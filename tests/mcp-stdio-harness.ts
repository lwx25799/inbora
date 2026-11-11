import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

interface RpcResponse { id?: number; result?: unknown; error?: { code: number; message: string } }
interface ToolResult { isError?: boolean; content?: { type: string; text: string }[]; structuredContent?: unknown }

/** Test-only wire driver; production MCP framing and negotiation are owned by the official SDK. */
export async function startMcpStdio(root: string, mode: 'source' | 'built') {
  const args = mode === 'source' ? ['--import', 'tsx', 'src/mcp/stdio.ts'] : ['dist/mcp/stdio.js'];
  const child = spawn(process.execPath, [...args, '--runtime', root], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map<number, { resolve: (value: RpcResponse) => void; reject: (error: Error) => void }>();
  let sequence = 0;
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', value => { stderr += value; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const result = JSON.parse(line) as RpcResponse;
    if (result.id !== undefined) {
      const request = pending.get(result.id);
      if (request) { pending.delete(result.id); request.resolve(result); }
    }
  });
  child.on('error', () => {
    for (const request of pending.values()) request.reject(Error('MCP_TEST_CHILD_FAILED'));
    pending.clear();
  });
  child.on('exit', () => {
    for (const request of pending.values()) request.reject(Error('MCP_TEST_CHILD_EXITED'));
    pending.clear();
  });
  function rpc(method: string, params: unknown): Promise<RpcResponse> {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error(`MCP_TEST_TIMEOUT_${method}`)); }, 15_000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  async function close(): Promise<void> {
    if (child.exitCode !== null) { lines.close(); return; }
    const exiting = once(child, 'exit');
    child.stdin.end();
    const watchdog = setTimeout(() => child.kill(), 3000);
    const [code] = await exiting;
    clearTimeout(watchdog);
    lines.close();
    if (code !== 0 || stderr) throw Error('MCP_TEST_CHILD_UNCLEAN_EXIT');
  }
  try {
    const ready = await rpc('initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'inbora-service-fixture', version: '1' },
    });
    if (ready.error) throw Error('MCP_TEST_HANDSHAKE_FAILED');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  } catch (error) { await close(); throw error; }
  return {
    rpc, close,
    async call(tool: string, args: unknown = {}): Promise<unknown> {
      const response = await rpc('tools/call', { name: tool, arguments: args });
      if (response.error) throw Error(`MCP_TEST_PROTOCOL_${response.error.code}`);
      const result = response.result as ToolResult;
      if (result.isError) throw Error(result.content?.find(content => content.type === 'text')?.text ?? 'MCP_TOOL_FAILED');
      return result.structuredContent;
    },
  };
}
