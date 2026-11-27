import type { LookupAddress } from 'node:dns';
import type { AccountId } from '../../contracts/account.js';
import { Blocked } from '../../core/contracts.js';
import type { PlatformCapabilities } from '../platform-connector.js';

export const WECHAT_KF_PLATFORM_ID = 'wechat-kf' as const;
export const WECHAT_KF_DEFAULT_API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin' as const;
export const WECHAT_KF_TOKEN_URL = `${WECHAT_KF_DEFAULT_API_BASE}/gettoken` as const;
export const WECHAT_KF_MAX_TEXT_BYTES = 2048 as const;
export const WECHAT_KF_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
export const WECHAT_KF_DEFAULT_TIMEOUT_MS = 15_000;
export const WECHAT_KF_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
export const WECHAT_KF_SESSION_WINDOW_LIMIT_ERRCODE = 95026 as const;
export const WECHAT_KF_TOKEN_EXPIRED_CODES: ReadonlySet<number> = new Set([40001, 40014, 42001]);

export type WeChatKfErrorCode =
  | 'WECHAT_KF_INVALID_AES_KEY'
  | 'WECHAT_KF_INVALID_SIGNATURE'
  | 'WECHAT_KF_INVALID_CIPHERTEXT'
  | 'WECHAT_KF_INVALID_PADDING'
  | 'WECHAT_KF_INVALID_PAYLOAD'
  | 'WECHAT_KF_RECEIVER_ID_MISMATCH'
  | 'WECHAT_KF_CREDENTIAL_REQUIRED'
  | 'WECHAT_KF_INVALID_ENDPOINT'
  | 'WECHAT_KF_UNSAFE_ENDPOINT'
  | 'WECHAT_KF_REDIRECT_REJECTED'
  | 'WECHAT_KF_INVALID_CALLBACK_URL'
  | 'WECHAT_KF_TIMEOUT'
  | 'WECHAT_KF_NETWORK_ERROR'
  | 'WECHAT_KF_HTTP_ERROR'
  | 'WECHAT_KF_RESPONSE_INVALID'
  | 'WECHAT_KF_RESPONSE_TOO_LARGE'
  | 'WECHAT_KF_TOKEN_FETCH_FAILED'
  | 'WECHAT_KF_TOKEN_EXPIRED'
  | 'WECHAT_KF_TEXT_TOO_LONG'
  | 'WECHAT_KF_INVALID_MSGID'
  | 'WECHAT_KF_SESSION_WINDOW_LIMIT'
  | 'WECHAT_KF_API_ERROR'
  | 'WECHAT_KF_BODY_TOO_LARGE'
  | 'WECHAT_KF_INVALID_WEBHOOK_QUERY'
  | 'WECHAT_KF_INVALID_WEBHOOK_XML'
  | 'WECHAT_KF_OPERATION_UNSUPPORTED'
  | 'WECHAT_KF_STORE_REQUIRED'
  | 'WECHAT_KF_STORE_CHANGED'
  | 'WECHAT_KF_ACCOUNT_CHANGED'
  | 'WECHAT_KF_EVENT_TARGET_REQUIRED'
  | 'WECHAT_KF_CLOSED';

export interface WeChatKfErrorDetails {
  readonly errcode?: number | undefined;
  readonly httpStatus?: number | undefined;
}

/** Controlled error type whose message never includes raw credentials, tokens, or message bodies. */
export class WeChatKfError extends Blocked {
  declare readonly code: WeChatKfErrorCode;
  readonly errcode?: number;
  readonly httpStatus?: number;

  constructor(code: WeChatKfErrorCode, details?: WeChatKfErrorDetails) {
    super(code);
    this.name = 'WeChatKfError';
    if (details?.errcode !== undefined) this.errcode = details.errcode;
    if (details?.httpStatus !== undefined) this.httpStatus = details.httpStatus;
  }
}

export type WeChatKfFetch = typeof fetch;
export type WeChatKfDnsLookup = (hostname: string, options: { all: true }) => Promise<LookupAddress[]>;

export interface WeChatKfCredentials {
  readonly corpId: string;
  readonly appSecret: string;
  readonly token?: string | undefined;
  readonly encodingAESKey?: string | undefined;
}

export type WeChatKfCredentialProvider = () => WeChatKfCredentials;

export interface WeChatKfDecryptedPayload {
  readonly message: string;
  readonly receiverId: string;
}

export interface WeChatKfTokenOptions {
  readonly apiBaseUrl?: string | undefined;
  readonly fetchImpl?: WeChatKfFetch | undefined;
  readonly lookup?: WeChatKfDnsLookup | undefined;
  readonly timeoutMs?: number | undefined;
  readonly refreshBufferMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface WeChatKfMessageEventPayload {
  readonly event_type: string;
  readonly open_kfid?: string | undefined;
  readonly external_userid?: string | undefined;
  readonly scene?: string | undefined;
  readonly scene_param?: string | undefined;
  readonly welcome_code?: string | undefined;
  readonly fail_msgid?: string | undefined;
  readonly fail_type?: number | undefined;
}

export interface WeChatKfMessage {
  readonly msgid: string;
  readonly open_kfid?: string | undefined;
  readonly external_userid?: string | undefined;
  readonly send_time: number;
  readonly origin: number;
  readonly servicer_userid?: string | undefined;
  readonly msgtype: string;
  readonly text?: { readonly content: string; readonly menu_id?: string | undefined } | undefined;
  readonly image?: { readonly media_id: string } | undefined;
  readonly voice?: { readonly media_id: string } | undefined;
  readonly video?: { readonly media_id: string } | undefined;
  readonly file?: { readonly media_id: string } | undefined;
  readonly location?: {
    readonly latitude?: number | undefined;
    readonly longitude?: number | undefined;
    readonly name?: string | undefined;
    readonly address?: string | undefined;
  } | undefined;
  readonly link?: {
    readonly title?: string | undefined;
    readonly desc?: string | undefined;
    readonly url?: string | undefined;
    readonly pic_url?: string | undefined;
  } | undefined;
  readonly miniprogram?: {
    readonly title?: string | undefined;
    readonly appid?: string | undefined;
    readonly pagepath?: string | undefined;
  } | undefined;
  readonly event?: WeChatKfMessageEventPayload | undefined;
}

export interface SyncMessagesRequest {
  readonly cursor?: string | undefined;
  readonly token?: string | undefined;
  readonly limit?: number | undefined;
  readonly voice_format?: number | undefined;
  readonly open_kfid?: string | undefined;
}

export interface SyncMessagesResponse {
  readonly errcode: number;
  readonly errmsg: string;
  readonly next_cursor?: string | undefined;
  readonly has_more?: number | undefined;
  readonly msg_list?: readonly WeChatKfMessage[] | undefined;
}

export interface SendTextMessageRequest {
  readonly touser: string;
  readonly openKfid: string;
  readonly content: string;
  readonly msgid?: string | undefined;
}

export interface SendTextMessageResponse {
  readonly errcode: number;
  readonly errmsg: string;
  readonly msgid: string;
}

export interface WeChatKfWebhookQuery {
  readonly msg_signature?: string | undefined;
  readonly timestamp?: string | undefined;
  readonly nonce?: string | undefined;
  readonly echostr?: string | undefined;
}

export interface WeChatKfWebhookEvent {
  readonly event: 'kf_msg_or_event';
  readonly token: string;
  readonly openKfId: string;
  readonly createTime: number | null;
  readonly toUserName: string | null;
}

export interface WeChatKfCursorStore {
  load(accountId: AccountId, openKfId: string): string | null | Promise<string | null>;
  save(accountId: AccountId, openKfId: string, cursor: string): void | Promise<void>;
}

export interface WeChatKfCapabilities extends PlatformCapabilities {
  readonly transport: 'official_api';
}

export type WeChatKfTransportState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'DEGRADED' | 'ERROR';

export interface WeChatKfTransportStatus {
  readonly transport: 'official_api';
  readonly state: WeChatKfTransportState;
  readonly endpointDigest: string | null;
  readonly protocol: 'wechat_kf_http';
  readonly lastHeartbeatAt?: number | null;
  readonly lastSyncAt?: number | null;
  readonly errorCode?: string | null;
}

export interface WeChatKfConnectorOptions {
  readonly accountId?: AccountId | undefined;
  readonly openKfId: string;
  readonly credentials: WeChatKfCredentials | WeChatKfCredentialProvider;
  readonly root?: string | undefined;
  readonly apiBaseUrl?: string | undefined;
  readonly fetchImpl?: WeChatKfFetch | undefined;
  readonly lookup?: WeChatKfDnsLookup | undefined;
  readonly timeoutMs?: number | undefined;
  readonly cursorStore?: WeChatKfCursorStore | undefined;
  readonly maxSyncPages?: number | undefined;
  readonly maxVerifyPages?: number | undefined;
  readonly syncPageLimit?: number | undefined;
  readonly now?: (() => number) | undefined;
}
