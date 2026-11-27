import {randomUUID} from 'node:crypto';
import {digest,requireSafe,targetKey,type StoredEvent,type InboundEvent} from '../core/contracts.js';
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
  type ReplyPipelineConfig,
  type ResolvedReplyPipelineConfig,
} from './reply-pipeline/index.js';

export interface AutomaticReplyContext {
  store:EventStore;authority:WorkbenchAuthority;automation:AutomationStore;browser:PlatformConnector;
  models:ModelProviderController;provider:DeepSeekProvider;humanReplies:HumanReplyWorkflow;settings:AiSettings;
  modelPending:Set<string>;automaticSignal:AbortSignal;modelSignal:AbortSignal;
  isClosing():boolean;updated():void;stop(code:string):void;beforeWork():void;statusUpdated():void;errorCode(error:unknown):string;
  knowledgeContext?(event:InboundEvent):ReplyKnowledgeContext|null;
  currentSettings?():AiSettings;
  pipelineConfig?:ReplyPipelineConfig;
  rhythmGate?:PersistentRhythmGate;
  attributionStore?:HandoffAttributionStore;
  rng?:()=>number;
}

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

function recordHandoffStop(
  c:AutomaticReplyContext,
  grant:Grant<ReplyPolicy>,
  event:StoredEvent,
  contextVersion:string,
  generation:number,
  stage:'eligibility_check'|'scope_and_blacklist_check'|'ownership_handoff_check'|'rhythm_rate_limit_check'|'content_safety_check'|'debounce_preprocess'|'handoff_rules_and_knowledge'|'outbound_safety_and_loop_check',
  reasonCode:string,
  attributionStore:HandoffAttributionStore,
  recordAttribution:boolean,
):void{
  const now=c.authority.now();
  c.store.db.transaction(()=>{
    c.store.db.prepare(`INSERT INTO automation_jobs VALUES(?,?,?,?,?,?,?,NULL,?,?)
      ON CONFLICT(event_id) DO UPDATE SET state='REVIEW',reason=excluded.reason,updated_at=excluded.updated_at`)
      .run(event.id,grant.version,'REVIEW',contextVersion,generation,0,reasonCode,now,now);
    if(recordAttribution)recordPipelineHandoffAttribution(attributionStore,event,stage,reasonCode);
    c.store.audit('AUTO_REPLY_HANDOFF',event.id,{stage,reasonCode});
  }).immediate();
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
    if(pipelineConfig.rhythm.profile==='off'||rhythmGate.check(c.store.accountId,pipelineConfig.rhythm).allowed){
      const intentsBefore=(c.store.db.prepare('SELECT count(*) AS n FROM send_intents').get() as {n:number}).n;
      if(await recoverPolicyDraft(c.store,c.authority,c.automation,c.humanReplies,grant,c.beforeWork,c.models.guard)){
        const intentsAfter=(c.store.db.prepare('SELECT count(*) AS n FROM send_intents').get() as {n:number}).n;
        if(intentsAfter>intentsBefore)rhythmGate.recordAction(c.store.accountId,pipelineConfig.rhythm);
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
    if(!c.automation.allowance(grant.version,'MODEL')||!c.automation.allowance(grant.version,'SEND'))return;
    const candidates=listAutomaticCandidates(c,grant);
    if(!candidates.length)return;
    let selectedPre:PipelinePreGenerationResult|null=null;
    for(const candidate of candidates){
      const pre=runReplyPipelinePreGeneration({
        store:c.store,authority:c.authority,automation:c.automation,grant,event:candidate,
        config:pipelineConfig,
        resolveKnowledge:ev=>c.knowledgeContext?.(ev)??null,
        now:c.authority.now,
        ...(c.rng?{rng:c.rng}:{}),
      },rhythmGate);
      if(pre.decision==='defer'){
        if(pre.stoppedAt==='rhythm_rate_limit_check')return;
        continue;
      }
      if(pre.decision==='skip')continue;
      if(pre.decision==='handoff_human'){
        const handoffEvent=pre.anchorEvent;
        recordHandoffStop(
          c,grant,handoffEvent,
          pre.contextVersion??c.authority.contextVersion(handoffEvent),
          pre.ownershipGeneration??c.authority.ownership(handoffEvent).generation,
          pre.stoppedAt??'content_safety_check',
          pre.reasonCode,attributionStore,pipelineConfig.recordAttribution,
        );
        c.updated();
        return;
      }
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
      c.store.db.prepare("UPDATE automation_jobs SET state='GENERATING',updated_at=? WHERE event_id=?").run(c.authority.now(),event.id);
      const knowledge=selectedPre.knowledge??c.knowledgeContext?.(event.payload)??null;
      if(selectedPre.directFaqReply){
        const faqOutbound=evaluateOutboundStage({
          store:c.store,event,replyText:selectedPre.directFaqReply.text,config:pipelineConfig,now:c.authority.now,
        });
        if(faqOutbound.decision!=='continue'){
          recordHandoffStop(c,grant,event,context,generation,'outbound_safety_and_loop_check',faqOutbound.reasonCode,attributionStore,pipelineConfig.recordAttribution);
          return;
        }
        c.store.audit('AUTO_PIPELINE_EXACT_FAQ_MATCHED',event.id,{entryId:selectedPre.directFaqReply.entryId});
      }
      const settings={...c.settings,rules:grant.scope.instructions},settingsFingerprint=replySettingsFingerprint(settings,knowledge?.persona);
      const checkSettings=()=>requireSafe(replySettingsFingerprint(c.currentSettings?.()??c.settings,knowledge?.persona,grant.scope.instructions)===settingsFingerprint,'AI_SETTINGS_CHANGED');
      const binding={controller:c.models,kind:grant.kind,snapshot:c.models.guard.snapshot(grant,'REPLY_GENERATION')};
      const validate=()=>{
        checkSettings();
        requireSafe(c.automation.policyMatches(grant,c.store.event(event.id)),'POLICY_NO_LONGER_AUTHORIZED');
        requireSafe(c.authority.ownership(event).generation===generation&&c.authority.contextVersion(event)===context&&!c.authority.draftFor(event.id),'AUTO_RESULT_STALE');
      };
      const modelEnd=runtimePerformance.start('MODEL',event.payload.channel);
      const result=await c.provider.generate(c.store,event.payload,buildModelHistory(c,event,selectedPre.mergedEventIds),
        settings,'',true,signal,()=>{
          requireSafe(!signal.aborted,'MODEL_CANCELLED');
          c.models.guard.assertCurrent(binding.snapshot,'AUTO_REPLY');
          checkSettings();
          assertReplyKnowledgeCurrent(c.store,knowledge);
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
        recordHandoffStop(c,grant,event,context,generation,'outbound_safety_and_loop_check',outbound.reasonCode,attributionStore,pipelineConfig.recordAttribution);
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
          for(const mergedId of selectedPre.mergedEventIds){
            if(mergedId===event.id)continue;
            const hasState=c.store.db.prepare('SELECT 1 FROM automation_jobs WHERE event_id=?').get(mergedId)||
              c.store.db.prepare('SELECT 1 FROM reply_drafts WHERE event_id=?').get(mergedId)||
              c.store.db.prepare('SELECT 1 FROM send_intents WHERE event_id=?').get(mergedId);
            if(!hasState){
              const mergedTs=c.authority.now();
              c.store.db.prepare("INSERT INTO automation_jobs VALUES(?,?,?,?,?,0,'DEBOUNCE_MERGED_INTO_ANCHOR',?,?,?)")
                .run(mergedId,grant.version,'MERGED',context,generation,event.id,mergedTs,mergedTs);
            }
          }
        }).immediate();
        callId=undefined;
        await c.humanReplies.prepare(token,commandId);
        const command=c.authority.command(commandId);
        c.store.db.prepare('UPDATE automation_jobs SET state=?,reason=?,updated_at=? WHERE event_id=?').run(command.status,command.reason,c.authority.now(),event.id);
        if(command.intent_id!==null){
          rhythmGate.recordAction(c.store.accountId,pipelineConfig.rhythm);
        }
      }finally{c.authority.revoke(token);}
    }catch(error){
      const code=c.errorCode(routeSignal.aborted?routeSignal.reason:error);
      if(callId)c.models.models.discardUnpublishedCall(callId,modelCallFailureReason(routeSignal.aborted?routeSignal.reason:error));
      const paid=c.store.db.prepare("SELECT job_key FROM grant_reservations WHERE grant_version=? AND kind='MODEL' AND job_key=?").get(grant.version,event.id);
      if(automaticSignal.aborted&&!paid)c.store.db.prepare("DELETE FROM automation_jobs WHERE event_id=? AND command_id IS NULL AND state IN ('QUALIFYING','GENERATING')").run(event.id);
      else {
        c.store.db.prepare("UPDATE automation_jobs SET state='REVIEW',reason=?,updated_at=? WHERE event_id=?").run(code,c.authority.now(),event.id);
        if(pipelineConfig.recordAttribution&&catchAttributionCodes.has(code)){
          const stage=code==='MODEL_SENSITIVE_OUTPUT'||code==='MODEL_DUPLICATE_OUTPUT'?'outbound_safety_and_loop_check':
            code==='KNOWLEDGE_CONFLICT'?'handoff_rules_and_knowledge':'content_safety_check';
          recordPipelineHandoffAttribution(attributionStore,event,stage,code);
        }
      }
      if(shouldStopGlobally(code))c.stop(code);
      c.store.audit('AUTO_REPLY_STOPPED',event.id);
    }finally{c.modelPending.delete(event.id);c.updated();}
}
