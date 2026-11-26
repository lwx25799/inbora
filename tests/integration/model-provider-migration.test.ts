import Database from "better-sqlite3";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DeepSeekProvider } from "../../src/ai/deepseek.js";
import { BrowserService } from "../../src/app/browser-service.js";
import { ModelCredentialStore, type ModelCredentialProtector } from "../../src/app/credentials.js";
import { ClientService } from "../../src/app/service.js";
import { migrateAutomation } from "../../src/storage/automation-migration.js";
import { migrateClient } from "../../src/storage/client-migration.js";
import { migrationInventory } from "../../src/storage/migration-inventory.js";
import { migrateModelProviders } from "../../src/storage/model-provider-migration.js";
import { initializeModelProviderSchema, ModelProviderStore } from "../../src/storage/model-provider-store.js";
import { EventStore } from "../../src/storage/store.js";
import { privateTemp } from "../helpers.js";
import { AutomationStore } from "../../src/storage/automation-store.js";
import { bootstrapModelProviders } from "../../src/app/service-bootstrap.js";

const cipher: ModelCredentialProtector = {
  protect: async input => Buffer.from(input).reverse(),
  unprotect: async input => Buffer.from(input).reverse(),
};

async function fixture(run: (events: EventStore, root: string) => Promise<void>) {
  const root = privateTemp("provider-migration-");
  let events: EventStore | undefined;
  try {
    events = new EventStore(join(root, "main.sqlite"), true);
    await migrateClient(events, join(root, "schema3.sqlite"));
    await migrateAutomation(events, join(root, "automation.sqlite"));
    await run(events, root);
  } finally {
    try { events?.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}

test("preserves schema3, every old row, the saved model and private restore materials", async () => fixture(async (events, root) => {
  const settings = Buffer.from(JSON.stringify({ model: "deepseek-reasoner", persona: "fixture", business: "", rules: "" }));
  await writeFile(join(root, "client-settings.json"), settings);
  const db = events.db;
  db.exec(`
    INSERT INTO accounts VALUES ('account_001','fixture-identity');
    INSERT INTO cursors VALUES ('DIRECT_MESSAGE','fixture','cursor','now');
    INSERT INTO inbound_events VALUES ('event','account_001','DIRECT_MESSAGE','source','scope','target','binding','{}','PENDING');
    INSERT INTO reply_drafts VALUES ('draft','event','fixture draft','deepseek-reasoner',1,'DRAFT',NULL,NULL);
    INSERT INTO draft_revisions VALUES ('draft',1,'HUMAN','fixture draft','operator',1);
    INSERT INTO send_intents VALUES ('intent','event','draft','target','digest','digest','VERIFIED','now');
    INSERT INTO delivery_receipts VALUES ('receipt','intent','VERIFIED','proof','now');
    INSERT INTO automation_grants VALUES (1,'MODEL','{"legacy":true}','model-digest',1,NULL);
    INSERT INTO automation_grants VALUES (2,'AUTO_REPLY','{"legacy":true}','auto-digest',1,NULL);
    INSERT INTO grant_reservations VALUES (1,'MODEL','call',1);
    INSERT INTO grant_reservations VALUES (2,'SEND','intent',1);
    UPDATE budgets SET used=1;
    INSERT INTO model_calls VALUES ('call','deepseek-reasoner','SUCCEEDED',1,2,3,NULL);
  `);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").pluck().all() as string[];
  const before = migrationInventory(db, tables);
  expect(await migrateModelProviders(events, root)).toBe(true);
  const store = new ModelProviderStore(db);
  const selected = store.getSelection();
  expect(selected).toMatchObject({ modelId: "deepseek-reasoner", selectionRevision: 1 });
  expect(store.listConnections()).toHaveLength(1);
  expect(store.getRevision(selected.connectionId!, selected.routeRevision!)).toMatchObject({
    presetId: "deepseek", protocol: "OPENAI_CHAT", baseUrl: "https://api.deepseek.com",
    storage: "MEMORY", credentialRevision: null,
  });
  expect(db.pragma("user_version", { simple: true })).toBe(3);
  expect(db.pragma("table_info(model_calls)")).toHaveLength(7);
  expect(() => db.exec("INSERT INTO accounts VALUES ('account_002','forbidden')")).toThrow();
  expect(migrationInventory(db, tables)).toBe(before);
  expect(store.getCallRoute("call")).toBeNull();
  const backups = join(root, "model-provider-backups");
  const [run] = await readdir(backups);
  const backupRoot = join(backups, run!);
  expect((await readdir(backupRoot)).sort()).toEqual(["client-settings.json", "database.sqlite", "manifest.json"]);
  expect(await readFile(join(backupRoot, "client-settings.json"))).toEqual(settings);
  const restored = new Database(join(backupRoot, "database.sqlite"), { readonly: true });
  try {
    expect(restored.pragma("quick_check", { simple: true })).toBe("ok");
    expect(restored.pragma("foreign_key_check")).toEqual([]);
    expect(migrationInventory(restored)).toBe(before);
  } finally { restored.close(); }
}));

test("absent settings and an old memory-only Key use the default model without creating a credential", async () => fixture(async (events, root) => {
  const readLegacyKey = () => { throw new Error("a missing file must never trigger legacy Key import"); };
  expect(await migrateModelProviders(events, root, { readLegacyKey })).toBe(true);
  const store = new ModelProviderStore(events.db);
  const selected = store.getSelection();
  expect(selected.modelId).toBe("deepseek-flash");
  expect(store.getRevision(selected.connectionId!, selected.routeRevision!)).toMatchObject({ storage: "MEMORY", credentialRevision: null });
  expect(events.db.prepare("SELECT count(*) FROM m_credentials").pluck().get()).toBe(0);
}));

test("saving business prompts after a failed migration preserves the model for retry", async () => fixture(async (events, root) => {
  const settingsFile = join(root, "client-settings.json");
  const backupRoot = join(root, "model-provider-backups");
  const model = "deepseek-reasoner";
  const prompts = { persona: "New persona", business: "New business", rules: "New rules" };
  await writeFile(settingsFile, JSON.stringify({ model, persona: "Original persona", business: "", rules: "" }));
  await writeFile(backupRoot, "Blocks creation of the migration backup directory");
  const service = new ClientService(events, new BrowserService(root), new DeepSeekProvider());
  try {
    await service.loadSettings();
    const token = service.authority.issueSession();
    expect(await service.dispatch(token, { command: "getStatus" })).toMatchObject({
      modelProvidersAvailable: false, settings: { model: "deepseek-flash" },
    });
    await service.dispatch(token, { command: "configureAi", settings: prompts });
    expect(JSON.parse(await readFile(settingsFile, "utf8"))).toEqual({ model, ...prompts });
  } finally { await service.close(); }

  await rm(backupRoot);
  expect(await migrateModelProviders(events, root)).toBe(true);
  expect(new ModelProviderStore(events.db).getSelection().modelId).toBe(model);
}));

test("imports a legacy DPAPI fixture once and never revives it after deletion", async () => fixture(async (events, root) => {
  const key = "synthetic-legacy-key";
  const oldCiphertext = Buffer.from(key).reverse();
  await writeFile(join(root, "model-key.dpapi"), oldCiphertext);
  const credentials = new ModelCredentialStore(root, cipher);
  expect(await migrateModelProviders(events, root, {
    credentialProtector: cipher,
    readLegacyKey: async backup => (await readFile(join(backup, "model-key.dpapi"))).reverse().toString("utf8"),
  })).toBe(true);
  const store = new ModelProviderStore(events.db);
  const [active] = store.listConnections();
  const ref = store.getCredential(store.getRevision(active!.id, active!.draftRevision)!.credentialRevision!)!;
  expect(ref.storage).toBe("DPAPI");
  expect(await credentials.load(ref, store.isCredentialActive)).toBe("synthetic-legacy-key");
  store.deleteKeys(active!.id, active!.version);
  await credentials.cleanup(store);
  expect(await migrateModelProviders(events, root, { readLegacyKey: () => { throw new Error("re-import"); } })).toBe(false);
  expect(store.getRevision(active!.id, store.getSelection().routeRevision!)).toMatchObject({ credentialRevision: null });
  const [run] = await readdir(join(root, "model-provider-backups"));
  expect(await readFile(join(root, "model-provider-backups", run!, "model-key.dpapi"))).toEqual(oldCiphertext);
  expect(await readFile(join(root, "model-key.dpapi"))).toEqual(oldCiphertext);
}));

test("a decrypted whitespace-only legacy Key keeps its backup and publishes a keyless route with a warning", async () =>
  fixture(async (events, root) => {
    const encrypted = Buffer.from("synthetic encrypted whitespace");
    await writeFile(join(root, "model-key.dpapi"), encrypted);
    const readLegacyKey = async (backup: string) => {
      expect(await readFile(join(backup, "model-key.dpapi"))).toEqual(encrypted);
      return "   ";
    };
    const before = migrationInventory(events.db, ["budgets", "automation_grants"]);
    expect(await migrateModelProviders(events, root, { readLegacyKey })).toBe("LEGACY_MODEL_KEY_RECONFIGURE_REQUIRED");
    expect(migrationInventory(events.db, ["budgets", "automation_grants"])).toBe(before);
    expect(events.db.prepare("SELECT count(*) FROM m_credentials").pluck().get()).toBe(0);
    const auto = new AutomationStore(events);
    auto.initialize(Date.now());
    const { controller, reason } = await bootstrapModelProviders(auto, root, fetch, () => {});
    try {
      expect(reason).toBeNull();
      expect(controller?.state().connections[0]?.applied).toMatchObject({
        routeRevision: 1, keyPresent: false, keyStored: false, unavailableReason: "LEGACY_MODEL_KEY_RECONFIGURE_REQUIRED",
      });
    } finally { controller?.close(); }
    expect(await readFile(join(root, "model-key.dpapi"))).toEqual(encrypted);
    expect(await readdir(join(root, "model-provider-backups"))).toHaveLength(1);
  }));

test.each(["partial", "unknown", "wrong-type", "dangling-reference", "missing-unique-index", "immediate-draft-reference"])(
  "rejects a %s extension before backup", async kind => fixture(async (events, root) => {
    if (kind === "partial") events.db.exec("CREATE TABLE m_connections(id TEXT PRIMARY KEY)");
    if (kind === "wrong-type") events.db.exec("CREATE VIEW m_selection AS SELECT 1");
    if (kind === "unknown") {
      initializeModelProviderSchema(events.db);
      events.db.exec("PRAGMA ignore_check_constraints=ON; UPDATE m_provider_schema SET version=2");
    }
    if (kind === "dangling-reference") {
      initializeModelProviderSchema(events.db, {
        connectionId: "92bfa5aa-ee9c-4a66-8c26-ec25534804de", modelId: "deepseek-flash", credential: null,
      });
      events.db.exec("PRAGMA foreign_keys=OFF; UPDATE m_connections SET draft_revision=99; PRAGMA foreign_keys=ON");
    }
    if (kind === "missing-unique-index") {
      initializeModelProviderSchema(events.db);
      events.db.exec("DROP INDEX m_live_connection_name");
    }
    if (kind === "immediate-draft-reference") {
      initializeModelProviderSchema(events.db);
      const ddl = events.db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").pluck();
      const table = ddl.get("m_connections") as string;
      const index = ddl.get("m_live_connection_name") as string;
      const foreignKeys = events.db.pragma("foreign_key_list('m_connections')");
      events.db.exec("DROP TABLE m_connections");
      events.db.exec(table.replace(" DEFERRABLE INITIALLY DEFERRED", ""));
      events.db.exec(index);
      expect(events.db.pragma("foreign_key_list('m_connections')")).toEqual(foreignKeys);
      expect(events.db.pragma("foreign_key_check")).toEqual([]);
    }
    await expect(migrateModelProviders(events, root)).rejects.toThrow("MODEL_PROVIDER_SCHEMA_INVALID");
    expect(await readdir(root)).not.toContain("model-provider-backups");
  }),
);

test("keeps recovery materials when old settings cannot be parsed", async () => fixture(async (events, root) => {
  const invalidSettings = Buffer.from('{"model":');
  await writeFile(join(root, "client-settings.json"), invalidSettings);
  const before = migrationInventory(events.db);
  await expect(migrateModelProviders(events, root)).rejects.toThrow("INVALID_LEGACY_MODEL_SETTINGS");
  expect(migrationInventory(events.db)).toBe(before);
  const directory = join(root, "model-provider-backups");
  const [run] = await readdir(directory);
  expect((await readdir(join(directory, run!))).sort()).toEqual(["client-settings.json", "database.sqlite", "manifest.json"]);
  expect(await readFile(join(directory, run!, "client-settings.json"))).toEqual(invalidSettings);
}));

test("rejects a change to the live DB after backup and cleans the staged credential", async () => fixture(async (events, root) => {
  await writeFile(join(root, "model-key.dpapi"), "synthetic encrypted fixture");
  await expect(migrateModelProviders(events, root, {
    credentialProtector: cipher,
    readLegacyKey: () => {
      events.db.exec("UPDATE budgets SET used=2 WHERE kind='MODEL'");
      return "synthetic-legacy-key";
    },
  })).rejects.toThrow("DATABASE_CHANGED_DURING_MIGRATION");
  expect(events.db.prepare("SELECT used FROM budgets WHERE kind='MODEL'").pluck().get()).toBe(2);
  expect(events.db.prepare("SELECT name FROM sqlite_master WHERE name='m_provider_schema'").get()).toBeUndefined();
  expect((await readdir(join(root, "model-credentials"), { recursive: true })).filter(name => name.endsWith(".dpapi"))).toEqual([]);
}));
