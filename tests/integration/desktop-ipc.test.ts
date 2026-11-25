import { test, expect } from "vitest";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomBytes, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { privateTemp } from "../helpers.js";
import Database from 'better-sqlite3';
import {existsSync} from 'node:fs';
import {readFile,rm,writeFile} from 'node:fs/promises';
import {z} from 'zod';
import {commandSchema} from '../../src/app/contracts.js';
import {MAX_PROTOCOL_V2_FRAME_BYTES} from '../../src/contracts/protocol-v2.js';
import {installFixtureKey,modelFixture,providerState} from '../model-provider-helpers.js';
import {ModelProviderStore} from '../../src/storage/model-provider-store.js';
import type {ModelCatalogEntry,ModelCatalogPage,PublicModelState} from '../../src/contracts/model-providers.js';

function applicationCommands(schema:unknown):string[]{
  if(!schema||typeof schema!=='object')return[];
  const object=schema as {properties?:{command?:{const?:unknown}}};
  const command=object.properties?.command?.const;
  const nested=Object.values(schema).flatMap(value=>Array.isArray(value)?value.flatMap(applicationCommands):applicationCommands(value));
  return typeof command==='string'?[command,...nested]:nested;
}

test('native request allowlist matches the complete application command contract',async()=>{
  const native=await readFile('desktop/src-tauri/src/main.rs','utf8');
  const commands=applicationCommands(z.toJSONSchema(commandSchema));
  const allowed=native.match(/const ALLOWED:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/u)?.[1];
  expect(commands.length).toBeGreaterThan(30);expect(commands).toContain('enableReplyPolicy');
  expect(commands).toContain('securityRecovery');expect(commands).toContain('modelProviders');expect(allowed).toBeDefined();
  const names=[...allowed!.matchAll(/"([A-Za-z][A-Za-z0-9]+)"/gu)].map(m=>m[1]!);
  expect(new Set(names)).toEqual(new Set(['connect','disconnect',...commands]));
});

test('desktop status projects the persistent selection without key or credential handles',async()=>{
  const f=await modelFixture();
  try{
    const key='synthetic-ipc-key';
    await installFixtureKey(f.service,f.token,{key});
    const selection=(await providerState(f.service,f.token)).selection;
    await f.service.dispatch(f.token,{command:'configureAi',settings:{persona:'Synthetic business',business:'',rules:''}});
    const status=await f.service.dispatch(f.token,{command:'getStatus'});
    expect(status).toMatchObject({modelProvidersSupported:true,modelProvidersAvailable:true,modelProvidersError:null,modelProviders:{selection},
      settings:{model:selection.modelId,persona:'Synthetic business'},keyPresent:true,keyStored:false});
    const json=JSON.stringify(status);
    expect(json).not.toContain(key);
    expect(json).not.toMatch(/credentialRevision|ciphertext/u);
    await expect(f.service.dispatch(f.token,{command:'configureAi',settings:{model:'vendor/forbidden:v2',persona:'',business:'',rules:''}}))
      .rejects.toThrow('USE_MODEL_PROVIDER_SETTINGS');
  }finally{await f.close();}
});

async function rustFrameLimit(): Promise<number> {
  const native = await readFile("desktop/src-tauri/src/protocol.rs", "utf8");
  const rustLimit = Number(native.match(/MAX_SIDECAR_LINE_BYTES: usize = ([\d_]+)/u)?.[1]?.replaceAll("_", ""));
  const v2Limit = Number(native.match(/MAX_PROTOCOL_V2_FRAME_BYTES: usize = ([\d_]+)/u)?.[1]?.replaceAll("_", ""));
  expect(rustLimit).toBe(2_000_000);
  expect(v2Limit).toBe(1_048_576);
  expect(v2Limit).toBe(MAX_PROTOCOL_V2_FRAME_BYTES);
  return rustLimit;
}

function seedLargeCatalog(db: Database.Database) {
  const directory: ModelCatalogEntry[] = Array.from({ length: 2_000 }, (_, index) => ({
    modelId: `catalog-${index.toString().padStart(4, "0")}-` + "x".repeat(240),
    source: "DISCOVERED", displayName: "中文模型".repeat(50),
  }));
  const models = new ModelProviderStore(db);
  const selected = models.getSelection();
  const first = models.requireConnection(selected.connectionId!);
  for (const row of [first, ...Array.from({ length: 3 }, (_, index) => models.saveConnection({
    connectionId: null, expectedVersion: 0, name: `连接 ${index}`, presetId: "custom",
    protocol: "OPENAI_CHAT", baseUrl: "https://example.com/v1", region: null, manualModels: [],
  }))]) {
    models.recordCatalog({ connectionId: row.id, routeRevision: row.draftRevision,
      status: "COMPLETE", models: directory, fetchedAt: Date.now(), reason: null });
  }
  return { connectionId: first.id, directory };
}

test("the UTF-8 status envelope for four multi-byte catalogs stays well under the Rust frame limit", async () => {
  const f = await modelFixture();
  try {
    const rustLimit = await rustFrameLimit();
    const { connectionId, directory } = seedLargeCatalog(f.store.db);
    const applied = directory.at(-1)!;
    f.store.db.prepare("UPDATE m_selection SET model_id=? WHERE id=1").run(applied.modelId);
    expect(Buffer.byteLength(JSON.stringify(directory), "utf8")).toBeGreaterThan(rustLimit * 0.9);
    const result = await f.service.dispatch(f.token, { command: "getStatus" });
    const bytes = Buffer.byteLength(JSON.stringify({ protocol: 1, requestId: randomUUID(), ok: true, result }) + "\n", "utf8");
    expect(bytes).toBeLessThan(rustLimit / 4);
    expect(result).toMatchObject({ modelProviders: { totalConnectionCount: 4 } });
    const state = (result as {modelProviders: PublicModelState}).modelProviders;
    const row = state.connections.find(connection => connection.id === connectionId)!;
    expect(row).toMatchObject({
      totalModelCount: 2001, modelsTruncated: true,
      models: expect.arrayContaining([expect.objectContaining({ source: "MANUAL" }), applied]),
      draft: { catalogResult: { totalCount: 2000, truncated: false } },
      applied: { catalogResult: { totalCount: 2000, truncated: false, selectedModelInCatalog: true } },
    });
    expect(row.draft.catalogResult).not.toHaveProperty("models");
    expect(await providerState(f.service, f.token)).toEqual(state);
    expect(await f.service.dispatch(f.token, { command: "modelProviders", action: "list", offset: 1, limit: 2 }))
      .toMatchObject({ totalConnectionCount: 4, nextConnectionOffset: 3, connections: state.connections.slice(1, 3) });
    const listed: ModelCatalogEntry[] = [];
    for (let offset: number | null = 0; offset !== null;) {
      const page = await f.service.dispatch(f.token,
        { command: "modelProviders", action: "list", connectionId, offset, limit: 200 }) as ModelCatalogPage;
      expect(page).toMatchObject({ connectionId, offset, totalModelCount: 2001, version: row.version });
      expect(page.nextOffset === null || page.nextOffset > offset).toBe(true);
      listed.push(...page.models);
      offset = page.nextOffset;
    }
    expect(listed.filter(model => model.source === "DISCOVERED")).toEqual(directory);
    console.info(`Four-catalog getStatus UTF-8 frame: ${bytes} bytes`);
  } finally { await f.close(); }
});

test("a save from a truncated public model list cannot silently remove hidden manual entries", async () => {
  const f = await modelFixture();
  try {
    const { service, token, store } = f;
    const models = new ModelProviderStore(store.db);
    const manualModels = Array.from({ length: 1_200 }, (_, index) => ({
      modelId: `manual-${index}-` + "x".repeat(235), displayName: "手动别名".repeat(50),
    }));
    const settings = { presetId: "custom", protocol: "OPENAI_CHAT", baseUrl: "https://example.com/v1", region: null } as const;
    const stored = models.saveConnection({ connectionId: null, expectedVersion: 0, name: "Manual models", ...settings, manualModels });
    const state = await providerState(service, token);
    const visible = state.connections.find(row => row.id === stored.id)!;
    expect(visible).toMatchObject({ modelsTruncated: true, totalModelCount: manualModels.length });
    const save = { command: "modelProviders", action: "save", connectionId: stored.id,
      expectedVersion: stored.version, name: "Rename only", ...settings };
    const visibleModels = visible.models.map(({ modelId, displayName }) => ({ modelId, displayName }));
    await expect(service.dispatch(token, { ...save, manualModels: visibleModels })).rejects.toThrow("MODEL_MANUAL_MODELS_TRUNCATED");
    expect(models.requireConnection(stored.id)).toEqual(stored);
    await service.dispatch(token, { ...save, manualModels, manualModelsComplete: true,
      expectedSelectionRevision: state.selection.selectionRevision });
    expect(models.requireConnection(stored.id)).toMatchObject({ name: "Rename only", models: stored.models });
  } finally { await f.close(); }
});

test("source sidecar authenticates IPC, rejects unbounded/extra fields, reconnects and exits without replay", async () => {
  const secret = randomBytes(32).toString("hex"),
    root = privateTemp("source-ipc-");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/app/sidecar.ts"],
    {
      cwd: resolve("."),
      env: { ...process.env, INBORA_PIPE_NONCE: secret },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const pending = new Map<
    string,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
    }
  >();
  let ready!: () => void;
  const boot = new Promise<void>((r) => (ready = r));
  let stderr = "";
  let replyBytes = 0;
  child.stderr.on("data", (data) => (stderr += String(data)));
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.ready) ready();
    if (typeof value.requestId === "string") {
      replyBytes = Buffer.byteLength(line + "\n", "utf8");
      pending.get(value.requestId)?.resolve(value);
      pending.delete(value.requestId);
    }
  });
  function call(body: unknown, nonce = secret) {
    const requestId = randomUUID();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      child.stdin.write(
        JSON.stringify({ protocol: 1, requestId, secret: nonce, body }) + "\n",
      );
    });
  }
  const exited = new Promise<number | null>((r) => child.once("exit", r));
  try {
    await boot;
    expect(await call({ command: "getStatus" }, "0".repeat(64))).toMatchObject({
      ok: false,
      error: "IPC_AUTHENTICATION_FAILED",
    });
    const absent=join(root,'uninitialized-nested');
    expect({reply:await call({command:'connect',runtime:absent,initialize:false,consent:true}),created:existsSync(absent)})
      .toMatchObject({reply:{ok:false,error:'RUNTIME_NOT_FOUND'},created:false});
    expect(await call({command:'connect',runtime:root,initialize:false,consent:true})).toMatchObject({ok:false,error:'RUNTIME_NOT_FOUND'});
    expect(existsSync(join(root,'poc.sqlite'))).toBe(false);
    const file=join(root,'not-a-directory');await writeFile(file,'synthetic file must remain');
    expect(await call({command:'connect',runtime:file,initialize:false,consent:true})).toMatchObject({ok:false,error:'RUNTIME_NOT_FOUND'});
    expect(
      await call({
        command: "connect",
        runtime: root,
        initialize: true,
        consent: true,
      }),
    ).toMatchObject({
      ok: true,
      result: { connected: true, schema: 4, mode: "DRAFT_ONLY",
        localAssistantConnection:{ready:true,instanceId:expect.any(String),transport:'stdio',tools:16} },
    });
    const recoverySession=randomUUID();
    expect(await call({command:'securityRecovery',action:'start',channel:'COMMENT_NOTIFICATION'}))
      .toMatchObject({ok:false,error:'MANUAL_RECOVERY_HEADLESS_REQUIRED'});
    for(const action of ['frame','finish'] as const)
      expect(await call({command:'securityRecovery',action,sessionId:recoverySession}))
        .toMatchObject({ok:false,error:'MANUAL_RECOVERY_OPERATOR_CHANGED'});
    expect(await call({command:'securityRecovery',action:'input',sessionId:recoverySession,frameId:randomUUID(),
      sequence:1,input:{kind:'pointer',phase:'down',x:1,y:1}}))
      .toMatchObject({ok:false,error:'MANUAL_RECOVERY_OPERATOR_CHANGED'});
    expect(await call({command:'securityRecovery',action:'close',sessionId:recoverySession}))
      .toMatchObject({ok:true,result:{browser:{state:'CLOSED',mode:'headless'},manualRecovery:null}});
    expect(
      await call({ command: "getStatus", operatorId: "forged" }),
    ).toMatchObject({ ok: false, error: "INVALID_COMMAND" });
    expect(await call({ command: "setMode", mode: "MANUAL" })).toMatchObject({
      ok: true,
      result: { configuredMode: "MANUAL", mode: "DRAFT_ONLY" },
    });
    const rustLimit = await rustFrameLimit();
    const seed = new Database(join(root, "poc.sqlite"));
    let connectionId: string;
    try { ({ connectionId } = seedLargeCatalog(seed)); }
    finally { seed.close(); }
    expect(await call({ command: "getStatus" })).toMatchObject({
      ok: true, result: { modelProviders: { totalConnectionCount: 4 } },
    });
    expect(replyBytes).toBeLessThan(rustLimit / 4);
    expect(await call({ command: "modelProviders", action: "list", connectionId, limit: 201 }))
      .toMatchObject({ ok: false, error: "INVALID_COMMAND" });
    expect(await call({ command: "modelProviders", action: "list", connectionId, offset: 2_000, limit: 200 }))
      .toMatchObject({ ok: true, result: { offset: 2_000, nextOffset: null, totalModelCount: 2_001, models: [expect.any(Object)] } });
    expect(
      await call({
        command: "connect",
        runtime: root,
        initialize: false,
        consent: true,
      }),
    ).toMatchObject({ ok: true, result: { connected: true } });
    expect(replyBytes).toBeLessThan(rustLimit / 4);
    const control=new Database(join(root,'poc.sqlite'));control.prepare('UPDATE operator_sessions SET expires_at=0').run();control.close();
    expect(await call({command:'getStatus'})).toMatchObject({ok:true,result:{configuredMode:'MANUAL'}});
    expect(await call({ command: "emergencyStop" })).toMatchObject({
      ok: true,
      result: { paused: true },
    });
    expect(await call({command:'connect',runtime:root,initialize:false,consent:true})).toMatchObject({ok:true,result:{connected:true,paused:true}});
    expect(
      await call({
        command: "getInbox",
        channel: "ALL",
        status: "ALL",
        page: 0,
      }),
    ).toMatchObject({ ok: true, result: { items: [], total: 0 } });
    child.stdin.end();
    expect(await exited).toBe(0);
    expect(stderr).toBe("");
    // New process uses the same database and never consumes model/send budgets on startup.
    const { EventStore } = await import("../../src/storage/store.js");
    const store = new EventStore(join(root, "poc.sqlite"));
    expect(store.stats().budgets).toEqual([
      { kind: "MODEL", used: 0, maximum: 50 },
      { kind: "SEND", used: 0, maximum: 20 },
    ]);
    store.close();
  } finally {
    child.kill();
    await exited;
    lines.close();
    for (const item of pending.values())
      item.reject(new Error("IPC_TEST_ENDED"));
    await rm(root,{recursive:true,force:true});
  }
}, 30_000);
