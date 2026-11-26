import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialStore, ModelCredentialStore } from '../../src/app/credentials.js';
import { MAX_NATIVE_BRIDGE_BYTES, type NativeBridgeRequest } from '../../src/contracts/native-bridge.js';
import {
  clearNativeWin32Bridge,
  getNativeWin32Bridge,
  NativeWin32BridgeClient,
  registerNativeBridgeTransport,
} from '../../src/native/win32-bridge.js';
import { BrowserResources } from '../../src/observability/browser-resources.js';
import { privateTemp } from '../helpers.js';

const secret = 'ab'.repeat(32);
const sample = {
  rows: [{
    pid: 100, parentPid: 90, name: 'msedge.exe', createdAt: 10, workingSetBytes: 1000,
    privateBytes: 2000, cpuSeconds: 1.25, statCreatedAt: 10,
  }],
  sampledAt: 20,
  cached: false,
};

function response(request: NativeBridgeRequest, fields: Record<string, unknown>) {
  return { kind: 'native_bridge_response', bridgeId: request.bridgeId, secret, ...fields };
}

function harness() {
  const requests: NativeBridgeRequest[] = [];
  const send = vi.fn((request: NativeBridgeRequest) => { requests.push(request); });
  const client = registerNativeBridgeTransport({ secret, send });
  const last = () => requests.at(-1)!;
  return { client, requests, send, last };
}

describe('NativeWin32BridgeClient', () => {
  beforeEach(() => vi.stubEnv('INBORA_NATIVE_BRIDGE', '1'));
  afterEach(() => {
    clearNativeWin32Bridge();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('encodes plaintext for protect and returns the decoded ciphertext', async () => {
    const { client, last } = harness();
    const plaintext = Buffer.from([0, 24, 255]);
    const ciphertext = Buffer.from([4, 3, 2, 1]);
    const pending = client.dpapiProtect(plaintext, '合成 entropy');
    expect(last()).toEqual({
      kind: 'native_bridge_request', bridgeId: expect.any(String), secret,
      payload: { op: 'dpapiProtect', dataBase64: plaintext.toString('base64'), entropy: '合成 entropy' },
    });
    expect(client.handleResponse(response(last(), {
      ok: true, result: { dataBase64: ciphertext.toString('base64') },
    }))).toBe(true);
    await expect(pending).resolves.toEqual(ciphertext);
  });

  it('passes through the cache key and fractional mtime, and clears one or all entries', async () => {
    const { client, last } = harness();
    const ciphertext = Buffer.from('synthetic-ciphertext');
    const plaintext = Buffer.from('synthetic-plaintext');
    const pending = client.dpapiUnprotect(ciphertext, 'fixture', { cacheKey: 'model', mtimeMs: 123.456 });
    expect(last().payload).toEqual({
      op: 'dpapiUnprotect', dataBase64: ciphertext.toString('base64'),
      entropy: 'fixture', cacheKey: 'model', mtimeMs: 123.456,
    });
    client.handleResponse(response(last(), { ok: true, result: { dataBase64: plaintext.toString('base64') } }));
    await expect(pending).resolves.toEqual(plaintext);

    for (const cacheKey of ['model', undefined]) {
      const cleared = client.clearDpapiCache(cacheKey);
      expect(JSON.parse(JSON.stringify(last().payload))).toEqual(
        cacheKey === undefined ? { op: 'clearDpapiCache' } : { op: 'clearDpapiCache', cacheKey },
      );
      client.handleResponse(response(last(), { ok: true, result: { cleared: true } }));
      await expect(cleared).resolves.toBeUndefined();
    }
  });

  it('samples with target and age options and maps known native failures', async () => {
    const { client, last } = harness();
    const pending = client.sampleProcessTree(100, { targetExe: 'msedge.exe', maxAgeMs: 5000 });
    expect(last().payload).toEqual({ op: 'sampleProcessTree', rootPid: 100, targetExe: 'msedge.exe', maxAgeMs: 5000 });
    client.handleResponse(response(last(), { ok: true, result: sample }));
    await expect(pending).resolves.toEqual(sample);

    for (const [request, error] of [
      [() => client.dpapiProtect(Buffer.from('fixture'), ''), 'DPAPI_PROTECT_FAILED'],
      [() => client.dpapiUnprotect(Buffer.from('fixture'), ''), 'DPAPI_UNPROTECT_FAILED'],
      [() => client.clearDpapiCache(), 'DPAPI_CACHE_UNAVAILABLE'],
      [() => client.sampleProcessTree(100), 'ACCESS_DENIED'],
    ] as const) {
      const pending = request();
      client.handleResponse(response(last(), { ok: false, error }));
      await expect(pending).rejects.toThrow(error);
    }
  });

  it('accepts only authenticated responses for the pending bridge ID', async () => {
    const { client, last } = harness();
    const pending = client.sampleProcessTree(100);
    const frame = response(last(), { ok: true, result: sample });
    expect(client.handleResponse({ ...frame, secret: 'cd'.repeat(32), result: null })).toBe(true);
    expect(client.handleResponse({ ...frame, secret: '中'.repeat(64), result: null })).toBe(true);
    expect(client.handleResponse({ ...frame, bridgeId: randomUUID(), result: null })).toBe(true);
    expect(client.handleResponse({ protocol: 2, ...{ ok: true, result: sample } })).toBe(false);
    client.handleResponse(frame);
    await expect(pending).resolves.toEqual(sample);
  });

  it('rejects malformed authenticated envelopes and invalid operation results', async () => {
    const { client, last } = harness();
    for (const [request, fields] of [
      [() => client.sampleProcessTree(100), { ok: 'yes', result: sample }],
      [() => client.sampleProcessTree(100), { ok: true }],
      [() => client.sampleProcessTree(100), { ok: true, result: { ...sample, cached: 1 } }],
      [() => client.sampleProcessTree(100), { ok: true, result: sample, extra: true }],
      [() => client.clearDpapiCache(), { ok: true, result: { cleared: false } }],
      [() => client.dpapiProtect(Buffer.from('fixture'), ''), { ok: true, result: { dataBase64: '!@#$' } }],
      [() => client.dpapiUnprotect(Buffer.from('fixture'), ''), { ok: true, result: { dataBase64: 'AB==' } }],
      [() => client.dpapiUnprotect(Buffer.from('fixture'), ''), {
        ok: true, result: { dataBase64: Buffer.alloc(12_001).toString('base64') },
      }],
      [() => client.sampleProcessTree(100), { ok: true, result: 'x'.repeat(MAX_NATIVE_BRIDGE_BYTES) }],
    ] as const) {
      const pending = request();
      client.handleResponse(response(last(), fields));
      await expect(pending).rejects.toThrow('NATIVE_BRIDGE_INVALID_RESPONSE');
    }
  });

  it('uses fixed errors for unrecognized native errors and transport failures', async () => {
    const { client, last } = harness();
    const sensitive = 'sensitive plaintext plus Q0lQSEVSVEVYVA==';
    const pending = client.dpapiUnprotect(Buffer.from('fixture'), '');
    client.handleResponse(response(last(), { ok: false, error: sensitive }));
    await expect(pending).rejects.toEqual(new Error('NATIVE_BRIDGE_FAILED'));
    const broken = new NativeWin32BridgeClient({ secret, send: () => Promise.reject(new Error(sensitive)) });
    await expect(broken.dpapiProtect(Buffer.from('fixture'), '')).rejects.toEqual(new Error('NATIVE_BRIDGE_TRANSPORT_FAILED'));
  });

  it('rejects out-of-bound requests before sending them', async () => {
    const { client, send } = harness();
    await expect(client.dpapiProtect(Buffer.alloc(12_001), '')).rejects.toThrow('DPAPI_INVALID_SIZE');
    await expect(client.dpapiUnprotect(Buffer.alloc(16_001), '')).rejects.toThrow('DPAPI_INVALID_SIZE');
    await expect(client.sampleProcessTree(1, { maxAgeMs: 30_001 })).rejects.toThrow('NATIVE_BRIDGE_INVALID_PAYLOAD');
    await expect(client.clearDpapiCache('中'.repeat(100_000))).rejects.toThrow('NATIVE_BRIDGE_INVALID_PAYLOAD');
    expect(send).not.toHaveBeenCalled();
  });

  it('accepts legacy Unicode credentials up to 12,000 UTF-8 bytes in both directions', async () => {
    const { client, last } = harness();
    for (const characters of [3000, 4000]) {
      const plaintext = Buffer.from('密'.repeat(characters), 'utf8');
      const ciphertext = Buffer.from('synthetic ciphertext');
      const protecting = client.dpapiProtect(plaintext, 'fixture');
      void protecting.catch(() => {});
      expect(last()?.payload).toMatchObject({ op: 'dpapiProtect', dataBase64: plaintext.toString('base64') });
      client.handleResponse(response(last(), { ok: true, result: { dataBase64: ciphertext.toString('base64') } }));
      await expect(protecting).resolves.toEqual(ciphertext);
      const restoring = client.dpapiUnprotect(ciphertext, 'fixture');
      client.handleResponse(response(last(), { ok: true, result: { dataBase64: plaintext.toString('base64') } }));
      await expect(restoring).resolves.toEqual(plaintext);
    }
  });

  it('deletes legacy ciphertext while the native bridge has no free slot', async () => {
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }));
    const root = privateTemp('3c-legacy-credentials-');
    const file = join(root, 'model-key.dpapi');
    const { client } = harness();
    const pending = Array.from({ length: 16 }, () => client.clearDpapiCache().catch(() => {}));
    try {
      await writeFile(file, 'synthetic ciphertext');
      await expect(new CredentialStore(root).delete()).resolves.toBeUndefined();
      await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      client.close();
      await Promise.all(pending);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('marks revoked ciphertext removed before cache clearing settles and falls back to clearing all', async () => {
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }));
    const root = privateTemp('3c-model-credentials-');
    const ref = { connectionId: randomUUID(), credentialRevision: randomUUID(), storage: 'DPAPI' } as const;
    const file = join(root, 'model-credentials', ref.connectionId, `${ref.credentialRevision}.dpapi`);
    const { client, requests, last } = harness();
    const finishCredentialCleanup = vi.fn();
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, 'synthetic ciphertext');
      const cleanup = new ModelCredentialStore(root).cleanup({
        listCleanableCredentials: () => [ref], claimCredentialCleanup: () => true, finishCredentialCleanup,
      });
      await vi.waitFor(() => expect(last()?.payload).toMatchObject({ op: 'clearDpapiCache', cacheKey: expect.any(String) }));
      await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
      await cleanup;
      expect(finishCredentialCleanup).toHaveBeenCalledExactlyOnceWith(ref, true);
      client.handleResponse(response(last(), { ok: false, error: 'DPAPI_CACHE_UNAVAILABLE' }));
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      expect(last().payload).toEqual({ op: 'clearDpapiCache', cacheKey: undefined });
      client.handleResponse(response(last(), { ok: false, error: 'DPAPI_CACHE_UNAVAILABLE' }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('bypasses the native process cache for the first sample of each browser owner epoch', async () => {
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }));
    const root = privateTemp('3c-browser-epoch-');
    const sampleAges: Array<number | undefined> = [];
    let epoch = 1;
    const native = registerNativeBridgeTransport({ secret, send: frame => {
      if (frame.payload.op !== 'sampleProcessTree') throw new Error('Unexpected bridge call');
      sampleAges.push(frame.payload.maxAgeMs);
      const edge = { ...sample.rows[0]!, pid: process.pid + 1, parentPid: process.pid };
      const owner = { ...edge, pid: process.pid, parentPid: 0, name: 'node.exe', createdAt: 5, statCreatedAt: 5 };
      native.handleResponse(response(frame, { ok: true, result: { ...sample, rows: [owner, edge] } }));
    } });
    const monitor = new BrowserResources({ root, identity: () => ({ epoch, open: true, mode: 'headless', pageCount: 1 }) });
    try {
      await monitor.sampleNow();
      await monitor.sampleNow();
      expect(monitor.snapshot().run?.samples).toBe(2);
      epoch++;
      await monitor.sampleNow();
      expect(sampleAges).toEqual([0, 2000, 0]);
      expect(monitor.snapshot().run?.samples).toBe(1);
    } finally {
      await monitor.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('bounds pending requests and releases their slots on timeout', async () => {
    vi.useFakeTimers();
    const { client, requests, last } = harness();
    const pending = Array.from({ length: 16 }, () => client.sampleProcessTree(100).catch((error: Error) => error.message));
    await expect(client.sampleProcessTree(101)).rejects.toThrow('NATIVE_BRIDGE_BUSY');
    expect(requests).toHaveLength(16);
    const late = last();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await Promise.all(pending)).toEqual(Array(16).fill('TIMEOUT'));
    expect(vi.getTimerCount()).toBe(0);

    const next = client.sampleProcessTree(102);
    client.handleResponse(response(late, { ok: false, error: 'ACCESS_DENIED' }));
    client.handleResponse(response(last(), { ok: true, result: sample }));
    await expect(next).resolves.toEqual(sample);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels aborted samples and releases outstanding work when cleared', async () => {
    vi.useFakeTimers();
    const { client, requests } = harness();
    const abort = new AbortController();
    const pending = client.sampleProcessTree(100, { signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toThrow('CANCELLED');
    await expect(client.sampleProcessTree(100, { signal: abort.signal })).rejects.toThrow('CANCELLED');
    expect(requests).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    const inFlight = client.clearDpapiCache();
    clearNativeWin32Bridge();
    await expect(inFlight).rejects.toThrow('NATIVE_BRIDGE_UNAVAILABLE');
    expect(getNativeWin32Bridge().isAvailable()).toBe(false);
    expect(client.isAvailable()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('requires both a registered transport and the host environment flag', async () => {
    expect(getNativeWin32Bridge().isAvailable()).toBe(false);
    await expect(getNativeWin32Bridge().sampleProcessTree(100)).rejects.toThrow('NATIVE_BRIDGE_UNAVAILABLE');
    vi.stubEnv('INBORA_NATIVE_BRIDGE', undefined);
    const { client, send } = harness();
    expect(getNativeWin32Bridge()).toBe(client);
    expect(client.isAvailable()).toBe(false);
    await expect(client.clearDpapiCache()).rejects.toThrow('NATIVE_BRIDGE_UNAVAILABLE');
    expect(send).not.toHaveBeenCalled();
    vi.stubEnv('INBORA_NATIVE_BRIDGE', '1');
    expect(client.isAvailable()).toBe(true);
  });
});
