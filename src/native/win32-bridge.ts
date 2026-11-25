import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  MAX_NATIVE_BRIDGE_BYTES,
  nativeBridgeRequestSchema,
  nativeBridgeResponseSchema,
  nativeProcessSampleSchema,
  type NativeBridgeRequest,
  type NativeBridgeResponse,
  type NativeProcessSample,
} from '../contracts/native-bridge.js';

const MAX_PLAINTEXT_BYTES = 12_000;
const MAX_CIPHERTEXT_BYTES = 16_000;
const MAX_IN_FLIGHT = 16;
const BRIDGE_TIMEOUT_MS = 5_000;
const bytesResultSchema = z.object({ dataBase64: z.base64() }).strict();
const clearResultSchema = z.object({ cleared: z.literal(true) }).strict();
const nativeErrors = new Set([
  'NATIVE_BRIDGE_BUSY',
  'NATIVE_BRIDGE_INVALID_PAYLOAD',
  'NATIVE_BRIDGE_RESPONSE_TOO_LARGE',
  'DPAPI_INVALID_SIZE',
  'DPAPI_INVALID_BASE64',
  'DPAPI_PROTECT_FAILED',
  'DPAPI_UNPROTECT_FAILED',
  'DPAPI_CACHE_UNAVAILABLE',
  'ACCESS_DENIED',
  'PROCESS_UNAVAILABLE',
  'INVALID_SAMPLE',
]);

export interface NativeBridgeTransport {
  secret: string;
  send(request: NativeBridgeRequest): void | Promise<void>;
}

type Pending = {
  resolve(response: NativeBridgeResponse): void;
  reject(code: string): void;
};

export class NativeWin32BridgeClient {
  private readonly transport: NativeBridgeTransport | undefined;
  private readonly secret: Buffer | undefined;
  private readonly pending = new Map<string, Pending>();
  private closed = false;

  constructor(transport?: NativeBridgeTransport) {
    if (transport?.secret.length === 64) {
      this.transport = { secret: transport.secret, send: transport.send.bind(transport) };
      this.secret = Buffer.from(transport.secret, 'utf16le');
    }
  }

  isAvailable(): boolean {
    return !this.closed && this.transport !== undefined && process.env.INBORA_NATIVE_BRIDGE === '1';
  }

  /** Routes a parsed stdin frame. Returns true if the frame belongs to the native bridge. */
  handleResponse(frame: unknown): boolean {
    if (typeof frame !== 'object' || frame === null ||
        !('kind' in frame) || frame.kind !== 'native_bridge_response') return false;
    if (!('bridgeId' in frame) || typeof frame.bridgeId !== 'string' ||
        !('secret' in frame) || typeof frame.secret !== 'string' ||
        frame.secret.length !== 64 || !this.secret) return true;
    const pending = this.pending.get(frame.bridgeId);
    if (!pending) return true;
    if (!timingSafeEqual(Buffer.from(frame.secret, 'utf16le'), this.secret)) return true;

    try {
      if (Buffer.byteLength(JSON.stringify(frame)) <= MAX_NATIVE_BRIDGE_BYTES) {
        const parsed = nativeBridgeResponseSchema.safeParse(frame);
        if (parsed.success) {
          pending.resolve(parsed.data);
          return true;
        }
      }
    } catch {
      // A malformed frame can contain sensitive fields. Report a fixed error.
    }
    pending.reject('NATIVE_BRIDGE_INVALID_RESPONSE');
    return true;
  }

  close(): void {
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject('NATIVE_BRIDGE_UNAVAILABLE');
  }

  private async request(payload: NativeBridgeRequest['payload'], signal?: AbortSignal): Promise<unknown> {
    const transport = this.transport;
    if (!this.isAvailable() || !transport) throw new Error('NATIVE_BRIDGE_UNAVAILABLE');
    if (signal?.aborted) throw new Error('CANCELLED');
    if (this.pending.size >= MAX_IN_FLIGHT) throw new Error('NATIVE_BRIDGE_BUSY');

    const bridgeId = randomUUID();
    const frame = nativeBridgeRequestSchema.safeParse({
      kind: 'native_bridge_request', bridgeId, secret: transport.secret, payload,
    });
    if (!frame.success || Buffer.byteLength(JSON.stringify(frame.data)) > MAX_NATIVE_BRIDGE_BYTES) {
      throw new Error('NATIVE_BRIDGE_INVALID_PAYLOAD');
    }
    const response = await new Promise<NativeBridgeResponse>((resolve, reject) => {
      const cleanup = (): boolean => {
        if (!this.pending.delete(bridgeId)) return false;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        return true;
      };
      const fail = (code: string): void => {
        if (cleanup()) reject(new Error(code));
      };
      const onAbort = (): void => fail('CANCELLED');
      const timer = setTimeout(() => fail('TIMEOUT'), BRIDGE_TIMEOUT_MS);
      this.pending.set(bridgeId, {
        resolve: (value) => { if (cleanup()) resolve(value); },
        reject: fail,
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        void Promise.resolve(transport.send(frame.data)).catch(() => fail('NATIVE_BRIDGE_TRANSPORT_FAILED'));
      } catch {
        fail('NATIVE_BRIDGE_TRANSPORT_FAILED');
      }
    });
    if (!response.ok) {
      throw new Error(nativeErrors.has(response.error) ? response.error : 'NATIVE_BRIDGE_FAILED');
    }
    return response.result;
  }

  private async dpapi(payload: NativeBridgeRequest['payload'], maxOutput: number): Promise<Buffer> {
    const parsed = bytesResultSchema.safeParse(await this.request(payload));
    if (parsed.success) {
      const bytes = Buffer.from(parsed.data.dataBase64, 'base64');
      if (bytes.length <= maxOutput && bytes.toString('base64') === parsed.data.dataBase64) return bytes;
      bytes.fill(0);
    }
    throw new Error('NATIVE_BRIDGE_INVALID_RESPONSE');
  }

  async dpapiProtect(input: Buffer, entropy: string): Promise<Buffer> {
    if (input.length > MAX_PLAINTEXT_BYTES) throw new Error('DPAPI_INVALID_SIZE');
    return this.dpapi({ op: 'dpapiProtect', dataBase64: input.toString('base64'), entropy }, MAX_CIPHERTEXT_BYTES);
  }

  async dpapiUnprotect(input: Buffer, entropy: string, cache?: { cacheKey: string; mtimeMs: number }): Promise<Buffer> {
    if (input.length > MAX_CIPHERTEXT_BYTES) throw new Error('DPAPI_INVALID_SIZE');
    return this.dpapi({
      op: 'dpapiUnprotect', dataBase64: input.toString('base64'), entropy,
      cacheKey: cache?.cacheKey, mtimeMs: cache?.mtimeMs,
    }, MAX_PLAINTEXT_BYTES);
  }

  async clearDpapiCache(cacheKey?: string): Promise<void> {
    const result = await this.request({ op: 'clearDpapiCache', cacheKey });
    if (!clearResultSchema.safeParse(result).success) throw new Error('NATIVE_BRIDGE_INVALID_RESPONSE');
  }

  async sampleProcessTree(rootPid: number, options?: {
    targetExe?: string;
    maxAgeMs?: number;
    signal?: AbortSignal;
  }): Promise<NativeProcessSample> {
    const result = await this.request({
      op: 'sampleProcessTree', rootPid, targetExe: options?.targetExe, maxAgeMs: options?.maxAgeMs,
    }, options?.signal);
    const parsed = nativeProcessSampleSchema.safeParse(result);
    if (!parsed.success) throw new Error('NATIVE_BRIDGE_INVALID_RESPONSE');
    return parsed.data;
  }
}

const unavailableBridge = new NativeWin32BridgeClient();
let nativeBridge: NativeWin32BridgeClient | undefined;

export function registerNativeBridgeTransport(transport: NativeBridgeTransport): NativeWin32BridgeClient {
  clearNativeWin32Bridge();
  nativeBridge = new NativeWin32BridgeClient(transport);
  return nativeBridge;
}

export function getNativeWin32Bridge(): NativeWin32BridgeClient {
  return nativeBridge ?? unavailableBridge;
}

export function clearNativeWin32Bridge(): void {
  nativeBridge?.close();
  nativeBridge = undefined;
}
