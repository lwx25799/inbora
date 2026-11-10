import { invoke } from "@tauri-apps/api/core";
import type {
  ClientCommand,
  SendParams,
  AiSettings,
  InboxSync,
  BrowserDraftChoice,
} from "../../src/app/contracts.js";
import type {
  Draft,
  StoredEvent,
  InboundEvent,
} from "../../src/core/contracts.js";
import type { CollectionSettings, Grant, ModelGrant, ReplyPolicy } from '../../src/app/automation-contracts.js';
import type { TimelineItem } from '../../src/app/inbox-queries.js';
export type { TimelineItem };

export type { SendParams, AiSettings, BrowserDraftChoice };
export interface Status {
  runtime: string;
  account: { id: string; identity: string } | null;
  operator: { id: string; permissions: string[]; expiresAt: number };
  mode: "OBSERVE" | "DRAFT_ONLY" | "MANUAL" | "AI_ASSISTED" | "LIMITED_AUTO";
  configuredMode: Status["mode"];
  paused: boolean;
  browser: {
    state: string;
    mode: "headed" | "headless";
    loginRecovery?:boolean;
    version: string | null;
  };
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
  page: number;
  pageSize: number;
  items: {
    id: string;
    status: string;
    replyStatus: 'WAITING'|'REPLIED';
    channel: string;
    author: string | null;
    preview: string;
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
  replyStatus: 'WAITING'|'REPLIED';
  conversationReplyStatus?: 'WAITING'|'REPLIED';
  commentContext?: ReturnType<typeof import('../../src/storage/comment-thread-context.js').commentThreadPage>;
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
  paused: boolean;
  frozen: boolean;
  intent: { id: string; status: string } | null;
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
export function desktopInfo(): Promise<{ runtime: string; version: string; rememberedRuntime?: string|null }> {
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
export const reasons: Record<string, string> = {
  BROWSER_DRAFT_NOT_RECOVERABLE:'当前没有可安全清理的已保存自动回复稿，网页输入已保留',
  BROWSER_DRAFT_NOT_MATCHED:'网页输入与已保存的自动回复稿不一致，未清理',
  BROWSER_DRAFT_CHANGED:'应用回复稿或会话已变化，未清理，请重新检查',
  NATIVE_REPLY_SAVED_DRAFT_MISMATCH:'网页输入与已保存的自动回复稿不一致，未清理',
  NATIVE_REPLY_SAVED_DRAFT_CHANGED:'网页输入或会话已变化，未清理，请重新检查',
  NATIVE_REPLY_SAVED_DRAFT_NOT_CLEARED:'未能确认网页输入已清空，应用回复稿保留，未发送或重试',
  POLICY_TARGETS_REQUIRED:'请为每个已选通道选择作品或会话范围，已保存策略和额度保持不变',
  LOGIN_RECOVERY_IN_PROGRESS:'正在等待本人登录或处理验证码，完成后自动恢复无头运行',
  BROWSER_HAS_HUMAN_INPUT:'专属网页中还有未提交输入，已保留，请处理后再切换浏览器',
  PREPARING:'正在后台准备与核验',
  AUTO_POLICY_REQUIRED:'请先设置并启用准确的自动回复策略',
  POLICY_NO_LONGER_AUTHORIZED:'自动回复策略已撤销、暂停或范围变化',
  MODEL_GRANT_EXHAUSTED:'持续模型授权额度已用尽',
  SEND_GRANT_EXHAUSTED:'持续发送授权额度已用尽',
  MODEL_OUTSIDE_GRANT:'当前通道或模型超出已启用授权',
  OWN_WORKS_METADATA_NOT_READY:'本人作品列表尚未取得可核验字段，已保留进度',
  DM_LIST_READ_FAILED:'私信会话列表读取未完成，后台保留进度并退避重试',
  DM_THREAD_READ_FAILED:'当前私信会话读取未完成，已暂缓此会话并继续其它会话',
  OBSERVATION_DM_CHAT_NOT_READY:'已尝试选择原生会话行，但聊天层未打开；已保留此会话并让出其它会话',
  OBSERVATION_COMMENT_TEXT_DOM_NOT_READY:'评论行已出现，正文组件仍未就绪；已保留进度',
  OBSERVATION_COMMENT_TOOLTIP_DOM_NOT_READY:'评论行已出现，原生编号组件仍未就绪；已保留进度',
  OBSERVATION_ACCOUNT_AVATAR_DOM_NOT_READY:'账号头像组件尚未就绪，身份核验未完成',
  OBSERVATION_ACCOUNT_AVATAR_DOM_NOT_UNIQUE:'账号头像组件不唯一，身份核验已停止',
  OBSERVATION_COMMENT_LIST_DOM_NOT_READY:'当前作品评论列表尚未就绪，已保留进度',
  OBSERVATION_COMMENT_LIST_DOM_NOT_UNIQUE:'当前作品评论列表不唯一，已停止本次读取',
  OBSERVATION_COMMENT_ROOTS_DOM_NOT_READY:'评论列表可见，但没有可核验的一级评论或明确空态',
  OBSERVATION_COMMENT_TEXT_DOM_NOT_UNIQUE:'评论正文组件不唯一，已停止当前作品读取',
  OBSERVATION_COMMENT_TOOLTIP_DOM_NOT_UNIQUE:'评论原生编号组件不唯一，已停止当前作品读取',
  COMMENT_TEXT_UNVERIFIED:'评论正文尚未完整核验，已保留待核对；完成核验前不会调用模型或发送',
  COMMENT_PARENT_UNVERIFIED:'评论所属层级尚未完整核验，消息已保留；后台完成核验前不会自动回复',
  COMMENT_ROOT_CONTEXT_REQUIRED:'一级根评论尚未完整收取，后台补齐后再生成回复',
  COMMENT_THREAD_CONTEXT_UNVERIFIED:'评论对话中的上下文尚未完整核验，后台正在补齐',
  DM_CONTENT_UNVERIFIED:'内容仅供人工查看，AI不会自动处理',
  HUMAN_MEDIA_TEXT_REQUIRED:'请直接输入人工回复，此消息不能使用已有的非人工草稿',
  HUMAN_MEDIA_APPROVAL_REQUIRED:'本次人工回复的后台核验已失效，草稿已保留',
  TARGET_NEEDS_REVIEW:'消息的准确目标或原生身份仍待核验，暂不能发送',
  OBSERVATION_DM_CONTENT_DOM_NOT_READY:'私信正文正在加载，后台已保留收取进度',
  DM_ADVANCE_READ_FAILED:'私信列表翻页未完成，已保留已收取记录和会话进度',
  OBSERVATION_EXISTING_HUMAN_INPUT:'网页保留了未发送输入，后台已保留草稿并停止本次切换',
  DPAPI_RESTORE_FAILED:'当前 Windows 用户无法解密已保存的 Key，请重新配置',
  INBOX_SYNC_IN_PROGRESS: "收件箱正在同步，请等待当前读取完成。",
  OBSERVATION_DOM_NOT_READY: "页面尚未就绪，请稍后再次同步。",
  OBSERVATION_PAGE_BLOCKED: "请在专属浏览器检查登录或验证提示。",
  OBSERVATION_ACCOUNT_CHANGED: "浏览器账号与绑定账号不一致，已停止同步。",
  PLATFORM_STOP: "平台要求停止，已结束本次同步。",
  CHALLENGE_REQUIRED: "请在专属浏览器完成平台验证后再同步。",
  LOGIN_REQUIRED: "请先在专属浏览器登录。",
  ACCOUNT_NOT_VERIFIED: "当前账号身份未通过核验，已停止同步。",
  ACCOUNT_CHANGED: "当前账号与收件箱绑定账号不一致，已停止同步。",
  BROWSER_CLOSED: "专属浏览器已关闭，本次同步已停止。",
  RUNTIME_NOT_FOUND: "没有找到现有运行资料，请核对目录路径；首次使用请明确初始化新目录。",
  CAPABILITY_UNVERIFIED: "请先打开专属浏览器并同步此通道",
  CAPABILITY_EXPIRED_OR_CHANGED: "通道证据已过期或环境已变化",
  CAPABILITY_READ_ONLY: "读取已核验，发送尚未核验",
  CAPABILITY_SEND_UNVERIFIED: "尚无已确认发送证据；受控测试资格按准确任务单独生效",
  CAPABILITY_BLOCKED: "最近一次同步或核验未通过，请查看操作审计并重新同步",
  CHANNEL_NOT_SENDABLE: "此通道当前禁止发送",
  MODE_DRAFT_ONLY: "当前模式仅允许保存草稿",
  ACCOUNT_PAUSED: "账号已暂停",
  TARGET_PAUSED: "此目标已暂停",
  TARGET_FROZEN: "此前回复尚未确认送达；可以编辑草稿，发送暂不可用",
  LEASE_EXPIRED_OR_CHANGED: "接管已过期或代际已变化，请重新接管",
  DRAFT_VERSION_CONFLICT: "草稿版本已变化，请重新读取并核对",
  CONTEXT_VERSION_CONFLICT: "上下文已变化，请重新核对",
  TARGET_SELECTION_CHANGED: "所选目标已变化，原确认失效",
  OPERATOR_PERMISSION_DENIED: "当前操作员没有此权限",
  OPERATOR_EXPIRED: "操作员会话已过期，请重新连接",
  REAL_MODEL_AUTHORIZATION_REQUIRED: "请先配置 Key 并明确授权模型调用",
  MODEL_KEY_REQUIRED: "请先输入本次 Key",
  SENSITIVE_MANUAL_HANDLING: "检测到敏感内容，保留人工处理",
  MODEL_FAILED_NO_RETRY: "模型请求失败，未自动重试，可继续人工编辑",
  OWNER_LOCKED_OR_PORT_UNAVAILABLE:
    "运行目录正被其他内核占用，或本机锁端口不可用",
  DATABASE_MISSING_USE_INIT:
    "目录中没有数据库，请选择已有目录或明确初始化新目录",
  CONFIRMATION_EXPIRED: "确认已超过 60 秒，请重新检查目标和全文",
  COMMENT_REPLY_REFRESH_NOT_READY: "原评论刷新后尚未就绪，草稿已保留",
  COMMENT_REPLY_LIST_NOT_UNIQUE: "出现多个可见评论列表，无法确定回复位置，未继续发送",
  COMMENT_REPLY_ROOT_NOT_FOUND: "本轮未找到这条评论，回复已保存，尚未发送",
  COMMENT_REPLY_ROOT_NOT_UNIQUE: "无法唯一定位原评论，回复已保存，尚未发送",
  COMMENT_REPLY_LOCATE_TIMEOUT: "本轮定位评论耗时较长，回复已保存，尚未发送",
  COMMENT_REPLY_CANCELLED: "发送准备已停止，已有回复保留",
  OBSERVATION_COMMENT_RESTORE_LIMIT: "本轮较后面的评论尚未收完，后台已保留进度",
  OBSERVATION_COMMENT_RENDER_NOT_READY: "网页评论尚未完成显示，后台已保留收取进度",
};
export function explain(error: unknown): string {
  const text = typeof error === "string" ? error : String(error);
  return reasons[text] ?? text;
}
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
