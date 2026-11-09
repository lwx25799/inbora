import { afterEach, expect, test } from "vitest";
import { join } from "node:path";
import { CollectionScheduler, DeferredObjectRead, type CollectionSource } from "../../src/app/collection-scheduler.js";
import { AutomationStore } from "../../src/storage/automation-store.js";
import { migrateAutomation } from "../../src/storage/automation-migration.js";
import { migrateClient } from "../../src/storage/client-migration.js";
import { Blocked } from "../../src/core/contracts.js";
import { database, privateTemp } from "../helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function setup(collect: (source: CollectionSource, signal: AbortSignal) => Promise<void>) {
  const store = database(), root = privateTemp("collector-");
  await migrateClient(store, join(root, "schema3.sqlite"));
  await migrateAutomation(store, join(root, "automation.sqlite"));
  let now = Date.now();
  const data = new AutomationStore(store, () => now);
  data.initialize(now); store.bindAccount("own-1");
  data.configureCollection({ownId: "own-1", comments: true, inbox: true, commentIntervalMs: 30_000, dmIntervalMs: 15_000});
  const scheduler = new CollectionScheduler(data, collect);
  cleanup.push(async () => { await scheduler.close(); store.close(); });
  return {store, data, scheduler, advance: (ms: number) => { now += ms; }};
}
test("collector runs both channels without AI/Key or manual sync, respects independent cadence and send pause", async () => {
  const calls: CollectionSource[] = [], f = await setup(async source => {calls.push(source);});
  f.store.db.prepare("UPDATE client_state SET paused=1,mode='DRAFT_ONLY'").run();
  await f.scheduler.tick(); await f.scheduler.tick(); await f.scheduler.tick();
  expect(calls).toEqual(["works", "dm"]);
  f.advance(15_000); await f.scheduler.tick(); expect(calls).toEqual(["works", "dm", "dm"]);
  f.advance(15_000); await f.scheduler.tick(); await f.scheduler.tick();
  expect(calls).toEqual(["works", "dm", "dm", "works", "dm"]);
  expect(f.store.db.prepare("SELECT count(*) AS n FROM model_calls").get()).toEqual({n: 0});
  expect(f.scheduler.status().channels).toEqual(expect.arrayContaining([expect.objectContaining({source: "works", last_error: null, elapsed_ms: 0})]));
});
test("pending collection coalesces timer ticks and never overlaps the two page turns", async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => {release = r;});
  const calls: CollectionSource[] = [], f = await setup(async source => {calls.push(source); await gate;});
  const first = f.scheduler.tick();
  try {
    await expect.poll(() => calls.length).toBe(1);
    await f.scheduler.tick(); expect(calls).toEqual(["works"]);
  } finally { release(); await first; }
  await f.scheduler.tick(); expect(calls).toEqual(["works", "dm"]);
});
test("ordinary source failure backs off only that channel; global stop survives a new scheduler", async () => {
  const calls: CollectionSource[] = [], f = await setup(async source => {calls.push(source); if (source === "works") throw new Blocked("OBSERVATION_DOM_NOT_READY");});
  await f.scheduler.tick(); await f.scheduler.tick();
  expect(calls).toEqual(["works", "dm"]); expect(f.data.state().emergencyStopped).toBe(false);
  const progress = f.scheduler.status().channels as {source: string; failures: number; last_error: string | null}[];
  expect(progress.find(p => p.source === "works")).toMatchObject({failures: 1, last_error: "OBSERVATION_DOM_NOT_READY"});
  f.data.stop(true); f.advance(60_000); await f.scheduler.tick(); expect(calls).toHaveLength(2);
  const restarted = new CollectionScheduler(f.data, async source => {calls.push(source);});
  try { await restarted.tick(); expect(calls).toHaveLength(2); } finally { await restarted.close(); }
  f.data.stop(false); await f.scheduler.tick(); expect(calls).toHaveLength(3);
});

test('ordinary browser closure retains collection error and retries instead of globally stopping',async()=>{
  let calls=0;const f=await setup(async()=>{if(++calls===1)throw new Blocked('BROWSER_CLOSED');});
  await f.scheduler.tick();
  expect(f.data.state().emergencyStopped).toBe(false);
  expect(f.scheduler.status().channels).toEqual(expect.arrayContaining([expect.objectContaining({source:'works',last_error:'BROWSER_CLOSED',last_success:null})]));
  f.advance(60_000);await f.scheduler.tick();expect(calls).toBe(2);
});

test.each([false,true])('only a persisted per-object deferral avoids whole-channel backoff (deferred: %s)',async deferred=>{
  const f=await setup(async()=>{throw deferred?new DeferredObjectRead('OBSERVATION_DOM_NOT_READY'):new Blocked('OBSERVATION_DOM_NOT_READY');});
  const before=f.data.now();await f.scheduler.tick();
  expect(f.store.db.prepare("SELECT next_at,last_success,last_error,failures FROM collection_progress WHERE source='works'").get())
    .toEqual({next_at:before+(deferred?30_000:60_000),last_success:null,last_error:'OBSERVATION_DOM_NOT_READY',failures:1});
  expect(f.data.state().emergencyStopped).toBe(false);
});
test("identity/platform validation blocks subsequent collection and records a safe enumerated cause", async () => {
  const calls: CollectionSource[] = [], f = await setup(async source => {calls.push(source); throw new Blocked("OBSERVATION_ACCOUNT_CHANGED");});
  await f.scheduler.tick(); await f.scheduler.tick(); expect(calls).toEqual(["works"]);
  expect(f.data.state().emergencyStopped).toBe(true);
  expect(f.scheduler.status().channels).toEqual(expect.arrayContaining([expect.objectContaining({last_error: "OBSERVATION_ACCOUNT_CHANGED"})]));
});
test("cancel/close does not free a still running operation and disable collection does not touch sending", async () => {
  const f = await setup(async (_source, signal) => new Promise<void>(resolve => {signal.addEventListener("abort", () => resolve(), {once: true});}));
  const task = f.scheduler.tick(); await expect.poll(() => f.scheduler.status().running).toBe(true);
  await f.scheduler.close(); await task;
  expect(f.scheduler.status().running).toBe(false);
  f.data.configureCollection({...f.data.state().collection!, comments: false, inbox: false});
  expect(f.store.db.prepare("SELECT paused FROM client_state").get()).toEqual({paused: 0});
});
test("emergency stop or collection disable before the queued turn prevents the reader from starting", async () => {
  const calls: CollectionSource[] = [], f = await setup(async source => {calls.push(source);});
  const task = f.scheduler.tick(); f.data.stop(true); f.scheduler.cancel(); await task;
  expect(calls).toEqual([]);
  f.data.stop(false); f.advance(120_000);
  const disabled = f.scheduler.tick();
  f.data.configureCollection({...f.data.state().collection!, comments: false, inbox: false});
  await disabled; expect(calls).toEqual([]);
});
