import { EventEmitter } from 'node:events';
import { isOfficialApiPlatform } from '../contracts/account.js';
import {
  Blocked, DEFAULT_ACCOUNT_ID, MOCK_PLATFORM_ID, digest, requireSafe,
  type AccountId, type AccountsCommand, type AccountSummary,
} from '../core/contracts.js';
import { MockPlatformConnector, mockCapabilities } from '../platform/mock-platform-connector.js';
import { PlatformConnectorRegistry } from '../platform/platform-connector-registry.js';
import type { PlatformConnector } from '../platform/platform-connector.js';
import { AccountStore } from '../storage/account-store.js';
import type { EventStore } from '../storage/store.js';
import type { WorkbenchAuthority } from './authority.js';
import type { ClientCommand } from './contracts.js';
import {
  createRuntimeConnector, createWorkerDispatchLedger, IsolatedDouyinConnector,
  readAccountHolds, runtimeWorkerMode, writeAccountAudit,
} from './isolated-douyin-connector.js';
import { MockAccountRuntime, type SharedMockModels } from './mock-account-runtime.js';
import { OfficialChannelManager, type OfficialChannelManagerOptions } from './official-channel-manager.js';

export { createRuntimeConnector, createWorkerDispatchLedger, runtimeWorkerMode };

type RegisterAccount = Extract<AccountsCommand, { action: 'registerAccount' }>;
type DisconnectAccount = Extract<AccountsCommand, { action: 'disconnectAccount' }>;
type ReactivateAccount = Extract<AccountsCommand, { action: 'reactivateAccount' }>;

function copyCapabilities(capabilities: PlatformConnector['capabilities']): AccountSummary['capabilities'] {
  return { ...capabilities, channels: [...capabilities.channels] };
}

export function isAccountWrite(command: AccountsCommand): boolean {
  return command.action !== 'listAccounts'
    && command.action !== 'getAccountStatus'
    && command.action !== 'getOfficialChannelConfig';
}

function isAccountLifecycleWrite(command: AccountsCommand): command is RegisterAccount | DisconnectAccount | ReactivateAccount {
  return command.action === 'registerAccount'
    || command.action === 'disconnectAccount'
    || command.action === 'reactivateAccount';
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
  private officialManager: OfficialChannelManager | null = null;
  private officialOptions: OfficialChannelManagerOptions = {};

  constructor(private readonly events: EventStore, private readonly primary: PlatformConnector,
    private readonly now: () => number, private readonly primaryAuthority: WorkbenchAuthority,
    private readonly sharedModels: () => SharedMockModels) {
    this.registry.register(primary);
  }

  configureOfficialOptions(options: OfficialChannelManagerOptions): void {
    requireSafe(!this.officialManager, 'OFFICIAL_CHANNEL_ALREADY_INITIALIZED');
    this.officialOptions = options;
  }

  private get official(): OfficialChannelManager {
    return this.officialManager ??= new OfficialChannelManager({
      root: this.primary.root,
      events: this.events,
      now: this.now,
      sharedModels: this.sharedModels,
      emit: (accountId, event) => this.updates.emit('update', accountId, { event }),
      readAudit: auditPage,
      hasInFlightIntent: accountId => this.hasInFlightIntent(accountId),
      onRegistryChanged: () => this.rebuildRegistry(),
    }, this.officialOptions);
  }

  get schemaVersion(): number { return this.events.db.pragma('user_version', { simple: true }) as number; }

  get storage(): AccountStore | null {
    if (this.schemaVersion !== 4) return null;
    return this.accountStore ??= new AccountStore(this.events.db, this.now);
  }

  initialize(): void {
    const disconnectedOfficial: AccountId[] = [];
    for (const account of this.storage?.listAccounts() ?? []) {
      this.attachMock(account);
      if (account.status === 'DISCONNECTED' && isOfficialApiPlatform(account.platform)) {
        disconnectedOfficial.push(account.id);
      }
    }
    if (disconnectedOfficial.length > 0) {
      void this.official.cleanupDisconnectedCredentials(disconnectedOfficial);
    }
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
    const operator = this.primaryAuthority.requireGuiControl(parentToken, 'READ');
    if (isOfficialApiPlatform(account.platform) && account.connector === account.platform) {
      return this.official.dispatch(account, operator, command, () => { this.primaryAuthority.operator(parentToken, 'READ'); });
    }
    const connector = this.getMockConnector(accountId);
    requireSafe(this.usesMock(account) && connector, 'ACCOUNT_COMMAND_NOT_SUPPORTED');
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
    this.officialManager?.onEmergencyStop();
  }

  recheckWorkerSend(): void {
    if (this.primary instanceof IsolatedDouyinConnector) this.primary.recheckInFlight();
  }

  validateProtocolWrite(command: AccountsCommand): void {
    if (!isAccountLifecycleWrite(command)) return;
    const storage = this.storage;
    const previous = storage && findProtocolCommand(storage, command.commandId.toLowerCase());
    if (!previous) return;
    // Match the existing AccountStore digest format, including records written by v1.
    const { action } = command;
    const accountRef = action === 'registerAccount' ? null : command.accountRef;
    const requestDigest = action === 'registerAccount'
      ? digest([command.platform, command.connector, command.accountId, command.ownId, command.displayLabel, command.profileRef])
      : digest([accountRef, command.confirmed]);
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
    if ('commandId' in command) command = { ...command, commandId: command.commandId.toLowerCase() };
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
        const transport = connector?.transportStatus?.();
        const connectorState = transport?.transport === 'official_api'
          ? transport.state
          : connector?.status().state ?? (account.status === 'DISCONNECTED' ? 'DISCONNECTED' : 'UNAVAILABLE');
        const connected = transport?.transport === 'official_api'
          ? transport.state === 'CONNECTED'
          : connectorState !== 'ACCOUNT_CHANGED' && (connector?.resourceIdentity().open ?? false);
        return { ...this.withCapabilities(account, connector), connected, connectorState,
          ...(transport?.transport === 'official_api' ? { transportStatus: transport } : {}) };
      }
      case 'getOfficialChannelConfig': {
        const account = storage.getAccount(command.accountRef);
        requireSafe(account, 'ACCOUNT_NOT_FOUND');
        return this.official.getConfig(account);
      }
      case 'configureOfficialChannel': {
        const account = storage.getAccount(command.accountRef);
        requireSafe(account, 'ACCOUNT_NOT_FOUND');
        return this.official.configure(account, command);
      }
      case 'connectOfficialChannel': {
        const account = storage.getAccount(command.accountRef);
        requireSafe(account, 'ACCOUNT_NOT_FOUND');
        return this.official.connect(account);
      }
      case 'disconnectOfficialChannel': {
        const account = storage.getAccount(command.accountRef);
        requireSafe(account, 'ACCOUNT_NOT_FOUND');
        return this.official.disconnectTransport(account);
      }
      case 'disconnectAccount': {
        requireSafe(command.confirmed === true, 'ACCOUNT_DISCONNECT_CONFIRMATION_REQUIRED');
        const connector = this.temporary.get(command.accountRef);
        const runtime = this.mockRuntimes.get(command.accountRef);
        let wasFresh = false;
        const account = this.change(storage, command, (fresh, commandId) => {
          wasFresh = fresh;
          if (fresh) {
            requireSafe(command.accountRef !== DEFAULT_ACCOUNT_ID && command.accountRef !== this.primary.accountId,
              'PRIMARY_ACCOUNT_DISCONNECT_BLOCKED');
            requireSafe((!connector || connector.isIdle()) && (!runtime || runtime.isIdle())
              && (!this.officialManager || this.officialManager.isIdle(command.accountRef))
              && !this.hasInFlightIntent(command.accountRef), 'ACCOUNT_OPERATION_IN_PROGRESS');
          }
          return storage.disconnectAccount({ ...command, commandId });
        }, 'ACCOUNT_DISCONNECTED');
        if (wasFresh && storage.getAccount(account.id)?.status === 'DISCONNECTED') {
          if (connector) {
            this.temporary.delete(account.id);
            this.mockRuntimes.delete(account.id);
            this.rebuildRegistry();
            await (runtime?.close() ?? connector.close());
          }
          if (isOfficialApiPlatform(account.platform)) {
            await this.official.onAccountDisconnected(account.id);
          }
        }
        return account;
      }
      case 'reactivateAccount': {
        requireSafe(command.confirmed === true, 'ACCOUNT_DISCONNECT_CONFIRMATION_REQUIRED');
        const replay = findProtocolCommand(storage, command.commandId);
        if (!replay) {
          const existing = storage.getAccount(command.accountRef);
          if (existing && existing.status === 'DISCONNECTED' && isOfficialApiPlatform(existing.platform)) {
            await this.official.purgeDisconnectedCredentials(existing.id);
          }
        }
        return this.change(storage, command, (_fresh, commandId) =>
          storage.reactivateAccount({ ...command, commandId }), 'ACCOUNT_REACTIVATED');
      }
    }
  }

  private change(storage: AccountStore, command: RegisterAccount | DisconnectAccount | ReactivateAccount,
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
    if (
      (account.id === this.primary.accountId && account.platform === this.primary.platformId)
      || this.temporary.has(account.id)
      || this.officialManager?.getConnector(account.id)
    ) {
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
    for (const connector of this.officialManager?.activeConnectors() ?? []) this.registry.register(connector);
  }

  async close(): Promise<void> {
    const closing = [...this.temporary].map(([id, connector]) => this.mockRuntimes.get(id)?.close() ?? connector.close());
    this.temporary.clear();
    this.mockRuntimes.clear();
    const officialClose = this.officialManager?.close() ?? Promise.resolve();
    this.rebuildRegistry();
    await Promise.all([...closing, officialClose]);
  }
}
