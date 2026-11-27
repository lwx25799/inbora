import { z } from "zod";
import { modelBaseUrlSchema } from "./model-providers.js";

export const BUSINESS_TOOL_IDS = [
  "query_order_status",
  "query_logistics_trace",
  "query_inventory_stock",
] as const;
export const businessToolIdSchema = z.enum(BUSINESS_TOOL_IDS);
export type BusinessToolId = z.infer<typeof businessToolIdSchema>;

export const toolEndpointsSchema = z.object({
  query_order_status: modelBaseUrlSchema.optional(),
  query_logistics_trace: modelBaseUrlSchema.optional(),
  query_inventory_stock: modelBaseUrlSchema.optional(),
}).strict();

export const accountAiFeaturesSchema = z.object({
  visionEnabled: z.boolean(),
  mediaReplyEnabled: z.boolean(),
  enabledBusinessTools: z.array(businessToolIdSchema).max(BUSINESS_TOOL_IDS.length),
  toolEndpoints: toolEndpointsSchema,
  syncCustomerAvatars: z.boolean(),
}).strict();
export type AccountAiFeatures = z.infer<typeof accountAiFeaturesSchema>;

export const DEFAULT_ACCOUNT_AI_FEATURES: AccountAiFeatures = {
  visionEnabled: false,
  mediaReplyEnabled: false,
  enabledBusinessTools: [],
  toolEndpoints: {},
  syncCustomerAvatars: false,
};

export const accountAiFeaturesCommandSchema = z.discriminatedUnion("action", [
  z.object({ command: z.literal("accountAiFeatures"), action: z.literal("get") }).strict(),
  z.object({
    command: z.literal("accountAiFeatures"),
    action: z.literal("save"),
    features: accountAiFeaturesSchema,
  }).strict(),
]);
export type AccountAiFeaturesCommand = z.infer<typeof accountAiFeaturesCommandSchema>;

export const MEDIA_ASSET_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const mediaAssetMimeTypeSchema = z.enum(MEDIA_ASSET_MIME_TYPES);
export type MediaAssetMimeType = z.infer<typeof mediaAssetMimeTypeSchema>;

export const MAX_MEDIA_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_MEDIA_CHUNK_CHARS = 65_536;

export const mediaAssetSummarySchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(120),
  mimeType: mediaAssetMimeTypeSchema,
  bytes: z.int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  createdAt: z.int().nonnegative(),
}).strict();
export type MediaAssetSummary = z.infer<typeof mediaAssetSummarySchema>;

export const mediaAssetsCommandSchema = z.discriminatedUnion("action", [
  z.object({ command: z.literal("mediaAssets"), action: z.literal("list") }).strict(),
  z.object({
    command: z.literal("mediaAssets"),
    action: z.literal("save"),
    name: z.string().trim().min(1).max(120),
    base64: z.string().min(1).max(7_500_000),
  }).strict(),
  z.object({
    command: z.literal("mediaAssets"),
    action: z.literal("uploadStart"),
    name: z.string().trim().min(1).max(120),
    mimeType: mediaAssetMimeTypeSchema,
    bytes: z.int().positive().max(MAX_MEDIA_UPLOAD_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict(),
  z.object({
    command: z.literal("mediaAssets"),
    action: z.literal("uploadChunk"),
    uploadId: z.uuid(),
    index: z.int().nonnegative().max(1000),
    data: z.string().min(1).max(MAX_MEDIA_CHUNK_CHARS),
  }).strict(),
  z.object({
    command: z.literal("mediaAssets"),
    action: z.literal("uploadFinish"),
    uploadId: z.uuid(),
  }).strict(),
  z.object({
    command: z.literal("mediaAssets"),
    action: z.literal("delete"),
    assetId: z.uuid(),
  }).strict(),
]);
export type MediaAssetsCommand = z.infer<typeof mediaAssetsCommandSchema>;

export const businessToolsCommandSchema = z.discriminatedUnion("action", [
  z.object({ command: z.literal("businessTools"), action: z.literal("list") }).strict(),
  z.object({
    command: z.literal("businessTools"),
    action: z.literal("invokeReadonly"),
    toolId: businessToolIdSchema,
    params: z.record(z.string().min(1).max(40), z.string().max(200)),
  }).strict(),
]);
export type BusinessToolsCommand = z.infer<typeof businessToolsCommandSchema>;
