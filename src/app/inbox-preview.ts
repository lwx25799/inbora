import {digest,eventBinding,eventSchema,targetKey,type InboundEvent,type StoredEvent} from '../core/contracts.js';
import type {EventStore} from '../storage/store.js';

export interface InboxPreview {
  id:string;eventId:string;text:string;occurredAt:string|null;direction:'INCOMING'|'OUTGOING';payload:InboundEvent|null;
}
interface Row {
  id:string;event_id:string;account_id:string;scope_key:string;source:string;text:string;occurred_at:string|null;
  payload:string|null;binding:string|null;own_id:string|null;text_digest:string|null;
}
export const inboxPreviewKey=(event:StoredEvent):string=>JSON.stringify([event.payload.accountId,event.payload.conversationId?targetKey(event.payload):event.id]);

/** One batch over the same sources as the detail timeline; private media is loaded only for the displayed page. */
export function readInboxPreviews(store:EventStore,tables:ReadonlySet<string>,own:ReadonlyMap<string,string>):Map<string,InboxPreview> {
  const hasChat=tables.has('chat_messages'),hasLinks=tables.has('chat_delivery_links');
  const nativeId=(id:string)=>`COALESCE(${hasLinks?`(SELECT native_id_digest FROM chat_delivery_links WHERE intent_id=${id}),`:''}
    (SELECT json_extract(a.detail_redacted,'$.nativeIdDigest') FROM audit_events a WHERE a.entity_id=${id}
      AND a.event_type IN ('SUBMISSION_PROOF','CLOCK_SKEW_PROOF') ORDER BY a.rowid DESC LIMIT 1))`;
  const notObserved=(boundary:string)=>hasChat?`AND NOT EXISTS(SELECT 1 FROM chat_messages m WHERE m.account_id=e.account_id AND
    m.conversation_id=json_extract(e.payload,'$.conversationId') AND m.conflicted=0 AND
    (m.native_id_digest=${nativeId('i.id')} OR (${nativeId('i.id')} IS NULL AND json_extract(m.payload,'$.text')=d.text AND
      abs(julianday(json_extract(m.payload,'$.occurredAt'))-julianday(${boundary}))*86400000<2000)))`:'';
  const scope=`CASE WHEN json_extract(e.payload,'$.conversationId') IS NULL THEN e.id ELSE e.target_key END`;
  const verified=tables.has('verification_results')?`COALESCE((SELECT verified FROM verification_results v WHERE v.intent_id=i.id ORDER BY v.rowid DESC LIMIT 1),
    CASE i.status WHEN 'CONFIRMED' THEN 1 ELSE 0 END)=1`:"i.status='CONFIRMED'";
  const parts=[`SELECT 'in:'||e.id id,e.id event_id,e.account_id,${scope} scope_key,'in' source,
    json_extract(e.payload,'$.text') text,json_extract(e.payload,'$.occurredAt') occurred_at,e.payload,e.binding,NULL own_id,NULL text_digest
    FROM inbound_events e WHERE e.channel='DIRECT_MESSAGE'`,
  `SELECT 'out:'||i.id,e.id,e.account_id,${scope},'out',d.text,i.attempt_started_at,NULL,NULL,NULL,i.text_digest
    FROM send_intents i JOIN inbound_events e ON e.id=i.event_id JOIN reply_drafts d ON d.id=i.draft_id
    WHERE e.channel='DIRECT_MESSAGE' AND ${verified} ${notObserved('i.attempt_started_at')}`,
  `SELECT 'retry:'||i.id,e.id,e.account_id,${scope},'retry',d.text,i.time,NULL,NULL,NULL,json_extract(i.detail_redacted,'$.textDigest')
    FROM audit_events i JOIN inbound_events e ON e.id=json_extract(i.detail_redacted,'$.eventId')
    JOIN reply_drafts d ON d.id=json_extract(i.detail_redacted,'$.draftId')
    WHERE e.channel='DIRECT_MESSAGE' AND i.event_type='MANUAL_RETRY_INTENT' AND
      (SELECT json_extract(r.detail_redacted,'$.result') FROM audit_events r WHERE r.entity_id=i.id AND r.event_type='MANUAL_RETRY_RECEIPT'
        ORDER BY r.rowid DESC LIMIT 1)='CONFIRMED' ${notObserved('i.time')}`];
  if(hasChat)parts.push(`SELECT 'observed:'||m.id,m.id,m.account_id,'dm:'||m.conversation_id,'observed',
    json_extract(m.payload,'$.text'),json_extract(m.payload,'$.occurredAt'),m.payload,m.binding,m.own_id,NULL
    FROM chat_messages m JOIN accounts a ON a.id=m.account_id AND a.own_id=m.own_id WHERE m.conflicted=0`);
  if(tables.has('human_reply_turns'))parts.push(`SELECT 'followup:'||t.command_id,t.event_id,e.account_id,${scope},'followup',
    t.text,t.attempt_started_at,NULL,NULL,NULL,NULL FROM human_reply_turns t JOIN inbound_events e ON e.id=t.event_id
    WHERE e.channel='DIRECT_MESSAGE' AND t.status='CONFIRMED' ${hasChat?`AND NOT EXISTS(SELECT 1 FROM chat_messages m
      WHERE m.account_id=e.account_id AND m.conversation_id=json_extract(e.payload,'$.conversationId')
      AND m.conflicted=0 AND m.native_id_digest=t.native_id_digest)`:''}`);
  const rows=store.db.prepare(`WITH candidates AS (${parts.join(' UNION ALL ')}),ranked AS (
    SELECT *,ROW_NUMBER() OVER(PARTITION BY source,account_id,scope_key ORDER BY
      COALESCE(CAST((julianday(occurred_at)-2440587.5)*86400000 AS INTEGER),0) DESC,id DESC) position FROM candidates)
    SELECT * FROM ranked WHERE position<=31`).all() as Row[];
  const latest=new Map<string,InboxPreview>();
  for(const row of rows){
    if(row.text_digest!==null&&digest(row.text)!==row.text_digest)continue;
    let payload:InboundEvent|null=null;
    if(row.payload!==null){
      const parsed=eventSchema.safeParse(JSON.parse(row.payload));if(!parsed.success)continue;payload=parsed.data;
      if(row.source==='observed'&&(payload.channel!=='DIRECT_MESSAGE'||payload.direction!=='OUTGOING'||payload.kind!=='DM'||
        payload.accountId!==row.account_id||payload.actorId!==own.get(row.account_id)||row.own_id!==payload.actorId||
        targetKey(payload)!==row.scope_key||eventBinding(payload)!==row.binding))continue;
    }
    const key=JSON.stringify([row.account_id,row.scope_key]),prior=latest.get(key),at=Date.parse(row.occurred_at??'')||0;
    if(prior){const previousAt=Date.parse(prior.occurredAt??'')||0;
      if(at<previousAt||at===previousAt&&row.id.localeCompare(prior.id)<=0)continue;}
    latest.set(key,{id:row.id,eventId:row.event_id,text:row.text,occurredAt:row.occurred_at,
      direction:row.source==='in'?'INCOMING':'OUTGOING',payload});
  }
  return latest;
}
