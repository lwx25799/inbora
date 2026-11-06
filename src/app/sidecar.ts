import { createInterface } from "node:readline";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { OwnerLock } from "../browser/owner-lock.js";
import { EventStore } from "../storage/store.js";
import { migrateClient } from "../storage/client-migration.js";
import { runtimeRoot, initRuntime, loadRuntime } from "../config/runtime.js";
import { requireSafe } from "../core/contracts.js";
import { BrowserService } from "./browser-service.js";
import { ClientService, clientError } from "./service.js";
import { protocolVersion,commandSchema } from "./contracts.js";

const pipeSchema = z
  .object({
    protocol: z.literal(protocolVersion),
    requestId: z.uuid(),
    secret: z.string().length(64),
    body: z.unknown(),
  })
  .strict();
const connectSchema = z
  .object({
    command: z.literal("connect"),
    runtime: z.string().min(1).max(1000),
    initialize: z.boolean(),
    consent: z.literal(true),
  })
  .strict();
const secret = process.env.INBORA_PIPE_NONCE;
requireSafe(secret?.length === 64, "TRUSTED_DESKTOP_PARENT_REQUIRED");
delete process.env.INBORA_PIPE_NONCE;
let service: ClientService | undefined,
  token = "",
  lock: OwnerLock | undefined,
  store: EventStore | undefined;
let connecting = false,
  closing = false;
const active = new Set<Promise<void>>();
const output = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + "\n");
async function connect(raw: unknown): Promise<unknown> {
  const c = connectSchema.parse(raw);
  if (service) {
    requireSafe(
      !c.initialize && runtimeRoot(c.runtime) === service.browser.root,
      "DISCONNECT_FIRST",
    );
    try {
      service.authority.operator(token);
    } catch (error) {
      requireSafe(
        clientError(error) === "OPERATOR_EXPIRED",
        "OPERATOR_PERMISSION_DENIED",
      );
      service.authority.expireOperators();
      token = service.authority.issueSession();
    }
    return {
      connected: true,
      ...((await service.dispatch(token, { command: "getStatus" })) as object),
    };
  }
  requireSafe(!connecting, "CONNECTION_IN_PROGRESS");
  connecting = true;
  try {
    const root = runtimeRoot(c.runtime);
    lock = await OwnerLock.acquire(root);
    if (c.initialize) await initRuntime(root);
    await loadRuntime(root);
    store = new EventStore(join(root, "poc.sqlite"), c.initialize);
    await migrateClient(
      store,
      join(root, "backups", `client-v2-${randomUUID()}.sqlite`),
    );
    service = new ClientService(store, new BrowserService(root));
    await service.loadSettings();
    token = service.authority.issueSession();
    service.events.on("update", (event) => output({ protocol: 1, event }));
    return {
      connected: true,
      runtime: root,
      ...((await service.dispatch(token, { command: "getStatus" })) as object),
    };
  } catch (error) {
    service = undefined;
    store?.close();
    store = undefined;
    await lock?.close();
    lock = undefined;
    throw error;
  } finally {
    connecting = false;
  }
}
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await service?.close();
  await Promise.allSettled([...active]);
  store?.close();
  await lock?.close();
  process.exitCode = 0;
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (closing) return;
  let id: string | null = null;
  const task = (async () => {
    try {
      requireSafe(Buffer.byteLength(line) <= 100_000, "IPC_REQUEST_TOO_LARGE");
      const envelope = pipeSchema.parse(JSON.parse(line));
      id = envelope.requestId;
      requireSafe(
        timingSafeEqual(Buffer.from(envelope.secret), Buffer.from(secret!)),
        "IPC_AUTHENTICATION_FAILED",
      );
      const raw = envelope.body;
      requireSafe(
        raw && typeof raw === "object" && "command" in raw,
        "INVALID_COMMAND",
      );
      let result: unknown;
      if (raw.command === "connect") result = await connect(raw);
      else if (raw.command === "disconnect") {
        requireSafe(service, "CONNECT_RUNTIME_FIRST");
        await service.close();
        store!.close();
        await lock!.close();
        service = undefined;
        store = undefined;
        lock = undefined;
        token = "";
        result = { connected: false };
      } else if(raw.command==='emergencyStop') {
        requireSafe(service,'CONNECT_RUNTIME_FIRST');commandSchema.parse(raw);
        // The independently authenticated desktop pipe can always obtain stop-only authority.
        // Expiry of the editing session must never put emergency stop behind reconnect/browser work.
        const stopToken=service.authority.issueSession(['READ','CONTROL']);
        try{await service.dispatch(stopToken,raw);result={paused:true,emergencyStopped:true};}
        finally{service.authority.revoke(stopToken);}
      } else {
        requireSafe(service, "CONNECT_RUNTIME_FIRST");
        result = await service.dispatch(token, raw);
      }
      output({ protocol: 1, requestId: id, ok: true, result });
    } catch (error) {
      output({
        protocol: 1,
        requestId: id,
        ok: false,
        error:
          error instanceof z.ZodError ? "INVALID_COMMAND" : clientError(error),
      });
    }
  })();
  active.add(task);
  void task.finally(() => active.delete(task));
});
input.on("close", () => {
  void close();
});
process.on("SIGTERM", () => {
  input.close();
});
process.on("SIGINT", () => {
  input.close();
});
// A killed desktop must not leave a browser supervisor with an inherited pipe still open.
const parent = process.ppid;
const heartbeat = setInterval(() => {
  try {
    process.kill(parent, 0);
  } catch {
    input.close();
    clearInterval(heartbeat);
  }
}, 2000);
heartbeat.unref();
output({ protocol: 1, ready: true });
