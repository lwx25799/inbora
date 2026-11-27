import { randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { inspect } from 'node:util';
import { Blocked } from '../../core/contracts.js';
import type { ValidatedOfficialApiEndpoint } from '../official-api-base.js';
import { WecomOutboundAckQueue } from './ack-queue.js';
import {
  buildActiveSendFrame,
  buildStreamReplyFrame,
  decodeWecomWsMessageData,
  decodeWecomWsMessageDataSync,
  parseWecomWsFrame,
  raceWithAbort,
  resolveWecomWsConfig,
  validateWecomWsEndpoint,
  type ResolvedWecomWsConfig,
} from './frame-guard.js';
import { createPinnedWebSocket } from './pinned-ws.js';
import {
  WECOM_MAX_INBOUND_FRAME_BYTES,
  WsCmd,
  type WecomActiveSendParams,
  type WecomDnsLookup,
  type WecomHttpsRequestImpl,
  type WecomInboundEventBody,
  type WecomInboundMessageBody,
  type WecomSendReplyParams,
  type WecomSendReplyResult,
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
const MAX_PENDING_PING_IDS = 8;

// Keep secret accessors off instance properties so serialization/inspection never leaks credentials.
const secretVault = new WeakMap<WecomWsClient, () => string>();

export class WecomWsClient {
  readonly botId: string;
  readonly endpointDigest: string;

  private readonly config: Omit<ResolvedWecomWsConfig, 'readSecret'>;
  private readonly customWebSocketFactory: WecomWebSocketFactory | undefined;
  private readonly httpsRequestImpl: WecomHttpsRequestImpl | undefined;
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
  private activeConnectAbort: AbortController | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
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
    const resolved = resolveWecomWsConfig(options);
    const { readSecret, ...safeConfig } = resolved;
    this.config = safeConfig;
    this.botId = safeConfig.botId;
    this.endpointDigest = safeConfig.endpointDigest;
    this.customWebSocketFactory = options.webSocketFactory;
    this.httpsRequestImpl = options.httpsRequest;
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
      this.config.ackTimeoutMs,
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

  connect(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new Blocked('WECOM_WS_CLOSED'));
    }
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
    return this.startTrackedConnection(signal);
  }

  disconnect(): void {
    this.manuallyClosed = true;
    this.connectPromise = null;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.clearConnectTimer();
    this.clearAuthTimer();
    this.connectionGen++;
    const rejectAuth = this.authReject;
    this.authResolve = null;
    this.authReject = null;
    this.authReqId = null;
    this.authenticated = false;
    this.pendingPingIds.clear();
    this.outboundQueue.failAllOnDisconnect();
    // Detach socket listeners before aborting/closing so synchronous close events cannot race.
    this.teardownSocket(true);
    const connectAbort = this.activeConnectAbort;
    this.activeConnectAbort = null;
    connectAbort?.abort(new Blocked('WECOM_WS_CLOSED'));
    this.setState('DISCONNECTED');
    rejectAuth?.(new Blocked('WECOM_WS_CLOSED'));
  }

  /**
   * Send a single non-retried final stream reply bound to an inbound req_id.
   * Never splits messages and never retries after timeout, disconnect, or unknown errors.
   */
  sendReplyOnce(params: WecomSendReplyParams): Promise<WecomSendReplyResult> {
    try {
      const built = buildStreamReplyFrame(params, this.config.maxReplyBytes);
      return this.outboundQueue.enqueue(built.reqId, built.streamId, built.payload, params.signal);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Blocked('WECOM_WS_FRAME_INVALID'));
    }
  }

  /**
   * Send a single non-retried proactive message (aibot_send_msg).
   * Never retries after timeout, disconnect, or unknown errors.
   */
  sendActiveMessageOnce(params: WecomActiveSendParams): Promise<WecomSendReplyResult> {
    try {
      const built = buildActiveSendFrame(params, this.config.maxReplyBytes);
      return this.outboundQueue.enqueue(built.reqId, built.streamId, built.payload, params.signal);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Blocked('WECOM_WS_FRAME_INVALID'));
    }
  }

  private startTrackedConnection(externalSignal?: AbortSignal): Promise<void> {
    let tracked!: Promise<void>;
    tracked = this.openConnection(externalSignal).finally(() => {
      if (this.connectPromise === tracked) {
        this.connectPromise = null;
      }
    });
    this.connectPromise = tracked;
    return tracked;
  }

  private async openConnection(externalSignal?: AbortSignal): Promise<void> {
    const gen = ++this.connectionGen;
    this.authenticated = false;
    this.authHandledOnCurrentSocket = false;
    this.authReqId = null;
    this.clearAuthTimer();
    this.clearConnectTimer();
    this.stopHeartbeat();
    this.teardownSocket(true);

    // Abort any superseded in-flight upgrade/DNS attempt before starting a new one.
    const previousAbort = this.activeConnectAbort;
    this.activeConnectAbort = null;
    previousAbort?.abort(new Blocked('WECOM_WS_SUPERSEDED'));

    this.setState('CONNECTING');

    const connectAbort = new AbortController();
    this.activeConnectAbort = connectAbort;

    const onExternalAbort = () => {
      // Advance generation and detach listeners BEFORE aborting the underlying socket.
      if (gen === this.connectionGen && !this.authenticated) {
        this.abortPendingConnect(gen, 'WECOM_WS_CLOSED', false);
      }
      connectAbort.abort(new Blocked('WECOM_WS_CLOSED'));
    };
    if (externalSignal) {
      if (externalSignal.aborted) {
        this.activeConnectAbort = null;
        throw new Blocked('WECOM_WS_CLOSED');
      }
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    // Overall handshake deadline spanning DNS resolution + TLS/WS upgrade + subscribe auth.
    this.connectTimer = setTimeout(() => {
      if (gen !== this.connectionGen || this.authenticated || this.manuallyClosed) return;
      if (this.authReqId !== null) {
        this.handleAuthFailure(gen, 'WECOM_WS_AUTH_TIMEOUT', false);
        connectAbort.abort(new Blocked('WECOM_WS_AUTH_TIMEOUT'));
      } else {
        this.abortPendingConnect(gen, 'WECOM_WS_CONNECT_TIMEOUT', true);
        connectAbort.abort(new Blocked('WECOM_WS_CONNECT_TIMEOUT'));
      }
    }, this.config.connectTimeoutMs);

    try {
      let validated: ValidatedOfficialApiEndpoint | undefined;
      if (!this.customWebSocketFactory || this.dnsLookupFn) {
        try {
          validated = await raceWithAbort(
            validateWecomWsEndpoint(this.config.wsUrl, this.dnsLookupFn ?? dnsLookup),
            connectAbort.signal,
          );
        } catch (error) {
          if (connectAbort.signal.aborted && connectAbort.signal.reason instanceof Blocked) {
            throw connectAbort.signal.reason;
          }
          if (gen !== this.connectionGen || this.manuallyClosed || externalSignal?.aborted) {
            throw new Blocked('WECOM_WS_CLOSED');
          }
          const safeErr = error instanceof Blocked ? error : new Blocked('WECOM_WS_ENDPOINT_SSRF_BLOCKED');
          this.lastErrorCode = safeErr.code;
          this.clearConnectTimer();
          if (safeErr.code === 'WECOM_WS_DNS_FAILED' || safeErr.code === 'WECOM_WS_CONNECT_TIMEOUT') {
            this.emitError(safeErr);
            this.scheduleReconnect('disconnect');
          } else {
            // Terminal policy / private-IP SSRF rejection: never reconnect.
            this.authFailureExhausted = true;
            this.setState('ERROR');
            this.emitError(safeErr);
          }
          throw safeErr;
        }
      }

      if (gen !== this.connectionGen || this.manuallyClosed || connectAbort.signal.aborted) {
        throw new Blocked('WECOM_WS_CLOSED');
      }

      await new Promise<void>((resolve, reject) => {
        let socket: WecomWebSocketLike;
        try {
          socket = this.customWebSocketFactory
            ? this.customWebSocketFactory(this.config.wsUrl, connectAbort.signal)
            : createPinnedWebSocket(validated!, {
                signal: connectAbort.signal,
                maxFrameBytes: WECOM_MAX_INBOUND_FRAME_BYTES,
                requestImpl: this.httpsRequestImpl,
              });
        } catch {
          const err = new Blocked('WECOM_WS_CONNECT_FAILED');
          this.lastErrorCode = err.code;
          this.clearConnectTimer();
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
          this.handleRawMessage(event.data, gen);
        };

        const onError = (event: WecomWebSocketEvent) => {
          if (gen !== this.connectionGen || this.manuallyClosed) return;
          const safeErr = event.error instanceof Blocked ? event.error : new Blocked('WECOM_WS_SOCKET_ERROR');
          this.lastErrorCode = safeErr.code;
          this.emitError(safeErr);
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
    } finally {
      externalSignal?.removeEventListener('abort', onExternalAbort);
      if (this.activeConnectAbort === connectAbort) {
        this.activeConnectAbort = null;
      }
      if (gen === this.connectionGen) {
        this.clearConnectTimer();
      }
    }
  }

  private abortPendingConnect(gen: number, code: string, shouldReconnect: boolean): void {
    if (gen !== this.connectionGen || this.authenticated) return;
    this.connectionGen++;
    this.clearConnectTimer();
    this.clearAuthTimer();
    this.authReqId = null;
    this.teardownSocket(true);
    const err = new Blocked(code);
    this.lastErrorCode = code;
    const reject = this.authReject;
    this.authResolve = null;
    this.authReject = null;
    if (shouldReconnect && !this.manuallyClosed) {
      this.emitError(err);
      this.scheduleReconnect('disconnect');
    } else if (!this.manuallyClosed) {
      this.setState('DISCONNECTED');
    }
    reject?.(err);
  }

  private sendSubscribeAuth(gen: number): void {
    if (gen !== this.connectionGen || !this.ws) return;
    const readSecret = secretVault.get(this);
    let secret = '';
    try {
      secret = readSecret?.() ?? '';
    } catch {
      this.handleAuthFailure(gen, 'WECOM_WS_CREDENTIAL_REQUIRED', true);
      return;
    }
    if (typeof secret !== 'string' || !secret.trim()) {
      this.handleAuthFailure(gen, 'WECOM_WS_CREDENTIAL_REQUIRED', true);
      return;
    }

    const reqId = `aibot_subscribe_${randomUUID()}`;
    this.authReqId = reqId;
    this.clearAuthTimer();
    this.authTimer = setTimeout(() => {
      if (gen !== this.connectionGen || this.authenticated) return;
      this.handleAuthFailure(gen, 'WECOM_WS_AUTH_TIMEOUT', false);
    }, this.config.ackTimeoutMs);

    const frame: WecomWsFrame<{ bot_id: string; secret: string }> = {
      cmd: WsCmd.SUBSCRIBE,
      headers: { req_id: reqId },
      body: { bot_id: this.botId, secret },
    };
    try {
      this.ws.send(JSON.stringify(frame));
    } catch {
      this.handleAuthFailure(gen, 'WECOM_WS_AUTH_SEND_FAILED', false);
    }
  }

  private handleRawMessage(data: unknown, gen: number): void {
    try {
      const syncRaw = decodeWecomWsMessageDataSync(data);
      if (syncRaw === null) return;
      if (syncRaw !== undefined) {
        // Synchronous decode & dispatch prevents same-packet [TEXT(ACK)][CLOSE] races.
        this.dispatchDecodedFrame(syncRaw, gen);
        return;
      }
    } catch (error) {
      this.reportFrameError(gen, error);
      return;
    }

    void decodeWecomWsMessageData(data).then(
      raw => {
        if (gen !== this.connectionGen || raw === null) return;
        this.dispatchDecodedFrame(raw, gen);
      },
      error => {
        this.reportFrameError(gen, error);
      },
    );
  }

  private dispatchDecodedFrame(raw: string, gen: number): void {
    if (gen !== this.connectionGen) return;
    try {
      const frame = parseWecomWsFrame(raw);

      if (frame.cmd === WsCmd.CALLBACK) {
        if (!this.authenticated) {
          this.outboundQueue.recordIgnoredFrame();
          return;
        }
        this.invokeCallback(gen, () => this.options.onMessage?.(frame as WecomWsFrame<WecomInboundMessageBody>));
        return;
      }
      if (frame.cmd === WsCmd.EVENT_CALLBACK) {
        if (!this.authenticated) {
          this.outboundQueue.recordIgnoredFrame();
          return;
        }
        this.invokeCallback(gen, () => this.options.onEvent?.(frame as WecomWsFrame<WecomInboundEventBody>));
        return;
      }

      // Unified strict ACK gate across auth, heartbeat, and outbound reply acknowledgements.
      if (frame.cmd === undefined && typeof frame.errcode === 'number') {
        const reqId = frame.headers.req_id;
        if (this.authReqId && reqId === this.authReqId) {
          this.handleAuthAck(frame, gen);
          return;
        }
        if (this.authenticated && this.pendingPingIds.has(reqId)) {
          this.handlePongAck(frame, reqId);
          return;
        }
        if (this.authenticated) {
          this.outboundQueue.handleAck(frame, gen);
          return;
        }
      }
      this.outboundQueue.recordIgnoredFrame();
    } catch (error) {
      this.reportFrameError(gen, error);
    }
  }

  private invokeCallback(gen: number, fn: () => unknown): void {
    try {
      const result = fn();
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        void (result as PromiseLike<unknown>).then(undefined, error => {
          this.reportFrameError(gen, error);
        });
      }
    } catch (error) {
      this.reportFrameError(gen, error);
    }
  }

  private reportFrameError(gen: number, error: unknown): void {
    if (gen !== this.connectionGen) return;
    const safeErr = error instanceof Blocked ? error : new Blocked('WECOM_WS_FRAME_INVALID');
    this.lastErrorCode = safeErr.code;
    this.emitError(safeErr);
  }

  private handleAuthAck(frame: WecomWsFrame, gen: number): void {
    if (gen !== this.connectionGen || this.authenticated) return;
    this.clearAuthTimer();
    this.clearConnectTimer();
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
    this.clearConnectTimer();
    this.authReqId = null;
    this.authenticated = false;
    this.consecutiveAuthFailures++;

    const exhausted = immediateFatal || this.consecutiveAuthFailures >= this.config.maxAuthFailureAttempts;
    const errorCode = immediateFatal
      ? code
      : exhausted
        ? 'WS_AUTH_FAILURE_EXHAUSTED'
        : code;
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
      if (this.missedPongCount >= this.config.missedPongThreshold) {
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
    }, this.config.heartbeatIntervalMs);
  }

  private handlePongAck(frame: WecomWsFrame, reqId: string): void {
    this.pendingPingIds.delete(reqId);
    if (frame.errcode === 0) {
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

    // Closing while waiting for subscribe ACK counts toward consecutive auth failures.
    if (!this.manuallyClosed && !this.authenticated && this.authReqId !== null && !this.authHandledOnCurrentSocket) {
      this.options.onDisconnected?.({ code, manual: false });
      this.handleAuthFailure(gen, 'WECOM_WS_AUTH_DISCONNECTED', false);
      return;
    }

    this.connectionGen++;
    this.stopHeartbeat();
    this.clearAuthTimer();
    this.clearConnectTimer();
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
    if (reason === 'auth_failure' && this.consecutiveAuthFailures >= this.config.maxAuthFailureAttempts) {
      this.authFailureExhausted = true;
      this.lastErrorCode = 'WS_AUTH_FAILURE_EXHAUSTED';
      this.setState('ERROR');
      return;
    }
    // Enforce global reconnect budget across both regular disconnects and auth retries.
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.lastErrorCode = 'WECOM_WS_RECONNECT_EXHAUSTED';
      this.setState('ERROR');
      this.emitError(new Blocked('WECOM_WS_RECONNECT_EXHAUSTED'));
      return;
    }

    this.reconnectAttempts++;
    const attempt = reason === 'auth_failure' ? this.consecutiveAuthFailures : this.reconnectAttempts;
    const delayMs = Math.min(
      this.config.reconnectBaseDelayMs * (2 ** Math.max(0, attempt - 1)),
      this.config.reconnectMaxDelayMs,
    );
    this.setState('DEGRADED');
    this.options.onReconnecting?.({ attempt, delayMs, reason });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.manuallyClosed || this.authFailureExhausted || this.connectPromise) return;
      void this.startTrackedConnection().catch(() => {
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

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
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
    try {
      this.options.onStateChange?.(next);
    } catch {
      // Isolate user listener errors from connection state transitions.
    }
  }

  private emitError(error: Error): void {
    try {
      this.options.onError?.(error);
    } catch {
      // Isolate throwing onError handlers so internal state/reconnect logic never breaks.
    }
  }
}
