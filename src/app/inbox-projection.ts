import {digest,isManualMediaCandidate,isStrong,type Draft,type StoredEvent} from '../core/contracts.js';
import {decodeEventRow,type EventRow,type EventStore} from '../storage/store.js';

export type ReplyStatus='WAITING'|'REPLIED';
interface OrderedRow extends EventRow {ordinal:number;scope:string}
interface IntentRow {event_id:string;attempt_started_at:string;target_digest:string;text_digest:string;text:string;approval:string|null}
interface ResumeRow {event_id:string;text:string;ordinal:number;saved_at:number}
export interface InboxGroup {selected:StoredEvent;latest:StoredEvent;members:StoredEvent[];replyStatus:ReplyStatus}

export function inboxGroupKey(event:StoredEvent):string {
  const e=event.payload;
  return digest(e.channel==='DIRECT_MESSAGE'&&e.conversationId?[e.accountId,e.channel,e.conversationId]:
    [e.accountId,e.channel,e.videoId,e.commentId,event.id]);
}

/** One read-transaction snapshot. Approval/coverage rules stay in JavaScript, never in a second SQL state machine. */
export class InboxProjection {
  readonly events:StoredEvent[];
  readonly order:Map<string,number>;
  readonly own:Map<string,string>;
  private readonly intents:Map<string,IntentRow>;
  private readonly verifications:Map<string,number>;
  private readonly collisions:Set<string>;
  private readonly firstObserved:Map<string,number>;
  private readonly drafts:Map<string,ResumeRow>;
  constructor(store:EventStore,channel:string='ALL',target?:{key:string;accountId:string;eventId?:string}) {
    const where=["e.status<>'BASELINE'"],args:string[]=[];
    if(channel!=='ALL'){where.push('e.channel=?');args.push(channel);}
    if(target){where.push('e.account_id=?');args.push(target.accountId);
      where.push(target.eventId?'e.id=?':'e.target_key=?');args.push(target.eventId??target.key);}
    const filter=where.join(' AND '),db=store.db;
    const tables=new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('verification_results','draft_revisions')").all() as {name:string}[]).map(row=>row.name));
    const rows=db.prepare(`SELECT e.rowid AS ordinal,e.id,e.payload,e.binding,e.status,e.scope FROM inbound_events e WHERE ${filter} ORDER BY e.rowid`).all(...args) as OrderedRow[];
    this.events=rows.map(decodeEventRow);this.order=new Map(rows.map(row=>[row.id,row.ordinal]));
    this.intents=new Map((db.prepare(`SELECT i.event_id,i.attempt_started_at,i.target_digest,i.text_digest,d.text,d.approval
      FROM send_intents i JOIN inbound_events e ON e.id=i.event_id JOIN reply_drafts d ON d.id=i.draft_id WHERE ${filter}`).all(...args) as IntentRow[]).map(row=>[row.event_id,row]));
    this.verifications=new Map(tables.has('verification_results')?(db.prepare(`SELECT i.event_id,v.verified FROM send_intents i
      JOIN inbound_events e ON e.id=i.event_id JOIN verification_results v ON v.rowid=(SELECT MAX(v2.rowid) FROM verification_results v2 WHERE v2.intent_id=i.id)
      WHERE ${filter}`).all(...args) as {event_id:string;verified:number}[]).map(row=>[row.event_id,row.verified]):[]);
    this.collisions=new Set((db.prepare(`SELECT DISTINCT c.event_id FROM source_collisions c JOIN inbound_events e ON e.id=c.event_id WHERE ${filter}`).all(...args) as {event_id:string}[]).map(row=>row.event_id));
    this.firstObserved=new Map((db.prepare(`SELECT e.id,o.observed_at FROM inbound_events e JOIN observations o ON o.rowid=(SELECT o2.rowid FROM observations o2
      WHERE o2.channel=e.channel AND o2.scope=e.scope AND o2.evidence_ref=json_extract(e.payload,'$.evidenceId') ORDER BY o2.rowid LIMIT 1)
      WHERE ${filter}`).all(...args) as {id:string;observed_at:string}[]).map(row=>[row.id,Date.parse(row.observed_at)]));
    const revision=tables.has('draft_revisions');
    this.drafts=new Map((db.prepare(`SELECT d.event_id,d.text,d.rowid AS ordinal,${revision?'COALESCE(r.saved_at,0)':'0'} AS saved_at FROM reply_drafts d
      JOIN inbound_events e ON e.id=d.event_id ${revision?'LEFT JOIN draft_revisions r ON r.draft_id=d.id AND r.version=d.version':''}
      WHERE ${filter} AND d.status IN ('DRAFT','APPROVED') AND NOT EXISTS(SELECT 1 FROM send_intents i WHERE i.event_id=d.event_id)`)
      .all(...args) as ResumeRow[]).map(row=>[row.event_id,row]));
    this.own=new Map((db.prepare('SELECT id,own_id FROM accounts').all() as {id:string;own_id:string}[]).map(row=>[row.id,row.own_id]));
  }
  replyStatus(event:StoredEvent):ReplyStatus {
    const latest=this.verifications.get(event.id);
    return latest!==undefined?(latest===1?'REPLIED':'WAITING'):event.status==='CONFIRMED'?'REPLIED':'WAITING';
  }
  group(members:StoredEvent[]):InboxGroup {
    const time=(event:StoredEvent)=>Date.parse(event.payload.occurredAt??'')||0;
    members.sort((a,b)=>time(a)-time(b));
    const latest=members.at(-1)!,replies:{event:StoredEvent;at:number;ownId:string}[]=[];let repliedAt=-Infinity;
    if(latest.payload.channel==='DIRECT_MESSAGE')for(const event of members){
      if(this.replyStatus(event)!=='REPLIED')continue;
      const intent=this.intents.get(event.id);if(!intent)continue;
      const approval=intent.approval?JSON.parse(intent.approval) as Draft['approval']:null,at=Date.parse(intent.attempt_started_at);
      if(approval&&approval.snapshot.eventBinding===event.binding&&digest(approval.snapshot)===intent.target_digest&&
        digest(intent.text)===intent.text_digest&&Number.isFinite(at)){
        repliedAt=Math.max(repliedAt,at);replies.push({event,at,ownId:approval.snapshot.ownId});
      }
    }
    const waiting=members.filter(event=>{
      if(this.replyStatus(event)!=='WAITING')return false;
      const laterObserved=(this.order.get(event.id)??0)>(this.order.get(latest.id)??0);
      if(event.payload.channel==='DIRECT_MESSAGE'&&Number.isFinite(repliedAt)){
        const receivedAt=time(event),precision=event.payload.occurredAtPrecisionMs??1,firstObserved=this.firstObserved.get(event.id)??NaN;
        let coverageAt=isStrong(event.payload)?repliedAt:-Infinity;
        if(isManualMediaCandidate(event.payload)&&/^[1-9]\d{0,63}$/.test(event.payload.platformEventId!)){
          const own=this.own.get(event.payload.accountId);
          for(const reply of replies)if(reply.ownId===own&&event.payload.actorId!==reply.ownId&&
            reply.event.payload.accountId===event.payload.accountId&&reply.event.payload.conversationId===event.payload.conversationId&&
            reply.event.payload.actorId===event.payload.actorId)coverageAt=Math.max(coverageAt,reply.at);
        }
        if(receivedAt>0&&receivedAt+precision<=coverageAt&&Number.isFinite(firstObserved)&&firstObserved<coverageAt&&!this.collisions.has(event.id))return false;
        const intent=this.intents.get(event.id);
        if(!laterObserved&&event.id!==latest.id&&time(event)<time(latest)&&this.replyStatus(latest)==='REPLIED'&&
          intent&&Date.parse(intent.attempt_started_at)<repliedAt)return false;
      }
      return event.id===latest.id||event.status==='UNCERTAIN'||event.status==='INTENT_RECORDED'||event.status==='CONFIRMED'||this.collisions.has(event.id)||laterObserved;
    });
    return {selected:waiting.at(-1)??latest,latest,members,replyStatus:waiting.length?'WAITING':'REPLIED'};
  }
  resumeEvent(members:StoredEvent[],status:ReplyStatus):string|null {
    if(status!=='WAITING'||members[0]?.payload.channel!=='DIRECT_MESSAGE')return null;
    let confirmedAt=-Infinity;
    for(const event of members){
      if(this.replyStatus(event)!=='REPLIED')continue;
      const at=Date.parse(this.intents.get(event.id)?.attempt_started_at??'');
      confirmedAt=Math.max(confirmedAt,Number.isFinite(at)?at:Infinity);
    }
    const drafts=members.flatMap(event=>{const draft=this.drafts.get(event.id);return draft&&draft.text.trim()&&draft.saved_at>confirmedAt?[draft]:[];})
      .sort((a,b)=>b.saved_at-a.saved_at||b.ordinal-a.ordinal);
    return drafts[0]?.event_id??null;
  }
}
