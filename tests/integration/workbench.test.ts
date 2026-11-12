import { afterEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { AccountActor } from "../../src/browser/account-actor.js";
import { BrowserService } from "../../src/app/browser-service.js";
import { ClientService } from "../../src/app/service.js";
import { migrateClient } from "../../src/storage/client-migration.js";
import { EventStore } from "../../src/storage/store.js";
import {
  digest,
  targetKey,
  type InboundEvent,
  type ReplyAdapter,
} from "../../src/core/contracts.js";
import { DeepSeekProvider } from "../../src/ai/deepseek.js";
import {
  candidate,
  database,
  pending,
  privateTemp,
  snapshot,
} from "../helpers.js";
import type { SendParams } from "../../src/app/contracts.js";
import { ManualCommentRetry } from "../../src/core/manual-comment-retry.js";

class FixtureBrowser extends BrowserService {
  private fixtureActor = new AccountActor();
  clicks = 0;
  proof = true;
  failStart = false;
  beforePrepare: () => Promise<void> = async () => {};
  constructor() {
    super(privateTemp("workbench-browser-"));
  }
  override get actor() {
    return this.fixtureActor;
  }
  override identity() {
    return {
      identityDigest: digest("own-1"),
      mappingDigest: "synthetic-mapping",
      browserVersion: "fixture-1",
      browserMode: "headed" as const,
    };
  }
  override async refreshIdentity() {
    return this.identity();
  }
  override async open() {
    if (this.failStart) throw new Error("fixture cold start failure");
  }
  override async close() {}
  override async verifyEmergencyRecovery(_ownId:string,_signal:AbortSignal,check:()=>void,complete:()=>void=()=>{}){check();complete();}
  override async adapter(e: InboundEvent) {
    await this.open();
    let text = "";
    const adapter: ReplyAdapter = {
      inspect: async () => snapshot(e),
      prepare: async (_e, t) => {
        text = t;
        await this.beforePrepare();
      },
      verifyPrepared: async () => snapshot(e),
      baseline: async () => [],
      clickOnce: async () => {
        this.clicks++;
        await new Promise((r) => setTimeout(r, 5));
      },
      readback: async () =>
        this.proof
          ? {
              id: randomUUID(),
              ownId: "own-1",
              targetKey: targetKey(e),
              text,
              pending: false,
              sentAt: new Date().toISOString(),
            }
          : null,
    };
    return { adapter, dispose: () => {} };
  }
}
const stores: EventStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});
async function setup(provider?: DeepSeekProvider) {
  const store = database();
  stores.push(store);
  await migrateClient(store, join(privateTemp("migration-"), "backup.sqlite"));
  let clock = Date.now();
  const browser = new FixtureBrowser(),
    service = new ClientService(store, browser, provider, () => clock);
  const token = service.authority.issueSession();
  const eventId = pending(store),
    claim = service.authority.claim(token, eventId, 0);
  for (const channel of ["DIRECT_MESSAGE", "COMMENT_NOTIFICATION"] as const)
    service.authority.attest(
      channel,
      "SEND_AVAILABLE",
      browser.identity(),
      "synthetic-evidence",
    );
  service.authority.setMode(token, "MANUAL");
  return {
    store,
    browser,
    service,
    token,
    eventId,
    generation: claim.generation,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
function saveAndSelect(
  ctx: Awaited<ReturnType<typeof setup>>,
  eventId = ctx.eventId,
  generation = ctx.generation,
): SendParams {
  const d = ctx.service.authority.save(
    ctx.token,
    eventId,
    generation,
    0,
    "人工回复，已核对。",
  );
  const selectionId = randomUUID();
  ctx.service.authority.select(ctx.token, eventId, selectionId);
  return {
    eventId,
    generation,
    draftId: d.id,
    draftVersion: d.version,
    text: d.text,
    contextVersion: ctx.service.authority.contextVersion(
      ctx.store.event(eventId),
    ),
    selectionId,
  };
}
async function preview(ctx: Awaited<ReturnType<typeof setup>>, p: SendParams) {
  return (await ctx.service.dispatch(ctx.token, {
    command: "previewSend",
    params: p,
  })) as { commandId: string };
}

describe("workbench authority and application contracts, synthetic only", () => {
  test("a late confirmed trial never re-enables a channel blocked after intent", async () => {
    const c = await setup(),
      p = saveAndSelect(c);
    c.service.authority.calibrateTrial(
      p.draftId,
      snapshot(c.store.event(c.eventId).payload),
      c.browser.identity(),
      "synthetic-calibration",
    );
    const review = await preview(c, p);
    c.browser.beforePrepare = async () => {};
    const original = c.browser.adapter.bind(c.browser);
    c.browser.adapter = async (e) => {
      const handle = await original(e),
        read = handle.adapter.readback;
      handle.adapter.readback = async (...args) => {
        const proof = await read(...args);
        c.service.authority.attest(
          "DIRECT_MESSAGE",
          "BLOCKED",
          c.browser.identity(),
          "later-safety-block",
        );
        return proof;
      };
      return handle;
    };
    await c.service.dispatch(c.token, {
      command: "submitManualSend",
      commandId: review.commandId,
      params: p,
      confirmed: true,
    });
    await c.service.drain();
    expect(c.service.authority.command(review.commandId).status).toBe(
      "CONFIRMED",
    );
    expect(
      c.service.authority.capability("DIRECT_MESSAGE", c.browser.identity())
        .state,
    ).toBe("BLOCKED");
  });
  test.each(['READ_OK','BLOCKED'] as const)('capability %s explains its own denial without opening sends',async state=>{
    const c=await setup(),p=saveAndSelect(c);
    c.service.authority.attest('DIRECT_MESSAGE',state,c.browser.identity(),'synthetic-denial-evidence');
    await expect(preview(c,p)).rejects.toThrow(state==='READ_OK'?'CAPABILITY_READ_ONLY':'CAPABILITY_BLOCKED');
    expect(c.store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
    expect(c.service.authority.capability('DIRECT_MESSAGE',c.browser.identity()).state).toBe(state);
  });
  test("explicit backend calibration is limited to one exact draft, gives no approval, and promotes only its verified channel", async () => {
    const c = await setup(),
      p = saveAndSelect(c);
    for (const channel of ["DIRECT_MESSAGE", "COMMENT_NOTIFICATION"] as const)
      c.service.authority.attest(
        channel,
        "SEND_REVIEW_ONLY",
        c.browser.identity(),
        "synthetic-unverified",
      );
    await expect(preview(c, p)).rejects.toThrow("CAPABILITY_SEND_UNVERIFIED");
    c.service.authority.calibrateTrial(
      p.draftId,
      snapshot(c.store.event(c.eventId).payload),
      c.browser.identity(),
      "synthetic-read-calibration",
    );
    expect(c.store.draft(p.draftId).status).toBe("DRAFT");
    expect(c.browser.clicks).toBe(0);
    expect(
      c.service.authority.trialAvailable(
        c.eventId,
        p.draftId,
        p.draftVersion,
        p.text + "changed",
        c.browser.identity(),
      ),
    ).toBe(false);
    await expect(
      c.service.dispatch(c.token, {
        command: "calibrateTrial",
        draftId: p.draftId,
      }),
    ).rejects.toThrow();
    const review = await preview(c, p);
    await c.service.dispatch(c.token, {
      command: "submitManualSend",
      commandId: review.commandId,
      params: p,
      confirmed: true,
    });
    await c.service.drain();
    expect(c.browser.clicks).toBe(1);
    expect(
      c.service.authority.capability("DIRECT_MESSAGE", c.browser.identity())
        .state,
    ).toBe("SEND_AVAILABLE");
    expect(
      c.service.authority.capability(
        "COMMENT_NOTIFICATION",
        c.browser.identity(),
      ).state,
    ).toBe("SEND_REVIEW_ONLY");
    expect(
      c.store.db
        .prepare("SELECT used FROM controlled_trials WHERE event_id=?")
        .get(c.eventId),
    ).toEqual({ used: 1 });
  });
  test("CLI control pause invalidates ownership and old previews even after resume", async () => {
    const c = await setup(),
      p = saveAndSelect(c),
      review = await preview(c, p);
    c.store.pause(targetKey(c.store.event(c.eventId).payload), true);
    c.store.pause(targetKey(c.store.event(c.eventId).payload), false);
    const result = (await c.service.dispatch(c.token, {
      command: "submitManualSend",
      commandId: review.commandId,
      params: p,
      confirmed: true,
    })) as { status: string };
    await c.service.drain();
    expect(result.status).toBe("FAILED_BEFORE_CLICK");
    expect(c.browser.clicks).toBe(0);
    expect(
      c.service.authority.ownership(c.store.event(c.eventId)).generation,
    ).toBeGreaterThan(c.generation);
  });
  test("a new preview permanently replaces an older preview of the same event", async () => {
    const c = await setup(),
      p = saveAndSelect(c),
      old = await preview(c, p),
      current = await preview(c, p);
    expect(
      await c.service.dispatch(c.token, {
        command: "submitManualSend",
        commandId: old.commandId,
        params: p,
        confirmed: true,
      }),
    ).toMatchObject({ status: "FAILED_BEFORE_CLICK" });
    await c.service.dispatch(c.token, {
      command: "submitManualSend",
      commandId: current.commandId,
      params: p,
      confirmed: true,
    });
    await c.service.drain();
    expect(c.browser.clicks).toBe(1);
  });
  test("schema3 rejects both new and pre-migration retry grants while preserving the original unknown", async () => {
    const store = database();
    stores.push(store);
    const e = candidate({
      channel: "COMMENT_NOTIFICATION",
      kind: "COMMENT",
      videoId: "retry-work",
      commentId: "retry-parent",
      conversationId: null,
    });
    const eventId = pending(store, e),
      draft = store.saveDraft(eventId, "legacy approved fixture", "mock");
    store.approve(draft.id, snapshot(e), draft.version, draft.text);
    const intent = store.recordIntent(draft.id, snapshot(e), false);
    store.receipt(intent, "UNCERTAIN", "fixture");
    const grant = store.authorizeCommentRetry(
      draft.id,
      snapshot(e),
      "synthetic-specific-approval",
    );
    await migrateClient(
      store,
      join(privateTemp("retry-migration-"), "backup.sqlite"),
    );
    expect(() =>
      store.authorizeCommentRetry(draft.id, snapshot(e), "another"),
    ).toThrow("CLIENT_UNKNOWN_READ_ONLY");
    expect(() =>
      store.recordCommentRetryIntent(grant, snapshot(e), true),
    ).toThrow("CLIENT_UNKNOWN_READ_ONLY");
    const browser = new FixtureBrowser(),
      handle = await browser.adapter(e);
    await expect(
      new ManualCommentRetry(store, browser.actor).send(
        grant,
        handle.adapter,
        true,
      ),
    ).rejects.toThrow("CLIENT_UNKNOWN_READ_ONLY");
    expect(browser.clicks).toBe(0);
    expect(store.uncertain()).toHaveLength(1);
  });
  test("G06 migration restores version 2 snapshot and preserves budget, baseline, unknown and pauses", async () => {
    const store = database();
    stores.push(store);
    const eventId = pending(store);
    const d = store.saveDraft(eventId, "old approved text", "mock");
    store.approve(
      d.id,
      snapshot(store.event(eventId).payload),
      d.version,
      d.text,
    );
    const intent = store.recordIntent(
      d.id,
      snapshot(store.event(eventId).payload),
      true,
    );
    store.receipt(intent, "UNCERTAIN", "fixture");
    store.pause(targetKey(store.event(eventId).payload), true);
    store.consumeBudget("MODEL");
    const before = store.stats();
    const backup = join(privateTemp("client-upgrade-"), "backup.sqlite");
    expect(await migrateClient(store, backup)).toBe(true);
    expect(store.stats()).toEqual(before);
    const old = new EventStore(backup);
    expect(old.stats()).toEqual(before);
    old.close();
    expect(await migrateClient(store, backup)).toBe(false);
    expect(store.db.pragma("user_version", { simple: true })).toBe(3);
  });
  test("G03 manual starts blank, saves, clears and rejects stale edits without any model", async () => {
    const c = await setup();
    const d = c.service.authority.save(c.token, c.eventId, c.generation, 0, "");
    expect(d.text).toBe("");
    c.service.authority.save(
      c.token,
      c.eventId,
      c.generation,
      d.version,
      "hello\r\nworld",
    );
    expect(() =>
      c.service.authority.save(
        c.token,
        c.eventId,
        c.generation,
        d.version,
        "late",
      ),
    ).toThrow("DRAFT_VERSION_CONFLICT");
    expect(c.store.stats().budgets).toContainEqual({
      kind: "MODEL",
      used: 0,
      maximum: 50,
    });
  });
  test("T25/T33 expired sessions, missing permissions, competing and expired leases", async () => {
    const c = await setup(),
      other = c.service.authority.issueSession(),
      readOnly = c.service.authority.issueSession(["READ"]);
    expect(() =>
      c.service.authority.claim(other, c.eventId, c.generation),
    ).toThrow("OTHER_OPERATOR_OWNS");
    expect(() =>
      c.service.authority.save(
        readOnly,
        c.eventId,
        c.generation,
        0,
        "forbidden",
      ),
    ).toThrow("OPERATOR_PERMISSION_DENIED");
    expect(
      c.store.db
        .prepare(
          "SELECT count(*) AS n FROM audit_events WHERE event_type='OPERATOR_PERMISSION_DENIED'",
        )
        .get(),
    ).toEqual({ n: 1 });
    c.advance(120_001);
    expect(() =>
      c.service.authority.renew(c.token, c.eventId, c.generation),
    ).toThrow("LEASE_EXPIRED_OR_CHANGED");
    const next = c.service.authority.claim(other, c.eventId, c.generation);
    expect(next.generation).toBe(c.generation + 1);
    c.service.authority.revoke(other);
    expect(() => c.service.authority.operator(other)).toThrow(
      "OPERATOR_EXPIRED",
    );
  });
  test("T28/G08 duplicate command and differing arguments persist across restart without second click", async () => {
    const c = await setup(),
      p = saveAndSelect(c),
      review = await preview(c, p);
    const command = {
      command: "submitManualSend",
      commandId: review.commandId,
      params: p,
      confirmed: true,
    };
    await Promise.all([
      c.service.dispatch(c.token, command),
      c.service.dispatch(c.token, command),
    ]);
    await c.service.drain();
    expect(c.browser.clicks).toBe(1);
    expect(c.service.authority.command(review.commandId).status).toBe(
      "CONFIRMED",
    );
    await expect(
      c.service.dispatch(c.token, {
        ...command,
        params: { ...p, text: "different" },
      }),
    ).rejects.toThrow("COMMAND_PARAMETERS_CONFLICT");
    c.service.authority.recover();
    await expect(c.service.dispatch(c.token, command)).rejects.toThrow(
      "OPERATOR_EXPIRED",
    );
    expect(
      await c.service.dispatch(c.service.authority.issueSession(), {
        command: "getSendResult",
        commandId: review.commandId,
      }),
    ).toMatchObject({ status: "CONFIRMED" });
    expect(c.browser.clicks).toBe(1);
    expect(
      c.store.db.prepare("SELECT count(*) AS n FROM send_intents").get(),
    ).toEqual({ n: 1 });
  });
  test("T37 switching channels invalidates pending confirmation", async () => {
    const c = await setup(),
      p = saveAndSelect(c),
      review = await preview(c, p);
    c.service.authority.select(c.token, null, randomUUID());
    expect(
      await c.service.dispatch(c.token, {
        command: "submitManualSend",
        commandId: review.commandId,
        params: p,
        confirmed: true,
      }),
    ).toMatchObject({
      status: "FAILED_BEFORE_CLICK",
      reason: "TARGET_SELECTION_CHANGED",
    });
    c.service.authority.select(c.token, c.eventId, p.selectionId);
    expect(
      await c.service.dispatch(c.token, {
        command: "submitManualSend",
        commandId: review.commandId,
        params: p,
        confirmed: true,
      }),
    ).toMatchObject({ status: "FAILED_BEFORE_CLICK" });
    expect(c.browser.clicks).toBe(0);
  });
  test("T26/T32 versions, context and ownership are rechecked after browser preparation", async () => {
    const c = await setup(),
      p = saveAndSelect(c),
      review = await preview(c, p);
    c.browser.beforePrepare = async () => {
      c.service.authority.save(
        c.token,
        c.eventId,
        c.generation,
        p.draftVersion,
        "new human version",
      );
    };
    await c.service.dispatch(c.token, {
      command: "submitManualSend",
      commandId: review.commandId,
      params: p,
      confirmed: true,
    });
    await c.service.drain();
    expect(c.browser.clicks).toBe(0);
    expect(c.service.authority.command(review.commandId).status).toBe(
      "FAILED_BEFORE_CLICK",
    );
    expect(c.service.authority.draftFor(c.eventId)?.text).toBe(
      "new human version",
    );
  });
  test("T34 emergency stop is reachable during stalled browser task and preserves previous target pauses", async () => {
    const c = await setup(),
      p = saveAndSelect(c),
      review = await preview(c, p);
    let proceed!: () => void, prepared!: () => void;
    const entered = new Promise<void>((r) => (prepared = r));
    c.browser.beforePrepare = async () => {
      prepared();
      await new Promise<void>((r) => (proceed = r));
    };
    await c.service.dispatch(c.token, {
      command: "submitManualSend",
      commandId: review.commandId,
      params: p,
      confirmed: true,
    });
    await entered;
    const old = candidate({
        platformEventId: "paused-old",
        conversationId: "old-paused-conversation",
      }),
      oldId = pending(c.store, old);
    c.store.pause(targetKey(old), true);
    await c.service.dispatch(c.token, { command: "emergencyStop" });
    proceed();
    await c.service.drain();
    expect(c.browser.clicks).toBe(0);
    await c.service.dispatch(c.token, { command: "resume", eventId: null });
    expect(
      c.store.db
        .prepare("SELECT paused FROM pauses WHERE target_key=?")
        .get(targetKey(c.store.event(oldId).payload)),
    ).toEqual({ paused: 1 });
  });
  test("T35 unknown freezes target; reconnect recovers no queued dispatch and does not erase receipt", async () => {
    const c = await setup(),
      p = saveAndSelect(c),
      review = await preview(c, p);
    c.browser.proof = false;
    await c.service.dispatch(c.token, {
      command: "submitManualSend",
      commandId: review.commandId,
      params: p,
      confirmed: true,
    });
    await c.service.drain();
    expect(c.service.authority.command(review.commandId).status).toBe(
      "UNCERTAIN",
    );
    c.service.authority.recover();
    expect(c.store.uncertain()).toHaveLength(1);
    expect(c.browser.clicks).toBe(1);
    await expect(
      c.service.dispatch(c.token, {
        command: "reconcileUncertain",
        eventId: c.eventId,
        decision: "MARK_NOT_SENT",
      }),
    ).rejects.toThrow();
  });
  test("G10 capability expiry, mapping change and modes cannot be overridden by frontend fields", async () => {
    const c = await setup(),
      p = saveAndSelect(c);
    c.service.authority.setMode(c.token, "DRAFT_ONLY");
    await expect(preview(c, p)).rejects.toThrow("MODE_DRAFT_ONLY");
    c.service.authority.setMode(c.token, "MANUAL");
    expect(
      c.service.authority.capability("DIRECT_MESSAGE", {
        ...c.browser.identity(),
        mappingDigest: "changed",
      }).state,
    ).toBe("SEND_REVIEW_ONLY");
    c.advance(24 * 3600_000 + 1);
    const token = c.service.authority.issueSession();
    expect(
      c.service.authority.capability("DIRECT_MESSAGE", c.browser.identity())
        .reason,
    ).toBe("CAPABILITY_EXPIRED_OR_CHANGED");
    await expect(
      c.service.dispatch(token, { command: "setMode", mode: "LIMITED_AUTO" }),
    ).rejects.toThrow();
    await expect(
      c.service.dispatch(token, { command: "getStatus", operatorId: "forged" }),
    ).rejects.toThrow();
  });
  test("configured manual mode remains distinct from the effective draft-only mode while browser identity is absent",async()=>{
    const c=await setup();
    const cold=new ClientService(c.store,new BrowserService(c.browser.root));
    const token=cold.authority.issueSession();
    await cold.dispatch(token,{command:'setMode',mode:'MANUAL'});
    expect(await cold.dispatch(token,{command:'getStatus'})).toMatchObject({
      configuredMode:'MANUAL',mode:'DRAFT_ONLY',browser:{state:'CLOSED'},
    });
    expect(cold.authority.mode()).toBe('MANUAL');
    expect(c.store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
  });
  test("T31 cold browser failure and confirmation timeout retain human draft and never create intent", async () => {
    const c = await setup(),
      p = saveAndSelect(c),
      review = await preview(c, p);
    c.advance(60_001);
    await expect(
      c.service.dispatch(c.token, {
        command: "submitManualSend",
        commandId: review.commandId,
        params: p,
        confirmed: true,
      }),
    ).rejects.toThrow("CONFIRMATION_EXPIRED");
    c.browser.failStart = true;
    await expect(preview(c, p)).rejects.toThrow();
    expect(c.service.authority.draftFor(c.eventId)?.text).toBe(p.text);
    expect(
      c.store.db.prepare("SELECT count(*) AS n FROM send_intents").get(),
    ).toEqual({ n: 0 });
  });
  test("T38/G09 20 synthetic manual tasks across both channels, no Key, zero requests and tokens", async () => {
    const c = await setup();
    for (let i = 0; i < 20; i++) {
      const e = candidate({
        ...(i % 2
          ? {
              platformEventId: `synthetic-comment-${i}`,
              channel: "COMMENT_NOTIFICATION",
              kind: "COMMENT",
              videoId: `work-${i}`,
              commentId: `parent-${i}`,
              conversationId: null,
            }
          : {
              platformEventId: `synthetic-message-${i}`,
              conversationId: `conversation-${i}`,
            }),
        occurredAt: new Date(
          Date.parse("2026-11-04T01:00:01Z") + i * 1000,
        ).toISOString(),
      });
      const eventId = pending(c.store, e),
        generation = c.service.authority.claim(c.token, eventId, 0).generation,
        p = saveAndSelect(c, eventId, generation),
        review = await preview(c, p);
      await c.service.dispatch(c.token, {
        command: "submitManualSend",
        commandId: review.commandId,
        params: p,
        confirmed: true,
      });
      await c.service.drain();
      expect(c.service.authority.command(review.commandId).status).toBe(
        "CONFIRMED",
      );
    }
    expect(c.browser.clicks).toBe(20);
    expect(
      c.store.db.prepare("SELECT count(*) AS n FROM delivery_receipts").get(),
    ).toEqual({ n: 20 });
    const status = (await c.service.dispatch(c.token, {
      command: "getStatus",
    })) as { usage: unknown };
    expect(status.usage).toMatchObject({
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(c.store.stats().budgets).toContainEqual({
      kind: "MODEL",
      used: 0,
      maximum: 50,
    });
  });
  test("G02 AI is explicit, Key never persisted, late output stays candidate and never overwrites new human version", async () => {
    let resolve!: (r: Response) => void;
    let calls = 0;
    const provider = new DeepSeekProvider(async () => {
      calls++;
      return new Promise<Response>((r) => (resolve = r));
    });
    const c = await setup(provider);
    const p = saveAndSelect(c);
    await expect(
      c.service.dispatch(c.token, {
        command: "generateSuggestion",
        eventId: c.eventId,
        draftVersion: p.draftVersion,
      }),
    ).rejects.toThrow("REAL_MODEL_AUTHORIZATION_REQUIRED");
    const key = "synthetic-contract-key-only";
    const settings = {
      model: "deepseek-flash",
      persona: "本地客服",
      business: "说明",
      rules: "简短",
    };
    await c.service.dispatch(c.token, {
      command: "configureAi",
      settings,
      key,
    });
    expect(
      await readFile(join(c.browser.root, "client-settings.json"), "utf8"),
    ).not.toContain(key);
    await c.service.dispatch(c.token, {
      command: "authorizeAi",
      authorized: true,
    });
    const suggestion = c.service.dispatch(c.token, {
      command: "generateSuggestion",
      eventId: c.eventId,
      draftVersion: p.draftVersion,
    });
    await Promise.resolve();
    c.service.authority.save(
      c.token,
      c.eventId,
      c.generation,
      p.draftVersion,
      "new human text",
    );
    resolve(
      new Response(
        JSON.stringify({
          model: "deepseek-flash",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "模型建议" },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
        }),
      ),
    );
    expect(await suggestion).toMatchObject({ stale: true });
    expect(c.service.authority.draftFor(c.eventId)?.text).toBe(
      "new human text",
    );
    expect(calls).toBe(1);
    expect(c.browser.clicks).toBe(0);
  });
});
