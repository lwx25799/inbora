/**
 * WeChat Customer Service (WeChat KF) official API PlatformConnector implementation.
 * Enforces Inbora safety invariants:
 * - Single AccountActor queue for observe, send, and read-only verification.
 * - Credentials held inside private closures; never persisted to SQLite, audits, errors, or status.
 * - Single-submission SendCoordinator contract with zero post-intent resend.
 * - Read-only /kf/sync_msg origin=5 bounded verification without advancing observe cursors.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
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
import { recordEvidence } from '../../observability/evidence.js';
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
  WeChatKfApiClient,
  assertWeChatKfTextLength,
  deriveWeChatKfMsgId,
  matchWeChatKfOutgoingProof,
  normalizeWeChatKfInboundMessage,
} from './api.js';
import {
  WECHAT_KF_PLATFORM_ID,
  WeChatKfError,
  type WeChatKfCapabilities,
  type WeChatKfConnectorOptions,
  type WeChatKfCredentialProvider,
  type WeChatKfCredentials,
  type WeChatKfCursorStore,
  type WeChatKfMessage,
  type WeChatKfTransportState,
  type WeChatKfTransportStatus,
  type WeChatKfWebhookQuery,
} from './types.js';
import {
  WeChatKfWebhookProcessor,
  handleWebhookVerify,
  type WeChatKfWebhookCredentials,
  type WeChatKfWebhookDispatchResult,
} from './webhook.js';

const DEFAULT_MAX_SYNC_PAGES = 20;
const DEFAULT_MAX_VERIFY_PAGES = 10;
const DEFAULT_SYNC_PAGE_LIMIT = 200;
const MAX_SENT_HISTORY_PER_PEER = 256;
const MAX_CHECKPOINTS = 256;

export const wechatKfCapabilities: WeChatKfCapabilities = Object.freeze({
  channels: Object.freeze(['DIRECT_MESSAGE'] as const),
  loginRecovery: false,
  manualSecurityRecovery: false,
  preview: false,
  readback: true,
  transport: 'official_api',
});

/** In-memory cursor store keyed by (accountId, openKfId); callers may inject a durable store. */
export class MemoryWeChatKfCursorStore implements WeChatKfCursorStore {
  private readonly cursors = new Map<string, string>();

  load(accountId: AccountId, openKfId: string): string | null {
    return this.cursors.get(`${accountId}:${openKfId}`) ?? null;
  }

  save(accountId: AccountId, openKfId: string, cursor: string): void {
    this.cursors.set(`${accountId}:${openKfId}`, cursor);
  }
}

function isLocalEvidenceRoot(root: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:\/\//iu.test(root);
}

export class WeChatKfPlatformConnector implements PlatformConnector {
  readonly root: string;
  readonly platformId = WECHAT_KF_PLATFORM_ID;
  readonly accountId: AccountId;
  readonly capabilities: WeChatKfCapabilities = wechatKfCapabilities;
  readonly actor = new AccountActor();
  readonly loginRecovery = false;
  readonly openKfId: string;
  readonly apiClient: WeChatKfApiClient;

  readonly #readCredentials: WeChatKfCredentialProvider;
  readonly #cursorStore: WeChatKfCursorStore;
  readonly #maxSyncPages: number;
  readonly #maxVerifyPages: number;
  readonly #syncPageLimit: number;
  readonly #now: () => number;

  private store: EventStore | undefined;
  private epoch = 1;
  private opened = true;
  private transportState: WeChatKfTransportState = 'CONNECTED';
  private lastSyncAt: number | null = null;
  private lastErrorCode: string | null = null;
  private readonly sentMsgIdsByPeer = new Map<string, string[]>();
  private readonly dispatchedIntents = new Set<string>();
  private readonly sendCheckpoints = new Map<string, string | null>();
  private webhookProcessor: WeChatKfWebhookProcessor | undefined;

  onManualRecoveryClosed = () => {};

  constructor(options: WeChatKfConnectorOptions) {
    this.accountId = accountIdSchema.parse(options.accountId ?? DEFAULT_ACCOUNT_ID);
    requireSafe(typeof options.openKfId === 'string' && options.openKfId.trim().length > 0, 'ACCOUNT_REQUIRED');
    this.openKfId = options.openKfId.trim();
    this.root = options.root ?? 'official-api://wechat-kf';
    const credProvider = options.credentials;
    this.#readCredentials = typeof credProvider === 'function' ? credProvider : () => credProvider;
    this.#cursorStore = options.cursorStore ?? new MemoryWeChatKfCursorStore();
    this.#maxSyncPages = Math.max(1, options.maxSyncPages ?? DEFAULT_MAX_SYNC_PAGES);
    this.#maxVerifyPages = Math.max(1, options.maxVerifyPages ?? DEFAULT_MAX_VERIFY_PAGES);
    this.#syncPageLimit = Math.max(1, Math.min(1000, options.syncPageLimit ?? DEFAULT_SYNC_PAGE_LIMIT));
    this.#now = options.now ?? (() => Date.now());

    this.apiClient = new WeChatKfApiClient({
      credentials: this.#readCredentials,
      apiBaseUrl: options.apiBaseUrl,
      fetchImpl: options.fetchImpl,
      lookup: options.lookup,
      timeoutMs: options.timeoutMs,
      now: this.#now,
    });
  }

  get ownerEpoch(): number { return this.epoch; }
  get manualRecoveryActive(): boolean { return false; }

  status(): BrowserStatus {
    return { state: this.opened ? 'OPEN' : 'CLOSED', mode: 'headless', version: null };
  }

  transportStatus(): WeChatKfTransportStatus {
    return {
      transport: 'official_api',
      state: this.opened ? this.transportState : 'DISCONNECTED',
      endpointDigest: this.apiClient.endpointDigest,
      protocol: 'wechat_kf_http',
      lastHeartbeatAt: null,
      lastSyncAt: this.lastSyncAt,
      errorCode: this.lastErrorCode,
    };
  }

  resourceIdentity(): BrowserResourceIdentity {
    return { open: this.opened, epoch: this.epoch, mode: 'headless', pageCount: 0 };
  }

  isIdle(): boolean { return this.actor.idle; }

  identity(channel: Channel): CapabilityIdentity | null {
    if (!this.opened || channel !== 'DIRECT_MESSAGE') return null;
    return {
      identityDigest: digest([this.accountId, this.openKfId]),
      mappingDigest: digest([this.platformId, this.apiClient.endpointDigest]),
      browserVersion: 'official-api',
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
        this.opened = true;
      }
      this.transportState = 'CONNECTED';
      this.lastErrorCode = null;
    });
  }

  close(): Promise<void> {
    return this.actor.run(async () => {
      this.opened = false;
      this.transportState = 'DISCONNECTED';
      this.apiClient.tokenManager.clearAll();
    });
  }

  bindStore(store: EventStore): void {
    this.assertStore(store, false);
    store.bindAccount(this.accountId, this.openKfId);
    this.store = store;
  }

  setRuntimeInstance(_instanceId: string | null): void {}
  async verifyManualCheck(): Promise<never> { throw new WeChatKfError('WECHAT_KF_OPERATION_UNSUPPORTED'); }
  async beginLoginRecovery(): Promise<void> { throw new WeChatKfError('WECHAT_KF_OPERATION_UNSUPPORTED'); }
  async finishLoginRecovery(): Promise<boolean> { return false; }
  async completeLoginIfVerified(): Promise<boolean> { return false; }
  async verifyEmergencyRecovery(): Promise<void> { throw new WeChatKfError('WECHAT_KF_OPERATION_UNSUPPORTED'); }
  async openStoredMessage(): Promise<never> { throw new WeChatKfError('WECHAT_KF_OPERATION_UNSUPPORTED'); }
  async workUrl(): Promise<string | null> { return null; }
  manualRecoveryStatus(): null { return null; }
  async securityRecovery(): Promise<never> { throw new WeChatKfError('WECHAT_KF_OPERATION_UNSUPPORTED'); }
  async closeManualRecovery(): Promise<void> {}
  async recoverSecurityHolds(): Promise<void> {}
  prioritizePreview(): void {}
  prioritizeDisplayPreview(_data: AutomationStore, _event: InboundEvent, _target: PreviewDisplayTarget): boolean { return false; }

  async currentCursor(): Promise<string | null> {
    return this.#cursorStore.load(this.accountId, this.openKfId);
  }

  /** Verify WeChat KF GET callback URL using internal closure-held credentials. */
  handleWebhookVerify(query: WeChatKfWebhookQuery | URLSearchParams): string {
    return handleWebhookVerify(query, this.readWebhookCredentials());
  }

  /** Process WeChat KF POST callback XML with Token idempotency and trigger incremental sync. */
  async handleWebhookEvent(
    query: WeChatKfWebhookQuery | URLSearchParams,
    body: string | Buffer | AsyncIterable<Buffer | Uint8Array | string>,
    store: EventStore,
    signal?: AbortSignal,
  ): Promise<WeChatKfWebhookDispatchResult> {
    this.webhookProcessor ??= new WeChatKfWebhookProcessor({
      credentials: () => this.readWebhookCredentials(),
      expectedOpenKfId: this.openKfId,
      now: this.#now,
      onEvent: async webhookEvent => {
        await this.observeWithSyncToken(store, webhookEvent.token, signal);
      },
    });
    return this.webhookProcessor.handlePost(query, body);
  }

  observe(store: EventStore, source: ObservationSource, signal?: AbortSignal): Promise<ObservationResult> {
    if (source !== 'dm') {
      return this.actor.run(async () => {
        signal?.throwIfAborted();
        requireSafe(this.opened, 'BROWSER_CLOSED');
        this.bindStore(store);
        return { newEventIds: [] };
      });
    }
    return this.observeWithSyncToken(store, undefined, signal);
  }

  async collect(data: AutomationStore, source: CollectionSource, signal: AbortSignal): Promise<void> {
    if (source !== 'dm') return;
    await this.observe(data.store, source, signal);
  }

  private observeWithSyncToken(
    store: EventStore,
    syncToken?: string,
    signal?: AbortSignal,
  ): Promise<ObservationResult> {
    return this.actor.run(async () => {
      signal?.throwIfAborted();
      requireSafe(this.opened, 'BROWSER_CLOSED');
      this.bindStore(store);

      const initialCursor = await this.#cursorStore.load(this.accountId, this.openKfId);
      let cursor = initialCursor ?? undefined;
      const normalizedEvents: InboundEvent[] = [];
      let nextCursorToPersist: string | undefined;

      try {
        for (let page = 0; page < this.#maxSyncPages; page++) {
          signal?.throwIfAborted();
          const res = await this.apiClient.syncMessages({
            cursor,
            token: page === 0 ? syncToken : undefined,
            open_kfid: this.openKfId,
            limit: this.#syncPageLimit,
          }, { signal });

          for (const msg of res.msg_list ?? []) {
            this.trackObservedOutgoing(msg);
            const event = normalizeWeChatKfInboundMessage(msg, this.accountId, this.openKfId);
            if (event) normalizedEvents.push(event);
          }

          if (res.next_cursor && res.next_cursor !== cursor) {
            cursor = res.next_cursor;
            nextCursorToPersist = res.next_cursor;
          }
          if (res.has_more !== 1 || !res.next_cursor) break;
        }
      } catch (error) {
        this.recordTransportFailure(error);
        throw error;
      }

      const observedMs = this.#now();
      const observedAt = new Date(observedMs).toISOString();
      const newEventIds: string[] = [];
      const byConversation = Map.groupBy(normalizedEvents, event => event.conversationId!);
      for (const [conversationId, events] of byConversation) {
        const earliest = events.reduce((first, item) => {
          const parsed = Date.parse(item.occurredAt ?? '');
          return Number.isFinite(parsed) ? Math.min(first, parsed) : first;
        }, observedMs);
        const firstBoundary = Math.max(1, Math.min(earliest, observedMs) - 1000);
        newEventIds.push(...store.observe(
          'DIRECT_MESSAGE',
          conversationId,
          events,
          this.openKfId,
          this.platformId,
          observedAt,
          firstBoundary,
        ));
      }

      if (nextCursorToPersist !== undefined) {
        await this.#cursorStore.save(this.accountId, this.openKfId, nextCursorToPersist);
      }

      this.lastSyncAt = this.#now();
      this.transportState = 'CONNECTED';
      this.lastErrorCode = null;
      return { newEventIds };
    });
  }

  async adapter(
    event: InboundEvent,
    store: EventStore | undefined = this.store,
    signal?: AbortSignal,
    options?: AdapterOptions,
  ): Promise<AdapterHandle> {
    requireSafe(store, 'WECHAT_KF_STORE_REQUIRED');
    this.assertStore(store);
    requireSafe(event.accountId === this.accountId, 'ACCOUNT_CHANGED');
    requireSafe(event.channel === 'DIRECT_MESSAGE' && event.conversationId, 'WECHAT_KF_EVENT_TARGET_REQUIRED');
    signal?.throwIfAborted();

    const binding = eventBinding(event);
    const eventId = store.db
      .prepare('SELECT id FROM inbound_events WHERE account_id=? AND channel=? AND source_key=?')
      .pluck()
      .get(this.accountId, event.channel, event.platformEventId);
    requireSafe(typeof eventId === 'string' && store.event(eventId).binding === binding, 'NATIVE_REPLY_ORIGINAL_CHANGED');

    const key = targetKey(event);
    const peerId = event.conversationId;
    const epoch = this.epoch;
    let disposed = false;
    let preparedText: string | undefined;
    const pendingProofs = new Map<string, SendProof | null>();

    const snapshot = (current: InboundEvent): TargetSnapshot => {
      signal?.throwIfAborted();
      options?.readonlySignal?.throwIfAborted();
      requireSafe(this.opened && !disposed && epoch === this.epoch, 'BROWSER_CLOSED');
      this.assertStore(store);
      requireSafe(
        isEligible(current, this.openKfId) &&
        eventBinding(current) === binding &&
        store.event(eventId).binding === binding,
        'NATIVE_REPLY_ORIGINAL_CHANGED',
      );
      return {
        accountId: this.accountId,
        ownId: this.openKfId,
        targetKey: key,
        eventBinding: binding,
        contextDigest: digest([this.accountId, this.openKfId, key, binding]),
        composerKey: key,
        mappingDigest: digest([this.platformId, this.apiClient.endpointDigest]),
      };
    };

    const currentDraft = () => {
      const id = store.db.prepare('SELECT id FROM reply_drafts WHERE event_id=?').pluck().get(eventId);
      return typeof id === 'string' ? store.draft(id) : undefined;
    };

    const adapter: PlatformReplyAdapter = {
      inspect: async current => snapshot(current),
      prepare: async (current, text) => {
        snapshot(current);
        assertWeChatKfTextLength(text);
        preparedText = text;
      },
      verifyPrepared: async (current, text) => {
        requireSafe(preparedText === text, 'NATIVE_REPLY_NOT_PREPARED');
        assertWeChatKfTextLength(text);
        return snapshot(current);
      },
      baseline: async current => {
        snapshot(current);
        return [...(this.sentMsgIdsByPeer.get(peerId) ?? [])];
      },
      clickOnce: async (notBefore, check, permitExpiresAt) => {
        requireSafe(check && !options?.readonlySignal && notBefore, 'NATIVE_REPLY_NOT_PREPARED');
        if (permitExpiresAt !== undefined) {
          requireSafe(this.#now() <= permitExpiresAt, 'NATIVE_REPLY_ACK_REVOKED');
        }
        check();
        const draft = currentDraft();
        requireSafe(draft?.approval && draft.text === preparedText, 'NATIVE_REPLY_NOT_PREPARED');
        const intentId = store.db
          .prepare('SELECT id FROM send_intents WHERE event_id=? AND attempt_started_at=?')
          .pluck()
          .get(eventId, notBefore);
        requireSafe(typeof intentId === 'string' && !this.dispatchedIntents.has(intentId), 'INTENT_BINDING_CHANGED');
        store.assertIntentDispatch(intentId, draft, snapshot(event));
        assertWeChatKfTextLength(draft.text);

        // Lock single-submission before network dispatch so this intent can never fire twice.
        this.dispatchedIntents.add(intentId);
        preparedText = undefined;
        try {
          const priorCursor = await this.#cursorStore.load(this.accountId, this.openKfId);
          this.recordSendCheckpoint(intentId, priorCursor);
        } catch {
          // Best-effort checkpoint; verification falls back to bounded sync scan.
        }

        const kfMsgId = deriveWeChatKfMsgId(intentId);
        const boundaryMs = Date.parse(notBefore);
        const beforeMs = Math.max(boundaryMs, this.#now());
        const requestAt = new Date(beforeMs).toISOString();

        try {
          const res = await this.apiClient.sendTextMessage({
            touser: peerId,
            openKfid: this.openKfId,
            content: draft.text,
            msgid: kfMsgId,
          }, { signal });
          const afterMs = Math.max(beforeMs, this.#now());
          const responseAt = new Date(afterMs).toISOString();
          const proof: SendProof = {
            id: res.msgid,
            ownId: this.openKfId,
            targetKey: key,
            text: draft.text,
            pending: false,
            sentAt: responseAt,
            submission: {
              boundary: notBefore,
              requestAt,
              responseAt,
              requestDigest: digest([intentId, kfMsgId, key, digest(draft.text)]),
              responseDigest: digest([res.msgid, this.openKfId, responseAt]),
            },
          };
          pendingProofs.set(notBefore, proof);
          this.recordSentMsgId(peerId, res.msgid);
          this.transportState = 'CONNECTED';
          this.lastErrorCode = null;
        } catch (error) {
          // Post-intent network/timeout/API outcome is uncertain: NEVER resend; let readback return null -> UNCERTAIN.
          const code = this.recordTransportFailure(error);
          store.audit('WECHAT_KF_SEND_UNCERTAIN', intentId, { code });
          pendingProofs.set(notBefore, null);
        }
      },
      readback: async (current, text, before, notBefore) => {
        snapshot(current);
        const proof = pendingProofs.get(notBefore) ?? null;
        if (!proof) return null;
        if (
          proof.text !== text ||
          proof.ownId !== this.openKfId ||
          proof.targetKey !== targetKey(current) ||
          before.includes(proof.id)
        ) {
          return null;
        }
        return structuredClone(proof);
      },
      verifyExisting: async (current, text, notBefore, contextDigest) => {
        snapshot(current);
        const intentRow = store.db
          .prepare('SELECT id FROM send_intents WHERE event_id=? AND attempt_started_at=?')
          .get(eventId, notBefore) as { id: string } | undefined;
        return this.verifyExistingReadOnly(
          current,
          text,
          notBefore,
          contextDigest,
          intentRow?.id,
          options?.readonlySignal ?? signal,
        );
      },
      cancelPreparation: async () => { preparedText = undefined; },
    };

    return {
      adapter,
      dispose: () => {
        disposed = true;
        preparedText = undefined;
        pendingProofs.clear();
      },
    };
  }

  async verifyExisting(
    store: EventStore,
    eventId: string,
    options: VerificationOptions = {},
  ): Promise<VerificationResult> {
    requireSafe(!options.signal?.aborted, 'COLLECTION_CANCELLED');
    this.bindStore(store);
    const event = store.event(eventId);
    const draftRow = store.db.prepare('SELECT id FROM reply_drafts WHERE event_id=?').get(eventId) as { id: string } | undefined;
    const intentRow = store.db.prepare('SELECT id FROM send_intents WHERE event_id=?').get(eventId) as { id: string } | undefined;
    requireSafe(draftRow && intentRow, 'INTENT_REQUIRED');

    const handle = await this.adapter(event.payload, store, undefined, {
      ...(options.signal ? { readonlySignal: options.signal } : {}),
    });
    try {
      const proof = await this.actor.run(async () => {
        requireSafe(!options.signal?.aborted, 'COLLECTION_CANCELLED');
        const current = store.draft(draftRow.id);
        const boundary = store.intentBoundary(intentRow.id);
        return this.verifyExistingReadOnly(
          event.payload,
          current.text,
          boundary,
          current.approval?.snapshot.contextDigest,
          intentRow.id,
          options.signal,
        );
      }, options.background ? 'background' : 'interactive');

      requireSafe(!options.signal?.aborted, 'VERIFICATION_CANCELLED');
      const evidenceId = await this.writeVerificationEvidence(eventId, proof);
      return {
        verified: !!proof,
        evidenceId,
        ...(proof ? { nativeIdDigest: digest(proof.id) } : {}),
      };
    } finally {
      await handle.dispose();
    }
  }

  async verifyExistingFollowup(
    store: EventStore,
    commandId: string,
    options: VerificationOptions = {},
  ): Promise<FollowupVerificationResult> {
    requireSafe(!options.signal?.aborted, 'COLLECTION_CANCELLED');
    this.bindStore(store);
    const hasTurns = !!store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='human_reply_turns'")
      .get();
    requireSafe(hasTurns, 'INTENT_REQUIRED');
    const turn = store.db
      .prepare(`SELECT t.event_id, t.text, t.intent_id, t.attempt_started_at, t.approval, t.status
        FROM human_reply_turns t JOIN inbound_events e ON e.id=t.event_id
        WHERE t.command_id=? AND e.account_id=?`)
      .get(commandId, this.accountId) as {
        event_id: string; text: string; intent_id: string | null;
        attempt_started_at: string | null; approval: string | null; status: string;
      } | undefined;
    requireSafe(turn && turn.intent_id && turn.attempt_started_at && turn.status === 'UNCERTAIN', 'INTENT_REQUIRED');
    const event = store.event(turn.event_id);
    const parsedApproval = turn.approval ? (JSON.parse(turn.approval) as { snapshot?: TargetSnapshot }) : undefined;

    const proof = await this.actor.run(async () => {
      requireSafe(!options.signal?.aborted, 'COLLECTION_CANCELLED');
      requireSafe(this.opened, 'BROWSER_CLOSED');
      return this.verifyExistingReadOnly(
        event.payload,
        turn.text,
        turn.attempt_started_at!,
        parsedApproval?.snapshot?.contextDigest,
        turn.intent_id!,
        options.signal,
      );
    }, options.background ? 'background' : 'interactive');

    requireSafe(!options.signal?.aborted, 'VERIFICATION_CANCELLED');
    const evidenceId = await this.writeVerificationEvidence(turn.event_id, proof);
    return {
      verified: !!proof,
      evidenceId,
      ...(proof ? { proofDigest: digest(proof), nativeIdDigest: digest(proof.id) } : {}),
    };
  }

  toJSON(): Record<string, unknown> {
    return {
      platformId: this.platformId,
      accountId: this.accountId,
      openKfId: this.openKfId,
      transportStatus: this.transportStatus(),
    };
  }

  /** Read-only /kf/sync_msg bounded scan for origin=5 messages; never advances observe cursor and never resends. */
  private async verifyExistingReadOnly(
    event: InboundEvent,
    text: string,
    notBefore: string,
    contextDigest: string | undefined,
    intentId: string | undefined,
    signal?: AbortSignal,
  ): Promise<SendProof | null> {
    const startCursor = intentId ? (this.sendCheckpoints.get(intentId) ?? undefined) : undefined;
    const scanFrom = async (initialCursor: string | undefined): Promise<SendProof | null> => {
      let cursor = initialCursor;
      const collected: WeChatKfMessage[] = [];
      for (let page = 0; page < this.#maxVerifyPages; page++) {
        signal?.throwIfAborted();
        const res = await this.apiClient.syncMessages({
          cursor,
          open_kfid: this.openKfId,
          limit: this.#syncPageLimit,
        }, { signal });
        for (const msg of res.msg_list ?? []) {
          if (msg.origin === 5) collected.push(msg);
        }
        if (res.has_more !== 1 || !res.next_cursor || res.next_cursor === cursor) break;
        cursor = res.next_cursor;
      }
      return matchWeChatKfOutgoingProof(collected, {
        openKfId: this.openKfId,
        event,
        text,
        notBefore,
        nowMs: this.#now(),
        contextDigest,
        expectedMsgId: intentId ? deriveWeChatKfMsgId(intentId) : undefined,
      });
    };

    const primary = await scanFrom(startCursor);
    if (primary || startCursor !== undefined) return primary;

    const storedCursor = await this.#cursorStore.load(this.accountId, this.openKfId);
    if (!storedCursor) return null;
    return scanFrom(storedCursor);
  }

  private async writeVerificationEvidence(eventId: string, proof: SendProof | null): Promise<string> {
    if (!isLocalEvidenceRoot(this.root)) return randomUUID();
    return recordEvidence(join(this.root, 'evidence'), {
      caseId: 'D05',
      browserVersion: '0.0.0.0',
      mode: 'headless',
      taskId: eventId,
      action: 'OBSERVE',
      result: proof ? 'PASS' : 'BLOCKED',
      source: 'AUTOMATED_REAL',
      diagnostics: ['CLIENT_READ_ONLY_RECHECK', 'WECHAT_KF_SYNC_MSG_RECHECK', 'ORIGINAL_RECEIPTS_RETAINED'],
      proofDigest: proof ? digest(proof) : null,
    });
  }

  private trackObservedOutgoing(msg: WeChatKfMessage): void {
    if (msg.origin !== 5) return;
    if (msg.open_kfid && msg.open_kfid !== this.openKfId) return;
    if (!msg.external_userid || !msg.msgid) return;
    this.recordSentMsgId(msg.external_userid, msg.msgid);
  }

  private recordSentMsgId(peerId: string, msgId: string): void {
    const list = this.sentMsgIdsByPeer.get(peerId) ?? [];
    if (!list.includes(msgId)) {
      list.push(msgId);
      if (list.length > MAX_SENT_HISTORY_PER_PEER) list.shift();
      this.sentMsgIdsByPeer.set(peerId, list);
    }
  }

  private recordSendCheckpoint(intentId: string, cursor: string | null): void {
    while (this.sendCheckpoints.size >= MAX_CHECKPOINTS) {
      const oldest = this.sendCheckpoints.keys().next().value;
      if (oldest === undefined) break;
      this.sendCheckpoints.delete(oldest);
    }
    this.sendCheckpoints.set(intentId, cursor);
  }

  private recordTransportFailure(error: unknown): string {
    const code = error instanceof WeChatKfError || error instanceof Blocked ? error.code : 'WECHAT_KF_NETWORK_ERROR';
    this.lastErrorCode = code;
    this.transportState = code === 'WECHAT_KF_TOKEN_FETCH_FAILED' ||
      code === 'WECHAT_KF_TOKEN_EXPIRED' ||
      code === 'WECHAT_KF_CREDENTIAL_REQUIRED'
      ? 'ERROR'
      : 'DEGRADED';
    return code;
  }

  private readWebhookCredentials(): WeChatKfWebhookCredentials {
    const creds: WeChatKfCredentials = this.#readCredentials();
    if (!creds.corpId?.trim() || !creds.token?.trim() || !creds.encodingAESKey?.trim()) {
      throw new WeChatKfError('WECHAT_KF_CREDENTIAL_REQUIRED');
    }
    return { corpId: creds.corpId, token: creds.token, encodingAESKey: creds.encodingAESKey };
  }

  private assertStore(store: EventStore, bound = true): void {
    store.assertAccount(this.accountId);
    requireSafe(!this.store || this.store === store, 'WECHAT_KF_STORE_CHANGED');
    const ownId = store.accountOwnId(this.accountId);
    requireSafe(ownId === this.openKfId || (!bound && !ownId), 'WECHAT_KF_ACCOUNT_CHANGED');
  }
}
