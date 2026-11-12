import { McpServer } from '@modelcontextprotocol/server';
import { requireSafe } from '../core/contracts.js';
import { assistantTools } from './tool-contracts.js';
import { assistantError, type AssistantToolRegistry } from './bridge-contracts.js';

const readOnly = new Set([
  'inbora_get_status', 'inbora_list_inbox', 'inbora_get_thread', 'inbora_get_diagnostics',
  'inbora_inspect_preview', 'inbora_get_operation',
]);
const external = new Set([
  'inbora_sync_inbox', 'inbora_refresh_preview', 'inbora_generate_suggestion',
  'inbora_send_reply', 'inbora_set_automatic_reply',
]);

export function createAssistantMcpServer(
  call: (tool: string, args: unknown) => Promise<unknown>,
  registry: AssistantToolRegistry = assistantTools,
): McpServer {
  const server = new McpServer({ name: 'inbora', version: '0.3.5' }, { maxToolInputElements: 100 });
  for (const [name, definition] of Object.entries(registry)) {
    server.registerTool(name, {
      description: definition.description,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
      annotations: {
        readOnlyHint: readOnly.has(name),
        destructiveHint: !readOnly.has(name),
        idempotentHint: readOnly.has(name),
        openWorldHint: external.has(name),
      },
    }, async args => {
      try {
        const result = await call(name, args);
        const output = definition.outputSchema.safeParse(result);
        requireSafe(output.success, 'ASSISTANT_RESPONSE_INVALID');
        return {
          content: [{ type: 'text', text: JSON.stringify(output.data) }],
          structuredContent: output.data,
        };
      } catch (error) {
        // Never let SDK diagnostics interpolate private payloads or original errors.
        return { content: [{ type: 'text', text: assistantError(error) }], isError: true };
      }
    });
  }
  return server;
}
