import { z } from "zod";

export const MODEL_PROTOCOLS = [
  "OPENAI_CHAT", "OPENAI_RESPONSES", "ANTHROPIC_MESSAGES", "GEMINI_GENERATE_CONTENT",
] as const;
export const modelProtocolSchema = z.enum(MODEL_PROTOCOLS);
export type ModelProtocol = z.infer<typeof modelProtocolSchema>;

export const MODEL_PRESET_IDS = [
  "deepseek", "openai", "anthropic", "gemini", "qwen", "doubao", "siliconflow", "openrouter", "custom",
] as const;
export const modelPresetIdSchema = z.enum(MODEL_PRESET_IDS);
export type ModelPresetId = z.infer<typeof modelPresetIdSchema>;

export const MODEL_KEY_STORAGES = ["MEMORY", "DPAPI"] as const;
export const modelKeyStorageSchema = z.enum(MODEL_KEY_STORAGES);
export type ModelKeyStorage = z.infer<typeof modelKeyStorageSchema>;

export const MODEL_CALL_PURPOSES = [
  "REPLY_GENERATION", "PERSONA_ANALYSIS", "PERSONA_MERGE", "SANDBOX_REPLY", "SANDBOX_COMPARE", "PROVIDER_TEST",
] as const;
export const modelCallPurposeSchema = z.enum(MODEL_CALL_PURPOSES);
export type ModelCallPurpose = z.infer<typeof modelCallPurposeSchema>;

export const MODEL_ERROR_CODES = [
  "MODEL_CONNECTION_CONFLICT",
  "MODEL_CONNECTION_NOT_APPLIED",
  "MODEL_PROTOCOL_UNSUPPORTED",
  "MODEL_KEY_REQUIRED",
  "LEGACY_MODEL_KEY_RECONFIGURE_REQUIRED",
  "MODEL_CREDENTIAL_CLEANUP_FAILED",
  "MODEL_MANUAL_MODELS_TRUNCATED",
  "DPAPI_RESTORE_FAILED",
  "MODEL_AUTH_FAILED",
  "MODEL_NOT_AVAILABLE",
  "MODEL_REQUEST_UNSUPPORTED",
  "MODEL_OUTPUT_INCOMPLETE",
  "MODEL_RESPONSE_INVALID",
  "MODEL_TIMEOUT",
  "MODEL_NETWORK_ERROR",
  "MODEL_REDIRECT_REJECTED",
  "MODEL_RESPONSE_TOO_LARGE",
  "MODEL_RATE_LIMITED",
  "MODEL_SERVICE_ERROR",
  "MODEL_ROUTE_CHANGED",
  "EMERGENCY_STOPPED",
  "MODEL_OUTSIDE_GRANT",
  "MODEL_GRANT_EXHAUSTED",
  "MODEL_COMMAND_CONFLICT",
  "USE_MODEL_PROVIDER_SETTINGS",
  "LEGACY_MODEL_ROUTE_UNPROVEN",
] as const;
export const modelErrorCodeSchema = z.enum(MODEL_ERROR_CODES);
export type ModelErrorCode = z.infer<typeof modelErrorCodeSchema>;
export const modelCallErrorCodeSchema = z.enum([
  ...MODEL_ERROR_CODES,
  "AI_SETTINGS_CHANGED", "ASSISTANT_PERMISSION_REQUIRED", "AUTO_RESULT_STALE", "CONTEXT_VERSION_CONFLICT",
  "DRAFT_VERSION_CONFLICT", "GRANT_REVOKED", "KNOWLEDGE_CONTEXT_CHANGED", "MODEL_CANCELLED",
  "MODEL_DUPLICATE_OUTPUT", "MODEL_PAUSED", "MODEL_SENSITIVE_OUTPUT", "PERSONA_MODEL_FORMAT_INVALID",
  "PERSONA_TASK_SELECTION_CHANGED", "POLICY_NO_LONGER_AUTHORIZED", "SECURITY_CHANNEL_HELD", "SECURITY_STATE_CHANGED",
  "TARGET_CHANGED",
]);
export type ModelCallErrorCode = z.infer<typeof modelCallErrorCodeSchema>;

export const modelIdSchema = z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/u);
export function isValidModelId(value: unknown): value is string {
  return modelIdSchema.safeParse(value).success;
}

// Validate the input spelling without changing it. The transport checks network destinations.
export const modelBaseUrlSchema = z.string().max(2048).refine(value => {
  if (!/^https:\/\/[^/@?#]+(?:\/|$)/iu.test(value) || /[\s\p{Cc}\\?#]/u.test(value)) return false;
  const url = URL.parse(value);
  if (!url || url.username || url.password) return false;
  const host = url.hostname.replace(/\.$/u, "");
  if (!host.includes(".") && !host.startsWith("[")) return false;
  if (/(?:^|\.)(?:localhost|local)$/u.test(host)) return false;
  const ipv4 = /^\d+\.\d+\.\d+\.\d+$/u.test(host);
  const privateIpv4 = /^(?:0|10|127|169\.254|172\.(?:1[6-9]|2\d|3[01])|192\.168|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\./u;
  if (ipv4 && privateIpv4.test(host)) return false;
  if (/^\[(?:::|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/iu.test(host)) return false;
  // A base URL may have a version prefix, but the adapter appends the operation path.
  if (url.pathname.includes("//")) return false;
  const path = url.pathname.replace(/\/+$/u, "");
  const repeatsVersion = /\/(v\d+(?:alpha|beta)?\d*)\/\1(?:\/|$)/iu.test(path);
  const operationPath = /\/(?:chat\/completions|responses|messages|models)$|:generateContent$/iu.test(path);
  return !repeatsVersion && !operationPath;
}, "INVALID_MODEL_BASE_URL");

const connectionId = z.uuid();
const revision = z.int().positive();
const timestamp = z.int().nonnegative();
const endpointDigest = z.string().regex(/^[a-f0-9]{64}$/u);
const displayName = z.string().min(1).max(200).refine(value => value.trim().length > 0);
const region = z.string().min(1).max(80).nullable();
const catalogLimit = 2000;
export const INLINE_MODEL_LIMIT = 32;
export const CONNECTION_PAGE_LIMIT = 20;
export const MODEL_PAGE_LIMIT = 200;
const pageOffset = z.int().nonnegative();
const modelCount = z.int().min(0).max(catalogLimit * 2);

const modelCatalogFields = { modelId: modelIdSchema, displayName: displayName.nullable() };
export const modelCatalogEntrySchema = z.object({
  ...modelCatalogFields,
  source: z.enum(["DISCOVERED", "MANUAL"]),
}).strict();
export type ModelCatalogEntry = z.infer<typeof modelCatalogEntrySchema>;

export const modelConnectionSchema = z.object({
  id: connectionId,
  name: displayName,
  presetId: modelPresetIdSchema,
  version: revision,
  draftRevision: revision,
  models: z.array(modelCatalogEntrySchema).max(catalogLimit * 2),
  modelsFetchedAt: timestamp.nullable(),
  deletedAt: timestamp.nullable(),
}).strict();
export type ModelConnection = z.infer<typeof modelConnectionSchema>;

const route = { connectionId, routeRevision: revision };
const revisionSettings = {
  presetId: modelPresetIdSchema,
  protocol: modelProtocolSchema,
  baseUrl: modelBaseUrlSchema,
  region,
  storage: modelKeyStorageSchema,
};
export const connectionRevisionSchema = z.object({
  ...route,
  ...revisionSettings,
  credentialRevision: z.uuid().nullable(),
  createdAt: timestamp,
}).strict();
export type ConnectionRevision = z.infer<typeof connectionRevisionSchema>;

export const modelSelectionSchema = z.union([
  z.object({ ...route, modelId: modelIdSchema, selectionRevision: revision }).strict(),
  z.object({
    connectionId: z.null(), routeRevision: z.null(), modelId: z.null(),
    selectionRevision: z.int().nonnegative(),
  }).strict(),
]);
export type ModelSelection = z.infer<typeof modelSelectionSchema>;
const publicModelSelectionSchema = z.union([
  modelSelectionSchema.options[0].extend({ modelDisplayName: displayName.nullable().optional() }),
  modelSelectionSchema.options[1],
]);

export const modelBindingSchema = z.object({
  ...route,
  selectionRevision: revision,
  protocol: modelProtocolSchema,
  endpointDigest,
}).strict();
export type ModelBinding = z.infer<typeof modelBindingSchema>;

export const MODEL_PROVIDER_TEST_VERSION = 1;
const snapshotFields = {
  ...route,
  presetId: modelPresetIdSchema,
  protocol: modelProtocolSchema,
  endpointDigest,
  credentialRevision: z.uuid(),
  modelId: modelIdSchema,
};
export const modelRouteSnapshotSchema = z.discriminatedUnion("purpose", [
  z.object({
    ...snapshotFields,
    purpose: modelCallPurposeSchema.exclude(["PROVIDER_TEST"]),
    selectionRevision: revision,
    grantVersion: revision,
  }).strict(),
  z.object({
    ...snapshotFields,
    purpose: z.literal("PROVIDER_TEST"),
    selectionRevision: z.null(),
    grantVersion: z.null(),
    commandId: z.uuid(),
    testVersion: z.literal(MODEL_PROVIDER_TEST_VERSION),
  }).strict(),
]);
export type ModelRouteSnapshot = z.infer<typeof modelRouteSnapshotSchema>;

// Counts describe what the provider reported. No totals are inferred.
const tokenCount = z.int().nonnegative().nullable();
export const modelUsageDetailsSchema = z.object({
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  totalTokens: tokenCount,
  reasoningTokens: tokenCount,
  cacheReadTokens: tokenCount,
  cacheWriteTokens: tokenCount,
}).strict();
export type ModelUsageDetails = z.infer<typeof modelUsageDetailsSchema>;

export const modelResultSchema = z.object({
  text: z.string().min(1).refine(value => value.trim().length > 0),
  requestedModelId: modelIdSchema,
  reportedModelId: modelIdSchema.nullable(),
  finishReason: z.enum(["stop", "length", "content-filter", "tool-calls", "error", "interrupted", "other"]),
  usage: modelUsageDetailsSchema,
}).strict();
export type ModelResult = z.infer<typeof modelResultSchema>;

export const modelTestResultSchema = z.object({
  ...route,
  commandId: z.uuid(),
  modelId: modelIdSchema,
  status: z.enum(["STARTED", "SUCCEEDED", "FAILED", "INTERRUPTED"]),
  reportedModelId: modelIdSchema.nullable(),
  elapsedMs: timestamp.nullable(),
  usage: modelUsageDetailsSchema.nullable(),
  reason: modelErrorCodeSchema.nullable(),
}).strict();
export type ModelTestResult = z.infer<typeof modelTestResultSchema>;

export const modelCatalogResultSchema = z.object({
  ...route,
  status: z.enum(["COMPLETE", "PARTIAL", "FAILED"]),
  models: z.array(modelCatalogEntrySchema).max(catalogLimit),
  fetchedAt: timestamp.nullable(),
  reason: modelErrorCodeSchema.nullable(),
}).strict();
export type ModelCatalogResult = z.infer<typeof modelCatalogResultSchema>;

export const modelCatalogSummarySchema = modelCatalogResultSchema.omit({ models: true }).extend({
  totalCount: z.int().min(0).max(catalogLimit),
  truncated: z.boolean(),
  selectedModelInCatalog: z.boolean().nullable(),
}).strict();
export type ModelCatalogSummary = z.infer<typeof modelCatalogSummarySchema>;

export const modelCatalogPageSchema = z.object({
  connectionId,
  version: revision,
  offset: pageOffset,
  nextOffset: pageOffset.nullable(),
  totalModelCount: modelCount,
  models: z.array(modelCatalogEntrySchema).max(MODEL_PAGE_LIMIT),
}).strict();
export type ModelCatalogPage = z.infer<typeof modelCatalogPageSchema>;

const publicModelRevisionSchema = z.object({
  routeRevision: revision,
  ...revisionSettings,
  keyPresent: z.boolean(),
  keyStored: z.boolean(),
  unavailableReason: modelErrorCodeSchema.nullable(),
  // Accept public state from earlier sidecars during a mixed-version rollout.
  catalogResult: z.union([modelCatalogSummarySchema, modelCatalogResultSchema]).nullable(),
  testResult: modelTestResultSchema.nullable(),
}).strict();
export const publicModelConnectionSchema = modelConnectionSchema.omit({ deletedAt: true }).extend({
  models: z.array(modelCatalogEntrySchema).max(INLINE_MODEL_LIMIT),
  totalModelCount: modelCount.optional(),
  modelsTruncated: z.boolean().optional(),
  draft: publicModelRevisionSchema,
  applied: publicModelRevisionSchema.nullable(),
}).strict();
export type PublicModelConnection = z.infer<typeof publicModelConnectionSchema>;

export const publicModelStateSchema = z.object({
  connections: z.array(publicModelConnectionSchema).max(CONNECTION_PAGE_LIMIT),
  totalConnectionCount: pageOffset.optional(),
  nextConnectionOffset: pageOffset.nullable().optional(),
  listRevision: pageOffset.optional(),
  selection: publicModelSelectionSchema,
}).strict();
export type PublicModelState = z.infer<typeof publicModelStateSchema>;

const command = z.literal("modelProviders");
const saveModelConnectionSchema = z.object({
  command,
  action: z.literal("save"),
  connectionId: connectionId.nullable(),
  expectedVersion: z.int().nonnegative(),
  name: displayName,
  presetId: modelPresetIdSchema,
  protocol: modelProtocolSchema,
  baseUrl: modelBaseUrlSchema,
  region,
  manualModels: z.array(z.object({
    modelId: modelIdSchema,
    displayName: displayName.nullable().optional(),
  }).strict()).max(catalogLimit).optional(),
  manualModelsComplete: z.literal(true).optional(),
  expectedSelectionRevision: z.int().nonnegative().optional(),
  // Older clients may still send this flag. It cannot authorize a truncated replacement.
  replaceTruncatedManualModels: z.literal(true).optional(),
}).strict().refine(
  value => (value.connectionId === null) === (value.expectedVersion === 0),
  { path: ["expectedVersion"], message: "INVALID_MODEL_CONNECTION_VERSION" },
).refine(
  value => !value.manualModelsComplete || (value.manualModels !== undefined && value.expectedSelectionRevision !== undefined),
  { path: ["manualModelsComplete"], message: "INVALID_COMPLETE_MANUAL_MODELS" },
);
const writeKey = { command, action: z.literal("setKey"), connectionId, expectedVersion: revision };
const setModelKeySchema = z.discriminatedUnion("storage", [
  z.object({
    ...writeKey,
    storage: modelKeyStorageSchema,
    key: z.string().min(1).max(4000).refine(value => value.trim().length > 0 && !/[\r\n]/u.test(value)),
  }).strict(),
  z.object({ ...writeKey, storage: z.literal("DELETE") }).strict(),
]);
const confirmedModelCommand = { ...route, command, commandId: z.uuid(), modelId: modelIdSchema, confirmed: z.literal(true) };
export const modelProvidersCommandSchema = z.discriminatedUnion("action", [
  z.object({
    command, action: z.literal("list"), connectionId: connectionId.optional(),
    offset: pageOffset.optional(), limit: z.int().min(1).max(MODEL_PAGE_LIMIT).optional(),
    expectedListRevision: pageOffset.optional(),
  }).strict(),
  saveModelConnectionSchema,
  setModelKeySchema,
  z.object({ command, action: z.literal("discover"), ...route }).strict(),
  z.object({ ...confirmedModelCommand, action: z.literal("test") }).strict(),
  z.object({
    ...confirmedModelCommand,
    action: z.literal("apply"),
    expectedSelectionRevision: z.int().nonnegative(),
  }).strict(),
  z.object({ command, action: z.literal("delete"), connectionId, expectedVersion: revision }).strict(),
]);
export type ModelProvidersCommand = z.infer<typeof modelProvidersCommandSchema>;
