import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DeepSeekProvider } from "../../src/ai/deepseek.js";
import { runServiceAutomaticReply } from "../../src/app/automatic-reply.js";
import { WorkbenchAuthority } from "../../src/app/authority.js";
import { ModelCredentialStore } from "../../src/app/credentials.js";
import { HumanReplyWorkflow } from "../../src/app/human-reply-workflow.js";
import { ModelProviderController } from "../../src/app/model-provider-controller.js";
import { ModelRouteGuard } from "../../src/app/model-route-guard.js";
import { saveReplyPipelineConfig } from "../../src/app/reply-pipeline-commands.js";
import { deliverCommand, type DeliveryContext } from "../../src/app/service-delivery.js";
import { DEFAULT_REPLY_PIPELINE_PERSISTED_CONFIG } from "../../src/contracts/reply-pipeline.js";
import { digest } from "../../src/core/contracts.js";
import { ReplyKnowledgeService } from "../../src/knowledge/service.js";
import { MockPlatformConnector } from "../../src/platform/mock-platform-connector.js";
import { AccountAiFeaturesStore } from "../../src/storage/account-ai-features.js";
import { migrateAutomation } from "../../src/storage/automation-migration.js";
import { AutomationStore } from "../../src/storage/automation-store.js";
import { migrateClient } from "../../src/storage/client-migration.js";
import { MessagePreviewStore } from "../../src/storage/message-previews.js";
import { initializeModelProviderSchema } from "../../src/storage/model-provider-store.js";
import { EventStore } from "../../src/storage/store.js";
import { candidate, privateTemp } from "../helpers.js";

const VALID_PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function setupEnv(prefix: string) {
  const root = privateTemp(prefix);
  const nowMs = 1_700_000_000_000;
  const store = new EventStore(join(root, "main.sqlite"), true);
  await migrateClient(store, join(root, "client.sqlite"));
  await migrateAutomation(store, join(root, "auto.sqlite"));
  const connector = new MockPlatformConnector({ accountId: "account_001", ownId: "own-1" });
  connector.identity = () => ({
    identityDigest: digest("own-1"),
    mappingDigest: "synthetic",
    browserVersion: "mock",
    browserMode: "headless",
  });
  connector.bindStore(store);
  const automation = new AutomationStore(store, () => nowMs);
  automation.initialize(1000);
  const models = initializeModelProviderSchema(store.db);
  return { root, nowMs, store, connector, automation, models };
}

test("R3 #1 & #2: vision qualification passes manualMedia=true only for image path, and in-flight vision opt-out aborts before network send", async () => {
  const { root, nowMs, store, connector, automation, models } = await setupEnv("m3-r3-vision-");
  try {
    const requests: string[] = [];
    let toggleOptOutInFlight = false;
    const transport: typeof fetch = async (_url, init) => {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as { model: string };
      requests.push(parsed.model);
      return Response.json({
        id: "chat-r3",
        model: parsed.model,
        choices: [{ index: 0, message: { role: "assistant", content: "收到图片，已核实。" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    };
    const controller = new ModelProviderController(
      new ModelRouteGuard(models, automation),
      new ModelCredentialStore(root),
      transport,
      () => {},
    );
    const conn = models.saveConnection({
      connectionId: null, expectedVersion: 0, name: "OpenAI", presetId: "openai", protocol: "OPENAI_CHAT",
      baseUrl: "https://api.openai.com/v1", region: null,
      manualModels: [{ modelId: "gpt-4.1-mini", displayName: null }, { modelId: "gpt-4o", displayName: null }],
    });
    await controller.dispatch({ command: "modelProviders", action: "setKey", connectionId: conn.id, expectedVersion: conn.version, storage: "MEMORY", key: "sk-r3" }, () => {});
    await controller.dispatch({ command: "modelProviders", action: "apply", connectionId: conn.id, routeRevision: 2, modelId: "gpt-4.1-mini", commandId: randomUUID(), confirmed: true, expectedSelectionRevision: 0 }, () => {});
    await controller.dispatch({ command: "modelProviders", action: "setSlot", commandId: randomUUID(), slot: "vision", connectionId: conn.id, routeRevision: 2, modelId: "gpt-4o", confirmed: true }, () => {});

    const authority = new WorkbenchAuthority(store, () => nowMs);
    const token = authority.issueSession();
    automation.grant("AUTO_REPLY", {
      ownId: "own-1", channels: ["DIRECT_MESSAGE"], model: "gpt-4.1-mini", modelLimit: 10, sendLimit: 10, expiresAt: null,
      workIds: [], futureOwnWorks: false, conversationIds: ["conversation-1"], entireInbox: true, containsAny: [], excludesAny: [],
      instructions: "reply", startHour: 0, endHour: 24,
    });
    authority.setMode(token, "LIMITED_AUTO");
    authority.pause(token, null, false);

    const adapterCalls: Array<{ eventId: string | null; options: unknown }> = [];
    const origAdapter = connector.adapter.bind(connector);
    connector.adapter = async (ev, s, sig, opts) => {
      adapterCalls.push({ eventId: ev.platformEventId, options: opts });
      return origAdapter(ev, s, sig, opts);
    };

    const featuresStore = new AccountAiFeaturesStore(store.db, store.accountId);
    featuresStore.save({ visionEnabled: true, mediaReplyEnabled: false, enabledBusinessTools: [], toolEndpoints: {}, syncCustomerAvatars: false });

    const textEv = candidate({ platformEventId: "dm-text-r3", text: "你好", occurredAt: "2026-11-04T01:05:00Z" });
    const imgEv = candidate({ platformEventId: "dm-img-r3-1", text: "[图片消息]", observationIssue: "DM_CONTENT_UNVERIFIED", contentType: "IMAGE", occurredAt: "2026-11-04T01:10:00Z" });
    connector.inject(textEv);
    (connector as unknown as { inbox: Map<string, unknown> }).inbox.set("DIRECT_MESSAGE:dm-img-r3-1", imgEv);
    store.observe("DIRECT_MESSAGE", "conversation-1", [], "own-1", "fixture", "2026-11-04T01:00:00Z");
    store.observe("DIRECT_MESSAGE", "conversation-1", [textEv, imgEv], "own-1", "fixture");
    new MessagePreviewStore(root).save(imgEv, "own-1", [{ label: "img", png: VALID_PNG_1X1, width: 1, height: 1 }]);

    const humanReplies = new HumanReplyWorkflow(store, authority, connector, () => false, async () => {}, () => {}, e => String(e));
    const runOnce = () => runServiceAutomaticReply({
      store, authority, automation, browser: connector, models: controller, provider: new DeepSeekProvider(transport), humanReplies,
      modelPending: new Set(), automaticSignal: new AbortController().signal, modelSignal: new AbortController().signal,
      isClosing: () => false, keyPresent: true, settings: () => ({ model: "gpt-4.1-mini", persona: "", business: "", rules: "" }),
      knowledgeContext: () => null, updated: () => {}, stop: () => {}, beforeWork: () => {}, statusUpdated: () => {}, errorCode: e => String(e),
    });
    await runOnce();
    await runOnce();

    expect(adapterCalls.find(c => c.eventId === "dm-text-r3")?.options).toBeUndefined();
    expect(adapterCalls.find(c => c.eventId === "dm-img-r3-1")?.options).toEqual({ manualMedia: true });
    const img1Id = store.db.prepare("SELECT id FROM inbound_events WHERE source_key='dm-img-r3-1'").pluck().get() as string;
    expect(store.db.prepare("SELECT state, reason FROM automation_jobs WHERE event_id=?").get(img1Id)).toEqual({
      state: "REVIEW", reason: "VISION_DRAFT_AWAITING_APPROVAL",
    });

    // R3 #2: disable visionEnabled during async key load before HTTP dispatch
    requests.length = 0;
    const imgEv2 = candidate({ platformEventId: "dm-img-r3-2", text: "[图片消息]", observationIssue: "DM_CONTENT_UNVERIFIED", contentType: "IMAGE", occurredAt: "2026-11-04T01:15:00Z" });
    (connector as unknown as { inbox: Map<string, unknown> }).inbox.set("DIRECT_MESSAGE:dm-img-r3-2", imgEv2);
    const [img2Id] = store.observe("DIRECT_MESSAGE", "conversation-1", [imgEv2], "own-1", "fixture");
    new MessagePreviewStore(root).save(imgEv2, "own-1", [{ label: "img", png: VALID_PNG_1X1, width: 1, height: 1 }]);

    const origLoadKey = controller.loadKey.bind(controller);
    controller.loadKey = async rev => {
      const k = await origLoadKey(rev);
      if (toggleOptOutInFlight) {
        featuresStore.save({ visionEnabled: false, mediaReplyEnabled: false, enabledBusinessTools: [], toolEndpoints: {}, syncCustomerAvatars: false });
      }
      return k;
    };
    toggleOptOutInFlight = true;

    await runServiceAutomaticReply({
      store, authority, automation, browser: connector, models: controller, provider: new DeepSeekProvider(transport), humanReplies,
      modelPending: new Set(), automaticSignal: new AbortController().signal, modelSignal: new AbortController().signal,
      isClosing: () => false, keyPresent: true, settings: () => ({ model: "gpt-4.1-mini", persona: "", business: "", rules: "" }),
      knowledgeContext: () => null, updated: () => {}, stop: () => {}, beforeWork: () => {}, statusUpdated: () => {}, errorCode: e => String(e),
    });

    expect(requests).toEqual([]);
    expect(store.db.prepare("SELECT count(*) FROM reply_drafts WHERE event_id=?").pluck().get(img2Id)).toBe(0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("R3 #3: newly blocked word saved during browser preflight aborts deliverCommand before recordIntent", async () => {
  const { root, nowMs, store, connector, automation, models } = await setupEnv("m3-r3-preflight-");
  try {
    const transport: typeof fetch = async (_url, init) => {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as { model: string };
      return Response.json({
        id: "chat-preflight",
        model: parsed.model,
        choices: [{ index: 0, message: { role: "assistant", content: "包含绝对禁词的政策回复" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    };
    const controller = new ModelProviderController(
      new ModelRouteGuard(models, automation),
      new ModelCredentialStore(root),
      transport,
      () => {},
    );
    const conn = models.saveConnection({
      connectionId: null, expectedVersion: 0, name: "OpenAI", presetId: "openai", protocol: "OPENAI_CHAT",
      baseUrl: "https://api.openai.com/v1", region: null, manualModels: [{ modelId: "gpt-4.1-mini", displayName: null }],
    });
    await controller.dispatch({ command: "modelProviders", action: "setKey", connectionId: conn.id, expectedVersion: conn.version, storage: "MEMORY", key: "sk-preflight" }, () => {});
    await controller.dispatch({ command: "modelProviders", action: "apply", connectionId: conn.id, routeRevision: 2, modelId: "gpt-4.1-mini", commandId: randomUUID(), confirmed: true, expectedSelectionRevision: 0 }, () => {});
    const authority = new WorkbenchAuthority(store, () => nowMs);
    authority.modelRoute = controller.guard;
    const token = authority.issueSession();
    automation.grant("AUTO_REPLY", {
      ownId: "own-1", channels: ["DIRECT_MESSAGE"], model: "gpt-4.1-mini", modelLimit: 10, sendLimit: 10, expiresAt: null,
      workIds: [], futureOwnWorks: false, conversationIds: ["conversation-1"], entireInbox: true, containsAny: [], excludesAny: [],
      instructions: "reply", startHour: 0, endHour: 24,
    });
    authority.setMode(token, "LIMITED_AUTO");
    authority.pause(token, null, false);

    const ev = candidate({ platformEventId: "dm-preflight-r3", text: "什么时候到", occurredAt: "2026-11-04T01:05:00Z" });
    connector.inject(ev);
    store.observe("DIRECT_MESSAGE", "conversation-1", [], "own-1", "fixture", "2026-11-04T01:00:00Z");
    const [eventId] = store.observe("DIRECT_MESSAGE", "conversation-1", [ev], "own-1", "fixture");

    const origAdapter = connector.adapter.bind(connector);
    let injectedBlock = false;
    connector.adapter = async (e, s, sig, opts) => {
      const handle = await origAdapter(e, s, sig, opts);
      const origPrepare = handle.adapter.prepare.bind(handle.adapter);
      handle.adapter.prepare = async (evArg, textArg) => {
        await origPrepare(evArg, textArg);
        if (!injectedBlock) {
          injectedBlock = true;
          saveReplyPipelineConfig(store, authority, token, {
            ...DEFAULT_REPLY_PIPELINE_PERSISTED_CONFIG,
            sensitive: { ...DEFAULT_REPLY_PIPELINE_PERSISTED_CONFIG.sensitive, customWords: ["绝对禁词"] },
          });
        }
      };
      return handle;
    };

    const ctx: DeliveryContext = {
      store, authority, browser: connector,
      getAutomation: () => automation, getVerification: () => null,
      isClosing: () => false, suspendForVisible: () => {}, resetOnlineAbort: () => new AbortController().signal,
      resumeAfterLogin: () => {}, bumpInboxRevision: () => {}, emit: () => {},
      errorCode: err => (err instanceof Error ? err.message : "ERR"),
    };
    const workflow = new HumanReplyWorkflow(
      store, authority, connector, () => false,
      (tok, id, p) => deliverCommand(ctx, tok, id, p),
      () => {}, err => (err instanceof Error ? err.message : "ERR"),
    );
    await runServiceAutomaticReply({
      store, authority, automation, browser: connector, models: controller, provider: new DeepSeekProvider(transport), humanReplies: workflow,
      modelPending: new Set(), automaticSignal: new AbortController().signal, modelSignal: new AbortController().signal,
      isClosing: () => false, keyPresent: true, settings: () => ({ model: "gpt-4.1-mini", persona: "", business: "", rules: "" }),
      knowledgeContext: () => null, updated: () => {}, stop: () => {}, beforeWork: () => {}, statusUpdated: () => {},
      errorCode: err => (err instanceof Error ? err.message : "ERR"),
    });

    expect(injectedBlock).toBe(true);
    expect(connector.clickCount).toBe(0);
    expect(store.db.prepare("SELECT count(*) FROM send_intents").pluck().get()).toBe(0);
    expect(store.db.prepare("SELECT status, reason FROM manual_send_commands WHERE event_id=?").get(eventId!)).toEqual({
      status: "FAILED_BEFORE_CLICK", reason: "CUSTOM_SENSITIVE_WORD",
    });
    expect(store.db.prepare("SELECT state, reason FROM automation_jobs WHERE event_id=?").get(eventId!)).toEqual({
      state: "FAILED_BEFORE_CLICK", reason: "CUSTOM_SENSITIVE_WORD",
    });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("R3 #4: multi-batch persona analyze routes PERSONA_ANALYSIS to utility slot and PERSONA_MERGE to primary slot", async () => {
  const { root, nowMs, store, automation, models } = await setupEnv("m3-r3-merge-");
  let knowledge: ReplyKnowledgeService | undefined;
  try {
    const calls: Array<{ model: string; body: string }> = [];
    const transport: typeof fetch = async (_url, init) => {
      const body = String(init?.body ?? "");
      const parsed = JSON.parse(body) as { model: string };
      calls.push({ model: parsed.model, body });
      const text = parsed.model === "gpt-4o-mini"
        ? JSON.stringify({ rules: "单批提炼风格" })
        : JSON.stringify({ rules: "合并后最终风格" });
      return Response.json({
        id: "chat-merge",
        model: parsed.model,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    };
    const controller = new ModelProviderController(
      new ModelRouteGuard(models, automation),
      new ModelCredentialStore(root),
      transport,
      () => {},
    );
    const conn = models.saveConnection({
      connectionId: null, expectedVersion: 0, name: "OpenAI", presetId: "openai", protocol: "OPENAI_CHAT",
      baseUrl: "https://api.openai.com/v1", region: null,
      manualModels: [{ modelId: "gpt-4.1-mini", displayName: null }, { modelId: "gpt-4o-mini", displayName: null }],
    });
    await controller.dispatch({ command: "modelProviders", action: "setKey", connectionId: conn.id, expectedVersion: conn.version, storage: "MEMORY", key: "sk-merge" }, () => {});
    await controller.dispatch({ command: "modelProviders", action: "apply", connectionId: conn.id, routeRevision: 2, modelId: "gpt-4.1-mini", commandId: randomUUID(), confirmed: true, expectedSelectionRevision: 0 }, () => {});
    await controller.dispatch({ command: "modelProviders", action: "setSlot", commandId: randomUUID(), slot: "utility", connectionId: conn.id, routeRevision: 2, modelId: "gpt-4o-mini", confirmed: true }, () => {});

    const authority = new WorkbenchAuthority(store, () => nowMs);
    const token = authority.issueSession();
    automation.grant("MODEL", {
      ownId: "own-1", channels: ["DIRECT_MESSAGE"], model: "gpt-4.1-mini", modelLimit: 10, expiresAt: null,
    });

    knowledge = new ReplyKnowledgeService(store, authority, root, () => ({
      settings: { model: "gpt-4.1-mini", persona: "", business: "", rules: "" },
      models: controller, modelUnavailable: null, automation, signal: new AbortController().signal, closing: false,
    }));
    await knowledge.initialize();
    const samples = Array.from({ length: 10 }, (_, idx) => ({
      channel: "DIRECT_MESSAGE" as const,
      prompt: `Q${idx}:${"问".repeat(700)}`,
      response: `A${idx}:${"答".repeat(700)}`,
      group: "fixture",
      source: "IMPORTED" as const,
    }));
    knowledge.data.addSamples(store.accountId, samples);
    const sampleIds = store.db.prepare("SELECT id FROM k_samples").pluck().all() as string[];
    knowledge.data.selectSamples(store.accountId, sampleIds, true);

    const res = await knowledge.dispatch(token, { command: "replyKnowledge", action: "analyze", sampleIds, confirmed: true }) as { persona: { text: string } };
    expect(res.persona.text).toBe("合并后最终风格");
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.slice(0, -1).every(c => c.model === "gpt-4o-mini")).toBe(true);
    expect(calls.at(-1)?.model).toBe("gpt-4.1-mini");
    expect(calls.at(-1)?.body).toContain("合并风格规则");
  } finally {
    await knowledge?.close();
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
