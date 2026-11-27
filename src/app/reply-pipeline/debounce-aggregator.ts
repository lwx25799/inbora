import { isStrong, targetKey, type StoredEvent } from '../../core/contracts.js';
import { decodeEventRow, type EventRow, type EventStore } from '../../storage/store.js';
import type { WorkbenchAuthority } from '../authority.js';
import type { DebounceConfig } from './types.js';

export const MIN_DEBOUNCE_WINDOW_MS = 2_000;
export const MAX_DEBOUNCE_WINDOW_MS = 5_000;
export const DEFAULT_DEBOUNCE_WINDOW_MS = 3_000;

export interface DebounceEvaluationInput {
  store: EventStore;
  authority: WorkbenchAuthority;
  event: StoredEvent;
  config: Required<DebounceConfig>;
  now: number;
  expectedOwnershipGeneration?: number;
}

export interface DebounceEvaluationResult {
  decision: 'continue' | 'defer';
  reasonCode:
    | 'DEBOUNCE_DISABLED'
    | 'DEBOUNCE_NON_DM_BYPASS'
    | 'DEBOUNCE_WINDOW_PENDING'
    | 'DEBOUNCE_SINGLE_READY'
    | 'DEBOUNCE_MERGED_READY'
    | 'DEBOUNCE_OWNERSHIP_CHANGED';
  anchorEvent: StoredEvent;
  /** 参与本次聚合的完整事件列表（按时间升序，包含每条完整原文与 binding） */
  fragments: StoredEvent[];
  /** 受 maxMergedChars 约束的聚合上下文文本（用于知识检索与模型生成） */
  mergedText: string;
  /** 全部碎片的完整未截断拼接文本（仅用于安全与转人工关键词检查，绝不因截断漏检） */
  fullConcatText: string;
  fragmentEventIds: string[];
  latestContextVersion: string;
  ownershipGeneration: number;
  deferUntilMs?: number;
}

export function clampDebounceWindowMs(windowMs: number): number {
  if (!Number.isFinite(windowMs)) return DEFAULT_DEBOUNCE_WINDOW_MS;
  return Math.min(MAX_DEBOUNCE_WINDOW_MS, Math.max(MIN_DEBOUNCE_WINDOW_MS, Math.trunc(windowMs)));
}

function eventTimestampMs(event: StoredEvent, fallback: number): number {
  const parsed = event.payload.occurredAt ? Date.parse(event.payload.occurredAt) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function queryUnreadDmFragments(store: EventStore, event: StoredEvent, maxMessages: number): StoredEvent[] {
  const key = targetKey(event.payload);
  const rows = store.db
    .prepare(
      `SELECT e.id, e.payload, e.binding, e.status FROM inbound_events e
       WHERE e.account_id=? AND e.channel='DIRECT_MESSAGE' AND e.target_key=?
         AND e.status='AWAITING_DRAFT'
         AND NOT EXISTS(SELECT 1 FROM automation_jobs j WHERE j.event_id=e.id)
         AND NOT EXISTS(SELECT 1 FROM reply_drafts d WHERE d.event_id=e.id)
         AND NOT EXISTS(SELECT 1 FROM send_intents i WHERE i.event_id=e.id)
       ORDER BY e.rowid ASC`,
    )
    .all(event.payload.accountId, key) as EventRow[];

  const decoded = rows
    .map((row) => decodeEventRow(row, event.payload.accountId))
    .filter(
      (item) =>
        item.payload.direction === 'INCOMING' &&
        item.payload.kind === 'DM' &&
        item.payload.actorId === event.payload.actorId &&
        isStrong(item.payload),
    );

  // 若事件尚未落库（如场景训练台干跑模拟事件），退回到仅包含当前事件
  if (!decoded.some((item) => item.id === event.id)) {
    return [event];
  }

  decoded.sort((a, b) => {
    const ta = eventTimestampMs(a, 0);
    const tb = eventTimestampMs(b, 0);
    if (ta !== tb) return ta - tb;
    return a.id.localeCompare(b.id);
  });

  if (decoded.length <= maxMessages) return decoded;
  // 保留包含最新碎片的尾部连续片段
  return decoded.slice(-maxMessages);
}

function mergeFragmentTexts(fragments: StoredEvent[], maxMergedChars: number): string {
  const parts: string[] = [];
  let currentLength = 0;
  for (const fragment of fragments) {
    const clean = fragment.payload.text.replace(/\r\n?/gu, '\n').trim();
    if (!clean) continue;
    const separatorLen = parts.length > 0 ? 1 : 0;
    const chars = Array.from(clean);
    if (currentLength + separatorLen + chars.length <= maxMergedChars) {
      parts.push(clean);
      currentLength += separatorLen + chars.length;
    } else {
      const remaining = maxMergedChars - currentLength - separatorLen;
      if (remaining > 0) {
        parts.push(chars.slice(0, remaining).join(''));
      }
      break;
    }
  }
  return parts.join('\n');
}

function concatFullFragmentTexts(fragments: StoredEvent[]): string {
  return fragments
    .map((fragment) => fragment.payload.text.replace(/\r\n?/gu, '\n').trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * 阶段 6：私信碎片消息 2-5 秒静默聚合。
 * - 仅针对 DIRECT_MESSAGE 生效；评论区直接透传。
 * - 静默窗口未到时返回 defer（不跳过、不丢弃），附带建议重试时间 deferUntilMs。
 * - 窗口到期后合并同一会话同一发送者的连续未读短句，并严格绑定最新锚点事件的 contextVersion 与人工接管代际。
 */
export function evaluateDebounce(input: DebounceEvaluationInput): DebounceEvaluationResult {
  const { store, authority, event, config, now, expectedOwnershipGeneration } = input;
  const currentOwnership = authority.ownership(event);
  const currentContextVersion = authority.contextVersion(event);

  if (!config.enabled) {
    return {
      decision: 'continue',
      reasonCode: 'DEBOUNCE_DISABLED',
      anchorEvent: event,
      fragments: [event],
      mergedText: event.payload.text,
      fullConcatText: event.payload.text,
      fragmentEventIds: [event.id],
      latestContextVersion: currentContextVersion,
      ownershipGeneration: currentOwnership.generation,
    };
  }

  if (event.payload.channel !== 'DIRECT_MESSAGE') {
    return {
      decision: 'continue',
      reasonCode: 'DEBOUNCE_NON_DM_BYPASS',
      anchorEvent: event,
      fragments: [event],
      mergedText: event.payload.text,
      fullConcatText: event.payload.text,
      fragmentEventIds: [event.id],
      latestContextVersion: currentContextVersion,
      ownershipGeneration: currentOwnership.generation,
    };
  }

  if (expectedOwnershipGeneration !== undefined && currentOwnership.generation !== expectedOwnershipGeneration) {
    return {
      decision: 'defer',
      reasonCode: 'DEBOUNCE_OWNERSHIP_CHANGED',
      anchorEvent: event,
      fragments: [event],
      mergedText: event.payload.text,
      fullConcatText: event.payload.text,
      fragmentEventIds: [event.id],
      latestContextVersion: currentContextVersion,
      ownershipGeneration: currentOwnership.generation,
    };
  }

  const windowMs = clampDebounceWindowMs(config.windowMs);
  const maxMessages = Math.max(1, Math.trunc(config.maxMessages));
  const maxMergedChars = Math.max(50, Math.trunc(config.maxMergedChars));

  const fragments = queryUnreadDmFragments(store, event, maxMessages);
  const anchorEvent = fragments[fragments.length - 1] ?? event;
  const latestAtMs = eventTimestampMs(anchorEvent, now);
  const elapsedMs = now - latestAtMs;
  const latestContextVersion = authority.contextVersion(anchorEvent);
  const latestOwnership = authority.ownership(anchorEvent);
  const fullConcatText = concatFullFragmentTexts(fragments) || anchorEvent.payload.text;

  if (expectedOwnershipGeneration !== undefined && latestOwnership.generation !== expectedOwnershipGeneration) {
    return {
      decision: 'defer',
      reasonCode: 'DEBOUNCE_OWNERSHIP_CHANGED',
      anchorEvent,
      fragments,
      mergedText: mergeFragmentTexts(fragments, maxMergedChars),
      fullConcatText,
      fragmentEventIds: fragments.map((item) => item.id),
      latestContextVersion,
      ownershipGeneration: latestOwnership.generation,
    };
  }

  // 当最新碎片距当前时刻不足静默窗口（含轻微正向时钟漂移），返回 defer 等待而非跳过丢弃
  if (elapsedMs < windowMs) {
    const deferUntilMs = latestAtMs + windowMs;
    return {
      decision: 'defer',
      reasonCode: 'DEBOUNCE_WINDOW_PENDING',
      anchorEvent,
      fragments,
      mergedText: mergeFragmentTexts(fragments, maxMergedChars),
      fullConcatText,
      fragmentEventIds: fragments.map((item) => item.id),
      latestContextVersion,
      ownershipGeneration: latestOwnership.generation,
      deferUntilMs,
    };
  }

  const merged = fragments.length > 1;
  // 单条消息不截断 mergedText，完整保留原始正文以避免超过 maxMergedChars 的长私信触发 KNOWLEDGE_CONTEXT_MISMATCH
  const mergedText = merged ? mergeFragmentTexts(fragments, maxMergedChars) || anchorEvent.payload.text : anchorEvent.payload.text;
  return {
    decision: 'continue',
    reasonCode: merged ? 'DEBOUNCE_MERGED_READY' : 'DEBOUNCE_SINGLE_READY',
    anchorEvent,
    fragments,
    mergedText,
    fullConcatText,
    fragmentEventIds: fragments.map((item) => item.id),
    latestContextVersion,
    ownershipGeneration: latestOwnership.generation,
  };
}
