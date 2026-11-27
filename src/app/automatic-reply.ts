import {randomUUID} from 'node:crypto';
import {digest,requireSafe,targetKey,validText,type StoredEvent,type InboundEvent} from '../core/contracts.js';
import {decodeEventRow,type EventRow,type EventStore} from '../storage/store.js';
import type {AutomationStore} from '../storage/automation-store.js';
import type {ModelProviderController} from './model-provider-controller.js';
import type {DeepSeekProvider} from '../ai/deepseek.js';
import type {WorkbenchAuthority} from './authority.js';
import type {PlatformConnector} from '../platform/platform-connector.js';
import type {HumanReplyWorkflow} from './human-reply-workflow.js';
import type {AiSettings,SendParams} from './contracts.js';
import type {Grant,ReplyPolicy} from './automation-contracts.js';
import {grantMatchesModel} from '../storage/model-grant-binding.js';
import {sameReplyPolicy} from './model-route-guard.js';
import {modelCallFailureReason} from '../ai/business-model-call.js';
import {recoverPolicyDraft} from './policy-draft-recovery.js';
import {readCommentThreadContext,commentThreadModelHistory} from '../storage/comment-thread-context.js';
import {shouldStopGlobally,securityCandidateCodes} from '../core/emergency-stop.js';
import {assertSecurityRevision,securityRevision} from '../storage/security-holds.js';
import {runtimePerformance} from '../observability/runtime-performance.js';
import type {ReplyKnowledgeContext} from '../knowledge/contracts.js';
import {assertReplyKnowledgeCurrent,bindReplyKnowledge,replySettingsFingerprint} from '../knowledge/generation-context.js';
import {
  HandoffAttributionStore,
  PersistentRhythmGate,
  evaluateOutboundStage,
  recordPipelineHandoffAttribution,
  resolvePipelineConfig,
  runReplyPipelinePreGeneration,
  type PipelinePreGenerationResult,
  type PipelineStageName,
  type ReplyPipelineConfig,
  type ResolvedReplyPipelineConfig,
} from './reply-pipeline/index.js';

export interface ServiceAutomaticReplyHost {
  store:EventStore;authority:WorkbenchAuthority;automation:AutomationStore|null;browser:PlatformConnector;
  models:ModelProviderController|null;provider:DeepSeekProvider;humanReplies:HumanReplyWorkflow;
  modelPending:Set<string>;automaticSignal:AbortSignal;modelSignal:AbortSignal;
  isClosing():boolean;keyPresent:boolean;settings():AiSettings;
  knowledgeContext(event:InboundEvent,queryText?:string):ReplyKnowledgeContext|null;
  pipelineConfig?:ReplyPipelineConfig;
  updated():void;stop(code:string):void;beforeWork():void;statusUpdated():void;errorCode(error:unknown):string;
}

/** 供 ClientService 委派自动回复执行，保持 service.ts 精简且不压缩格式 */
export async function runServiceAutomaticReply(host:ServiceAutomaticReplyHost):Promise<void>{
  const allowNoModelKey=Boolean(host.pipelineConfig?.handoff?.exactFaqDirectReply);
  if(host.isClosing()||host.browser.loginRecovery||!host.automation||!host.models||(!host.keyPresent&&!allowNoModelKey)||host.modelPending.size)return;
  await runAutomaticReply({
    store:host.store,authority:host.authority,automation:host.automation,browser:host.browser,
    knowledgeContext:host.knowledgeContext,
    ...(host.pipelineConfig?{pipelineConfig:host.pipelineConfig}:{}),
    provider:host.provider,humanReplies:host.humanReplies,
    settings:host.settings(),currentSettings:host.settings,
    models:host.models,modelPending:host.modelPending,
    automaticSignal:host.automaticSignal,modelSignal:host.modelSignal,
    isClosing:host.isClosing,updated:host.updated,errorCode:host.errorCode,
    beforeWork:host.beforeWork,statusUpdated:host.statusUpdated,stop:host.stop,
  });
}

export interface AutomaticReplyContext {
  store:EventStore;authority:WorkbenchAuthority;automation:AutomationStore;browser:PlatformConnector;
  models:ModelProviderController;provider:DeepSeekProvider;humanReplies:HumanReplyWorkflow;settings:AiSettings;
  modelPending:Set<string>;automaticSignal:AbortSignal;modelSignal:AbortSignal;
  isClosing():boolean;updated():void;stop(code:string):void;beforeWork():void;statusUpdated():void;errorCode(error:unknown):string;
  knowledgeContext?(event:InboundEvent,queryText?:string):ReplyKnowledgeContext|null;
  currentSettings?():AiSettings;
  pipelineConfig?:ReplyPipelineConfig;
  rhythmGate?:PersistentRhythmGate;
  attributionStore?:HandoffAttributionStore;
  rng?:()=>number;
}

const recoverableBeforeClickReasons=new Set([
  'CLIENT_CLOSING',
  'TARGET_CHANGED_REAPPROVE',
  'NATIVE_REPLY_EXISTING_DRAFT',
  'COMMENT_REPLY_ROOT_NOT_UNIQUE',
  'COMMENT_REPLY_CLOCK_UNVERIFIED',
]);

function resolveEffectivePipelineConfig(c:AutomaticReplyContext,rhythmGate:PersistentRhythmGate):ResolvedReplyPipelineConfig{
  const base=resolvePipelineConfig(c.pipelineConfig);
  if(c.pipelineConfig?.rhythm)return base;
  const storedProfile=rhythmGate.getStoredProfile(c.store.accountId,base.rhythm.scope??'ALL');
  if(!storedProfile||storedProfile==='off')return base;
  return {...base,rhythm:{...base.rhythm,profile:storedProfile}};
}

function listAutomaticCandidates(c:AutomaticReplyContext,grant:Grant<ReplyPolicy>):StoredEvent[]{
  const channels=grant.scope.channels;
  const rows=c.store.db.prepare(`SELECT e.id,e.payload,e.binding,e.status FROM inbound_events e
    WHERE e.account_id=? AND e.status='AWAITING_DRAFT' AND e.channel IN (${channels.map(()=>'?').join(',')})
    AND NOT EXISTS(SELECT 1 FROM automation_jobs j WHERE j.event_id=e.id)
    AND NOT EXISTS(SELECT 1 FROM reply_drafts d WHERE d.event_id=e.id)
    AND NOT EXISTS(SELECT 1 FROM send_intents i WHERE i.event_id=e.id) ORDER BY e.rowid`)
    .all(c.store.accountId,...channels) as EventRow[];
  const eligible:StoredEvent[]=[];
  for(const row of rows){
    const event=decodeEventRow(row,c.store.accountId);
    if(c.automation.policyMatches(grant,event))eligible.push(event);
  }
  return eligible;
}

function buildModelHistory(c:AutomaticReplyContext,event:StoredEvent,mergedEventIds:string[]):InboundEvent[]{
  const history=c.store.history(event.payload).filter(item=>!item.observationIssue&&!item.contentType);
  if(mergedEventIds.length<=1)return history;
  const seen=new Set(history.map(item=>`${item.platformEventId??''}:${item.occurredAt??''}:${item.text}`));
  const extras:InboundEvent[]=[];
  for(const id of mergedEventIds){
    if(id===event.id)continue;
    try{
      const fragment=c.store.event(id).payload;
      if(fragment.observationIssue||fragment.contentType)continue;
      const key=`${fragment.platformEventId??''}:${fragment.occurredAt??''}:${fragment.text}`;
      if(!seen.has(key)){seen.add(key);extras.push(fragment);}
    }catch{/* Ignore missing fragment; anchor event still binds contextVersion. */}
  }
  return [...extras,...history].sort((a,b)=>(a.occurredAt??'').localeCompare(b.occurredAt??''));
}

/** 预占模型前与落草稿事务内逐条复核全部非锚点碎片仍为 AWAITING_DRAFT、binding 未变且无冲突/草稿/发送意图 */
function assertBatchFragmentsCurrent(store:EventStore,anchorId:string,fragmentBindings:Record<string,string>):void{
  for(const [id,expectedBinding] of Object.entries(fragmentBindings)){
    if(id===anchorId)continue;
    const row=store.db.prepare('SELECT status,binding FROM inbound_events WHERE id=? AND account_id=?')
      .get(id,store.accountId) as {status:string;binding:string}|undefined;
    requireSafe(
      row&&row.status==='AWAITING_DRAFT'&&row.binding===expectedBinding&&
        !store.db.prepare('SELECT 1 FROM source_collisions WHERE event_id=? LIMIT 1').get(id)&&
        !store.db.prepare('SELECT 1 FROM reply_drafts WHERE event_id=? LIMIT 1').get(id)&&
        !store.db.prepare('SELECT 1 FROM send_intents WHERE event_id=? LIMIT 1').get(id)&&
        !store.db.prepare('SELECT 1 FROM automation_jobs WHERE event_id=? LIMIT 1').get(id),
      'AUTO_RESULT_STALE',
    );
  }
}

/** 同事务原子写入整批事件为 REVIEW（避免前序碎片残留 AWAITING_DRAFT 下轮单独触发回复），并记录转人工归因 */
function recordHandoffStop(
  c:AutomaticReplyContext,
  grant:Grant<ReplyPolicy>,
  event:StoredEvent,
  mergedEventIds:readonly string[],
  contextVersion:string,
  generation:number,
  stage:PipelineStageName,
  reasonCode:string,
  attributionStore:HandoffAttributionStore,
  recordAttribution:boolean,
):void{
  const now=c.authority.now();
  const batchIds=mergedEventIds.length?mergedEventIds:[event.id];
  c.store.db.transaction(()=>{
    for(const id of batchIds){
      if(id!==event.id&&(
        c.store.db.prepare('SELECT 1 FROM reply_drafts WHERE event_id=? LIMIT 1').get(id)||
        c.store.db.prepare('SELECT 1 FROM send_intents WHERE event_id=? LIMIT 1').get(id)
      ))continue;
      c.store.db.prepare(`INSERT INTO automation_jobs VALUES(?,?,?,?,?,?,?,NULL,?,?)
        ON CONFLICT(event_id) DO UPDATE SET state='REVIEW',reason=excluded.reason,updated_at=excluded.updated_at`)
        .run(id,grant.version,'REVIEW',contextVersion,generation,0,reasonCode,now,now);
    }
    if(recordAttribution)recordPipelineHandoffAttribution(attributionStore,event,stage,reasonCode);
    c.store.audit('AUTO_REPLY_HANDOFF',event.id,{stage,reasonCode,batchSize:batchIds.length});
  }).immediate();
}

/** 同事务写入非锚点碎片 MERGED 状态并绑定 commandId，发送前非白名单失败时再统一转 REVIEW */
function markMergedFragmentsInTx(
  c:AutomaticReplyContext,
  grant:Grant<ReplyPolicy>,
  anchorEventId:string,
  mergedEventIds:readonly string[],
  fragmentBindings:Record<string,string>,
  contextVersion:string,
  generation:number,
  commandId:string,
):void{
  if(mergedEventIds.length<=1)return;
  assertBatchFragmentsCurrent(c.store,anchorEventId,fragmentBindings);
  const mergedTs=c.authority.now();
  for(const mergedId of mergedEventIds){
    if(mergedId===anchorEventId)continue;
    c.store.db.prepare("INSERT INTO automation_jobs VALUES(?,?,?,?,?,0,'DEBOUNCE_MERGED_INTO_ANCHOR',?,?,?)")
      .run(mergedId,grant.version,'MERGED',contextVersion,generation,commandId,mergedTs,mergedTs);
  }
}

function finalizePreparedCommand(
  c:AutomaticReplyContext,
  eventId:string,
  commandId:string,
  rhythmGate:PersistentRhythmGate,
  pipelineConfig:ResolvedReplyPipelineConfig,
):void{
  const command=c.authority.command(commandId);
  const updatedAt=c.authority.now();
  c.store.db.transaction(()=>{
    c.store.db.prepare('UPDATE automation_jobs SET state=?,reason=?,updated_at=? WHERE event_id=?')
      .run(command.status,command.reason,updatedAt,eventId);
    // 发送前失败且未生成 send_intents 且不在恢复白名单时，将关联前序碎片统一置 REVIEW，避免永久滞留 MERGED
    if(command.intent_id===null&&(!command.reason||!recoverableBeforeClickReasons.has(command.reason))){
      c.store.db.prepare("UPDATE automation_jobs SET state='REVIEW',reason=?,updated_at=? WHERE state='MERGED' AND command_id=?")
        .run(command.reason??'AUTO_SEND_FAILED_BEFORE_CLICK',updatedAt,commandId);
    }
  }).immediate();
  if(command.intent_id!==null){
    rhythmGate.recordAction(c.store.accountId,pipelineConfig.rhythm,{intentId:command.intent_id});
  }
}

async function qualifyPolicyTarget(c:AutomaticReplyContext,grant:Grant<ReplyPolicy>,event:StoredEvent,signal:AbortSignal):Promise<void>{
  const handle=await c.browser.adapter(event.payload,c.store,signal);
  try{await c.browser.actor.run(async()=>{
    requireSafe(!signal.aborted&&c.automation.policyMatches(grant,c.store.event(event.id)),'POLICY_NO_LONGER_AUTHORIZED');
    const prior=await c.browser.refreshIdentity(event.payload.channel),proof=await handle.adapter.inspect(event.payload),identity=await c.browser.refreshIdentity(event.payload.channel);
    requireSafe(!signal.aborted&&prior&&identity&&digest(prior)===digest(identity),'CAPABILITY_CHANGED_DURING_CHECK');
    requireSafe(proof.ownId===grant.scope.ownId&&identity.identityDigest===digest(proof.ownId),'ACCOUNT_CHANGED');
    requireSafe(proof.accountId===event.payload.accountId&&proof.eventBinding===event.binding&&
      proof.targetKey===targetKey(event.payload)&&proof.composerKey===proof.targetKey,'TARGET_CHANGED');
  });}finally{await handle.dispose();}
}

/** Consume the existing one-time unpaid qualification before a fresh read. No old intent or paid generation can enter. */
async function recoverUnpaidCommentRoot(c:AutomaticReplyContext,grant:Grant<ReplyPolicy>):Promise<void>{
  if(!c.automation.allowance(grant.version,'MODEL')||!c.automation.allowance(grant.version,'SEND'))return;
  const jobs=c.store.db.prepare(`SELECT j.event_id,j.context_version,j.grant_version,g.scope_json,g.scope_digest FROM automation_jobs j
    JOIN automation_grants g ON g.version=j.grant_version AND g.kind='AUTO_REPLY'
    WHERE j.state='REVIEW' AND j.reason='COMMENT_REPLY_ROOT_NOT_UNIQUE' AND j.draft_version=0
    AND NOT EXISTS(SELECT 1 FROM grant_reservations r WHERE r.job_key=j.event_id AND r.kind IN ('MODEL','SEND'))
    AND NOT EXISTS(SELECT 1 FROM reply_drafts d WHERE d.event_id=j.event_id)
    AND NOT EXISTS(SELECT 1 FROM send_intents i WHERE i.event_id=j.event_id)
    AND NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.event_type='AUTO_QUALIFICATION_RESUMED' AND a.entity_id=j.event_id)`)
    .all() as {event_id:string;context_version:string;grant_version:number;scope_json:string;scope_digest:string}[];
  const {selection,route}=c.models.guard.current();
  for(const job of jobs){
    let previous:ReplyPolicy;
    try{previous=c.automation.readGrantScope('AUTO_REPLY',job) as ReplyPolicy;}catch{continue;}
    if(!grantMatchesModel({...grant,version:job.grant_version,scope:previous},selection,route))continue;
    const event=c.store.event(job.event_id);
    if(event.payload.channel!=='COMMENT_NOTIFICATION'||!sameReplyPolicy(previous,grant.scope,event.payload.kind==='REPLY')||
      !c.automation.policyMatches(grant,event)||c.authority.contextVersion(event)!==job.context_version)continue;
    const generation=c.authority.ownership(event).generation,signal=AbortSignal.any([c.modelSignal,c.automaticSignal,c.models.signal]);
    c.beforeWork();
    const claimed=c.store.db.transaction(()=>{
      if(c.isClosing()||signal.aborted||!c.automation.policyMatches(grant,c.store.event(event.id))||
        c.authority.contextVersion(event)!==job.context_version||c.authority.ownership(event).generation!==generation||
        !c.store.db.prepare(`SELECT event_id FROM automation_jobs WHERE event_id=? AND state='REVIEW'
        AND reason='COMMENT_REPLY_ROOT_NOT_UNIQUE' AND draft_version=0 AND context_version=? AND grant_version=?`)
        .get(event.id,job.context_version,job.grant_version)||
        c.store.db.prepare("SELECT id FROM audit_events WHERE event_type='AUTO_QUALIFICATION_RESUMED' AND entity_id=?").get(event.id)||
        c.store.db.prepare('SELECT job_key FROM grant_reservations WHERE job_key=?').get(event.id)||
        c.store.db.prepare('SELECT id FROM reply_drafts WHERE event_id=?').get(event.id)||
        c.store.db.prepare('SELECT id FROM send_intents WHERE event_id=?').get(event.id))return false;
      c.store.audit('AUTO_QUALIFICATION_RESUMED',event.id,{root:true,contract:1});return true;
    }).immediate();
    if(!claimed)continue;
    c.modelPending.add(event.id);
    try{
      c.store.assertModelObservation(event.payload);
      if(event.payload.kind==='REPLY')commentThreadModelHistory(readCommentThreadContext(c.store,event.payload),event.payload);
      await qualifyPolicyTarget(c,grant,event,signal);
      c.store.db.transaction(()=>{
        requireSafe(!c.isClosing()&&!signal.aborted&&c.automation.policyMatches(grant,c.store.event(event.id))&&
          c.authority.contextVersion(event)===job.context_version&&c.authority.ownership(event).generation===generation&&!c.authority.draftFor(event.id),'AUTO_RESULT_STALE');
        requireSafe(!c.store.db.prepare('SELECT job_key FROM grant_reservations WHERE job_key=?').get(event.id)&&
          !c.store.db.prepare('SELECT id FROM send_intents WHERE event_id=?').get(event.id),'AUTO_RESULT_STALE');
        requireSafe(c.store.db.prepare(`DELETE FROM automation_jobs WHERE event_id=? AND state='REVIEW'
          AND reason='COMMENT_REPLY_ROOT_NOT_UNIQUE' AND draft_version=0 AND context_version=? AND grant_version=?`)
          .run(event.id,job.context_version,job.grant_version).changes===1,'AUTO_RESULT_STALE');
      }).immediate();
    }catch(error){
      const code=c.errorCode(error);c.store.db.prepare("UPDATE automation_jobs SET reason=?,updated_at=? WHERE event_id=? AND state='REVIEW' AND draft_version=0")
        .run(code,c.authority.now(),event.id);
      if(shouldStopGlobally(code))c.stop(code);
    }finally{c.modelPending.delete(event.id);c.updated();}
    return;
  }
}

const catchAttributionCodes=new Set([
  'SENSITIVE_MANUAL_HANDLING',
  'MODEL_SENSITIVE_OUTPUT',
  'MODEL_DUPLICATE_OUTPUT',
  'KNOWLEDGE_CONFLICT',
  'DM_CONTENT_UNVERIFIED',
]);

/** Existing policy orchestration upgraded with the 8-stage reply pipeline, persistent rhythm gate and handoff attribution. */
export async function runAutomaticReply(c:AutomaticReplyContext):Promise<void> {
    const grant=c.models.guard.eligibleGrant('AUTO_REPLY') as Grant<ReplyPolicy>|null;
    if(!grant||grant.scope.model!==c.settings.model)return;
    const rhythmGate=c.rhythmGate??new PersistentRhythmGate(c.store.db,{now:c.authority.now,...(c.rng?{rng:c.rng}:{})});
    const attributionStore=c.attributionStore??new HandoffAttributionStore(c.store.db,c.authority.now);
    const pipelineConfig=resolveEffectivePipelineConfig(c,rhythmGate);
    const heldJobs=c.store.db.prepare(`SELECT event_id,reason FROM automation_jobs WHERE state='REVIEW' AND draft_version=0
      AND NOT EXISTS(SELECT 1 FROM grant_reservations r WHERE r.job_key=automation_jobs.event_id)
      AND NOT EXISTS(SELECT 1 FROM reply_drafts d WHERE d.event_id=automation_jobs.event_id)
      AND NOT EXISTS(SELECT 1 FROM send_intents i WHERE i.event_id=automation_jobs.event_id)`).all() as {event_id:string;reason:string}[];
    for(const job of heldJobs)if((securityCandidateCodes.has(job.reason)||job.reason==='SECURITY_CHANNEL_HELD')&&
      c.automation.policyMatches(grant,c.store.event(job.event_id)))
      c.store.db.prepare("DELETE FROM automation_jobs WHERE event_id=? AND state='REVIEW' AND draft_version=0").run(job.event_id);
    if(pipelineConfig.rhythm.profile==='off'||rhythmGate.evaluateOrTriggerCooloff(c.store.accountId,pipelineConfig.rhythm).allowed){
      if(await recoverPolicyDraft(c.store,c.authority,c.automation,c.humanReplies,grant,c.beforeWork,c.models.guard,{
        pipelineConfig,
        attributionStore,
        onIntentSubmitted:intentId=>rhythmGate.recordAction(c.store.accountId,pipelineConfig.rhythm,{intentId}),
      })){
        c.updated();return;
      }
    }
    await recoverUnpaidCommentRoot(c,grant);
    const readable=c.store.db.prepare(`SELECT event_id FROM automation_jobs WHERE state='REVIEW' AND reason IN ('DM_CONTENT_UNVERIFIED','OBSERVATION_DM_CONTENT_DOM_NOT_READY','COMMENT_ROOT_CONTEXT_REQUIRED','COMMENT_THREAD_CONTEXT_UNVERIFIED') AND draft_version=0
      AND NOT EXISTS(SELECT 1 FROM grant_reservations r WHERE r.kind='MODEL' AND r.job_key=automation_jobs.event_id)
      AND NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.event_type='AUTO_QUALIFICATION_RESUMED' AND a.entity_id=automation_jobs.event_id)
      AND NOT EXISTS(SELECT 1 FROM send_intents i WHERE i.event_id=automation_jobs.event_id)`).all() as {event_id:string}[];
    for(const pending of readable)try{
      const event=c.store.event(pending.event_id);c.store.assertModelObservation(event.payload);
      if(event.payload.kind==='REPLY')commentThreadModelHistory(readCommentThreadContext(c.store,event.payload),event.payload);
      if(c.automation.policyMatches(grant,event))c.store.db.transaction(()=>{
        c.store.audit('AUTO_QUALIFICATION_RESUMED',event.id);c.store.db.prepare('DELETE FROM automation_jobs WHERE event_id=?').run(event.id);
      }).immediate();
    }catch{/* Current content or context remains unverified; retain the stop without a paid retry. */}
    if(!c.automation.allowance(grant.version,'SEND'))return;
    const hasModelAllowance=c.automation.allowance(grant.version,'MODEL');
    if(!hasModelAllowance&&!pipelineConfig.handoff.exactFaqDirectReply)return;
    const candidates=listAutomaticCandidates(c,grant);
    if(!candidates.length)return;
    let selectedPre:PipelinePreGenerationResult|null=null;
    for(const candidate of candidates){
      let pre:PipelinePreGenerationResult;
      try{
        pre=runReplyPipelinePreGeneration({
          store:c.store,authority:c.authority,automation:c.automation,grant,event:candidate,
          config:pipelineConfig,
          resolveKnowledge:(ev,mergedText)=>c.knowledgeContext?.(ev,mergedText)??null,
          now:c.authority.now,
          ...(c.rng?{rng:c.rng}:{}),
        },rhythmGate);
      }catch(error){
        const code=c.errorCode(error);
        if(shouldStopGlobally(code)){c.stop(code);return;}
        const nowTs=c.authority.now();
        c.store.db.transaction(()=>{
          c.store.db.prepare(`INSERT INTO automation_jobs VALUES(?,?,?,?,?,?,?,NULL,?,?)
            ON CONFLICT(event_id) DO UPDATE SET state='REVIEW',reason=excluded.reason,updated_at=excluded.updated_at`)
            .run(candidate.id,grant.version,'REVIEW',c.authority.contextVersion(candidate),c.authority.ownership(candidate).generation,0,code,nowTs,nowTs);
          c.store.audit('AUTO_REPLY_STOPPED',candidate.id,{stage:'pre_generation',reasonCode:code});
        }).immediate();
        c.updated();
        continue;
      }
      if(pre.decision==='defer'){
        if(pre.stoppedAt==='rhythm_rate_limit_check')return;
        continue;
      }
      if(pre.decision==='skip')continue;
      if(pre.decision==='handoff_human'){
        const handoffEvent=pre.anchorEvent;
        recordHandoffStop(
          c,grant,handoffEvent,pre.mergedEventIds,
          pre.contextVersion??c.authority.contextVersion(handoffEvent),
          pre.ownershipGeneration??c.authority.ownership(handoffEvent).generation,
          pre.stoppedAt??'content_safety_check',
          pre.reasonCode,attributionStore,pipelineConfig.recordAttribution,
        );
        c.updated();
        return;
      }
      // 无 MODEL 额度时，仅放行命中高置信 FAQ 确定性直出的候选，跳过需调模型的普通候选
      if(!hasModelAllowance&&!pre.directFaqReply)continue;
      selectedPre=pre;
      break;
    }
    if(!selectedPre)return;
    const event=selectedPre.anchorEvent;
    const generation=c.authority.ownership(event).generation,context=c.authority.contextVersion(event),now=c.authority.now();
    if((selectedPre.ownershipGeneration!==null&&selectedPre.ownershipGeneration!==generation)||
      (selectedPre.contextVersion!==null&&selectedPre.contextVersion!==context))return;
    c.beforeWork();
    const security=securityRevision(c.store,event.payload.channel);
    c.store.db.prepare('INSERT INTO automation_jobs VALUES(?,?,?,?,?,?,NULL,NULL,?,?)').run(event.id,grant.version,'QUALIFYING',context,generation,0,now,now);
    c.modelPending.add(event.id);
    c.statusUpdated();
    const automaticSignal=c.automaticSignal,routeSignal=c.models.signal,signal=AbortSignal.any([c.modelSignal,automaticSignal,routeSignal]);
    let callId:string|undefined;
    try {
      await qualifyPolicyTarget(c,grant,event,signal);
      requireSafe(!signal.aborted&&c.automation.policyMatches(grant,c.store.event(event.id))&&c.authority.contextVersion(event)===context&&c.authority.ownership(event).generation===generation,'AUTO_RESULT_STALE');
      assertBatchFragmentsCurrent(c.store,event.id,selectedPre.fragmentBindings);
      const effectiveQuery=selectedPre.mergedEventIds.length>1?selectedPre.mergedText:event.payload.text;
      const knowledge=selectedPre.knowledge??c.knowledgeContext?.(event.payload,effectiveQuery)??null;
      const settings={...c.settings,rules:grant.scope.instructions},settingsFingerprint=replySettingsFingerprint(settings,knowledge?.persona);
      const checkSettings=()=>requireSafe(replySettingsFingerprint(c.currentSettings?.()??c.settings,knowledge?.persona,grant.scope.instructions)===settingsFingerprint,'AI_SETTINGS_CHANGED');

      // 高置信 FAQ 确定性免模型直出分支：零模型调用、零 MODEL 预占，完整经安全校验与唯一 SendCoordinator 单次提交
      if(pipelineConfig.handoff.exactFaqDirectReply&&selectedPre.directFaqReply&&knowledge){
        const faqOutbound=evaluateOutboundStage({
          store:c.store,event,replyText:selectedPre.directFaqReply.text,config:pipelineConfig,now:c.authority.now,
        });
        if(faqOutbound.decision!=='continue'){
          recordHandoffStop(
            c,grant,event,selectedPre.mergedEventIds,context,generation,
            'outbound_safety_and_loop_check',faqOutbound.reasonCode,attributionStore,pipelineConfig.recordAttribution,
          );
          return;
        }
        const directText=validText(selectedPre.directFaqReply.text);
        if(signal.aborted)throw signal.reason;
        checkSettings();
        assertSecurityRevision(c.store,event.payload.channel,security);
        const commandId=randomUUID(),selectionId=randomUUID();
        const token=c.authority.issueSession();
        try{
          c.store.db.transaction(()=>{
            checkSettings();
            assertReplyKnowledgeCurrent(c.store,knowledge);
            assertSecurityRevision(c.store,event.payload.channel,security);
            assertBatchFragmentsCurrent(c.store,event.id,selectedPre.fragmentBindings);
            requireSafe(!c.isClosing()&&c.automation.policyMatches(grant,c.store.event(event.id)),'POLICY_NO_LONGER_AUTHORIZED');
            requireSafe(c.automation.allowance(grant.version,'SEND'),'SEND_GRANT_EXHAUSTED');
            requireSafe(c.authority.ownership(event).generation===generation&&c.authority.contextVersion(event)===context&&!c.authority.draftFor(event.id),'AUTO_RESULT_STALE');
            const draftId=randomUUID(),ts=c.authority.now();
            c.store.db.prepare("INSERT INTO reply_drafts VALUES(?,?,?,?,1,'DRAFT',NULL,NULL)").run(draftId,event.id,directText,'AUTO_FAQ_DIRECT');
            c.store.db.prepare("INSERT INTO draft_revisions VALUES(?,1,'AUTO_FAQ_DIRECT',?,?,?)").run(draftId,directText,`policy:${grant.version}`,ts);
            bindReplyKnowledge(c.store,'DRAFT',draftId,1,knowledge);
            c.store.db.prepare("UPDATE inbound_events SET status='AWAITING_APPROVAL' WHERE id=?").run(event.id);
            const params:SendParams={eventId:event.id,generation,draftId,draftVersion:1,text:directText,contextVersion:context,selectionId};
            c.store.db.prepare("INSERT INTO manual_send_commands VALUES(?,?,?,?,?,'PREPARING',NULL,NULL,?)").run(commandId,event.id,
              c.authority.operator(token).id,digest(params),JSON.stringify(params),ts);
            c.store.db.prepare('INSERT INTO policy_commands VALUES(?,?,?)').run(commandId,grant.version,generation);
            c.store.db.prepare("UPDATE automation_jobs SET state='PREPARING',draft_version=1,command_id=?,updated_at=? WHERE event_id=?").run(commandId,ts,event.id);
            markMergedFragmentsInTx(c,grant,event.id,selectedPre.mergedEventIds,selectedPre.fragmentBindings,context,generation,commandId);
            c.store.audit('AUTO_PIPELINE_EXACT_FAQ_MATCHED',event.id,{entryId:selectedPre.directFaqReply!.entryId,direct:true});
          }).immediate();
          await c.humanReplies.prepare(token,commandId);
          finalizePreparedCommand(c,event.id,commandId,rhythmGate,pipelineConfig);
        }finally{c.authority.revoke(token);}
        return;
      }

      c.store.db.prepare("UPDATE automation_jobs SET state='GENERATING',updated_at=? WHERE event_id=?").run(c.authority.now(),event.id);
      const binding={controller:c.models,kind:grant.kind,snapshot:c.models.guard.snapshot(grant,'REPLY_GENERATION')};
      const validate=()=>{
        checkSettings();
        requireSafe(c.automation.policyMatches(grant,c.store.event(event.id)),'POLICY_NO_LONGER_AUTHORIZED');
        requireSafe(c.authority.ownership(event).generation===generation&&c.authority.contextVersion(event)===context&&!c.authority.draftFor(event.id),'AUTO_RESULT_STALE');
        assertBatchFragmentsCurrent(c.store,event.id,selectedPre.fragmentBindings);
      };
      // 碎片聚合命中多条消息时，仅向模型提示与知识校验传入聚合文本浅拷贝；数据库/目标/意图绑定 100% 保持原始 anchorEvent
      const modelEvent=selectedPre.mergedEventIds.length>1&&selectedPre.mergedText!==event.payload.text
        ?{...event.payload,text:selectedPre.mergedText}
        :event.payload;
      const modelEnd=runtimePerformance.start('MODEL',event.payload.channel);
      const result=await c.provider.generate(c.store,modelEvent,buildModelHistory(c,event,selectedPre.mergedEventIds),
        settings,'',true,signal,()=>{
          requireSafe(!signal.aborted,'MODEL_CANCELLED');
          c.models.guard.assertCurrent(binding.snapshot,'AUTO_REPLY');
          checkSettings();
          assertReplyKnowledgeCurrent(c.store,knowledge);
          assertBatchFragmentsCurrent(c.store,event.id,selectedPre.fragmentBindings);
          requireSafe(c.automation.policyMatches(grant,c.store.event(event.id)),'POLICY_NO_LONGER_AUTHORIZED');
          requireSafe(c.automation.allowance(grant.version,'SEND'),'SEND_GRANT_EXHAUSTED');
          c.automation.reserve(grant.version,'MODEL',event.id);
        },undefined,knowledge,binding,validate).then(result=>{modelEnd();return result;},error=>{modelEnd(signal.aborted?'CANCELLED':'FAILED');throw error;});
      callId=result.callId;
      if(signal.aborted)throw signal.reason;
      checkSettings();
      assertSecurityRevision(c.store,event.payload.channel,security);
      // 阶段 8：出站双层敏感词终审 + 同句死循环保护（放行后仍必须经现有唯一 SendCoordinator 单次提交）
      const outbound=evaluateOutboundStage({
        store:c.store,event,replyText:result.text,config:pipelineConfig,now:c.authority.now,
      });
      if(outbound.decision!=='continue'){
        c.models.models.discardUnpublishedCall(
          callId,
          outbound.reasonCode==='LOOP_BREAKER_HANDOFF'?'MODEL_DUPLICATE_OUTPUT':'MODEL_SENSITIVE_OUTPUT',
        );
        callId=undefined;
        recordHandoffStop(
          c,grant,event,selectedPre.mergedEventIds,context,generation,
          'outbound_safety_and_loop_check',outbound.reasonCode,attributionStore,pipelineConfig.recordAttribution,
        );
        return;
      }
      const commandId=randomUUID(),selectionId=randomUUID();
      const token=c.authority.issueSession();
      try {
        c.store.db.transaction(()=>{
          c.models.guard.assertCurrent(binding.snapshot,'AUTO_REPLY');
          checkSettings();
          assertReplyKnowledgeCurrent(c.store,knowledge);
          assertSecurityRevision(c.store,event.payload.channel,security);
          assertBatchFragmentsCurrent(c.store,event.id,selectedPre.fragmentBindings);
          requireSafe(!c.isClosing()&&c.automation.policyMatches(grant,c.store.event(event.id)),'POLICY_NO_LONGER_AUTHORIZED');
          requireSafe(c.authority.ownership(event).generation===generation&&c.authority.contextVersion(event)===context&&!c.authority.draftFor(event.id),'AUTO_RESULT_STALE');
          const draftId=randomUUID();
          c.store.db.prepare("INSERT INTO reply_drafts VALUES(?,?,?,?,1,'DRAFT',NULL,NULL)").run(draftId,event.id,result.text,result.model);
          c.store.db.prepare("INSERT INTO draft_revisions VALUES(?,1,'AUTO_POLICY',?,?,?)").run(draftId,result.text,`policy:${grant.version}`,c.authority.now());
          bindReplyKnowledge(c.store,'DRAFT',draftId,1,knowledge);
          c.models.models.bindGeneration({ownerKind:'DRAFT',ownerId:draftId,ownerVersion:1},result.callId);
          c.store.db.prepare("UPDATE inbound_events SET status='AWAITING_APPROVAL' WHERE id=?").run(event.id);
          const params:SendParams={eventId:event.id,generation,draftId,draftVersion:1,text:result.text,contextVersion:context,selectionId};
          c.store.db.prepare("INSERT INTO manual_send_commands VALUES(?,?,?,?,?,'PREPARING',NULL,NULL,?)").run(commandId,event.id,
            c.authority.operator(token).id,digest(params),JSON.stringify(params),c.authority.now());
          c.store.db.prepare('INSERT INTO policy_commands VALUES(?,?,?)').run(commandId,grant.version,generation);
          c.store.db.prepare("UPDATE automation_jobs SET state='PREPARING',draft_version=1,command_id=?,updated_at=? WHERE event_id=?").run(commandId,c.authority.now(),event.id);
          markMergedFragmentsInTx(c,grant,event.id,selectedPre.mergedEventIds,selectedPre.fragmentBindings,context,generation,commandId);
        }).immediate();
        callId=undefined;
        await c.humanReplies.prepare(token,commandId);
        finalizePreparedCommand(c,event.id,commandId,rhythmGate,pipelineConfig);
      }finally{c.authority.revoke(token);}
    }catch(error){
      const code=c.errorCode(routeSignal.aborted?routeSignal.reason:error);
      if(callId)c.models.models.discardUnpublishedCall(callId,modelCallFailureReason(routeSignal.aborted?routeSignal.reason:error));
      const paid=c.store.db.prepare("SELECT job_key FROM grant_reservations WHERE grant_version=? AND kind='MODEL' AND job_key=?").get(grant.version,event.id);
      if(automaticSignal.aborted&&!paid)c.store.db.prepare("DELETE FROM automation_jobs WHERE event_id=? AND command_id IS NULL AND state IN ('QUALIFYING','GENERATING')").run(event.id);
      else {
        const ts=c.authority.now();
        c.store.db.transaction(()=>{
          c.store.db.prepare("UPDATE automation_jobs SET state='REVIEW',reason=?,updated_at=? WHERE event_id=?").run(code,ts,event.id);
          for(const id of selectedPre.mergedEventIds){
            if(id===event.id)continue;
            if(c.store.db.prepare('SELECT 1 FROM reply_drafts WHERE event_id=? LIMIT 1').get(id)||
              c.store.db.prepare('SELECT 1 FROM send_intents WHERE event_id=? LIMIT 1').get(id))continue;
            c.store.db.prepare(`INSERT INTO automation_jobs VALUES(?,?,?,?,?,?,?,NULL,?,?)
              ON CONFLICT(event_id) DO UPDATE SET state='REVIEW',reason=excluded.reason,updated_at=excluded.updated_at`)
              .run(id,grant.version,'REVIEW',context,generation,0,code,ts,ts);
          }
          if(pipelineConfig.recordAttribution&&catchAttributionCodes.has(code)){
            const stage=code==='MODEL_SENSITIVE_OUTPUT'||code==='MODEL_DUPLICATE_OUTPUT'?'outbound_safety_and_loop_check':
              code==='KNOWLEDGE_CONFLICT'?'handoff_rules_and_knowledge':'content_safety_check';
            recordPipelineHandoffAttribution(attributionStore,event,stage,code);
          }
        }).immediate();
      }
      if(shouldStopGlobally(code))c.stop(code);
      c.store.audit('AUTO_REPLY_STOPPED',event.id);
    }finally{c.modelPending.delete(event.id);c.updated();}
}
