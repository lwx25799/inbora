import { z } from 'zod';
import { accountIdSchema } from './account.js';
import { channelSchema, eventSchema } from './events.js';

export const MAX_WORKER_FRAME_BYTES = 1_048_576;

const intentId = z.uuid();
const ownerEpoch = z.number().int().nonnegative();
const notBefore = z.string().min(1).max(64);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);

export const WorkerSendBindingSchema = z.object({
  intentId,
  nonce: z.uuid(),
  sessionId: z.uuid(),
  ownerEpoch,
  notBefore,
  permitExpiresAt: z.int().positive().optional(),
  sendEpoch: z.int().nonnegative().optional(),
  textDigest: digest,
  targetDigest: digest,
}).strict();
export type WorkerSendBinding = z.infer<typeof WorkerSendBindingSchema>;

const target = z.object({
  handleId: z.uuid(), event: eventSchema, ownId: z.string().min(1),
}).strict();

export const WorkerCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('hello') }).strict(),
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('open') }).strict(),
  z.object({ action: z.literal('close') }).strict(),
  z.object({ action: z.literal('observe'), accountId: accountIdSchema.optional(),
    source: z.enum(['notifications', 'works', 'dm']).optional(), index: z.int().nonnegative().optional(),
  }).strict(),
  z.object({ action: z.literal('identity'), channel: channelSchema, ownId: z.string().optional() }).strict(),
  z.object({ action: z.literal('inspectTarget'), target: target.optional() }).strict(),
  z.object({ action: z.literal('prepareSend'), targetDigest: digest.optional(), target: target.optional(), text: z.string().optional() }).strict(),
  z.object({ action: z.literal('verifyPrepared'), target: target, text: z.string() }).strict(),
  z.object({ action: z.literal('baseline'), target: target }).strict(),
  z.object({ action: z.literal('executeSend'), binding: WorkerSendBindingSchema, text: z.string() }).strict(),
  z.object({ action: z.literal('abortSend') }).strict(),
  z.object({
    action: z.literal('readback'),
    intentId,
    baseline: z.array(z.string()),
    notBefore,
    text: z.string(),
    target: target.optional(),
  }).strict(),
  z.object({ action: z.literal('cancelPreparation'), handleId: z.uuid().optional() }).strict(),
  z.object({ action: z.literal('disposeTarget'), handleId: z.uuid() }).strict(),
  z.object({ action: z.literal('shutdown') }).strict(),
]);
export type WorkerCommand = z.infer<typeof WorkerCommandSchema>;
export type WorkerTarget = z.infer<typeof target>;

const envelopeFields = { id: z.uuid(), sessionId: z.uuid(), ownerEpoch };
export const WorkerRequestEnvelopeSchema = z.object({ ...envelopeFields, command: WorkerCommandSchema }).strict();
export type WorkerRequestEnvelope = z.infer<typeof WorkerRequestEnvelopeSchema>;

export const WorkerResponseEnvelopeSchema = z.discriminatedUnion('ok', [
  z.object({ ...envelopeFields, ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ ...envelopeFields, ok: z.literal(false), error: z.string() }).strict(),
]);
export type WorkerResponseEnvelope = z.infer<typeof WorkerResponseEnvelopeSchema>;
