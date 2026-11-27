import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { resolveSlotRoute } from "../../src/ai/slot-router.js";
import { ModelCredentialStore } from "../../src/app/credentials.js";
import { ModelProviderController } from "../../src/app/model-provider-controller.js";
import { ModelRouteGuard } from "../../src/app/model-route-guard.js";
import { DEFAULT_ACCOUNT_AI_FEATURES } from "../../src/contracts/ai-runtime.js";
import { AccountAiFeaturesStore } from "../../src/storage/account-ai-features.js";
import { migrateAutomation } from "../../src/storage/automation-migration.js";
import { AutomationStore } from "../../src/storage/automation-store.js";
import { migrateClient } from "../../src/storage/client-migration.js";
import { initializeModelProviderSchema, inspectModelProviderSchema } from "../../src/storage/model-provider-store.js";
import { ModelSlotStore } from "../../src/storage/model-slot-store.js";
import { EventStore } from "../../src/storage/store.js";
import { privateTemp } from "../helpers.js";

async function withSlotHarness(
  run: (ctx: {
    store: EventStore;
    automation: AutomationStore;
    controller: ModelProviderController;
    slots: ModelSlotStore;
  }) => Promise<void> | void,
) {
  const root = privateTemp("slot-router-");
  const store = new EventStore(join(root, "main.sqlite"), true);
  try {
    await migrateClient(store, join(root, "client.sqlite"));
    store.bindAccount("account_001", "own-1");
    await migrateAutomation(store, join(root, "automation.sqlite"));
    const automation = new AutomationStore(store);
    automation.initialize(1000);
    const models = initializeModelProviderSchema(store.db);
    const guard = new ModelRouteGuard(models, automation);
    const credentials = new ModelCredentialStore(root);
    const controller = new ModelProviderController(guard, credentials, globalThis.fetch, () => {});
    await controller.initialize();
    const slots = new ModelSlotStore(models);
    await run({ store, automation, controller, slots });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function addKeyedConnection(
  controller: ModelProviderController,
  name: string,
  baseUrl: string,
  modelId: string,
) {
  const saved = controller.models.saveConnection({
    connectionId: null,
    expectedVersion: 0,
    name,
    presetId: "openai",
    protocol: "OPENAI_CHAT",
    baseUrl,
    region: null,
    manualModels: [{ modelId, displayName: null }],
  });
  await controller.dispatch(
    {
      command: "modelProviders",
      action: "setKey",
      connectionId: saved.id,
      expectedVersion: saved.version,
      storage: "MEMORY",
      key: "sk-synthetic-slot-test-key",
    },
    () => {},
  );
  return controller.models.requireConnection(saved.id);
}

test("getSlots is pure read-only and never touches m_* schema or creates model_slot_routes", async () => {
  await withSlotHarness(async ({ store, controller, slots }) => {
    const initial = slots.getSlots();
    expect(initial).toEqual({
      primary: { connectionId: null, routeRevision: null, modelId: null, selectionRevision: 0 },
      vision: null,
      utility: null,
      embedding: null,
    });
    const existsBefore = store.db
      .prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name='model_slot_routes'")
      .get();
    expect(existsBefore).toBeUndefined();
    expect(inspectModelProviderSchema(store.db)).toBe("READY");

    const conn = await addKeyedConnection(controller, "VisionConn", "https://api.openai.com/v1", "gpt-4o");
    const updated = slots.setSlot({
      commandId: randomUUID(),
      slot: "vision",
      connectionId: conn.id,
      routeRevision: conn.draftRevision,
      modelId: "gpt-4o",
      confirmed: true,
    });
    expect(updated.vision).toMatchObject({
      slot: "vision",
      connectionId: conn.id,
      routeRevision: conn.draftRevision,
      modelId: "gpt-4o",
      revision: 1,
    });
    expect(inspectModelProviderSchema(store.db)).toBe("READY");
  });
});

test("resolveSlotRoute implements primary, vision, utility, and embedding fallback contracts", async () => {
  await withSlotHarness(async ({ store, automation, controller, slots }) => {
    const primaryConn = await addKeyedConnection(controller, "PrimaryConn", "https://api.openai.com/v1", "gpt-4.1-mini");
    await controller.dispatch(
      {
        command: "modelProviders",
        action: "apply",
        connectionId: primaryConn.id,
        routeRevision: primaryConn.draftRevision,
        modelId: "gpt-4.1-mini",
        commandId: randomUUID(),
        confirmed: true,
        expectedSelectionRevision: 0,
      },
      () => {},
    );
    const grant = automation.grant("MODEL", {
      ownId: "own-1",
      channels: ["DIRECT_MESSAGE"],
      model: "gpt-4.1-mini",
      modelLimit: 10,
      expiresAt: null,
    });

    // primary directly uses m_selection
    const primaryRes = resolveSlotRoute(store, slots, controller, grant, "primary");
    expect(primaryRes.decision).toBe("use_model");
    expect(primaryRes.route?.modelId).toBe("gpt-4.1-mini");
    expect(primaryRes.transportPolicy).toEqual({ publicHttpsOnly: true, redirect: "error", maxRetries: 0 });

    // vision hands off when visionEnabled is false (default) even if vision slot is configured
    const visionConn = await addKeyedConnection(controller, "VisionConn", "https://api.openai.com/v1", "gpt-4o");
    slots.setSlot({
      commandId: randomUUID(),
      slot: "vision",
      connectionId: visionConn.id,
      routeRevision: visionConn.draftRevision,
      modelId: "gpt-4o",
      confirmed: true,
    });
    const visionOff = resolveSlotRoute(store, slots, controller, grant, "vision");
    expect(visionOff).toMatchObject({
      slot: "vision",
      decision: "handoff_human",
      reason: "VISION_DISABLED_OR_UNCONFIGURED",
      route: null,
    });

    // vision hands off when visionEnabled is true but slot is cleared
    new AccountAiFeaturesStore(store.db, store.accountId).save({
      ...DEFAULT_ACCOUNT_AI_FEATURES,
      visionEnabled: true,
    });
    slots.setSlot({
      commandId: randomUUID(),
      slot: "vision",
      connectionId: null,
      routeRevision: null,
      modelId: null,
      confirmed: true,
    });
    expect(resolveSlotRoute(store, slots, controller, grant, "vision")).toMatchObject({
      slot: "vision",
      decision: "handoff_human",
      reason: "VISION_DISABLED_OR_UNCONFIGURED",
    });

    // vision resolves when visionEnabled=true and vision slot is configured
    slots.setSlot({
      commandId: randomUUID(),
      slot: "vision",
      connectionId: visionConn.id,
      routeRevision: visionConn.draftRevision,
      modelId: "gpt-4o",
      confirmed: true,
    });
    const visionOn = resolveSlotRoute(store, slots, controller, grant, "vision");
    expect(visionOn).toMatchObject({
      slot: "vision",
      decision: "use_model",
      mode: "vision_slot",
      route: { modelId: "gpt-4o", connectionId: visionConn.id },
    });

    // utility falls back to primary when unconfigured
    const utilityFallback = resolveSlotRoute(store, slots, controller, grant, "utility");
    expect(utilityFallback).toMatchObject({
      slot: "utility",
      mode: "local_or_primary",
      decision: "fallback_primary",
      route: { modelId: "gpt-4.1-mini", connectionId: primaryConn.id },
    });

    // utility uses dedicated slot when configured
    const utilityConn = await addKeyedConnection(controller, "UtilityConn", "https://api.openai.com/v1", "gpt-4o-mini");
    slots.setSlot({
      commandId: randomUUID(),
      slot: "utility",
      connectionId: utilityConn.id,
      routeRevision: utilityConn.draftRevision,
      modelId: "gpt-4o-mini",
      confirmed: true,
    });
    expect(resolveSlotRoute(store, slots, controller, grant, "utility")).toMatchObject({
      slot: "utility",
      mode: "utility_slot",
      decision: "use_model",
      route: { modelId: "gpt-4o-mini", connectionId: utilityConn.id },
    });

    // embedding: fts5_only -> cloud_embedding -> local_onnx priority
    expect(resolveSlotRoute(store, slots, controller, grant, "embedding", { onnxReady: false })).toMatchObject({
      slot: "embedding",
      mode: "fts5_only",
      decision: "fallback_fts5",
      route: null,
    });
    const embedConn = await addKeyedConnection(controller, "EmbedConn", "https://api.openai.com/v1", "text-embedding-3-small");
    slots.setSlot({
      commandId: randomUUID(),
      slot: "embedding",
      connectionId: embedConn.id,
      routeRevision: embedConn.draftRevision,
      modelId: "text-embedding-3-small",
      confirmed: true,
    });
    expect(resolveSlotRoute(store, slots, controller, grant, "embedding", { onnxReady: false })).toMatchObject({
      slot: "embedding",
      mode: "cloud_embedding",
      decision: "use_model",
      route: { modelId: "text-embedding-3-small", connectionId: embedConn.id },
    });
    expect(resolveSlotRoute(store, slots, controller, grant, "embedding", { onnxReady: true })).toMatchObject({
      slot: "embedding",
      mode: "local_onnx",
      decision: "use_local_onnx",
      route: null,
    });
  });
});

test("resolveSlotRoute enforces grant, budget, and emergency stop bounds", async () => {
  await withSlotHarness(async ({ store, automation, controller, slots }) => {
    const conn = await addKeyedConnection(controller, "Main", "https://api.openai.com/v1", "gpt-4.1");
    await controller.dispatch(
      {
        command: "modelProviders",
        action: "apply",
        connectionId: conn.id,
        routeRevision: conn.draftRevision,
        modelId: "gpt-4.1",
        commandId: randomUUID(),
        confirmed: true,
        expectedSelectionRevision: 0,
      },
      () => {},
    );
    const grant = automation.grant("MODEL", {
      ownId: "own-1",
      channels: ["DIRECT_MESSAGE"],
      model: "gpt-4.1",
      modelLimit: 1,
      expiresAt: null,
    });
    automation.reserve(grant.version, "MODEL", "job-1");
    expect(() => resolveSlotRoute(store, slots, controller, grant, "primary")).toThrow("MODEL_GRANT_EXHAUSTED");

    automation.stop(true, "MANUAL_EMERGENCY_STOP", "MANUAL");
    expect(() => resolveSlotRoute(store, slots, controller, grant, "primary")).toThrow("EMERGENCY_STOPPED");
  });
});
