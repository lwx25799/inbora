import {digest,eventBinding,requireSafe} from '../core/contracts.js';
import type {EventStore} from '../storage/store.js';
import {ChatMessageStore} from '../storage/chat-messages.js';
import {MessagePreviewStore} from '../storage/message-previews.js';
import {MessageShareStore} from '../storage/message-shares.js';
import type {AutomationStore} from '../storage/automation-store.js';
import type {BrowserService} from './browser-service.js';
import type {Page} from 'playwright';
import type {ObservationMapping} from '../config/site-mapping.js';
import type {DiscoveredPeer,ObservationBatch} from '../adapters/observed-reader.js';
import {saveMessagePreviews} from '../adapters/message-preview.js';
import {resolveStoredDmMessage} from './message-view.js';

export interface PreviewDisplayTarget {eventId:string;source:'INBOUND'|'CHAT';purpose:'DISPLAY'}
export function resolvePreviewDisplay(store:EventStore,eventId:string,source?:PreviewDisplayTarget['source']){
  const resolved=resolveStoredDmMessage(store,eventId,source),{event,ownId}=resolved;
  requireSafe(event.observationIssue==='DM_CONTENT_UNVERIFIED'&&['IMAGE','MIXED'].includes(event.contentType??''),'MESSAGE_PREVIEW_UNAVAILABLE');
  return {event,ownId,target:{eventId,source:resolved.source,purpose:'DISPLAY'} as PreviewDisplayTarget};
}

export function readOrRefreshPreview(store:EventStore,browser:BrowserService,data:AutomationStore|null,control:()=>void,
  request:{eventId:string;refresh?:true|undefined;previewId?:string|undefined}){
  if(request.refresh===true){
    control();requireSafe(data,'AUTOMATION_NOT_READY');
    const resolved=resolvePreviewDisplay(store,request.eventId);
    return {scheduled:browser.prioritizeDisplayPreview(data,resolved.event,resolved.target)};
  }
  const observed=new ChatMessageStore(store).get(request.eventId),event=observed??store.event(request.eventId);
  const own=store.db.prepare('SELECT own_id FROM accounts WHERE id=?').get(event.payload.accountId) as {own_id:string}|undefined;
  requireSafe(own&&request.previewId,'MESSAGE_PREVIEW_UNAVAILABLE');return new MessagePreviewStore(browser.root).read(event.payload,own.own_id,request.previewId);
}

/** Explicit display reads enrich only the stored exact carrier; they never observe tasks or advance watermarks. */
export async function saveDisplayPreview(input:{store:EventStore;root:string;page:Page;mapping:ObservationMapping;target:PreviewDisplayTarget;
  batch:ObservationBatch;peer:DiscoveredPeer;signal:AbortSignal;check():void}):Promise<boolean>{
  input.check();const {event,ownId}=resolvePreviewDisplay(input.store,input.target.eventId,input.target.source);
  if(!input.batch.events.some(row=>row.platformEventId===event.platformEventId))return false;
  const cache=new MessagePreviewStore(input.root),shares=new MessageShareStore(input.root);
  const state=()=>digest([cache.list(event,ownId),cache.displayText(event,ownId),shares.read(event,ownId)]),before=state();
  await saveMessagePreviews(input.page,input.mapping,{...input.batch,events:[event]},input.root,input.signal,input.peer);
  input.check();requireSafe(eventBinding(resolvePreviewDisplay(input.store,input.target.eventId,input.target.source).event)===eventBinding(event),'MESSAGE_PREVIEW_UNAVAILABLE');
  if(state()!==before)input.store.audit('MESSAGE_DISPLAY_CHANGED',digest([event.accountId,'dm:'+event.conversationId]));
  return true;
}
