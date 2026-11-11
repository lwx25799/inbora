import type {z} from 'zod';
import {isStrong} from '../core/contracts.js';
import type {LocalAssistantState} from '../app/local-assistant-contracts.js';
import type {MessagePreviewAttachment} from '../storage/message-previews.js';
import type {WorkbenchQueries} from '../app/workbench-queries.js';
import type {WorkbenchAuthority} from '../app/authority.js';
import {previewSchema,statusSchema,threadSchema,replySchema} from './tool-contracts.js';

export function previewView(rows:MessagePreviewAttachment[]){
  return rows.map(row=>previewSchema.parse({previewId:row.previewId,state:row.state,reason:row.reason??null,
    width:row.width??null,height:row.height??null}));
}
export function draftView(draft:ReturnType<WorkbenchAuthority['draftFor']>){
  return draft?{id:draft.id,version:draft.version,text:draft.text,source:draft.origin}:null;
}
type Thread=ReturnType<WorkbenchQueries['thread']>;
export function threadView(detail:Thread,now:number){
  const timeline=detail.timeline;
  const messages=timeline.items.map(row=>({id:row.id,eventId:row.eventId,direction:row.direction,text:row.text,
    occurredAt:row.occurredAt,historical:row.historical,origin:row.origin,previews:previewView(row.attachments)}));
  const context=detail.commentContext;
  return threadSchema.parse({
    event:{id:detail.event.id,channel:detail.event.payload.channel,text:detail.event.payload.text,
      author:detail.event.payload.actorName,occurredAt:detail.event.payload.occurredAt,
      quality:isStrong(detail.event.payload)?'TEXT':'UNVERIFIED',replyStatus:detail.replyStatus},
    draft:draftView(detail.draft),contextVersion:detail.contextVersion,
    ownership:{generation:detail.ownership.generation,isMine:detail.ownership.isMine,
      busy:!!detail.ownership.operator_id&&detail.ownership.lease_expires_at>now,expiresAt:detail.ownership.lease_expires_at},
    timeline:{items:messages,pageSize:30,hasMore:timeline.hasMore,before:timeline.before},
    commentContext:context?{items:context.items.map(row=>({id:row.id,eventId:row.eventId,direction:row.direction,
      text:row.text,occurredAt:row.occurredAt,historical:row.historical,origin:row.origin,previews:[]})),
      pageSize:30,hasMore:context.hasMore,before:context.before}:null,
    frozen:detail.frozen,
  });
}
export function replyView(detail:Thread,selectionId:string):z.infer<typeof replySchema>{
  return replySchema.parse({kind:'reply',eventId:detail.event.id,selectionId,generation:detail.ownership.generation,
    expectedVersion:detail.draft?.version??0,contextVersion:detail.contextVersion,draft:draftView(detail.draft)});
}
export function statusView(status:ReturnType<WorkbenchQueries['status']>,assistant:LocalAssistantState,instanceId:string){
  return statusSchema.parse({runtime:status.runtime,instanceId,connected:true,accountConnected:!!status.account,
    browser:{state:status.browser.state,mode:status.browser.mode??null},automaticReply:status.configuredMode==='LIMITED_AUTO',
    emergencyStopped:status.automation?.emergencyStopped??false,budgets:status.budgets,
    assistant:{enabled:!!assistant.grant&&!assistant.reason,grantVersion:assistant.grant?.version??null,
      expiresAt:assistant.grant?.scope.expiresAt??null,permissions:assistant.grant?.scope.permissions??{read:false,editControl:false,send:false},
      remaining:assistant.remaining,reason:assistant.reason},sync:status.sync});
}
