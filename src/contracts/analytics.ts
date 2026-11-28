import { z } from 'zod';
import type { HandoffAttributionSummary } from './reply-pipeline.js';

export const analyticsRangeSchema = z.enum(['7d', '14d', '30d']);
export type AnalyticsRange = z.infer<typeof analyticsRangeSchema>;

export const getAnalyticsCommandSchema = z.object({
  command: z.literal('getAnalytics'),
  range: analyticsRangeSchema,
}).strict();
export type GetAnalyticsCommand = z.infer<typeof getAnalyticsCommandSchema>;

export type AnalyticsResponseTimingBasis =
  | 'PLATFORM_SEND_AT'
  | 'CONFIRMATION_AT'
  | 'MIXED'
  | 'NONE';

export interface AnalyticsSummary {
  range: AnalyticsRange;
  sinceIso: string;
  untilIso: string;
  scopes: {
    totals: 'ACCOUNT_WINDOW';
    dailySeries: 'ACCOUNT_WINDOW';
    handoffSummary: 'ACCOUNT_WINDOW';
    modelUsage: 'RUNTIME_ALL_TIME';
    budgets: 'SHARED_GLOBAL';
    accountBreakdown: 'ALL_ACCOUNTS_WINDOW';
    avgResponseBasis: AnalyticsResponseTimingBasis;
  };
  totals: {
    confirmedTotal: number;
    autoConfirmed: number;
    humanConfirmed: number;
    faqDirectConfirmed: number;
    unknownConfirmed: number;
    autoRate: number;
    faqDirectRate: number;
    autoReplyAttempts: number;
    autoReplySuccessRate: number;
    avgResponseMs: number | null;
  };
  dailySeries: {
    date: string;
    label: string;
    autoConfirmed: number;
    humanConfirmed: number;
    faqDirectConfirmed: number;
    unknownConfirmed: number;
  }[];
  handoffSummary: HandoffAttributionSummary;
  modelUsage: {
    requests: number;
    succeeded: number;
    failed: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    unresolved: number;
  };
  budgets: {
    kind: string;
    used: number;
    maximum: number | null;
  }[];
  accountBreakdown: {
    accountId: string;
    displayLabel: string;
    platform: string;
    autoConfirmed: number;
    humanConfirmed: number;
    faqDirectConfirmed: number;
    unknownConfirmed: number;
    totalConfirmed: number;
  }[];
}
