import { createHash } from 'node:crypto';
import type { LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { inspect } from 'node:util';
import { isPublicModelAddress } from '../ai/model-transport.js';
import { AccountActor } from '../browser/account-actor.js';
import { accountIdSchema, platformIdSchema, type AccountId, type PlatformId } from '../contracts/account.js';
import type { Channel } from '../contracts/events.js';
import { Blocked, digest, requireSafe } from '../core/contracts.js';
import type {
  AccountSerialExecutor,
  OfficialApiCapabilityIdentity,
  OfficialApiProtocol,
  OfficialApiTransportState,
  OfficialApiTransportStatus,
} from './platform-connector.js';

export const WECHAT_KF_DEFAULT_BASE_URL = 'https://qyapi.weixin.qq.com/cgi-bin';
export const WECOM_AIBOT_DEFAULT_WS_URL = 'wss://openws.work.weixin.qq.com';
export const WECHAT_KF_OFFICIAL_HOSTS = Object.freeze(['qyapi.weixin.qq.com'] as const);
export const WECOM_AIBOT_OFFICIAL_HOSTS = Object.freeze(['openws.work.weixin.qq.com'] as const);

export type OfficialApiUrlProtocol = 'https:' | 'wss:';
export type OfficialApiDnsLookup = (hostname: string, options: { all: true }) => Promise<LookupAddress[]>;

export interface OfficialApiEndpointOptions {
  readonly allowedProtocols?: readonly OfficialApiUrlProtocol[] | undefined;
  readonly allowedHosts?: readonly string[] | undefined;
  readonly allowQuery?: boolean | undefined;
  readonly lookup?: OfficialApiDnsLookup | undefined;
}

export interface ParsedOfficialApiEndpoint {
  readonly url: URL;
  readonly normalizedUrl: string;
  readonly protocol: OfficialApiUrlProtocol;
  readonly hostname: string;
  readonly port: 443;
  readonly endpointDigest: string;
}

export interface ValidatedOfficialApiEndpoint extends ParsedOfficialApiEndpoint {
  readonly addresses: readonly LookupAddress[];
  readonly pinnedLookup: LookupFunction;
}

export interface OfficialApiChannelIdentityInput {
  readonly platformId: PlatformId;
  readonly accountId: AccountId;
  readonly ownId: string;
  readonly channel: Channel;
  readonly protocol: OfficialApiProtocol;
  readonly endpointUrl: string;
  readonly allowedHosts?: readonly string[] | undefined;
  readonly scopeId?: string | null | undefined;
}

export interface OfficialApiTransportStatusInput {
  readonly state: OfficialApiTransportState;
  readonly protocol: OfficialApiProtocol;
  readonly endpointDigest: string | null;
  readonly lastHeartbeatAt?: number | null | undefined;
  readonly lastSyncAt?: number | null | undefined;
  readonly errorCode?: string | null | undefined;
}

export interface OfficialApiSecretHolder<T extends Readonly<Record<string, string>>> {
  use<R>(operation: (secrets: Readonly<T>) => R): R;
  digest(key: keyof T): string;
  keyFragment(key: keyof T, length?: number): string;
  dispose(): void;
  readonly disposed: boolean;
}

const DEFAULT_PROTOCOLS: readonly OfficialApiUrlProtocol[] = Object.freeze(['https:', 'wss:'] as const);
const MAX_ENDPOINT_LENGTH = 2048;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const SAFE_ERROR_CODE = /^[A-Z0-9_]{1,64}$/u;
const FORBIDDEN_HOST_SUFFIX = /(?:^|\.)(?:localhost|local|internal|home\.arpa|localdomain|lan)$/iu;
const SENSITIVE_FIELD_NAME =
  /(?:secret|token|encoding[_-]?aes[_-]?key|aes[_-]?key|password|passwd|credential|authorization|cookie|private[_-]?key|api[_-]?key)/iu;
const SAFE_METADATA_FIELD_NAME =
  /^(?:endpointDigest|identityDigest|mappingDigest|credentialDigest|lastHeartbeatAt|lastSyncAt|errorCode)$/u;
const INLINE_QUERY_SECRET =
  /([?&](?:access_token|corpsecret|secret|token|encoding_aes_key|encodingaeskey|aeskey|msg_signature|key)=)([^&#\s]*)/giu;
const INLINE_AUTH_SECRET = /(authorization\s*:\s*(?:(?:bearer|basic|token)\s+)?)([^\s,;\r\n]+)/giu;
const INLINE_COOKIE_SECRET = /((?:set-)?cookie\s*:\s*)([^\r\n]+)/giu;
const SENSITIVE_HEADER_NAME =
  /(?:secret|token|authorization|cookie|api[_-]?key|credential|password|aes[_-]?key|signature)/iu;

function normalizeHostName(value: string): string {
  return value.trim().toLowerCase().replace(/\.+$/u, '').replace(/^\[|\]$/gu, '');
}

function validatePathSegments(rawUrl: string): void {
  const pathMatch = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/iu.exec(rawUrl);
  const rawPath = pathMatch?.[1] ?? '';
  if (!rawPath) return;
  for (const segment of rawPath.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Blocked('OFFICIAL_API_ENDPOINT_INVALID');
    }
    if (decoded === '.' || decoded === '..' || /[\/\\?#\p{Cc}]/u.test(decoded)) {
      throw new Blocked('OFFICIAL_API_ENDPOINT_INVALID');
    }
  }
}

/**
 * Synchronous structural validation for official HTTPS/WSS endpoints.
 * Rejects plaintext http/ws, credentials, non-443 ports, local/private hostnames and private IP literals.
 */
export function parseOfficialApiEndpoint(
  rawUrl: string,
  options: Omit<OfficialApiEndpointOptions, 'lookup'> = {},
): ParsedOfficialApiEndpoint {
  if (
    typeof rawUrl !== 'string' ||
    rawUrl.length === 0 ||
    rawUrl.length > MAX_ENDPOINT_LENGTH ||
    rawUrl !== rawUrl.trim() ||
    rawUrl.includes('\\') ||
    /[\p{Cc}\s]/u.test(rawUrl)
  ) {
    throw new Blocked('OFFICIAL_API_ENDPOINT_INVALID');
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Blocked('OFFICIAL_API_ENDPOINT_INVALID');
  }

  const allowedProtocols = options.allowedProtocols ?? DEFAULT_PROTOCOLS;
  if (
    (url.protocol !== 'https:' && url.protocol !== 'wss:') ||
    !allowedProtocols.includes(url.protocol)
  ) {
    throw new Blocked('OFFICIAL_API_ENDPOINT_PROTOCOL_UNSUPPORTED');
  }

  if (url.username !== '' || url.password !== '') {
    throw new Blocked('OFFICIAL_API_ENDPOINT_CREDENTIALS_FORBIDDEN');
  }

  if (url.hash !== '' || (!options.allowQuery && url.search !== '')) {
    throw new Blocked('OFFICIAL_API_ENDPOINT_INVALID');
  }

  if (url.port !== '' && url.port !== '443') {
    throw new Blocked('OFFICIAL_API_ENDPOINT_PORT_UNSUPPORTED');
  }

  validatePathSegments(rawUrl);

  const host = normalizeHostName(url.hostname);
  if (!host || host.includes('%') || /[^\x21-\x7e]/u.test(host)) {
    throw new Blocked('OFFICIAL_API_ENDPOINT_INVALID');
  }

  if (FORBIDDEN_HOST_SUFFIX.test(host)) {
    throw new Blocked('OFFICIAL_API_ENDPOINT_PRIVATE_ADDRESS');
  }

  const family = isIP(host);
  if (family !== 0) {
    if (!isPublicModelAddress(host)) {
      throw new Blocked('OFFICIAL_API_ENDPOINT_PRIVATE_ADDRESS');
    }
  } else if (!host.includes('.')) {
    throw new Blocked('OFFICIAL_API_ENDPOINT_PRIVATE_ADDRESS');
  }

  if (options.allowedHosts !== undefined) {
    const allowedSet = new Set(options.allowedHosts.map(normalizeHostName).filter(Boolean));
    if (!allowedSet.size || !allowedSet.has(host)) {
      throw new Blocked('OFFICIAL_API_ENDPOINT_HOST_NOT_ALLOWED');
    }
  }

  const hostAuthority = family === 6 ? `[${host}]` : host;
  const cleanPath = url.pathname.replace(/\/+$/u, '');
  const query = options.allowQuery ? url.search : '';
  const normalizedUrl = `${url.protocol}//${hostAuthority}${cleanPath}${query}`;

  return Object.freeze({
    url,
    normalizedUrl,
    protocol: url.protocol,
    hostname: host,
    port: 443 as const,
    endpointDigest: digest(normalizedUrl),
  });
}

/**
 * Full anti-SSRF endpoint validation: performs structural validation plus DNS resolution,
 * verifies every resolved address via isPublicModelAddress, and returns a pinned lookup callback.
 */
export async function validateOfficialApiEndpoint(
  rawUrl: string,
  options: OfficialApiEndpointOptions = {},
): Promise<ValidatedOfficialApiEndpoint> {
  const parsed = parseOfficialApiEndpoint(rawUrl, options);
  const family = isIP(parsed.hostname);
  let resolved: LookupAddress[];
  if (family !== 0) {
    resolved = [{ address: parsed.hostname, family }];
  } else {
    const resolve: OfficialApiDnsLookup =
      options.lookup ?? ((hostname, lookupOptions) => dnsLookup(hostname, lookupOptions));
    try {
      resolved = await resolve(parsed.hostname, { all: true });
    } catch {
      throw new Blocked('OFFICIAL_API_ENDPOINT_DNS_FAILED');
    }
  }

  if (
    !resolved.length ||
    resolved.some(
      ({ address, family: resolvedFamily }) =>
        typeof address !== 'string' ||
        isIP(address) !== resolvedFamily ||
        !isPublicModelAddress(address),
    )
  ) {
    throw new Blocked('OFFICIAL_API_ENDPOINT_PRIVATE_ADDRESS');
  }

  const addresses = Object.freeze(
    resolved.map(({ address, family: resolvedFamily }) => Object.freeze({ address, family: resolvedFamily })),
  );
  const pinnedLookup: LookupFunction = (_hostname, lookupOptions, callback) => {
    const requestedFamily =
      lookupOptions?.family === 4 || lookupOptions?.family === 'IPv4'
        ? 4
        : lookupOptions?.family === 6 || lookupOptions?.family === 'IPv6'
          ? 6
          : 0;
    const matching = requestedFamily === 0
      ? addresses
      : addresses.filter(entry => entry.family === requestedFamily);
    if (!matching.length) {
      const error = Object.assign(
        new Error(`getaddrinfo ENOTFOUND ${parsed.hostname}`),
        { code: 'ENOTFOUND', hostname: parsed.hostname },
      ) as NodeJS.ErrnoException;
      callback(error, lookupOptions?.all ? [] : '', 0);
      return;
    }
    if (lookupOptions?.all) callback(null, matching.map(entry => ({ ...entry })));
    else callback(null, matching[0]!.address, matching[0]!.family);
  };

  return Object.freeze({
    ...parsed,
    addresses,
    pinnedLookup,
  });
}

export function officialApiEndpointDigest(
  rawUrl: string,
  options: Omit<OfficialApiEndpointOptions, 'lookup'> = {},
): string {
  return parseOfficialApiEndpoint(rawUrl, options).endpointDigest;
}

/** Non-reversible SHA-256 credential digest safe for cache keys, identity correlation and status snapshots. */
export function credentialDigest(secret: string, namespace = 'official-api-credential'): string {
  requireSafe(typeof secret === 'string' && secret.trim().length > 0, 'OFFICIAL_API_CREDENTIAL_REQUIRED');
  return createHash('sha256').update(namespace).update('\0').update(secret).digest('hex');
}

export function credentialKeyFragment(
  secret: string,
  length = 16,
  namespace = 'official-api-credential',
): string {
  requireSafe(Number.isSafeInteger(length) && length >= 8 && length <= 64, 'OFFICIAL_API_DIGEST_LENGTH_INVALID');
  return credentialDigest(secret, namespace).slice(0, length);
}

/** Holds sensitive credentials in a closure so serialization/logging cannot expose plaintext values. */
export function createOfficialApiSecretHolder<T extends Readonly<Record<string, string>>>(
  secrets: T,
): OfficialApiSecretHolder<T> {
  const entries = new Map<string, string>();
  for (const [key, value] of Object.entries(secrets)) {
    requireSafe(typeof value === 'string' && value.trim().length > 0, 'OFFICIAL_API_CREDENTIAL_REQUIRED');
    entries.set(key, value);
  }
  const keyNames = Object.freeze([...entries.keys()]);
  let isDisposed = false;

  const readSecret = (key: keyof T): string => {
    requireSafe(!isDisposed, 'OFFICIAL_API_CREDENTIAL_DISPOSED');
    const value = entries.get(String(key));
    requireSafe(value !== undefined, 'OFFICIAL_API_CREDENTIAL_REQUIRED');
    return value;
  };

  const holder: OfficialApiSecretHolder<T> & {
    toJSON(): { redacted: true; keys: readonly string[]; disposed: boolean };
    [inspect.custom](): { redacted: true; keys: readonly string[]; disposed: boolean };
  } = {
    get disposed() {
      return isDisposed;
    },
    use<R>(operation: (current: Readonly<T>) => R): R {
      requireSafe(!isDisposed, 'OFFICIAL_API_CREDENTIAL_DISPOSED');
      const snapshot = Object.freeze(Object.fromEntries(entries)) as Readonly<T>;
      return operation(snapshot);
    },
    digest(key: keyof T): string {
      return credentialDigest(readSecret(key), `official-api:${String(key)}`);
    },
    keyFragment(key: keyof T, length = 16): string {
      return credentialKeyFragment(readSecret(key), length, `official-api:${String(key)}`);
    },
    dispose(): void {
      isDisposed = true;
      entries.clear();
    },
    toJSON() {
      return { redacted: true, keys: keyNames, disposed: isDisposed };
    },
    [inspect.custom]() {
      return { redacted: true, keys: keyNames, disposed: isDisposed };
    },
  };

  return Object.freeze(holder);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

type RedactSegment = { readonly redacted: boolean; readonly text: string };

function applyInlinePattern(segments: readonly RedactSegment[], pattern: RegExp): RedactSegment[] {
  const next: RedactSegment[] = [];
  for (const segment of segments) {
    if (segment.redacted) {
      next.push(segment);
      continue;
    }
    const regex = new RegExp(pattern.source, pattern.flags);
    let lastIndex = 0;
    for (const match of segment.text.matchAll(regex)) {
      const matchIndex = match.index ?? 0;
      const prefix = match[1] ?? '';
      if (matchIndex > lastIndex) {
        next.push({ redacted: false, text: segment.text.slice(lastIndex, matchIndex) });
      }
      if (prefix) {
        next.push({ redacted: false, text: prefix });
      }
      next.push({ redacted: true, text: '[REDACTED]' });
      lastIndex = matchIndex + match[0].length;
    }
    if (lastIndex < segment.text.length) {
      next.push({ redacted: false, text: segment.text.slice(lastIndex) });
    }
  }
  return next;
}

export function redactOfficialApiText(text: string, extraSecrets: readonly string[] = []): string {
  let segments: RedactSegment[] = [{ redacted: false, text }];
  segments = applyInlinePattern(segments, INLINE_QUERY_SECRET);
  segments = applyInlinePattern(segments, INLINE_AUTH_SECRET);
  segments = applyInlinePattern(segments, INLINE_COOKIE_SECRET);

  const secrets = [...new Set(extraSecrets.filter(item => typeof item === 'string' && item.trim().length > 0))].sort(
    (left, right) => right.length - left.length,
  );
  if (!secrets.length) {
    return segments.map(segment => segment.text).join('');
  }
  const secretRegex = new RegExp(secrets.map(escapeRegExp).join('|'), 'gu');
  return segments
    .map(segment => (segment.redacted ? segment.text : segment.text.replace(secretRegex, '[REDACTED]')))
    .join('');
}

function redactRawHeaders(
  headers: readonly unknown[],
  extraSecrets: readonly string[],
  depth: number,
  seen: WeakSet<object>,
): unknown[] {
  const output: unknown[] = [];
  for (let index = 0; index < headers.length; index += 2) {
    const rawName = headers[index];
    output.push(redactOfficialApiValue(rawName, extraSecrets, depth + 1, seen));
    if (index + 1 < headers.length) {
      const isSensitive = typeof rawName === 'string' && SENSITIVE_HEADER_NAME.test(rawName);
      output.push(
        isSensitive ? '[REDACTED]' : redactOfficialApiValue(headers[index + 1], extraSecrets, depth + 1, seen),
      );
    }
  }
  return output;
}

function redactObjectEntry(
  key: string,
  entry: unknown,
  extraSecrets: readonly string[],
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (!SAFE_METADATA_FIELD_NAME.test(key) && SENSITIVE_FIELD_NAME.test(key)) {
    return '[REDACTED]';
  }
  if (/^rawheaders$/iu.test(key) && Array.isArray(entry)) {
    return redactRawHeaders(entry, extraSecrets, depth + 1, seen);
  }
  return redactOfficialApiValue(entry, extraSecrets, depth + 1, seen);
}

export function redactOfficialApiValue(
  value: unknown,
  extraSecrets: readonly string[] = [],
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === 'string') return redactOfficialApiText(value, extraSecrets);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 16) return '[TRUNCATED]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (value instanceof Error) {
    const errorOutput: Record<string, unknown> = {
      name: redactOfficialApiText(value.name, extraSecrets),
      message: redactOfficialApiText(value.message, extraSecrets),
    };
    const errorRecord = value as unknown as Record<string, unknown>;
    if (errorRecord.code !== undefined) {
      errorOutput.code = redactOfficialApiValue(errorRecord.code, extraSecrets, depth + 1, seen);
    }
    if (value.cause !== undefined) {
      errorOutput.cause = redactOfficialApiValue(value.cause, extraSecrets, depth + 1, seen);
    }
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'name' || key === 'message' || key === 'code' || key === 'cause' || key === 'stack') continue;
      errorOutput[key] = redactObjectEntry(key, entry, extraSecrets, depth, seen);
    }
    return errorOutput;
  }
  if (Array.isArray(value)) {
    return value.map(item => redactOfficialApiValue(item, extraSecrets, depth + 1, seen));
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = redactObjectEntry(key, entry, extraSecrets, depth, seen);
  }
  return output;
}

export function createOfficialApiTransportStatus(
  input: OfficialApiTransportStatusInput,
): OfficialApiTransportStatus {
  const endpointDigest =
    input.endpointDigest === null ? null : (requireSafe(SHA256_HEX.test(input.endpointDigest), 'OFFICIAL_API_ENDPOINT_DIGEST_INVALID'), input.endpointDigest);
  const normalizedError =
    input.errorCode === undefined || input.errorCode === null
      ? input.errorCode
      : SAFE_ERROR_CODE.test(input.errorCode)
        ? input.errorCode
        : 'UNCLASSIFIED_ERROR';

  return Object.freeze({
    transport: 'official_api' as const,
    state: input.state,
    protocol: input.protocol,
    endpointDigest,
    ...(input.lastHeartbeatAt !== undefined ? { lastHeartbeatAt: input.lastHeartbeatAt } : {}),
    ...(input.lastSyncAt !== undefined ? { lastSyncAt: input.lastSyncAt } : {}),
    ...(normalizedError !== undefined ? { errorCode: normalizedError } : {}),
  });
}

/** Account-scoped serial execution wrapper backed by AccountActor for official API connectors. */
export class OfficialApiSerialExecutor implements AccountSerialExecutor {
  private readonly actor: AccountActor;
  private disposed = false;

  constructor(actor = new AccountActor()) {
    this.actor = actor;
  }

  get idle(): boolean {
    return this.actor.idle;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  run<T>(operation: () => Promise<T>, priority: 'interactive' | 'background' = 'interactive'): Promise<T> {
    if (this.disposed) return Promise.reject(new Blocked('OFFICIAL_API_CONNECTOR_CLOSED'));
    return this.actor.run(async () => {
      if (this.disposed) throw new Blocked('OFFICIAL_API_CONNECTOR_CLOSED');
      return operation();
    }, priority);
  }

  runInteractive<T>(operation: () => Promise<T>): Promise<T> {
    return this.run(operation, 'interactive');
  }

  runBackground<T>(operation: () => Promise<T>): Promise<T> {
    return this.run(operation, 'background');
  }

  runWithSignal<T>(
    operation: (signal: AbortSignal | undefined) => Promise<T>,
    signal?: AbortSignal,
    priority: 'interactive' | 'background' = 'interactive',
  ): Promise<T> {
    if (this.disposed) return Promise.reject(new Blocked('OFFICIAL_API_CONNECTOR_CLOSED'));
    if (!signal) return this.run(() => operation(undefined), priority);
    if (signal.aborted) return Promise.reject(signal.reason ?? new Blocked('OFFICIAL_API_ABORTED'));

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let started = false;

      const onAbort = () => {
        if (settled || started) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(signal.reason ?? new Blocked('OFFICIAL_API_ABORTED'));
      };

      signal.addEventListener('abort', onAbort, { once: true });

      void this.run(async () => {
        signal.removeEventListener('abort', onAbort);
        if (settled) return undefined;
        started = true;
        signal.throwIfAborted();
        return operation(signal);
      }, priority).then(
        value => {
          signal.removeEventListener('abort', onAbort);
          if (!settled) {
            settled = true;
            resolve(value as T);
          }
        },
        error => {
          signal.removeEventListener('abort', onAbort);
          if (!settled) {
            settled = true;
            reject(error);
          }
        },
      );
    });
  }

  dispose(): void {
    this.disposed = true;
  }
}

export function createOfficialApiExecutor(actor?: AccountActor): OfficialApiSerialExecutor {
  return new OfficialApiSerialExecutor(actor);
}

/** Builds a browser-free channel capability identity digest for official API connectors. */
export function buildOfficialApiChannelIdentity(
  input: OfficialApiChannelIdentityInput,
): OfficialApiCapabilityIdentity {
  requireSafe(platformIdSchema.safeParse(input.platformId).success, 'PLATFORM_ID_INVALID');
  requireSafe(accountIdSchema.safeParse(input.accountId).success, 'ACCOUNT_ID_INVALID');
  const ownId = input.ownId.trim();
  requireSafe(ownId.length > 0, 'ACCOUNT_REQUIRED');
  const allowedProtocols: readonly OfficialApiUrlProtocol[] =
    input.protocol === 'wecom_ws' ? ['wss:'] : ['https:'];
  const parsed = parseOfficialApiEndpoint(input.endpointUrl, {
    allowedProtocols,
    allowedHosts: input.allowedHosts,
  });
  const scope = input.scopeId?.trim();
  return Object.freeze({
    transport: 'official_api' as const,
    identityDigest: digest(
      scope
        ? ['official_api', input.platformId, input.accountId, ownId, scope]
        : ['official_api', input.platformId, input.accountId, ownId],
    ),
    mappingDigest: digest(['official_api', input.platformId, input.protocol, input.channel, parsed.endpointDigest]),
    protocol: input.protocol,
    endpointDigest: parsed.endpointDigest,
  });
}
