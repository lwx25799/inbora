import type { AccountId } from '../../contracts/account.js';
import type { Channel, InboundEvent, StoredEvent } from '../../core/contracts.js';
import type { ReplyKnowledgeContext } from '../../knowledge/contracts.js';
import type { Grant, ReplyPolicy } from '../automation-contracts.js';
import type { EventStore } from '../../storage/store.js';
import type { AutomationStore } from '../../storage/automation-store.js';
import type { WorkbenchAuthority } from '../authority.js';

export const PIPELINE_STAGE_ORDER = [
  'eligibility_check',
  'scope_and_blacklist_check',
  'ownership_handoff_check',
  'rhythm_rate_limit_check',
  'content_safety_check',
  'debounce_preprocess',
  'handoff_rules_and_knowledge',
  'outbound_safety_and_loop_check',
] as const;

export type PipelineStageName = (typeof PIPELINE_STAGE_ORDER)[number];

export type StageDecision = 'continue' | 'handoff_human' | 'defer' | 'skip';

export interface StageOutcome {
  stage: PipelineStageName;
  decision: StageDecision;
  reasonCode: string;
  detail?: Record<string, unknown>;
}

export interface SensitiveGuardConfig {
  /** 第一层：商家自定义敏感词表 */
  customWords: string[];
  /** 第二层：是否启用内置平台导流与合规红线词/正则 */
  enablePlatformRedline: boolean;
  /** 是否启用入站提示注入检测，默认 true */
  enablePromptInjectionGuard?: boolean;
}

export type RhythmProfile = 'off' | 'calm' | 'natural' | 'active';

export interface RhythmPreset {
  minIntervalMs: number;
  maxIntervalMs: number;
  burstWindowMs: number;
  burstMaxActions: number;
  cooloffMs: number;
}

export interface RhythmConfig {
  profile: RhythmProfile;
  overrides?: Partial<RhythmPreset>;
  /** 节流计数作用域，默认 'ALL'（账号级统一写动作节流） */
  scope?: 'ALL' | Channel;
}

export interface DebounceConfig {
  /** 是否启用私信碎片消息 2-5 秒静默聚合 */
  enabled: boolean;
  /** 静默聚合等待窗口（毫秒，规范区间 2000-5000ms） */
  windowMs: number;
  /** 最多合并的连续未读短句数量，默认 6 */
  maxMessages?: number;
  /** 合并后最大字符长度，默认 1500 */
  maxMergedChars?: number;
}

export interface LoopBreakerConfig {
  /** 是否启用同句死循环保护 */
  enabled: boolean;
  /** 冷却时间窗（毫秒），默认 10 分钟 */
  cooldownMs: number;
  /** 高度雷同判定阈值（0-1），默认 0.9 */
  similarityThreshold: number;
  /** 检查同一目标最近 N 条发出记录，默认 10 */
  windowSize: number;
  /** 是否仅限自动回复记录参与比较，默认 false（同时防范复读近期已确认外发） */
  autoPolicyOnly?: boolean;
}

export interface ScopeFilterConfig {
  /** 黑名单客户 actorId */
  blacklistActors?: string[];
  /** 若非空，仅允许白名单内 actorId */
  whitelistActors?: string[];
  /** 黑名单会话 conversationId */
  blacklistConversations?: string[];
  /** 是否过滤群聊消息 */
  excludeGroupChats?: boolean;
}

export interface HandoffRulesConfig {
  /** 含图/视频/音频等媒体消息转人工（当视觉能力未开启时） */
  mediaMessageHandoff: boolean;
  /** 是否开启多模态看图能力，默认 false */
  allowVisionModel?: boolean;
  /** 售后/退款/投诉关键词转人工 */
  afterSalesHandoff: boolean;
  /** 议价/砍价关键词转人工 */
  bargainHandoff: boolean;
  /** 商家自定义转人工触发词 */
  customTriggers: string[];
  /** 知识库未命中转人工 */
  knowledgeMissHandoff: boolean;
  /** 知识库冲突转人工 */
  knowledgeConflictHandoff: boolean;
  /** 高置信 FAQ 精确命中直出判断开关 */
  exactFaqDirectReply: boolean;
}

export interface ReplyPipelineConfig {
  scope?: ScopeFilterConfig;
  rhythm?: RhythmConfig;
  sensitive?: Partial<SensitiveGuardConfig>;
  debounce?: Partial<DebounceConfig>;
  handoff?: Partial<HandoffRulesConfig>;
  loopBreaker?: Partial<LoopBreakerConfig>;
  /** 在线模式下是否将转人工归因落库，默认 true；dryRun 始终不写库 */
  recordAttribution?: boolean;
}

export interface ResolvedReplyPipelineConfig {
  scope: Required<ScopeFilterConfig>;
  rhythm: RhythmConfig;
  sensitive: Required<SensitiveGuardConfig>;
  debounce: Required<DebounceConfig>;
  handoff: Required<HandoffRulesConfig>;
  loopBreaker: Required<LoopBreakerConfig>;
  recordAttribution: boolean;
}

export interface ExactFaqCandidate {
  id: string;
  title: string;
  text: string;
  topic?: string;
  version?: number;
  score?: number;
}

/** 兼容现有 ReplyKnowledgeContext 及后续知识检索升级扩展字段 */
export type PipelineKnowledgeContext = ReplyKnowledgeContext & {
  exactFaqMatch?: ExactFaqCandidate | null;
  exactFaqHit?: ExactFaqCandidate | null;
};

export interface DirectFaqReply {
  entryId: string;
  title: string;
  text: string;
  source: 'exact_faq_hit' | 'unique_title_match';
}

export interface RecentSentReply {
  text: string;
  sentAt: string;
  origin?: string;
}

export interface PipelineEvaluationInput {
  store: EventStore;
  authority: WorkbenchAuthority;
  automation: AutomationStore;
  grant: Grant<ReplyPolicy>;
  event: StoredEvent;
  config?: ReplyPipelineConfig;
  /** 若调用方已提前查好知识上下文，直接复用，否则按需通过 resolveKnowledge 获取 */
  knowledge?: PipelineKnowledgeContext | null;
  resolveKnowledge?: (event: InboundEvent, mergedText: string) => PipelineKnowledgeContext | null;
  /** 可选标记：是否群聊消息（供未来多平台/企微群聊接入使用） */
  isGroupChat?: boolean;
  /** 只读干跑模式（场景训练台）：绝不写库、不修改节流状态、不记录归因 */
  dryRun?: boolean;
  /** 干跑模式下可选传入的模拟候选回复文本，用于完整走完阶段 8 */
  candidateReplyText?: string;
  /** 干跑模式下可选注入近期发出历史，用于模拟死循环检查 */
  recentReplies?: RecentSentReply[];
  /** 可选时钟与确定性随机数注入（便于单测） */
  now?: () => number;
  rng?: () => number;
}

export interface PipelinePreGenerationResult {
  eventId: string;
  anchorEvent: StoredEvent;
  accountId: AccountId;
  channel: Channel;
  targetKey: string;
  dryRun: boolean;
  decision: StageDecision;
  stoppedAt: PipelineStageName | null;
  reasonCode: string;
  stages: StageOutcome[];
  contextVersion: string | null;
  ownershipGeneration: number | null;
  mergedText: string;
  /** 全部碎片的完整未截断拼接文本（用于风控安检与关键词检查） */
  fullConcatText: string;
  mergedEventIds: string[];
  /** 批次中每条碎片事件在预检时的 binding 快照（用于模型前与落草稿时防并发冲突漂移） */
  fragmentBindings: Record<string, string>;
  knowledge: PipelineKnowledgeContext | null;
  directFaqReply: DirectFaqReply | null;
  deferUntilMs?: number;
}

export interface PipelineTrace {
  eventId: string;
  anchorEventId: string;
  accountId: AccountId;
  channel: Channel;
  targetKey: string;
  dryRun: boolean;
  finalDecision: StageDecision;
  stoppedAt: PipelineStageName | null;
  reasonCode: string;
  stages: StageOutcome[];
  contextVersion: string | null;
  ownershipGeneration: number | null;
  mergedText: string;
  mergedEventIds: string[];
  directFaqReply: DirectFaqReply | null;
  deferUntilMs?: number;
  attributionRecorded: boolean;
}

/** 面向既有测试与零侵入兼容的默认配置（节流默认 off、碎片聚合默认关闭、售后/议价额外拦截默认关闭） */
export const DEFAULT_COMPATIBLE_PIPELINE_CONFIG: ResolvedReplyPipelineConfig = {
  scope: {
    blacklistActors: [],
    whitelistActors: [],
    blacklistConversations: [],
    excludeGroupChats: true,
  },
  rhythm: {
    profile: 'off',
    scope: 'ALL',
  },
  sensitive: {
    customWords: [],
    enablePlatformRedline: true,
    enablePromptInjectionGuard: true,
  },
  debounce: {
    enabled: false,
    windowMs: 3000,
    maxMessages: 6,
    maxMergedChars: 1500,
  },
  handoff: {
    mediaMessageHandoff: true,
    allowVisionModel: false,
    afterSalesHandoff: false,
    bargainHandoff: false,
    customTriggers: [],
    knowledgeMissHandoff: false,
    knowledgeConflictHandoff: true,
    exactFaqDirectReply: false,
  },
  loopBreaker: {
    enabled: true,
    cooldownMs: 10 * 60_000,
    similarityThreshold: 0.9,
    windowSize: 10,
    autoPolicyOnly: false,
  },
  recordAttribution: true,
};

/** 生产环境推荐配置（开启 natural 自然节流、3 秒碎片聚合、售后与议价独立转人工开关） */
export const PRODUCTION_PIPELINE_CONFIG: ResolvedReplyPipelineConfig = {
  ...DEFAULT_COMPATIBLE_PIPELINE_CONFIG,
  rhythm: {
    profile: 'natural',
    scope: 'ALL',
  },
  debounce: {
    enabled: true,
    windowMs: 3000,
    maxMessages: 6,
    maxMergedChars: 1500,
  },
  handoff: {
    ...DEFAULT_COMPATIBLE_PIPELINE_CONFIG.handoff,
    afterSalesHandoff: true,
    bargainHandoff: true,
  },
};

export function resolvePipelineConfig(input?: ReplyPipelineConfig): ResolvedReplyPipelineConfig {
  const base = DEFAULT_COMPATIBLE_PIPELINE_CONFIG;
  return {
    scope: {
      blacklistActors: [...(input?.scope?.blacklistActors ?? base.scope.blacklistActors)],
      whitelistActors: [...(input?.scope?.whitelistActors ?? base.scope.whitelistActors)],
      blacklistConversations: [...(input?.scope?.blacklistConversations ?? base.scope.blacklistConversations)],
      excludeGroupChats: input?.scope?.excludeGroupChats ?? base.scope.excludeGroupChats,
    },
    rhythm: {
      profile: input?.rhythm?.profile ?? base.rhythm.profile,
      scope: input?.rhythm?.scope ?? base.rhythm.scope ?? 'ALL',
      ...(input?.rhythm?.overrides ? { overrides: { ...input.rhythm.overrides } } : {}),
    },
    sensitive: {
      customWords: [...(input?.sensitive?.customWords ?? base.sensitive.customWords)],
      enablePlatformRedline: input?.sensitive?.enablePlatformRedline ?? base.sensitive.enablePlatformRedline,
      enablePromptInjectionGuard: input?.sensitive?.enablePromptInjectionGuard ?? base.sensitive.enablePromptInjectionGuard,
    },
    debounce: {
      enabled: input?.debounce?.enabled ?? base.debounce.enabled,
      windowMs: input?.debounce?.windowMs ?? base.debounce.windowMs,
      maxMessages: input?.debounce?.maxMessages ?? base.debounce.maxMessages,
      maxMergedChars: input?.debounce?.maxMergedChars ?? base.debounce.maxMergedChars,
    },
    handoff: {
      mediaMessageHandoff: input?.handoff?.mediaMessageHandoff ?? base.handoff.mediaMessageHandoff,
      allowVisionModel: input?.handoff?.allowVisionModel ?? base.handoff.allowVisionModel,
      afterSalesHandoff: input?.handoff?.afterSalesHandoff ?? base.handoff.afterSalesHandoff,
      bargainHandoff: input?.handoff?.bargainHandoff ?? base.handoff.bargainHandoff,
      customTriggers: [...(input?.handoff?.customTriggers ?? base.handoff.customTriggers)],
      knowledgeMissHandoff: input?.handoff?.knowledgeMissHandoff ?? base.handoff.knowledgeMissHandoff,
      knowledgeConflictHandoff: input?.handoff?.knowledgeConflictHandoff ?? base.handoff.knowledgeConflictHandoff,
      exactFaqDirectReply: input?.handoff?.exactFaqDirectReply ?? base.handoff.exactFaqDirectReply,
    },
    loopBreaker: {
      enabled: input?.loopBreaker?.enabled ?? base.loopBreaker.enabled,
      cooldownMs: input?.loopBreaker?.cooldownMs ?? base.loopBreaker.cooldownMs,
      similarityThreshold: input?.loopBreaker?.similarityThreshold ?? base.loopBreaker.similarityThreshold,
      windowSize: input?.loopBreaker?.windowSize ?? base.loopBreaker.windowSize,
      autoPolicyOnly: input?.loopBreaker?.autoPolicyOnly ?? base.loopBreaker.autoPolicyOnly,
    },
    recordAttribution: input?.recordAttribution ?? base.recordAttribution,
  };
}
