import { z } from "zod";

export const protocolVersion = 1;
export const modeSchema = z.enum([
  "OBSERVE",
  "DRAFT_ONLY",
  "MANUAL",
  "AI_ASSISTED",
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
export const commandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("getStatus") }).strict(),
  z
    .object({
      command: z.literal("getInbox"),
      channel: z.enum(["ALL", "COMMENT_NOTIFICATION", "DIRECT_MESSAGE"]),
      status: z.enum(["ALL", "PENDING", "REVIEW", "UNCERTAIN", "CONFIRMED"]),
      page: z.number().int().min(0).max(100000),
    })
    .strict(),
  z.object({ command: z.literal("getThread"), ...event }).strict(),
  z.object({ command: z.literal("openTarget"), ...event }).strict(),
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
      command: z.literal("browser"),
      open: z.boolean(),
      mode: z.enum(["headed", "headless"]),
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
export type ClientCommand = z.infer<typeof commandSchema>;
export interface InboxSync {
  runId: string | null;
  running: boolean;
  cancelled: boolean;
  source: "works" | "dm" | null;
  results: {
    source: "works" | "dm";
    state: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED" | "CANCELLED";
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
