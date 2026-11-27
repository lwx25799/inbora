import { z } from 'zod';

export const DEFAULT_ACCOUNT_ID = 'account_001';
export const accountIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
export type AccountId = z.infer<typeof accountIdSchema>;

export const DOUYIN_PLATFORM_ID = 'douyin';
export const XIAOHONGSHU_PLATFORM_ID = 'xiaohongshu';
export const BILIBILI_PLATFORM_ID = 'bilibili';
export const WEB_BROWSER_PLATFORM_IDS = [XIAOHONGSHU_PLATFORM_ID, BILIBILI_PLATFORM_ID] as const;
export type WebBrowserPlatformId = typeof WEB_BROWSER_PLATFORM_IDS[number];
export const webBrowserPlatformIdSchema = z.enum(WEB_BROWSER_PLATFORM_IDS);
export function isWebBrowserPlatform(platform: string): platform is WebBrowserPlatformId {
  return platform === XIAOHONGSHU_PLATFORM_ID || platform === BILIBILI_PLATFORM_ID;
}
export const MOCK_PLATFORM_ID = 'mock-platform';
export const WECOM_AIBOT_PLATFORM_ID = 'wecom-aibot';
export const WECHAT_KF_PLATFORM_ID = 'wechat-kf';
export const OFFICIAL_API_PLATFORM_IDS = [WECOM_AIBOT_PLATFORM_ID, WECHAT_KF_PLATFORM_ID] as const;
export type OfficialApiPlatformId = typeof OFFICIAL_API_PLATFORM_IDS[number];
export const officialApiPlatformIdSchema = z.enum(OFFICIAL_API_PLATFORM_IDS);
export function isOfficialApiPlatform(platform: string): platform is OfficialApiPlatformId {
  return platform === WECOM_AIBOT_PLATFORM_ID || platform === WECHAT_KF_PLATFORM_ID;
}
export const platformIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
export type PlatformId = z.infer<typeof platformIdSchema>;

export const platformTransportSchema = z.enum(['browser', 'official_api', 'desktop_uia', 'copilot_webview']);
export type PlatformTransport = z.infer<typeof platformTransportSchema>;

export const channelCredentialStorageSchema = z.enum(['MEMORY', 'DPAPI']);
export type ChannelCredentialStorage = z.infer<typeof channelCredentialStorageSchema>;

export const officialChannelCredentialModeSchema = z.enum(['KEEP', 'SET', 'DELETE']);
export type OfficialChannelCredentialMode = z.infer<typeof officialChannelCredentialModeSchema>;

export const officialApiTransportStateSchema = z.enum(['DISCONNECTED', 'CONNECTING', 'CONNECTED', 'DEGRADED', 'ERROR']);
export const officialApiTransportStatusSchema = z.object({
  transport: z.literal('official_api'),
  state: officialApiTransportStateSchema,
  protocol: z.enum(['wecom_ws', 'wechat_kf_http']),
  endpointDigest: z.string().max(128).nullable(),
  lastHeartbeatAt: z.number().nullable().optional(),
  lastSyncAt: z.number().nullable().optional(),
  errorCode: z.string().max(128).nullable().optional(),
}).strict();

const nonEmptySecretSchema = z.string().min(1).max(4000).refine(
  value => value.trim().length > 0 && !/[\r\n]/u.test(value) && !/\p{Cs}/u.test(value),
  'INVALID_CHANNEL_SECRET',
);
const optionalEndpointSchema = z.string().min(1).max(2048).nullable().optional();
const wecomBotIdSchema = z.string().min(1).max(128).refine(value => value.trim().length > 0 && !/[\r\n]/u.test(value));
const wechatCorpIdSchema = z.string().min(1).max(128).refine(value => value.trim().length > 0 && !/[\r\n]/u.test(value));
const wechatOpenKfIdSchema = z.string().min(1).max(128).refine(value => value.trim().length > 0 && !/[\r\n]/u.test(value));

const officialPublicBaseFields = {
  accountRef: accountIdSchema,
  credentialStorage: z.enum(['MEMORY', 'DPAPI', 'NONE']),
  secretConfigured: z.boolean(),
  credentialError: z.string().max(128).nullable(),
  connected: z.boolean(),
  transportStatus: officialApiTransportStatusSchema.nullable(),
  updatedAt: z.string().nullable(),
};

export const officialChannelPublicConfigSchema = z.discriminatedUnion('platform', [
  z.object({
    ...officialPublicBaseFields,
    platform: z.literal(WECOM_AIBOT_PLATFORM_ID),
    botId: z.string().max(128),
    wsUrl: z.string().max(2048).nullable(),
    allowGroupMessages: z.boolean(),
  }).strict(),
  z.object({
    ...officialPublicBaseFields,
    platform: z.literal(WECHAT_KF_PLATFORM_ID),
    corpId: z.string().max(128),
    openKfId: z.string().max(128),
    apiBaseUrl: z.string().max(2048).nullable(),
    webhookSecretConfigured: z.boolean(),
  }).strict(),
]);
export type OfficialChannelPublicConfig = z.infer<typeof officialChannelPublicConfigSchema>;

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
const configureWecomAibotCommandSchema = z.object({
  command,
  action: z.literal('configureOfficialChannel'),
  commandId: z.uuid(),
  accountRef: accountRefSchema,
  platform: z.literal(WECOM_AIBOT_PLATFORM_ID),
  botId: wecomBotIdSchema,
  wsUrl: optionalEndpointSchema,
  allowGroupMessages: z.boolean().optional(),
  credentialMode: officialChannelCredentialModeSchema,
  storage: channelCredentialStorageSchema.optional(),
  secret: nonEmptySecretSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.credentialMode === 'SET' && !value.secret) {
    ctx.addIssue({ code: 'custom', path: ['secret'], message: 'CHANNEL_CREDENTIAL_REQUIRED' });
  }
  if (value.credentialMode !== 'SET' && value.secret !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['secret'], message: 'INVALID_COMMAND' });
  }
});

const configureWechatKfCommandSchema = z.object({
  command,
  action: z.literal('configureOfficialChannel'),
  commandId: z.uuid(),
  accountRef: accountRefSchema,
  platform: z.literal(WECHAT_KF_PLATFORM_ID),
  corpId: wechatCorpIdSchema,
  openKfId: wechatOpenKfIdSchema,
  apiBaseUrl: optionalEndpointSchema,
  credentialMode: officialChannelCredentialModeSchema,
  storage: channelCredentialStorageSchema.optional(),
  appSecret: nonEmptySecretSchema.optional(),
  token: nonEmptySecretSchema.nullable().optional(),
  encodingAESKey: nonEmptySecretSchema.nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.credentialMode === 'SET' && !value.appSecret) {
    ctx.addIssue({ code: 'custom', path: ['appSecret'], message: 'CHANNEL_CREDENTIAL_REQUIRED' });
  }
  if (value.credentialMode !== 'SET' && (value.appSecret !== undefined || value.token !== undefined || value.encodingAESKey !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['appSecret'], message: 'INVALID_COMMAND' });
  }
});

export const configureOfficialChannelCommandSchema = z.union([
  configureWecomAibotCommandSchema,
  configureWechatKfCommandSchema,
]);
export type ConfigureOfficialChannelCommand = z.infer<typeof configureOfficialChannelCommandSchema>;

export const accountsCommandSchema = z.union([
  z.discriminatedUnion('action', [
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
    z.object({
      command,
      action: z.literal('reactivateAccount'),
      commandId: z.uuid(),
      accountRef: accountRefSchema,
      confirmed: z.literal(true),
    }).strict(),
    z.object({ command, action: z.literal('getOfficialChannelConfig'), accountRef: accountRefSchema }).strict(),
    z.object({
      command,
      action: z.literal('connectOfficialChannel'),
      commandId: z.uuid(),
      accountRef: accountRefSchema,
    }).strict(),
    z.object({
      command,
      action: z.literal('disconnectOfficialChannel'),
      commandId: z.uuid(),
      accountRef: accountRefSchema,
    }).strict(),
  ]),
  configureOfficialChannelCommandSchema,
]);
export type AccountsCommand = z.infer<typeof accountsCommandSchema>;
