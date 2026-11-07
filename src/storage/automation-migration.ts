import Database from "better-sqlite3";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { digest, requireSafe } from "../core/contracts.js";
import type { EventStore } from "./store.js";

const sql = `
CREATE TABLE automation_state (id INTEGER PRIMARY KEY CHECK(id=1), started_at INTEGER NOT NULL,
  emergency_stopped INTEGER NOT NULL DEFAULT 0, collection_json TEXT NOT NULL);
CREATE TABLE collection_progress (source TEXT PRIMARY KEY, next_at INTEGER NOT NULL DEFAULT 0,
  last_success INTEGER, last_error TEXT, failures INTEGER NOT NULL DEFAULT 0, elapsed_ms INTEGER);
CREATE TABLE discovered_works (id TEXT PRIMARY KEY, own_id TEXT NOT NULL, url TEXT NOT NULL,
  published_at INTEGER, precision_ms INTEGER NOT NULL, state TEXT NOT NULL,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
CREATE TABLE automation_grants (version INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
  scope_json TEXT NOT NULL, scope_digest TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE automation_human_pauses (target_key TEXT PRIMARY KEY, paused INTEGER NOT NULL);
CREATE TABLE grant_reservations (grant_version INTEGER NOT NULL REFERENCES automation_grants(version),
  kind TEXT NOT NULL, job_key TEXT NOT NULL, reserved_at INTEGER NOT NULL,
  PRIMARY KEY(grant_version,kind,job_key));
CREATE TABLE automation_jobs (event_id TEXT PRIMARY KEY REFERENCES inbound_events(id), grant_version INTEGER NOT NULL,
  state TEXT NOT NULL, context_version TEXT NOT NULL, ownership_generation INTEGER NOT NULL,
  draft_version INTEGER NOT NULL, reason TEXT, command_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE verification_jobs (intent_id TEXT PRIMARY KEY REFERENCES send_intents(id),
  event_id TEXT NOT NULL REFERENCES inbound_events(id), boundary TEXT NOT NULL, target_digest TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, deadline INTEGER NOT NULL,
  state TEXT NOT NULL, last_error TEXT);
CREATE TABLE verification_results (id TEXT PRIMARY KEY, intent_id TEXT NOT NULL REFERENCES send_intents(id),
  verified INTEGER NOT NULL, evidence_ref TEXT NOT NULL, checked_at INTEGER NOT NULL);
CREATE TABLE automation_schema (version INTEGER PRIMARY KEY CHECK(version=1));
INSERT INTO automation_schema VALUES(1);`;

function inventory(db: Database.Database, names: string[]): string {
  return digest(names.map(name => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]));
}

/** Additive extension of schema3; backup and restore are checked before the owner database changes. */
export async function migrateAutomation(store: EventStore, backupFile: string): Promise<boolean> {
  requireSafe(store.db.pragma("user_version", { simple: true }) === 3, "CLIENT_MIGRATION_REQUIRED");
  if (store.db.prepare("SELECT name FROM sqlite_master WHERE name='automation_schema'").get()) {
    requireSafe(!!store.db.prepare("SELECT version FROM automation_schema WHERE version=1").get(), "AUTOMATION_SCHEMA_UNSUPPORTED");
    return false;
  }
  const names = (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name: string}[]).map(x => x.name);
  const before = inventory(store.db, names);
  await mkdir(dirname(backupFile), { recursive: true });
  await store.db.backup(backupFile);
  const trialFile = `${backupFile}.trial`;
  await copyFile(backupFile, trialFile);
  try {
    const backup = new Database(backupFile, {readonly: true});
    try {
      requireSafe(backup.pragma("quick_check", {simple: true}) === "ok" && inventory(backup, names) === before, "MIGRATION_BACKUP_RESTORE_FAILED");
    } finally { backup.close(); }
    const trial = new Database(trialFile);
    try {
      trial.pragma("foreign_keys = ON");
      trial.transaction(() => trial.exec(sql)).immediate();
      requireSafe(trial.pragma("quick_check", {simple: true}) === "ok" && inventory(trial, names) === before, "MIGRATION_TRIAL_FAILED");
    } finally { trial.close(); }
    requireSafe(inventory(store.db, names) === before, "DATABASE_CHANGED_DURING_MIGRATION");
    store.db.transaction(() => store.db.exec(sql)).immediate();
    store.audit("AUTOMATION_SCHEMA_UPGRADED", "automation-1");
    return true;
  } finally { await rm(trialFile, {force: true}); }
}
