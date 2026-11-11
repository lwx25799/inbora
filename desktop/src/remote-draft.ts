import type {Thread} from './api.js';

export interface RemoteDraftEditor {
  eventId:string|null;
  text:string;
  suggestionId:string|null;
  editVersion:number;
}

export function mayAdvanceReplySelection(thread:Thread,guiSendEventId:string|undefined,guiIntentId?:string|null):boolean {
  return thread.draft?.origin!=='MCP_ASSISTED'||guiSendEventId===thread.event.id&&!!guiIntentId&&guiIntentId===thread.intent?.id;
}

export function remoteDraftConflict(previous:Thread|null,next:Thread,current:RemoteDraftEditor):boolean {
  return !!previous&&previous.event.id===next.event.id&&current.eventId===next.event.id&&
    next.draft?.origin==='MCP_ASSISTED'&&next.draft.version>(previous.draft?.version??0)&&!next.intent&&
    (current.text!==next.draft.text||current.suggestionId!==null);
}

/** A remote save may refresh a clean editor; it must never adopt or overwrite an intervening human edit. */
export function remoteDraftUpdate(previous:Thread|null,next:Thread,before:RemoteDraftEditor,current:RemoteDraftEditor):RemoteDraftEditor|null {
  if(!previous||previous.event.id!==next.event.id||before.eventId!==next.event.id||current.eventId!==next.event.id)return null;
  if(previous.intent||next.intent||previous.followup?.latestTurn||next.followup?.latestTurn||
    previous.followup?.queueReady||next.followup?.queueReady)return null;
  if(before.text!==(previous.draft?.text??'')||before.suggestionId!==null||
    current.editVersion!==before.editVersion||current.text!==before.text||current.suggestionId!==before.suggestionId)return null;
  if((next.draft?.version??0)<(previous.draft?.version??0))return null;
  return {...current,text:next.draft?.text??'',suggestionId:null};
}
