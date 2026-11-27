import { randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { inspect } from 'node:util';
import { Blocked } from '../../core/contracts.js';
import { WecomOutboundAckQueue } from './ack-queue.js';
import { computeWecomEndpointDigest } from './crypto.js';
import {
  assertSafeWecomWsUrlSyntax,
  decodeWecomWsMessageData,
  parseWecomWsFrame,
  requirePositiveInt,
  validateWecomWsEndpoint,
} from './frame-guard.js';
import {
  WECOM_AIBOT_DEFAULT_WS_URL,
  WECOM_REPLY_MAX_UTF8_BYTES,
  WsCmd,
  type WecomActiveSendBody,
  type WecomActiveSendParams,
  type WecomDnsLookup,
  type WecomInboundEventBody,
  type WecomInboundMessageBody,
  type WecomSendReplyParams,
  type WecomSendReplyResult,
  type WecomStreamReplyBody,
  type WecomWebSocketEvent,
  type WecomWebSocketFactory,
  type WecomWebSocketLike,
  type WecomWsClientOptions,
  type WecomWsClientStatus,
  type WecomWsConnectionState,
  type WecomWsFrame,
} from './types.js';

export { assertSafeWecomWsUrlSyntax, validateWecomWsEndpoint } from './frame-guard.js';

const WS_OPEN = 1;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_MISSED_PONG_THRESHOLD = 2;
const DEFAULT_ACK_TIMEOUT_MS = 15_000;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;
const DEFAULT_MAX_AUTH_FAILURE_ATTEMPTS = 3;
const MAX_PENDING_PING_IDS = 8;

// Keep secret accessors off instance properties so serialization/inspection never leaks credentials.
const secretVault = new WeakMap<WecomWsClient, () => string>();

function createNativeWebSocket(url: string): WecomWebSocketLike {
  const Ctor = globalThis.WebSocket;
  if (typeof Ctor !== 'function') {
    throw new Blocked('WECOM_WS_RUNTIME_UNSUPPORTED');
  }
  return new Ctor(url) as unknown as WecomWebSocketLike;
}

export class WecomWsClient {
  readonly botId: string;
  readonly endpointDigest: string;

  private readonly wsUrl: string;
  private readonly heartbeatIntervalMs: number;
  private readonly missedPongThreshold: number;
  private readonly ackTimeoutMs: number;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly maxAuthFailureAttempts: number;
  private readonly maxReplyBytes: number;
  private readonly webSocketFactory: WecomWebSocketFactory;
  private readonly usesCustomFactory: boolean;
  private readonly dnsLookupFn: WecomDnsLookup | undefined;
  private readonly now: () => number;
  private readonly options: WecomWsClientOptions;
  private readonly outboundQueue: WecomOutboundAckQueue;

  private ws: WecomWebSocketLike | null = null;
  private wsCleanup: (() => void) | null = null;
  private state: WecomWsConnectionState = 'DISCONNECTED';
  private authenticated = false;
  private manuallyClosed = false;
  private authFailureExhausted = false;
  private connectionGen = 0;

  private connectPromise: Promise<void> | null = null;
  private authReqId: string | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private authHandledOnCurrentSocket = false;
  private authResolve: (() => void) | null = null;
  private authReject: ((error: Error) => void) | null = null;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private missedPongCount = 0;
  private lastHeartbeatAt: number | null = null;
  private readonly pendingPingIds = new Set<string>();

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private consecutiveAuthFailures = 0;
  private lastErrorCode: string | null = null;

  constructor(options: WecomWsClientOptions) {
    const botId = typeof options.botId === 'string' ? options.botId.trim() : '';
    if (!botId) {
      throw new Blocked('WECOM_WS_CREDENTIAL_REQUIRED');
    }
    const readSecret = typeof options.secret === 'function'
      ? options.secret
      : () => options.secret as string;
    const initialSecret = readSecret();
    if (typeof initialSecret !== 'string' || !initialSecret.trim()) {
      throw new Blocked('WECOM_WS_CREDENTIAL_REQUIRED');
    }

    const wsUrl = options.wsUrl ?? WECOM_AIBOT_DEFAULT_WS_URL;
    assertSafeWecomWsUrlSyntax(wsUrl);

    this.botId = botId;
    this.wsUrl = wsUrl;
    this.endpointDigest = computeWecomEndpointDigest(wsUrl);
    this.heartbeatIntervalMs = requirePositiveInt(options.heartbeatIntervalMs, DEFAULT_HEARTBEAT_INTERVAL_MS);
    this.missedPongThreshold = requirePositiveInt(options.missedPongThreshold, DEFAULT_MISSED_PONG_THRESHOLD);
    this.ackTimeoutMs = requirePositiveInt(options.ackTimeoutMs, DEFAULT_ACK_TIMEOUT_MS);
    this.reconnectBaseDelayMs = requirePositiveInt(options.reconnectBaseDelayMs, DEFAULT_RECONNECT_BASE_DELAY_MS);
    this.reconnectMaxDelayMs = requirePositiveInt(options.reconnectMaxDelayMs, DEFAULT_RECONNECT_MAX_DELAY_MS);
    if (this.reconnectMaxDelayMs < this.reconnectBaseDelayMs) {
      throw new Blocked('WECOM_WS_CONFIG_INVALID');
    }
    this.maxReconnectAttempts = requirePositiveInt(options.maxReconnectAttempts, DEFAULT_MAX_RECONNECT_ATTEMPTS, 0);
    this.maxAuthFailureAttempts = requirePositiveInt(options.maxAuthFailureAttempts, DEFAULT_MAX_AUTH_FAILURE_ATTEMPTS, 1);
    this.maxReplyBytes = requirePositiveInt(options.maxReplyBytes, WECOM_REPLY_MAX_UTF8_BYTES);
    if (this.maxReplyBytes > WECOM_REPLY_MAX_UTF8_BYTES) {
      throw new Blocked('WECOM_WS_CONFIG_INVALID');
    }
    this.usesCustomFactory = typeof options.webSocketFactory === 'function';
    this.webSocketFactory = options.webSocketFactory ?? createNativeWebSocket;
    this.dnsLookupFn = options.dnsLookup;
    this.now = options.now ?? (() => Date.now());
    // Store callback hooks without retaining raw secret string on the instance.
    this.options = { ...options, secret: '' };
    secretVault.set(this, readSecret);

    const client = this;
    this.outboundQueue = new WecomOutboundAckQueue(
      {
        get isConnected() {
          return client.isConnected;
        },
        get connectionGen() {
          return client.connectionGen;
        },
        now: () => this.now(),
        transmit: payload => {
          if (!this.ws || this.ws.readyState !== WS_OPEN) {
            throw new Blocked('WECOM_WS_NOT_CONNECTED');
          }
          this.ws.send(payload);
        },
      },
      this.ackTimeoutMs,
    );
  }

  get isConnected(): boolean {
    return this.state === 'CONNECTED' && this.authenticated && this.ws?.readyState === WS_OPEN;
  }

  getStatus(): WecomWsClientStatus {
    return {
      state: this.state,
      authenticated: this.authenticated,
      endpointDigest: this.endpointDigest,
      lastHeartbeatAt: this.lastHeartbeatAt,
      reconnectAttempts: this.reconnectAttempts,
      consecutiveAuthFailures: this.consecutiveAuthFailures,
      pendingAckCount: this.outboundQueue.pendingCount,
      lateAckIgnoredCount: this.outboundQueue.lateAckIgnoredCount,
      errorCode: this.lastErrorCode,
    };
  }

  toJSON(): WecomWsClientStatus {
    return this.getStatus();
  }

  [inspect.custom](): WecomWsClientStatus {
    return this.getStatus();
  }

  connect(): Promise<void> {
    if (this.isConnected) {
      return Promise.resolve();
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.manuallyClosed = false;
    this.authFailureExhausted = false;
    this.reconnectAttempts = 0;
    this.consecutiveAuthFailures = 0;
    this.clearReconnectTimer();
    const attempt = this.openConnection();
    this.connectPromise = attempt.finally(() => {
      if (this.connectPromise === attempt) {
        this.connectPromise = null;
      }
    });
    return this.connectPromise;
  }

  disconnect(): void {
    this.manuallyClosed = true;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.clearAuthTimer();
    const rejectAuth = this.authReject;
    this.authResolve = null;
    this.authReject = null;
    this.authReqId = null;
    this.authenticated = false;
    this.connectionGen++;
    this.pendingPingIds.clear();
    this.outboundQueue.failAllOnDisconnect();
    this.teardownSocket(true);
    this.setState('DISCONNECTED');
    rejectAuth?.(new Blocked('WECOM_WS_CLOSED'));
  }

  /**
   * Send a single non-retried final stream reply bound to an inbound req_id.
   * Never splits messages and never retries after timeout, disconnect, or unknown errors.
   */
  sendReplyOnce(params: WecomSendReplyParams): Promise<WecomSendReplyResult> {
    const reqId = typeof params.reqId === 'string' ? params.reqId.trim() : '';
    if (!reqId) {
      return Promise.reject(new Blocked('WECOM_WS_REQ_ID_REQUIRED'));
    }
    const contentError = this.validateReplyContent(params.content);
    if (contentError) {
      return Promise.reject(contentError);
    }
    const streamId = params.streamId?.trim() || `stream_${randomUUID()}`;
    const frame: WecomWsFrame<WecomStreamReplyBody> = {
      cmd: WsCmd.RESPONSE,
      headers: { req_id: reqId },
      body: {
        msgtype: 'stream',
        stream: {
          id: streamId,
          finish: true,
          content: params.content,
        },
      },
    };
    return this.outboundQueue.enqueue(reqId, streamId, JSON.stringify(frame), params.signal);
  }

  /**
   * Send a single non-retried proactive message (aibot_send_msg).
   * Never retries after timeout, disconnect, or unknown errors.
   */
  sendActiveMessageOnce(params: WecomActiveSendParams): Promise<WecomSendReplyResult> {
    const chatId = typeof params.chatId === 'string' ? params.chatId.trim() : '';
    if (!chatId) {
      return Promise.reject(new Blocked('WECOM_WS_TARGET_REQUIRED'));
    }
    const contentError = this.validateReplyContent(params.content);
    if (contentError) {
      return Promise.reject(contentError);
    }
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
    return this.outboundQueue.enqueue(reqId, reqId, JSON.stringify(frame), params.signal);
  }

  private validateReplyContent(content: string): Blocked | null {
    if (typeof content !== 'string' || !content.trim()) {
      return new Blocked('WECOM_WS_REPLY_EMPTY');
    }
    if (Buffer.byteLength(content, 'utf8') > this.maxReplyBytes) {
      return new Blocked('WECOM_WS_REPLY_TOO_LONG');
    }
    return null;
  }

  private async openConnection(): Promise<void> {
    const gen = ++this.connectionGen;
    this.authenticated = false;
    this.authHandledOnCurrentSocket = false;
    this.authReqId = null;
    this.clearAuthTimer();
    this.stopHeartbeat();
    this.teardownSocket(false);
    this.setState('CONNECTING');

    if (!this.usesCustomFactory || this.dnsLookupFn) {
      try {
        await validateWecomWsEndpoint(this.wsUrl, this.dnsLookupFn ?? dnsLookup);
      } catch (error) {
        if (gen !== this.connectionGen || this.manuallyClosed) {
          throw new Blocked('WECOM_WS_CLOSED');
        }
        const safeErr = error instanceof Blocked ? error : new Blocked('WECOM_WS_ENDPOINT_SSRF_BLOCKED');
        this.lastErrorCode = safeErr.code;
        this.setState('ERROR');
        this.emitError(safeErr);
        throw safeErr;
      }
    }

    if (gen !== this.connectionGen || this.manuallyClosed) {
      throw new Blocked('WECOM_WS_CLOSED');
    }

    return new Promise<void>((resolve, reject) => {
      let socket: WecomWebSocketLike;
      try {
        socket = this.webSocketFactory(this.wsUrl);
      } catch {
        const err = new Blocked('WECOM_WS_CONNECT_FAILED');
        this.lastErrorCode = err.code;
        this.emitError(err);
        this.scheduleReconnect('disconnect');
        reject(err);
        return;
      }

      this.ws = socket;
      this.authResolve = resolve;
      this.authReject = reject;

      const onOpen = () => {
        if (gen !== this.connectionGen || this.manuallyClosed) return;
        this.sendSubscribeAuth(gen);
      };

      const onMessage = (event: WecomWebSocketEvent) => {
        if (gen !== this.connectionGen || this.manuallyClosed) return;
        void this.handleRawMessage(event.data, gen);
      };

      const onError = () => {
        if (gen !== this.connectionGen || this.manuallyClosed) return;
        this.lastErrorCode = 'WECOM_WS_SOCKET_ERROR';
        this.emitError(new Blocked('WECOM_WS_SOCKET_ERROR'));
      };

      const onClose = (event: WecomWebSocketEvent) => {
        if (gen !== this.connectionGen) return;
        const code = typeof event.code === 'number' ? event.code : 1006;
        this.handleSocketClose(gen, code);
      };

      socket.addEventListener('open', onOpen);
      socket.addEventListener('message', onMessage);
      socket.addEventListener('error', onError);
      socket.addEventListener('close', onClose);
      this.wsCleanup = () => {
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('message', onMessage);
        socket.removeEventListener('error', onError);
        socket.removeEventListener('close', onClose);
      };

      if (socket.readyState === WS_OPEN) {
        onOpen();
      }
    });
  }

  private sendSubscribeAuth(gen: number): void {
    if (gen !== this.connectionGen || !this.ws) return;
    const readSecret = secretVault.get(this);
    const secret = readSecret?.() ?? '';
    if (!secret.trim()) {
      this.handleAuthFailure(gen, 'WECOM_WS_CREDENTIAL_REQUIRED', true);
      return;
    }

    const reqId = `aibot_subscribe_${randomUUID()}`;
    this.authReqId = reqId;
    this.clearAuthTimer();
    this.authTimer = setTimeout(() => {
      if (gen !== this.connectionGen || this.authenticated) return;
      this.handleAuthFailure(gen, 'WECOM_WS_AUTH_TIMEOUT', false);
    }, this.ackTimeoutMs);

    const frame: WecomWsFrame<{ bot_id: string; secret: string }> = {
      cmd: WsCmd.SUBSCRIBE,
      headers: { req_id: reqId },
      body: {
        bot_id: this.botId,
        secret,
      },
    };
    try {
      this.ws.send(JSON.stringify(frame));
    } catch {
      this.handleAuthFailure(gen, 'WECOM_WS_AUTH_SEND_FAILED', false);
    }
  }

  private async handleRawMessage(data: unknown, gen: number): Promise<void> {
    let raw: string | null;
    try {
      raw = await decodeWecomWsMessageData(data);
    } catch (error) {
      if (gen !== this.connectionGen) return;
      const safeErr = error instanceof Blocked ? error : new Blocked('WECOM_WS_FRAME_INVALID');
      this.lastErrorCode = safeErr.code;
      this.emitError(safeErr);
      return;
    }
    if (gen !== this.connectionGen || raw === null) return;

    let frame: WecomWsFrame;
    try {
      frame = parseWecomWsFrame(raw);
    } catch (error) {
      const safeErr = error instanceof Blocked ? error : new Blocked('WECOM_WS_FRAME_INVALID');
      this.lastErrorCode = safeErr.code;
      this.emitError(safeErr);
      return;
    }

    if (frame.cmd === WsCmd.CALLBACK) {
      this.options.onMessage?.(frame as WecomWsFrame<WecomInboundMessageBody>);
      return;
    }
    if (frame.cmd === WsCmd.EVENT_CALLBACK) {
      this.options.onEvent?.(frame as WecomWsFrame<WecomInboundEventBody>);
      return;
    }

    const reqId = frame.headers.req_id;
    if (this.authReqId && reqId === this.authReqId) {
      this.handleAuthAck(frame, gen);
      return;
    }
    if (this.pendingPingIds.has(reqId)) {
      this.handlePongAck(frame, reqId);
      return;
    }
    this.outboundQueue.handleAck(frame, gen);
  }

  private handleAuthAck(frame: WecomWsFrame, gen: number): void {
    if (gen !== this.connectionGen || this.authenticated) return;
    this.clearAuthTimer();
    this.authReqId = null;

    if (frame.errcode === 0) {
      this.authenticated = true;
      this.reconnectAttempts = 0;
      this.consecutiveAuthFailures = 0;
      this.missedPongCount = 0;
      this.lastHeartbeatAt = this.now();
      this.lastErrorCode = null;
      this.outboundQueue.clearTainted();
      this.setState('CONNECTED');
      this.startHeartbeat(gen);
      const resolve = this.authResolve;
      this.authResolve = null;
      this.authReject = null;
      resolve?.();
      this.options.onAuthenticated?.();
      return;
    }

    this.handleAuthFailure(gen, 'WECOM_WS_AUTH_FAILED', false);
  }

  private handleAuthFailure(gen: number, code: string, immediateFatal: boolean): void {
    if (gen !== this.connectionGen || this.authHandledOnCurrentSocket) return;
    this.authHandledOnCurrentSocket = true;
    this.connectionGen++;
    this.clearAuthTimer();
    this.authReqId = null;
    this.authenticated = false;
    this.consecutiveAuthFailures++;

    const exhausted = immediateFatal || this.consecutiveAuthFailures >= this.maxAuthFailureAttempts;
    const errorCode = exhausted ? 'WS_AUTH_FAILURE_EXHAUSTED' : code;
    const err = new Blocked(errorCode);
    this.lastErrorCode = errorCode;

    const reject = this.authReject;
    this.authResolve = null;
    this.authReject = null;

    if (exhausted) {
      this.authFailureExhausted = true;
      this.clearReconnectTimer();
      this.setState('ERROR');
    } else {
      this.setState('DEGRADED');
    }

    this.teardownSocket(true);
    this.emitError(err);
    reject?.(err);

    if (!exhausted && !this.manuallyClosed) {
      this.scheduleReconnect('auth_failure');
    }
  }

  private startHeartbeat(gen: number): void {
    this.stopHeartbeat();
    this.missedPongCount = 0;
    this.pendingPingIds.clear();
    this.heartbeatTimer = setInterval(() => {
      if (gen !== this.connectionGen || !this.isConnected || !this.ws) {
        this.stopHeartbeat();
        return;
      }
      if (this.missedPongCount >= this.missedPongThreshold) {
        this.stopHeartbeat();
        this.lastErrorCode = 'WECOM_WS_HEARTBEAT_TIMEOUT';
        this.emitError(new Blocked('WECOM_WS_HEARTBEAT_TIMEOUT'));
        this.forceDeadSocketReconnect(gen);
        return;
      }
      const reqId = `ping_${randomUUID()}`;
      if (this.pendingPingIds.size >= MAX_PENDING_PING_IDS) {
        const oldest = this.pendingPingIds.values().next().value;
        if (oldest !== undefined) this.pendingPingIds.delete(oldest);
      }
      this.pendingPingIds.add(reqId);
      this.missedPongCount++;
      const pingFrame: WecomWsFrame = {
        cmd: WsCmd.HEARTBEAT,
        headers: { req_id: reqId },
      };
      try {
        this.ws.send(JSON.stringify(pingFrame));
      } catch {
        this.stopHeartbeat();
        this.forceDeadSocketReconnect(gen);
      }
    }, this.heartbeatIntervalMs);
  }

  private handlePongAck(frame: WecomWsFrame, reqId: string): void {
    this.pendingPingIds.delete(reqId);
    if (frame.errcode === undefined || frame.errcode === 0) {
      this.pendingPingIds.clear();
      this.missedPongCount = 0;
      this.lastHeartbeatAt = this.now();
    }
  }

  private forceDeadSocketReconnect(gen: number): void {
    if (gen !== this.connectionGen) return;
    const socket = this.ws;
    this.handleSocketClose(gen, 4000);
    try {
      socket?.close(4000, 'heartbeat_timeout');
    } catch {
      // Socket may already be closing or closed.
    }
  }

  private handleSocketClose(gen: number, code: number): void {
    if (gen !== this.connectionGen) return;
    this.connectionGen++;
    this.stopHeartbeat();
    this.clearAuthTimer();
    this.authenticated = false;
    this.authReqId = null;
    this.teardownSocket(false);
    this.pendingPingIds.clear();
    this.outboundQueue.failAllOnDisconnect();

    const rejectAuth = this.authReject;
    this.authResolve = null;
    this.authReject = null;

    this.options.onDisconnected?.({ code, manual: this.manuallyClosed });

    if (this.manuallyClosed) {
      this.setState('DISCONNECTED');
      rejectAuth?.(new Blocked('WECOM_WS_CLOSED'));
      return;
    }

    if (this.authFailureExhausted) {
      this.setState('ERROR');
      rejectAuth?.(new Blocked('WS_AUTH_FAILURE_EXHAUSTED'));
      return;
    }

    if (this.authHandledOnCurrentSocket) {
      return;
    }

    rejectAuth?.(new Blocked('WECOM_WS_DISCONNECTED'));
    this.scheduleReconnect('disconnect');
  }

  private scheduleReconnect(reason: 'disconnect' | 'auth_failure'): void {
    if (this.manuallyClosed || this.authFailureExhausted || this.reconnectTimer !== null) {
      return;
    }
    let attempt: number;
    if (reason === 'auth_failure') {
      if (this.consecutiveAuthFailures >= this.maxAuthFailureAttempts) {
        this.authFailureExhausted = true;
        this.lastErrorCode = 'WS_AUTH_FAILURE_EXHAUSTED';
        this.setState('ERROR');
        return;
      }
      attempt = this.consecutiveAuthFailures;
    } else {
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        this.lastErrorCode = 'WECOM_WS_RECONNECT_EXHAUSTED';
        this.setState('ERROR');
        this.emitError(new Blocked('WECOM_WS_RECONNECT_EXHAUSTED'));
        return;
      }
      this.reconnectAttempts++;
      attempt = this.reconnectAttempts;
    }

    const delayMs = Math.min(
      this.reconnectBaseDelayMs * (2 ** Math.max(0, attempt - 1)),
      this.reconnectMaxDelayMs,
    );
    this.setState('DEGRADED');
    this.options.onReconnecting?.({ attempt, delayMs, reason });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.manuallyClosed || this.authFailureExhausted) return;
      void this.openConnection().catch(() => {
        // Errors are already surfaced through onError and state transitions.
      });
    }, delayMs);
  }

  private teardownSocket(shouldClose: boolean): void {
    const cleanup = this.wsCleanup;
    const socket = this.ws;
    this.wsCleanup = null;
    this.ws = null;
    cleanup?.();
    if (shouldClose && socket) {
      try {
        socket.close(1000, 'client_close');
      } catch {
        // Ignore close errors on already-closed sockets.
      }
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearAuthTimer(): void {
    if (this.authTimer !== null) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setState(next: WecomWsConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.options.onStateChange?.(next);
  }

  private emitError(error: Error): void {
    this.options.onError?.(error);
  }
}
