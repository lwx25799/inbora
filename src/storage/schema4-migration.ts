import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Blocked, DEFAULT_ACCOUNT_ID, digest, requireSafe, type Channel } from '../core/contracts.js';
import { legacyTargetRef } from './account-store.js';
import { migrationInventory } from './migration-inventory.js';
import type { EventStore } from './store.js';

const coreTables = [
  'accounts', 'observations', 'inbound_events', 'cursors', 'source_collisions', 'reply_drafts', 'send_intents',
  'delivery_receipts', 'audit_events', 'pauses', 'budgets', 'model_calls',
] as const;
const knowledgeTables = [
  'k_schema', 'k_sources', 'k_knowledge', 'k_chunks', 'k_search', 'k_terms', 'k_samples', 'k_sample_sources',
  'k_personas', 'k_generation_contexts', 'k_learning_tasks', 'k_learning_batches', 'k_model_purposes', 'k_candidate_progress',
] as const;
const ftsIndexes = [{ table: 'k_search', column: 'text' }, { table: 'k_terms', column: 'terms' }] as const;
const shadowTables = [
  'k_search_data', 'k_search_idx', 'k_search_content', 'k_search_docsize', 'k_search_config',
  'k_terms_data', 'k_terms_idx', 'k_terms_content', 'k_terms_docsize', 'k_terms_config',
] as const;
const statisticsTables = ['sqlite_stat1', 'sqlite_stat4'];
const sourceTables = new Set<string>([
  ...coreTables,
  'operator_sessions', 'thread_ownership', 'draft_revisions', 'manual_send_commands', 'client_approvals',
  'channel_capabilities', 'client_state', 'controlled_trials', 'ai_suggestions',
  'automation_state', 'collection_progress', 'discovered_works', 'discovered_conversations',
  'work_collection_progress', 'collection_targets', 'manual_send_inputs', 'policy_commands', 'automation_grants',
  'automation_human_pauses', 'grant_reservations', 'automation_jobs', 'verification_jobs', 'verification_results',
  'automation_schema', 'chat_messages', 'chat_delivery_links', 'budget_limits', 'sqlite_sequence',
  'human_reply_drafts', 'human_reply_turns', 'assistant_sessions', 'assistant_commands', 'assistant_operations',
  ...knowledgeTables, ...shadowTables, ...statisticsTables,
  'm_provider_schema', 'm_connections', 'm_connection_revisions', 'm_credentials', 'm_selection',
  'm_call_routes', 'm_generation_bindings', 'm_commands',
]);
const schema4Sql = `
CREATE TABLE accounts_v4 (
  id TEXT PRIMARY KEY, own_id TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT 'douyin',
  connector TEXT NOT NULL DEFAULT 'douyin', display_label TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'ACTIVE',
  profile_ref TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE legacy_target_aliases (
  account_id TEXT NOT NULL, legacy_target_key TEXT NOT NULL, target_ref TEXT NOT NULL UNIQUE, channel TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY(account_id, channel, legacy_target_key)
);
CREATE TABLE account_pauses (
  account_id TEXT NOT NULL, target_key TEXT NOT NULL, paused INTEGER NOT NULL, PRIMARY KEY(account_id, target_key)
);
CREATE TABLE account_cursors (
  account_id TEXT NOT NULL, channel TEXT NOT NULL, scope TEXT NOT NULL, cursor_data TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY(account_id, channel, scope)
);
CREATE TABLE account_observations (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, channel TEXT NOT NULL, scope TEXT NOT NULL,
  observed_at TEXT NOT NULL, count INTEGER NOT NULL, evidence_ref TEXT NOT NULL
);
CREATE TABLE account_channel_capabilities (
  account_id TEXT NOT NULL, channel TEXT NOT NULL, connector TEXT NOT NULL, browser_mode TEXT NOT NULL,
  state TEXT NOT NULL, identity_digest TEXT NOT NULL, mapping_digest TEXT NOT NULL, browser_version TEXT NOT NULL,
  evidence_ref TEXT NOT NULL, verified_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY(account_id, channel, connector, browser_mode)
);
CREATE TABLE account_grant_bindings (
  grant_version INTEGER PRIMARY KEY REFERENCES automation_grants(version) ON DELETE CASCADE, account_id TEXT NOT NULL
);
CREATE TABLE account_operator_sessions (
  operator_id TEXT PRIMARY KEY REFERENCES operator_sessions(id) ON DELETE CASCADE, account_id TEXT NOT NULL
);
CREATE TABLE account_client_state (
  account_id TEXT PRIMARY KEY, paused INTEGER NOT NULL, mode TEXT NOT NULL
);
CREATE TABLE account_collection_config (
  account_id TEXT PRIMARY KEY, collection_json TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE account_audit_links (
  audit_id TEXT PRIMARY KEY REFERENCES audit_events(id) ON DELETE CASCADE, account_id TEXT NOT NULL
);
CREATE TABLE account_budget_ledger (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL, delta INTEGER NOT NULL, entity_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE account_model_routes (
  call_id TEXT PRIMARY KEY REFERENCES model_calls(id) ON DELETE CASCADE, account_id TEXT NOT NULL, connection_id TEXT, model_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE account_knowledge_scopes (
  entry_id TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL, visibility TEXT NOT NULL CHECK(visibility IN ('PRIVATE','SHARED')),
  updated_at INTEGER NOT NULL
);
CREATE TABLE protocol_v2_commands (
  command_id TEXT PRIMARY KEY, scope_kind TEXT NOT NULL, account_ref TEXT, command TEXT NOT NULL, action TEXT,
  request_digest TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE schema4_migration_meta (
  id INTEGER PRIMARY KEY CHECK(id=1), from_version INTEGER NOT NULL, upgraded_at TEXT NOT NULL,
  pre_inventory_sha256 TEXT NOT NULL, preserved_tables_sha256 TEXT NOT NULL, fts_rebuilt INTEGER NOT NULL
);`;

const accountIdentityIndex = "CREATE UNIQUE INDEX accounts_platform_own_id ON accounts(platform, own_id) WHERE own_id <> ''";
const accountAuditIndex = 'CREATE INDEX account_audit_links_account ON account_audit_links(account_id, audit_id)';
const migrationMetaColumns = 'id,from_version,upgraded_at,pre_inventory_sha256,preserved_tables_sha256,fts_rebuilt';
const tableNames = (db: Database.Database) => db.prepare(
  "SELECT name FROM main.sqlite_schema WHERE type='table' ORDER BY name",
).pluck().all() as string[];
const version = (db: Database.Database) => db.pragma('user_version', { simple: true });
const healthy = (db: Database.Database) => db.pragma('quick_check', { simple: true }) === 'ok' &&
  (db.pragma('foreign_key_check') as unknown[]).length === 0;
const schemaDigest = (db: Database.Database) => digest(db.prepare(
  'SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY type, name',
).all());
const counters = (db: Database.Database) => [db.pragma('data_version', { simple: true }),
  db.pragma('schema_version', { simple: true }), db.prepare('SELECT total_changes()').pluck().get()].join('/');
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const sha256Pattern = /^[a-f0-9]{64}$/u;

// Read values with their SQLite types. Hex preserves stored text and blobs without JS decoding.
function exactInventory(db: Database.Database, tables: string[], newAuditIds: readonly string[] = []): string {
  const hash = createHash('sha256');
  const columns = db.prepare("SELECT name FROM pragma_table_info(?,'main') ORDER BY cid").pluck();
  const primaryKey = db.prepare("SELECT name FROM pragma_table_info(?,'main') WHERE pk>0 ORDER BY pk").pluck();
  const withoutRowid = new Set(db.prepare("SELECT name FROM pragma_table_list WHERE schema='main' AND wr=1").pluck().all());
  for (const table of tables) {
    const names = (table === 'accounts' ? ['id', 'own_id'] : columns.all(table) as string[]).map(quote);
    const fts = ftsIndexes.some(index => index.table === table);
    const order = fts ? names.map(name => `CAST(${name} AS BLOB)`) : withoutRowid.has(table) ?
      (primaryKey.all(table) as string[]).map(quote) : ['rowid'];
    const fields = names.flatMap(name => [`typeof(${name})`,
      `CASE typeof(${name}) WHEN 'text' THEN hex(CAST(${name} AS BLOB)) WHEN 'blob' THEN hex(${name}) ELSE ${name} END`]);
    hash.update(JSON.stringify([table, names]) + '\n');
    const omitted = table === 'audit_events' && newAuditIds.length > 0;
    const where = omitted ? 'WHERE NOT EXISTS (SELECT 1 FROM json_each(?) WHERE value=audit_events.id)' : '';
    for (const row of db.prepare(`SELECT ${fields.join(', ')} FROM main.${quote(table)} ${where} ORDER BY ${order.join(', ')}`)
      .raw().safeIntegers().iterate(...(omitted ? [JSON.stringify(newAuditIds)] : [])) as Iterable<unknown[]>) {
      hash.update(JSON.stringify(row, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() :
        typeof value === 'number' ? sqliteRealBytes(value) : value) + '\n');
    }
  }
  return hash.digest('hex');
}

function sqliteRealBytes(value: number): string {
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeDoubleBE(value);
  return bytes.toString('hex');
}

function ftsSearchDigest(db: Database.Database, tables: string[]): string {
  const hash = createHash('sha256');
  for (const { table } of ftsIndexes) {
    if (!tables.includes(table)) continue;
    const vocab = `${table}_schema4_vocab`;
    db.exec(`CREATE VIRTUAL TABLE temp.${vocab} USING fts5vocab(main, ${table}, 'row')`);
    const positions = `${vocab}_positions`;
    db.exec(`CREATE VIRTUAL TABLE temp.${positions} USING fts5vocab(main, ${table}, 'instance')`);
    try {
      const terms = db.prepare(`SELECT term FROM temp.${vocab} ORDER BY term`).pluck().iterate() as Iterable<string>;
      const search = db.prepare(`SELECT chunk_id FROM main.${table} WHERE ${table} MATCH ? ORDER BY chunk_id`).pluck();
      hash.update(JSON.stringify(table) + '\n');
      for (const term of terms) {
        hash.update(JSON.stringify(term) + '\n');
        for (const id of search.iterate(`"${term.replaceAll('"', '""')}"`)) hash.update(JSON.stringify(id) + '\n');
      }
      // Token positions establish that phrase searches also retain the same matches across rebuilt rowids.
      for (const row of db.prepare(`SELECT p.term, f.chunk_id, p.col, p.offset FROM temp.${positions} p
        JOIN main.${table} f ON f.rowid=p.doc ORDER BY p.term, f.chunk_id, p.col, p.offset`).raw().iterate()) {
        hash.update(JSON.stringify(row) + '\n');
      }
    } finally { db.exec(`DROP TABLE temp.${positions}; DROP TABLE temp.${vocab};`); }
  }
  return hash.digest('hex');
}

function assertNoPersistentTriggers(db: Database.Database, code: string): void {
  requireSafe(!db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='trigger' LIMIT 1").get(), code);
}

/** Validate the completed schema using only reads from the opened database. */
export function assertSchema4Complete(db: Database.Database): void {
  requireSafe(version(db) === 4, 'SCHEMA4_INCOMPLETE');
  assertNoPersistentTriggers(db, 'SCHEMA4_INCOMPLETE');
  const tables = new Set(tableNames(db));
  requireSafe([...coreTables, 'operator_sessions', 'client_state'].every(name => tables.has(name)), 'SCHEMA4_INCOMPLETE');
  const expected = new Database(':memory:');
  try {
    expected.exec(`${schema4Sql} ALTER TABLE accounts_v4 RENAME TO accounts; ${accountIdentityIndex};`);
    const shape = (database: Database.Database) => database.prepare(
      `SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?,'main') ORDER BY cid`,
    );
    const foreignKeys = (database: Database.Database) => database.prepare(
      "SELECT * FROM pragma_foreign_key_list(?,'main') ORDER BY id,seq",
    );
    const uniqueConstraints = (database: Database.Database) => database.prepare(`
      SELECT l.partial, x.seqno, x.cid, x.name, x."desc", x.coll FROM pragma_index_list(?,'main') l
      JOIN pragma_index_xinfo(l.name,'main') x WHERE l.origin='u' AND x."key"=1 ORDER BY l.name,x.seqno`);
    const actualShape = shape(db), expectedShape = shape(expected);
    const actualKeys = foreignKeys(db), expectedKeys = foreignKeys(expected);
    const actualUnique = uniqueConstraints(db), expectedUnique = uniqueConstraints(expected);
    requireSafe(tableNames(expected).every(name => tables.has(name) && digest(actualShape.all(name)) === digest(expectedShape.all(name)) &&
      digest(actualKeys.all(name)) === digest(expectedKeys.all(name)) &&
      digest(actualUnique.all(name)) === digest(expectedUnique.all(name))), 'SCHEMA4_INCOMPLETE');
    // PRAGMA table_info omits CHECK expressions. Compare the declarations for the tables that enforce them.
    const tableSql = (database: Database.Database, name: string) => (database.prepare(
      "SELECT sql FROM main.sqlite_schema WHERE type='table' AND name=?",
    ).pluck().get(name) as string).replace(/\s+/gu, ' ').trim();
    for (const name of ['account_knowledge_scopes', 'schema4_migration_meta'])
      requireSafe(tableSql(db, name) === tableSql(expected, name), 'SCHEMA4_INCOMPLETE');
    const indexSql = db.prepare(
      "SELECT sql FROM main.sqlite_schema WHERE type='index' AND name=? AND tbl_name=?",
    ).pluck();
    requireSafe(indexSql.get('accounts_platform_own_id', 'accounts') === accountIdentityIndex &&
      indexSql.get('account_audit_links_account', 'account_audit_links') === accountAuditIndex, 'SCHEMA4_INCOMPLETE');
  } finally { expected.close(); }
  const rows = db.prepare(`SELECT ${migrationMetaColumns} FROM main.schema4_migration_meta`).all() as {
    id: number; from_version: number; upgraded_at: string; pre_inventory_sha256: string;
    preserved_tables_sha256: string; fts_rebuilt: number;
  }[];
  const row = rows[0];
  requireSafe(rows.length === 1 && row?.id === 1 && row.from_version === 3 && typeof row.upgraded_at === 'string' &&
    Number.isFinite(Date.parse(row.upgraded_at)) && sha256Pattern.test(row.pre_inventory_sha256) &&
    sha256Pattern.test(row.preserved_tables_sha256) && (row.fts_rebuilt === 0 || row.fts_rebuilt === 1), 'SCHEMA4_INCOMPLETE');
}

const aliasSources = {
  inbound_events: 'SELECT target_key, channel FROM inbound_events',
  send_intents: 'SELECT i.target_key, e.channel FROM send_intents i JOIN inbound_events e ON e.id=i.event_id',
  pauses: 'SELECT target_key, NULL AS channel FROM pauses',
  thread_ownership: 'SELECT target_key, channel FROM thread_ownership',
  collection_targets: `SELECT target_key, CASE WHEN length(trim(conversation_id))>0 THEN 'DIRECT_MESSAGE'
    WHEN conversation_id IS NULL AND substr(target_key,1,8)='comment:' THEN 'COMMENT_NOTIFICATION' END AS channel
    FROM collection_targets`,
  human_reply_turns: 'SELECT t.target_key, e.channel FROM human_reply_turns t JOIN inbound_events e ON e.id=t.event_id',
};

function migrateAliases(db: Database.Database, tables: string[], now: string): { targetDigest: string; channels: number }[] {
  const queries = Object.entries(aliasSources).filter(([name]) => tables.includes(name)).map(([, sql]) => sql);
  const targets = db.prepare(`SELECT DISTINCT target_key, channel FROM (${queries.join(' UNION ALL ')})
    ORDER BY target_key, channel`).all() as { target_key: string; channel: Channel | null }[];
  const byKey = new Map<string, Set<Channel>>();
  const untyped = new Set<string>();
  for (const { target_key: key, channel } of targets) {
    requireSafe(key && (channel === null || channel === 'DIRECT_MESSAGE' || channel === 'COMMENT_NOTIFICATION'),
      'SCHEMA4_LEGACY_TARGET_INVALID');
    const channels = byKey.get(key) ?? new Set<Channel>();
    byKey.set(key, channels);
    if (channel) channels.add(channel);
    else untyped.add(key);
  }
  const insert = db.prepare(`INSERT INTO legacy_target_aliases (account_id, legacy_target_key, target_ref, channel, created_at)
    VALUES (?, ?, ?, ?, ?)`);
  const unresolved: { targetDigest: string; channels: number }[] = [];
  for (const [key, channels] of byKey) {
    if (!channels.size && key.startsWith('dm:')) channels.add('DIRECT_MESSAGE');
    if (!channels.size && key.startsWith('comment:')) channels.add('COMMENT_NOTIFICATION');
    if (untyped.has(key) && channels.size !== 1) unresolved.push({ targetDigest: digest([DEFAULT_ACCOUNT_ID, key]), channels: channels.size });
    for (const channel of channels) insert.run(DEFAULT_ACCOUNT_ID, key, legacyTargetRef(DEFAULT_ACCOUNT_ID, channel, key), channel, now);
  }
  return unresolved;
}

type SourceSnapshot = ReturnType<typeof captureSource>;

function captureSource(db: Database.Database) {
  const tables = tableNames(db);
  assertNoPersistentTriggers(db, 'SCHEMA4_UNKNOWN_TRIGGER');
  requireSafe(tables.every(name => sourceTables.has(name)), 'SCHEMA4_UNKNOWN_TABLE');
  requireSafe(coreTables.every(name => tables.includes(name)), 'SCHEMA4_SOURCE_INVALID');
  const preserved = tables.filter(name => !statisticsTables.includes(name) && !shadowTables.some(shadow => shadow === name));
  return {
    tables, preserved, schema: schemaDigest(db), counters: counters(db), inventory: migrationInventory(db),
    exact: exactInventory(db, tables), preservedDigest: exactInventory(db, preserved), fts: ftsSearchDigest(db, tables),
  };
}

function applySchema4Sql(db: Database.Database, source: SourceSnapshot, now: string): string[] {
  db.exec(schema4Sql);
  db.prepare(`INSERT INTO accounts_v4 (id, own_id, platform, connector, display_label, status, profile_ref, created_at, updated_at)
    SELECT id, own_id, 'douyin', 'douyin', '', 'ACTIVE', '', ?, ? FROM accounts ORDER BY rowid`).run(now, now);
  db.exec(`DROP TABLE accounts; ALTER TABLE accounts_v4 RENAME TO accounts;
    ${accountIdentityIndex}; ${accountAuditIndex};`);
  const unresolvedAliases = migrateAliases(db, source.tables, now);
  if (source.tables.includes('automation_grants')) db.prepare(`INSERT INTO account_grant_bindings
    SELECT version, ? FROM automation_grants`).run(DEFAULT_ACCOUNT_ID);
  if (source.tables.includes('automation_state')) db.prepare(`INSERT INTO account_collection_config
    SELECT ?, collection_json, ? FROM automation_state WHERE id=1`).run(DEFAULT_ACCOUNT_ID, Date.parse(now));
  db.prepare('INSERT INTO account_operator_sessions SELECT id, ? FROM operator_sessions').run(DEFAULT_ACCOUNT_ID);
  db.prepare('INSERT INTO account_client_state SELECT ?, paused, mode FROM client_state WHERE id=1').run(DEFAULT_ACCOUNT_ID);
  db.prepare(`INSERT INTO account_pauses (account_id, target_key, paused) SELECT ?, target_key, paused FROM pauses`).run(DEFAULT_ACCOUNT_ID);
  db.prepare(`INSERT INTO account_cursors (account_id, channel, scope, cursor_data, updated_at)
    SELECT ?, channel, scope, cursor_data, updated_at FROM cursors`).run(DEFAULT_ACCOUNT_ID);
  db.prepare(`INSERT INTO account_observations (id, account_id, channel, scope, observed_at, count, evidence_ref)
    SELECT id, ?, channel, scope, observed_at, count, evidence_ref FROM observations ORDER BY rowid`).run(DEFAULT_ACCOUNT_ID);
  if (source.tables.includes('channel_capabilities')) db.prepare(`INSERT INTO account_channel_capabilities
    (account_id, channel, connector, browser_mode, state, identity_digest, mapping_digest, browser_version, evidence_ref, verified_at, expires_at)
    SELECT ?, channel, 'douyin', browser_mode, state, identity_digest, mapping_digest, browser_version, evidence_ref, verified_at, expires_at
    FROM channel_capabilities`).run(DEFAULT_ACCOUNT_ID);
  if (source.tables.includes('k_knowledge')) db.exec(`INSERT INTO account_knowledge_scopes (entry_id, owner_account_id, visibility, updated_at)
    SELECT id, account_id, 'PRIVATE', updated_at FROM k_knowledge`);
  const rebuildFts = source.tables.includes('k_chunks') && ftsIndexes.every(index => source.tables.includes(index.table));
  if (rebuildFts) rebuildKnowledgeSearch(db);
  db.prepare(`INSERT INTO schema4_migration_meta
    (id, from_version, upgraded_at, pre_inventory_sha256, preserved_tables_sha256, fts_rebuilt) VALUES (1, 3, ?, ?, ?, ?)`)
    .run(now, source.inventory, source.preservedDigest, Number(rebuildFts));
  db.pragma('user_version = 4');
  const auditIds: string[] = [];
  const audit = (type: string, entity: string, detail: Record<string, number> = {}) => {
    const id = randomUUID();
    db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?)').run(id, now, type, entity, JSON.stringify(detail));
    db.prepare('INSERT INTO account_audit_links (audit_id, account_id) VALUES (?, ?)').run(id, DEFAULT_ACCOUNT_ID);
    auditIds.push(id);
  };
  for (const { targetDigest, channels } of unresolvedAliases) audit('SCHEMA4_LEGACY_TARGET_UNRESOLVED', targetDigest, { channels });
  audit('SCHEMA4_UPGRADED', 'schema-4');
  return auditIds;
}

function rebuildKnowledgeSearch(db: Database.Database): void {
  // Schema3 also indexed title and aliases. Preserve that form when it matches the authoritative entry and chunk.
  db.exec(`CREATE TEMP TABLE schema4_search_text (chunk_id TEXT PRIMARY KEY, text TEXT NOT NULL);
    INSERT INTO temp.schema4_search_text (chunk_id, text)
    SELECT s.chunk_id, s.text FROM k_search s JOIN k_chunks c ON c.id=s.chunk_id JOIN k_knowledge k ON k.id=c.entry_id
    WHERE s.text = k.title || char(10) || COALESCE((
      SELECT group_concat(value, char(10) ORDER BY key) || char(10) FROM json_each(k.aliases_json)
    ), '') || c.text;
    DELETE FROM k_search;
    INSERT INTO k_search (chunk_id, text) SELECT c.id, COALESCE(s.text, c.text)
    FROM k_chunks c LEFT JOIN temp.schema4_search_text s ON s.chunk_id=c.id ORDER BY c.rowid;
    DROP TABLE temp.schema4_search_text;
    DELETE FROM k_terms;
    INSERT INTO k_terms (chunk_id, terms) SELECT id, terms FROM k_chunks ORDER BY rowid;`);
}

function verifySource(db: Database.Database, source: SourceSnapshot, code: string): void {
  requireSafe(version(db) === 3 && healthy(db) && schemaDigest(db) === source.schema &&
    migrationInventory(db) === source.inventory && exactInventory(db, source.tables) === source.exact, code);
}

function verifyUpgrade(db: Database.Database, source: SourceSnapshot, code: string, newAuditIds: string[]): void {
  requireSafe(version(db) === 4 && healthy(db) && exactInventory(db, source.preserved, newAuditIds) === source.preservedDigest &&
    ftsSearchDigest(db, source.tables) === source.fts, code);
  assertSchema4Complete(db);
}

function verifyBackupFile(file: string, source: SourceSnapshot, code: string): void {
  try {
    const backup = new Database(file, { readonly: true, fileMustExist: true });
    try { verifySource(backup, source, code); }
    finally { backup.close(); }
  } catch (error) { throw error instanceof Blocked ? error : new Blocked(code); }
}

/** Explicit schema upgrade with a verified online backup and a private upgrade/restore trial. */
export async function migrateToSchema4(store: EventStore, backupFile: string): Promise<boolean> {
  const { db } = store;
  if (version(db) === 4) {
    db.transaction(() => assertSchema4Complete(db))();
    return false;
  }
  requireSafe(version(db) === 3, 'DATABASE_SCHEMA_UNSUPPORTED');
  requireSafe(!db.inTransaction && db.pragma('foreign_keys', { simple: true }) === 1, 'SCHEMA4_SOURCE_INVALID');
  const source = db.transaction(() => {
    requireSafe(version(db) === 3 && healthy(db), 'SCHEMA4_SOURCE_INVALID');
    return captureSource(db);
  })();
  const now = new Date().toISOString();
  const directory = dirname(backupFile);
  let reservation: Stats | undefined;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Reserve a new backup path so a retry or alias cannot overwrite a live database or an older backup.
    const placeholder = await open(backupFile, 'wx', 0o600);
    try { reservation = await placeholder.stat(); }
    finally { await placeholder.close(); }
    await db.backup(backupFile);
    verifyBackupFile(backupFile, source, 'SCHEMA4_BACKUP_INVALID');
  } catch {
    if (reservation) {
      try {
        const file = await lstat(backupFile);
        if (file.isFile() && file.dev === reservation.dev && file.ino === reservation.ino) await rm(backupFile, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          process.emitWarning('Schema4 backup cleanup failed', { code: 'SCHEMA4_BACKUP_CLEANUP_FAILED' });
      }
    }
    throw new Blocked('SCHEMA4_BACKUP_INVALID');
  }

  const scratch = await mkdtemp(join(directory, '.trial-'));
  const trialFile = join(scratch, 'database.trial');
  const upgrade = (target: Database.Database, code: string) => {
    const auditIds = applySchema4Sql(target, source, now);
    verifyUpgrade(target, source, code, auditIds);
  };
  try {
    await copyFile(backupFile, trialFile);
    const trial = new Database(trialFile, { fileMustExist: true });
    try {
      trial.pragma('foreign_keys = ON');
      trial.transaction(() => upgrade(trial, 'SCHEMA4_TRIAL_FAILED')).immediate();
    } finally { trial.close(); }
    await copyFile(backupFile, trialFile);
    // The schema digest also proves the restored copy has neither aliases nor a completion marker.
    verifyBackupFile(trialFile, source, 'SCHEMA4_RESTORE_FAILED');

    requireSafe(!db.inTransaction && db.pragma('foreign_keys', { simple: true }) === 1, 'DATABASE_CHANGED_DURING_MIGRATION');
    db.transaction(() => {
      requireSafe(counters(db) === source.counters, 'DATABASE_CHANGED_DURING_MIGRATION');
      verifySource(db, source, 'DATABASE_CHANGED_DURING_MIGRATION');
      upgrade(db, 'SCHEMA4_PUBLISH_FAILED');
    }).immediate();
    return true;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {
      process.emitWarning('Schema4 trial cleanup failed', { code: 'SCHEMA4_TRIAL_CLEANUP_FAILED' });
    });
  }
}
