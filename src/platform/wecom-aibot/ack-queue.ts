import { Blocked } from '../../core/contracts.js';
import type { WecomSendReplyResult, WecomWsFrame } from './types.js';

interface QueuedOutboundItem {
  reqId: string;
  streamId: string;
  payload: string;
  signal: AbortSignal | undefined;
  resolve: (result: WecomSendReplyResult) => void;
  reject: (error: Error) => void;
}

interface ActivePendingAck {
  reqId: string;
  seq: number;
  connectionGen: number;
  streamId: string;
  requestAt: string;
  timer: ReturnType<typeof setTimeout>;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
  settled: boolean;
  resolve: (result: WecomSendReplyResult) => void;
  reject: (error: Error) => void;
}

export interface OutboundQueueHost {
  readonly isConnected: boolean;
  readonly connectionGen: number;
  now(): number;
  transmit(payload: string): void;
}

/**
 * Per-req_id serial outbound queue with monotonic pendingAckSeq tracking.
 * Prevents timeout / late-ACK races and guarantees zero automatic resend after
 * timeout, disconnect, abort, or rejection.
 */
export class WecomOutboundAckQueue {
  private pendingAckSeq = 0;
  private lateAckIgnored = 0;
  private readonly queues = new Map<string, QueuedOutboundItem[]>();
  private readonly activeByReqId = new Map<string, ActivePendingAck>();
  private readonly taintedReqIds = new Set<string>();

  constructor(
    private readonly host: OutboundQueueHost,
    private readonly ackTimeoutMs: number,
  ) {}

  get pendingCount(): number {
    return this.activeByReqId.size;
  }

  get lateAckIgnoredCount(): number {
    return this.lateAckIgnored;
  }

  clearTainted(): void {
    this.taintedReqIds.clear();
  }

  recordIgnoredFrame(): void {
    this.lateAckIgnored++;
  }

  enqueue(
    reqId: string,
    streamId: string,
    payload: string,
    signal: AbortSignal | undefined,
  ): Promise<WecomSendReplyResult> {
    if (signal?.aborted) {
      return Promise.reject(new Blocked('WECOM_WS_SEND_ABORTED'));
    }
    if (!this.host.isConnected) {
      return Promise.reject(new Blocked('WECOM_WS_NOT_CONNECTED'));
    }
    if (this.taintedReqIds.has(reqId)) {
      return Promise.reject(new Blocked('WECOM_WS_SEND_UNCERTAIN'));
    }
    return new Promise<WecomSendReplyResult>((resolve, reject) => {
      const queue = this.queues.get(reqId) ?? [];
      queue.push({ reqId, streamId, payload, signal, resolve, reject });
      this.queues.set(reqId, queue);
      this.drain(reqId);
    });
  }

  handleAck(frame: WecomWsFrame, gen: number): void {
    if (frame.cmd !== undefined || typeof frame.errcode !== 'number') {
      this.lateAckIgnored++;
      return;
    }
    const reqId = frame.headers.req_id;
    const active = this.activeByReqId.get(reqId);
    if (!active || active.settled || active.connectionGen !== gen) {
      this.lateAckIgnored++;
      return;
    }
    const headerSeq = frame.headers['seq'];
    if (typeof headerSeq === 'number' && headerSeq !== active.seq) {
      this.lateAckIgnored++;
      return;
    }

    active.settled = true;
    clearTimeout(active.timer);
    if (active.signal && active.onAbort) {
      active.signal.removeEventListener('abort', active.onAbort);
    }
    this.activeByReqId.delete(reqId);

    if (frame.errcode === 0) {
      active.resolve({
        reqId,
        streamId: active.streamId,
        ackSeq: active.seq,
        requestAt: active.requestAt,
        responseAt: new Date(this.host.now()).toISOString(),
        errcode: 0,
      });
    } else {
      active.reject(new Blocked('WECOM_WS_REPLY_REJECTED'));
    }

    this.drain(reqId);
  }

  failAllOnDisconnect(): void {
    const activeEntries = [...this.activeByReqId.values()];
    this.activeByReqId.clear();
    for (const active of activeEntries) {
      if (active.settled) continue;
      active.settled = true;
      clearTimeout(active.timer);
      if (active.signal && active.onAbort) {
        active.signal.removeEventListener('abort', active.onAbort);
      }
      // In-flight outbound frames become UNCERTAIN on disconnect and are NEVER auto-retried.
      active.reject(new Blocked('WECOM_WS_SEND_UNCERTAIN'));
    }

    const queuedLists = [...this.queues.values()];
    this.queues.clear();
    for (const list of queuedLists) {
      for (const item of list) {
        item.reject(new Blocked('WECOM_WS_NOT_CONNECTED'));
      }
    }

    this.taintedReqIds.clear();
  }

  private drain(reqId: string): void {
    if (this.activeByReqId.has(reqId)) {
      return;
    }
    const queue = this.queues.get(reqId);
    if (!queue || queue.length === 0) {
      this.queues.delete(reqId);
      return;
    }

    while (queue.length > 0 && !this.activeByReqId.has(reqId)) {
      const item = queue.shift()!;
      if (queue.length === 0) {
        this.queues.delete(reqId);
      }

      if (item.signal?.aborted) {
        item.reject(new Blocked('WECOM_WS_SEND_ABORTED'));
        continue;
      }
      if (this.taintedReqIds.has(reqId)) {
        // A prior frame for this req_id timed out on this connection; any late ACK would be ambiguous.
        item.reject(new Blocked('WECOM_WS_SEND_UNCERTAIN'));
        continue;
      }
      if (!this.host.isConnected) {
        item.reject(new Blocked('WECOM_WS_NOT_CONNECTED'));
        continue;
      }

      const seq = ++this.pendingAckSeq;
      const gen = this.host.connectionGen;
      const requestAt = new Date(this.host.now()).toISOString();

      const active: ActivePendingAck = {
        reqId,
        seq,
        connectionGen: gen,
        streamId: item.streamId,
        requestAt,
        timer: setTimeout(() => {
          this.cancelInFlightAsUncertain(reqId, seq, gen);
        }, this.ackTimeoutMs),
        signal: item.signal,
        onAbort: undefined,
        settled: false,
        resolve: item.resolve,
        reject: item.reject,
      };

      if (item.signal) {
        const onAbort = () => {
          this.cancelInFlightAsUncertain(reqId, seq, gen);
        };
        active.onAbort = onAbort;
        item.signal.addEventListener('abort', onAbort, { once: true });
      }

      this.activeByReqId.set(reqId, active);

      try {
        this.host.transmit(item.payload);
      } catch {
        this.settleActiveAsUncertain(active);
        this.drain(reqId);
      }
    }
  }

  private cancelInFlightAsUncertain(reqId: string, seq: number, gen: number): void {
    const active = this.activeByReqId.get(reqId);
    if (!active || active.settled || active.seq !== seq || active.connectionGen !== gen) {
      return;
    }
    this.settleActiveAsUncertain(active);
    this.drain(reqId);
  }

  private settleActiveAsUncertain(active: ActivePendingAck): void {
    if (active.settled) return;
    active.settled = true;
    clearTimeout(active.timer);
    if (active.signal && active.onAbort) {
      active.signal.removeEventListener('abort', active.onAbort);
    }
    if (this.activeByReqId.get(active.reqId)?.seq === active.seq) {
      this.activeByReqId.delete(active.reqId);
    }
    if (active.connectionGen === this.host.connectionGen) {
      this.taintedReqIds.add(active.reqId);
    }
    active.reject(new Blocked('WECOM_WS_SEND_UNCERTAIN'));
  }
}
