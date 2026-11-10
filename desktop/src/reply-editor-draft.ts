import type {Thread} from './api';

export interface SubmittedReply {text:string;suggestionId:string|null;editVersion:number}
interface LocalReply {text:string;suggestionId:string|null;editVersion?:number;submitted?:SubmittedReply}

export function completedReply(thread:Thread):boolean {
  return thread.replyStatus==='REPLIED'&&!!thread.intent;
}

export function matchesSentDraft(thread:Thread,input:LocalReply):boolean {
  return completedReply(thread)&&!!thread.draft&&
    (input.submitted?input.editVersion===input.submitted.editVersion&&
      input.submitted.text.replace(/\r\n?/gu,'\n')===thread.draft.text.replace(/\r\n?/gu,'\n'):input.suggestionId===null)&&
    input.text.replace(/\r\n?/gu,'\n')===thread.draft.text.replace(/\r\n?/gu,'\n');
}

/** A sent ledger revision is history, not an editable draft. Keep later local input. */
export function replyEditorDraft(thread:Thread,buffer?:LocalReply):LocalReply {
  if(completedReply(thread))return buffer&&!matchesSentDraft(thread,buffer)
    ?buffer:{text:'',suggestionId:null};
  return buffer??{text:thread.draft?.text??'',suggestionId:null};
}
