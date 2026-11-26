import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AccountActor } from '../browser/account-actor.js';
import { Blocked, DEFAULT_ACCOUNT_ID, MOCK_PLATFORM_ID, digest, eventBinding, requireSafe, targetKey,
  type AccountId, type AccountsCommand, type AccountSummary, type Channel, type Draft, type InboundEvent, type TargetSnapshot,
} from '../core/contracts.js';
import type { BrowserMode } from '../contracts/browser-resources.js';
import type { WorkerSendBinding } from '../contracts/browser-worker.js';
import type { ManualRecoveryCommand, ManualRecoveryResult } from '../contracts/manual-recovery.js';
import { DOUYIN_PLATFORM_ID, DouyinPlatformConnector, douyinCapabilities } from '../platform/douyin-platform-connector.js';
import { MockPlatformConnector, mockCapabilities } from '../platform/mock-platform-connector.js';
import { PlatformConnectorRegistry } from '../platform/platform-connector-registry.js';
import type { AdapterOptions, CapabilityIdentity, CollectionSource, ObservationSource, PlatformConnector } from '../platform/platform-connector.js';
import { AccountStore } from '../storage/account-store.js';
import type { AutomationStore } from '../storage/automation-store.js';
import { isEmergencyStopped, onEmergencyStop } from '../storage/emergency-stop.js';
import { assertSecurityChannelClear, holdSecurityChannel, readSecurityHold, resolveSecurityHold, securityRevision } from '../storage/security-holds.js';
import type { EventStore } from '../storage/store.js';
import { BrowserWorkerHost, type WorkerDispatchLedger } from '../workers/browser-worker-host.js';
import { workerTextDigest, type WorkerMode, type WorkerStatus } from '../workers/worker-protocol.js';
import { BrowserService } from './browser-service.js';
import type { WorkbenchAuthority } from './authority.js';
import type { ClientCommand } from './contracts.js';
import { MockAccountRuntime, type SharedMockModels } from './mock-account-runtime.js';

type RegisterAccount = Extract<AccountsCommand, { action: 'registerAccount' }>;
type DisconnectAccount = Extract<AccountsCommand, { action: 'disconnectAccount' }>;

function copyCapabilities(capabilities: PlatformConnector['capabilities']): AccountSummary['capabilities'] {
  return { ...capabilities, channels: [...capabilities.channels] };
}

export function isAccountWrite(command: AccountsCommand): command is RegisterAccount | DisconnectAccount {
  return command.action === 'registerAccount' || command.action === 'disconnectAccount';
}

function hasTable(store: EventStore, table: string): boolean {
  return !!store.db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name=?").get(table);
}

export function findProtocolCommand(storage: AccountStore, commandId: string) {
  const exact = storage.getProtocolCommand(commandId);
  if (exact) return exact;
  // Older ledgers accepted uppercase UUIDs. Look them up without rewriting historic results.
  const legacy = storage.db.prepare('SELECT command_id FROM protocol_v2_commands WHERE lower(command_id)=? LIMIT 1')
    .pluck().get(commandId);
  return typeof legacy === 'string' ? storage.getProtocolCommand(legacy) : null;
}

export function auditPage(store: EventStore, page: number) {
  const followups = hasTable(store, 'human_reply_turns') ? `
    UNION ALL SELECT t.command_id,e.account_id FROM human_reply_turns t JOIN inbound_events e ON e.id=t.event_id
    UNION ALL SELECT t.intent_id,e.account_id FROM human_reply_turns t JOIN inbound_events e ON e.id=t.event_id
  ` : '';
  const explicit = hasTable(store, 'account_audit_links');
  const legacy = store.accountId === DEFAULT_ACCOUNT_ID && hasTable(store, 'schema4_migration_meta');
  const items = store.db.prepare(`WITH subjects(entity, account) AS (
    SELECT id,id FROM accounts
    UNION ALL SELECT id,account_id FROM inbound_events
    UNION ALL SELECT d.id,e.account_id FROM reply_drafts d JOIN inbound_events e ON e.id=d.event_id
    UNION ALL SELECT i.id,e.account_id FROM send_intents i JOIN inbound_events e ON e.id=i.event_id
    UNION ALL SELECT s.id,e.account_id FROM ai_suggestions s JOIN inbound_events e ON e.id=s.event_id
    UNION ALL SELECT c.command_id,e.account_id FROM manual_send_commands c JOIN inbound_events e ON e.id=c.event_id
    UNION ALL SELECT id||':DIRECT_MESSAGE',id FROM accounts
    UNION ALL SELECT id||':COMMENT_NOTIFICATION',id FROM accounts
    ${followups}
  )
    SELECT a.time,a.event_type,a.entity_id,a.detail_redacted FROM audit_events a
    ${explicit ? 'LEFT JOIN account_audit_links l ON l.audit_id=a.id' : ''}
    WHERE ${explicit ? 'l.account_id=@account OR (l.audit_id IS NULL AND (' : ''}
      NOT EXISTS (SELECT 1 FROM subjects WHERE entity=a.entity_id AND account<>@account)
      AND COALESCE(CASE WHEN json_valid(a.detail_redacted) THEN json_extract(a.detail_redacted,'$.accountId') END,@account)=@account
      AND (EXISTS (SELECT 1 FROM subjects WHERE entity=a.entity_id AND account=@account)
        OR (CASE WHEN json_valid(a.detail_redacted) THEN json_extract(a.detail_redacted,'$.accountId') END)=@account
        ${legacy ? 'OR a.time < (SELECT upgraded_at FROM schema4_migration_meta WHERE id=1)' : ''})
    ${explicit ? '))' : ''}
    ORDER BY a.rowid DESC LIMIT 50 OFFSET @offset`)
    .all({ account: store.accountId, offset: page * 50 });
  return { items, page };
}

export class AccountController {
  readonly updates = new EventEmitter();
  private accountStore: AccountStore | null = null;
  private registry = new PlatformConnectorRegistry();
  private readonly temporary = new Map<AccountId, MockPlatformConnector>();
  private readonly mockRuntimes = new Map<AccountId, MockAccountRuntime>();

  constructor(private readonly events: EventStore, private readonly primary: PlatformConnector,
    private readonly now: () => number, private readonly primaryAuthority: WorkbenchAuthority,
    private readonly sharedModels: () => SharedMockModels) {
    this.registry.register(primary);
  }

  get schemaVersion(): number { return this.events.db.pragma('user_version', { simple: true }) as number; }

  get storage(): AccountStore | null {
    if (this.schemaVersion !== 4) return null;
    return this.accountStore ??= new AccountStore(this.events.db, this.now);
  }

  initialize(): void {
    for (const account of this.storage?.listAccounts() ?? []) this.attachMock(account);
  }

  getMockConnector(accountId: AccountId): MockPlatformConnector | undefined {
    return this.temporary.get(accountId);
  }

  securityStatus(accountId: AccountId) {
    return {
      securityHolds: readAccountHolds({ accountId, db: this.events.db }),
      manualRecovery: accountId === this.primary.accountId ? this.primary.manualRecoveryStatus() : null,
    };
  }

  async dispatchMock(accountId: AccountId, parentToken: string, command: ClientCommand): Promise<unknown> {
    const account = this.storage?.getAccount(accountId);
    requireSafe(account, 'ACCOUNT_NOT_FOUND');
    requireSafe(account.status === 'ACTIVE', account.status === 'DISCONNECTED' ? 'ACCOUNT_DISCONNECTED' : 'ACCOUNT_NOT_ACTIVE');
    const connector = this.getMockConnector(accountId);
    requireSafe(this.usesMock(account) && connector, 'ACCOUNT_COMMAND_NOT_SUPPORTED');
    const operator = this.primaryAuthority.requireGuiControl(parentToken, 'READ');
    let runtime = this.mockRuntimes.get(accountId);
    if (!runtime) {
      runtime = new MockAccountRuntime(this.events.db.name, connector, this.now, this.sharedModels,
        event => this.updates.emit('update', accountId, { event }), auditPage);
      this.mockRuntimes.set(accountId, runtime);
    }
    return runtime.dispatch(operator, command, () => { this.primaryAuthority.operator(parentToken, 'READ'); });
  }

  hasMultipleActiveAccounts(): boolean {
    if (!this.storage) return false;
    return !!this.events.db.prepare("SELECT 1 FROM accounts WHERE status='ACTIVE' LIMIT 1 OFFSET 1").get();
  }

  abortWorkerSends(): void {
    if (this.primary instanceof IsolatedDouyinConnector) this.primary.abortInFlight();
  }

  recheckWorkerSend(): void {
    if (this.primary instanceof IsolatedDouyinConnector) this.primary.recheckInFlight();
  }

  validateProtocolWrite(command: AccountsCommand): void {
    if (!isAccountWrite(command)) return;
    const storage = this.storage;
    const previous = storage && findProtocolCommand(storage, command.commandId.toLowerCase());
    if (!previous) return;
    // Match the existing AccountStore digest format, including records written by v1.
    const { action } = command;
    const accountRef = action === 'disconnectAccount' ? command.accountRef : null;
    const requestDigest = action === 'disconnectAccount' ? digest([accountRef, command.confirmed]) :
      digest([command.platform, command.connector, command.accountId, command.ownId, command.displayLabel, command.profileRef]);
    requireSafe(previous.command === 'accounts' && previous.action === action && previous.accountRef === accountRef &&
      previous.scopeKind === (accountRef === null ? 'GLOBAL' : 'ACCOUNT') && previous.requestDigest === requestDigest, 'COMMAND_ID_CONFLICT');
  }

  async dispatch(command: AccountsCommand): Promise<unknown> {
    const storage = this.storage;
    if (command.action === 'listAccounts') {
      return { accounts: (storage?.listAccounts() ?? []).map(account => this.withCapabilities(account)),
        schemaVersion: this.schemaVersion };
    }
    requireSafe(storage, 'SCHEMA4_REQUIRED');
    if (isAccountWrite(command)) command = { ...command, commandId: command.commandId.toLowerCase() };
    switch (command.action) {
      case 'registerAccount': {
        const account = this.change(storage, command, (_fresh, commandId) => {
          requireSafe(command.ownId === undefined || command.ownId.trim(), 'ACCOUNT_REQUIRED');
          return storage.registerAccount({ ...command, commandId });
        }, 'ACCOUNT_REGISTERED');
        const current = storage.getAccount(account.id)!;
        this.attachMock(current);
        // Registration replays describe the original registration, even after a later disconnect.
        return this.usesMock(account) ? { ...account, capabilities: copyCapabilities(mockCapabilities) } : account;
      }
      case 'getAccountStatus': {
        const account = storage.getAccount(command.accountRef);
        requireSafe(account, 'ACCOUNT_NOT_FOUND');
        const connector = this.connectorFor(account);
        const connectorState = connector?.status().state ?? (account.status === 'DISCONNECTED' ? 'DISCONNECTED' : 'UNAVAILABLE');
        return { ...this.withCapabilities(account, connector), connected: connectorState !== 'ACCOUNT_CHANGED' &&
          (connector?.resourceIdentity().open ?? false), connectorState };
      }
      case 'disconnectAccount': {
        requireSafe(command.confirmed === true, 'ACCOUNT_DISCONNECT_CONFIRMATION_REQUIRED');
        const connector = this.temporary.get(command.accountRef);
        const runtime = this.mockRuntimes.get(command.accountRef);
        const account = this.change(storage, command, (fresh, commandId) => {
          if (fresh) {
            requireSafe(command.accountRef !== DEFAULT_ACCOUNT_ID && command.accountRef !== this.primary.accountId,
              'PRIMARY_ACCOUNT_DISCONNECT_BLOCKED');
            requireSafe((!connector || connector.isIdle()) && (!runtime || runtime.isIdle()) && !this.hasInFlightIntent(command.accountRef),
              'ACCOUNT_OPERATION_IN_PROGRESS');
          }
          return storage.disconnectAccount({ ...command, commandId });
        }, 'ACCOUNT_DISCONNECTED');
        if (connector) {
          this.temporary.delete(account.id);
          this.mockRuntimes.delete(account.id);
          this.rebuildRegistry();
          await (runtime?.close() ?? connector.close());
        }
        return account;
      }
    }
  }

  private change(storage: AccountStore, command: RegisterAccount | DisconnectAccount,
    write: (fresh: boolean, commandId: string) => AccountSummary, audit: string): AccountSummary {
    const outcome = storage.db.transaction(() => {
      const previous = findProtocolCommand(storage, command.commandId);
      const fresh = !previous;
      let account: AccountSummary;
      try { account = write(fresh, previous?.commandId ?? command.commandId); }
      catch (error) {
        // AccountStore persists terminal business failures. Commit that record with no account change.
        if (error instanceof Blocked) return error;
        throw error;
      }
      if (fresh) writeAccountAudit(this.events, audit, account.id, account.id);
      return account;
    }).immediate();
    if (outcome instanceof Blocked) throw outcome;
    return outcome;
  }

  private hasInFlightIntent(accountId: AccountId): boolean {
    const { db } = this.events;
    if (db.prepare(`SELECT 1 FROM send_intents i JOIN inbound_events e ON e.id=i.event_id
      WHERE e.account_id=? AND i.status='INTENT_RECORDED' LIMIT 1`).get(accountId)) return true;
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='human_reply_turns'").get()) return false;
    return !!db.prepare(`SELECT 1 FROM human_reply_turns t JOIN inbound_events e ON e.id=t.event_id
      WHERE e.account_id=? AND t.status='INTENT_RECORDED' LIMIT 1`).get(accountId);
  }

  private usesMock(account: AccountSummary): boolean {
    return account.platform === MOCK_PLATFORM_ID && account.connector === MOCK_PLATFORM_ID;
  }

  private attachMock(account: AccountSummary): void {
    if (account.status !== 'ACTIVE' || !this.usesMock(account) || account.id === this.primary.accountId ||
      this.temporary.has(account.id)) return;
    const connector = new MockPlatformConnector({ accountId: account.id, ownId: account.ownId ?? account.id });
    this.registry.register(connector);
    this.temporary.set(account.id, connector);
  }

  private connectorFor(account: AccountSummary): PlatformConnector | undefined {
    if (account.status === 'DISCONNECTED') return;
    if ((account.id === this.primary.accountId && account.platform === this.primary.platformId) || this.temporary.has(account.id)) {
      return this.registry.resolve(account.platform, account.id);
    }
  }

  private withCapabilities(account: AccountSummary, connector = this.connectorFor(account)): AccountSummary {
    return connector ? { ...account, capabilities: copyCapabilities(connector.capabilities) } : account;
  }

  private rebuildRegistry(): void {
    this.registry = new PlatformConnectorRegistry();
    this.registry.register(this.primary);
    for (const connector of this.temporary.values()) this.registry.register(connector);
  }

  async close(): Promise<void> {
    const closing = [...this.temporary].map(([id, connector]) => this.mockRuntimes.get(id)?.close() ?? connector.close());
    this.temporary.clear();
    this.mockRuntimes.clear();
    this.rebuildRegistry();
    await Promise.all(closing);
  }
}

function writeAccountAudit(store: EventStore, event: string, entity: string, account: string, detail = {}): void {
  const id = randomUUID();
  store.db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?)')
    .run(id, new Date().toISOString(), event, entity, JSON.stringify(detail));
  if (hasTable(store, 'account_audit_links')) {
    store.db.prepare('INSERT INTO account_audit_links (audit_id, account_id) VALUES (?,?)').run(id, account);
  }
}

type WorkerIntent = {
  id: string; event_id: string; channel: Channel; target_key: string; target_digest: string | null;
  text_digest: string | null; text: string; version: number; approval: string | null;
  draft_id: string | null; operator_id: string | null;
};

function workerIntent(store: EventStore, notBefore: string, targetDigest: string, textDigest: string,
  filter: { eventId: string } | { intentId: string }): WorkerIntent {
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
    ${followup}`).all({ accountId, notBefore, id: byEvent ? filter.eventId : filter.intentId }) as WorkerIntent[];
  const matches = rows.filter(row => {
    if (!row.approval || workerTextDigest(row.text) !== textDigest) return false;
    const approval = JSON.parse(row.approval) as Draft['approval'];
    return approval && approval.version === row.version && approval.textDigest === digest(row.text) &&
      approval.snapshot.targetKey === row.target_key && approval.snapshot.eventBinding === store.event(row.event_id).binding &&
      approval.snapshot.accountId === accountId && digest(approval.snapshot) === targetDigest &&
      (row.draft_id === null || (row.target_digest === targetDigest && row.text_digest === approval.textDigest));
  });
  const [match] = matches;
  requireSafe(match && matches.length === 1, 'INTENT_BINDING_CHANGED');
  return match;
}

export function createWorkerDispatchLedger(store: EventStore): WorkerDispatchLedger {
  const hasDispatched = (intentId: string) => !!store.db.prepare(
    "SELECT 1 FROM audit_events WHERE event_type='BROWSER_WORKER_DISPATCHED' AND entity_id=? LIMIT 1",
  ).get(intentId);
  return {
    hasDispatched,
    recordDispatched: store.db.transaction((binding: WorkerSendBinding) => {
      requireSafe(!hasDispatched(binding.intentId), 'WORKER_CRASH_NO_REPLAY');
      const row = workerIntent(store, binding.notBefore, binding.targetDigest, binding.textDigest, { intentId: binding.intentId });
      assertSecurityChannelClear(store, row.channel);
      writeAccountAudit(store, 'BROWSER_WORKER_DISPATCHED', binding.intentId, store.accountId, binding);
    }).immediate,
  };
}

export function runtimeWorkerMode(store: EventStore, override = process.env.INBORA_BROWSER_WORKER): WorkerMode | undefined {
  if (override === '1') return 'browser';
  // ADR-001: preserve the single-browser recovery path. Synthetic accounts own no browser.
  if (store.schemaVersion() === 4 && store.db.prepare(`SELECT 1 FROM accounts
    WHERE status='ACTIVE' AND platform=? AND connector=? LIMIT 1 OFFSET 1`).get(DOUYIN_PLATFORM_ID, DOUYIN_PLATFORM_ID)) return 'browser';
}

export function createRuntimeConnector(root: string, store: EventStore, workerMode: WorkerMode): IsolatedDouyinConnector;
export function createRuntimeConnector(root: string, store: EventStore): PlatformConnector;
export function createRuntimeConnector(root: string, store: EventStore, workerMode = runtimeWorkerMode(store)): PlatformConnector {
  if (!workerMode) return new DouyinPlatformConnector(new BrowserService(root, undefined, store.accountId));
  const profileDir = join(root, 'profile');
  let connector: IsolatedDouyinConnector | undefined;
  const host = new BrowserWorkerHost({
    profileDir, mode: workerMode, ledger: createWorkerDispatchLedger(store),
    onPermitCheck: binding => connector?.permitActiveSend(binding) ?? false,
  });
  connector = new IsolatedDouyinConnector(root, store, host, profileDir);
  return connector;
}

const recoveryChannels = ['DIRECT_MESSAGE', 'COMMENT_NOTIFICATION'] as const;
type HeldChannel = ReturnType<typeof recoverySnapshot>;
type RecoveryStatus = {
  securityHolds: NonNullable<HeldChannel['hold']>[];
  manualRecovery: ReturnType<IsolatedDouyinConnector['manualRecoveryStatus']>;
};
function recoverySnapshot(store: EventStore, channel: Channel) {
  return { channel, revision: securityRevision(store, channel), hold: readSecurityHold(store, channel) };
}

function readAccountHolds(store: Pick<EventStore, 'accountId' | 'db'>) {
  return recoveryChannels.flatMap(channel => readSecurityHold(store, channel) ?? []);
}

/** Core owns approvals, account state and storage. Only the Worker touches browser pages. */
class IsolatedDouyinConnector implements PlatformConnector {
  readonly platformId = DOUYIN_PLATFORM_ID;
  readonly capabilities = { ...douyinCapabilities, loginRecovery: false, manualSecurityRecovery: true, preview: false };
  readonly actor = new AccountActor();
  readonly loginRecovery = false;
  onManualRecoveryClosed = () => {};
  private workerState: WorkerStatus | undefined;
  private opening: Promise<void> | undefined;
  private closing = false;
  private readonly identities = new Map<Channel, CapabilityIdentity>();
  private activeSend: { intentId: string; validate: () => void } | undefined;
  private recovery?: { id: string; token: string; ownId: string; snapshot: HeldChannel };

  constructor(readonly root: string, private readonly store: EventStore, private readonly host: BrowserWorkerHost,
    private readonly profileDir: string) {}

  get accountId() { return this.store.accountId; }
  get ownerEpoch() { return this.host.ownerEpoch; }
  status() {
    return { state: this.resourceIdentity().open ? 'OPEN_IDENTITY_UNVERIFIED' : 'CLOSED',
      mode: 'headless' as const, version: this.host.pid ? this.workerState?.version ?? null : null };
  }
  resourceIdentity() {
    const open = !!this.host.pid && this.workerState?.state === 'OPEN' && !this.closing;
    return { open, epoch: this.ownerEpoch, mode: 'headless' as const, pageCount: open ? this.workerState?.pageCount ?? 0 : 0 };
  }
  isIdle() { return this.actor.idle && !this.opening && !this.closing; }
  abortInFlight() { this.host.abortInFlight(); }
  recheckInFlight() {
    try { this.activeSend?.validate(); }
    catch { this.abortInFlight(); }
  }
  permitActiveSend(binding: Readonly<WorkerSendBinding>): boolean {
    if (!this.activeSend || this.activeSend.intentId !== binding.intentId) return false;
    this.activeSend.validate();
    return true;
  }
  bindStore(store: EventStore) { requireSafe(store === this.store, 'ACCOUNT_CHANGED'); }
  setRuntimeInstance(_instanceId: string | null) {}
  get manualRecoveryActive() { return this.recovery !== undefined; }
  manualRecoveryStatus() {
    const hold = this.recovery?.snapshot.hold;
    return hold ? { active: true as const, channel: hold.channel, incidentId: hold.incidentId } : null;
  }
  async closeManualRecovery() {
    if (!this.recovery) return;
    delete this.recovery;
    this.onManualRecoveryClosed();
  }
  async recoverSecurityHolds(force = false, signal?: AbortSignal, check?: () => void) {
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
  async finishLoginRecovery() { return false; }
  async completeLoginIfVerified() { return false; }
  async openStoredMessage(): Promise<never> { throw new Blocked('WORKER_MANUAL_RECOVERY_UNAVAILABLE'); }
  async securityRecovery(command: ManualRecoveryCommand, token: string, check: () => void): Promise<ManualRecoveryResult>;
  async securityRecovery(command: { command: 'securityRecovery'; action: 'status' }, token: string, check: () => void): Promise<RecoveryStatus>;
  async securityRecovery(command: ManualRecoveryCommand | { action: 'status' }, token: string, check: () => void):
    Promise<ManualRecoveryResult | RecoveryStatus> {
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
      requireSafe(!session || session.token === token && session.snapshot.channel === command.channel,
        'MANUAL_RECOVERY_ALREADY_ACTIVE');
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
  async workUrl() { return null; }
  prioritizePreview() {}
  prioritizeDisplayPreview() { return false; }
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
    const identity = await this.invoke(channel, () => this.host.identity(channel, this.store.accountOwnId()));
    if (!identity) return null;
    const { ownId, ...proof } = identity;
    const capability = { ...proof, identityDigest: digest(ownId), browserMode: 'headless' as const };
    this.identities.set(channel, capability);
    return capability;
  }

  async verifyEmergencyRecovery(ownId: string, signal: AbortSignal, check: () => void, complete?: () => void) {
    const snapshots = recoveryChannels.map(channel => recoverySnapshot(this.store, channel));
    await this.verifyRecovery(ownId, snapshots, signal, check, complete);
  }

  private async verifyRecovery(ownId: string, snapshots: HeldChannel[], signal?: AbortSignal, check?: () => void,
    complete?: () => void) {
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
          if (hold) requireSafe(resolveSecurityHold(this.store, channel, hold.revision, undefined, sameWorker),
            'SECURITY_RECOVERY_CHANGED');
        }
        complete?.();
      }).immediate();
    });
  }

  async observe(store: EventStore, source: ObservationSource, signal?: AbortSignal) {
    this.bindStore(store);
    const channel = source === 'dm' ? 'DIRECT_MESSAGE' : 'COMMENT_NOTIFICATION';
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
        newEventIds.push(...store.observe(channel, batch.scope, batch.events, batch.ownId, batch.evidenceId));
      }
      return { newEventIds };
    }, 'background');
  }

  async collect(data: AutomationStore, source: CollectionSource, signal: AbortSignal) {
    const config = data.state().collection;
    requireSafe(config && (source === 'dm' ? config.inbox : config.comments), 'COLLECTION_NOT_CONFIGURED');
    data.requireAccount(config.ownId);
    await this.observe(data.store, source, signal);
  }

  async adapter(event: InboundEvent, store = this.store, signal?: AbortSignal, options: AdapterOptions = {}):
  ReturnType<PlatformConnector['adapter']> {
    this.bindStore(store);
    requireSafe(event.accountId === this.accountId, 'ACCOUNT_CHANGED');
    requireSafe(!options.manualMedia, 'WORKER_MANUAL_MEDIA_UNAVAILABLE');
    assertSecurityChannelClear(store, event.channel);
    await this.open('headless', options.readonlySignal ?? signal);
    const ownId = store.accountOwnId();
    requireSafe(ownId, 'ACCOUNT_CHANGED');
    const epoch = this.ownerEpoch;
    const target = { handleId: randomUUID(), event, ownId };
    const binding = eventBinding(event);
    const eventId = store.db.prepare('SELECT id FROM inbound_events WHERE account_id=? AND channel=? AND source_key=?')
      .pluck().get(this.accountId, event.channel, event.platformEventId);
    requireSafe(typeof eventId === 'string' && store.event(eventId).binding === binding, 'NATIVE_REPLY_ORIGINAL_CHANGED');
    let disposed = false, snapshot: TargetSnapshot | undefined, text: string | undefined, intentId: string | undefined;
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
          snapshot = await invoke(() => this.host.inspectTarget(target));
          check(current);
          requireSafe(snapshot.eventBinding === binding && snapshot.accountId === this.accountId &&
            snapshot.ownId === ownId && snapshot.targetKey === targetKey(event), 'INTENT_BINDING_CHANGED');
          return snapshot;
        },
        prepare: async (current, approvedText) => {
          check(current);
          requireSafe(snapshot && !options.readonlySignal, 'WORKER_NOT_PREPARED');
          await invoke(() => this.host.prepareSend(digest(snapshot), target, approvedText));
          text = approvedText;
        },
        verifyPrepared: async (current, approvedText) => {
          check(current);
          return invoke(() => this.host.verifyPrepared(target, approvedText));
        },
        baseline: async current => { check(current); return invoke(() => this.host.baseline(target)); },
        clickOnce: async (notBefore, authorize) => {
          check();
          requireSafe(snapshot && text !== undefined && notBefore && authorize && !options.readonlySignal, 'WORKER_NOT_PREPARED');
          const approvedText = text, targetDigest = digest(snapshot);
          const row = workerIntent(store, notBefore, targetDigest, workerTextDigest(approvedText), { eventId });
          const ownership = () => hasTable(store, 'thread_ownership') ? store.db.prepare(`
            SELECT generation FROM thread_ownership WHERE account_id=? AND channel=? AND target_key=?
          `).pluck().get(this.accountId, event.channel, targetKey(event)) : undefined;
          const generation = ownership();
          const validate = () => {
            check();
            authorize();
            requireSafe(!isEmergencyStopped(store), 'EMERGENCY_STOPPED');
            if (hasTable(store, 'client_state')) requireSafe(!store.clientState().paused, 'ACCOUNT_PAUSED');
            store.assertTargetUnpaused(targetKey(event));
            requireSafe(ownership() === generation, 'OWNERSHIP_CHANGED');
            if (row.operator_id && hasTable(store, 'operator_sessions')) {
              requireSafe(store.db.prepare('SELECT 1 FROM operator_sessions WHERE id=? AND expires_at>?')
                .get(row.operator_id, Date.now()), 'OPERATOR_EXPIRED');
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
            await invoke(() => this.host.executeSend({ intentId: row.id, notBefore, text: approvedText, targetDigest,
              permitExpiresAt: Date.now() + 1_500 }));
          } finally {
            clearInterval(monitor);
            detachEmergency();
            signal?.removeEventListener('abort', onAbort);
            this.activeSend = undefined;
          }
        },
        readback: async (current, approvedText, baseline, notBefore) => {
          // Accepted submissions may finish readback after a global stop.
          requireSafe(!disposed && this.host.pid && this.ownerEpoch === epoch && eventBinding(current) === binding, 'BROWSER_CLOSED');
          if (!intentId) return null;
          const result = await invoke(() => this.host.readback({ target, intentId: intentId!, baseline, notBefore, text: approvedText }));
          return result.verified ? result.proof ?? null : null;
        },
        cancelPreparation: async () => { if (this.host.pid && this.ownerEpoch === epoch) await this.host.cancelPreparation(target.handleId); },
      },
      dispose: async () => {
        disposed = true;
        if (this.host.pid && this.ownerEpoch === epoch) await this.host.disposeTarget(target.handleId);
      },
    };
  }

  async verifyExisting() { return { verified: false, evidenceId: 'worker-no-bound-proof' }; }

  private async invoke<T>(channel: Channel, operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof Blocked && error.code === 'WORKER_BROWSER_CLOSED') this.workerState = undefined;
      if (error instanceof Blocked && error.code === 'OBSERVATION_SECURITY_SUSPECT') {
        holdSecurityChannel(this.store, channel, { incidentId: randomUUID(), reason: error.code, mode: 'headless' });
      }
      throw error;
    }
  }
}
