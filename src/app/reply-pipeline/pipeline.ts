import {
  isManualMediaCandidate,
  isStrong,
  targetKey,
  validText,
  type InboundEvent,
  type StoredEvent,
} from '../../core/contracts.js';
import { readSecurityHold } from '../../storage/security-holds.js';
import type { EventStore } from '../../storage/store.js';
import { checkInboundSafety, checkOutboundSafety } from './sensitive-guard.js';
import { evaluateDebounce } from './debounce-aggregator.js';
import { checkReplyLoop } from './loop-breaker.js';
import { PersistentRhythmGate } from './rhythm-gate.js';
import {
  evaluateHandoffRulesAndKnowledge,
  HandoffAttributionStore,
  isMediaPayload,
} from './handoff-attribution.js';
import {
  resolvePipelineConfig,
  type DirectFaqReply,
  type PipelineEvaluationInput,
  type PipelineKnowledgeContext,
  type PipelinePreGenerationResult,
  type PipelineStageName,
  type PipelineTrace,
  type RecentSentReply,
  type ResolvedReplyPipelineConfig,
  type StageDecision,
  type StageOutcome,
} from './types.js';

const GROUP_CHAT_ID_PATTERN = /^(?:group:|chatroom:|room:|grp_)/iu;

function shanghaiHour(nowMs: number): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(nowMs),
  );
}

/**
 * 检测同一会话中是否存在发生时间晚于当前入站消息的外部人工新回复（原生端/手机端同步或人工追发）。
 */
function hasExternalHumanReplyAfter(
  store: EventStore,
  event: StoredEvent,
  ownId: string,
): { detected: boolean; source?: 'chat_messages' | 'human_reply_turns' } {
  const eventAtMs = event.payload.occurredAt ? Date.parse(event.payload.occurredAt) : NaN;
  if (!Number.isFinite(eventAtMs)) return { detected: false };

  if (
    event.payload.channel === 'DIRECT_MESSAGE' &&
    event.payload.conversationId &&
    store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_messages'").get()
  ) {
    const rows = store.db
      .prepare(
        `SELECT payload FROM chat_messages
         WHERE account_id=? AND own_id=? AND conversation_id=? AND conflicted=0
         ORDER BY observed_at DESC LIMIT 20`,
      )
      .all(event.payload.accountId, ownId, event.payload.conversationId) as { payload: string }[];
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload) as InboundEvent;
        if (payload.direction !== 'OUTGOING' || payload.actorId !== ownId) continue;
        const sentMs = payload.occurredAt ? Date.parse(payload.occurredAt) : NaN;
        if (Number.isFinite(sentMs) && sentMs > eventAtMs) {
          return { detected: true, source: 'chat_messages' };
        }
      } catch {
        continue;
      }
    }
  }

  if (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='human_reply_turns'").get()) {
    const turns = store.db
      .prepare(
        `SELECT COALESCE(verified_at, attempt_started_at) AS sent_at FROM human_reply_turns t
         JOIN inbound_events e ON e.id=t.event_id
         WHERE e.account_id=? AND t.target_key=? AND t.status IN ('INTENT_RECORDED', 'CONFIRMED')
         ORDER BY t.rowid DESC LIMIT 10`,
      )
      .all(event.payload.accountId, targetKey(event.payload)) as { sent_at: string | null }[];
    for (const turn of turns) {
      const sentMs = turn.sent_at ? Date.parse(turn.sent_at) : NaN;
      if (Number.isFinite(sentMs) && sentMs > eventAtMs) {
        return { detected: true, source: 'human_reply_turns' };
      }
    }
  }

  return { detected: false };
}

/** 阶段 1：账号/事件强绑定与状态校验 */
function runStage1Eligibility(input: PipelineEvaluationInput, config: ResolvedReplyPipelineConfig): StageOutcome {
  const { store, automation, grant, event, dryRun } = input;
  const stage: PipelineStageName = 'eligibility_check';

  if (event.payload.accountId !== store.accountId) {
    return { stage, decision: 'skip', reasonCode: 'ACCOUNT_MISMATCH' };
  }
  if (readSecurityHold(store, event.payload.channel)) {
    return { stage, decision: 'skip', reasonCode: 'SECURITY_CHANNEL_HELD' };
  }
  const active = automation.active('AUTO_REPLY');
  if (!active || active.version !== grant.version) {
    return { stage, decision: 'skip', reasonCode: 'GRANT_NOT_ACTIVE' };
  }
  if (automation.state().emergencyStopped) {
    return { stage, decision: 'skip', reasonCode: 'EMERGENCY_STOPPED' };
  }
  const boundOwnId = store.accountOwnId(store.accountId);
  if (!boundOwnId || boundOwnId !== grant.scope.ownId) {
    return { stage, decision: 'skip', reasonCode: 'ACCOUNT_NOT_VERIFIED' };
  }
  if (event.payload.direction !== 'INCOMING' || event.payload.actorId === grant.scope.ownId) {
    return { stage, decision: 'skip', reasonCode: 'NOT_INCOMING_CUSTOMER_EVENT' };
  }
  if (!dryRun && event.status !== 'AWAITING_DRAFT') {
    return { stage, decision: 'skip', reasonCode: 'EVENT_STATUS_NOT_ELIGIBLE', detail: { status: event.status } };
  }
  const mediaCandidate = isManualMediaCandidate(event.payload) || isMediaPayload(event.payload);
  if (!isStrong(event.payload)) {
    // 合法媒体消息放行至阶段 7，由精细转人工规则统一输出 MEDIA_MESSAGE_HANDOFF 与归因
    if (mediaCandidate && config.handoff.mediaMessageHandoff) {
      return {
        stage,
        decision: 'continue',
        reasonCode: 'ELIGIBILITY_PASSED_MEDIA_FOR_HANDOFF',
        detail: { contentType: event.payload.contentType ?? 'UNKNOWN' },
      };
    }
    return { stage, decision: 'handoff_human', reasonCode: 'EVENT_NOT_STRONG_BOUND' };
  }
  if (!dryRun) {
    const existingIntent = store.db.prepare('SELECT id FROM send_intents WHERE event_id=?').get(event.id);
    if (existingIntent || store.sendFrozen(event.id)) {
      return { stage, decision: 'skip', reasonCode: 'TARGET_FROZEN_OR_INTENT_EXISTS' };
    }
  }
  return { stage, decision: 'continue', reasonCode: 'ELIGIBILITY_PASSED' };
}

/** 阶段 2：通道、黑白名单、群聊/嵌套评论范围过滤 */
function runStage2Scope(input: PipelineEvaluationInput, config: ResolvedReplyPipelineConfig, now: number): StageOutcome {
  const { store, grant, event, isGroupChat } = input;
  const stage: PipelineStageName = 'scope_and_blacklist_check';
  const policy = grant.scope;
  const payload = event.payload;

  if (!policy.channels.includes(payload.channel)) {
    return { stage, decision: 'skip', reasonCode: 'CHANNEL_NOT_ALLOWED', detail: { channel: payload.channel } };
  }
  if (payload.channel === 'COMMENT_NOTIFICATION' && payload.kind === 'REPLY' && policy.replyToNestedComments === false) {
    return { stage, decision: 'skip', reasonCode: 'NESTED_COMMENT_DISABLED' };
  }
  const detectedGroupChat =
    isGroupChat === true || Boolean(payload.conversationId && GROUP_CHAT_ID_PATTERN.test(payload.conversationId));
  if (config.scope.excludeGroupChats && detectedGroupChat) {
    return { stage, decision: 'skip', reasonCode: 'GROUP_CHAT_FILTERED' };
  }
  if (payload.actorId && config.scope.blacklistActors.includes(payload.actorId)) {
    return { stage, decision: 'skip', reasonCode: 'BLACKLISTED_ACTOR' };
  }
  if (payload.conversationId && config.scope.blacklistConversations.includes(payload.conversationId)) {
    return { stage, decision: 'skip', reasonCode: 'BLACKLISTED_CONVERSATION' };
  }
  if (
    config.scope.whitelistActors.length > 0 &&
    (!payload.actorId || !config.scope.whitelistActors.includes(payload.actorId))
  ) {
    return { stage, decision: 'skip', reasonCode: 'NOT_IN_WHITELIST' };
  }

  const hour = shanghaiHour(now);
  if (hour < policy.startHour || hour >= policy.endHour) {
    return {
      stage,
      decision: 'defer',
      reasonCode: 'OUTSIDE_SERVICE_HOURS',
      detail: { hour, startHour: policy.startHour, endHour: policy.endHour },
    };
  }

  const lowerText = payload.text.toLocaleLowerCase();
  if (policy.excludesAny.some((word) => lowerText.includes(word.toLocaleLowerCase()))) {
    return { stage, decision: 'skip', reasonCode: 'POLICY_EXCLUDED_KEYWORD' };
  }
  if (policy.containsAny.length > 0 && !policy.containsAny.some((word) => lowerText.includes(word.toLocaleLowerCase()))) {
    return { stage, decision: 'skip', reasonCode: 'POLICY_REQUIRED_KEYWORD_MISSING' };
  }

  if (payload.channel === 'DIRECT_MESSAGE') {
    const allowed = policy.entireInbox || Boolean(payload.conversationId && policy.conversationIds.includes(payload.conversationId));
    if (!allowed) return { stage, decision: 'skip', reasonCode: 'CONVERSATION_OUT_OF_SCOPE' };
  } else {
    let allowed = Boolean(payload.videoId && policy.workIds.includes(payload.videoId));
    if (!allowed && policy.futureOwnWorks && payload.videoId) {
      const work = store.db
        .prepare('SELECT own_id, state FROM discovered_works WHERE id=?')
        .get(payload.videoId) as { own_id: string; state: string } | undefined;
      allowed = Boolean(work && work.own_id === policy.ownId && work.state === 'INCLUDED');
    }
    if (!allowed) return { stage, decision: 'skip', reasonCode: 'WORK_OUT_OF_SCOPE' };
  }

  return { stage, decision: 'continue', reasonCode: 'SCOPE_PASSED' };
}

/** 阶段 3：人工接管代际、暂停态与外部人工新回复检测 */
function runStage3Ownership(
  input: PipelineEvaluationInput,
  now: number,
): { outcome: StageOutcome; generation: number; contextVersion: string } {
  const { store, authority, grant, event, dryRun } = input;
  const stage: PipelineStageName = 'ownership_handoff_check';
  const owner = authority.ownership(event);
  const contextVersion = authority.contextVersion(event);

  const client = store.clientState();
  if (!dryRun && (client.paused || client.mode !== 'LIMITED_AUTO')) {
    return {
      outcome: { stage, decision: 'skip', reasonCode: 'AUTO_MODE_INACTIVE', detail: { mode: client.mode, paused: Boolean(client.paused) } },
      generation: owner.generation,
      contextVersion,
    };
  }
  if (store.targetPaused(targetKey(event.payload))) {
    return {
      outcome: { stage, decision: 'handoff_human', reasonCode: 'TARGET_PAUSED', detail: { generation: owner.generation } },
      generation: owner.generation,
      contextVersion,
    };
  }
  if (owner.operator_id && owner.lease_expires_at > now) {
    return {
      outcome: {
        stage,
        decision: 'handoff_human',
        reasonCode: 'HUMAN_ACTIVE_OWNERSHIP',
        detail: { generation: owner.generation },
      },
      generation: owner.generation,
      contextVersion,
    };
  }
  const existingDraft = authority.draftFor(event.id);
  if (existingDraft && existingDraft.origin === 'HUMAN_TYPED') {
    return {
      outcome: {
        stage,
        decision: 'handoff_human',
        reasonCode: 'HUMAN_ACTIVE_OWNERSHIP',
        detail: { generation: owner.generation, draftVersion: existingDraft.version },
      },
      generation: owner.generation,
      contextVersion,
    };
  }
  const externalReply = hasExternalHumanReplyAfter(store, event, grant.scope.ownId);
  if (externalReply.detected) {
    return {
      outcome: {
        stage,
        decision: 'handoff_human',
        reasonCode: 'EXTERNAL_HUMAN_REPLIED',
        detail: { generation: owner.generation, source: externalReply.source },
      },
      generation: owner.generation,
      contextVersion,
    };
  }

  return {
    outcome: { stage, decision: 'continue', reasonCode: 'OWNERSHIP_CLEAR', detail: { generation: owner.generation } },
    generation: owner.generation,
    contextVersion,
  };
}

/** 阶段 4：SQLite 持久化三档写动作节流阀检查 */
function runStage4Rhythm(
  input: PipelineEvaluationInput,
  config: ResolvedReplyPipelineConfig,
  gate: PersistentRhythmGate,
): { outcome: StageOutcome; deferUntilMs?: number } {
  const stage: PipelineStageName = 'rhythm_rate_limit_check';
  const decision = input.dryRun
    ? gate.check(input.store.accountId, config.rhythm)
    : gate.evaluateOrTriggerCooloff(input.store.accountId, config.rhythm);

  if (!decision.allowed) {
    return {
      outcome: {
        stage,
        decision: 'defer',
        reasonCode: decision.reasonCode,
        detail: {
          profile: decision.profile,
          retryAfterMs: decision.retryAfterMs,
          nextAllowedAt: decision.nextAllowedAt,
          windowCount: decision.windowCount,
          burstMaxActions: decision.burstMaxActions,
          cooloffTriggered: decision.cooloffTriggered,
        },
      },
      deferUntilMs: decision.nextAllowedAt,
    };
  }
  return {
    outcome: {
      stage,
      decision: 'continue',
      reasonCode: decision.reasonCode,
      detail: { profile: decision.profile, windowCount: decision.windowCount },
    },
  };
}

/** 阶段 5：入站双层敏感词 + 提示注入拦截（前置零模型额度消耗） */
function runStage5ContentSafety(text: string, config: ResolvedReplyPipelineConfig): StageOutcome {
  const stage: PipelineStageName = 'content_safety_check';
  const check = checkInboundSafety(text, config.sensitive);
  if (check.blocked) {
    return {
      stage,
      decision: 'handoff_human',
      reasonCode: check.reasonCode,
      detail: {
        layer: check.layer,
        ...(check.category ? { category: check.category } : {}),
        ...(check.ruleId ? { ruleId: check.ruleId } : {}),
        ...(check.ruleDigest ? { ruleDigest: check.ruleDigest } : {}),
      },
    };
  }
  return { stage, decision: 'continue', reasonCode: 'INBOUND_SAFETY_PASSED' };
}

/** 阶段 8：出站双层敏感词终审 + 同句死循环保护 */
export function evaluateOutboundStage(params: {
  store: EventStore;
  event: StoredEvent;
  replyText: string;
  config: ResolvedReplyPipelineConfig;
  now?: () => number;
  recentReplies?: RecentSentReply[];
}): StageOutcome {
  const stage: PipelineStageName = 'outbound_safety_and_loop_check';
  const now = (params.now ?? Date.now)();

  let canonicalText: string;
  try {
    canonicalText = validText(params.replyText);
  } catch {
    return { stage, decision: 'handoff_human', reasonCode: 'OUTBOUND_INVALID_TEXT' };
  }

  const outboundSafety = checkOutboundSafety(canonicalText, params.config.sensitive);
  if (outboundSafety.blocked) {
    return {
      stage,
      decision: 'handoff_human',
      reasonCode: outboundSafety.reasonCode,
      detail: {
        direction: 'OUTBOUND',
        layer: outboundSafety.layer,
        ...(outboundSafety.category ? { category: outboundSafety.category } : {}),
        ...(outboundSafety.ruleId ? { ruleId: outboundSafety.ruleId } : {}),
      },
    };
  }

  const loopResult = checkReplyLoop({
    store: params.store,
    accountId: params.event.payload.accountId,
    targetKey: targetKey(params.event.payload),
    candidateText: canonicalText,
    config: params.config.loopBreaker,
    now,
    ...(params.recentReplies ? { extraRecentReplies: params.recentReplies } : {}),
  });

  if (loopResult.blocked) {
    return {
      stage,
      decision: 'handoff_human',
      reasonCode: 'LOOP_BREAKER_HANDOFF',
      detail: {
        similarity: loopResult.similarity,
        candidateDigest: loopResult.candidateDigest,
        ...(loopResult.matchedDigest ? { matchedDigest: loopResult.matchedDigest } : {}),
        cooldownMs: params.config.loopBreaker.cooldownMs,
      },
    };
  }

  return {
    stage,
    decision: 'continue',
    reasonCode: 'OUTBOUND_SAFETY_PASSED',
    detail: { similarity: loopResult.similarity, recentChecked: loopResult.recentChecked },
  };
}

/**
 * 执行 8 阶段流水线的前 7 阶段（资格 -> 范围 -> 接管 -> 节流 -> 入站敏感词 -> 碎片聚合 -> 精细转人工与知识判定）。
 * 所有高成本/不可逆动作（调模型、建草稿、SendCoordinator 提交）均位于本函数返回 continue 之后。
 */
export function runReplyPipelinePreGeneration(
  input: PipelineEvaluationInput,
  rhythmGate?: PersistentRhythmGate,
): PipelinePreGenerationResult {
  const config = resolvePipelineConfig(input.config);
  const nowFn = input.now ?? input.authority.now;
  const now = nowFn();
  const dryRun = Boolean(input.dryRun);
  const gate =
    rhythmGate ??
    new PersistentRhythmGate(input.store.db, {
      now: nowFn,
      ...(input.rng ? { rng: input.rng } : {}),
    });

  const stages: StageOutcome[] = [];
  let anchorEvent = input.event;
  let mergedText = input.event.payload.text;
  let mergedEventIds = [input.event.id];
  let contextVersion: string | null = null;
  let ownershipGeneration: number | null = null;
  let knowledge: PipelineKnowledgeContext | null = input.knowledge ?? null;
  let directFaqReply: DirectFaqReply | null = null;
  let deferUntilMs: number | undefined;

  const stopWith = (outcome: StageOutcome): PipelinePreGenerationResult => ({
    eventId: input.event.id,
    anchorEvent,
    accountId: anchorEvent.payload.accountId,
    channel: anchorEvent.payload.channel,
    targetKey: targetKey(anchorEvent.payload),
    dryRun,
    decision: outcome.decision,
    stoppedAt: outcome.stage,
    reasonCode: outcome.reasonCode,
    stages,
    contextVersion,
    ownershipGeneration,
    mergedText,
    mergedEventIds,
    knowledge,
    directFaqReply,
    ...(deferUntilMs !== undefined ? { deferUntilMs } : {}),
  });

  // 阶段 1: eligibility_check
  const s1 = runStage1Eligibility(input, config);
  stages.push(s1);
  if (s1.decision !== 'continue') return stopWith(s1);

  // 阶段 2: scope_and_blacklist_check
  const s2 = runStage2Scope(input, config, now);
  stages.push(s2);
  if (s2.decision !== 'continue') return stopWith(s2);

  // 阶段 3: ownership_handoff_check
  const s3 = runStage3Ownership(input, now);
  ownershipGeneration = s3.generation;
  contextVersion = s3.contextVersion;
  stages.push(s3.outcome);
  if (s3.outcome.decision !== 'continue') return stopWith(s3.outcome);

  // 阶段 4: rhythm_rate_limit_check
  const s4 = runStage4Rhythm(input, config, gate);
  deferUntilMs = s4.deferUntilMs;
  stages.push(s4.outcome);
  if (s4.outcome.decision !== 'continue') return stopWith(s4.outcome);

  // 阶段 5: content_safety_check（前置零模型额度消耗）
  const s5 = runStage5ContentSafety(input.event.payload.text, config);
  stages.push(s5);
  if (s5.decision !== 'continue') return stopWith(s5);

  // 阶段 6: debounce_preprocess（私信碎片 2-5 秒静默聚合）
  const debounce = evaluateDebounce({
    store: input.store,
    authority: input.authority,
    event: input.event,
    config: config.debounce,
    now,
    expectedOwnershipGeneration: ownershipGeneration,
  });
  anchorEvent = debounce.anchorEvent;
  mergedText = debounce.mergedText;
  mergedEventIds = debounce.fragmentEventIds;
  contextVersion = debounce.latestContextVersion;
  ownershipGeneration = debounce.ownershipGeneration;
  if (debounce.deferUntilMs !== undefined) deferUntilMs = debounce.deferUntilMs;

  if (debounce.decision !== 'continue') {
    const s6Defer: StageOutcome = {
      stage: 'debounce_preprocess',
      decision: 'defer',
      reasonCode: debounce.reasonCode,
      detail: {
        fragmentCount: debounce.fragmentEventIds.length,
        anchorEventId: debounce.anchorEvent.id,
        ...(debounce.deferUntilMs !== undefined ? { deferUntilMs: debounce.deferUntilMs } : {}),
      },
    };
    stages.push(s6Defer);
    return stopWith(s6Defer);
  }

  // 跨碎片聚合后复核敏感词，封堵拆分碎片绕过敏感词的路径
  if (debounce.fragmentEventIds.length > 1) {
    const mergedSafety = checkInboundSafety(mergedText, config.sensitive);
    if (mergedSafety.blocked) {
      const s6Blocked: StageOutcome = {
        stage: 'debounce_preprocess',
        decision: 'handoff_human',
        reasonCode: mergedSafety.reasonCode,
        detail: {
          crossFragmentBlocked: true,
          fragmentCount: debounce.fragmentEventIds.length,
          layer: mergedSafety.layer,
          ...(mergedSafety.category ? { category: mergedSafety.category } : {}),
        },
      };
      stages.push(s6Blocked);
      return stopWith(s6Blocked);
    }
  }

  stages.push({
    stage: 'debounce_preprocess',
    decision: 'continue',
    reasonCode: debounce.reasonCode,
    detail: {
      fragmentCount: debounce.fragmentEventIds.length,
      anchorEventId: debounce.anchorEvent.id,
      merged: debounce.fragmentEventIds.length > 1,
    },
  });

  // 阶段 7: handoff_rules_and_knowledge
  if (knowledge === null && input.resolveKnowledge && !isMediaPayload(anchorEvent.payload)) {
    knowledge = input.resolveKnowledge(anchorEvent.payload, mergedText);
  }
  const s7 = evaluateHandoffRulesAndKnowledge(anchorEvent, mergedText, knowledge, config.handoff);
  directFaqReply = s7.directFaqReply;
  stages.push(s7.outcome);
  if (s7.outcome.decision !== 'continue') return stopWith(s7.outcome);

  return {
    eventId: input.event.id,
    anchorEvent,
    accountId: anchorEvent.payload.accountId,
    channel: anchorEvent.payload.channel,
    targetKey: targetKey(anchorEvent.payload),
    dryRun,
    decision: 'continue',
    stoppedAt: null,
    reasonCode: s7.outcome.reasonCode,
    stages,
    contextVersion,
    ownershipGeneration,
    mergedText,
    mergedEventIds,
    knowledge,
    directFaqReply,
  };
}

/**
 * 场景训练台只读干跑（dryRun）：
 * 严格只读（绝不写 SQLite 节流表、归因表、任务表、草稿表或消耗任何额度），
 * 完整执行 8 个有序阶段并返回逐阶段轨迹与最终归因结论。
 */
export function dryRunReplyPipeline(input: PipelineEvaluationInput): PipelineTrace {
  const config = resolvePipelineConfig(input.config);
  const pre = runReplyPipelinePreGeneration({ ...input, dryRun: true });
  const stages = [...pre.stages];

  let finalDecision: StageDecision = pre.decision;
  let stoppedAt: PipelineStageName | null = pre.stoppedAt;
  let reasonCode = pre.reasonCode;

  if (pre.decision === 'continue') {
    const replyCandidate = input.candidateReplyText ?? pre.directFaqReply?.text;
    if (replyCandidate !== undefined) {
      const s8 = evaluateOutboundStage({
        store: input.store,
        event: pre.anchorEvent,
        replyText: replyCandidate,
        config,
        now: input.now ?? input.authority.now,
        ...(input.recentReplies ? { recentReplies: input.recentReplies } : {}),
      });
      stages.push(s8);
      finalDecision = s8.decision;
      stoppedAt = s8.decision === 'continue' ? null : s8.stage;
      reasonCode = s8.reasonCode;
    } else {
      const s8Skipped: StageOutcome = {
        stage: 'outbound_safety_and_loop_check',
        decision: 'continue',
        reasonCode: 'OUTBOUND_DRY_RUN_NO_CANDIDATE',
      };
      stages.push(s8Skipped);
    }
  }

  return {
    eventId: pre.eventId,
    anchorEventId: pre.anchorEvent.id,
    accountId: pre.accountId,
    channel: pre.channel,
    targetKey: pre.targetKey,
    dryRun: true,
    finalDecision,
    stoppedAt,
    reasonCode,
    stages,
    contextVersion: pre.contextVersion,
    ownershipGeneration: pre.ownershipGeneration,
    mergedText: pre.mergedText,
    mergedEventIds: pre.mergedEventIds,
    directFaqReply: pre.directFaqReply,
    ...(pre.deferUntilMs !== undefined ? { deferUntilMs: pre.deferUntilMs } : {}),
    attributionRecorded: false,
  };
}

/** 在线模式记录转人工归因的统一入口（dryRun 绝不调用） */
export function recordPipelineHandoffAttribution(
  store: HandoffAttributionStore,
  event: StoredEvent,
  stage: PipelineStageName,
  reasonCode: string,
): void {
  store.record({
    accountId: event.payload.accountId,
    channel: event.payload.channel,
    eventId: event.id,
    stage,
    reasonCode,
  });
}
