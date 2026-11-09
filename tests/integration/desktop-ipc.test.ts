import { test, expect } from "vitest";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomBytes, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { privateTemp } from "../helpers.js";
import Database from 'better-sqlite3';
import {existsSync} from 'node:fs';
import {readFile,writeFile} from 'node:fs/promises';

test('native request allowlist matches the complete application command contract',async()=>{
  const [contracts,native]=await Promise.all([readFile('src/app/contracts.ts','utf8'),readFile('desktop/src-tauri/src/main.rs','utf8')]);
  const commands=[...contracts.matchAll(/command:\s*z\.literal\(["']([A-Za-z][A-Za-z0-9]+)["']\)/gu)].map(m=>m[1]!);
  const allowed=native.match(/const ALLOWED:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/u)?.[1];
  expect(commands.length).toBeGreaterThan(30);expect(commands).toContain('enableReplyPolicy');expect(allowed).toBeDefined();
  const names=[...allowed!.matchAll(/"([A-Za-z][A-Za-z0-9]+)"/gu)].map(m=>m[1]!);
  expect(new Set(names)).toEqual(new Set(['connect','disconnect',...commands]));
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
  child.stderr.on("data", (data) => (stderr += String(data)));
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.ready) ready();
    if (typeof value.requestId === "string") {
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
      result: { connected: true, schema: 3, mode: "DRAFT_ONLY" },
    });
    expect(
      await call({ command: "getStatus", operatorId: "forged" }),
    ).toMatchObject({ ok: false, error: "INVALID_COMMAND" });
    expect(await call({ command: "setMode", mode: "MANUAL" })).toMatchObject({
      ok: true,
      result: { configuredMode: "MANUAL", mode: "DRAFT_ONLY" },
    });
    expect(
      await call({
        command: "connect",
        runtime: root,
        initialize: false,
        consent: true,
      }),
    ).toMatchObject({ ok: true, result: { connected: true } });
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
    lines.close();
    for (const item of pending.values())
      item.reject(new Error("IPC_TEST_ENDED"));
  }
}, 30_000);
