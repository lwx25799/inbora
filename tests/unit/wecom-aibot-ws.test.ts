import { createCipheriv, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  assertSafeWecomWsUrlSyntax,
  decodeWecomAesKey,
  decryptWecomAttachment,
  validateWecomWsEndpoint,
  WecomWsClient,
  WsCmd,
  type WecomWebSocketEvent,
  type WecomWebSocketLike,
  type WecomWebSocketListener,
  type WecomWsFrame,
} from '../../src/platform/wecom-aibot/index.js';

type SocketEventType = 'open' | 'message' | 'error' | 'close';

class MockWebSocket implements WecomWebSocketLike {
  readyState = 0;
  readonly sentRaw: string[] = [];
  readonly sentFrames: WecomWsFrame[] = [];
  closeCalls: { code?: number; reason?: string }[] = [];
  private readonly listeners: Record<SocketEventType, Set<WecomWebSocketListener>> = {
    open: new Set(),
    message: new Set(),
    error: new Set(),
    close: new Set(),
  };

  constructor(readonly url: string) {}

  addEventListener(type: SocketEventType, listener: WecomWebSocketListener): void {
    this.listeners[type].add(listener);
  }

  removeEventListener(type: SocketEventType, listener: WecomWebSocketListener): void {
    this.listeners[type].delete(listener);
  }

  send(data: string): void {
    if (this.readyState !== 1) {
      throw new Error('socket not open');
    }
    this.sentRaw.push(data);
    this.sentFrames.push(JSON.parse(data) as WecomWsFrame);
  }

  close(code = 1000, reason = ''): void {
    this.closeCalls.push({ code, reason });
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', { code, reason });
  }

  simulateOpen(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  simulateFrame(frame: WecomWsFrame): void {
    this.emit('message', { data: JSON.stringify(frame) });
  }

  simulateDrop(code = 1006, reason = 'network_drop'): void {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }

  private emit(type: SocketEventType, event: WecomWebSocketEvent): void {
    for (const listener of [...this.listeners[type]]) {
      listener(event);
    }
  }
}

function encryptWecom32Pkcs7(plaintext: Buffer, rawKey: Buffer): Buffer {
  const blockSize = 32;
  const pad = blockSize - (plaintext.length % blockSize);
  const padded = Buffer.concat([plaintext, Buffer.alloc(pad, pad)]);
  const iv = rawKey.subarray(0, 16);
  const cipher = createCipheriv('aes-256-cbc', rawKey, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

function createHarness() {
  const sockets: MockWebSocket[] = [];
  const factory = (url: string) => {
    const ws = new MockWebSocket(url);
    sockets.push(ws);
    return ws;
  };
  return { sockets, factory };
}

async function authenticateSocket(ws: MockWebSocket): Promise<WecomWsFrame> {
  ws.simulateOpen();
  const subscribeFrame = ws.sentFrames.find(frame => frame.cmd === WsCmd.SUBSCRIBE);
  expect(subscribeFrame).toBeDefined();
  ws.simulateFrame({
    headers: { req_id: subscribeFrame!.headers.req_id },
    errcode: 0,
    errmsg: 'ok',
  });
  await Promise.resolve();
  return subscribeFrame!;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('WeCom attachment AES-256-CBC decryption', () => {
  test('decrypts 43-char unpadded and 44-char standard Base64 keys across boundary lengths', () => {
    const rawKey = randomBytes(32);
    const key44 = rawKey.toString('base64');
    const key43 = key44.slice(0, 43);
    expect(key43).toHaveLength(43);
    expect(key44).toHaveLength(44);
    expect(decodeWecomAesKey(key43).equals(rawKey)).toBe(true);
    expect(decodeWecomAesKey(key44).equals(rawKey)).toBe(true);

    for (const sample of [
      Buffer.alloc(0),
      Buffer.from('hello wecom attachment', 'utf8'),
      Buffer.alloc(32, 0x41),
      Buffer.alloc(63, 0x42),
      randomBytes(129),
    ]) {
      const encrypted = encryptWecom32Pkcs7(sample, rawKey);
      expect(decryptWecomAttachment(encrypted, key43).equals(sample)).toBe(true);
      expect(decryptWecomAttachment(encrypted, key44).equals(sample)).toBe(true);
    }
  });

  test('rejects tampered ciphertext, invalid PKCS#7 padding, and malformed keys without leaking key material', () => {
    const rawKey = randomBytes(32);
    const key43 = rawKey.toString('base64').slice(0, 43);
    const encrypted = encryptWecom32Pkcs7(Buffer.from('sensitive payload', 'utf8'), rawKey);

    // Flip last byte to corrupt PKCS#7 padding.
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x01;
    expect(() => decryptWecomAttachment(tampered, key43)).toThrow('WECOM_CRYPTO_PADDING_INVALID');

    // Craft plaintext with inconsistent padding bytes (pad = 4, but earlier padding byte != 4).
    const badPadPlain = Buffer.alloc(32, 0x61);
    badPadPlain[28] = 0x04;
    badPadPlain[29] = 0x03;
    badPadPlain[30] = 0x04;
    badPadPlain[31] = 0x04;
    const cipherBadPad = createCipheriv('aes-256-cbc', rawKey, rawKey.subarray(0, 16));
    cipherBadPad.setAutoPadding(false);
    const encBadPad = Buffer.concat([cipherBadPad.update(badPadPlain), cipherBadPad.final()]);
    expect(() => decryptWecomAttachment(encBadPad, key43)).toThrow('WECOM_CRYPTO_PADDING_INVALID');

    // Craft plaintext with pad = 0 and pad = 33.
    for (const invalidPad of [0, 33]) {
      const plain = Buffer.alloc(32, invalidPad);
      const cipher = createCipheriv('aes-256-cbc', rawKey, rawKey.subarray(0, 16));
      cipher.setAutoPadding(false);
      const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
      expect(() => decryptWecomAttachment(enc, key43)).toThrow('WECOM_CRYPTO_PADDING_INVALID');
    }

    // Truncated non-block-aligned ciphertext.
    expect(() => decryptWecomAttachment(encrypted.subarray(0, 17), key43)).toThrow('WECOM_CRYPTO_CIPHERTEXT_INVALID');

    // Malformed key must never appear in thrown error message.
    const secretSentinel = 'BAD_KEY_SENTINEL_SECRET_9999999999999999999';
    let caught: unknown;
    try {
      decryptWecomAttachment(encrypted, secretSentinel);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('WECOM_CRYPTO_KEY_INVALID');
    expect((caught as Error).message).not.toContain(secretSentinel);
  });
});

describe('WeCom WSS endpoint SSRF & protocol guard', () => {
  test.each([
    'ws://openws.work.weixin.qq.com',
    'http://openws.work.weixin.qq.com',
    'https://openws.work.weixin.qq.com',
    'wss://user:pass@openws.work.weixin.qq.com',
    'wss://openws.work.weixin.qq.com:8443',
    'wss://localhost',
    'wss://sub.localhost',
    'wss://bot.local',
    'wss://service.internal',
    'wss://127.0.0.1',
    'wss://10.0.0.1',
    'wss://172.16.0.5',
    'wss://192.168.1.10',
    'wss://169.254.169.254',
    'wss://[::1]',
    'wss://[fc00::1]',
    'wss://[::ffff:127.0.0.1]',
  ])('blocks non-wss or non-public endpoint: %s', badUrl => {
    expect(() => assertSafeWecomWsUrlSyntax(badUrl)).toThrow('WECOM_WS_ENDPOINT_SSRF_BLOCKED');
  });

  test('blocks domain resolving to private IP via DNS and allows public IP resolution', async () => {
    await expect(
      validateWecomWsEndpoint('wss://evil-private.example.com', async () => [{ address: '10.0.0.8', family: 4 }]),
    ).rejects.toThrow('WECOM_WS_ENDPOINT_SSRF_BLOCKED');

    await expect(
      validateWecomWsEndpoint('wss://mixed-dns.example.com', async () => [
        { address: '1.1.1.1', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]),
    ).rejects.toThrow('WECOM_WS_ENDPOINT_SSRF_BLOCKED');

    const ok = await validateWecomWsEndpoint('wss://openws.work.weixin.qq.com', async () => [
      { address: '101.226.103.50', family: 4 },
    ]);
    expect(ok.protocol).toBe('wss:');
  });

  test('blocks DNS SSRF during WecomWsClient.connect before constructing socket', async () => {
    const { sockets, factory } = createHarness();
    const client = new WecomWsClient({
      botId: 'bot-1',
      secret: 'synthetic-secret-value',
      wsUrl: 'wss://rebind.example.com',
      webSocketFactory: factory,
      dnsLookup: async () => [{ address: '192.168.10.20', family: 4 }],
    });
    await expect(client.connect()).rejects.toThrow('WECOM_WS_ENDPOINT_SSRF_BLOCKED');
    expect(sockets).toHaveLength(0);
    expect(client.getStatus().state).toBe('ERROR');
    expect(client.getStatus().errorCode).toBe('WECOM_WS_ENDPOINT_SSRF_BLOCKED');
  });
});

describe('WecomWsClient protocol lifecycle, heartbeat, reconnect & single-send guarantees', () => {
  test('authenticates via aibot_subscribe and keeps secret out of status and serialization', async () => {
    const { sockets, factory } = createHarness();
    const secret = 'synthetic-wecom-secret-do-not-expose';
    const client = new WecomWsClient({
      botId: 'bot-alpha',
      secret,
      webSocketFactory: factory,
    });

    const connectPromise = client.connect();
    expect(sockets).toHaveLength(1);
    const subscribe = await authenticateSocket(sockets[0]!);
    await connectPromise;

    expect(subscribe.cmd).toBe(WsCmd.SUBSCRIBE);
    expect(subscribe.body).toEqual({ bot_id: 'bot-alpha', secret });
    expect(client.isConnected).toBe(true);
    expect(client.getStatus().state).toBe('CONNECTED');
    expect(client.getStatus().authenticated).toBe(true);
    expect(JSON.stringify(client.getStatus())).not.toContain(secret);
    expect(JSON.stringify(client)).not.toContain(secret);
    expect(inspect(client, { showHidden: true, depth: 4 })).not.toContain(secret);
    expect(inspect(Object.fromEntries(Object.entries(client).filter(([k]) => k !== 'ws')), { depth: 4 })).not.toContain(
      secret,
    );

    client.disconnect();
  });

  test('stops reconnecting and reports WS_AUTH_FAILURE_EXHAUSTED after consecutive auth failures', async () => {
    vi.useFakeTimers();
    const { sockets, factory } = createHarness();
    const errors: string[] = [];
    const reconnects: { attempt: number; delayMs: number; reason: string }[] = [];

    const client = new WecomWsClient({
      botId: 'bot-auth-fail',
      secret: 'wrong-secret',
      maxAuthFailureAttempts: 3,
      reconnectBaseDelayMs: 1_000,
      reconnectMaxDelayMs: 30_000,
      webSocketFactory: factory,
      onError: err => errors.push(err.message),
      onReconnecting: info => reconnects.push(info),
    });

    const initialConnect = client.connect().catch(err => err as Error);
    expect(sockets).toHaveLength(1);
    sockets[0]!.simulateOpen();
    sockets[0]!.simulateFrame({
      headers: { req_id: sockets[0]!.sentFrames[0]!.headers.req_id },
      errcode: 40001,
      errmsg: 'invalid secret',
    });
    const firstErr = await initialConnect;
    expect(firstErr).toBeInstanceOf(Error);
    expect((firstErr as Error).message).toBe('WECOM_WS_AUTH_FAILED');
    expect(reconnects).toEqual([{ attempt: 1, delayMs: 1_000, reason: 'auth_failure' }]);

    // Attempt 2 after 1s
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.simulateOpen();
    sockets[1]!.simulateFrame({
      headers: { req_id: sockets[1]!.sentFrames[0]!.headers.req_id },
      errcode: 40001,
      errmsg: 'invalid secret',
    });
    await Promise.resolve();
    expect(reconnects).toHaveLength(2);
    expect(reconnects[1]).toEqual({ attempt: 2, delayMs: 2_000, reason: 'auth_failure' });

    // Attempt 3 after 2s -> reaches maxAuthFailureAttempts=3, stops reconnecting
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sockets).toHaveLength(3);
    sockets[2]!.simulateOpen();
    sockets[2]!.simulateFrame({
      headers: { req_id: sockets[2]!.sentFrames[0]!.headers.req_id },
      errcode: 40001,
      errmsg: 'invalid secret',
    });
    await Promise.resolve();

    expect(client.getStatus().state).toBe('ERROR');
    expect(client.getStatus().errorCode).toBe('WS_AUTH_FAILURE_EXHAUSTED');
    expect(errors).toContain('WS_AUTH_FAILURE_EXHAUSTED');

    // Advancing far into the future must NOT open a 4th socket.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(3);

    client.disconnect();
  });

  test('heartbeat detects 2 consecutive missed pongs as dead socket and reconnects', async () => {
    vi.useFakeTimers();
    const { sockets, factory } = createHarness();
    const client = new WecomWsClient({
      botId: 'bot-hb',
      secret: 'secret-hb',
      heartbeatIntervalMs: 10_000,
      missedPongThreshold: 2,
      reconnectBaseDelayMs: 1_000,
      webSocketFactory: factory,
    });

    const p = client.connect();
    await authenticateSocket(sockets[0]!);
    await p;

    // 1st ping -> answered with pong -> healthy
    await vi.advanceTimersByTimeAsync(10_000);
    const ping1 = sockets[0]!.sentFrames.filter(f => f.cmd === WsCmd.HEARTBEAT);
    expect(ping1).toHaveLength(1);
    sockets[0]!.simulateFrame({ headers: { req_id: ping1[0]!.headers.req_id }, errcode: 0 });
    await Promise.resolve();

    // Next 2 pings get no pong -> 3rd tick sees missedPongCount === 2 and closes socket
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets[0]!.sentFrames.filter(f => f.cmd === WsCmd.HEARTBEAT)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets[0]!.sentFrames.filter(f => f.cmd === WsCmd.HEARTBEAT)).toHaveLength(3);
    expect(sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets[0]!.closeCalls.length).toBeGreaterThanOrEqual(1);
    expect(client.getStatus().state).toBe('DEGRADED');

    // Reconnect fires after 1s
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    await authenticateSocket(sockets[1]!);
    expect(client.isConnected).toBe(true);

    client.disconnect();
  });

  test('reconnects with exponential backoff capped at 30s and stops at maxReconnectAttempts', async () => {
    vi.useFakeTimers();
    const { sockets, factory } = createHarness();
    const delays: number[] = [];
    const client = new WecomWsClient({
      botId: 'bot-backoff',
      secret: 'secret-backoff',
      reconnectBaseDelayMs: 1_000,
      reconnectMaxDelayMs: 30_000,
      maxReconnectAttempts: 7,
      webSocketFactory: factory,
      onReconnecting: info => delays.push(info.delayMs),
    });

    const p = client.connect();
    await authenticateSocket(sockets[0]!);
    await p;

    const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    for (let i = 0; i < expectedDelays.length; i++) {
      sockets[i]!.simulateDrop();
      expect(delays[i]).toBe(expectedDelays[i]);
      await vi.advanceTimersByTimeAsync(expectedDelays[i]!);
      expect(sockets).toHaveLength(i + 2);
    }

    // One more drop exceeds maxReconnectAttempts=7 -> ERROR, no 9th socket
    sockets[sockets.length - 1]!.simulateDrop();
    expect(client.getStatus().state).toBe('ERROR');
    expect(client.getStatus().errorCode).toBe('WECOM_WS_RECONNECT_EXHAUSTED');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(8);

    client.disconnect();
  });

  test('serializes outbound frames per req_id and defends against timeout / late-ACK races with pendingAckSeq', async () => {
    vi.useFakeTimers();
    const { sockets, factory } = createHarness();
    const client = new WecomWsClient({
      botId: 'bot-queue',
      secret: 'secret-queue',
      ackTimeoutMs: 5_000,
      webSocketFactory: factory,
    });

    const p = client.connect();
    await authenticateSocket(sockets[0]!);
    await p;

    // 1. Same req_id serial queue: 2nd frame does not transmit until 1st frame receives ACK.
    const send1 = client.sendReplyOnce({ reqId: 'req-serial', content: 'first reply', streamId: 's1' });
    const send2 = client.sendReplyOnce({ reqId: 'req-serial', content: 'second reply', streamId: 's2' });

    const replyFramesBeforeAck = () =>
      sockets[0]!.sentFrames.filter(f => f.cmd === WsCmd.RESPONSE && f.headers.req_id === 'req-serial');
    expect(replyFramesBeforeAck()).toHaveLength(1);
    expect((replyFramesBeforeAck()[0]!.body as { stream: { finish: boolean; content: string } }).stream).toMatchObject({
      finish: true,
      content: 'first reply',
    });

    // Wrong explicit seq header is ignored and does not confirm in-flight frame 1.
    sockets[0]!.simulateFrame({ headers: { req_id: 'req-serial', seq: 999 }, errcode: 0, errmsg: 'stale' });
    await Promise.resolve();
    expect(replyFramesBeforeAck()).toHaveLength(1);
    expect(client.getStatus().lateAckIgnoredCount).toBe(1);

    // Real ACK for frame 1 releases frame 2.
    sockets[0]!.simulateFrame({ headers: { req_id: 'req-serial' }, errcode: 0, errmsg: 'ok' });
    const res1 = await send1;
    expect(res1.errcode).toBe(0);
    expect(res1.ackSeq).toBe(1);
    expect(replyFramesBeforeAck()).toHaveLength(2);

    sockets[0]!.simulateFrame({ headers: { req_id: 'req-serial' }, errcode: 0, errmsg: 'ok' });
    const res2 = await send2;
    expect(res2.ackSeq).toBe(2);

    // 2. Timeout + late ACK race: frame A times out -> queued frame B for same req_id fails closed
    //    without transmitting, and late ACK for frame A is ignored cleanly.
    const sendA = client.sendReplyOnce({ reqId: 'req-race', content: 'frame A', streamId: 'sa' });
    const sendB = client.sendReplyOnce({ reqId: 'req-race', content: 'frame B', streamId: 'sb' });
    const raceFrames = () =>
      sockets[0]!.sentFrames.filter(f => f.cmd === WsCmd.RESPONSE && f.headers.req_id === 'req-race');
    expect(raceFrames()).toHaveLength(1);

    const aRejection = expect(sendA).rejects.toThrow('WECOM_WS_SEND_UNCERTAIN');
    const bRejection = expect(sendB).rejects.toThrow('WECOM_WS_SEND_UNCERTAIN');
    await vi.advanceTimersByTimeAsync(5_000);
    await aRejection;
    await bRejection;

    // Frame B must never have been transmitted and frame A must never have been retried.
    expect(raceFrames()).toHaveLength(1);

    // Late ACK arrives after timeout -> safely ignored, increments counter.
    const ignoredBefore = client.getStatus().lateAckIgnoredCount;
    sockets[0]!.simulateFrame({ headers: { req_id: 'req-race' }, errcode: 0, errmsg: 'late' });
    await Promise.resolve();
    expect(client.getStatus().lateAckIgnoredCount).toBe(ignoredBefore + 1);

    // Further sends on the same tainted req_id on this connection remain fail-closed.
    await expect(client.sendReplyOnce({ reqId: 'req-race', content: 'frame C' })).rejects.toThrow(
      'WECOM_WS_SEND_UNCERTAIN',
    );
    expect(raceFrames()).toHaveLength(1);

    client.disconnect();
  });

  test('never retries outbound reply after disconnect or reconnect, and enforces UTF-8 byte ceiling', async () => {
    vi.useFakeTimers();
    const { sockets, factory } = createHarness();
    const client = new WecomWsClient({
      botId: 'bot-once',
      secret: 'secret-once',
      maxReplyBytes: 32,
      reconnectBaseDelayMs: 1_000,
      webSocketFactory: factory,
    });

    const p = client.connect();
    await authenticateSocket(sockets[0]!);
    await p;

    // Over-limit UTF-8 payload rejected before any frame is sent.
    await expect(client.sendReplyOnce({ reqId: 'req-big', content: '你'.repeat(12) })).rejects.toThrow(
      'WECOM_WS_REPLY_TOO_LONG',
    );
    expect(sockets[0]!.sentFrames.filter(f => f.cmd === WsCmd.RESPONSE)).toHaveLength(0);

    // In-flight send when socket drops -> rejects WECOM_WS_SEND_UNCERTAIN, 0 retries after reconnect.
    const inFlight = client.sendReplyOnce({ reqId: 'req-drop', content: 'single shot' });
    expect(sockets[0]!.sentFrames.filter(f => f.cmd === WsCmd.RESPONSE)).toHaveLength(1);

    const dropAssertion = expect(inFlight).rejects.toThrow('WECOM_WS_SEND_UNCERTAIN');
    sockets[0]!.simulateDrop();
    await dropAssertion;

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    await authenticateSocket(sockets[1]!);

    // Reconnected socket must NOT resend the dropped reply.
    expect(sockets[1]!.sentFrames.filter(f => f.cmd === WsCmd.RESPONSE)).toHaveLength(0);
    const totalResponseFrames = sockets.reduce(
      (sum, ws) => sum + ws.sentFrames.filter(f => f.cmd === WsCmd.RESPONSE).length,
      0,
    );
    expect(totalResponseFrames).toBe(1);

    client.disconnect();
  });
});
