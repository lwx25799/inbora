import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Blocked, requireSafe } from '../core/contracts.js';
import { assistantTools } from './tool-contracts.js';
import { readAssistantDiscovery } from './discovery.js';
import {
  assistantRoute, browserResourcesHeader, bridgeResponseSchema, maxAssistantRequestBytes, maxAssistantResponseBytes,
  type AssistantToolRegistry,
} from './bridge-contracts.js';

export class AssistantBridgeClient {
  readonly sessionId = randomUUID();
  constructor(private readonly root: string, private readonly options: {
    timeoutMs?: number;
    tools?: AssistantToolRegistry;
  } = {}) {}

  async call(tool: string, args: unknown): Promise<unknown> {
    const registry: AssistantToolRegistry = this.options.tools ?? assistantTools;
    const definition = Object.hasOwn(registry, tool) ? registry[tool] : undefined;
    requireSafe(definition, 'ASSISTANT_TOOL_NOT_ALLOWED');
    const input = definition.inputSchema.safeParse(args);
    requireSafe(input.success, 'ASSISTANT_INVALID_REQUEST');
    const descriptor = await readAssistantDiscovery(this.root);
    try { process.kill(descriptor.pid, 0); }
    catch { throw new Blocked('APP_NOT_RUNNING'); }
    const body = JSON.stringify({
      protocol: 1, runtime: descriptor.runtime, instanceId: descriptor.instanceId,
      sessionId: this.sessionId, tool, args: input.data,
    });
    requireSafe(Buffer.byteLength(body) <= maxAssistantRequestBytes, 'ASSISTANT_REQUEST_TOO_LARGE');
    const value = await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const finish = (error: Blocked | null, result?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(result);
      };
      const req = request({
        hostname: '127.0.0.1', port: descriptor.port, path: assistantRoute, method: 'POST', agent: false,
        headers: {
          Authorization: `Bearer ${descriptor.secret}`, 'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body), Connection: 'close',
          ...(tool === 'inbora_get_diagnostics' ? { [browserResourcesHeader]: '1' } : {}),
        },
      }, response => {
        let bytes = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxAssistantResponseBytes) {
            finish(new Blocked('ASSISTANT_RESPONSE_TOO_LARGE'));
            response.destroy();
          } else chunks.push(chunk);
        });
        response.on('error', () => finish(new Blocked('ASSISTANT_CONNECTION_LOST_QUERY_OPERATION')));
        response.on('end', () => {
          try {
            requireSafe(response.headers['content-type']?.startsWith('application/json'), 'ASSISTANT_RESPONSE_INVALID');
            const parsed = bridgeResponseSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            requireSafe(parsed.success, 'ASSISTANT_RESPONSE_INVALID');
            if (!parsed.data.ok) return finish(new Blocked(parsed.data.error));
            requireSafe(response.statusCode === 200 && parsed.data.instanceId === descriptor.instanceId,
              'ASSISTANT_INSTANCE_CHANGED');
            finish(null, parsed.data.result);
          } catch { finish(new Blocked('ASSISTANT_RESPONSE_INVALID')); }
        });
      });
      const timer = setTimeout(() => {
        finish(new Blocked('ASSISTANT_REQUEST_TIMEOUT_QUERY_OPERATION'));
        req.destroy();
      }, this.options.timeoutMs ?? 15_000);
      req.on('error', (error: NodeJS.ErrnoException) => finish(new Blocked(
        error.code === 'ECONNREFUSED' ? 'APP_NOT_RUNNING' : 'ASSISTANT_CONNECTION_LOST_QUERY_OPERATION',
      )));
      // This is intentionally the only write attempt. Recovery is get_operation, never replay.
      req.end(body);
    });
    const output = definition.outputSchema.safeParse(value);
    requireSafe(output.success, 'ASSISTANT_RESPONSE_INVALID');
    return output.data;
  }
}
