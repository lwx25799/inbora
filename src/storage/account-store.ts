import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  accountIdSchema, accountSummarySchema, accountsCommandSchema, DEFAULT_ACCOUNT_ID, DOUYIN_PLATFORM_ID,
  isOfficialApiPlatform, legacyTargetAliasSchema, WECHAT_KF_PLATFORM_ID, WECOM_AIBOT_PLATFORM_ID,
  type AccountId, type AccountSummary, type AccountsCommand, type LegacyTargetAlias,
} from '../contracts/account.js';
import { Blocked, digest, requireSafe, type Channel } from '../core/contracts.js';
import { douyinCapabilities } from '../platform/douyin-platform-connector.js';
import { wechatKfCapabilities } from '../platform/wechat-kf/connector.js';
import { wecomAibotCapabilities } from '../platform/wecom-aibot/connector.js';
import { parseStoredModelGrant } from './model-grant-binding.js';

type RegisterAccount = Omit<Extract<AccountsCommand, { action: 'registerAccount' }>, 'command' | 'action'>;
type DisconnectAccount = Omit<Extract<AccountsCommand, { action: 'disconnectAccount' }>, 'command' | 'action'>;
type ReactivateAccount = Omit<Extract<AccountsCommand, { action: 'reactivateAccount' }>, 'command' | 'action'>;
type AccountRow = Pick<AccountSummary, 'id' | 'platform' | 'connector' | 'status' | 'createdAt' | 'updatedAt'> & {
  ownId: string; displayLabel: string; profileRef: string;
};
type KnowledgeScope = { entryId: string; ownerAccountId: AccountId; visibility: 'PRIVATE' | 'SHARED'; updatedAt: number };
export interface ProtocolCommandInput {
  commandId: string;
  scopeKind: 'GLOBAL' | 'ACCOUNT';
  accountRef?: AccountId | null;
  command: string;
  action?: string | null;
  requestDigest: string;
  status: string;
  resultJson?: string | null;
  errorCode?: string | null;
}
export interface ProtocolCommandRecord extends Required<ProtocolCommandInput> {
  createdAt: number;
  updatedAt: number;
}

const accountColumns = `id, platform, connector, own_id AS ownId, display_label AS displayLabel,
  status, profile_ref AS profileRef, created_at AS createdAt, updated_at AS updatedAt`;
const aliasColumns = `account_id AS accountId, legacy_target_key AS legacyTargetKey,
  target_ref AS targetRef, channel, created_at AS createdAt`;
const noConnectorCapabilities = {
  channels: [] as Channel[], loginRecovery: false, manualSecurityRecovery: false, preview: false, readback: false,
};

export function legacyTargetRef(accountId: AccountId, channel: Channel, legacyTargetKey: string): string {
  return `ref:${digest([accountId, channel, legacyTargetKey])}`;
}

export class AccountStore {
  constructor(readonly db: Database.Database, private readonly now: () => number = Date.now) {
    requireSafe(db.pragma('user_version', { simple: true }) === 4, 'SCHEMA4_REQUIRED');
  }

  ensureLegacyPrimaryAccount(profileRef?: string): AccountSummary {
    return this.db.transaction(() => {
      const now = new Date(this.now()).toISOString();
      this.db.prepare(`INSERT INTO accounts (id, profile_ref, created_at, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET profile_ref=excluded.profile_ref, updated_at=excluded.updated_at
        WHERE accounts.profile_ref='' AND excluded.profile_ref<>''`).run(DEFAULT_ACCOUNT_ID, profileRef ?? '', now, now);
      return this.getAccount(DEFAULT_ACCOUNT_ID)!;
    }).immediate();
  }

  listAccounts(): AccountSummary[] {
    const rows = this.db.prepare(`SELECT ${accountColumns} FROM accounts ORDER BY created_at,id`).all() as AccountRow[];
    return rows.map(row => this.summary(row));
  }

  getAccount(accountRef: AccountId): AccountSummary | null {
    const row = this.db.prepare(`SELECT ${accountColumns} FROM accounts WHERE id=?`).get(accountRef) as AccountRow | undefined;
    return row ? this.summary(row) : null;
  }

  private summary(row: AccountRow): AccountSummary {
    const capabilities = row.connector === DOUYIN_PLATFORM_ID
      ? douyinCapabilities
      : row.connector === WECOM_AIBOT_PLATFORM_ID
        ? wecomAibotCapabilities
        : row.connector === WECHAT_KF_PLATFORM_ID
          ? wechatKfCapabilities
          : noConnectorCapabilities;
    const verifiedChannels = this.db.prepare(`SELECT DISTINCT channel FROM account_channel_capabilities
      WHERE account_id=? AND connector=? AND state IN ('READ_OK','SEND_REVIEW_ONLY','SEND_AVAILABLE') AND expires_at>?
      ORDER BY channel`).pluck().all(row.id, row.connector, this.now()) as Channel[];
    return accountSummarySchema.parse({
      ...row, accountRef: row.id, ownId: row.ownId || null, displayLabel: row.displayLabel || row.id,
      profileRef: row.profileRef || row.id, capabilities: { ...capabilities, channels: [...new Set([...capabilities.channels, ...verifiedChannels])] },
      autoReplyEnabled: row.status === 'ACTIVE' && this.autoReplyEnabled(row.id, row.ownId),
    });
  }

  private autoReplyEnabled(accountId: AccountId, ownId: string): boolean {
    if (!ownId || !this.db.prepare("SELECT 1 FROM main.sqlite_schema WHERE name='automation_grants' AND type='table'").get()) return false;
    const row = this.db.prepare(`SELECT g.scope_json,g.scope_digest FROM automation_grants g
      JOIN account_grant_bindings b ON b.grant_version=g.version
      WHERE b.account_id=? AND g.kind='AUTO_REPLY' AND g.revoked_at IS NULL ORDER BY g.version DESC LIMIT 1`).get(accountId) as
      { scope_json: string; scope_digest: string } | undefined;
    if (!row) return false;
    try {
      const scope = parseStoredModelGrant('AUTO_REPLY', JSON.parse(row.scope_json));
      return digest(scope) === row.scope_digest && scope.ownId === ownId && (scope.expiresAt === null || scope.expiresAt > this.now());
    } catch { return false; }
  }

  registerAccount(input: RegisterAccount): AccountSummary {
    const parsed = accountsCommandSchema.safeParse({ ...input, command: 'accounts', action: 'registerAccount' });
    requireSafe(parsed.success, 'INVALID_ACCOUNT_COMMAND');
    const { commandId, platform, connector, accountId, ownId, displayLabel, profileRef } = input;
    const command = {
      commandId, scopeKind: 'GLOBAL', command: 'accounts', action: 'registerAccount',
      requestDigest: digest([platform, connector, accountId, ownId, displayLabel, profileRef]),
    } as const;
    return this.runAccountCommand(command, now => {
      const id = accountId ?? `account_${randomUUID()}`;
      requireSafe(!ownId || !this.db.prepare('SELECT 1 FROM accounts WHERE platform=? AND own_id=?').get(platform, ownId),
        'ACCOUNT_IDENTITY_CONFLICT');
      requireSafe(id !== DEFAULT_ACCOUNT_ID && !this.db.prepare('SELECT 1 FROM accounts WHERE id=?').get(id), 'ACCOUNT_ID_CONFLICT');
      this.db.prepare(`INSERT INTO accounts (id, own_id, platform, connector, display_label, profile_ref, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, ownId ?? '', platform, connector, displayLabel ?? '', profileRef ?? '', now, now);
      return id;
    });
  }

  disconnectAccount(input: DisconnectAccount): AccountSummary {
    const parsed = accountsCommandSchema.safeParse({ ...input, command: 'accounts', action: 'disconnectAccount' });
    requireSafe(parsed.success, 'INVALID_ACCOUNT_COMMAND');
    const { commandId, accountRef, confirmed } = input;
    return this.runAccountCommand({
      commandId, scopeKind: 'ACCOUNT', accountRef, command: 'accounts', action: 'disconnectAccount',
      requestDigest: digest([accountRef, confirmed]),
    }, now => {
      requireSafe(this.db.prepare("UPDATE accounts SET status='DISCONNECTED', updated_at=? WHERE id=?")
        .run(now, accountRef).changes === 1, 'ACCOUNT_NOT_FOUND');
      return accountRef;
    });
  }

  reactivateAccount(input: ReactivateAccount): AccountSummary {
    const parsed = accountsCommandSchema.safeParse({ ...input, command: 'accounts', action: 'reactivateAccount' });
    requireSafe(parsed.success, 'INVALID_ACCOUNT_COMMAND');
    const { commandId, accountRef, confirmed } = input;
    return this.runAccountCommand({
      commandId, scopeKind: 'ACCOUNT', accountRef, command: 'accounts', action: 'reactivateAccount',
      requestDigest: digest([accountRef, confirmed]),
    }, now => {
      const existing = this.getAccount(accountRef);
      requireSafe(existing, 'ACCOUNT_NOT_FOUND');
      requireSafe(isOfficialApiPlatform(existing.platform) && existing.connector === existing.platform,
        'ACCOUNT_COMMAND_NOT_SUPPORTED');
      requireSafe(existing.status === 'DISCONNECTED', 'ACCOUNT_ALREADY_ACTIVE');
      requireSafe(this.db.prepare("UPDATE accounts SET status='ACTIVE', updated_at=? WHERE id=? AND status='DISCONNECTED'")
        .run(now, accountRef).changes === 1, 'ACCOUNT_NOT_FOUND');
      return accountRef;
    });
  }

  private runAccountCommand(command: Omit<ProtocolCommandInput, 'status'>, change: (now: string) => AccountId): AccountSummary {
    const outcome = this.db.transaction(() => {
      const existing = this.matchCommand(command);
      if (existing) {
        if (existing.errorCode) return new Blocked(existing.errorCode);
        requireSafe(existing.status === 'COMPLETED' && existing.resultJson !== null, 'COMMAND_IN_PROGRESS');
        return accountSummarySchema.parse(JSON.parse(existing.resultJson));
      }
      let accountId: AccountId;
      try { accountId = this.db.transaction(change)(new Date(this.now()).toISOString()); }
      catch (error) {
        if (!(error instanceof Blocked)) throw error;
        this.recordProtocolCommand({ ...command, status: 'FAILED', errorCode: error.code });
        return error;
      }
      const result = this.getAccount(accountId)!;
      this.recordProtocolCommand({ ...command, status: 'COMPLETED', resultJson: JSON.stringify(result) });
      return result;
    }).immediate();
    if (outcome instanceof Blocked) throw outcome;
    return outcome;
  }

  resolveLegacyTargetAlias(accountId: AccountId, legacyTargetKey: string, channel?: Channel): LegacyTargetAlias | null {
    const rows = this.db.prepare(`SELECT ${aliasColumns} FROM legacy_target_aliases WHERE account_id=? AND legacy_target_key=?
      ${channel === undefined ? '' : 'AND channel=?'} LIMIT 2`)
      .all(accountId, legacyTargetKey, ...(channel === undefined ? [] : [channel]));
    return rows.length === 1 ? legacyTargetAliasSchema.parse(rows[0]) : null;
  }

  ensureLegacyTargetAlias(accountId: AccountId, legacyTargetKey: string, channel: Channel): LegacyTargetAlias {
    const alias = legacyTargetAliasSchema.parse({
      accountId, legacyTargetKey, channel, targetRef: legacyTargetRef(accountId, channel, legacyTargetKey),
      createdAt: new Date(this.now()).toISOString(),
    });
    return this.db.transaction(() => {
      requireSafe(this.db.prepare('SELECT 1 FROM accounts WHERE id=?').get(accountId), 'ACCOUNT_NOT_FOUND');
      this.db.prepare(`INSERT INTO legacy_target_aliases (account_id, legacy_target_key, target_ref, channel, created_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, channel, legacy_target_key) DO NOTHING`)
        .run(alias.accountId, alias.legacyTargetKey, alias.targetRef, alias.channel, alias.createdAt);
      return this.resolveLegacyTargetAlias(accountId, legacyTargetKey, channel)!;
    }).immediate();
  }

  getKnowledgeScope(entryId: string): KnowledgeScope | null {
    return (this.db.prepare(`SELECT entry_id AS entryId, owner_account_id AS ownerAccountId, visibility, updated_at AS updatedAt
      FROM account_knowledge_scopes WHERE entry_id=?`).get(entryId) as KnowledgeScope | undefined) ?? null;
  }

  getProtocolCommand(commandId: string): ProtocolCommandRecord | null {
    return (this.db.prepare(`SELECT command_id AS commandId, scope_kind AS scopeKind, account_ref AS accountRef,
      command, action, request_digest AS requestDigest, status, result_json AS resultJson, error_code AS errorCode,
      created_at AS createdAt, updated_at AS updatedAt FROM protocol_v2_commands WHERE command_id=?`)
      .get(commandId) as ProtocolCommandRecord | undefined) ?? null;
  }

  private matchCommand(input: Omit<ProtocolCommandInput, 'status'>): ProtocolCommandRecord | null {
    const row = this.getProtocolCommand(input.commandId);
    requireSafe(!row || row.scopeKind === input.scopeKind && row.accountRef === (input.accountRef ?? null) &&
      row.command === input.command && row.action === (input.action ?? null) && row.requestDigest === input.requestDigest,
    'COMMAND_ID_CONFLICT');
    return row;
  }

  recordProtocolCommand(input: ProtocolCommandInput): ProtocolCommandRecord {
    requireSafe(input.scopeKind === 'GLOBAL' ? input.accountRef == null :
      input.scopeKind === 'ACCOUNT' && accountIdSchema.safeParse(input.accountRef).success, 'COMMAND_SCOPE_INVALID');
    return this.db.transaction(() => {
      const previous = this.matchCommand(input);
      if (previous && (previous.status !== 'PENDING' || input.status === 'PENDING')) return previous;
      const now = this.now();
      this.db.prepare(`INSERT INTO protocol_v2_commands (command_id, scope_kind, account_ref, command, action, request_digest,
        status, result_json, error_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(command_id) DO UPDATE SET status=excluded.status, result_json=excluded.result_json,
          error_code=excluded.error_code, updated_at=excluded.updated_at`).run(input.commandId, input.scopeKind,
        input.accountRef ?? null, input.command, input.action ?? null, input.requestDigest, input.status, input.resultJson ?? null,
        input.errorCode ?? null, now, now);
      return this.getProtocolCommand(input.commandId)!;
    }).immediate();
  }
}
