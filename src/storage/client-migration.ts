import Database from "better-sqlite3";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { digest, requireSafe } from "../core/contracts.js";
import type { EventStore } from "./store.js";

const sql = `
CREATE TABLE operator_sessions (id TEXT PRIMARY KEY, token_digest TEXT UNIQUE NOT NULL,
  permissions TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE thread_ownership (account_id TEXT NOT NULL, channel TEXT NOT NULL, target_key TEXT NOT NULL,
  operator_id TEXT, generation INTEGER NOT NULL, lease_expires_at INTEGER NOT NULL,
  PRIMARY KEY(account_id,channel,target_key));
CREATE TABLE draft_revisions (draft_id TEXT NOT NULL REFERENCES reply_drafts(id), version INTEGER NOT NULL,
  origin TEXT NOT NULL, text TEXT NOT NULL, operator_id TEXT NOT NULL, saved_at INTEGER NOT NULL,
  PRIMARY KEY(draft_id,version));
CREATE TABLE manual_send_commands (command_id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES inbound_events(id),
  operator_id TEXT NOT NULL, params_digest TEXT NOT NULL, params TEXT NOT NULL, status TEXT NOT NULL,
  intent_id TEXT UNIQUE REFERENCES send_intents(id), reason TEXT, created_at INTEGER NOT NULL);
CREATE TABLE client_approvals (command_id TEXT PRIMARY KEY REFERENCES manual_send_commands(command_id),
  draft_id TEXT NOT NULL REFERENCES reply_drafts(id), snapshot TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE channel_capabilities (channel TEXT NOT NULL, browser_mode TEXT NOT NULL, state TEXT NOT NULL,
  identity_digest TEXT NOT NULL, mapping_digest TEXT NOT NULL, browser_version TEXT NOT NULL,
  evidence_ref TEXT NOT NULL, verified_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY(channel,browser_mode));
CREATE TABLE client_state (id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL, mode TEXT NOT NULL);
CREATE TABLE controlled_trials (event_id TEXT PRIMARY KEY REFERENCES inbound_events(id), draft_id TEXT NOT NULL,
  draft_version INTEGER NOT NULL, text_digest TEXT NOT NULL, identity_json TEXT NOT NULL,
  evidence_ref TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
INSERT INTO client_state VALUES(1,0,'DRAFT_ONLY');
CREATE TABLE ai_suggestions (id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES inbound_events(id),
  draft_version INTEGER NOT NULL, context_version TEXT NOT NULL, text TEXT NOT NULL, model TEXT NOT NULL,
  created_at INTEGER NOT NULL, dismissed INTEGER NOT NULL DEFAULT 0);
PRAGMA user_version = 3;`;

function inventory(db: Database.Database): string {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  return digest(
    tables.map(({ name }) => [
      name,
      db
        .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`)
        .all(),
    ]),
  );
}
function upgrade(db: Database.Database): void {
  db.transaction(() => db.exec(sql)).immediate();
}

/** Explicit, additive upgrade: exercise backup, trial upgrade and restore before touching the owner DB. */
export async function migrateClient(
  store: EventStore,
  backupFile: string,
): Promise<boolean> {
  if (store.db.pragma("user_version", { simple: true }) === 3) return false;
  requireSafe(
    store.db.pragma("user_version", { simple: true }) === 2,
    "DATABASE_SCHEMA_UNSUPPORTED",
  );
  const before = inventory(store.db);
  await mkdir(dirname(backupFile), { recursive: true });
  await store.db.backup(backupFile);
  const trialFile = `${backupFile}.trial`;
  await copyFile(backupFile, trialFile);
  try {
    const restored = new Database(backupFile, { readonly: true });
    try {
      requireSafe(
        restored.pragma("quick_check", { simple: true }) === "ok" &&
          inventory(restored) === before,
        "MIGRATION_BACKUP_RESTORE_FAILED",
      );
    } finally {
      restored.close();
    }
    const trial = new Database(trialFile);
    try {
      upgrade(trial);
      requireSafe(
        trial.pragma("quick_check", { simple: true }) === "ok" &&
          trial.pragma("user_version", { simple: true }) === 3,
        "MIGRATION_TRIAL_FAILED",
      );
    } finally {
      trial.close();
    }
    requireSafe(
      inventory(store.db) === before,
      "DATABASE_CHANGED_DURING_MIGRATION",
    );
    upgrade(store.db);
    store.audit("CLIENT_SCHEMA_UPGRADED", "schema-3");
    return true;
  } finally {
    await rm(trialFile, { force: true });
  }
}
