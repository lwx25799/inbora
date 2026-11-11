import { z } from "zod";
import { collectionSchema, modelGrantSchema, replyPolicySchema } from "./automation-contracts.js";

export const protocolVersion = 1;
export const modeSchema = z.enum([
  "OBSERVE",
  "DRAFT_ONLY",
  "MANUAL",
  "AI_ASSISTED",
  "LIMITED_AUTO",
]);
export type Mode = z.infer<typeof modeSchema>;
export const settingsSchema = z
  .object({
    model: z
      .string()
      .regex(/^deepseek-[a-z0-9.-]+$/)
      .max(100),
    persona: z.string().max(2000),
    business: z.string().max(4000),
    rules: z.string().max(4000),
  })
  .strict();
export type AiSettings = z.infer<typeof settingsSchema>;
export const defaultSettings: AiSettings = {
  model: "deepseek-flash",
  persona: "",
  business: "",
  rules: "",
};
const event = { eventId: z.uuid() };
const owned = { ...event, generation: z.number().int().nonnegative() };
export const sendParamsSchema = z
  .object({
    ...owned,
    draftId: z.uuid(),
    draftVersion: z.number().int().positive(),
    text: z.string().min(1).max(2000),
    contextVersion: z.string().regex(/^[a-f0-9]{64}$/),
    selectionId: z.uuid(),
  })
  .strict();
export type SendParams = z.infer<typeof sendParamsSchema>;
export const humanReplySchema=z.object({...owned,expectedVersion:z.number().int().nonnegative(),text:z.string().min(1).max(2000),
  contextVersion:z.string().regex(/^[a-f0-9]{64}$/),selectionId:z.uuid(),suggestionId:z.uuid().nullable()}).strict();
export interface BrowserDraftChoice {
  eventId:string;draftId:string;draftVersion:number;text:string;contextVersion:string;
  author:string|null;conversationId:string;originalText:string;
}
const browserCommandSchema=z.union([
  z.object({command:z.literal('browser'),open:z.boolean(),mode:z.enum(['headed','headless']),loginRecovery:z.boolean().optional(),manualVisible:z.boolean().optional()}).strict(),
  z.object({command:z.literal('browser'),action:z.literal('inspectSavedDraftRecovery')}).strict(),
  z.object({command:z.literal('browser'),action:z.literal('clearSavedDraftRecovery'),...event,draftId:z.uuid(),draftVersion:z.number().int().positive(),
    expectedText:z.string().min(1).max(2000),contextVersion:z.string().regex(/^[a-f0-9]{64}$/),confirmed:z.literal(true)}).strict(),
]);
const ordinaryCommandSchema = z.discriminatedUnion("command", [
  z.object({command:z.literal('openHumanDialog'),...event,selectionId:z.uuid(),editing:z.boolean().optional()}).strict(),
  z.object({command:z.literal('closeHumanDialog'),...owned}).strict(),
  z.object({command:z.literal('sendHumanReply'),commandId:z.uuid(),input:humanReplySchema}).strict(),
  z.object({command:z.literal('sendHumanFollowup'),commandId:z.uuid(),input:humanReplySchema}).strict(),
  z.object({command:z.literal('saveHumanFollowupDraft'),...owned,expectedVersion:z.number().int().nonnegative(),text:z.string().max(2000),suggestionId:z.null()}).strict(),
  z.object({command:z.literal("configureCollection"),settings:collectionSchema}).strict(),
  z.object({command:z.literal("setModelGrant"),scope:modelGrantSchema.nullable(),confirmed:z.literal(true)}).strict(),
  z.object({command:z.literal("setReplyPolicy"),policy:replyPolicySchema.nullable(),confirmed:z.literal(true)}).strict(),
  z.object({command:z.literal('enableReplyPolicy'),policy:replyPolicySchema,confirmed:z.literal(true)}).strict(),
  z.object({command:z.literal('setAutomaticReply'),enabled:z.boolean()}).strict(),
  z.object({command:z.literal("resumeAutomation"),...event}).strict(),
  z.object({command:z.literal("clearModelKey")}).strict(),
  z.object({command:z.literal('setKeyStorage'),storage:z.enum(['MEMORY','DPAPI','DELETE'])}).strict(),
  z.object({ command: z.literal("getStatus") }).strict(),
  z.object({ command: z.literal('getDiagnostics') }).strict(),
  z
    .object({
      command: z.literal("getInbox"),
      channel: z.enum(["ALL", "COMMENT_NOTIFICATION", "DIRECT_MESSAGE"]),
      status: z.enum(["ALL", "UNREAD", "PENDING", "MANUAL_ONLY", "REVIEW", "UNCERTAIN", "CONFIRMED"]),
      page: z.number().int().min(0).max(100000),
    })
    .strict(),
  z.object({command:z.literal('markInboxRead')}).strict(),
  z.object({ command: z.literal("getThread"), ...event,timelineBefore:z.string().min(1).max(300).optional() }).strict(),
  z.object({command:z.literal('getMessagePreview'),...event,previewId:z.string().regex(/^[a-f0-9]{64}$/).optional(),refresh:z.literal(true).optional()})
    .strict().refine(value=>(value.refresh===true)!==(value.previewId!==undefined)),
  z.object({ command: z.literal("openTarget"), ...event,visible:z.literal(true).optional() }).strict(),
  z
    .object({
      command: z.literal("selectTarget"),
      eventId: z.uuid().nullable(),
      selectionId: z.uuid(),
    })
    .strict(),
  z.object({ command: z.literal("claimHuman"), ...owned }).strict(),
  z.object({ command: z.literal("renewHuman"), ...owned }).strict(),
  z.object({ command: z.literal("releaseHuman"), ...owned }).strict(),
  z
    .object({
      command: z.literal("saveDraft"),
      ...owned,
      expectedVersion: z.number().int().nonnegative(),
      text: z.string().max(2000),
      suggestionId: z.uuid().nullable(),
    })
    .strict(),
  z
    .object({
      command: z.literal("generateSuggestion"),
      ...event,
      draftVersion: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({ command: z.literal("dismissSuggestion"), suggestionId: z.uuid() })
    .strict(),
  z
    .object({ command: z.literal("previewSend"), params: sendParamsSchema })
    .strict(),
  z
    .object({
      command: z.literal("submitManualSend"),
      commandId: z.uuid(),
      params: sendParamsSchema,
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({ command: z.literal("getSendResult"), commandId: z.uuid() })
    .strict(),
  z
    .object({ command: z.literal("pause"), eventId: z.uuid().nullable() })
    .strict(),
  z
    .object({ command: z.literal("resume"), eventId: z.uuid().nullable() })
    .strict(),
  z.object({ command: z.literal("emergencyStop") }).strict(),
  z.object({ command: z.literal("setMode"), mode: modeSchema }).strict(),
  z
    .object({
      command: z.literal("getAudit"),
      page: z.number().int().min(0).max(100000),
    })
    .strict(),
  z
    .object({
      command: z.literal("observe"),
      source: z.enum(["notifications", "works", "dm"]),
    })
    .strict(),
  z.object({command:z.literal('syncInbox')}).strict(),
  z
    .object({
      command: z.literal("reconcileUncertain"),
      ...event,
      decision: z.literal("READ_ONLY_VERIFY"),
    })
    .strict(),
  z
    .object({
      command: z.literal("configureAi"),
      settings: settingsSchema,
      key: z.string().max(4000),
    })
    .strict(),
  z
    .object({ command: z.literal("authorizeAi"), authorized: z.boolean() })
    .strict(),
]);
export const commandSchema=z.union([ordinaryCommandSchema,browserCommandSchema]);
export type ClientCommand = z.infer<typeof commandSchema>;
export interface InboxSync {
  runId: string | null;
  running: boolean;
  cancelled: boolean;
  source: "works" | "dm" | null;
  results: {
    source: "works" | "dm";
    state: "PENDING" | "RUNNING" | "SUCCEEDED" | "DEFERRED" | "FAILED" | "SKIPPED" | "CANCELLED";
    error: string | null;
  }[];
}
export const envelopeSchema = z
  .object({
    protocol: z.literal(protocolVersion),
    requestId: z.uuid(),
    session: z.string().min(32).max(200),
    body: commandSchema,
  })
  .strict();
