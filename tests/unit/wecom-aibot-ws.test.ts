import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { PassThrough } from 'node:stream';
import { inspect } from 'node:util';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { officialApiEndpointDigest } from '../../src/platform/official-api-base.js';
import {
  assertSafeWecomWsUrlSyntax,
  computeWecomEndpointDigest,
  createPinnedWebSocket,
  decodeWecomAesKey,
  decryptWecomAttachment,
  validateWecomWsEndpoint,
  WECOM_AIBOT_DEFAULT_WS_URL,
  WecomWsClient,
  WsCmd,
  type WecomHttpsRequestImpl,
  type WecomWebSocketEvent,
  type WecomWebSocketLike,
  type WecomWebSocketListener,
  type WecomWsFrame,
} from '../../src/platform/wecom-aibot/index.js';

type SocketEventType = 'open' | 'message' | 'error' | 'close';

class MockWebSocket implements WecomWebSocketLike {
  readyState = 0;
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
    if (this.readyState !== 1) throw new Error('socket not open');
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
  simulateRaw(raw: string): void {
    this.emit('message', { data: raw });
  }
  simulateDrop(code = 1006, reason = 'network_drop'): void {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }
  private emit(type: SocketEventType, event: WecomWebSocketEvent): void {
    for (const listener of [...this.listeners[type]]) listener(event);
  }
}

function encodeServerFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const len = payload.length;
  const headerLen = len < 126 ? 2 : len <= 65_535 ? 4 : 10;
  const buf = Buffer.allocUnsafe(headerLen + len);
  buf[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
  if (len < 126) buf[1] = len;
  else if (len <= 65_535) {
    buf[1] = 126;
    buf.writeUInt16BE(len, 2);
  } else {
    buf[1] = 127;
    buf.writeBigUInt64BE(BigInt(len), 2);
  }
  payload.copy(buf, headerLen);
  return buf;
}

function decodeMaskedClientFrame(chunk: Buffer): { fin: boolean; opcode: number; masked: boolean; payload: Buffer } {
  const fin = (chunk[0]! & 0x80) !== 0;
  const opcode = chunk[0]! & 0x0f;
  const masked = (chunk[1]! & 0x80) !== 0;
  let offset = 2;
  let len = chunk[1]! & 0x7f;
  if (len === 126) {
    len = chunk.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    len = Number(chunk.readBigUInt64BE(2));
    offset = 10;
  }
  const mask = chunk.subarray(offset, offset + 4);
  const data = Buffer.from(chunk.subarray(offset + 4, offset + 4 + len));
  for (let i = 0; i < data.length; i++) data[i] = data[i]! ^ mask[i & 3]!;
  return { fin, opcode, masked, payload: data };
}

function encryptWecom32Pkcs7(plaintext: Buffer, rawKey: Buffer): Buffer {
  const pad = 32 - (plaintext.length % 32);
  const padded = Buffer.concat([plaintext, Buffer.alloc(pad, pad)]);
  const cipher = createCipheriv('aes-256-cbc', rawKey, rawKey.subarray(0, 16));
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
  ws.simulateFrame({ headers: { req_id: subscribeFrame!.headers.req_id }, errcode: 0, errmsg: 'ok' });
  await Promise.resolve();
  return subscribeFrame!;
}

function createPinnedMockEnv(options: {
  extraUpgradeHeaders?: Record<string, string>;
  hangUpgrade?: boolean;
  failWriteAfter?: number;
} = {}) {
  let requestCount = 0;
  let capturedOpts: RequestOptions | undefined;
  let pinnedAddress = '';
  const clientChunks: Buffer[] = [];
  const serverStream = new PassThrough();

  const httpsRequest = ((opts: RequestOptions) => {
    requestCount++;
    capturedOpts = opts;
    const req = Object.assign(new EventEmitter(), {
      destroy: () => req,
      end: () => {
        const lookup = opts.lookup as (
          h: string,
          o: { family?: number; all?: boolean },
          cb: (err: Error | null, addr: string, fam: number) => void,
        ) => void;
        lookup('openws.work.weixin.qq.com', { family: 4 }, (err, addr, fam) => {
          expect(err).toBeNull();
          expect(fam).toBe(4);
          pinnedAddress = addr;
        });
        if (options.hangUpgrade) return req;

        const key = String((opts.headers as Record<string, string>)['Sec-WebSocket-Key']);
        const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        let writes = 0;
        const duplex = Object.assign(new EventEmitter(), {
          destroyed: false,
          write: (chunk: Buffer | Uint8Array) => {
            writes++;
            if (options.failWriteAfter !== undefined && writes > options.failWriteAfter) {
              throw new Error('EPIPE');
            }
            clientChunks.push(Buffer.from(chunk));
            return true;
          },
          end: () => duplex,
          destroy: () => {
            if (!duplex.destroyed) {
              duplex.destroyed = true;
              duplex.emit('close');
            }
            return duplex;
          },
        });
        serverStream.on('data', (chunk: Buffer) => duplex.emit('data', chunk));
        queueMicrotask(() => {
          req.emit(
            'upgrade',
            {
              statusCode: 101,
              headers: {
                upgrade: 'websocket',
                connection: 'Upgrade',
                'sec-websocket-accept': accept,
                ...options.extraUpgradeHeaders,
              },
            } as IncomingMessage,
            duplex as unknown as PassThrough,
            Buffer.alloc(0),
          );
        });
        return req;
      },
    }) as unknown as ClientRequest;
    return req;
  }) as unknown as WecomHttpsRequestImpl;

  return {
    httpsRequest,
    serverStream,
    clientChunks,
    get requestCount() {
      return requestCount;
    },
    get capturedOpts() {
      return capturedOpts;
    },
    get pinnedAddress() {
      return pinnedAddress;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('WeCom attachment AES-256-CBC decryption', () => {
  test('decrypts 43-char and 44-char Base64 keys across 32-byte boundary lengths', () => {
    const rawKey = randomBytes(32);
    const key44 = rawKey.toString('base64');
    const key43 = key44.slice(0, 43);
    expect(decodeWecomAesKey(key43).equals(rawKey)).toBe(true);
    expect(decodeWecomAesKey(key44).equals(rawKey)).toBe(true);

    for (const sample of [Buffer.alloc(0), Buffer.from('hello wecom'), Buffer.alloc(32, 0x41), randomBytes(129)]) {
      const encrypted = encryptWecom32Pkcs7(sample, rawKey);
      expect(decryptWecomAttachment(encrypted, key43).equals(sample)).toBe(true);
      expect(decryptWecomAttachment(encrypted, key44).equals(sample)).toBe(true);
    }
  });

  test('rejects non-32-byte multiples (16B/48B), tampered ciphertext, bad PKCS#7 padding, and malformed keys without leaks', () => {
    const rawKey = randomBytes(32);
    const key43 = rawKey.toString('base64').slice(0, 43);
    const encrypted = encryptWecom32Pkcs7(Buffer.from('sensitive payload', 'utf8'), rawKey);

    const c16 = createCipheriv('aes-256-cbc', rawKey, rawKey.subarray(0, 16));
    c16.setAutoPadding(false);
    const block16 = Buffer.concat([c16.update(Buffer.alloc(16, 0x10)), c16.final()]);
    expect(() => decryptWecomAttachment(block16, key43)).toThrow('WECOM_CRYPTO_CIPHERTEXT_INVALID');
    expect(() => decryptWecomAttachment(Buffer.concat([encrypted, block16]), key43)).toThrow(
      'WECOM_CRYPTO_CIPHERTEXT_INVALID',
    );

    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x01;
    expect(() => decryptWecomAttachment(tampered, key43)).toThrow('WECOM_CRYPTO_PADDING_INVALID');

    const badPadPlain = Buffer.alloc(32, 0x61);
    badPadPlain.set([0x04, 0x03, 0x04, 0x04], 28);
    const cipherBadPad = createCipheriv('aes-256-cbc', rawKey, rawKey.subarray(0, 16));
    cipherBadPad.setAutoPadding(false);
    const encBadPad = Buffer.concat([cipherBadPad.update(badPadPlain), cipherBadPad.final()]);
    expect(() => decryptWecomAttachment(encBadPad, key43)).toThrow('WECOM_CRYPTO_PADDING_INVALID');

    for (const invalidPad of [0, 33]) {
      const cipher = createCipheriv('aes-256-cbc', rawKey, rawKey.subarray(0, 16));
      cipher.setAutoPadding(false);
      const enc = Buffer.concat([cipher.update(Buffer.alloc(32, invalidPad)), cipher.final()]);
      expect(() => decryptWecomAttachment(enc, key43)).toThrow('WECOM_CRYPTO_PADDING_INVALID');
    }

    const secretSentinel = 'BAD_KEY_SENTINEL_SECRET_9999999999999999999';
    let caught: unknown;
    try {
      decryptWecomAttachment(encrypted, secretSentinel);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toBe('WECOM_CRYPTO_KEY_INVALID');
    expect((caught as Error).message).not.toContain(secretSentinel);
  });
});

describe('WeCom WSS endpoint SSRF, digest alignment & PinnedWebSocket RFC 6455 hardening', () => {
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

  test('rejects query, fragment, backslash traversal and aligns endpointDigest with official-api-base', () => {
    for (const invalid of [
      'wss://openws.work.weixin.qq.com?token=abc',
      'wss://openws.work.weixin.qq.com#frag',
      'wss://openws.work.weixin.qq.com\\..\\secret',
    ]) {
      expect(() => assertSafeWecomWsUrlSyntax(invalid)).toThrow('WECOM_WS_ENDPOINT_INVALID');
    }
    expect(computeWecomEndpointDigest(WECOM_AIBOT_DEFAULT_WS_URL)).toBe(
      officialApiEndpointDigest(WECOM_AIBOT_DEFAULT_WS_URL, { allowedProtocols: ['wss:'] }),
    );
  });

  test('distinguishes transient DNS failure (reconnectable) from private-IP SSRF (terminal ERROR)', async () => {
    vi.useFakeTimers();
    await expect(
      validateWecomWsEndpoint('wss://evil-private.example.com', async () => [{ address: '10.0.0.8', family: 4 }]),
    ).rejects.toThrow('WECOM_WS_ENDPOINT_SSRF_BLOCKED');
    await expect(
      validateWecomWsEndpoint('wss://flaky-dns.example.com', async () => {
        throw new Error('EAI_AGAIN');
      }),
    ).rejects.toThrow('WECOM_WS_DNS_FAILED');

    const ssrfHarness = createHarness();
    let ssrfLookups = 0;
    const ssrfClient = new WecomWsClient({
      botId: 'bot-ssrf',
      secret: 'secret-ssrf',
      wsUrl: 'wss://rebind.example.com',
      reconnectBaseDelayMs: 1_000,
      webSocketFactory: ssrfHarness.factory,
      dnsLookup: async () => {
        ssrfLookups++;
        return [{ address: '192.168.10.20', family: 4 }];
      },
    });
    await expect(ssrfClient.connect()).rejects.toThrow('WECOM_WS_ENDPOINT_SSRF_BLOCKED');
    expect(ssrfClient.getStatus().state).toBe('ERROR');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ssrfLookups).toBe(1);

    const dnsHarness = createHarness();
    let dnsCalls = 0;
    const dnsClient = new WecomWsClient({
      botId: 'bot-dns',
      secret: 'secret-dns',
      wsUrl: 'wss://transient.example.com',
      reconnectBaseDelayMs: 1_000,
      webSocketFactory: dnsHarness.factory,
      dnsLookup: async () => {
        dnsCalls++;
        if (dnsCalls === 1) throw new Error('EAI_AGAIN');
        return [{ address: '101.226.103.50', family: 4 }];
      },
    });
    await expect(dnsClient.connect()).rejects.toThrow('WECOM_WS_DNS_FAILED');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(dnsCalls).toBe(2);
    await authenticateSocket(dnsHarness.sockets[0]!);
    expect(dnsClient.isConnected).toBe(true);
    dnsClient.disconnect();
  });

  test('PinnedWebSocket dials pinned IP once, confirms same-packet [TEXT(ACK)][CLOSE] synchronously, and handles fragments & ping/pong', async () => {
    let dnsLookups = 0;
    const env = createPinnedMockEnv();
    const receivedFrames: WecomWsFrame[] = [];

    const client = new WecomWsClient({
      botId: 'bot-pinned',
      secret: 'secret-pinned',
      maxReconnectAttempts: 0,
      dnsLookup: async () => {
        dnsLookups++;
        return [{ address: '101.226.103.50', family: 4 }];
      },
      httpsRequest: env.httpsRequest,
      onMessage: frame => receivedFrames.push(frame),
    });

    const connectP = client.connect();
    await new Promise(resolve => setTimeout(resolve, 15));

    expect(dnsLookups).toBe(1);
    expect(env.pinnedAddress).toBe('101.226.103.50');
    expect(env.capturedOpts?.servername).toBe('openws.work.weixin.qq.com');
    expect(env.capturedOpts?.rejectUnauthorized).toBe(true);
    expect((env.capturedOpts?.headers as Record<string, string>).Host).toBe('openws.work.weixin.qq.com');

    const subWire = decodeMaskedClientFrame(env.clientChunks[0]!);
    expect(subWire.masked).toBe(true);
    const subFrame = JSON.parse(subWire.payload.toString('utf8')) as WecomWsFrame;
    env.serverStream.emit(
      'data',
      encodeServerFrame(0x1, Buffer.from(JSON.stringify({ headers: { req_id: subFrame.headers.req_id }, errcode: 0 }))),
    );
    await connectP;

    // Fragmented TEXT frame + server PING -> client masked PONG
    const callbackJson = JSON.stringify({
      cmd: WsCmd.CALLBACK,
      headers: { req_id: 'frag-req-1' },
      body: { msgid: 'm1', aibotid: 'bot-pinned', chattype: 'single', from: { userid: 'u1' }, msgtype: 'text', text: { content: 'hi' } },
    });
    const half = Math.floor(callbackJson.length / 2);
    env.serverStream.emit('data', encodeServerFrame(0x1, Buffer.from(callbackJson.slice(0, half)), false));
    env.serverStream.emit('data', encodeServerFrame(0x0, Buffer.from(callbackJson.slice(half)), true));
    expect(receivedFrames).toHaveLength(1);

    const beforePing = env.clientChunks.length;
    env.serverStream.emit('data', encodeServerFrame(0x9, Buffer.from('hb-probe')));
    expect(decodeMaskedClientFrame(env.clientChunks[beforePing]!).opcode).toBe(0xa);

    // Same TCP/TLS chunk contains [TEXT(ACK errcode=0)][CLOSE(1000)]: ACK must confirm synchronously before CLOSE drops state.
    const replyPromise = client.sendReplyOnce({ reqId: 'same-pkt-req', content: 'final reply' });
    const closePayload = Buffer.alloc(2);
    closePayload.writeUInt16BE(1000, 0);
    const combinedChunk = Buffer.concat([
      encodeServerFrame(0x1, Buffer.from(JSON.stringify({ headers: { req_id: 'same-pkt-req' }, errcode: 0 }))),
      encodeServerFrame(0x8, closePayload),
    ]);
    env.serverStream.emit('data', combinedChunk);

    const ack = await replyPromise;
    expect(ack.errcode).toBe(0);
    expect(ack.reqId).toBe('same-pkt-req');
    client.disconnect();
  });

  test('PinnedWebSocket rejects unsolicited extensions, non-minimal lengths, invalid UTF-8, bad CLOSE codes, empty-fragment flood, and catches PING write error', async () => {
    const validated = await validateWecomWsEndpoint(WECOM_AIBOT_DEFAULT_WS_URL, async () => [
      { address: '101.226.103.50', family: 4 },
    ]);

    // 1. Unsolicited Sec-WebSocket-Extensions must reject Upgrade.
    const extEnv = createPinnedMockEnv({ extraUpgradeHeaders: { 'sec-websocket-extensions': 'permessage-deflate' } });
    const extClosed = new Promise<number>(resolve => {
      const ws = createPinnedWebSocket(validated, { requestImpl: extEnv.httpsRequest });
      ws.addEventListener('close', e => resolve(e.code ?? 0));
    });
    expect(await extClosed).toBe(1002);

    // 2. Empty CLOSE from server -> client must reply empty CLOSE payload (never wire 1005).
    const emptyCloseEnv = createPinnedMockEnv();
    const emptyCloseWs = createPinnedWebSocket(validated, { requestImpl: emptyCloseEnv.httpsRequest });
    await new Promise<void>(resolve => emptyCloseWs.addEventListener('open', () => resolve()));
    emptyCloseEnv.serverStream.emit('data', encodeServerFrame(0x8, Buffer.alloc(0)));
    expect(emptyCloseEnv.clientChunks).toHaveLength(1);
    const closeReply = decodeMaskedClientFrame(emptyCloseEnv.clientChunks[0]!);
    expect(closeReply.opcode).toBe(0x8);
    expect(closeReply.payload.length).toBe(0);

    // 3. Single-byte CLOSE, invalid close code 1005, non-minimal 126 length (<126), invalid UTF-8 text, and empty continuation flood.
    const invalidFrames: { buf: Buffer; expectedCode: number }[] = [
      { buf: encodeServerFrame(0x8, Buffer.from([0x03])), expectedCode: 1002 },
      { buf: encodeServerFrame(0x8, Buffer.from([0x03, 0xed])), expectedCode: 1002 }, // 1005 on wire
      { buf: Buffer.from([0x81, 126, 0x00, 0x10, ...Buffer.alloc(16, 0x41)]), expectedCode: 1002 },
      { buf: encodeServerFrame(0x1, Buffer.from([0xff, 0xfe])), expectedCode: 1007 },
    ];
    for (const item of invalidFrames) {
      const env = createPinnedMockEnv();
      const ws = createPinnedWebSocket(validated, { requestImpl: env.httpsRequest });
      await new Promise<void>(resolve => ws.addEventListener('open', () => resolve()));
      const closed = new Promise<number>(resolve => ws.addEventListener('close', e => resolve(e.code ?? 0)));
      env.serverStream.emit('data', item.buf);
      expect(await closed).toBe(item.expectedCode);
    }

    // Empty continuation flood exceeds fragment cap -> closes with 1009.
    const fragEnv = createPinnedMockEnv();
    const fragWs = createPinnedWebSocket(validated, { requestImpl: fragEnv.httpsRequest });
    await new Promise<void>(resolve => fragWs.addEventListener('open', () => resolve()));
    const fragClosed = new Promise<number>(resolve => fragWs.addEventListener('close', e => resolve(e.code ?? 0)));
    fragEnv.serverStream.emit('data', encodeServerFrame(0x1, Buffer.from('a'), false));
    for (let i = 0; i < 260; i++) fragEnv.serverStream.emit('data', encodeServerFrame(0x0, Buffer.alloc(0), false));
    expect(await fragClosed).toBe(1009);

    // PING write failure is caught cleanly without throwing synchronously.
    const pingErrEnv = createPinnedMockEnv({ failWriteAfter: 0 });
    const pingWs = createPinnedWebSocket(validated, { requestImpl: pingErrEnv.httpsRequest });
    await new Promise<void>(resolve => pingWs.addEventListener('open', () => resolve()));
    const pingClosed = new Promise<number>(resolve => pingWs.addEventListener('close', e => resolve(e.code ?? 0)));
    expect(() => pingErrEnv.serverStream.emit('data', encodeServerFrame(0x9, Buffer.from('p')))).not.toThrow();
    expect(await pingClosed).toBe(1006);
  });

  test('PinnedWebSocket handshake timeout and external abort advance generation before aborting so state/errors stay exact without spurious reconnect', async () => {
    vi.useFakeTimers();

    // Handshake timeout on hung PinnedWebSocket -> must reject WECOM_WS_CONNECT_TIMEOUT (not WECOM_WS_DISCONNECTED).
    const hungEnv = createPinnedMockEnv({ hangUpgrade: true });
    const toClient = new WecomWsClient({
      botId: 'bot-pinned-to',
      secret: 's',
      connectTimeoutMs: 1_500,
      maxReconnectAttempts: 0,
      dnsLookup: async () => [{ address: '101.226.103.50', family: 4 }],
      httpsRequest: hungEnv.httpsRequest,
    });
    const toP = toClient.connect();
    const toCheck = expect(toP).rejects.toThrow('WECOM_WS_CONNECT_TIMEOUT');
    await vi.advanceTimersByTimeAsync(1_500);
    await toCheck;

    // External AbortSignal aborting hung PinnedWebSocket -> rejects WECOM_WS_CLOSED, stays DISCONNECTED, 0 auto-reconnects.
    const abortEnv = createPinnedMockEnv({ hangUpgrade: true });
    const ac = new AbortController();
    const abortClient = new WecomWsClient({
      botId: 'bot-pinned-abort',
      secret: 's',
      reconnectBaseDelayMs: 500,
      maxReconnectAttempts: 5,
      dnsLookup: async () => [{ address: '101.226.103.50', family: 4 }],
      httpsRequest: abortEnv.httpsRequest,
    });
    const abortP = abortClient.connect(ac.signal);
    await vi.advanceTimersByTimeAsync(1);
    expect(abortEnv.requestCount).toBe(1);
    const abortCheck = expect(abortP).rejects.toThrow('WECOM_WS_CLOSED');
    ac.abort();
    await abortCheck;
    expect(abortClient.getStatus().state).toBe('DISCONNECTED');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(abortEnv.requestCount).toBe(1);
  });
});

describe('WecomWsClient lifecycle, disconnect/reconnect race safety, ACK gating & single-send guarantees', () => {
  test('disconnect() clears connectPromise immediately for sync reconnect, and auto-reconnect shares single tracked slot with concurrent connect()', async () => {
    vi.useFakeTimers();
    const { sockets, factory } = createHarness();
    const secret = 'synthetic-wecom-secret-do-not-expose';
    const client = new WecomWsClient({
      botId: 'bot-alpha',
      secret,
      reconnectBaseDelayMs: 500,
      maxReconnectAttempts: 3,
      webSocketFactory: factory,
    });

    // Disconnect mid-handshake then synchronously call connect(): must open fresh socket #2.
    const first = client.connect();
    const firstExpect = expect(first).rejects.toThrow('WECOM_WS_CLOSED');
    client.disconnect();
    await firstExpect;

    const second = client.connect();
    expect(sockets).toHaveLength(2);
    await authenticateSocket(sockets[1]!);
    await second;
    expect(JSON.stringify(client.getStatus())).not.toContain(secret);
    expect(JSON.stringify(client)).not.toContain(secret);
    expect(inspect(client, { showHidden: true, depth: 4 })).not.toContain(secret);

    // Drop triggers auto-reconnect; concurrent manual connect() shares that single tracked attempt (no extra socket).
    sockets[1]!.simulateDrop();
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(3);
    const shared = client.connect();
    expect(sockets).toHaveLength(3);
    await authenticateSocket(sockets[2]!);
    await shared;
    expect(client.isConnected).toBe(true);
    client.disconnect();
  });

  test('enforces strict numeric errcode ACK gate across auth/heartbeat/reply and isolates async callbacks & throwing onError', async () => {
    vi.useFakeTimers();
    const { sockets, factory } = createHarness();
    const received: WecomWsFrame[] = [];
    const seenErrors: string[] = [];
    let mode: 'ok' | 'async_reject' = 'ok';

    const client = new WecomWsClient({
      botId: 'bot-guard',
      secret: 'secret-guard',
      heartbeatIntervalMs: 5_000,
      missedPongThreshold: 2,
      webSocketFactory: factory,
      onMessage: frame => {
        if (mode === 'async_reject') return Promise.reject(new Error('async boom')) as unknown as void;
        received.push(frame);
      },
      onError: err => {
        seenErrors.push(err.message);
        throw new Error('throwing onError must be isolated');
      },
    });

    const connectP = client.connect();
    sockets[0]!.simulateOpen();

    // Pre-auth callback and auth ACK missing numeric errcode are both ignored.
    const sub = sockets[0]!.sentFrames.find(f => f.cmd === WsCmd.SUBSCRIBE)!;
    sockets[0]!.simulateFrame({ cmd: WsCmd.CALLBACK, headers: { req_id: 'pre-auth' }, body: { msgid: 'm0', aibotid: 'bot-guard', chattype: 'single', from: { userid: 'u1' }, msgtype: 'text' } });
    sockets[0]!.simulateFrame({ headers: { req_id: sub.headers.req_id } });
    expect(received).toHaveLength(0);
    expect(client.isConnected).toBe(false);

    sockets[0]!.simulateFrame({ headers: { req_id: sub.headers.req_id }, errcode: 0 });
    await connectP;

    // Heartbeat ACK missing numeric errcode must NOT reset missedPongCount.
    await vi.advanceTimersByTimeAsync(5_000);
    const p1 = sockets[0]!.sentFrames.filter(f => f.cmd === WsCmd.HEARTBEAT)[0]!;
    sockets[0]!.simulateFrame({ headers: { req_id: p1.headers.req_id } });
    await vi.advanceTimersByTimeAsync(5_000); // sends ping 2 (missedPongCount=2)
    await vi.advanceTimersByTimeAsync(5_000); // sees missedPongCount>=2 -> dead socket
    expect(sockets[0]!.closeCalls.length).toBeGreaterThanOrEqual(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await authenticateSocket(sockets[1]!);

    // Unknown cmd or missing errcode never confirms reply; async rejecting onMessage and throwing onError are contained.
    let confirmed = false;
    const replyP = client.sendReplyOnce({ reqId: 'req-ack', content: 'hi' }).then(r => {
      confirmed = true;
      return r;
    });
    sockets[1]!.simulateFrame({ cmd: 'aibot_unknown', headers: { req_id: 'req-ack' }, errcode: 0 });
    sockets[1]!.simulateFrame({ headers: { req_id: 'req-ack' } });
    await Promise.resolve();
    expect(confirmed).toBe(false);
    sockets[1]!.simulateFrame({ headers: { req_id: 'req-ack' }, errcode: 0 });
    expect((await replyP).errcode).toBe(0);

    mode = 'async_reject';
    sockets[1]!.simulateFrame({ cmd: WsCmd.CALLBACK, headers: { req_id: 'cb-async' }, body: { msgid: 'm2', aibotid: 'bot-guard', chattype: 'single', from: { userid: 'u1' }, msgtype: 'text' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(seenErrors).toContain('WECOM_WS_FRAME_INVALID');
    client.disconnect();
  });

  test('catches throwing secret(), bounds auth retries by maxAuthFailureAttempts & maxReconnectAttempts, applies 30s backoff cap, and enforces serial pendingAckSeq with 0 resend', async () => {
    vi.useFakeTimers();

    expect(() => new WecomWsClient({ botId: 'b', secret: () => { throw new Error('raw'); } })).toThrow('WECOM_WS_CREDENTIAL_REQUIRED');

    // Auth failure exhaustion + subscribe-drop counting
    const authHarness = createHarness();
    const authClient = new WecomWsClient({
      botId: 'bot-auth',
      secret: 'wrong',
      maxAuthFailureAttempts: 2,
      reconnectBaseDelayMs: 1_000,
      webSocketFactory: authHarness.factory,
    });
    const p0 = authClient.connect().catch(e => e as Error);
    authHarness.sockets[0]!.simulateOpen();
    authHarness.sockets[0]!.simulateDrop();
    expect(((await p0) as Error).message).toBe('WECOM_WS_AUTH_DISCONNECTED');
    await vi.advanceTimersByTimeAsync(1_000);
    authHarness.sockets[1]!.simulateOpen();
    authHarness.sockets[1]!.simulateFrame({ headers: { req_id: authHarness.sockets[1]!.sentFrames[0]!.headers.req_id }, errcode: 40001 });
    expect(authClient.getStatus().errorCode).toBe('WS_AUTH_FAILURE_EXHAUSTED');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(authHarness.sockets).toHaveLength(2);

    // Serial queue, pendingAckSeq timeout/late-ACK race, UTF-8 limit, disconnect 0 resend & backoff cap
    const { sockets, factory } = createHarness();
    const delays: number[] = [];
    const client = new WecomWsClient({
      botId: 'bot-q',
      secret: 's',
      ackTimeoutMs: 5_000,
      maxReplyBytes: 32,
      reconnectBaseDelayMs: 1_000,
      reconnectMaxDelayMs: 30_000,
      maxReconnectAttempts: 6,
      webSocketFactory: factory,
      onReconnecting: info => delays.push(info.delayMs),
    });
    const cp = client.connect();
    await authenticateSocket(sockets[0]!);
    await cp;

    await expect(client.sendReplyOnce({ reqId: 'big', content: '你'.repeat(12) })).rejects.toThrow('WECOM_WS_REPLY_TOO_LONG');

    const s1 = client.sendReplyOnce({ reqId: 'ser', content: '1' });
    const s2 = client.sendReplyOnce({ reqId: 'ser', content: '2' });
    expect(sockets[0]!.sentFrames.filter(f => f.headers.req_id === 'ser')).toHaveLength(1);
    sockets[0]!.simulateFrame({ headers: { req_id: 'ser', seq: 999 }, errcode: 0 });
    expect(sockets[0]!.sentFrames.filter(f => f.headers.req_id === 'ser')).toHaveLength(1);
    sockets[0]!.simulateFrame({ headers: { req_id: 'ser' }, errcode: 0 });
    expect((await s1).ackSeq).toBe(1);
    sockets[0]!.simulateFrame({ headers: { req_id: 'ser' }, errcode: 0 });
    expect((await s2).ackSeq).toBe(2);

    const rA = client.sendReplyOnce({ reqId: 'race', content: 'A' });
    const rB = client.sendReplyOnce({ reqId: 'race', content: 'B' });
    const eA = expect(rA).rejects.toThrow('WECOM_WS_SEND_UNCERTAIN');
    const eB = expect(rB).rejects.toThrow('WECOM_WS_SEND_UNCERTAIN');
    await vi.advanceTimersByTimeAsync(5_000);
    await eA;
    await eB;
    expect(sockets[0]!.sentFrames.filter(f => f.headers.req_id === 'race')).toHaveLength(1);
    const beforeLate = client.getStatus().lateAckIgnoredCount;
    sockets[0]!.simulateFrame({ headers: { req_id: 'race' }, errcode: 0 });
    expect(client.getStatus().lateAckIgnoredCount).toBe(beforeLate + 1);

    const dropP = client.sendReplyOnce({ reqId: 'drop', content: 'once' });
    const dropCheck = expect(dropP).rejects.toThrow('WECOM_WS_SEND_UNCERTAIN');
    sockets[0]!.simulateDrop();
    await dropCheck;
    await vi.advanceTimersByTimeAsync(1_000);
    await authenticateSocket(sockets[1]!);
    expect(sockets[1]!.sentFrames.filter(f => f.cmd === WsCmd.RESPONSE)).toHaveLength(0);

    delays.length = 0;
    for (const expectedDelay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]) {
      sockets[sockets.length - 1]!.simulateDrop();
      expect(delays[delays.length - 1]).toBe(expectedDelay);
      await vi.advanceTimersByTimeAsync(expectedDelay);
    }
    sockets[sockets.length - 1]!.simulateDrop();
    expect(client.getStatus().errorCode).toBe('WECOM_WS_RECONNECT_EXHAUSTED');
    client.disconnect();
  });
});
