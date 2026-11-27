import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AccountId } from '../../contracts/account.js';
import { digest, type Channel, type InboundEvent, type StoredEvent } from '../../core/contracts.js';
import type {
  DirectFaqReply,
  HandoffRulesConfig,
  PipelineKnowledgeContext,
  PipelineStageName,
  StageOutcome,
} from './types.js';

const AFTER_SALES_KEYWORDS_PATTERN =
  /(?:售后|退款|退货|换货|补发|漏发|少发|破损|坏了|质量问题|假货|投诉|举报|差评|维权|申请介入|平台介入|退差价|仅退款|refund|complaint|return\s+item)/iu;

const BARGAIN_KEYWORDS_PATTERN =
  /(?:便宜点|便宜些|少点|再少|最低价|底价|砍价|抹零|打折吗|能优惠|优惠多少|太贵了|贵了点|包邮吗可以再便宜|送个|送点|怎么优惠|讲价|discount|cheaper)/iu;

function normalizeExactText(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function isMediaPayload(payload: InboundEvent): boolean {
  return Boolean(payload.contentType || payload.observationIssue === 'DM_CONTENT_UNVERIFIED');
}

export function resolveDirectFaqMatch(
  knowledge: PipelineKnowledgeContext | null,
  queryText: string,
): DirectFaqReply | null {
  if (!knowledge || knowledge.conflicts.length > 0) return null;

  const explicit = knowledge.exactFaqHit ?? knowledge.exactFaqMatch;
  if (explicit && explicit.text.trim().length > 0) {
    return {
      entryId: explicit.id,
      title: explicit.title,
      text: explicit.text.trim(),
      source: 'exact_faq_hit',
    };
  }

  if (knowledge.knowledge.length === 1) {
    const only = knowledge.knowledge[0]!;
    const qNorm = normalizeExactText(queryText);
    const tNorm = normalizeExactText(only.title);
    if (qNorm.length >= 2 && qNorm === tNorm && only.text.trim().length > 0) {
      return {
        entryId: only.id,
        title: only.title,
        text: only.text.trim(),
        source: 'unique_title_match',
      };
    }
  }
  return null;
}

/** 阶段 7：精细转人工独立开关 + 知识库命中/冲突 + 高置信 FAQ 直出判断 */
export function evaluateHandoffRulesAndKnowledge(
  event: StoredEvent,
  mergedText: string,
  knowledge: PipelineKnowledgeContext | null,
  rules: Required<HandoffRulesConfig>,
): { outcome: StageOutcome; directFaqReply: DirectFaqReply | null } {
  const stage: PipelineStageName = 'handoff_rules_and_knowledge';

  if (rules.mediaMessageHandoff && !rules.allowVisionModel && isMediaPayload(event.payload)) {
    return {
      outcome: {
        stage,
        decision: 'handoff_human',
        reasonCode: 'MEDIA_MESSAGE_HANDOFF',
        detail: { contentType: event.payload.contentType ?? 'UNVERIFIED_MEDIA' },
      },
      directFaqReply: null,
    };
  }

  if (rules.afterSalesHandoff && AFTER_SALES_KEYWORDS_PATTERN.test(mergedText)) {
    return {
      outcome: { stage, decision: 'handoff_human', reasonCode: 'AFTER_SALES_KEYWORD_HANDOFF' },
      directFaqReply: null,
    };
  }

  if (rules.bargainHandoff && BARGAIN_KEYWORDS_PATTERN.test(mergedText)) {
    return {
      outcome: { stage, decision: 'handoff_human', reasonCode: 'BARGAIN_KEYWORD_HANDOFF' },
      directFaqReply: null,
    };
  }

  const normalizedLower = mergedText.normalize('NFKC').toLocaleLowerCase();
  for (const trigger of rules.customTriggers) {
    const clean = trigger.trim();
    if (!clean) continue;
    if (normalizedLower.includes(clean.normalize('NFKC').toLocaleLowerCase())) {
      return {
        outcome: {
          stage,
          decision: 'handoff_human',
          reasonCode: 'CUSTOM_HANDOFF_TRIGGER',
          detail: { triggerDigest: digest(clean) },
        },
        directFaqReply: null,
      };
    }
  }

  if (rules.knowledgeConflictHandoff && knowledge && knowledge.conflicts.length > 0) {
    return {
      outcome: {
        stage,
        decision: 'handoff_human',
        reasonCode: 'KNOWLEDGE_CONFLICT_HANDOFF',
        detail: { conflictCount: knowledge.conflicts.length },
      },
      directFaqReply: null,
    };
  }

  if (rules.knowledgeMissHandoff && (!knowledge || knowledge.knowledge.length === 0)) {
    return {
      outcome: {
        stage,
        decision: 'handoff_human',
        reasonCode: 'KNOWLEDGE_MISS_HANDOFF',
        detail: { knowledgeAvailable: Boolean(knowledge), hitCount: knowledge?.knowledge.length ?? 0 },
      },
      directFaqReply: null,
    };
  }

  if (rules.exactFaqDirectReply) {
    const direct = resolveDirectFaqMatch(knowledge, mergedText);
    if (direct) {
      return {
        outcome: {
          stage,
          decision: 'continue',
          reasonCode: 'EXACT_FAQ_DIRECT_MATCH',
          detail: { entryId: direct.entryId, source: direct.source },
        },
        directFaqReply: direct,
      };
    }
  }

  return {
    outcome: {
      stage,
      decision: 'continue',
      reasonCode: 'HANDOFF_RULES_PASSED',
      detail: { knowledgeHits: knowledge?.knowledge.length ?? 0 },
    },
    directFaqReply: null,
  };
}

export type HandoffCategory =
  | 'KNOWLEDGE_MISS'
  | 'MEDIA_MESSAGE'
  | 'AFTER_SALES'
  | 'BARGAIN'
  | 'SENSITIVE_WORD'
  | 'LOOP_BREAKER'
  | 'HUMAN_OWNERSHIP'
  | 'CUSTOM_TRIGGER'
  | 'OTHER';

export const HANDOFF_CATEGORY_LABELS: Readonly<Record<HandoffCategory, string>> = {
  KNOWLEDGE_MISS: '知识未命中/冲突',
  MEDIA_MESSAGE: '买家发图/媒体',
  AFTER_SALES: '售后/退款/投诉',
  BARGAIN: '议价/砍价',
  SENSITIVE_WORD: '敏感词/风控红线',
  LOOP_BREAKER: '死循环保护',
  HUMAN_OWNERSHIP: '人工接管/暂停',
  CUSTOM_TRIGGER: '自定义转人工词',
  OTHER: '其他转人工',
};

export interface HandoffAttributionRecord {
  id: string;
  accountId: AccountId;
  channel: Channel;
  eventId: string;
  stage: PipelineStageName;
  reasonCode: string;
  category: HandoffCategory;
  createdAt: number;
}

export interface HandoffAttributionBucket {
  key: string;
  label: string;
  count: number;
  ratio: number;
  percentage: number;
}

export interface HandoffAttributionSummary {
  accountId: AccountId;
  sinceMs: number | null;
  untilMs: number | null;
  channel: Channel | null;
  total: number;
  byCategory: HandoffAttributionBucket[];
  byReasonCode: HandoffAttributionBucket[];
  byStage: HandoffAttributionBucket[];
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS handoff_attributions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  event_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  category TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handoff_attr_account_time
  ON handoff_attributions(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_handoff_attr_category
  ON handoff_attributions(account_id, category, created_at);`;

function hasTable(db: Database.Database): boolean {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='handoff_attributions'").get(),
  );
}

export function classifyHandoffCategory(reasonCode: string): HandoffCategory {
  switch (reasonCode) {
    case 'KNOWLEDGE_MISS_HANDOFF':
    case 'KNOWLEDGE_CONFLICT_HANDOFF':
    case 'KNOWLEDGE_CONFLICT':
      return 'KNOWLEDGE_MISS';
    case 'MEDIA_MESSAGE_HANDOFF':
    case 'DM_CONTENT_UNVERIFIED':
      return 'MEDIA_MESSAGE';
    case 'AFTER_SALES_KEYWORD_HANDOFF':
      return 'AFTER_SALES';
    case 'BARGAIN_KEYWORD_HANDOFF':
      return 'BARGAIN';
    case 'CUSTOM_SENSITIVE_WORD':
    case 'PLATFORM_REDLINE_WORD':
    case 'OUTBOUND_SENSITIVE_WORD':
    case 'OUTBOUND_PLATFORM_REDLINE':
    case 'PROMPT_INJECTION_DETECTED':
    case 'SENSITIVE_MANUAL_HANDLING':
    case 'MODEL_SENSITIVE_OUTPUT':
      return 'SENSITIVE_WORD';
    case 'LOOP_BREAKER_HANDOFF':
    case 'MODEL_DUPLICATE_OUTPUT':
      return 'LOOP_BREAKER';
    case 'HUMAN_ACTIVE_OWNERSHIP':
    case 'EXTERNAL_HUMAN_REPLIED':
    case 'TARGET_PAUSED':
      return 'HUMAN_OWNERSHIP';
    case 'CUSTOM_HANDOFF_TRIGGER':
      return 'CUSTOM_TRIGGER';
    default:
      return 'OTHER';
  }
}

function toBuckets(
  rows: { key: string; count: number }[],
  total: number,
  labelResolver: (key: string) => string,
): HandoffAttributionBucket[] {
  return rows.map((row) => {
    const ratio = total > 0 ? row.count / total : 0;
    return {
      key: row.key,
      label: labelResolver(row.key),
      count: row.count,
      ratio: Number(ratio.toFixed(4)),
      percentage: Number((ratio * 100).toFixed(1)),
    };
  });
}

/**
 * 精细转人工归因持久化存储。
 * 采用惰性建表 handoff_attributions，不修改 automation_schema 版本号；
 * 只记录事件标识、阶段与固定原因码，绝不存储客户隐私文本或敏感词原文。
 */
export class HandoffAttributionStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {}

  record(input: {
    accountId: AccountId;
    channel: Channel;
    eventId: string;
    stage: PipelineStageName;
    reasonCode: string;
    createdAt?: number;
  }): HandoffAttributionRecord {
    const id = randomUUID();
    const createdAt = input.createdAt ?? this.now();
    const category = classifyHandoffCategory(input.reasonCode);
    this.db
      .transaction(() => {
        this.db.exec(CREATE_TABLE_SQL);
        this.db
          .prepare(
            `INSERT INTO handoff_attributions (id, account_id, channel, event_id, stage, reason_code, category, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, input.accountId, input.channel, input.eventId, input.stage, input.reasonCode, category, createdAt);
      })
      .immediate();

    return {
      id,
      accountId: input.accountId,
      channel: input.channel,
      eventId: input.eventId,
      stage: input.stage,
      reasonCode: input.reasonCode,
      category,
      createdAt,
    };
  }

  /** 按时间窗与可选通道聚合归因分布（表不存在时只读返回空分布，不副作用建表） */
  querySummary(params: {
    accountId: AccountId;
    sinceMs?: number;
    untilMs?: number;
    channel?: Channel;
  }): HandoffAttributionSummary {
    const sinceMs = params.sinceMs ?? null;
    const untilMs = params.untilMs ?? null;
    const channel = params.channel ?? null;

    if (!hasTable(this.db)) {
      return {
        accountId: params.accountId,
        sinceMs,
        untilMs,
        channel,
        total: 0,
        byCategory: [],
        byReasonCode: [],
        byStage: [],
      };
    }

    const conditions = ['account_id=?'];
    const args: unknown[] = [params.accountId];
    if (sinceMs !== null) {
      conditions.push('created_at>=?');
      args.push(sinceMs);
    }
    if (untilMs !== null) {
      conditions.push('created_at<=?');
      args.push(untilMs);
    }
    if (channel !== null) {
      conditions.push('channel=?');
      args.push(channel);
    }
    const where = conditions.join(' AND ');

    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS total FROM handoff_attributions WHERE ${where}`)
      .get(...args) as { total: number };
    const total = totalRow.total;

    const categoryRows = this.db
      .prepare(
        `SELECT category AS key, COUNT(*) AS count FROM handoff_attributions
         WHERE ${where} GROUP BY category ORDER BY count DESC, key ASC`,
      )
      .all(...args) as { key: string; count: number }[];

    const reasonRows = this.db
      .prepare(
        `SELECT reason_code AS key, COUNT(*) AS count FROM handoff_attributions
         WHERE ${where} GROUP BY reason_code ORDER BY count DESC, key ASC`,
      )
      .all(...args) as { key: string; count: number }[];

    const stageRows = this.db
      .prepare(
        `SELECT stage AS key, COUNT(*) AS count FROM handoff_attributions
         WHERE ${where} GROUP BY stage ORDER BY count DESC, key ASC`,
      )
      .all(...args) as { key: string; count: number }[];

    return {
      accountId: params.accountId,
      sinceMs,
      untilMs,
      channel,
      total,
      byCategory: toBuckets(
        categoryRows,
        total,
        (key) => HANDOFF_CATEGORY_LABELS[key as HandoffCategory] ?? HANDOFF_CATEGORY_LABELS.OTHER,
      ),
      byReasonCode: toBuckets(reasonRows, total, (key) => key),
      byStage: toBuckets(stageRows, total, (key) => key),
    };
  }

  listRecent(params: {
    accountId: AccountId;
    limit?: number;
    sinceMs?: number;
    channel?: Channel;
  }): HandoffAttributionRecord[] {
    if (!hasTable(this.db)) return [];
    const conditions = ['account_id=?'];
    const args: unknown[] = [params.accountId];
    if (params.sinceMs !== null && params.sinceMs !== undefined) {
      conditions.push('created_at>=?');
      args.push(params.sinceMs);
    }
    if (params.channel) {
      conditions.push('channel=?');
      args.push(params.channel);
    }
    const limit = Math.max(1, Math.min(500, Math.trunc(params.limit ?? 50)));
    const rows = this.db
      .prepare(
        `SELECT id, account_id, channel, event_id, stage, reason_code, category, created_at
         FROM handoff_attributions
         WHERE ${conditions.join(' AND ')}
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(...args, limit) as {
      id: string;
      account_id: string;
      channel: Channel;
      event_id: string;
      stage: PipelineStageName;
      reason_code: string;
      category: HandoffCategory;
      created_at: number;
    }[];

    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id as AccountId,
      channel: row.channel,
      eventId: row.event_id,
      stage: row.stage,
      reasonCode: row.reason_code,
      category: row.category,
      createdAt: row.created_at,
    }));
  }
}
