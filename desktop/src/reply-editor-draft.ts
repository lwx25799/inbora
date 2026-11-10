import type {Thread} from './api';

export interface SubmittedReply {text:string;suggestionId:string|null;editVersion:number}
interface LocalReply {text:string;suggestionId:string|null;editVersion?:number;submitted?:SubmittedReply}

export function replyDraft(thread:Thread){return thread.intent&&thread.followup?thread.followup.draft:thread.draft;}
export function submittedReplyText(thread:Thread){return thread.followup?.latestTurn?.text??thread.draft?.text??'';}
export function hasSubmittedReply(thread:Thread):boolean {
  return thread.followup?.latestTurn?!!thread.followup.latestTurn.intentId:!!thread.intent;
}

export function hasLocalReplyDraft(thread:Thread,input:LocalReply):boolean {
  if(!thread.intent)return true;
  if(completedReply(thread)&&!input.text&&input.suggestionId===null)return false;
  if(input.submitted)return input.editVersion!==input.submitted.editVersion;
  return input.text.replace(/\r\n?/gu,'\n')!==(thread.draft?.text??'').replace(/\r\n?/gu,'\n')||input.suggestionId!==null;
}

export function completedReply(thread:Thread):boolean {
  return thread.replyStatus==='REPLIED'&&!!thread.intent&&(!thread.followup?.latestTurn||thread.followup.latestTurn.status==='CONFIRMED');
}

export function matchesSentDraft(thread:Thread,input:LocalReply):boolean {
  const sent=submittedReplyText(thread);
  if(thread.intent&&thread.followup?.draft?.status==='DRAFT'&&!input.submitted)return false;
  return hasSubmittedReply(thread)&&
    (input.submitted?input.editVersion===input.submitted.editVersion&&
      input.submitted.text.replace(/\r\n?/gu,'\n')===sent.replace(/\r\n?/gu,'\n'):input.suggestionId===null)&&
    input.text.replace(/\r\n?/gu,'\n')===sent.replace(/\r\n?/gu,'\n');
}

/** A sent ledger revision is history, not an editable draft. Keep later local input. */
export function replyEditorDraft(thread:Thread,buffer?:LocalReply):LocalReply {
  const draft=replyDraft(thread);
  if(buffer&&!matchesSentDraft(thread,buffer))return buffer;
  if(thread.intent&&thread.followup&&draft?.status==='DRAFT')return {text:draft.text,suggestionId:null};
  if(thread.intent)return {text:'',suggestionId:null};
  return buffer??{text:thread.draft?.text??'',suggestionId:null};
}
