import { randomUUID } from 'node:crypto';
import {
  isOfficialApiPlatform, WECHAT_KF_PLATFORM_ID, WECOM_AIBOT_PLATFORM_ID,
  type AccountId, type AccountSummary, type ConfigureOfficialChannelCommand,
  type OfficialApiPlatformId, type OfficialChannelPublicConfig,
} from '../contracts/account.js';
import { Blocked, requireSafe } from '../core/contracts.js';
import type { PlatformConnector } from '../platform/platform-connector.js';
import { WeChatKfPlatformConnector } from '../platform/wechat-kf/connector.js';
import type { WeChatKfConnectorOptions } from '../platform/wechat-kf/types.js';
import { WecomAibotPlatformConnector } from '../platform/wecom-aibot/connector.js';
import type { WecomAibotConnectorOptions } from '../platform/wecom-aibot/types.js';
import { isEmergencyStopped } from '../storage/emergency-stop.js';
import type { EventStore } from '../storage/store.js';
import {
  ChannelCredentialStore, type ChannelCredentialProtector,
  type WechatKfSecretPayload, type WecomAibotSecretPayload,
} from './channel-credentials.js';
import type { ClientCommand } from './contracts.js';
import type { SharedMockModels } from './mock-account-runtime.js';
import {
  dispatchOfflineOfficialRead, OfficialAccountRuntime, SqliteWeChatKfCursorStore,
  type ParentOperator,
} from './official-account-runtime.js';

export interface OfficialChannelManagerOptions {
  readonly protector?: ChannelCredentialProtector | undefined;
  readonly createWecomConnector?: ((options: WecomAibotConnectorOptions) => PlatformConnector) | undefined;
  readonly createWechatKfConnector?: ((options: WeChatKfConnectorOptions) => PlatformConnector) | undefined;
}

interface ManagerDeps {
  readonly root: string;
  readonly events: EventStore;
  readonly now: () => number;
  readonly sharedModels: () => SharedMockModels;
  readonly emit: (accountId: AccountId, event: string) => void;
  readonly readAudit: (store: EventStore, page: number) => unknown;
  readonly hasInFlightIntent: (accountId: AccountId) => boolean;
  readonly onRegistryChanged: () => void;
}

function writeSanitizedAudit(store: EventStore, event: string, entity: string, accountId: AccountId, detail: Record<string, unknown>): void {
  const id = randomUUID();
  store.db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?)')
    .run(id, new Date().toISOString(), event, entity, JSON.stringify(detail));
  if (store.db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name='account_audit_links'").get()) {
    store.db.prepare('INSERT INTO account_audit_links (audit_id, account_id) VALUES (?,?)').run(id, accountId);
  }
}

const WECHAT_KF_CORP_PROFILE_PREFIX = 'wechat-kf:';

function parseBoundWechatCorpId(profileRef: string): string | null {
  if (!profileRef.startsWith(WECHAT_KF_CORP_PROFILE_PREFIX)) return null;
  const corpId = profileRef.slice(WECHAT_KF_CORP_PROFILE_PREFIX.length).trim();
  return corpId.length > 0 ? corpId : null;
}

function accountStartBoundaryMs(account: AccountSummary, fallbackNow: () => number): number {
  const created = Date.parse(account.createdAt);
  if (Number.isSafeInteger(created) && created > 0) return created;
  return Math.max(1, Math.trunc(fallbackNow()));
}

/** Coordinates official channel credentials, live connectors, and account-scoped runtimes. */
export class OfficialChannelManager {
  private readonly credentials: ChannelCredentialStore;
  private readonly runtimes = new Map<AccountId, OfficialAccountRuntime>();
  private readonly connectingAborts = new Map<AccountId, AbortController>();
  private readonly closingAccounts = new Set<AccountId>();
  private readonly lifecycleQueues = new Map<AccountId, Promise<unknown>>();
  private readonly stopTasks = new Set<Promise<void>>();

  constructor(private readonly deps: ManagerDeps, private readonly options: OfficialChannelManagerOptions = {}) {
    this.credentials = new ChannelCredentialStore(deps.root, options.protector, deps.now);
  }

  private sequenceAccount<T>(accountId: AccountId, work: () => Promise<T>): Promise<T> {
    const task = (this.lifecycleQueues.get(accountId) ?? Promise.resolve()).catch(() => {}).then(work);
    this.lifecycleQueues.set(accountId, task);
    void task.finally(() => {
      if (this.lifecycleQueues.get(accountId) === task) this.lifecycleQueues.delete(accountId);
    }).catch(() => {});
    return task;
  }

  activeConnectors(): PlatformConnector[] {
    return [...this.runtimes.values()].map(runtime => runtime.connector);
  }

  getConnector(accountId: AccountId): PlatformConnector | undefined {
    return this.runtimes.get(accountId)?.connector;
  }

  isIdle(accountId: AccountId): boolean {
    if (this.connectingAborts.has(accountId) || this.closingAccounts.has(accountId)) return false;
    const runtime = this.runtimes.get(accountId);
    return !runtime || runtime.isIdle();
  }

  async cleanupDisconnectedCredentials(accountIds: readonly AccountId[]): Promise<void> {
    await this.credentials.cleanupAccounts(accountIds);
  }

  purgeDisconnectedCredentials(accountId: AccountId): Promise<void> {
    return this.sequenceAccount(accountId, () => this.credentials.deleteAccount(accountId, true));
  }

  async getConfig(account: AccountSummary): Promise<OfficialChannelPublicConfig> {
    requireSafe(isOfficialApiPlatform(account.platform) && account.connector === account.platform, 'ACCOUNT_COMMAND_NOT_SUPPORTED');
    const config = await this.credentials.getPublicConfig(account.id, account.platform, account.ownId);
    const runtime = this.runtimes.get(account.id);
    const transportStatus = runtime?.connector.transportStatus?.();
    const officialTransport = transportStatus?.transport === 'official_api' ? transportStatus : null;
    const connected = officialTransport ? officialTransport.state === 'CONNECTED' : (runtime?.connector.resourceIdentity().open ?? false);
    if (config.platform === WECHAT_KF_PLATFORM_ID && !config.corpId) {
      const boundCorp = parseBoundWechatCorpId(account.profileRef);
      if (boundCorp) return { ...config, corpId: boundCorp, connected, transportStatus: officialTransport };
    }
    return { ...config, connected, transportStatus: officialTransport };
  }

  configure(account: AccountSummary, command: ConfigureOfficialChannelCommand): Promise<OfficialChannelPublicConfig> {
    return this.sequenceAccount(account.id, async () => {
      requireSafe(account.status === 'ACTIVE', account.status === 'DISCONNECTED' ? 'ACCOUNT_DISCONNECTED' : 'ACCOUNT_NOT_ACTIVE');
      requireSafe(isOfficialApiPlatform(account.platform) && account.connector === account.platform
        && account.platform === command.platform, 'ACCOUNT_COMMAND_NOT_SUPPORTED');
      requireSafe(!this.deps.hasInFlightIntent(account.id), 'ACCOUNT_OPERATION_IN_PROGRESS');
      requireSafe(!this.closingAccounts.has(account.id), 'ACCOUNT_OPERATION_IN_PROGRESS');

      const existingRuntime = this.runtimes.get(account.id);
      if (existingRuntime) requireSafe(existingRuntime.isIdle(), 'ACCOUNT_OPERATION_IN_PROGRESS');

      // Bound external identities are immutable once set so historical drafts/events can never send under another account,
      // even across disconnectAccount -> reactivateAccount cycles.
      const nextOwnId = command.platform === WECOM_AIBOT_PLATFORM_ID ? command.botId.trim() : command.openKfId.trim();
      const existingStored = await this.credentials.readStoredConfig(account.id, account.platform);
      if (account.ownId) {
        requireSafe(account.ownId === nextOwnId, 'ACCOUNT_IDENTITY_IMMUTABLE');
      }
      if (command.platform === WECHAT_KF_PLATFORM_ID) {
        const boundCorpId = parseBoundWechatCorpId(account.profileRef)
          ?? (existingStored?.platform === WECHAT_KF_PLATFORM_ID ? existingStored.corpId : null);
        if (boundCorpId) {
          requireSafe(boundCorpId === command.corpId.trim(), 'ACCOUNT_IDENTITY_IMMUTABLE');
        }
        if (existingStored?.platform === WECHAT_KF_PLATFORM_ID) {
          requireSafe(existingStored.openKfId === nextOwnId, 'ACCOUNT_IDENTITY_IMMUTABLE');
        }
      }
      const duplicate = this.deps.events.db.prepare(
        'SELECT 1 FROM accounts WHERE platform=? AND own_id=? AND id<>?',
      ).get(account.platform, nextOwnId, account.id);
      requireSafe(!duplicate, 'ACCOUNT_IDENTITY_CONFLICT');

      if (existingRuntime) {
        await this.closeRuntime(account.id, existingRuntime);
      }

      const { stored } = await this.credentials.saveConfig(account.id, command);
      const nowIso = new Date(this.deps.now()).toISOString();
      const nextProfileRef = command.platform === WECHAT_KF_PLATFORM_ID
        ? `${WECHAT_KF_CORP_PROFILE_PREFIX}${command.corpId.trim()}`
        : null;
      try {
        this.deps.events.db.transaction(() => {
          const current = this.deps.events.db.prepare('SELECT status, own_id, profile_ref FROM accounts WHERE id=?')
            .get(account.id) as { status: string; own_id: string; profile_ref: string } | undefined;
          requireSafe(current?.status === 'ACTIVE', current?.status === 'DISCONNECTED' ? 'ACCOUNT_DISCONNECTED' : 'ACCOUNT_NOT_ACTIVE');
          requireSafe(!current.own_id || current.own_id === nextOwnId, 'ACCOUNT_IDENTITY_IMMUTABLE');
          if (nextProfileRef) {
            const persistedCorp = parseBoundWechatCorpId(current.profile_ref);
            requireSafe(!persistedCorp || `${WECHAT_KF_CORP_PROFILE_PREFIX}${persistedCorp}` === nextProfileRef,
              'ACCOUNT_IDENTITY_IMMUTABLE');
          }
          const conflict = this.deps.events.db.prepare(
            'SELECT 1 FROM accounts WHERE platform=? AND own_id=? AND id<>?',
          ).get(account.platform, nextOwnId, account.id);
          requireSafe(!conflict, 'ACCOUNT_IDENTITY_CONFLICT');
          const resolvedOwnId = current.own_id || nextOwnId;
          const resolvedProfileRef = nextProfileRef && !parseBoundWechatCorpId(current.profile_ref)
            ? nextProfileRef
            : current.profile_ref;
          this.deps.events.db.prepare('UPDATE accounts SET own_id=?, profile_ref=?, updated_at=? WHERE id=?')
            .run(resolvedOwnId, resolvedProfileRef, nowIso, account.id);
          writeSanitizedAudit(this.deps.events, 'OFFICIAL_CHANNEL_CONFIGURED', account.id, account.id, {
            platform: account.platform,
            credentialStorage: stored.storage,
            credentialMode: command.credentialMode,
          });
        }).immediate();
      } catch (error) {
        const status = this.deps.events.db.prepare('SELECT status FROM accounts WHERE id=?').pluck().get(account.id);
        if (status === 'DISCONNECTED') await this.credentials.deleteAccount(account.id, false).catch(() => {});
        throw error;
      }

      this.deps.emit(account.id, 'status_updated');
      return this.getConfig({
        ...account,
        ownId: nextOwnId,
        ...(nextProfileRef ? { profileRef: nextProfileRef } : {}),
      });
    });
  }

  connect(account: AccountSummary): Promise<OfficialChannelPublicConfig> {
    return this.sequenceAccount(account.id, async () => {
      requireSafe(account.status === 'ACTIVE', account.status === 'DISCONNECTED' ? 'ACCOUNT_DISCONNECTED' : 'ACCOUNT_NOT_ACTIVE');
      requireSafe(isOfficialApiPlatform(account.platform) && account.connector === account.platform, 'ACCOUNT_COMMAND_NOT_SUPPORTED');
      requireSafe(!isEmergencyStopped(this.deps.events), 'EMERGENCY_STOPPED');
      requireSafe(!this.closingAccounts.has(account.id), 'ACCOUNT_OPERATION_IN_PROGRESS');

      const existing = this.runtimes.get(account.id);
      if (existing) {
        const currentTransport = existing.connector.transportStatus?.();
        if (currentTransport?.transport === 'official_api' && currentTransport.state === 'CONNECTED') {
          return this.getConfig(account);
        }
        await this.closeRuntime(account.id, existing);
      }

      const connectAbort = new AbortController();
      this.connectingAborts.set(account.id, connectAbort);
      let runtime: OfficialAccountRuntime | undefined;
      try {
        const platform: OfficialApiPlatformId = account.platform;
        const stored = await this.credentials.readStoredConfig(account.id, platform);
        requireSafe(!connectAbort.signal.aborted && !isEmergencyStopped(this.deps.events), 'EMERGENCY_STOPPED');
        requireSafe(stored, 'CHANNEL_CONFIG_REQUIRED');
        const secretPayload = await this.credentials.loadSecret(account.id, platform);
        requireSafe(!connectAbort.signal.aborted && !isEmergencyStopped(this.deps.events), 'EMERGENCY_STOPPED');
        const expectedOwnId = stored.platform === WECOM_AIBOT_PLATFORM_ID ? stored.botId : stored.openKfId;
        requireSafe(!account.ownId || account.ownId === expectedOwnId, 'ACCOUNT_CHANGED');

        // Use this account's own creation timestamp as firstRunAt so joining an older workspace
        // never converts pre-existing customer messages into AWAITING_DRAFT.
        const firstRunAt = accountStartBoundaryMs(account, this.deps.now);
        let connector: PlatformConnector;
        if (stored.platform === WECOM_AIBOT_PLATFORM_ID) {
          const wecomSecret = secretPayload as WecomAibotSecretPayload;
          const opts: WecomAibotConnectorOptions = {
            accountId: account.id,
            botId: stored.botId,
            secret: () => wecomSecret.secret,
            ...(stored.wsUrl ? { wsUrl: stored.wsUrl } : {}),
            allowGroupMessages: stored.allowGroupMessages,
            autoPersistInbound: true,
            firstRunAt,
            now: this.deps.now,
          };
          connector = this.options.createWecomConnector
            ? this.options.createWecomConnector(opts)
            : new WecomAibotPlatformConnector(opts);
        } else {
          const kfSecret = secretPayload as WechatKfSecretPayload;
          const cursorStore = new SqliteWeChatKfCursorStore(this.deps.events.db, this.deps.now);
          const opts: WeChatKfConnectorOptions = {
            accountId: account.id,
            openKfId: stored.openKfId,
            root: this.deps.root,
            credentials: () => ({
              corpId: stored.corpId,
              appSecret: kfSecret.appSecret,
              ...(kfSecret.token ? { token: kfSecret.token } : {}),
              ...(kfSecret.encodingAESKey ? { encodingAESKey: kfSecret.encodingAESKey } : {}),
            }),
            ...(stored.apiBaseUrl ? { apiBaseUrl: stored.apiBaseUrl } : {}),
            cursorStore,
            firstRunAt,
            now: this.deps.now,
          };
          connector = this.options.createWechatKfConnector
            ? this.options.createWechatKfConnector(opts)
            : new WeChatKfPlatformConnector(opts);
        }

        // For WeChat KF, verify credentials BEFORE opening/attesting SEND_AVAILABLE so bad secrets never persist capability rows.
        if (connector instanceof WeChatKfPlatformConnector) {
          await connector.apiClient.verifyCredentials(connectAbort.signal);
          requireSafe(!connectAbort.signal.aborted && !isEmergencyStopped(this.deps.events), 'EMERGENCY_STOPPED');
        }

        runtime = new OfficialAccountRuntime(
          this.deps.events.db.name, connector, this.deps.now,
          this.deps.sharedModels, event => this.deps.emit(account.id, event), this.deps.readAudit,
        );
        await runtime.openAndAttest(connectAbort.signal);
        requireSafe(!connectAbort.signal.aborted && !isEmergencyStopped(this.deps.events), 'EMERGENCY_STOPPED');
        const currentStatus = this.deps.events.db.prepare('SELECT status FROM accounts WHERE id=?').pluck().get(account.id);
        requireSafe(currentStatus === 'ACTIVE', currentStatus === 'DISCONNECTED' ? 'ACCOUNT_DISCONNECTED' : 'ACCOUNT_NOT_ACTIVE');

        this.runtimes.set(account.id, runtime);
        runtime = undefined;
        this.deps.onRegistryChanged();
        writeSanitizedAudit(this.deps.events, 'OFFICIAL_CHANNEL_CONNECTED', account.id, account.id, {
          platform: account.platform,
        });
        this.deps.emit(account.id, 'status_updated');
        return this.getConfig(account);
      } catch (error) {
        if (runtime) await runtime.close().catch(() => {});
        throw error;
      } finally {
        if (this.connectingAborts.get(account.id) === connectAbort) {
          this.connectingAborts.delete(account.id);
        }
      }
    });
  }

  disconnectTransport(account: AccountSummary): Promise<OfficialChannelPublicConfig> {
    return this.sequenceAccount(account.id, async () => {
      requireSafe(isOfficialApiPlatform(account.platform) && account.connector === account.platform, 'ACCOUNT_COMMAND_NOT_SUPPORTED');
      requireSafe(!this.deps.hasInFlightIntent(account.id), 'ACCOUNT_OPERATION_IN_PROGRESS');
      requireSafe(!this.closingAccounts.has(account.id), 'ACCOUNT_OPERATION_IN_PROGRESS');
      const runtime = this.runtimes.get(account.id);
      if (runtime) {
        requireSafe(runtime.isIdle(), 'ACCOUNT_OPERATION_IN_PROGRESS');
        await this.closeRuntime(account.id, runtime);
        writeSanitizedAudit(this.deps.events, 'OFFICIAL_CHANNEL_DISCONNECTED', account.id, account.id, {
          platform: account.platform,
        });
        this.deps.emit(account.id, 'status_updated');
      }
      return this.getConfig(account);
    });
  }

  dispatch(account: AccountSummary, operator: ParentOperator, command: ClientCommand, checkOperator: () => void): Promise<unknown> {
    requireSafe(isOfficialApiPlatform(account.platform) && account.connector === account.platform, 'ACCOUNT_COMMAND_NOT_SUPPORTED');
    const runtime = this.runtimes.get(account.id);
    if (!runtime) {
      return Promise.resolve(dispatchOfflineOfficialRead(
        this.deps.events.db.name, account, operator, command,
        this.deps.now, this.deps.sharedModels, this.deps.readAudit,
      ));
    }
    return runtime.dispatch(operator, command, checkOperator);
  }

  onAccountDisconnected(accountId: AccountId): Promise<void> {
    this.connectingAborts.get(accountId)?.abort(new Blocked('ACCOUNT_DISCONNECTED'));
    return this.sequenceAccount(accountId, async () => {
      const runtime = this.runtimes.get(accountId);
      if (runtime) {
        await this.closeRuntime(accountId, runtime);
      }
      await this.credentials.deleteAccount(accountId, true);
    });
  }

  onEmergencyStop(): void {
    // Abort connecting handshakes without clearing connectingAborts early; connect()'s finally block
    // removes its entry only after teardown completes so isIdle() stays false until fully stopped.
    for (const [, abort] of this.connectingAborts) {
      abort.abort(new Blocked('EMERGENCY_STOPPED'));
    }
    const entries = [...this.runtimes.entries()];
    if (!entries.length) return;
    for (const [id, runtime] of entries) {
      this.runtimes.delete(id);
      this.closingAccounts.add(id);
      runtime.abortNow('EMERGENCY_STOPPED');
    }
    this.deps.onRegistryChanged();
    const task = Promise.allSettled(entries.map(async ([id, runtime]) => {
      try { await runtime.close(); }
      finally { this.closingAccounts.delete(id); }
    })).then(() => {});
    this.stopTasks.add(task);
    void task.finally(() => this.stopTasks.delete(task));
  }

  private async closeRuntime(accountId: AccountId, runtime: OfficialAccountRuntime): Promise<void> {
    this.runtimes.delete(accountId);
    this.closingAccounts.add(accountId);
    this.deps.onRegistryChanged();
    try {
      await runtime.close();
    } finally {
      this.closingAccounts.delete(accountId);
    }
  }

  async close(): Promise<void> {
    for (const [id, abort] of this.connectingAborts) {
      abort.abort(new Blocked('CLIENT_CLOSING'));
      this.connectingAborts.delete(id);
    }
    const entries = [...this.runtimes.entries()];
    this.runtimes.clear();
    for (const [id, runtime] of entries) {
      this.closingAccounts.add(id);
      runtime.abortNow('CLIENT_CLOSING');
    }
    this.deps.onRegistryChanged();
    await Promise.allSettled([
      ...entries.map(async ([id, runtime]) => {
        try { await runtime.close(); }
        finally { this.closingAccounts.delete(id); }
      }),
      ...this.stopTasks,
      ...this.lifecycleQueues.values(),
    ]);
  }
}
