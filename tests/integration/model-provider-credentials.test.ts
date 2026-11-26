import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { expect, test, vi } from "vitest";
import { ModelCredentialStore, type ModelCredentialProtector } from "../../src/app/credentials.js";
import { initializeModelProviderSchema, type ModelProviderStore } from "../../src/storage/model-provider-store.js";
import { EventStore } from "../../src/storage/store.js";
import { privateTemp } from "../helpers.js";
import { installFixtureKey, modelFixture, providerState } from "../model-provider-helpers.js";

const directoryFault = vi.hoisted(() => ({ operation: "", path: "" }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  function check(operation: string, path: unknown) {
    if (directoryFault.operation === operation && directoryFault.path === path) {
      throw Object.assign(new Error("fixture access denied"), { code: "EACCES" });
    }
  }
  return { ...fs,
    lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
      check("lstat", args[0]);
      return fs.lstatSync(...args);
    },
    readdirSync: (...args: Parameters<typeof fs.readdirSync>) => {
      check("readdir", args[0]);
      return fs.readdirSync(...args);
    },
  };
});

const cipher: ModelCredentialProtector = {
  protect: async input => Buffer.from(input).reverse(),
  unprotect: async input => Buffer.from(input).reverse(),
};
const endpoints = {
  connectionId: null, expectedVersion: 0, presetId: "deepseek", protocol: "OPENAI_CHAT",
  baseUrl: "https://api.deepseek.com", region: null, manualModels: [],
} as const;

test.each(["malformed JSON", "digest mismatch"])("revokes the selected Key despite a corrupt grant (%s)", async damage => {
  const f = await modelFixture();
  let restarted: typeof f.service | undefined;
  try {
    await installFixtureKey(f.service, f.token, { grant: true });
    const { db } = f.store;
    const active = "WHERE kind='MODEL' AND revoked_at IS NULL";
    if (damage === "malformed JSON") db.prepare("UPDATE automation_grants SET scope_json='{' " + active).run();
    else db.prepare("UPDATE automation_grants SET scope_digest='invalid' " + active).run();
    const before = (await providerState(f.service, f.token)).selection;
    const models = f.service.authority.modelRoute!.models;
    const route = models.getRevision(before.connectionId!, before.routeRevision!)!;
    const status = { command: "getStatus" };
    expect(await f.service.dispatch(f.token, status)).toMatchObject({
      modelProvidersAvailable: true, modelGrantError: "GRANT_CORRUPT",
      corruptModelGrantKinds: ["MODEL"], modelAuthorized: false, keyPresent: true,
    });
    expect(() => f.service.authority.modelRoute!.eligibleGrant("MODEL")).toThrow("GRANT_CORRUPT");
    await f.service.dispatch(f.token, { command: "clearModelKey" });
    const after = (await providerState(f.service, f.token)).selection;
    expect(after).toMatchObject({ selectionRevision: before.selectionRevision + 1, routeRevision: before.routeRevision! + 1 });
    expect(models.getCredential(route.credentialRevision!)).toMatchObject({ revokedAt: expect.any(Number), cleanupState: "DONE" });
    await f.service.close();
    const next = await f.start(); restarted = next.service;
    expect(await next.service.dispatch(next.token, status)).toMatchObject({
      modelProvidersAvailable: true, modelGrantError: "GRANT_CORRUPT",
      corruptModelGrantKinds: ["MODEL"], modelAuthorized: false, keyPresent: false,
    });
    expect(() => next.service.authority.modelRoute!.eligibleGrant("MODEL")).toThrow("GRANT_CORRUPT");
  } finally { await restarted?.close(); await f.close(); }
});

async function fixture(run: (store: ModelProviderStore, root: string) => Promise<void>) {
  const root = privateTemp("provider-credentials-");
  let events: EventStore | undefined;
  try {
    events = new EventStore(join(root, "main.sqlite"), true);
    events.db.pragma("user_version = 3");
    await run(initializeModelProviderSchema(events.db), root);
  } finally {
    try { events?.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}

function publisher(store: ModelProviderStore, id: string, version: number) {
  return (ref: Parameters<ModelProviderStore["setCredential"]>[2]) => {
    store.setCredential(id, version, ref);
    return ref;
  };
}

test.each(["lstat", "readdir"])("staged cleanup isolates a connection %s failure and removes a later orphan", async operation =>
  fixture(async (_store, root) => {
    const base = join(root, "model-credentials");
    const blocked = join(base, "00000000-0000-4000-8000-000000000001");
    const healthy = join(base, "00000000-0000-4000-8000-000000000002");
    await mkdir(blocked, { recursive: true });
    await mkdir(healthy);
    const file = join(healthy, randomUUID() + ".dpapi");
    await writeFile(file, "synthetic ciphertext");
    await writeFile(file + ".pending", "");
    directoryFault.operation = operation;
    directoryFault.path = blocked;
    try {
      expect(await new ModelCredentialStore(root, cipher).cleanupStaged(() => false)).toBe(false);
      expect(await readdir(healthy)).toEqual([]);
    } finally {
      directoryFault.operation = "";
      directoryFault.path = "";
    }
  }));

test("a staged cleanup returning false is surfaced as the fixed cleanup error", async () => {
  const f = await modelFixture();
  let restarted: typeof f.service | undefined;
  try {
    await f.service.close();
    const directory = join(f.root, "model-credentials", randomUUID());
    await mkdir(directory, { recursive: true });
    const file = join(directory, randomUUID() + ".dpapi");
    await writeFile(file + ".pending", "");
    await mkdir(file + ".tmp");
    const next = await f.start();
    restarted = next.service;
    expect(await next.service.dispatch(next.token, { command: "getStatus" })).toMatchObject({
      modelProvidersAvailable: true, keyStorageError: "MODEL_CREDENTIAL_CLEANUP_FAILED",
    });
    expect(await readdir(directory)).toContain(basename(file) + ".pending");
  } finally { await restarted?.close(); await f.close(); }
});

test("isolates connections and removes explicitly revoked MEMORY and DPAPI values", async () => fixture(async (store, root) => {
  const first = store.saveConnection({ ...endpoints, name: "First", manualModels: [] });
  const second = store.saveConnection({ ...endpoints, name: "Second", manualModels: [] });
  const credentials = new ModelCredentialStore(root, cipher);
  const a = await credentials.save(first.id, "synthetic-A", publisher(store, first.id, 1));
  const b = await credentials.save(second.id, "synthetic-B", publisher(store, second.id, 1), "DPAPI");
  expect(await credentials.load(a, store.isCredentialActive)).toBe("synthetic-A");
  expect(await credentials.load(b, store.isCredentialActive)).toBe("synthetic-B");
  expect(await credentials.load({ ...b, connectionId: a.connectionId }, store.isCredentialActive)).toBeNull();
  expect(await new ModelCredentialStore(root, cipher).load(a, store.isCredentialActive)).toBeNull();
  const file = join(root, "model-credentials", b.connectionId, b.credentialRevision + ".dpapi");
  expect((await readFile(file)).includes(Buffer.from("synthetic-B"))).toBe(false);
  store.deleteKeys(first.id, 2);
  store.deleteKeys(second.id, 2);
  await credentials.cleanup(store);
  expect(await credentials.load(a, store.isCredentialActive)).toBeNull();
  expect(await credentials.load(b, store.isCredentialActive)).toBeNull();
  await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
}));

test("refuses to return a late decryption after the database revokes its revision", async () => fixture(async (store, root) => {
  const connection = store.saveConnection({ ...endpoints, name: "Racing", manualModels: [] });
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let pause = false;
  const credentials = new ModelCredentialStore(root, { ...cipher, unprotect: async (value, ref) => {
    if (pause) {
      entered.resolve();
      await resume.promise;
    }
    return cipher.unprotect(value, ref);
  } });
  const ref = await credentials.save(connection.id, "synthetic-late-key", publisher(store, connection.id, 1), "DPAPI");
  pause = true;
  const load = credentials.load(ref, store.isCredentialActive);
  try {
    await entered.promise;
    store.deleteKeys(connection.id, 2);
  } finally { resume.resolve(); }
  expect(await load).toBeNull();
  await credentials.cleanup(store);
}));

test("validates keys/UUIDs and cleans the orphan after a DB publication conflict", async () => fixture(async (store, root) => {
  const row = store.saveConnection({ ...endpoints, name: "Stale", manualModels: [] });
  const credentials = new ModelCredentialStore(root, cipher);
  for (const key of ["", "  ", "x\ny", "x\ry", "x".repeat(4001)]) {
    await expect(credentials.save(row.id, key, () => {})).rejects.toThrow("INVALID_MODEL_KEY");
  }
  await expect(credentials.save("..", "synthetic", () => {})).rejects.toThrow("INVALID_MODEL_CREDENTIAL_ID");
  await expect(credentials.save(row.id, "synthetic", publisher(store, row.id, 9), "DPAPI"))
    .rejects.toThrow("MODEL_CONNECTION_CONFLICT");
  expect(await readdir(join(root, "model-credentials", row.id))).toEqual([]);
  expect(store.db.prepare("SELECT count(*) FROM m_credentials").pluck().get()).toBe(0);
}));

test("rejects an async credential publisher before staging or invoking it", async () => fixture(async (store, root) => {
  const row = store.saveConnection({ ...endpoints, name: "Async", manualModels: [] });
  const credentials = new ModelCredentialStore(root, cipher);
  let invoked = false;
  const publish = async () => { invoked = true; };
  // @ts-expect-error Runtime validation must also protect JavaScript callers.
  const save = credentials.save(row.id, "synthetic", publish, "DPAPI");
  await expect(save).rejects.toThrow("MODEL_PROVIDER_TRANSACTION_HOOK_ASYNC");
  expect(invoked).toBe(false);
  expect(await readdir(root)).not.toContain("model-credentials");
}));

test("cleanup preserves the current selection, latest draft and unregistered files", async () => fixture(async (store, root) => {
  const row = store.saveConnection({ ...endpoints, name: "Referenced", manualModels: [] });
  const credentials = new ModelCredentialStore(root, cipher);
  const active = await credentials.save(row.id, "synthetic-A", publisher(store, row.id, 1), "DPAPI");
  const input = { connectionId: row.id, modelId: "deepseek-flash", expectedSelectionRevision: 0 };
  store.apply({ ...input, routeRevision: 2, commandId: randomUUID() });
  const replaced = await credentials.save(row.id, "synthetic-B", publisher(store, row.id, 2), "DPAPI");
  const draft = await credentials.save(row.id, "synthetic-C", publisher(store, row.id, 3), "DPAPI");
  const dir = join(root, "model-credentials", row.id);
  const foreign = randomUUID() + ".dpapi";
  await writeFile(join(dir, foreign), "unowned");
  await credentials.cleanup(store);
  expect((await readdir(dir)).sort()).toEqual([foreign, active.credentialRevision + ".dpapi", draft.credentialRevision + ".dpapi"].sort());
  expect(store.isCredentialActive(replaced)).toBe(false);
  store.apply({ ...input, routeRevision: 4, commandId: randomUUID(), expectedSelectionRevision: 1 });
  await credentials.cleanup(store);
  expect((await readdir(dir)).sort()).toEqual([foreign, draft.credentialRevision + ".dpapi"].sort());
}));

test("cleanup rejects a redirected connection directory and never follows its target", async () => fixture(async (store, root) => {
  const row = store.saveConnection({ ...endpoints, name: "Redirect", manualModels: [] });
  const credentials = new ModelCredentialStore(root, cipher);
  const ref = await credentials.save(row.id, "synthetic", publisher(store, row.id, 1), "DPAPI");
  const directory = join(root, "model-credentials", row.id);
  const outside = join(root, "unowned");
  const filename = ref.credentialRevision + ".dpapi";
  await rm(join(directory, filename));
  await rm(directory, { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, filename), "unowned");
  await symlink(outside, directory, process.platform === "win32" ? "junction" : "dir");
  await expect(credentials.load(ref, store.isCredentialActive)).rejects.toThrow("DPAPI_RESTORE_FAILED");
  store.deleteKeys(row.id, 2);
  await credentials.cleanup(store);
  expect(await readFile(join(outside, filename), "utf8")).toBe("unowned");
  expect((await lstat(directory)).isSymbolicLink()).toBe(true);
  expect(store.getCredential(ref.credentialRevision)).toMatchObject({ cleanupState: "FAILED", cleanupError: "MODEL_CREDENTIAL_CLEANUP_FAILED" });
}));

test("returns a fixed DPAPI failure without falling back to another Key", async () => fixture(async (store, root) => {
  const a = store.saveConnection({ ...endpoints, name: "A", manualModels: [] });
  const b = store.saveConnection({ ...endpoints, name: "B", manualModels: [] });
  let broken = false;
  const credentials = new ModelCredentialStore(root, { ...cipher, unprotect: (value, ref) => {
    if (broken) throw new Error("synthetic sensitive subprocess details");
    return cipher.unprotect(value, ref);
  } });
  const encrypted = await credentials.save(a.id, "synthetic-DPAPI", publisher(store, a.id, 1), "DPAPI");
  const memory = await credentials.save(b.id, "synthetic-MEMORY", publisher(store, b.id, 1));
  broken = true;
  await expect(credentials.load(encrypted, store.isCredentialActive)).rejects.toThrow(/^DPAPI_RESTORE_FAILED$/);
  expect(await credentials.load(memory, store.isCredentialActive)).toBe("synthetic-MEMORY");
}));
