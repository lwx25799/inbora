import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { requireSafe } from '../core/contracts.js';
import { assistantTools } from './tool-contracts.js';
import { canonicalAssistantRoot, publishAssistantDiscovery } from './discovery.js';
import {
  assistantError, assistantRoute, browserResourcesHeader, bridgeRequestSchema, maxAssistantRequestBytes,
  maxAssistantResponseBytes, type AssistantToolRegistry,
} from './bridge-contracts.js';

export interface AssistantControlOptions {
  root: string;
  dispatch: (sessionId: string, tool: string, args: unknown) => Promise<unknown>;
  tools?: AssistantToolRegistry;
}

function oneHeader(request: IncomingMessage, name: string): boolean {
  return request.rawHeaders.filter((_, index) => index % 2 === 0)
    .filter(header => header.toLowerCase() === name).length === 1;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  const text = JSON.stringify(body);
  requireSafe(Buffer.byteLength(text) <= maxAssistantResponseBytes, 'ASSISTANT_RESPONSE_TOO_LARGE');
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Connection: 'close',
  });
  response.end(text);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const part of request) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.byteLength;
    requireSafe(size <= maxAssistantRequestBytes, 'ASSISTANT_REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { requireSafe(false, 'ASSISTANT_INVALID_REQUEST'); }
}

export async function startAssistantControl(options: AssistantControlOptions): Promise<{
  instanceId: string;
  close: () => Promise<void>;
}> {
  const root = await canonicalAssistantRoot(options.root);
  const instanceId = randomUUID();
  const secret = randomBytes(32).toString('hex');
  const registry: AssistantToolRegistry = options.tools ?? assistantTools;
  let port = 0;
  let closing = false;
  let closeTask: Promise<void> | undefined;
  const active = new Set<Promise<void>>();
  const unaccepted = new Set<IncomingMessage>();
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      requireSafe(!closing, 'APP_NOT_RUNNING');
      requireSafe(request.socket.remoteAddress === '127.0.0.1', 'ASSISTANT_AUTHENTICATION_FAILED');
      requireSafe(request.method === 'POST' && request.url === assistantRoute, 'ASSISTANT_INVALID_REQUEST');
      requireSafe(oneHeader(request, 'host') && request.headers.host === `127.0.0.1:${port}` &&
        request.headers.origin === undefined, 'ASSISTANT_AUTHENTICATION_FAILED');
      const supplied = request.headers.authorization ?? '';
      const expected = `Bearer ${secret}`;
      const suppliedBytes = Buffer.from(supplied);
      const expectedBytes = Buffer.from(expected);
      requireSafe(oneHeader(request, 'authorization') && suppliedBytes.length === expectedBytes.length &&
        timingSafeEqual(suppliedBytes, expectedBytes), 'ASSISTANT_AUTHENTICATION_FAILED');
      const resourcesHeader = request.headers[browserResourcesHeader];
      requireSafe(resourcesHeader === undefined || oneHeader(request, browserResourcesHeader) && resourcesHeader === '1',
        'ASSISTANT_INVALID_REQUEST');
      requireSafe(request.headers['content-type'] === 'application/json', 'ASSISTANT_INVALID_REQUEST');
      const envelope = bridgeRequestSchema.parse(await readBody(request));
      requireSafe(!closing, 'APP_NOT_RUNNING');
      requireSafe(envelope.runtime === root, 'ASSISTANT_RUNTIME_MISMATCH');
      requireSafe(envelope.instanceId === instanceId, 'ASSISTANT_INSTANCE_CHANGED');
      const definition = Object.hasOwn(registry, envelope.tool) ? registry[envelope.tool] : undefined;
      requireSafe(definition, 'ASSISTANT_TOOL_NOT_ALLOWED');
      const input = definition.inputSchema.safeParse(envelope.args);
      requireSafe(input.success, 'ASSISTANT_INVALID_REQUEST');
      unaccepted.delete(request);
      // An HTTP disconnect does not cancel accepted work or cause a second dispatch.
      const result = await options.dispatch(envelope.sessionId, envelope.tool, input.data);
      const checked = definition.outputSchema.safeParse(result);
      requireSafe(checked.success, 'ASSISTANT_RESPONSE_INVALID');
      let compatible = checked.data;
      if (envelope.tool === 'inbora_get_diagnostics' && resourcesHeader === undefined &&
        compatible !== null && typeof compatible === 'object' && !Array.isArray(compatible)) {
        // Existing stdio processes retain the previous strict output schema until their next start.
        const legacy: Record<string, unknown> = { ...compatible };
        delete legacy.browserResources;
        compatible = legacy;
      }
      send(response, 200, { ok: true, instanceId, result: compatible });
    } catch (error) {
      const code = assistantError(error);
      send(response, code === 'ASSISTANT_AUTHENTICATION_FAILED' ? 401 : 400, { ok: false, error: code });
    } finally { unaccepted.delete(request); }
  };
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15_000, headersTimeout: 10_000 }, (request, response) => {
    unaccepted.add(request);
    const task = handle(request, response);
    active.add(task);
    void task.finally(() => active.delete(task)).catch(() => {});
  });
  server.maxConnections = 16;
  server.on('clientError', (_, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  requireSafe(address && typeof address !== 'string', 'ASSISTANT_CONTROL_START_FAILED');
  port = address.port;
  let unpublish: () => Promise<void>;
  try {
    unpublish = await publishAssistantDiscovery({ version: 1, runtime: root, instanceId, pid: process.pid, port, secret });
  } catch (error) {
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw error;
  }
  return {
    instanceId,
    close: () => {
      if (closeTask) return closeTask;
      closing = true;
      closeTask = (async () => {
        // Invalidate discovery before draining requests. Existing accepted operations keep their ledger.
        const stopped = new Promise<void>(resolve => server.close(() => resolve()));
        server.closeIdleConnections();
        // Incomplete bodies have no accepted operation. They must not hold the old backend open.
        for (const request of unaccepted) request.destroy();
        try { await unpublish(); }
        finally { await Promise.allSettled([...active]); await stopped; }
      })();
      return closeTask;
    },
  };
}
