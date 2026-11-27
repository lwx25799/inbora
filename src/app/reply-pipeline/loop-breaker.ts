import { digest, type AccountId } from '../../core/contracts.js';
import type { EventStore } from '../../storage/store.js';
import type { LoopBreakerConfig, RecentSentReply } from './types.js';

export interface LoopCheckResult {
  blocked: boolean;
  reasonCode: 'LOOP_BREAKER_DISABLED' | 'LOOP_BREAKER_CLEAR' | 'LOOP_BREAKER_HANDOFF';
  similarity: number;
  candidateDigest: string;
  matchedDigest?: string;
  matchedSentAt?: string;
  recentChecked: number;
}

const NON_CONTENT_PATTERN = /[^\p{L}\p{N}]+/gu;

export function normalizeReplyForLoopCheck(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase().replace(NON_CONTENT_PATTERN, '');
}

function toBigrams(normalized: string): Map<string, number> {
  const chars = Array.from(normalized);
  const map = new Map<string, number>();
  if (chars.length <= 1) {
    if (chars.length === 1) map.set(chars[0]!, 1);
    return map;
  }
  for (let i = 0; i < chars.length - 1; i++) {
    const gram = `${chars[i]!}${chars[i + 1]!}`;
    map.set(gram, (map.get(gram) ?? 0) + 1);
  }
  return map;
}

/**
 * 基于标准化文本字符 2-gram 多重集合 Dice 系数计算相似度（0-1）。
 * - 标准化后完全相同 -> 1.0
 * - 空串不匹配 -> 0
 */
export function computeReplySimilarity(a: string, b: string): number {
  const na = normalizeReplyForLoopCheck(a);
  const nb = normalizeReplyForLoopCheck(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const gramsA = toBigrams(na);
  const gramsB = toBigrams(nb);
  let totalA = 0;
  let totalB = 0;
  let intersection = 0;
  for (const count of gramsA.values()) totalA += count;
  for (const count of gramsB.values()) totalB += count;
  for (const [gram, countA] of gramsA) {
    const countB = gramsB.get(gram);
    if (countB) intersection += Math.min(countA, countB);
  }
  if (totalA + totalB === 0) return 0;
  return (2 * intersection) / (totalA + totalB);
}

/**
 * 从现有单库 SQLite 读取同一目标在冷却窗口内近期已发出的回复。
 * 直接复用 send_intents / reply_drafts / draft_revisions，无需新增迁移表。
 */
export function queryRecentTargetReplies(
  store: EventStore,
  accountId: AccountId,
  targetKey: string,
  windowSize: number,
  autoPolicyOnly = false,
): RecentSentReply[] {
  const limit = Math.max(1, Math.trunc(windowSize));
  const hasRevisions = Boolean(
    store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='draft_revisions'").get(),
  );

  if (hasRevisions) {
    const originClause = autoPolicyOnly ? "AND r.origin='AUTO_POLICY'" : '';
    const rows = store.db
      .prepare(
        `SELECT d.text, i.attempt_started_at AS sent_at, COALESCE(r.origin, 'LEGACY') AS origin
         FROM send_intents i
         JOIN inbound_events e ON e.id=i.event_id
         JOIN reply_drafts d ON d.id=i.draft_id
         LEFT JOIN draft_revisions r ON r.draft_id=d.id AND r.version=d.version
         WHERE e.account_id=? AND i.target_key=?
           AND i.status IN ('INTENT_RECORDED', 'CONFIRMED', 'UNCERTAIN')
           ${originClause}
         ORDER BY i.rowid DESC
         LIMIT ?`,
      )
      .all(accountId, targetKey, limit) as { text: string; sent_at: string; origin: string }[];
    return rows.map((row) => ({ text: row.text, sentAt: row.sent_at, origin: row.origin }));
  }

  const rows = store.db
    .prepare(
      `SELECT d.text, i.attempt_started_at AS sent_at
       FROM send_intents i
       JOIN inbound_events e ON e.id=i.event_id
       JOIN reply_drafts d ON d.id=i.draft_id
       WHERE e.account_id=? AND i.target_key=?
         AND i.status IN ('INTENT_RECORDED', 'CONFIRMED', 'UNCERTAIN')
       ORDER BY i.rowid DESC
       LIMIT ?`,
    )
    .all(accountId, targetKey, limit) as { text: string; sent_at: string }[];
  return rows.map((row) => ({ text: row.text, sentAt: row.sent_at }));
}

export interface CheckReplyLoopInput {
  store: EventStore;
  accountId: AccountId;
  targetKey: string;
  candidateText: string;
  config: Required<LoopBreakerConfig>;
  now: number;
  /** 可选额外近期回复（用于干跑模拟或内存补充窗口） */
  extraRecentReplies?: RecentSentReply[];
}

/**
 * 同句死循环保护：冷却期内拒绝向同一客户重复发送完全相同或高度雷同的回复，触发 LOOP_BREAKER_HANDOFF 转人工。
 */
export function checkReplyLoop(input: CheckReplyLoopInput): LoopCheckResult {
  const { store, accountId, targetKey, candidateText, config, now, extraRecentReplies = [] } = input;
  const normalizedCandidate = normalizeReplyForLoopCheck(candidateText);
  const candidateDigest = digest(normalizedCandidate);

  if (!config.enabled) {
    return {
      blocked: false,
      reasonCode: 'LOOP_BREAKER_DISABLED',
      similarity: 0,
      candidateDigest,
      recentChecked: 0,
    };
  }

  const dbRecent = queryRecentTargetReplies(
    store,
    accountId,
    targetKey,
    config.windowSize,
    config.autoPolicyOnly,
  );
  const allRecent = [...extraRecentReplies, ...dbRecent];
  const threshold = Math.min(1, Math.max(0.5, config.similarityThreshold));
  const cooldownMs = Math.max(0, config.cooldownMs);

  let maxSimilarity = 0;
  let checked = 0;

  for (const item of allRecent) {
    const sentAtMs = Date.parse(item.sentAt);
    if (Number.isFinite(sentAtMs) && cooldownMs > 0 && now - sentAtMs > cooldownMs) {
      continue;
    }
    checked++;
    const similarity = computeReplySimilarity(candidateText, item.text);
    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
    }
    if (similarity >= threshold) {
      return {
        blocked: true,
        reasonCode: 'LOOP_BREAKER_HANDOFF',
        similarity: Number(similarity.toFixed(4)),
        candidateDigest,
        matchedDigest: digest(normalizeReplyForLoopCheck(item.text)),
        matchedSentAt: item.sentAt,
        recentChecked: checked,
      };
    }
  }

  return {
    blocked: false,
    reasonCode: 'LOOP_BREAKER_CLEAR',
    similarity: Number(maxSimilarity.toFixed(4)),
    candidateDigest,
    recentChecked: checked,
  };
}
