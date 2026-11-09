import {randomUUID} from 'node:crypto';
import {digest,requireSafe,targetKey} from '../core/contracts.js';
import type {EventStore} from '../storage/store.js';
import type {AutomationStore} from '../storage/automation-store.js';
import type {DeepSeekProvider} from '../ai/deepseek.js';
import type {WorkbenchAuthority} from './authority.js';
import type {BrowserService} from './browser-service.js';
import type {HumanReplyWorkflow} from './human-reply-workflow.js';
import type {AiSettings,SendParams} from './contracts.js';
import type {Grant,ReplyPolicy} from './automation-contracts.js';
import {recoverPolicyDraft} from './policy-draft-recovery.js';
import {readCommentThreadContext,commentThreadModelHistory} from '../storage/comment-thread-context.js';
import {collectionStops} from './collection-scheduler.js';
import {runtimePerformance} from '../observability/runtime-performance.js';

interface AutomaticReplyContext {
  store:EventStore;authority:WorkbenchAuthority;automation:AutomationStore;browser:BrowserService;
  provider:DeepSeekProvider;humanReplies:HumanReplyWorkflow;settings:AiSettings;key:string;
  modelPending:Set<string>;automaticSignal:AbortSignal;modelSignal:AbortSignal;
  isClosing():boolean;updated():void;stop():void;beforeWork():void;statusUpdated():void;errorCode(error:unknown):string;
}

/** Existing policy orchestration extracted unchanged so the application service can own lifecycle controls. */
export async function runAutomaticReply(c:AutomaticReplyContext):Promise<void> {
    const grant=c.automation.active('AUTO_REPLY') as Grant<ReplyPolicy>|null;
    if(!grant||grant.scope.model!==c.settings.model)return;
    if(await recoverPolicyDraft(c.store,c.authority,c.automation,c.humanReplies,grant,c.beforeWork)){
      c.updated();return;
    }
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
    const event=c.store.firstAutomaticCandidate(grant.scope.channels,e=>c.automation.policyMatches(grant,e));
    if(!event)return;
    c.beforeWork();
    const generation=c.authority.ownership(event).generation,context=c.authority.contextVersion(event),now=c.authority.now();
    c.store.db.prepare('INSERT INTO automation_jobs VALUES(?,?,?,?,?,?,NULL,NULL,?,?)').run(event.id,grant.version,'QUALIFYING',context,generation,0,now,now);
    c.modelPending.add(event.id);
    c.statusUpdated();
    const automaticSignal=c.automaticSignal,signal=AbortSignal.any([c.modelSignal,automaticSignal]);
    try {
      const handle=await c.browser.adapter(event.payload,c.store,signal);
      try{await c.browser.actor.run(async()=>{
        requireSafe(!signal.aborted&&c.automation.policyMatches(grant,c.store.event(event.id)),'POLICY_NO_LONGER_AUTHORIZED');
        const prior=await c.browser.refreshIdentity(event.payload.channel),proof=await handle.adapter.inspect(event.payload),identity=await c.browser.refreshIdentity(event.payload.channel);
        requireSafe(!signal.aborted&&prior&&identity&&digest(prior)===digest(identity),'CAPABILITY_CHANGED_DURING_CHECK');
        requireSafe(proof.ownId===grant.scope.ownId&&identity.identityDigest===digest(proof.ownId),'ACCOUNT_CHANGED');
        requireSafe(proof.accountId===event.payload.accountId&&proof.eventBinding===event.binding&&
          proof.targetKey===targetKey(event.payload)&&proof.composerKey===proof.targetKey,'TARGET_CHANGED');
      });}finally{handle.dispose();}
      requireSafe(!signal.aborted&&c.automation.policyMatches(grant,c.store.event(event.id))&&c.authority.contextVersion(event)===context&&c.authority.ownership(event).generation===generation,'AUTO_RESULT_STALE');
      c.store.db.prepare("UPDATE automation_jobs SET state='GENERATING',updated_at=? WHERE event_id=?").run(c.authority.now(),event.id);
      const modelEnd=runtimePerformance.start('MODEL',event.payload.channel);
      const result=await c.provider.generate(c.store,event.payload,c.store.history(event.payload).filter(item=>!item.observationIssue&&!item.contentType),
        {...c.settings,rules:grant.scope.instructions},c.key,true,signal,()=>{
          requireSafe(!signal.aborted,'MODEL_CANCELLED');
          requireSafe(c.automation.policyMatches(grant,c.store.event(event.id)),'POLICY_NO_LONGER_AUTHORIZED');
          requireSafe(c.automation.allowance(grant.version,'SEND'),'SEND_GRANT_EXHAUSTED');
          c.automation.reserve(grant.version,'MODEL',event.id);
        }).then(result=>{modelEnd();return result;},error=>{modelEnd(signal.aborted?'CANCELLED':'FAILED');throw error;});
      requireSafe(!signal.aborted,'MODEL_CANCELLED');
      const commandId=randomUUID(),selectionId=randomUUID();
      const token=c.authority.issueSession();
      try {
        c.store.db.transaction(()=>{
          requireSafe(!c.isClosing()&&c.automation.policyMatches(grant,c.store.event(event.id)),'POLICY_NO_LONGER_AUTHORIZED');
          requireSafe(c.authority.ownership(event).generation===generation&&c.authority.contextVersion(event)===context&&!c.authority.draftFor(event.id),'AUTO_RESULT_STALE');
          const draftId=randomUUID();
          c.store.db.prepare("INSERT INTO reply_drafts VALUES(?,?,?,?,1,'DRAFT',NULL,NULL)").run(draftId,event.id,result.text,result.model);
          c.store.db.prepare("INSERT INTO draft_revisions VALUES(?,1,'AUTO_POLICY',?,?,?)").run(draftId,result.text,`policy:${grant.version}`,c.authority.now());
          c.store.db.prepare("UPDATE inbound_events SET status='AWAITING_APPROVAL' WHERE id=?").run(event.id);
          const params:SendParams={eventId:event.id,generation,draftId,draftVersion:1,text:result.text,contextVersion:context,selectionId};
          c.store.db.prepare("INSERT INTO manual_send_commands VALUES(?,?,?,?,?,'PREPARING',NULL,NULL,?)").run(commandId,event.id,
            c.authority.operator(token).id,digest(params),JSON.stringify(params),c.authority.now());
          c.store.db.prepare('INSERT INTO policy_commands VALUES(?,?,?)').run(commandId,grant.version,generation);
          c.store.db.prepare("UPDATE automation_jobs SET state='PREPARING',draft_version=1,command_id=?,updated_at=? WHERE event_id=?").run(commandId,c.authority.now(),event.id);
        }).immediate();
        await c.humanReplies.prepare(token,commandId);
        const command=c.authority.command(commandId);
        c.store.db.prepare('UPDATE automation_jobs SET state=?,reason=?,updated_at=? WHERE event_id=?').run(command.status,command.reason,c.authority.now(),event.id);
      }finally{c.authority.revoke(token);}
    }catch(error){
      const code=c.errorCode(error);
      const paid=c.store.db.prepare("SELECT job_key FROM grant_reservations WHERE grant_version=? AND kind='MODEL' AND job_key=?").get(grant.version,event.id);
      if(automaticSignal.aborted&&!paid)c.store.db.prepare("DELETE FROM automation_jobs WHERE event_id=? AND command_id IS NULL AND state IN ('QUALIFYING','GENERATING')").run(event.id);
      else c.store.db.prepare("UPDATE automation_jobs SET state='REVIEW',reason=?,updated_at=? WHERE event_id=?").run(code,c.authority.now(),event.id);
      if(collectionStops.has(code))c.stop();
      c.store.audit('AUTO_REPLY_STOPPED',event.id);
    }finally{c.modelPending.delete(event.id);c.updated();}
}
