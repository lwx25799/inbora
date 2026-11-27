import type { AccountId } from '../../contracts/account.js';
import { eventSchema, type InboundEvent } from '../../contracts/events.js';
import { digest, requireSafe } from '../../core/contracts.js';
import type { WecomInboundMessageBody, WecomWsFrame } from './types.js';

const MAX_EVENT_TEXT_CHARS = 10_000;

export interface NormalizedContent {
  text: string;
  contentType?: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'MIXED';
  observationIssue?: 'DM_CONTENT_UNVERIFIED';
}

export function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= limit) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

export function addBoundedSet<T>(set: Set<T>, value: T, limit: number): void {
  if (set.has(value)) return;
  if (set.size >= limit) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(value);
}

export function parseFirstRunAt(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  requireSafe(Number.isSafeInteger(parsed) && parsed > 0, 'WECOM_FIRST_RUN_AT_INVALID');
  return parsed;
}

function truncateText(value: string): string {
  return value.length <= MAX_EVENT_TEXT_CHARS ? value : value.slice(0, MAX_EVENT_TEXT_CHARS);
}

/**
 * Convert WeCom create_time to ISO-8601 UTC, or return null when missing/invalid
 * so redelivered frames without timestamps produce deterministic eventBinding hashes.
 */
export function normalizeWecomCreateTime(createTime: number | undefined): string | null {
  if (typeof createTime === 'number' && Number.isFinite(createTime) && createTime > 0) {
    const ms = createTime > 1e12 ? Math.trunc(createTime) : Math.trunc(createTime * 1000);
    if (ms >= Date.UTC(2000, 0, 1) && ms <= Date.UTC(2100, 0, 1)) {
      return new Date(ms).toISOString();
    }
  }
  return null;
}

export function normalizeWecomMessageContent(body: WecomInboundMessageBody): NormalizedContent {
  const msgType = typeof body.msgtype === 'string' ? body.msgtype.toLowerCase() : '';
  if (msgType === 'text') {
    const textObj = body.text && typeof body.text === 'object' ? body.text : undefined;
    const raw = typeof textObj?.content === 'string' ? textObj.content.trim() : '';
    if (raw) {
      return { text: truncateText(raw) };
    }
    return { text: '[空文本消息]', observationIssue: 'DM_CONTENT_UNVERIFIED' };
  }
  if (msgType === 'image') {
    return { text: '[图片消息]', contentType: 'IMAGE', observationIssue: 'DM_CONTENT_UNVERIFIED' };
  }
  if (msgType === 'video') {
    return { text: '[视频消息]', contentType: 'VIDEO', observationIssue: 'DM_CONTENT_UNVERIFIED' };
  }
  if (msgType === 'voice') {
    const voiceObj = body.voice && typeof body.voice === 'object' ? body.voice : undefined;
    const transcript = typeof voiceObj?.content === 'string' ? voiceObj.content.trim() : '';
    const text = transcript ? truncateText(`[语音消息] ${transcript}`) : '[语音消息]';
    return { text, contentType: 'AUDIO', observationIssue: 'DM_CONTENT_UNVERIFIED' };
  }
  if (msgType === 'file') {
    return { text: '[文件消息]', contentType: 'MIXED', observationIssue: 'DM_CONTENT_UNVERIFIED' };
  }
  if (msgType === 'mixed') {
    const rawItems = body.mixed && typeof body.mixed === 'object' && Array.isArray(body.mixed.msg_item)
      ? body.mixed.msg_item
      : [];
    const textParts: string[] = [];
    for (const item of rawItems) {
      if (!item || typeof item !== 'object') continue;
      if (item.msgtype !== 'text') continue;
      const itemText = item.text && typeof item.text === 'object' ? item.text.content : undefined;
      if (typeof itemText === 'string' && itemText.trim()) {
        textParts.push(itemText.trim());
      }
    }
    const text = textParts.length > 0
      ? truncateText(`[图文混合消息] ${textParts.join(' ')}`)
      : '[图文混合消息]';
    return { text, contentType: 'MIXED', observationIssue: 'DM_CONTENT_UNVERIFIED' };
  }
  return { text: '[非文本消息]', contentType: 'MIXED', observationIssue: 'DM_CONTENT_UNVERIFIED' };
}

export type InboundNormalizationResult =
  | { kind: 'ok'; event: InboundEvent; msgId: string; conversationId: string }
  | { kind: 'ignore' }
  | { kind: 'invalid' };

export function normalizeWecomInboundFrame(
  frame: WecomWsFrame<WecomInboundMessageBody>,
  context: { accountId: AccountId; ownId: string; allowGroupMessages: boolean },
): InboundNormalizationResult {
  const body = frame.body;
  if (!body || typeof body !== 'object') {
    return { kind: 'invalid' };
  }

  // Strongly require aibotid matching this connector's bot identity.
  if (typeof body.aibotid !== 'string' || body.aibotid.trim() !== context.ownId) {
    return { kind: 'ignore' };
  }

  const msgId = typeof body.msgid === 'string' ? body.msgid.trim() : '';
  const fromObj = body.from && typeof body.from === 'object' ? body.from : undefined;
  const fromUserId = typeof fromObj?.userid === 'string' ? fromObj.userid.trim() : '';
  if (!msgId || !fromUserId) {
    return { kind: 'invalid' };
  }

  // Ignore bot self-echoes.
  if (fromUserId === context.ownId) {
    return { kind: 'ignore' };
  }

  let conversationId: string;
  if (body.chattype === 'group') {
    if (!context.allowGroupMessages) return { kind: 'ignore' };
    const trimmedChatId = typeof body.chatid === 'string' ? body.chatid.trim() : '';
    if (!trimmedChatId) return { kind: 'ignore' };
    conversationId = `group:${trimmedChatId}`;
  } else if (body.chattype === 'single') {
    conversationId = `single:${fromUserId}`;
  } else {
    return { kind: 'ignore' };
  }

  const occurredAt = normalizeWecomCreateTime(body.create_time);
  const content = normalizeWecomMessageContent(body);
  const actorName = typeof fromObj?.name === 'string' && fromObj.name.trim()
    ? fromObj.name.trim()
    : null;

  const parsed = eventSchema.safeParse({
    accountId: context.accountId,
    channel: 'DIRECT_MESSAGE',
    platformEventId: msgId,
    actorId: fromUserId,
    actorName,
    text: content.text,
    occurredAt,
    videoId: null,
    commentId: null,
    conversationId,
    direction: 'INCOMING',
    kind: 'DM',
    evidenceId: `wecom-ws:${digest([context.accountId, msgId, frame.headers.req_id]).slice(0, 16)}`,
    discovery: 'DIRECT_MESSAGE',
    ...(content.contentType ? { contentType: content.contentType } : {}),
    ...(content.observationIssue ? { observationIssue: content.observationIssue } : {}),
  });

  if (!parsed.success) {
    return { kind: 'invalid' };
  }
  return { kind: 'ok', event: parsed.data, msgId, conversationId };
}
