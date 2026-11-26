import { randomUUID } from "node:crypto";
import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import https from "node:https";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { ModelCredentialStore } from "../../src/app/credentials.js";
import { ModelProviderStore } from "../../src/storage/model-provider-store.js";
import { applyModel, chatAnswer, deferred, modelFixture, providerState, stageFixtureModel } from "../model-provider-helpers.js";

vi.mock("node:dns/promises", { spy: true });

const testCommand = (target: Awaited<ReturnType<typeof stageFixtureModel>>) => ({
  command: "modelProviders", action: "test", commandId: randomUUID(), confirmed: true,
  connectionId: target.connectionId, routeRevision: target.routeRevision, modelId: target.modelId,
});

test("connection test uses fixed public text and one global attempt, with durable replay before preconditions", async () => {
  const requests: Record<string, unknown>[] = [];
  const f = await modelFixture(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body))); return chatAnswer();
  });
  try {
    const target = await stageFixtureModel(f.service, f.token);
    const input = testCommand(target);
    f.store.db.prepare("UPDATE budget_limits SET maximum=1 WHERE kind='MODEL'").run();
    const result = await f.service.dispatch(f.token, input);
    expect(result).toMatchObject({ status: "SUCCEEDED", reportedModelId: target.modelId, usage: { totalTokens: 5 } });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ max_tokens: 512, model: target.modelId, messages: [{ role: "user", content: "Reply only with OK." }] });
    expect(f.store.budget("MODEL").used).toBe(1);
    expect(f.store.db.prepare("SELECT purpose,grant_version,selection_revision FROM m_call_routes").all())
      .toEqual([{ purpose: "PROVIDER_TEST", grant_version: null, selection_revision: null }]);
    for (const table of ["automation_grants", "grant_reservations", "reply_drafts", "send_intents", "automation_jobs"]) {
      expect(f.store.db.prepare("SELECT count(*) FROM " + table).pluck().get()).toBe(0);
    }
    await f.service.dispatch(f.token, { command: "emergencyStop" });
    await f.service.dispatch(f.token, { command: "modelProviders", action: "setKey", storage: "DELETE",
      connectionId: target.connectionId, expectedVersion: target.version });
    expect(await f.service.dispatch(f.token, input)).toEqual(result);
    await expect(f.service.dispatch(f.token, { ...input, modelId: "another" })).rejects.toThrow("MODEL_COMMAND_CONFLICT");
    expect(requests).toHaveLength(1);
  } finally { await f.close(); }
});

test.each(["key", "delete", "emergency", "switch"])("an in-flight test reacts correctly to %s", async action => {
  const entered = deferred(), release = deferred();
  const calls: string[] = [];
  const f = await modelFixture(async url => {
    calls.push(String(url)); entered.resolve(); await release.promise; return chatAnswer();
  });
  try {
    const target = await stageFixtureModel(f.service, f.token);
    const other = await stageFixtureModel(f.service, f.token, "Other");
    const input = testCommand(target);
    const running = f.service.dispatch(f.token, input);
    await entered.promise;
    expect(await f.service.dispatch(f.token, input)).toMatchObject({ status: "STARTED" });
    if (action === "switch") await applyModel(f.service, f.token, other.connectionId, other.routeRevision, other.modelId);
    if (action === "emergency") await f.service.dispatch(f.token, { command: "emergencyStop" });
    if (action === "key" || action === "delete") await f.service.dispatch(f.token, {
      command: "modelProviders", action: action === "key" ? "setKey" : "delete",
      ...(action === "key" ? { storage: "DELETE" } : {}), connectionId: target.connectionId, expectedVersion: target.version,
    });
    if (action === "switch") release.resolve();
    expect(await running).toMatchObject({ status: action === "switch" ? "SUCCEEDED" : "INTERRUPTED" });
    expect(calls).toEqual(["https://models.example.com/v1/chat/completions"]);
    expect(f.store.budget("MODEL").used).toBe(1);
  } finally { release.resolve(); await f.close(); }
});

test("restart marks a durably started test interrupted without replaying or refunding it", async () => {
  let requests = 0;
  const f = await modelFixture(async () => { requests++; return chatAnswer(); });
  let restarted: typeof f.service | undefined;
  try {
    const target = await stageFixtureModel(f.service, f.token);
    const input = testCommand(target);
    new ModelProviderStore(f.store.db).startTest(input, () => { f.store.consumeBudget("MODEL"); return undefined; });
    await f.service.close();
    const next = await f.start(); restarted = next.service;
    expect(await next.service.dispatch(next.token, input)).toMatchObject({ status: "INTERRUPTED" });
    expect(f.store.budget("MODEL").used).toBe(1);
    expect(requests).toBe(0);
  } finally { await restarted?.close(); await f.close(); }
});

test("a stop and recovery during Key lookup cannot reserve or send a connection test", async () => {
  const entered = deferred(), release = deferred();
  const transport = vi.fn<typeof fetch>(async () => chatAnswer());
  const f = await modelFixture(transport);
  const original = ModelCredentialStore.prototype.load;
  const load = vi.spyOn(ModelCredentialStore.prototype, "load").mockImplementationOnce(async function (this: ModelCredentialStore, ...args) {
    entered.resolve();
    await release.promise;
    return original.apply(this, args);
  });
  try {
    const target = await stageFixtureModel(f.service, f.token);
    const running = f.service.dispatch(f.token, testCommand(target));
    const rejected = expect(running).rejects.toThrow("EMERGENCY_STOPPED");
    await entered.promise;
    const auto = f.service.authority.modelRoute!.automation;
    auto.stop(true);
    expect(auto.resumeEmergency(auto.emergencyRevision())).toBe(true);
    release.resolve();
    await rejected;
    expect(transport).not.toHaveBeenCalled();
    expect(f.store.budget("MODEL").used).toBe(0);
    expect(f.store.db.prepare("SELECT count(*) FROM m_commands WHERE kind='TEST'").pluck().get()).toBe(0);
  } finally {
    release.resolve();
    load.mockRestore();
    await f.close();
  }
});

test("controller discovery uses native public DNS validation before opening an HTTPS connection", async () => {
  const fallback = vi.fn<typeof fetch>(async () => Response.json({ data: [] }));
  vi.stubGlobal("fetch", fallback);
  const dns = vi.mocked(lookup as (hostname: string, options: { all: true }) => Promise<LookupAddress[]>)
    .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
  const httpsRequest = vi.spyOn(https, "request").mockImplementation(() => {
    throw new Error("Unexpected outgoing connection");
  });
  let f: Awaited<ReturnType<typeof modelFixture>> | undefined;
  try {
    f = await modelFixture(globalThis.fetch);
    const { connectionId, routeRevision } = await stageFixtureModel(f.service, f.token);
    expect(await f.service.dispatch(f.token, { command: "modelProviders", action: "discover", connectionId, routeRevision }))
      .toMatchObject({ status: "FAILED", reason: "MODEL_REQUEST_UNSUPPORTED", totalCount: 0 });
    expect(dns).toHaveBeenCalledWith("models.example.com", { all: true });
    expect(httpsRequest).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  } finally {
    await f?.close();
    dns.mockClear();
    httpsRequest.mockRestore();
    vi.unstubAllGlobals();
  }
});

test("rekeying and applying preserve an in-flight test's exact Key until it finishes, then revoke it", async () => {
  const entered = deferred(), release = deferred();
  const f = await modelFixture(async () => { entered.resolve(); await release.promise; return chatAnswer(); });
  try {
    const target = await stageFixtureModel(f.service, f.token);
    await applyModel(f.service, f.token, target.connectionId, target.routeRevision, target.modelId);
    const data = new ModelProviderStore(f.store.db);
    const old = data.getRevision(target.connectionId, target.routeRevision)!;
    const ref = { connectionId: target.connectionId, storage: old.storage, credentialRevision: old.credentialRevision! };
    const running = f.service.dispatch(f.token, testCommand(target));
    await entered.promise;
    await f.service.dispatch(f.token, { command: "modelProviders", action: "setKey", storage: "MEMORY",
      connectionId: target.connectionId, expectedVersion: target.version, key: "synthetic-second-version" });
    const connection = (await providerState(f.service, f.token)).connections.find(c => c.id === target.connectionId)!;
    await applyModel(f.service, f.token, connection.id, connection.draftRevision, target.modelId);
    expect(data.isCredentialActive(ref)).toBe(true);
    release.resolve();
    expect(await running).toMatchObject({ status: "SUCCEEDED", routeRevision: target.routeRevision });
    expect(data.isCredentialActive(ref)).toBe(false);
    expect(data.getCredential(ref.credentialRevision)?.cleanupState).toBe("DONE");
  } finally { release.resolve(); await f.close(); }
});

test("a truncated connection test retains reported usage and can never pass", async () => {
  const f = await modelFixture(async () => Response.json({
    model: "vendor/model:review", choices: [{ index: 0, finish_reason: "length", message: { role: "assistant", content: "Partial" } }],
    usage: { prompt_tokens: 4, completion_tokens: 512, total_tokens: 516 },
  }));
  try {
    const target = await stageFixtureModel(f.service, f.token);
    expect(await f.service.dispatch(f.token, testCommand(target))).toMatchObject({
      status: "FAILED", reason: "MODEL_OUTPUT_INCOMPLETE", reportedModelId: target.modelId,
      usage: { inputTokens: 4, outputTokens: 512, totalTokens: 516 },
    });
    expect(f.store.budget("MODEL").used).toBe(1);
  } finally { await f.close(); }
});

test("startup reconciles only marked unpublished credential artifacts", async () => {
  const f = await modelFixture();
  let restarted: typeof f.service | undefined;
  try {
    const conn = (await providerState(f.service, f.token)).connections[0]!;
    const folder = join(f.root, "model-credentials", conn.id);
    await mkdir(folder, { recursive: true });
    const pending = join(folder, randomUUID() + ".dpapi");
    const keep = join(folder, randomUUID() + ".dpapi");
    await writeFile(pending, "synthetic-ciphertext");
    await writeFile(pending + ".tmp", "synthetic-temporary");
    await writeFile(pending + ".pending", "");
    await writeFile(keep, "unrelated-fixture");
    await f.service.close();
    const next = await f.start(); restarted = next.service;
    for (const suffix of ["", ".tmp", ".pending"]) expect(existsSync(pending + suffix)).toBe(false);
    expect(existsSync(keep)).toBe(true);
    expect((await providerState(next.service, next.token)).connections[0]?.draft.keyPresent).toBe(false);
  } finally { await restarted?.close(); await f.close(); }
});
