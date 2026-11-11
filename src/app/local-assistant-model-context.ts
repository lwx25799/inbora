import {eventBinding,requireSafe,targetKey,type InboundEvent,type StoredEvent} from '../core/contracts.js';
import {sameCommentThread} from '../storage/comment-thread-context.js';
import type {WorkbenchAuthority} from './authority.js';

/** Check the exact bounded prompt after the provider has added any mandatory comment root. */
export function requireAssistantModelContext(authority:WorkbenchAuthority,token:string,anchor:StoredEvent,history:InboundEvent[]):void{
  const version=authority.assistantVersion(token);if(version===null)return;
  const grant=authority.assistant.requireEvent('read',anchor,version),store=authority.store;
  const sameThread=(item:InboundEvent)=>item.accountId===anchor.payload.accountId&&item.channel===anchor.payload.channel&&
    (item.channel==='DIRECT_MESSAGE'?targetKey(item)===targetKey(anchor.payload):
      targetKey(item)===targetKey(anchor.payload)||sameCommentThread(item,anchor.payload));
  for(const item of history){
    const at=Date.parse(item.occurredAt??'');
    requireSafe(sameThread(item)&&Number.isFinite(at)&&at>grant.scope.collection.startedAt&&at<=authority.now(),
      'ASSISTANT_CONTEXT_OUTSIDE_SCOPE');
    let sourceId:string|undefined;
    if(item.direction==='INCOMING'){
      const row=store.db.prepare('SELECT id,binding FROM inbound_events WHERE account_id=? AND channel=? AND source_key=?')
        .get(item.accountId,item.channel,item.platformEventId) as {id:string;binding:string}|undefined;
      if(row?.binding===eventBinding(item))sourceId=row.id;
    }else if(item.direction==='OUTGOING'){
      const id=item.platformEventId?.replace(/^(?:out|followup|retry):/u,'');
      if(id){
        sourceId=(store.db.prepare('SELECT event_id FROM send_intents WHERE id=?').get(id) as {event_id:string}|undefined)?.event_id;
        if(!sourceId&&store.db.prepare("SELECT name FROM sqlite_master WHERE name='human_reply_turns'").get())
          sourceId=(store.db.prepare('SELECT event_id FROM human_reply_turns WHERE command_id=?').get(id) as {event_id:string}|undefined)?.event_id;
        if(!sourceId)sourceId=(store.db.prepare("SELECT json_extract(detail_redacted,'$.eventId') event_id FROM audit_events WHERE id=? AND event_type='MANUAL_RETRY_INTENT'")
          .get(id) as {event_id:string}|undefined)?.event_id;
      }
    }
    requireSafe(sourceId&&authority.assistant.inScope(grant,store.event(sourceId)),'ASSISTANT_CONTEXT_OUTSIDE_SCOPE');
  }
}
