import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { AssistantBridgeClient } from './bridge-client.js';
import { createAssistantMcpServer } from './server.js';

// Startup and tools/list do not depend on the desktop being online. Each tool reports APP_NOT_RUNNING.
const argumentsValid = process.argv.length === 4 && process.argv[2] === '--runtime' && !!process.argv[3];
if (!argumentsValid) {
  process.stderr.write('INBORA_MCP_RUNTIME_ARGUMENT_REQUIRED\n');
  process.exitCode = 1;
} else {
  const bridge = new AssistantBridgeClient(process.argv[3]!);
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 128_000 });
  // The official entry selects 2025 initialize or 2026 discovery from the opening exchange.
  const handle = serveStdio(() => createAssistantMcpServer((tool, args) => bridge.call(tool, args)), { transport });
  process.on('SIGINT', () => { void handle.close(); });
  process.on('SIGTERM', () => { void handle.close(); });
}
