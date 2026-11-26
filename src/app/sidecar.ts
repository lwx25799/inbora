import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { OwnerLock } from "../browser/owner-lock.js";
import { EventStore } from "../storage/store.js";
import { migrateClient } from "../storage/client-migration.js";
import { migrateAutomation } from "../storage/automation-migration.js";
import { runtimeRoot, initRuntime, loadRuntime } from "../config/runtime.js";
import { requireSafe } from "../core/contracts.js";
import { DEFAULT_ACCOUNT_ID } from "../contracts/account.js";
import { MAX_NATIVE_BRIDGE_BYTES } from "../contracts/native-bridge.js";
import { MAX_PROTOCOL_V2_FRAME_BYTES, type ProtocolScope, type ProtocolV2EventEnvelope } from "../contracts/protocol-v2.js";
import { clearNativeWin32Bridge, getNativeWin32Bridge, registerNativeBridgeTransport } from "../native/win32-bridge.js";
import { ClientService, clientError } from "./service.js";
import { createRuntimeConnector } from "./account-controller.js";
import { dispatchTrustedServiceCommand, MAX_V1_FRAME_BYTES, nativeResponsePrefix, oversizedSidecarFrame, parseSidecarFrame, routeSidecarEnvelope,
  type SidecarCommand } from "./protocol-v2-router.js";
import {AssistantFacade} from '../mcp/assistant-facade.js';
import {startAssistantControl} from '../mcp/control-server.js';

const secret = process.env.INBORA_PIPE_NONCE;
const firstRunAt = Math.floor(Date.now() - process.uptime() * 1000);
requireSafe(secret?.length === 64, "TRUSTED_DESKTOP_PARENT_REQUIRED");
delete process.env.INBORA_PIPE_NONCE;
let service: ClientService | undefined,
  token = "",
  lock: OwnerLock | undefined,
  store: EventStore | undefined;
let assistant:AssistantFacade|undefined;
let control:Awaited<ReturnType<typeof startAssistantControl>>|undefined;
let connecting = false,
  disconnecting = false,
  closing = false;
let connectionSettled: Promise<void> | undefined;
let disconnectSettled: Promise<void> | undefined;
const active = new Set<Promise<void>>();
const lifecycleCommandIds = new Map<string, string>();
let v2Events = false;
function output<T extends { protocol?: number; requestId?: string | null; kind?: string }>(value: T): void {
  let line = JSON.stringify(value);
  const limit = value.kind === 'native_bridge_request' ? MAX_NATIVE_BRIDGE_BYTES :
    value.protocol === 2 ? MAX_PROTOCOL_V2_FRAME_BYTES : 2_000_000;
  if (Buffer.byteLength(line) > limit) {
    if (value.requestId === undefined) return;
    line = JSON.stringify({ protocol: value.protocol, requestId: value.requestId, ok: false, error: 'SIDECAR_RESPONSE_TOO_LARGE' });
  }
  process.stdout.write(line + "\n");
}
if (process.env.INBORA_NATIVE_BRIDGE === '1') {
  registerNativeBridgeTransport({ secret, send: frame => { output(frame); } });
}
async function connect(c: Extract<SidecarCommand, { command: 'connect' }>): Promise<unknown> {
  requireSafe(!closing, 'CLIENT_CLOSING');
  requireSafe(!connecting && !disconnecting, 'CONNECTION_IN_PROGRESS');
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
      service.authority.expireOperators("DESKTOP");
      service.accounts.recheckWorkerSend();
      token = service.authority.issueSession();
    }
    return {
      connected: true,
      runtime: service.browser.root,
      ...((await service.dispatch(token, { command: "getStatus" })) as object),
    };
  }
  connecting = true;
  let settle!: () => void;
  connectionSettled = new Promise<void>(resolve => { settle = resolve; });
  try {
    const root = runtimeRoot(c.runtime);
    lock = await OwnerLock.acquire(root, c.initialize);
    requireSafe(!closing, 'CLIENT_CLOSING');
    if (c.initialize) {
      await initRuntime(root);
      requireSafe(!closing, 'CLIENT_CLOSING');
    }
    await loadRuntime(root);
    requireSafe(!closing, 'CLIENT_CLOSING');
    store = new EventStore(join(root, "poc.sqlite"), c.initialize, undefined, DEFAULT_ACCOUNT_ID);
    await migrateClient(
      store,
      join(root, "backups", `client-v2-${randomUUID()}.sqlite`),
    );
    requireSafe(!closing, 'CLIENT_CLOSING');
    await migrateAutomation(store,join(root,'backups',`automation-before-${randomUUID()}.sqlite`));
    requireSafe(!closing, 'CLIENT_CLOSING');
    // ADR-001 keeps the proven single-account connector. Multi-browser runtimes and the explicit
    // INBORA_BROWSER_WORKER=1 override choose a separate Worker when opening the runtime.
    const connector = createRuntimeConnector(root, store);
    service = new ClientService(store, connector, undefined, Date.now, firstRunAt);
    await service.loadSettings();
    requireSafe(!closing, 'CLIENT_CLOSING');
    assistant=new AssistantFacade(service);
    const facade=assistant;
    control=await startAssistantControl({root,dispatch:(sessionId,tool,args)=>facade.dispatch(sessionId,tool,args)});
    facade.instanceId=control.instanceId;
    service.setAssistantConnection(control.instanceId);
    requireSafe(!closing,'CLIENT_CLOSING');
    token = service.authority.issueSession();
    const accountRef = service.accountId;
    service.events.on("update", (event: { event: string }) => {
      // The native relay keeps legacy listeners and scoped v2 subscribers on separate channels.
      output({ protocol: 1, event });
      if (v2Events) {
        const scope = event.event === 'status_updated' ? { kind: 'GLOBAL' } as const : { kind: 'ACCOUNT', accountRef } as const;
        const frame: ProtocolV2EventEnvelope = { protocol: 2, scope, event };
        output(frame);
      }
    });
    service.accounts.updates.on("update", (accountRef: string, event: { event: string }) => {
      if (v2Events) output<ProtocolV2EventEnvelope>({ protocol: 2, scope: { kind: 'ACCOUNT', accountRef }, event });
    });
    service.startOnline();
    return {
      connected: true,
      runtime: root,
      ...((await service.dispatch(token, { command: "getStatus" })) as object),
    };
  } catch (error) {
    await closeServices();
    service = undefined;
    store?.close();
    store = undefined;
    await lock?.close();
    lock = undefined;
    const code=(error as NodeJS.ErrnoException)?.code;
    if(!c.initialize&&(code==='ENOENT'||code==='ENOTDIR'))requireSafe(false,'RUNTIME_NOT_FOUND');
    throw error;
  } finally {
    connecting = false;
    settle();
    connectionSettled = undefined;
  }
}
async function closeServices():Promise<void>{
  const controlClosed=control?.close();
  // Observe errors while the service drains, then propagate them once cleanup has finished.
  void controlClosed?.catch(()=>{});
  service?.setAssistantConnection(null);
  // Service cancellation stops unsubmitted work; accepted submissions keep their existing readback.
  try {
    await service?.close();
  } finally {
    try {
      await assistant?.close();
    } finally {
      assistant=undefined;control=undefined;
      await controlClosed;
    }
  }
}
async function disconnect(currentTask: () => Promise<void>): Promise<{ connected: false }> {
  requireSafe(!closing, "CLIENT_CLOSING");
  requireSafe(!connecting && !disconnecting, "CONNECTION_IN_PROGRESS");
  requireSafe(service, "CONNECT_RUNTIME_FIRST");
  disconnecting = true;
  let settle!: () => void;
  disconnectSettled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const closingStore = store;
  const closingLock = lock;
  try {
    await closeServices();
  } finally {
    const self = currentTask();
    while (true) {
      const others = [...active].filter((item) => item !== self);
      if (!others.length) break;
      await Promise.allSettled(others);
    }
    service = undefined;
    store = undefined;
    lock = undefined;
    token = "";
    const bridge = getNativeWin32Bridge();
    if (bridge.isAvailable()) await bridge.clearDpapiCache().catch(() => {});
    try {
      closingStore?.close();
    } finally {
      try {
        await closingLock?.close();
      } finally {
        disconnecting = false;
        settle();
        disconnectSettled = undefined;
      }
    }
  }
  return { connected: false };
}
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  // A connection can still create/load its service; let its cancellation cleanup finish first.
  // Other active requests remain cancellable by service.close(), so do not drain all requests here.
  try {
    await connectionSettled;
    if (disconnectSettled) await disconnectSettled;
    await closeServices();
  } finally {
    await Promise.allSettled([...active]);
    try {
      store?.close();
    } finally {
      try { await lock?.close(); }
      finally { clearNativeWin32Bridge(); }
    }
  }
}
async function dispatch(body: SidecarCommand, currentTask: () => Promise<void>, scope?: ProtocolScope): Promise<unknown> {
  if (body.command === 'connect') return connect(body);
  if (body.command === 'disconnect') return disconnect(currentTask);
  requireSafe(!closing && !disconnecting, 'CLIENT_CLOSING');
  requireSafe(service && !connecting, 'CONNECT_RUNTIME_FIRST');
  return dispatchTrustedServiceCommand(service, token, body, scope);
}

function receive(frame: ReturnType<typeof parseSidecarFrame>): void {
  if (frame.kind === 'native' || closing) return;
  if (frame.kind === 'response') { output(frame.response); return; }
  if (frame.envelope.protocol === 2) v2Events = true;
  let task!: Promise<void>;
  task = (async () => {
    output(await routeSidecarEnvelope(frame.envelope, {
      accounts: connecting || disconnecting ? undefined : service?.accounts,
      lifecycleCommandIds, dispatch: (body, scope) => dispatch(body, () => task, scope), errorCode: clientError,
    }));
  })();
  active.add(task);
  void task.finally(() => active.delete(task));
}

// Consume bytes before decoding. A discarded line gets one short error and never
// enters the JSON parser. A following line can still carry an emergency stop.
const inputBuffer = Buffer.allocUnsafe(MAX_PROTOCOL_V2_FRAME_BYTES + 1);
let inputBytes = 0;
let discarding = false;
let frameLimit = MAX_PROTOCOL_V2_FRAME_BYTES;
function consume(chunk: Buffer): void {
  for (let start = 0; start < chunk.length;) {
    const newline = chunk.indexOf(0x0a, start);
    const end = newline === -1 ? chunk.length : newline;
    if (!discarding) {
      if (inputBytes < 512) {
        const prefixBytes = Math.min(end - start, 512 - inputBytes);
        chunk.copy(inputBuffer, inputBytes, start, start + prefixBytes);
        inputBytes += prefixBytes;
        start += prefixBytes;
        const prefix = inputBuffer.toString('utf8', 0, inputBytes);
        if (/^\s*\{\s*"protocol"\s*:\s*1\s*[,}]/u.test(prefix)) frameLimit = MAX_V1_FRAME_BYTES;
        else if (nativeResponsePrefix.test(prefix)) frameLimit = MAX_NATIVE_BRIDGE_BYTES;
      }
      const count = Math.min(end - start, frameLimit + 1 - inputBytes);
      chunk.copy(inputBuffer, inputBytes, start, start + count);
      inputBytes += count;
      const trailingCR = inputBuffer[inputBytes - 1] === 0x0d;
      if (start + count < end || inputBytes - Number(trailingCR) > frameLimit) {
        receive(oversizedSidecarFrame(inputBuffer.toString('utf8', 0, Math.min(inputBytes, 512))));
        discarding = true;
      } else if (newline !== -1) {
        receive(parseSidecarFrame(inputBuffer.toString('utf8', 0, inputBytes - Number(trailingCR)), secret!));
      }
    }
    if (newline === -1) break;
    start = newline + 1;
    inputBytes = 0;
    discarding = false;
    frameLimit = MAX_PROTOCOL_V2_FRAME_BYTES;
  }
}
function stopInput(): void {
  process.stdin.off('data', consume);
  process.stdin.pause();
  void close().catch(() => { process.exitCode = 1; });
}
process.stdin.on('data', consume);
process.stdin.once('end', stopInput);
process.on("SIGTERM", stopInput);
process.on("SIGINT", stopInput);
// A killed desktop must not leave a browser supervisor with an inherited pipe still open.
const parent = process.ppid;
const heartbeat = setInterval(() => {
  try {
    process.kill(parent, 0);
  } catch {
    stopInput();
    clearInterval(heartbeat);
  }
}, 2000);
heartbeat.unref();
output({ protocol: 1, ready: true });
