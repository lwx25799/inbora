import {z} from 'zod';
import type {AutomationStore} from '../storage/automation-store.js';
import {MessagePreviewStore} from '../storage/message-previews.js';
import {MessageShareStore} from '../storage/message-shares.js';

const retrySchema=z.object({eventId:z.uuid(),conversationId:z.string().min(1),attempts:z.number().int().min(0).max(2),lastAttempt:z.number().int().nonnegative()});
export const previewRetryFields={previewRetries:z.array(retrySchema).max(100).default([]),previewRetryNeedsNormal:z.boolean().default(false)};
const fieldsSchema=z.object(previewRetryFields);
const interval=120_000;

function load(data:AutomationStore){
  const row=data.store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='dm'").get() as {cursor_json:string};
  const cursor=JSON.parse(row.cursor_json) as Record<string,unknown>;return {...cursor,...fieldsSchema.parse(cursor)};
}
function save(data:AutomationStore,cursor:ReturnType<typeof load>):void{
  data.store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='dm'").run(JSON.stringify(cursor));
}

/** One bounded exact-event preview retry, sharing the normal actor and yielding its next turn to collection. */
export function preparePreviewRetry(data:AutomationStore,root:string,canSchedule:boolean,prioritize:(conversationId:string,eventId:string)=>boolean):boolean {
  const cursor=load(data),state=data.state(),ownId=state.collection?.ownId;
  if(state.emergencyStopped||!state.collection?.inbox||!ownId)return cursor.previewRetryNeedsNormal;
  data.requireAccount(ownId);
  const prior=new Map(cursor.previewRetries.map(item=>[item.eventId,item])),previews=new MessagePreviewStore(root),shares=new MessageShareStore(root);
  const rows=data.store.db.prepare(`SELECT id FROM inbound_events WHERE account_id='account_001' AND channel='DIRECT_MESSAGE' AND status<>'BASELINE'
    AND json_extract(payload,'$.observationIssue')='DM_CONTENT_UNVERIFIED' AND json_extract(payload,'$.contentType') IN ('IMAGE','MIXED')
    ORDER BY rowid DESC LIMIT 100`).all() as {id:string}[];
  cursor.previewRetries=[];
  for(const row of rows){
    const event=data.store.event(row.id).payload,at=Date.parse(event.occurredAt??'');
    if(event.direction!=='INCOMING'||event.actorId===ownId||!event.actorId||!event.conversationId||!event.platformEventId||
      !/^[1-9]\d{0,63}$/u.test(event.platformEventId)||!Number.isFinite(at)||at<=state.startedAt||at>data.now()||shares.read(event,ownId)||
      previews.list(event,ownId).some(item=>item.state==='READY'))continue;
    const recorded=data.store.db.prepare(`SELECT count(*) AS attempts,COALESCE(max(json_extract(detail_redacted,'$.attemptedAt')),0) AS lastAttempt
      FROM audit_events WHERE event_type='MESSAGE_PREVIEW_RETRY' AND entity_id=?`).get(row.id) as {attempts:number;lastAttempt:number};
    if(recorded.attempts>=2)continue;
    const old=prior.get(row.id);cursor.previewRetries.push({eventId:row.id,conversationId:event.conversationId,
      attempts:recorded.attempts,lastAttempt:Math.max(recorded.lastAttempt,old?.lastAttempt??0)});
  }
  cursor.previewRetries.sort((a,b)=>a.lastAttempt-b.lastAttempt||a.eventId.localeCompare(b.eventId));
  if(canSchedule&&!cursor.previewRetryNeedsNormal)for(const retry of cursor.previewRetries){
    const latest=data.store.db.prepare(`SELECT COALESCE(max(json_extract(a.detail_redacted,'$.attemptedAt')),0) AS at FROM audit_events a
      JOIN inbound_events e ON e.id=a.entity_id WHERE a.event_type='MESSAGE_PREVIEW_RETRY' AND e.account_id='account_001' AND e.target_key=?`)
      .get('dm:'+retry.conversationId) as {at:number};
    if(latest.at&&data.now()-latest.at<interval||!prioritize(retry.conversationId,retry.eventId))continue;
    retry.attempts++;retry.lastAttempt=data.now();cursor.previewRetryNeedsNormal=true;
    data.store.db.transaction(()=>{data.store.audit('MESSAGE_PREVIEW_RETRY',retry.eventId,{attempt:retry.attempts,attemptedAt:retry.lastAttempt});save(data,cursor);}).immediate();
    return false;
  }
  save(data,cursor);return cursor.previewRetryNeedsNormal;
}

export function finishPreviewNormalTurn(data:AutomationStore):void {
  const cursor=load(data);if(!cursor.previewRetryNeedsNormal)return;
  cursor.previewRetryNeedsNormal=false;save(data,cursor);
}
