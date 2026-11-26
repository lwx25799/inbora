import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { afterAll, expect, test, vi } from 'vitest';
import { WorkbenchAuthority } from '../../src/app/authority.js';
import type { Grant, ReplyPolicy } from '../../src/app/automation-contracts.js';
import { defaultSettings } from '../../src/app/contracts.js';
import { CredentialStore } from '../../src/app/credentials.js';
import { claimFollowupVerification, commitFollowupVerificationFailure, extendFollowupVerificationDeadlines } from '../../src/app/followup-verification.js';
import { HumanFollowups } from '../../src/app/human-followup.js';
import { captureHumanQueueContext, stableHumanQueueContext } from '../../src/app/human-queue-context.js';
import { bootstrapModelProviders } from '../../src/app/service-bootstrap.js';
import { sendResultCommand } from '../../src/app/service-delivery.js';
import { VerificationScheduler } from '../../src/app/verification-scheduler.js';
import { WorkbenchQueries } from '../../src/app/workbench-queries.js';
import { DEFAULT_ACCOUNT_ID, MOCK_PLATFORM_ID, digest, targetKey } from '../../src/core/contracts.js';
import { migrateReplyKnowledge } from '../../src/knowledge/migration.js';
import { recoverLearningTasks } from '../../src/knowledge/model-service.js';
import { retrieveKnowledge } from '../../src/knowledge/retrieval.js';
import { ReplyKnowledgeService } from '../../src/knowledge/service.js';
import { ReplyKnowledgeStore } from '../../src/knowledge/store.js';
import { MockPlatformConnector } from '../../src/platform/mock-platform-connector.js';
import { AccountStore } from '../../src/storage/account-store.js';
import { migrateAutomation } from '../../src/storage/automation-migration.js';
import { AutomationStore } from '../../src/storage/automation-store.js';
import { migrateClient } from '../../src/storage/client-migration.js';
import { migrateFollowups } from '../../src/storage/followup-migration.js';
import { migrateLocalAssistant } from '../../src/storage/local-assistant-migration.js';
import { migrationInventory } from '../../src/storage/migration-inventory.js';
import { migrateModelProviders } from '../../src/storage/model-provider-migration.js';
import { initializeModelProviderSchema } from '../../src/storage/model-provider-store.js';
import { ensureQueryIndexes } from '../../src/storage/query-indexes.js';
import { migrateToSchema4 } from '../../src/storage/schema4-migration.js';
import { EventStore } from '../../src/storage/store.js';
import { approved, candidate, pending, privateTemp, snapshot } from '../helpers.js';

vi.mock('node:fs/promises', { spy: true });

const time = '2026-11-04T01:00:00Z';
const legacyEvent = candidate({ text: '你好，订单 📦', occurredAt: time });
const scope = legacyEvent.conversationId!;
const target = targetKey(legacyEvent);
const collection = { ownId: 'own-1', comments: true, inbox: true, commentIntervalMs: 30_000, dmIntervalMs: 15_000 };
const parent = resolve('.local/tests');
let cleanedDirectories = 0;
let cleanedBytes = 0;

function fixtureBytes(path: string): number {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) return 0;
  return stats.isDirectory() ? readdirSync(path).reduce((sum, name) => sum + fixtureBytes(join(path, name)), 0) : stats.size;
}

async function fixture(run: (store: EventStore, root: string, file: string) => Promise<void>, seed = false) {
  const root = privateTemp('schema4-');
  const file = join(root, 'owner.sqlite');
  let store: EventStore | undefined;
  try {
    store = new EventStore(file, true);
    let eventId: string | undefined;
    if (seed) {
      const draftId = approved(store, legacyEvent);
      eventId = store.draft(draftId).eventId;
      const intentId = store.recordIntent(draftId, snapshot(legacyEvent), true);
      store.receipt(intentId, 'UNCERTAIN', 'fixture-receipt');
      store.db.prepare('INSERT INTO source_collisions VALUES (?,?,?,?,?)').run(randomUUID(), eventId,
        digest('conflicting event'), JSON.stringify({ ...legacyEvent, text: '异议' }), 'fixture-collision');
    }
    await migrateClient(store, join(root, 'client.sqlite'));
    if (eventId) await seedExtensions(store, root, eventId);
    await run(store, root, file);
  } finally {
    try { store?.close(); }
    finally {
      const resolved = realpathSync(root);
      expect(dirname(resolved)).toBe(realpathSync(parent));
      expect(basename(resolved)).toMatch(/^schema4-/u);
      cleanedBytes += fixtureBytes(resolved);
      rmSync(resolved, { recursive: true, force: true });
      cleanedDirectories++;
    }
  }
}

async function seedExtensions(store: EventStore, root: string, eventId: string): Promise<void> {
  await migrateAutomation(store, join(root, 'automation.sqlite'));
  await migrateFollowups(store, join(root, 'followup.sqlite'));
  await migrateLocalAssistant(store, join(root, 'assistant.sqlite'));
  await migrateReplyKnowledge(store, join(root, 'knowledge.sqlite'));
  await ensureQueryIndexes(store, join(root, 'indexes.sqlite'));
  const { db } = store;
  db.exec(`
    INSERT INTO operator_sessions VALUES ('operator', 'fixture-token-digest', '[]', 1800000000000);
    INSERT INTO pauses VALUES ('dm:pause-only', 1);
    INSERT INTO thread_ownership VALUES ('account_001', 'COMMENT_NOTIFICATION', 'comment:1:2', 'operator', 1, 9999);
    INSERT INTO collection_targets VALUES ('comment:2:3', 'own-1', 'peer-1', 'sec-1', 'Fixture', NULL, 1);
    INSERT INTO automation_state VALUES (1, 1, 0, 'null');
    INSERT INTO channel_capabilities VALUES ('DIRECT_MESSAGE', 'headed', 'READ_OK', 'identity', 'map', '1', 'proof', 1, 1900000000000);
    INSERT INTO model_calls VALUES ('call', 'deepseek-flash', 'SUCCEEDED', 9007199254740993, 2, 3, 0.0001);
    UPDATE budget_limits SET maximum=NULL WHERE kind='SEND';
  `);
  const policy = { ownId: 'own-1', channels: ['DIRECT_MESSAGE'], model: 'deepseek-flash', modelLimit: 10, expiresAt: null,
    workIds: [], futureOwnWorks: false, conversationIds: [], entireInbox: true, containsAny: [], excludesAny: [],
    instructions: 'Fixture policy', startHour: 0, endHour: 24, sendLimit: 5 };
  db.prepare("INSERT INTO automation_grants VALUES (1, 'AUTO_REPLY', ?, ?, 1, NULL)").run(JSON.stringify(policy), digest(policy));
  db.exec("INSERT INTO assistant_sessions VALUES ('operator', 1)");
  db.prepare('INSERT INTO manual_send_commands VALUES (?,?,?,?,?,?,?,?,?)')
    .run('old-command', eventId, 'operator', 'old-digest', '{}', 'FAILED_BEFORE_CLICK', null, 'FIXTURE', 1);
  db.exec("INSERT INTO assistant_commands VALUES ('old-command', 1)");
  db.prepare('INSERT INTO assistant_operations VALUES (?,?,?,?,?,?,?,?,?,?)').run('operation', 'fixture', 'digest', 1, eventId,
    'DONE', '{}', null, 1, 1);
  db.prepare('INSERT INTO human_reply_drafts VALUES (?,?,?,?,?,?)').run(eventId, 'human-draft', '跟进', 1, 'operator', 1);
  db.prepare('INSERT INTO human_reply_turns VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('old-turn', eventId, 'dm:turn-only',
    'operator', 'turn-digest', '{"raw": "params"}', '跟进', 1, 'CONFIRMED', '{"raw": "approval"}', 'turn-intent', time, null,
    'turn-proof', time, 'native-digest', 1);
  const knowledge = new ReplyKnowledgeStore(store, { now: () => 1_800_000_000_000 });
  for (const [title, text, aliases] of [
    ['物流时间', '快递配送说明。Priority shipping', ['快速发货', '客服时段']], ['包装', '纸盒包装材质。Recyclable packaging', []],
  ] as [string, string, string[]][]) {
    const entry = knowledge.saveKnowledge(DEFAULT_ACCOUNT_ID, { title, topic: title, text, aliases });
    knowledge.setKnowledgeState(DEFAULT_ACCOUNT_ID, entry.id, 'ACTIVE');
    if (aliases.length === 0) db.prepare(`UPDATE k_search SET text=(SELECT text FROM k_chunks WHERE id=k_search.chunk_id)
      WHERE chunk_id IN (SELECT id FROM k_chunks WHERE entry_id=?)`).run(entry.id);
  }
  const connectionId = randomUUID();
  const models = initializeModelProviderSchema(db, {
    connectionId, modelId: 'deepseek-flash', credential: { connectionId, credentialRevision: randomUUID(), storage: 'MEMORY' },
  });
  models.apply({ commandId: randomUUID(), connectionId, routeRevision: 1, modelId: 'deepseek-flash', expectedSelectionRevision: 1 });
}

const tables = (db: Database.Database) => db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' ORDER BY name").pluck().all() as string[];
const version = (db: Database.Database) => db.pragma('user_version', { simple: true });
const search = (db: Database.Database) => [
  db.prepare('SELECT chunk_id FROM k_search WHERE k_search MATCH ? ORDER BY chunk_id').pluck().all('"快递配送"'),
  db.prepare('SELECT chunk_id FROM k_search WHERE k_search MATCH ? ORDER BY chunk_id').pluck().all('"物流时间" OR "快速发货"'),
  db.prepare('SELECT chunk_id FROM k_terms WHERE k_terms MATCH ? ORDER BY chunk_id').pluck().all('"priority"'),
];

test('checks backup, upgrade and restore while preserving original history and both FTS indexes', async () => fixture(async (store, root) => {
  const { db } = store;
  const backupFile = join(root, 'schema4.sqlite');
  const before = migrationInventory(db);
  const persisted = tables(db).filter(name => ['inbound_events', 'reply_drafts', 'send_intents', 'delivery_receipts', 'source_collisions',
    'budgets', 'budget_limits', 'model_calls'].includes(name) || name.startsWith('m_') ||
    name.startsWith('k_') && !/^k_(search|terms)_(data|idx|content|docsize|config)$/u.test(name));
  const history = migrationInventory(db, persisted);
  const originalSearch = search(db);
  expect(originalSearch.map(rows => rows.length)).toEqual([1, 1, 1]);
  expect(await migrateToSchema4(store, backupFile)).toBe(true);
  expect(version(db)).toBe(4);
  expect(db.pragma('quick_check', { simple: true })).toBe('ok');
  expect(db.pragma('foreign_key_check')).toEqual([]);
  expect(migrationInventory(db, persisted)).toBe(history);
  expect(db.prepare('SELECT input_tokens FROM model_calls').pluck().safeIntegers().get()).toBe(9007199254740993n);
  expect(search(db)).toEqual(originalSearch);
  expect(db.prepare('SELECT id, own_id, platform FROM accounts').all()).toEqual([
    { id: DEFAULT_ACCOUNT_ID, own_id: 'own-1', platform: 'douyin' },
  ]);
  expect(db.prepare('SELECT id, from_version, pre_inventory_sha256, fts_rebuilt FROM schema4_migration_meta').all())
    .toEqual([{ id: 1, from_version: 3, pre_inventory_sha256: before, fts_rebuilt: 1 }]);
  expect(db.prepare("SELECT entity_id FROM audit_events WHERE event_type='SCHEMA4_UPGRADED'").pluck().all()).toEqual(['schema-4']);

  const accounts = new AccountStore(db);
  const expectedKeys = [target, 'dm:pause-only', 'dm:turn-only', 'comment:1:2', 'comment:2:3'];
  expect(db.prepare('SELECT legacy_target_key FROM legacy_target_aliases ORDER BY legacy_target_key').pluck().all()).toEqual(expectedKeys.sort());
  for (const key of expectedKeys) {
    const channel = key.startsWith('dm:') ? 'DIRECT_MESSAGE' : 'COMMENT_NOTIFICATION';
    const alias = accounts.resolveLegacyTargetAlias(DEFAULT_ACCOUNT_ID, key);
    expect(alias?.targetRef).toBe(`ref:${digest([DEFAULT_ACCOUNT_ID, channel, key])}`);
    expect(accounts.ensureLegacyTargetAlias(DEFAULT_ACCOUNT_ID, key, channel)).toEqual(alias);
  }
  const entries = db.prepare('SELECT id FROM k_knowledge ORDER BY id').pluck().all() as string[];
  expect(entries).toHaveLength(2);
  for (const id of entries) expect(accounts.getKnowledgeScope(id)).toMatchObject({ ownerAccountId: DEFAULT_ACCOUNT_ID, visibility: 'PRIVATE' });
  expect(db.prepare('SELECT account_id, channel, state FROM account_channel_capabilities').all())
    .toEqual([{ account_id: DEFAULT_ACCOUNT_ID, channel: 'DIRECT_MESSAGE', state: 'READ_OK' }]);
  expect(() => store.assertTargetUnpaused('dm:pause-only')).toThrow('TARGET_PAUSED');

  const backup = new Database(backupFile, { readonly: true });
  try {
    expect(version(backup)).toBe(3);
    expect(backup.pragma('quick_check', { simple: true })).toBe('ok');
    expect(migrationInventory(backup)).toBe(before);
    expect(tables(backup)).not.toContain('legacy_target_aliases');
    expect(tables(backup)).not.toContain('schema4_migration_meta');
  } finally { backup.close(); }
  expect(readdirSync(root).filter(name => name.startsWith('.trial-'))).toEqual([]);
  expect(await migrateToSchema4(store, backupFile)).toBe(false);
  expect(await migrateClient(store, backupFile)).toBe(false);
  expect(await migrateAutomation(store, backupFile)).toBe(false);
  expect(await migrateFollowups(store, backupFile)).toBe(false);
  expect(await migrateLocalAssistant(store, backupFile)).toBe(false);
  expect(await migrateReplyKnowledge(store, backupFile)).toBe(false);
  expect(await ensureQueryIndexes(store, backupFile)).toBe(false);
  expect(await migrateModelProviders(store, root)).toBe(false);
  expect(version(db)).toBe(4);
}, true));

test.each(['private_fixture', 'k_unknown', 'm_future'])('rejects unknown persistent table %s before creating any backup', async name =>
  fixture(async (store, root) => {
    const { db } = store;
    db.exec(`CREATE TABLE ${name}(id INTEGER PRIMARY KEY); INSERT INTO ${name} VALUES (1)`);
    const before = migrationInventory(db);
    const backupFile = join(root, 'schema4.sqlite');
    await expect(migrateToSchema4(store, backupFile)).rejects.toMatchObject({ code: 'SCHEMA4_UNKNOWN_TABLE' });
    expect(version(db)).toBe(3);
    expect(migrationInventory(db)).toBe(before);
    expect(existsSync(backupFile)).toBe(false);
  }));

test('rejects an invalid completion marker before opening or writing to the database', async () => fixture(async (store, root, databaseFile) => {
  const file = join(root, 'schema4.sqlite');
  await migrateToSchema4(store, file);
  store.db.exec("INSERT INTO operator_sessions VALUES ('startup-session','startup-token','[]',1800000000000)");
  store.db.exec("INSERT INTO account_operator_sessions VALUES ('startup-session','account_001')");
  store.db.exec("UPDATE schema4_migration_meta SET preserved_tables_sha256='invalid'");
  const dataVersion = store.db.pragma('data_version', { simple: true });
  const inventory = migrationInventory(store.db);
  expect(() => new EventStore(databaseFile).close()).toThrow('SCHEMA4_INCOMPLETE');
  expect(store.db.pragma('data_version', { simple: true })).toBe(dataVersion);
  expect(migrationInventory(store.db)).toBe(inventory);
  await expect(migrateToSchema4(store, file)).rejects.toMatchObject({ code: 'SCHEMA4_INCOMPLETE' });
}));

test.each([
  ['missing table', 'DROP TABLE account_cursors'],
  ['same table name with missing column', `DROP TABLE account_cursors; CREATE TABLE account_cursors (
    account_id TEXT NOT NULL, channel TEXT NOT NULL, scope TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(account_id, channel, scope))`],
  ['same table name with different primary key', `DROP TABLE account_cursors; CREATE TABLE account_cursors (
    account_id TEXT NOT NULL, channel TEXT NOT NULL, scope TEXT NOT NULL, cursor_data TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(channel, scope))`],
  ['nonunique identity index', `DROP INDEX accounts_platform_own_id;
    CREATE INDEX accounts_platform_own_id ON accounts(platform, own_id) WHERE own_id <> ''`],
  ['missing alias UNIQUE', `DROP TABLE legacy_target_aliases; CREATE TABLE legacy_target_aliases (
    account_id TEXT NOT NULL, legacy_target_key TEXT NOT NULL, target_ref TEXT NOT NULL, channel TEXT NOT NULL,
    created_at TEXT NOT NULL, PRIMARY KEY(account_id, channel, legacy_target_key))`],
  ['missing visibility CHECK', `DROP TABLE account_knowledge_scopes; CREATE TABLE account_knowledge_scopes (
    entry_id TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL, visibility TEXT NOT NULL, updated_at INTEGER NOT NULL)`],
  ['missing completion marker CHECK', `ALTER TABLE schema4_migration_meta RENAME TO old_marker;
    CREATE TABLE schema4_migration_meta (id INTEGER PRIMARY KEY, from_version INTEGER NOT NULL, upgraded_at TEXT NOT NULL,
    pre_inventory_sha256 TEXT NOT NULL, preserved_tables_sha256 TEXT NOT NULL, fts_rebuilt INTEGER NOT NULL);
    INSERT INTO schema4_migration_meta SELECT * FROM old_marker; DROP TABLE old_marker`],
  ['unexpected persistent trigger', `CREATE TRIGGER unexpected_schema4_trigger AFTER INSERT ON audit_events
    BEGIN SELECT 1; END`],
])('blocks a schema4 header with a valid marker and %s', async (_cause, sql) => fixture(async (store, root) => {
  const file = join(root, 'schema4.sqlite');
  await migrateToSchema4(store, file);
  expect(await migrateToSchema4(store, file)).toBe(false);
  const marker = store.db.prepare('SELECT * FROM schema4_migration_meta').get();
  store.db.exec(sql);
  expect(store.db.prepare('SELECT * FROM schema4_migration_meta').get()).toEqual(marker);
  await expect(migrateToSchema4(store, file)).rejects.toMatchObject({ code: 'SCHEMA4_INCOMPLETE' });
}));

test('rejects a persistent trigger before backing up legacy history', async () => fixture(async (store, root) => {
  store.db.exec(`CREATE TRIGGER unexpected_audit AFTER INSERT ON audit_events
    WHEN new.event_type='SCHEMA4_UPGRADED' BEGIN UPDATE budgets SET used=used+1; END`);
  const file = join(root, 'schema4.sqlite');
  await expect(migrateToSchema4(store, file)).rejects.toMatchObject({ code: 'SCHEMA4_UNKNOWN_TRIGGER' });
  expect(existsSync(file)).toBe(false);
  expect(version(store.db)).toBe(3);
}));

test('rolls back the final transaction if the migration audit changes history', async () => fixture(async (store, root) => {
  const { db } = store;
  db.exec(`INSERT INTO audit_events VALUES ('older-audit','${time}','SCHEMA4_UPGRADED','older','{}');
    CREATE TEMP TRIGGER change_old_audit AFTER INSERT ON main.audit_events
    WHEN new.event_type='SCHEMA4_UPGRADED'
    BEGIN UPDATE audit_events SET detail_redacted='{"changed":true}' WHERE id='older-audit'; END`);
  const before = migrationInventory(db);
  const file = join(root, 'schema4.sqlite');
  await expect(migrateToSchema4(store, file)).rejects.toMatchObject({ code: 'SCHEMA4_PUBLISH_FAILED' });
  expect(version(db)).toBe(3);
  expect(migrationInventory(db)).toBe(before);
  expect(existsSync(file)).toBe(true);
}));

test('allows SQLite statistics and diagnoses ambiguous legacy keys without guessing their channel', async () => fixture(async (store, root) => {
  const { db } = store;
  db.exec(`UPDATE inbound_events SET target_key='same-key';
    INSERT INTO thread_ownership VALUES ('account_001','COMMENT_NOTIFICATION','same-key',NULL,1,0);
    INSERT INTO collection_targets VALUES ('opaque-dm','own-1','peer-1','sec-1','Fixture','native-dm-id',1);
    INSERT INTO pauses VALUES ('same-key',1),('opaque-dm',1),('unknown-key',1);
    ANALYZE;`);
  expect(tables(db)).toContain('sqlite_stat1');
  await migrateToSchema4(store, join(root, 'schema4.sqlite'));
  const accounts = new AccountStore(db);
  expect(accounts.resolveLegacyTargetAlias(DEFAULT_ACCOUNT_ID, 'same-key')).toBeNull();
  for (const channel of ['COMMENT_NOTIFICATION', 'DIRECT_MESSAGE'] as const) {
    const alias = accounts.resolveLegacyTargetAlias(DEFAULT_ACCOUNT_ID, 'same-key', channel);
    expect(alias).toMatchObject({ channel, targetRef: `ref:${digest([DEFAULT_ACCOUNT_ID, channel, 'same-key'])}` });
    expect(accounts.ensureLegacyTargetAlias(DEFAULT_ACCOUNT_ID, 'same-key', channel)).toEqual(alias);
  }
  expect(accounts.resolveLegacyTargetAlias(DEFAULT_ACCOUNT_ID, 'opaque-dm')).toMatchObject({ channel: 'DIRECT_MESSAGE' });
  expect(accounts.resolveLegacyTargetAlias(DEFAULT_ACCOUNT_ID, 'unknown-key')).toBeNull();
  expect(db.prepare("SELECT entity_id,detail_redacted FROM audit_events WHERE event_type='SCHEMA4_LEGACY_TARGET_UNRESOLVED' ORDER BY rowid").all())
    .toEqual(['same-key', 'unknown-key'].map((key, index) => ({
      entity_id: digest([DEFAULT_ACCOUNT_ID, key]), detail_redacted: JSON.stringify({ channels: index === 0 ? 2 : 0 }),
    })));
}, true));

test('upgrades and initializes the primary account when the legacy credential cannot be decrypted', async () => fixture(async (store, root) => {
  writeFileSync(join(root, 'model-key.dpapi'), 'synthetic unreadable credential');
  const load = vi.spyOn(CredentialStore.prototype, 'load').mockRejectedValueOnce(new Error('Fixture DPAPI error'));
  try {
    const models = await bootstrapModelProviders(new AutomationStore(store), root, fetch, () => {});
    expect(load).toHaveBeenCalledOnce();
    expect(models).toEqual({ controller: null, reason: 'DPAPI_RESTORE_FAILED' });
    expect(version(store.db)).toBe(4);
    expect(new AccountStore(store.db).getAccount(DEFAULT_ACCOUNT_ID)).toMatchObject({ id: DEFAULT_ACCOUNT_ID, status: 'ACTIVE' });
  } finally { load.mockRestore(); }
}));

test('leaves the live database on schema3 when the trial rebuild would change search results', async () => fixture(async (store, root) => {
  const { db } = store;
  db.exec("DELETE FROM k_search; INSERT INTO k_search VALUES ('stale-chunk', 'mismatched searchable text')");
  const before = migrationInventory(db);
  const file = join(root, 'schema4.sqlite');
  await expect(migrateToSchema4(store, file)).rejects.toMatchObject({ code: 'SCHEMA4_TRIAL_FAILED' });
  expect(version(db)).toBe(3);
  expect(migrationInventory(db)).toBe(before);
  expect(existsSync(file)).toBe(true);
  expect(readdirSync(root).filter(name => name.startsWith('.trial-'))).toEqual([]);
}, true));

test('detects writes that arrive after backup and preserves the newer main database', async () => fixture(async (store, root, file) => {
  const originalBackup = store.db.backup.bind(store.db);
  const backup = vi.spyOn(store.db, 'backup').mockImplementation(async destination => {
    const result = await originalBackup(destination);
    const writer = new Database(file, { fileMustExist: true });
    try { writer.exec("UPDATE budgets SET used=7 WHERE kind='SEND'"); }
    finally { writer.close(); }
    return result;
  });
  try {
    await expect(migrateToSchema4(store, join(root, 'schema4.sqlite'))).rejects.toMatchObject({ code: 'DATABASE_CHANGED_DURING_MIGRATION' });
    expect(version(store.db)).toBe(3);
    expect(store.budget('SEND').used).toBe(7);
    expect(readdirSync(root).filter(name => name.startsWith('.trial-'))).toEqual([]);
  } finally { backup.mockRestore(); }
}));

test('rejects a backup with a changed SQLite integer even when JS number rounding hides the change', async () => fixture(async (store, root) => {
  store.db.exec("INSERT INTO model_calls VALUES ('call', 'mock', 'SUCCEEDED', 9007199254740992, 2, 3, NULL)");
  const before = migrationInventory(store.db);
  let roundedBackup: string | undefined;
  const originalBackup = store.db.backup.bind(store.db);
  const backup = vi.spyOn(store.db, 'backup').mockImplementation(async destination => {
    const result = await originalBackup(destination);
    const rewritten = new Database(destination, { fileMustExist: true });
    try {
      rewritten.exec('UPDATE model_calls SET input_tokens=9007199254740993');
      roundedBackup = migrationInventory(rewritten);
    } finally { rewritten.close(); }
    return result;
  });
  try {
    const file = join(root, 'schema4.sqlite');
    await expect(migrateToSchema4(store, file)).rejects.toMatchObject({ code: 'SCHEMA4_BACKUP_INVALID' });
    expect(existsSync(file)).toBe(false);
    expect(roundedBackup).toBe(before);
    expect(version(store.db)).toBe(3);
    expect(store.db.prepare('SELECT input_tokens FROM model_calls').pluck().safeIntegers().get()).toBe(9007199254740992n);
    expect(readdirSync(root).filter(name => name.startsWith('.trial-'))).toEqual([]);
  } finally { backup.mockRestore(); }
}));

test('never removes a pre-existing backup at the requested destination', async () => fixture(async (store, root) => {
  const file = join(root, 'schema4.sqlite');
  writeFileSync(file, 'existing backup');
  await expect(migrateToSchema4(store, file)).rejects.toMatchObject({ code: 'SCHEMA4_BACKUP_INVALID' });
  expect(readFileSync(file, 'utf8')).toBe('existing backup');
  expect(version(store.db)).toBe(3);
}));

test('returns success and records a diagnostic if trial cleanup fails after commit', async () => fixture(async (store, root) => {
  const file = join(root, 'schema4.sqlite');
  const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
  vi.mocked(rm).mockRejectedValueOnce(new Error('Fixture directory is in use'));
  try {
    await expect(migrateToSchema4(store, file)).resolves.toBe(true);
    expect(version(store.db)).toBe(4);
    expect(warn).toHaveBeenCalledWith('Schema4 trial cleanup failed', { code: 'SCHEMA4_TRIAL_CLEANUP_FAILED' });
    expect(await migrateToSchema4(store, file)).toBe(false);
    expect(existsSync(file)).toBe(true);
  } finally {
    vi.mocked(rm).mockReset();
    warn.mockRestore();
  }
}));

test('keeps blank legacy identities and binds a registered placeholder only to an available identity', async () => fixture(async (store, root, file) => {
  store.db.prepare('INSERT INTO accounts (id, own_id) VALUES (?, ?)').run(DEFAULT_ACCOUNT_ID, '');
  await migrateToSchema4(store, join(root, 'schema4.sqlite'));
  const accounts = new AccountStore(store.db);
  expect(accounts.ensureLegacyPrimaryAccount('legacy-profile')).toMatchObject({ ownId: null, profileRef: 'legacy-profile' });
  expect(store.db.prepare('SELECT own_id FROM accounts').pluck().all()).toEqual(['']);
  accounts.registerAccount({ commandId: randomUUID(), platform: 'douyin', connector: 'douyin', accountId: 'unbound' });
  const unbound = new EventStore(file, false, undefined, 'unbound');
  try {
    unbound.bindAccount('native-id');
    expect(unbound.accountOwnId()).toBe('native-id');
    expect(() => store.bindAccount('native-id')).toThrow('ACCOUNT_IDENTITY_CONFLICT');
  } finally { unbound.close(); }
  expect(accounts.ensureLegacyPrimaryAccount('another-profile').profileRef).toBe('legacy-profile');
  expect(await migrateModelProviders(store, root)).toBe(true);
  expect(await migrateModelProviders(store, root)).toBe(false);
  expect(version(store.db)).toBe(4);
}));

test('isolates identical native ids, observations, watermarks, pauses and unknown sends across accounts', async () =>
  fixture(async (store, root, file) => {
    await migrateToSchema4(store, join(root, 'schema4.sqlite'));
    const { db } = store;
    const accounts = new AccountStore(db);
    const input = { commandId: randomUUID(), platform: MOCK_PLATFORM_ID, connector: 'mock', accountId: 'account_002', ownId: 'own-1',
      profileRef: 'mock-profile' };
    const registered = accounts.registerAccount(input);
    expect(registered).toMatchObject({ id: 'account_002', status: 'ACTIVE', autoReplyEnabled: false });
    expect(accounts.registerAccount({ ...input })).toEqual(registered);
    expect(() => accounts.registerAccount({ ...input, displayLabel: 'different' })).toThrow('COMMAND_ID_CONFLICT');
    const duplicate = { ...input, commandId: randomUUID(), accountId: 'account_003' };
    expect(() => accounts.registerAccount(duplicate)).toThrow('ACCOUNT_IDENTITY_CONFLICT');
    expect(() => accounts.registerAccount(duplicate)).toThrow('ACCOUNT_IDENTITY_CONFLICT');
    expect(() => accounts.registerAccount({ ...duplicate, ownId: 'own-2' })).toThrow('COMMAND_ID_CONFLICT');
    expect(accounts.getAccount(DEFAULT_ACCOUNT_ID)?.autoReplyEnabled).toBe(true);
    expect(accounts.listAccounts().map(item => item.id).sort()).toEqual([DEFAULT_ACCOUNT_ID, 'account_002']);

    const other = new EventStore(file, false, undefined, registered.id);
    try {
      const second = { ...legacyEvent, accountId: registered.id };
      const oldId = store.events()[0]!.id;
      const [otherId] = other.observe(second.channel, scope, [second], input.ownId, 'other-evidence',
        '2026-11-04T01:01:00Z', Date.parse(time) - 1000);
      expect(otherId).toBeDefined();
      expect(other.events()).toMatchObject([{ id: otherId, payload: second, status: 'AWAITING_DRAFT' }]);
      expect(store.events()).toMatchObject([{ id: oldId, payload: legacyEvent, status: 'UNCERTAIN' }]);
      const automation = new AutomationStore(store);
      const otherAutomation = new AutomationStore(other);
      const grant = automation.active('AUTO_REPLY') as Grant<ReplyPolicy>;
      expect(grant.version).toBe(1);
      expect(otherAutomation.active('AUTO_REPLY')).toBeNull();
      expect(otherAutomation.policyMatches(grant, other.event(otherId!))).toBe(false);
      expect(otherAutomation.policyScopeMatches(grant, other.event(otherId!))).toBe(false);
      expect(otherAutomation.allowance(grant.version, 'SEND')).toBe(false);
      expect(() => otherAutomation.reserve(grant.version, 'SEND', otherId!)).toThrow('GRANT_REVOKED');
      expect(() => automation.reserve(grant.version, 'SEND', otherId!)).toThrow('GRANT_REVOKED');
      expect(db.prepare('SELECT count(*) FROM grant_reservations').pluck().get()).toBe(0);
      const secondaryGrant = otherAutomation.grant('AUTO_REPLY', grant.scope);
      expect(accounts.getAccount(registered.id)?.autoReplyEnabled).toBe(true);
      expect(otherAutomation.policyScopeMatches(secondaryGrant, other.event(otherId!))).toBe(true);
      expect(automation.active('AUTO_REPLY')).toEqual(grant);
      otherAutomation.reserve(secondaryGrant.version, 'SEND', otherId!);
      otherAutomation.revoke('AUTO_REPLY');
      expect(automation.active('AUTO_REPLY')).toEqual(grant);
      expect(db.prepare('SELECT count(*) FROM source_collisions').pluck().get()).toBe(1);
      const firstCursor = db.prepare('SELECT cursor_data FROM cursors WHERE channel=? AND scope=?').pluck().get(second.channel, scope);
      const cursors = db.prepare('SELECT account_id, cursor_data FROM account_cursors WHERE channel=? AND scope=? ORDER BY account_id')
        .all(second.channel, scope) as { account_id: string; cursor_data: string }[];
      expect(cursors.map(cursor => cursor.account_id)).toEqual([DEFAULT_ACCOUNT_ID, registered.id]);
      expect(cursors[0]?.cursor_data).toBe(firstCursor);
      expect(cursors[1]?.cursor_data).not.toBe(firstCursor);
      expect(db.prepare('SELECT account_id, evidence_ref FROM account_observations ORDER BY rowid').all()).toEqual([
        { account_id: DEFAULT_ACCOUNT_ID, evidence_ref: 'fixture' }, { account_id: DEFAULT_ACCOUNT_ID, evidence_ref: 'fixture' },
        { account_id: registered.id, evidence_ref: 'other-evidence' },
      ]);
      expect(db.prepare('SELECT evidence_ref FROM observations WHERE evidence_ref=?').get('other-evidence')).toBeUndefined();
      store.observe(second.channel, scope, [], input.ownId, 'primary-evidence', '2026-11-04T01:02:00Z');
      expect(db.prepare('SELECT id FROM observations WHERE evidence_ref=?').pluck().get('primary-evidence'))
        .toBe(db.prepare('SELECT id FROM account_observations WHERE account_id=? AND evidence_ref=?').pluck()
          .get(DEFAULT_ACCOUNT_ID, 'primary-evidence'));
      expect(store.sendFrozen(oldId)).toBe(true);
      expect(other.sendFrozen(otherId!)).toBe(false);
      expect(() => other.saveDraft(otherId!, 'draft', 'model')).toThrow('CLIENT_USE_VERSIONED_DRAFT_SERVICE');

      const claim = db.prepare('INSERT INTO thread_ownership VALUES (?,?,?,?,?,?)');
      for (const id of [DEFAULT_ACCOUNT_ID, registered.id]) claim.run(id, second.channel, target, 'operator', 1, 9999);
      other.pause(target, true);
      expect(() => other.assertTargetUnpaused(target)).toThrow('TARGET_PAUSED');
      expect(() => store.assertTargetUnpaused(target)).not.toThrow();
      expect(db.prepare('SELECT generation FROM thread_ownership WHERE target_key=? ORDER BY account_id').pluck().all(target)).toEqual([1, 2]);
      store.pause(target, true);
      other.pause(target, false);
      expect(() => other.assertTargetUnpaused(target)).not.toThrow();
      expect(() => store.assertTargetUnpaused(target)).toThrow('TARGET_PAUSED');
      expect(db.prepare('SELECT paused FROM pauses WHERE target_key=?').pluck().get(target)).toBe(1);
      store.pause(target, false);
      db.prepare('UPDATE pauses SET paused=1 WHERE target_key=?').run(target);
      expect(() => store.assertTargetUnpaused(target)).toThrow('TARGET_PAUSED');
      expect(() => other.assertTargetUnpaused(target)).not.toThrow();

      const otherAlias = accounts.ensureLegacyTargetAlias(registered.id, target, second.channel);
      expect(otherAlias.targetRef).not.toBe(accounts.resolveLegacyTargetAlias(DEFAULT_ACCOUNT_ID, target)?.targetRef);
      const draftId = randomUUID();
      db.prepare("INSERT INTO reply_drafts VALUES (?, ?, 'fixture draft', 'mock', 1, 'DRAFT', NULL, NULL)").run(draftId, otherId);
      db.prepare("UPDATE inbound_events SET status='AWAITING_APPROVAL' WHERE id=?").run(otherId);
      expect(() => store.draft(draftId)).toThrow('DRAFT_NOT_FOUND');
      expect(() => store.reject(draftId)).toThrow('DRAFT_NOT_FOUND');
      expect(() => store.invalidateApproval(draftId)).toThrow('DRAFT_NOT_FOUND');
      expect(store.stats()).toMatchObject({ tasks: [{ eventId: oldId }], uncertain: 1 });
      expect(other.stats()).toMatchObject({ tasks: [{ eventId: otherId }], uncertain: 0 });
      const proof = snapshot(second);
      other.approve(draftId, proof, 1, 'fixture draft');
      expect(() => other.recordIntent(draftId, proof, false)).toThrow('CLIENT_AUTHORITY_REQUIRED');
      const intent = other.recordIntent(draftId, proof, false, { check() {}, committed() {} });
      expect(() => store.receipt(intent, 'UNCERTAIN', 'foreign')).toThrow('INTENT_NOT_REVIEWABLE');
      expect(store.recover()).toBe(0);
      expect(other.event(otherId!).status).toBe('INTENT_RECORDED');
      other.receipt(intent, 'CONFIRMED', 'mock-receipt');
      expect(store.receiptForEvent(otherId!)).toBeUndefined();
      const disconnect = { commandId: randomUUID(), accountRef: registered.id, confirmed: true } as const;
      const preserved = ['inbound_events', 'send_intents', 'delivery_receipts', 'legacy_target_aliases'];
      const history = migrationInventory(db, preserved);
      const result = accounts.disconnectAccount(disconnect);
      expect(result).toMatchObject({ id: registered.id, status: 'DISCONNECTED', profileRef: input.profileRef, ownId: input.ownId });
      expect(accounts.disconnectAccount(disconnect)).toEqual(result);
      expect(accounts.registerAccount(input)).toEqual(registered);
      expect(accounts.getAccount(registered.id)).toEqual(result);
      expect(accounts.getProtocolCommand(disconnect.commandId)).toMatchObject({ scopeKind: 'ACCOUNT', accountRef: registered.id, status: 'COMPLETED' });
      expect(other.receiptForEvent(otherId!)).toMatchObject({ result: 'CONFIRMED', proof_ref: 'mock-receipt' });
      expect(migrationInventory(db, preserved)).toBe(history);
      expect(() => other.bindAccount(input.ownId)).toThrow('ACCOUNT_NOT_ACTIVE');
    } finally { other.close(); }
  }, true));

async function withTwoAccounts(run: (first: EventStore, second: EventStore, root: string) => Promise<void>) {
  await fixture(async (first, root, file) => {
    new AutomationStore(first).configureCollection(collection);
    await migrateToSchema4(first, join(root, 'schema4.sqlite'));
    const account = new AccountStore(first.db).registerAccount({
      commandId: randomUUID(), platform: MOCK_PLATFORM_ID, connector: 'mock', accountId: 'account_002', ownId: 'own-1',
    });
    const second = new EventStore(file, false, undefined, account.id);
    try { await run(first, second, root); }
    finally { second.close(); }
  }, true);
}

test('isolates workbench sessions, takeover, pause, capabilities and startup recovery', async () => withTwoAccounts(async (first, second, root) => {
  const { db } = first;
  const now = () => 1_800_000_000_000;
  const a = new WorkbenchAuthority(first, now), b = new WorkbenchAuthority(second, now);
  const tokenA = a.issueSession(), tokenB = b.issueSession();
  expect(db.prepare('SELECT account_id FROM account_operator_sessions WHERE operator_id=?').pluck().get('operator')).toBe(first.accountId);
  expect(() => b.operator(tokenA)).toThrow('OPERATOR_EXPIRED');
  expect(() => b.renewTrustedSession(tokenA)).toThrow('OPERATOR_EXPIRED');
  b.revoke(tokenA);
  expect(a.operator(tokenA).permissions).toContain('CONTROL');
  const knowledge = new ReplyKnowledgeService(second, b, root, () => ({
    settings: defaultSettings, models: null, modelUnavailable: null, automation: null,
    signal: new AbortController().signal, closing: false,
  }));
  const overview = { command: 'replyKnowledge', action: 'overview' } as const;
  await expect(knowledge.dispatch(tokenA, overview)).rejects.toThrow('OPERATOR_EXPIRED');
  await expect(knowledge.dispatch(tokenB, overview)).resolves.toMatchObject({ available: true });

  const payload = candidate({ platformEventId: 'fresh', occurredAt: '2026-11-04T01:03:00Z' });
  const secondPayload = { ...payload, accountId: second.accountId };
  const eventA = pending(first, payload), eventB = pending(second, secondPayload);
  const draftA = randomUUID(), draftB = randomUUID();
  const insertDraft = db.prepare("INSERT INTO reply_drafts VALUES(?,?,'fixture draft','mock',1,'DRAFT',NULL,NULL)");
  for (const [eventId, draftId] of [[eventA, draftA], [eventB, draftB]]) {
    insertDraft.run(draftId, eventId);
    db.prepare("UPDATE inbound_events SET status='AWAITING_APPROVAL' WHERE id=?").run(eventId);
  }
  first.approve(draftA, snapshot(payload), 1, 'fixture draft');
  second.approve(draftB, snapshot(secondPayload), 1, 'fixture draft');
  a.claim(tokenA, eventA, 0);
  expect(first.draft(draftA).status).toBe('DRAFT');
  expect(second.draft(draftB).status).toBe('APPROVED');
  const intentB = second.recordIntent(draftB, snapshot(secondPayload), false, { check() {}, committed() {} });
  second.receipt(intentB, 'CONFIRMED', 'own-receipt');
  const opA = a.operator(tokenA).id, opB = b.operator(tokenB).id;
  const insertTurn = db.prepare(`INSERT INTO human_reply_turns VALUES(?,?,?,?,?,'{}','followup fixture',1,
    'PREPARING',NULL,NULL,NULL,NULL,NULL,NULL,NULL,?)`);
  insertTurn.run('prepare-a', eventA, target, opA, 'digest-a', now());
  insertTurn.run('prepare-b', eventB, target, opB, 'digest-b', now());
  a.pause(tokenA, null, true);
  expect(a.paused()).toBe(true);
  expect(b.paused()).toBe(false);
  expect(db.prepare("SELECT paused FROM client_state WHERE id=1").pluck().get()).toBe(1);
  expect(db.prepare("SELECT status FROM human_reply_turns WHERE command_id LIKE 'prepare-%' ORDER BY command_id").pluck().all())
    .toEqual(['FAILED_BEFORE_CLICK', 'PREPARING']);

  const connector = new MockPlatformConnector({ accountId: second.accountId, ownId: 'own-1' });
  const followups = new HumanFollowups(second, b, connector, () => false, () => {}, String);
  const channel = 'DIRECT_MESSAGE';
  const identityB = connector.identity(channel)!;
  const identityA = { ...identityB, identityDigest: 'identity-a' };
  a.attest(channel, 'SEND_AVAILABLE', identityA, 'proof-a');
  b.attest(channel, 'READ_OK', identityB, 'proof-b');
  a.setMode(tokenA, 'MANUAL');
  expect(b.mode()).toBe('DRAFT_ONLY');
  expect(a.capability(channel, identityA)).toMatchObject({ state: 'SEND_AVAILABLE', evidence: 'proof-a' });
  expect(b.capability(channel, identityB)).toMatchObject({ state: 'READ_OK', evidence: 'proof-b' });
  expect(db.prepare("SELECT evidence_ref FROM channel_capabilities WHERE browser_mode='headless'").pluck().get()).toBe('proof-a');
  expect(db.prepare("SELECT mode FROM client_state WHERE id=1").pluck().get()).toBe('MANUAL');
  b.setMode(tokenB, 'OBSERVE');
  expect(a.mode()).toBe('MANUAL');
  expect(b.mode()).toBe('OBSERVE');
  expect(first.clientState()).toEqual({ paused: 1, mode: 'MANUAL' });
  const view = new WorkbenchQueries(second, b, connector);
  second.observe(channel, scope, [], 'own-1', 'secondary-sync', '2027-01-02T00:00:00Z');
  first.observe(channel, scope, [], 'own-1', 'primary-sync', '2027-01-03T00:00:00Z');
  first.pause(target, true);
  expect(view.thread(tokenB, eventB, null).paused).toBe(false);
  second.pause(target, true);
  expect(view.thread(tokenB, eventB, null).paused).toBe(true);
  second.pause(target, false);
  db.exec("UPDATE human_reply_turns SET status='FAILED_BEFORE_CLICK' WHERE command_id='prepare-b'");
  db.exec("UPDATE human_reply_turns SET status='PREPARING' WHERE command_id='prepare-a'");
  expect(followups.view(eventB)).toMatchObject({ eligible: true, reason: null });
  const context = captureHumanQueueContext(second, b, second.event(eventB), opB);
  db.exec("UPDATE human_reply_turns SET status='CONFIRMED' WHERE command_id='prepare-a'");
  expect(stableHumanQueueContext(second, second.event(eventB), context)).toBe(true);
  insertTurn.run('own-confirmed', eventB, target, opB, 'own-digest', now());
  db.exec("UPDATE human_reply_turns SET status='CONFIRMED' WHERE command_id='own-confirmed'");
  expect(stableHumanQueueContext(second, second.event(eventB), context)).toBe(false);
  const automationA = new AutomationStore(first, now), automationB = new AutomationStore(second, now);
  expect(automationA.state().collection).toEqual(collection);
  expect(automationB.state().collection).toBeNull();
  automationB.configureCollection({ ...collection, comments: false });
  expect(automationA.state()).toMatchObject({ collection, startedAt: 1, emergencyStopped: false });
  expect(JSON.parse(db.prepare('SELECT collection_json FROM automation_state').pluck().get() as string)).toEqual(collection);
  db.exec("INSERT INTO discovered_works VALUES ('review-work','own-1','fixture',NULL,1,'REVIEW',1,1)");
  expect(db.prepare(`SELECT l.account_id FROM audit_events a JOIN account_audit_links l ON l.audit_id=a.id
    WHERE a.event_type='COLLECTION_CONFIGURED' ORDER BY a.rowid`).pluck().all()).toEqual([second.accountId]);
  const status = view.status(tokenB, {
    settings: defaultSettings, keyPresent: false, keyStored: false, keyStorageError: null,
    modelAuthorized: false, modelBusy: false, automation: automationB,
    collector: undefined, inboxRevision: 0,
    sync: { runId: null, running: false, cancelled: false, source: null, results: [] },
  });
  expect(status.lastSync).toEqual([{ channel, at: '2027-01-02T00:00:00Z' }]);
  expect(status.automation).toMatchObject({ collection: { ...collection, comments: false }, pendingWorks: { count: 0 } });
  expect(status.automation?.unresolvedSends).toEqual([]);

  const insertCommand = db.prepare("INSERT INTO manual_send_commands VALUES(?,?,?,'fixture','{}','QUEUED',NULL,NULL,?)");
  insertCommand.run('new-a', eventA, opA, now());
  insertCommand.run('new-b', eventB, opB, now());
  db.prepare("INSERT INTO client_approvals VALUES ('new-a',?,?,?)").run(draftA, '{}', now());
  expect(a.approval('new-a').snapshot).toBe('{}');
  for (const id of ['new-a', 'missing']) expect(() => b.approval(id)).toThrow('COMMAND_NOT_FOUND');
  for (const id of ['new-a', 'prepare-a', 'missing'])
    expect(() => sendResultCommand(second, b, followups, tokenB, id)).toThrow('COMMAND_NOT_FOUND');
  expect(sendResultCommand(second, b, followups, tokenB, 'new-b')).toMatchObject({ status: 'QUEUED' });
  expect(sendResultCommand(second, b, followups, tokenB, 'own-confirmed')).toMatchObject({ status: 'CONFIRMED' });
  a.recover();
  expect(db.prepare("SELECT status FROM manual_send_commands WHERE command_id LIKE 'new-%' ORDER BY command_id").pluck().all())
    .toEqual(['FAILED_BEFORE_CLICK', 'QUEUED']);
  expect(() => a.operator(tokenA)).toThrow('OPERATOR_EXPIRED');
  expect(b.operator(tokenB).id).toBe(opB);
  const task = db.prepare("INSERT INTO k_learning_tasks VALUES(?,?, 'samples','settings','RUNNING',?,NULL)");
  const batch = db.prepare("INSERT INTO k_learning_batches VALUES(?,0,'STYLE_LEARNING','input',NULL,'RUNNING','call')");
  task.run('task-a', first.accountId, now());
  task.run('task-b', second.accountId, now());
  batch.run('task-a');
  batch.run('task-b');
  recoverLearningTasks(first);
  expect(db.prepare('SELECT state FROM k_learning_tasks ORDER BY id').pluck().all()).toEqual(['INTERRUPTED', 'RUNNING']);
  expect(db.prepare('SELECT state FROM k_learning_batches ORDER BY task_id').pluck().all()).toEqual(['INTERRUPTED', 'RUNNING']);
}));

test('binds assistant grants, regrants and revocation to accounts sharing a native identity', async () => withTwoAccounts(async (first, second) => {
  const a = new WorkbenchAuthority(first), b = new WorkbenchAuthority(second), { db } = first;
  new AutomationStore(second).configureCollection(collection);
  const grantA = a.assistant.grant(a.assistant.connectedScope());
  db.prepare('DELETE FROM account_grant_bindings WHERE grant_version=?').run(grantA.version);
  expect(a.assistant.active()).toEqual(grantA);
  expect(b.assistant.state()).toMatchObject({ grant: null, connectionEnabled: true });
  expect(() => b.issueAssistantSession(grantA.version)).toThrow('ASSISTANT_PERMISSION_REQUIRED');
  db.prepare("INSERT INTO grant_reservations VALUES (?,'MODEL','consumed',1)").run(grantA.version);
  const grantB = b.assistant.grant(b.assistant.connectedScope());
  expect(b.assistant.state().used.MODEL).toBe(0);
  const tokenA = a.issueAssistantSession(grantA.version), tokenB = b.issueAssistantSession(grantB.version);
  const opA = a.operator(tokenA).id, opB = b.operator(tokenB).id;
  for (const [authority, op, version] of [[a, opA, grantA.version], [b, opB, grantB.version]] as const) {
    const eventId = pending(authority.store, candidate({ accountId: authority.accountId, platformEventId: 'assistant-event', occurredAt: '2026-11-04T01:04:00Z' }));
    db.prepare("INSERT INTO thread_ownership VALUES (?,'DIRECT_MESSAGE',?,?,1,9999999999999)").run(authority.accountId, target, op);
    db.prepare("INSERT INTO manual_send_commands VALUES(?,?,?,'fixture','{}','QUEUED',NULL,NULL,1)").run(op, eventId, op);
    authority.assistant.bindCommand(op, op);
    expect(authority.assistant.session(op)).toBe(version);
  }
  const replacement = a.assistant.grant(a.assistant.connectedScope());
  expect(a.assistant.usage(replacement.version).MODEL).toBe(1);
  expect(b.assistant.active()).toEqual(grantB);
  expect(() => a.operator(tokenA)).toThrow('OPERATOR_EXPIRED');
  expect(b.operator(tokenB).id).toBe(opB);
  expect(db.prepare('SELECT status FROM manual_send_commands WHERE command_id IN (?,?) ORDER BY status').pluck().all(opA, opB))
    .toEqual(['FAILED_BEFORE_CLICK', 'QUEUED']);
  expect(db.prepare('SELECT operator_id FROM thread_ownership WHERE target_key=? ORDER BY account_id').pluck().all(target)).toEqual([null, opB]);
}));

test('keeps verification startup, claim, delay and failure writes in their event account', async () => withTwoAccounts(async (first, second) => {
  const { db } = first, now = () => Date.parse(time) + 121_000, intent = 'foreign-intent';
  const payload = candidate({ accountId: second.accountId }), eventId = pending(second, payload);
  db.prepare("INSERT INTO reply_drafts VALUES(?,?,'reply','mock',1,'DRAFT',NULL,NULL)").run('foreign-draft', eventId);
  db.prepare("INSERT INTO send_intents VALUES(?,?,?,?,?,?,'UNCERTAIN',?)")
    .run(intent, eventId, 'foreign-draft', target, digest(snapshot(payload)), digest('reply'), time);
  db.prepare(`INSERT INTO human_reply_turns VALUES('foreign-turn',?,?,'operator','digest','{}','followup',1,
    'UNCERTAIN',?,'foreign-turn-intent',?,NULL,NULL,NULL,NULL,?)`)
    .run(eventId, target, JSON.stringify({ snapshot: snapshot(payload) }), time, Date.parse(time));
  const verify = vi.fn(async () => ({ verified: false, evidenceId: 'fixture' }));
  const a = new VerificationScheduler(new AutomationStore(first, now), verify, undefined, verify);
  const job = () => db.prepare('SELECT state,attempts,deadline FROM verification_jobs WHERE intent_id=?').get(intent);
  try {
    a.enqueue(eventId);
    expect(job()).toBeUndefined();
    new VerificationScheduler(new AutomationStore(second, now), verify).enqueue(eventId);
    db.prepare("UPDATE verification_jobs SET state='RUNNING', attempts=1, deadline=1 WHERE intent_id=?").run(intent);
    a.start();
    expect(job()).toEqual({ state: 'RUNNING', attempts: 1, deadline: 1 });
    const audits = () => db.prepare("SELECT entity_id FROM audit_events WHERE entity_id='foreign-turn-intent'").pluck().all();
    expect(audits()).toEqual([]);
    extendFollowupVerificationDeadlines(second, now());
    const owned = claimFollowupVerification(second, now(), [])!;
    expect(owned).toMatchObject({ commandId: 'foreign-turn', attempts: 0 });
    expect(claimFollowupVerification(first, now(), [])).toBeUndefined();
    expect(() => commitFollowupVerificationFailure(first, now(), owned, Error('fixture'))).toThrow();
    expect(audits()).toEqual(['foreign-turn-intent']);
    db.prepare("UPDATE verification_jobs SET state='PENDING' WHERE intent_id=?").run(intent);
    await a.tick();
    expect(job()).toEqual({ state: 'PENDING', attempts: 1, deadline: 1 });
    expect(verify).not.toHaveBeenCalled();
  } finally { await a.close(); }
}));

test('keeps the same twenty private knowledge candidates and returned order after unrelated account writes', async () =>
  withTwoAccounts(async (first, second) => {
    const accounts = new AccountStore(first.db);
    const now = 1_800_000_000_000;
    function writeEntries(store: EventStore, count: number, title: string, text: string) {
      const knowledge = new ReplyKnowledgeStore(store, { now: () => now });
      const source = knowledge.saveSource(store.accountId, { kind: 'MANUAL', title });
      const entries = Array.from({ length: count }, (_, index) => {
        const entry = knowledge.saveKnowledge(store.accountId, { sourceId: source.id, title, topic: `${title} ${index}`, text });
        knowledge.setKnowledgeState(store.accountId, entry.id, 'ACTIVE');
        return entry;
      });
      return { knowledge, source, entries };
    }
    writeEntries(first, 13, 'alpha', 'alpha details and shipping');
    writeEntries(first, 15, 'bravo', 'bravo details and shipping');
    const retrieve = () => retrieveKnowledge(first.db, first.accountId, 'DIRECT_MESSAGE', 'alpha bravo', { now, ownId: 'own-1' });
    const before = retrieve();
    expect(before.relevant).toHaveLength(20);
    expect(before.knowledge).toHaveLength(4);
    const { knowledge, source, entries } = writeEntries(second, 120, 'alpha', 'alpha details and shipping');
    expect(accounts.getKnowledgeScope(entries[0]!.id)).toMatchObject({ ownerAccountId: second.accountId, visibility: 'PRIVATE' });
    expect(retrieve()).toEqual(before);
    knowledge.deleteSource(second.accountId, source.id);
    expect(entries.every(entry => accounts.getKnowledgeScope(entry.id) === null)).toBe(true);
    expect(retrieve()).toEqual(before);
  }));

test('keeps replacement model grants and inherited reservations on the originating account', async () =>
  withTwoAccounts(async (first, second, root) => {
    const automation = new AutomationStore(first);
    const otherAutomation = new AutomationStore(second);
    const scope = { ownId: 'own-1', channels: ['DIRECT_MESSAGE' as const], model: 'deepseek-flash', modelLimit: 5, expiresAt: null };
    const original = automation.grant('MODEL', scope);
    const other = otherAutomation.grant('MODEL', scope);
    automation.reserve(original.version, 'MODEL', 'original-model-job');
    const { controller, reason } = await bootstrapModelProviders(automation, root, fetch, () => {});
    expect(reason).toBeNull();
    expect(controller).not.toBeNull();
    try {
      const { guard } = controller!;
      const { selection, route } = guard.current();
      first.db.transaction(() => guard.switchGrants(selection, selection, route)).immediate();
      const replacement = automation.active('MODEL')!;
      expect(replacement.version).toBeGreaterThan(original.version);
      expect(otherAutomation.active('MODEL')).toEqual(other);
      expect(otherAutomation.allowance(replacement.version, 'MODEL')).toBe(false);
      expect(first.db.prepare('SELECT job_key FROM grant_reservations WHERE grant_version=?').pluck().all(replacement.version))
        .toEqual(['original-model-job']);
    } finally { controller?.close(); }
  }));

test('protocol command storage preserves completed results and rejects cross-scope replay', async () => fixture(async (store, root) => {
  await migrateToSchema4(store, join(root, 'schema4.sqlite'));
  let now = 100;
  const accounts = new AccountStore(store.db, () => now);
  const input = { commandId: randomUUID(), scopeKind: 'ACCOUNT', accountRef: DEFAULT_ACCOUNT_ID,
    command: 'fixtureCommand', requestDigest: digest('fixture-parameters') } as const;
  expect(accounts.getProtocolCommand(input.commandId)).toBeNull();
  expect(accounts.recordProtocolCommand({ ...input, status: 'PENDING' })).toMatchObject({ status: 'PENDING', createdAt: 100 });
  now = 200;
  const complete = accounts.recordProtocolCommand({ ...input, status: 'COMPLETED', resultJson: '{"saved":true}' });
  expect(complete).toMatchObject({ status: 'COMPLETED', createdAt: 100, updatedAt: 200, resultJson: '{"saved":true}' });
  expect(accounts.recordProtocolCommand({ ...input, status: 'PENDING' })).toEqual(complete);
  expect(() => accounts.recordProtocolCommand({ ...input, scopeKind: 'GLOBAL', accountRef: null, status: 'PENDING' }))
    .toThrow('COMMAND_ID_CONFLICT');
}));

afterAll(() => process.stdout.write(`${JSON.stringify({ schema4FixtureCleanup: { directories: cleanedDirectories, bytes: cleanedBytes } })}\n`));
