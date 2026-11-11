import {expect,test} from 'vitest';
import {createElement,type ComponentType} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {Thread,Status} from '../../desktop/src/api.js';
import {candidate} from '../helpers.js';
import {eventBinding} from '../../src/core/contracts.js';
import {defaultSettings} from '../../src/app/contracts.js';

function fixture(reason:string|null,eligible=reason===null){
  const payload=candidate(),thread:Thread={event:{id:'930bfc79-03e3-4006-bd73-6c7e29596311',payload,binding:eventBinding(payload),status:'AWAITING_DRAFT'},
    strong:true,paused:false,frozen:false,intent:null,draft:null,history:[],suggestions:[],contextVersion:'synthetic',
    ownership:{operator_id:'fixture',generation:1,lease_expires_at:Date.now()+60000,isMine:true},capability:{state:'SEND_AVAILABLE',reason:'',evidence:'synthetic'},
    controlledTrial:false,workUrl:null,replyStatus:'WAITING',receipt:null,suggestionEligibility:{eligible,reason}};
  const status:Status={runtime:'synthetic-only',account:{id:'account_001',identity:'own-1'},operator:{id:'fixture',permissions:['READ','EDIT'],expiresAt:Date.now()+60000},
    mode:'MANUAL',configuredMode:'MANUAL',paused:false,browser:{state:'CLOSED',mode:'headless',version:null},lastSync:[],capabilities:[],budgets:[],
    usage:{requests:0,inputTokens:0,outputTokens:0,unresolved:0},settings:defaultSettings,keyPresent:true,modelAuthorized:false,modelBusy:false,
    sync:{runId:null,running:false,cancelled:false,source:null,results:[]},go:'UNVERIFIED',schema:3};
  const props={thread,status,selected:thread.event.id,detailElement:{current:null},dialogElement:{current:null},
    setStatus:()=>{},choose:()=>{},busy:'',act:async(_label:string,action:()=>Promise<void>)=>{await action();},setNotice:()=>{},openDialog:async()=>{},closeDialog:async()=>{},
    readOnly:false,localDraft:false,saving:false,dirty:false,error:'',notice:'',text:'new human text',setText:()=>{},setSuggestionId:()=>{},setReview:()=>{},
    refreshThread:async()=>{},block:'',send:null,sendCurrentText:async()=>{}};
  const html=()=>renderToStaticMarkup(createElement(ReplyComposer,props));
  return{thread,status,props,html,button:()=>html().match(/<button([^>]*)>生成 AI 建议<\/button>/u)![1]!};
}
// The Node compiler does not enable JSX; Vitest's actual UI transform still executes the real component.
const componentPath='../../desktop/src/ReplyComposer.tsx';
const {ReplyComposer}=await import(componentPath) as {ReplyComposer:ComponentType<ReturnType<typeof fixture>['props']>};

test('authoritative exact thread permission enables first-text AI even while a preceding global status is old',()=>{
  const f=fixture(null);expect(f.button()).not.toContain('disabled');
});
test.each([
  ['DM_CONTENT_UNVERIFIED','此消息包含尚未核验的媒体或分享内容，暂不能生成 AI 建议'],
  ['SUGGESTION_ALREADY_SUBMITTED','此条已提交，可对新的文字留言生成建议'],
  ['MODEL_OUTSIDE_GRANT','当前回复策略未覆盖这条消息，暂不能生成 AI 建议'],
  ['MODEL_GRANT_EXHAUSTED','模型额度已用尽，暂不能生成 AI 建议'],
  ['MODEL_KEY_REQUIRED','模型 Key 尚未就绪，暂不能生成 AI 建议'],
  ['LOGIN_RECOVERY_IN_PROGRESS','专属浏览器正由本人操作，AI 建议暂不可用'],
])('a disabled %s entry explains its exact cause without promising media understanding', (reason,message)=>{
  const f=fixture(reason);expect(f.button()).toContain('disabled');expect(f.html()).toContain(message);
});
test('global busy or restoring state temporarily disables but never changes the exact draft',()=>{
  const f=fixture(null);f.props.busy='正在处理';expect(f.button()).toContain('disabled');expect(f.html()).toContain('正在处理当前操作，请稍候生成 AI 建议');
  f.props.busy='';f.props.readOnly=true;expect(f.button()).toContain('disabled');expect(f.props.text).toBe('new human text');
});

test('an assistant-authored draft is visibly distinct from human input',()=>{
  const f=fixture(null);
  f.thread.draft={id:'841459e3-490a-4d02-858a-d498b55f004c',eventId:f.thread.event.id,text:'助手合成草稿',model:'assistant',
    version:1,status:'DRAFT',approval:null,origin:'MCP_ASSISTED'};
  expect(f.html()).toContain('本机助手编辑');
  expect(f.html()).not.toContain('·<!-- -->人工输入');
});
