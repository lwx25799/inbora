import { inspect } from 'node:util';
import { AccountActor } from '../../browser/account-actor.js';
import { accountIdSchema, DEFAULT_ACCOUNT_ID, type AccountId } from '../../contracts/account.js';
import type { BrowserMode, BrowserResourceIdentity, BrowserStatus } from '../../contracts/browser-resources.js';
import type { Channel } from '../../contracts/events.js';
import {
  Blocked,
  digest,
  eventBinding,
  isEligible,
  requireSafe,
  targetKey,
  type InboundEvent,
  type SendProof,
  type TargetSnapshot,
} from '../../core/contracts.js';
import type { AutomationStore } from '../../storage/automation-store.js';
import type { EventStore } from '../../storage/store.js';
import { createOfficialApiTransportStatus } from '../official-api-base.js';
import type {
  AdapterHandle,
  AdapterOptions,
  CapabilityIdentity,
  CollectionSource,
  FollowupVerificationResult,
  ObservationResult,
  ObservationSource,
  PlatformConnector,
  PlatformReplyAdapter,
  PreviewDisplayTarget,
  VerificationOptions,
  VerificationResult,
} from '../platform-connector.js';
import {
  addBoundedSet,
  normalizeWecomInboundFrame,
  parseFirstRunAt,
  setBoundedMap,
} from './inbound-normalizer.js';
import {
  WECOM_AIBOT_PLATFORM_ID,
  WECOM_DEFAULT_REQ_ID_TTL_MS,
  WECOM_REPLY_MAX_UTF8_BYTES,
  type WecomAibotCapabilities,
  type WecomAibotConnectorOptions,
  type WecomAibotTransportStatus,
  type WecomInboundDropInfo,
  type WecomInboundMessageBody,
  type WecomWsFrame,
} from './types.js';
import { WecomWsClient } from './ws-client.js';

const MAX_TRACKED_MSG_IDS = 4_096;
const MAX_REQ_ID_MAPPINGS = 2_048;
const MAX_PENDING_INBOUND = 2_048;
const MAX_DISPATCHED_INTENTS = 4_096;
const MAX_CONFIRMED_PROOFS_PER_TARGET = 256;

export const wecomAibotCapabilities: WecomAibotCapabilities = {
  channels: ['DIRECT_MESSAGE'],
  loginRecovery: false,
  manualSecurityRecovery: false,
  preview: false,
  // Long-connection protocol has no post-hoc server history fetch for readback verification;
  // synchronous send confirmation still relies on the official per-reply ACK frame.
  readback: false,
  transport: 'official_api',
};

interface InboundReplyRoute {
  reqId: string;
  conversationId: string;
  receivedAt: number;
}

export class WecomAibotPlatformConnector implements PlatformConnector {
  readonly root: string;
  readonly platformId = WECOM_AIBOT_PLATFORM_ID;
  readonly capabilities: WecomAibotCapabilities = wecomAibotCapabilities;
  readonly actor = new AccountActor();
  readonly accountId: AccountId;
  readonly loginRecovery = false;
  readonly manualRecoveryActive = false;
  onManualRecoveryClosed = () => {};

  readonly wsClient: WecomWsClient;

  private readonly ownId: string;
  private readonly allowGroupMessages: boolean;
  private readonly autoPersistInbound: boolean;
  private readonly maxReplyBytes: number;
  private readonly reqIdTtlMs: number;
  private readonly now: () => number;
  private readonly onWsError: ((error: Error) => void) | undefined;
  private readonly onInboundDrop: ((info: WecomInboundDropInfo) => void) | undefined;
  private readonly explicitFirstRunAtMs: number | undefined;
  private firstRunAtMs: number;

  private store: EventStore | undefined;
  private epoch = 1;
  private opened = false;
  private closing = false;
  private lastInboundAt: number | null = null;

  private readonly seenMsgBindings = new Map<string, string>();
  private readonly reqIdByMsgId = new Map<string, InboundReplyRoute>();
  private readonly pendingInbound: InboundEvent[] = [];
  private readonly dispatchedIntents = new Set<string>();
  private readonly confirmedProofs = new Map<string, SendProof[]>();

  get ownerEpoch(): number {
    return this.epoch;
  }

  constructor(options: WecomAibotConnectorOptions) {
    this.accountId = accountIdSchema.parse(options.accountId ?? DEFAULT_ACCOUNT_ID);
    const botId = typeof options.botId === 'string' ? options.botId.trim() : '';
    requireSafe(botId.length > 0, 'ACCOUNT_REQUIRED');
    this.ownId = botId;
    this.allowGroupMessages = options.allowGroupMessages ?? true;
    this.autoPersistInbound = options.autoPersistInbound ?? true;
    this.maxReplyBytes = options.maxReplyBytes ?? WECOM_REPLY_MAX_UTF8_BYTES;
    this.now = options.now ?? (() => Date.now());
    this.explicitFirstRunAtMs = parseFirstRunAt(options.firstRunAt);
    this.firstRunAtMs = this.explicitFirstRunAtMs ?? this.now();
    const reqIdTtlMs = options.reqIdTtlMs ?? WECOM_DEFAULT_REQ_ID_TTL_MS;
    requireSafe(Number.isSafeInteger(reqIdTtlMs) && reqIdTtlMs > 0, 'WECOM_WS_CONFIG_INVALID');
    this.reqIdTtlMs = reqIdTtlMs;
    this.onWsError = options.onWsError;
    this.onInboundDrop = options.onInboundDrop;

    this.wsClient = new WecomWsClient({
      botId: this.ownId,
      secret: options.secret,
      wsUrl: options.wsUrl,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      missedPongThreshold: options.missedPongThreshold,
      ackTimeoutMs: options.ackTimeoutMs,
      connectTimeoutMs: options.connectTimeoutMs,
      reconnectBaseDelayMs: options.reconnectBaseDelayMs,
      reconnectMaxDelayMs: options.reconnectMaxDelayMs,
      maxReconnectAttempts: options.maxReconnectAttempts,
      maxAuthFailureAttempts: options.maxAuthFailureAttempts,
      maxReplyBytes: options.maxReplyBytes,
      webSocketFactory: options.webSocketFactory,
      httpsRequest: options.httpsRequest,
      dnsLookup: options.dnsLookup,
      now: this.now,
      onMessage: frame => this.handleInboundFrame(frame),
      onError: options.onWsError,
    });

    this.root = `official-api://${this.platformId}/${this.accountId}/${this.wsClient.endpointDigest.slice(0, 12)}`;
  }

  transportStatus(): WecomAibotTransportStatus {
    const wsStatus = this.wsClient.getStatus();
    return createOfficialApiTransportStatus({
      state: wsStatus.state,
      protocol: 'wecom_ws',
      endpointDigest: wsStatus.endpointDigest,
      lastHeartbeatAt: wsStatus.lastHeartbeatAt,
      lastSyncAt: this.lastInboundAt,
      errorCode: wsStatus.errorCode,
    }) as WecomAibotTransportStatus;
  }

  toJSON(): WecomAibotTransportStatus {
    return this.transportStatus();
  }

  [inspect.custom](): WecomAibotTransportStatus {
    return this.transportStatus();
  }

  status(): BrowserStatus {
    const wsState = this.wsClient.getStatus().state;
    const state = wsState === 'CONNECTED'
      ? 'OPEN'
      : wsState === 'DISCONNECTED'
        ? 'CLOSED'
        : wsState;
    return { state, mode: 'headless', version: null };
  }

  resourceIdentity(): BrowserResourceIdentity {
    return {
      open: this.opened && this.wsClient.isConnected,
      epoch: this.ownerEpoch,
      mode: 'headless',
      pageCount: 0,
    };
  }

  isIdle(): boolean {
    return this.actor.idle;
  }

  identity(channel: Channel): CapabilityIdentity | null {
    if (channel !== 'DIRECT_MESSAGE' || !this.opened || !this.wsClient.isConnected) {
      return null;
    }
    return {
      identityDigest: digest(this.ownId),
      mappingDigest: digest([this.platformId, this.wsClient.endpointDigest]),
      browserVersion: 'wecom-ws',
      browserMode: 'headless',
    };
  }

  async refreshIdentity(channel: Channel): Promise<CapabilityIdentity | null> {
    return this.identity(channel);
  }

  open(_mode?: BrowserMode, signal?: AbortSignal): Promise<void> {
    return this.actor.run(async () => {
      signal?.throwIfAborted();
      requireSafe(!this.closing, 'CLIENT_CLOSING');
      if (!this.opened) {
        this.epoch++;
      }
      await this.wsClient.connect(signal);
      if (this.closing || signal?.aborted) {
        this.wsClient.disconnect();
        signal?.throwIfAborted();
        throw new Blocked('CLIENT_CLOSING');
      }
      this.opened = true;
    });
  }

  close(): Promise<void> {
    // Interrupt any in-flight open()/connect() immediately before queueing actor teardown
    // so close() can never deadlock behind a hung handshake.
    this.closing = true;
    this.wsClient.disconnect();
    return this.actor.run(async () => {
      this.wsClient.disconnect();
      this.opened = false;
      this.closing = false;
    });
  }

  bindStore(store: EventStore): void {
    this.bindStoreInternal(store, true);
  }

  private bindStoreInternal(store: EventStore, scheduleFlush: boolean): void {
    this.assertAccount(store, false);
    store.bindAccount(this.accountId, this.ownId);
    this.store = store;
    this.syncPersistedFirstRunBoundary(store);
    if (scheduleFlush && this.autoPersistInbound && this.pendingInbound.length > 0) {
      void this.actor.run(async () => {
        if (this.store === store && this.pendingInbound.length > 0) {
          this.flushPendingInbound(store);
        }
      }, 'background').catch(() => {});
    }
  }

  setRuntimeInstance(_instanceId: string | null): void {}
  async verifyManualCheck(): Promise<never> { throw new Blocked('WECOM_OPERATION_UNSUPPORTED'); }
  async beginLoginRecovery(): Promise<void> { throw new Blocked('WECOM_OPERATION_UNSUPPORTED'); }
  async finishLoginRecovery(): Promise<boolean> { return false; }
  async completeLoginIfVerified(): Promise<boolean> { return false; }
  async verifyEmergencyRecovery(): Promise<void> { throw new Blocked('WECOM_OPERATION_UNSUPPORTED'); }
  async openStoredMessage(): Promise<never> { throw new Blocked('WECOM_OPERATION_UNSUPPORTED'); }
  async workUrl(): Promise<string | null> { return null; }
  manualRecoveryStatus() { return null; }
  async securityRecovery(): Promise<never> { throw new Blocked('WECOM_OPERATION_UNSUPPORTED'); }
  async closeManualRecovery(): Promise<void> {}
  async recoverSecurityHolds(): Promise<void> {}
  prioritizePreview(): void {}
  prioritizeDisplayPreview(_data: AutomationStore, _event: InboundEvent, _target: PreviewDisplayTarget): boolean {
    return false;
  }

  async collect(data: AutomationStore, source: CollectionSource, signal: AbortSignal): Promise<void> {
    const startedAt = data.state().startedAt;
    if (this.explicitFirstRunAtMs === undefined && Number.isSafeInteger(startedAt) && startedAt > 0) {
      this.firstRunAtMs = startedAt;
    }
    await this.observeWithBoundary(data.store, source, signal, startedAt);
  }

  observe(store: EventStore, source: ObservationSource, signal?: AbortSignal): Promise<ObservationResult> {
    return this.observeWithBoundary(store, source, signal, undefined);
  }

  private observeWithBoundary(
    store: EventStore,
    source: ObservationSource,
    signal: AbortSignal | undefined,
    boundaryOverrideMs: number | undefined,
  ): Promise<ObservationResult> {
    return this.actor.run(async () => {
      signal?.throwIfAborted();
      this.bindStoreInternal(store, false);
      if (source !== 'dm') {
        return { newEventIds: [] };
      }
      const newEventIds = this.flushPendingInbound(store, boundaryOverrideMs);
      return { newEventIds };
    });
  }

  async verifyExisting(
    _store: EventStore,
    _eventId: string,
    _options?: VerificationOptions,
  ): Promise<VerificationResult> {
    // WeCom long-connection protocol provides no server-side message history fetch API.
    return { verified: false, evidenceId: 'wecom-ws-history-unavailable' };
  }

  async verifyExistingFollowup(
    _store: EventStore,
    _commandId: string,
    _options?: VerificationOptions,
  ): Promise<FollowupVerificationResult> {
    return { verified: false, evidenceId: 'wecom-ws-history-unavailable' };
  }

  async adapter(
    event: InboundEvent,
    store = this.store,
    signal?: AbortSignal,
    options?: AdapterOptions,
  ): Promise<AdapterHandle> {
    requireSafe(store, 'WECOM_STORE_REQUIRED');
    requireSafe(event.channel === 'DIRECT_MESSAGE', 'WECOM_CHANNEL_UNSUPPORTED');
    this.assertAccount(store);
    requireSafe(event.accountId === this.accountId, 'ACCOUNT_CHANGED');
    signal?.throwIfAborted();

    const binding = eventBinding(event);
    const eventId = store.db
      .prepare('SELECT id FROM inbound_events WHERE account_id=? AND channel=? AND source_key=?')
      .pluck()
      .get(this.accountId, event.channel, event.platformEventId);
    requireSafe(
      typeof eventId === 'string' && store.event(eventId).binding === binding,
      'NATIVE_REPLY_ORIGINAL_CHANGED',
    );

    const key = targetKey(event);
    const epoch = this.ownerEpoch;
    let disposed = false;
    let preparedText: string | undefined;
    let lastAttempt: { boundary: string; proof: SendProof | null } | null = null;

    const resolveRoute = (): { reqId: string; routeKey: string } => {
      const mapped = event.platformEventId ? this.reqIdByMsgId.get(event.platformEventId) : undefined;
      if (
        mapped
        && mapped.conversationId === event.conversationId
        && this.now() - mapped.receivedAt <= this.reqIdTtlMs
      ) {
        return { reqId: mapped.reqId, routeKey: `req:${mapped.reqId}` };
      }
      // Never silently downgrade single or group replies to proactive aibot_send_msg broadcasts.
      throw new Blocked('WECOM_WS_REPLY_ROUTE_MISSING');
    };

    const snapshot = (current: InboundEvent): TargetSnapshot => {
      signal?.throwIfAborted();
      options?.readonlySignal?.throwIfAborted();
      requireSafe(this.opened && !disposed && epoch === this.ownerEpoch, 'BROWSER_CLOSED');
      requireSafe(this.wsClient.isConnected, 'WECOM_WS_NOT_CONNECTED');
      this.assertAccount(store);
      requireSafe(
        isEligible(current, this.ownId)
          && eventBinding(current) === binding
          && store.event(eventId).binding === binding,
        'NATIVE_REPLY_ORIGINAL_CHANGED',
      );
      const { routeKey } = resolveRoute();
      return {
        accountId: this.accountId,
        ownId: this.ownId,
        targetKey: key,
        eventBinding: binding,
        contextDigest: digest([this.accountId, this.ownId, key, binding, routeKey]),
        composerKey: key,
        mappingDigest: digest([this.platformId, this.wsClient.endpointDigest]),
      };
    };

    const currentDraft = () => {
      const id = store.db.prepare('SELECT id FROM reply_drafts WHERE event_id=?').pluck().get(eventId);
      return typeof id === 'string' ? store.draft(id) : undefined;
    };

    const confirmedForTarget = () => this.confirmedProofs.get(key) ?? [];

    const adapter: PlatformReplyAdapter = {
      inspect: async current => snapshot(current),
      prepare: async (current, text) => {
        snapshot(current);
        requireSafe(text.trim().length > 0, 'WECOM_WS_REPLY_EMPTY');
        requireSafe(Buffer.byteLength(text, 'utf8') <= this.maxReplyBytes, 'WECOM_WS_REPLY_TOO_LONG');
        preparedText = text;
      },
      verifyPrepared: async (current, text) => {
        requireSafe(preparedText === text, 'NATIVE_REPLY_NOT_PREPARED');
        return snapshot(current);
      },
      baseline: async current => {
        snapshot(current);
        return confirmedForTarget().map(proof => proof.id);
      },
      clickOnce: async (notBefore, check) => {
        requireSafe(check && !options?.readonlySignal && notBefore, 'NATIVE_REPLY_NOT_PREPARED');
        check();
        const draft = currentDraft();
        requireSafe(draft?.approval && draft.text === preparedText, 'NATIVE_REPLY_NOT_PREPARED');
        const intentId = store.db
          .prepare('SELECT id FROM send_intents WHERE event_id=? AND attempt_started_at=?')
          .pluck()
          .get(eventId, notBefore);
        requireSafe(
          typeof intentId === 'string' && !this.dispatchedIntents.has(intentId),
          'INTENT_BINDING_CHANGED',
        );
        const currentSnapshot = snapshot(event);
        store.assertIntentDispatch(intentId, draft, currentSnapshot);
        const route = resolveRoute();

        addBoundedSet(this.dispatchedIntents, intentId, MAX_DISPATCHED_INTENTS);
        preparedText = undefined;
        lastAttempt = { boundary: notBefore, proof: null };

        try {
          const ack = await this.wsClient.sendReplyOnce({
            reqId: route.reqId,
            content: draft.text,
            streamId: `inbora_${intentId}`,
            signal,
          });

          const proof: SendProof = {
            id: `wecom-ack:${ack.reqId}:${ack.ackSeq}`,
            ownId: this.ownId,
            targetKey: key,
            text: draft.text,
            pending: false,
            sentAt: ack.responseAt,
            submission: {
              boundary: notBefore,
              requestAt: ack.requestAt,
              responseAt: ack.responseAt,
              requestDigest: digest([intentId, ack.reqId, ack.streamId, draft.text]),
              responseDigest: digest([ack.reqId, ack.ackSeq, ack.errcode, key, ack.responseAt]),
            },
          };
          lastAttempt = { boundary: notBefore, proof };
          const list = confirmedForTarget();
          const next = list.length >= MAX_CONFIRMED_PROOFS_PER_TARGET
            ? [...list.slice(1), proof]
            : [...list, proof];
          this.confirmedProofs.set(key, next);
        } catch (error) {
          // On timeout, disconnect, or rejection after intent commit: never retry.
          // Leave proof null so readback returns null and SendCoordinator records UNCERTAIN.
          if (
            error instanceof Blocked
            && (error.code === 'WECOM_WS_SEND_UNCERTAIN'
              || error.code === 'WECOM_WS_REPLY_REJECTED'
              || error.code === 'WECOM_WS_NOT_CONNECTED')
          ) {
            lastAttempt = { boundary: notBefore, proof: null };
            return;
          }
          throw error;
        }
      },
      readback: async (current, text, before, notBefore) => {
        requireSafe(!disposed && epoch === this.ownerEpoch, 'BROWSER_CLOSED');
        this.assertAccount(store);
        requireSafe(eventBinding(current) === binding, 'NATIVE_REPLY_ORIGINAL_CHANGED');
        const proof = lastAttempt?.boundary === notBefore ? lastAttempt.proof : null;
        if (!proof) {
          return null;
        }
        if (
          proof.text !== text
          || proof.ownId !== this.ownId
          || proof.targetKey !== key
          || before.includes(proof.id)
        ) {
          return null;
        }
        return structuredClone(proof);
      },
      cancelPreparation: async () => {
        preparedText = undefined;
      },
    };

    return {
      adapter,
      dispose: () => {
        disposed = true;
        preparedText = undefined;
      },
    };
  }

  private handleInboundFrame(frame: WecomWsFrame<WecomInboundMessageBody>): void {
    const normalized = normalizeWecomInboundFrame(frame, {
      accountId: this.accountId,
      ownId: this.ownId,
      allowGroupMessages: this.allowGroupMessages,
    });
    if (normalized.kind === 'ignore') return;
    if (normalized.kind === 'invalid') {
      try {
        this.onWsError?.(new Blocked('WECOM_WS_FRAME_INVALID'));
      } catch {
        // Isolate user listener errors.
      }
      return;
    }

    const { event: inboundEvent, msgId, conversationId } = normalized;
    const binding = eventBinding(inboundEvent);
    const priorBinding = this.seenMsgBindings.get(msgId);
    if (priorBinding === binding) {
      // Exact duplicate delivery of the same bound message.
      return;
    }

    const receivedAt = this.now();
    // Differing bindings for the same msgid are forwarded to EventStore.observe
    // so SOURCE_COLLISION auditing and approval revocation fire cleanly.
    setBoundedMap(this.seenMsgBindings, msgId, binding, MAX_TRACKED_MSG_IDS);
    setBoundedMap(
      this.reqIdByMsgId,
      msgId,
      { reqId: frame.headers.req_id, conversationId, receivedAt },
      MAX_REQ_ID_MAPPINGS,
    );
    this.lastInboundAt = receivedAt;

    if (this.pendingInbound.length >= MAX_PENDING_INBOUND) {
      const evicted = this.pendingInbound.shift();
      this.handleBufferEviction(evicted);
    }
    this.pendingInbound.push(inboundEvent);

    if (this.autoPersistInbound && this.store) {
      const boundStore = this.store;
      void this.actor.run(async () => {
        if (this.store === boundStore && this.pendingInbound.length > 0) {
          this.flushPendingInbound(boundStore);
        }
      }, 'background').catch(() => {});
    }
  }

  private handleBufferEviction(evicted: InboundEvent | undefined): void {
    const droppedMsgId = evicted?.platformEventId;
    if (!droppedMsgId) return;
    if (!this.pendingInbound.some(item => item.platformEventId === droppedMsgId)) {
      this.seenMsgBindings.delete(droppedMsgId);
    }
    try {
      this.onInboundDrop?.({ droppedMsgId, reason: 'BUFFER_OVERFLOW' });
    } catch {
      // Isolate callback errors.
    }
    try {
      this.store?.audit('WECOM_INBOUND_BUFFER_OVERFLOW', droppedMsgId);
    } catch {
      // Best-effort audit when store is closed or read-only.
    }
  }

  private syncPersistedFirstRunBoundary(store: EventStore): void {
    if (this.explicitFirstRunAtMs !== undefined) return;
    const hasTable = store.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='automation_state'")
      .get();
    if (!hasTable) return;
    const row = store.db.prepare('SELECT started_at FROM automation_state WHERE id=1').get() as
      | { started_at: number }
      | undefined;
    if (row && Number.isSafeInteger(row.started_at) && row.started_at > 0) {
      this.firstRunAtMs = row.started_at;
    }
  }

  private resolveFirstBoundaryMs(store: EventStore, boundaryOverrideMs?: number): number {
    if (boundaryOverrideMs !== undefined) {
      const parsed = parseFirstRunAt(boundaryOverrideMs)!;
      if (this.explicitFirstRunAtMs === undefined) {
        this.firstRunAtMs = parsed;
      }
      return parsed;
    }
    if (this.explicitFirstRunAtMs !== undefined) {
      return this.explicitFirstRunAtMs;
    }
    this.syncPersistedFirstRunBoundary(store);
    return this.firstRunAtMs;
  }

  private flushPendingInbound(store: EventStore, boundaryOverrideMs?: number): string[] {
    if (this.pendingInbound.length === 0) {
      return [];
    }
    const batch = this.pendingInbound.splice(0, this.pendingInbound.length);
    const entries = [...Map.groupBy(batch, event => event.conversationId!).entries()];
    const newEventIds: string[] = [];
    const boundaryMs = this.resolveFirstBoundaryMs(store, boundaryOverrideMs);

    for (let index = 0; index < entries.length; index++) {
      const [scope, events] = entries[index]!;
      const nowMs = this.now();
      const eventTimes = events
        .map(event => Date.parse(event.occurredAt ?? ''))
        .filter(ms => Number.isFinite(ms) && ms > 0);
      const latest = eventTimes.length > 0 ? Math.max(...eventTimes) : nowMs;
      const observedAtMs = Math.max(nowMs, boundaryMs, latest);
      const observedAt = new Date(observedAtMs).toISOString();
      const firstBoundary = Math.max(1, Math.min(boundaryMs, observedAtMs));
      try {
        newEventIds.push(
          ...store.observe('DIRECT_MESSAGE', scope, events, this.ownId, this.platformId, observedAt, firstBoundary),
        );
      } catch (error) {
        const unpersisted = entries.slice(index).flatMap(([, pending]) => pending);
        this.pendingInbound.unshift(...unpersisted);
        while (this.pendingInbound.length > MAX_PENDING_INBOUND) {
          this.handleBufferEviction(this.pendingInbound.shift());
        }
        throw error;
      }
    }
    return newEventIds;
  }

  private assertAccount(store: EventStore, bound = true): void {
    store.assertAccount(this.accountId);
    requireSafe(!this.store || this.store === store, 'WECOM_STORE_CHANGED');
    if (store.schemaVersion() >= 4) {
      const row = store.db
        .prepare('SELECT platform FROM accounts WHERE id=?')
        .get(this.accountId) as { platform: string } | undefined;
      requireSafe(row !== undefined, 'ACCOUNT_NOT_FOUND');
      requireSafe(row.platform === this.platformId, 'ACCOUNT_PLATFORM_MISMATCH');
    }
    const ownId = store.accountOwnId(this.accountId);
    requireSafe(ownId === this.ownId || (!bound && !ownId), 'NATIVE_REPLY_ACCOUNT_CHANGED');
  }
}
