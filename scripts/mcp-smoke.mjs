import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

const source = process.argv.includes('--source');
const base = resolve('.local/tests');
await mkdir(base, { recursive: true });
const root = await mkdtemp(join(base, 'mcp-stdio-'));
let control;
let mutationCount = 0;
if (process.argv.includes('--connected-fixture')) {
  const { startAssistantControl } = await import('../dist/mcp/control-server.js');
  control = await startAssistantControl({ root, dispatch: async (_session, tool, args) => {
    if (tool === 'inbora_get_status') return {
      runtime: root, instanceId: control.instanceId, connected: true, accountConnected: false,
      browser: { state: 'CLOSED', mode: null }, automaticReply: false, emergencyStopped: false,
      budgets: [{ kind: 'MODEL', used: 7, maximum: 50 }, { kind: 'SEND', used: 9, maximum: 20 }],
      assistant: { enabled: false, grantVersion: null, expiresAt: null,
        permissions: { read: false, editControl: false, send: false },
        remaining: { MODEL: 0, SEND: 0 }, reason: 'ASSISTANT_PERMISSION_REQUIRED' },
      sync: { runId: null, running: false, cancelled: false, source: null, results: [] },
    };
    assert.equal(tool, 'inbora_mark_all_read');
    mutationCount++;
    return { operationId: args.operationId, tool, state: 'SUCCEEDED', eventId: null,
      result: { kind: 'read', marked: 3 }, error: null, createdAt: 1, updatedAt: 1 };
  } });
}
// The fixture is deliberately offline: handshake/discovery must still work without a Sidecar.
const args = source ? ['--import', 'tsx', 'src/mcp/stdio.ts'] : ['dist/mcp/stdio.js'];
const child = spawn(process.execPath, [...args, '--runtime', root], {
  windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map();
let nextId = 0;
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', value => { stderr += value; });
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  const result = JSON.parse(line);
  if (result.id !== undefined) {
    const waiter = pending.get(result.id);
    if (waiter) { pending.delete(result.id); waiter.resolve(result); }
  }
});
function rpc(method, params, notification = false) {
  const id = ++nextId;
  const payload = { jsonrpc: '2.0', method, params, ...(notification ? {} : { id }) };
  if (notification) { child.stdin.write(`${JSON.stringify(payload)}\n`); return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`SMOKE_TIMEOUT_${method}`)); }, 15_000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); } });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  });
}

try {
  const initialized = await rpc('initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'inbora-synthetic-check', version: '1' },
  });
  assert.equal(initialized.result.serverInfo.name, 'inbora');
  assert.ok(initialized.result.protocolVersion);
  await rpc('notifications/initialized', {}, true);
  const listed = await rpc('tools/list', {});
  assert.equal(listed.result.tools.length, 16);
  for (const tool of listed.result.tools) {
    assert.ok(tool.name.startsWith('inbora_'));
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.outputSchema);
  }
  const status = await rpc('tools/call', { name: 'inbora_get_status', arguments: {} });
  if (control) {
    assert.equal(status.result.structuredContent.runtime, root);
    assert.equal(status.result.structuredContent.instanceId, control.instanceId);
    assert.equal(status.result.structuredContent.budgets[1].used, 9);
    const operationId = randomUUID();
    const changed = await rpc('tools/call', { name: 'inbora_mark_all_read', arguments: { operationId } });
    assert.equal(changed.result.structuredContent.operationId, operationId);
    assert.deepEqual(changed.result.structuredContent.result, { kind: 'read', marked: 3 });
    assert.equal(mutationCount, 1);
  } else {
    assert.equal(status.result.isError, true);
    assert.equal(status.result.content[0].text, 'APP_NOT_RUNNING');
  }
  const invalid = await rpc('tools/call', { name: 'inbora_get_status', arguments: { command: 'arbitrary' } });
  assert.equal(invalid.result.isError, true);
  const shutdown = once(child, 'exit');
  child.stdin.end();
  const [code] = await shutdown;
  assert.equal(code, 0);
  assert.equal(stderr, '');
  console.log(JSON.stringify({ mode: source ? 'tsx' : 'built-node', handshake: 'PASS', tools: 16,
    ...(control ? { authenticatedFixture: 'PASS', mutations: mutationCount } : { offline: 'APP_NOT_RUNNING' }), exitedOnEof: true }));
} finally {
  if (child.exitCode === null) child.kill();
  await control?.close();
  lines.close();
  // This exact freshly-created synthetic runtime contains no user data.
  assert.ok(root.startsWith(`${base}\\`) || root.startsWith(`${base}/`));
  await rm(root, { recursive: true, force: true });
}
