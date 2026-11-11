import {digest,eventBinding,isManualMediaCandidate,isStrong,targetKey,validManualMediaProof,type Draft,type StoredEvent} from '../core/contracts.js';
import {decodeEventRow,type EventRow,type EventStore} from '../storage/store.js';
import {commentThreadGroupKey} from '../storage/comment-thread-context.js';
import {readNoReplyEventIds} from './message-disposition.js';

export type ReplyStatus='WAITING'|'REPLIED'|'NOT_REQUIRED'|'MANUAL_ONLY';
interface OrderedRow extends EventRow {ordinal:number;scope:string}
interface IntentRow {event_id:string;attempt_started_at:string;target_digest:string;text_digest:string;text:string;approval:string|null}
interface ResumeRow {event_id:string;text:string;ordinal:number;saved_at:number}
interface FollowupRow {event_id:string;target_key:string;text:string;version:number;approval:string|null;params:string;
  intent_id:string|null;attempt_started_at:string|null;verified_at:string|null;proof_ref:string|null;native_id_digest:string|null}
export interface InboxGroup {selected:StoredEvent;latest:StoredEvent;members:StoredEvent[];replyStatus:ReplyStatus}

export function inboxGroupKey(event:StoredEvent):string {
  const e=event.payload;
  if(e.channel==='DIRECT_MESSAGE'&&e.conversationId)return digest([e.accountId,e.channel,e.conversationId]);
  return commentThreadGroupKey(e)??digest([e.accountId,e.channel,e.videoId,e.commentId,event.id]);
}

/** One read-transaction snapshot. Approval/coverage rules stay in JavaScript, never in a second SQL state machine. */
export class InboxProjection {
  readonly events:StoredEvent[];
  readonly order:Map<string,number>;
  readonly own:Map<string,string>;
  private readonly intents:Map<string,IntentRow>;
  private readonly verifications:Map<string,number>;
  private readonly pendingFollowups=new Set<string>();
  private readonly collisions:Set<string>;
  private readonly firstObserved:Map<string,number>;
  private readonly drafts:Map<string,ResumeRow>;
  private readonly noReply:Set<string>;
  private readonly mediaIdentityConflicts=new Set<string>();
  private readonly confirmedFollowups=new Map<string,number>();
  constructor(store:EventStore,channel:string='ALL',target?:{key:string;accountId:string;eventId?:string}) {
    const where=["e.status<>'BASELINE'"],args:string[]=[];
    if(channel!=='ALL'){where.push('e.channel=?');args.push(channel);}
    if(target){where.push('e.account_id=?');args.push(target.accountId);
      where.push(target.eventId?'e.id=?':'e.target_key=?');args.push(target.eventId??target.key);}
    const filter=where.join(' AND '),db=store.db;
    const tables=new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('verification_results','draft_revisions','human_reply_turns')").all() as {name:string}[]).map(row=>row.name));
    const rows=db.prepare(`SELECT e.rowid AS ordinal,e.id,e.payload,e.binding,e.status,e.scope FROM inbound_events e WHERE ${filter} ORDER BY e.rowid`).all(...args) as OrderedRow[];
    this.events=rows.map(decodeEventRow);this.order=new Map(rows.map(row=>[row.id,row.ordinal]));
    this.intents=new Map((db.prepare(`SELECT i.event_id,i.attempt_started_at,i.target_digest,i.text_digest,d.text,d.approval
      FROM send_intents i JOIN inbound_events e ON e.id=i.event_id JOIN reply_drafts d ON d.id=i.draft_id WHERE ${filter}`).all(...args) as IntentRow[]).map(row=>[row.event_id,row]));
    this.verifications=new Map(tables.has('verification_results')?(db.prepare(`SELECT i.event_id,v.verified FROM send_intents i
      JOIN inbound_events e ON e.id=i.event_id JOIN verification_results v ON v.rowid=(SELECT MAX(v2.rowid) FROM verification_results v2 WHERE v2.intent_id=i.id)
      WHERE ${filter}`).all(...args) as {event_id:string;verified:number}[]).map(row=>[row.event_id,row.verified]):[]);
    this.collisions=new Set((db.prepare(`SELECT DISTINCT c.event_id FROM source_collisions c JOIN inbound_events e ON e.id=c.event_id WHERE ${filter}`).all(...args) as {event_id:string}[]).map(row=>row.event_id));
    if(tables.has('human_reply_turns'))for(const row of db.prepare(`SELECT DISTINCT t.event_id FROM human_reply_turns t JOIN inbound_events e ON e.id=t.event_id
      WHERE ${filter} AND t.status IN ('PREPARING','APPROVED','INTENT_RECORDED','UNCERTAIN')`).all(...args) as {event_id:string}[]){
        this.verifications.set(row.event_id,0);this.pendingFollowups.add(row.event_id);
      }
    this.firstObserved=new Map((db.prepare(`SELECT e.id,o.observed_at FROM inbound_events e JOIN observations o ON o.rowid=(SELECT o2.rowid FROM observations o2
      WHERE o2.channel=e.channel AND o2.scope=e.scope AND o2.evidence_ref=json_extract(e.payload,'$.evidenceId') ORDER BY o2.rowid LIMIT 1)
      WHERE ${filter}`).all(...args) as {id:string;observed_at:string}[]).map(row=>[row.id,Date.parse(row.observed_at)]));
    const revision=tables.has('draft_revisions');
    this.drafts=new Map((db.prepare(`SELECT d.event_id,d.text,d.rowid AS ordinal,${revision?'COALESCE(r.saved_at,0)':'0'} AS saved_at FROM reply_drafts d
      JOIN inbound_events e ON e.id=d.event_id ${revision?'LEFT JOIN draft_revisions r ON r.draft_id=d.id AND r.version=d.version':''}
      WHERE ${filter} AND d.status IN ('DRAFT','APPROVED') AND NOT EXISTS(SELECT 1 FROM send_intents i WHERE i.event_id=d.event_id)`)
      .all(...args) as ResumeRow[]).map(row=>[row.event_id,row]));
    this.own=new Map((db.prepare('SELECT id,own_id FROM accounts').all() as {id:string;own_id:string}[]).map(row=>[row.id,row.own_id]));
    this.noReply=readNoReplyEventIds(store);
    const peers=new Map<string,string>();
    for(const event of this.events){
      if(event.payload.channel!=='DIRECT_MESSAGE'||!event.payload.conversationId)continue;
      const key=inboxGroupKey(event),peer=event.payload.actorId,prior=peers.get(key);
      if(peer){if(prior&&prior!==peer)this.mediaIdentityConflicts.add(key);peers.set(key,peer);}
      const approval=this.intents.get(event.id)?.approval;
      if(approval&&(JSON.parse(approval) as NonNullable<Draft['approval']>).snapshot.ownId!==this.own.get(event.payload.accountId))
        this.mediaIdentityConflicts.add(key);
    }
    if(tables.has('human_reply_turns')){
      const sources=new Map(this.events.map(event=>[event.id,event]));
      const turns=db.prepare(`SELECT t.event_id,t.target_key,t.text,t.version,t.approval,t.params,t.intent_id,
        t.attempt_started_at,t.verified_at,t.proof_ref,t.native_id_digest FROM human_reply_turns t
        JOIN inbound_events e ON e.id=t.event_id WHERE ${filter} AND t.status='CONFIRMED'`).all(...args) as FollowupRow[];
      for(const turn of turns)try{
        const event=sources.get(turn.event_id);if(!event||this.replyStatus(event)!=='REPLIED'||this.collisions.has(event.id))continue;
        const e=event.payload,approval=turn.approval?JSON.parse(turn.approval) as Draft['approval']:null,snapshot=approval?.snapshot;
        const params=JSON.parse(turn.params) as {eventId?:string;text?:string},own=this.own.get(e.accountId);
        const at=Date.parse(turn.attempt_started_at??''),verified=Date.parse(turn.verified_at??''),received=Date.parse(e.occurredAt??'');
        if(e.channel!=='DIRECT_MESSAGE'||e.kind!=='DM'||e.direction!=='INCOMING'||!own||!e.actorId||e.actorId===own||
          !snapshot||snapshot.accountId!==e.accountId||snapshot.ownId!==own||snapshot.eventBinding!==event.binding||eventBinding(e)!==event.binding||
          snapshot.targetKey!==targetKey(e)||snapshot.composerKey!==targetKey(e)||turn.target_key!==targetKey(e)||
          !approval||approval.version!==turn.version||approval.textDigest!==digest(turn.text)||params?.eventId!==event.id||params.text!==turn.text||
          !turn.text.trim()||!turn.intent_id||!/^[a-f0-9]{64}$/u.test(turn.proof_ref??'')||!/^[a-f0-9]{64}$/u.test(turn.native_id_digest??'')||
          !Number.isFinite(at)||!Number.isFinite(verified)||verified<at||!Number.isFinite(received)||received+(e.occurredAtPrecisionMs??1)>at||
          !(isStrong(e)||validManualMediaProof(e,snapshot)))continue;
        this.confirmedFollowups.set(event.id,Math.max(this.confirmedFollowups.get(event.id)??-Infinity,at));
      }catch{/* Incomplete persisted proof cannot advance conversation coverage. */}
    }
  }
  replyStatus(event:StoredEvent):ReplyStatus {
    const latest=this.verifications.get(event.id);
    if(latest===undefined&&!['CONFIRMED','UNCERTAIN','INTENT_RECORDED'].includes(event.status)&&!this.intents.has(event.id)&&
      !this.collisions.has(event.id)&&!this.pendingFollowups.has(event.id)){
      if(this.noReply.has(event.id))return 'NOT_REQUIRED';
      const own=this.own.get(event.payload.accountId);
      if(own&&!this.mediaIdentityConflicts.has(inboxGroupKey(event))&&isManualMediaCandidate(event.payload)&&event.payload.actorId!==own&&
        /^[1-9]\d{0,63}$/u.test(event.payload.platformEventId!)&&eventBinding(event.payload)===event.binding)return 'MANUAL_ONLY';
    }
    return latest!==undefined?(latest===1?'REPLIED':'WAITING'):event.status==='CONFIRMED'?'REPLIED':'WAITING';
  }
  group(members:StoredEvent[]):InboxGroup {
    const time=(event:StoredEvent)=>Date.parse(event.payload.occurredAt??'')||0;
    members.sort((a,b)=>time(a)-time(b));
    const latest=members.at(-1)!,replies:{event:StoredEvent;at:number;ownId:string;followup?:boolean}[]=[];let repliedAt=-Infinity;
    if(latest.payload.channel==='COMMENT_NOTIFICATION'){
      const waiting=members.filter(event=>this.replyStatus(event)==='WAITING');
      return {selected:waiting.at(-1)??latest,latest,members,replyStatus:waiting.length?'WAITING':'REPLIED'};
    }
    // Shares and unsupported media stay visible without becoming automatic reply tasks.
    const latestRequired=members.filter(event=>['WAITING','REPLIED'].includes(this.replyStatus(event))).at(-1);
    if(!latestRequired)return {selected:members.filter(event=>this.replyStatus(event)==='MANUAL_ONLY').at(-1)??latest,latest,members,
      replyStatus:members.some(event=>this.replyStatus(event)==='MANUAL_ONLY')?'MANUAL_ONLY':'NOT_REQUIRED'};
    if(latest.payload.channel==='DIRECT_MESSAGE')for(const event of members){
      if(this.replyStatus(event)!=='REPLIED')continue;
      const followupAt=this.confirmedFollowups.get(event.id);
      if(followupAt!==undefined)replies.push({event,at:followupAt,ownId:this.own.get(event.payload.accountId)!,followup:true});
      const intent=this.intents.get(event.id);if(!intent)continue;
      const approval=intent.approval?JSON.parse(intent.approval) as Draft['approval']:null,at=Date.parse(intent.attempt_started_at);
      if(approval&&approval.snapshot.eventBinding===event.binding&&digest(approval.snapshot)===intent.target_digest&&
        digest(intent.text)===intent.text_digest&&Number.isFinite(at)){
        repliedAt=Math.max(repliedAt,at);replies.push({event,at,ownId:approval.snapshot.ownId});
      }
    }
    const waiting=members.filter(event=>{
      if(this.pendingFollowups.has(event.id))return true;
      if(this.replyStatus(event)!=='WAITING')return false;
      const laterObserved=(this.order.get(event.id)??0)>(this.order.get(latestRequired.id)??0);
      if(event.payload.channel==='DIRECT_MESSAGE'&&replies.length){
        const receivedAt=time(event),precision=event.payload.occurredAtPrecisionMs??1,firstObserved=this.firstObserved.get(event.id)??NaN;
        let coverageAt=isStrong(event.payload)?repliedAt:-Infinity;
        const media=isManualMediaCandidate(event.payload)&&/^[1-9]\d{0,63}$/.test(event.payload.platformEventId!);
        if(isStrong(event.payload)||media){
          const own=this.own.get(event.payload.accountId);
          for(const reply of replies)if((media||reply.followup)&&(!reply.followup||!this.intents.has(event.id)&&eventBinding(event.payload)===event.binding)&&
            reply.ownId===own&&event.payload.actorId!==reply.ownId&&
            reply.event.payload.accountId===event.payload.accountId&&reply.event.payload.conversationId===event.payload.conversationId&&
            reply.event.payload.actorId===event.payload.actorId)coverageAt=Math.max(coverageAt,reply.at);
        }
        if(receivedAt>0&&receivedAt+precision<=coverageAt&&Number.isFinite(firstObserved)&&firstObserved<coverageAt&&!this.collisions.has(event.id))return false;
        const intent=this.intents.get(event.id);
        if(!laterObserved&&event.id!==latestRequired.id&&time(event)<time(latestRequired)&&this.replyStatus(latestRequired)==='REPLIED'&&
          intent&&Date.parse(intent.attempt_started_at)<repliedAt)return false;
      }
      return event.id===latestRequired.id||event.status==='UNCERTAIN'||event.status==='INTENT_RECORDED'||event.status==='CONFIRMED'||this.collisions.has(event.id)||laterObserved;
    });
    return {selected:waiting.at(-1)??latest,latest,members,replyStatus:waiting.length?'WAITING':'REPLIED'};
  }
  resumeEvent(members:StoredEvent[],status:ReplyStatus):string|null {
    if(status!=='WAITING'&&members[0]?.payload.channel!=='DIRECT_MESSAGE')return null;
    if(members[0]?.payload.channel==='COMMENT_NOTIFICATION'){
      const drafts=members.filter(event=>this.replyStatus(event)==='WAITING').flatMap(event=>{
        const draft=this.drafts.get(event.id);return draft&&draft.text.trim()?[draft]:[];
      }).sort((a,b)=>b.saved_at-a.saved_at||b.ordinal-a.ordinal);
      return drafts[0]?.event_id??null;
    }
    let confirmedAt=-Infinity;
    for(const event of members){
      if(this.replyStatus(event)!=='REPLIED')continue;
      const at=Date.parse(this.intents.get(event.id)?.attempt_started_at??'');
      confirmedAt=Math.max(confirmedAt,Number.isFinite(at)?at:Infinity,this.confirmedFollowups.get(event.id)??-Infinity);
    }
    const drafts=members.flatMap(event=>{const draft=this.drafts.get(event.id);return draft&&draft.text.trim()&&draft.saved_at>confirmedAt?[draft]:[];})
      .sort((a,b)=>b.saved_at-a.saved_at||b.ordinal-a.ordinal);
    return drafts[0]?.event_id??null;
  }
}
