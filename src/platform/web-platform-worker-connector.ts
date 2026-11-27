import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AccountActor } from '../browser/account-actor.js';
import { createWorkerDispatchLedger, readAccountHolds } from '../app/isolated-douyin-connector.js';
import { requireCalibratedWebReplyMapping } from '../config/web-platform-mapping.js';
import type { AccountId, WebBrowserPlatformId } from '../contracts/account.js';
import type { BrowserMode } from '../contracts/browser-resources.js';
import type { WorkerSendBinding } from '../contracts/browser-worker.js';
import type { ManualRecoveryCommand, ManualRecoveryResult } from '../contracts/manual-recovery.js';
import {
  Blocked,
  digest,
  eventBinding,
  requireSafe,
  targetKey,
  type Channel,
  type Draft,
  type InboundEvent,
  type TargetSnapshot,
} from '../core/contracts.js';
import { evidenceSchema, recordEvidence } from '../observability/evidence.js';
import type { AutomationStore } from '../storage/automation-store.js';
import { isEmergencyStopped, onEmergencyStop } from '../storage/emergency-stop.js';
import {
  assertSecurityChannelClear,
  holdSecurityChannel,
  readSecurityHold,
  resolveSecurityHold,
  securityRevision,
} from '../storage/security-holds.js';
import type { EventStore } from '../storage/store.js';
import { BrowserWorkerHost } from '../workers/browser-worker-host.js';
import { workerTextDigest, type WorkerMode, type WorkerStatus } from '../workers/worker-protocol.js';
import type {
  AdapterOptions,
  BrowserTransportStatus,
  CapabilityIdentity,
  CollectionSource,
  ObservationSource,
  PlatformCapabilities,
  PlatformConnector,
  VerificationOptions,
  VerificationResult,
} from './platform-connector.js';

export const webPlatformCapabilities: PlatformCapabilities = Object.freeze({
  channels: Object.freeze(['COMMENT_NOTIFICATION', 'DIRECT_MESSAGE'] as const),
  loginRecovery: false,
  manualSecurityRecovery: true,
  preview: false,
  readback: true,
  transport: 'browser',
});

const recoveryChannels = ['DIRECT_MESSAGE', 'COMMENT_NOTIFICATION'] as const;
type HeldChannel = ReturnType<typeof recoverySnapshot>;
type RecoveryStatus = {
  securityHolds: NonNullable<HeldChannel['hold']>[];
  manualRecovery: ReturnType<WebPlatformWorkerConnector['manualRecoveryStatus']>;
};

function recoverySnapshot(store: EventStore, channel: Channel) {
  return { channel, revision: securityRevision(store, channel), hold: readSecurityHold(store, channel) };
}

function hasTable(store: EventStore, table: string): boolean {
  return !!store.db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name=?").get(table);
}

type WorkerIntentRow = {
  id: string;
  event_id: string;
  channel: Channel;
  target_key: string;
  target_digest: string | null;
  text_digest: string | null;
  text: string;
  version: number;
  approval: string | null;
  draft_id: string | null;
  operator_id: string | null;
};

function findWorkerIntent(
  store: EventStore,
  notBefore: string,
  targetDigest: string,
  textDigest: string,
  filter: { eventId: string } | { intentId: string },
): WorkerIntentRow {
  const { db, accountId } = store;
  const byEvent = 'eventId' in filter;
  const hasCommands = hasTable(store, 'manual_send_commands');
  const followup = hasTable(store, 'human_reply_turns') ? `
    UNION ALL SELECT t.intent_id,t.event_id,e.channel,t.target_key,NULL,NULL,t.text,t.version,t.approval,NULL,t.operator_id
    FROM human_reply_turns t JOIN inbound_events e ON e.id=t.event_id
    WHERE e.account_id=@accountId AND t.attempt_started_at=@notBefore AND t.status='INTENT_RECORDED'
      AND ${byEvent ? 't.event_id' : 't.intent_id'}=@id
  ` : '';
  const rows = db.prepare(`
    SELECT i.id,i.event_id,e.channel,i.target_key,i.target_digest,i.text_digest,d.text,d.version,d.approval,i.draft_id,
      ${hasCommands ? '(SELECT operator_id FROM manual_send_commands WHERE intent_id=i.id LIMIT 1)' : 'NULL'} AS operator_id
    FROM send_intents i JOIN inbound_events e ON e.id=i.event_id JOIN reply_drafts d ON d.id=i.draft_id AND d.event_id=e.id
    WHERE e.account_id=@accountId AND i.attempt_started_at=@notBefore AND i.status='INTENT_RECORDED'
      AND e.status='INTENT_RECORDED' AND d.status='APPROVED' AND ${byEvent ? 'i.event_id' : 'i.id'}=@id
    ${followup}`).all({ accountId, notBefore, id: byEvent ? filter.eventId : filter.intentId }) as WorkerIntentRow[];
  const matches = rows.filter(row => {
    if (!row.approval || workerTextDigest(row.text) !== textDigest) return false;
    const approval = JSON.parse(row.approval) as Draft['approval'];
    return approval
      && approval.version === row.version
      && approval.textDigest === digest(row.text)
      && approval.snapshot.targetKey === row.target_key
      && approval.snapshot.eventBinding === store.event(row.event_id).binding
      && approval.snapshot.accountId === accountId
      && digest(approval.snapshot) === targetDigest
      && (row.draft_id === null || (row.target_digest === targetDigest && row.text_digest === approval.textDigest));
  });
  const [match] = matches;
  requireSafe(match && matches.length === 1, 'INTENT_BINDING_CHANGED');
  return match;
}

export interface WebPlatformWorkerConnectorOptions {
  readonly platformId: WebBrowserPlatformId;
  readonly accountId: AccountId;
  readonly root: string;
  readonly profileDir: string;
  readonly store: EventStore;
  readonly mode?: WorkerMode;
  readonly entryScript?: string;
  readonly allowFixture?: boolean;
  readonly firstRunAt?: number;
}

/** Isolated browser worker PlatformConnector for 小红书 & B 站. */
export class WebPlatformWorkerConnector implements PlatformConnector {
  readonly platformId: WebBrowserPlatformId;
  readonly root: string;
  readonly capabilities: PlatformCapabilities = webPlatformCapabilities;
  readonly actor = new AccountActor();
  readonly loginRecovery = false;
  onManualRecoveryClosed = () => {};

  private readonly store: EventStore;
  private readonly host: BrowserWorkerHost;
  private readonly profileDir: string;
  private readonly mode: WorkerMode;
  private readonly allowFixture: boolean;
  private readonly firstRunAt: number | undefined;
  private workerState: WorkerStatus | undefined;
  private opening: Promise<void> | undefined;
  private closing = false;
  private readonly identities = new Map<Channel, CapabilityIdentity>();
  private activeSend: { intentId: string; validate: () => void } | undefined;
  private recovery?: { id: string; token: string; ownId: string; snapshot: HeldChannel };

  constructor(options: WebPlatformWorkerConnectorOptions) {
    this.platformId = options.platformId;
    this.root = options.root;
    this.store = options.store;
    this.profileDir = options.profileDir;
    this.mode = options.mode ?? 'browser';
    this.allowFixture = options.allowFixture ?? false;
    this.firstRunAt = options.firstRunAt;
    requireSafe(options.accountId === options.store.accountId, 'ACCOUNT_CHANGED');
    this.host = new BrowserWorkerHost({
      profileDir: options.profileDir,
      accountRoot: options.root,
      platformId: options.platformId,
      mode: this.mode,
      allowFixture: this.allowFixture,
      ...(options.entryScript ? { entryScript: options.entryScript } : {}),
      ledger: createWorkerDispatchLedger(options.store),
      onPermitCheck: binding => this.permitActiveSend(binding),
    });
  }

  get accountId(): AccountId {
    return this.store.accountId;
  }

  get ownerEpoch(): number {
    return this.host.ownerEpoch;
  }

  status() {
    const open = this.resourceIdentity().open;
    const state = !open ? 'CLOSED' : this.identities.size > 0 ? 'OPEN' : 'OPEN_UNVERIFIED';
    return {
      state,
      mode: 'headless' as const,
      version: this.host.pid ? this.workerState?.version ?? null : null,
    };
  }

  transportStatus(): BrowserTransportStatus {
    const current = this.status();
    return {
      transport: 'browser',
      state: current.state,
      mode: current.mode,
      version: current.version,
      loginRecovery: this.loginRecovery,
    };
  }

  resourceIdentity() {
    const open = !!this.host.pid && this.workerState?.state === 'OPEN' && !this.closing;
    return {
      open,
      epoch: this.ownerEpoch,
      mode: 'headless' as const,
      pageCount: open ? this.workerState?.pageCount ?? 0 : 0,
    };
  }

  isIdle(): boolean {
    return this.actor.idle && !this.opening && !this.closing;
  }

  abortInFlight(): void {
    void this.host.abortInFlight();
  }

  recheckInFlight(): void {
    try {
      this.activeSend?.validate();
    } catch {
      this.abortInFlight();
    }
  }

  permitActiveSend(binding: Readonly<WorkerSendBinding>): boolean {
    if (!this.activeSend || this.activeSend.intentId !== binding.intentId) return false;
    this.activeSend.validate();
    return true;
  }

  bindStore(store: EventStore): void {
    requireSafe(store === this.store, 'ACCOUNT_CHANGED');
  }

  setRuntimeInstance(_instanceId: string | null): void {}

  get manualRecoveryActive(): boolean {
    return this.recovery !== undefined;
  }

  manualRecoveryStatus() {
    const hold = this.recovery?.snapshot.hold;
    return hold ? { active: true as const, channel: hold.channel, incidentId: hold.incidentId } : null;
  }

  async closeManualRecovery(): Promise<void> {
    if (!this.recovery) return;
    delete this.recovery;
    this.onManualRecoveryClosed();
  }

  async recoverSecurityHolds(force = false, signal?: AbortSignal, check?: () => void): Promise<void> {
    if (!force) return;
    const held = recoveryChannels.map(channel => recoverySnapshot(this.store, channel)).filter(item => item.hold);
    if (!held.length) return;
    requireSafe(!this.manualRecoveryActive, 'MANUAL_RECOVERY_IN_PROGRESS');
    const ownId = this.store.accountOwnId();
    requireSafe(ownId, 'ACCOUNT_NOT_VERIFIED');
    await this.verifyRecovery(ownId, held, signal, check);
  }

  async verifyManualCheck(): Promise<never> { throw new Blocked('WORKER_MANUAL_RECOVERY_UNAVAILABLE'); }
  async beginLoginRecovery(): Promise<never> { throw new Blocked('WORKER_MANUAL_RECOVERY_UNAVAILABLE'); }
  async finishLoginRecovery(): Promise<boolean> { return false; }
  async completeLoginIfVerified(): Promise<boolean> { return false; }
  async openStoredMessage(): Promise<never> { throw new Blocked('WORKER_MANUAL_RECOVERY_UNAVAILABLE'); }

  async securityRecovery(command: ManualRecoveryCommand, token: string, check: () => void): Promise<ManualRecoveryResult>;
  async securityRecovery(command: { command: 'securityRecovery'; action: 'status' }, token: string, check: () => void): Promise<RecoveryStatus>;
  async securityRecovery(
    command: ManualRecoveryCommand | { action: 'status' },
    token: string,
    check: () => void,
  ): Promise<ManualRecoveryResult | RecoveryStatus> {
    check();
    if (command.action === 'status') {
      return { securityHolds: readAccountHolds(this.store), manualRecovery: this.manualRecoveryStatus() };
    }
    const session = this.recovery;
    if (command.action === 'close') {
      if (session?.id === command.sessionId) {
        requireSafe(session.token === token, 'MANUAL_RECOVERY_OPERATOR_CHANGED');
        await this.closeManualRecovery();
      }
      return;
    }
    if (command.action === 'start') {
      const snapshot = recoverySnapshot(this.store, command.channel);
      if (!snapshot.hold) return { state: 'CLEARED' as const };
      const ownId = this.store.accountOwnId();
      requireSafe(ownId, 'ACCOUNT_NOT_VERIFIED');
      requireSafe(
        !session || (session.token === token && session.snapshot.channel === command.channel),
        'MANUAL_RECOVERY_ALREADY_ACTIVE',
      );
      if (!session || session.snapshot.revision !== snapshot.revision) {
        this.recovery = { id: randomUUID(), token, ownId, snapshot };
      }
      return { sessionId: this.recovery!.id, channel: command.channel, incidentId: snapshot.hold.incidentId };
    }
    requireSafe(command.action === 'finish', 'WORKER_MANUAL_RECOVERY_UNAVAILABLE');
    requireSafe(session?.id === command.sessionId, 'MANUAL_RECOVERY_SESSION_EXPIRED');
    requireSafe(session.token === token, 'MANUAL_RECOVERY_OPERATOR_CHANGED');
    await this.verifyRecovery(session.ownId, [session.snapshot], AbortSignal.timeout(30_000), () => {
      check();
      requireSafe(this.recovery === session, 'SECURITY_RECOVERY_CHANGED');
    });
    await this.closeManualRecovery();
  }

  async workUrl(): Promise<string | null> { return null; }
  prioritizePreview(): void {}
  prioritizeDisplayPreview(): boolean { return false; }
  async verifyExistingFollowup() { return { verified: false, evidenceId: 'worker-followup-unavailable' }; }

  async open(mode: BrowserMode = 'headless', signal?: AbortSignal): Promise<void> {
    requireSafe(mode === 'headless', 'WORKER_MANUAL_RECOVERY_UNAVAILABLE');
    requireSafe(!this.closing, 'BROWSER_CLOSED');
    signal?.throwIfAborted();
    if (this.resourceIdentity().open) return;
    this.opening ??= (async () => {
      this.identities.clear();
      await mkdir(this.profileDir, { recursive: true });
      await this.host.start();
      this.workerState = await this.host.open();
    })().finally(() => { this.opening = undefined; });
    await this.opening;
    signal?.throwIfAborted();
    requireSafe(!this.closing, 'BROWSER_CLOSED');
  }

  async close(): Promise<void> {
    this.closing = true;
    this.abortInFlight();
    try {
      await this.closeManualRecovery();
      await this.opening?.catch(() => {});
      await this.host.close();
    } finally {
      this.workerState = undefined;
      this.identities.clear();
      this.closing = false;
    }
  }

  identity(channel: Channel): CapabilityIdentity | null {
    return this.resourceIdentity().open ? this.identities.get(channel) ?? null : null;
  }

  async refreshIdentity(channel: Channel): Promise<CapabilityIdentity | null> {
    if (!this.resourceIdentity().open) return null;
    this.identities.delete(channel);
    const identity = await this.invoke(channel, () => this.host.identity(channel, this.store.accountOwnId() || undefined));
    if (!identity) return null;
    const { ownId, ...proof } = identity;
    const capability: CapabilityIdentity = {
      ...proof,
      identityDigest: digest(ownId),
      browserMode: 'headless',
    };
    this.identities.set(channel, capability);
    return capability;
  }

  async verifyEmergencyRecovery(ownId: string, signal: AbortSignal, check: () => void, complete?: () => void): Promise<void> {
    const snapshots = recoveryChannels.map(channel => recoverySnapshot(this.store, channel));
    await this.verifyRecovery(ownId, snapshots, signal, check, complete);
  }

  private async verifyRecovery(
    ownId: string,
    snapshots: HeldChannel[],
    signal?: AbortSignal,
    check?: () => void,
    complete?: () => void,
  ): Promise<void> {
    const active = () => {
      check?.();
      requireSafe(!signal?.aborted, 'SECURITY_RECOVERY_CANCELLED');
      requireSafe(this.store.accountOwnId() === ownId, 'ACCOUNT_CHANGED');
    };
    const unchanged = () => {
      active();
      for (const { channel, revision } of snapshots) {
        requireSafe(securityRevision(this.store, channel) === revision, 'SECURITY_RECOVERY_CHANGED');
      }
    };
    unchanged();
    await this.open('headless', signal);
    const epoch = this.ownerEpoch;
    await this.actor.run(async () => {
      const sameWorker = () => {
        active();
        requireSafe(this.resourceIdentity().open && this.ownerEpoch === epoch, 'BROWSER_CLOSED');
      };
      for (const { channel } of snapshots) {
        unchanged();
        sameWorker();
        const identity = await this.invoke(channel, () => this.host.identity(channel, ownId));
        requireSafe(identity?.ownId === ownId, 'ACCOUNT_CHANGED');
      }
      this.store.db.transaction(() => {
        unchanged();
        sameWorker();
        for (const { channel, hold } of snapshots) {
          if (hold) {
            requireSafe(resolveSecurityHold(this.store, channel, hold.revision, undefined, sameWorker), 'SECURITY_RECOVERY_CHANGED');
          }
        }
        complete?.();
      }).immediate();
    });
  }

  async observe(store: EventStore, source: ObservationSource, signal?: AbortSignal) {
    this.bindStore(store);
    const channel: Channel = source === 'dm' ? 'DIRECT_MESSAGE' : 'COMMENT_NOTIFICATION';
    assertSecurityChannelClear(store, channel);
    await this.open('headless', signal);
    return this.actor.run(async () => {
      const newEventIds: string[] = [];
      for (let index = 0; ; index++) {
        signal?.throwIfAborted();
        assertSecurityChannelClear(store, channel);
        const batch = await this.invoke(channel, () => this.host.observe({ accountId: this.accountId, source, index }));
        signal?.throwIfAborted();
        assertSecurityChannelClear(store, channel);
        if (!batch) break;
        const ownId = store.accountOwnId();
        requireSafe(!ownId || ownId === batch.ownId, 'ACCOUNT_CHANGED');
        const observedAt = new Date().toISOString();
        const boundary = this.firstRunAt !== undefined
          ? Math.max(1, Math.min(Math.trunc(this.firstRunAt), Date.parse(observedAt)))
          : undefined;
        newEventIds.push(...store.observe(channel, batch.scope, batch.events, batch.ownId, batch.evidenceId, observedAt, boundary));
      }
      return { newEventIds };
    }, 'background');
  }

  async collect(data: AutomationStore, source: CollectionSource, signal: AbortSignal): Promise<void> {
    const config = data.state().collection;
    requireSafe(config && (source === 'dm' ? config.inbox : config.comments), 'COLLECTION_NOT_CONFIGURED');
    data.requireAccount(config.ownId);
    await this.observe(data.store, source, signal);
  }

  private async assertCalibratedIfBrowser(): Promise<string | undefined> {
    if (this.mode !== 'browser') return undefined;
    const mapping = await requireCalibratedWebReplyMapping(this.root, this.platformId, { allowFixture: this.allowFixture });
    return digest(mapping);
  }

  async adapter(
    event: InboundEvent,
    store = this.store,
    signal?: AbortSignal,
    options: AdapterOptions = {},
  ): ReturnType<PlatformConnector['adapter']> {
    this.bindStore(store);
    requireSafe(event.accountId === this.accountId, 'ACCOUNT_CHANGED');
    requireSafe(!options.manualMedia, 'WORKER_MANUAL_MEDIA_UNAVAILABLE');
    assertSecurityChannelClear(store, event.channel);
    await this.assertCalibratedIfBrowser();
    await this.open('headless', options.readonlySignal ?? signal);
    const ownId = store.accountOwnId();
    requireSafe(ownId, 'ACCOUNT_CHANGED');
    const epoch = this.ownerEpoch;
    const target = { handleId: randomUUID(), event, ownId };
    const binding = eventBinding(event);
    const eventId = store.db.prepare('SELECT id FROM inbound_events WHERE account_id=? AND channel=? AND source_key=?')
      .pluck().get(this.accountId, event.channel, event.platformEventId);
    requireSafe(typeof eventId === 'string' && store.event(eventId).binding === binding, 'NATIVE_REPLY_ORIGINAL_CHANGED');
    let disposed = false;
    let snapshot: TargetSnapshot | undefined;
    let inspectedMappingDigest: string | undefined;
    let text: string | undefined;
    let intentId: string | undefined;
    const active = (current = event) => {
      requireSafe(!disposed && this.resourceIdentity().open && this.ownerEpoch === epoch, 'BROWSER_CLOSED');
      (options.readonlySignal ?? signal)?.throwIfAborted();
      requireSafe(eventBinding(current) === binding && store.event(eventId).binding === binding, 'NATIVE_REPLY_ORIGINAL_CHANGED');
    };
    const check = (current = event) => { active(current); assertSecurityChannelClear(store, event.channel); };
    const invoke = <T>(call: () => Promise<T>) => this.invoke(event.channel, call);
    return {
      adapter: {
        inspect: async current => {
          check(current);
          inspectedMappingDigest = await this.assertCalibratedIfBrowser();
          snapshot = await invoke(() => this.host.inspectTarget(target));
          check(current);
          requireSafe(
            snapshot.eventBinding === binding
            && snapshot.accountId === this.accountId
            && snapshot.ownId === ownId
            && snapshot.targetKey === targetKey(event),
            'INTENT_BINDING_CHANGED',
          );
          return snapshot;
        },
        prepare: async (current, approvedText) => {
          check(current);
          const currentMappingDigest = await this.assertCalibratedIfBrowser();
          if (inspectedMappingDigest && currentMappingDigest) {
            requireSafe(currentMappingDigest === inspectedMappingDigest, 'TARGET_CHANGED_REAPPROVE');
          }
          requireSafe(snapshot && !options.readonlySignal, 'WORKER_NOT_PREPARED');
          await invoke(() => this.host.prepareSend(digest(snapshot), target, approvedText));
          text = approvedText;
        },
        verifyPrepared: async (current, approvedText) => {
          check(current);
          return invoke(() => this.host.verifyPrepared(target, approvedText));
        },
        baseline: async current => {
          check(current);
          return invoke(() => this.host.baseline(target));
        },
        clickOnce: async (notBefore, authorize) => {
          check();
          const currentMappingDigest = await this.assertCalibratedIfBrowser();
          if (inspectedMappingDigest && currentMappingDigest) {
            requireSafe(currentMappingDigest === inspectedMappingDigest, 'TARGET_CHANGED_REAPPROVE');
          }
          requireSafe(snapshot && text !== undefined && notBefore && authorize && !options.readonlySignal, 'WORKER_NOT_PREPARED');
          const approvedText = text;
          const targetDigest = digest(snapshot);
          const row = findWorkerIntent(store, notBefore, targetDigest, workerTextDigest(approvedText), { eventId });
          const ownership = () => hasTable(store, 'thread_ownership')
            ? store.db.prepare(
              'SELECT generation FROM thread_ownership WHERE account_id=? AND channel=? AND target_key=?',
            ).pluck().get(this.accountId, event.channel, targetKey(event))
            : undefined;
          const generation = ownership();
          const validate = () => {
            check();
            authorize();
            requireSafe(!isEmergencyStopped(store), 'EMERGENCY_STOPPED');
            if (hasTable(store, 'client_state')) requireSafe(!store.clientState().paused, 'ACCOUNT_PAUSED');
            store.assertTargetUnpaused(targetKey(event));
            requireSafe(ownership() === generation, 'OWNERSHIP_CHANGED');
            if (row.operator_id && hasTable(store, 'operator_sessions')) {
              requireSafe(
                store.db.prepare('SELECT 1 FROM operator_sessions WHERE id=? AND expires_at>?').get(row.operator_id, Date.now()),
                'OPERATOR_EXPIRED',
              );
            }
          };
          validate();
          intentId = row.id;
          this.activeSend = { intentId: row.id, validate };
          const monitor = setInterval(() => this.recheckInFlight(), 25);
          const onAbort = () => this.abortInFlight();
          const detachEmergency = onEmergencyStop(store, onAbort);
          signal?.addEventListener('abort', onAbort, { once: true });
          try {
            await invoke(() => this.host.executeSend({
              intentId: row.id,
              notBefore,
              text: approvedText,
              targetDigest,
              permitExpiresAt: Date.now() + 1_500,
            }));
          } finally {
            clearInterval(monitor);
            detachEmergency();
            signal?.removeEventListener('abort', onAbort);
            this.activeSend = undefined;
          }
        },
        readback: async (current, approvedText, baseline, notBefore) => {
          requireSafe(!disposed && this.host.pid && this.ownerEpoch === epoch && eventBinding(current) === binding, 'BROWSER_CLOSED');
          if (!intentId) return null;
          const result = await invoke(() => this.host.readback({
            target,
            intentId: intentId!,
            baseline,
            notBefore,
            text: approvedText,
          }));
          return result.verified ? result.proof ?? null : null;
        },
        cancelPreparation: async () => {
          if (this.host.pid && this.ownerEpoch === epoch) await this.host.cancelPreparation(target.handleId);
        },
      },
      dispose: async () => {
        disposed = true;
        if (this.host.pid && this.ownerEpoch === epoch) await this.host.disposeTarget(target.handleId);
      },
    };
  }

  async verifyExisting(
    store: EventStore,
    eventId: string,
    options: VerificationOptions = {},
  ): Promise<VerificationResult> {
    this.bindStore(store);
    requireSafe(!options.signal?.aborted, 'COLLECTION_CANCELLED');
    const event = store.event(eventId);
    const draft = store.db.prepare('SELECT id FROM reply_drafts WHERE event_id=?').get(eventId) as { id: string } | undefined;
    const intent = store.db.prepare('SELECT id FROM send_intents WHERE event_id=?').get(eventId) as { id: string } | undefined;
    assertSecurityChannelClear(store, event.payload.channel);
    if (options.commentDraftId !== undefined) {
      requireSafe(event.payload.channel === 'COMMENT_NOTIFICATION' && draft?.id === options.commentDraftId, 'COMMENT_REPLY_SCOPE_REQUIRED');
    }
    requireSafe(draft && intent, options.commentDraftId !== undefined ? 'COMMENT_REPLY_INTENT_REQUIRED' : 'INTENT_REQUIRED');
    const ownId = store.accountOwnId();
    requireSafe(ownId, 'ACCOUNT_CHANGED');
    await this.assertCalibratedIfBrowser();
    await this.open('headless', options.signal);
    const epoch = this.ownerEpoch;
    const current = store.draft(draft.id);
    const notBefore = store.intentBoundary(intent.id);
    const target = { handleId: randomUUID(), event: event.payload, ownId };
    const result = await this.actor.run(async () => {
      requireSafe(!options.signal?.aborted, 'COLLECTION_CANCELLED');
      requireSafe(this.resourceIdentity().open && this.ownerEpoch === epoch, 'BROWSER_CLOSED');
      return this.invoke(event.payload.channel, () => this.host.verifyExisting({
        target,
        text: current.text,
        notBefore,
      }));
    }, options.background ? 'background' : 'interactive');
    requireSafe(!options.signal?.aborted, 'VERIFICATION_CANCELLED');
    requireSafe(this.resourceIdentity().open && this.ownerEpoch === epoch, 'BROWSER_CLOSED');
    assertSecurityChannelClear(store, event.payload.channel);
    const proof = result.verified ? result.proof : null;
    const rawVersion = this.status().version;
    const browserVersion = rawVersion && /^\d+\.\d+\.\d+\.\d+$/.test(rawVersion) ? rawVersion : '0.0.0.0';
    const evidenceId = await recordEvidence(join(this.root, 'evidence'), {
      caseId: event.payload.channel === 'DIRECT_MESSAGE' ? 'D05' : 'C05',
      browserVersion,
      mode: 'headless',
      taskId: evidenceSchema.shape.taskId.safeParse(eventId).success ? eventId : null,
      action: 'OBSERVE',
      result: proof ? 'PASS' : 'BLOCKED',
      source: 'AUTOMATED_REAL',
      diagnostics: ['CLIENT_READ_ONLY_RECHECK', 'ORIGINAL_RECEIPTS_RETAINED'],
      proofDigest: proof ? digest(proof) : null,
    });
    return { verified: Boolean(proof), evidenceId, ...(proof ? { nativeIdDigest: digest(proof.id) } : {}) };
  }

  private async invoke<T>(channel: Channel, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof Blocked && error.code === 'WORKER_BROWSER_CLOSED') this.workerState = undefined;
      if (error instanceof Blocked && error.code === 'OBSERVATION_SECURITY_SUSPECT') {
        holdSecurityChannel(this.store, channel, { incidentId: randomUUID(), reason: error.code, mode: 'headless' });
      }
      throw error;
    }
  }
}
