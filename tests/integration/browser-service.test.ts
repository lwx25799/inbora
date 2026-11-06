import { test, expect } from "vitest";
import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserService } from "../../src/app/browser-service.js";
import type { BrowserProfileOwner } from "../../src/browser/profile-owner.js";
import { AccountActor } from "../../src/browser/account-actor.js";
import { privateTemp } from "../helpers.js";
import { mapping } from "../fixtures/site.js";

function fakeOwner() {
  const context = new EventEmitter();
  let closed = 0,
    opened = "";
  const owner = {
    context,
    actor: new AccountActor(),
    version: () => "synthetic-edge-1",
    open: async (origin: string) => {
      opened = origin;
    },
    close: async () => {
      closed++;
      context.emit("close");
    },
  } as unknown as BrowserProfileOwner;
  return { owner, context, closed: () => closed, opened: () => opened };
}
test("browser launch is single-flight, loads current mapping identity, and releases natural close before reopening", async () => {
  const root = privateTemp("browser-lifecycle-"),
    config = { ...mapping("https://www.douyin.com"), environment: "douyin" };
  await writeFile(join(root, "site-mapping.json"), JSON.stringify(config));
  let launches = 0;
  const owners: ReturnType<typeof fakeOwner>[] = [];
  const browser = new BrowserService(root, async () => {
    launches++;
    await new Promise((r) => setTimeout(r, 5));
    const fake = fakeOwner();
    owners.push(fake);
    return fake.owner;
  });
  await Promise.all([browser.open(), browser.open()]);
  expect(launches).toBe(1);
  expect(browser.identity("DIRECT_MESSAGE")).toMatchObject({
    browserVersion: "synthetic-edge-1",
    browserMode: "headed",
  });
  owners[0]!.context.emit("close");
  await browser.open();
  expect(launches).toBe(2);
  expect(owners[0]!.closed()).toBe(1);
  await browser.close();
  expect(owners[1]!.closed()).toBe(1);
});
test("first login can open the fixed authorized entry without mapping and keeps capabilities unverified", async () => {
  const fake = fakeOwner(),
    browser = new BrowserService(
      privateTemp("browser-first-login-"),
      async () => fake.owner,
    );
  await browser.open("headed");
  expect(fake.opened()).toBe("https://www.douyin.com/");
  expect(browser.identity("DIRECT_MESSAGE")).toBeNull();
  expect(browser.status().state).toBe("OPEN_IDENTITY_UNVERIFIED");
  await browser.close();
});
test("changed mapping is reflected in authority identity and malformed mapping fails closed", async () => {
  const root = privateTemp("browser-mapping-"),
    config = { ...mapping("https://www.douyin.com"), environment: "douyin" };
  await writeFile(join(root, "site-mapping.json"), JSON.stringify(config));
  const fake = fakeOwner(),
    browser = new BrowserService(root, async () => fake.owner);
  await browser.open();
  const before = browser.identity("DIRECT_MESSAGE")!.mappingDigest;
  await writeFile(
    join(root, "site-mapping.json"),
    JSON.stringify({ ...config, ownId: "changed-fixture-own" }),
  );
  expect(
    (await browser.refreshIdentity("DIRECT_MESSAGE"))!.mappingDigest,
  ).not.toBe(before);
  await writeFile(join(root, "site-mapping.json"), "{");
  await expect(browser.refreshIdentity("DIRECT_MESSAGE")).rejects.toThrow();
  await browser.close();
});
