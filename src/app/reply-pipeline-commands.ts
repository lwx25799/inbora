import {
  DEFAULT_REPLY_PIPELINE_PERSISTED_CONFIG,
  replyPipelinePersistedConfigSchema,
  type ReplyPipelineCommand,
  type ReplyPipelinePersistedConfig,
  type ReplyPipelineStatusView,
} from '../contracts/reply-pipeline.js';
import { Blocked, type InboundEvent } from '../core/contracts.js';
import type { AutomationStore } from '../storage/automation-store.js';
import { isEmergencyStopped } from '../storage/emergency-stop.js';
import type { EventStore } from '../storage/store.js';
import type { Grant, ReplyPolicy } from './automation-contracts.js';
import type { WorkbenchAuthority } from './authority.js';
import {
  HandoffAttributionStore,
  PersistentRhythmGate,
  dryRunReplyPipeline as executeDryRunReplyPipeline,
  type PipelineKnowledgeContext,
  type PipelineTrace,
  type ReplyPipelineConfig,
} from './reply-pipeline/index.js';

const SETTINGS_TABLE = 'reply_pipeline_settings';
const SEVEN_DAYS_MS = 7 * 86_400_000;

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS reply_pipeline_settings (
  account_id TEXT PRIMARY KEY,
  config_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`;

interface SettingsRow {
  config_json: string;
  updated_at: number;
}

function hasPipelineSettingsTable(store: EventStore): boolean {
  return Boolean(
    store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(SETTINGS_TABLE),
  );
}

function cloneDefaultConfig(): ReplyPipelinePersistedConfig {
  return {
    rhythmProfile: DEFAULT_REPLY_PIPELINE_PERSISTED_CONFIG.rhythmProfile,
    debounce: { ...DEFAULT_REPLY_PIPELINE_PERSISTED_CONFIG.debounce },
    sensitive: {
      ...DEFAULT_REPLY_PIPELINE_PERSISTED_CONFIG.sensitive,
      customWords: [...DEFAULT_REPLY_PIPELINE_PERSISTED_CONFIG.sensitive.customWords],
    },
    handoff: {
      ...DEFAULT_REPLY_PIPELINE_PERSISTED_CONFIG.handoff,
      customTriggers: [...DEFAULT_REPLY_PIPELINE_PERSISTED_CONFIG.handoff.customTriggers],
    },
    loopBreaker: { ...DEFAULT_REPLY_PIPELINE_PERSISTED_CONFIG.loopBreaker },
  };
}

function readPersistedConfig(store: EventStore): {
  configured: boolean;
  config: ReplyPipelinePersistedConfig;
  updatedAt: number | null;
} {
  if (!hasPipelineSettingsTable(store)) {
    return { configured: false, config: cloneDefaultConfig(), updatedAt: null };
  }
  const row = store.db
    .prepare('SELECT config_json, updated_at FROM reply_pipeline_settings WHERE account_id=?')
    .get(store.accountId) as SettingsRow | undefined;
  if (!row) {
    return { configured: false, config: cloneDefaultConfig(), updatedAt: null };
  }
  try {
    const parsed = replyPipelinePersistedConfigSchema.safeParse(JSON.parse(row.config_json));
    if (parsed.success) {
      return { configured: true, config: parsed.data, updatedAt: row.updated_at };
    }
  } catch {
    /* Fall back to defaults when persisted JSON is malformed. */
  }
  return { configured: false, config: cloneDefaultConfig(), updatedAt: null };
}

export function toReplyPipelineConfig(persisted: ReplyPipelinePersistedConfig): ReplyPipelineConfig {
  return {
    rhythm: {
      profile: persisted.rhythmProfile,
      scope: 'ALL',
    },
    debounce: {
      enabled: persisted.debounce.enabled,
      windowMs: persisted.debounce.windowMs,
    },
    sensitive: {
      customWords: [...persisted.sensitive.customWords],
      enablePlatformRedline: persisted.sensitive.enablePlatformRedline,
      enablePromptInjectionGuard: persisted.sensitive.enablePromptInjectionGuard,
    },
    handoff: {
      mediaMessageHandoff: persisted.handoff.mediaMessageHandoff,
      afterSalesHandoff: persisted.handoff.afterSalesHandoff,
      bargainHandoff: persisted.handoff.bargainHandoff,
      customTriggers: [...persisted.handoff.customTriggers],
      knowledgeMissHandoff: persisted.handoff.knowledgeMissHandoff,
      knowledgeConflictHandoff: persisted.handoff.knowledgeConflictHandoff,
      exactFaqDirectReply: persisted.handoff.exactFaqDirectReply,
    },
    loopBreaker: {
      enabled: persisted.loopBreaker.enabled,
    },
  };
}

/** Read-only effective pipeline config loader; never creates tables when absent. */
export function loadEffectivePipelineConfig(store: EventStore): ReplyPipelineConfig {
  const persisted = readPersistedConfig(store);
  if (persisted.configured) {
    return toReplyPipelineConfig(persisted.config);
  }
  const storedProfile = new PersistentRhythmGate(store.db).getStoredProfile(store.accountId, 'ALL');
  if (storedProfile) {
    return toReplyPipelineConfig({ ...persisted.config, rhythmProfile: storedProfile });
  }
  return toReplyPipelineConfig(persisted.config);
}

/** Read-only status view for reply pipeline settings, rhythm state, and 7-day handoff summary. */
export function getReplyPipelineStatusView(
  store: EventStore,
  now: () => number = Date.now,
): ReplyPipelineStatusView {
  const { configured, config, updatedAt } = readPersistedConfig(store);
  const rhythmState = new PersistentRhythmGate(store.db, { now }).inspectState(store.accountId, 'ALL');
  const currentMs = now();
  const handoffSummary = new HandoffAttributionStore(store.db, now).querySummary({
    accountId: store.accountId,
    sinceMs: currentMs - SEVEN_DAYS_MS,
    untilMs: currentMs,
  });
  return {
    configured,
    config,
    rhythmState,
    handoffSummary,
    updatedAt,
  };
}

export function saveReplyPipelineConfig(
  store: EventStore,
  authority: WorkbenchAuthority,
  token: string,
  config: ReplyPipelinePersistedConfig,
  now: () => number = Date.now,
): ReplyPipelineStatusView {
  authority.requireGuiControl(token);
  const parsed = replyPipelinePersistedConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new Blocked('INVALID_PIPELINE_CONFIG');
  }

  const ts = now();
  const serialized = JSON.stringify(parsed.data);
  store.db
    .transaction(() => {
      store.db.exec(CREATE_TABLE_SQL);
      store.db
        .prepare(
          `INSERT INTO reply_pipeline_settings (account_id, config_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET
             config_json=excluded.config_json,
             updated_at=excluded.updated_at`,
        )
        .run(store.accountId, serialized, ts);
      new PersistentRhythmGate(store.db, { now: () => ts }).setAccountProfile(
        store.accountId,
        parsed.data.rhythmProfile,
        'ALL',
      );
      store.audit('REPLY_PIPELINE_CONFIG_SAVED', store.accountId, {
        rhythmProfile: parsed.data.rhythmProfile,
        debounceEnabled: parsed.data.debounce.enabled,
        debounceWindowMs: parsed.data.debounce.windowMs,
        customWordsCount: parsed.data.sensitive.customWords.length,
        enablePlatformRedline: parsed.data.sensitive.enablePlatformRedline,
        enablePromptInjectionGuard: parsed.data.sensitive.enablePromptInjectionGuard,
        mediaMessageHandoff: parsed.data.handoff.mediaMessageHandoff,
        afterSalesHandoff: parsed.data.handoff.afterSalesHandoff,
        bargainHandoff: parsed.data.handoff.bargainHandoff,
        customTriggersCount: parsed.data.handoff.customTriggers.length,
        knowledgeMissHandoff: parsed.data.handoff.knowledgeMissHandoff,
        knowledgeConflictHandoff: parsed.data.handoff.knowledgeConflictHandoff,
        exactFaqDirectReply: parsed.data.handoff.exactFaqDirectReply,
        loopBreakerEnabled: parsed.data.loopBreaker.enabled,
      });
    })
    .immediate();

  return getReplyPipelineStatusView(store, now);
}

export interface ReplyPipelineCommandContext {
  store: EventStore;
  authority: WorkbenchAuthority;
  automation: AutomationStore | null;
  knowledgeContext: (event: InboundEvent, queryText: string) => PipelineKnowledgeContext | null;
  now?: () => number;
  onConfigSaved?: () => void;
}

export function dryRunReplyPipeline(
  ctx: ReplyPipelineCommandContext,
  token: string,
  input: { eventId: string; candidateReplyText?: string },
): PipelineTrace {
  ctx.authority.operator(token, 'READ');
  const now = ctx.now ?? ctx.authority.now;
  const event = ctx.store.event(input.eventId);
  const config = loadEffectivePipelineConfig(ctx.store);

  const activeGrant = ctx.automation?.active('AUTO_REPLY') as Grant<ReplyPolicy> | null | undefined;
  const ownId = ctx.store.accountOwnId(ctx.store.accountId) ?? '';
  const fallbackGrant: Grant<ReplyPolicy> = {
    version: 1,
    kind: 'AUTO_REPLY',
    createdAt: now(),
    scope: {
      ownId,
      channels: ['DIRECT_MESSAGE', 'COMMENT_NOTIFICATION'],
      model: 'deepseek-flash',
      modelLimit: null,
      expiresAt: null,
      workIds: event.payload.videoId ? [event.payload.videoId] : [],
      futureOwnWorks: false,
      conversationIds: event.payload.conversationId ? [event.payload.conversationId] : [],
      entireInbox: true,
      containsAny: [],
      excludesAny: [],
      instructions: 'dry-run',
      startHour: 0,
      endHour: 24,
      sendLimit: null,
    },
  };
  const effectiveGrant = activeGrant ?? fallbackGrant;
  const effectiveAutomation = (
    activeGrant && ctx.automation
      ? ctx.automation
      : {
          active: () => effectiveGrant,
          state: () => ctx.automation?.state() ?? { emergencyStopped: isEmergencyStopped(ctx.store) },
        }
  ) as unknown as AutomationStore;

  return executeDryRunReplyPipeline({
    store: ctx.store,
    authority: ctx.authority,
    automation: effectiveAutomation,
    grant: effectiveGrant,
    event,
    config,
    dryRun: true,
    ...(input.candidateReplyText !== undefined ? { candidateReplyText: input.candidateReplyText } : {}),
    resolveKnowledge: (ev, mergedText) => ctx.knowledgeContext(ev, mergedText),
    now,
  });
}

export function handleReplyPipelineCommand(
  ctx: ReplyPipelineCommandContext,
  token: string,
  command: ReplyPipelineCommand,
): unknown {
  const now = ctx.now ?? ctx.authority.now;
  switch (command.action) {
    case 'getConfig':
      ctx.authority.operator(token, 'READ');
      return getReplyPipelineStatusView(ctx.store, now);
    case 'saveConfig': {
      const view = saveReplyPipelineConfig(ctx.store, ctx.authority, token, command.config, now);
      ctx.onConfigSaved?.();
      return view;
    }
    case 'dryRun':
      return dryRunReplyPipeline(ctx, token, {
        eventId: command.eventId,
        ...(command.candidateReplyText !== undefined ? { candidateReplyText: command.candidateReplyText } : {}),
      });
  }
}
