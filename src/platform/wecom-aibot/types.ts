import type { LookupAddress } from 'node:dns';
import type { AccountId } from '../../contracts/account.js';
import type { PlatformCapabilities } from '../platform-connector.js';

export const WECOM_AIBOT_PLATFORM_ID = 'wecom-aibot' as const;
export const WECOM_AIBOT_DEFAULT_WS_URL = 'wss://openws.work.weixin.qq.com' as const;
export const WECOM_REPLY_MAX_UTF8_BYTES = 20_480;
export const WECOM_MAX_INBOUND_FRAME_BYTES = 2 * 1024 * 1024;

export const WsCmd = {
  SUBSCRIBE: 'aibot_subscribe',
  HEARTBEAT: 'ping',
  CALLBACK: 'aibot_msg_callback',
  EVENT_CALLBACK: 'aibot_event_callback',
  RESPONSE: 'aibot_respond_msg',
  SEND_MSG: 'aibot_send_msg',
} as const;

export type WsCmdValue = typeof WsCmd[keyof typeof WsCmd];

export type WecomWsConnectionState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'DEGRADED'
  | 'ERROR';

export interface WecomWsFrameHeaders {
  req_id: string;
  [key: string]: unknown;
}

export interface WecomWsFrame<TBody = unknown> {
  cmd?: string;
  headers: WecomWsFrameHeaders;
  body?: TBody;
  errcode?: number;
  errmsg?: string;
}

export interface WecomMixedMessageItem {
  msgtype: 'text' | 'image' | string;
  text?: { content?: string };
  image?: { url?: string; aeskey?: string };
}

export interface WecomQuoteMessage {
  msgtype?: string;
  text?: { content?: string };
  image?: { url?: string; aeskey?: string };
  voice?: { content?: string };
  file?: { url?: string; aeskey?: string };
  video?: { url?: string; aeskey?: string };
  mixed?: { msg_item?: WecomMixedMessageItem[] };
}

export interface WecomInboundMessageBody {
  msgid: string;
  aibotid: string;
  chatid?: string;
  chattype: 'single' | 'group';
  from: { userid: string; name?: string };
  create_time?: number;
  msgtype: 'text' | 'image' | 'voice' | 'file' | 'video' | 'mixed' | string;
  text?: { content?: string };
  image?: { url?: string; aeskey?: string };
  voice?: { content?: string };
  file?: { url?: string; aeskey?: string; name?: string };
  video?: { url?: string; aeskey?: string };
  mixed?: { msg_item?: WecomMixedMessageItem[] };
  quote?: WecomQuoteMessage;
}

export interface WecomInboundEventBody {
  msgid?: string;
  aibotid?: string;
  chatid?: string;
  chattype?: 'single' | 'group';
  from?: { userid?: string };
  create_time?: number;
  msgtype?: 'event' | string;
  event?: { eventtype?: string; [key: string]: unknown };
}

export interface WecomStreamReplyBody {
  msgtype: 'stream';
  stream: {
    id: string;
    finish: true;
    content: string;
  };
}

export interface WecomActiveSendBody {
  chatid: string;
  msgtype: 'markdown' | 'text';
  markdown?: { content: string };
  text?: { content: string };
}

export interface WecomWebSocketEvent {
  data?: unknown;
  code?: number;
  reason?: string;
  error?: unknown;
}

export type WecomWebSocketListener = (event: WecomWebSocketEvent) => void;

export interface WecomWebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: WecomWebSocketListener): void;
  removeEventListener(type: 'open' | 'message' | 'error' | 'close', listener: WecomWebSocketListener): void;
}

export type WecomWebSocketFactory = (url: string) => WecomWebSocketLike;
export type WecomDnsLookup = (hostname: string, options: { all: true }) => Promise<LookupAddress[]>;

export interface WecomSendReplyParams {
  reqId: string;
  content: string;
  streamId?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface WecomActiveSendParams {
  chatId: string;
  content: string;
  msgType?: 'markdown' | 'text' | undefined;
  reqId?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface WecomSendReplyResult {
  reqId: string;
  streamId: string;
  ackSeq: number;
  requestAt: string;
  responseAt: string;
  errcode: 0;
}

export interface WecomWsClientStatus {
  state: WecomWsConnectionState;
  authenticated: boolean;
  endpointDigest: string;
  lastHeartbeatAt: number | null;
  reconnectAttempts: number;
  consecutiveAuthFailures: number;
  pendingAckCount: number;
  lateAckIgnoredCount: number;
  errorCode: string | null;
}

export interface WecomWsClientOptions {
  botId: string;
  secret: string | (() => string);
  wsUrl?: string | undefined;
  heartbeatIntervalMs?: number | undefined;
  missedPongThreshold?: number | undefined;
  ackTimeoutMs?: number | undefined;
  reconnectBaseDelayMs?: number | undefined;
  reconnectMaxDelayMs?: number | undefined;
  maxReconnectAttempts?: number | undefined;
  maxAuthFailureAttempts?: number | undefined;
  maxReplyBytes?: number | undefined;
  webSocketFactory?: WecomWebSocketFactory | undefined;
  dnsLookup?: WecomDnsLookup | undefined;
  now?: (() => number) | undefined;
  onMessage?: ((frame: WecomWsFrame<WecomInboundMessageBody>) => void) | undefined;
  onEvent?: ((frame: WecomWsFrame<WecomInboundEventBody>) => void) | undefined;
  onAuthenticated?: (() => void) | undefined;
  onDisconnected?: ((info: { code: number; manual: boolean }) => void) | undefined;
  onReconnecting?: ((info: { attempt: number; delayMs: number; reason: 'disconnect' | 'auth_failure' }) => void) | undefined;
  onError?: ((error: Error) => void) | undefined;
  onStateChange?: ((state: WecomWsConnectionState) => void) | undefined;
}

export interface WecomAibotCapabilities extends PlatformCapabilities {
  readonly transport: 'official_api';
}

export interface WecomAibotTransportStatus {
  transport: 'official_api';
  state: WecomWsConnectionState;
  endpointDigest: string | null;
  protocol: 'wecom_ws';
  lastHeartbeatAt: number | null;
  lastSyncAt: number | null;
  errorCode: string | null;
}

export interface WecomAibotConnectorOptions {
  accountId?: AccountId | undefined;
  botId: string;
  secret: string | (() => string);
  wsUrl?: string | undefined;
  allowGroupMessages?: boolean | undefined;
  autoPersistInbound?: boolean | undefined;
  heartbeatIntervalMs?: number | undefined;
  missedPongThreshold?: number | undefined;
  ackTimeoutMs?: number | undefined;
  reconnectBaseDelayMs?: number | undefined;
  reconnectMaxDelayMs?: number | undefined;
  maxReconnectAttempts?: number | undefined;
  maxAuthFailureAttempts?: number | undefined;
  maxReplyBytes?: number | undefined;
  webSocketFactory?: WecomWebSocketFactory | undefined;
  dnsLookup?: WecomDnsLookup | undefined;
  now?: (() => number) | undefined;
  onWsError?: ((error: Error) => void) | undefined;
}
