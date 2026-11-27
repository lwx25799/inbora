import { inspect } from 'node:util';
import { AccountActor } from '../../browser/account-actor.js';
import { accountIdSchema, DEFAULT_ACCOUNT_ID, type AccountId } from '../../contracts/account.js';
import type { BrowserMode, BrowserResourceIdentity, BrowserStatus } from '../../contracts/browser-resources.js';
import { eventSchema, type Channel } from '../../contracts/events.js';
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
  WECOM_AIBOT_PLATFORM_ID,
  WECOM_REPLY_MAX_UTF8_BYTES,
  type WecomAibotCapabilities,
  type WecomAibotConnectorOptions,
  type WecomAibotTransportStatus,
  type WecomInboundMessageBody,
  type WecomWsFrame,
} from './types.js';
import { WecomWsClient } from './ws-client.js';

const MAX_TRACKED_MSG_IDS = 4_096;
const MAX_REQ_ID_MAPPINGS = 2_048;
const MAX_PENDING_INBOUND = 2_048;
const MAX_DISPATCHED_INTENTS = 4_096;
const MAX_CONFIRMED_PROOFS_PER_TARGET = 256;
const MAX_EVENT_TEXT_CHARS = 10_000;

export const wecomAibotCapabilities: WecomAibotCapabilities = {
  channels: ['DIRECT_MESSAGE'],
  loginRecovery: false,
  manualSecurityRecovery: false,
  preview: false,
  readback: true,
  transport: 'official_api',
};

interface InboundReplyRoute {
  reqId: string;
  conversationId: string;
  chatId: string | null;
  receivedAt: number;
}

interface NormalizedContent {
  text: string;
  contentType?: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'MIXED';
  observationIssue?: 'DM_CONTENT_UNVERIFIED';
}

function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= limit) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

function addBoundedSet<T>(set: Set<T>, value: T, limit: number): void {
  if (set.has(value)) return;
  if (set.size >= limit) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(value);
}

function truncateText(value: string): string {
  return value.length <= MAX_EVENT_TEXT_CHARS ? value : value.slice(0, MAX_EVENT_TEXT_CHARS);
}

function normalizeCreateTime(createTime: number | undefined, fallbackMs: number): string {
  if (typeof createTime === 'number' && Number.isFinite(createTime) && createTime > 0) {
    const ms = createTime > 1e12 ? Math.trunc(createTime) : Math.trunc(createTime * 1000);
    if (ms >= Date.UTC(2000, 0, 1) && ms <= Date.UTC(2100, 0, 1)) {
      return new Date(ms).toISOString();
    }
  }
  return new Date(fallbackMs).toISOString();
}

function normalizeMessageContent(body: WecomInboundMessageBody): NormalizedContent {
  const msgType = typeof body.msgtype === 'string' ? body.msgtype.toLowerCase() : '';
  if (msgType === 'text') {
    const raw = typeof body.text?.content === 'string' ? body.text.content.trim() : '';
    if (raw) {
      return { text: truncateText(raw) };
    }
    return { text: '[空文本消息]', observationIssue: 'DM_CONTENT_UNVERIFIED' };
  }
  if (msgType === 'image') {
    return { text: '[图片消息]', contentType: 'IMAGE', observationIssue: 'DM_CONTENT_UNVERIFIED' };
  }
  if (msgType === 'video') {
    return { text: '[视频消息]', contentType: 'VIDEO', observationIssue: 'DM_CONTENT_UNVERIFIED' };
  }
  if (msgType === 'voice') {
    const transcript = typeof body.voice?.content === 'string' ? body.voice.content.trim() : '';
    const text = transcript ? truncateText(`[语音消息] ${transcript}`) : '[语音消息]';
    return { text, contentType: 'AUDIO', observationIssue: 'DM_CONTENT_UNVERIFIED' };
  }
  if (msgType === 'file') {
    return { text: '[文件消息]', contentType: 'MIXED', observationIssue: 'DM_CONTENT_UNVERIFIED' };
  }
  if (msgType === 'mixed') {
    const textParts = (body.mixed?.msg_item ?? [])
      .filter(item => item.msgtype === 'text' && typeof item.text?.content === 'string')
      .map(item => item.text!.content!.trim())
      .filter(Boolean);
    const text = textParts.length > 0
      ? truncateText(`[图文混合消息] ${textParts.join(' ')}`)
      : '[图文混合消息]';
    return { text, contentType: 'MIXED', observationIssue: 'DM_CONTENT_UNVERIFIED' };
  }
  return { text: '[非文本消息]', contentType: 'MIXED', observationIssue: 'DM_CONTENT_UNVERIFIED' };
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
  private readonly now: () => number;

  private store: EventStore | undefined;
  private epoch = 1;
  private opened = false;
  private lastInboundAt: number | null = null;

  private readonly seenMsgIds = new Set<string>();
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

    this.wsClient = new WecomWsClient({
      botId: this.ownId,
      secret: options.secret,
      wsUrl: options.wsUrl,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      missedPongThreshold: options.missedPongThreshold,
      ackTimeoutMs: options.ackTimeoutMs,
      reconnectBaseDelayMs: options.reconnectBaseDelayMs,
      reconnectMaxDelayMs: options.reconnectMaxDelayMs,
      maxReconnectAttempts: options.maxReconnectAttempts,
      maxAuthFailureAttempts: options.maxAuthFailureAttempts,
      maxReplyBytes: options.maxReplyBytes,
      webSocketFactory: options.webSocketFactory,
      dnsLookup: options.dnsLookup,
      now: this.now,
      onMessage: frame => this.handleInboundFrame(frame),
      onError: options.onWsError,
    });

    this.root = `official-api://${this.platformId}/${this.accountId}/${this.wsClient.endpointDigest.slice(0, 12)}`;
  }

  transportStatus(): WecomAibotTransportStatus {
    const wsStatus = this.wsClient.getStatus();
    return {
      transport: 'official_api',
      state: wsStatus.state,
      endpointDigest: wsStatus.endpointDigest,
      protocol: 'wecom_ws',
      lastHeartbeatAt: wsStatus.lastHeartbeatAt,
      lastSyncAt: this.lastInboundAt,
      errorCode: wsStatus.errorCode,
    };
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
      identityDigest: digest([this.accountId, this.ownId]),
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
      if (!this.opened) {
        this.epoch++;
      }
      await this.wsClient.connect();
      signal?.throwIfAborted();
      this.opened = true;
    });
  }

  close(): Promise<void> {
    return this.actor.run(async () => {
      this.wsClient.disconnect();
      this.opened = false;
    });
  }

  bindStore(store: EventStore): void {
    this.bindStoreInternal(store, true);
  }

  private bindStoreInternal(store: EventStore, scheduleFlush: boolean): void {
    this.assertAccount(store, false);
    store.bindAccount(this.accountId, this.ownId);
    this.store = store;
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
    await this.observe(data.store, source, signal);
  }

  observe(store: EventStore, source: ObservationSource, signal?: AbortSignal): Promise<ObservationResult> {
    return this.actor.run(async () => {
      signal?.throwIfAborted();
      this.bindStoreInternal(store, false);
      if (source !== 'dm') {
        return { newEventIds: [] };
      }
      const newEventIds = this.flushPendingInbound(store);
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

    const resolveRoute = (): { reqId: string | null; chatId: string | null; routeKey: string } => {
      const mapped = event.platformEventId ? this.reqIdByMsgId.get(event.platformEventId) : undefined;
      if (mapped && mapped.conversationId === event.conversationId) {
        return { reqId: mapped.reqId, chatId: mapped.chatId, routeKey: `req:${mapped.reqId}` };
      }
      if (event.conversationId?.startsWith('group:')) {
        const chatId = event.conversationId.slice('group:'.length);
        if (chatId) {
          return { reqId: null, chatId, routeKey: `chat:${chatId}` };
        }
      }
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
          const ack = route.reqId
            ? await this.wsClient.sendReplyOnce({
                reqId: route.reqId,
                content: draft.text,
                streamId: `inbora_${intentId}`,
                signal,
              })
            : await this.wsClient.sendActiveMessageOnce({
                chatId: route.chatId!,
                content: draft.text,
                reqId: `send_${intentId}`,
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
    const body = frame.body;
    if (!body || typeof body !== 'object') return;

    const msgId = typeof body.msgid === 'string' ? body.msgid.trim() : '';
    const fromUserId = typeof body.from?.userid === 'string' ? body.from.userid.trim() : '';
    if (!msgId || !fromUserId) return;

    // Ignore cross-bot payloads and bot self-echoes.
    if (typeof body.aibotid === 'string' && body.aibotid.trim() && body.aibotid.trim() !== this.ownId) {
      return;
    }
    if (fromUserId === this.ownId) {
      return;
    }

    // Deduplicate repeated msgid deliveries.
    if (this.seenMsgIds.has(msgId)) {
      return;
    }

    let conversationId: string;
    let chatId: string | null = null;
    if (body.chattype === 'group') {
      if (!this.allowGroupMessages) return;
      const trimmedChatId = typeof body.chatid === 'string' ? body.chatid.trim() : '';
      if (!trimmedChatId) return;
      chatId = trimmedChatId;
      conversationId = `group:${trimmedChatId}`;
    } else if (body.chattype === 'single') {
      conversationId = `single:${fromUserId}`;
    } else {
      return;
    }

    const receivedAt = this.now();
    const occurredAt = normalizeCreateTime(body.create_time, receivedAt);
    const content = normalizeMessageContent(body);
    const actorName = typeof body.from.name === 'string' && body.from.name.trim()
      ? body.from.name.trim()
      : null;

    const inboundEvent = eventSchema.parse({
      accountId: this.accountId,
      channel: 'DIRECT_MESSAGE',
      platformEventId: msgId,
      actorId: fromUserId,
      actorName,
      text: content.text,
      occurredAt,
      videoId: null,
      commentId: null,
      conversationId,
      direction: 'INCOMING',
      kind: 'DM',
      evidenceId: `wecom-ws:${digest([this.accountId, msgId, frame.headers.req_id]).slice(0, 16)}`,
      discovery: 'DIRECT_MESSAGE',
      ...(content.contentType ? { contentType: content.contentType } : {}),
      ...(content.observationIssue ? { observationIssue: content.observationIssue } : {}),
    });

    addBoundedSet(this.seenMsgIds, msgId, MAX_TRACKED_MSG_IDS);
    setBoundedMap(
      this.reqIdByMsgId,
      msgId,
      { reqId: frame.headers.req_id, conversationId, chatId, receivedAt },
      MAX_REQ_ID_MAPPINGS,
    );
    this.lastInboundAt = receivedAt;

    if (this.pendingInbound.length >= MAX_PENDING_INBOUND) {
      this.pendingInbound.shift();
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

  private flushPendingInbound(store: EventStore): string[] {
    if (this.pendingInbound.length === 0) {
      return [];
    }
    const batch = this.pendingInbound.splice(0, this.pendingInbound.length);
    const entries = [...Map.groupBy(batch, event => event.conversationId!).entries()];
    const newEventIds: string[] = [];

    for (let index = 0; index < entries.length; index++) {
      const [scope, events] = entries[index]!;
      const nowMs = this.now();
      const eventTimes = events
        .map(event => Date.parse(event.occurredAt ?? ''))
        .filter(ms => Number.isFinite(ms) && ms > 0);
      const earliest = eventTimes.length > 0 ? Math.min(...eventTimes) : nowMs;
      const latest = eventTimes.length > 0 ? Math.max(...eventTimes) : nowMs;
      const observedAtMs = Math.max(nowMs, latest);
      const observedAt = new Date(observedAtMs).toISOString();
      const firstBoundary = Math.max(1, Math.min(earliest - 1, observedAtMs));
      try {
        newEventIds.push(
          ...store.observe('DIRECT_MESSAGE', scope, events, this.ownId, this.platformId, observedAt, firstBoundary),
        );
      } catch (error) {
        const unpersisted = entries.slice(index).flatMap(([, pending]) => pending);
        this.pendingInbound.unshift(...unpersisted);
        if (this.pendingInbound.length > MAX_PENDING_INBOUND) {
          this.pendingInbound.splice(0, this.pendingInbound.length - MAX_PENDING_INBOUND);
        }
        throw error;
      }
    }
    return newEventIds;
  }

  private assertAccount(store: EventStore, bound = true): void {
    store.assertAccount(this.accountId);
    requireSafe(!this.store || this.store === store, 'WECOM_STORE_CHANGED');
    const ownId = store.accountOwnId(this.accountId);
    requireSafe(ownId === this.ownId || (!bound && !ownId), 'NATIVE_REPLY_ACCOUNT_CHANGED');
  }
}
