import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { DeepSeekProvider } from '../../src/ai/deepseek.js';
import { buildValidatedVisionInput } from '../../src/ai/vision-input.js';
import { readAnalyticsSummary } from '../../src/app/analytics-queries.js';
import { AvatarCacheStore, ingestCachedAvatar } from '../../src/app/avatar-cache.js';
import { MockAccountRuntime, type SharedMockModels } from '../../src/app/mock-account-runtime.js';
import { dispatchOfflineOfficialRead, OfficialAccountRuntime } from '../../src/app/official-account-runtime.js';
import {
  dispatchTrustedServiceCommand, parseSidecarFrame, routeSidecarEnvelope, type SidecarCommand,
} from '../../src/app/protocol-v2-router.js';
import { HandoffAttributionStore } from '../../src/app/reply-pipeline/handoff-attribution.js';
import { isReadOnlySidecarCommand } from '../../src/app/service-guards.js';
import { WebAccountRuntime } from '../../src/app/web-account-runtime.js';
import type { AnalyticsSummary } from '../../src/contracts/analytics.js';
import {
  AVATAR_CACHE_MAX_ENTRIES, AVATAR_MAX_BYTES, AVATAR_MAX_DATA_URL_BYTES, type AvatarPreviewResult,
} from '../../src/contracts/avatar.js';
import { isMutatingClientCommand, type ProtocolScope } from '../../src/contracts/protocol-v2.js';
import { DEFAULT_ACCOUNT_ID, digest, targetKey, type InboundEvent, type TargetSnapshot } from '../../src/core/contracts.js';
import { ReplyKnowledgeStore } from '../../src/knowledge/store.js';
import { MockPlatformConnector } from '../../src/platform/mock-platform-connector.js';
import { WecomAibotPlatformConnector } from '../../src/platform/wecom-aibot/connector.js';
import { AccountAiFeaturesStore } from '../../src/storage/account-ai-features.js';
import { AccountStore } from '../../src/storage/account-store.js';
import { migrateFollowups } from '../../src/storage/followup-migration.js';
import { EventStore } from '../../src/storage/store.js';
import { privateTemp } from '../helpers.js';
import { modelFixture } from '../model-provider-helpers.js';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x12, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);

function makeDmEvent(accountId: string, idx: number, occurredAt: string): InboundEvent {
  return {
    accountId,
    channel: 'DIRECT_MESSAGE',
    direction: 'INCOMING',
    kind: 'DM',
    platformEventId: `dm-${accountId}-${idx}`,
    conversationId: `conv-${accountId}-${idx}`,
    videoId: null,
    commentId: null,
    evidenceId: `ev-${accountId}-${idx}`,
    actorId: `peer-${idx}`,
    actorName: `Customer ${idx}`,
    text: `你好 ${idx}`,
    occurredAt,
    occurredAtPrecisionMs: 1,
  };
}

function seedConfirmedDelivery(params: {
  store: EventStore;
  event: InboundEvent;
  origin: string;
  model: string;
  verifiedAt: string;
  commandMode?: 'POLICY' | 'MANUAL' | 'NONE';
  receiptResult?: 'CONFIRMED' | 'UNCERTAIN';
  verificationVerified?: 0 | 1;
  checkedAtMs?: number;
  submissionResponseAt?: string;
}): { eventId: string; draftId: string; intentId: string } {
  const {
    store, event, origin, model, verifiedAt,
    commandMode = 'NONE', receiptResult = 'CONFIRMED', verificationVerified, checkedAtMs, submissionResponseAt,
  } = params;
  const eventId = randomUUID();
  const draftId = randomUUID();
  const intentId = randomUUID();
  const tKey = targetKey(event);
  const snapshot: TargetSnapshot = {
    accountId: event.accountId,
    ownId: 'own-' + event.accountId,
    targetKey: tKey,
    composerKey: tKey,
    eventBinding: digest(event),
    contextDigest: digest('ctx'),
    mappingDigest: digest('map'),
  };
  const approval = JSON.stringify({ snapshot, textDigest: digest('reply'), version: 1 });
  const verifiedMs = Date.parse(verifiedAt);

  store.db.prepare('INSERT INTO inbound_events VALUES (?,?,?,?,?,?,?,?,?)')
    .run(eventId, event.accountId, event.channel, event.platformEventId, 'dm', tKey, digest(event), JSON.stringify(event), receiptResult);
  store.db.prepare("INSERT INTO reply_drafts VALUES (?,?,?,?,1,'APPROVED',?,?)")
    .run(draftId, eventId, `reply-${origin}`, model, approval, verifiedAt);
  store.db.prepare('INSERT INTO draft_revisions VALUES (?,1,?,?,?,?)')
    .run(draftId, origin, `reply-${origin}`, 'op-1', verifiedMs);
  store.db.prepare('INSERT INTO send_intents VALUES (?,?,?,?,?,?,?,?)')
    .run(intentId, eventId, draftId, tKey, digest(snapshot), digest('reply'), receiptResult, verifiedAt);
  store.db.prepare('INSERT INTO delivery_receipts VALUES (?,?,?,?,?)')
    .run(randomUUID(), intentId, receiptResult, `proof-${intentId}`, verifiedAt);

  if (commandMode !== 'NONE') {
    const commandId = randomUUID();
    store.db.prepare("INSERT INTO manual_send_commands VALUES (?,?,?,?,?,'CONFIRMED',?,NULL,?)")
      .run(commandId, eventId, 'op-1', digest('p'), '{}', intentId, verifiedMs);
    if (commandMode === 'POLICY') {
      store.db.prepare('INSERT OR IGNORE INTO automation_grants VALUES (1,?,?,?,?,NULL)')
        .run('AUTO_REPLY', '{}', digest({}), verifiedMs - 60_000);
      store.db.prepare('INSERT INTO policy_commands VALUES (?,1,1)').run(commandId);
    }
  }
  if (verificationVerified !== undefined) {
    store.db.prepare('INSERT INTO verification_results VALUES (?,?,?,?,?)')
      .run(randomUUID(), intentId, verificationVerified, `ev-${intentId}`, checkedAtMs ?? verifiedMs);
  }
  if (submissionResponseAt) {
    store.db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?)')
      .run(randomUUID(), submissionResponseAt, 'SUBMISSION_PROOF', intentId, JSON.stringify({ responseAt: submissionResponseAt }));
  }

  return { eventId, draftId, intentId };
}

test('readAnalyticsSummary performs zero writes on a fresh uninitialized DB without optional tables', () => {
  const dir = privateTemp('analytics-empty-');
  const store = new EventStore(join(dir, 'fresh.sqlite'), true);
  try {
    const tablesBefore = store.db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' ORDER BY name").pluck().all();
    const changesBefore = store.db.prepare('SELECT total_changes()').pluck().get() as number;
    const nowMs = Date.parse('2026-11-27T10:00:00.000+08:00');
    const summary = readAnalyticsSummary(store, '7d', () => nowMs);

    expect(store.db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' ORDER BY name").pluck().all()).toEqual(tablesBefore);
    expect(store.db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(summary.scopes).toEqual({
      totals: 'ACCOUNT_WINDOW',
      dailySeries: 'ACCOUNT_WINDOW',
      handoffSummary: 'ACCOUNT_WINDOW',
      modelUsage: 'RUNTIME_ALL_TIME',
      budgets: 'SHARED_GLOBAL',
      accountBreakdown: 'ALL_ACCOUNTS_WINDOW',
      avgResponseBasis: 'NONE',
    });
    expect(summary.totals).toEqual({
      confirmedTotal: 0,
      autoConfirmed: 0,
      humanConfirmed: 0,
      faqDirectConfirmed: 0,
      unknownConfirmed: 0,
      autoRate: 0,
      faqDirectRate: 0,
      autoReplyAttempts: 0,
      autoReplySuccessRate: 0,
      avgResponseMs: null,
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getAnalytics separates policy vs human vision provenance, reconciled proofs, retries, unknown origins, and same-cohort rate', async () => {
  const f = await modelFixture();
  try {
    await migrateFollowups(f.store, join(f.root, 'backups', 'followups.sqlite'));
    const nowIso = '2026-11-27T14:00:00.000+08:00';
    const nowMs = Date.parse(nowIso);

    const accountStore = new AccountStore(f.store.db, () => nowMs, f.root);
    const xhsAccount = accountStore.registerAccount({
      commandId: randomUUID(),
      platform: 'xiaohongshu',
      connector: 'xiaohongshu',
      displayLabel: '小红书官方号',
      profileRef: 'profiles/xhs-1',
    });

    // 1. Policy AUTO_FAQ_DIRECT with duplicate CONFIRMED receipt (counted once)
    const faq = seedConfirmedDelivery({
      store: f.store,
      event: makeDmEvent(DEFAULT_ACCOUNT_ID, 1, '2026-11-27T13:58:00.000+08:00'),
      origin: 'AUTO_FAQ_DIRECT',
      model: 'AUTO_FAQ_DIRECT',
      verifiedAt: '2026-11-27T13:59:00.000+08:00',
      commandMode: 'POLICY',
      submissionResponseAt: '2026-11-27T13:58:30.000+08:00', // 30s
    });
    f.store.db.prepare('INSERT INTO delivery_receipts VALUES (?,?,?,?,?)')
      .run(randomUUID(), faq.intentId, 'CONFIRMED', 'dup-proof', '2026-11-27T13:59:10.000+08:00');

    // 2. Policy AUTO_POLICY
    const auto = seedConfirmedDelivery({
      store: f.store,
      event: makeDmEvent(DEFAULT_ACCOUNT_ID, 2, '2026-11-27T13:50:00.000+08:00'),
      origin: 'AUTO_POLICY',
      model: 'deepseek-chat',
      verifiedAt: '2026-11-27T13:52:00.000+08:00',
      commandMode: 'POLICY',
      submissionResponseAt: '2026-11-27T13:51:00.000+08:00', // 60s
    });

    // 3. Human-approved vision/AUTO_POLICY draft sent via manual_send_commands -> MUST count as humanConfirmed!
    seedConfirmedDelivery({
      store: f.store,
      event: makeDmEvent(DEFAULT_ACCOUNT_ID, 3, '2026-11-27T12:00:00.000+08:00'),
      origin: 'AUTO_POLICY',
      model: 'deepseek-chat',
      verifiedAt: '2026-11-27T12:02:00.000+08:00',
      commandMode: 'MANUAL',
      submissionResponseAt: '2026-11-27T12:01:30.000+08:00', // 90s
    });

    // 4. Reconciled UNCERTAIN -> verification_results.verified = 1
    seedConfirmedDelivery({
      store: f.store,
      event: makeDmEvent(DEFAULT_ACCOUNT_ID, 4, '2026-11-26T10:00:00.000+08:00'),
      origin: 'HUMAN_TYPED',
      model: 'HUMAN_TYPED',
      verifiedAt: '2026-11-26T10:03:00.000+08:00',
      commandMode: 'MANUAL',
      receiptResult: 'UNCERTAIN',
      verificationVerified: 1,
      checkedAtMs: Date.parse('2026-11-26T10:02:00.000+08:00'),
      submissionResponseAt: '2026-11-26T10:01:00.000+08:00', // 60s
    });

    // 5. Confirmed comment retry in audit_events (original intent remained UNCERTAIN)
    const retryUncertain = seedConfirmedDelivery({
      store: f.store,
      event: makeDmEvent(DEFAULT_ACCOUNT_ID, 5, '2026-11-26T11:00:00.000+08:00'),
      origin: 'HUMAN_TYPED',
      model: 'HUMAN_TYPED',
      verifiedAt: '2026-11-26T11:01:00.000+08:00',
      commandMode: 'MANUAL',
      receiptResult: 'UNCERTAIN',
    });
    const retryIntentId = randomUUID();
    f.store.db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?)').run(
      retryIntentId,
      '2026-11-26T11:02:00.000+08:00',
      'MANUAL_RETRY_INTENT',
      'grant-1',
      JSON.stringify({ eventId: retryUncertain.eventId, previousIntentId: retryUncertain.intentId, draftId: retryUncertain.draftId }),
    );
    f.store.db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?)').run(
      randomUUID(),
      '2026-11-26T11:02:30.000+08:00',
      'MANUAL_RETRY_RECEIPT',
      retryIntentId,
      JSON.stringify({ result: 'CONFIRMED', proofRef: 'retry-proof' }),
    );
    f.store.db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?)').run(
      randomUUID(),
      '2026-11-26T11:02:00.000+08:00',
      'SUBMISSION_PROOF',
      retryIntentId,
      JSON.stringify({ responseAt: '2026-11-26T11:02:00.000+08:00' }), // 120s
    );

    // 6. Unknown legacy origin without command row -> unknownConfirmed (does NOT inflate humanConfirmed)
    seedConfirmedDelivery({
      store: f.store,
      event: makeDmEvent(DEFAULT_ACCOUNT_ID, 6, '2026-11-25T10:00:00.000+08:00'),
      origin: 'deepseek-flash',
      model: 'deepseek-flash',
      verifiedAt: '2026-11-25T10:01:00.000+08:00',
      commandMode: 'NONE',
      submissionResponseAt: '2026-11-25T10:00:30.000+08:00', // 30s
    });

    // 7. Old policy job created BEFORE 7d window whose receipt verified INSIDE 7d window -> must NOT inflate 7d cohort success rate
    const oldTrigger = seedConfirmedDelivery({
      store: f.store,
      event: makeDmEvent(DEFAULT_ACCOUNT_ID, 7, '2026-11-15T09:00:00.000+08:00'),
      origin: 'AUTO_POLICY',
      model: 'deepseek-chat',
      verifiedAt: '2026-11-27T09:01:00.000+08:00',
      commandMode: 'POLICY',
      submissionResponseAt: '2026-11-27T09:01:00.000+08:00', // excluded? No, verifiedAt is in window, avgResponseMs uses endMs - occurredMs
    });
    // Wait: keep oldTrigger outside window or test oldTrigger separately in cohort check!
    // Let's keep oldTrigger receipt ALSO before window (or test cohort check cleanly below).
    f.store.db.prepare('UPDATE delivery_receipts SET verified_at=? WHERE send_intent_id=?')
      .run('2026-11-15T09:01:00.000+08:00', oldTrigger.intentId);
    f.store.db.prepare('DELETE FROM audit_events WHERE entity_id=?').run(oldTrigger.intentId);

    // 8. Confirmed human_reply_turns followup
    f.store.db.prepare(`
      INSERT INTO human_reply_turns VALUES (?,?,?,?,?,?,?,?,'CONFIRMED',NULL,NULL,NULL,NULL,'proof-followup',?,NULL,?)
    `).run(
      randomUUID(), faq.eventId, targetKey(makeDmEvent(DEFAULT_ACCOUNT_ID, 1, '2026-11-27T13:58:00.000+08:00')),
      'op-1', digest('followup'), '{}', '补充说明', 1, '2026-11-27T13:59:30.000+08:00', nowMs - 1000,
    );

    // 9. Secondary account delivery
    seedConfirmedDelivery({
      store: f.store,
      event: makeDmEvent(xhsAccount.id, 1, '2026-11-27T12:00:00.000+08:00'),
      origin: 'AUTO_POLICY',
      model: 'deepseek-chat',
      verifiedAt: '2026-11-27T12:01:00.000+08:00',
      commandMode: 'POLICY',
    });

    // 10. Automation jobs: 2 succeeded batches in 7d, 1 fragmented failed REVIEW batch with NULL command_id
    // (2 fragment rows sharing context_version/generation/grant_version/updated_at -> 1 attempt!),
    // plus 1 old succeeded batch created 12 days ago (outside 7d cohort)
    f.store.db.prepare('INSERT INTO automation_jobs VALUES (?,?,?,?,?,1,NULL,NULL,?,?)')
      .run(faq.eventId, 1, 'CONFIRMED', 'ctx-faq', 1, nowMs - 50_000, nowMs - 40_000);
    f.store.db.prepare('INSERT INTO automation_jobs VALUES (?,?,?,?,?,1,NULL,NULL,?,?)')
      .run(auto.eventId, 1, 'CONFIRMED', 'ctx-auto', 1, nowMs - 50_000, nowMs - 40_000);
    f.store.db.prepare("INSERT INTO automation_jobs VALUES (?,?,?,?,?,0,'AFTER_SALES_KEYWORD_HANDOFF',NULL,?,?)")
      .run(retryUncertain.eventId, 1, 'REVIEW', 'ctx-frag-batch', 1, nowMs - 30_000, nowMs - 20_000);
    // Second fragment with command_id IS NULL sharing batch signature must NOT be counted as a second attempt
    const evFrag2 = makeDmEvent(DEFAULT_ACCOUNT_ID, 99, '2026-11-27T11:00:00.000+08:00');
    f.store.db.prepare('INSERT INTO inbound_events VALUES (?,?,?,?,?,?,?,?,?)')
      .run(evFrag2.evidenceId, DEFAULT_ACCOUNT_ID, 'DIRECT_MESSAGE', evFrag2.platformEventId, 'dm', targetKey(evFrag2), digest(evFrag2), JSON.stringify(evFrag2), 'AWAITING_DRAFT');
    f.store.db.prepare("INSERT INTO automation_jobs VALUES (?,?,?,?,?,0,'AFTER_SALES_KEYWORD_HANDOFF',NULL,?,?)")
      .run(evFrag2.evidenceId, 1, 'REVIEW', 'ctx-frag-batch', 1, nowMs - 30_000, nowMs - 20_000);
    // Old job outside 7d window
    f.store.db.prepare('INSERT INTO automation_jobs VALUES (?,?,?,?,?,1,NULL,NULL,?,?)')
      .run(oldTrigger.eventId, 1, 'CONFIRMED', 'ctx-old', 1, Date.parse('2026-11-15T09:00:00.000+08:00'), Date.parse('2026-11-15T09:01:00.000+08:00'));

    new HandoffAttributionStore(f.store.db, () => nowMs).record({
      accountId: DEFAULT_ACCOUNT_ID,
      channel: 'DIRECT_MESSAGE',
      eventId: retryUncertain.eventId,
      stage: 'handoff_rules_and_knowledge',
      reasonCode: 'AFTER_SALES_KEYWORD_HANDOFF',
      createdAt: nowMs - 25_000,
    });
    f.store.db.prepare("INSERT INTO model_calls VALUES ('call-1','deepseek-chat','SUCCEEDED',120,45,350,0.001)").run();
    f.store.db.prepare("UPDATE budget_limits SET maximum=NULL WHERE kind='SEND'").run();

    const summary7d = readAnalyticsSummary(f.store, '7d', () => nowMs);
    expect(summary7d.scopes.avgResponseBasis).toBe('PLATFORM_SEND_AT');
    expect(summary7d.totals).toEqual({
      confirmedTotal: 7, // faq(1) + auto(1) + visionHuman(1) + reconciled(1) + retry(1) + followup(1) + unknown(1)
      autoConfirmed: 1,
      humanConfirmed: 4, // visionHuman + reconciled + retry + followup
      faqDirectConfirmed: 1,
      unknownConfirmed: 1,
      autoRate: 0.2857,
      faqDirectRate: 0.1429,
      autoReplyAttempts: 3, // 2 succeeded + 1 fragmented failed batch
      autoReplySuccessRate: 0.6667,
      avgResponseMs: 65_000, // (30 + 60 + 90 + 60 + 120 + 30) / 6 = 65s
    });
    expect(summary7d.accountBreakdown).toEqual([
      {
        accountId: DEFAULT_ACCOUNT_ID,
        displayLabel: '账号', // NEVER raw own_id!
        platform: 'douyin',
        autoConfirmed: 1,
        humanConfirmed: 4,
        faqDirectConfirmed: 1,
        unknownConfirmed: 1,
        totalConfirmed: 7,
      },
      {
        accountId: xhsAccount.id,
        displayLabel: '小红书官方号',
        platform: 'xiaohongshu',
        autoConfirmed: 1,
        humanConfirmed: 0,
        faqDirectConfirmed: 0,
        unknownConfirmed: 0,
        totalConfirmed: 1,
      },
    ]);

    // Verify 14d cohort includes oldTrigger (3/4 = 0.75)
    const summary14d = readAnalyticsSummary(f.store, '14d', () => nowMs);
    expect(summary14d.totals.autoReplyAttempts).toBe(4);
    expect(summary14d.totals.autoReplySuccessRate).toBe(0.75);
  } finally {
    await f.close();
  }
});

test('AvatarCacheStore enforces sync gate, private root / junction check, LRU recency on read, atomic patch, and vision isolation', async () => {
  const root = privateTemp('avatar-cache-');
  const dbPath = join(root, 'avatar.sqlite');
  const store = new EventStore(dbPath, true);
  try {
    const cache = new AvatarCacheStore(root);
    expect(() => new AvatarCacheStore('official-api://wecom-aibot')).toThrow('AVATAR_CACHE_INVALID_PATH');
    expect(() => new AvatarCacheStore(join(process.cwd(), 'src'))).toThrow('RUNTIME_MUST_BE_PRIVATE');

    // Windows junction / symlink check at runtimeRoot
    const junctionPath = join(root, 'junction-to-src');
    let symlinkCreated = false;
    try {
      symlinkSync(join(process.cwd(), 'src'), junctionPath, 'junction');
      symlinkCreated = true;
    } catch {
      /* Skip symlink creation if platform policy forbids unprivileged symlinks */
    }
    if (symlinkCreated) {
      expect(() => new AvatarCacheStore(junctionPath)).toThrow();
    }

    await expect(cache.saveAvatar(DEFAULT_ACCOUNT_ID, 'CUSTOMER', 'peer-1', PNG_BYTES, false))
      .rejects.toThrow('AVATAR_SYNC_DISABLED');
    await expect(cache.saveAvatar(DEFAULT_ACCOUNT_ID, 'CUSTOMER', 'peer-1', new Uint8Array([1, 2, 3, 4]), true))
      .rejects.toThrow('AVATAR_INVALID_FORMAT');
    await expect(cache.saveAvatar(DEFAULT_ACCOUNT_ID, 'ACCOUNT', 'self', new Uint8Array(AVATAR_MAX_BYTES + 1), false))
      .rejects.toThrow('AVATAR_TOO_LARGE');

    // Atomic setSyncCustomerAvatars patch preserves existing vision/media/tools settings
    const featureStore = new AccountAiFeaturesStore(store.db, DEFAULT_ACCOUNT_ID);
    featureStore.save({
      visionEnabled: true,
      mediaReplyEnabled: true,
      enabledBusinessTools: ['query_order_status'],
      toolEndpoints: { query_order_status: 'https://api.example.com/orders' },
      syncCustomerAvatars: false,
    });
    const patchedOn = featureStore.setSyncCustomerAvatars(true);
    expect(patchedOn).toEqual({
      visionEnabled: true,
      mediaReplyEnabled: true,
      enabledBusinessTools: ['query_order_status'],
      toolEndpoints: { query_order_status: 'https://api.example.com/orders' },
      syncCustomerAvatars: true,
    });

    // Offline ingestion helper respects enabled flag & safely ignores invalid formats
    const ingested = await ingestCachedAvatar(store, { role: 'CUSTOMER', key: 'peer-ingest', bytes: WEBP_BYTES });
    expect(ingested.saved).toBe(true);
    // Direct readPreview defaults syncCustomerAvatars to false so CUSTOMER avatars never leak without explicit opt-in
    expect(cache.readPreview(DEFAULT_ACCOUNT_ID, 'CUSTOMER', 'peer-ingest').found).toBe(false);
    expect(cache.readPreview(DEFAULT_ACCOUNT_ID, 'CUSTOMER', 'peer-ingest', true).found).toBe(true);
    // Turning off syncCustomerAvatars blocks backend CUSTOMER preview immediately
    featureStore.setSyncCustomerAvatars(false);
    expect(cache.readPreview(DEFAULT_ACCOUNT_ID, 'CUSTOMER', 'peer-ingest', false).found).toBe(false);

    // ACCOUNT role allowed regardless of syncCustomerAvatars; traversal keys safely hashed
    await cache.saveAvatar(DEFAULT_ACCOUNT_ID, 'ACCOUNT', '../../etc/passwd', JPEG_BYTES, false);
    const accountPreview = cache.readPreview(DEFAULT_ACCOUNT_ID, 'ACCOUNT', '../../etc/passwd');
    expect(accountPreview.found).toBe(true);
    expect(accountPreview.mimeType).toBe('image/jpeg');
    expect(Buffer.byteLength(accountPreview.dataUrl!, 'utf8')).toBeLessThanOrEqual(AVATAR_MAX_DATA_URL_BYTES);

    // Vision isolation rejects files under avatars/
    const cachedPath = join(cache.avatarsRoot, createHash('sha256').update(DEFAULT_ACCOUNT_ID).digest('hex'), 'test.png');
    expect(() =>
      buildValidatedVisionInput({
        accountFeatures: { visionEnabled: true },
        sourceKind: 'CUSTOMER_MESSAGE_IMAGE',
        filePath: cachedPath,
        bytes: PNG_BYTES,
        mimeType: 'image/png',
      }),
    ).toThrow('VISION_INPUT_FORBIDDEN');

    // Corrupt file on disk must never crash or pass readPreview
    const corruptDir = join(cache.avatarsRoot, createHash('sha256').update('acc_corrupt').digest('hex'));
    await cache.saveAvatar('acc_corrupt', 'CUSTOMER', 'bad', PNG_BYTES, true);
    const files = readdirSync(corruptDir);
    writeFileSync(join(corruptDir, files[0]!), new Uint8Array([0x00, 0x01, 0x02]));
    expect(cache.readPreview('acc_corrupt', 'CUSTOMER', 'bad', true).found).toBe(false);

    // Per-account 500 LRU cap + in-memory access recency preservation without disk writes
    const lruAccount = 'acc_lru';
    await cache.saveAvatar(lruAccount, 'CUSTOMER', 'peer-0', PNG_BYTES, true);
    for (let i = 1; i < AVATAR_CACHE_MAX_ENTRIES; i++) {
      await cache.saveAvatar(lruAccount, 'CUSTOMER', `peer-${i}`, PNG_BYTES, true);
    }
    // Read peer-0 to refresh its recency in memory (read-only!) before inserting 5 more entries
    expect(cache.readPreview(lruAccount, 'CUSTOMER', 'peer-0', true).found).toBe(true);
    for (let i = AVATAR_CACHE_MAX_ENTRIES; i < AVATAR_CACHE_MAX_ENTRIES + 5; i++) {
      await cache.saveAvatar(lruAccount, 'CUSTOMER', `peer-${i}`, PNG_BYTES, true);
    }
    // peer-0 survived because it was accessed; peer-1..peer-5 were evicted!
    expect(cache.readPreview(lruAccount, 'CUSTOMER', 'peer-0', true).found).toBe(true);
    expect(cache.readPreview(lruAccount, 'CUSTOMER', 'peer-1', true).found).toBe(false);
    expect(cache.readPreview(lruAccount, 'CUSTOMER', 'peer-5', true).found).toBe(false);
    expect(cache.readPreview(lruAccount, 'CUSTOMER', `peer-${AVATAR_CACHE_MAX_ENTRIES + 4}`, true).found).toBe(true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('read-only IPC performs zero SQLite writes even on near-expiry sessions and cold secondary runtimes', async () => {
  const f = await modelFixture();
  const pipeSecret = 'ab'.repeat(32);
  try {
    const nowMs = Date.parse('2026-11-27T15:00:00.000+08:00');
    const now = () => nowMs;
    const dbPath = f.store.db.name;
    const accounts = new AccountStore(f.store.db, now, f.root);
    const officialAcc = accounts.registerAccount({
      commandId: randomUUID(),
      platform: 'wecom-aibot',
      connector: 'wecom-aibot',
      displayLabel: '企微客服',
      profileRef: 'official-api://wecom-aibot',
    });
    const webAcc = accounts.registerAccount({
      commandId: randomUUID(),
      platform: 'bilibili',
      connector: 'bilibili',
      displayLabel: 'B站客服',
      profileRef: 'profiles/bili-acc',
    });
    const mockAcc = accounts.registerAccount({
      commandId: randomUUID(),
      platform: 'mock-platform',
      connector: 'mock-platform',
      displayLabel: 'Mock客服',
      profileRef: 'profiles/mock-acc',
    });

    const cache = new AvatarCacheStore(f.root);
    await cache.saveAvatar(DEFAULT_ACCOUNT_ID, 'ACCOUNT', 'self', PNG_BYTES, false);
    await cache.saveAvatar(officialAcc.id, 'ACCOUNT', 'wecom-bot', JPEG_BYTES, false);
    await cache.saveAvatar(webAcc.id, 'CUSTOMER', 'bili-user-1', WEBP_BYTES, true);
    await cache.saveAvatar(mockAcc.id, 'ACCOUNT', 'mock-self', PNG_BYTES, false);
    new AccountAiFeaturesStore(f.store.db, webAcc.id, now).setSyncCustomerAvatars(true);

    // Move operator session close to expiry (< 30m remaining) to prove pure reads do NOT trigger SQLite session renewal writes
    f.store.db.prepare('UPDATE operator_sessions SET expires_at=?').run(Date.now() + 5 * 60_000);

    const context = {
      accounts: f.service.accounts,
      lifecycleCommandIds: new Map<string, string>(),
      dispatch: (body: SidecarCommand, scope?: ProtocolScope) => {
        if (body.command === 'connect' || body.command === 'disconnect') throw new Error('Unexpected lifecycle');
        return dispatchTrustedServiceCommand(f.service, f.token, body, scope);
      },
    };
    const sendV2 = (body: unknown, scope: ProtocolScope) => {
      const parsed = parseSidecarFrame(JSON.stringify({
        protocol: 2, requestId: randomUUID(), secret: pipeSecret, scope, body,
      }), pipeSecret);
      if (parsed.kind !== 'request') throw new Error('Expected request');
      return routeSidecarEnvelope(parsed.envelope, context);
    };

    const changesBefore = f.store.db.prepare('SELECT total_changes()').pluck().get() as number;
    const primaryAvatar = await sendV2(
      { command: 'getAvatarPreview', role: 'ACCOUNT', key: 'self' },
      { kind: 'ACCOUNT', accountRef: DEFAULT_ACCOUNT_ID },
    );
    expect(primaryAvatar).toMatchObject({ ok: true, result: { found: true, mimeType: 'image/png' } });

    const coldMockAnalytics = await sendV2(
      { command: 'getAnalytics', range: '7d' },
      { kind: 'ACCOUNT', accountRef: mockAcc.id },
    );
    expect(coldMockAnalytics).toMatchObject({ ok: true, result: { range: '7d' } });

    const webAvatarRes = await sendV2(
      { command: 'getAvatarPreview', role: 'CUSTOMER', key: 'bili-user-1' },
      { kind: 'ACCOUNT', accountRef: webAcc.id },
    );
    expect(webAvatarRes).toMatchObject({ ok: true, result: { found: true, mimeType: 'image/webp' } });

    // Backend gate blocks customer avatar preview when syncCustomerAvatars is false
    expect(await sendV2(
      { command: 'getAvatarPreview', role: 'CUSTOMER', key: 'bili-user-1' },
      { kind: 'ACCOUNT', accountRef: DEFAULT_ACCOUNT_ID },
    )).toMatchObject({ ok: true, result: { found: false } });

    // Atomic setSyncCustomerAvatars command over protocol v2
    expect(isMutatingClientCommand({ command: 'accountAiFeatures', action: 'setSyncCustomerAvatars', enabled: false })).toBe(true);
    expect(isReadOnlySidecarCommand({ command: 'accountAiFeatures', action: 'setSyncCustomerAvatars', enabled: false })).toBe(false);

    const changesAfterReads = f.store.db.prepare('SELECT total_changes()').pluck().get() as number;
    expect(changesAfterReads).toBe(changesBefore);

    // Rejected unauthorized pure read (session lacks READ permission) must ALSO perform zero SQLite writes
    const noReadToken = f.service.authority.issueSession(['EDIT']);
    const changesBeforeReject = f.store.db.prepare('SELECT total_changes()').pluck().get() as number;
    const rejectContext = {
      accounts: f.service.accounts,
      lifecycleCommandIds: new Map<string, string>(),
      dispatch: (body: SidecarCommand, scope?: ProtocolScope) => {
        if (body.command === 'connect' || body.command === 'disconnect') throw new Error('Unexpected lifecycle');
        return dispatchTrustedServiceCommand(f.service, noReadToken, body, scope);
      },
    };
    const rejectParsed = parseSidecarFrame(JSON.stringify({
      protocol: 2, requestId: randomUUID(), secret: pipeSecret,
      scope: { kind: 'ACCOUNT', accountRef: DEFAULT_ACCOUNT_ID },
      body: { command: 'getAnalytics', range: '7d' },
    }), pipeSecret);
    if (rejectParsed.kind !== 'request' || rejectParsed.envelope.protocol !== 2) throw new Error('Expected v2 request');
    expect(await routeSidecarEnvelope(rejectParsed.envelope, rejectContext)).toMatchObject({
      ok: false, error: 'OPERATOR_PERMISSION_DENIED',
    });
    expect(await routeSidecarEnvelope({
      ...rejectParsed.envelope,
      scope: { kind: 'ACCOUNT', accountRef: mockAcc.id },
      body: { command: 'getAvatarPreview', role: 'ACCOUNT', key: 'mock-self' },
    }, rejectContext)).toMatchObject({ ok: false, error: 'OPERATOR_PERMISSION_DENIED' });
    expect(f.store.db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeReject);

    // Verify InboxItem and ThreadView expose identical targetKey and avatarKey even when actorId is null
    const noActorEv = makeDmEvent(DEFAULT_ACCOUNT_ID, 200, '2026-11-27T14:30:00.000+08:00');
    noActorEv.actorId = null;
    const noActorId = randomUUID();
    f.store.db.prepare('INSERT INTO inbound_events VALUES (?,?,?,?,?,?,?,?,?)')
      .run(noActorId, DEFAULT_ACCOUNT_ID, 'DIRECT_MESSAGE', noActorEv.platformEventId, 'dm', targetKey(noActorEv), digest(noActorEv), JSON.stringify(noActorEv), 'AWAITING_DRAFT');
    const inboxRes = await f.service.dispatch(f.token, { command: 'getInbox', channel: 'ALL', status: 'ALL', page: 0 }) as {
      items: { id: string; actorId: string | null; targetKey: string; avatarKey: string }[];
    };
    const inboxItem = inboxRes.items.find(item => item.id === noActorId)!;
    const threadRes = await f.service.dispatch(f.token, { command: 'getThread', eventId: noActorId }) as {
      targetKey: string; avatarKey: string;
    };
    expect(inboxItem.actorId).toBeNull();
    expect(inboxItem.targetKey).toBe(targetKey(noActorEv));
    expect(inboxItem.avatarKey).toBe(targetKey(noActorEv));
    expect(threadRes.targetKey).toBe(inboxItem.targetKey);
    expect(threadRes.avatarKey).toBe(inboxItem.avatarKey);

    // Grouped comment row: older pending comment A + newer handled reply B from another actor.
    // Inbox row opens A (id=A), so targetKey and avatarKey MUST match A (same as getThread(A)).
    const commentA: InboundEvent = {
      accountId: DEFAULT_ACCOUNT_ID,
      channel: 'COMMENT_NOTIFICATION',
      direction: 'INCOMING',
      kind: 'COMMENT',
      platformEventId: 'c-root-1',
      videoId: 'vid-1',
      commentId: '1001',
      conversationId: null,
      evidenceId: 'ev-c-1',
      actorId: 'commenter-a',
      actorName: 'Commenter A',
      text: '这个怎么卖？',
      occurredAt: '2026-11-27T14:35:00.000+08:00',
      occurredAtPrecisionMs: 1,
    };
    const replyB: InboundEvent = {
      accountId: DEFAULT_ACCOUNT_ID,
      channel: 'COMMENT_NOTIFICATION',
      direction: 'INCOMING',
      kind: 'REPLY',
      platformEventId: 'c-reply-2',
      videoId: 'vid-1',
      commentId: '1002',
      rootCommentId: '1001',
      replyToCommentId: '1002',
      conversationId: null,
      evidenceId: 'ev-c-2',
      actorId: 'replier-b',
      actorName: 'Replier B',
      text: '我也想知道',
      occurredAt: '2026-11-27T14:36:00.000+08:00',
      occurredAtPrecisionMs: 1,
    };
    const commentAId = randomUUID();
    const replyBId = randomUUID();
    f.store.db.prepare('INSERT INTO inbound_events VALUES (?,?,?,?,?,?,?,?,?)')
      .run(commentAId, DEFAULT_ACCOUNT_ID, 'COMMENT_NOTIFICATION', commentA.platformEventId, 'works', targetKey(commentA), digest(commentA), JSON.stringify(commentA), 'AWAITING_DRAFT');
    f.store.db.prepare('INSERT INTO inbound_events VALUES (?,?,?,?,?,?,?,?,?)')
      .run(replyBId, DEFAULT_ACCOUNT_ID, 'COMMENT_NOTIFICATION', replyB.platformEventId, 'works', targetKey(replyB), digest(replyB), JSON.stringify(replyB), 'CONFIRMED');
    const groupedInbox = await f.service.dispatch(f.token, { command: 'getInbox', channel: 'COMMENT_NOTIFICATION', status: 'ALL', page: 0 }) as {
      items: { id: string; actorId: string | null; targetKey: string; avatarKey: string }[];
    };
    const groupedRow = groupedInbox.items.find(item => item.id === commentAId)!;
    const groupedThread = await f.service.dispatch(f.token, { command: 'getThread', eventId: commentAId }) as {
      targetKey: string; avatarKey: string;
    };
    expect(groupedRow).toBeDefined();
    expect(groupedRow.actorId).toBe('commenter-a');
    expect(groupedRow.targetKey).toBe(targetKey(commentA));
    expect(groupedRow.avatarKey).toBe('commenter-a');
    expect(groupedThread.targetKey).toBe(groupedRow.targetKey);
    expect(groupedThread.avatarKey).toBe(groupedRow.avatarKey);

    // Direct offline & online runtimes still support getAnalytics & getAvatarPreview
    const parentOp = f.service.authority.operator(f.token, 'READ');
    const sharedModels = (): SharedMockModels => ({
      models: null,
      provider: new DeepSeekProvider(),
      knowledge: new ReplyKnowledgeStore(f.store),
      state: {
        settings: { model: 'deepseek-flash', persona: '', business: '', rules: '' },
        keyPresent: false,
        modelAuthorized: false,
        modelRoute: null,
        modelUnavailable: null,
        modelBusy: false,
        recovering: false,
      },
      signal: new AbortController().signal,
    });

    const offlineAvatar = dispatchOfflineOfficialRead(
      dbPath, officialAcc, parentOp, { command: 'getAvatarPreview', role: 'ACCOUNT', key: 'wecom-bot' },
      now, sharedModels, () => ({ items: [], page: 0 }),
    ) as AvatarPreviewResult;
    expect(offlineAvatar.found).toBe(true);

    const officialConnector = new WecomAibotPlatformConnector({
      accountId: officialAcc.id,
      botId: 'bot-1',
      secret: 'sec-1',
      wsUrl: 'wss://qyapi.weixin.qq.com/ws',
      allowGroupMessages: false,
      now,
    });
    const officialRuntime = new OfficialAccountRuntime(dbPath, officialConnector, now, sharedModels, () => {}, () => ({ items: [], page: 0 }));
    try {
      const onlineAnalytics = await officialRuntime.dispatch(parentOp, { command: 'getAnalytics', range: '30d' }, () => {}) as AnalyticsSummary;
      expect(onlineAnalytics.range).toBe('30d');
    } finally {
      await officialRuntime.close();
    }

    const webRuntime = new WebAccountRuntime({
      file: dbPath, account: webAcc, now, sharedModels, emit: () => {}, readAudit: () => ({ items: [], page: 0 }),
      workerMode: 'synthetic', allowFixture: true,
    });
    try {
      const webAvatar = await webRuntime.dispatch(parentOp, { command: 'getAvatarPreview', role: 'CUSTOMER', key: 'bili-user-1' }, () => {}) as AvatarPreviewResult;
      expect(webAvatar.found).toBe(true);
    } finally {
      await webRuntime.close();
    }

    const mockConnector = new MockPlatformConnector({ accountId: mockAcc.id });
    const mockRuntime = new MockAccountRuntime(dbPath, mockConnector, now, sharedModels, () => {}, () => ({ items: [], page: 0 }));
    try {
      const mockAvatar = await mockRuntime.dispatch(parentOp, { command: 'getAvatarPreview', role: 'ACCOUNT', key: 'mock-self' }, () => {}) as AvatarPreviewResult;
      expect(mockAvatar.found).toBe(true);
    } finally {
      await mockRuntime.close();
    }

    expect(existsSync(join(f.root, 'avatars'))).toBe(true);
  } finally {
    await f.close();
  }
});

test('readAnalyticsSummary avoids scanning audit_events for out-of-window intents under high historical volume', () => {
  const dir = privateTemp('analytics-perf-');
  const store = new EventStore(join(dir, 'perf.sqlite'), true);
  try {
    const oldIso = '2026-10-01T10:00:00.000+08:00';
    const insertEvent = store.db.prepare('INSERT INTO inbound_events VALUES (?,?,?,?,?,?,?,?,?)');
    const insertDraft = store.db.prepare("INSERT INTO reply_drafts VALUES (?,?,?,?,1,'APPROVED',NULL,NULL)");
    const insertIntent = store.db.prepare("INSERT INTO send_intents VALUES (?,?,?,?,?,?,'CONFIRMED',?)");
    const insertReceipt = store.db.prepare('INSERT INTO delivery_receipts VALUES (?,?,?,?,?)');
    const insertAudit = store.db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?)');

    store.db.transaction(() => {
      for (let i = 0; i < 2000; i++) {
        const eventId = randomUUID();
        const draftId = randomUUID();
        const intentId = randomUUID();
        insertEvent.run(eventId, DEFAULT_ACCOUNT_ID, 'DIRECT_MESSAGE', `old-${i}`, 'dm', `dm:conv-${i}`, `b-${i}`, JSON.stringify(makeDmEvent(DEFAULT_ACCOUNT_ID, i, oldIso)), 'CONFIRMED');
        insertDraft.run(draftId, eventId, 'ok', 'HUMAN_TYPED');
        insertIntent.run(intentId, eventId, draftId, `dm:conv-${i}`, `td-${i}`, `tx-${i}`, oldIso);
        insertReceipt.run(randomUUID(), intentId, 'CONFIRMED', `proof-${i}`, oldIso);
      }
      for (let i = 0; i < 80_040; i++) {
        insertAudit.run(`aud-${i}`, oldIso, 'BACKGROUND_TICK', `ent-${i}`, '{}');
      }
    }).immediate();

    const nowMs = Date.parse('2026-11-27T15:00:00.000+08:00');
    const start = performance.now();
    const summary = readAnalyticsSummary(store, '7d', () => nowMs);
    const elapsedMs = performance.now() - start;

    expect(summary.totals.confirmedTotal).toBe(0);
    expect(elapsedMs).toBeLessThan(500);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
