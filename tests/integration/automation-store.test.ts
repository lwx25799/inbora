import { afterEach, expect, test } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { migrateClient } from "../../src/storage/client-migration.js";
import { migrateAutomation } from "../../src/storage/automation-migration.js";
import { AutomationStore } from "../../src/storage/automation-store.js";
import { EventStore } from "../../src/storage/store.js";
import { candidate, database, privateTemp } from "../helpers.js";
import type { ReplyPolicy } from "../../src/app/automation-contracts.js";
import { WorkbenchAuthority } from "../../src/app/authority.js";

const stores: EventStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); });
const start = Date.parse("2026-11-07T01:00:00Z");
async function setup() {
  const store = database(); stores.push(store);
  const root = privateTemp("automation-migration-");
  await migrateClient(store, join(root, "client.sqlite"));
  store.bindAccount("own-1");
  const backup = join(root, "automation.sqlite");
  await migrateAutomation(store, backup);
  const auto = new AutomationStore(store, () => start + 60_000);
  auto.initialize(start);
  return {store, auto, backup};
}
const policy: ReplyPolicy = {
  ownId: "own-1", channels: ["COMMENT_NOTIFICATION", "DIRECT_MESSAGE"], model: "deepseek-flash",
  modelLimit: 2, sendLimit: 2, expiresAt: null, workIds: [], futureOwnWorks: true,
  conversationIds: [], entireInbox: true, containsAny: ["hello"], excludesAny: ["refund"],
  instructions: "Answer the specified greeting briefly.", startHour: 0, endHour: 24,
};

test('a new policy cannot silently enable empty targets or revoke the existing valid scope',async()=>{
  const {store,auto}=await setup(),valid=auto.grant('AUTO_REPLY',policy);
  for(const scope of [{...policy,futureOwnWorks:false},{...policy,entireInbox:false}])
    expect(()=>auto.grant('AUTO_REPLY',scope)).toThrow('POLICY_TARGETS_REQUIRED');
  expect(auto.active('AUTO_REPLY')?.version).toBe(valid.version);
  expect(store.db.prepare('SELECT count(*) n FROM grant_reservations').get()).toEqual({n:0});
});

test('saving an all-inbound policy removes trigger filtering and carries consumed allowance into the revised scope',async()=>{
  const {store,auto}=await setup();store.db.prepare("UPDATE client_state SET mode='LIMITED_AUTO'").run();
  const first=auto.grant('AUTO_REPLY',policy);auto.reserve(first.version,'MODEL','used-model');auto.reserve(first.version,'SEND','used-send');
  store.consumeBudget('MODEL');store.consumeBudget('SEND');
  const revised=auto.grant('AUTO_REPLY',{...policy,instructions:'Reply naturally to the specific incoming text.'});
  expect(revised.scope.containsAny).toEqual([]);
  expect(store.db.prepare('SELECT kind,count(*) n FROM grant_reservations WHERE grant_version=? GROUP BY kind').all(revised.version))
    .toEqual([{kind:'MODEL',n:1},{kind:'SEND',n:1}]);
  const e=candidate({text:'A normal question with no special trigger',occurredAt:new Date(start+10_000).toISOString()});
  const [id]=store.observe(e.channel,e.conversationId!,[e],'own-1','synthetic',new Date(start+60_000).toISOString(),start);
  expect(auto.policyMatches(revised,store.event(id!))).toBe(true);
  expect(auto.policyMatches(revised,{...store.event(id!),payload:{...e,text:'Please refund'}})).toBe(false);
});

test("additive migration preserves the actual SQLite backup, budgets, old intents and restore inventory", async () => {
  const {store, backup} = await setup();
  const restored = new Database(backup, {readonly: true});
  try {
    expect(restored.pragma("quick_check", {simple: true})).toBe("ok");
    for (const table of ["budgets", "inbound_events", "send_intents", "delivery_receipts", "cursors", "client_state"])
      expect(store.db.prepare(`SELECT * FROM ${table}`).all()).toEqual(restored.prepare(`SELECT * FROM ${table}`).all());
    expect(restored.prepare("SELECT name FROM sqlite_master WHERE name='automation_state'").get()).toBeUndefined();
  } finally { restored.close(); }
  expect(await migrateAutomation(store, backup)).toBe(false);
});

test("first run boundary survives later enable, account verification, pause and process restart", async () => {
  const {store, auto} = await setup();
  auto.configureCollection({ownId: "own-1", comments: true, inbox: true, commentIntervalMs: 30_000, dmIntervalMs: 15_000});
  auto.stop(true);
  const recovered = new AutomationStore(store, () => start + 90_000);
  recovered.initialize(start + 80_000);
  expect(recovered.state()).toMatchObject({startedAt: start, emergencyStopped: true, collection: {comments: true, inbox: true}});
  expect(() => recovered.configureCollection({...recovered.state().collection!, ownId: "another"})).toThrow("ACCOUNT_NOT_VERIFIED");
});

test("new work discovery is idempotent, excludes old history and retains ambiguous publication time", async () => {
  const {store, auto} = await setup();
  const work = {id: "new-work", ownId: "own-1", url: "http://127.0.0.1/video/new-work", publishedAt: start + 2000, precisionMs: 1000};
  expect(auto.registerWork(work)).toBe("INCLUDED");
  expect(auto.registerWork(work)).toBe("INCLUDED");
  expect(auto.registerWork({...work, id: "old-work", url: "http://127.0.0.1/video/old-work", publishedAt: start - 2000})).toBe("HISTORICAL");
  expect(auto.registerWork({...work, id: "same-second", url: "http://127.0.0.1/video/same-second", publishedAt: start - 500})).toBe("REVIEW");
  expect(auto.registerWork({...work, id: "no-time", url: "http://127.0.0.1/video/no-time", publishedAt: null})).toBe("REVIEW");
  expect(auto.registerWork({...work, id: "no-time", url: "http://127.0.0.1/video/no-time"})).toBe("INCLUDED");
  expect(() => auto.registerWork({...work, publishedAt: start + 3000})).toThrow("WORK_IDENTITY_CONFLICT");
  expect(store.db.prepare("SELECT count(*) AS n FROM discovered_works").get()).toEqual({n: 4});
});

test("new scopes backfill from first run, persist high water and do not replay old or duplicate inputs", async () => {
  const {store} = await setup();
  const event = candidate({occurredAt: new Date(start + 10_000).toISOString(), conversationId: "new-native-conversation"});
  const observed = new Date(start + 60_000).toISOString();
  const old = {...event, platformEventId: "old", occurredAt: new Date(start - 1000).toISOString()};
  const ids = store.observe("DIRECT_MESSAGE", "new-native-conversation", [old, event], "own-1", "fixture", observed, start);
  expect(ids).toHaveLength(1);
  expect(store.event(ids[0]!).status).toBe("AWAITING_DRAFT");
  expect(store.observe("DIRECT_MESSAGE", "new-native-conversation", [event, old], "own-1", "fixture", observed, start + 5000)).toEqual([]);
  const cursor = store.db.prepare("SELECT cursor_data FROM cursors WHERE scope='new-native-conversation'").get() as {cursor_data: string};
  expect(JSON.parse(cursor.cursor_data)).toMatchObject({baselineTime: start});
  const later = {...event, platformEventId: "after-downtime", occurredAt: new Date(start + 70_000).toISOString()};
  expect(store.observe("DIRECT_MESSAGE", "new-native-conversation", [later], "own-1", "fixture", new Date(start + 90_000).toISOString(), start)).toHaveLength(1);
});

test("persistent grant versions survive restart; revoke/expiry and atomic quota checks cannot be bypassed", async () => {
  const {store, auto} = await setup();
  const grant = auto.grant("AUTO_REPLY", policy);
  const restarted = new AutomationStore(store, () => start + 60_000);
  expect(restarted.active("AUTO_REPLY")).toEqual(grant);
  store.db.transaction(() => { restarted.reserve(grant.version, "MODEL", "one"); store.consumeBudget("MODEL"); }).immediate();
  expect(() => restarted.reserve(grant.version, "MODEL", "one")).toThrow("GRANT_JOB_ALREADY_RESERVED");
  store.db.transaction(() => { restarted.reserve(grant.version, "MODEL", "two"); store.consumeBudget("MODEL"); }).immediate();
  expect(() => restarted.reserve(grant.version, "MODEL", "three")).toThrow("MODEL_GRANT_EXHAUSTED");
  expect(store.db.prepare("SELECT used FROM budgets WHERE kind='MODEL'").get()).toEqual({used: 2});
  restarted.revoke("AUTO_REPLY");
  expect(() => restarted.reserve(grant.version, "SEND", "one")).toThrow("GRANT_REVOKED");
  expect(() => restarted.grant("AUTO_REPLY", {...policy, ownId: "wrong"})).toThrow("ACCOUNT_NOT_VERIFIED");
  const expiring = restarted.grant("AUTO_REPLY", {...policy, expiresAt: start + 61_000});
  expect(new AutomationStore(store, () => start + 62_000).active("AUTO_REPLY")).toBeNull();
  expect(expiring.version).toBeGreaterThan(grant.version);
});

test("policy deterministically checks target, rules, future-work opt-in and human priority", async () => {
  const {store, auto} = await setup();
  store.db.prepare("UPDATE client_state SET mode='LIMITED_AUTO'").run();
  const e = candidate({occurredAt: new Date(start + 10_000).toISOString()});
  const [id] = store.observe("DIRECT_MESSAGE", e.conversationId!, [e], "own-1", "fixture", new Date(start + 60_000).toISOString(), start);
  const grant = auto.grant("AUTO_REPLY", policy);
  expect(auto.policyMatches(grant, store.event(id!))).toBe(true);
  expect(auto.policyMatches(grant, {...store.event(id!), payload: {...e, text: "hello refund"}})).toBe(false);
  const comment = {...store.event(id!), payload: candidate({channel: "COMMENT_NOTIFICATION", videoId: "new", commentId: "parent", conversationId: null, kind: "COMMENT"})};
  expect(auto.policyMatches(grant, comment)).toBe(false);
  auto.registerWork({id: "new", ownId: "own-1", url: "http://127.0.0.1/video/new", publishedAt: start + 1000, precisionMs: 1000});
  expect(auto.policyMatches(grant, comment)).toBe(true);
  const authority = new WorkbenchAuthority(store), token = authority.issueSession();
  const claim = authority.claim(token, id!, 0);
  expect(auto.policyMatches(grant, store.event(id!))).toBe(false);
  authority.release(token, id!, claim.generation);
  expect(auto.policyMatches(grant, store.event(id!))).toBe(true);
  authority.resumeAutomation(token, id!);
  expect(auto.policyMatches(grant, store.event(id!))).toBe(true);
  store.db.prepare("UPDATE client_state SET paused=1").run();
  expect(auto.policyMatches(grant, store.event(id!))).toBe(false);
});

test("supplied same-version policy cannot broaden the persisted conversation authorization", async () => {
  const {store, auto} = await setup();
  store.db.prepare("UPDATE client_state SET mode='LIMITED_AUTO'").run();
  const e = candidate({occurredAt: new Date(start + 10_000).toISOString()});
  const [id] = store.observe("DIRECT_MESSAGE", e.conversationId!, [e], "own-1", "fixture", new Date(start + 60_000).toISOString(), start);
  const grant = auto.grant("AUTO_REPLY", {...policy, entireInbox: false, conversationIds: ["allowed-only"]});
  expect(auto.policyMatches({...grant, scope: {...grant.scope, entireInbox: true}}, store.event(id!))).toBe(false);
});

test("native second precision overlapping first-run boundary remains reviewable rather than hidden history", async () => {
  const {store} = await setup();
  const e = candidate({channel: "COMMENT_NOTIFICATION", kind: "COMMENT", videoId: "new-work", commentId: "parent", conversationId: null,
    occurredAt: new Date(start).toISOString(), occurredAtPrecisionMs: 1000});
  store.observe("COMMENT_NOTIFICATION", "work:new-work", [e], "own-1", "fixture", new Date(start + 60_000).toISOString(), start + 500);
  expect(store.events()[0]?.status).toBe("MANUAL_REVIEW");
});
