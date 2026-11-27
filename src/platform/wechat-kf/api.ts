/**
 * WeChat Customer Service (WeChat KF) official HTTP API client.
 * Security invariants:
 * - Public HTTPS (443) only, SSRF-checked, zero redirects.
 * - syncMessages (/kf/sync_msg): read-only, retries at most once on TOKEN_EXPIRED_CODES.
 * - sendTextMessage (/kf/send_msg): strict UTF-8 <= 2048B precheck (no splitting),
 *   strictly ZERO retries on network timeout, 5xx, disconnect, or unknown errors,
 *   deterministic WECHAT_KF_SESSION_WINDOW_LIMIT on errcode 95026.
 */
import { createHash } from 'node:crypto';
import type { AccountId } from '../../contracts/account.js';
import { eventSchema } from '../../contracts/events.js';
import {
  digest,
  dmClockToleranceMs,
  proofTimeValid,
  targetKey,
  type InboundEvent,
  type SendProof,
} from '../../core/contracts.js';
import {
  WECHAT_KF_DEFAULT_API_BASE,
  WECHAT_KF_DEFAULT_TIMEOUT_MS,
  WECHAT_KF_MAX_TEXT_BYTES,
  WECHAT_KF_SESSION_WINDOW_LIMIT_ERRCODE,
  WECHAT_KF_TOKEN_EXPIRED_CODES,
  WeChatKfError,
  type SendTextMessageRequest,
  type SendTextMessageResponse,
  type SyncMessagesRequest,
  type SyncMessagesResponse,
  type WeChatKfCredentialProvider,
  type WeChatKfCredentials,
  type WeChatKfDnsLookup,
  type WeChatKfFetch,
  type WeChatKfMessage,
} from './types.js';
import {
  WeChatKfTokenManager,
  assertSafeWeChatKfApiBase,
  endpointDigest as computeEndpointDigest,
  executeSafeWeChatKfJsonRequest,
} from './token.js';

const SYNC_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const SEND_RESPONSE_MAX_BYTES = 64 * 1024;
const WECHAT_MSGID_PATTERN = /^[A-Za-z0-9]{1,32}$/u;
const MAX_EVENT_TEXT_CHARS = 10_000;
const VERIFY_WINDOW_MS = 5 * 60 * 1000;
const HASH64_PATTERN = /^[a-f0-9]{64}$/u;

/** Deterministically derive a WeChat KF compliant msgid ([0-9a-f]{32}) from an Inbora intentId. */
export function deriveWeChatKfMsgId(intentId: string): string {
  return createHash('sha256').update(intentId, 'utf8').digest('hex').slice(0, 32);
}

function sanitizeMessageText(raw: string): string {
  const cleaned = raw.replace(/\r\n?/gu, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '');
  const chars = [...cleaned];
  return chars.length > MAX_EVENT_TEXT_CHARS ? chars.slice(0, MAX_EVENT_TEXT_CHARS).join('') : cleaned;
}

function normalizeMessageContent(msg: WeChatKfMessage): {
  text: string;
  contentType?: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'MIXED';
  observationIssue?: 'DM_CONTENT_UNVERIFIED';
} {
  switch (msg.msgtype) {
    case 'text': {
      const content = typeof msg.text?.content === 'string' ? sanitizeMessageText(msg.text.content) : '';
      if (content.trim().length > 0) return { text: content };
      return { text: '[空文本消息]', contentType: 'MIXED', observationIssue: 'DM_CONTENT_UNVERIFIED' };
    }
    case 'image':
      return { text: '[图片消息]', contentType: 'IMAGE', observationIssue: 'DM_CONTENT_UNVERIFIED' };
    case 'voice':
      return { text: '[语音消息]', contentType: 'AUDIO', observationIssue: 'DM_CONTENT_UNVERIFIED' };
    case 'video':
      return { text: '[视频消息]', contentType: 'VIDEO', observationIssue: 'DM_CONTENT_UNVERIFIED' };
    case 'file':
      return { text: '[文件消息]', contentType: 'MIXED', observationIssue: 'DM_CONTENT_UNVERIFIED' };
    case 'location':
      return { text: '[位置消息]', contentType: 'MIXED', observationIssue: 'DM_CONTENT_UNVERIFIED' };
    case 'link':
      return { text: '[链接消息]', contentType: 'MIXED', observationIssue: 'DM_CONTENT_UNVERIFIED' };
    case 'miniprogram':
      return { text: '[小程序消息]', contentType: 'MIXED', observationIssue: 'DM_CONTENT_UNVERIFIED' };
    default:
      return { text: '[非文本消息]', contentType: 'MIXED', observationIssue: 'DM_CONTENT_UNVERIFIED' };
  }
}

/** Normalize an external WeChat customer message (origin === 3) into a standard Inbora InboundEvent. */
export function normalizeWeChatKfInboundMessage(
  msg: WeChatKfMessage,
  accountId: AccountId,
  openKfId: string,
): InboundEvent | null {
  if (msg.origin !== 3 || msg.msgtype === 'event') return null;
  if (msg.open_kfid && msg.open_kfid !== openKfId) return null;
  if (typeof msg.msgid !== 'string' || !msg.msgid.trim()) return null;
  if (typeof msg.external_userid !== 'string' || !msg.external_userid.trim()) return null;
  if (msg.external_userid === openKfId) return null;

  const occurredAt = Number.isFinite(msg.send_time) && msg.send_time > 0
    ? new Date(msg.send_time * 1000).toISOString()
    : null;
  const normalized = normalizeMessageContent(msg);

  return eventSchema.parse({
    accountId,
    channel: 'DIRECT_MESSAGE',
    platformEventId: msg.msgid,
    actorId: msg.external_userid,
    actorName: null,
    text: normalized.text,
    occurredAt,
    occurredAtPrecisionMs: 1000,
    videoId: null,
    commentId: null,
    conversationId: msg.external_userid,
    direction: 'INCOMING',
    kind: 'DM',
    evidenceId: `wechat-kf:${digest([accountId, openKfId, msg.msgid]).slice(0, 16)}`,
    discovery: 'DIRECT_MESSAGE',
    ...(normalized.observationIssue ? { observationIssue: normalized.observationIssue } : {}),
    ...(normalized.contentType ? { contentType: normalized.contentType } : {}),
  });
}

export interface MatchWeChatKfOutgoingOptions {
  readonly openKfId: string;
  readonly event: InboundEvent;
  readonly text: string;
  readonly notBefore: string;
  readonly nowMs: number;
  readonly contextDigest?: string | undefined;
  readonly expectedMsgId?: string | undefined;
}

/** Match a unique origin=5 outgoing reply within a bounded window for read-only reconciliation. */
export function matchWeChatKfOutgoingProof(
  messages: readonly WeChatKfMessage[],
  options: MatchWeChatKfOutgoingOptions,
): SendProof | null {
  const boundaryMs = Date.parse(options.notBefore);
  if (!Number.isFinite(boundaryMs) || !options.event.conversationId) return null;
  const minTimeMs = boundaryMs - dmClockToleranceMs;
  const maxTimeMs = Math.min(options.nowMs + dmClockToleranceMs, boundaryMs + VERIFY_WINDOW_MS);

  const candidates = messages.filter(msg => {
    if (msg.origin !== 5) return false;
    if (msg.open_kfid && msg.open_kfid !== options.openKfId) return false;
    if (msg.external_userid !== options.event.conversationId) return false;
    if (msg.msgtype !== 'text' || msg.text?.content !== options.text) return false;
    if (typeof msg.msgid !== 'string' || !msg.msgid.trim()) return false;
    if (!Number.isFinite(msg.send_time) || msg.send_time <= 0) return false;
    const sendTimeMs = msg.send_time * 1000;
    return sendTimeMs >= minTimeMs && sendTimeMs <= maxTimeMs;
  });

  if (candidates.length === 0) return null;
  let matched: WeChatKfMessage | undefined;
  if (options.expectedMsgId) {
    const exact = candidates.filter(msg => msg.msgid === options.expectedMsgId);
    if (exact.length === 1) matched = exact[0];
    else if (exact.length > 1) return null;
  }
  if (!matched) {
    if (candidates.length !== 1) return null;
    matched = candidates[0]!;
  }

  const sendTimeMs = matched.send_time * 1000;
  const sentAt = new Date(sendTimeMs).toISOString();
  const key = targetKey(options.event);

  const proof: SendProof = sendTimeMs <= boundaryMs &&
      options.contextDigest && HASH64_PATTERN.test(options.contextDigest)
    ? {
      id: matched.msgid,
      ownId: options.openKfId,
      targetKey: key,
      text: options.text,
      pending: false,
      sentAt,
      clockSkew: {
        boundary: options.notBefore,
        baselineContextDigest: options.contextDigest,
        remainingContextDigest: options.contextDigest,
        refreshedId: matched.msgid,
      },
    }
    : {
      id: matched.msgid,
      ownId: options.openKfId,
      targetKey: key,
      text: options.text,
      pending: false,
      sentAt,
    };

  return proofTimeValid(proof, options.notBefore) ? proof : null;
}

export interface WeChatKfApiClientOptions {
  readonly credentials: WeChatKfCredentials | WeChatKfCredentialProvider;
  readonly apiBaseUrl?: string | undefined;
  readonly fetchImpl?: WeChatKfFetch | undefined;
  readonly lookup?: WeChatKfDnsLookup | undefined;
  readonly timeoutMs?: number | undefined;
  readonly tokenManager?: WeChatKfTokenManager | undefined;
  readonly now?: (() => number) | undefined;
}

interface RawSyncResponse {
  readonly errcode?: unknown;
  readonly errmsg?: unknown;
  readonly next_cursor?: unknown;
  readonly has_more?: unknown;
  readonly msg_list?: unknown;
}

interface RawSendResponse {
  readonly errcode?: unknown;
  readonly errmsg?: unknown;
  readonly msgid?: unknown;
}

export function assertWeChatKfTextLength(content: string): void {
  if (typeof content !== 'string' || !content.length) {
    throw new WeChatKfError('WECHAT_KF_API_ERROR');
  }
  if (Buffer.byteLength(content, 'utf8') > WECHAT_KF_MAX_TEXT_BYTES) {
    throw new WeChatKfError('WECHAT_KF_TEXT_TOO_LONG');
  }
}

export class WeChatKfApiClient {
  readonly apiBaseUrl: string;
  readonly endpointDigest: string;
  readonly tokenManager: WeChatKfTokenManager;
  readonly #readCredentials: WeChatKfCredentialProvider;
  readonly #fetchImpl: WeChatKfFetch | undefined;
  readonly #lookup: WeChatKfDnsLookup | undefined;
  readonly #timeoutMs: number;
  readonly #now: (() => number) | undefined;

  constructor(options: WeChatKfApiClientOptions) {
    this.apiBaseUrl = assertSafeWeChatKfApiBase(options.apiBaseUrl ?? WECHAT_KF_DEFAULT_API_BASE);
    this.endpointDigest = computeEndpointDigest(this.apiBaseUrl);
    this.tokenManager = options.tokenManager ?? new WeChatKfTokenManager();
    const provider = options.credentials;
    this.#readCredentials = typeof provider === 'function' ? provider : () => provider;
    this.#fetchImpl = options.fetchImpl;
    this.#lookup = options.lookup;
    this.#timeoutMs = options.timeoutMs ?? WECHAT_KF_DEFAULT_TIMEOUT_MS;
    this.#now = options.now;
  }

  private credentials(): { corpId: string; appSecret: string } {
    const creds = this.#readCredentials();
    if (!creds || typeof creds.corpId !== 'string' || !creds.corpId.trim() ||
        typeof creds.appSecret !== 'string' || !creds.appSecret.trim()) {
      throw new WeChatKfError('WECHAT_KF_CREDENTIAL_REQUIRED');
    }
    return { corpId: creds.corpId, appSecret: creds.appSecret };
  }

  private async accessToken(signal?: AbortSignal): Promise<string> {
    const { corpId, appSecret } = this.credentials();
    return this.tokenManager.getAccessToken(corpId, appSecret, {
      apiBaseUrl: this.apiBaseUrl,
      fetchImpl: this.#fetchImpl,
      lookup: this.#lookup,
      timeoutMs: this.#timeoutMs,
      now: this.#now,
      signal,
    });
  }

  clearCachedToken(): void {
    const { corpId, appSecret } = this.credentials();
    this.tokenManager.clearAccessToken(corpId, appSecret, this.apiBaseUrl);
  }

  /**
   * Read-only incremental message sync (/kf/sync_msg).
   * Retries at most once if WeChat explicitly returns a token-expired errcode (40001/40014/42001).
   */
  async syncMessages(
    params: SyncMessagesRequest = {},
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<SyncMessagesResponse> {
    const payload: Record<string, unknown> = {};
    if (params.cursor) payload.cursor = params.cursor;
    if (params.token) payload.token = params.token;
    if (params.limit !== undefined) {
      payload.limit = Math.max(1, Math.min(1000, Math.trunc(params.limit)));
    }
    if (params.voice_format !== undefined) payload.voice_format = params.voice_format;
    if (params.open_kfid) payload.open_kfid = params.open_kfid;
    const serialized = JSON.stringify(payload);

    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(options.signal);
      const url = new URL(`${this.apiBaseUrl}/kf/sync_msg`);
      url.searchParams.set('access_token', token);

      const raw = await executeSafeWeChatKfJsonRequest<RawSyncResponse>({
        url: url.toString(),
        method: 'POST',
        body: serialized,
        maxResponseBytes: SYNC_RESPONSE_MAX_BYTES,
        timeoutMs: this.#timeoutMs,
        fetchImpl: this.#fetchImpl,
        lookup: this.#lookup,
        signal: options.signal,
      });

      if (typeof raw.errcode !== 'number') {
        throw new WeChatKfError('WECHAT_KF_RESPONSE_INVALID');
      }
      if (raw.errcode === 0) {
        const msgList = Array.isArray(raw.msg_list) ? (raw.msg_list as WeChatKfMessage[]) : [];
        return {
          errcode: 0,
          errmsg: typeof raw.errmsg === 'string' ? raw.errmsg : 'ok',
          ...(typeof raw.next_cursor === 'string' ? { next_cursor: raw.next_cursor } : {}),
          ...(typeof raw.has_more === 'number' ? { has_more: raw.has_more } : {}),
          msg_list: msgList,
        };
      }
      if (attempt === 0 && WECHAT_KF_TOKEN_EXPIRED_CODES.has(raw.errcode)) {
        this.clearCachedToken();
        continue;
      }
      throw new WeChatKfError(
        WECHAT_KF_TOKEN_EXPIRED_CODES.has(raw.errcode) ? 'WECHAT_KF_TOKEN_EXPIRED' : 'WECHAT_KF_API_ERROR',
        { errcode: raw.errcode },
      );
    }
    throw new WeChatKfError('WECHAT_KF_API_ERROR');
  }

  /**
   * Single-submission text send (/kf/send_msg).
   * Enforces UTF-8 <= 2048B precheck (never splits), NEVER retries on timeout/network/5xx/error,
   * and maps errcode 95026 to deterministic WECHAT_KF_SESSION_WINDOW_LIMIT.
   */
  async sendTextMessage(
    params: SendTextMessageRequest,
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<SendTextMessageResponse> {
    if (!params.touser?.trim() || !params.openKfid?.trim()) {
      throw new WeChatKfError('WECHAT_KF_EVENT_TARGET_REQUIRED');
    }
    assertWeChatKfTextLength(params.content);
    if (params.msgid !== undefined && !WECHAT_MSGID_PATTERN.test(params.msgid)) {
      throw new WeChatKfError('WECHAT_KF_INVALID_MSGID');
    }

    const token = await this.accessToken(options.signal);
    const url = new URL(`${this.apiBaseUrl}/kf/send_msg`);
    url.searchParams.set('access_token', token);

    const body = JSON.stringify({
      touser: params.touser,
      open_kfid: params.openKfid,
      ...(params.msgid !== undefined ? { msgid: params.msgid } : {}),
      msgtype: 'text',
      text: { content: params.content },
    });

    const raw = await executeSafeWeChatKfJsonRequest<RawSendResponse>({
      url: url.toString(),
      method: 'POST',
      body,
      maxResponseBytes: SEND_RESPONSE_MAX_BYTES,
      timeoutMs: this.#timeoutMs,
      fetchImpl: this.#fetchImpl,
      lookup: this.#lookup,
      signal: options.signal,
    });

    if (typeof raw.errcode !== 'number') {
      throw new WeChatKfError('WECHAT_KF_RESPONSE_INVALID');
    }
    if (raw.errcode === 0) {
      if (typeof raw.msgid !== 'string' || !raw.msgid.trim()) {
        throw new WeChatKfError('WECHAT_KF_RESPONSE_INVALID');
      }
      return {
        errcode: 0,
        errmsg: typeof raw.errmsg === 'string' ? raw.errmsg : 'ok',
        msgid: raw.msgid,
      };
    }
    if (raw.errcode === WECHAT_KF_SESSION_WINDOW_LIMIT_ERRCODE) {
      throw new WeChatKfError('WECHAT_KF_SESSION_WINDOW_LIMIT', { errcode: raw.errcode });
    }
    if (WECHAT_KF_TOKEN_EXPIRED_CODES.has(raw.errcode)) {
      // Invalidate cached token for future sends, but NEVER auto-retry the current send.
      this.clearCachedToken();
      throw new WeChatKfError('WECHAT_KF_TOKEN_EXPIRED', { errcode: raw.errcode });
    }
    throw new WeChatKfError('WECHAT_KF_API_ERROR', { errcode: raw.errcode });
  }

  toJSON(): Record<string, unknown> {
    return { endpointDigest: this.endpointDigest };
  }
}
