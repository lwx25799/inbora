import {expect,test} from 'vitest';
import {createElement,type ComponentType} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {Thread,Status} from '../../desktop/src/api.js';
import {candidate} from '../helpers.js';
import {eventBinding} from '../../src/core/contracts.js';
import {defaultSettings} from '../../src/app/contracts.js';

function fixture(){
  const payload=candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',videoId:'100',commentId:'101',conversationId:null});
  const thread:Thread={event:{id:'930bfc79-03e3-4006-bd73-6c7e29596311',payload,binding:eventBinding(payload),status:'UNCERTAIN'},
    strong:true,paused:false,frozen:true,intent:{id:'synthetic-intent',status:'UNCERTAIN'},
    draft:{id:'synthetic-draft',eventId:'930bfc79-03e3-4006-bd73-6c7e29596311',text:'自动回复全文 <保留> 👩‍🚒',model:'mock',version:1,status:'APPROVED',approval:null,origin:'AI_ASSISTED_APPROVED'},
    history:[],suggestions:[],contextVersion:'synthetic',
    ownership:{operator_id:null,generation:1,lease_expires_at:0,isMine:false},capability:{state:'BLOCKED',reason:'TARGET_FROZEN',evidence:null},
    controlledTrial:false,workUrl:null,replyStatus:'WAITING',receipt:{result:'UNCERTAIN',verified_at:'2026-11-11T01:00:00Z',proof_ref:'synthetic'},
    verification:{state:'REVIEW',attempts:2,last_error:'NO_COMPLETE_PROOF',verified:0,checked_at:1}};
  const status:Status={runtime:'synthetic-only',account:{id:'account_001',identity:'own-1'},operator:{id:'fixture',permissions:['READ','EDIT'],expiresAt:Date.now()+60000},
    mode:'LIMITED_AUTO',configuredMode:'LIMITED_AUTO',paused:false,browser:{state:'CLOSED',mode:'headless',version:null},lastSync:[],capabilities:[],budgets:[],
    usage:{requests:0,inputTokens:0,outputTokens:0,unresolved:0},settings:defaultSettings,keyPresent:true,modelAuthorized:false,modelBusy:false,
    sync:{runId:null,running:false,cancelled:false,source:null,results:[]},go:'UNVERIFIED',schema:3};
  const props={thread,status,selected:thread.event.id,detailElement:{current:null},dialogElement:{current:null},
    setStatus:()=>{},choose:()=>{},busy:'',act:async(_label:string,action:()=>Promise<void>)=>{await action();},setNotice:()=>{},openDialog:async()=>{},closeDialog:async()=>{},
    readOnly:false,localDraft:false,saving:false,dirty:false,error:'',notice:'',text:'',setText:()=>{},setSuggestionId:()=>{},setReview:()=>{},
    refreshThread:async()=>{},block:'TARGET_FROZEN',send:null,sendCurrentText:async()=>{}};
  const html=()=>renderToStaticMarkup(createElement(ReplyDetail,props));
  return {thread,props,html,visible:()=>html().split('<dialog')[0]!};
}
const componentPath='../../desktop/src/ReplyDetail.tsx';
const {ReplyDetail}=await import(componentPath) as {ReplyDetail:ComponentType<ReturnType<typeof fixture>['props']>};

test('an uncertain automatic comment reply is visible before opening the human dialog without claiming delivery',()=>{
  const f=fixture(),before=JSON.stringify(f.thread);
  expect(f.html()).toContain('自动回复全文');
  expect(f.visible()).toContain('自动回复全文 &lt;保留&gt;');
  expect(f.visible()).toContain('回复结果待确认');
  expect(f.visible()).toContain('等待回复');expect(f.visible()).not.toContain('我方已回复');
  expect(JSON.stringify(f.thread)).toBe(before);
});

test('active readback and exhausted evidence show distinct truthful explanations',()=>{
  const f=fixture();f.thread.verification!.state='PENDING';
  expect(f.visible()).toContain('正在后台核对发送结果');
  f.thread.verification!.state='REVIEW';
  expect(f.visible()).toContain('后台核对已结束');
});

test('an unsent draft and a confirmed reply do not appear as unconfirmed attempts',()=>{
  const f=fixture();expect(f.visible()).toContain('回复结果待确认');
  f.thread.intent=null;expect(f.visible()).not.toContain('回复结果待确认');expect(f.visible()).not.toContain('自动回复全文');
  f.thread.intent={id:'synthetic-intent',status:'CONFIRMED'};f.thread.replyStatus='REPLIED';
  expect(f.visible()).not.toContain('回复结果待确认');expect(f.visible()).toContain('已回复');
});
