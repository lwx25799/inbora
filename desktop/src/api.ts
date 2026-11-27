import { invoke } from "@tauri-apps/api/core";
import {
  accountSummarySchema, DEFAULT_ACCOUNT_ID, DOUYIN_PLATFORM_ID, isOfficialApiPlatform, MOCK_PLATFORM_ID,
  officialChannelPublicConfigSchema, WECHAT_KF_PLATFORM_ID, WECOM_AIBOT_PLATFORM_ID,
  type AccountId, type AccountSummary, type AccountsCommand, type ChannelCredentialStorage,
  type ConfigureOfficialChannelCommand, type OfficialApiPlatformId, type OfficialChannelCredentialMode,
  type OfficialChannelPublicConfig,
} from "../../src/contracts/account.js";
import { isMutatingClientCommand, requiredScopeForCommand, type ProtocolScope } from "../../src/contracts/protocol-v2.js";
import type { BrowserStatus } from "../../src/contracts/browser-resources.js";
import type {
  ClientCommand,
  SendParams,
  AiSettings,
  InboxSync,
  BrowserDraftChoice,
  ModelProviderStatusFields,
} from "../../src/contracts/client.js";
import type {
  Draft,
  StoredEvent,
  InboundEvent,
} from "../../src/contracts/events.js";
import type { CollectionSettings, Grant, ModelGrant, ReplyPolicy } from '../../src/contracts/automation.js';
import type { CommentThreadPage, ReplyStatus, TimelineItem } from '../../src/contracts/inbox.js';
import type {LocalAssistantState} from '../../src/contracts/local-assistant.js';
import type {SecurityRuntime} from '../../src/contracts/diagnostics.js';
import {extractErrorCode} from './error-messages.js';
import {
  MODEL_PAGE_LIMIT, modelCatalogPageSchema, publicModelStateSchema,
  type ModelPresetId, type ModelProtocol, type PublicModelConnection, type PublicModelState,
} from '../../src/contracts/model-providers.js';
export type { ReplyStatus, TimelineItem };
export type {
  AccountSummary, AccountsCommand, ChannelCredentialStorage, ConfigureOfficialChannelCommand,
  OfficialApiPlatformId, OfficialChannelCredentialMode, OfficialChannelPublicConfig, ProtocolScope,
};
export { DOUYIN_PLATFORM_ID, MOCK_PLATFORM_ID, WECHAT_KF_PLATFORM_ID, WECOM_AIBOT_PLATFORM_ID, isOfficialApiPlatform };

export type { SendParams, AiSettings, BrowserDraftChoice };
export interface Status extends ModelProviderStatusFields {
  localAssistant?:LocalAssistantState;
  localAssistantConnection?:{ready:boolean;instanceId:string|null;transport:'stdio';tools:16};
  securityRuntime?:SecurityRuntime;
  securityHolds?:{channel:'DIRECT_MESSAGE'|'COMMENT_NOTIFICATION';reason:string;incidentId:string;revision:string;heldAt:number;mode:'headed'|'headless'}[];
  runtime: string;
  account: { id: AccountId; identity: string } | null;
  operator: { id: string; permissions: string[]; expiresAt: number };
  mode: "OBSERVE" | "DRAFT_ONLY" | "MANUAL" | "AI_ASSISTED" | "LIMITED_AUTO";
  configuredMode: Status["mode"];
  paused: boolean;
  browser: BrowserStatus;
  lastSync: { channel: string; at: string }[];
  capabilities: {
    channel: string;
    state: string;
    reason: string;
    evidence: string | null;
  }[];
  budgets: { kind: string; used: number; maximum: number|null }[];
  usage: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    unresolved: number;
  };
  settings: AiSettings;
  keyPresent: boolean;
  keyStored?:boolean;keyStorageError?:string|null;
  automation?:{startedAt:number;emergencyStopped:boolean;collection:CollectionSettings|null;modelGrant:Grant<ModelGrant>|null;replyPolicy:Grant<ReplyPolicy>|null;
    emergencyStop?:{reason:string;source:string;stoppedAt:number|null;legacy:boolean}|null;
    unresolvedSends?:{channel:string;count:number}[];
    inboxRevision:number;autoStopReason?:string|null;collector:{running:boolean;source:string|null;fatal:string|null;channels:{source:string;next_at:number;last_success:number|null;last_error:string|null;failures:number;elapsed_ms:number|null}[]};pendingWorks:{count:number}}|null;
  modelAuthorized: boolean;
  modelBusy: boolean;
  sync:InboxSync;
  go: string;
  schema: number;
}
export interface Inbox {
  total: number;
  unreadTotal?:number;
  page: number;
  pageSize: number;
  items: {
    id: string;
    status: string;
    replyStatus: ReplyStatus;
    unread?:boolean;
    channel: string;
    author: string | null;
    preview: string;
    previewDirection?:'INCOMING'|'OUTGOING';
    displayText?: string;
    time: string | null;
    source: string;
    groupKey?:string;
    latestEventId?:string;
    messageCount?:number;
    commentCount?:number;
    waitingCount?:number;
    resumeEventId?:string|null;
    previewEventId?:string;
    attachments?:TimelineItem['attachments'];
    share?:TimelineItem['share'];
  }[];
}
export interface Thread {
  groupKey?:string;
  timeline?:{items:TimelineItem[];pageSize:number;hasMore:boolean;before:string|null;projectionRevision?:string};
  replyStatus: ReplyStatus;
  conversationReplyStatus?: ReplyStatus;
  commentContext?: CommentThreadPage;
  controlledTrial: boolean;
  workUrl: string | null;
  event: StoredEvent;
  draft: (Draft & { origin: string }) | null;
  history: InboundEvent[];
  contextVersion: string;
  ownership: {
    operator_id: string | null;
    generation: number;
    lease_expires_at: number;
    isMine: boolean;
  };
  capability: { state: string; reason: string; evidence: string | null };
  strong: boolean;
  humanReplyEligibility?:{eligible:boolean;reason:string|null};
  suggestionEligibility?:{eligible:boolean;reason:string|null};
  paused: boolean;
  frozen: boolean;
  intent: { id: string; status: string } | null;
  followup?:{
    draft:(Draft & {origin:string})|null;
    latestTurn:{commandId:string;status:string;text:string;reason:string|null;intentId:string|null;verifiedAt:string|null}|null;
    eligible:boolean;queueReady?:boolean;reason:string|null;
  };
  receipt: { result: string; verified_at: string; proof_ref: string } | null;
  suggestions: {
    id: string;
    text: string;
    model: string;
    draft_version: number;
    context_version: string;
  }[];
  verification?:{state:string;attempts:number;last_error:string|null;verified:number|null;checked_at:number|null}|null;
  automationJob?:{state:string;reason:string|null;grant_version:number}|null;
}
export interface Review {
  commandId: string;
  expiresAt: number;
  params: SendParams;
  target: InboundEvent;
  account: string;
}
export type BusinessPrompts = Pick<AiSettings, 'persona' | 'business' | 'rules'>;

export async function saveBusinessPrompts(status: Status, settings: BusinessPrompts): Promise<Status> {
  if (status.modelProvidersSupported !== true) throw new Error('BUSINESS_PROMPTS_BACKEND_UPGRADE_REQUIRED');
  return request<Status>({command:'configureAi', settings});
}

export function runtimeSession(status: Status) {
  return JSON.stringify([status.runtime, status.operator.id, status.securityRuntime?.instanceId]);
}

export async function readModelCatalog(connection: PublicModelConnection) {
  if (!connection.modelsTruncated) return connection.models;
  const models: PublicModelConnection['models'] = [];
  const ids = new Set<string>();
  let offset: number | null = 0;
  while (offset !== null) {
    const page = modelCatalogPageSchema.parse(await request<unknown>({command:'modelProviders', action:'list',
      connectionId:connection.id, offset, limit:MODEL_PAGE_LIMIT}));
    if (page.connectionId !== connection.id || page.version !== connection.version || page.offset !== offset
      || page.totalModelCount !== connection.totalModelCount) throw new Error('MODEL_CONNECTION_CONFLICT');
    for (const model of page.models) {
      if (ids.has(model.modelId)) throw new Error('MODEL_PROVIDER_STATUS_UNCONFIRMED');
      ids.add(model.modelId);
      models.push(model);
    }
    const next = models.length < page.totalModelCount ? models.length : null;
    if (models.length > page.totalModelCount || page.nextOffset !== next || (next !== null && next <= offset)) {
      throw new Error('MODEL_PROVIDER_STATUS_UNCONFIRMED');
    }
    offset = next;
  }
  return models;
}

async function readConnectionPages(state: PublicModelState): Promise<PublicModelState> {
  const connections = [...state.connections];
  const ids = new Set(connections.map(connection => connection.id));
  let offset = state.nextConnectionOffset;
  while (offset != null) {
    const page = publicModelStateSchema.parse(await request<unknown>({command:'modelProviders', action:'list', offset,
      ...(state.listRevision === undefined ? {} : {expectedListRevision:state.listRevision})}));
    if (page.listRevision !== state.listRevision || page.selection.selectionRevision !== state.selection.selectionRevision
      || page.totalConnectionCount !== state.totalConnectionCount
      || offset !== connections.length || page.connections.some(connection => ids.has(connection.id))) {
      throw new Error('MODEL_CONNECTION_CONFLICT');
    }
    for (const connection of page.connections) ids.add(connection.id);
    connections.push(...page.connections);
    if (!page.connections.length || (page.nextConnectionOffset == null && connections.length !== state.totalConnectionCount)) {
      throw new Error('MODEL_PROVIDER_STATUS_UNCONFIRMED');
    }
    offset = page.nextConnectionOffset;
  }
  return {...state, connections, nextConnectionOffset:null};
}

export async function readModelConnections(first: Status) {
  let status = first;
  for (let attempt = 0; ; attempt++) {
    if (!status.modelProviders || status.modelProvidersAvailable !== true || runtimeSession(status) !== runtimeSession(first)) {
      throw new Error('MODEL_PROVIDER_STATUS_UNCONFIRMED');
    }
    try {
      return {status, state:await readConnectionPages(status.modelProviders)};
    } catch (error) {
      if (attempt >= 2 || extractErrorCode(error) !== 'MODEL_CONNECTION_CONFLICT') throw error;
      status = await request<Status>({command:'getStatus'});
    }
  }
}

type DesktopCommand = ClientCommand
  | { command: "connect"; runtime: string; initialize: boolean; consent: true }
  | { command: "disconnect" };

export interface ActiveWorkbenchAccount {
  accountRef: AccountId;
  displayLabel: string;
  platform: string;
}

interface AccountRouting {
  session: string;
  accountRef: AccountId;
  active: Set<AccountId> | null;
  loading: Promise<AccountSummary[]> | null;
}
let accountRouting: AccountRouting | null = null;
let activeWorkbenchAccount: ActiveWorkbenchAccount | null = null;

export function getActiveWorkbenchAccount(): ActiveWorkbenchAccount | null {
  return activeWorkbenchAccount;
}

export function setActiveWorkbenchAccount(next: ActiveWorkbenchAccount | null): void {
  activeWorkbenchAccount = next && next.accountRef !== DEFAULT_ACCOUNT_ID ? next : null;
}

function observeRoutingStatus(status: Status): void {
  if (!(status?.schema >= 4)) {
    accountRouting = null;
    activeWorkbenchAccount = null;
    return;
  }
  const session = runtimeSession(status);
  const accountRef = status.account?.id ?? DEFAULT_ACCOUNT_ID;
  if (accountRouting?.session === session) accountRouting.accountRef = accountRef;
  else accountRouting = { session, accountRef, active: null, loading: null };
}

function writeV2<T>(routing: AccountRouting, body: ClientCommand, kind: ProtocolScope['kind']): Promise<T> {
  const scope: ProtocolScope = kind === 'GLOBAL' ? { kind } : {
    kind, accountRef: 'accountRef' in body ? body.accountRef : routing.accountRef,
  };
  const commandId = ('commandId' in body ? body.commandId : undefined) ?? crypto.randomUUID();
  return requestV2<T>(scope, body, commandId);
}

export async function request<T>(body: DesktopCommand): Promise<T> {
  if (body.command === 'emergencyStop') return invoke<T>("client_request", { body });
  const routing = accountRouting;
  if (body.command === 'connect' || body.command === 'disconnect') {
    try {
      const result = await invoke<T>("client_request", { body });
      if (body.command === 'disconnect') {
        accountRouting = null;
        activeWorkbenchAccount = null;
      } else {
        activeWorkbenchAccount = null;
        observeRoutingStatus(result as Status);
      }
      return result;
    } catch (error) {
      if (accountRouting === routing && extractErrorCode(error) === 'CONNECT_RUNTIME_FIRST') {
        accountRouting = null;
        activeWorkbenchAccount = null;
      }
      throw error;
    }
  }

  // When the operator has switched the workbench to a secondary official account,
  // route all account-scoped reads and writes explicitly over Protocol V2.
  if (activeWorkbenchAccount && activeWorkbenchAccount.accountRef !== DEFAULT_ACCOUNT_ID) {
    const scopeKind = requiredScopeForCommand(body);
    if (scopeKind === 'ACCOUNT') {
      const targetRef = 'accountRef' in body ? body.accountRef : activeWorkbenchAccount.accountRef;
      const mutating = isMutatingClientCommand(body);
      const commandId = mutating
        ? (('commandId' in body ? body.commandId : undefined) ?? crypto.randomUUID())
        : undefined;
      return requestV2<T>({ kind: 'ACCOUNT', accountRef: targetRef }, body, commandId);
    }
  }

  if (body.command === 'getStatus') {
    try {
      const result = await invoke<T>("client_request", { body });
      if (accountRouting === routing) observeRoutingStatus(result as Status);
      return result;
    } catch (error) {
      if (accountRouting === routing && extractErrorCode(error) === 'CONNECT_RUNTIME_FIRST') accountRouting = null;
      throw error;
    }
  }

  const kind = routing && isMutatingClientCommand(body) ? requiredScopeForCommand(body) : null;
  if (!routing || !kind) return invoke<T>("client_request", { body });
  if (!routing.active) {
    // A schema4 connection can already have multiple accounts before Settings is opened.
    await listAccountsV2().catch(() => {});
    if (routing !== accountRouting) throw new Error('CONNECT_RUNTIME_FIRST');
  }
  if (routing.active && routing.active.size > 1) return writeV2<T>(routing, body, kind);
  try {
    return await invoke<T>("client_request", { body });
  } catch (error) {
    // This rejection happens before dispatch, so a scoped request cannot replay a write.
    if (routing !== accountRouting || extractErrorCode(error) !== 'PROTOCOL_V2_ACCOUNT_SCOPE_REQUIRED') throw error;
    routing.active = null;
    return writeV2<T>(routing, body, kind);
  }
}

export function requestV2<T>(
  scope: ProtocolScope,
  body: DesktopCommand,
  commandId?: string,
): Promise<T> {
  return invoke<T>("client_request_v2", { scope, body, ...(commandId ? { commandId } : {}) });
}

export const platformNames: Record<string, string> = {
  [DOUYIN_PLATFORM_ID]: '抖音',
  [WECOM_AIBOT_PLATFORM_ID]: '企业微信智能机器人',
  [WECHAT_KF_PLATFORM_ID]: '微信客服',
  [MOCK_PLATFORM_ID]: '合成验证平台 (Mock)',
};

export async function listAccountsV2(status?: Status): Promise<AccountSummary[]> {
  if (status) observeRoutingStatus(status);
  const routing = accountRouting;
  if (routing?.loading) return routing.loading;
  const loading = requestV2<{ accounts: unknown }>({ kind: 'GLOBAL' }, { command: 'accounts', action: 'listAccounts' })
    .then(result => accountSummarySchema.array().parse(result.accounts));
  if (routing) routing.loading = loading;
  try {
    const accounts = await loading;
    if (routing?.loading === loading) {
      routing.active = new Set(accounts.filter(account => account.status === 'ACTIVE').map(account => account.accountRef));
    }
    return accounts;
  } finally {
    if (routing?.loading === loading) routing.loading = null;
  }
}

export interface MockRegistration {
  commandId: string;
  displayLabel: string;
}

export function mockRegistrationAccountRef(commandId: string): AccountId {
  return `account_${commandId}`;
}

export function accountRegistrationUnconfirmed(error: unknown): boolean {
  return ['', 'COMMAND_IN_PROGRESS', 'IPC_RESPONSE_UNKNOWN_READ_STATUS', 'SIDECAR_CLOSED',
    'SIDECAR_RESPONSE_TOO_LARGE', 'DEV_BACKEND_RESTARTING_READ_STATUS',
    'DEV_BACKEND_UNAVAILABLE_RESTART_REQUIRED', 'OPERATION_FAILED_PRIVATE_DIAGNOSTICS',
  ].includes(extractErrorCode(error));
}

async function changeAccount(scope: ProtocolScope, body: Extract<AccountsCommand, { commandId: string }>): Promise<AccountSummary> {
  const routing = accountRouting;
  try {
    const account = await requestV2<AccountSummary>(scope, body, body.commandId);
    if (routing) {
      routing.loading = null; // A list started before the write can describe the old account set.
      if (body.action === 'disconnectAccount') routing.active?.delete(account.accountRef);
      else if (account.status === 'ACTIVE') routing.active?.add(account.accountRef);
    }
    return account;
  } catch (error) {
    if (routing && accountRegistrationUnconfirmed(error)) {
      routing.active = null;
      routing.loading = null;
    }
    throw error;
  }
}

export function registerMockAccountV2({ commandId, displayLabel }: MockRegistration): Promise<AccountSummary> {
  return changeAccount({ kind: 'GLOBAL' }, {
    command: 'accounts', action: 'registerAccount', commandId, accountId: mockRegistrationAccountRef(commandId),
    platform: MOCK_PLATFORM_ID, connector: MOCK_PLATFORM_ID, displayLabel,
  });
}

export interface OfficialAccountRegistration {
  commandId: string;
  platform: OfficialApiPlatformId;
  ownId: string;
  displayLabel: string;
}

export function registerOfficialAccountV2({
  commandId, platform, ownId, displayLabel,
}: OfficialAccountRegistration): Promise<AccountSummary> {
  return changeAccount({ kind: 'GLOBAL' }, {
    command: 'accounts',
    action: 'registerAccount',
    commandId,
    accountId: mockRegistrationAccountRef(commandId),
    platform,
    connector: platform,
    ownId,
    displayLabel,
  });
}

export function getOfficialChannelConfigV2(accountRef: AccountSummary['accountRef']): Promise<OfficialChannelPublicConfig> {
  return requestV2<unknown>(
    { kind: 'ACCOUNT', accountRef },
    { command: 'accounts', action: 'getOfficialChannelConfig', accountRef },
  ).then(value => officialChannelPublicConfigSchema.parse(value));
}

export function configureOfficialChannelV2(
  payload: ConfigureOfficialChannelCommand,
): Promise<OfficialChannelPublicConfig> {
  return requestV2<unknown>(
    { kind: 'ACCOUNT', accountRef: payload.accountRef },
    payload,
    payload.commandId,
  ).then(value => officialChannelPublicConfigSchema.parse(value));
}

export function connectOfficialChannelV2(accountRef: AccountSummary['accountRef']): Promise<OfficialChannelPublicConfig> {
  const commandId = crypto.randomUUID();
  return requestV2<unknown>(
    { kind: 'ACCOUNT', accountRef },
    { command: 'accounts', action: 'connectOfficialChannel', commandId, accountRef },
    commandId,
  ).then(value => officialChannelPublicConfigSchema.parse(value));
}

export function disconnectOfficialChannelV2(accountRef: AccountSummary['accountRef']): Promise<OfficialChannelPublicConfig> {
  const commandId = crypto.randomUUID();
  return requestV2<unknown>(
    { kind: 'ACCOUNT', accountRef },
    { command: 'accounts', action: 'disconnectOfficialChannel', commandId, accountRef },
    commandId,
  ).then(value => officialChannelPublicConfigSchema.parse(value));
}

export function observeOfficialAccountV2(accountRef: AccountSummary['accountRef']): Promise<unknown> {
  const commandId = crypto.randomUUID();
  return requestV2<unknown>(
    { kind: 'ACCOUNT', accountRef },
    { command: 'observe', source: 'dm' },
    commandId,
  );
}

export function disconnectAccountV2(accountRef: AccountSummary['accountRef']): Promise<AccountSummary> {
  return changeAccount({ kind: 'ACCOUNT', accountRef }, {
    command: 'accounts', action: 'disconnectAccount', commandId: crypto.randomUUID(), accountRef, confirmed: true,
  });
}

export function reactivateAccountV2(accountRef: AccountSummary['accountRef']): Promise<AccountSummary> {
  return changeAccount({ kind: 'ACCOUNT', accountRef }, {
    command: 'accounts', action: 'reactivateAccount', commandId: crypto.randomUUID(), accountRef, confirmed: true,
  });
}

export function desktopInfo(): Promise<{ runtime: string; version: string; rememberedRuntime?: string|null; features?:{replyKnowledge?:boolean} }> {
  return invoke("desktop_info");
}
export async function restoreDesktop() {
  let status:Status|null=null,unconnected=false;
  for(let attempt=0;attempt<20;attempt++){
    try{status=await request<Status>({command:'getStatus'});break;}
    catch(error){
      const code=typeof error==='string'?error:error instanceof Error?error.message:'';
      if(code==='CONNECT_RUNTIME_FIRST'){unconnected=true;break;}
      if(code!=='DEV_BACKEND_RESTARTING_READ_STATUS'||attempt===19)break;
      await new Promise(resolve=>setTimeout(resolve,250));
    }
  }
  const info=await desktopInfo();
  const previous=info.rememberedRuntime||localStorage.getItem('inbora-runtime');
  let runtime=status?.runtime??previous??info.runtime,error=!status&&!unconnected?'无法自动连接已保存的运行目录，请检查目录或重新连接。':'';
  if(!status&&unconnected&&previous){
    try{
      status=await request<Status>({command:'connect',runtime:previous,initialize:false,consent:true});
      runtime=status.runtime;
    }catch{error='无法自动连接已保存的运行目录，请检查目录或重新连接。';}
  }
  if(status)localStorage.setItem('inbora-runtime',status.runtime);
  return {runtime,version:info.version,status,error};
}
export function closeDesktop(): Promise<void> {
  return invoke("desktop_exit");
}
export { errorMessages as reasons, explain } from './error-messages.js';
export const modelPresetNames: Record<ModelPresetId, string> = {
  deepseek:'DeepSeek', openai:'OpenAI', anthropic:'Claude', gemini:'Gemini', qwen:'通义千问',
  doubao:'豆包', siliconflow:'硅基流动', openrouter:'OpenRouter', custom:'自定义',
};
export const modelProtocolNames: Record<ModelProtocol, string> = {
  OPENAI_CHAT:'OpenAI Chat Completions', OPENAI_RESPONSES:'OpenAI Responses',
  ANTHROPIC_MESSAGES:'Anthropic Messages', GEMINI_GENERATE_CONTENT:'Gemini GenerateContent',
};
export const capabilityNames: Record<string, string> = {
  READ_OK: "已验证读取",
  SEND_REVIEW_ONLY: "发送待验证",
  SEND_AVAILABLE: "发送已开通",
  BLOCKED: "通道已阻断",
};
export const sourceNames: Record<string, string> = {
  DIRECT_MESSAGE: "私信入口",
  NOTIFICATION: "顶部通知",
  ALLOWED_WORK: "作品补充发现",
};
