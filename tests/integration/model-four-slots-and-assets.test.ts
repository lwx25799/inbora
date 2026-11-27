import { createHash, randomUUID } from "node:crypto";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { handleAiRuntimeCommand, prepareSendMediaAttachment } from "../../src/app/ai-runtime-commands.js";
import { resolveEffectivePipelineConfig, runAutomaticReply, runServiceAutomaticReply } from "../../src/app/automatic-reply.js";
import { OfficialAccountRuntime } from "../../src/app/official-account-runtime.js";
import { saveReplyPipelineConfig } from "../../src/app/reply-pipeline-commands.js";
import { DEFAULT_REPLY_PIPELINE_PERSISTED_CONFIG } from "../../src/contracts/reply-pipeline.js";
import { ReplyKnowledgeService } from "../../src/knowledge/service.js";
import { MessagePreviewStore } from "../../src/storage/message-previews.js";
import type { PlatformConnector } from "../../src/platform/platform-connector.js";
import { PersistentRhythmGate, runReplyPipelinePreGeneration } from "../../src/app/reply-pipeline/index.js";
import { WorkbenchAuthority } from "../../src/app/authority.js";
import { ModelCredentialStore } from "../../src/app/credentials.js";
import { HumanReplyWorkflow } from "../../src/app/human-reply-workflow.js";
import { ModelProviderController } from "../../src/app/model-provider-controller.js";
import { ModelRouteGuard } from "../../src/app/model-route-guard.js";
import { DeepSeekProvider } from "../../src/ai/deepseek.js";
import { commandSchema, sendParamsSchema } from "../../src/contracts/client.js";
import { isMutatingClientCommand } from "../../src/contracts/protocol-v2.js";
import type { ReplyAdapter } from "../../src/core/contracts.js";
import { SendCoordinator } from "../../src/core/send-coordinator.js";
import { MockPlatformConnector } from "../../src/platform/mock-platform-connector.js";
import { AccountAiFeaturesStore } from "../../src/storage/account-ai-features.js";
import { migrateAutomation } from "../../src/storage/automation-migration.js";
import { AutomationStore } from "../../src/storage/automation-store.js";
import { migrateClient } from "../../src/storage/client-migration.js";
import { MediaAssetStore } from "../../src/storage/media-asset-store.js";
import { initializeModelProviderSchema } from "../../src/storage/model-provider-store.js";
import { migrateToSchema4 } from "../../src/storage/schema4-migration.js";
import { EventStore } from "../../src/storage/store.js";
import { candidate, pending, privateTemp, snapshot } from "../helpers.js";
import { digest } from "../../src/core/contracts.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

test("schema4 migration tolerates lazy model_slot_routes, account_ai_features, and local_media_assets", async () => {
  const root = privateTemp("m3-schema4-");
  const file = join(root, "main.sqlite");
  const store = new EventStore(file, true);
  try {
    await migrateClient(store, join(root, "client.sqlite"));
    store.bindAccount("account_001", "own-1");
    await migrateAutomation(store, join(root, "auto.sqlite"));
    const models = initializeModelProviderSchema(store.db);
    const conn = models.saveConnection({
      connectionId: null,
      expectedVersion: 0,
      name: "OpenAI",
      presetId: "openai",
      protocol: "OPENAI_CHAT",
      baseUrl: "https://api.openai.com/v1",
      region: null,
      manualModels: [{ modelId: "gpt-4o", displayName: null }],
    });
    const auto = new AutomationStore(store);
    auto.initialize(1000);
    const controller = new ModelProviderController(
      new ModelRouteGuard(models, auto),
      new ModelCredentialStore(root),
      globalThis.fetch,
      () => {},
    );
    await controller.dispatch(
      {
        command: "modelProviders",
        action: "setKey",
        connectionId: conn.id,
        expectedVersion: conn.version,
        storage: "MEMORY",
        key: "sk-schema4-slot-test",
      },
      () => {},
    );
    await controller.dispatch(
      {
        command: "modelProviders",
        action: "setSlot",
        commandId: randomUUID(),
        slot: "vision",
        connectionId: conn.id,
        routeRevision: 2,
        modelId: "gpt-4o",
        confirmed: true,
      },
      () => {},
    );
    new AccountAiFeaturesStore(store.db, store.accountId).save({
      visionEnabled: true,
      mediaReplyEnabled: true,
      enabledBusinessTools: ["query_order_status"],
      toolEndpoints: { query_order_status: "https://erp.example.com/orders" },
      syncCustomerAvatars: false,
    });
    await new MediaAssetStore(store.db, store.accountId, root).save({
      name: "size-chart.png",
      base64: PNG_BYTES.toString("base64"),
    });

    const upgraded = await migrateToSchema4(store, join(root, "schema4-backup.sqlite"));
    expect(upgraded).toBe(true);
    expect(store.db.pragma("user_version", { simple: true })).toBe(4);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("mediaAssets, SendCoordinator prepareMedia gate, and protocol-v2 read-only classification", async () => {
  const root = privateTemp("m3-assets-send-");
  const store = new EventStore(join(root, "main.sqlite"), true);
  try {
    await migrateClient(store, join(root, "client.sqlite"));
    store.bindAccount("account_001", "own-1");
    const authority = new WorkbenchAuthority(store);
    const token = authority.issueSession();

    expect(isMutatingClientCommand({ command: "modelProviders", action: "getSlots" })).toBe(false);
    expect(isMutatingClientCommand({ command: "accountAiFeatures", action: "get" })).toBe(false);
    expect(isMutatingClientCommand({ command: "mediaAssets", action: "list" })).toBe(false);
    expect(isMutatingClientCommand({ command: "businessTools", action: "list" })).toBe(false);
    expect(isMutatingClientCommand({
      command: "businessTools",
      action: "invokeReadonly",
      toolId: "query_order_status",
      params: { orderId: "1" },
    })).toBe(false);

    // sendParamsSchema rejects half-specified mediaAssetId/mediaAssetDigest
    expect(
      sendParamsSchema.safeParse({
        eventId: randomUUID(),
        generation: 0,
        draftId: randomUUID(),
        draftVersion: 1,
        text: "hello",
        contextVersion: "a".repeat(64),
        selectionId: randomUUID(),
        mediaAssetId: randomUUID(),
      }).success,
    ).toBe(false);

    // Bad magic bytes rejected
    await expect(
      handleAiRuntimeCommand({ store, authority, root }, token, {
        command: "mediaAssets",
        action: "save",
        name: "bad.png",
        base64: Buffer.from("not-an-image").toString("base64"),
      }),
    ).rejects.toThrow("MEDIA_ASSET_INVALID");

    // Localhost endpoint rejected by commandSchema
    expect(
      commandSchema.safeParse({
        command: "accountAiFeatures",
        action: "save",
        features: {
          visionEnabled: false,
          mediaReplyEnabled: false,
          enabledBusinessTools: ["query_order_status"],
          toolEndpoints: { query_order_status: "https://localhost/orders" },
          syncCustomerAvatars: false,
        },
      }).success,
    ).toBe(false);

    const savedRes = (await handleAiRuntimeCommand({ store, authority, root }, token, {
      command: "mediaAssets",
      action: "save",
      name: "promo.png",
      base64: PNG_BYTES.toString("base64"),
    })) as { asset: { id: string; sha256: string } };

    const event = candidate();
    const eventId = pending(store, event);
    const owner = authority.claim(token, eventId, 0);
    const draft = authority.save(token, eventId, owner.generation, 0, "approved fixture reply");
    const draftId = draft.id;
    store.approve(draftId, snapshot(event), draft.version, draft.text);

    // Fails when mediaReplyEnabled is false
    expect(() =>
      prepareSendMediaAttachment(store, root, {
        mediaAssetId: savedRes.asset.id,
        mediaAssetDigest: savedRes.asset.sha256,
      }),
    ).toThrow("MEDIA_REPLY_DISABLED");

    await handleAiRuntimeCommand({ store, authority, root }, token, {
      command: "accountAiFeatures",
      action: "save",
      features: {
        visionEnabled: false,
        mediaReplyEnabled: true,
        enabledBusinessTools: [],
        toolEndpoints: {},
        syncCustomerAvatars: false,
      },
    });

    const attachment = prepareSendMediaAttachment(store, root, {
      mediaAssetId: savedRes.asset.id,
      mediaAssetDigest: savedRes.asset.sha256,
    })!;
    expect(attachment.asset.id).toBe(savedRes.asset.id);

    // Adapter without prepareMedia throws MEDIA_SEND_NOT_SUPPORTED BEFORE recordIntent
    const snap = snapshot(event);
    const coordinator = new SendCoordinator(store, { run: async fn => fn() });
    const noMediaAdapter: ReplyAdapter = {
      inspect: async () => snap,
      prepare: async () => {},
      verifyPrepared: async () => snap,
      baseline: async () => [],
      clickOnce: async () => { throw new Error("must not click"); },
      readback: async () => null,
    };
    await expect(
      coordinator.send(draftId, noMediaAdapter, true, { check: () => {}, committed: () => {} }, attachment),
    ).rejects.toThrow("MEDIA_SEND_NOT_SUPPORTED");
    expect(store.db.prepare("SELECT count(*) FROM send_intents").pluck().get()).toBe(0);
    expect(store.budget("SEND").used).toBe(0);

    // Re-approve draft, then verify tampering asset file fails integrity check before intent
    const d1 = store.draft(draftId);
    store.approve(draftId, snap, d1.version, d1.text);
    const assetPath = new MediaAssetStore(store.db, store.accountId, root).get(savedRes.asset.id)!.filePath;
    writeFileSync(assetPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x99]));
    await expect(
      coordinator.send(
        draftId,
        { ...noMediaAdapter, prepareMedia: async () => true },
        true,
        { check: () => {}, committed: () => {} },
        attachment,
      ),
    ).rejects.toThrow("MEDIA_ASSET_INVALID");
    expect(store.db.prepare("SELECT count(*) FROM send_intents").pluck().get()).toBe(0);

    // Restore valid bytes and confirm full SendCoordinator flow succeeds
    writeFileSync(assetPath, PNG_BYTES);
    store.approve(draftId, snap, d1.version, d1.text);
    const prepareMedia = vi.fn(async () => true);
    const fullAdapter: ReplyAdapter = {
      inspect: async () => snap,
      prepare: async () => {},
      prepareMedia,
      verifyPrepared: async () => snap,
      baseline: async () => [],
      clickOnce: async () => {},
      readback: async () => ({
        id: "sent-media-1",
        ownId: snap.ownId,
        targetKey: snap.targetKey,
        text: d1.text,
        pending: false,
        sentAt: new Date(Date.now() + 1000).toISOString(),
      }),
    };
    const outcome = await coordinator.send(
      draftId,
      fullAdapter,
      true,
      { check: () => {}, committed: () => {} },
      attachment,
    );
    expect(outcome).toBe("CONFIRMED");
    expect(prepareMedia).toHaveBeenCalledTimes(1);
    expect(store.budget("SEND").used).toBe(1);

    await handleAiRuntimeCommand({ store, authority, root }, token, {
      command: "mediaAssets",
      action: "delete",
      assetId: savedRes.asset.id,
    });
    expect(new MediaAssetStore(store.db, store.accountId, root).list()).toEqual([]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("automatic-reply passes allowVisionModel=true only when visionEnabled && visionSlotReady", async () => {
  const root = privateTemp("m3-auto-vision-");
  const store = new EventStore(join(root, "main.sqlite"), true);
  try {
    await migrateClient(store, join(root, "client.sqlite"));
    const connector = new MockPlatformConnector({ accountId: "account_001", ownId: "own-1" });
    connector.identity = () => ({
      identityDigest: digest("own-1"),
      mappingDigest: "synthetic",
      browserVersion: "mock",
      browserMode: "headless",
    });
    connector.bindStore(store);
    await migrateAutomation(store, join(root, "auto.sqlite"));
    const automation = new AutomationStore(store);
    automation.initialize(1000);
    const models = initializeModelProviderSchema(store.db);
    const controller = new ModelProviderController(
      new ModelRouteGuard(models, automation),
      new ModelCredentialStore(root),
      globalThis.fetch,
      () => {},
    );
    const primaryConn = models.saveConnection({
      connectionId: null,
      expectedVersion: 0,
      name: "Primary",
      presetId: "openai",
      protocol: "OPENAI_CHAT",
      baseUrl: "https://api.openai.com/v1",
      region: null,
      manualModels: [{ modelId: "gpt-4.1-mini", displayName: null }],
    });
    await controller.dispatch(
      {
        command: "modelProviders",
        action: "setKey",
        connectionId: primaryConn.id,
        expectedVersion: primaryConn.version,
        storage: "MEMORY",
        key: "sk-auto-test",
      },
      () => {},
    );
    await controller.dispatch(
      {
        command: "modelProviders",
        action: "apply",
        connectionId: primaryConn.id,
        routeRevision: 2,
        modelId: "gpt-4.1-mini",
        commandId: randomUUID(),
        confirmed: true,
        expectedSelectionRevision: 0,
      },
      () => {},
    );
    automation.grant("AUTO_REPLY", {
      ownId: "own-1",
      channels: ["DIRECT_MESSAGE"],
      model: "gpt-4.1-mini",
      modelLimit: 10,
      sendLimit: 10,
      expiresAt: null,
      workIds: [],
      futureOwnWorks: false,
      conversationIds: ["conversation-1"],
      entireInbox: true,
      containsAny: [],
      excludesAny: [],
      instructions: "reply",
      startHour: 0,
      endHour: 24,
    });
    const authority = new WorkbenchAuthority(store);
    const token = authority.issueSession();
    authority.setMode(token, "LIMITED_AUTO");
    authority.pause(token, null, false);

    // Observe a media DM event and verify automatic-reply resolves allowVisionModel only when visionEnabled && visionSlotReady
    store.observe("DIRECT_MESSAGE", "conversation-1", [], "own-1", "fixture", "2026-11-04T00:59:00Z");
    store.observe(
      "DIRECT_MESSAGE",
      "conversation-1",
      [
        candidate({
          platformEventId: "img-1",
          text: "[图片消息]",
          observationIssue: "DM_CONTENT_UNVERIFIED",
          contentType: "IMAGE",
          occurredAt: "2026-11-04T01:00:00Z",
        }),
      ],
      "own-1",
      "fixture",
    );
    const mediaEventId = store.db
      .prepare("SELECT id FROM inbound_events WHERE source_key='img-1'")
      .pluck()
      .get() as string;
    store.db.prepare("UPDATE inbound_events SET status='AWAITING_DRAFT' WHERE id=?").run(mediaEventId);
    const mediaEvent = store.event(mediaEventId);
    const grant = automation.active("AUTO_REPLY")!;
    const rhythmGate = new PersistentRhythmGate(store.db, { now: authority.now });

    // 1) Table absent -> read-only visionEnabled=false -> allowVisionModel=false -> MEDIA_MESSAGE_HANDOFF
    const configAbsent = resolveEffectivePipelineConfig({ store, models: controller }, rhythmGate);
    expect(configAbsent.handoff.allowVisionModel).toBe(false);
    expect(
      store.db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name='account_ai_features'").get(),
    ).toBeUndefined();
    const preOff = runReplyPipelinePreGeneration(
      { store, authority, automation, grant: grant as never, event: mediaEvent, config: configAbsent, dryRun: true },
      rhythmGate,
    );
    expect(preOff.decision).toBe("handoff_human");
    expect(preOff.reasonCode).toBe("MEDIA_MESSAGE_HANDOFF");

    // 2) visionEnabled=true without vision slot -> allowVisionModel=false -> MEDIA_MESSAGE_HANDOFF
    new AccountAiFeaturesStore(store.db, store.accountId).save({
      visionEnabled: true,
      mediaReplyEnabled: false,
      enabledBusinessTools: [],
      toolEndpoints: {},
      syncCustomerAvatars: false,
    });
    const configNoSlot = resolveEffectivePipelineConfig({ store, models: controller }, rhythmGate);
    expect(configNoSlot.handoff.allowVisionModel).toBe(false);

    // 3) visionEnabled=true + vision slot ready -> allowVisionModel=true -> bypasses MEDIA_MESSAGE_HANDOFF
    await controller.dispatch(
      {
        command: "modelProviders",
        action: "setSlot",
        commandId: randomUUID(),
        slot: "vision",
        connectionId: primaryConn.id,
        routeRevision: 2,
        modelId: "gpt-4.1-mini",
        confirmed: true,
      },
      () => {},
    );
    const configOn = resolveEffectivePipelineConfig({ store, models: controller }, rhythmGate);
    expect(configOn.handoff.allowVisionModel).toBe(true);
    const preOn = runReplyPipelinePreGeneration(
      { store, authority, automation, grant: grant as never, event: mediaEvent, config: configOn, dryRun: true },
      rhythmGate,
    );
    expect(preOn.decision).toBe("continue");

    // Also run runAutomaticReply end-to-end with no unhandled errors
    const humanReplies = new HumanReplyWorkflow(store, authority, connector, () => false, async () => {}, () => {}, e => String(e));
    await runAutomaticReply({
      store,
      authority,
      automation,
      browser: connector,
      models: controller,
      provider: new DeepSeekProvider(),
      humanReplies,
      settings: { model: "gpt-4.1-mini", persona: "", business: "", rules: "" },
      modelPending: new Set(),
      automaticSignal: new AbortController().signal,
      modelSignal: new AbortController().signal,
      isClosing: () => false,
      updated: () => {},
      stop: () => {},
      beforeWork: () => {},
      statusUpdated: () => {},
      errorCode: e => (e instanceof Error ? e.message : "ERR"),
    });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("chunked media upload, delete unlink failure preserves DB row, and in-flight outbound safety reloads new blocked words", async () => {
  const root = privateTemp("m3-r1-regressions-");
  const store = new EventStore(join(root, "main.sqlite"), true);
  try {
    await migrateClient(store, join(root, "client.sqlite"));
    const connector = new MockPlatformConnector({ accountId: "account_001", ownId: "own-1" });
    connector.identity = () => ({
      identityDigest: digest("own-1"),
      mappingDigest: "synthetic",
      browserVersion: "mock",
      browserMode: "headless",
    });
    connector.bindStore(store);
    await migrateAutomation(store, join(root, "auto.sqlite"));
    const automation = new AutomationStore(store);
    automation.initialize(1000);
    const authority = new WorkbenchAuthority(store);
    const token = authority.issueSession();

    // 1. Chunked upload round-trip + temp cleanup on failed upload
    const payloadBytes = Buffer.concat([PNG_BYTES, Buffer.alloc(120, 0x41)]);
    const payloadBase64 = payloadBytes.toString("base64");
    const sha256 = createHash("sha256").update(payloadBytes).digest("hex");

    const started = (await handleAiRuntimeCommand({ store, authority, root }, token, {
      command: "mediaAssets",
      action: "uploadStart",
      name: "chunked.png",
      mimeType: "image/png",
      bytes: payloadBytes.byteLength,
      sha256,
    })) as { uploadId: string };
    const mid = Math.floor(payloadBase64.length / 2);
    await handleAiRuntimeCommand({ store, authority, root }, token, {
      command: "mediaAssets",
      action: "uploadChunk",
      uploadId: started.uploadId,
      index: 0,
      data: payloadBase64.slice(0, mid),
    });
    await handleAiRuntimeCommand({ store, authority, root }, token, {
      command: "mediaAssets",
      action: "uploadChunk",
      uploadId: started.uploadId,
      index: 1,
      data: payloadBase64.slice(mid),
    });
    const finished = (await handleAiRuntimeCommand({ store, authority, root }, token, {
      command: "mediaAssets",
      action: "uploadFinish",
      uploadId: started.uploadId,
    })) as { asset: { id: string; bytes: number; sha256: string } };
    expect(finished.asset).toMatchObject({ bytes: payloadBytes.byteLength, sha256 });

    // Out-of-order chunk cleans up .tmp-*
    const badStart = (await handleAiRuntimeCommand({ store, authority, root }, token, {
      command: "mediaAssets",
      action: "uploadStart",
      name: "bad-order.png",
      mimeType: "image/png",
      bytes: payloadBytes.byteLength,
      sha256,
    })) as { uploadId: string };
    await expect(
      handleAiRuntimeCommand({ store, authority, root }, token, {
        command: "mediaAssets",
        action: "uploadChunk",
        uploadId: badStart.uploadId,
        index: 1,
        data: payloadBase64.slice(0, 16),
      }),
    ).rejects.toThrow("MEDIA_ASSET_INVALID");
    expect(readdirSync(join(root, "media-assets")).some(name => name.startsWith(".tmp-"))).toBe(false);

    // 2. Delete failure (EBUSY) preserves DB row and throws MEDIA_ASSET_DELETE_FAILED
    const lockedStore = new MediaAssetStore(store.db, store.accountId, root, Date.now, async () => {
      const err = new Error("EBUSY") as NodeJS.ErrnoException;
      err.code = "EBUSY";
      throw err;
    });
    await expect(lockedStore.delete(finished.asset.id)).rejects.toThrow("MEDIA_ASSET_DELETE_FAILED");
    expect(lockedStore.list().some(item => item.id === finished.asset.id)).toBe(true);

    // 3. In-flight outbound safety re-reads newly saved blocked word before sending
    const models = initializeModelProviderSchema(store.db);
    const controller = new ModelProviderController(
      new ModelRouteGuard(models, automation),
      new ModelCredentialStore(root),
      globalThis.fetch,
      () => {},
    );
    const conn = models.saveConnection({
      connectionId: null,
      expectedVersion: 0,
      name: "OpenAI",
      presetId: "openai",
      protocol: "OPENAI_CHAT",
      baseUrl: "https://api.openai.com/v1",
      region: null,
      manualModels: [{ modelId: "gpt-4.1-mini", displayName: null }],
    });
    await controller.dispatch(
      {
        command: "modelProviders",
        action: "setKey",
        connectionId: conn.id,
        expectedVersion: conn.version,
        storage: "MEMORY",
        key: "sk-outbound-reload",
      },
      () => {},
    );
    await controller.dispatch(
      {
        command: "modelProviders",
        action: "apply",
        connectionId: conn.id,
        routeRevision: 2,
        modelId: "gpt-4.1-mini",
        commandId: randomUUID(),
        confirmed: true,
        expectedSelectionRevision: 0,
      },
      () => {},
    );
    automation.grant("AUTO_REPLY", {
      ownId: "own-1",
      channels: ["DIRECT_MESSAGE"],
      model: "gpt-4.1-mini",
      modelLimit: 10,
      sendLimit: 10,
      expiresAt: null,
      workIds: [],
      futureOwnWorks: false,
      conversationIds: ["conversation-1"],
      entireInbox: true,
      containsAny: [],
      excludesAny: [],
      instructions: "reply",
      startHour: 0,
      endHour: 24,
    });
    authority.setMode(token, "LIMITED_AUTO");
    authority.pause(token, null, false);

    const dmEvent = candidate({
      platformEventId: "dm-reload-1",
      text: "请问今天发货吗",
      occurredAt: "2026-11-04T01:05:00Z",
    });
    connector.inject(dmEvent);
    store.observe("DIRECT_MESSAGE", "conversation-1", [], "own-1", "fixture", "2026-11-04T01:00:00Z");
    const [dmEventId] = store.observe("DIRECT_MESSAGE", "conversation-1", [dmEvent], "own-1", "fixture");

    const fakeProvider = {
      generate: vi.fn(async (_store, _ev, _hist, _settings, _key, _auth, _sig, reserve) => {
        reserve?.();
        // Mutate reply_pipeline_settings mid-generation with a new custom blocked word
        saveReplyPipelineConfig(store, authority, token, {
          ...DEFAULT_REPLY_PIPELINE_PERSISTED_CONFIG,
          sensitive: {
            ...DEFAULT_REPLY_PIPELINE_PERSISTED_CONFIG.sensitive,
            customWords: ["禁发词"],
          },
        });
        return { text: "这条包含禁发词不能自动发送", model: "gpt-4.1-mini", callId: randomUUID() };
      }),
    } as unknown as DeepSeekProvider;

    const humanReplies = new HumanReplyWorkflow(store, authority, connector, () => false, async () => {}, () => {}, e => String(e));
    await runServiceAutomaticReply({
      store,
      authority,
      automation,
      browser: connector,
      models: controller,
      provider: fakeProvider,
      humanReplies,
      modelPending: new Set(),
      automaticSignal: new AbortController().signal,
      modelSignal: new AbortController().signal,
      isClosing: () => false,
      keyPresent: true,
      settings: () => ({ model: "gpt-4.1-mini", persona: "", business: "", rules: "" }),
      knowledgeContext: () => null,
      updated: () => {},
      stop: () => {},
      beforeWork: () => {},
      statusUpdated: () => {},
      errorCode: e => (e instanceof Error ? e.message : "ERR"),
    });

    expect(connector.clickCount).toBe(0);
    expect(store.db.prepare("SELECT count(*) FROM send_intents").pluck().get()).toBe(0);
    expect(
      store.db.prepare("SELECT state, reason FROM automation_jobs WHERE event_id=?").get(dmEventId!),
    ).toEqual({ state: "REVIEW", reason: "CUSTOM_SENSITIVE_WORD" });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("R2: customer image reaches separate vision slot, separate utility slot runs analyze, official-api root uploads cleanly, and expired uploads clean up", async () => {
  const root = privateTemp("m3-r2-");
  let nowMs = 1_700_000_000_000;
  const dbPath = join(root, "main.sqlite");
  const store = new EventStore(dbPath, true);
  let knowledge: ReplyKnowledgeService | undefined;
  let officialRuntime: OfficialAccountRuntime | undefined;
  try {
    await migrateClient(store, join(root, "client.sqlite"));
    await migrateAutomation(store, join(root, "auto.sqlite"));
    const connector = new MockPlatformConnector({ accountId: "account_001", ownId: "own-1" });
    connector.identity = () => ({ identityDigest: digest("own-1"), mappingDigest: "synthetic", browserVersion: "mock", browserMode: "headless" });
    connector.bindStore(store);
    const automation = new AutomationStore(store, () => nowMs);
    automation.initialize(1000);
    const models = initializeModelProviderSchema(store.db);
    const requests: { model: string; body: string }[] = [];
    const transport: typeof fetch = async (_url, init) => {
      const body = String(init?.body ?? "");
      const parsed = JSON.parse(body) as { model: string };
      requests.push({ model: parsed.model, body });
      const text = parsed.model === "gpt-4o-mini"
        ? JSON.stringify({ rules: "简洁礼貌回复" })
        : "看图确认这是已发货订单截图，请耐心等待派送。";
      return Response.json({
        id: "chat-r2",
        model: parsed.model,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      });
    };
    const controller = new ModelProviderController(new ModelRouteGuard(models, automation), new ModelCredentialStore(root), transport, () => {});
    const conn = models.saveConnection({
      connectionId: null, expectedVersion: 0, name: "OpenAI", presetId: "openai", protocol: "OPENAI_CHAT",
      baseUrl: "https://api.openai.com/v1", region: null,
      manualModels: [{ modelId: "gpt-4.1-mini", displayName: null }, { modelId: "gpt-4o", displayName: null }, { modelId: "gpt-4o-mini", displayName: null }],
    });
    await controller.dispatch({ command: "modelProviders", action: "setKey", connectionId: conn.id, expectedVersion: conn.version, storage: "MEMORY", key: "sk-r2-test" }, () => {});
    await controller.dispatch({ command: "modelProviders", action: "apply", connectionId: conn.id, routeRevision: 2, modelId: "gpt-4.1-mini", commandId: randomUUID(), confirmed: true, expectedSelectionRevision: 0 }, () => {});
    await controller.dispatch({ command: "modelProviders", action: "setSlot", commandId: randomUUID(), slot: "vision", connectionId: conn.id, routeRevision: 2, modelId: "gpt-4o", confirmed: true }, () => {});
    await controller.dispatch({ command: "modelProviders", action: "setSlot", commandId: randomUUID(), slot: "utility", connectionId: conn.id, routeRevision: 2, modelId: "gpt-4o-mini", confirmed: true }, () => {});

    const authority = new WorkbenchAuthority(store, () => nowMs);
    const token = authority.issueSession();
    automation.grant("AUTO_REPLY", {
      ownId: "own-1", channels: ["DIRECT_MESSAGE"], model: "gpt-4.1-mini", modelLimit: 10, sendLimit: 10, expiresAt: null,
      workIds: [], futureOwnWorks: false, conversationIds: ["conversation-1"], entireInbox: true, containsAny: [], excludesAny: [],
      instructions: "reply", startHour: 0, endHour: 24,
    });
    authority.setMode(token, "LIMITED_AUTO");
    authority.pause(token, null, false);

    // 1. Real customer image DM (`MANUAL_REVIEW` from observe) reaches separate `vision` slot (`gpt-4o`) when enabled
    const imgEv = candidate({ platformEventId: "dm-img-r2", text: "[图片消息]", observationIssue: "DM_CONTENT_UNVERIFIED", contentType: "IMAGE", occurredAt: "2026-11-04T01:10:00Z" });
    (connector as unknown as { inbox: Map<string, unknown> }).inbox.set(`DIRECT_MESSAGE:dm-img-r2`, imgEv);
    store.observe("DIRECT_MESSAGE", "conversation-1", [], "own-1", "fixture", "2026-11-04T01:09:00Z");
    store.observe("DIRECT_MESSAGE", "conversation-1", [imgEv], "own-1", "fixture");
    const validPng1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    new MessagePreviewStore(root).save(imgEv, "own-1", [{ label: "img", png: validPng1x1, width: 1, height: 1 }]);
    new AccountAiFeaturesStore(store.db, store.accountId).save({ visionEnabled: true, mediaReplyEnabled: false, enabledBusinessTools: [], toolEndpoints: {}, syncCustomerAvatars: false });

    const humanReplies = new HumanReplyWorkflow(store, authority, connector, () => false, async () => {}, () => {}, e => String(e));
    await runServiceAutomaticReply({
      store, authority, automation, browser: connector, models: controller, provider: new DeepSeekProvider(transport), humanReplies,
      modelPending: new Set(), automaticSignal: new AbortController().signal, modelSignal: new AbortController().signal,
      isClosing: () => false, keyPresent: true, settings: () => ({ model: "gpt-4.1-mini", persona: "", business: "", rules: "" }),
      knowledgeContext: () => null, updated: () => {}, stop: () => {}, beforeWork: () => {}, statusUpdated: () => {}, errorCode: e => String(e),
    });
    expect(requests.some(r => r.model === "gpt-4o" && r.body.includes(validPng1x1.toString("base64")))).toBe(true);
    const imgId = store.db.prepare("SELECT id FROM inbound_events WHERE source_key='dm-img-r2'").pluck().get() as string;
    expect(store.db.prepare("SELECT state, reason FROM automation_jobs WHERE event_id=?").get(imgId)).toEqual({ state: "REVIEW", reason: "VISION_DRAFT_AWAITING_APPROVAL" });

    // 2. Separate `utility` slot (`gpt-4o-mini`) works for `analyze`, and read-only `embeddingStatus`/`debugRetrieval` never fail on exhausted grant
    knowledge = new ReplyKnowledgeService(store, authority, root, () => ({
      settings: { model: "gpt-4.1-mini", persona: "", business: "", rules: "" },
      models: controller, modelUnavailable: null, automation, signal: new AbortController().signal, closing: false,
    }));
    await knowledge.initialize();
    knowledge.data.addSamples(store.accountId, [{ channel: "DIRECT_MESSAGE", prompt: "发货吗", response: "当天发", group: "fixture", source: "IMPORTED" }]);
    const sampleIds = store.db.prepare("SELECT id FROM k_samples").pluck().all() as string[];
    knowledge.data.selectSamples(store.accountId, sampleIds, true);
    const analyzed = await knowledge.dispatch(token, { command: "replyKnowledge", action: "analyze", sampleIds, confirmed: true }) as { persona: { text: string } };
    expect(analyzed.persona.text).toBe("简洁礼貌回复");
    expect(requests.some(r => r.model === "gpt-4o-mini")).toBe(true);
    await controller.dispatch({ command: "modelProviders", action: "setSlot", commandId: randomUUID(), slot: "embedding", connectionId: conn.id, routeRevision: 2, modelId: "text-embedding-3-small", confirmed: true }, () => {});
    expect(await knowledge.dispatch(token, { command: "replyKnowledge", action: "embeddingStatus" })).toMatchObject({ cloudEmbeddingConfigured: true });

    // 3. OfficialAccountRuntime uses dirname(dbPath) instead of `official-api://` for mediaAssets
    const officialConnector = {
      root: "official-api://wecom-aibot/bot-1", platformId: "wecom-aibot", accountId: "account_001",
      capabilities: { channels: ["DIRECT_MESSAGE"], loginRecovery: false, manualSecurityRecovery: false, preview: false, readback: true, transport: "official_api" },
      ownerEpoch: 1, loginRecovery: false, actor: connector.actor,
      bindStore: () => {}, setRuntimeInstance: () => {}, isIdle: () => true, close: async () => {},
      identity: () => null, refreshIdentity: async () => null,
    } as unknown as PlatformConnector;
    const parentOp = authority.operator(token, "CONTROL");
    officialRuntime = new OfficialAccountRuntime(dbPath, officialConnector, () => nowMs, () => ({ models: controller, provider: new DeepSeekProvider(), knowledge: knowledge!.data, state: { settings: { model: "gpt-4.1-mini", persona: "", business: "", rules: "" }, keyPresent: true, modelAuthorized: true, modelRoute: controller.guard, modelUnavailable: null, modelBusy: false, recovering: false }, signal: new AbortController().signal }), () => {}, () => ({ items: [], page: 0 }));
    const savedOfficial = await officialRuntime.dispatch(parentOp, { command: "mediaAssets", action: "save", name: "official.png", base64: PNG_BYTES.toString("base64") }, () => {}) as { asset: { id: string } };
    expect(savedOfficial.asset.id).toBeTruthy();
    await officialRuntime.close();
    officialRuntime = undefined;

    // 4. Expired chunked upload throws MEDIA_UPLOAD_EXPIRED and cleans `.tmp-*`
    const mediaStore = new MediaAssetStore(store.db, store.accountId, root, () => nowMs);
    const { uploadId } = await mediaStore.startUpload({ name: "exp.png", mimeType: "image/png", bytes: PNG_BYTES.byteLength, sha256: createHash("sha256").update(PNG_BYTES).digest("hex") });
    nowMs += 11 * 60_000;
    await expect(mediaStore.appendUploadChunk({ uploadId, index: 0, data: PNG_BYTES.toString("base64") })).rejects.toThrow("MEDIA_UPLOAD_EXPIRED");
    expect(readdirSync(join(root, "media-assets")).some(name => name.startsWith(".tmp-"))).toBe(false);
  } finally {
    await officialRuntime?.close();
    await knowledge?.close();
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
