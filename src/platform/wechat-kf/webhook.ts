/**
 * WeChat KF webhook verification (GET), encrypted XML callback handling (POST),
 * linear-time XML scanner (immune to ReDoS/XXE/comment/attribute injection),
 * token-idempotent singleflight processor, and public HTTPS callback URL validation.
 */
import { createHash } from 'node:crypto';
import { decrypt, verifySignature } from './crypto.js';
import { assertSafePublicHttpsUrl, resolvePublicEndpoint } from './token.js';
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

export interface WeChatKfWebhookHandlerOutcome {
  readonly truncated?: boolean | undefined;
}

export type WeChatKfWebhookEventHandler = (
  event: WeChatKfWebhookEvent,
  signal?: AbortSignal,
) => Promise<void | WeChatKfWebhookHandlerOutcome>;

export interface WeChatKfWebhookDispatchResult {
  readonly accepted: true;
  readonly duplicate: boolean;
  readonly ignored: boolean;
  readonly synced: boolean;
  readonly truncated?: boolean | undefined;
  readonly reason?: 'OPEN_KFID_MISMATCH' | undefined;
  readonly event: WeChatKfWebhookEvent;
}

const DEFAULT_TOKEN_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_SEEN_TOKENS = 2048;
const TAG_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u;
const ENTITY_MAP: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function isXmlSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function skipSpaces(input: string, start: number): number {
  let pos = start;
  while (pos < input.length && isXmlSpace(input.charCodeAt(pos))) pos++;
  return pos;
}

/** Decode only the 5 standard XML entities in O(N); reject numeric or arbitrary entity references. */
function decodeStrictXmlText(raw: string): string {
  if (!raw.includes('&')) return raw;
  let out = '';
  let pos = 0;
  while (pos < raw.length) {
    const amp = raw.indexOf('&', pos);
    if (amp === -1) {
      out += raw.slice(pos);
      break;
    }
    out += raw.slice(pos, amp);
    const semi = raw.indexOf(';', amp + 1);
    if (semi === -1 || semi - amp > 6) {
      throw new WeChatKfError('WECHAT_KF_INVALID_WEBHOOK_XML');
    }
    const entity = raw.slice(amp + 1, semi);
    const replacement = ENTITY_MAP[entity];
    if (replacement === undefined) {
      throw new WeChatKfError('WECHAT_KF_INVALID_WEBHOOK_XML');
    }
    out += replacement;
    pos = semi + 1;
  }
  return out;
}

/**
 * Strictly linear O(N) flat <xml>...</xml> parser for WeChat KF callback payloads.
 * Rejects DTD/ENTITY, XML comments, attributes, nested elements, duplicate tags, and trailing data.
 */
export function parseFlatWeChatXml(xmlInput: string): ReadonlyMap<string, string> {
  const xml = xmlInput.startsWith('\uFEFF') ? xmlInput.slice(1) : xmlInput;
  if (xml.includes('<!DOCTYPE') || xml.includes('<!ENTITY') || xml.includes('<!--')) {
    throw new WeChatKfError('WECHAT_KF_INVALID_WEBHOOK_XML');
  }

  let pos = skipSpaces(xml, 0);
  if (xml.startsWith('<?xml', pos)) {
    const declEnd = xml.indexOf('?>', pos + 5);
    if (declEnd === -1) throw new WeChatKfError('WECHAT_KF_INVALID_WEBHOOK_XML');
    pos = skipSpaces(xml, declEnd + 2);
  }

  if (!xml.startsWith('<xml>', pos)) {
    throw new WeChatKfError('WECHAT_KF_INVALID_WEBHOOK_XML');
  }
  pos += 5;

  const fields = new Map<string, string>();
  while (pos < xml.length) {
    pos = skipSpaces(xml, pos);
    if (xml.startsWith('</xml>', pos)) {
      pos = skipSpaces(xml, pos + 6);
      if (pos !== xml.length) {
        throw new WeChatKfError('WECHAT_KF_INVALID_WEBHOOK_XML');
      }
      return fields;
    }
    if (xml.charCodeAt(pos) !== 0x3c /* '<' */) {
      throw new WeChatKfError('WECHAT_KF_INVALID_WEBHOOK_XML');
    }
    const openEnd = xml.indexOf('>', pos + 1);
    if (openEnd === -1) {
      throw new WeChatKfError('WECHAT_KF_INVALID_WEBHOOK_XML');
    }
    const tag = xml.slice(pos + 1, openEnd);
    if (!TAG_NAME_PATTERN.test(tag) || fields.has(tag)) {
      throw new WeChatKfError('WECHAT_KF_INVALID_WEBHOOK_XML');
    }

    const contentStart = skipSpaces(xml, openEnd + 1);
    const closeTag = `</${tag}>`;
    let value: string;
    if (xml.startsWith('<![CDATA[', contentStart)) {
      const cdataEnd = xml.indexOf(']]>', contentStart + 9);
      if (cdataEnd === -1) throw new WeChatKfError('WECHAT_KF_INVALID_WEBHOOK_XML');
      value = xml.slice(contentStart + 9, cdataEnd);
      const afterCdata = skipSpaces(xml, cdataEnd + 3);
      if (!xml.startsWith(closeTag, afterCdata)) {
        throw new WeChatKfError('WECHAT_KF_INVALID_WEBHOOK_XML');
      }
      pos = afterCdata + closeTag.length;
    } else {
      const nextLt = xml.indexOf('<', openEnd + 1);
      if (nextLt === -1 || !xml.startsWith(closeTag, nextLt)) {
        throw new WeChatKfError('WECHAT_KF_INVALID_WEBHOOK_XML');
      }
      const rawText = xml.slice(openEnd + 1, nextLt).trim();
      if (rawText.includes('>')) throw new WeChatKfError('WECHAT_KF_INVALID_WEBHOOK_XML');
      value = decodeStrictXmlText(rawText);
      pos = nextLt + closeTag.length;
    }
    fields.set(tag, value);
  }

  throw new WeChatKfError('WECHAT_KF_INVALID_WEBHOOK_XML');
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

function raceSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new WeChatKfError('WECHAT_KF_TIMEOUT'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new WeChatKfError('WECHAT_KF_TIMEOUT'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      err => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}

/** Synchronously validate a public HTTPS relay/tunnel callback URL (no private IP, localhost, or embedded credentials). */
export function assertSafeWebhookCallbackUrl(rawUrl: string): URL {
  return assertSafePublicHttpsUrl(rawUrl, 'WECHAT_KF_INVALID_CALLBACK_URL', false);
}

/** Validate a public HTTPS callback URL including DNS resolution checks against SSRF. */
export async function validateWebhookCallbackUrl(
  rawUrl: string,
  options: { lookup?: WeChatKfDnsLookup | undefined; signal?: AbortSignal | undefined } = {},
): Promise<URL> {
  const validated = await resolvePublicEndpoint(rawUrl, {
    lookup: options.lookup,
    signal: options.signal,
    allowQuery: false,
    errorCode: 'WECHAT_KF_INVALID_CALLBACK_URL',
  });
  return validated.url;
}

/** Read an incoming HTTP body stream with a strict byte ceiling (default 64KB) and AbortSignal support. */
export async function readBoundedWebhookBody(
  stream: AsyncIterable<Buffer | Uint8Array | string>,
  maxBytes: number = WECHAT_KF_WEBHOOK_MAX_BODY_BYTES,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new WeChatKfError('WECHAT_KF_TIMEOUT');
  const iterator = stream[Symbol.asyncIterator]();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new WeChatKfError('WECHAT_KF_TIMEOUT');
      const next = await raceSignal(iterator.next(), signal);
      if (signal?.aborted) throw new WeChatKfError('WECHAT_KF_TIMEOUT');
      if (next.done) break;
      const chunk = next.value;
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
      totalBytes += buf.byteLength;
      if (totalBytes > maxBytes) {
        throw new WeChatKfError('WECHAT_KF_BODY_TOO_LARGE');
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks, totalBytes).toString('utf8');
  } catch (error) {
    await iterator.return?.().catch(() => {});
    throw error;
  }
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

  const outerFields = parseFlatWeChatXml(bodyBuf.toString('utf8'));
  const encrypted = outerFields.get('Encrypt');
  if (!encrypted) {
    throw new WeChatKfError('WECHAT_KF_INVALID_WEBHOOK_XML');
  }

  if (!verifySignature(credentials.token, timestamp, nonce, encrypted, msg_signature)) {
    throw new WeChatKfError('WECHAT_KF_INVALID_SIGNATURE');
  }

  const { message: innerXml } = decrypt(credentials.encodingAESKey, encrypted, credentials.corpId);
  const innerFields = parseFlatWeChatXml(innerXml);

  const msgType = innerFields.get('MsgType');
  const event = innerFields.get('Event');
  const syncToken = innerFields.get('Token');
  const openKfId = innerFields.get('OpenKfId');
  const createTimeRaw = innerFields.get('CreateTime') ?? null;
  const toUserName = innerFields.get('ToUserName') ?? null;

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
  readonly onEvent?: WeChatKfWebhookEventHandler | undefined;
}

export interface WeChatKfWebhookPostOptions {
  readonly onEvent?: WeChatKfWebhookEventHandler | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Stateful webhook processor with bounded Token-based idempotency and singleflight concurrency guard.
 * Reuses only deduplication state across requests; per-request handlers and signals are never cached.
 */
export class WeChatKfWebhookProcessor {
  readonly #readCredentials: () => WeChatKfWebhookCredentials;
  readonly #expectedOpenKfId: string | undefined;
  readonly #maxBodyBytes: number;
  readonly #tokenTtlMs: number;
  readonly #maxSeenTokens: number;
  readonly #now: () => number;
  readonly #defaultOnEvent: WeChatKfWebhookEventHandler | undefined;
  readonly #seenTokens = new Map<string, number>();
  readonly #inFlightTokens = new Map<string, Promise<{ readonly truncated: boolean }>>();

  constructor(options: WeChatKfWebhookProcessorOptions) {
    const provider = options.credentials;
    this.#readCredentials = typeof provider === 'function' ? provider : () => provider;
    this.#expectedOpenKfId = options.expectedOpenKfId;
    this.#maxBodyBytes = options.maxBodyBytes ?? WECHAT_KF_WEBHOOK_MAX_BODY_BYTES;
    this.#tokenTtlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
    this.#maxSeenTokens = options.maxSeenTokens ?? DEFAULT_MAX_SEEN_TOKENS;
    this.#now = options.now ?? (() => Date.now());
    this.#defaultOnEvent = options.onEvent;
  }

  verify(query: WeChatKfWebhookQuery | URLSearchParams): string {
    return handleWebhookVerify(query, this.#readCredentials());
  }

  async handlePost(
    query: WeChatKfWebhookQuery | URLSearchParams,
    body: string | Buffer | AsyncIterable<Buffer | Uint8Array | string>,
    options: WeChatKfWebhookPostOptions = {},
  ): Promise<WeChatKfWebhookDispatchResult> {
    if (options.signal?.aborted) throw new WeChatKfError('WECHAT_KF_TIMEOUT');
    const handler = options.onEvent ?? this.#defaultOnEvent;
    if (!handler) throw new WeChatKfError('WECHAT_KF_OPERATION_UNSUPPORTED');

    const rawBody = typeof body === 'string' || Buffer.isBuffer(body)
      ? body
      : await readBoundedWebhookBody(body, this.#maxBodyBytes, options.signal);

    if (options.signal?.aborted) throw new WeChatKfError('WECHAT_KF_TIMEOUT');
    const event = parseWebhookEvent(query, rawBody, this.#readCredentials(), this.#maxBodyBytes);

    if (this.#expectedOpenKfId && event.openKfId !== this.#expectedOpenKfId) {
      return { accepted: true, duplicate: false, ignored: true, synced: false, reason: 'OPEN_KFID_MISMATCH', event };
    }

    const tokenDigest = createHash('sha256').update(`${event.openKfId}:${event.token}`, 'utf8').digest('hex');
    const nowMs = this.#now();
    this.pruneExpiredTokens(nowMs);

    if (this.#seenTokens.has(tokenDigest)) {
      return { accepted: true, duplicate: true, ignored: false, synced: false, truncated: false, event };
    }

    const existing = this.#inFlightTokens.get(tokenDigest);
    if (existing) {
      const outcome = await raceSignal(existing, options.signal);
      return {
        accepted: true,
        duplicate: true,
        ignored: false,
        synced: false,
        truncated: outcome.truncated,
        event,
      };
    }

    const run = (async (): Promise<{ readonly truncated: boolean }> => {
      const outcome = await handler(event, options.signal);
      const truncated = outcome?.truncated === true;
      if (!truncated) {
        this.recordSeenToken(tokenDigest, this.#now());
      }
      return { truncated };
    })();

    const tracked = run.finally(() => {
      if (this.#inFlightTokens.get(tokenDigest) === tracked) {
        this.#inFlightTokens.delete(tokenDigest);
      }
    });
    void tracked.catch(() => {});
    this.#inFlightTokens.set(tokenDigest, tracked);

    const outcome = await raceSignal(tracked, options.signal);
    return {
      accepted: true,
      duplicate: false,
      ignored: false,
      synced: true,
      truncated: outcome.truncated,
      event,
    };
  }

  private pruneExpiredTokens(nowMs: number): void {
    for (const [key, expiresAt] of this.#seenTokens) {
      if (expiresAt <= nowMs) this.#seenTokens.delete(key);
    }
  }

  private recordSeenToken(tokenDigest: string, nowMs: number): void {
    while (this.#seenTokens.size >= this.#maxSeenTokens) {
      const oldestKey = this.#seenTokens.keys().next().value;
      if (oldestKey === undefined) break;
      this.#seenTokens.delete(oldestKey);
    }
    this.#seenTokens.set(tokenDigest, nowMs + this.#tokenTtlMs);
  }
}
