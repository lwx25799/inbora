import { afterEach, expect, test, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { AccountActor } from "../../src/browser/account-actor.js";
import { BrowserService } from "../../src/app/browser-service.js";
import { ClientService } from "../../src/app/service.js";
import { CollectionScheduler, DeferredObjectRead } from "../../src/app/collection-scheduler.js";
import { VerificationScheduler } from "../../src/app/verification-scheduler.js";
import { humanQueueFrozen } from "../../src/app/human-queue-context.js";
import { claimReceiptRecheck, receiptRecheckVersion } from "../../src/app/receipt-recheck.js";
import { CredentialStore } from "../../src/app/credentials.js";
import { defaultSettings } from "../../src/app/contracts.js";
import type { ReplyPolicy } from "../../src/app/automation-contracts.js";
import { DeepSeekProvider } from "../../src/ai/deepseek.js";
import { Blocked, digest, eventBinding, targetKey, type InboundEvent } from "../../src/core/contracts.js";
import { AutomationStore } from "../../src/storage/automation-store.js";
import { ChatMessageStore } from "../../src/storage/chat-messages.js";
import { migrateClient } from "../../src/storage/client-migration.js";
import { migrateAutomation } from "../../src/storage/automation-migration.js";
import { migrateFollowups } from "../../src/storage/followup-migration.js";
import { approved, candidate, database, pending, privateTemp, snapshot } from "../helpers.js";
import { setupAssistant } from "../mcp-helpers.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

class MockBrowser extends BrowserService {
  private queue = new AccountActor();
  inspectGate: () => Promise<void> = async () => {};
  override get actor() {
    return this.queue;
  }
  override identity() {
    return {
      identityDigest: digest("own-1"),
      mappingDigest: "synthetic-p0-mapping",
      browserVersion: "1.0.0.0",
      browserMode: "headless" as const,
    };
  }
  override async refreshIdentity() {
    return this.identity();
  }
  override async open() {}
  override async close() {}
  override async adapter(event: InboundEvent) {
    let text = "";
    return {
      dispose: () => {},
      adapter: {
        inspect: async () => {
          await this.inspectGate();
          return snapshot(event);
        },
        prepare: async (_e: InboundEvent, value: string) => {
          text = value;
        },
        verifyPrepared: async () => snapshot(event),
        baseline: async () => [],
        clickOnce: async () => {},
        readback: async () => ({
          id: randomUUID(),
          ownId: "own-1",
          targetKey: targetKey(event),
          text,
          pending: false,
          sentAt: new Date().toISOString(),
        }),
      },
    };
  }
}

test("readOnly session renewal avoids SQLite writes, desktop reconnect preserves MCP sessions, and GUI config gates hold", async () => {
  const f = await setupAssistant();
  cleanups.push(() => f.close());

  const beforeChanges = (f.store.db.prepare("SELECT total_changes() n").get() as { n: number }).n;
  f.service.authority.renewTrustedSession(f.gui, { readOnly: true });
  expect((f.store.db.prepare("SELECT total_changes() n").get() as { n: number }).n).toBe(beforeChanges);
  f.store.db
    .prepare("UPDATE operator_sessions SET expires_at=? WHERE token_digest=?")
    .run(f.service.authority.now() + 60_000, digest(f.gui));
  const beforeLow = (f.store.db.prepare("SELECT total_changes() n").get() as { n: number }).n;
  f.service.authority.renewTrustedSession(f.gui, { readOnly: true });
  expect((f.store.db.prepare("SELECT total_changes() n").get() as { n: number }).n).toBe(beforeLow + 1);

  const assistantOp = f.service.authority.operator(f.token);
  expect(f.service.authority.ownership(f.store.event(f.eventId)).operator_id).toBe(assistantOp.id);
  f.service.authority.expireOperators("DESKTOP");
  expect(() => f.service.authority.operator(f.gui)).toThrow("OPERATOR_EXPIRED");
  expect(f.service.authority.operator(f.token).id).toBe(assistantOp.id);
  expect(f.service.authority.ownership(f.store.event(f.eventId)).operator_id).toBe(assistantOp.id);

  const policy: ReplyPolicy = {
    ownId: "own-1",
    channels: ["DIRECT_MESSAGE"],
    model: "deepseek-flash",
    modelLimit: 2,
    sendLimit: 2,
    expiresAt: null,
    workIds: [],
    futureOwnWorks: false,
    conversationIds: [],
    entireInbox: true,
    containsAny: [],
    excludesAny: [],
    instructions: "ok",
    startHour: 0,
    endHour: 24,
  };
  const forbidden: unknown[] = [
    { command: "configureAi", settings: defaultSettings, key: "k" },
    { command: "clearModelKey" },
    { command: "setKeyStorage", storage: "MEMORY" },
    { command: "setModelGrant", scope: null, confirmed: true },
    { command: "setReplyPolicy", policy: null, confirmed: true },
    { command: "enableReplyPolicy", policy, confirmed: true },
    {
      command: "configureCollection",
      settings: { ownId: "own-1", comments: true, inbox: true, commentIntervalMs: 30_000, dmIntervalMs: 30_000 },
    },
    { command: "browser", open: false, mode: "headless" },
    { command: "setMode", mode: "MANUAL" },
  ];
  for (const body of forbidden) {
    await expect(f.service.dispatch(f.token, body)).rejects.toThrow("ASSISTANT_PERMISSION_REQUIRED");
  }

  const gui = f.service.authority.issueSession();
  await f.service.dispatch(gui, { command: "setReplyPolicy", policy: { ...policy, model: "deepseek-chat" }, confirmed: true });
  await expect(f.service.dispatch(gui, { command: "setMode", mode: "LIMITED_AUTO" })).rejects.toThrow("MODEL_OUTSIDE_GRANT");
  await f.service.dispatch(gui, { command: "setReplyPolicy", policy, confirmed: true });
  f.store.db.prepare("UPDATE automation_grants SET scope_digest='tampered' WHERE kind='AUTO_REPLY' AND revoked_at IS NULL").run();
  await expect(f.service.dispatch(gui, { command: "setMode", mode: "LIMITED_AUTO" })).rejects.toThrow("GRANT_CORRUPT");
  f.store.db.prepare("DELETE FROM automation_grants WHERE kind='AUTO_REPLY' AND scope_digest='tampered'").run();
  await f.service.dispatch(gui, { command: "setReplyPolicy", policy, confirmed: true });
  f.auto.stop(true);
  await expect(f.service.dispatch(gui, { command: "setMode", mode: "LIMITED_AUTO" })).rejects.toThrow("EMERGENCY_STOPPED");
  f.auto.stop(false);
  await f.service.dispatch(gui, { command: "setMode", mode: "LIMITED_AUTO" });
  expect(f.service.authority.mode()).toBe("LIMITED_AUTO");
});

test("emergencyStop/close abort automaticAbort, replyKnowledge emits selectively, clearModelKey deletes DPAPI disk key", async () => {
  const root = privateTemp("p0-5-service-");
  const store = database();
  await migrateClient(store, join(root, "client.sqlite"));
  const eventId = pending(store, candidate());
  let enteredInspect!: () => void;
  let releaseInspect!: () => void;
  const inspectStarted = new Promise<void>((r) => {
    enteredInspect = r;
  });
  const browser = new MockBrowser(root);
  browser.inspectGate = async () => {
    enteredInspect();
    await new Promise<void>((r) => {
      releaseInspect = r;
    });
  };
  let modelCalls = 0;
  const provider = new DeepSeekProvider(async () => {
    modelCalls++;
    return new Response(
      JSON.stringify({
        model: "deepseek-flash",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  const service = new ClientService(store, browser, provider);
  cleanups.push(async () => {
    releaseInspect?.();
    await service.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await service.loadSettings();
  const token = service.authority.issueSession();
  await service.dispatch(token, { command: "configureAi", settings: defaultSettings, key: "synthetic-dpapi-key" });
  await service.dispatch(token, { command: "setKeyStorage", storage: "DPAPI" });
  expect(existsSync(join(root, "model-key.dpapi"))).toBe(true);
  await service.dispatch(token, { command: "clearModelKey" });
  expect(existsSync(join(root, "model-key.dpapi"))).toBe(false);
  expect(await new CredentialStore(root).load()).toBeNull();
  expect(await service.dispatch(token, { command: "getStatus" })).toMatchObject({ keyPresent: false, keyStored: false });

  const events: string[] = [];
  service.events.on("update", (m: { event: string }) => events.push(m.event));
  await service.dispatch(token, { command: "replyKnowledge", action: "overview" });
  const upload = (await service.dispatch(token, {
    command: "replyKnowledge",
    action: "importStart",
    name: "a.txt",
    bytes: 4,
    kind: "CHAT",
  })) as { id: string };
  await service.dispatch(token, {
    command: "replyKnowledge",
    action: "importChunk",
    id: upload.id,
    index: 0,
    data: Buffer.from("a:hi").toString("base64"),
  });
  await service.dispatch(token, { command: "replyKnowledge", action: "importCancel", id: upload.id });
  expect(events.filter((e) => e === "knowledge_updated")).toHaveLength(0);
  await service.dispatch(token, {
    command: "replyKnowledge",
    action: "saveKnowledge",
    input: {
      title: "发货说明",
      topic: "配送",
      text: "下单后当天发货",
      aliases: ["物流"],
      channels: ["DIRECT_MESSAGE", "COMMENT_NOTIFICATION"],
    },
  });
  expect(events.filter((e) => e === "knowledge_updated")).toHaveLength(1);

  await service.dispatch(token, { command: "configureAi", settings: defaultSettings, key: "synthetic-auto-key" });
  await service.dispatch(token, {
    command: "setReplyPolicy",
    confirmed: true,
    policy: {
      ownId: "own-1",
      channels: ["DIRECT_MESSAGE"],
      model: "deepseek-flash",
      modelLimit: 2,
      sendLimit: 2,
      expiresAt: null,
      workIds: [],
      futureOwnWorks: false,
      conversationIds: [],
      entireInbox: true,
      containsAny: [],
      excludesAny: [],
      instructions: "brief",
      startHour: 0,
      endHour: 24,
    },
  });
  await service.dispatch(token, { command: "setMode", mode: "LIMITED_AUTO" });
  const autoTask = service.runAutomaticReply();
  await inspectStarted;
  await service.dispatch(token, { command: "emergencyStop" });
  releaseInspect();
  await autoTask;
  expect(modelCalls).toBe(0);
  expect(store.db.prepare("SELECT * FROM automation_jobs WHERE event_id=?").get(eventId)).toBeUndefined();
});

test("schedulers recover from transient errors, DeferredObjectRead keeps failures=0, and resumeIdleAutomation is O(N)", async () => {
  const root = privateTemp("p0-5-schedulers-");
  const store = database();
  const file = store.db.name;
  store.close();
  Object.defineProperty(store, "db", { value: new Database(file) });
  store.db.pragma("foreign_keys = ON");
  await migrateClient(store, join(root, "client.sqlite"));
  await migrateAutomation(store, join(root, "automation.sqlite"));
  await migrateFollowups(store, join(root, "followups.sqlite"));
  let now = Date.now();
  const data = new AutomationStore(store, () => now);
  data.initialize(now);
  store.bindAccount("own-1");
  data.configureCollection({ ownId: "own-1", comments: true, inbox: true, commentIntervalMs: 30_000, dmIntervalMs: 15_000 });

  let call = 0;
  const collector = new CollectionScheduler(data, async () => {
    call++;
    if (call <= 5) throw new DeferredObjectRead("OBSERVATION_DOM_NOT_READY");
    if (call === 6) throw new Blocked("OBSERVATION_DOM_NOT_READY");
  });
  cleanups.push(async () => {
    await collector.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  for (let i = 0; i < 5; i++) {
    await collector.runNow("works");
    now += 30_000;
  }
  expect(store.db.prepare("SELECT failures FROM collection_progress WHERE source='works'").get()).toEqual({ failures: 0 });
  const beforeRealFail = now;
  await expect(collector.runNow("works")).rejects.toThrow("OBSERVATION_DOM_NOT_READY");
  expect(store.db.prepare("SELECT failures,next_at FROM collection_progress WHERE source='works'").get()).toEqual({
    failures: 1,
    next_at: beforeRealFail + 60_000,
  });

  const stateSpy = vi.spyOn(data, "state").mockImplementationOnce(() => {
    throw new Error("SQLITE_BUSY");
  });
  await (collector as unknown as { pulse(): Promise<void> }).pulse();
  expect(collector.status().fatal).toBe("COLLECTION_STATE_UNAVAILABLE");
  stateSpy.mockRestore();
  // Suspended and emergencyStopped early returns must not falsely clear fatal/backoff.
  collector.suspend(true);
  now += 2_000;
  await (collector as unknown as { pulse(): Promise<void> }).pulse();
  expect(collector.status().fatal).toBe("COLLECTION_STATE_UNAVAILABLE");
  collector.suspend(false);
  await (collector as unknown as { pulse(): Promise<void> }).pulse();
  expect(collector.status().fatal).toBeNull();

  const busyAgain = vi.spyOn(data, "state").mockImplementationOnce(() => {
    throw new Error("SQLITE_BUSY");
  });
  await (collector as unknown as { pulse(): Promise<void> }).pulse();
  expect(collector.status().fatal).toBe("COLLECTION_STATE_UNAVAILABLE");
  busyAgain.mockRestore();
  data.stop(true);
  now += 2_000;
  await (collector as unknown as { pulse(): Promise<void> }).pulse();
  expect(collector.status().fatal).toBe("COLLECTION_STATE_UNAVAILABLE");
  data.stop(false);
  call = 0;
  await collector.runNow("works");
  expect(collector.status().fatal).toBeNull();

  let verifierUpdates = 0;
  const verifier = new VerificationScheduler(
    data,
    async () => ({ verified: false, evidenceId: "x" }),
    () => {
      verifierUpdates++;
    },
  );
  cleanups.push(() => verifier.close());
  const vSpy = vi.spyOn(data, "state").mockImplementationOnce(() => {
    throw new Error("SQLITE_BUSY");
  });
  await (verifier as unknown as { pulse(): Promise<void> }).pulse();
  expect(verifierUpdates).toBe(0);
  vSpy.mockRestore();
  // Suspended early return keeps backoff; suspend(false) resets retryAt for immediate recovery.
  verifier.suspend(true);
  now += 2_000;
  await (verifier as unknown as { pulse(): Promise<void> }).pulse();
  verifier.suspend(false);
  await expect((verifier as unknown as { pulse(): Promise<void> }).pulse()).resolves.toBeUndefined();
  expect(verifierUpdates).toBe(0);

  const insert = store.db.prepare("INSERT INTO inbound_events VALUES(?,?,?,?,?,?,?,?,?)");
  store.db.transaction(() => {
    for (let i = 0; i < 200; i++) {
      const e = candidate({
        platformEventId: `idle-${i}`,
        conversationId: `conv-${i}`,
        occurredAt: new Date(Date.UTC(2026, 10, 1) + i * 1000).toISOString(),
      });
      insert.run(randomUUID(), e.accountId, e.channel, e.platformEventId, e.conversationId, targetKey(e), eventBinding(e), JSON.stringify(e), "AWAITING_DRAFT");
    }
  })();
  const service = new ClientService(store, new MockBrowser(root));
  cleanups.push(() => service.close());
  let eventScans = 0;
  const origEvents = store.events.bind(store);
  vi.spyOn(store, "events").mockImplementation(() => {
    eventScans++;
    return origEvents();
  });
  service.authority.resumeIdleAutomation();
  expect(eventScans).toBe(1);
});

test("sidecar disconnect drains in-flight requests cleanly and allows clean reconnect", async () => {
  const secret = randomBytes(32).toString("hex");
  const root = privateTemp("p0-5-sidecar-disconnect-");
  const child = spawn(process.execPath, ["--import", "tsx", "src/app/sidecar.ts"], {
    cwd: resolve("."),
    env: { ...process.env, INBORA_PIPE_NONCE: secret },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const pendingReq = new Map<string, (v: Record<string, unknown>) => void>();
  let ready!: () => void;
  const boot = new Promise<void>((r) => {
    ready = r;
  });
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += String(d);
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.ready) ready();
    if (typeof value.requestId === "string") {
      pendingReq.get(value.requestId)?.(value);
      pendingReq.delete(value.requestId);
    }
  });
  const call = (body: unknown) => {
    const requestId = randomUUID();
    return new Promise<Record<string, unknown>>((resolve) => {
      pendingReq.set(requestId, resolve);
      child.stdin.write(JSON.stringify({ protocol: 1, requestId, secret, body }) + "\n");
    });
  };
  const exited = new Promise<number | null>((r) => child.once("exit", r));
  cleanups.push(async () => {
    if (child.exitCode === null) {
      child.stdin.end();
      child.kill();
    }
    await exited;
    lines.close();
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });
  await boot;
  expect(await call({ command: "connect", runtime: root, initialize: true, consent: true })).toMatchObject({ ok: true });
  const [statusRes, disconnectRes] = await Promise.all([
    call({ command: "getStatus" }),
    call({ command: "disconnect" }),
  ]);
  expect(disconnectRes).toEqual({ protocol: 1, requestId: expect.any(String), ok: true, result: { connected: false } });
  expect(statusRes.protocol).toBe(1);
  expect(statusRes.ok === true || statusRes.error === "CLIENT_CLOSING").toBe(true);
  expect(await call({ command: "connect", runtime: root, initialize: false, consent: true })).toMatchObject({ ok: true });
  child.stdin.end();
  expect(await exited).toBe(0);
  expect(stderr).toBe("");
}, 30_000);

test("OBSERVATION_SECURITY_SUSPECT stays whitelisted and DM clock tolerance (+2000ms) aligns sendFrozen and receiptRecheck", async () => {
  const root = privateTemp("p0-5-suspect-and-clock-");
  const store = database();
  cleanups.push(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const baseMs = Date.now() - 60_000;
  const originalPayload = candidate({ platformEventId: "1001", conversationId: "conv-clock", occurredAt: new Date(baseMs).toISOString() });
  const draftId = approved(store, originalPayload);
  await migrateClient(store, join(root, "client.sqlite"));
  await migrateAutomation(store, join(root, "automation.sqlite"));
  await migrateFollowups(store, join(root, "followups.sqlite"));
  const origEventId = store.draft(draftId).eventId;
  const intentId = store.recordIntent(draftId, snapshot(originalPayload), false, { check: () => {}, committed: () => {} });
  store.db.prepare("UPDATE send_intents SET attempt_started_at=? WHERE id=?").run(new Date(baseMs + 5_000).toISOString(), intentId);
  store.receipt(intentId, "UNCERTAIN", "POST_INTENT_FAILURE:READBACK:OBSERVATION_SECURITY_SUSPECT");

  // humanQueueFrozen must block same operator when proof_ref carries OBSERVATION_SECURITY_SUSPECT.
  store.db.prepare("INSERT INTO manual_send_commands VALUES(?,?,?,?,?,'UNCERTAIN',?,NULL,?)").run("cmd-1", origEventId, "op-1", "d", "{}", intentId, baseMs);
  store.db.prepare("INSERT INTO manual_send_inputs VALUES(?,?)").run("cmd-1", "in-1");
  expect(humanQueueFrozen(store, store.event(origEventId), "op-1")).toBe(true);

  // sendFrozen allows a distinct later incoming DM whose server timestamp is <=2000ms ahead of local clock, and blocks >2000ms ahead.
  const withinSkew = pending(store, candidate({ platformEventId: "1002", conversationId: "conv-clock", occurredAt: new Date(Date.now() + 1_500).toISOString() }));
  const beyondSkew = pending(store, candidate({ platformEventId: "1003", conversationId: "conv-clock", occurredAt: new Date(Date.now() + 2_500).toISOString() }));
  expect(store.sendFrozen(withinSkew)).toBe(false);
  expect(store.sendFrozen(beyondSkew)).toBe(true);

  // claimReceiptRecheck accepts DM outgoing candidate up to now + 2000ms and rejects > now + 2000ms; repair failure audits OBSERVATION_SECURITY_SUSPECT.
  const now = Date.now() + 10_000;
  const recheckPayload = candidate({ platformEventId: "2001", conversationId: "conv-recheck", occurredAt: new Date(now - 20_000).toISOString() });
  const rEventId = pending(store, recheckPayload);
  const rDraftId = randomUUID();
  const rText = "recheck clock skew reply";
  store.db.prepare("INSERT INTO reply_drafts VALUES(?,?,?,'mock',1,'DRAFT',NULL,NULL)").run(rDraftId, rEventId, rText);
  store.db.prepare("UPDATE inbound_events SET status='AWAITING_APPROVAL' WHERE id=?").run(rEventId);
  const rProof = { ...snapshot(recheckPayload), contextDigest: "a".repeat(64) };
  store.approve(rDraftId, rProof, 1, rText);
  const rIntentId = store.recordIntent(rDraftId, rProof, false, { check: () => {}, committed: () => {} });
  const rBoundary = store.intentBoundary(rIntentId);
  store.receipt(rIntentId, "UNCERTAIN", "POST_INTENT_FAILURE:READBACK:UNCLASSIFIED");
  store.db
    .prepare("INSERT INTO verification_jobs VALUES(?,?,?,?,2,?,?,?,?)")
    .run(rIntentId, rEventId, rBoundary, digest(rProof), now - 100, now - 1, "REVIEW", "OBSERVATION_DM_CONTENT_DOM_NOT_READY");

  const chat = new ChatMessageStore(store);
  const within = candidate({ conversationId: "conv-recheck", platformEventId: "9002", direction: "OUTGOING", actorId: "own-1", text: rText, occurredAt: new Date(now + 1_500).toISOString() });
  chat.observe([within], "own-1", Date.parse(rBoundary) - 1_000, now);
  const tooFar = { ...within, occurredAt: new Date(now + 2_500).toISOString() };
  store.db.prepare("UPDATE chat_messages SET payload=?,binding=? WHERE conversation_id='conv-recheck'").run(JSON.stringify(tooFar), eventBinding(tooFar));
  expect(claimReceiptRecheck(store, now)).toBeUndefined();

  store.db.prepare("UPDATE chat_messages SET payload=?,binding=? WHERE conversation_id='conv-recheck'").run(JSON.stringify(within), eventBinding(within));
  const auto = new AutomationStore(store, () => now);
  auto.initialize(now - 10_000);
  const repairWorker = new VerificationScheduler(auto, async () => {
    throw new Blocked("OBSERVATION_SECURITY_SUSPECT");
  });
  cleanups.push(() => repairWorker.close());
  await repairWorker.tick();
  expect(
    store.db.prepare("SELECT event_type FROM audit_events WHERE event_type LIKE ?").all(receiptRecheckVersion + "_FAILED_%"),
  ).toEqual([{ event_type: receiptRecheckVersion + "_FAILED_OBSERVATION_SECURITY_SUSPECT" }]);
});
