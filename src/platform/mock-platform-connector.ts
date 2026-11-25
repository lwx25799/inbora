import { randomUUID } from 'node:crypto';
import { AccountActor } from '../browser/account-actor.js';
import { Blocked, digest, eventBinding, isEligible, isStrong, requireSafe, targetKey, type InboundEvent, type SendProof, type TargetSnapshot } from '../core/contracts.js';
import { DEFAULT_ACCOUNT_ID, MOCK_PLATFORM_ID, accountIdSchema, type AccountId } from '../contracts/account.js';
import type { BrowserResourceIdentity, BrowserStatus, BrowserMode } from '../contracts/browser-resources.js';
import { eventSchema, type Channel } from '../contracts/events.js';
import type { AutomationStore } from '../storage/automation-store.js';
import type { EventStore } from '../storage/store.js';
import type {
  AdapterHandle, AdapterOptions, CapabilityIdentity, CollectionSource, FollowupVerificationResult,
  ObservationResult, ObservationSource, PlatformCapabilities, PlatformConnector, PlatformReplyAdapter,
  PreviewDisplayTarget, VerificationOptions, VerificationResult,
} from './platform-connector.js';

export const mockCapabilities: PlatformCapabilities = {
  channels: ['COMMENT_NOTIFICATION', 'DIRECT_MESSAGE'], loginRecovery: false,
  manualSecurityRecovery: false, preview: false, readback: true,
};

export interface MockPlatformOptions {
  accountId?: AccountId;
  ownId?: string;
  now?: () => string;
}

export class MockPlatformConnector implements PlatformConnector {
  readonly root = 'synthetic://mock-platform';
  readonly platformId = MOCK_PLATFORM_ID;
  readonly capabilities = mockCapabilities;
  readonly actor = new AccountActor();
  readonly accountId: AccountId;
  readonly loginRecovery = false;
  private readonly ownId: string;
  private readonly now: () => string;
  private store: EventStore | undefined;
  private epoch = 1;
  private opened = true;
  private drifted = false;
  private readonly webDrafts = new Map<string, string>();
  private readonly inbox = new Map<string, InboundEvent>();
  private readonly sent = new Map<string, SendProof[]>();
  private readonly dispatched = new Set<string>();
  private _clickCount = 0;
  failNextClickOnce = false;
  hideNextReadback = false;
  get clickCount() { return this._clickCount; }
  get ownerEpoch() { return this.epoch; }

  constructor(options: MockPlatformOptions = {}) {
    this.accountId = accountIdSchema.parse(options.accountId ?? DEFAULT_ACCOUNT_ID);
    this.ownId = options.ownId ?? 'mock-own-1';
    requireSafe(this.ownId.trim(), 'ACCOUNT_REQUIRED');
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get manualRecoveryActive() { return false; }
  onManualRecoveryClosed = () => {};
  status(): BrowserStatus {
    return { state: this.drifted ? 'ACCOUNT_CHANGED' : this.opened ? 'OPEN' : 'CLOSED', mode: 'headless', version: null };
  }
  resourceIdentity(): BrowserResourceIdentity { return { open: this.opened, epoch: this.ownerEpoch, mode: 'headless', pageCount: 0 }; }
  isIdle() { return this.actor.idle; }
  identity(_channel: Channel): CapabilityIdentity | null {
    return this.opened && !this.drifted ? {
      identityDigest: digest([this.accountId, this.ownId]), mappingDigest: digest(this.platformId),
      browserVersion: 'mock', browserMode: 'headless',
    } : null;
  }
  async refreshIdentity(channel: Channel) { return this.identity(channel); }
  open(_mode?: BrowserMode, signal?: AbortSignal): Promise<void> {
    return this.actor.run(async () => {
      signal?.throwIfAborted();
      if (!this.opened) this.epoch++;
      this.opened = true;
    });
  }
  close(): Promise<void> { return this.actor.run(async () => { this.opened = false; }); }
  bindStore(store: EventStore) {
    this.assertAccount(store, false);
    store.bindAccount(this.accountId, this.ownId);
    this.store = store;
  }
  setRuntimeInstance(_instanceId: string | null) {}
  async verifyManualCheck(): Promise<never> { throw new Blocked('MOCK_OPERATION_UNSUPPORTED'); }
  async beginLoginRecovery() { throw new Blocked('MOCK_OPERATION_UNSUPPORTED'); }
  async finishLoginRecovery() { return false; }
  async completeLoginIfVerified() { return false; }
  async verifyEmergencyRecovery() { throw new Blocked('MOCK_OPERATION_UNSUPPORTED'); }
  async openStoredMessage(): Promise<never> { throw new Blocked('MOCK_OPERATION_UNSUPPORTED'); }
  async workUrl() { return null; }
  manualRecoveryStatus() { return null; }
  async securityRecovery() { throw new Blocked('MOCK_OPERATION_UNSUPPORTED'); }
  async closeManualRecovery() {}
  async recoverSecurityHolds() { throw new Blocked('MOCK_OPERATION_UNSUPPORTED'); }
  async collect(data: AutomationStore, source: CollectionSource, signal: AbortSignal) {
    await this.observe(data.store, source, signal);
  }
  prioritizePreview() {}
  prioritizeDisplayPreview(_data: AutomationStore, _event: InboundEvent, _target: PreviewDisplayTarget) { return false; }
  async verifyExisting(_store: EventStore, _eventId: string, _options?: VerificationOptions): Promise<VerificationResult> {
    return { verified: false, evidenceId: 'mock-no-proof' };
  }
  async verifyExistingFollowup(_store: EventStore, _commandId: string, _options?: VerificationOptions): Promise<FollowupVerificationResult> {
    return { verified: false, evidenceId: 'mock-no-proof' };
  }

  setWebDraft(target: string, text: string) {
    if (text) this.webDrafts.set(target, text);
    else this.webDrafts.delete(target);
  }
  simulateAccountDrift() { this.drifted = true; }
  inject(input: Omit<InboundEvent, 'accountId'>): void {
    const event = eventSchema.parse({ ...input, accountId: this.accountId });
    requireSafe(isStrong(event), 'MOCK_EVENT_TARGET_REQUIRED');
    this.inbox.set(this.inboxKey(event), event);
  }

  observe(store: EventStore, source: ObservationSource, signal?: AbortSignal): Promise<ObservationResult> {
    return this.actor.run(async () => {
      signal?.throwIfAborted();
      requireSafe(this.opened, 'BROWSER_CLOSED');
      this.bindStore(store);
      const channel = source === 'dm' ? 'DIRECT_MESSAGE' : 'COMMENT_NOTIFICATION';
      const groups = Map.groupBy([...this.inbox.values()].filter(event => event.channel === channel), event =>
        channel === 'DIRECT_MESSAGE' ? event.conversationId! : source);
      const observedAt = this.now();
      const newEventIds: string[] = [];
      for (const [scope, events] of groups) {
        // Injected synthetic events are new relative to the first observation of their scope.
        const earliest = events.reduce((first, event) => {
          const occurredAt = Date.parse(event.occurredAt ?? '');
          return Number.isFinite(occurredAt) ? Math.min(first, occurredAt) : first;
        }, Date.parse(observedAt));
        const boundary = earliest - 1;
        newEventIds.push(...store.observe(channel, scope, events, this.ownId, this.platformId, observedAt, boundary));
      }
      return { newEventIds };
    });
  }

  async adapter(event: InboundEvent, store = this.store, signal?: AbortSignal, options?: AdapterOptions): Promise<AdapterHandle> {
    requireSafe(store, 'MOCK_STORE_REQUIRED');
    this.assertAccount(store);
    requireSafe(event.accountId === this.accountId, 'ACCOUNT_CHANGED');
    signal?.throwIfAborted();
    const binding = eventBinding(event);
    const eventId = store.db.prepare('SELECT id FROM inbound_events WHERE account_id=? AND channel=? AND source_key=?').pluck()
      .get(this.accountId, event.channel, event.platformEventId);
    requireSafe(typeof eventId === 'string' && store.event(eventId).binding === binding, 'NATIVE_REPLY_ORIGINAL_CHANGED');
    const key = targetKey(event);
    const epoch = this.ownerEpoch;
    let disposed = false;
    let preparedText: string | undefined;

    const snapshot = (current: InboundEvent): TargetSnapshot => {
      signal?.throwIfAborted();
      options?.readonlySignal?.throwIfAborted();
      requireSafe(this.opened && !disposed && epoch === this.ownerEpoch, 'BROWSER_CLOSED');
      this.assertAccount(store);
      const original = this.inbox.get(this.inboxKey(event));
      requireSafe(original && isEligible(original, this.ownId) && eventBinding(original) === binding &&
        eventBinding(current) === binding && store.event(eventId).binding === binding, 'NATIVE_REPLY_ORIGINAL_CHANGED');
      // webDrafts contains external input. Only preparedText belongs to this adapter.
      requireSafe(!this.webDrafts.has(key), 'NATIVE_REPLY_EXISTING_DRAFT');
      return { accountId: this.accountId, ownId: this.ownId, targetKey: key, eventBinding: binding,
        contextDigest: digest([this.accountId, this.ownId, key, binding]), composerKey: key, mappingDigest: digest(this.platformId) };
    };

    const currentDraft = () => {
      const id = store.db.prepare('SELECT id FROM reply_drafts WHERE event_id=?').pluck().get(eventId);
      return typeof id === 'string' ? store.draft(id) : undefined;
    };
    const sent = () => this.sent.get(key) ?? [];
    const adapter: PlatformReplyAdapter = {
      inspect: async current => snapshot(current),
      prepare: async (current, text) => { snapshot(current); preparedText = text; },
      verifyPrepared: async (current, text) => {
        requireSafe(preparedText === text, 'NATIVE_REPLY_NOT_PREPARED');
        return snapshot(current);
      },
      baseline: async current => { snapshot(current); return sent().map(proof => proof.id); },
      clickOnce: async (notBefore, check) => {
        requireSafe(check && !options?.readonlySignal && notBefore, 'NATIVE_REPLY_NOT_PREPARED');
        check();
        const draft = currentDraft();
        requireSafe(draft?.approval && draft.text === preparedText, 'NATIVE_REPLY_NOT_PREPARED');
        const intentId = store.db.prepare('SELECT id FROM send_intents WHERE event_id=? AND attempt_started_at=?').pluck()
          .get(eventId, notBefore);
        requireSafe(typeof intentId === 'string' && !this.dispatched.has(intentId), 'INTENT_BINDING_CHANGED');
        store.assertIntentDispatch(intentId, draft, snapshot(event));
        this.dispatched.add(intentId);
        preparedText = undefined;
        this._clickCount++;
        if (this.failNextClickOnce) {
          this.failNextClickOnce = false;
          throw new Blocked('NATIVE_REPLY_CLICK_BLOCKED');
        }
        const sentAt = this.now();
        const proof: SendProof = { id: randomUUID(), ownId: this.ownId, targetKey: key, text: draft.text,
          pending: false, sentAt, submission: { boundary: notBefore, requestAt: sentAt, responseAt: sentAt,
            requestDigest: digest([intentId, draft.text]), responseDigest: digest([key, sentAt]) } };
        this.sent.set(key, [...sent(), proof]);
      },
      readback: async (current, text, before, notBefore) => {
        snapshot(current);
        if (this.hideNextReadback) { this.hideNextReadback = false; return null; }
        const matches = sent().filter(proof => proof.text === text && proof.submission?.boundary === notBefore && !before.includes(proof.id));
        return matches.length === 1 ? structuredClone(matches[0]!) : null;
      },
      cancelPreparation: async () => { preparedText = undefined; },
    };
    return { adapter, dispose: () => { disposed = true; preparedText = undefined; } };
  }

  private inboxKey(event: InboundEvent): string {
    return `${event.channel}:${event.platformEventId}`;
  }

  private assertAccount(store: EventStore, bound = true): void {
    store.assertAccount(this.accountId);
    requireSafe(!this.store || this.store === store, 'MOCK_STORE_CHANGED');
    const ownId = store.accountOwnId(this.accountId);
    requireSafe(!this.drifted && (ownId === this.ownId || !bound && !ownId), 'NATIVE_REPLY_ACCOUNT_CHANGED');
  }
}
