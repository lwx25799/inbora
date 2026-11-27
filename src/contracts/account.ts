import { z } from 'zod';

export const DEFAULT_ACCOUNT_ID = 'account_001';
export const accountIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
export type AccountId = z.infer<typeof accountIdSchema>;

export const DOUYIN_PLATFORM_ID = 'douyin';
export const MOCK_PLATFORM_ID = 'mock-platform';
export const WECOM_AIBOT_PLATFORM_ID = 'wecom-aibot';
export const WECHAT_KF_PLATFORM_ID = 'wechat-kf';
export const platformIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
export type PlatformId = z.infer<typeof platformIdSchema>;

export const platformTransportSchema = z.enum(['browser', 'official_api', 'desktop_uia', 'copilot_webview']);
export type PlatformTransport = z.infer<typeof platformTransportSchema>;

export const accountRefSchema = accountIdSchema;
export type AccountRef = z.infer<typeof accountRefSchema>;
export const targetRefSchema = z.string().min(1).max(256);
export type TargetRef = z.infer<typeof targetRefSchema>;
export const accountStatusSchema = z.enum(['ACTIVE', 'DISCONNECTED', 'PAUSED', 'ERROR']);
export type AccountStatus = z.infer<typeof accountStatusSchema>;

const channelSchema = z.enum(['COMMENT_NOTIFICATION', 'DIRECT_MESSAGE']);
const connectorSchema = z.string().min(1).max(64);
const ownIdSchema = z.string().min(1).max(128);
const displayLabelSchema = z.string().min(1).max(128);
const profileRefSchema = z.string().min(1).max(260);

export const accountSummarySchema = z.object({
  id: accountIdSchema,
  accountRef: accountRefSchema,
  platform: platformIdSchema,
  connector: connectorSchema,
  ownId: ownIdSchema.nullable(),
  displayLabel: displayLabelSchema,
  status: accountStatusSchema,
  profileRef: profileRefSchema,
  capabilities: z.object({
    channels: z.array(channelSchema),
    loginRecovery: z.boolean(),
    manualSecurityRecovery: z.boolean(),
    preview: z.boolean(),
    readback: z.boolean(),
    transport: platformTransportSchema.optional(),
  }).strict(),
  autoReplyEnabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();
export type AccountSummary = z.infer<typeof accountSummarySchema>;

export const legacyTargetAliasSchema = z.object({
  accountId: accountIdSchema,
  legacyTargetKey: z.string().min(1),
  targetRef: targetRefSchema,
  channel: channelSchema,
  createdAt: z.string(),
}).strict();
export type LegacyTargetAlias = z.infer<typeof legacyTargetAliasSchema>;

const command = z.literal('accounts');
export const accountsCommandSchema = z.discriminatedUnion('action', [
  z.object({ command, action: z.literal('listAccounts') }).strict(),
  z.object({
    command,
    action: z.literal('registerAccount'),
    commandId: z.uuid(),
    platform: platformIdSchema,
    connector: connectorSchema,
    accountId: accountIdSchema.optional(),
    ownId: ownIdSchema.optional(),
    displayLabel: displayLabelSchema.optional(),
    profileRef: profileRefSchema.optional(),
  }).strict(),
  z.object({ command, action: z.literal('getAccountStatus'), accountRef: accountRefSchema }).strict(),
  z.object({
    command,
    action: z.literal('disconnectAccount'),
    commandId: z.uuid(),
    accountRef: accountRefSchema,
    confirmed: z.literal(true),
  }).strict(),
]);
export type AccountsCommand = z.infer<typeof accountsCommandSchema>;
