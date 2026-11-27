import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ClientRequest, IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { Duplex } from 'node:stream';
import { Blocked } from '../../core/contracts.js';
import type { ValidatedOfficialApiEndpoint } from '../official-api-base.js';
import {
  WECOM_MAX_INBOUND_FRAME_BYTES,
  type WecomHttpsRequestImpl,
  type WecomWebSocketEvent,
  type WecomWebSocketLike,
  type WecomWebSocketListener,
} from './types.js';

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_CONTROL_PAYLOAD = 125;

type SocketEventType = 'open' | 'message' | 'error' | 'close';

export interface PinnedWebSocketOptions {
  readonly signal?: AbortSignal | undefined;
  readonly maxFrameBytes?: number | undefined;
  readonly requestImpl?: WecomHttpsRequestImpl | undefined;
}

function buildPinnedLookup(validated: ValidatedOfficialApiEndpoint): LookupFunction {
  const addresses = validated.addresses;
  return (_hostname, options, callback) => {
    const requestedFamily = typeof options === 'number' ? options : options?.family;
    const filtered = requestedFamily === 4 || requestedFamily === 6
      ? addresses.filter(entry => entry.family === requestedFamily)
      : addresses;
    if (filtered.length === 0) {
      const err = Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      callback(err, '', 4);
      return;
    }
    if (typeof options === 'object' && options?.all) {
      callback(null, filtered.map(entry => ({ address: entry.address, family: entry.family })));
    } else {
      callback(null, filtered[0]!.address, filtered[0]!.family);
    }
  };
}

export function encodeClientWsFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  const maskKey = randomBytes(4);
  let headerLen = 2;
  if (length >= 126 && length <= 65_535) {
    headerLen += 2;
  } else if (length > 65_535) {
    headerLen += 8;
  }

  const frame = Buffer.allocUnsafe(headerLen + 4 + length);
  frame[0] = 0x80 | (opcode & 0x0f);
  if (length < 126) {
    frame[1] = 0x80 | length;
  } else if (length <= 65_535) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
  }

  maskKey.copy(frame, headerLen);
  const dataOffset = headerLen + 4;
  for (let i = 0; i < length; i++) {
    frame[dataOffset + i] = payload[i]! ^ maskKey[i & 3]!;
  }
  return frame;
}

function buildClosePayload(code: number, reason: string): Buffer {
  const reasonBuf = reason ? Buffer.from(reason, 'utf8').subarray(0, MAX_CONTROL_PAYLOAD - 2) : Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(2 + reasonBuf.length);
  buf.writeUInt16BE(code, 0);
  reasonBuf.copy(buf, 2);
  return buf;
}

function verifyAcceptHeader(expected: string, actualHeader: string | string[] | undefined): boolean {
  if (typeof actualHeader !== 'string') return false;
  const expectedBuf = Buffer.from(expected, 'ascii');
  const actualBuf = Buffer.from(actualHeader.trim(), 'ascii');
  return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Zero-dependency RFC 6455 TLS WebSocket client that dials ONLY the already-validated
 * public IP addresses returned by validateOfficialApiEndpoint (preventing DNS rebinding),
 * while preserving original hostname Host header, TLS SNI, and strict certificate checks.
 */
export class PinnedWebSocket implements WecomWebSocketLike {
  readyState: number = WS_CONNECTING;

  private readonly maxFrameBytes: number;
  private readonly listeners: Record<SocketEventType, Set<WecomWebSocketListener>> = {
    open: new Set(),
    message: new Set(),
    error: new Set(),
    close: new Set(),
  };

  private request: ClientRequest | null = null;
  private socket: Duplex | null = null;
  private closeSent = false;
  private closedEmitted = false;
  private closeCode = 1006;
  private closeReason = '';

  private buffer: Buffer = Buffer.alloc(0);
  private fragmentOpcode: number | null = null;
  private fragmentChunks: Buffer[] = [];
  private fragmentTotalBytes = 0;

  private readonly signal: AbortSignal | undefined;
  private readonly onSignalAbort: (() => void) | undefined;

  constructor(validated: ValidatedOfficialApiEndpoint, options: PinnedWebSocketOptions = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? WECOM_MAX_INBOUND_FRAME_BYTES;
    this.signal = options.signal;

    if (this.signal?.aborted) {
      this.finishClosed(1006, 'aborted', new Blocked('WECOM_WS_CLOSED'));
      return;
    }

    if (this.signal) {
      this.onSignalAbort = () => {
        this.abortConnection('connect_aborted');
      };
      this.signal.addEventListener('abort', this.onSignalAbort, { once: true });
    }

    const wsKey = randomBytes(16).toString('base64');
    const expectedAccept = createHash('sha1').update(`${wsKey}${WS_GUID}`).digest('base64');
    const requestImpl = options.requestImpl ?? https.request;
    const isLiteralIp = isIP(validated.hostname) !== 0;
    const hostHeader = isLiteralIp && isIP(validated.hostname) === 6
      ? `[${validated.hostname}]`
      : validated.hostname;

    const req = requestImpl({
      protocol: 'https:',
      hostname: validated.hostname,
      port: validated.port,
      path: validated.url.pathname || '/',
      method: 'GET',
      agent: false,
      lookup: buildPinnedLookup(validated),
      rejectUnauthorized: true,
      ...(isLiteralIp ? {} : { servername: validated.hostname }),
      headers: {
        Host: hostHeader,
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': wsKey,
        'Sec-WebSocket-Version': '13',
      },
    });
    this.request = req;

    req.on('response', (res: IncomingMessage) => {
      res.resume();
      this.failAndClose(1002, 'upgrade_rejected', new Blocked('WECOM_WS_CONNECT_FAILED'));
    });

    req.on('upgrade', (res: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.request = null;
      this.detachAbortListener();
      if (this.closedEmitted || this.readyState !== WS_CONNECTING) {
        socket.destroy();
        return;
      }

      const upgrade = typeof res.headers.upgrade === 'string' ? res.headers.upgrade.toLowerCase() : '';
      const connection = typeof res.headers.connection === 'string' ? res.headers.connection.toLowerCase() : '';
      const validUpgrade = res.statusCode === 101
        && upgrade === 'websocket'
        && connection.split(',').some(part => part.trim() === 'upgrade')
        && verifyAcceptHeader(expectedAccept, res.headers['sec-websocket-accept']);

      if (!validUpgrade) {
        socket.destroy();
        this.failAndClose(1002, 'invalid_handshake', new Blocked('WECOM_WS_CONNECT_FAILED'));
        return;
      }

      this.socket = socket;
      this.readyState = WS_OPEN;
      this.attachSocketListeners(socket);
      this.emit('open', {});

      if (head && head.length > 0 && this.readyState === WS_OPEN) {
        this.onSocketData(head);
      }
    });

    req.on('error', () => {
      if (this.closedEmitted) return;
      this.failAndClose(1006, 'connect_error', new Blocked('WECOM_WS_CONNECT_FAILED'));
    });

    req.end();
  }

  addEventListener(type: SocketEventType, listener: WecomWebSocketListener): void {
    this.listeners[type].add(listener);
  }

  removeEventListener(type: SocketEventType, listener: WecomWebSocketListener): void {
    this.listeners[type].delete(listener);
  }

  send(data: string): void {
    if (this.readyState !== WS_OPEN || !this.socket || this.socket.destroyed) {
      throw new Blocked('WECOM_WS_NOT_CONNECTED');
    }
    const payload = Buffer.from(data, 'utf8');
    this.socket.write(encodeClientWsFrame(OPCODE_TEXT, payload));
  }

  close(code = 1000, reason = ''): void {
    if (this.closedEmitted || this.readyState === WS_CLOSED) return;
    if (this.readyState === WS_CONNECTING) {
      this.abortConnection(reason || 'client_close');
      return;
    }
    this.readyState = WS_CLOSING;
    this.closeCode = code;
    this.closeReason = reason;
    if (!this.closeSent && this.socket && !this.socket.destroyed) {
      this.closeSent = true;
      try {
        this.socket.write(encodeClientWsFrame(OPCODE_CLOSE, buildClosePayload(code, reason)));
      } catch {
        // Proceed to destroy below.
      }
    }
    this.socket?.end();
    this.socket?.destroy();
    this.finishClosed(code, reason);
  }

  private attachSocketListeners(socket: Duplex): void {
    socket.on('data', (chunk: Buffer) => this.onSocketData(chunk));
    socket.on('error', () => {
      if (this.closedEmitted) return;
      this.emit('error', { error: new Blocked('WECOM_WS_SOCKET_ERROR') });
    });
    socket.on('close', () => {
      this.finishClosed(this.closeCode, this.closeReason);
    });
  }

  private onSocketData(chunk: Buffer): void {
    if (this.closedEmitted || this.readyState === WS_CLOSED) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 2 && this.readyState === WS_OPEN) {
      const first = this.buffer[0]!;
      const second = this.buffer[1]!;
      const fin = (first & 0x80) !== 0;
      const rsv = first & 0x70;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;

      if (rsv !== 0 || masked) {
        this.protocolClose(1002, 'protocol_error');
        return;
      }

      let offset = 2;
      let payloadLen = second & 0x7f;
      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        const bigLen = this.buffer.readBigUInt64BE(2);
        if (bigLen > BigInt(this.maxFrameBytes)) {
          this.protocolClose(1009, 'frame_too_large', new Blocked('WECOM_WS_FRAME_TOO_LARGE'));
          return;
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }

      if (payloadLen > this.maxFrameBytes) {
        this.protocolClose(1009, 'frame_too_large', new Blocked('WECOM_WS_FRAME_TOO_LARGE'));
        return;
      }

      const isControl = (opcode & 0x08) !== 0;
      if (isControl && (!fin || payloadLen > MAX_CONTROL_PAYLOAD)) {
        this.protocolClose(1002, 'invalid_control_frame');
        return;
      }

      if (this.buffer.length < offset + payloadLen) {
        return;
      }

      const payload = this.buffer.subarray(offset, offset + payloadLen);
      this.buffer = this.buffer.subarray(offset + payloadLen);

      if (isControl) {
        this.handleControlFrame(opcode, payload);
      } else {
        this.handleDataFrame(opcode, fin, payload);
      }
    }
  }

  private handleControlFrame(opcode: number, payload: Buffer): void {
    if (opcode === OPCODE_PING) {
      if (this.readyState === WS_OPEN && this.socket && !this.socket.destroyed) {
        this.socket.write(encodeClientWsFrame(OPCODE_PONG, Buffer.from(payload)));
      }
      return;
    }
    if (opcode === OPCODE_PONG) {
      return;
    }
    if (opcode === OPCODE_CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
      this.closeCode = code;
      this.closeReason = reason;
      if (!this.closeSent && this.socket && !this.socket.destroyed) {
        this.closeSent = true;
        try {
          this.socket.write(encodeClientWsFrame(OPCODE_CLOSE, buildClosePayload(code, '')));
        } catch {
          // Ignore write errors during peer-initiated close.
        }
      }
      this.socket?.destroy();
      this.finishClosed(code, reason);
      return;
    }
    this.protocolClose(1002, 'unknown_control_opcode');
  }

  private handleDataFrame(opcode: number, fin: boolean, payload: Buffer): void {
    if (opcode === OPCODE_TEXT || opcode === OPCODE_BINARY) {
      if (this.fragmentOpcode !== null) {
        this.protocolClose(1002, 'interleaved_data_frame');
        return;
      }
      if (fin) {
        this.dispatchMessage(opcode, payload);
        return;
      }
      this.fragmentOpcode = opcode;
      this.fragmentChunks = [Buffer.from(payload)];
      this.fragmentTotalBytes = payload.length;
      return;
    }

    if (opcode === OPCODE_CONTINUATION) {
      if (this.fragmentOpcode === null) {
        this.protocolClose(1002, 'unexpected_continuation');
        return;
      }
      this.fragmentTotalBytes += payload.length;
      if (this.fragmentTotalBytes > this.maxFrameBytes) {
        this.protocolClose(1009, 'frame_too_large', new Blocked('WECOM_WS_FRAME_TOO_LARGE'));
        return;
      }
      this.fragmentChunks.push(Buffer.from(payload));
      if (fin) {
        const merged = Buffer.concat(this.fragmentChunks, this.fragmentTotalBytes);
        const completedOpcode = this.fragmentOpcode;
        this.fragmentOpcode = null;
        this.fragmentChunks = [];
        this.fragmentTotalBytes = 0;
        this.dispatchMessage(completedOpcode, merged);
      }
      return;
    }

    this.protocolClose(1002, 'unknown_data_opcode');
  }

  private dispatchMessage(opcode: number, payload: Buffer): void {
    const data = opcode === OPCODE_TEXT ? payload.toString('utf8') : Buffer.from(payload);
    this.emit('message', { data });
  }

  private protocolClose(code: number, reason: string, error?: Error): void {
    if (error) {
      this.emit('error', { error });
    }
    this.close(code, reason);
  }

  private abortConnection(reason: string): void {
    this.detachAbortListener();
    const req = this.request;
    this.request = null;
    req?.destroy();
    this.socket?.destroy();
    this.finishClosed(1006, reason);
  }

  private failAndClose(code: number, reason: string, error: Error): void {
    this.detachAbortListener();
    const req = this.request;
    this.request = null;
    req?.destroy();
    this.socket?.destroy();
    this.finishClosed(code, reason, error);
  }

  private finishClosed(code: number, reason: string, error?: Error): void {
    if (this.closedEmitted) return;
    this.closedEmitted = true;
    this.readyState = WS_CLOSED;
    this.detachAbortListener();
    this.buffer = Buffer.alloc(0);
    this.fragmentOpcode = null;
    this.fragmentChunks = [];
    this.fragmentTotalBytes = 0;
    this.socket = null;
    this.request = null;
    if (error) {
      this.emit('error', { error });
    }
    this.emit('close', { code, reason });
  }

  private detachAbortListener(): void {
    if (this.signal && this.onSignalAbort) {
      this.signal.removeEventListener('abort', this.onSignalAbort);
    }
  }

  private emit(type: SocketEventType, event: WecomWebSocketEvent): void {
    for (const listener of [...this.listeners[type]]) {
      listener(event);
    }
  }
}

export function createPinnedWebSocket(
  validated: ValidatedOfficialApiEndpoint,
  options?: PinnedWebSocketOptions,
): WecomWebSocketLike {
  return new PinnedWebSocket(validated, options);
}
