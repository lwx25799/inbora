/**
 * Singleflight access_token cache and SSRF-safe public HTTPS transport for WeChat KF.
 * Never uses raw appSecret as a Map key and never emits credentials or URLs with secrets in errors.
 */
import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { isPublicModelAddress } from '../../ai/model-transport.js';
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
const FORBIDDEN_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

function isForbiddenHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.$/u, '');
  if (!lower || lower === 'localhost') return true;
  if (FORBIDDEN_HOST_SUFFIXES.some(suffix => lower.endsWith(suffix))) return true;
  const unwrapped = lower.replace(/^\[|\]$/gu, '');
  const family = isIP(unwrapped);
  if (family !== 0) return !isPublicModelAddress(unwrapped);
  return !lower.includes('.');
}

/** Validate a public HTTPS (port 443) URL, rejecting credentials, localhost, and private IPs. */
export function assertSafePublicHttpsUrl(
  rawUrl: string,
  errorCode: 'WECHAT_KF_INVALID_ENDPOINT' | 'WECHAT_KF_INVALID_CALLBACK_URL' = 'WECHAT_KF_INVALID_ENDPOINT',
): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new WeChatKfError(errorCode);
  }
  if (parsed.protocol !== 'https:') {
    throw new WeChatKfError(errorCode === 'WECHAT_KF_INVALID_CALLBACK_URL' ? errorCode : 'WECHAT_KF_UNSAFE_ENDPOINT');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new WeChatKfError(errorCode === 'WECHAT_KF_INVALID_CALLBACK_URL' ? errorCode : 'WECHAT_KF_UNSAFE_ENDPOINT');
  }
  if (parsed.port !== '' && parsed.port !== '443') {
    throw new WeChatKfError(errorCode === 'WECHAT_KF_INVALID_CALLBACK_URL' ? errorCode : 'WECHAT_KF_UNSAFE_ENDPOINT');
  }
  if (parsed.hash !== '') {
    throw new WeChatKfError(errorCode);
  }
  if (isForbiddenHostname(parsed.hostname)) {
    throw new WeChatKfError(errorCode === 'WECHAT_KF_INVALID_CALLBACK_URL' ? errorCode : 'WECHAT_KF_UNSAFE_ENDPOINT');
  }
  return parsed;
}

/** Validate and normalize the WeChat KF API base URL (default: https://qyapi.weixin.qq.com/cgi-bin). */
export function assertSafeWeChatKfApiBase(apiBaseUrl: string = WECHAT_KF_DEFAULT_API_BASE): string {
  const parsed = assertSafePublicHttpsUrl(apiBaseUrl, 'WECHAT_KF_INVALID_ENDPOINT');
  if (parsed.search !== '') {
    throw new WeChatKfError('WECHAT_KF_INVALID_ENDPOINT');
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/u, '');
  return `${parsed.origin}${normalizedPath}`;
}

/** Compute a redacted digest of an endpoint origin and path without credentials or query params. */
export function endpointDigest(apiBaseUrl: string): string {
  const parsed = assertSafePublicHttpsUrl(apiBaseUrl, 'WECHAT_KF_INVALID_ENDPOINT');
  const canonical = `${parsed.origin}${parsed.pathname.replace(/\/+$/u, '')}`;
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}

/** Resolve hostname via DNS and verify every returned address is a public IP. */
export async function resolvePublicAddresses(
  hostname: string,
  lookup: WeChatKfDnsLookup = dnsLookup,
  errorCode: 'WECHAT_KF_UNSAFE_ENDPOINT' | 'WECHAT_KF_INVALID_CALLBACK_URL' = 'WECHAT_KF_UNSAFE_ENDPOINT',
): Promise<readonly { address: string; family: number }[]> {
  const unwrapped = hostname.replace(/^\[|\]$/gu, '');
  const family = isIP(unwrapped);
  if (family !== 0) {
    if (!isPublicModelAddress(unwrapped)) throw new WeChatKfError(errorCode);
    return [{ address: unwrapped, family }];
  }
  let resolved: { address: string; family: number }[];
  try {
    resolved = await lookup(unwrapped, { all: true });
  } catch {
    throw new WeChatKfError(errorCode === 'WECHAT_KF_INVALID_CALLBACK_URL' ? errorCode : 'WECHAT_KF_NETWORK_ERROR');
  }
  if (!resolved.length || resolved.some(({ address, family: addrFamily }) =>
    isIP(address) !== addrFamily || !isPublicModelAddress(address),
  )) {
    throw new WeChatKfError(errorCode);
  }
  return resolved.map(({ address, family: addrFamily }) => ({ address, family: addrFamily }));
}

async function readBoundedText(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (!response.body) {
    const text = await response.text();
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
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new WeChatKfError('WECHAT_KF_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
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
  addresses: readonly { address: string; family: number }[],
  signal: AbortSignal,
): Promise<Response> {
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  const family = isIP(hostname);
  const pinnedLookup: LookupFunction = (_host, options, callback) => {
    if (options.all) callback(null, addresses.map(a => ({ ...a })));
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  };
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
}

/**
 * Execute a single non-redirecting, SSRF-checked HTTPS JSON request.
 * Never retries and never includes URLs or secrets in thrown errors.
 */
export async function executeSafeWeChatKfJsonRequest<T>(request: SafeJsonHttpRequest): Promise<T> {
  const parsed = assertSafePublicHttpsUrl(request.url, 'WECHAT_KF_INVALID_ENDPOINT');
  const timeoutSignal = AbortSignal.timeout(request.timeoutMs);
  const combinedSignal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal;

  if (combinedSignal.aborted) {
    throw new WeChatKfError('WECHAT_KF_TIMEOUT');
  }

  const useCustomFetch = request.fetchImpl !== undefined &&
    request.fetchImpl !== nativeFetch &&
    request.fetchImpl !== globalThis.fetch;

  if (!useCustomFetch || request.lookup !== undefined) {
    const addresses = await resolvePublicAddresses(parsed.hostname, request.lookup ?? dnsLookup);
    if (!useCustomFetch) {
      const headers: Record<string, string> = request.body !== undefined
        ? { 'content-type': 'application/json; charset=utf-8' }
        : {};
      const response = await sendPinnedHttps(
        parsed,
        request.method,
        headers,
        request.body !== undefined ? Buffer.from(request.body, 'utf8') : undefined,
        addresses,
        combinedSignal,
      );
      return parseBoundedJsonResponse<T>(response, request.maxResponseBytes, combinedSignal);
    }
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
  if (response.redirected || response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    void response.body?.cancel().catch(() => {});
    throw new WeChatKfError('WECHAT_KF_REDIRECT_REJECTED', { httpStatus: response.status });
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new WeChatKfError('WECHAT_KF_HTTP_ERROR', { httpStatus: response.status });
  }
  const text = await readBoundedText(response, maxBytes, signal);
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
  const baseDigest = endpointDigest(apiBaseUrl);
  return `${corpId}:${secretHash}:${baseDigest}`;
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

/** Singleflight WeChat KF access_token manager with 5-minute preemptive refresh and redacted keys. */
export class WeChatKfTokenManager {
  private readonly cache = new Map<string, TokenCacheEntry>();
  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly generations = new Map<string, number>();

  /** Expose only redacted key identifiers for diagnostics/tests; never exposes secrets or tokens. */
  cachedKeyCount(): number {
    return this.cache.size;
  }

  /** Expose redacted cache key list (never raw appSecret). */
  cachedKeys(): readonly string[] {
    return [...this.cache.keys()];
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

    const cached = this.cache.get(key);
    if (cached && currentMs < cached.refreshAt) {
      return cached.accessToken;
    }

    const existing = this.inFlight.get(key);
    if (existing) {
      return raceWithAbort(existing, options.signal);
    }

    const generation = this.generations.get(key) ?? 0;
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
      const expiresInSec = typeof data.expires_in === 'number' && Number.isFinite(data.expires_in) && data.expires_in > 0
        ? data.expires_in
        : 7200;
      const fetchedAt = now();
      const expiresAt = fetchedAt + expiresInSec * 1000;
      const effectiveBuffer = Math.min(refreshBufferMs, Math.max(0, expiresInSec * 1000 - 1000));
      const refreshAt = expiresAt - effectiveBuffer;

      // Only populate cache if no invalidation occurred while this refresh was in flight.
      if ((this.generations.get(key) ?? 0) === generation) {
        this.cache.set(key, {
          accessToken: data.access_token,
          refreshAt,
          expiresAt,
        });
      }
      return data.access_token;
    })();

    // Prevent unhandled rejection when a single caller aborts while the shared fetch rejects later.
    void pending.catch(() => {});
    this.inFlight.set(key, pending);
    try {
      return await raceWithAbort(pending, options.signal);
    } finally {
      if (this.inFlight.get(key) === pending) {
        this.inFlight.delete(key);
      }
    }
  }

  clearAccessToken(corpId: string, appSecret: string, apiBaseUrl: string = WECHAT_KF_DEFAULT_API_BASE): void {
    if (!corpId.trim() || !appSecret.trim()) return;
    const base = assertSafeWeChatKfApiBase(apiBaseUrl);
    const key = buildTokenCacheKey(corpId, appSecret, base);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    this.cache.delete(key);
    this.inFlight.delete(key);
  }

  clearAll(): void {
    for (const key of new Set([...this.cache.keys(), ...this.inFlight.keys()])) {
      this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    }
    this.cache.clear();
    this.inFlight.clear();
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
