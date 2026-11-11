import type {Thread} from './api.js';

export interface SubmittedReply {text:string;suggestionId:string|null;editVersion:number;cleared?:boolean;restored?:boolean}
interface LocalReply {text:string;suggestionId:string|null;editVersion?:number;submitted?:SubmittedReply}
export interface ReplyCommandResult {commandId:string;status:string;reason:string|null;accepted?:boolean;intentId?:string|null}

export function hasReplyHistory(thread:Thread){return !!thread.intent||!!thread.followup?.latestTurn||!!thread.followup?.queueReady;}
export function canContinueReply(thread:Thread){return !hasReplyHistory(thread)||(thread.followup?.queueReady??thread.followup?.eligible??false);}
export function replyDraft(thread:Thread){return hasReplyHistory(thread)&&thread.followup?thread.followup.draft:thread.draft;}
export function submittedReplyText(thread:Thread){return thread.followup?.latestTurn?.text??thread.draft?.text??'';}
export function hasSubmittedReply(thread:Thread):boolean {
  return thread.followup?.latestTurn?!!thread.followup.latestTurn.intentId:!!thread.intent;
}

export function hasLocalReplyDraft(thread:Thread,input:LocalReply):boolean {
  if(!hasReplyHistory(thread))return true;
  if(completedReply(thread)&&!input.text&&input.suggestionId===null)return false;
  if(input.submitted)return input.editVersion!==input.submitted.editVersion;
  if(thread.draft?.origin==='MCP_ASSISTED'&&!thread.followup?.latestTurn)return true;
  return input.text.replace(/\r\n?/gu,'\n')!==(thread.draft?.text??'').replace(/\r\n?/gu,'\n')||input.suggestionId!==null;
}

export function completedReply(thread:Thread):boolean {
  return thread.replyStatus==='REPLIED'&&!!thread.intent&&(!thread.followup?.latestTurn||thread.followup.latestTurn.status==='CONFIRMED');
}

export function matchesSentDraft(thread:Thread,input:LocalReply):boolean {
  const sent=submittedReplyText(thread);
  if(thread.intent&&thread.followup?.draft?.status==='DRAFT'&&!input.submitted)return false;
  // Only this GUI's submitted revision can retire human text after an assistant send.
  if(thread.draft?.origin==='MCP_ASSISTED'&&!thread.followup?.latestTurn&&!input.submitted)return false;
  return hasSubmittedReply(thread)&&
    (input.submitted?input.editVersion===input.submitted.editVersion&&
      input.submitted.text.replace(/\r\n?/gu,'\n')===sent.replace(/\r\n?/gu,'\n'):input.suggestionId===null)&&
    input.text.replace(/\r\n?/gu,'\n')===sent.replace(/\r\n?/gu,'\n');
}

/** A sent ledger revision is history, not an editable draft. Keep later local input. */
export function replyEditorDraft(thread:Thread,buffer?:LocalReply):LocalReply {
  const draft=replyDraft(thread);
  if(buffer&&!matchesSentDraft(thread,buffer))return buffer;
  if(hasReplyHistory(thread)&&thread.followup&&draft?.status==='DRAFT')return {text:draft.text,suggestionId:null};
  if(hasReplyHistory(thread))return {text:'',suggestionId:null};
  return buffer??{text:thread.draft?.text??'',suggestionId:null};
}

/** A durable command acknowledgement retires only the exact submitted editor revision. */
export function submissionEditorUpdate(input:LocalReply,submitted:SubmittedReply,result:ReplyCommandResult,commandId:string){
  if(result.commandId!==commandId||submitted.restored)return null;
  const sameVersion=input.editVersion===submitted.editVersion;
  if(result.status==='FAILED_BEFORE_CLICK')return submitted.cleared&&sameVersion&&input.text===''&&input.suggestionId===null
    ?{text:submitted.text,suggestionId:submitted.suggestionId,submitted:{...submitted,restored:true}}:null;
  if(submitted.cleared||!(result.accepted===true||result.intentId)||!sameVersion||input.text!==submitted.text||input.suggestionId!==submitted.suggestionId)return null;
  return {text:'',suggestionId:null,submitted:{...submitted,cleared:true}};
}
