import { expect, test } from "vitest";
import { AccountActor } from "../../src/browser/account-actor.js";

test("manual operations precede queued collection and the background queue still gets bounded turns", async () => {
  const actor = new AccountActor(), calls: string[] = [];
  const collect = actor.run(async () => {calls.push("collection");}, "background");
  const manual = Array.from({length: 7}, (_, index) => actor.run(async () => {calls.push(`manual-${index}`);}));
  await Promise.all([collect, ...manual]);
  expect(calls).toEqual(["manual-0", "manual-1", "manual-2", "collection", "manual-3", "manual-4", "manual-5", "manual-6"]);
});
test("one full send operation remains indivisible; a rejected task does not stop the queue", async () => {
  const actor = new AccountActor(), calls: string[] = [];
  let active = 0;
  const tasks = ["send", "collection", "another-send"].map(name => actor.run(async () => {
    expect(active++).toBe(0); calls.push(`${name}:start`);
    await Promise.resolve(); calls.push(`${name}:end`); active--;
    if (name === "collection") throw Error("synthetic rejection");
  }));
  const results = await Promise.allSettled(tasks);
  expect(results.map(r => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  expect(calls).toEqual(["send:start", "send:end", "collection:start", "collection:end", "another-send:start", "another-send:end"]);
});
