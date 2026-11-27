import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { digest, isStrong, requireSafe, type AccountId, type Channel, type InboundEvent } from '../../core/contracts.js';
import type { KnowledgeInput } from '../../knowledge/contracts.js';
import { decodeEventRow, type EventStore } from '../../storage/store.js';
import { checkInboundSafety, checkOutboundSafety } from './sensitive-guard.js';

export type FaqSuggestionStatus = 'PENDING' | 'ADOPTED' | 'DISMISSED';

export interface FaqSuggestion {
  id: string;
  accountId: AccountId;
  clusterDigest: string;
  channels: Channel[];
  question: string;
  variants: string[];
  suggestedAnswer: string;
  sampleCount: number;
  sourceEventIds: string[];
  status: FaqSuggestionStatus;
  createdAt: number;
  updatedAt: number;
}

export interface GenerateFaqSuggestionsOptions {
  /** 每个簇至少需要多少条相似已确认人工回复才生成建议，默认 2 */
  minClusterSize?: number;
  /** 问题相似度聚类阈值（0-1），默认 0.42 */
  similarityThreshold?: number;
  /** 最多扫描多少条近期已确认人工回复，默认 300 */
  maxSourceRecords?: number;
  /** 最多返回/生成多少条候选建议，默认 50 */
  maxSuggestions?: number;
  now?: () => number;
}

export interface AdoptFaqOverrides {
  title?: string;
  topic?: string;
  text?: string;
  aliases?: string[];
  channels?: Channel[];
}

export interface AdoptFaqResult {
  suggestion: FaqSuggestion;
  knowledgeDraft: KnowledgeInput;
}

interface ConfirmedHumanPair {
  eventId: string;
  channel: Channel;
  question: string;
  answer: string;
  verifiedAt: string;
}

interface FaqSuggestionRow {
  id: string;
  account_id: string;
  cluster_digest: string;
  channels_json: string;
  question: string;
  variants_json: string;
  suggested_answer: string;
  sample_count: number;
  source_event_ids_json: string;
  status: FaqSuggestionStatus;
  created_at: number;
  updated_at: number;
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS faq_suggestion_candidates (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  cluster_digest TEXT NOT NULL,
  channels_json TEXT NOT NULL,
  question TEXT NOT NULL,
  variants_json TEXT NOT NULL,
  suggested_answer TEXT NOT NULL,
  sample_count INTEGER NOT NULL,
  source_event_ids_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(account_id, cluster_digest)
);
CREATE INDEX IF NOT EXISTS idx_faq_suggestions_account_status
  ON faq_suggestion_candidates(account_id, status, updated_at);`;

const ZH_STOP_WORDS = new Set([
  '在吗', '你好', '您好', '请问', '一下', '这个', '那个', '什么', '怎么', '可以',
  '能不能', '帮我', '麻烦', '谢谢', '感谢', '亲', '老板', '客服', '哈喽', '喂',
  '一般', '手机号', '手机', '邮箱', '联系方式',
  '吗', '呢', '啊', '呀', '哦', '吧', '的', '了', '是', '有', '我', '你', '他', '后',
]);

const wordSegmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });

function hasFaqTable(db: Database.Database): boolean {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='faq_suggestion_candidates'").get(),
  );
}

/**
 * 脱敏清理文本中的常见隐私字段（手机号、长编号/订单号/银行卡、身份证、邮箱、外链、社交账号）。
 */
export function redactFaqText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\r\n?/gu, '\n')
    .replace(/(?:https?:\/\/|weixin:\/\/|mqqwpa:\/\/|t\.me\/)\S+/giu, '[链接]')
    .replace(/\bwww\.[a-z0-9-]+\.[a-z]{2,}\S*/giu, '[链接]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/giu, '[邮箱]')
    .replace(/\b\d{17}[\dxX]\b/gu, '[证件号]')
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/gu, '[手机号]')
    .replace(/\b\d{10,24}\b/gu, '[编号]')
    .replace(/((?:微信号|vx号?|wx号?|qq号?)\s*[:：=]?\s*)[a-z0-9_-]{3,}/giu, '$1[账号]')
    .trim();
}

function isSafeForFaq(rawQuestion: string, rawAnswer: string, cleanQuestion: string, cleanAnswer: string): boolean {
  if (!cleanQuestion || !cleanAnswer) return false;
  // 对原文与脱敏后文本检查严禁导流/私下转账/凭据/违禁词
  const guardConfig = { customWords: [], enablePlatformRedline: true, enablePromptInjectionGuard: true };
  const rawCheck = checkInboundSafety(rawQuestion, guardConfig);
  if (rawCheck.blocked && rawCheck.category !== 'pii_credential') return false;
  if (/(?:密码|验证码|身份证|银行卡|私下转账|加微|微信号|vx|wx)/iu.test(rawQuestion)) return false;
  if (/(?:密码|验证码|身份证|银行卡|私下转账|加微|微信号|vx|wx)/iu.test(rawAnswer)) return false;

  const outCheck = checkOutboundSafety(cleanAnswer, guardConfig);
  if (outCheck.blocked) return false;
  return true;
}

function tokenizeQuestion(text: string): Set<string> {
  const cleaned = text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\[[^\]]+\]/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

  const tokens = new Set<string>();
  for (const seg of wordSegmenter.segment(cleaned)) {
    if (!seg.isWordLike) continue;
    const word = seg.segment.trim();
    if (!word || ZH_STOP_WORDS.has(word)) continue;
    tokens.add(word);
    // 中文多字词同步拆 2-gram，提升“多久发货”与“几天发货”之类同义短语召回
    const chars = Array.from(word);
    if (chars.length >= 2 && /[\u4e00-\u9fff]/u.test(word)) {
      for (let i = 0; i < chars.length - 1; i++) {
        const bg = `${chars[i]!}${chars[i + 1]!}`;
        if (!ZH_STOP_WORDS.has(bg)) tokens.add(bg);
      }
    }
  }
  return tokens;
}

function questionSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const token of a) {
    if (b.has(token)) overlap++;
  }
  if (overlap === 0) return 0;
  const dice = (2 * overlap) / (a.size + b.size);
  const containment = overlap / Math.min(a.size, b.size);
  return Math.min(a.size, b.size) >= 2 ? 0.5 * dice + 0.5 * containment : dice;
}

/**
 * 仅查询本账号已确认（CONFIRMED）的人工回复记录（排除未确认外发、纯自动回复、未验证媒体内容）。
 */
function queryConfirmedHumanReplies(store: EventStore, maxRecords: number): ConfirmedHumanPair[] {
  const limit = Math.max(1, Math.trunc(maxRecords));
  const hasRevisions = Boolean(
    store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='draft_revisions'").get(),
  );
  const results: ConfirmedHumanPair[] = [];
  const seenKey = new Set<string>();

  const draftRows = (
    hasRevisions
      ? store.db
          .prepare(
            `SELECT e.id AS event_id, e.payload, e.binding, e.status, d.text AS answer,
                    COALESCE(r.origin, 'LEGACY') AS origin,
                    COALESCE((SELECT MAX(dr.verified_at) FROM delivery_receipts dr WHERE dr.send_intent_id=i.id AND dr.result='CONFIRMED'), i.attempt_started_at) AS verified_at
             FROM send_intents i
             JOIN inbound_events e ON e.id=i.event_id
             JOIN reply_drafts d ON d.id=i.draft_id
             LEFT JOIN draft_revisions r ON r.draft_id=d.id AND r.version=d.version
             WHERE e.account_id=? AND i.status='CONFIRMED'
               AND r.origin IN ('HUMAN_TYPED', 'AI_ASSISTED_APPROVED')
             ORDER BY i.rowid DESC
             LIMIT ?`,
          )
          .all(store.accountId, limit)
      : []
  ) as {
    event_id: string;
    payload: string;
    binding: string;
    status: InboundEvent['direction'];
    answer: string;
    origin: string;
    verified_at: string;
  }[];

  for (const row of draftRows) {
    let event;
    try {
      event = decodeEventRow(
        { id: row.event_id, payload: row.payload, binding: row.binding, status: 'CONFIRMED' },
        store.accountId,
      );
    } catch {
      continue;
    }
    if (event.payload.direction !== 'INCOMING' || !isStrong(event.payload)) continue;
    const dedup = `draft:${row.event_id}`;
    if (seenKey.has(dedup)) continue;
    seenKey.add(dedup);
    results.push({
      eventId: row.event_id,
      channel: event.payload.channel,
      question: event.payload.text,
      answer: row.answer,
      verifiedAt: row.verified_at,
    });
  }

  if (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='human_reply_turns'").get()) {
    const turnRows = store.db
      .prepare(
        `SELECT t.command_id, e.id AS event_id, e.payload, e.binding, t.text AS answer,
                COALESCE(t.verified_at, t.attempt_started_at, '') AS verified_at
         FROM human_reply_turns t
         JOIN inbound_events e ON e.id=t.event_id
         WHERE e.account_id=? AND t.status='CONFIRMED'
         ORDER BY t.rowid DESC
         LIMIT ?`,
      )
      .all(store.accountId, limit) as {
      command_id: string;
      event_id: string;
      payload: string;
      binding: string;
      answer: string;
      verified_at: string;
    }[];

    for (const row of turnRows) {
      let event;
      try {
        event = decodeEventRow(
          { id: row.event_id, payload: row.payload, binding: row.binding, status: 'CONFIRMED' },
          store.accountId,
        );
      } catch {
        continue;
      }
      if (event.payload.direction !== 'INCOMING' || !isStrong(event.payload)) continue;
      const dedup = `turn:${row.command_id}`;
      if (seenKey.has(dedup)) continue;
      seenKey.add(dedup);
      results.push({
        eventId: row.event_id,
        channel: event.payload.channel,
        question: event.payload.text,
        answer: row.answer,
        verifiedAt: row.verified_at,
      });
    }
  }

  return results;
}

function decodeRow(row: FaqSuggestionRow): FaqSuggestion {
  return {
    id: row.id,
    accountId: row.account_id as AccountId,
    clusterDigest: row.cluster_digest,
    channels: JSON.parse(row.channels_json) as Channel[],
    question: row.question,
    variants: JSON.parse(row.variants_json) as string[],
    suggestedAnswer: row.suggested_answer,
    sampleCount: row.sample_count,
    sourceEventIds: JSON.parse(row.source_event_ids_json) as string[],
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 离线纯本地服务：从本账号已确认的人工回复中按相似问题聚类，提炼脱敏后的「待审候选 FAQ 建议」。
 * 支持采纳转化为标准 KnowledgeInput 草稿，或丢弃不再重复提示。
 */
export class FaqSuggestionService {
  constructor(
    private readonly store: EventStore,
    private readonly now: () => number = Date.now,
  ) {}

  generateSuggestions(options: GenerateFaqSuggestionsOptions = {}): FaqSuggestion[] {
    const minClusterSize = Math.max(1, Math.trunc(options.minClusterSize ?? 2));
    const similarityThreshold = Math.min(0.95, Math.max(0.15, options.similarityThreshold ?? 0.36));
    const maxSourceRecords = Math.max(10, Math.trunc(options.maxSourceRecords ?? 300));
    const maxSuggestions = Math.max(1, Math.trunc(options.maxSuggestions ?? 50));
    const now = (options.now ?? this.now)();

    const rawPairs = queryConfirmedHumanReplies(this.store, maxSourceRecords);
    const sanitized: Array<ConfirmedHumanPair & { cleanQuestion: string; cleanAnswer: string; tokens: Set<string> }> = [];
    for (const pair of rawPairs) {
      const cleanQuestion = redactFaqText(pair.question);
      const cleanAnswer = redactFaqText(pair.answer);
      if (!isSafeForFaq(pair.question, pair.answer, cleanQuestion, cleanAnswer)) continue;
      const tokens = tokenizeQuestion(cleanQuestion);
      if (tokens.size === 0) continue;
      sanitized.push({ ...pair, cleanQuestion, cleanAnswer, tokens });
    }

    // 按时间降序稳定性聚类
    interface Cluster {
      items: typeof sanitized;
      centroidTokens: Set<string>;
    }
    const clusters: Cluster[] = [];
    for (const item of sanitized) {
      let bestCluster: Cluster | null = null;
      let bestScore = 0;
      for (const cluster of clusters) {
        const score = questionSimilarity(item.tokens, cluster.centroidTokens);
        if (score >= similarityThreshold && score > bestScore) {
          bestScore = score;
          bestCluster = cluster;
        }
      }
      if (bestCluster) {
        bestCluster.items.push(item);
        for (const token of item.tokens) bestCluster.centroidTokens.add(token);
      } else {
        clusters.push({ items: [item], centroidTokens: new Set(item.tokens) });
      }
    }

    const qualifying = clusters
      .filter((cluster) => cluster.items.length >= minClusterSize)
      .sort((a, b) => b.items.length - a.items.length)
      .slice(0, maxSuggestions);

    const db = this.store.db;
    const saved: FaqSuggestion[] = [];

    db.transaction(() => {
      db.exec(CREATE_TABLE_SQL);
      for (const cluster of qualifying) {
        const uniqueQuestions = [...new Set(cluster.items.map((item) => item.cleanQuestion))];
        const representative = uniqueQuestions[0]!;
        const variants = uniqueQuestions.slice(1, 20);
        // 选取出现频次最高且最新的已确认人工回复作为推荐答案
        const answerCounts = new Map<string, number>();
        for (const item of cluster.items) {
          answerCounts.set(item.cleanAnswer, (answerCounts.get(item.cleanAnswer) ?? 0) + 1);
        }
        let suggestedAnswer = cluster.items[0]!.cleanAnswer;
        let maxCount = 0;
        for (const [ans, count] of answerCounts) {
          if (count > maxCount) {
            maxCount = count;
            suggestedAnswer = ans;
          }
        }
        const channels = [...new Set(cluster.items.map((item) => item.channel))] as Channel[];
        const sourceEventIds = [...new Set(cluster.items.map((item) => item.eventId))];
        const clusterKeyTokens = [...cluster.centroidTokens].sort().slice(0, 12);
        const clusterDigest = digest([this.store.accountId, clusterKeyTokens]);

        const existing = db
          .prepare('SELECT * FROM faq_suggestion_candidates WHERE account_id=? AND cluster_digest=?')
          .get(this.store.accountId, clusterDigest) as FaqSuggestionRow | undefined;

        if (existing) {
          // 已被运营采纳或明确丢弃的同类建议不再复活打扰
          if (existing.status === 'ADOPTED' || existing.status === 'DISMISSED') continue;
          db.prepare(
            `UPDATE faq_suggestion_candidates
             SET channels_json=?, question=?, variants_json=?, suggested_answer=?,
                 sample_count=?, source_event_ids_json=?, updated_at=?
             WHERE id=?`,
          ).run(
            JSON.stringify(channels),
            representative,
            JSON.stringify(variants),
            suggestedAnswer,
            cluster.items.length,
            JSON.stringify(sourceEventIds),
            now,
            existing.id,
          );
          const refreshed = db
            .prepare('SELECT * FROM faq_suggestion_candidates WHERE id=?')
            .get(existing.id) as FaqSuggestionRow;
          saved.push(decodeRow(refreshed));
        } else {
          const id = randomUUID();
          db.prepare(
            `INSERT INTO faq_suggestion_candidates (
               id, account_id, cluster_digest, channels_json, question, variants_json,
               suggested_answer, sample_count, source_event_ids_json, status, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
          ).run(
            id,
            this.store.accountId,
            clusterDigest,
            JSON.stringify(channels),
            representative,
            JSON.stringify(variants),
            suggestedAnswer,
            cluster.items.length,
            JSON.stringify(sourceEventIds),
            now,
            now,
          );
          const inserted = db
            .prepare('SELECT * FROM faq_suggestion_candidates WHERE id=?')
            .get(id) as FaqSuggestionRow;
          saved.push(decodeRow(inserted));
        }
      }
    }).immediate();

    return saved;
  }

  listSuggestions(status?: FaqSuggestionStatus): FaqSuggestion[] {
    if (!hasFaqTable(this.store.db)) return [];
    const rows = (
      status
        ? this.store.db
            .prepare(
              `SELECT * FROM faq_suggestion_candidates WHERE account_id=? AND status=?
               ORDER BY sample_count DESC, updated_at DESC`,
            )
            .all(this.store.accountId, status)
        : this.store.db
            .prepare(
              `SELECT * FROM faq_suggestion_candidates WHERE account_id=?
               ORDER BY sample_count DESC, updated_at DESC`,
            )
            .all(this.store.accountId)
    ) as FaqSuggestionRow[];
    return rows.map(decodeRow);
  }

  /** 采纳候选 FAQ，标记为 ADOPTED 并产出符合 KnowledgeInput 契约的知识库草稿 */
  adoptSuggestion(suggestionId: string, overrides: AdoptFaqOverrides = {}): AdoptFaqResult {
    const db = this.store.db;
    requireSafe(hasFaqTable(db), 'FAQ_SUGGESTION_NOT_FOUND');
    const now = this.now();

    return db
      .transaction(() => {
        const row = db
          .prepare('SELECT * FROM faq_suggestion_candidates WHERE id=? AND account_id=?')
          .get(suggestionId, this.store.accountId) as FaqSuggestionRow | undefined;
        requireSafe(row, 'FAQ_SUGGESTION_NOT_FOUND');
        requireSafe(row.status === 'PENDING', 'FAQ_SUGGESTION_NOT_PENDING');

        db.prepare("UPDATE faq_suggestion_candidates SET status='ADOPTED', updated_at=? WHERE id=?").run(now, row.id);
        const updated = decodeRow({ ...row, status: 'ADOPTED', updated_at: now });

        const title = (overrides.title ?? updated.question).trim().slice(0, 200);
        const topic = (overrides.topic ?? '人工对话提炼FAQ').trim().slice(0, 100);
        const text = (overrides.text ?? updated.suggestedAnswer).trim().slice(0, 100_000);
        const aliases = (overrides.aliases ?? updated.variants)
          .map((item) => item.trim().slice(0, 100))
          .filter(Boolean)
          .slice(0, 30);
        const channels: Channel[] =
          overrides.channels && overrides.channels.length > 0
            ? [...new Set(overrides.channels)]
            : updated.channels.length > 0
              ? updated.channels
              : ['DIRECT_MESSAGE'];

        const knowledgeDraft: KnowledgeInput = {
          title,
          topic,
          text,
          aliases,
          channels,
        };
        this.store.audit('FAQ_SUGGESTION_ADOPTED', updated.id, { sampleCount: updated.sampleCount });
        return { suggestion: updated, knowledgeDraft };
      })
      .immediate();
  }

  /** 丢弃候选 FAQ，后续再次提炼不会重复生成同簇建议 */
  dismissSuggestion(suggestionId: string): FaqSuggestion {
    const db = this.store.db;
    requireSafe(hasFaqTable(db), 'FAQ_SUGGESTION_NOT_FOUND');
    const now = this.now();

    return db
      .transaction(() => {
        const row = db
          .prepare('SELECT * FROM faq_suggestion_candidates WHERE id=? AND account_id=?')
          .get(suggestionId, this.store.accountId) as FaqSuggestionRow | undefined;
        requireSafe(row, 'FAQ_SUGGESTION_NOT_FOUND');
        requireSafe(row.status === 'PENDING', 'FAQ_SUGGESTION_NOT_PENDING');

        db.prepare("UPDATE faq_suggestion_candidates SET status='DISMISSED', updated_at=? WHERE id=?").run(now, row.id);
        this.store.audit('FAQ_SUGGESTION_DISMISSED', row.id, { sampleCount: row.sample_count });
        return decodeRow({ ...row, status: 'DISMISSED', updated_at: now });
      })
      .immediate();
  }
}
