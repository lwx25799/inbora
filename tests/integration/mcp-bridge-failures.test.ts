import { afterEach, expect, test } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { privateTemp } from '../helpers.js';
import { AssistantBridgeClient } from '../../src/mcp/bridge-client.js';
import { canonicalAssistantRoot, publishAssistantDiscovery } from '../../src/mcp/discovery.js';
import { maxAssistantResponseBytes, type AssistantToolRegistry } from '../../src/mcp/bridge-contracts.js';

const tools: AssistantToolRegistry = {
  inbora_get_status: { description: 'Synthetic status', inputSchema: z.object({}).strict(),
    outputSchema: z.object({ connected: z.boolean() }).strict() },
  inbora_mark_all_read: { description: 'Synthetic mutation', inputSchema: z.object({ operationId: z.uuid() }).strict(),
    outputSchema: z.object({ operationId: z.uuid() }).strict() },
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

async function peer(handler: (request: IncomingMessage, response: ServerResponse, instanceId: string) => void) {
  const root = await canonicalAssistantRoot(privateTemp('mcp-peer-failure-'));
  const instanceId = randomUUID();
  let calls = 0;
  const server = createServer((request, response) => {
    calls++;
    request.resume();
    request.on('end', () => handler(request, response, instanceId));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('SYNTHETIC_LISTENER_INVALID');
  const unpublish = await publishAssistantDiscovery({
    version: 1, runtime: root, instanceId, pid: process.pid, port: address.port,
    secret: randomBytes(32).toString('hex'),
  });
  cleanups.push(async () => {
    await unpublish();
    await new Promise<void>(resolve => server.close(() => resolve()));
    const base = resolve('.local/tests');
    expect(root.startsWith(`${base}\\`) || root.startsWith(`${base}/`)).toBe(true);
    await rm(root, { recursive: true, force: true });
  });
  return { client: new AssistantBridgeClient(root, { tools }), calls: () => calls };
}

test.each([
  { name: 'invalid JSON', body: '{synthetic-private-body', expected: 'ASSISTANT_RESPONSE_INVALID' },
  { name: 'unexpected envelope field', body: JSON.stringify({ ok: false, error: 'PERMISSION_REQUIRED', private: 'body' }), expected: 'ASSISTANT_RESPONSE_INVALID' },
  { name: 'unsafe error string', body: JSON.stringify({ ok: false, error: 'private body and file path' }), expected: 'ASSISTANT_RESPONSE_INVALID' },
  { name: 'raw object without envelope', body: JSON.stringify({ connected: true }), expected: 'ASSISTANT_RESPONSE_INVALID' },
])('malformed peer response: $name is rejected and a write is never retried', async ({ body, expected }) => {
  const { client, calls } = await peer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(body);
  });
  await expect(client.call('inbora_mark_all_read', { operationId: randomUUID() })).rejects.toThrow(expected);
  expect(calls()).toBe(1);
});

test('valid envelope from the wrong instance cannot be accepted', async () => {
  const { client, calls } = await peer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, instanceId: randomUUID(), result: { connected: true } }));
  });
  await expect(client.call('inbora_get_status', {})).rejects.toThrow('ASSISTANT_RESPONSE_INVALID');
  expect(calls()).toBe(1);
});

test('unexpected private fields in an otherwise valid output never reach a caller', async () => {
  const { client } = await peer((_request, response, instanceId) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, instanceId, result: { connected: true, private: 'synthetic body' } }));
  });
  await expect(client.call('inbora_get_status', {})).rejects.toThrow('ASSISTANT_RESPONSE_INVALID');
});

test('redirect responses are rejected without following any URL', async () => {
  const { client, calls } = await peer((_request, response, instanceId) => {
    response.writeHead(307, { 'Content-Type': 'application/json', Location: 'http://127.0.0.1:1/never-follow' });
    response.end(JSON.stringify({ ok: true, instanceId, result: { connected: true } }));
  });
  await expect(client.call('inbora_get_status', {})).rejects.toThrow('ASSISTANT_RESPONSE_INVALID');
  expect(calls()).toBe(1);
});

test('oversized response is bounded and rejected', async () => {
  const { client, calls } = await peer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('x'.repeat(maxAssistantResponseBytes + 1));
  });
  await expect(client.call('inbora_get_status', {})).rejects.toThrow('ASSISTANT_RESPONSE_TOO_LARGE');
  expect(calls()).toBe(1);
});

test('disconnect after the request body is accepted returns query guidance and never replays the write', async () => {
  let accepted = 0;
  const { client, calls } = await peer((request, _response) => {
    accepted++;
    request.socket.destroy();
  });
  await expect(client.call('inbora_mark_all_read', { operationId: randomUUID() }))
    .rejects.toThrow('ASSISTANT_CONNECTION_LOST_QUERY_OPERATION');
  expect(calls()).toBe(1);
  expect(accepted).toBe(1);
});
