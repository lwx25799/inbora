import { randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { Blocked } from '../../core/contracts.js';
import {
  parseOfficialApiEndpoint,
  validateOfficialApiEndpoint,
  type ParsedOfficialApiEndpoint,
  type ValidatedOfficialApiEndpoint,
} from '../official-api-base.js';
import {
  WECOM_AIBOT_DEFAULT_WS_URL,
  WECOM_MAX_INBOUND_FRAME_BYTES,
  WECOM_REPLY_MAX_UTF8_BYTES,
  WsCmd,
  type WecomActiveSendBody,
  type WecomActiveSendParams,
  type WecomDnsLookup,
  type WecomSendReplyParams,
  type WecomStreamReplyBody,
  type WecomWsClientOptions,
  type WecomWsFrame,
} from './types.js';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_MISSED_PONG_THRESHOLD = 2;
const DEFAULT_ACK_TIMEOUT_MS = 15_000;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;
const DEFAULT_MAX_AUTH_FAILURE_ATTEMPTS = 3;

export interface ResolvedWecomWsConfig {
  readonly botId: string;
  readonly wsUrl: string;
  readonly endpointDigest: string;
  readonly readSecret: () => string;
  readonly heartbeatIntervalMs: number;
  readonly missedPongThreshold: number;
  readonly ackTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly reconnectBaseDelayMs: number;
  readonly reconnectMaxDelayMs: number;
  readonly maxReconnectAttempts: number;
  readonly maxAuthFailureAttempts: number;
  readonly maxReplyBytes: number;
}

function mapEndpointError(error: unknown): Blocked {
  if (!(error instanceof Blocked)) {
    return new Blocked('WECOM_WS_ENDPOINT_INVALID');
  }
  switch (error.code) {
    case 'OFFICIAL_API_ENDPOINT_DNS_FAILED':
      return new Blocked('WECOM_WS_DNS_FAILED');
    case 'OFFICIAL_API_ENDPOINT_PROTOCOL_UNSUPPORTED':
    case 'OFFICIAL_API_ENDPOINT_CREDENTIALS_FORBIDDEN':
    case 'OFFICIAL_API_ENDPOINT_PORT_UNSUPPORTED':
    case 'OFFICIAL_API_ENDPOINT_PRIVATE_ADDRESS':
    case 'OFFICIAL_API_ENDPOINT_HOST_NOT_ALLOWED':
      return new Blocked('WECOM_WS_ENDPOINT_SSRF_BLOCKED');
    default:
      return new Blocked('WECOM_WS_ENDPOINT_INVALID');
  }
}

/**
 * Synchronous URL syntax & static SSRF checks aligned with official-api-base.ts.
 * Rejects plaintext ws:, query strings, fragments, backslashes, credentials,
 * non-443 ports, local hostnames and private IP literals.
 */
export function assertSafeWecomWsUrlSyntax(rawUrl: string): ParsedOfficialApiEndpoint {
  if (typeof rawUrl !== 'string' || rawUrl.includes('\\')) {
    throw new Blocked('WECOM_WS_ENDPOINT_INVALID');
  }
  try {
    return parseOfficialApiEndpoint(rawUrl, { allowedProtocols: ['wss:'] });
  } catch (error) {
    throw mapEndpointError(error);
  }
}

/**
 * Full WSS endpoint validation including DNS resolution against private/loopback IP ranges.
 * Distinguishes transient DNS failure (WECOM_WS_DNS_FAILED, reconnectable) from SSRF/policy
 * rejection (WECOM_WS_ENDPOINT_SSRF_BLOCKED / WECOM_WS_ENDPOINT_INVALID, terminal).
 */
export async function validateWecomWsEndpoint(
  rawUrl: string,
  lookup: WecomDnsLookup = dnsLookup,
): Promise<ValidatedOfficialApiEndpoint> {
  assertSafeWecomWsUrlSyntax(rawUrl);
  try {
    return await validateOfficialApiEndpoint(rawUrl, {
      allowedProtocols: ['wss:'],
      lookup,
    });
  } catch (error) {
    throw mapEndpointError(error);
  }
}

export function requirePositiveInt(value: number | undefined, fallback: number, minimum = 1): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Blocked('WECOM_WS_CONFIG_INVALID');
  }
  return value;
}

export function resolveWecomWsConfig(options: WecomWsClientOptions): ResolvedWecomWsConfig {
  const botId = typeof options.botId === 'string' ? options.botId.trim() : '';
  if (!botId) {
    throw new Blocked('WECOM_WS_CREDENTIAL_REQUIRED');
  }
  const readSecret = typeof options.secret === 'function'
    ? options.secret
    : () => options.secret as string;
  let initialSecret: string;
  try {
    initialSecret = readSecret();
  } catch {
    throw new Blocked('WECOM_WS_CREDENTIAL_REQUIRED');
  }
  if (typeof initialSecret !== 'string' || !initialSecret.trim()) {
    throw new Blocked('WECOM_WS_CREDENTIAL_REQUIRED');
  }

  const wsUrl = options.wsUrl ?? WECOM_AIBOT_DEFAULT_WS_URL;
  const parsed = assertSafeWecomWsUrlSyntax(wsUrl);
  const ackTimeoutMs = requirePositiveInt(options.ackTimeoutMs, DEFAULT_ACK_TIMEOUT_MS);
  const reconnectBaseDelayMs = requirePositiveInt(options.reconnectBaseDelayMs, DEFAULT_RECONNECT_BASE_DELAY_MS);
  const reconnectMaxDelayMs = requirePositiveInt(options.reconnectMaxDelayMs, DEFAULT_RECONNECT_MAX_DELAY_MS);
  if (reconnectMaxDelayMs < reconnectBaseDelayMs) {
    throw new Blocked('WECOM_WS_CONFIG_INVALID');
  }
  const maxReplyBytes = requirePositiveInt(options.maxReplyBytes, WECOM_REPLY_MAX_UTF8_BYTES);
  if (maxReplyBytes > WECOM_REPLY_MAX_UTF8_BYTES) {
    throw new Blocked('WECOM_WS_CONFIG_INVALID');
  }

  return {
    botId,
    wsUrl,
    endpointDigest: parsed.endpointDigest,
    readSecret,
    heartbeatIntervalMs: requirePositiveInt(options.heartbeatIntervalMs, DEFAULT_HEARTBEAT_INTERVAL_MS),
    missedPongThreshold: requirePositiveInt(options.missedPongThreshold, DEFAULT_MISSED_PONG_THRESHOLD),
    ackTimeoutMs,
    connectTimeoutMs: requirePositiveInt(options.connectTimeoutMs, ackTimeoutMs),
    reconnectBaseDelayMs,
    reconnectMaxDelayMs,
    maxReconnectAttempts: requirePositiveInt(options.maxReconnectAttempts, DEFAULT_MAX_RECONNECT_ATTEMPTS, 0),
    maxAuthFailureAttempts: requirePositiveInt(options.maxAuthFailureAttempts, DEFAULT_MAX_AUTH_FAILURE_ATTEMPTS, 1),
    maxReplyBytes,
  };
}

/**
 * Synchronous decode for string/Uint8Array/ArrayBuffer payloads so frames arriving
 * in the same TCP/TLS chunk before a CLOSE frame are processed without yielding a microtask.
 * Returns undefined only when async Blob decoding is required.
 */
export function decodeWecomWsMessageDataSync(data: unknown): string | null | undefined {
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
    return undefined;
  }
  return null;
}

export async function decodeWecomWsMessageData(data: unknown): Promise<string | null> {
  const syncResult = decodeWecomWsMessageDataSync(data);
  if (syncResult !== undefined) {
    return syncResult;
  }
  const buffer = await (data as Blob).arrayBuffer();
  if (buffer.byteLength > WECOM_MAX_INBOUND_FRAME_BYTES) {
    throw new Blocked('WECOM_WS_FRAME_TOO_LARGE');
  }
  return Buffer.from(buffer).toString('utf8');
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

function assertValidReplyContent(content: string, maxReplyBytes: number): void {
  if (typeof content !== 'string' || !content.trim()) {
    throw new Blocked('WECOM_WS_REPLY_EMPTY');
  }
  if (Buffer.byteLength(content, 'utf8') > maxReplyBytes) {
    throw new Blocked('WECOM_WS_REPLY_TOO_LONG');
  }
}

export function buildStreamReplyFrame(
  params: WecomSendReplyParams,
  maxReplyBytes: number,
): { reqId: string; streamId: string; payload: string } {
  const reqId = typeof params.reqId === 'string' ? params.reqId.trim() : '';
  if (!reqId) {
    throw new Blocked('WECOM_WS_REQ_ID_REQUIRED');
  }
  assertValidReplyContent(params.content, maxReplyBytes);
  const streamId = params.streamId?.trim() || `stream_${randomUUID()}`;
  const frame: WecomWsFrame<WecomStreamReplyBody> = {
    cmd: WsCmd.RESPONSE,
    headers: { req_id: reqId },
    body: {
      msgtype: 'stream',
      stream: { id: streamId, finish: true, content: params.content },
    },
  };
  return { reqId, streamId, payload: JSON.stringify(frame) };
}

export function buildActiveSendFrame(
  params: WecomActiveSendParams,
  maxReplyBytes: number,
): { reqId: string; streamId: string; payload: string } {
  const chatId = typeof params.chatId === 'string' ? params.chatId.trim() : '';
  if (!chatId) {
    throw new Blocked('WECOM_WS_TARGET_REQUIRED');
  }
  assertValidReplyContent(params.content, maxReplyBytes);
  const reqId = params.reqId?.trim() || `send_${randomUUID()}`;
  const msgType = params.msgType ?? 'markdown';
  const body: WecomActiveSendBody = msgType === 'text'
    ? { chatid: chatId, msgtype: 'text', text: { content: params.content } }
    : { chatid: chatId, msgtype: 'markdown', markdown: { content: params.content } };
  const frame: WecomWsFrame<WecomActiveSendBody> = {
    cmd: WsCmd.SEND_MSG,
    headers: { req_id: reqId },
    body,
  };
  return { reqId, streamId: reqId, payload: JSON.stringify(frame) };
}

export function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Blocked('WECOM_WS_CLOSED'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason instanceof Error ? signal.reason : new Blocked('WECOM_WS_CLOSED'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
