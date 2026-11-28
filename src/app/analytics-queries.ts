import type Database from 'better-sqlite3';
import type { AccountId } from '../contracts/account.js';
import type {
  AnalyticsRange,
  AnalyticsResponseTimingBasis,
  AnalyticsSummary,
} from '../contracts/analytics.js';
import { HandoffAttributionStore } from './reply-pipeline/handoff-attribution.js';

const DAY_MS = 86_400_000;
const shanghaiDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export interface ReadOnlyAnalyticsStore {
  db: Database.Database;
  accountId: AccountId;
  schemaVersion(): number;
}

type DeliveryOriginKind = 'faqDirect' | 'auto' | 'human' | 'unknown';

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name=?").get(name),
  );
}

function toShanghaiDateKey(ms: number): string {
  return shanghaiDateFormatter.format(ms);
}

function toDayLabel(dateKey: string): string {
  return dateKey.slice(5).replace('-', '/');
}

function roundRatio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Number(Math.min(1, numerator / denominator).toFixed(4));
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function extractOccurredAtMs(payloadJson: string): number | null {
  try {
    const parsed = JSON.parse(payloadJson) as { occurredAt?: unknown };
    return parseIsoMs(parsed?.occurredAt);
  } catch {
    return null;
  }
}

function classifyDirectOrigin(origin: string | null | undefined): DeliveryOriginKind {
  if (origin === 'AUTO_FAQ_DIRECT') return 'faqDirect';
  if (origin === 'AUTO_POLICY') return 'auto';
  if (origin === 'HUMAN_TYPED' || origin === 'AI_ASSISTED_APPROVED' || origin === 'MCP_ASSISTED') {
    return 'human';
  }
  return 'unknown';
}

function classifyIntentProvenance(params: {
  hasPolicyCmd: boolean;
  hasManualCmd: boolean;
  draftOrigin: string | null | undefined;
}): DeliveryOriginKind {
  if (params.hasPolicyCmd) {
    return params.draftOrigin === 'AUTO_FAQ_DIRECT' ? 'faqDirect' : 'auto';
  }
  if (params.hasManualCmd) {
    return 'human';
  }
  return classifyDirectOrigin(params.draftOrigin);
}

interface IntentBaseRow {
  intentId: string;
  eventId: string;
  accountId: string;
  intentStatus: string;
  attemptStartedAt: string;
}

interface IntentDetailRow {
  intentId: string;
  payloadJson: string;
  origin: string | null;
}

interface RetryIntentAuditRow {
  retryId: string;
  detailJson: string;
}

interface RetryReceiptAuditRow {
  entityId: string;
  verifiedAt: string;
  detailJson: string;
}

interface FollowupConfirmedRow {
  accountId: string;
  verifiedAt: string;
}

interface AutomationJobRow {
  eventId: string;
  commandId: string | null;
  grantVersion: number;
  contextVersion: string;
  ownershipGeneration: number;
  createdAt: number;
  updatedAt: number;
}

const SQL_IN_CHUNK = 400;

function queryInChunks<T>(
  ids: readonly string[],
  runChunk: (placeholders: string, slice: readonly string[]) => T[],
): T[] {
  const results: T[] = [];
  for (let i = 0; i < ids.length; i += SQL_IN_CHUNK) {
    const slice = ids.slice(i, i + SQL_IN_CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    results.push(...runChunk(placeholders, slice));
  }
  return results;
}

/** Pure read-only analytics aggregation across effective confirmed deliveries, handoffs, models, budgets, and accounts. */
export function readAnalyticsSummary(
  store: ReadOnlyAnalyticsStore,
  range: AnalyticsRange,
  now: () => number = Date.now,
): AnalyticsSummary {
  const db = store.db;
  const untilMs = now();
  const days = range === '7d' ? 7 : range === '14d' ? 14 : 30;
  const todayKey = toShanghaiDateKey(untilMs);
  const todayStartMs = Date.parse(`${todayKey}T00:00:00.000+08:00`);
  const sinceMs = todayStartMs - (days - 1) * DAY_MS;
  const sinceIso = new Date(sinceMs).toISOString();
  const untilIso = new Date(untilMs).toISOString();

  const dailyMap = new Map<string, AnalyticsSummary['dailySeries'][number]>();
  const dailySeries: AnalyticsSummary['dailySeries'] = [];
  for (let i = 0; i < days; i++) {
    const date = toShanghaiDateKey(sinceMs + i * DAY_MS);
    const bucket = {
      date,
      label: toDayLabel(date),
      autoConfirmed: 0,
      humanConfirmed: 0,
      faqDirectConfirmed: 0,
      unknownConfirmed: 0,
    };
    dailyMap.set(date, bucket);
    dailySeries.push(bucket);
  }

  const accountMap = new Map<string, AnalyticsSummary['accountBreakdown'][number]>();
  const schemaVersion = store.schemaVersion();
  if (tableExists(db, 'accounts')) {
    if (schemaVersion >= 4) {
      const rows = db.prepare(
        'SELECT id, platform, display_label AS displayLabel FROM accounts ORDER BY created_at, id',
      ).all() as { id: string; platform: string; displayLabel: string }[];
      for (const row of rows) {
        accountMap.set(row.id, {
          accountId: row.id,
          displayLabel: row.displayLabel.trim() || '账号',
          platform: row.platform || 'douyin',
          autoConfirmed: 0,
          humanConfirmed: 0,
          faqDirectConfirmed: 0,
          unknownConfirmed: 0,
          totalConfirmed: 0,
        });
      }
    } else {
      const rows = db.prepare('SELECT id FROM accounts ORDER BY id').all() as { id: string }[];
      for (const row of rows) {
        accountMap.set(row.id, {
          accountId: row.id,
          displayLabel: '账号',
          platform: 'douyin',
          autoConfirmed: 0,
          humanConfirmed: 0,
          faqDirectConfirmed: 0,
          unknownConfirmed: 0,
          totalConfirmed: 0,
        });
      }
    }
  }

  const ensureAccountBucket = (accountId: string) => {
    let bucket = accountMap.get(accountId);
    if (!bucket) {
      bucket = {
        accountId,
        displayLabel: '账号',
        platform: 'douyin',
        autoConfirmed: 0,
        humanConfirmed: 0,
        faqDirectConfirmed: 0,
        unknownConfirmed: 0,
        totalConfirmed: 0,
      };
      accountMap.set(accountId, bucket);
    }
    return bucket;
  };

  let autoConfirmed = 0;
  let humanConfirmed = 0;
  let faqDirectConfirmed = 0;
  let unknownConfirmed = 0;
  let responseMsSum = 0;
  let responseSamples = 0;
  let platformSendSamples = 0;
  let confirmationSamples = 0;

  const confirmedIntentIds = new Set<string>();
  const confirmedPolicyEventIds = new Set<string>();

  const recordConfirmed = (params: {
    accountId: string;
    eventId?: string;
    verifiedMs: number;
    kind: DeliveryOriginKind;
    occurredMs: number | null;
    platformSendMs: number | null;
  }) => {
    const accountBucket = ensureAccountBucket(params.accountId);
    if (params.kind === 'faqDirect') accountBucket.faqDirectConfirmed += 1;
    else if (params.kind === 'auto') accountBucket.autoConfirmed += 1;
    else if (params.kind === 'human') accountBucket.humanConfirmed += 1;
    else accountBucket.unknownConfirmed += 1;
    accountBucket.totalConfirmed += 1;

    if (params.accountId !== store.accountId) return;

    if (params.kind === 'faqDirect') faqDirectConfirmed += 1;
    else if (params.kind === 'auto') autoConfirmed += 1;
    else if (params.kind === 'human') humanConfirmed += 1;
    else unknownConfirmed += 1;

    if (params.eventId && (params.kind === 'auto' || params.kind === 'faqDirect')) {
      confirmedPolicyEventIds.add(params.eventId);
    }

    const dayBucket = dailyMap.get(toShanghaiDateKey(params.verifiedMs));
    if (dayBucket) {
      if (params.kind === 'faqDirect') dayBucket.faqDirectConfirmed += 1;
      else if (params.kind === 'auto') dayBucket.autoConfirmed += 1;
      else if (params.kind === 'human') dayBucket.humanConfirmed += 1;
      else dayBucket.unknownConfirmed += 1;
    }

    const endMs = params.platformSendMs ?? params.verifiedMs;
    if (params.occurredMs !== null && endMs >= params.occurredMs) {
      responseMsSum += endMs - params.occurredMs;
      responseSamples += 1;
      if (params.platformSendMs !== null) platformSendSamples += 1;
      else confirmationSamples += 1;
    }
  };

  const hasEvents = tableExists(db, 'inbound_events');
  const hasIntents = tableExists(db, 'send_intents');
  const hasReceipts = tableExists(db, 'delivery_receipts');
  const hasDrafts = tableExists(db, 'reply_drafts');
  const hasRevisions = tableExists(db, 'draft_revisions');
  const hasVerification = tableExists(db, 'verification_results');
  const hasManualCmds = tableExists(db, 'manual_send_commands');
  const hasPolicyCmds = tableExists(db, 'policy_commands');
  const hasAudit = tableExists(db, 'audit_events');

  // Precompute automation_jobs batches in [sinceMs, untilMs] so we only resolve provenance for
  // confirmed intents that either fall inside the reporting window or belong to the window's job cohort.
  let hasAutomationJobsForAccount = false;
  const cohortBatches: { eventIds: string[] }[] = [];
  const cohortEventIds = new Set<string>();
  if (hasEvents && tableExists(db, 'automation_jobs')) {
    const jobRows = db.prepare(`
      SELECT j.event_id AS eventId, j.command_id AS commandId, j.grant_version AS grantVersion,
        j.context_version AS contextVersion, j.ownership_generation AS ownershipGeneration,
        j.created_at AS createdAt, j.updated_at AS updatedAt
      FROM automation_jobs j
      JOIN inbound_events e ON e.id = j.event_id
      WHERE e.account_id = ?
    `).all(store.accountId) as AutomationJobRow[];

    if (jobRows.length > 0) {
      hasAutomationJobsForAccount = true;
      const batches = new Map<string, { minCreatedAt: number; eventIds: string[] }>();
      for (const job of jobRows) {
        const key = job.commandId && job.commandId.trim()
          ? `cmd:${job.commandId}`
          : `batch:${job.contextVersion}:${job.ownershipGeneration}:${job.grantVersion}:${job.updatedAt}`;
        const current = batches.get(key);
        if (!current) {
          batches.set(key, { minCreatedAt: job.createdAt, eventIds: [job.eventId] });
        } else {
          if (job.createdAt < current.minCreatedAt) current.minCreatedAt = job.createdAt;
          current.eventIds.push(job.eventId);
        }
      }
      for (const batch of batches.values()) {
        if (batch.minCreatedAt < sinceMs || batch.minCreatedAt > untilMs) continue;
        cohortBatches.push({ eventIds: batch.eventIds });
        for (const eventId of batch.eventIds) cohortEventIds.add(eventId);
      }
    }
  }

  if (hasEvents && hasIntents && hasDrafts) {
    const verificationByIntent = new Map<string, { verified: number; checkedAt: number }>();
    if (hasVerification) {
      const vRows = db.prepare(
        'SELECT intent_id AS intentId, verified, checked_at AS checkedAt FROM verification_results ORDER BY rowid ASC',
      ).all() as { intentId: string; verified: number; checkedAt: number }[];
      for (const row of vRows) {
        verificationByIntent.set(row.intentId, { verified: row.verified, checkedAt: row.checkedAt });
      }
    }

    const receiptByIntent = new Map<string, string>();
    if (hasReceipts) {
      const rRows = db.prepare(
        "SELECT send_intent_id AS intentId, MAX(verified_at) AS verifiedAt FROM delivery_receipts WHERE result = 'CONFIRMED' GROUP BY send_intent_id",
      ).all() as { intentId: string; verifiedAt: string }[];
      for (const row of rRows) {
        if (row.verifiedAt) receiptByIntent.set(row.intentId, row.verifiedAt);
      }
    }

    const baseRows = db.prepare(`
      SELECT i.id AS intentId, i.event_id AS eventId, e.account_id AS accountId,
        i.status AS intentStatus, i.attempt_started_at AS attemptStartedAt
      FROM send_intents i
      JOIN inbound_events e ON e.id = i.event_id
    `).all() as IntentBaseRow[];

    const selectedIntents: (IntentBaseRow & { verifiedMs: number | null; inWindow: boolean })[] = [];
    for (const row of baseRows) {
      const verif = verificationByIntent.get(row.intentId);
      const receiptAt = receiptByIntent.get(row.intentId);
      const confirmed = verif !== undefined
        ? verif.verified === 1
        : row.intentStatus === 'CONFIRMED' || receiptAt !== undefined;
      if (!confirmed) continue;

      confirmedIntentIds.add(row.intentId);
      const verifiedMs =
        parseIsoMs(receiptAt)
        ?? (verif && typeof verif.checkedAt === 'number' && Number.isFinite(verif.checkedAt) ? verif.checkedAt : null)
        ?? parseIsoMs(row.attemptStartedAt);
      const inWindow = verifiedMs !== null && verifiedMs >= sinceMs && verifiedMs <= untilMs;
      const inCohort = row.accountId === store.accountId && cohortEventIds.has(row.eventId);
      if (!inWindow && !inCohort) continue;

      selectedIntents.push({ ...row, verifiedMs, inWindow });
    }

    if (selectedIntents.length > 0) {
      const selectedIds = selectedIntents.map((item) => item.intentId);
      const manualCmdByIntent = new Map<string, string>();
      if (hasManualCmds) {
        const cmdRows = queryInChunks(selectedIds, (placeholders, slice) => db.prepare(
          `SELECT intent_id AS intentId, command_id AS commandId FROM manual_send_commands WHERE intent_id IN (${placeholders}) ORDER BY rowid ASC`,
        ).all(...slice) as { intentId: string; commandId: string }[]);
        for (const row of cmdRows) manualCmdByIntent.set(row.intentId, row.commandId);
      }

      const policyCmdIds = new Set<string>();
      if (hasManualCmds && hasPolicyCmds && manualCmdByIntent.size > 0) {
        const uniqueCmdIds = [...new Set(manualCmdByIntent.values())];
        const pRows = queryInChunks(uniqueCmdIds, (placeholders, slice) => db.prepare(
          `SELECT command_id AS commandId FROM policy_commands WHERE command_id IN (${placeholders})`,
        ).all(...slice) as { commandId: string }[]);
        for (const row of pRows) policyCmdIds.add(row.commandId);
      }

      const detailByIntent = new Map<string, IntentDetailRow>();
      const detailRows = queryInChunks(selectedIds, (placeholders, slice) => db.prepare(`
        SELECT i.id AS intentId, e.payload AS payloadJson,
          ${hasRevisions ? 'COALESCE(dr.origin, d.model)' : 'd.model'} AS origin
        FROM send_intents i
        JOIN inbound_events e ON e.id = i.event_id
        JOIN reply_drafts d ON d.id = i.draft_id
        ${hasRevisions ? 'LEFT JOIN draft_revisions dr ON dr.draft_id = d.id AND dr.version = d.version' : ''}
        WHERE i.id IN (${placeholders})
      `).all(...slice) as IntentDetailRow[]);
      for (const row of detailRows) detailByIntent.set(row.intentId, row);

      const inWindowIntentIds = new Set(selectedIntents.filter((x) => x.inWindow).map((x) => x.intentId));
      const submissionByIntent = new Map<string, string>();
      if (hasAudit && inWindowIntentIds.size > 0) {
        const proofRows = db.prepare(`
          SELECT entity_id AS entityId, json_extract(detail_redacted, '$.responseAt') AS responseAt
          FROM audit_events
          WHERE event_type = 'SUBMISSION_PROOF'
          ORDER BY rowid ASC
        `).all() as { entityId: string; responseAt: string | null }[];
        for (const row of proofRows) {
          if (inWindowIntentIds.has(row.entityId) && typeof row.responseAt === 'string') {
            submissionByIntent.set(row.entityId, row.responseAt);
          }
        }
      }

      for (const item of selectedIntents) {
        const detail = detailByIntent.get(item.intentId);
        if (!detail) continue;
        const cmdId = manualCmdByIntent.get(item.intentId);
        const kind = classifyIntentProvenance({
          hasPolicyCmd: cmdId !== undefined && policyCmdIds.has(cmdId),
          hasManualCmd: cmdId !== undefined,
          draftOrigin: detail.origin,
        });
        if (item.accountId === store.accountId && (kind === 'auto' || kind === 'faqDirect')) {
          confirmedPolicyEventIds.add(item.eventId);
        }
        if (!item.inWindow || item.verifiedMs === null) continue;

        recordConfirmed({
          accountId: item.accountId,
          eventId: item.eventId,
          verifiedMs: item.verifiedMs,
          kind,
          occurredMs: extractOccurredAtMs(detail.payloadJson),
          platformSendMs: parseIsoMs(submissionByIntent.get(item.intentId)),
        });
      }
    }
  }

  if (hasEvents && hasAudit) {
    const retryIntents = db.prepare(
      "SELECT id AS retryId, detail_redacted AS detailJson FROM audit_events WHERE event_type = 'MANUAL_RETRY_INTENT'",
    ).all() as RetryIntentAuditRow[];

    if (retryIntents.length > 0) {
      const retryIdSet = new Set(retryIntents.map((r) => r.retryId));
      const receiptRows = db.prepare(
        "SELECT entity_id AS entityId, time AS verifiedAt, detail_redacted AS detailJson FROM audit_events WHERE event_type = 'MANUAL_RETRY_RECEIPT' ORDER BY rowid ASC",
      ).all() as RetryReceiptAuditRow[];
      const latestReceipt = new Map<string, RetryReceiptAuditRow>();
      for (const row of receiptRows) {
        if (retryIdSet.has(row.entityId)) latestReceipt.set(row.entityId, row);
      }

      const inWindowRetries: {
        retryId: string;
        eventId: string;
        previousIntentId: string | null;
        verifiedMs: number;
      }[] = [];
      const seenRetryIds = new Set<string>();
      for (const intent of retryIntents) {
        const receipt = latestReceipt.get(intent.retryId);
        if (!receipt) continue;
        let result: unknown;
        let eventId: unknown;
        let previousIntentId: unknown;
        try {
          result = (JSON.parse(receipt.detailJson) as { result?: unknown }).result;
          const detail = JSON.parse(intent.detailJson) as { eventId?: unknown; previousIntentId?: unknown };
          eventId = detail.eventId;
          previousIntentId = detail.previousIntentId;
        } catch {
          continue;
        }
        if (result !== 'CONFIRMED' || typeof eventId !== 'string') continue;
        const prevId = typeof previousIntentId === 'string' ? previousIntentId : null;
        if (prevId && confirmedIntentIds.has(prevId)) continue;
        const dedupeKey = prevId ?? eventId;
        if (seenRetryIds.has(dedupeKey)) continue;
        seenRetryIds.add(dedupeKey);

        const verifiedMs = parseIsoMs(receipt.verifiedAt);
        if (verifiedMs === null || verifiedMs < sinceMs || verifiedMs > untilMs) continue;
        inWindowRetries.push({ retryId: intent.retryId, eventId, previousIntentId: prevId, verifiedMs });
      }

      if (inWindowRetries.length > 0) {
        const eventRows = queryInChunks(
          [...new Set(inWindowRetries.map((r) => r.eventId))],
          (placeholders, slice) => db.prepare(
            `SELECT id, account_id AS accountId, payload AS payloadJson FROM inbound_events WHERE id IN (${placeholders})`,
          ).all(...slice) as { id: string; accountId: string; payloadJson: string }[],
        );
        const eventMap = new Map(eventRows.map((e) => [e.id, e]));

        const inWindowRetryIds = new Set(inWindowRetries.map((r) => r.retryId));
        const retryProofs = new Map<string, string>();
        const proofRows = db.prepare(`
          SELECT entity_id AS entityId, json_extract(detail_redacted, '$.responseAt') AS responseAt
          FROM audit_events
          WHERE event_type = 'SUBMISSION_PROOF'
          ORDER BY rowid ASC
        `).all() as { entityId: string; responseAt: string | null }[];
        for (const row of proofRows) {
          if (inWindowRetryIds.has(row.entityId) && typeof row.responseAt === 'string') {
            retryProofs.set(row.entityId, row.responseAt);
          }
        }

        for (const retry of inWindowRetries) {
          const ev = eventMap.get(retry.eventId);
          if (!ev) continue;
          recordConfirmed({
            accountId: ev.accountId,
            eventId: retry.eventId,
            verifiedMs: retry.verifiedMs,
            kind: 'human',
            occurredMs: extractOccurredAtMs(ev.payloadJson),
            platformSendMs: parseIsoMs(retryProofs.get(retry.retryId)),
          });
        }
      }
    }
  }

  if (hasEvents && tableExists(db, 'human_reply_turns')) {
    const intentGuard = hasIntents
      ? 'AND (t.intent_id IS NULL OR NOT EXISTS (SELECT 1 FROM send_intents si WHERE si.id = t.intent_id))'
      : '';
    const rows = db.prepare(`
      SELECT
        e.account_id AS accountId,
        t.verified_at AS verifiedAt
      FROM human_reply_turns t
      JOIN inbound_events e ON e.id = t.event_id
      WHERE t.status = 'CONFIRMED' AND t.verified_at IS NOT NULL
        ${intentGuard}
    `).all() as FollowupConfirmedRow[];

    for (const row of rows) {
      const verifiedMs = parseIsoMs(row.verifiedAt);
      if (verifiedMs === null || verifiedMs < sinceMs || verifiedMs > untilMs) continue;
      recordConfirmed({
        accountId: row.accountId,
        verifiedMs,
        kind: 'human',
        occurredMs: null,
        platformSendMs: null,
      });
    }
  }

  let autoReplyAttempts = 0;
  let cohortSucceeded = 0;
  if (hasAutomationJobsForAccount) {
    for (const batch of cohortBatches) {
      autoReplyAttempts += 1;
      if (batch.eventIds.some((eventId) => confirmedPolicyEventIds.has(eventId))) {
        cohortSucceeded += 1;
      }
    }
  } else {
    autoReplyAttempts = autoConfirmed + faqDirectConfirmed;
    cohortSucceeded = autoReplyAttempts;
  }

  const confirmedTotal = autoConfirmed + faqDirectConfirmed + humanConfirmed + unknownConfirmed;
  const automatedConfirmed = autoConfirmed + faqDirectConfirmed;

  const handoffSummary = new HandoffAttributionStore(db, now).querySummary({
    accountId: store.accountId,
    sinceMs,
    untilMs,
  });

  let modelUsage: AnalyticsSummary['modelUsage'] = {
    requests: 0,
    succeeded: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    unresolved: 0,
  };
  if (tableExists(db, 'model_calls')) {
    const row = db.prepare(`
      SELECT
        COUNT(*) AS requests,
        COALESCE(SUM(CASE WHEN status = 'SUCCEEDED' THEN 1 ELSE 0 END), 0) AS succeeded,
        COALESCE(SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END), 0) AS failed,
        COALESCE(SUM(CASE WHEN typeof(input_tokens) = 'integer' AND input_tokens >= 0 THEN input_tokens ELSE 0 END), 0) AS inputTokens,
        COALESCE(SUM(CASE WHEN typeof(output_tokens) = 'integer' AND output_tokens >= 0 THEN output_tokens ELSE 0 END), 0) AS outputTokens,
        COALESCE(SUM(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END), 0) AS unresolved
      FROM model_calls
    `).get() as {
      requests: number;
      succeeded: number;
      failed: number;
      inputTokens: number;
      outputTokens: number;
      unresolved: number;
    };
    modelUsage = {
      requests: row.requests,
      succeeded: row.succeeded,
      failed: row.failed,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      totalTokens: row.inputTokens + row.outputTokens,
      unresolved: row.unresolved,
    };
  }

  let budgets: AnalyticsSummary['budgets'] = [];
  if (tableExists(db, 'budgets')) {
    if (tableExists(db, 'budget_limits')) {
      budgets = db.prepare(`
        SELECT b.kind AS kind, b.used AS used,
          CASE WHEN l.kind IS NOT NULL THEN l.maximum ELSE b.maximum END AS maximum
        FROM budgets b
        LEFT JOIN budget_limits l ON l.kind = b.kind
        ORDER BY b.kind
      `).all() as AnalyticsSummary['budgets'];
    } else {
      budgets = db.prepare('SELECT kind, used, maximum FROM budgets ORDER BY kind')
        .all() as AnalyticsSummary['budgets'];
    }
  }

  const avgResponseBasis: AnalyticsResponseTimingBasis = responseSamples === 0
    ? 'NONE'
    : platformSendSamples > 0 && confirmationSamples > 0
      ? 'MIXED'
      : platformSendSamples > 0
        ? 'PLATFORM_SEND_AT'
        : 'CONFIRMATION_AT';

  return {
    range,
    sinceIso,
    untilIso,
    scopes: {
      totals: 'ACCOUNT_WINDOW',
      dailySeries: 'ACCOUNT_WINDOW',
      handoffSummary: 'ACCOUNT_WINDOW',
      modelUsage: 'RUNTIME_ALL_TIME',
      budgets: 'SHARED_GLOBAL',
      accountBreakdown: 'ALL_ACCOUNTS_WINDOW',
      avgResponseBasis,
    },
    totals: {
      confirmedTotal,
      autoConfirmed,
      humanConfirmed,
      faqDirectConfirmed,
      unknownConfirmed,
      autoRate: roundRatio(automatedConfirmed, confirmedTotal),
      faqDirectRate: roundRatio(faqDirectConfirmed, confirmedTotal),
      autoReplyAttempts,
      autoReplySuccessRate: roundRatio(cohortSucceeded, autoReplyAttempts),
      avgResponseMs: responseSamples > 0 ? Math.round(responseMsSum / responseSamples) : null,
    },
    dailySeries,
    handoffSummary,
    modelUsage,
    budgets,
    accountBreakdown: [...accountMap.values()].sort(
      (a, b) => b.totalConfirmed - a.totalConfirmed || a.accountId.localeCompare(b.accountId),
    ),
  };
}
