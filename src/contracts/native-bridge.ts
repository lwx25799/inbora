import { z } from 'zod';

export const NATIVE_BRIDGE_PROTOCOL = 1;
export const MAX_NATIVE_BRIDGE_BYTES = 262_144;

const bridgeFields = { bridgeId: z.uuid(), secret: z.string().length(64) };
const dpapiFields = { dataBase64: z.base64(), entropy: z.string() };
const cacheKey = z.string().optional();
const positiveNumber = z.number().finite().positive();
const processId = positiveNumber.int();

export const nativeBridgeRequestSchema = z.object({
  kind: z.literal('native_bridge_request'),
  ...bridgeFields,
  payload: z.discriminatedUnion('op', [
    z.object({ op: z.literal('dpapiProtect'), ...dpapiFields }).strict(),
    z.object({
      op: z.literal('dpapiUnprotect'),
      ...dpapiFields,
      cacheKey,
      mtimeMs: z.number().optional(),
    }).strict(),
    z.object({ op: z.literal('clearDpapiCache'), cacheKey }).strict(),
    z.object({
      op: z.literal('sampleProcessTree'),
      rootPid: processId,
      targetExe: z.string().optional(),
      maxAgeMs: z.number().int().nonnegative().max(30_000).optional(),
    }).strict(),
  ]),
}).strict();
export type NativeBridgeRequest = z.infer<typeof nativeBridgeRequestSchema>;

const responseFields = { kind: z.literal('native_bridge_response'), ...bridgeFields };
export const nativeBridgeResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ...responseFields, ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ ...responseFields, ok: z.literal(false), error: z.string() }).strict(),
]);
export type NativeBridgeResponse = z.infer<typeof nativeBridgeResponseSchema>;

const nullableMetric = z.number().finite().nonnegative().nullable();
export const nativeProcessRowSchema = z.object({
  pid: processId,
  parentPid: z.number().int().nonnegative(),
  name: z.string().max(128),
  createdAt: positiveNumber,
  workingSetBytes: nullableMetric,
  privateBytes: nullableMetric,
  cpuSeconds: nullableMetric,
  statCreatedAt: positiveNumber.nullable(),
}).strict();
export type NativeProcessRow = z.infer<typeof nativeProcessRowSchema>;

export const nativeProcessSampleSchema = z.object({
  rows: z.array(nativeProcessRowSchema).max(16_384),
  sampledAt: z.number().int().positive(),
  cached: z.boolean(),
}).strict();
export type NativeProcessSample = z.infer<typeof nativeProcessSampleSchema>;
