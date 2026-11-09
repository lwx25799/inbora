import {digest,eventBinding,eventSchema,isStrong,requireSafe,targetKey,type InboundEvent,type StoredEvent} from '../core/contracts.js';
import type {EventStore} from './store.js';

export interface CommentThreadItem {
  id:string;eventId:string;direction:'INCOMING'|'OUTGOING';text:string;occurredAt:string|null;historical:boolean;
  origin:'OBSERVED'|'CONFIRMED';isRoot:boolean;payload:InboundEvent;verifiedForModel:boolean;
}
export interface CommentThreadContext {
  group:string;root:CommentThreadItem|null;rootVerified:boolean;rootMissing:boolean;rootAmbiguous:boolean;
  items:CommentThreadItem[];projectionRevision:string;localRecordsOnly:true;observedOwnHistoryComplete:false;
}
interface ThreadIdentity {accountId:string;workId:string;rootId:string}
interface Row {id:string;payload:string;binding:string;status:StoredEvent['status']}
const native=/^[1-9]\d{0,63}$/u;
function identity(event:InboundEvent):ThreadIdentity|null {
  if(event.channel!=='COMMENT_NOTIFICATION'||!event.videoId||!event.commentId||!native.test(event.commentId))return null;
  if(event.kind==='COMMENT'&&event.rootCommentId===undefined&&event.replyToCommentId===undefined)
    return {accountId:event.accountId,workId:event.videoId,rootId:event.commentId};
  if(event.kind==='REPLY'&&event.rootCommentId&&native.test(event.rootCommentId)&&event.rootCommentId!==event.commentId&&event.replyToCommentId===event.commentId)
    return {accountId:event.accountId,workId:event.videoId,rootId:event.rootCommentId};
  return null;
}
export function sameCommentThread(left:InboundEvent,right:InboundEvent):boolean {
  const a=identity(left),b=identity(right);
  return !!a&&!!b&&a.accountId===b.accountId&&a.workId===b.workId&&a.rootId===b.rootId;
}
function at(item:CommentThreadItem):number {const value=Date.parse(item.occurredAt??'');return Number.isFinite(value)?value:0;}
function chronological(a:CommentThreadItem,b:CommentThreadItem):number {return at(a)-at(b)||a.id.localeCompare(b.id);}
function present(store:EventStore,table:string):boolean {return !!store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);}

/** Reconstruct only locally recorded exact thread members. Neither tasks, send targets nor persistent state are changed. */
export function readCommentThreadContext(store:EventStore,event:InboundEvent):CommentThreadContext {
  const thread=identity(event),group=digest(thread??[event.accountId,event.channel,event.videoId,event.commentId,'UNVERIFIED']);
  const empty:CommentThreadContext={group,root:null,rootVerified:false,rootMissing:true,rootAmbiguous:false,items:[],projectionRevision:digest([group]),
    localRecordsOnly:true,observedOwnHistoryComplete:false};
  if(!thread)return empty;
  const rows=store.db.prepare(`SELECT id,payload,binding,status FROM inbound_events WHERE account_id=? AND channel='COMMENT_NOTIFICATION'
    AND json_extract(payload,'$.videoId')=? AND (json_extract(payload,'$.commentId')=? OR json_extract(payload,'$.rootCommentId')=?) ORDER BY rowid`)
    .all(thread.accountId,thread.workId,thread.rootId,thread.rootId) as Row[];
  const sources=new Map<string,StoredEvent>(),items:CommentThreadItem[]=[];
  for(const row of rows){
    let raw:unknown;try{raw=JSON.parse(row.payload);}catch{continue;}
    const parsed=eventSchema.safeParse(raw);if(!parsed.success||!sameCommentThread(parsed.data,event)||parsed.data.direction!=='INCOMING')continue;
    const payload=parsed.data,collision=!!store.db.prepare('SELECT id FROM source_collisions WHERE event_id=? LIMIT 1').get(row.id);
    const verified=isStrong(payload)&&!!payload.occurredAt&&Number.isFinite(Date.parse(payload.occurredAt))&&!collision&&row.binding===eventBinding(payload);
    sources.set(row.id,{id:row.id,payload,binding:row.binding,status:row.status});
    items.push({id:'in:'+row.id,eventId:row.id,direction:'INCOMING',text:payload.text,occurredAt:payload.occurredAt,
      historical:row.status==='BASELINE',origin:'OBSERVED',isRoot:payload.kind==='COMMENT'&&payload.commentId===thread.rootId,payload,verifiedForModel:verified});
  }
  const own=store.db.prepare('SELECT own_id FROM accounts WHERE id=?').get(thread.accountId) as {own_id:string}|undefined;
  const outgoing=(id:string,source:StoredEvent,text:string,time:string):void=>{
    const millis=Date.parse(time);if(!own||!Number.isFinite(millis))return;
    const payload:InboundEvent={...source.payload,text,direction:'OUTGOING',actorId:own.own_id,actorName:null,platformEventId:id,occurredAt:new Date(millis).toISOString()};
    const original=items.find(item=>item.id==='in:'+source.id);
    items.push({id,eventId:source.id,direction:'OUTGOING',text,occurredAt:payload.occurredAt,historical:false,origin:'CONFIRMED',isRoot:false,
      payload,verifiedForModel:original?.verifiedForModel===true&&!payload.observationIssue&&!payload.contentType});
  };
  const hasVerification=present(store,'verification_results');
  for(const source of sources.values()){
    const intents=store.db.prepare(`SELECT i.id,i.status,i.target_key,i.text_digest,i.attempt_started_at,d.text FROM send_intents i
      JOIN reply_drafts d ON d.id=i.draft_id AND d.event_id=i.event_id WHERE i.event_id=?`).all(source.id) as {
        id:string;status:string;target_key:string;text_digest:string;attempt_started_at:string;text:string}[];
    for(const intent of intents){
      if(intent.target_key!==targetKey(source.payload)||digest(intent.text)!==intent.text_digest)continue;
      const verification=hasVerification?store.db.prepare('SELECT verified FROM verification_results WHERE intent_id=? ORDER BY rowid DESC LIMIT 1').get(intent.id) as {verified:number}|undefined:undefined;
      const receipt=store.db.prepare('SELECT result FROM delivery_receipts WHERE send_intent_id=? ORDER BY rowid DESC LIMIT 1').get(intent.id) as {result:string}|undefined;
      const confirmed=verification?verification.verified===1:intent.status==='CONFIRMED'&&receipt?.result==='CONFIRMED';
      if(confirmed)outgoing('out:'+intent.id,source,intent.text,intent.attempt_started_at);
    }
    const retries=store.db.prepare(`SELECT i.id,i.time,i.detail_redacted,d.text FROM audit_events i JOIN reply_drafts d
      ON d.id=json_extract(i.detail_redacted,'$.draftId') AND d.event_id=json_extract(i.detail_redacted,'$.eventId')
      WHERE i.event_type='MANUAL_RETRY_INTENT' AND json_extract(i.detail_redacted,'$.eventId')=? ORDER BY i.rowid`)
      .all(source.id) as {id:string;time:string;detail_redacted:string;text:string}[];
    for(const retry of retries){
      let detail:{textDigest?:string};try{detail=JSON.parse(retry.detail_redacted);}catch{continue;}
      const receipt=store.db.prepare("SELECT detail_redacted FROM audit_events WHERE event_type='MANUAL_RETRY_RECEIPT' AND entity_id=? ORDER BY rowid DESC LIMIT 1")
        .get(retry.id) as {detail_redacted:string}|undefined;
      let result:string|undefined;try{result=receipt?JSON.parse(receipt.detail_redacted).result:undefined;}catch{continue;}
      if(result==='CONFIRMED'&&detail.textDigest===digest(retry.text))outgoing('retry:'+retry.id,source,retry.text,retry.time);
    }
  }
  const roots=items.filter(item=>item.isRoot),root=roots.length===1?roots[0]!:null;
  const ordered=items.filter(item=>!item.isRoot).sort(chronological),result=root?[root,...ordered]:ordered;
  return {group,root,rootVerified:!!root&&root.verifiedForModel,rootMissing:roots.length===0,rootAmbiguous:roots.length>1,items:result,
    projectionRevision:digest([group,roots.map(item=>item.id),result.map(item=>[item.id,item.text,item.occurredAt,item.verifiedForModel,item.historical])]),
    localRecordsOnly:true,observedOwnHistoryComplete:false};
}

/** Keep the root, then the recent exact thread context; the current child is already the model's original input. */
export function commentThreadModelHistory(context:CommentThreadContext,event:InboundEvent,recent=6):InboundEvent[] {
  requireSafe(context.root&&context.rootVerified&&!context.rootMissing&&!context.rootAmbiguous&&sameCommentThread(context.root.payload,event),'COMMENT_ROOT_CONTEXT_REQUIRED');
  requireSafe(Number.isSafeInteger(recent)&&recent>=0&&recent<=30,'COMMENT_CONTEXT_LIMIT_INVALID');
  const chosen=recent===0?[]:context.items.filter(item=>!item.isRoot&&sameCommentThread(item.payload,event)&&
    !(item.direction==='INCOMING'&&targetKey(item.payload)===targetKey(event))).slice(-recent);
  requireSafe(chosen.every(item=>item.verifiedForModel),'COMMENT_THREAD_CONTEXT_UNVERIFIED');
  return [context.root.payload,...chosen.map(item=>item.payload)];
}

/** Native root remains pinned on every local timeline page; pagination never changes the currently selected reply target. */
export function commentThreadPage(context:CommentThreadContext,before?:string,pageSize=30){
  requireSafe(Number.isSafeInteger(pageSize)&&pageSize>=1&&pageSize<=100,'COMMENT_CONTEXT_LIMIT_INVALID');
  let cursor:{group:string;at:number;order:string}|null=null;
  if(before!==undefined){
    try{cursor=JSON.parse(Buffer.from(before,'base64url').toString('utf8'));}catch{requireSafe(false,'TIMELINE_CURSOR_INVALID');}
    requireSafe(cursor&&cursor.group===context.group&&Number.isFinite(cursor.at)&&typeof cursor.order==='string'&&
      /^(in|out|retry):[a-f0-9-]{36}$/iu.test(cursor.order),'TIMELINE_CURSOR_INVALID');
  }
  const all=context.items.filter(item=>!item.isRoot&&(!cursor||at(item)<cursor.at||at(item)===cursor.at&&item.id.localeCompare(cursor.order)<0));
  const selected=all.slice(-pageSize),hasMore=all.length>pageSize,oldest=selected[0];
  return {root:context.root,rootVerified:context.rootVerified,rootMissing:context.rootMissing,rootAmbiguous:context.rootAmbiguous,
    items:context.root?[context.root,...selected]:selected,pageSize,hasMore,
    before:hasMore&&oldest?Buffer.from(JSON.stringify({group:context.group,at:at(oldest),order:oldest.id})).toString('base64url'):null,
    projectionRevision:context.projectionRevision,localRecordsOnly:context.localRecordsOnly,observedOwnHistoryComplete:context.observedOwnHistoryComplete};
}
