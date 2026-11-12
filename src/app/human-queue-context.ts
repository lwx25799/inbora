import {digest,requireSafe,targetKey,type StoredEvent} from '../core/contracts.js';
import type {EventStore} from '../storage/store.js';
import type {WorkbenchAuthority} from './authority.js';
import {randomUUID} from 'node:crypto';
import {readCommentThreadContext} from '../storage/comment-thread-context.js';

export interface HumanQueueContext {contextVersion:string;stableDigest:string;original:boolean;turns:string[];operatorId:string;prefixDigest:string}
function prefix(store:EventStore,eventId:string,context:Pick<HumanQueueContext,'original'|'turns'|'operatorId'>):string{
  const original=context.original?store.db.prepare(`SELECT c.command_id,c.event_id,c.operator_id,i.input_digest,
    json_extract(c.params,'$.text') AS text,json_extract(c.params,'$.draftId') AS draftId,json_extract(c.params,'$.draftVersion') AS version
    FROM manual_send_commands c JOIN manual_send_inputs i ON i.command_id=c.command_id WHERE c.event_id=? AND c.operator_id=? ORDER BY c.rowid`)
    .all(eventId,context.operatorId):[];
  const turns=context.turns.map(id=>store.db.prepare('SELECT command_id,event_id,operator_id,input_digest,text,version FROM human_reply_turns WHERE command_id=?').get(id));
  return digest([original,turns]);
}
function stable(store:EventStore,event:StoredEvent,context:Pick<HumanQueueContext,'original'|'turns'>):string{
  const key=targetKey(event.payload),incoming=store.db.prepare('SELECT id,binding,payload FROM inbound_events WHERE account_id=? AND channel=? AND target_key=? ORDER BY rowid')
    .all(event.payload.accountId,event.payload.channel,key);
  const collisions=store.db.prepare('SELECT c.* FROM source_collisions c JOIN inbound_events e ON e.id=c.event_id WHERE e.target_key=? ORDER BY c.rowid').all(key);
  const outgoing=store.db.prepare(`SELECT i.event_id,i.id,d.text,r.id AS receipt_id,r.result,r.verified_at FROM send_intents i
    JOIN reply_drafts d ON d.id=i.draft_id JOIN delivery_receipts r ON r.send_intent_id=i.id WHERE i.target_key=? AND r.result='CONFIRMED' ORDER BY r.rowid`)
    .all(key) as {event_id:string}[];
  const turns=store.db.prepare("SELECT command_id,event_id,text,version,status,verified_at FROM human_reply_turns WHERE target_key=? AND status='CONFIRMED' ORDER BY rowid")
    .all(key) as {command_id:string}[];
  const retries=store.db.prepare(`SELECT a.* FROM audit_events a JOIN inbound_events e ON e.id=json_extract(a.detail_redacted,'$.eventId')
    WHERE e.target_key=? AND a.event_type='MANUAL_RETRY_INTENT' ORDER BY a.rowid`).all(key);
  const thread=event.payload.kind==='REPLY'?readCommentThreadContext(store,event.payload).items.filter(item=>item.direction==='INCOMING'||
    !(context.original&&item.eventId===event.id&&item.id.startsWith('out:')||context.turns.some(id=>item.id==='followup:'+id))):null;
  return digest([incoming,collisions,thread,outgoing.filter(row=>!context.original||row.event_id!==event.id),
    turns.filter(row=>!context.turns.includes(row.command_id)),retries]);
}
export function captureHumanQueueContext(store:EventStore,authority:WorkbenchAuthority,event:StoredEvent,operatorId:string):HumanQueueContext{
  const original=!!store.db.prepare(`SELECT c.command_id FROM manual_send_commands c JOIN manual_send_inputs i ON i.command_id=c.command_id
    WHERE c.event_id=? AND c.operator_id=? AND c.status<>'FAILED_BEFORE_CLICK' LIMIT 1`).get(event.id,operatorId);
  const turns=(store.db.prepare('SELECT command_id FROM human_reply_turns WHERE event_id=? AND operator_id=? ORDER BY rowid').all(event.id,operatorId) as {command_id:string}[]).map(row=>row.command_id);
  const context={contextVersion:authority.contextVersion(event),stableDigest:'',original,turns,operatorId,prefixDigest:''};
  context.stableDigest=stable(store,event,context);context.prefixDigest=prefix(store,event.id,context);return context;
}
export function stableHumanQueueContext(store:EventStore,event:StoredEvent,context:HumanQueueContext):boolean{
  if(context.original&&!store.db.prepare(`SELECT c.command_id FROM manual_send_commands c JOIN manual_send_inputs i ON i.command_id=c.command_id
    WHERE c.event_id=? AND c.operator_id=? LIMIT 1`).get(event.id,context.operatorId))return false;
  for(const id of context.turns)if(!store.db.prepare('SELECT command_id FROM human_reply_turns WHERE command_id=? AND event_id=? AND operator_id=?')
    .get(id,event.id,context.operatorId))return false;
  return prefix(store,event.id,context)===context.prefixDigest&&stable(store,event,context)===context.stableDigest;
}
export function acceptHumanQueueContext(store:EventStore,authority:WorkbenchAuthority,event:StoredEvent,operatorId:string,inputVersion:string):HumanQueueContext{
  if(authority.contextVersion(event)!==inputVersion){
    const rows=store.db.prepare("SELECT detail_redacted FROM audit_events WHERE event_type='HUMAN_QUEUE_CONTEXT' ORDER BY rowid DESC LIMIT 100")
      .all() as {detail_redacted:string}[];
    requireSafe(rows.some(row=>{const saved=JSON.parse(row.detail_redacted) as HumanQueueContext&{eventId:string};
      return saved.eventId===event.id&&saved.operatorId===operatorId&&saved.contextVersion===inputVersion&&stableHumanQueueContext(store,event,saved);}),
    'CONTEXT_VERSION_CONFLICT');
  }
  return captureHumanQueueContext(store,authority,event,operatorId);
}
export function recordHumanQueueContext(store:EventStore,id:string,eventId:string,context:HumanQueueContext):void{
  store.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?)').run(randomUUID(),new Date().toISOString(),'HUMAN_QUEUE_CONTEXT',id,JSON.stringify({...context,eventId}));
}
export function humanQueueFrozen(store:EventStore,event:StoredEvent,operatorId:string|null):boolean{
  if(!store.sendFrozen(event.id))return false;if(!operatorId)return true;
  if(store.db.prepare(`SELECT c.id FROM source_collisions c JOIN inbound_events e ON e.id=c.event_id WHERE e.target_key=? LIMIT 1`).get(targetKey(event.payload)))return true;
  const original=store.db.prepare(`SELECT i.event_id,m.operator_id,x.command_id,(SELECT r.proof_ref FROM delivery_receipts r
    WHERE r.send_intent_id=i.id ORDER BY r.rowid DESC LIMIT 1) AS proof_ref FROM send_intents i LEFT JOIN manual_send_commands m ON m.intent_id=i.id
    LEFT JOIN manual_send_inputs x ON x.command_id=m.command_id WHERE i.target_key=? AND i.status IN ('INTENT_RECORDED','UNCERTAIN')`)
    .all(targetKey(event.payload)) as {event_id:string;operator_id:string|null;command_id:string|null;proof_ref:string|null}[];
  const turns=store.db.prepare("SELECT event_id,operator_id,command_id,proof_ref FROM human_reply_turns WHERE target_key=? AND status IN ('INTENT_RECORDED','UNCERTAIN')")
    .all(targetKey(event.payload)) as typeof original;
  const unsafe=new Set(['NATIVE_REPLY_ACCOUNT_CHANGED','NATIVE_REPLY_CONVERSATION_CHANGED','NATIVE_REPLY_ORIGINAL_CHANGED','NATIVE_REPLY_DOM_CHANGED',
    'NATIVE_REPLY_PAGE_BLOCKED','NATIVE_REPLY_ACK_REVOKED','COMMENT_REPLY_ACCOUNT_CHANGED','COMMENT_REPLY_CONVERSATION_CHANGED',
    'COMMENT_REPLY_ORIGINAL_CHANGED','COMMENT_REPLY_DOM_CHANGED','COMMENT_REPLY_PAGE_BLOCKED','COMMENT_REPLY_ACK_REVOKED',
    'OBSERVATION_ROW_CHANGED','OBSERVATION_ROW_IDENTITY_CONFLICT','OBSERVATION_ACCOUNT_CHANGED','OBSERVATION_PAGE_BLOCKED',
    'OBSERVATION_UNEXPECTED_ORIGIN','OBSERVATION_SECURITY_TITLE','OBSERVATION_SECURITY_COMPONENT',
    'OBSERVATION_CONVERSATION_NOT_FOUND','OBSERVATION_CONVERSATION_NOT_UNIQUE']);
  return [...original,...turns].some(row=>row.event_id!==event.id||row.operator_id!==operatorId||!row.command_id||
    unsafe.has(/^POST_INTENT_FAILURE:(?:DISPATCH|READBACK):([A-Z_]+)$/u.exec(row.proof_ref??'')?.[1]??''));
}
export function requireDistinctHumanText(store:EventStore,eventId:string,text:string,id=''):void{
  const original=store.db.prepare(`SELECT c.command_id,json_extract(c.params,'$.text') AS text FROM manual_send_commands c
    WHERE c.event_id=? AND c.status IN ('PREPARING','QUEUED','PREFLIGHT','SENDING','UNCERTAIN')`).all(eventId) as {command_id:string;text:string}[];
  const turns=store.db.prepare("SELECT command_id,text FROM human_reply_turns WHERE event_id=? AND status IN ('PREPARING','APPROVED','INTENT_RECORDED','UNCERTAIN')")
    .all(eventId) as typeof original;
  requireSafe(![...original,...turns].some(row=>row.command_id!==id&&row.text===text),'HUMAN_REPLY_DUPLICATE_UNRESOLVED');
}
