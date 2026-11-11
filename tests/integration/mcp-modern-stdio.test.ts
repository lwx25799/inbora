import { expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server';
import { privateTemp } from '../helpers.js';

interface Response { id: number; result?: Record<string, unknown>; error?: { code: number; message: string } }

test('actual stdio entry discovers 2026 protocol tools and reports offline without a legacy initialize', async () => {
  const root = privateTemp('mcp-modern-');
  const args = process.env.INBORA_MCP_BUILT_TEST === '1' ? ['dist/mcp/stdio.js'] : ['--import', 'tsx', 'src/mcp/stdio.ts'];
  const child = spawn(process.execPath, [...args, '--runtime', join(root, 'not-created')], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  const pending = new Map<number, { resolve: (response: Response) => void; reject: (error: Error) => void }>();
  let next = 0;
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', value => { stderr += value; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const response = JSON.parse(line) as Response;
    pending.get(response.id)?.resolve(response);
    pending.delete(response.id);
  });
  child.on('error', () => {
    for (const request of pending.values()) request.reject(Error('MCP_MODERN_CHILD_FAILED'));
  });
  child.on('exit', () => {
    for (const request of pending.values()) request.reject(Error('MCP_MODERN_CHILD_EXITED'));
  });
  function rpc(method: string, params: Record<string, unknown>): Promise<Response> {
    const id = ++next;
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error('MCP_MODERN_TIMEOUT')); }, 5000);
      pending.set(id, {
        resolve: value => { clearTimeout(timer); accept(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: {
        [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
        [CLIENT_INFO_META_KEY]: { name: 'inbora-modern-fixture', version: '1' },
        [CLIENT_CAPABILITIES_META_KEY]: {},
      } } }) + '\n');
    });
  }
  try {
    const discovered = await rpc('server/discover', {});
    expect(discovered.error).toBeUndefined();
    expect(discovered.result?.supportedVersions).toContain('2026-07-28');
    const listed = await rpc('tools/list', {});
    expect(listed.error).toBeUndefined();
    expect(listed.result?.tools).toHaveLength(16);
    const status = await rpc('tools/call', { name: 'inbora_get_status', arguments: {} });
    expect(status.error).toBeUndefined();
    expect(status.result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'APP_NOT_RUNNING' }] });
    child.stdin.end();
    const [code] = await exited;
    expect(code).toBe(0);
    expect(stderr).toBe('');
  } finally {
    if (child.exitCode === null) child.kill();
    await exited;
    lines.close();
    const base = resolve('.local/tests');
    expect(root.startsWith(`${base}\\`) || root.startsWith(`${base}/`)).toBe(true);
    await rm(root, { recursive: true, force: true });
  }
});
