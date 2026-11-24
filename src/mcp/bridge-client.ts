import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Blocked, requireSafe } from '../core/contracts.js';
import { assistantTools } from './tool-contracts.js';
import {
  readAssistantDiscoverySnapshot,
  statAssistantDiscovery,
  type AssistantDiscovery,
  type AssistantDiscoverySnapshot,
  type AssistantDiscoveryStamp,
} from './discovery.js';
import {
  assistantRoute, browserResourcesHeader, securityStatusHeader, bridgeResponseSchema, maxAssistantRequestBytes, maxAssistantResponseBytes,
  type AssistantToolRegistry,
} from './bridge-contracts.js';

interface AttemptResult {
  value?: unknown;
  error?: Blocked;
  retryableStaleDiscovery?: boolean;
  invalidateCache?: boolean;
}

export class AssistantBridgeClient {
  readonly sessionId = randomUUID();
  private cached: AssistantDiscoverySnapshot | null = null;
  constructor(private readonly root: string, private readonly options: {
    timeoutMs?: number;
    tools?: AssistantToolRegistry;
    statDiscovery?: (root: string) => Promise<AssistantDiscoveryStamp>;
    readDiscovery?: (root: string) => Promise<AssistantDiscoverySnapshot>;
  } = {}) {}

  private isAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch { return false; }
  }

  private async resolveDiscovery(forceRefresh: boolean): Promise<{ descriptor: AssistantDiscovery; fromCache: boolean }> {
    const statFn = this.options.statDiscovery ?? statAssistantDiscovery;
    const readFn = this.options.readDiscovery ?? readAssistantDiscoverySnapshot;
    if (!forceRefresh && this.cached) {
      let stamp: AssistantDiscoveryStamp;
      try { stamp = await statFn(this.root); }
      catch (error) { this.cached = null; throw error; }
      if (
        stamp.canonical === this.cached.stamp.canonical &&
        stamp.mtimeMs === this.cached.stamp.mtimeMs &&
        stamp.size === this.cached.stamp.size &&
        this.isAlive(this.cached.descriptor.pid)
      ) {
        return { descriptor: this.cached.descriptor, fromCache: true };
      }
      this.cached = null;
    }
    let snapshot: AssistantDiscoverySnapshot;
    try { snapshot = await readFn(this.root); }
    catch (error) { this.cached = null; throw error; }
    if (!this.isAlive(snapshot.descriptor.pid)) {
      this.cached = null;
      throw new Blocked('APP_NOT_RUNNING');
    }
    this.cached = snapshot;
    return { descriptor: snapshot.descriptor, fromCache: false };
  }

  private sendOnce(descriptor: AssistantDiscovery, tool: string, data: unknown): Promise<AttemptResult> {
    const body = JSON.stringify({
      protocol: 1, runtime: descriptor.runtime, instanceId: descriptor.instanceId,
      sessionId: this.sessionId, tool, args: data,
    });
    requireSafe(Buffer.byteLength(body) <= maxAssistantRequestBytes, 'ASSISTANT_REQUEST_TOO_LARGE');
    return new Promise<AttemptResult>(resolve => {
      let settled = false;
      const finish = (outcome: AttemptResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      const req = request({
        hostname: '127.0.0.1', port: descriptor.port, path: assistantRoute, method: 'POST', agent: false,
        headers: {
          Authorization: `Bearer ${descriptor.secret}`, 'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body), Connection: 'close',
          ...(tool === 'inbora_get_diagnostics' ? { [browserResourcesHeader]: '1' } : {}),
          ...(tool === 'inbora_get_status' ? { [securityStatusHeader]: '1' } : {}),
        },
      }, response => {
        let bytes = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxAssistantResponseBytes) {
            finish({ error: new Blocked('ASSISTANT_RESPONSE_TOO_LARGE') });
            response.destroy();
          } else chunks.push(chunk);
        });
        response.on('error', () => finish({
          error: new Blocked('ASSISTANT_CONNECTION_LOST_QUERY_OPERATION'),
          invalidateCache: true,
        }));
        response.on('end', () => {
          try {
            requireSafe(response.headers['content-type']?.startsWith('application/json'), 'ASSISTANT_RESPONSE_INVALID');
            const parsed = bridgeResponseSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            requireSafe(parsed.success, 'ASSISTANT_RESPONSE_INVALID');
            if (!parsed.data.ok) {
              const stale = (response.statusCode === 401 && parsed.data.error === 'ASSISTANT_AUTHENTICATION_FAILED') ||
                parsed.data.error === 'ASSISTANT_INSTANCE_CHANGED';
              return finish({
                error: new Blocked(parsed.data.error),
                retryableStaleDiscovery: stale,
                invalidateCache: stale,
              });
            }
            requireSafe(response.statusCode === 200 && parsed.data.instanceId === descriptor.instanceId,
              'ASSISTANT_INSTANCE_CHANGED');
            finish({ value: parsed.data.result });
          } catch { finish({ error: new Blocked('ASSISTANT_RESPONSE_INVALID') }); }
        });
      });
      const timer = setTimeout(() => {
        finish({ error: new Blocked('ASSISTANT_REQUEST_TIMEOUT_QUERY_OPERATION'), invalidateCache: true });
        req.destroy();
      }, this.options.timeoutMs ?? 15_000);
      req.on('error', (error: NodeJS.ErrnoException) => {
        const refused = error.code === 'ECONNREFUSED';
        finish({
          error: new Blocked(refused ? 'APP_NOT_RUNNING' : 'ASSISTANT_CONNECTION_LOST_QUERY_OPERATION'),
          retryableStaleDiscovery: refused,
          invalidateCache: true,
        });
      });
      // This is intentionally the only write attempt. Recovery is get_operation, never replay.
      req.end(body);
    });
  }

  async call(tool: string, args: unknown): Promise<unknown> {
    const registry: AssistantToolRegistry = this.options.tools ?? assistantTools;
    const definition = Object.hasOwn(registry, tool) ? registry[tool] : undefined;
    requireSafe(definition, 'ASSISTANT_TOOL_NOT_ALLOWED');
    const input = definition.inputSchema.safeParse(args);
    requireSafe(input.success, 'ASSISTANT_INVALID_REQUEST');
    const first = await this.resolveDiscovery(false);
    let outcome = await this.sendOnce(first.descriptor, tool, input.data);
    if (outcome.invalidateCache) this.cached = null;
    if (outcome.error && first.fromCache && outcome.retryableStaleDiscovery) {
      // Only retry when a cached descriptor failed before dispatch (ECONNREFUSED / 401 / instance changed) and discovery rotated.
      const refreshed = await this.resolveDiscovery(true);
      const changed = refreshed.descriptor.instanceId !== first.descriptor.instanceId ||
        refreshed.descriptor.port !== first.descriptor.port ||
        refreshed.descriptor.secret !== first.descriptor.secret;
      if (changed) {
        outcome = await this.sendOnce(refreshed.descriptor, tool, input.data);
        if (outcome.invalidateCache) this.cached = null;
      }
    }
    if (outcome.error) throw outcome.error;
    const output = definition.outputSchema.safeParse(outcome.value);
    requireSafe(output.success, 'ASSISTANT_RESPONSE_INVALID');
    return output.data;
  }
}
