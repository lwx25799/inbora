import {randomUUID} from 'node:crypto';
import {digest,requireSafe} from '../core/contracts.js';
import type {EventStore} from '../storage/store.js';
import type {AutomationStore} from '../storage/automation-store.js';
import type {WorkbenchAuthority} from './authority.js';
import type {HumanReplyWorkflow} from './human-reply-workflow.js';
import type {Grant,ReplyPolicy} from './automation-contracts.js';
import type {SendParams} from './contracts.js';
import {replyPolicySchema} from './automation-contracts.js';

/** Requalify one generated policy draft that never acquired an intent. No model call or submit replay is available here. */
export async function recoverPolicyDraft(store:EventStore,authority:WorkbenchAuthority,auto:AutomationStore,
  workflow:HumanReplyWorkflow,grant:Grant<ReplyPolicy>):Promise<boolean>{
  if(!auto.allowance(grant.version,'SEND'))return false;
  const jobs=store.db.prepare(`SELECT j.event_id,j.context_version,j.draft_version,g.scope_json FROM automation_jobs j
    JOIN automation_grants g ON g.version=j.grant_version AND g.kind='AUTO_REPLY'
    JOIN reply_drafts d ON d.event_id=j.event_id JOIN draft_revisions r ON r.draft_id=d.id AND r.version=d.version
    WHERE r.origin='AUTO_POLICY' AND d.version=j.draft_version
    AND ((j.state='FAILED_BEFORE_CLICK' AND j.reason IN ('CLIENT_CLOSING','TARGET_CHANGED_REAPPROVE','NATIVE_REPLY_EXISTING_DRAFT')) OR (j.state='REVIEW' AND j.reason='RESTART_NO_REPLAY'))
    AND NOT EXISTS(SELECT 1 FROM send_intents i WHERE i.event_id=j.event_id)
    AND ((SELECT count(*) FROM audit_events a WHERE a.event_type='AUTO_DRAFT_RESUMED' AND a.entity_id=j.event_id)<2
      OR (j.state='FAILED_BEFORE_CLICK' AND j.reason='TARGET_CHANGED_REAPPROVE'
        AND NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.event_type='AUTO_VIEWPORT_REQUALIFIED' AND a.entity_id=d.id)))
    ORDER BY j.created_at`).all() as {event_id:string;context_version:string;draft_version:number;scope_json:string}[];
  for(const job of jobs){
    const previous=replyPolicySchema.safeParse(JSON.parse(job.scope_json));if(!previous.success)continue;
    const rules=({modelLimit:_model,sendLimit:_send,expiresAt:_expiry,replyToNestedComments,...scope}:ReplyPolicy)=>({
      ...scope,...(store.event(job.event_id).payload.kind==='REPLY'?{replyToNestedComments:replyToNestedComments!==false}:{})});
    if(digest(rules(previous.data))!==digest(rules(grant.scope)))continue;
    const event=store.event(job.event_id),draft=authority.draftFor(event.id);
    if(!draft||!auto.policyMatches(grant,event,'DRAFT')||authority.contextVersion(event)!==job.context_version)continue;
    const attempts=(store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='AUTO_DRAFT_RESUMED' AND entity_id=?").get(event.id) as {n:number}).n;
    if(attempts>=2&&event.payload.channel!=='DIRECT_MESSAGE')continue;
    const commandId=randomUUID(),token=authority.issueSession();
    try{
      store.db.transaction(()=>{
        requireSafe(auto.policyMatches(grant,store.event(event.id),'DRAFT'),'POLICY_NO_LONGER_AUTHORIZED');
        const generation=authority.ownership(event).generation;
        if(draft.status==='APPROVED')store.invalidateApproval(draft.id);
        const params:SendParams={eventId:event.id,draftId:draft.id,draftVersion:draft.version,text:draft.text,
          generation,selectionId:randomUUID(),contextVersion:job.context_version};
        store.db.prepare("INSERT INTO manual_send_commands VALUES(?,?,?,?,?,'PREPARING',NULL,NULL,?)")
          .run(commandId,event.id,authority.operator(token).id,digest(params),JSON.stringify(params),authority.now());
        store.db.prepare('INSERT INTO policy_commands VALUES(?,?,?)').run(commandId,grant.version,generation);
        store.db.prepare("UPDATE automation_jobs SET grant_version=?,state='PREPARING',reason=NULL,command_id=?,ownership_generation=?,updated_at=? WHERE event_id=?")
          .run(grant.version,commandId,generation,authority.now(),event.id);
        // The corrected, page-owned viewport contract gets one fresh qualification; historical attempts stay intact.
        if(attempts>=2)store.audit('AUTO_VIEWPORT_REQUALIFIED',draft.id,{version:draft.version,contract:1});
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
