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
  if (len < 126) {
    buf[1] = len;
  } else if (len <= 65_535) {
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

    // 16B and 48B ciphertexts are not 32-byte multiples and must be rejected.
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

describe('WeCom WSS endpoint SSRF, digest alignment & PinnedWebSocket anti-rebinding', () => {
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

    // Private IP SSRF during connect: terminal ERROR, 0 reconnects.
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
    expect(ssrfHarness.sockets).toHaveLength(0);

    // Transient DNS error: schedules reconnect and recovers once DNS succeeds.
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
    expect(dnsClient.getStatus().state).toBe('DEGRADED');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(dnsCalls).toBe(2);
    expect(dnsHarness.sockets).toHaveLength(1);
    await authenticateSocket(dnsHarness.sockets[0]!);
    expect(dnsClient.isConnected).toBe(true);
    dnsClient.disconnect();
  });

  test('PinnedWebSocket dials pinned IP without second DNS lookup and handles RFC 6455 masking, fragments & ping/pong', async () => {
    let dnsLookups = 0;
    let capturedOpts: RequestOptions | undefined;
    let pinnedAddress = '';
    const clientChunks: Buffer[] = [];
    const serverStream = new PassThrough();
    const receivedFrames: WecomWsFrame[] = [];

    const mockHttpsRequest = ((opts: RequestOptions) => {
      capturedOpts = opts;
      const req = Object.assign(new EventEmitter(), {
        destroy: () => req,
        end: () => {
        // Verify pinned lookup returns pre-validated public IP without calling dnsLookup again.
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

        const key = String((opts.headers as Record<string, string>)['Sec-WebSocket-Key']);
        const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        // Separate write sink from inbound server stream (PassThrough echoes writes back to 'data').
        const duplex = Object.assign(new EventEmitter(), {
          destroyed: false,
          write: (chunk: Buffer | Uint8Array) => {
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
              headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-accept': accept },
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

    const client = new WecomWsClient({
      botId: 'bot-pinned',
      secret: 'secret-pinned',
      dnsLookup: async () => {
        dnsLookups++;
        return [{ address: '101.226.103.50', family: 4 }];
      },
      httpsRequest: mockHttpsRequest,
      onMessage: frame => receivedFrames.push(frame),
    });

    const connectP = client.connect();
    await new Promise(resolve => setTimeout(resolve, 15));

    // Only 1 DNS resolution occurred; pinned lookup returned exact validated IP with SNI/TLS intact.
    expect(dnsLookups).toBe(1);
    expect(pinnedAddress).toBe('101.226.103.50');
    expect(capturedOpts?.servername).toBe('openws.work.weixin.qq.com');
    expect(capturedOpts?.rejectUnauthorized).toBe(true);
    expect((capturedOpts?.headers as Record<string, string>).Host).toBe('openws.work.weixin.qq.com');

    // Client subscribe frame must be RFC 6455 masked.
    expect(clientChunks.length).toBeGreaterThanOrEqual(1);
    const subWire = decodeMaskedClientFrame(clientChunks[0]!);
    expect(subWire.masked).toBe(true);
    expect(subWire.opcode).toBe(0x1);
    const subFrame = JSON.parse(subWire.payload.toString('utf8')) as WecomWsFrame;
    expect(subFrame.cmd).toBe(WsCmd.SUBSCRIBE);

    // Reply with unmasked server auth ACK, then test fragmented TEXT frame and server PING -> client PONG.
    serverStream.emit(
      'data',
      encodeServerFrame(0x1, Buffer.from(JSON.stringify({ headers: { req_id: subFrame.headers.req_id }, errcode: 0 }))),
    );
    await connectP;
    expect(client.isConnected).toBe(true);

    const callbackJson = JSON.stringify({
      cmd: WsCmd.CALLBACK,
      headers: { req_id: 'frag-req-1' },
      body: { msgid: 'm1', aibotid: 'bot-pinned', chattype: 'single', from: { userid: 'u1' }, msgtype: 'text', text: { content: 'hi' } },
    });
    const half = Math.floor(callbackJson.length / 2);
    serverStream.emit('data', encodeServerFrame(0x1, Buffer.from(callbackJson.slice(0, half)), false));
    serverStream.emit('data', encodeServerFrame(0x0, Buffer.from(callbackJson.slice(half)), true));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(receivedFrames).toHaveLength(1);
    expect(receivedFrames[0]!.headers.req_id).toBe('frag-req-1');

    // Server PING -> client must emit masked PONG with same payload.
    const countBeforePing = clientChunks.length;
    serverStream.emit('data', encodeServerFrame(0x9, Buffer.from('hb-probe')));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(clientChunks.length).toBeGreaterThan(countBeforePing);
    const pongWire = decodeMaskedClientFrame(clientChunks[countBeforePing]!);
    expect(pongWire.masked).toBe(true);
    expect(pongWire.opcode).toBe(0xa);
    expect(pongWire.payload.toString('utf8')).toBe('hb-probe');

    client.disconnect();
  });
});

describe('WecomWsClient protocol safety, connectPromise, auth gating & single-send guarantees', () => {
  test('authenticates, clears connectPromise on disconnect/failure for clean reconnect, and never exposes secret', async () => {
    const { sockets, factory } = createHarness();
    const secret = 'synthetic-wecom-secret-do-not-expose';
    const client = new WecomWsClient({ botId: 'bot-alpha', secret, maxReconnectAttempts: 0, webSocketFactory: factory });

    // 1st attempt fails -> connectPromise must clear so 2nd connect() initiates a fresh socket.
    const failConnect = client.connect();
    sockets[0]!.simulateDrop();
    await expect(failConnect).rejects.toThrow('WECOM_WS_DISCONNECTED');

    const okConnect = client.connect();
    expect(sockets).toHaveLength(2);
    const subscribe = await authenticateSocket(sockets[1]!);
    await okConnect;
    expect(subscribe.body).toEqual({ bot_id: 'bot-alpha', secret });
    expect(JSON.stringify(client.getStatus())).not.toContain(secret);
    expect(JSON.stringify(client)).not.toContain(secret);
    expect(inspect(client, { showHidden: true, depth: 4 })).not.toContain(secret);

    // Close and reopen must create socket #3 rather than returning stale resolved promise.
    client.disconnect();
    const reopen = client.connect();
    expect(sockets).toHaveLength(3);
    await authenticateSocket(sockets[2]!);
    await reopen;
    expect(client.isConnected).toBe(true);
    client.disconnect();
  });

  test('blocks pre-auth callbacks, ignores unknown-cmd/missing-errcode ACKs, and isolates malformed/throwing handlers', async () => {
    const { sockets, factory } = createHarness();
    const received: WecomWsFrame[] = [];
    const errors: string[] = [];
    let throwInHandler = false;

    const client = new WecomWsClient({
      botId: 'bot-guard',
      secret: 'secret-guard',
      webSocketFactory: factory,
      onMessage: frame => {
        if (throwInHandler) throw new Error('boom inside handler');
        received.push(frame);
      },
      onError: err => errors.push(err.message),
    });

    const connectP = client.connect();
    sockets[0]!.simulateOpen();

    // Before auth ACK arrives: CALLBACK must be ignored.
    sockets[0]!.simulateFrame({
      cmd: WsCmd.CALLBACK,
      headers: { req_id: 'pre-auth-req' },
      body: { msgid: 'm0', aibotid: 'bot-guard', chattype: 'single', from: { userid: 'u1' }, msgtype: 'text' },
    });
    await Promise.resolve();
    expect(received).toHaveLength(0);

    // Complete auth.
    const sub = sockets[0]!.sentFrames.find(f => f.cmd === WsCmd.SUBSCRIBE)!;
    sockets[0]!.simulateFrame({ headers: { req_id: sub.headers.req_id }, errcode: 0, errmsg: 'ok' });
    await connectP;

    // Unknown cmd or missing errcode frame must NOT confirm in-flight outbound reply.
    let resolved = false;
    const replyP = client.sendReplyOnce({ reqId: 'req-strict-ack', content: 'hello' }).then(res => {
      resolved = true;
      return res;
    });
    sockets[0]!.simulateFrame({ cmd: 'aibot_unknown', headers: { req_id: 'req-strict-ack' }, errcode: 0 });
    sockets[0]!.simulateFrame({ headers: { req_id: 'req-strict-ack' } });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(resolved).toBe(false);
    expect(client.getStatus().lateAckIgnoredCount).toBeGreaterThanOrEqual(2);

    // Real official ACK (cmd omitted, numeric errcode === 0) confirms delivery.
    sockets[0]!.simulateFrame({ headers: { req_id: 'req-strict-ack' }, errcode: 0, errmsg: 'ok' });
    const res = await replyP;
    expect(res.errcode).toBe(0);

    // Malformed JSON and throwing onMessage callback are contained as WECOM_WS_FRAME_INVALID without unhandled rejections.
    sockets[0]!.simulateRaw('{not-json');
    throwInHandler = true;
    sockets[0]!.simulateFrame({
      cmd: WsCmd.CALLBACK,
      headers: { req_id: 'bad-cb' },
      body: { msgid: 'm2', aibotid: 'bot-guard', chattype: 'single', from: { userid: 'u1' }, msgtype: 'text' },
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(errors.filter(e => e === 'WECOM_WS_FRAME_INVALID').length).toBeGreaterThanOrEqual(2);
    client.disconnect();
  });

  test('enforces connectTimeoutMs, catches throwing secret(), bounds auth retries by maxReconnectAttempts, and counts subscribe disconnects', async () => {
    vi.useFakeTimers();

    // Throwing secret() in constructor & during subscribe.
    expect(
      () => new WecomWsClient({ botId: 'b', secret: () => { throw new Error('raw-secret-boom'); } }),
    ).toThrow('WECOM_WS_CREDENTIAL_REQUIRED');

    let secretCall = 0;
    const secHarness = createHarness();
    const secErrors: string[] = [];
    const secClient = new WecomWsClient({
      botId: 'bot-sec',
      secret: () => {
        secretCall++;
        if (secretCall === 1) return 'initial-ok';
        throw new Error('vault-locked-raw-secret');
      },
      webSocketFactory: secHarness.factory,
      onError: e => secErrors.push(e.message),
    });
    const secP = secClient.connect();
    secHarness.sockets[0]!.simulateOpen();
    await expect(secP).rejects.toThrow('WECOM_WS_CREDENTIAL_REQUIRED');
    expect(secErrors).toContain('WECOM_WS_CREDENTIAL_REQUIRED');
    expect(secClient.getStatus().state).toBe('ERROR');

    // Handshake timeout when socket never opens.
    const toHarness = createHarness();
    const toClient = new WecomWsClient({
      botId: 'bot-to',
      secret: 's',
      connectTimeoutMs: 2_000,
      maxReconnectAttempts: 0,
      webSocketFactory: toHarness.factory,
    });
    const toP = toClient.connect();
    const toExpect = expect(toP).rejects.toThrow('WECOM_WS_CONNECT_TIMEOUT');
    await vi.advanceTimersByTimeAsync(2_000);
    await toExpect;

    // Subscribe sent then socket drops without ACK -> counts toward consecutiveAuthFailures AND maxReconnectAttempts.
    const dropHarness = createHarness();
    const dropClient = new WecomWsClient({
      botId: 'bot-drop-auth',
      secret: 's',
      maxAuthFailureAttempts: 5,
      maxReconnectAttempts: 1,
      reconnectBaseDelayMs: 1_000,
      webSocketFactory: dropHarness.factory,
    });
    const first = dropClient.connect().catch(err => err as Error);
    dropHarness.sockets[0]!.simulateOpen();
    dropHarness.sockets[0]!.simulateDrop();
    expect(((await first) as Error).message).toBe('WECOM_WS_AUTH_DISCONNECTED');
    expect(dropClient.getStatus().consecutiveAuthFailures).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(dropHarness.sockets).toHaveLength(2);
    dropHarness.sockets[1]!.simulateOpen();
    dropHarness.sockets[1]!.simulateDrop();
    await Promise.resolve();
    expect(dropClient.getStatus().consecutiveAuthFailures).toBe(2);
    expect(dropClient.getStatus().state).toBe('ERROR');
    expect(dropClient.getStatus().errorCode).toBe('WECOM_WS_RECONNECT_EXHAUSTED');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dropHarness.sockets).toHaveLength(2);
  });

  test('stops reconnecting on WS_AUTH_FAILURE_EXHAUSTED, detects 2 missed pongs, and applies exponential backoff capped at 30s', async () => {
    vi.useFakeTimers();

    // Auth failure exhaustion (maxAuthFailureAttempts = 3)
    const authHarness = createHarness();
    const authErrors: string[] = [];
    const authClient = new WecomWsClient({
      botId: 'bot-auth',
      secret: 'wrong',
      maxAuthFailureAttempts: 3,
      reconnectBaseDelayMs: 1_000,
      webSocketFactory: authHarness.factory,
      onError: e => authErrors.push(e.message),
    });
    const p0 = authClient.connect().catch(e => e as Error);
    authHarness.sockets[0]!.simulateOpen();
    authHarness.sockets[0]!.simulateFrame({ headers: { req_id: authHarness.sockets[0]!.sentFrames[0]!.headers.req_id }, errcode: 40001 });
    expect(((await p0) as Error).message).toBe('WECOM_WS_AUTH_FAILED');
    await vi.advanceTimersByTimeAsync(1_000);
    authHarness.sockets[1]!.simulateOpen();
    authHarness.sockets[1]!.simulateFrame({ headers: { req_id: authHarness.sockets[1]!.sentFrames[0]!.headers.req_id }, errcode: 40001 });
    await vi.advanceTimersByTimeAsync(2_000);
    authHarness.sockets[2]!.simulateOpen();
    authHarness.sockets[2]!.simulateFrame({ headers: { req_id: authHarness.sockets[2]!.sentFrames[0]!.headers.req_id }, errcode: 40001 });
    await Promise.resolve();
    expect(authClient.getStatus().errorCode).toBe('WS_AUTH_FAILURE_EXHAUSTED');
    expect(authErrors).toContain('WS_AUTH_FAILURE_EXHAUSTED');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(authHarness.sockets).toHaveLength(3);

    // Heartbeat 2 missed pongs + exponential backoff 1s -> 2s -> ... -> 30s
    const hbHarness = createHarness();
    const delays: number[] = [];
    const hbClient = new WecomWsClient({
      botId: 'bot-hb',
      secret: 's',
      heartbeatIntervalMs: 10_000,
      missedPongThreshold: 2,
      reconnectBaseDelayMs: 1_000,
      reconnectMaxDelayMs: 30_000,
      maxReconnectAttempts: 7,
      webSocketFactory: hbHarness.factory,
      onReconnecting: info => delays.push(info.delayMs),
    });
    const cp = hbClient.connect();
    await authenticateSocket(hbHarness.sockets[0]!);
    await cp;

    await vi.advanceTimersByTimeAsync(10_000);
    const ping1 = hbHarness.sockets[0]!.sentFrames.filter(f => f.cmd === WsCmd.HEARTBEAT);
    hbHarness.sockets[0]!.simulateFrame({ headers: { req_id: ping1[0]!.headers.req_id }, errcode: 0 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(hbHarness.sockets[0]!.closeCalls.length).toBeGreaterThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(hbHarness.sockets).toHaveLength(2);
    await authenticateSocket(hbHarness.sockets[1]!);

    delays.length = 0;
    const expected = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    for (let i = 0; i < expected.length; i++) {
      hbHarness.sockets[hbHarness.sockets.length - 1]!.simulateDrop();
      expect(delays[i]).toBe(expected[i]);
      await vi.advanceTimersByTimeAsync(expected[i]!);
    }
    hbHarness.sockets[hbHarness.sockets.length - 1]!.simulateDrop();
    expect(hbClient.getStatus().errorCode).toBe('WECOM_WS_RECONNECT_EXHAUSTED');
    hbClient.disconnect();
  });

  test('serializes per req_id, prevents timeout/late-ACK races with pendingAckSeq, enforces UTF-8 limit and 0 retries on disconnect', async () => {
    vi.useFakeTimers();
    const { sockets, factory } = createHarness();
    const client = new WecomWsClient({
      botId: 'bot-queue',
      secret: 's',
      ackTimeoutMs: 5_000,
      maxReplyBytes: 32,
      reconnectBaseDelayMs: 1_000,
      webSocketFactory: factory,
    });
    const cp = client.connect();
    await authenticateSocket(sockets[0]!);
    await cp;

    await expect(client.sendReplyOnce({ reqId: 'req-big', content: '你'.repeat(12) })).rejects.toThrow('WECOM_WS_REPLY_TOO_LONG');

    const s1 = client.sendReplyOnce({ reqId: 'req-serial', content: 'first', streamId: 's1' });
    const s2 = client.sendReplyOnce({ reqId: 'req-serial', content: 'second', streamId: 's2' });
    const serialFrames = () => sockets[0]!.sentFrames.filter(f => f.cmd === WsCmd.RESPONSE && f.headers.req_id === 'req-serial');
    expect(serialFrames()).toHaveLength(1);

    sockets[0]!.simulateFrame({ headers: { req_id: 'req-serial', seq: 999 }, errcode: 0 });
    await Promise.resolve();
    expect(serialFrames()).toHaveLength(1);

    sockets[0]!.simulateFrame({ headers: { req_id: 'req-serial' }, errcode: 0 });
    expect((await s1).ackSeq).toBe(1);
    expect(serialFrames()).toHaveLength(2);
    sockets[0]!.simulateFrame({ headers: { req_id: 'req-serial' }, errcode: 0 });
    expect((await s2).ackSeq).toBe(2);

    // Timeout + late ACK race: queued frame B fails closed without transmitting.
    const sA = client.sendReplyOnce({ reqId: 'req-race', content: 'A' });
    const sB = client.sendReplyOnce({ reqId: 'req-race', content: 'B' });
    const raceFrames = () => sockets[0]!.sentFrames.filter(f => f.cmd === WsCmd.RESPONSE && f.headers.req_id === 'req-race');
    expect(raceFrames()).toHaveLength(1);
    const eA = expect(sA).rejects.toThrow('WECOM_WS_SEND_UNCERTAIN');
    const eB = expect(sB).rejects.toThrow('WECOM_WS_SEND_UNCERTAIN');
    await vi.advanceTimersByTimeAsync(5_000);
    await eA;
    await eB;
    expect(raceFrames()).toHaveLength(1);

    const beforeLate = client.getStatus().lateAckIgnoredCount;
    sockets[0]!.simulateFrame({ headers: { req_id: 'req-race' }, errcode: 0 });
    await Promise.resolve();
    expect(client.getStatus().lateAckIgnoredCount).toBe(beforeLate + 1);

    // Disconnect in-flight -> WECOM_WS_SEND_UNCERTAIN, 0 resend after reconnect.
    const dropSend = client.sendReplyOnce({ reqId: 'req-drop', content: 'once' });
    const dropCheck = expect(dropSend).rejects.toThrow('WECOM_WS_SEND_UNCERTAIN');
    sockets[0]!.simulateDrop();
    await dropCheck;
    await vi.advanceTimersByTimeAsync(1_000);
    await authenticateSocket(sockets[1]!);
    expect(sockets[1]!.sentFrames.filter(f => f.cmd === WsCmd.RESPONSE)).toHaveLength(0);
    client.disconnect();
  });
});
