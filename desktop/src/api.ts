import { invoke } from "@tauri-apps/api/core";
import type {
  ClientCommand,
  SendParams,
  AiSettings,
} from "../../src/app/contracts.js";
import type {
  Draft,
  StoredEvent,
  InboundEvent,
} from "../../src/core/contracts.js";

export type { SendParams, AiSettings };
export interface Status {
  runtime: string;
  account: { id: string; identity: string } | null;
  operator: { id: string; permissions: string[]; expiresAt: number };
  mode: "OBSERVE" | "DRAFT_ONLY" | "MANUAL" | "AI_ASSISTED";
  configuredMode: Status["mode"];
  paused: boolean;
  browser: {
    state: string;
    mode: "headed" | "headless";
    version: string | null;
  };
  lastSync: { channel: string; at: string }[];
  capabilities: {
    channel: string;
    state: string;
    reason: string;
    evidence: string | null;
  }[];
  budgets: { kind: string; used: number; maximum: number }[];
  usage: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    unresolved: number;
  };
  settings: AiSettings;
  keyPresent: boolean;
  modelAuthorized: boolean;
  modelBusy: boolean;
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
    channel: string;
    author: string | null;
    preview: string;
    time: string | null;
    source: string;
  }[];
}
export interface Thread {
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
export function desktopInfo(): Promise<{ runtime: string; version: string }> {
  return invoke("desktop_info");
}
export function closeDesktop(): Promise<void> {
  return invoke("desktop_exit");
}
export const reasons: Record<string, string> = {
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
  TARGET_FROZEN: "目标存在待核实发送，已冻结",
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
};
export function explain(error: unknown): string {
  const text = typeof error === "string" ? error : String(error);
  return reasons[text] ?? text;
}
export const statusNames: Record<string, string> = {
  AWAITING_DRAFT: "待处理",
  AWAITING_APPROVAL: "待确认",
  APPROVED: "已批准",
  MANUAL_REVIEW: "目标需核对",
  INTENT_RECORDED: "发送中",
  CONFIRMED: "已确认",
  UNCERTAIN: "结果待核实",
  REJECTED: "已拒绝",
  BASELINE: "历史基线",
  QUEUED: "排队中",
  PREFLIGHT: "发送前核验",
  SENDING: "发送中",
  FAILED_BEFORE_CLICK: "发送前失败",
  PREVIEW: "待确认",
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
