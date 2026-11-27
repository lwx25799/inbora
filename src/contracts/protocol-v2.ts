import { z } from 'zod';
import { accountRefSchema } from './account.js';
import { commandSchema, protocolVersion, protocolVersionV2 } from './client.js';

export const PROTOCOL_V1 = protocolVersion;
export const PROTOCOL_V2 = protocolVersionV2;
export const MAX_PROTOCOL_V2_FRAME_BYTES = 1_048_576;

export const protocolScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('GLOBAL') }).strict(),
  z.object({ kind: z.literal('ACCOUNT'), accountRef: accountRefSchema }).strict(),
]);
export type ProtocolScope = z.infer<typeof protocolScopeSchema>;

const protocol = z.literal(PROTOCOL_V2);
const responseFields = { protocol, requestId: z.uuid() };

export const protocolV2RequestEnvelopeSchema = z.object({
  ...responseFields,
  secret: z.string().length(64),
  scope: protocolScopeSchema,
  commandId: z.uuid().optional(),
  body: z.unknown(),
}).strict();
export type ProtocolV2RequestEnvelope = z.infer<typeof protocolV2RequestEnvelopeSchema>;

export const protocolV2ResponseEnvelopeSchema = z.discriminatedUnion('ok', [
  z.object({ ...responseFields, ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ ...responseFields, ok: z.literal(false), error: z.string() }).strict(),
]);
export type ProtocolV2ResponseEnvelope = z.infer<typeof protocolV2ResponseEnvelopeSchema>;

export const protocolV2EventEnvelopeSchema = z.object({
  protocol,
  scope: protocolScopeSchema,
  event: z.unknown(),
}).strict();
export type ProtocolV2EventEnvelope = z.infer<typeof protocolV2EventEnvelopeSchema>;

// The desktop sends these lifecycle commands outside the client business-command union.
const lifecycleCommandSchema = z.discriminatedUnion('command', [
  z.object({
    command: z.literal('connect'),
    runtime: z.string().min(1).max(1000),
    initialize: z.boolean(),
    consent: z.literal(true),
  }).strict(),
  z.object({ command: z.literal('disconnect') }).strict(),
]);
const protocolCommandSchema = z.union([lifecycleCommandSchema, commandSchema]);

export function requiredScopeForCommand(body: unknown): 'GLOBAL' | 'ACCOUNT' | null {
  const parsed = protocolCommandSchema.safeParse(body);
  if (!parsed.success) return null;
  const command = parsed.data;

  switch (command.command) {
    case 'connect':
    case 'disconnect':
    case 'emergencyStop':
    case 'modelProviders':
      return 'GLOBAL';
    case 'accounts':
      return command.action === 'listAccounts' || command.action === 'registerAccount' ? 'GLOBAL' : 'ACCOUNT';
    default:
      return 'ACCOUNT';
  }
}

export function isMutatingClientCommand(body: unknown): boolean {
  const parsed = protocolCommandSchema.safeParse(body);
  if (!parsed.success) return false;
  const command = parsed.data;

  switch (command.command) {
    case 'getStatus':
    case 'getDiagnostics':
    case 'getInbox':
    case 'getThread':
    case 'getAudit':
    case 'getSendResult':
      return false;
    case 'getMessagePreview':
      return command.refresh === true;
    case 'replyKnowledge':
      return command.action !== 'overview'
        && command.action !== 'debugRetrieval'
        && command.action !== 'embeddingStatus';
    case 'modelProviders':
      return command.action !== 'list';
    case 'accounts':
      return command.action !== 'listAccounts'
        && command.action !== 'getAccountStatus'
        && command.action !== 'getOfficialChannelConfig';
    default:
      return true;
  }
}
