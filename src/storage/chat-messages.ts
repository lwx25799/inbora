import {randomUUID} from 'node:crypto';
import {digest,eventBinding,eventSchema,requireSafe,type InboundEvent} from '../core/contracts.js';
import type {EventStore} from './store.js';

export interface ChatMessage {id:string;payload:InboundEvent;binding:string;ownId:string;historical:boolean}
interface ChatRow {id:string;payload:string;binding:string;own_id:string;historical:number}

/** Observed own messages are display data, never incoming tasks, approvals or delivery receipts. */
export class ChatMessageStore {
  constructor(readonly store:EventStore){}
  observe(events:InboundEvent[],ownId:string,origin:number,observedAt=Date.now()):void {
    const own=this.store.db.prepare("SELECT own_id FROM accounts WHERE id='account_001'").get() as {own_id:string}|undefined;
    requireSafe(own?.own_id===ownId,'ACCOUNT_CHANGED');
    requireSafe(Number.isSafeInteger(origin)&&origin>0&&origin<=observedAt,'OBSERVATION_BOUNDARY_INVALID');
    for(const input of events){
      if(input.channel!=='DIRECT_MESSAGE'||input.direction!=='OUTGOING'||input.actorId!==ownId)continue;
      const event=eventSchema.parse(input),time=Date.parse(event.occurredAt??'');
      if(event.kind!=='DM'||!event.conversationId||!event.platformEventId||!Number.isFinite(time)||time<946684800000||time>observedAt+2000)continue;
      const binding=eventBinding(event),prior=this.store.db.prepare('SELECT id,binding FROM chat_messages WHERE account_id=? AND conversation_id=? AND native_id=?')
        .get(event.accountId,event.conversationId,event.platformEventId) as {id:string;binding:string}|undefined;
      if(prior){
        if(prior.binding!==binding)this.store.db.prepare('UPDATE chat_messages SET conflicted=1 WHERE id=?').run(prior.id);
        continue;
      }
      this.store.db.prepare('INSERT INTO chat_messages VALUES(?,?,?,?,?,?,?,?,?,?,0)').run(randomUUID(),event.accountId,ownId,event.conversationId,
        event.platformEventId,digest(event.platformEventId),binding,JSON.stringify(event),observedAt,Number(time<origin));
    }
  }
  get(id:string):ChatMessage|null {
    if(!this.store.db.prepare("SELECT name FROM sqlite_master WHERE name='chat_messages'").get())return null;
    const row=this.store.db.prepare('SELECT id,payload,binding,own_id,historical FROM chat_messages WHERE id=? AND conflicted=0').get(id) as ChatRow|undefined;
    if(!row)return null;
    const payload=eventSchema.parse(JSON.parse(row.payload)),own=this.store.db.prepare('SELECT own_id FROM accounts WHERE id=?').get(payload.accountId) as {own_id:string}|undefined;
    requireSafe(own?.own_id===row.own_id&&payload.actorId===own.own_id&&payload.direction==='OUTGOING'&&eventBinding(payload)===row.binding,'MESSAGE_PREVIEW_UNAVAILABLE');
    return {id:row.id,payload,binding:row.binding,ownId:row.own_id,historical:!!row.historical};
  }
}
