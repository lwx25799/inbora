import {z} from 'zod';
import {digest,eventBinding,requireSafe} from '../core/contracts.js';
import type {EventStore} from '../storage/store.js';
import {ChatMessageStore} from '../storage/chat-messages.js';
import {ObservedReader} from '../adapters/observed-reader.js';
import type {ObservationMapping} from '../config/site-mapping.js';
import type {Page} from 'playwright';
import {locatePreviewTarget} from './preview-target.js';
import {visibleStoredMessage} from '../adapters/message-view-location.js';
import {reportSecurityFailure} from '../adapters/security-signal.js';
import {assertSecurityChannelClear} from '../storage/security-holds.js';

export function resolveStoredDmMessage(store:EventStore,eventId:string,source?:'INBOUND'|'CHAT'){
  const chat=source!=='INBOUND'?new ChatMessageStore(store).get(eventId):null;
  requireSafe(source!=='CHAT'||chat,'MESSAGE_PREVIEW_UNAVAILABLE');
  const saved=chat??store.event(eventId),event=saved.payload;
  const ownId=store.accountOwnId();
  const peer=store.db.prepare('SELECT own_id,uid,sec_uid,title FROM discovered_conversations WHERE id=?').get(event.conversationId) as
    {own_id:string;uid:string|null;sec_uid:string;title:string}|undefined;
  requireSafe(ownId&&event.accountId===store.accountId&&event.channel==='DIRECT_MESSAGE'&&event.kind==='DM'&&
    event.platformEventId&&/^[1-9]\d{0,63}$/u.test(event.platformEventId)&&event.occurredAt&&Date.parse(event.occurredAt)>=946684800000&&
    Date.parse(event.occurredAt)<=Date.now()+2000&&peer?.own_id===ownId&&peer.sec_uid&&eventBinding(event)===saved.binding&&
    (chat?event.direction==='OUTGOING'&&event.actorId===ownId:
      event.direction==='INCOMING'&&event.actorId!==ownId&&event.actorId===peer.uid),'MESSAGE_PREVIEW_UNAVAILABLE');
  return {event,ownId,source:chat?'CHAT' as const:'INBOUND' as const,
    peer:{uid:peer.uid,secUid:peer.sec_uid,title:peer.title,conversationId:event.conversationId!}};
}
const checkpoint=z.object({peer:z.object({conversationId:z.string()}),phase:z.enum(['MIN','MAX','PROBE_MIN','PROBE_MAX']),
  anchor:z.object({top:z.number().finite(),height:z.number().nonnegative(),ids:z.array(z.string().min(1)).min(1).max(100)}).optional()});
const checkpoints=z.object({sweep:checkpoint.optional(),parked:z.array(checkpoint).max(1000).default([])});

/** One explicit viewing request. Exact visible native identity proves location; no messages or previews are saved. */
export async function locateStoredDmMessage(input:{store:EventStore;eventId:string;page:Page;mapping:ObservationMapping;signal:AbortSignal;check():void}){
  input.check();assertSecurityChannelClear(input.store,'DIRECT_MESSAGE');
  const resolved=resolveStoredDmMessage(input.store,input.eventId);
  requireSafe(resolved.ownId===input.mapping.self.uid,'ACCOUNT_CHANGED');
  const row=input.store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='dm'").get() as {cursor_json:string}|undefined;
  const cursor=checkpoints.parse(row?JSON.parse(row.cursor_json):{});
  const anchors=[...(cursor.sweep?[cursor.sweep]:[]),...cursor.parked].filter(item=>item.peer.conversationId===resolved.peer.conversationId&&item.anchor)
    .map(item=>({...item.anchor!,phase:item.phase}));
  // This read creates no tasks: metadata-complete stored rows need no body-ready waiting against the collection origin.
  const reader=new ObservedReader(input.page,input.mapping,Date.now(),input.signal,input.store.accountId),initial=await reader.dmWindow(resolved.peer,undefined,true);input.check();
  const result=await locatePreviewTarget({reader,peer:resolved.peer,target:resolved.event,initial,anchors,check:input.check,
    persist:async()=>false,record:()=>{},viewNativeTarget:()=>{input.check();return input.page.evaluate(visibleStoredMessage,{mapping:input.mapping,accountId:input.store.accountId,event:resolved.event,peer:resolved.peer}).catch(error=>reportSecurityFailure(input.page,error));}});input.check();
  await input.page.bringToFront();input.check();
  const located=result.found&&await input.page.evaluate(visibleStoredMessage,{mapping:input.mapping,accountId:input.store.accountId,event:resolved.event,peer:resolved.peer}).catch(error=>reportSecurityFailure(input.page,error));
  input.check();input.store.audit(located?'MESSAGE_VIEW_LOCATED':'MESSAGE_VIEW_NOT_FOUND',digest(input.eventId),{headed:true,located,windows:result.windows});
  return {opened:true as const,located};
}
