import { z } from 'zod';

export const DEFAULT_ACCOUNT_ID = 'account_001';
export const accountIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
export type AccountId = z.infer<typeof accountIdSchema>;
