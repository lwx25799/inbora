import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { requireSafe } from '../core/contracts.js';

const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';

/** Snapshot existing rows in a stable order, including rowid-less FTS5 shadow tables. */
export function migrationInventory(db: Database.Database, names = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
).pluck().all() as string[]): string {
  const withoutRowid = new Set(db.prepare("SELECT name FROM pragma_table_list WHERE schema='main' AND wr=1").pluck().all() as string[]);
  const primaryKey = db.prepare('SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk').pluck();
  const hash = createHash('sha256');
  for (const name of names) {
    const keys = withoutRowid.has(name) ? (primaryKey.all(name) as string[]).map(quote) : ['rowid'];
    requireSafe(keys.length > 0, 'MIGRATION_TABLE_KEY_REQUIRED');
    hash.update(JSON.stringify(name) + '\n');
    for (const row of db.prepare(`SELECT * FROM ${quote(name)} ORDER BY ${keys.join(', ')}`).iterate()) {
      hash.update(JSON.stringify(row) + '\n');
    }
  }
  return hash.digest('hex');
}
