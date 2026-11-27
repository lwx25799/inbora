/**
 * WeChat Customer Service (WeChat KF) official API PlatformConnector implementation.
 * Enforces Inbora safety invariants:
 * - Single AccountActor queue for observe, send, and read-only verification.
 * - Credentials held inside private closures; never persisted to SQLite, audits, errors, or status.
 * - Single-submission SendCoordinator contract with pre-write beforeSend guard and zero post-intent resend.
 * - Honest verifyExisting/capabilities.readback: WeChat KF /kf/sync_msg does not return API-sent messages.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
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
import { recordEvidence } from '../../observability/evidence.js';
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
  WeChatKfApiClient,
  assertWeChatKfTextLength,
  deriveWeChatKfMsgId,
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
const DEFAULT_SYNC_PAGE_LIMIT = 200;
const MAX_SENT_HISTORY_PER_PEER = 256;

export const wechatKfCapabilities: WeChatKfCapabilities = Object.freeze({
  channels: Object.freeze(['DIRECT_MESSAGE'] as const),
  loginRecovery: false,
  manualSecurityRecovery: false,
  preview: false,
  // WeChat KF /kf/sync_msg explicitly excludes messages sent via /kf/send_msg.
  // Synchronous send confirmation still works via adapter.readback() on the /kf/send_msg response.
  readback: false,
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

function parseFirstRunAt(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  requireSafe(Number.isSafeInteger(parsed) && parsed > 0, 'OBSERVATION_BOUNDARY_INVALID');
  return parsed;
}

interface ObserveInternalResult {
  readonly newEventIds: string[];
  readonly truncated: boolean;
}

interface SendFailAuditRecord {
  readonly entityId: string;
  readonly detail: Record<string, unknown>;
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
  readonly #firstRunAtMs: number | undefined;
  readonly #createdAtMs: number;
  readonly #maxSyncPages: number;
  readonly #syncPageLimit: number;
  readonly #now: () => number;

  private store: EventStore | undefined;
  private rememberedStartedAtMs: number | undefined;
  private epoch = 1;
  private opened = true;
  private transportState: WeChatKfTransportState = 'CONNECTED';
  private lastSyncAt: number | null = null;
  private lastErrorCode: string | null = null;
  private readonly sentMsgIdsByPeer = new Map<string, string[]>();
  private readonly dispatchedIntents = new Set<string>();
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
    this.#firstRunAtMs = parseFirstRunAt(options.firstRunAt);
    this.#maxSyncPages = Math.max(1, options.maxSyncPages ?? DEFAULT_MAX_SYNC_PAGES);
    this.#syncPageLimit = Math.max(1, Math.min(1000, options.syncPageLimit ?? DEFAULT_SYNC_PAGE_LIMIT));
    this.#now = options.now ?? (() => Date.now());
    this.#createdAtMs = Math.max(1, Math.trunc(this.#now()));

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
    return createOfficialApiTransportStatus({
      state: this.opened ? this.transportState : 'DISCONNECTED',
      endpointDigest: this.apiClient.endpointDigest,
      protocol: 'wechat_kf_http',
      lastHeartbeatAt: null,
      lastSyncAt: this.lastSyncAt,
      errorCode: this.lastErrorCode,
    });
  }

  resourceIdentity(): BrowserResourceIdentity {
    return { open: this.opened, epoch: this.epoch, mode: 'headless', pageCount: 0 };
  }

  isIdle(): boolean { return this.actor.idle; }

  identity(channel: Channel): CapabilityIdentity | null {
    if (!this.opened || channel !== 'DIRECT_MESSAGE') return null;
    return {
      identityDigest: digest(this.openKfId),
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

  /** Process WeChat KF POST callback XML with Token idempotency; never caches per-request store or signal. */
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
    });
    return this.webhookProcessor.handlePost(query, body, {
      signal,
      onEvent: async (webhookEvent, activeSignal) => {
        const result = await this.observeWithSyncToken(store, webhookEvent.token, activeSignal);
        return { truncated: result.truncated };
      },
    });
  }

  async observe(store: EventStore, source: ObservationSource, signal?: AbortSignal): Promise<ObservationResult> {
    if (source !== 'dm') {
      return this.actor.run(async () => {
        signal?.throwIfAborted();
        requireSafe(this.opened, 'BROWSER_CLOSED');
        this.bindStore(store);
        return { newEventIds: [] };
      });
    }
    const { newEventIds } = await this.observeWithSyncToken(store, undefined, signal);
    return { newEventIds };
  }

  async collect(data: AutomationStore, source: CollectionSource, signal: AbortSignal): Promise<void> {
    if (source !== 'dm') return;
    const state = data.state();
    requireSafe(!signal.aborted && !state.emergencyStopped, 'COLLECTION_CANCELLED');
    if (Number.isSafeInteger(state.startedAt) && state.startedAt > 0) {
      this.rememberedStartedAtMs = state.startedAt;
    }
    await this.observeWithSyncToken(data.store, undefined, signal, state.startedAt);
  }

  private observeWithSyncToken(
    store: EventStore,
    syncToken?: string,
    signal?: AbortSignal,
    overrideFirstRunAt?: number,
  ): Promise<ObserveInternalResult> {
    return this.actor.run(async () => {
      signal?.throwIfAborted();
      requireSafe(this.opened, 'BROWSER_CLOSED');
      this.bindStore(store);

      const initialCursor = await this.#cursorStore.load(this.accountId, this.openKfId);
      let cursor = initialCursor ?? undefined;
      const normalizedEvents: InboundEvent[] = [];
      const sendFailAudits: SendFailAuditRecord[] = [];
      let nextCursorToPersist: string | undefined;
      let truncated = false;

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
            const failAudit = this.extractSendFailAudit(msg);
            if (failAudit) {
              sendFailAudits.push(failAudit);
              continue;
            }
            const event = normalizeWeChatKfInboundMessage(msg, this.accountId, this.openKfId);
            if (event) normalizedEvents.push(event);
          }

          const previousCursor = cursor;
          const advanced = Boolean(res.next_cursor && res.next_cursor !== previousCursor);
          if (advanced) {
            cursor = res.next_cursor;
            nextCursorToPersist = res.next_cursor;
          }
          if (res.has_more === 1) {
            if (!advanced || page === this.#maxSyncPages - 1) {
              truncated = true;
              break;
            }
          } else {
            break;
          }
        }
      } catch (error) {
        this.recordTransportFailure(error);
        throw error;
      }

      const observedMs = this.#now();
      const observedAt = new Date(observedMs).toISOString();
      const firstBoundary = this.resolveFirstRunBoundaryMs(store, observedMs, overrideFirstRunAt);

      const newEventIds: string[] = [];
      const byConversation = Map.groupBy(normalizedEvents, event => event.conversationId!);
      for (const [conversationId, events] of byConversation) {
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

      for (const failAudit of sendFailAudits) {
        store.audit('WECHAT_KF_MSG_SEND_FAIL', failAudit.entityId, failAudit.detail, observedAt);
      }

      if (nextCursorToPersist !== undefined) {
        await this.#cursorStore.save(this.accountId, this.openKfId, nextCursorToPersist);
      }

      this.lastSyncAt = this.#now();
      this.transportState = 'CONNECTED';
      this.lastErrorCode = null;
      return { newEventIds, truncated };
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
        const expectedText = preparedText;
        requireSafe(typeof expectedText === 'string', 'NATIVE_REPLY_NOT_PREPARED');

        const intentId = store.db
          .prepare('SELECT id FROM send_intents WHERE event_id=? AND attempt_started_at=?')
          .pluck()
          .get(eventId, notBefore);
        requireSafe(typeof intentId === 'string' && !this.dispatchedIntents.has(intentId), 'INTENT_BINDING_CHANGED');

        const recheckBeforeSend = (): void => {
          signal?.throwIfAborted();
          requireSafe(this.opened && !disposed && epoch === this.epoch, 'BROWSER_CLOSED');
          if (permitExpiresAt !== undefined) {
            requireSafe(this.#now() <= permitExpiresAt, 'NATIVE_REPLY_ACK_REVOKED');
          }
          check();
          const latestDraft = currentDraft();
          requireSafe(latestDraft?.approval && latestDraft.text === expectedText, 'NATIVE_REPLY_NOT_PREPARED');
          store.assertIntentDispatch(intentId, latestDraft, snapshot(event));
          assertWeChatKfTextLength(latestDraft.text);
        };

        // Initial synchronous verification before acquiring access_token or resolving DNS.
        recheckBeforeSend();
        this.dispatchedIntents.add(intentId);
        preparedText = undefined;

        const kfMsgId = deriveWeChatKfMsgId(intentId);
        const boundaryMs = Date.parse(notBefore);
        let beforeSendPassed = false;
        let requestAt = new Date(Math.max(boundaryMs, this.#now())).toISOString();

        try {
          const res = await this.apiClient.sendTextMessage({
            touser: peerId,
            openKfid: this.openKfId,
            content: expectedText,
            msgid: kfMsgId,
          }, {
            signal,
            // Final synchronous check right after token/DNS and immediately before writing the HTTPS request.
            beforeSend: () => {
              recheckBeforeSend();
              requestAt = new Date(Math.max(boundaryMs, this.#now())).toISOString();
              beforeSendPassed = true;
            },
          });
          const afterMs = Math.max(Date.parse(requestAt), this.#now());
          const responseAt = new Date(afterMs).toISOString();
          const proof: SendProof = {
            id: res.msgid,
            ownId: this.openKfId,
            targetKey: key,
            text: expectedText,
            pending: false,
            sentAt: responseAt,
            submission: {
              boundary: notBefore,
              requestAt,
              responseAt,
              requestDigest: digest([intentId, kfMsgId, key, digest(expectedText)]),
              responseDigest: digest([res.msgid, this.openKfId, responseAt]),
            },
          };
          pendingProofs.set(notBefore, proof);
          this.recordSentMsgId(peerId, res.msgid);
          this.transportState = 'CONNECTED';
          this.lastErrorCode = null;
        } catch (error) {
          // If revoked/closed/paused before any HTTP bytes were sent, propagate the bounded guard code.
          if (!beforeSendPassed && error instanceof Blocked && !(error instanceof WeChatKfError)) {
            throw error;
          }
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
      // WeChat KF /kf/sync_msg does not return messages sent via /kf/send_msg; never fabricate proof from origin=5.
      verifyExisting: async current => {
        snapshot(current);
        return null;
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

  /**
   * Honest read-only reconciliation: WeChat KF /kf/sync_msg does not expose API-sent messages,
   * so this never calls /kf/send_msg and never fabricates confirmation from human origin=5 replies.
   */
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

    await this.actor.run(async () => {
      requireSafe(!options.signal?.aborted, 'COLLECTION_CANCELLED');
      requireSafe(this.opened, 'BROWSER_CLOSED');
      this.assertStore(store);
      requireSafe(event.payload.accountId === this.accountId, 'ACCOUNT_CHANGED');
    }, options.background ? 'background' : 'interactive');

    requireSafe(!options.signal?.aborted, 'VERIFICATION_CANCELLED');
    const evidenceId = await this.writeVerificationEvidence(eventId);
    return { verified: false, evidenceId };
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
      .prepare(`SELECT t.event_id, t.intent_id, t.attempt_started_at, t.status
        FROM human_reply_turns t JOIN inbound_events e ON e.id=t.event_id
        WHERE t.command_id=? AND e.account_id=?`)
      .get(commandId, this.accountId) as {
        event_id: string; intent_id: string | null; attempt_started_at: string | null; status: string;
      } | undefined;
    requireSafe(turn && turn.intent_id && turn.attempt_started_at && turn.status === 'UNCERTAIN', 'INTENT_REQUIRED');

    await this.actor.run(async () => {
      requireSafe(!options.signal?.aborted, 'COLLECTION_CANCELLED');
      requireSafe(this.opened, 'BROWSER_CLOSED');
      this.assertStore(store);
    }, options.background ? 'background' : 'interactive');

    requireSafe(!options.signal?.aborted, 'VERIFICATION_CANCELLED');
    const evidenceId = await this.writeVerificationEvidence(turn.event_id);
    return { verified: false, evidenceId };
  }

  toJSON(): Record<string, unknown> {
    return {
      platformId: this.platformId,
      accountId: this.accountId,
      openKfId: this.openKfId,
      transportStatus: this.transportStatus(),
    };
  }

  [inspect.custom](): Record<string, unknown> {
    return this.toJSON();
  }

  private async writeVerificationEvidence(eventId: string): Promise<string> {
    if (!isLocalEvidenceRoot(this.root)) return randomUUID();
    return recordEvidence(join(this.root, 'evidence'), {
      caseId: 'D05',
      browserVersion: '0.0.0.0',
      mode: 'headless',
      taskId: eventId,
      action: 'OBSERVE',
      result: 'BLOCKED',
      source: 'AUTOMATED_REAL',
      diagnostics: ['CLIENT_READ_ONLY_RECHECK', 'WECHAT_KF_API_HISTORY_UNAVAILABLE', 'ORIGINAL_RECEIPTS_RETAINED'],
      proofDigest: null,
    });
  }

  private extractSendFailAudit(msg: WeChatKfMessage): SendFailAuditRecord | null {
    if (msg.origin !== 4 || msg.msgtype !== 'event' || msg.event?.event_type !== 'msg_send_fail') return null;
    const scopeKfId = msg.open_kfid ?? msg.event.open_kfid;
    if (scopeKfId && scopeKfId !== this.openKfId) return null;
    const entityId = digest([this.accountId, this.openKfId, msg.msgid || msg.event.fail_msgid || 'unknown']);
    const detail: Record<string, unknown> = {};
    if (typeof msg.event.fail_msgid === 'string' && msg.event.fail_msgid.trim()) {
      detail.failMsgIdDigest = digest(msg.event.fail_msgid);
    }
    if (typeof msg.event.fail_type === 'number' && Number.isSafeInteger(msg.event.fail_type)) {
      detail.failType = msg.event.fail_type;
    }
    const peer = msg.external_userid ?? msg.event.external_userid;
    if (typeof peer === 'string' && peer.trim()) {
      detail.targetDigest = digest(peer);
    }
    return { entityId, detail };
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

  private resolveFirstRunBoundaryMs(store: EventStore, observedMs: number, overrideFirstRunAt?: number): number {
    let candidate = overrideFirstRunAt ?? this.#firstRunAtMs ?? this.rememberedStartedAtMs;
    if (candidate === undefined) {
      const hasAutomationState = !!store.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='automation_state'")
        .get();
      if (hasAutomationState) {
        const row = store.db.prepare('SELECT started_at FROM automation_state WHERE id=1').get() as { started_at?: unknown } | undefined;
        if (typeof row?.started_at === 'number' && Number.isSafeInteger(row.started_at) && row.started_at > 0) {
          this.rememberedStartedAtMs = row.started_at;
          candidate = row.started_at;
        }
      }
    }
    const effective = candidate ?? this.#createdAtMs;
    return Math.max(1, Math.min(Math.trunc(effective), observedMs));
  }

  private assertStore(store: EventStore, bound = true): void {
    store.assertAccount(this.accountId);
    requireSafe(!this.store || this.store === store, 'WECHAT_KF_STORE_CHANGED');
    if (store.schemaVersion() >= 4) {
      const account = store.db
        .prepare('SELECT platform, own_id FROM accounts WHERE id=?')
        .get(this.accountId) as { platform: string; own_id: string } | undefined;
      requireSafe(account !== undefined && account.platform === this.platformId, 'WECHAT_KF_ACCOUNT_CHANGED');
      requireSafe(account.own_id === this.openKfId || (!bound && account.own_id === ''), 'WECHAT_KF_ACCOUNT_CHANGED');
      return;
    }
    const ownId = store.accountOwnId(this.accountId);
    requireSafe(ownId === this.openKfId || (!bound && !ownId), 'WECHAT_KF_ACCOUNT_CHANGED');
  }
}
