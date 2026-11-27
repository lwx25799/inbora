import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  BILIBILI_PLATFORM_ID,
  XIAOHONGSHU_PLATFORM_ID,
  webBrowserPlatformIdSchema,
  type WebBrowserPlatformId,
} from '../contracts/account.js';
import { Blocked, requireSafe } from '../core/contracts.js';

const selector = z.string().min(1).max(2000);
const attrName = z.string().min(1).max(128);
const nonEmptyText = z.string().trim().min(1).max(128);

export const WEB_PLATFORM_DEFAULT_SECURITY_BLOCKERS =
  '.captcha-modal,#captcha_container,[id^="captcha_container"],.geetest_panel,.bili-mini-mask,.red-captcha';

export const WEB_PLATFORM_ORIGIN_WHITELIST: Record<WebBrowserPlatformId, readonly string[]> = {
  [XIAOHONGSHU_PLATFORM_ID]: ['https://www.xiaohongshu.com', 'https://creator.xiaohongshu.com'],
  [BILIBILI_PLATFORM_ID]: [
    'https://www.bilibili.com',
    'https://message.bilibili.com',
    'https://member.bilibili.com',
  ],
};

export const webPlatformCommentObservationSelectorsSchema = z.object({
  entry: selector.optional(),
  list: selector,
  rows: selector,
  rowIdAttribute: attrName.optional(),
  parentIdAttribute: attrName.optional(),
  videoIdAttribute: attrName.optional(),
  authorId: selector.optional(),
  authorIdAttribute: attrName.optional(),
  authorName: selector.optional(),
  text: selector,
  time: selector.optional(),
  timeAttribute: attrName.optional(),
  fromMeClass: z.string().min(1).max(128).optional(),
});

export const webPlatformDmObservationSelectorsSchema = z.object({
  entry: selector.optional(),
  list: selector.optional(),
  conversationRows: selector.optional(),
  conversationIdAttribute: attrName.optional(),
  peerIdAttribute: attrName.optional(),
  peerName: selector.optional(),
  selectAction: selector.optional(),
  pane: selector,
  activeConversationId: selector.optional(),
  activeConversationIdAttribute: attrName.optional(),
  messages: selector,
  messageIdAttribute: attrName.optional(),
  senderIdAttribute: attrName.optional(),
  messageText: selector,
  messageTime: selector.optional(),
  messageTimeAttribute: attrName.optional(),
  fromMeClass: z.string().min(1).max(128).optional(),
});

export const webPlatformObservationSelectorsSchema = z.object({
  selfId: selector,
  selfIdAttribute: attrName.optional(),
  securityBlockers: selector.default(WEB_PLATFORM_DEFAULT_SECURITY_BLOCKERS),
  loginRequired: selector.optional(),
  comment: webPlatformCommentObservationSelectorsSchema.optional(),
  dm: webPlatformDmObservationSelectorsSchema.optional(),
}).refine(
  value => Boolean(value.comment || value.dm),
  { message: 'WEB_PLATFORM_CHANNEL_SELECTORS_REQUIRED' },
);

export const webPlatformCommentReplySelectorsSchema = webPlatformCommentObservationSelectorsSchema.extend({
  openReply: selector.optional(),
  directRepliesSelector: selector.optional(),
  composer: selector,
  send: selector,
  outgoingRows: selector,
  proofIdAttribute: attrName.optional(),
  proofOwnIdAttribute: attrName.optional(),
  proofText: selector.optional(),
  proofTime: selector.optional(),
  proofTimeAttribute: attrName.optional(),
  proofConfirmedSelector: selector.optional(),
  proofConfirmedAttribute: attrName.optional(),
  proofConfirmedValue: z.string().min(1).max(128).optional(),
  proofPendingSelector: selector.optional(),
  proofFailedSelector: selector.optional(),
});

export const webPlatformDmReplySelectorsSchema = webPlatformDmObservationSelectorsSchema.extend({
  composer: selector,
  send: selector,
  outgoingRows: selector,
  proofIdAttribute: attrName.optional(),
  proofOwnIdAttribute: attrName.optional(),
  proofText: selector.optional(),
  proofTime: selector.optional(),
  proofTimeAttribute: attrName.optional(),
  proofConfirmedSelector: selector.optional(),
  proofConfirmedAttribute: attrName.optional(),
  proofConfirmedValue: z.string().min(1).max(128).optional(),
  proofPendingSelector: selector.optional(),
  proofFailedSelector: selector.optional(),
});

export const webPlatformReplySelectorsSchema = z.object({
  selfId: selector,
  selfIdAttribute: attrName.optional(),
  securityBlockers: selector.default(WEB_PLATFORM_DEFAULT_SECURITY_BLOCKERS),
  loginRequired: selector.optional(),
  comment: webPlatformCommentReplySelectorsSchema.optional(),
  dm: webPlatformDmReplySelectorsSchema.optional(),
}).refine(
  value => Boolean(value.comment || value.dm),
  { message: 'WEB_PLATFORM_REPLY_CHANNEL_SELECTORS_REQUIRED' },
);

export const webPlatformObservationMappingSchema = z.object({
  version: z.literal(1).default(1),
  platform: webBrowserPlatformIdSchema,
  environment: z.enum(['fixture', 'production']),
  origin: z.url(),
  entryUrl: z.url(),
  selfId: nonEmptyText,
  observedAt: z.iso.datetime().optional(),
  evidenceRef: z.string().min(1).optional(),
  selectors: webPlatformObservationSelectorsSchema,
});
export type WebPlatformObservationMapping = z.infer<typeof webPlatformObservationMappingSchema>;

export const webPlatformReplyMappingSchema = z.object({
  version: z.literal(1).default(1),
  platform: webBrowserPlatformIdSchema,
  environment: z.enum(['fixture', 'production']),
  origin: z.url(),
  entryUrl: z.url(),
  selfId: nonEmptyText,
  observedAt: z.iso.datetime().optional(),
  evidenceRef: z.string().min(1).optional(),
  selectors: webPlatformReplySelectorsSchema,
});
export type WebPlatformReplyMapping = z.infer<typeof webPlatformReplyMappingSchema>;

export interface ValidateWebMappingOptions {
  platform?: WebBrowserPlatformId;
  allowFixture?: boolean;
}

function assertAllowedOriginAndEntry(
  mapping: {
    platform: WebBrowserPlatformId;
    environment: 'fixture' | 'production';
    origin: string;
    entryUrl: string;
    evidenceRef?: string | undefined;
  },
  options: ValidateWebMappingOptions = {},
): void {
  if (options.platform) {
    requireSafe(mapping.platform === options.platform, 'PLATFORM_MAPPING_MISMATCH');
  }
  const parsedOrigin = new URL(mapping.origin);
  requireSafe(
    parsedOrigin.origin === mapping.origin && !parsedOrigin.username && !parsedOrigin.password,
    'INVALID_ORIGIN',
  );
  if (mapping.environment === 'production') {
    const allowed = WEB_PLATFORM_ORIGIN_WHITELIST[mapping.platform];
    requireSafe(allowed.includes(mapping.origin), 'REAL_MAPPING_REQUIRED');
    requireSafe(
      typeof mapping.evidenceRef === 'string' && mapping.evidenceRef.trim().length > 0,
      'CALIBRATION_EVIDENCE_REQUIRED',
    );
  } else {
    requireSafe(options.allowFixture === true, 'REAL_MAPPING_REQUIRED');
    requireSafe(
      parsedOrigin.protocol === 'http:' && (parsedOrigin.hostname === '127.0.0.1' || parsedOrigin.hostname === 'localhost'),
      'LOCAL_FIXTURE_REQUIRED',
    );
  }
  const parsedEntry = new URL(mapping.entryUrl);
  requireSafe(
    parsedEntry.protocol === parsedOrigin.protocol
    && parsedEntry.origin === mapping.origin
    && !parsedEntry.username
    && !parsedEntry.password
    && !parsedEntry.hash,
    'UNSAFE_OBSERVATION_URL',
  );
}

export function validateWebPlatformObservationMapping(
  value: unknown,
  options?: ValidateWebMappingOptions,
): WebPlatformObservationMapping {
  const mapping = webPlatformObservationMappingSchema.parse(value);
  assertAllowedOriginAndEntry(mapping, options);
  return mapping;
}

export function validateWebPlatformReplyMapping(
  value: unknown,
  options?: ValidateWebMappingOptions,
): WebPlatformReplyMapping {
  const mapping = webPlatformReplyMappingSchema.parse(value);
  assertAllowedOriginAndEntry(mapping, options);
  return mapping;
}

export function webPlatformMappingDir(accountRoot: string): string {
  return join(accountRoot, 'mappings');
}

export function webPlatformObservationMappingPath(accountRoot: string, platform: WebBrowserPlatformId): string {
  return join(webPlatformMappingDir(accountRoot), `${platform}.observation.json`);
}

export function webPlatformReplyMappingPath(accountRoot: string, platform: WebBrowserPlatformId): string {
  return join(webPlatformMappingDir(accountRoot), `${platform}.reply.json`);
}

export async function loadWebPlatformObservationMapping(
  accountRoot: string,
  platform: WebBrowserPlatformId,
  options?: Omit<ValidateWebMappingOptions, 'platform'>,
): Promise<WebPlatformObservationMapping | null> {
  let raw: string;
  try {
    raw = await readFile(webPlatformObservationMappingPath(accountRoot, platform), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return validateWebPlatformObservationMapping(JSON.parse(raw), { allowFixture: false, ...options, platform });
}

export async function loadWebPlatformReplyMapping(
  accountRoot: string,
  platform: WebBrowserPlatformId,
  options?: Omit<ValidateWebMappingOptions, 'platform'>,
): Promise<WebPlatformReplyMapping | null> {
  let raw: string;
  try {
    raw = await readFile(webPlatformReplyMappingPath(accountRoot, platform), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return validateWebPlatformReplyMapping(JSON.parse(raw), { allowFixture: false, ...options, platform });
}

export async function hasCalibratedWebReplyMapping(
  accountRoot: string,
  platform: WebBrowserPlatformId,
  options?: Omit<ValidateWebMappingOptions, 'platform'>,
): Promise<boolean> {
  try {
    return (await loadWebPlatformReplyMapping(accountRoot, platform, options)) !== null;
  } catch {
    return false;
  }
}

export async function requireCalibratedWebReplyMapping(
  accountRoot: string,
  platform: WebBrowserPlatformId,
  options?: Omit<ValidateWebMappingOptions, 'platform'>,
): Promise<WebPlatformReplyMapping> {
  try {
    const mapping = await loadWebPlatformReplyMapping(accountRoot, platform, options);
    if (!mapping) throw new Blocked('PLATFORM_MAPPING_UNCALIBRATED');
    return mapping;
  } catch (error) {
    if (error instanceof Blocked && error.code === 'PLATFORM_MAPPING_UNCALIBRATED') throw error;
    throw new Blocked('PLATFORM_MAPPING_UNCALIBRATED');
  }
}
