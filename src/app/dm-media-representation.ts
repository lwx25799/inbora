import {eventBinding,isStrong,type InboundEvent} from '../core/contracts.js';
import type {EventStore} from '../storage/store.js';
import {ChatMessageStore} from '../storage/chat-messages.js';

/** Collector-only compatibility: a newly readable body cannot rewrite a stored media event or approval. */
export function retainStoredDmMedia(store:EventStore,events:InboundEvent[]):InboundEvent[]{
  const source=(event:InboundEvent)=>JSON.stringify([event.accountId,event.channel,event.platformEventId]),counts=new Map<string,number>();
  for(const event of events)counts.set(source(event),(counts.get(source(event))??0)+1);
  return events.map(fresh=>{
    if(fresh.channel!=='DIRECT_MESSAGE'||!['INCOMING','OUTGOING'].includes(fresh.direction)||fresh.kind!=='DM'||!isStrong(fresh)||
      !fresh.platformEventId||!/^[1-9]\d{0,63}$/u.test(fresh.platformEventId)||!fresh.occurredAt||counts.get(source(fresh))!==1)return fresh;
    let previous:InboundEvent|undefined;
    if(fresh.direction==='INCOMING'){
      const row=store.db.prepare('SELECT id,binding FROM inbound_events WHERE account_id=? AND channel=? AND source_key=?')
        .get(fresh.accountId,fresh.channel,fresh.platformEventId) as {id:string;binding:string}|undefined;
      if(!row)return fresh;previous=store.event(row.id).payload;if(row.binding!==eventBinding(previous))return fresh;
    }else{
      if(!store.db.prepare("SELECT name FROM sqlite_master WHERE name='chat_messages'").get())return fresh;
      const row=store.db.prepare('SELECT id FROM chat_messages WHERE account_id=? AND conversation_id=? AND native_id=? AND conflicted=0')
        .get(fresh.accountId,fresh.conversationId,fresh.platformEventId) as {id:string}|undefined;
      if(!row)return fresh;
      try{previous=new ChatMessageStore(store).get(row.id)?.payload;}catch{return fresh;}
    }
    if(!previous)return fresh;
    const placeholder=previous.contentType==='IMAGE'?'[图片或表情消息，需人工查看]':
      previous.contentType==='MIXED'?'[含媒体的消息，需人工查看]':null;
    if(previous.observationIssue!=='DM_CONTENT_UNVERIFIED'||!placeholder||previous.text!==placeholder)return fresh;
    const identity=(event:InboundEvent)=>[event.accountId,event.channel,event.platformEventId,event.actorId,event.conversationId,event.direction,event.kind,
      event.occurredAt,event.occurredAtPrecisionMs,event.videoId,event.commentId,event.rootCommentId,event.replyToCommentId];
    return JSON.stringify(identity(previous))===JSON.stringify(identity(fresh))?previous:fresh;
  });
}
