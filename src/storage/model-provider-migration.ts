import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, lstatSync, readFileSync, realpathSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CredentialStore, ModelCredentialStore, type ModelCredentialProtector } from "../app/credentials.js";
import { requireModelKey } from "../ai/model-transport.js";
import { defaultSettings, settingsSchema } from "../contracts/client.js";
import { Blocked, digest, requireSafe } from "../core/contracts.js";
import { migrationInventory } from "./migration-inventory.js";
import { initializeModelProviderSchema, inspectModelProviderSchema, type LegacyModelSeed } from "./model-provider-store.js";

type MigrationOptions = {
  credentialProtector?: ModelCredentialProtector;
  readLegacyKey?: (backupDirectory: string) => Promise<string | null> | string | null;
};
type LegacyFile = "client-settings.json" | "model-key.dpapi";
const legacyFiles = ["client-settings.json", "model-key.dpapi"] as const;
export const LEGACY_KEY_WARNING = "LEGACY_MODEL_KEY_RECONFIGURE_REQUIRED" as const;

function readLegacyFile(root: string, name: LegacyFile): Buffer | null {
  const path = join(root, name);
  let stats;
  try { stats = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  requireSafe(stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1
    && stats.size <= (name === "model-key.dpapi" ? 16_000 : 128_000), "MODEL_PROVIDER_LEGACY_FILE_INVALID");
  return readFileSync(path);
}

function legacyModel(settings: Buffer | null): string {
  if (!settings) return defaultSettings.model;
  try { return settingsSchema.parse({ model: defaultSettings.model, ...JSON.parse(settings.toString("utf8")) }).model; }
  catch { throw new Blocked("INVALID_LEGACY_MODEL_SETTINGS"); }
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const legacyDigests = (files: Map<LegacyFile, Buffer | null>) =>
  Object.fromEntries([...files].map(([name, bytes]) => [name, bytes ? sha256(bytes) : null]));
const captureLegacyFiles = (root: string) => new Map(legacyFiles.map(name => [name, readLegacyFile(root, name)]));

async function fileDigest(file: string) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}

function schemaDigest(db: Database.Database) {
  return digest(db.prepare("SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name").all());
}

function writeCounters(db: Database.Database) {
  return [
    db.pragma("data_version", { simple: true }),
    db.pragma("schema_version", { simple: true }),
    db.prepare("SELECT total_changes()").pluck().get(),
  ].join("/");
}

// The unchanged provider inspector is schema3-gated, but its extension DDL and checks are identical on schema4.
// Adapt only its version read, leaving the owner database header and transaction semantics intact.
function providerExtensionView(db: Database.Database): Database.Database {
  if (db.pragma("user_version", { simple: true }) !== 4) return db;
  return new Proxy(db, {
    get(target, key) {
      if (key === "pragma") return (source: string, options?: Database.PragmaOptions) =>
        source === "user_version" && options?.simple ? 3 : target.pragma(source, options);
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function verifyDatabase(db: Database.Database, tables: string[], before: string, code: string) {
  const version = db.pragma("user_version", { simple: true });
  requireSafe((version === 3 || version === 4) && db.pragma("quick_check", { simple: true }) === "ok"
    && (db.pragma("foreign_key_check") as unknown[]).length === 0 && migrationInventory(db, tables) === before, code);
}

async function restoreProbe(backup: string, directory: string, seed: LegacyModelSeed, tables: string[],
  before: string, originalSchema: string): Promise<void> {
  const scratch = await mkdtemp(join(directory, "trial-"));
  const trialFile = join(scratch, "database.sqlite");
  try {
    await copyFile(backup, trialFile);
    const trial = new Database(trialFile, { fileMustExist: true });
    try {
      trial.pragma("foreign_keys = ON");
      const extension = providerExtensionView(trial);
      initializeModelProviderSchema(extension, seed);
      requireSafe(inspectModelProviderSchema(extension) === "READY", "MODEL_PROVIDER_MIGRATION_TRIAL_FAILED");
      verifyDatabase(trial, tables, before, "MODEL_PROVIDER_MIGRATION_TRIAL_FAILED");
    } finally { trial.close(); }

    // Replace the trial with the untouched backup and check that the original DB is restorable.
    await copyFile(backup, trialFile);
    const restored = new Database(trialFile, { readonly: true, fileMustExist: true });
    try {
      verifyDatabase(restored, tables, before, "MODEL_PROVIDER_MIGRATION_RESTORE_FAILED");
      requireSafe(inspectModelProviderSchema(providerExtensionView(restored)) === "ABSENT"
        && schemaDigest(restored) === originalSchema, "MODEL_PROVIDER_MIGRATION_RESTORE_FAILED");
    } finally { restored.close(); }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Run under the existing OwnerLock, after schema3 and automation migration, before model startup. */
export async function migrateModelProviders(store: { db: Database.Database }, root: string,
  options: MigrationOptions = {}): Promise<boolean | typeof LEGACY_KEY_WARNING> {
  const { db } = store;
  if (inspectModelProviderSchema(providerExtensionView(db)) === "READY") return false;
  requireSafe(!db.inTransaction && db.pragma("foreign_keys", { simple: true }) === 1, "MODEL_PROVIDER_SCHEMA_INVALID");
  const stats = lstatSync(root);
  requireSafe(stats.isDirectory() && !stats.isSymbolicLink(), "MODEL_PROVIDER_BACKUP_PATH_INVALID");
  const canonicalRoot = realpathSync.native(root);
  const files = captureLegacyFiles(canonicalRoot);
  const sourceFilesDigest = legacyDigests(files);
  const source = db.transaction(() => {
    const tables = db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' ORDER BY name").pluck().all() as string[];
    return { tables, rows: migrationInventory(db, tables), schema: schemaDigest(db), counters: writeCounters(db) };
  })();

  const backupRoot = join(canonicalRoot, "model-provider-backups");
  await mkdir(backupRoot, { mode: 0o700, recursive: true });
  const backupRootStats = lstatSync(backupRoot);
  requireSafe(backupRootStats.isDirectory() && !backupRootStats.isSymbolicLink(), "MODEL_PROVIDER_BACKUP_PATH_INVALID");
  const directory = await mkdtemp(join(backupRoot, "migration-"));
  const backup = join(directory, "database.sqlite");
  await db.backup(backup);
  await chmod(backup, 0o600);
  for (const [name, bytes] of files) {
    if (bytes) {
      await writeFile(join(directory, name), bytes, { flag: "wx", mode: 0o600 });
      requireSafe(readLegacyFile(directory, name)?.equals(bytes), "MODEL_PROVIDER_MIGRATION_RESTORE_FAILED");
    }
  }
  const backupDigest = await fileDigest(backup);
  await writeFile(join(directory, "manifest.json"), JSON.stringify({
    version: 1, databaseSha256: backupDigest, inventorySha256: source.rows, files: sourceFilesDigest,
  }), { flag: "wx", mode: 0o600 });

  const seed = {
    connectionId: randomUUID(), modelId: legacyModel(files.get("client-settings.json") ?? null), credential: null,
  };
  await restoreProbe(backup, directory, seed, source.tables, source.rows, source.schema);
  requireSafe(await fileDigest(backup) === backupDigest, "MODEL_PROVIDER_MIGRATION_RESTORE_FAILED");
  const publish = (migration: LegacyModelSeed, warning?: typeof LEGACY_KEY_WARNING): undefined => db.transaction((): undefined => {
    requireSafe(writeCounters(db) === source.counters && schemaDigest(db) === source.schema
      && migrationInventory(db, source.tables) === source.rows, "DATABASE_CHANGED_DURING_MIGRATION");
    requireSafe(digest(legacyDigests(captureLegacyFiles(canonicalRoot))) === digest(sourceFilesDigest),
      "MODEL_PROVIDER_LEGACY_FILES_CHANGED");
    initializeModelProviderSchema(providerExtensionView(db), migration);
    verifyDatabase(db, source.tables, source.rows, "MODEL_PROVIDER_MIGRATION_PUBLISH_FAILED");
    if (warning) db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?)")
      .run(randomUUID(), new Date().toISOString(), warning, migration.connectionId, "{}");
  }).immediate();

  if (files.get("model-key.dpapi")) {
    const backupKey = readLegacyFile(directory, "model-key.dpapi");
    requireSafe(backupKey && sha256(backupKey) === sourceFilesDigest["model-key.dpapi"], "MODEL_PROVIDER_MIGRATION_RESTORE_FAILED");
    let key: string | null;
    try {
      key = options.readLegacyKey ? await options.readLegacyKey(directory) : await new CredentialStore(directory).load();
    } catch (error) {
      // The legacy reader can reject decrypted content before returning it.
      if (error instanceof Blocked && error.code === "INVALID_MODEL_KEY") {
        publish(seed, LEGACY_KEY_WARNING);
        return LEGACY_KEY_WARNING;
      }
      throw new Blocked("DPAPI_RESTORE_FAILED");
    }
    requireSafe(key !== null, "DPAPI_RESTORE_FAILED");
    try { requireModelKey(key); }
    catch {
      publish(seed, LEGACY_KEY_WARNING);
      return LEGACY_KEY_WARNING;
    }
    const credentials = new ModelCredentialStore(canonicalRoot, options.credentialProtector);
    await credentials.save(seed.connectionId, key, credential => publish({ ...seed, credential }), "DPAPI");
  } else {
    publish(seed);
  }
  return true;
}
