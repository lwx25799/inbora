/**
 * WeChat KF webhook verification (GET), encrypted XML callback handling (POST),
 * token-idempotent sync triggering, and public HTTPS relay/callback URL validation.
 * Zero external XML dependencies.
 */
import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { decrypt, verifySignature } from './crypto.js';
import { assertSafePublicHttpsUrl, resolvePublicAddresses } from './token.js';
import {
  WECHAT_KF_WEBHOOK_MAX_BODY_BYTES,
  WeChatKfError,
  type WeChatKfDnsLookup,
  type WeChatKfWebhookEvent,
  type WeChatKfWebhookQuery,
} from './types.js';

export interface WeChatKfWebhookCredentials {
  readonly corpId: string;
  readonly token: string;
  readonly encodingAESKey: string;
}

export interface WeChatKfWebhookDispatchResult {
  readonly accepted: true;
  readonly duplicate: boolean;
  readonly ignored: boolean;
  readonly synced: boolean;
  readonly reason?: 'OPEN_KFID_MISMATCH' | undefined;
  readonly event: WeChatKfWebhookEvent;
}

const DEFAULT_TOKEN_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_SEEN_TOKENS = 2048;

function unescapeXmlEntities(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function rejectDangerousXml(xml: string): void {
  if (/<!(?:DOCTYPE|ENTITY)\b/iu.test(xml)) {
    throw new WeChatKfError('WECHAT_KF_INVALID_WEBHOOK_XML');
  }
}

/** Extract a unique XML tag value (supporting CDATA or plain text), rejecting duplicate tags. */
function extractUniqueXmlTag(xml: string, tagName: string): string | null {
  const pattern = new RegExp(
    `<${tagName}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))\\s*</${tagName}>`,
    'gu',
  );
  const matches = [...xml.matchAll(pattern)];
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new WeChatKfError('WECHAT_KF_INVALID_WEBHOOK_XML');
  }
  const match = matches[0]!;
  if (match[1] !== undefined) return match[1];
  return unescapeXmlEntities((match[2] ?? '').trim());
}

function normalizeQuery(input: WeChatKfWebhookQuery | URLSearchParams): WeChatKfWebhookQuery {
  if (input instanceof URLSearchParams) {
    return {
      msg_signature: input.get('msg_signature') ?? undefined,
      timestamp: input.get('timestamp') ?? undefined,
      nonce: input.get('nonce') ?? undefined,
      echostr: input.get('echostr') ?? undefined,
    };
  }
  return input;
}

function assertWebhookCredentials(creds: WeChatKfWebhookCredentials): void {
  if (
    typeof creds.corpId !== 'string' || !creds.corpId.trim() ||
    typeof creds.token !== 'string' || !creds.token.trim() ||
    typeof creds.encodingAESKey !== 'string' || !creds.encodingAESKey.trim()
  ) {
    throw new WeChatKfError('WECHAT_KF_CREDENTIAL_REQUIRED');
  }
}

/** Synchronously validate a public HTTPS relay/tunnel callback URL (no private IP, localhost, or embedded credentials). */
export function assertSafeWebhookCallbackUrl(rawUrl: string): URL {
  return assertSafePublicHttpsUrl(rawUrl, 'WECHAT_KF_INVALID_CALLBACK_URL');
}

/** Validate a public HTTPS callback URL including DNS resolution checks against SSRF. */
export async function validateWebhookCallbackUrl(
  rawUrl: string,
  options: { lookup?: WeChatKfDnsLookup | undefined } = {},
): Promise<URL> {
  const parsed = assertSafeWebhookCallbackUrl(rawUrl);
  await resolvePublicAddresses(parsed.hostname, options.lookup ?? dnsLookup, 'WECHAT_KF_INVALID_CALLBACK_URL');
  return parsed;
}

/** Read an incoming HTTP body stream with a strict byte ceiling (default 64KB). */
export async function readBoundedWebhookBody(
  stream: AsyncIterable<Buffer | Uint8Array | string>,
  maxBytes: number = WECHAT_KF_WEBHOOK_MAX_BODY_BYTES,
): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    totalBytes += buf.byteLength;
    if (totalBytes > maxBytes) {
      throw new WeChatKfError('WECHAT_KF_BODY_TOO_LARGE');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

/** Handle WeChat KF GET URL verification: verify msg_signature, decrypt echostr, and confirm receiverId === corpId. */
export function handleWebhookVerify(
  queryInput: WeChatKfWebhookQuery | URLSearchParams,
  credentials: WeChatKfWebhookCredentials,
): string {
  assertWebhookCredentials(credentials);
  const query = normalizeQuery(queryInput);
  const { msg_signature, timestamp, nonce, echostr } = query;
  if (!msg_signature || !timestamp || !nonce || !echostr) {
    throw new WeChatKfError('WECHAT_KF_INVALID_WEBHOOK_QUERY');
  }
  if (!verifySignature(credentials.token, timestamp, nonce, echostr, msg_signature)) {
    throw new WeChatKfError('WECHAT_KF_INVALID_SIGNATURE');
  }
  const { message } = decrypt(credentials.encodingAESKey, echostr, credentials.corpId);
  return message;
}

/** Parse, verify, decrypt, and validate a WeChat KF POST encrypted XML callback notification. */
export function parseWebhookEvent(
  queryInput: WeChatKfWebhookQuery | URLSearchParams,
  rawXmlBody: string | Buffer,
  credentials: WeChatKfWebhookCredentials,
  maxBytes: number = WECHAT_KF_WEBHOOK_MAX_BODY_BYTES,
): WeChatKfWebhookEvent {
  assertWebhookCredentials(credentials);
  const bodyBuf = typeof rawXmlBody === 'string' ? Buffer.from(rawXmlBody, 'utf8') : rawXmlBody;
  if (bodyBuf.byteLength === 0 || bodyBuf.byteLength > maxBytes) {
    throw new WeChatKfError(bodyBuf.byteLength > maxBytes ? 'WECHAT_KF_BODY_TOO_LARGE' : 'WECHAT_KF_INVALID_WEBHOOK_XML');
  }

  const query = normalizeQuery(queryInput);
  const { msg_signature, timestamp, nonce } = query;
  if (!msg_signature || !timestamp || !nonce) {
    throw new WeChatKfError('WECHAT_KF_INVALID_WEBHOOK_QUERY');
  }

  const rawXml = bodyBuf.toString('utf8');
  rejectDangerousXml(rawXml);
  const encrypted = extractUniqueXmlTag(rawXml, 'Encrypt');
  if (!encrypted) {
    throw new WeChatKfError('WECHAT_KF_INVALID_WEBHOOK_XML');
  }

  if (!verifySignature(credentials.token, timestamp, nonce, encrypted, msg_signature)) {
    throw new WeChatKfError('WECHAT_KF_INVALID_SIGNATURE');
  }

  const { message: innerXml } = decrypt(credentials.encodingAESKey, encrypted, credentials.corpId);
  rejectDangerousXml(innerXml);

  const msgType = extractUniqueXmlTag(innerXml, 'MsgType');
  const event = extractUniqueXmlTag(innerXml, 'Event');
  const syncToken = extractUniqueXmlTag(innerXml, 'Token');
  const openKfId = extractUniqueXmlTag(innerXml, 'OpenKfId');
  const createTimeRaw = extractUniqueXmlTag(innerXml, 'CreateTime');
  const toUserName = extractUniqueXmlTag(innerXml, 'ToUserName');

  if (msgType !== 'event' || event !== 'kf_msg_or_event' || !syncToken || !openKfId) {
    throw new WeChatKfError('WECHAT_KF_INVALID_WEBHOOK_XML');
  }

  const parsedTime = createTimeRaw !== null && /^\d+$/u.test(createTimeRaw)
    ? Number.parseInt(createTimeRaw, 10)
    : null;

  return {
    event: 'kf_msg_or_event',
    token: syncToken,
    openKfId,
    createTime: parsedTime !== null && Number.isSafeInteger(parsedTime) ? parsedTime : null,
    toUserName,
  };
}

export interface WeChatKfWebhookProcessorOptions {
  readonly credentials: WeChatKfWebhookCredentials | (() => WeChatKfWebhookCredentials);
  readonly expectedOpenKfId?: string | undefined;
  readonly maxBodyBytes?: number | undefined;
  readonly tokenTtlMs?: number | undefined;
  readonly maxSeenTokens?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly onEvent: (event: WeChatKfWebhookEvent) => Promise<void>;
}

/**
 * Stateful webhook processor with bounded Token-based idempotency and reentrancy guard.
 * Stores only SHA-256 digests of callback tokens.
 */
export class WeChatKfWebhookProcessor {
  readonly #readCredentials: () => WeChatKfWebhookCredentials;
  readonly #expectedOpenKfId: string | undefined;
  readonly #maxBodyBytes: number;
  readonly #tokenTtlMs: number;
  readonly #maxSeenTokens: number;
  readonly #now: () => number;
  readonly #onEvent: (event: WeChatKfWebhookEvent) => Promise<void>;
  private readonly seenTokens = new Map<string, number>();
  private readonly inFlightTokens = new Set<string>();

  constructor(options: WeChatKfWebhookProcessorOptions) {
    const provider = options.credentials;
    this.#readCredentials = typeof provider === 'function' ? provider : () => provider;
    this.#expectedOpenKfId = options.expectedOpenKfId;
    this.#maxBodyBytes = options.maxBodyBytes ?? WECHAT_KF_WEBHOOK_MAX_BODY_BYTES;
    this.#tokenTtlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
    this.#maxSeenTokens = options.maxSeenTokens ?? DEFAULT_MAX_SEEN_TOKENS;
    this.#now = options.now ?? (() => Date.now());
    this.#onEvent = options.onEvent;
  }

  verify(query: WeChatKfWebhookQuery | URLSearchParams): string {
    return handleWebhookVerify(query, this.#readCredentials());
  }

  async handlePost(
    query: WeChatKfWebhookQuery | URLSearchParams,
    body: string | Buffer | AsyncIterable<Buffer | Uint8Array | string>,
  ): Promise<WeChatKfWebhookDispatchResult> {
    const rawBody = typeof body === 'string' || Buffer.isBuffer(body)
      ? body
      : await readBoundedWebhookBody(body, this.#maxBodyBytes);

    const event = parseWebhookEvent(query, rawBody, this.#readCredentials(), this.#maxBodyBytes);

    if (this.#expectedOpenKfId && event.openKfId !== this.#expectedOpenKfId) {
      return { accepted: true, duplicate: false, ignored: true, synced: false, reason: 'OPEN_KFID_MISMATCH', event };
    }

    const tokenDigest = createHash('sha256').update(`${event.openKfId}:${event.token}`, 'utf8').digest('hex');
    const nowMs = this.#now();
    this.pruneExpiredTokens(nowMs);

    if (this.seenTokens.has(tokenDigest) || this.inFlightTokens.has(tokenDigest)) {
      return { accepted: true, duplicate: true, ignored: false, synced: false, event };
    }

    this.inFlightTokens.add(tokenDigest);
    try {
      await this.#onEvent(event);
      this.recordSeenToken(tokenDigest, this.#now());
      return { accepted: true, duplicate: false, ignored: false, synced: true, event };
    } finally {
      this.inFlightTokens.delete(tokenDigest);
    }
  }

  private pruneExpiredTokens(nowMs: number): void {
    for (const [key, expiresAt] of this.seenTokens) {
      if (expiresAt <= nowMs) this.seenTokens.delete(key);
    }
  }

  private recordSeenToken(tokenDigest: string, nowMs: number): void {
    while (this.seenTokens.size >= this.#maxSeenTokens) {
      const oldestKey = this.seenTokens.keys().next().value;
      if (oldestKey === undefined) break;
      this.seenTokens.delete(oldestKey);
    }
    this.seenTokens.set(tokenDigest, nowMs + this.#tokenTtlMs);
  }
}
