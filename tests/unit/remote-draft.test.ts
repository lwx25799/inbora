import {expect,test} from 'vitest';
import type {Thread} from '../../desktop/src/api.js';
import {remoteDraftUpdate,remoteDraftConflict,mayAdvanceReplySelection,type RemoteDraftEditor} from '../../desktop/src/remote-draft.js';
import {matchesSentDraft,replyEditorDraft,hasLocalReplyDraft} from '../../desktop/src/reply-editor-draft.js';
import {candidate} from '../helpers.js';
import {eventBinding} from '../../src/core/contracts.js';

function thread(text='原草稿',version=1):Thread {
  const payload=candidate(),eventId='930bfc79-03e3-4006-bd73-6c7e29596311';
  return {event:{id:eventId,payload,binding:eventBinding(payload),status:'AWAITING_DRAFT'},
    draft:{id:'841459e3-490a-4d02-858a-d498b55f004c',eventId,text,version,model:'mock',status:'DRAFT',approval:null,origin:'HUMAN_TYPED'},
    strong:true,paused:false,frozen:false,intent:null,history:[],suggestions:[],contextVersion:'synthetic',
    ownership:{operator_id:null,generation:1,lease_expires_at:0,isMine:false},capability:{state:'SEND_AVAILABLE',reason:'',evidence:'synthetic'},
    controlledTrial:false,workUrl:null,replyStatus:'WAITING',receipt:null};
}

const editor=(value:Thread):RemoteDraftEditor=>({eventId:value.event.id,text:value.draft?.text??'',suggestionId:null,editVersion:4});

test('a clean selected editor adopts the assistant saved version before opening or autosaving',()=>{
  const previous=thread(),next=thread('助手新草稿',2),before=editor(previous);
  next.draft!.origin='MCP_ASSISTED';
  const result=remoteDraftUpdate(previous,next,before,{...before});
  expect(result?.text).toBe('助手新草稿');
  expect(result?.text!==next.draft!.text).toBe(false);
  expect(result?.editVersion).toBe(4);
});

test('initially empty clean editors also adopt a newly created assistant draft',()=>{
  const previous=thread();previous.draft=null;
  const before=editor(previous),next=thread('助手首次草稿',1);
  expect(remoteDraftUpdate(previous,next,before,before)?.text).toBe('助手首次草稿');
});

test('existing unsaved human edits and uncommitted suggestion selections remain unchanged',()=>{
  const previous=thread(),next=thread('助手新草稿',2),dirty={...editor(previous),text:'人工未保存全文'};
  expect(remoteDraftUpdate(previous,next,dirty,dirty)).toBeNull();
  const suggestion={...editor(previous),suggestionId:'synthetic-suggestion'};
  expect(remoteDraftUpdate(previous,next,suggestion,suggestion)).toBeNull();
  expect(dirty.text).toBe('人工未保存全文');
});

test('typing or clearing during an in-flight read cannot be overwritten, including typing back the same text',()=>{
  const previous=thread(),next=thread('助手新草稿',2),before=editor(previous);
  for(const text of ['处理中输入','',before.text]){
    expect(remoteDraftUpdate(previous,next,before,{...before,text,editVersion:5})).toBeNull();
  }
  expect(remoteDraftUpdate(previous,next,before,{...before,text:'different'})).toBeNull();
});

test('other targets, stale revisions and submission history cannot replace the editor',()=>{
  const previous=thread(),next=thread('助手新草稿',2),before=editor(previous);
  expect(remoteDraftUpdate(null,next,before,before)).toBeNull();
  expect(remoteDraftUpdate(previous,next,before,{...before,eventId:'other'})).toBeNull();
  expect(remoteDraftUpdate(previous,{...next,event:{...next.event,id:'other'}},before,before)).toBeNull();
  expect(remoteDraftUpdate(previous,thread('旧响应',0),before,before)).toBeNull();
  expect(remoteDraftUpdate(previous,{...next,intent:{id:'intent',status:'INTENT_RECORDED'}},before,before)).toBeNull();
  expect(remoteDraftUpdate({...previous,intent:{id:'intent',status:'CONFIRMED'}},next,before,before)).toBeNull();
});

test('assistant completion does not advance the GUI selection while genuine GUI sends retain their behavior',()=>{
  const current=thread();current.draft!.origin='MCP_ASSISTED';
  current.intent={id:'current-intent',status:'CONFIRMED'};
  expect(mayAdvanceReplySelection(current,undefined)).toBe(false);
  expect(mayAdvanceReplySelection(current,'another-event')).toBe(false);
  expect(mayAdvanceReplySelection(current,current.event.id)).toBe(false);
  expect(mayAdvanceReplySelection(current,current.event.id,'old-gui-intent')).toBe(false);
  expect(mayAdvanceReplySelection(current,current.event.id,'current-intent')).toBe(true);
  current.draft!.origin='HUMAN_TYPED';
  expect(mayAdvanceReplySelection(current,undefined)).toBe(true);
});

test('an assistant revision conflicts with preserved dirty human text, but own-save acknowledgment does not',()=>{
  const previous=thread(),next=thread('助手另一全文',2),dirty={...editor(previous),text:'尚未保存的人稿',editVersion:5};
  next.draft!.origin='MCP_ASSISTED';
  expect(remoteDraftUpdate(previous,next,dirty,dirty)).toBeNull();
  expect(remoteDraftConflict(previous,next,dirty)).toBe(true);
  expect(remoteDraftConflict(previous,next,{...dirty,text:next.draft!.text})).toBe(false);
  expect(remoteDraftConflict(previous,next,{...dirty,eventId:'other'})).toBe(false);
  next.draft!.origin='HUMAN_TYPED';
  expect(remoteDraftConflict(previous,next,dirty)).toBe(false);
});

test.each(['INTENT_RECORDED','CONFIRMED'])('an MCP %s cannot retire identical unsubmitted human text or its buffer',status=>{
  const current=thread('相同全文',2);
  current.draft!.origin='MCP_ASSISTED';current.intent={id:'assistant-intent',status};
  current.replyStatus=status==='CONFIRMED'?'REPLIED':'WAITING';
  const human={text:'相同全文',suggestionId:null,editVersion:8};
  expect(matchesSentDraft(current,human)).toBe(false);
  expect(replyEditorDraft(current,human)).toEqual(human);
  expect(hasLocalReplyDraft(current,human)).toBe(true);
  expect(replyEditorDraft(current)).toEqual({text:'',suggestionId:null});
});

test('a genuine GUI submission can retire its unchanged MCP-assisted draft while later human edits stay',()=>{
  const current=thread('已提交全文',2);
  current.draft!.origin='MCP_ASSISTED';current.intent={id:'gui-intent',status:'CONFIRMED'};current.replyStatus='REPLIED';
  const submitted={text:'已提交全文',suggestionId:null,editVersion:8};
  const human={...submitted,submitted};
  expect(matchesSentDraft(current,human)).toBe(true);
  expect(replyEditorDraft(current,human)).toEqual({text:'',suggestionId:null});
  expect(matchesSentDraft(current,{...human,editVersion:9})).toBe(false);
});
