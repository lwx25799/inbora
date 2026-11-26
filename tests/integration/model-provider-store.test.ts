import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { endpointDigest } from "../../src/ai/provider-presets.js";
import { initializeModelProviderSchema, inlineModelEntries, inspectModelProviderSchema, type ModelProviderStore } from "../../src/storage/model-provider-store.js";
import { EventStore } from "../../src/storage/store.js";
import { privateTemp } from "../helpers.js";

const route = {
  presetId: "deepseek", protocol: "OPENAI_CHAT", baseUrl: "https://api.deepseek.com", region: null,
} as const;
const selection = { expectedSelectionRevision: 0, modelId: "deepseek-flash" };

function withStore(run: (store: ModelProviderStore) => void) {
  const root = privateTemp("provider-store-");
  let eventStore: EventStore | undefined;
  try {
    eventStore = new EventStore(join(root, "main.sqlite"), true);
    eventStore.db.pragma("user_version = 3");
    run(initializeModelProviderSchema(eventStore.db));
  } finally {
    try { eventStore?.close(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
}

function connection(store: ModelProviderStore, name: string) {
  return store.saveConnection({ ...route, connectionId: null, expectedVersion: 0, name, manualModels: [] });
}

function withKey(store: ModelProviderStore, name: string) {
  const added = connection(store, name);
  return store.setCredential(added.id, added.version, {
    connectionId: added.id, credentialRevision: randomUUID(), storage: "MEMORY",
  });
}

test("allows multiple instances of a preset and versions metadata independently of routes", () => withStore(store => {
  const added = connection(store, "First");
  expect(connection(store, "Second").presetId).toBe(added.presetId);
  expect(() => connection(store, " first ")).toThrow("MODEL_CONNECTION_CONFLICT");
  const input = { ...route, connectionId: added.id, expectedVersion: 1, name: "Renamed", manualModels: [] };
  expect(store.saveConnection(input)).toMatchObject({ version: 2, draftRevision: 1, name: "Renamed" });
  expect(() => store.saveConnection(input)).toThrow("MODEL_CONNECTION_CONFLICT");
}));

test("metadata-only saves preserve a large manual catalog across rename and route edit", () => withStore(store => {
  const manualModels = Array.from({ length: 1200 }, (_, index) => ({
    modelId: `manual-${index}`, displayName: `Alias ${index} ${"x".repeat(100)}`,
  }));
  expect(Buffer.byteLength(JSON.stringify(manualModels))).toBeGreaterThan(90_000);
  const added = store.saveConnection({ ...route, connectionId: null, expectedVersion: 0, name: "Large", manualModels });
  const rename = { ...route, connectionId: added.id, expectedVersion: added.version, name: "Renamed" };
  const renamed = store.saveConnection(rename);
  expect(renamed).toMatchObject({ name: "Renamed", version: 2, draftRevision: 1 });
  expect(renamed.models).toEqual(added.models);
  expect(() => store.saveConnection(rename)).toThrow("MODEL_CONNECTION_CONFLICT");
  const moved = store.saveConnection({ ...rename, expectedVersion: renamed.version, baseUrl: "https://example.com/v1" });
  expect(moved.models).toEqual(added.models);
  expect(moved.draftRevision).toBe(2);
}));

test("a stale inline preview cannot delete the newly pinned 33rd manual model or its alias", () => withStore(store => {
  const manualModels = Array.from({ length: 33 }, (_, index) => ({ modelId: `manual-${index}`, displayName: `Alias ${index}` }));
  const added = store.saveConnection({ ...route, connectionId: null, expectedVersion: 0, name: "Paged", manualModels });
  const keyed = store.setCredential(added.id, added.version, {
    connectionId: added.id, credentialRevision: randomUUID(), storage: "MEMORY",
  });
  const stalePreview = inlineModelEntries(keyed.models, null).map(({ modelId, displayName }) => ({ modelId, displayName }));
  const last = manualModels.at(-1)!;
  const applied = store.apply({ ...selection, connectionId: keyed.id, routeRevision: keyed.draftRevision,
    modelId: last.modelId, commandId: randomUUID() });
  const edit = { ...route, connectionId: keyed.id, expectedVersion: keyed.version, name: keyed.name };
  const oldFlag = { ...edit, manualModels: stalePreview, replaceTruncatedManualModels: true as const };
  expect(() => store.saveConnection({ ...edit, manualModels: stalePreview })).toThrow("MODEL_MANUAL_MODELS_TRUNCATED");
  expect(() => store.saveConnection(oldFlag)).toThrow("MODEL_MANUAL_MODELS_TRUNCATED");
  const completeEdit = { ...edit, manualModels: manualModels.slice(1), manualModelsComplete: true as const };
  expect(() => store.saveConnection({ ...completeEdit, expectedSelectionRevision: 0 })).toThrow("MODEL_CONNECTION_CONFLICT");
  expect(store.requireConnection(keyed.id)).toEqual(keyed);
  const updated = store.saveConnection({ ...completeEdit, expectedSelectionRevision: applied.selectionRevision });
  expect(updated.models).toEqual(keyed.models.slice(1));
  expect(updated.models.at(-1)).toEqual({ ...last, source: "MANUAL" });
}));

test.each([
  ["PARTIAL", "MODEL_TIMEOUT", false], ["PARTIAL", "MODEL_NETWORK_ERROR", false],
  ["PARTIAL", "MODEL_RESPONSE_TOO_LARGE", true], ["PARTIAL", null, true],
] as const)("persists catalog summary %s with reason %s and truncation %s", (status, reason, truncated) => withStore(store => {
  const row = connection(store, "Catalog");
  const result = { connectionId: row.id, routeRevision: row.draftRevision, status, reason, fetchedAt: 10, models: [] };
  expect(store.recordCatalog(result)).toMatchObject({ status, reason, truncated });
  expect(store.getRevisionStatus(row.id, row.draftRevision).catalogResult).toMatchObject({ status, reason, truncated });
  const stored = store.db.prepare("UPDATE m_connection_revisions SET catalog_result_json=? WHERE connection_id=?");
  stored.run(JSON.stringify({ ...result, totalCount: 0, truncated: true, retainedSelectedModelId: null, models: undefined }), row.id);
  expect(store.getRevisionStatus(row.id, row.draftRevision).catalogResult).toMatchObject({ status, reason, truncated });
  stored.run(JSON.stringify(result), row.id);
  expect(store.getRevisionStatus(row.id, row.draftRevision).catalogResult).toMatchObject({ status, reason, truncated });
}));

test("saves an endpoint as a separate keyless draft and preserves the applied route", () => withStore(store => {
  const added = withKey(store, "Applied");
  const applied = store.apply({ ...selection, connectionId: added.id, routeRevision: 2, commandId: randomUUID() });
  const edited = store.saveConnection({
    ...route, connectionId: added.id, expectedVersion: added.version, name: added.name,
    baseUrl: "https://example.com/v1", manualModels: [],
  });
  expect(edited).toMatchObject({ version: 3, draftRevision: 3 });
  expect(store.getRevision(added.id, 2)).toMatchObject({
    baseUrl: route.baseUrl, credentialRevision: expect.any(String),
    endpointDigest: endpointDigest(route.baseUrl),
  });
  expect(store.getRevision(added.id, 3)).toMatchObject({ baseUrl: "https://example.com/v1", credentialRevision: null });
  expect(store.getSelection()).toEqual(applied);
  expect(() => store.deleteConnection(added.id, edited.version)).toThrow("MODEL_CONNECTION_CONFLICT");
  expect(store.deleteKeys(added.id, edited.version)).toMatchObject({ draftRevision: 5 });
  const keyless = store.getSelection();
  expect(keyless).toMatchObject({ connectionId: added.id, modelId: selection.modelId, selectionRevision: 2 });
  expect(store.getRevision(added.id, keyless.routeRevision!)).toMatchObject({ baseUrl: route.baseUrl, credentialRevision: null });
}));

test("replays identical APPLY, rejects conflicts, and rolls back the same-transaction hook", () => withStore(store => {
  const added = withKey(store, "Applied");
  const input = { ...selection, connectionId: added.id, routeRevision: 2, commandId: randomUUID() };
  expect(() => store.apply(input, () => {
    expect(store.getSelection().selectionRevision).toBe(1);
    store.db.prepare("UPDATE budgets SET used=1 WHERE kind='MODEL'").run();
    throw new Error("hook failed");
  })).toThrow("hook failed");
  expect(store.getSelection().selectionRevision).toBe(0);
  expect(store.db.prepare("SELECT used FROM budgets WHERE kind='MODEL'").pluck().get()).toBe(0);
  const first = store.apply(input);
  expect(store.apply(input, () => { throw new Error("replayed hook"); })).toEqual(first);
  expect(() => store.apply({ ...input, modelId: "another-model" })).toThrow("MODEL_COMMAND_CONFLICT");
  const { expectedSelectionRevision: _, ...testInput } = input;
  expect(() => store.startTest(testInput, () => {})).toThrow("MODEL_COMMAND_CONFLICT");
  expect(store.apply({ ...input, commandId: randomUUID(), expectedSelectionRevision: 1 },
    () => { throw new Error("same selection hook"); })).toEqual(first);
}));

test("keeps call and generation provenance after logical deletion", () => withStore(store => {
  const added = withKey(store, "Historical");
  const input = { connectionId: added.id, routeRevision: 2, modelId: selection.modelId, commandId: randomUUID() };
  const started = store.startTest(input, () => {});
  store.finishTest({ ...started.result, status: "SUCCEEDED", elapsedMs: 10 });
  // Generation sources refer to normal calls. Insert one with the same applied route before switching away.
  const applied = store.apply({ ...input, commandId: randomUUID(), expectedSelectionRevision: 0 });
  const current = store.getRevision(added.id, 2)!;
  const callId = randomUUID();
  store.db.prepare("INSERT INTO model_calls VALUES (?,?,'SUCCEEDED',NULL,NULL,NULL,NULL)").run(callId, input.modelId);
  store.recordCallRoute(callId, {
    connectionId: added.id, routeRevision: 2, presetId: current.presetId, protocol: current.protocol,
    endpointDigest: current.endpointDigest, credentialRevision: current.credentialRevision!,
    selectionRevision: applied.selectionRevision, grantVersion: 1, modelId: input.modelId, purpose: "REPLY_GENERATION",
  });
  const suggestion = { ownerKind: "SUGGESTION", ownerId: "suggestion", ownerVersion: 1 } as const;
  const draft = { ownerKind: "DRAFT", ownerId: "draft", ownerVersion: 2 } as const;
  expect(() => store.bindGeneration(suggestion, started.callId)).toThrow("INVALID_MODEL_GENERATION_SOURCE");
  expect(() => store.bindGeneration(suggestion, callId)).toThrow("INVALID_MODEL_GENERATION_SOURCE");
  store.db.transaction(() => {
    store.finishCallRoute(callId, { outcome: "SUCCEEDED", reportedModel: null, errorCode: null, usageDetails: null });
    store.bindGeneration(suggestion, callId);
    store.copyGenerationBinding(suggestion, draft);
  }).immediate();
  const other = withKey(store, "Other");
  store.apply({ ...selection, expectedSelectionRevision: 1, connectionId: other.id, routeRevision: 2, commandId: randomUUID() });
  store.deleteConnection(added.id, added.version);
  expect(store.listConnections().map(row => row.id)).toEqual([other.id]);
  expect(store.getGenerationCallId(draft)).toBe(callId);
  expect(store.getCallRoute(callId)).toMatchObject({ connectionId: added.id, credentialRevision: current.credentialRevision });
  expect(store.getCallRoute(started.callId)).toMatchObject({ outcome: "SUCCEEDED" });
  expect(store.db.pragma("foreign_key_check")).toEqual([]);
}));

test("tracks discovery and test results per route and interrupts tests without replaying", () => withStore(store => {
  const added = withKey(store, "Test");
  const input = { connectionId: added.id, routeRevision: 2, modelId: selection.modelId, commandId: randomUUID() };
  store.recordCatalog({ ...inputRoute(input), status: "COMPLETE", models: [
    { modelId: selection.modelId, displayName: null, source: "DISCOVERED" },
  ], fetchedAt: 10, reason: null });
  expect(store.getRevisionStatus(added.id, 2)).toMatchObject({ catalogResult: { status: "COMPLETE" }, testResult: null });
  const started = store.startTest(input, () => {
    store.db.prepare("UPDATE budgets SET used=used+1 WHERE kind='MODEL'").run();
  });
  expect(started.snapshot).toMatchObject({ commandId: input.commandId, purpose: "PROVIDER_TEST" });
  expect(store.startTest(input, () => { throw new Error("reserved twice"); })).toEqual({ ...started, snapshot: null });
  expect(store.db.prepare("SELECT used FROM budgets WHERE kind='MODEL'").pluck().get()).toBe(1);
  store.finishTest({ ...started.result, status: "SUCCEEDED" });
  const inFlight = { ...input, commandId: randomUUID() };
  store.startTest(inFlight, () => {});
  const updated = store.setCredential(added.id, added.version + 1, {
    connectionId: added.id, credentialRevision: randomUUID(), storage: "MEMORY",
  });
  expect(store.getRevisionStatus(added.id, updated.draftRevision)).toEqual({ catalogResult: null, testResult: null });
  expect(store.listCleanableCredentials()).toEqual([]);
  expect(store.interruptTests()).toBe(1);
  expect(store.startTest(inFlight, () => { throw new Error("restarted"); })).toMatchObject({ result: { status: "INTERRUPTED" }, snapshot: null });
  expect(store.listCleanableCredentials()).toHaveLength(1);
}));

function inputRoute(input: { connectionId: string; routeRevision: number }) {
  return { connectionId: input.connectionId, routeRevision: input.routeRevision };
}

test("rejects an async transaction hook before it acquires work", () => withStore(store => {
  const added = withKey(store, "Async hook");
  const input = { ...selection, connectionId: added.id, routeRevision: 2, commandId: randomUUID() };
  let invoked = false;
  const asyncHook = async () => { invoked = true; };
  // @ts-expect-error Runtime validation must also protect JavaScript callers.
  expect(() => store.apply(input, asyncHook)).toThrow("MODEL_PROVIDER_TRANSACTION_HOOK_ASYNC");
  expect(invoked).toBe(false);
  expect(store.getSelection().selectionRevision).toBe(0);
}));

test("restores the discovered entry after removing its manual alias, even after a failed refresh", () => withStore(store => {
  const row = connection(store, "Catalog");
  const target = { connectionId: row.id, routeRevision: row.draftRevision };
  const model = { modelId: "deepseek-flash", displayName: "Provider label", source: "DISCOVERED" } as const;
  store.recordCatalog({ ...target, status: "COMPLETE", models: [model], fetchedAt: 10, reason: null });
  const edit = { ...route, connectionId: row.id, expectedVersion: 2, name: row.name };
  const aliased = store.saveConnection({ ...edit, manualModels: [{ modelId: model.modelId, displayName: "My label" }] });
  expect(aliased.models).toEqual([{ ...model, displayName: "My label", source: "MANUAL" }]);
  store.recordCatalog({ ...target, status: "FAILED", models: [], fetchedAt: null, reason: "MODEL_NETWORK_ERROR" });
  const restored = store.saveConnection({ ...edit, expectedVersion: aliased.version, manualModels: [] });
  expect(restored).toMatchObject({ models: [model], modelsFetchedAt: 10, draftRevision: 1 });
  expect(store.getRevisionStatus(row.id, 1)).toMatchObject({ catalogResult: { status: "FAILED" }, testResult: null });
}));

test.each([
  "FOREIGN KEY (route_revision,connection_id) REFERENCES m_connection_revisions(connection_id,route_revision)",
  "FOREIGN KEY (route_revision,connection_id) REFERENCES m_connection_revisions(route_revision,connection_id)",
])("rejects a composite foreign key with unexpected ordered pairings (%s)", foreignKey => withStore(store => {
  store.db.exec(`DROP TABLE m_selection;
    CREATE TABLE m_selection (id INTEGER PRIMARY KEY, connection_id TEXT, route_revision INTEGER, model_id TEXT,
      revision INTEGER NOT NULL, ${foreignKey}) STRICT;
    INSERT INTO m_selection VALUES(1,NULL,NULL,NULL,0)`);
  expect(store.db.pragma("foreign_key_check")).toEqual([]);
  expect(() => inspectModelProviderSchema(store.db)).toThrow("MODEL_PROVIDER_SCHEMA_INVALID");
}));

test("keeps the selected provider label and manual alias across a complete refresh", () => withStore(store => {
  const row = withKey(store, "Selected catalog");
  const target = { connectionId: row.id, routeRevision: row.draftRevision };
  const chosen = { modelId: selection.modelId, displayName: "\u4e2d\u6587\u6a21\u578b", source: "DISCOVERED" } as const;
  const other = { modelId: "new-model", displayName: null, source: "DISCOVERED" } as const;
  store.recordCatalog({ ...target, status: "COMPLETE", models: [chosen], fetchedAt: 10, reason: null });
  store.apply({ ...target, ...selection, commandId: randomUUID() });
  const edit = { ...route, connectionId: row.id, name: row.name };
  store.saveConnection({ ...edit, expectedVersion: row.version + 1,
    manualModels: [{ modelId: chosen.modelId, displayName: "My alias" }] });
  const summary = store.recordCatalog({ ...target, status: "COMPLETE", models: [other], fetchedAt: 20, reason: null });
  expect(summary).toEqual({ ...target, status: "COMPLETE", totalCount: 1, truncated: false,
    selectedModelInCatalog: false, fetchedAt: 20, reason: null });
  expect(JSON.parse(store.db.prepare("SELECT catalog_result_json FROM m_connection_revisions WHERE route_revision=?")
    .pluck().get(target.routeRevision) as string)).not.toHaveProperty("models");
  const page = store.listModelsPage(row.id, 0, 1);
  expect(page).toMatchObject({ models: [{ ...chosen, displayName: "My alias", source: "MANUAL" }],
    totalModelCount: 2, nextOffset: 1 });
  expect(store.listModelsPage(row.id, 1, 1)).toMatchObject({ models: [other], nextOffset: null });
  expect(store.saveConnection({ ...edit, expectedVersion: page.version, manualModels: [] }).models).toEqual([chosen, other]);
  expect(store.getRevisionStatus(row.id, target.routeRevision).catalogResult).toEqual(summary);
}));
