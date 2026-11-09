import {randomUUID} from 'node:crypto';
import {digest,requireSafe} from '../core/contracts.js';
import type {EventStore} from '../storage/store.js';
import type {AutomationStore} from '../storage/automation-store.js';
import type {WorkbenchAuthority} from './authority.js';
import type {HumanReplyWorkflow} from './human-reply-workflow.js';
import type {Grant,ReplyPolicy} from './automation-contracts.js';
import {sendParamsSchema,type SendParams} from './contracts.js';
import {replyPolicySchema} from './automation-contracts.js';

/** Requalify one generated policy draft that never acquired an intent. No model call or submit replay is available here. */
export async function recoverPolicyDraft(store:EventStore,authority:WorkbenchAuthority,auto:AutomationStore,
  workflow:HumanReplyWorkflow,grant:Grant<ReplyPolicy>):Promise<boolean>{
  if(!auto.allowance(grant.version,'SEND'))return false;
  const jobs=store.db.prepare(`SELECT j.event_id,j.context_version,j.draft_version,j.command_id,j.grant_version,j.reason,g.scope_json FROM automation_jobs j
    JOIN automation_grants g ON g.version=j.grant_version AND g.kind='AUTO_REPLY'
    JOIN reply_drafts d ON d.event_id=j.event_id JOIN draft_revisions r ON r.draft_id=d.id AND r.version=d.version
    WHERE r.origin='AUTO_POLICY' AND d.version=j.draft_version
    AND ((j.state='FAILED_BEFORE_CLICK' AND j.reason IN ('CLIENT_CLOSING','TARGET_CHANGED_REAPPROVE','NATIVE_REPLY_EXISTING_DRAFT','COMMENT_REPLY_ROOT_NOT_UNIQUE')) OR (j.state='REVIEW' AND j.reason='RESTART_NO_REPLAY'))
    AND NOT EXISTS(SELECT 1 FROM send_intents i WHERE i.event_id=j.event_id)
    AND NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.event_type='AUTO_COMMENT_ROOT_CLOSE_RESUMED' AND a.entity_id=d.id)
    AND (NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.event_type='AUTO_COMMENT_ROOT_REQUALIFIED' AND a.entity_id=d.id)
      OR (j.state='FAILED_BEFORE_CLICK' AND j.reason='CLIENT_CLOSING'))
    AND (j.reason='COMMENT_REPLY_ROOT_NOT_UNIQUE' OR (j.reason='CLIENT_CLOSING' AND EXISTS
      (SELECT 1 FROM audit_events a WHERE a.event_type='AUTO_COMMENT_ROOT_REQUALIFIED' AND a.entity_id=d.id))
      OR (SELECT count(*) FROM audit_events a WHERE a.event_type='AUTO_DRAFT_RESUMED' AND a.entity_id=j.event_id)<2
      OR (j.state='FAILED_BEFORE_CLICK' AND j.reason='TARGET_CHANGED_REAPPROVE'
        AND NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.event_type='AUTO_VIEWPORT_REQUALIFIED' AND a.entity_id=d.id)))
    ORDER BY j.created_at`).all() as {event_id:string;context_version:string;draft_version:number;command_id:string;grant_version:number;reason:string;scope_json:string}[];
  for(const job of jobs){
    const previous=replyPolicySchema.safeParse(JSON.parse(job.scope_json));if(!previous.success)continue;
    const rules=({modelLimit:_model,sendLimit:_send,expiresAt:_expiry,replyToNestedComments,...scope}:ReplyPolicy)=>({
      ...scope,...(store.event(job.event_id).payload.kind==='REPLY'?{replyToNestedComments:replyToNestedComments!==false}:{})});
    if(digest(rules(previous.data))!==digest(rules(grant.scope)))continue;
    const event=store.event(job.event_id),draft=authority.draftFor(event.id);
    if(!draft||!auto.policyMatches(grant,event,'DRAFT')||authority.contextVersion(event)!==job.context_version)continue;
    const marker=store.db.prepare("SELECT id FROM audit_events WHERE event_type='AUTO_COMMENT_ROOT_REQUALIFIED' AND entity_id=?").get(draft.id);
    const commentRoot=job.reason==='COMMENT_REPLY_ROOT_NOT_UNIQUE',rootClose=!!marker&&job.reason==='CLIENT_CLOSING';
    let priorCommand:{params:string;params_digest:string}|undefined;
    if(commentRoot||rootClose){
      if(event.payload.channel!=='COMMENT_NOTIFICATION')continue;
      if(rootClose&&!store.db.prepare(`SELECT id FROM audit_events WHERE event_type='AUTO_COMMENT_ROOT_REQUALIFIED' AND entity_id=?
        AND json_extract(detail_redacted,'$.version')=? AND json_extract(detail_redacted,'$.contract')=1`).get(draft.id,draft.version))continue;
      const failed=store.db.prepare(`SELECT c.params,c.params_digest FROM manual_send_commands c JOIN policy_commands p ON p.command_id=c.command_id
        WHERE c.command_id=? AND c.event_id=? AND c.status='FAILED_BEFORE_CLICK' AND c.reason=?
        AND c.intent_id IS NULL AND p.grant_version=?`).get(job.command_id,event.id,job.reason,job.grant_version) as {params:string;params_digest:string}|undefined;
      if(!failed||!store.db.prepare("SELECT job_key FROM grant_reservations WHERE grant_version=? AND kind='MODEL' AND job_key=?").get(job.grant_version,event.id)||
        store.db.prepare("SELECT job_key FROM grant_reservations WHERE kind='SEND' AND job_key=?").get(event.id))continue;
      let raw:unknown,prior:SendParams;try{raw=JSON.parse(failed.params);prior=sendParamsSchema.parse(raw);}catch{continue;}
      if(digest(raw)!==failed.params_digest||prior.eventId!==event.id||prior.draftId!==draft.id||prior.draftVersion!==draft.version||
        prior.text!==draft.text||prior.contextVersion!==job.context_version)continue;
      priorCommand=failed;
    }
    const attempts=(store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='AUTO_DRAFT_RESUMED' AND entity_id=?").get(event.id) as {n:number}).n;
    if(attempts>=2&&!commentRoot&&!rootClose&&event.payload.channel!=='DIRECT_MESSAGE')continue;
    const commandId=randomUUID(),token=authority.issueSession();
    try{
      store.db.transaction(()=>{
        requireSafe(auto.policyMatches(grant,store.event(event.id),'DRAFT'),'POLICY_NO_LONGER_AUTHORIZED');
        const claimed=store.db.prepare(`SELECT id FROM audit_events WHERE event_type='AUTO_COMMENT_ROOT_REQUALIFIED' AND entity_id=?
          AND json_extract(detail_redacted,'$.version')=? AND json_extract(detail_redacted,'$.contract')=1`).get(draft.id,draft.version);
        const currentMarker=store.db.prepare("SELECT id FROM audit_events WHERE event_type='AUTO_COMMENT_ROOT_REQUALIFIED' AND entity_id=?").get(draft.id);
        requireSafe(rootClose?claimed:!currentMarker,'COMMENT_ROOT_REQUALIFICATION_USED');
        requireSafe(!store.db.prepare("SELECT id FROM audit_events WHERE event_type='AUTO_COMMENT_ROOT_CLOSE_RESUMED' AND entity_id=?").get(draft.id),'COMMENT_ROOT_CLOSE_RESUME_USED');
        if(rootClose){
          requireSafe(store.db.prepare(`SELECT c.command_id FROM automation_jobs j JOIN manual_send_commands c ON c.command_id=j.command_id
            JOIN policy_commands p ON p.command_id=c.command_id WHERE j.event_id=? AND j.command_id=? AND j.grant_version=?
            AND j.state='FAILED_BEFORE_CLICK' AND j.reason='CLIENT_CLOSING' AND j.draft_version=? AND j.context_version=?
            AND c.event_id=j.event_id AND c.status='FAILED_BEFORE_CLICK' AND c.reason='CLIENT_CLOSING' AND c.intent_id IS NULL
            AND p.grant_version=j.grant_version AND c.params=? AND c.params_digest=?`).get(event.id,job.command_id,job.grant_version,
              draft.version,job.context_version,priorCommand!.params,priorCommand!.params_digest),'COMMENT_ROOT_CLOSE_COMMAND_CHANGED');
          const current=authority.draftFor(event.id);
          requireSafe(current?.id===draft.id&&current.version===draft.version&&current.text===draft.text&&current.origin==='AUTO_POLICY'&&
            authority.contextVersion(store.event(event.id))===job.context_version&&!store.db.prepare("SELECT job_key FROM grant_reservations WHERE kind='SEND' AND job_key=?").get(event.id),
            'COMMENT_ROOT_CLOSE_COMMAND_CHANGED');
        }
        const generation=authority.ownership(event).generation;
        if(draft.status==='APPROVED')store.invalidateApproval(draft.id);
        const params:SendParams={eventId:event.id,draftId:draft.id,draftVersion:draft.version,text:draft.text,
          generation,selectionId:randomUUID(),contextVersion:job.context_version};
        store.db.prepare("INSERT INTO manual_send_commands VALUES(?,?,?,?,?,'PREPARING',NULL,NULL,?)")
          .run(commandId,event.id,authority.operator(token).id,digest(params),JSON.stringify(params),authority.now());
        store.db.prepare('INSERT INTO policy_commands VALUES(?,?,?)').run(commandId,grant.version,generation);
        store.db.prepare("UPDATE automation_jobs SET grant_version=?,state='PREPARING',reason=NULL,command_id=?,ownership_generation=?,updated_at=? WHERE event_id=?")
          .run(grant.version,commandId,generation,authority.now(),event.id);
        // Corrective contracts consume their own durable qualification; historical attempts stay intact.
        if(rootClose)store.audit('AUTO_COMMENT_ROOT_CLOSE_RESUMED',draft.id,{version:draft.version,contract:1});
        else if(commentRoot)store.audit('AUTO_COMMENT_ROOT_REQUALIFIED',draft.id,{version:draft.version,contract:1});
        else if(attempts>=2)store.audit('AUTO_VIEWPORT_REQUALIFIED',draft.id,{version:draft.version,contract:1});
        else store.audit('AUTO_DRAFT_RESUMED',event.id);
      }).immediate();
      await workflow.prepare(token,commandId);
      const result=authority.command(commandId);
      store.db.prepare('UPDATE automation_jobs SET state=?,reason=?,updated_at=? WHERE event_id=?')
        .run(result.status,result.reason,authority.now(),event.id);
      return true;
    }finally{authority.revoke(token);}
  }
  return false;
}
