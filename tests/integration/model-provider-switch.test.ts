import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { AutomationStore } from "../../src/storage/automation-store.js";
import { digest } from "../../src/core/contracts.js";
import { replyPolicySchema } from "../../src/contracts/automation.js";
import { publicModelStateSchema } from "../../src/contracts/model-providers.js";
import { applyModel, fixturePolicy, installFixtureKey, modelFixture, providerState, stageFixtureModel } from "../model-provider-helpers.js";

const reservations = (store: Awaited<ReturnType<typeof modelFixture>>["store"], version: number) =>
  store.db.prepare("SELECT kind,job_key,reserved_at FROM grant_reservations WHERE grant_version=? ORDER BY kind,job_key").all(version);

test("public selection uses the applied catalog label after a Key rotation and a conflicting draft refresh", async () => {
  const f = await modelFixture();
  try {
    await installFixtureKey(f.service, f.token);
    const models = f.service.authority.modelRoute!.models;
    const { connectionId, routeRevision, modelId } = models.getSelection();
    const target = { connectionId: connectionId!, routeRevision: routeRevision! };
    const label = { modelId: modelId!, displayName: "Applied catalog label", source: "DISCOVERED" } as const;
    const catalog = { ...target, status: "COMPLETE", models: [label], fetchedAt: 10, reason: null } as const;
    models.recordCatalog({ ...catalog, models: [...catalog.models] });
    const row = models.requireConnection(target.connectionId);
    const keyChange = { command: "modelProviders", action: "setKey", connectionId, expectedVersion: row.version,
      storage: "MEMORY", key: "synthetic-new-key" };
    await f.service.dispatch(f.token, keyChange);
    const afterRotation = publicModelStateSchema.parse(await providerState(f.service, f.token));
    expect(afterRotation.selection).toMatchObject({ modelId, modelDisplayName: label.displayName });
    const draftRevision = afterRotation.connections[0]!.draftRevision;
    expect(draftRevision).toBeGreaterThan(target.routeRevision);
    models.recordCatalog({ ...catalog, routeRevision: draftRevision, models: [{ ...label, displayName: "Draft catalog label" }] });
    expect((await providerState(f.service, f.token)).selection).toMatchObject({ modelDisplayName: label.displayName });
  } finally { await f.close(); }
});

test("public selection keeps a manual model alias after a Key rotation", async () => {
  const f = await modelFixture();
  try {
    const { service, token } = f;
    const modelId = "manual-only";
    const displayName = "Manual alias";
    const state = publicModelStateSchema.parse(await service.dispatch(token, {
      command: "modelProviders", action: "save", connectionId: null, expectedVersion: 0,
      name: "Manual connection", presetId: "custom", protocol: "OPENAI_CHAT",
      baseUrl: "https://models.example.com/v1", region: null, manualModels: [{ modelId, displayName }],
    }));
    const created = state.connections.find(row => row.name === "Manual connection")!;
    const setKey = (expectedVersion: number, key: string) => service.dispatch(token, {
      command: "modelProviders", action: "setKey", connectionId: created.id, expectedVersion, key, storage: "MEMORY",
    });
    const keyed = publicModelStateSchema.parse(await setKey(created.version, "synthetic-first-key"));
    const draft = keyed.connections.find(row => row.id === created.id)!;
    const applied = await applyModel(service, token, draft.id, draft.draftRevision, modelId);
    const rotated = publicModelStateSchema.parse(await setKey(draft.version, "synthetic-second-key"));
    expect(rotated.connections.find(row => row.id === draft.id)!.draftRevision).toBeGreaterThan(draft.draftRevision);
    expect(rotated.selection).toMatchObject({ ...applied, modelDisplayName: displayName });
  } finally { await f.close(); }
});

test("connection paging rejects stale revisions after creation, selection reorder and deletion", async () => {
  const f = await modelFixture();
  try {
    const list = async (offset: number, expectedListRevision?: number) => publicModelStateSchema.parse(
      await f.service.dispatch(f.token, { command: "modelProviders", action: "list", offset, limit: 1,
        ...(expectedListRevision === undefined ? {} : { expectedListRevision }) }),
    );
    const revisionOf = (page: Awaited<ReturnType<typeof list>>) =>
      (page as typeof page & { listRevision: number }).listRevision;
    const first = await list(0);
    expect(revisionOf(first)).toEqual(expect.any(Number));
    const added = await stageFixtureModel(f.service, f.token);
    await expect(list(1, revisionOf(first))).rejects.toThrow("MODEL_CONNECTION_CONFLICT");
    const second = await list(0);
    expect(revisionOf(second)).toBeGreaterThan(revisionOf(first));
    expect((await list(1, revisionOf(second))).connections[0]?.id).toBe(added.connectionId);
    await applyModel(f.service, f.token, added.connectionId, added.routeRevision, added.modelId);
    await expect(list(1, revisionOf(second))).rejects.toThrow("MODEL_CONNECTION_CONFLICT");
    const reordered = await list(0);
    expect(revisionOf(reordered)).toBeGreaterThan(revisionOf(second));
    expect(reordered.connections[0]?.id).toBe(added.connectionId);
    const { id, version } = first.connections[0]!;
    await f.service.dispatch(f.token, { command: "modelProviders", action: "delete", connectionId: id, expectedVersion: version });
    await expect(list(1, revisionOf(reordered))).rejects.toThrow("MODEL_CONNECTION_CONFLICT");
    expect(revisionOf(await list(0))).toBeGreaterThan(revisionOf(reordered));
  } finally { await f.close(); }
});

test("switches both live grants in one transaction without changing budgets or consumed job sets", async () => {
  const f = await modelFixture();
  try {
    await installFixtureKey(f.service, f.token, { grant: true });
    const auto = new AutomationStore(f.store);
    const policy = auto.grant("AUTO_REPLY", fixturePolicy);
    const model = auto.active("MODEL")!;
    auto.reserve(model.version, "MODEL", "manual");
    auto.reserve(policy.version, "MODEL", "automatic");
    auto.reserve(policy.version, "SEND", "sent");
    f.store.consumeBudget("MODEL");
    f.store.consumeBudget("SEND");
    const initial = (await providerState(f.service, f.token)).selection;
    const target = await stageFixtureModel(f.service, f.token);
    expect((await providerState(f.service, f.token)).selection).toEqual(initial);
    const before = f.store.budgets();
    const commandId = randomUUID();
    const selected = await applyModel(f.service, f.token, target.connectionId, target.routeRevision, target.modelId,
      initial.selectionRevision, commandId);
    expect(selected.selectionRevision).toBe(initial.selectionRevision + 1);
    for (const previous of [model, policy]) {
      const next = auto.active(previous.kind)!;
      expect(next.version).toBeGreaterThan(previous.version);
      const { model: _model, ...scope } = previous.scope;
      const { modelId: _id, ...binding } = selected;
      expect(next.scope).toMatchObject({ ...scope, contractVersion: 2, model: target.modelId, modelBinding: binding });
      expect(reservations(f.store, next.version)).toEqual(reservations(f.store, previous.version));
      expect(f.store.db.prepare("SELECT revoked_at FROM automation_grants WHERE version=?").pluck().get(previous.version)).toEqual(expect.any(Number));
    }
    expect(f.store.budgets()).toEqual(before);
    const g = f.store.db.prepare("SELECT count(*) FROM automation_grants").pluck();
    const count = g.get();
    expect(await applyModel(f.service, f.token, target.connectionId, target.routeRevision, target.modelId)).toEqual(selected);
    expect(g.get()).toBe(count);
    expect(await applyModel(f.service, f.token, target.connectionId, target.routeRevision, target.modelId,
      initial.selectionRevision, commandId)).toEqual(selected);
    await expect(applyModel(f.service, f.token, target.connectionId, target.routeRevision, "other",
      initial.selectionRevision, commandId)).rejects.toThrow("MODEL_COMMAND_CONFLICT");
    const returned = await applyModel(f.service, f.token, initial.connectionId!, initial.routeRevision!, initial.modelId!);
    expect(returned).toEqual({ ...initial, selectionRevision: selected.selectionRevision + 1 });
    expect(f.store.budgets()).toEqual(before);
  } finally { await f.close(); }
});

test.each(["missing", "expired", "revoked"])("switch never revives a %s MODEL grant even when global budget is exhausted", async state => {
  const f = await modelFixture(() => { throw new Error("Unexpected network call"); });
  try {
    await installFixtureKey(f.service, f.token);
    const auto = new AutomationStore(f.store, () => 1);
    if (state !== "missing") auto.grant("MODEL", {
      ownId: "own-1", channels: ["DIRECT_MESSAGE"], model: "deepseek-flash", modelLimit: 1, expiresAt: 2,
    });
    if (state === "revoked") auto.revoke("MODEL");
    f.store.db.prepare("UPDATE budget_limits SET maximum=0 WHERE kind='MODEL'").run();
    const target = await stageFixtureModel(f.service, f.token);
    const grants = f.store.db.prepare("SELECT * FROM automation_grants").all();
    await applyModel(f.service, f.token, target.connectionId, target.routeRevision, target.modelId);
    expect(f.store.db.prepare("SELECT * FROM automation_grants").all()).toEqual(grants);
    await expect(f.service.dispatch(f.token, { command: "generateSuggestion", eventId: f.eventId, draftVersion: 0 }))
      .rejects.toThrow("REAL_MODEL_AUTHORIZATION_REQUIRED");
  } finally { await f.close(); }
});

test("two different concurrent applies admit one expected selection, durably survive restart, and preserve exhausted grant", async () => {
  const f = await modelFixture(() => { throw new Error("Unexpected network call"); });
  let restarted: typeof f.service | undefined;
  try {
    await installFixtureKey(f.service, f.token, { grant: true });
    const before = (await providerState(f.service, f.token)).selection;
    const target = await stageFixtureModel(f.service, f.token);
    const auto = new AutomationStore(f.store);
    const grant = auto.grant("MODEL", { ownId: "own-1", channels: ["DIRECT_MESSAGE"], model: before.modelId!, modelLimit: 1, expiresAt: null });
    auto.reserve(grant.version, "MODEL", "spent");
    f.store.consumeBudget("MODEL");
    const outcomes = await Promise.allSettled(["vendor/model:review", "vendor/model:alternate"].map(model =>
      applyModel(f.service, f.token, target.connectionId, target.routeRevision, model, before.selectionRevision)));
    const winner = outcomes.find(row => row.status === "fulfilled");
    expect(outcomes.filter(row => row.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find(row => row.status === "rejected")).toMatchObject({ reason: { code: "MODEL_CONNECTION_CONFLICT" } });
    await expect(f.service.dispatch(f.token, { command: "generateSuggestion", eventId: f.eventId, draftVersion: 0 }))
      .rejects.toThrow("MODEL_GRANT_EXHAUSTED");
    await f.service.close();
    const next = await f.start();
    restarted = next.service;
    expect((await providerState(next.service, next.token)).selection).toEqual(winner?.value);
    expect(await next.service.dispatch(next.token, { command: "getStatus" })).toMatchObject({
      settings: { model: winner?.value.modelId }, keyPresent: false,
    });
  } finally { await restarted?.close(); await f.close(); }
});

test("incomplete model extension disables the model surface while workbench status and human editing continue", async () => {
  const f = await modelFixture();
  let restarted: typeof f.service | undefined;
  try {
    await f.service.close();
    f.store.db.exec("DROP TABLE m_generation_bindings");
    const next = await f.start();
    restarted = next.service;
    expect(await next.service.dispatch(next.token, { command: "getStatus" })).toMatchObject({
      modelProvidersAvailable: false, modelProvidersUnavailableReason: "MODEL_PROVIDER_SCHEMA_INVALID",
    });
    await expect(providerState(next.service, next.token)).rejects.toThrow("MODEL_PROVIDER_SCHEMA_INVALID");
    const owner = next.service.authority.claim(next.token, f.eventId, 0);
    expect(next.service.authority.save(next.token, f.eventId, owner.generation, 0, "Human draft")?.text).toBe("Human draft");
  } finally { await restarted?.close(); await f.close(); }
});

test("a migrated legacy grant keeps its original digest until explicit key deletion and rebinds after replacement", async () => {
  const f = await modelFixture();
  try {
    const auto = new AutomationStore(f.store);
    const scope = { ownId: "own-1", channels: ["DIRECT_MESSAGE"], model: "deepseek-flash", modelLimit: 2, expiresAt: null };
    const inserted = f.store.db.prepare("INSERT INTO automation_grants(kind,scope_json,scope_digest,created_at) VALUES('MODEL',?,?,?)")
      .run(JSON.stringify(scope), digest(scope), Date.now());
    const initial = auto.active("MODEL")!;
    expect(initial.scope).toEqual(scope);
    expect(f.service.authority.modelRoute!.eligibleGrant("MODEL")?.version).toBe(Number(inserted.lastInsertRowid));
    auto.reserve(initial.version, "MODEL", "legacy-job");
    f.store.consumeBudget("MODEL");
    const budget = f.store.budgets();
    await f.service.dispatch(f.token, { command: "clearModelKey" });
    const keyless = (await providerState(f.service, f.token)).selection;
    expect(auto.active("MODEL")?.scope).toMatchObject({ contractVersion: 2, modelBinding: { selectionRevision: keyless.selectionRevision } });
    await installFixtureKey(f.service, f.token);
    expect(auto.active("MODEL")?.scope).toMatchObject({ contractVersion: 2, modelBinding: { selectionRevision: keyless.selectionRevision + 1 } });
    expect(reservations(f.store, auto.active("MODEL")!.version)).toEqual(reservations(f.store, initial.version));
    expect(f.store.budgets()).toEqual(budget);
    expect(f.store.db.prepare("SELECT scope_digest FROM automation_grants WHERE version=?").pluck().get(initial.version)).toBe(digest(scope));
  } finally { await f.close(); }
});

test("a paid automatic draft stays recoverable when a same-route legacy policy changes only its limits", async () => {
  const f = await modelFixture();
  try {
    const guard = f.service.authority.modelRoute!;
    const { models, automation: auto } = guard;
    const { route, modelId } = guard.current();
    const credentialRevision = randomUUID();
    const { db } = f.store;
    db.transaction(() => {
      db.prepare("INSERT INTO m_credentials (credential_revision,connection_id,storage,created_at,cleanup_state) VALUES(?,?,'MEMORY',?,'ACTIVE')")
        .run(credentialRevision, route.connectionId, Date.now());
      db.prepare("UPDATE m_connection_revisions SET credential_revision=? WHERE connection_id=? AND route_revision=?")
        .run(credentialRevision, route.connectionId, route.routeRevision);
    })();
    const legacyPolicy = replyPolicySchema.parse({ ...fixturePolicy, model: modelId });
    db.prepare("INSERT INTO automation_grants(kind,scope_json,scope_digest,created_at) VALUES('AUTO_REPLY',?,?,?)")
      .run(JSON.stringify(legacyPolicy), digest(legacyPolicy), Date.now());
    const legacy = guard.eligibleGrant("AUTO_REPLY")!;
    const callId = randomUUID();
    const owner = { ownerKind: "DRAFT", ownerId: randomUUID(), ownerVersion: 1 } as const;
    db.transaction(() => {
      auto.reserve(legacy.version, "MODEL", f.eventId);
      f.store.consumeBudget("MODEL");
      db.prepare("INSERT INTO model_calls VALUES (?,?,'SUCCEEDED',NULL,NULL,NULL,NULL)").run(callId, modelId);
      models.recordCallRoute(callId, guard.snapshot(legacy, "REPLY_GENERATION"));
      models.finishCallRoute(callId, { outcome: "SUCCEEDED", reportedModel: modelId, errorCode: null, usageDetails: null });
      models.bindGeneration(owner, callId);
    })();
    expect(() => guard.assertAutomaticDraft(owner, legacy.version, f.eventId)).not.toThrow();
    const updated = auto.grant("AUTO_REPLY", { ...legacyPolicy, modelLimit: 3, sendLimit: 3 });
    expect(updated.scope).toMatchObject({ contractVersion: 2, modelBinding: { routeRevision: route.routeRevision } });
    expect(reservations(f.store, updated.version)).toEqual(reservations(f.store, legacy.version));
    expect(() => guard.assertAutomaticDraft(owner, updated.version, f.eventId)).not.toThrow();
    const changed = auto.grant("AUTO_REPLY", { ...legacyPolicy, instructions: "Different rules." });
    expect(() => guard.assertAutomaticDraft(owner, changed.version, f.eventId)).toThrow("POLICY_NO_LONGER_AUTHORIZED");
    expect(f.store.budget("MODEL").used).toBe(1);
  } finally { await f.close(); }
});

test("an unsupported factory route cannot change selection or consume a test attempt", async () => {
  const f = await modelFixture(() => { throw new Error("Unexpected network call"); });
  try {
    await installFixtureKey(f.service, f.token, { grant: true });
    const original = (await providerState(f.service, f.token)).selection;
    const budget = f.store.budgets();
    const grants = f.store.db.prepare("SELECT * FROM automation_grants").all();
    const target = await stageFixtureModel(f.service, f.token, "Unsupported", "deepseek", "OPENAI_RESPONSES");
    await expect(applyModel(f.service, f.token, target.connectionId, target.routeRevision, target.modelId))
      .rejects.toThrow("MODEL_PROTOCOL_UNSUPPORTED");
    await expect(f.service.dispatch(f.token, { command: "modelProviders", action: "test", commandId: randomUUID(),
      connectionId: target.connectionId, routeRevision: target.routeRevision, modelId: target.modelId, confirmed: true }))
      .rejects.toThrow("MODEL_PROTOCOL_UNSUPPORTED");
    expect((await providerState(f.service, f.token)).selection).toEqual(original);
    expect(f.store.budgets()).toEqual(budget);
    expect(f.store.db.prepare("SELECT * FROM automation_grants").all()).toEqual(grants);
  } finally { await f.close(); }
});
