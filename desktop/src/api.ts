import { invoke } from "@tauri-apps/api/core";
import type { AccountId } from "../../src/contracts/account.js";
import type { BrowserStatus } from "../../src/contracts/browser-resources.js";
import type {
  ClientCommand,
  SendParams,
  AiSettings,
  InboxSync,
  BrowserDraftChoice,
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
export type { ReplyStatus, TimelineItem };

export type { SendParams, AiSettings, BrowserDraftChoice };
export interface Status {
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
export function request<T>(
  body:
    | ClientCommand
    | {
        command: "connect";
        runtime: string;
        initialize: boolean;
        consent: true;
      }
    | { command: "disconnect" },
): Promise<T> {
  return invoke<T>("client_request", { body });
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
