import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPublicModelAddress } from '../../ai/model-transport.js';
import { Blocked } from '../../core/contracts.js';
import {
  WECOM_MAX_INBOUND_FRAME_BYTES,
  type WecomDnsLookup,
  type WecomWsFrame,
} from './types.js';

const FORBIDDEN_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.arpa'] as const;

function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/gu, '').toLowerCase().replace(/\.$/u, '');
}

/**
 * Synchronous URL syntax & static SSRF checks.
 * Always enforced even when a synthetic WebSocketFactory is injected in tests.
 */
export function assertSafeWecomWsUrlSyntax(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Blocked('WECOM_WS_ENDPOINT_INVALID');
  }
  if (url.protocol !== 'wss:') {
    throw new Blocked('WECOM_WS_ENDPOINT_SSRF_BLOCKED');
  }
  if (url.username || url.password) {
    throw new Blocked('WECOM_WS_ENDPOINT_SSRF_BLOCKED');
  }
  if (url.port && url.port !== '443') {
    throw new Blocked('WECOM_WS_ENDPOINT_SSRF_BLOCKED');
  }
  const host = normalizeHost(url.hostname);
  if (!host || host === 'localhost' || FORBIDDEN_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))) {
    throw new Blocked('WECOM_WS_ENDPOINT_SSRF_BLOCKED');
  }
  if (isIP(host) !== 0 && !isPublicModelAddress(host)) {
    throw new Blocked('WECOM_WS_ENDPOINT_SSRF_BLOCKED');
  }
  return url;
}

/**
 * Full WSS endpoint validation including DNS resolution against private/loopback IP ranges.
 */
export async function validateWecomWsEndpoint(
  rawUrl: string,
  lookup: WecomDnsLookup = dnsLookup,
): Promise<URL> {
  const url = assertSafeWecomWsUrlSyntax(rawUrl);
  const host = normalizeHost(url.hostname);
  if (isIP(host) === 0) {
    let records: { address: string; family: number }[];
    try {
      records = await lookup(host, { all: true });
    } catch {
      throw new Blocked('WECOM_WS_ENDPOINT_SSRF_BLOCKED');
    }
    if (
      !records.length
      || records.some(entry => isIP(entry.address) !== entry.family || !isPublicModelAddress(entry.address))
    ) {
      throw new Blocked('WECOM_WS_ENDPOINT_SSRF_BLOCKED');
    }
  }
  return url;
}

export async function decodeWecomWsMessageData(data: unknown): Promise<string | null> {
  if (typeof data === 'string') {
    if (Buffer.byteLength(data, 'utf8') > WECOM_MAX_INBOUND_FRAME_BYTES) {
      throw new Blocked('WECOM_WS_FRAME_TOO_LARGE');
    }
    return data;
  }
  if (data instanceof Uint8Array) {
    if (data.byteLength > WECOM_MAX_INBOUND_FRAME_BYTES) {
      throw new Blocked('WECOM_WS_FRAME_TOO_LARGE');
    }
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    if (data.byteLength > WECOM_MAX_INBOUND_FRAME_BYTES) {
      throw new Blocked('WECOM_WS_FRAME_TOO_LARGE');
    }
    return Buffer.from(data).toString('utf8');
  }
  if (data && typeof data === 'object' && 'arrayBuffer' in data && typeof data.arrayBuffer === 'function') {
    const buffer = await (data as Blob).arrayBuffer();
    if (buffer.byteLength > WECOM_MAX_INBOUND_FRAME_BYTES) {
      throw new Blocked('WECOM_WS_FRAME_TOO_LARGE');
    }
    return Buffer.from(buffer).toString('utf8');
  }
  return null;
}

export function parseWecomWsFrame(raw: string): WecomWsFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Blocked('WECOM_WS_FRAME_INVALID');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Blocked('WECOM_WS_FRAME_INVALID');
  }
  const record = parsed as Record<string, unknown>;
  const headers = record['headers'];
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new Blocked('WECOM_WS_FRAME_INVALID');
  }
  const reqId = (headers as Record<string, unknown>)['req_id'];
  if (typeof reqId !== 'string' || !reqId.trim()) {
    throw new Blocked('WECOM_WS_FRAME_INVALID');
  }
  return record as unknown as WecomWsFrame;
}

export function requirePositiveInt(value: number | undefined, fallback: number, minimum = 1): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Blocked('WECOM_WS_CONFIG_INVALID');
  }
  return value;
}
