import { afterEach, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import { AccountActor } from "../../src/browser/account-actor.js";
import type { BrowserProfileOwner } from "../../src/browser/profile-owner.js";
import { BrowserService } from "../../src/app/browser-service.js";
import { BrowserSafety } from "../../src/app/browser-safety.js";
import { SecurityIncidents, type IncidentContext } from "../../src/app/security-incidents.js";
import { ClientService } from "../../src/app/service.js";
import { VerificationScheduler } from "../../src/app/verification-scheduler.js";
import { ObservedReader } from "../../src/adapters/observed-reader.js";
import type { SecuritySignal } from "../../src/adapters/security-signal.js";
import { digest, targetKey, type InboundEvent } from "../../src/core/contracts.js";
import { EventStore } from "../../src/storage/store.js";
import { AutomationStore } from "../../src/storage/automation-store.js";
import { loadObservationMapping } from "../../src/config/runtime.js";
import { migrateClient } from "../../src/storage/client-migration.js";
import { readSecurityHold } from "../../src/storage/security-holds.js";
import { commentThreadPage, readCommentThreadContext } from "../../src/storage/comment-thread-context.js";
import { observedMapping } from "../fixtures/observed-site.js";
import { mapping } from "../fixtures/site.js";
import { candidate, database, pending, privateTemp, snapshot } from "../helpers.js";
import { setupAssistant } from "../mcp-helpers.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

class MockBrowser extends BrowserService {
  private queue = new AccountActor();
  clicks = 0;
  uncertain = false;
  lastNative = "";
  constructor(root: string, private readonly clock: () => number = Date.now) {
    super(root);
  }
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
        inspect: async () => snapshot(event),
        prepare: async (_e: InboundEvent, value: string) => {
          text = value;
        },
        verifyPrepared: async () => snapshot(event),
        baseline: async () => [],
        clickOnce: async () => {
          this.clicks++;
        },
        readback: async (_e: InboundEvent, expectedText: string) =>
          this.uncertain
            ? null
            : {
                id: (this.lastNative = randomUUID()),
                ownId: "own-1",
                targetKey: targetKey(event),
                text: expectedText || text,
                pending: false,
                sentAt: new Date(this.clock() + 1000).toISOString(),
              },
      },
    };
  }
}

test("P0-1: disk failure during security hold keeps inline recovery meta without bypassing tampered disk JSON", async () => {
  const root = privateTemp("p0-1-security-");
  const store = new EventStore(join(root, "poc.sqlite"), true);
  cleanups.push(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  store.bindAccount("100");
  const obs = { ...observedMapping("https://www.douyin.com"), environment: "douyin" as const };
  await writeFile(join(root, "observation-mapping.json"), JSON.stringify(obs));
  const loadedObs = (await loadObservationMapping(root))!;
  const initial: SecuritySignal = {
    version: 1,
    state: "SUSPECT",
    kind: "COMPONENT",
    scope: "TARGET",
    href: `${loadedObs.entryUrl}?token=secret-must-strip`,
    origin: "https://www.douyin.com",
    title: "Synthetic",
    documentStartedAt: 123,
    observedAt: 456,
    target: { conversationId: loadedObs.peers[0]!.conversationId },
    matches: [],
    frames: [],
  };
  const ctx: IncidentContext = {
    mode: "headless",
    epoch: 1,
    instanceId: "inst-1",
    selectors: [loadedObs.securityBlockers],
    mappingDigest: digest(loadedObs),
  };
  const fakePage = {
    evaluate: async () => initial,
    frames: () => [],
    screenshot: async () => Buffer.from("x"),
  } as unknown as Page;

  const brokenRecorder = new SecurityIncidents(join(root, "missing-dir"), store);
  await brokenRecorder.record("DIRECT_MESSAGE", fakePage, initial, ctx);
  const hold = readSecurityHold(store, "DIRECT_MESSAGE")!;
  expect(hold).not.toBeNull();
  expect(await brokenRecorder.read(hold.incidentId)).toBeNull();

  const auditRow = store.db
    .prepare("SELECT detail_redacted FROM audit_events WHERE event_type='SECURITY_INCIDENT_RECOVERY_META' AND entity_id=?")
    .get(hold.incidentId) as { detail_redacted: string };
  expect(auditRow.detail_redacted).not.toContain("secret-must-strip");
  expect(auditRow.detail_redacted).not.toContain(obs.peers[0]!.conversationId);

  const safety = new BrowserSafety(root, store);
  const fallback = await safety.incidents.readRecovery(hold.incidentId);
  expect(fallback).toMatchObject({
    fromFallback: true,
    channel: "DIRECT_MESSAGE",
    conversationDigest: digest(obs.peers[0]!.conversationId),
    initial: { href: new URL(obs.entryUrl).toString(), origin: "https://www.douyin.com" },
  });

  const guardSpy = vi.spyOn(ObservedReader.prototype, "guard").mockResolvedValue();
  let pageUrl = obs.entryUrl;
  const page = {
    url: () => pageUrl,
    goto: async (url: string) => {
      pageUrl = url;
    },
    evaluate: async (fn: unknown) => {
      const src = String(fn);
      if (src.includes("performance.timeOrigin")) return { href: pageUrl, started: 555 };
      if (src.includes("originMatches")) return { originMatches: true, empty: true };
      return { events: [] };
    },
  } as unknown as Page;
  const owner = { notification: page, dm: page, actor: new AccountActor() } as unknown as BrowserProfileOwner;
  safety.attach(owner, 1, "headless");
  await expect(safety.recover(owner, "DIRECT_MESSAGE", undefined, true)).resolves.toBe(true);
  expect(readSecurityHold(store, "DIRECT_MESSAGE")).toBeNull();
  guardSpy.mockRestore();

  await mkdir(join(root, "evidence", "security-incidents"), { recursive: true });
  await writeFile(join(root, "evidence", "security-incidents", hold.incidentId + ".json"), "{corrupt-tampered");
  expect(await safety.incidents.readRecovery(hold.incidentId)).toBeNull();
});

test("P0-2: beginLoginRecovery rolls back on failure and completeLoginIfVerified never deadlocks in MANUAL_VISIBLE_PENDING", async () => {
  const root = privateTemp("p0-2-login-");
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "site-mapping.json"), JSON.stringify({ ...mapping("https://www.douyin.com"), environment: "douyin", ownId: "100" }));
  await writeFile(join(root, "observation-mapping.json"), JSON.stringify({ ...observedMapping("https://www.douyin.com"), environment: "douyin" }));

  let failHeadedLaunch = true;
  let launches = 0;
  const contexts: EventEmitter[] = [];
  const browser = new BrowserService(root, async (_profile, headless) => {
    launches++;
    if (!headless && failHeadedLaunch) throw new Error("synthetic headed launch failed");
    const context = new EventEmitter();
    contexts.push(context);
    let url = "https://www.douyin.com/";
    const makePage = () => ({
      url: () => url,
      goto: async (u: string) => {
        url = u;
      },
      evaluate: async () => ({ originMatches: true, empty: true }),
      locator: () => ({ evaluateAll: async () => true }),
    });
    const pages = [makePage(), makePage()];
    return {
      context,
      notification: pages[0],
      dm: pages[1],
      actor: new AccountActor(),
      version: () => "synthetic-1",
      open: async (origin: string) => {
        for (const p of pages) await p.goto(origin);
      },
      close: async () => {
        context.emit("close");
      },
    } as unknown as BrowserProfileOwner;
  });
  cleanups.push(async () => browser.close());

  await browser.open();
  await expect(browser.beginLoginRecovery(false)).rejects.toThrow("synthetic headed launch failed");
  expect(browser.loginRecovery).toBe(false);
  expect(browser.status().mode).toBe("headless");

  failHeadedLaunch = false;
  await browser.open();
  await browser.beginLoginRecovery(false);
  expect(browser.status().state).toBe("MANUAL_VISIBLE");
  contexts.at(-1)!.emit("close");
  expect(browser.status().state).toBe("MANUAL_VISIBLE_PENDING");

  let verified = false;
  const guard = vi.spyOn(ObservedReader.prototype, "guard").mockImplementation(async () => {
    if (!verified) throw new Error("LOGIN_REQUIRED");
  });
  await expect(browser.completeLoginIfVerified("100")).rejects.toThrow("LOGIN_REQUIRED");
  expect(browser.status().mode).toBe("headless");
  expect(browser.status().state).toBe("LOGIN_RECOVERY");
  verified = true;
  expect(await browser.completeLoginIfVerified("100")).toBe(true);
  expect(browser.loginRecovery).toBe(false);
  expect(launches).toBeGreaterThanOrEqual(4);
  guard.mockRestore();
});

test("P0-3: commentThreadPage accepts followup:<uuid> pagination cursors", () => {
  const store = database();
  cleanups.push(async () => store.close());
  const origin = Date.now() - 60_000;
  store.bindAccount("100");
  store.db.exec(
    `CREATE TABLE human_reply_turns(command_id TEXT PRIMARY KEY,event_id TEXT NOT NULL,target_key TEXT NOT NULL,
      operator_id TEXT NOT NULL,input_digest TEXT NOT NULL,params TEXT NOT NULL,text TEXT NOT NULL,version INTEGER NOT NULL,
      status TEXT NOT NULL,approval TEXT,intent_id TEXT,attempt_started_at TEXT,reason TEXT,proof_ref TEXT,verified_at TEXT,
      native_id_digest TEXT,created_at INTEGER NOT NULL)`,
  );
  const make = (id: string, text: string, offset: number): InboundEvent => ({
    accountId: "account_001",
    channel: "COMMENT_NOTIFICATION",
    platformEventId: id,
    actorId: "201",
    actorName: "Author",
    text,
    occurredAt: new Date(origin + offset).toISOString(),
    videoId: "10",
    commentId: id,
    conversationId: null,
    direction: "INCOMING",
    kind: id === "11" ? "COMMENT" : "REPLY",
    evidenceId: "synthetic",
    ...(id === "11" ? {} : { rootCommentId: "11", replyToCommentId: id }),
  });
  const root = make("11", "root", -1000),
    c1 = make("21", "child 1", 1000),
    c2 = make("22", "child 2", 3000);
  store.observe("COMMENT_NOTIFICATION", "work:10", [root, c1, c2], "100", "synthetic", new Date().toISOString(), origin);
  const childRow = store.events().find((e) => e.payload.commentId === "21")!;
  const followupId = randomUUID();
  store.db
    .prepare("INSERT INTO human_reply_turns VALUES(?,?,?,?,?,?,?,1,'CONFIRMED',NULL,?,?,NULL,NULL,?,NULL,?)")
    .run(
      followupId,
      childRow.id,
      targetKey(childRow.payload),
      "op-1",
      "d",
      "{}",
      "followup text",
      randomUUID(),
      new Date(origin + 2000).toISOString(),
      new Date(origin + 2010).toISOString(),
      origin + 2000,
    );
  const context = readCommentThreadContext(store, c2);
  const firstPage = commentThreadPage(context, undefined, 2);
  expect(firstPage.hasMore).toBe(true);
  expect(firstPage.items.map((item) => item.id)).toContain("followup:" + followupId);
  const olderPage = commentThreadPage(context, firstPage.before!, 2);
  expect(olderPage.items.some((item) => item.text === "child 1")).toBe(true);
});

test("P0-4: followup GUI isolation, capability evidence digest, and pause/select cancellation", async () => {
  const f = await setupAssistant();
  cleanups.push(() => f.close());
  f.service.authority.release(f.token, f.eventId, f.input.generation);
  const selectionId = randomUUID();
  const detail = (await f.service.dispatch(f.gui, {
    command: "openHumanDialog",
    eventId: f.eventId,
    selectionId,
  })) as { ownership: { generation: number }; contextVersion: string };
  const firstId = randomUUID();
  await f.service.dispatch(f.gui, {
    command: "sendHumanReply",
    commandId: firstId,
    input: {
      eventId: f.eventId,
      generation: detail.ownership.generation,
      expectedVersion: 0,
      text: "first gui reply",
      contextVersion: detail.contextVersion,
      selectionId,
      suggestionId: null,
    },
  });
  await f.service.drain();
  expect(await f.service.dispatch(f.gui, { command: "getSendResult", commandId: firstId })).toMatchObject({ status: "CONFIRMED" });

  await expect(
    f.service.dispatch(f.token, {
      command: "saveHumanFollowupDraft",
      eventId: f.eventId,
      generation: detail.ownership.generation,
      expectedVersion: 0,
      text: "assistant forbidden",
      suggestionId: null,
    }),
  ).rejects.toThrow("ASSISTANT_PERMISSION_REQUIRED");
  await expect(
    f.service.dispatch(f.token, {
      command: "sendHumanFollowup",
      commandId: randomUUID(),
      input: {
        eventId: f.eventId,
        generation: detail.ownership.generation,
        expectedVersion: 0,
        text: "assistant forbidden send",
        contextVersion: f.service.authority.contextVersion(f.store.event(f.eventId)),
        selectionId,
        suggestionId: null,
      },
    }),
  ).rejects.toThrow("ASSISTANT_PERMISSION_REQUIRED");

  const secondId = randomUUID();
  await f.service.dispatch(f.gui, {
    command: "sendHumanFollowup",
    commandId: secondId,
    input: {
      eventId: f.eventId,
      generation: detail.ownership.generation,
      expectedVersion: 0,
      text: "second gui reply",
      contextVersion: f.service.authority.contextVersion(f.store.event(f.eventId)),
      selectionId,
      suggestionId: null,
    },
  });
  await f.service.drain();
  const cap = f.service.authority.capability("DIRECT_MESSAGE", f.browser.identity());
  expect(cap.evidence).toBe(`readonly-contract:${digest([snapshot(f.store.event(f.eventId).payload), f.browser.identity()])}`);

  const pausedTurn = randomUUID();
  const prevThread = (await f.service.dispatch(f.gui, { command: "getThread", eventId: f.eventId })) as {
    followup: { draft: { version: number } | null };
    contextVersion: string;
  };
  let holdInspect!: () => void;
  const enteredInspect = new Promise<void>((resolve) => {
    const origAdapter = f.browser.adapter.bind(f.browser);
    f.browser.adapter = async (ev) => {
      const handle = await origAdapter(ev);
      const origInspect = handle.adapter.inspect.bind(handle.adapter);
      handle.adapter.inspect = async () => {
        resolve();
        await new Promise<void>((r) => {
          holdInspect = r;
        });
        return origInspect();
      };
      return handle;
    };
  });
  await f.service.dispatch(f.gui, {
    command: "sendHumanFollowup",
    commandId: pausedTurn,
    input: {
      eventId: f.eventId,
      generation: detail.ownership.generation,
      expectedVersion: prevThread.followup.draft?.version ?? 0,
      text: "restore me on pause",
      contextVersion: prevThread.contextVersion,
      selectionId,
      suggestionId: null,
    },
  });
  await enteredInspect;
  await f.service.dispatch(f.gui, { command: "pause", eventId: f.eventId });
  expect(await f.service.dispatch(f.gui, { command: "getSendResult", commandId: pausedTurn })).toMatchObject({
    status: "FAILED_BEFORE_CLICK",
    reason: "TARGET_PAUSED",
  });
  holdInspect();
  await f.service.drain();
  const afterPause = (await f.service.dispatch(f.gui, { command: "getThread", eventId: f.eventId })) as {
    followup: { draft: { text: string } | null };
  };
  expect(afterPause.followup.draft?.text).toBe("restore me on pause");
});

test("P0-4: UNCERTAIN human_reply_turns recovers via VerificationScheduler and reconcileUncertain", async () => {
  const store = database(),
    root = privateTemp("p0-4-verify-followup-");
  await migrateClient(store, join(root, "client.sqlite"));
  const eventId = pending(store, candidate());
  let now = Date.now();
  const browser = new MockBrowser(root, () => now);
  const service = new ClientService(store, browser, undefined, () => now);
  cleanups.push(async () => {
    await service.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await service.loadSettings();
  const token = service.authority.issueSession();
  await service.dispatch(token, { command: "setMode", mode: "MANUAL" });
  const selectionId = randomUUID();
  const detail = (await service.dispatch(token, { command: "openHumanDialog", eventId, selectionId })) as {
    ownership: { generation: number };
    contextVersion: string;
  };
  const firstId = randomUUID();
  await service.dispatch(token, {
    command: "sendHumanReply",
    commandId: firstId,
    input: {
      eventId,
      generation: detail.ownership.generation,
      expectedVersion: 0,
      text: "initial reply",
      contextVersion: detail.contextVersion,
      selectionId,
      suggestionId: null,
    },
  });
  await service.drain();

  browser.uncertain = true;
  const uncertainId = randomUUID();
  await service.dispatch(token, {
    command: "sendHumanFollowup",
    commandId: uncertainId,
    input: {
      eventId,
      generation: detail.ownership.generation,
      expectedVersion: 0,
      text: "uncertain followup",
      contextVersion: service.authority.contextVersion(store.event(eventId)),
      selectionId,
      suggestionId: null,
    },
  });
  await service.drain();
  expect(await service.dispatch(token, { command: "getSendResult", commandId: uncertainId })).toMatchObject({ status: "UNCERTAIN" });
  expect(store.sendFrozen(eventId)).toBe(true);

  const auto = new AutomationStore(store, () => now);
  const scheduler = new VerificationScheduler(
    auto,
    async () => ({ verified: false, evidenceId: "unused" }),
    () => {},
    (cmdId, signal) => browser.verifyExistingFollowup(store, cmdId, { signal, background: true }),
  );
  cleanups.push(() => scheduler.close());
  now += 2_000;
  await scheduler.tick();
  expect(await service.dispatch(token, { command: "getSendResult", commandId: uncertainId })).toMatchObject({ status: "UNCERTAIN" });
  browser.uncertain = false;
  now += 10_000;
  await scheduler.tick();
  expect(await service.dispatch(token, { command: "getSendResult", commandId: uncertainId })).toMatchObject({ status: "CONFIRMED" });
  expect(store.sendFrozen(eventId)).toBe(false);

  browser.uncertain = true;
  const secondUncertain = randomUUID();
  const t2 = (await service.dispatch(token, { command: "getThread", eventId })) as {
    followup: { draft: { version: number } | null };
    contextVersion: string;
  };
  await service.dispatch(token, {
    command: "sendHumanFollowup",
    commandId: secondUncertain,
    input: {
      eventId,
      generation: detail.ownership.generation,
      expectedVersion: t2.followup.draft?.version ?? 0,
      text: "reconcile me explicitly",
      contextVersion: t2.contextVersion,
      selectionId,
      suggestionId: null,
    },
  });
  await service.drain();
  expect(await service.dispatch(token, { command: "getSendResult", commandId: secondUncertain })).toMatchObject({ status: "UNCERTAIN" });
  browser.uncertain = false;
  const reconciled = (await service.dispatch(token, {
    command: "reconcileUncertain",
    eventId,
    decision: "READ_ONLY_VERIFY",
  })) as { verified: boolean };
  expect(reconciled.verified).toBe(true);
  expect(await service.dispatch(token, { command: "getSendResult", commandId: secondUncertain })).toMatchObject({ status: "CONFIRMED" });
});
