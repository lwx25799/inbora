import { z } from 'zod';
import type { AccountId } from './account.js';
import type { Channel } from './events.js';

export const rhythmProfileSchema = z.enum(['off', 'calm', 'natural', 'active']);
export type RhythmProfile = z.infer<typeof rhythmProfileSchema>;

export const replyPipelinePersistedConfigSchema = z.object({
  rhythmProfile: rhythmProfileSchema,
  debounce: z.object({
    enabled: z.boolean(),
    windowMs: z.number().int().min(2000).max(5000),
  }).strict(),
  sensitive: z.object({
    customWords: z.array(z.string().trim().min(1).max(60)).max(200),
    enablePlatformRedline: z.boolean(),
    enablePromptInjectionGuard: z.boolean(),
  }).strict(),
  handoff: z.object({
    mediaMessageHandoff: z.boolean(),
    afterSalesHandoff: z.boolean(),
    bargainHandoff: z.boolean(),
    customTriggers: z.array(z.string().trim().min(1).max(60)).max(200),
    knowledgeMissHandoff: z.boolean(),
    knowledgeConflictHandoff: z.boolean(),
    exactFaqDirectReply: z.boolean(),
  }).strict(),
  loopBreaker: z.object({
    enabled: z.boolean(),
  }).strict(),
}).strict();

export type ReplyPipelinePersistedConfig = z.infer<typeof replyPipelinePersistedConfigSchema>;

export const DEFAULT_REPLY_PIPELINE_PERSISTED_CONFIG: ReplyPipelinePersistedConfig = {
  rhythmProfile: 'off',
  debounce: {
    enabled: false,
    windowMs: 3000,
  },
  sensitive: {
    customWords: [],
    enablePlatformRedline: true,
    enablePromptInjectionGuard: true,
  },
  handoff: {
    mediaMessageHandoff: true,
    afterSalesHandoff: false,
    bargainHandoff: false,
    customTriggers: [],
    knowledgeMissHandoff: false,
    knowledgeConflictHandoff: true,
    exactFaqDirectReply: false,
  },
  loopBreaker: {
    enabled: true,
  },
};

export interface RhythmStateSnapshot {
  accountId: AccountId;
  scope: 'ALL' | Channel;
  profile: RhythmProfile;
  lastActionAt: number;
  nextAllowedAt: number;
  cooloffUntil: number;
  windowTimestamps: number[];
  totalActions: number;
  cooloffHits: number;
  updatedAt: number;
}

export interface HandoffAttributionBucket {
  key: string;
  label: string;
  count: number;
  ratio: number;
  percentage: number;
}

export interface HandoffAttributionSummary {
  accountId: AccountId;
  sinceMs: number | null;
  untilMs: number | null;
  channel: Channel | null;
  total: number;
  byCategory: HandoffAttributionBucket[];
  byReasonCode: HandoffAttributionBucket[];
  byStage: HandoffAttributionBucket[];
}

export interface ReplyPipelineStatusView {
  configured: boolean;
  config: ReplyPipelinePersistedConfig;
  rhythmState: RhythmStateSnapshot | null;
  handoffSummary: HandoffAttributionSummary;
  updatedAt: number | null;
}

export const replyPipelineCommandSchema = z.discriminatedUnion('action', [
  z.object({ command: z.literal('replyPipeline'), action: z.literal('getConfig') }).strict(),
  z.object({
    command: z.literal('replyPipeline'),
    action: z.literal('saveConfig'),
    config: replyPipelinePersistedConfigSchema,
  }).strict(),
  z.object({
    command: z.literal('replyPipeline'),
    action: z.literal('dryRun'),
    eventId: z.uuid(),
    candidateReplyText: z.string().max(2000).optional(),
  }).strict(),
]);

export type ReplyPipelineCommand = z.infer<typeof replyPipelineCommandSchema>;
