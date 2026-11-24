import { afterEach, expect, test } from 'vitest';
import { createServer, request } from 'node:http';
import { copyFile, readFile, access, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { z } from 'zod';
import { privateTemp } from '../helpers.js';
import { startAssistantControl } from '../../src/mcp/control-server.js';
import { AssistantBridgeClient } from '../../src/mcp/bridge-client.js';
import {
  canonicalAssistantRoot, readAssistantDiscovery, readAssistantDiscoverySnapshot, statAssistantDiscovery,
  discoveryFilename, publishAssistantDiscovery, type AssistantDiscovery,
} from '../../src/mcp/discovery.js';
import { assistantRoute, type AssistantToolRegistry } from '../../src/mcp/bridge-contracts.js';

const tools: AssistantToolRegistry = {
  inbora_get_status: {
    description: 'Synthetic status', inputSchema: z.object({}).strict(),
    outputSchema: z.object({ connected: z.boolean() }).strict(),
  },
  inbora_mark_all_read: {
    description: 'Synthetic mutation', inputSchema: z.object({ operationId: z.uuid() }).strict(),
    outputSchema: z.object({ operationId: z.uuid(), accepted: z.boolean() }).strict(),
  },
};
const running: { close: () => Promise<void> }[] = [];
const syntheticRoots: string[] = [];
function temporary(prefix: string): string {
  const root = privateTemp(prefix);
  syntheticRoots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(running.splice(0).map(server => server.close()));
  const base = resolve('.local/tests');
  for (const root of syntheticRoots.splice(0)) {
    expect(root.startsWith(`${base}\\`) || root.startsWith(`${base}/`)).toBe(true);
    await rm(root, { recursive: true, force: true });
  }
});

async function start(dispatch: (sessionId: string, tool: string, args: unknown) => Promise<unknown> = async () => ({ connected: true })) {
  const root = temporary('mcp-transport-');
  const control = await startAssistantControl({ root, dispatch, tools });
  running.push(control);
  return { root, control, descriptor: await readAssistantDiscovery(root), client: new AssistantBridgeClient(root, { tools }) };
}

async function raw(descriptor: AssistantDiscovery, options: {
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  route?: string;
} = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const body = JSON.stringify({
    protocol: 1, runtime: descriptor.runtime, instanceId: descriptor.instanceId,
    sessionId: randomUUID(), tool: 'inbora_get_status', args: {}, ...options.body,
  });
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port: descriptor.port, method: 'POST', path: options.route ?? assistantRoute,
      headers: { Authorization: `Bearer ${descriptor.secret}`, 'Content-Type': 'application/json', ...options.headers },
    }, response => {
      let value = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { value += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(value) as Record<string, unknown> }));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('DPAPI encrypts the entire descriptor, binds the runtime, and invalidates on close', async () => {
  const { root, control, descriptor, client } = await start();
  const bytes = await readFile(join(root, discoveryFilename));
  expect(bytes.includes(Buffer.from(descriptor.secret))).toBe(false);
  expect(bytes.includes(Buffer.from(root))).toBe(false);
  expect(descriptor.instanceId).toBe(control.instanceId);
  expect(await client.call('inbora_get_status', {})).toEqual({ connected: true });
  const other = temporary('mcp-wrong-runtime-');
  await copyFile(join(root, discoveryFilename), join(other, discoveryFilename));
  await expect(new AssistantBridgeClient(other, { tools }).call('inbora_get_status', {}))
    .rejects.toThrow('ASSISTANT_RUNTIME_MISMATCH');
  await control.close();
  await expect(client.call('inbora_get_status', {})).rejects.toThrow('APP_NOT_RUNNING');
  await expect(access(join(root, discoveryFilename))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('offline calls never initialize a directory or start a business service', async () => {
  const root = join(temporary('mcp-offline-'), 'not-created');
  await expect(new AssistantBridgeClient(root, { tools }).call('inbora_get_status', {})).rejects.toThrow('APP_NOT_RUNNING');
  await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('rejects missing authentication, browser Origin, incorrect Host, and non-whitelisted routes before dispatch', async () => {
  let calls = 0;
  const { descriptor } = await start(async () => { calls++; return { connected: true }; });
  for (const headers of [
    { Authorization: 'Bearer wrong' },
    { Origin: 'http://127.0.0.1' },
    { Host: 'untrusted.example' },
  ]) {
    const result = await raw(descriptor, { headers });
    expect(result.status).toBe(401);
    expect(result.body.error).toBe('ASSISTANT_AUTHENTICATION_FAILED');
  }
  expect((await raw(descriptor, { route: '/arbitrary-command' })).body.error).toBe('ASSISTANT_INVALID_REQUEST');
  expect(calls).toBe(0);
});

test('rejects stale instance, wrong runtime, unknown tools, and extra arguments', async () => {
  let calls = 0;
  const { descriptor } = await start(async () => { calls++; return { connected: true }; });
  const checks = [
    [{ instanceId: randomUUID() }, 'ASSISTANT_INSTANCE_CHANGED'],
    [{ runtime: join(descriptor.runtime, 'wrong') }, 'ASSISTANT_RUNTIME_MISMATCH'],
    [{ tool: 'inbora_arbitrary_sql' }, 'ASSISTANT_TOOL_NOT_ALLOWED'],
    [{ args: { arbitrary: true } }, 'ASSISTANT_INVALID_REQUEST'],
  ] as const;
  for (const [body, expected] of checks) expect((await raw(descriptor, { body })).body.error).toBe(expected);
  expect(calls).toBe(0);
});

test('invalid outputs and unexpected exceptions cannot return private values or stack traces', async () => {
  const sentinel = 'synthetic-private-body-must-stay-local';
  const first = await start(async () => ({ connected: true, secret: sentinel }));
  const invalid = await raw(first.descriptor);
  expect(invalid.body.error).toBe('ASSISTANT_RESPONSE_INVALID');
  expect(JSON.stringify(invalid)).not.toContain(sentinel);
  const second = await start(async () => { throw Error(sentinel); });
  const failed = await raw(second.descriptor);
  expect(failed.body.error).toBe('ASSISTANT_OPERATION_FAILED');
  expect(JSON.stringify(failed)).not.toContain(sentinel);
});

test('each stdio bridge has its own operation session', async () => {
  const sessions: string[] = [];
  const { root, client } = await start(async sessionId => { sessions.push(sessionId); return { connected: true }; });
  await client.call('inbora_get_status', {});
  await client.call('inbora_get_status', {});
  await new AssistantBridgeClient(root, { tools }).call('inbora_get_status', {});
  expect(sessions[0]).toBe(sessions[1]);
  expect(sessions[2]).not.toBe(sessions[0]);
});

test('timeout makes one write attempt and accepted work finishes after the requester disconnects', async () => {
  let complete!: () => void;
  const gate = new Promise<void>(resolve => { complete = resolve; });
  let calls = 0;
  let finished = false;
  const { root, control } = await start(async (_session, _tool, args) => {
    calls++;
    await gate;
    finished = true;
    return { operationId: (args as { operationId: string }).operationId, accepted: true };
  });
  const client = new AssistantBridgeClient(root, { tools, timeoutMs: 25 });
  await expect(client.call('inbora_mark_all_read', { operationId: randomUUID() }))
    .rejects.toThrow('ASSISTANT_REQUEST_TIMEOUT_QUERY_OPERATION');
  expect(calls).toBe(1);
  complete();
  await control.close();
  expect(finished).toBe(true);
  expect(calls).toBe(1);
});

test('new instance rotates credentials and old cleanup cannot erase its discovery', async () => {
  const { root, control, descriptor } = await start();
  await control.close();
  const replacement = await startAssistantControl({ root, tools, dispatch: async () => ({ connected: true }) });
  running.push(replacement);
  const fresh = await readAssistantDiscovery(root);
  expect(fresh.instanceId).not.toBe(descriptor.instanceId);
  expect(fresh.secret === descriptor.secret).toBe(false);
  const rejected = await raw({ ...descriptor, port: fresh.port });
  expect(rejected.body.error).toBe('ASSISTANT_AUTHENTICATION_FAILED');
  const unpublish = await publishAssistantDiscovery(fresh);
  const newer = { ...fresh, instanceId: randomUUID() };
  const removeNewer = await publishAssistantDiscovery(newer);
  await unpublish();
  expect((await readAssistantDiscovery(root)).instanceId).toBe(newer.instanceId);
  await removeNewer();
});

test('closing cancels an incomplete unaccepted HTTP body without dispatching or delaying shutdown', async () => {
  let calls = 0;
  const { descriptor, control } = await start(async () => { calls++; return { connected: true }; });
  const req = request({
    hostname: '127.0.0.1', port: descriptor.port, method: 'POST', path: assistantRoute,
    headers: { Authorization: `Bearer ${descriptor.secret}`, 'Content-Type': 'application/json',
      'Content-Length': 100, Expect: '100-continue' },
  });
  req.on('error', () => {});
  try {
    const continued = once(req, 'continue');
    req.flushHeaders();
    await continued;
    req.write('{');
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        control.close(),
        new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(Error('MCP_CLOSE_WAITED_ON_UNACCEPTED_BODY')), 500); }),
      ]);
    } finally { clearTimeout(watchdog); }
    expect(calls).toBe(0);
  } finally { req.destroy(); }
});

test('bridge caches decrypted discovery by file stamp and refreshes once on stale ECONNREFUSED or 401 without replaying accepted writes', async () => {
  const { root, control } = await start();
  let reads = 0;
  let stats = 0;
  const client = new AssistantBridgeClient(root, {
    tools,
    statDiscovery: async dir => { stats++; return statAssistantDiscovery(dir); },
    readDiscovery: async dir => { reads++; return readAssistantDiscoverySnapshot(dir); },
  });
  expect(await client.call('inbora_get_status', {})).toEqual({ connected: true });
  expect(await client.call('inbora_get_status', {})).toEqual({ connected: true });
  expect(await client.call('inbora_get_status', {})).toEqual({ connected: true });
  // Only the first call decrypts DPAPI; subsequent calls with unchanged mtimeMs+size hit memory cache.
  expect(reads).toBe(1);
  expect(stats).toBe(2);

  // Rotate backend instance and simulate coarse Windows mtime collision by freezing stat stamp to the old values.
  const staleStamp = await statAssistantDiscovery(root);
  await control.close();
  const replacement = await startAssistantControl({ root, tools, dispatch: async () => ({ connected: true }) });
  running.push(replacement);
  let phase = 0;
  const rotatedClient = new AssistantBridgeClient(root, {
    tools,
    statDiscovery: async () => staleStamp,
    readDiscovery: async dir => {
      phase++;
      const fresh = await readAssistantDiscoverySnapshot(dir);
      return { stamp: staleStamp, descriptor: fresh.descriptor };
    },
  });
  expect(await rotatedClient.call('inbora_get_status', {})).toEqual({ connected: true });
  expect(phase).toBe(1);
  // Swap running server while keeping stat stamp frozen so cache returns old port (ECONNREFUSED) -> clears cache and retries once.
  await replacement.close();
  const third = await startAssistantControl({ root, tools, dispatch: async () => ({ connected: true }) });
  running.push(third);
  expect(await rotatedClient.call('inbora_get_status', {})).toEqual({ connected: true });
  expect(phase).toBe(2);

  // Also test cached HTTP 401 -> clears cache, rereads fresh secret on same port, and succeeds on the single retry.
  const thirdSnapshot = await readAssistantDiscoverySnapshot(root);
  let authPhase = 0;
  const authServer = await start(async () => ({ connected: true }));
  const authClient = new AssistantBridgeClient(authServer.root, {
    tools,
    statDiscovery: async () => staleStamp,
    readDiscovery: async dir => {
      authPhase++;
      const fresh = await readAssistantDiscoverySnapshot(dir);
      return { stamp: staleStamp, descriptor: fresh.descriptor };
    },
  });
  expect(await authClient.call('inbora_get_status', {})).toEqual({ connected: true });
  expect(authPhase).toBe(1);
  // Simulate cached descriptor secret mismatch (401) while stat stamp stays unchanged.
  (authClient as unknown as { cached: { descriptor: AssistantDiscovery; stamp: typeof staleStamp } }).cached.descriptor = {
    ...authServer.descriptor,
    secret: '0'.repeat(64),
  };
  expect(await authClient.call('inbora_get_status', {})).toEqual({ connected: true });
  expect(authPhase).toBe(2);
  expect(thirdSnapshot.descriptor.instanceId).toBe(third.instanceId);
  expect(await client.call('inbora_get_status', {})).toEqual({ connected: true });
  expect(reads).toBe(2);
});

test('cached bridge never replays write tools on timeout or mid-flight disconnect even when discovery rotates', async () => {
  // Part A: Cached discovery hit + write tool timeout must not refresh or send a second write attempt.
  let releaseWrite!: () => void;
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  let primaryWrites = 0;
  let primaryFinished = false;
  const primary = await start(async (_session, tool, args) => {
    if (tool === 'inbora_get_status') return { connected: true };
    primaryWrites++;
    await writeGate;
    primaryFinished = true;
    return { operationId: (args as { operationId: string }).operationId, accepted: true };
  });
  let rotatedWrites = 0;
  const rotated = await start(async (_session, tool, args) => {
    if (tool === 'inbora_get_status') return { connected: true };
    rotatedWrites++;
    return { operationId: (args as { operationId: string }).operationId, accepted: true };
  });
  const primarySnapshot = await readAssistantDiscoverySnapshot(primary.root);
  const rotatedSnapshot = await readAssistantDiscoverySnapshot(rotated.root);

  let timeoutReads = 0;
  let timeoutStats = 0;
  const timeoutClient = new AssistantBridgeClient(primary.root, {
    tools,
    timeoutMs: 35,
    statDiscovery: async () => { timeoutStats++; return primarySnapshot.stamp; },
    readDiscovery: async () => {
      timeoutReads++;
      return timeoutReads === 1 ? primarySnapshot : rotatedSnapshot;
    },
  });
  expect(await timeoutClient.call('inbora_get_status', {})).toEqual({ connected: true });
  expect(timeoutReads).toBe(1);
  expect(timeoutStats).toBe(0);

  await expect(timeoutClient.call('inbora_mark_all_read', { operationId: randomUUID() }))
    .rejects.toThrow('ASSISTANT_REQUEST_TIMEOUT_QUERY_OPERATION');
  expect(timeoutStats).toBe(1);
  expect(timeoutReads).toBe(1);
  expect(primaryWrites).toBe(1);
  expect(rotatedWrites).toBe(0);
  releaseWrite();
  await primary.control.close();
  expect(primaryFinished).toBe(true);
  expect(primaryWrites).toBe(1);

  // Part B: Cached discovery hit + write tool mid-flight disconnect must not replay against a rotated instance.
  const disconnectRoot = temporary('mcp-cached-disconnect-');
  const canonicalRoot = await canonicalAssistantRoot(disconnectRoot);
  const instanceId = randomUUID();
  const secret = randomBytes(32).toString('hex');
  let disconnectWrites = 0;
  const rawServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { tool: string };
      if (payload.tool === 'inbora_get_status') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' });
        res.end(JSON.stringify({ ok: true, instanceId, result: { connected: true } }));
        return;
      }
      disconnectWrites++;
      req.socket.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    rawServer.once('error', reject);
    rawServer.listen(0, '127.0.0.1', () => {
      rawServer.removeListener('error', reject);
      resolve();
    });
  });
  const addr = rawServer.address();
  expect(addr && typeof addr !== 'string').toBe(true);
  const unpublish = await publishAssistantDiscovery({
    version: 1,
    runtime: canonicalRoot,
    instanceId,
    pid: process.pid,
    port: (addr as { port: number }).port,
    secret,
  });
  running.push({
    close: async () => {
      await unpublish();
      await new Promise<void>(resolve => rawServer.close(() => resolve()));
    },
  });
  const disconnectSnapshot = await readAssistantDiscoverySnapshot(disconnectRoot);

  let disconnectReads = 0;
  let disconnectStats = 0;
  const disconnectClient = new AssistantBridgeClient(disconnectRoot, {
    tools,
    statDiscovery: async () => { disconnectStats++; return disconnectSnapshot.stamp; },
    readDiscovery: async () => {
      disconnectReads++;
      return disconnectReads === 1 ? disconnectSnapshot : rotatedSnapshot;
    },
  });
  expect(await disconnectClient.call('inbora_get_status', {})).toEqual({ connected: true });
  expect(disconnectReads).toBe(1);
  expect(disconnectStats).toBe(0);

  await expect(disconnectClient.call('inbora_mark_all_read', { operationId: randomUUID() }))
    .rejects.toThrow('ASSISTANT_CONNECTION_LOST_QUERY_OPERATION');
  expect(disconnectStats).toBe(1);
  expect(disconnectReads).toBe(1);
  expect(disconnectWrites).toBe(1);
  expect(rotatedWrites).toBe(0);

  // Cache was invalidated on connection loss, so a subsequent explicit call refreshes discovery cleanly.
  expect(await disconnectClient.call('inbora_get_status', {})).toEqual({ connected: true });
  expect(disconnectReads).toBe(2);
  expect(rotatedWrites).toBe(0);
});
