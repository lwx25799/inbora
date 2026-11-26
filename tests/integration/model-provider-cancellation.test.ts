import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import * as modelClient from "../../src/ai/model-client.js";
import { ModelCredentialStore } from "../../src/app/credentials.js";
import { BrowserService } from "../../src/app/browser-service.js";
import { AccountActor } from "../../src/browser/account-actor.js";
import { digest, targetKey, type InboundEvent } from "../../src/core/contracts.js";
import { ReplyKnowledgeStore } from "../../src/knowledge/store.js";
import { AutomationStore } from "../../src/storage/automation-store.js";
import { snapshot } from "../helpers.js";
import { applyModel, chatAnswer, deferred, fixturePolicy, installFixtureKey, modelFixture, providerState, stageFixtureModel } from "../model-provider-helpers.js";

class GateBrowser extends BrowserService {
  private serial = new AccountActor();
  clicks = 0;
  prepare = async () => {};
  final = async () => {};
  clicked = async () => {};
  override get actor() { return this.serial; }
  override async close() {}
  override identity() {
    return { identityDigest: digest("own-1"), mappingDigest: "fixture", browserVersion: "1", browserMode: "headed" as const };
  }
  override async refreshIdentity() { return this.identity(); }
  override async adapter(event: InboundEvent) {
    let prepared = "", verifications = 0;
    return { dispose: () => {}, adapter: {
      inspect: async () => snapshot(event),
      prepare: async (_event: InboundEvent, text: string) => { await this.prepare(); prepared = text; },
      verifyPrepared: async () => { if (++verifications === 2) await this.final(); return snapshot(event); },
      baseline: async () => [],
      clickOnce: async () => { this.clicks++; await this.clicked(); },
      readback: async () => ({ id: randomUUID(), ownId: "own-1", targetKey: targetKey(event),
        text: prepared, pending: false, sentAt: new Date(Date.now() + 50).toISOString() }),
    } };
  }
}

async function fixture(transport: typeof fetch = async () => chatAnswer()) {
  let browser!: GateBrowser;
  const f = await modelFixture(transport, root => browser = new GateBrowser(root));
  await installFixtureKey(f.service, f.token);
  await f.service.dispatch(f.token,{command:'setMode',mode:'MANUAL'});
  const before = (await providerState(f.service, f.token)).selection;
  const target = await stageFixtureModel(f.service, f.token);
  const change = () => applyModel(f.service, f.token, target.connectionId, target.routeRevision, target.modelId);
  return { ...f, browser, before, change };
}

async function enable(f: Awaited<ReturnType<typeof fixture>>) {
  await f.service.dispatch(f.token, { command: "enableReplyPolicy", confirmed: true, policy: fixturePolicy });
}

test.each(["before-reserve", "before-client", "before-return", "prepare", "before-intent"])(
  "switch at %s blocks the old automatic command before an intent or click", async stage => {
    const entered = deferred(), release = deferred();
    const gate = async () => { entered.resolve(); await release.promise; };
    let requests = 0;
    const f = await fixture(async () => {
      requests++;
      if (stage === "before-return") await gate();
      return chatAnswer();
    });
    let work: Promise<void> | undefined;
    try {
      if (stage === "before-reserve") {
        const load = ModelCredentialStore.prototype.load;
        vi.spyOn(ModelCredentialStore.prototype, "load").mockImplementation(async function (this: ModelCredentialStore, ref, active) {
          if (ref.connectionId === f.before.connectionId) await gate();
          return load.call(this, ref, active);
        });
      }
      if (stage === "before-client") {
        const generate = modelClient.generateModelText;
        vi.spyOn(modelClient, "generateModelText").mockImplementation(async input => { await gate(); return generate(input); });
      }
      if (stage === "prepare") f.browser.prepare = gate;
      if (stage === "before-intent") f.browser.final = gate;
      await enable(f);
      work = f.service.runAutomaticReply();
      await entered.promise;
      await f.change();
      release.resolve();
      await work;
      expect(f.store.db.prepare("SELECT count(*) FROM send_intents").pluck().get()).toBe(0);
      expect(f.browser.clicks).toBe(0);
      expect(f.store.budget("SEND").used).toBe(0);
      expect(f.store.budget("MODEL").used).toBe(stage === "before-reserve" ? 0 : 1);
      expect(requests).toBe(["before-reserve", "before-client"].includes(stage) ? 0 : 1);
      expect(f.service.authority.draftFor(f.eventId)?.text ?? null).toBe(
        stage === "prepare" || stage === "before-intent" ? "Synthetic model answer." : null);
      expect(f.store.db.prepare("SELECT reason FROM automation_jobs WHERE event_id=?").pluck().get(f.eventId)).toBe("MODEL_ROUTE_CHANGED");
    } finally { release.resolve(); await work; vi.restoreAllMocks(); await f.close(); }
  },
);

test("an intent already committed continues its own readback and never clicks twice", async () => {
  const committed = deferred(), release = deferred();
  const f = await fixture();
  let work: Promise<void> | undefined;
  try {
    f.browser.clicked = async () => { committed.resolve(); await release.promise; };
    await enable(f);
    work = f.service.runAutomaticReply();
    await committed.promise;
    const before = f.store.db.prepare("SELECT * FROM send_intents").get();
    expect(before).toMatchObject({ status: "INTENT_RECORDED" });
    await f.change();
    expect(f.store.db.prepare("SELECT * FROM send_intents").get()).toEqual(before);
    release.resolve();
    await work;
    await f.service.runAutomaticReply();
    expect(f.store.db.prepare("SELECT status FROM send_intents").pluck().get()).toBe("CONFIRMED");
    expect(f.browser.clicks).toBe(1);
  } finally { release.resolve(); await work; await f.close(); }
});

test("beforeRequest rejects a stale selection version before the first POST with a live signal", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => chatAnswer());
  const f = await fixture(fetch);
  const generate = modelClient.generateModelText;
  const beforeRequest = vi.fn();
  const generation = vi.spyOn(modelClient, "generateModelText").mockImplementation(input => generate({
    ...input,
    beforeRequest: () => {
      expect(input.signal?.aborted).toBe(false);
      expect(input.beforeRequest).toBeTypeOf("function");
      beforeRequest();
      // Change the persisted version at the wire boundary without firing the controller's cancellation path.
      f.store.db.prepare("UPDATE m_selection SET revision=revision+1 WHERE id=1").run();
      input.beforeRequest!();
    },
  }));
  try {
    await enable(f);
    await f.service.runAutomaticReply();
    expect(beforeRequest).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(f.store.db.prepare("SELECT outcome,error_code FROM m_call_routes").get())
      .toEqual({ outcome: "FAILED", error_code: "MODEL_ROUTE_CHANGED" });
    expect(f.store.db.prepare("SELECT count(*) FROM send_intents").pluck().get()).toBe(0);
    expect(f.browser.clicks).toBe(0);
  } finally {
    generation.mockRestore();
    await f.close();
  }
});

test("a historical suggestion retains both bindings and its knowledge check after explicitly becoming a human draft", async () => {
  const f = await fixture();
  try {
    await f.service.dispatch(f.token, { command: "setModelGrant", confirmed: true, scope: {
      ownId: "own-1", channels: ["DIRECT_MESSAGE"], model: f.before.modelId, modelLimit: 2, expiresAt: null,
    } });
    const knowledge = new ReplyKnowledgeStore(f.store);
    const entry = knowledge.saveKnowledge("account_001", { title: "Hello greeting", topic: "hello", text: "Hello is a public greeting." });
    knowledge.setKnowledgeState("account_001", entry.id, "ACTIVE");
    const { eventId, service, token } = f;
    const suggestion = await service.dispatch(token, { command: "generateSuggestion", eventId, draftVersion: 0 }) as { id: string; text: string };
    await f.change();
    const selectionId = randomUUID();
    service.authority.select(token, eventId, selectionId);
    const { generation } = service.authority.claim(token, eventId, 0);
    const draft = service.authority.save(token, eventId, generation, 0, suggestion.text, suggestion.id);
    const route = f.store.db.prepare("SELECT call_id FROM m_generation_bindings ORDER BY owner_kind").pluck().all();
    expect(route).toHaveLength(2);
    expect(new Set(route).size).toBe(1);
    expect(f.store.db.prepare("SELECT count(*) FROM k_generation_contexts WHERE kind IN ('DRAFT','SUGGESTION')").pluck().get()).toBe(2);
    const params = { eventId, generation, selectionId, draftId: draft.id, draftVersion: draft.version,
      text: draft.text, contextVersion: service.authority.contextVersion(f.store.event(eventId)) };
    service.authority.attest("DIRECT_MESSAGE", "SEND_AVAILABLE", f.browser.identity(), "synthetic-only");
    expect(() => service.authority.assertCanSend(token, params, f.browser.identity())).not.toThrow();
    knowledge.setKnowledgeState("account_001", entry.id, "DISABLED");
    expect(() => service.authority.assertCanSend(token, params, f.browser.identity())).toThrow("KNOWLEDGE_CONTEXT_CHANGED");
    expect(f.store.db.prepare("SELECT count(*) FROM ai_suggestions").pluck().get()).toBe(1);
    expect(service.authority.draftFor(eventId)?.text).toBe(suggestion.text);
  } finally { await f.close(); }
});

test("a typed human reply can send once with no current Key", async () => {
  const f = await fixture();
  try {
    await f.service.dispatch(f.token, { command: "clearModelKey" });
    const { service, token, eventId } = f;
    const selectionId = randomUUID();
    service.authority.select(token, eventId, selectionId);
    const { generation } = service.authority.claim(token, eventId, 0);
    await service.dispatch(token, { command: "sendHumanReply", commandId: randomUUID(), input: {
      eventId, selectionId, generation, expectedVersion: 0, text: "Human reply.", suggestionId: null,
      contextVersion: service.authority.contextVersion(f.store.event(eventId)),
    } });
    await service.drain();
    expect(f.browser.clicks).toBe(1);
    expect(f.store.budget("MODEL").used).toBe(0);
    expect(service.authority.draftFor(eventId)?.origin).toBe("HUMAN_TYPED");
  } finally { await f.close(); }
});

test("startup preserves legacy automatic text and marks it unproven without recreating source rows", async () => {
  const f = await fixture();
  let restarted: typeof f.service | undefined;
  try {
    await enable(f);
    const grant = f.service.authority.modelRoute!.automation.active("AUTO_REPLY")!;
    const draft = { id: randomUUID(), version: 1, text: "Legacy automatic text" };
    f.store.db.prepare("INSERT INTO reply_drafts VALUES(?,?,?,?,1,'DRAFT',NULL,NULL)")
      .run(draft.id,f.eventId,draft.text,"deepseek-flash");
    f.store.db.prepare("INSERT INTO draft_revisions VALUES(?,?,'AUTO_POLICY',?,?,?)")
      .run(draft.id, draft.version, draft.text, "legacy-policy", Date.now());
    f.store.db.prepare("INSERT INTO automation_jobs VALUES(?,?,?,?,?,?,NULL,?,?,?)")
      .run(f.eventId, grant.version, "REVIEW", "legacy-context", 0, draft.version, "RESTART_NO_REPLAY", Date.now(), Date.now());
    await f.service.close();
    const next = await f.start(); restarted = next.service;
    expect(restarted.authority.draftFor(f.eventId)?.text).toBe(draft.text);
    expect(f.store.db.prepare("SELECT state,reason FROM automation_jobs WHERE event_id=?").get(f.eventId))
      .toEqual({ state: "REVIEW", reason: "LEGACY_MODEL_ROUTE_UNPROVEN" });
    expect(f.store.db.prepare("SELECT count(*) FROM m_generation_bindings").pluck().get()).toBe(0);
  } finally { await restarted?.close(); await f.close(); }
});

test("a scheduler-triggered emergency stop invalidates paid output even when recovery happens before it returns", async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture(async () => { entered.resolve(); await release.promise; return chatAnswer(); });
  try {
    await f.service.dispatch(f.token, { command: "setModelGrant", confirmed: true, scope: {
      ownId: "own-1", channels: ["DIRECT_MESSAGE"], model: f.before.modelId, modelLimit: 2, expiresAt: null,
    } });
    const running = expect(f.service.dispatch(f.token, { command: "generateSuggestion", eventId: f.eventId, draftVersion: 0 }))
      .rejects.toThrow("EMERGENCY_STOPPED");
    await entered.promise;
    const auto = new AutomationStore(f.store);
    auto.stop(true, "ACCOUNT_CHANGED", "VERIFICATION");
    expect(auto.resumeEmergency(auto.emergencyRevision())).toBe(true);
    release.resolve();
    await running;
    expect(f.store.db.prepare("SELECT count(*) FROM ai_suggestions").pluck().get()).toBe(0);
    expect(f.store.db.prepare("SELECT outcome,error_code FROM m_call_routes").get())
      .toEqual({ outcome: "CANCELLED", error_code: "EMERGENCY_STOPPED" });
    expect(f.store.budget("MODEL").used).toBe(1);
  } finally { release.resolve(); await f.close(); }
});
