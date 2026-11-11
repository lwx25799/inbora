import type {ClientService} from '../app/service.js';
import type {WorkbenchQueries} from '../app/workbench-queries.js';
import type {LocalAssistantGrant} from '../app/local-assistant-contracts.js';
import {requireSafe,type StoredEvent} from '../core/contracts.js';
import {ChatMessageStore} from '../storage/chat-messages.js';
import {sameCommentThread} from '../storage/comment-thread-context.js';
import {MessagePreviewStore} from '../storage/message-previews.js';
import {draftView,previewView,threadView} from './projections.js';

/** Deliberately selects fields: GUI payloads also contain private evidence/URLs and are not a wire contract. */
export class AssistantReads {
  constructor(readonly service:ClientService){}
  private sameThread(a:StoredEvent['payload'],b:StoredEvent['payload']):boolean{
    return a.accountId===b.accountId&&a.channel===b.channel&&(a.channel==='DIRECT_MESSAGE'?
      !!a.conversationId&&a.conversationId===b.conversationId:sameCommentThread(a,b));
  }
  private readable(grant:LocalAssistantGrant,anchor:StoredEvent,eventId:string,time:string|null):boolean{
    const at=Date.parse(time??'');
    if(!Number.isFinite(at)||at<=grant.scope.collection.startedAt||at>this.service.authority.now())return false;
    const store=this.service.store;
    if(store.db.prepare('SELECT id FROM inbound_events WHERE id=?').get(eventId)){
      const event=store.event(eventId);
      return this.sameThread(anchor.payload,event.payload)&&this.service.authority.assistant.inScope(grant,event);
    }
    const observed=new ChatMessageStore(store).get(eventId);
    return !!observed&&observed.ownId===grant.scope.ownId&&!observed.historical&&this.sameThread(anchor.payload,observed.payload);
  }
  async thread(token:string,eventId:string,before?:string){
    const event=this.service.store.event(eventId);
    const grant=this.service.authority.assistant.requireEvent('read',event,this.service.authority.assistantVersion(token)??undefined);
    const detail=await this.service.dispatch(token,{command:'getThread',eventId,...(before?{timelineBefore:before}:{})}) as ReturnType<WorkbenchQueries['thread']>;
    this.service.authority.assistant.requireEvent('read',this.service.store.event(eventId),grant.version);
    detail.timeline.items=detail.timeline.items.filter(row=>this.readable(grant,event,row.eventId,row.occurredAt));
    if(detail.commentContext)detail.commentContext.items=detail.commentContext.items.filter(row=>this.readable(grant,event,row.eventId,row.occurredAt));
    return threadView(detail,this.service.authority.now());
  }
  async inbox(token:string,input:{channel:'ALL'|'COMMENT_NOTIFICATION'|'DIRECT_MESSAGE';status:'ALL'|'UNREAD'|'PENDING'|'REVIEW'|'UNCERTAIN'|'CONFIRMED'|'MANUAL_ONLY';page:number}){
    const auth=this.service.authority,grant=auth.assistant.require('read',auth.assistantVersion(token)??undefined);
    requireSafe(input.channel==='ALL'||grant.scope.channels.includes(input.channel),'ASSISTANT_TARGET_OUTSIDE_SCOPE');
    const data=await this.service.dispatch(token,{command:'getInbox',...input}) as ReturnType<WorkbenchQueries['inbox']>;
    auth.assistant.require('read',grant.version);
    const within=(id:string)=>auth.assistant.inScope(grant,this.service.store.event(id));
    return {page:data.page,pageSize:20,hasMore:(data.page+1)*20<data.total,items:data.items.filter(row=>within(row.id)&&within(row.latestEventId))
      .map(row=>{
        // The assistant contract describes incoming tasks; the GUI preview may now be our latest outgoing message.
        const incoming=row.previewDirection==='OUTGOING'?this.service.store.event(row.latestEventId):null;
        return {eventId:row.id,channel:row.channel,author:row.author,text:incoming?.payload.text??row.preview,
          time:incoming?.payload.occurredAt??row.time,unread:row.unread,replyStatus:row.replyStatus,
          resumeEventId:row.resumeEventId&&within(row.resumeEventId)?row.resumeEventId:null,
          previews:previewView(incoming?new MessagePreviewStore(this.service.browser.root).list(incoming.payload,grant.scope.ownId):row.attachments)};
      })};
  }
  preview(token:string,eventId:string){
    const authority=this.service.authority,event=this.service.store.event(eventId);
    const grant=authority.assistant.requireEvent('read',event,authority.assistantVersion(token)??undefined);
    return {eventId,previews:previewView(new MessagePreviewStore(this.service.browser.root).list(event.payload,grant.scope.ownId))};
  }
  reply(token:string,eventId:string,selectionId:string){
    const a=this.service.authority,event=this.service.store.event(eventId),owner=a.ownership(event),draft=a.draftFor(eventId);
    a.requireOwner(token,event,owner.generation);a.requireSelection(token,eventId,selectionId);
    return {kind:'reply' as const,eventId,selectionId,generation:owner.generation,expectedVersion:draft?.version??0,
      contextVersion:a.contextVersion(event),draft:draftView(draft)};
  }
}
