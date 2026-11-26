import { z } from "zod";
import { modelBindingSchema, modelIdSchema } from "./model-providers.js";

export const channelsSchema = z.array(z.enum(["COMMENT_NOTIFICATION", "DIRECT_MESSAGE"])).min(1).max(2)
  .refine(values => new Set(values).size === values.length);
export const collectionSchema = z.object({
  ownId: z.string().min(1).max(300),
  comments: z.boolean(),
  inbox: z.boolean(),
  commentIntervalMs: z.number().int().min(15_000).max(3600_000),
  dmIntervalMs: z.number().int().min(15_000).max(3600_000),
}).strict();
export type CollectionSettings = z.infer<typeof collectionSchema>;
export const modelGrantSchema = z.object({
  ownId: z.string().min(1).max(300),
  channels: channelsSchema,
  model: z.string().regex(/^deepseek-[a-z0-9.-]+$/).max(100),
  modelLimit: z.number().int().min(1).nullable(),
  expiresAt: z.number().int().positive().nullable(),
}).strict();
export const replyPolicySchema = modelGrantSchema.extend({
  replyToNestedComments:z.boolean().optional(),
  workIds: z.array(z.string().min(1).max(64)).max(1000),
  futureOwnWorks: z.boolean(),
  conversationIds: z.array(z.string().min(1).max(512)).max(1000),
  entireInbox: z.boolean(),
  containsAny: z.array(z.string().min(1).max(100)).max(30),
  excludesAny: z.array(z.string().min(1).max(100)).max(30),
  instructions: z.string().min(1).max(4000),
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(1).max(24),
  sendLimit: z.number().int().min(1).nullable(),
}).strict().refine(p => p.startHour < p.endHour, "INVALID_POLICY_HOURS");
export type ModelGrant = z.infer<typeof modelGrantSchema>;
export type ReplyPolicy = z.infer<typeof replyPolicySchema>;
export const modelGrantInputSchema = modelGrantSchema.extend({ model: modelIdSchema });
export const replyPolicyInputSchema = replyPolicySchema.safeExtend({ model: modelIdSchema });

const modelGrantV2Fields = {
  contractVersion: z.literal(2),
  model: modelIdSchema,
  modelBinding: modelBindingSchema,
};
export const modelGrantV2Schema = modelGrantSchema.extend(modelGrantV2Fields).strict();
export const replyPolicyV2Schema = replyPolicySchema.safeExtend(modelGrantV2Fields).strict();
export type ModelGrantV2 = z.infer<typeof modelGrantV2Schema>;
export type ReplyPolicyV2 = z.infer<typeof replyPolicyV2Schema>;

export interface Grant<T = ModelGrant | ReplyPolicy> {
  version: number;
  kind: "MODEL" | "AUTO_REPLY";
  scope: T;
  createdAt: number;
}
