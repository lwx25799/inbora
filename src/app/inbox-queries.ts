import {digest,requireSafe,targetKey,type StoredEvent} from '../core/contracts.js';
import type {EventStore} from '../storage/store.js';
import type {ClientCommand} from './contracts.js';
import {MessagePreviewStore,type MessagePreviewAttachment} from '../storage/message-previews.js';
import {ChatMessageStore} from '../storage/chat-messages.js';
import {inboxReadBoundary,scopedReadEventIds} from './inbox-read-state.js';
import {MessageShareStore,type MessageShare} from '../storage/message-shares.js';
import {InboxProjection,inboxGroupKey,type ReplyStatus} from './inbox-projection.js';
import {readInboxPreviews,inboxPreviewKey} from './inbox-preview.js';
export {inboxGroupKey} from './inbox-projection.js';

export interface TimelineItem {
  id:string;
  eventId:string;
  direction:'INCOMING'|'OUTGOING';
  text:string;
  displayText?:string;
  occurredAt:string|null;
  historical:boolean;
  origin:'OBSERVED'|'CONFIRMED';
  contentType?:StoredEvent['payload']['contentType'];
  observationIssue?:StoredEvent['payload']['observationIssue'];
  attachments:MessagePreviewAttachment[];
  share?:MessageShare;
}
interface TimelineCursor {group:string;at:number;order:string}
interface MessageRow {id:string;event_id:string;text:string;occurred_at:string|null;at:number;historical:number}
const pageSize=30;
/** Product projections only. Grouping never changes an event's approval, draft or intent. */
export class InboxQueries {
  constructor(readonly store:EventStore,readonly root:string,readonly replyStatus:(id:string,status:string)=>ReplyStatus){}

  conversationReplyStatus(event:StoredEvent):ReplyStatus {
    if(event.payload.channel!=='DIRECT_MESSAGE')return this.replyStatus(event.id,event.status);
    return this.store.db.transaction(()=>{
      const projection=new InboxProjection(this.store,event.payload.channel,{key:targetKey(event.payload),accountId:event.payload.accountId,
        ...(!event.payload.conversationId?{eventId:event.id}:{})});
      const key=inboxGroupKey(event),members=projection.events.filter(item=>inboxGroupKey(item)===key);
      return members.length?projection.group(members).replyStatus:this.replyStatus(event.id,event.status);
    })();
  }

  inbox(c:Extract<ClientCommand,{command:'getInbox'}>){
    return this.store.db.transaction(()=>this.readInbox(c))();
  }
  private readInbox(c:Extract<ClientCommand,{command:'getInbox'}>){
    const projection=new InboxProjection(this.store,c.channel),groups=new Map<string,StoredEvent[]>();
    for(const event of projection.events){
      const key=inboxGroupKey(event),members=groups.get(key)??[];members.push(event);groups.set(key,members);
    }
    const time=(event:StoredEvent)=>Date.parse(event.payload.occurredAt??'')||0;
    const boundary=inboxReadBoundary(this.store);
    const scoped=scopedReadEventIds(this.store,boundary);
    const latestPreviews=c.channel==='COMMENT_NOTIFICATION'?new Map():readInboxPreviews(this.store,projection.tables,projection.own);
    const groupsWithRead=[...groups.entries()].map(([groupKey,members])=>{
      const group=projection.group(members);
      const latestMessage=group.latest.payload.channel==='DIRECT_MESSAGE'?latestPreviews.get(inboxPreviewKey(group.latest)):undefined;
      return {...group,groupKey,latestMessage,
        unread:members.some(event=>(projection.order.get(event.id)??0)>boundary&&!scoped.has(event.id))};
    });
    const unreadTotal=groupsWithRead.filter(row=>row.unread).length;
    const rows=groupsWithRead
      .filter(row=>c.status==='UNREAD'?row.unread:c.status==='PENDING'?row.replyStatus==='WAITING':c.status==='MANUAL_ONLY'?row.replyStatus==='MANUAL_ONLY':c.status==='CONFIRMED'?row.replyStatus==='REPLIED':
        c.status==='REVIEW'?row.members.some(e=>e.status==='MANUAL_REVIEW'):
          c.status==='UNCERTAIN'?row.members.some(e=>e.status==='UNCERTAIN'||e.status==='INTENT_RECORDED'):true)
      .sort((a,b)=>(Date.parse(b.latestMessage?.occurredAt??'')||time(b.latest))-(Date.parse(a.latestMessage?.occurredAt??'')||time(a.latest))||
        (projection.order.get(b.latest.id)??0)-(projection.order.get(a.latest.id)??0));
    const own=projection.own.get('account_001'),previews=new MessagePreviewStore(this.root),shares=new MessageShareStore(this.root);
    return {total:rows.length,unreadTotal,page:c.page,pageSize:20,items:rows.slice(c.page*20,c.page*20+20).map(row=>{
      const message=row.latestMessage;
      const payload=message?message.payload:row.latest.payload;
      const share=payload&&own?shares.read(payload,own):null;
      const displayText=payload&&own?previews.displayText(payload,own):null;
      return {
        id:row.selected.id,status:row.selected.status,replyStatus:row.replyStatus,unread:row.unread,channel:row.latest.payload.channel,
        author:row.latest.payload.actorName,preview:message?.text??row.latest.payload.text,time:message?.occurredAt??row.latest.payload.occurredAt,
        ...(message?{previewDirection:message.direction}:{}),
        ...(displayText!==null?{displayText}:{}),
        source:row.latest.payload.discovery??(row.latest.payload.channel==='DIRECT_MESSAGE'?'DIRECT_MESSAGE':'NOTIFICATION'),
        groupKey:row.groupKey,latestEventId:row.latest.id,messageCount:row.members.length,
        ...(row.latest.payload.channel==='COMMENT_NOTIFICATION'?{commentCount:row.members.length,
          waitingCount:row.members.filter(event=>projection.replyStatus(event)==='WAITING').length}:{}),
        resumeEventId:projection.resumeEvent(row.members,row.replyStatus),previewEventId:message?.eventId??row.latest.id,
        attachments:!share&&payload&&own?previews.list(payload,own):[],...(share?{share}:{}),
      };
    })};
  }

  timeline(event:StoredEvent,before?:string){
    return {...this.timelinePage(event,before),projectionRevision:this.projectionRevision(event)};
  }

  private timelinePage(event:StoredEvent,before?:string,limit=pageSize){
    const group=inboxGroupKey(event),cursor=this.cursor(group,before),e=event.payload;
    const candidateLimit=Math.max(pageSize,limit)+1;
    // Missing native identity must not merge weak events under a shared '?' target.
    const scope=e.channel==='DIRECT_MESSAGE'?!e.conversationId:!e.videoId||!e.commentId;
    const where=scope?'e.id=?':'e.account_id=? AND e.channel=? AND e.target_key=?';
    const args=scope?[event.id]:[e.accountId,e.channel,targetKey(e)];
    const bound=cursor?'WHERE (at < ? OR (at = ? AND id < ?))':'';
    const boundArgs=cursor?[cursor.at,cursor.at,cursor.order]:[];
    const timeSql=(value:string)=>`COALESCE(CAST((julianday(${value})-2440587.5)*86400000 AS INTEGER),0)`;
    const incoming=this.store.db.prepare(`SELECT * FROM (SELECT 'in:'||e.id AS id,e.id AS event_id,
      json_extract(e.payload,'$.text') AS text,json_extract(e.payload,'$.occurredAt') AS occurred_at,
      ${timeSql("json_extract(e.payload,'$.occurredAt')")} AS at,e.status='BASELINE' AS historical
      FROM inbound_events e WHERE ${where}) ${bound} ORDER BY at DESC,id DESC LIMIT ?`)
      .all(...args,...boundArgs,candidateLimit) as MessageRow[];
    const hasVerification=!!this.store.db.prepare("SELECT name FROM sqlite_master WHERE name='verification_results'").get();
    const verified=hasVerification?`COALESCE((SELECT verified FROM verification_results v WHERE v.intent_id=i.id ORDER BY v.rowid DESC LIMIT 1),
      CASE i.status WHEN 'CONFIRMED' THEN 1 ELSE 0 END)=1`:"i.status='CONFIRMED'";
    const hasChat=!!this.store.db.prepare("SELECT name FROM sqlite_master WHERE name='chat_messages'").get();
    const nativeId=(id:string)=>`COALESCE((SELECT native_id_digest FROM chat_delivery_links WHERE intent_id=${id}),
      (SELECT json_extract(a.detail_redacted,'$.nativeIdDigest') FROM audit_events a WHERE a.entity_id=${id}
        AND a.event_type IN ('SUBMISSION_PROOF','CLOCK_SKEW_PROOF') ORDER BY a.rowid DESC LIMIT 1))`;
    const notObserved=(boundary:string)=>hasChat?`AND NOT EXISTS(SELECT 1 FROM chat_messages m WHERE m.account_id=e.account_id AND
      m.conversation_id=json_extract(e.payload,'$.conversationId') AND m.conflicted=0 AND
      (m.native_id_digest=${nativeId('i.id')} OR (${nativeId('i.id')} IS NULL AND json_extract(m.payload,'$.text')=d.text AND
        abs(julianday(json_extract(m.payload,'$.occurredAt'))-julianday(${boundary}))*86400000<2000)))`:'';
    // The legacy fallback suppresses only a redundant display annotation. Native bubbles, intents and proof links remain distinct.
    // Each intent owns immutable text. Match its digest after loading rather than accepting a changed draft.
    const sent=this.store.db.prepare(`SELECT * FROM (SELECT 'out:'||i.id AS id,e.id AS event_id,d.text,
      i.attempt_started_at AS occurred_at,${timeSql('i.attempt_started_at')} AS at,0 AS historical,i.text_digest
      FROM send_intents i JOIN inbound_events e ON e.id=i.event_id JOIN reply_drafts d ON d.id=i.draft_id
      WHERE ${where} AND ${verified} ${notObserved('i.attempt_started_at')}) ${bound} ORDER BY at DESC,id DESC LIMIT ?`)
      .all(...args,...boundArgs,candidateLimit) as (MessageRow&{text_digest:string})[];
    const retried=this.store.db.prepare(`SELECT * FROM (SELECT 'retry:'||i.id AS id,e.id AS event_id,d.text,
      i.time AS occurred_at,${timeSql('i.time')} AS at,0 AS historical,json_extract(i.detail_redacted,'$.textDigest') AS text_digest
      FROM audit_events i JOIN inbound_events e ON e.id=json_extract(i.detail_redacted,'$.eventId')
      JOIN reply_drafts d ON d.id=json_extract(i.detail_redacted,'$.draftId')
      WHERE ${where} AND i.event_type='MANUAL_RETRY_INTENT' AND
        (SELECT json_extract(r.detail_redacted,'$.result') FROM audit_events r WHERE r.entity_id=i.id AND r.event_type='MANUAL_RETRY_RECEIPT'
          ORDER BY r.rowid DESC LIMIT 1)='CONFIRMED' ${notObserved('i.time')}) ${bound} ORDER BY at DESC,id DESC LIMIT ?`)
      .all(...args,...boundArgs,candidateLimit) as (MessageRow&{text_digest:string})[];
    const observed=hasChat&&e.channel==='DIRECT_MESSAGE'&&e.conversationId?this.store.db.prepare(`SELECT * FROM (
      SELECT 'observed:'||id AS id,id AS event_id,json_extract(payload,'$.text') AS text,
        json_extract(payload,'$.occurredAt') AS occurred_at,${timeSql("json_extract(payload,'$.occurredAt')")} AS at,historical
      FROM chat_messages WHERE account_id=? AND conversation_id=? AND own_id=(SELECT own_id FROM accounts WHERE id=?) AND conflicted=0
    ) ${bound} ORDER BY at DESC,id DESC LIMIT ?`).all(e.accountId,e.conversationId,e.accountId,...boundArgs,candidateLimit) as MessageRow[]:[];
    const followups=this.store.db.prepare("SELECT name FROM sqlite_master WHERE name='human_reply_turns'").get()?this.store.db.prepare(`SELECT * FROM (
      SELECT 'followup:'||t.command_id AS id,t.event_id,t.text,t.attempt_started_at AS occurred_at,
      ${timeSql('t.attempt_started_at')} AS at,0 AS historical FROM human_reply_turns t JOIN inbound_events e ON e.id=t.event_id
      WHERE ${where} AND t.status='CONFIRMED' ${hasChat?`AND NOT EXISTS(SELECT 1 FROM chat_messages m WHERE m.account_id=e.account_id
        AND m.conversation_id=json_extract(e.payload,'$.conversationId') AND m.conflicted=0 AND m.native_id_digest=t.native_id_digest)`:''})
      ${bound} ORDER BY at DESC,id DESC LIMIT ?`).all(...args,...boundArgs,candidateLimit) as MessageRow[]:[];
    const messages=[...incoming,...observed,...followups,...[...sent,...retried].filter(row=>digest(row.text)===row.text_digest)]
      .sort((a,b)=>b.at-a.at||b.id.localeCompare(a.id));
    const selected=messages.slice(0,limit),hasMore=messages.length>limit;
    const own=this.store.db.prepare('SELECT own_id FROM accounts WHERE id=?').get(e.accountId) as {own_id:string}|undefined;
    const previews=new MessagePreviewStore(this.root),shares=new MessageShareStore(this.root);
    const items=selected.reverse().map((row):TimelineItem=>{
      const inbound=row.id.startsWith('in:'),native=row.id.startsWith('observed:'),
        payload=inbound?this.store.event(row.event_id).payload:native?new ChatMessageStore(this.store).get(row.event_id)?.payload:null;
      const share=payload&&own?shares.read(payload,own.own_id):null,displayText=payload&&own?previews.displayText(payload,own.own_id):null;
      return {id:row.id,eventId:row.event_id,direction:inbound?'INCOMING':'OUTGOING',text:row.text,occurredAt:row.occurred_at,
        historical:!!row.historical,origin:inbound||native?'OBSERVED':'CONFIRMED',...(payload?.contentType?{contentType:payload.contentType}:{}),
        ...(displayText!==null?{displayText}:{}),
        ...(payload?.observationIssue?{observationIssue:payload.observationIssue}:{}),
        attachments:!share&&payload&&own?previews.list(payload,own.own_id):[],...(share?{share}:{})};
    });
    const oldest=selected[0];
    return {items,pageSize,hasMore,
      before:hasMore&&oldest?Buffer.from(JSON.stringify({group,at:oldest.at,order:oldest.id})).toString('base64url'):null};
  }

  private projectionRevision(event:StoredEvent):string {
    const e=event.payload,weak=e.channel==='DIRECT_MESSAGE'?!e.conversationId:!e.videoId||!e.commentId;
    const where=weak?'e.id=?':'e.account_id=? AND e.channel=? AND e.target_key=?',args=weak?[event.id]:[e.accountId,e.channel,targetKey(e)];
    const intents=this.store.db.prepare(`SELECT i.id,i.status FROM send_intents i JOIN inbound_events e ON e.id=i.event_id WHERE ${where} ORDER BY i.id`).all(...args);
    const receipts=this.store.db.prepare(`SELECT r.id,r.result FROM delivery_receipts r JOIN send_intents i ON i.id=r.send_intent_id
      JOIN inbound_events e ON e.id=i.event_id WHERE ${where} ORDER BY r.rowid`).all(...args);
    const table=(name:string)=>!!this.store.db.prepare("SELECT name FROM sqlite_master WHERE name=? AND type='table'").get(name);
    const verifications=table('verification_results')?this.store.db.prepare(`SELECT v.id,v.verified FROM verification_results v
      JOIN send_intents i ON i.id=v.intent_id JOIN inbound_events e ON e.id=i.event_id WHERE ${where} ORDER BY v.rowid`).all(...args):[];
    const observed=table('chat_messages')&&e.channel==='DIRECT_MESSAGE'&&e.conversationId?this.store.db.prepare(`SELECT id,native_id_digest,conflicted
      FROM chat_messages WHERE account_id=? AND conversation_id=? ORDER BY id`).all(e.accountId,e.conversationId):[];
    const links=table('chat_delivery_links')?this.store.db.prepare(`SELECT l.intent_id,l.native_id_digest FROM chat_delivery_links l
      JOIN send_intents i ON i.id=l.intent_id JOIN inbound_events e ON e.id=i.event_id WHERE ${where} ORDER BY l.intent_id`).all(...args):[];
    const nativeProofs=this.store.db.prepare(`SELECT a.id,a.event_type,json_extract(a.detail_redacted,'$.nativeIdDigest') AS native_id_digest
      FROM audit_events a JOIN send_intents i ON i.id=a.entity_id JOIN inbound_events e ON e.id=i.event_id WHERE ${where}
      AND a.event_type IN ('SUBMISSION_PROOF','CLOCK_SKEW_PROOF') ORDER BY a.rowid`).all(...args);
    const retries=this.store.db.prepare(`SELECT i.id,r.id AS receipt_id,json_extract(r.detail_redacted,'$.result') AS result
      FROM audit_events i JOIN inbound_events e ON e.id=json_extract(i.detail_redacted,'$.eventId')
      LEFT JOIN audit_events r ON r.entity_id=i.id AND r.event_type='MANUAL_RETRY_RECEIPT' WHERE ${where}
      AND i.event_type='MANUAL_RETRY_INTENT' ORDER BY i.id,r.rowid`).all(...args);
    const display=this.store.db.prepare("SELECT id FROM audit_events WHERE event_type='MESSAGE_DISPLAY_CHANGED' AND entity_id=? ORDER BY rowid DESC LIMIT 1")
      .get(digest([e.accountId,targetKey(e)]));
    const followups=table('human_reply_turns')?this.store.db.prepare(`SELECT t.command_id,t.status,t.native_id_digest FROM human_reply_turns t
      JOIN inbound_events e ON e.id=t.event_id WHERE ${where} ORDER BY t.rowid`).all(...args):[];
    return digest([inboxGroupKey(event),intents,receipts,verifications,observed,links,nativeProofs,retries,followups,display??null]);
  }

  private cursor(group:string,before?:string):TimelineCursor|null {
    if(before===undefined)return null;
    let value:unknown;try{value=JSON.parse(Buffer.from(before,'base64url').toString('utf8'));}catch{requireSafe(false,'TIMELINE_CURSOR_INVALID');}
    const c=value as Partial<TimelineCursor>|null;
    requireSafe(c&&c.group===group&&Number.isSafeInteger(c.at)&&typeof c.order==='string'&&/^(in|out|retry|observed|followup):[a-f0-9-]{36}$/iu.test(c.order),
      'TIMELINE_CURSOR_INVALID');
    return c as TimelineCursor;
  }
}
