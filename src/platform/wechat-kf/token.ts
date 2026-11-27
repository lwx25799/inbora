/**
 * Singleflight access_token cache and SSRF-safe public HTTPS transport for WeChat KF.
 * Reuses official-api-base endpoint/DNS/pinnedLookup validation, keeps tokens/secrets in JS #private
 * state with redacted util.inspect/toJSON, and supports pre-write synchronous beforeSend guards.
 */
import { createHash } from 'node:crypto';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { inspect } from 'node:util';
import { Blocked } from '../../core/contracts.js';
import {
  officialApiEndpointDigest,
  parseOfficialApiEndpoint,
  validateOfficialApiEndpoint,
} from '../official-api-base.js';
import {
  WECHAT_KF_DEFAULT_API_BASE,
  WECHAT_KF_DEFAULT_TIMEOUT_MS,
  WECHAT_KF_TOKEN_REFRESH_BUFFER_MS,
  WeChatKfError,
  type WeChatKfDnsLookup,
  type WeChatKfFetch,
  type WeChatKfTokenOptions,
} from './types.js';

const nativeFetch = globalThis.fetch;
const TOKEN_RESPONSE_MAX_BYTES = 64 * 1024;

function mapEndpointError(
  error: unknown,
  defaultCode: 'WECHAT_KF_INVALID_ENDPOINT' | 'WECHAT_KF_INVALID_CALLBACK_URL',
): WeChatKfError {
  if (error instanceof WeChatKfError) return error;
  if (defaultCode === 'WECHAT_KF_INVALID_CALLBACK_URL') {
    return new WeChatKfError('WECHAT_KF_INVALID_CALLBACK_URL');
  }
  if (error instanceof Blocked) {
    if (error.code === 'OFFICIAL_API_ENDPOINT_DNS_FAILED') {
      return new WeChatKfError('WECHAT_KF_NETWORK_ERROR');
    }
    if (
      error.code === 'OFFICIAL_API_ENDPOINT_PROTOCOL_UNSUPPORTED' ||
      error.code === 'OFFICIAL_API_ENDPOINT_CREDENTIALS_FORBIDDEN' ||
      error.code === 'OFFICIAL_API_ENDPOINT_PORT_UNSUPPORTED' ||
      error.code === 'OFFICIAL_API_ENDPOINT_PRIVATE_ADDRESS' ||
      error.code === 'OFFICIAL_API_ENDPOINT_HOST_NOT_ALLOWED'
    ) {
      return new WeChatKfError('WECHAT_KF_UNSAFE_ENDPOINT');
    }
  }
  return new WeChatKfError(defaultCode);
}

/** Validate a public HTTPS (port 443) URL via official-api-base, rejecting credentials, localhost, and private IPs. */
export function assertSafePublicHttpsUrl(
  rawUrl: string,
  errorCode: 'WECHAT_KF_INVALID_ENDPOINT' | 'WECHAT_KF_INVALID_CALLBACK_URL' = 'WECHAT_KF_INVALID_ENDPOINT',
  allowQuery = true,
): URL {
  if (typeof rawUrl !== 'string' || rawUrl.includes('\\')) {
    throw new WeChatKfError(errorCode);
  }
  try {
    return parseOfficialApiEndpoint(rawUrl, { allowedProtocols: ['https:'], allowQuery }).url;
  } catch (error) {
    throw mapEndpointError(error, errorCode);
  }
}

/** Validate and normalize the WeChat KF API base URL (default: https://qyapi.weixin.qq.com/cgi-bin). */
export function assertSafeWeChatKfApiBase(apiBaseUrl: string = WECHAT_KF_DEFAULT_API_BASE): string {
  if (typeof apiBaseUrl !== 'string' || apiBaseUrl.includes('\\')) {
    throw new WeChatKfError('WECHAT_KF_INVALID_ENDPOINT');
  }
  try {
    return parseOfficialApiEndpoint(apiBaseUrl, { allowedProtocols: ['https:'], allowQuery: false }).normalizedUrl;
  } catch (error) {
    throw mapEndpointError(error, 'WECHAT_KF_INVALID_ENDPOINT');
  }
}

/** Compute the canonical 64-char SHA-256 endpoint digest aligned with official-api-base. */
export function endpointDigest(apiBaseUrl: string): string {
  if (typeof apiBaseUrl !== 'string' || apiBaseUrl.includes('\\')) {
    throw new WeChatKfError('WECHAT_KF_INVALID_ENDPOINT');
  }
  try {
    return officialApiEndpointDigest(apiBaseUrl, { allowedProtocols: ['https:'], allowQuery: false });
  } catch (error) {
    throw mapEndpointError(error, 'WECHAT_KF_INVALID_ENDPOINT');
  }
}

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
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

/** Resolve hostname via official-api-base DNS validation under optional AbortSignal. */
export async function resolvePublicEndpoint(
  rawUrl: string,
  options: {
    readonly lookup?: WeChatKfDnsLookup | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly allowQuery?: boolean | undefined;
    readonly errorCode?: 'WECHAT_KF_INVALID_ENDPOINT' | 'WECHAT_KF_INVALID_CALLBACK_URL' | undefined;
  } = {},
): Promise<{ readonly url: URL; readonly pinnedLookup: LookupFunction }> {
  const errorCode = options.errorCode ?? 'WECHAT_KF_INVALID_ENDPOINT';
  if (typeof rawUrl !== 'string' || rawUrl.includes('\\')) {
    throw new WeChatKfError(errorCode);
  }
  const validation = validateOfficialApiEndpoint(rawUrl, {
    allowedProtocols: ['https:'],
    allowQuery: options.allowQuery ?? true,
    lookup: options.lookup,
  });
  void validation.catch(() => {});
  try {
    const validated = await raceWithAbort(validation, options.signal);
    return { url: validated.url, pinnedLookup: validated.pinnedLookup };
  } catch (error) {
    if (error instanceof WeChatKfError) throw error;
    throw mapEndpointError(error, errorCode);
  }
}

async function readBoundedText(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (signal.aborted) {
    void response.body?.cancel().catch(() => {});
    throw new WeChatKfError('WECHAT_KF_TIMEOUT');
  }
  if (!response.body) {
    const text = await raceWithAbort(response.text(), signal);
    if (signal.aborted) throw new WeChatKfError('WECHAT_KF_TIMEOUT');
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new WeChatKfError('WECHAT_KF_RESPONSE_TOO_LARGE');
    return text;
  }
  const reader = response.body.getReader();
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new WeChatKfError('WECHAT_KF_TIMEOUT');
      const { done, value } = await reader.read();
      if (signal.aborted) throw new WeChatKfError('WECHAT_KF_TIMEOUT');
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new WeChatKfError('WECHAT_KF_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
    if (signal.aborted) throw new WeChatKfError('WECHAT_KF_TIMEOUT');
    return Buffer.concat(chunks, total).toString('utf8');
  } catch (err) {
    if (err instanceof WeChatKfError) throw err;
    if (signal.aborted || (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'))) {
      throw new WeChatKfError('WECHAT_KF_TIMEOUT');
    }
    throw new WeChatKfError('WECHAT_KF_NETWORK_ERROR');
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

function sendPinnedHttps(
  url: URL,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  body: Buffer | undefined,
  pinnedLookup: LookupFunction,
  signal: AbortSignal,
): Promise<Response> {
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  const family = isIP(hostname);
  const requestHeaders: Record<string, string> = { ...headers, 'accept-encoding': 'identity' };
  delete requestHeaders.host;
  delete requestHeaders.Host;
  if (body) requestHeaders['content-length'] = String(body.byteLength);

  return new Promise<Response>((resolveResponse, reject) => {
    let settled = false;
    const finishResolve = (res: Response) => {
      if (settled) return;
      settled = true;
      resolveResponse(res);
    };
    const finishReject = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const req = https.request(url, {
      method,
      headers: requestHeaders,
      signal,
      agent: false,
      lookup: pinnedLookup,
      rejectUnauthorized: true,
      ...(family ? {} : { servername: hostname.replace(/\.$/u, '') }),
    }, incoming => {
      const status = incoming.statusCode ?? 500;
      if (status < 200 || status > 599) {
        incoming.destroy();
        finishReject(new WeChatKfError('WECHAT_KF_NETWORK_ERROR'));
        return;
      }
      if (status >= 300 && status < 400) {
        incoming.destroy();
        finishReject(new WeChatKfError('WECHAT_KF_REDIRECT_REJECTED', { httpStatus: status }));
        return;
      }
      if (status >= 400) {
        incoming.destroy();
        finishReject(new WeChatKfError('WECHAT_KF_HTTP_ERROR', { httpStatus: status }));
        return;
      }
      if (status === 204 || status === 205) {
        incoming.destroy();
        finishReject(new WeChatKfError('WECHAT_KF_RESPONSE_INVALID', { httpStatus: status }));
        return;
      }
      const stream = Readable.toWeb(incoming, {
        strategy: {
          highWaterMark: incoming.readableHighWaterMark,
          size: (chunk: Uint8Array) => chunk.byteLength,
        },
      });
      finishResolve(new Response(stream as unknown as ReadableStream<Uint8Array>, { status }));
    });
    req.once('error', err => {
      if (signal.aborted || (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'))) {
        finishReject(new WeChatKfError('WECHAT_KF_TIMEOUT'));
      } else {
        finishReject(new WeChatKfError('WECHAT_KF_NETWORK_ERROR'));
      }
    });
    req.once('close', () => {
      finishReject(new WeChatKfError(signal.aborted ? 'WECHAT_KF_TIMEOUT' : 'WECHAT_KF_NETWORK_ERROR'));
    });
    req.end(body);
  });
}

export interface SafeJsonHttpRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly body?: string | undefined;
  readonly maxResponseBytes: number;
  readonly timeoutMs: number;
  readonly fetchImpl?: WeChatKfFetch | undefined;
  readonly lookup?: WeChatKfDnsLookup | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Synchronous final authorization/safety guard invoked right after DNS and immediately before writing the request. */
  readonly beforeSend?: (() => void) | undefined;
}

/**
 * Execute a single non-redirecting, SSRF-checked HTTPS JSON request.
 * Never retries and never includes URLs or secrets in thrown errors.
 */
export async function executeSafeWeChatKfJsonRequest<T>(request: SafeJsonHttpRequest): Promise<T> {
  const parsed = assertSafePublicHttpsUrl(request.url, 'WECHAT_KF_INVALID_ENDPOINT', true);
  const timeoutSignal = AbortSignal.timeout(request.timeoutMs);
  const combinedSignal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal;

  if (combinedSignal.aborted) {
    throw new WeChatKfError('WECHAT_KF_TIMEOUT');
  }

  const useCustomFetch = request.fetchImpl !== undefined &&
    request.fetchImpl !== nativeFetch &&
    request.fetchImpl !== globalThis.fetch;

  let pinnedLookup: LookupFunction | undefined;
  if (!useCustomFetch || request.lookup !== undefined) {
    const validated = await resolvePublicEndpoint(parsed.toString(), {
      lookup: request.lookup,
      signal: combinedSignal,
      allowQuery: true,
      errorCode: 'WECHAT_KF_INVALID_ENDPOINT',
    });
    pinnedLookup = validated.pinnedLookup;
  }

  if (combinedSignal.aborted) {
    throw new WeChatKfError('WECHAT_KF_TIMEOUT');
  }
  request.beforeSend?.();
  if (combinedSignal.aborted) {
    throw new WeChatKfError('WECHAT_KF_TIMEOUT');
  }

  if (!useCustomFetch) {
    const headers: Record<string, string> = request.body !== undefined
      ? { 'content-type': 'application/json; charset=utf-8' }
      : {};
    const response = await sendPinnedHttps(
      parsed,
      request.method,
      headers,
      request.body !== undefined ? Buffer.from(request.body, 'utf8') : undefined,
      pinnedLookup!,
      combinedSignal,
    );
    return parseBoundedJsonResponse<T>(response, request.maxResponseBytes, combinedSignal);
  }

  let response: Response;
  try {
    response = await request.fetchImpl!(parsed.toString(), {
      method: request.method,
      ...(request.body !== undefined ? { headers: { 'content-type': 'application/json; charset=utf-8' }, body: request.body } : {}),
      redirect: 'manual',
      signal: combinedSignal,
    });
  } catch (err) {
    if (
      combinedSignal.aborted ||
      (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'))
    ) {
      throw new WeChatKfError('WECHAT_KF_TIMEOUT');
    }
    throw new WeChatKfError('WECHAT_KF_NETWORK_ERROR');
  }
  return parseBoundedJsonResponse<T>(response, request.maxResponseBytes, combinedSignal);
}

async function parseBoundedJsonResponse<T>(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void response.body?.cancel().catch(() => {});
    throw new WeChatKfError('WECHAT_KF_TIMEOUT');
  }
  if (response.redirected || response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    void response.body?.cancel().catch(() => {});
    throw new WeChatKfError('WECHAT_KF_REDIRECT_REJECTED', { httpStatus: response.status });
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new WeChatKfError('WECHAT_KF_HTTP_ERROR', { httpStatus: response.status });
  }
  const text = await readBoundedText(response, maxBytes, signal);
  if (signal.aborted) {
    throw new WeChatKfError('WECHAT_KF_TIMEOUT');
  }
  try {
    const data: unknown = JSON.parse(text);
    if (!data || typeof data !== 'object') throw new WeChatKfError('WECHAT_KF_RESPONSE_INVALID');
    return data as T;
  } catch (err) {
    if (err instanceof WeChatKfError) throw err;
    throw new WeChatKfError('WECHAT_KF_RESPONSE_INVALID');
  }
}

/** Build a redacted cache key using sha256(appSecret).slice(0, 16); raw appSecret is never stored as a key. */
export function buildTokenCacheKey(corpId: string, appSecret: string, apiBaseUrl: string = WECHAT_KF_DEFAULT_API_BASE): string {
  if (!corpId.trim() || !appSecret.trim()) {
    throw new WeChatKfError('WECHAT_KF_CREDENTIAL_REQUIRED');
  }
  const secretHash = createHash('sha256').update(appSecret, 'utf8').digest('hex').slice(0, 16);
  const baseFragment = endpointDigest(apiBaseUrl).slice(0, 16);
  return `${corpId}:${secretHash}:${baseFragment}`;
}

interface TokenCacheEntry {
  readonly accessToken: string;
  readonly refreshAt: number;
  readonly expiresAt: number;
}

interface RawTokenResponse {
  readonly errcode?: unknown;
  readonly errmsg?: unknown;
  readonly access_token?: unknown;
  readonly expires_in?: unknown;
}

/** Singleflight WeChat KF access_token manager with 5-minute preemptive refresh and private redacted storage. */
export class WeChatKfTokenManager {
  readonly #cache = new Map<string, TokenCacheEntry>();
  readonly #inFlight = new Map<string, Promise<string>>();
  readonly #generations = new Map<string, number>();
  #globalGeneration = 0;

  /** Expose only redacted cache entry count; never exposes secrets or tokens. */
  cachedKeyCount(): number {
    return this.#cache.size;
  }

  /** Expose redacted cache key list (never raw appSecret or access_token). */
  cachedKeys(): readonly string[] {
    return [...this.#cache.keys()];
  }

  async getAccessToken(
    corpId: string,
    appSecret: string,
    options: WeChatKfTokenOptions = {},
  ): Promise<string> {
    if (!corpId.trim() || !appSecret.trim()) {
      throw new WeChatKfError('WECHAT_KF_CREDENTIAL_REQUIRED');
    }
    const base = assertSafeWeChatKfApiBase(options.apiBaseUrl);
    const key = buildTokenCacheKey(corpId, appSecret, base);
    const now = options.now ?? (() => Date.now());
    const currentMs = now();

    const cached = this.#cache.get(key);
    if (cached && currentMs < cached.refreshAt) {
      return cached.accessToken;
    }

    const startGlobalGen = this.#globalGeneration;
    const startKeyGen = this.#generations.get(key) ?? 0;

    const existing = this.#inFlight.get(key);
    if (existing) {
      const token = await raceWithAbort(existing, options.signal);
      if (this.#globalGeneration !== startGlobalGen || (this.#generations.get(key) ?? 0) !== startKeyGen) {
        throw new WeChatKfError('WECHAT_KF_TOKEN_EXPIRED');
      }
      return token;
    }

    const timeoutMs = options.timeoutMs ?? WECHAT_KF_DEFAULT_TIMEOUT_MS;
    const refreshBufferMs = options.refreshBufferMs ?? WECHAT_KF_TOKEN_REFRESH_BUFFER_MS;

    const pending = (async (): Promise<string> => {
      const tokenUrl = new URL(`${base}/gettoken`);
      tokenUrl.searchParams.set('corpid', corpId);
      tokenUrl.searchParams.set('corpsecret', appSecret);

      const data = await executeSafeWeChatKfJsonRequest<RawTokenResponse>({
        url: tokenUrl.toString(),
        method: 'GET',
        maxResponseBytes: TOKEN_RESPONSE_MAX_BYTES,
        timeoutMs,
        fetchImpl: options.fetchImpl,
        lookup: options.lookup,
      });

      const errcode = typeof data.errcode === 'number' ? data.errcode : -1;
      if (errcode !== 0 || typeof data.access_token !== 'string' || !data.access_token.length) {
        throw new WeChatKfError('WECHAT_KF_TOKEN_FETCH_FAILED', {
          ...(typeof data.errcode === 'number' ? { errcode: data.errcode } : {}),
        });
      }

      // Reject stale in-flight token if clearAccessToken() or clearAll() invalidated this generation.
      if (this.#globalGeneration !== startGlobalGen || (this.#generations.get(key) ?? 0) !== startKeyGen) {
        throw new WeChatKfError('WECHAT_KF_TOKEN_EXPIRED');
      }

      const expiresInSec = typeof data.expires_in === 'number' && Number.isFinite(data.expires_in) && data.expires_in > 0
        ? data.expires_in
        : 7200;
      const fetchedAt = now();
      const expiresAt = fetchedAt + expiresInSec * 1000;
      const effectiveBuffer = Math.min(refreshBufferMs, Math.max(0, expiresInSec * 1000 - 1000));
      const refreshAt = expiresAt - effectiveBuffer;

      this.#cache.set(key, {
        accessToken: data.access_token,
        refreshAt,
        expiresAt,
      });
      return data.access_token;
    })();

    // Bind inFlight cleanup to the shared pending promise, never to an individual caller's abort path.
    const tracked = pending.finally(() => {
      if (this.#inFlight.get(key) === tracked) {
        this.#inFlight.delete(key);
      }
    });
    void tracked.catch(() => {});
    this.#inFlight.set(key, tracked);

    const token = await raceWithAbort(tracked, options.signal);
    if (this.#globalGeneration !== startGlobalGen || (this.#generations.get(key) ?? 0) !== startKeyGen) {
      throw new WeChatKfError('WECHAT_KF_TOKEN_EXPIRED');
    }
    return token;
  }

  clearAccessToken(corpId: string, appSecret: string, apiBaseUrl: string = WECHAT_KF_DEFAULT_API_BASE): void {
    if (!corpId.trim() || !appSecret.trim()) return;
    const base = assertSafeWeChatKfApiBase(apiBaseUrl);
    const key = buildTokenCacheKey(corpId, appSecret, base);
    this.#generations.set(key, (this.#generations.get(key) ?? 0) + 1);
    this.#cache.delete(key);
    this.#inFlight.delete(key);
  }

  clearAll(): void {
    this.#globalGeneration++;
    this.#cache.clear();
    this.#inFlight.clear();
  }

  toJSON(): Record<string, unknown> {
    return { cachedKeys: this.cachedKeys(), inFlightCount: this.#inFlight.size };
  }

  [inspect.custom](): Record<string, unknown> {
    return this.toJSON();
  }
}

const defaultTokenManager = new WeChatKfTokenManager();

export function getAccessToken(
  corpId: string,
  appSecret: string,
  options?: WeChatKfTokenOptions,
): Promise<string> {
  return defaultTokenManager.getAccessToken(corpId, appSecret, options);
}

export function clearAccessToken(
  corpId: string,
  appSecret: string,
  apiBaseUrl?: string,
): void {
  defaultTokenManager.clearAccessToken(corpId, appSecret, apiBaseUrl);
}
