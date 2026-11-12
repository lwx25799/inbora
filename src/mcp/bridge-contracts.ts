import { z } from 'zod';
import { Blocked } from '../core/contracts.js';

export const assistantRoute = '/inbora/assistant/v1';
export const maxAssistantRequestBytes = 100_000;
export const maxAssistantResponseBytes = 2_000_000;
export const bridgeRequestSchema = z.object({
  protocol: z.literal(1),
  runtime: z.string().min(1).max(1000),
  instanceId: z.uuid(),
  sessionId: z.uuid(),
  tool: z.string().regex(/^inbora_[a-z_]+$/u).max(80),
  args: z.record(z.string(), z.unknown()),
}).strict();
export const bridgeResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), instanceId: z.uuid(), result: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/u) }).strict(),
]);

export function assistantError(error: unknown): string {
  if (error instanceof Blocked && /^[A-Z][A-Z0-9_]{0,79}$/u.test(error.code)) return error.code;
  if (error instanceof z.ZodError) return 'ASSISTANT_INVALID_REQUEST';
  return 'ASSISTANT_OPERATION_FAILED';
}

export interface AssistantToolDefinition {
  description: string;
  inputSchema: z.ZodObject;
  outputSchema: z.ZodType;
}
export type AssistantToolRegistry = Record<string, AssistantToolDefinition>;
