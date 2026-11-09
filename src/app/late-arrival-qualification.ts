import {digest,eventBinding,isEligible,isStrong,targetKey,type InboundEvent} from '../core/contracts.js';
import type {AutomationStore} from '../storage/automation-store.js';
import type {CollectionSource} from './collection-scheduler.js';

interface LateArrivalInput {source:CollectionSource;scope:string;ownId:string;workIds:string[];events:InboundEvent[];evidence:string;signal:AbortSignal}

/** Collector-only status recovery. A second read is evidence, never model or send authorization. */
export function qualifyLateArrivals(data:AutomationStore,input:LateArrivalInput):void {
  const {store}=data,state=data.state(),settings=state.collection,now=data.now();
  if(input.signal.aborted||state.emergencyStopped||!settings||settings.ownId!==input.ownId||
    !(input.source==='dm'?settings.inbox:settings.comments))return;
  const own=store.db.prepare("SELECT own_id FROM accounts WHERE id='account_001'").get() as {own_id:string}|undefined;
  if(own?.own_id!==input.ownId)return;
  const channel=input.source==='dm'?'DIRECT_MESSAGE':'COMMENT_NOTIFICATION';
  const observation=store.db.prepare('SELECT rowid,observed_at FROM observations WHERE channel=? AND scope=? AND evidence_ref=? ORDER BY rowid DESC LIMIT 1')
    .get(channel,input.scope,input.evidence) as {rowid:number;observed_at:string}|undefined;
  const cursor=store.db.prepare('SELECT cursor_data FROM cursors WHERE channel=? AND scope=?').get(channel,input.scope) as {cursor_data:string}|undefined;
  if(!observation||!cursor)return;
  const {baselineTime}=JSON.parse(cursor.cursor_data) as {baselineTime:number};
  const observedAt=Date.parse(observation.observed_at);if(!Number.isFinite(baselineTime)||!Number.isFinite(observedAt)||observedAt>now)return;
  store.db.transaction(()=>{
    for(const fresh of input.events){
      if(input.signal.aborted)return;
      if(fresh.channel!==channel||fresh.accountId!=='account_001'||!isEligible(fresh,input.ownId)||!isStrong(fresh))continue;
      const at=Date.parse(fresh.occurredAt??'');
      if(!Number.isFinite(at)||at<=state.startedAt||at<=baselineTime||at>now)continue;
      const row=store.db.prepare("SELECT id,binding FROM inbound_events WHERE account_id=? AND channel=? AND source_key=? AND scope=? AND status='MANUAL_REVIEW'")
        .get(fresh.accountId,channel,fresh.platformEventId,input.scope) as {id:string;binding:string}|undefined;
      if(!row||row.binding!==eventBinding(fresh))continue;
      const target=store.db.prepare('SELECT own_id,uid,sec_uid,conversation_id FROM collection_targets WHERE target_key=?').get(targetKey(fresh)) as {
        own_id:string;uid:string;sec_uid:string;conversation_id:string|null}|undefined;
      if(!target||target.own_id!==input.ownId||target.uid!==fresh.actorId||!target.sec_uid||target.conversation_id!==fresh.conversationId)continue;
      if(channel==='COMMENT_NOTIFICATION'){
        const work=store.db.prepare("SELECT id FROM discovered_works WHERE id=? AND own_id=? AND state='INCLUDED'").get(fresh.videoId,input.ownId);
        if(input.scope!=='work:'+fresh.videoId||!input.workIds.includes(fresh.videoId!)&&!work)continue;
      }else if(input.scope!==fresh.conversationId||!store.db.prepare('SELECT id FROM discovered_conversations WHERE id=? AND own_id=? AND sec_uid=?')
        .get(fresh.conversationId,input.ownId,target.sec_uid))continue;
      if(['source_collisions','send_intents','reply_drafts','automation_jobs'].some(table=>store.db.prepare(`SELECT 1 FROM ${table} WHERE event_id=? LIMIT 1`).get(row.id)))continue;
      const entity=digest([row.id,row.binding,input.scope]),prior=store.db.prepare("SELECT detail_redacted FROM audit_events WHERE event_type='LATE_ARRIVAL_OBSERVED' AND entity_id=? ORDER BY rowid LIMIT 1")
        .get(entity) as {detail_redacted:string}|undefined;
      if(!prior){store.audit('LATE_ARRIVAL_OBSERVED',entity,{observation:observation.rowid});continue;}
      const firstId=(JSON.parse(prior.detail_redacted) as {observation?:number}).observation;
      const first=Number.isSafeInteger(firstId)?store.db.prepare('SELECT channel,scope,evidence_ref,observed_at FROM observations WHERE rowid=?').get(firstId) as {
        channel:string;scope:string;evidence_ref:string;observed_at:string}|undefined:undefined;
      if(!first||first.channel!==channel||first.scope!==input.scope||first.evidence_ref===input.evidence||observedAt-Date.parse(first.observed_at)<1000)continue;
      if(store.db.prepare("UPDATE inbound_events SET status='AWAITING_DRAFT' WHERE id=? AND binding=? AND status='MANUAL_REVIEW'").run(row.id,row.binding).changes)
        store.audit('LATE_ARRIVAL_QUALIFIED',entity,{firstObservation:firstId!,observation:observation.rowid});
    }
  }).immediate();
}
