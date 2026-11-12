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
    draft:{id:'synthetic-draft',eventId:'930bfc79-03e3-4006-bd73-6c7e29596311',text:'已记录的回复 <保留>',model:'mock',version:1,status:'APPROVED',approval:null,origin:'HUMAN_TYPED'},
    history:[],suggestions:[],contextVersion:'synthetic',
    ownership:{operator_id:'fixture',generation:1,lease_expires_at:9000000000000,isMine:true},
    capability:{state:'BLOCKED',reason:'TARGET_FROZEN',evidence:null},controlledTrial:false,workUrl:null,replyStatus:'WAITING',
    receipt:{result:'UNCERTAIN',verified_at:'2026-11-11T01:00:00Z',proof_ref:'synthetic'},verification:null};
  const status:Status={runtime:'synthetic-only',account:{id:'account_001',identity:'own-1'},operator:{id:'fixture',permissions:['READ','EDIT'],expiresAt:9000000000000},
    mode:'MANUAL',configuredMode:'MANUAL',paused:false,browser:{state:'CLOSED',mode:'headless',version:null},lastSync:[],capabilities:[],budgets:[],
    usage:{requests:0,inputTokens:0,outputTokens:0,unresolved:0},settings:defaultSettings,keyPresent:false,modelAuthorized:false,modelBusy:false,
    sync:{runId:null,running:false,cancelled:false,source:null,results:[]},go:'UNVERIFIED',schema:3};
  const props={thread,status,selected:thread.event.id,detailElement:{current:null},dialogElement:{current:null},
    setStatus:()=>{},choose:()=>{},busy:'',act:async(_label:string,action:()=>Promise<void>)=>{await action();},setNotice:()=>{},openDialog:async()=>{},closeDialog:async()=>{},
    readOnly:false,localDraft:true,saving:false,dirty:true,error:'',notice:'',text:'后来输入的新草稿',setText:()=>{},setSuggestionId:()=>{},setReview:()=>{},
    refreshThread:async()=>{},block:'此回复结果尚未确认，暂不可再次发送',
    send:null as {commandId:string;status:string;reason:string|null}|null,sendCurrentText:async()=>{}};
  return {thread,props,detail:()=>renderToStaticMarkup(createElement(ReplyDetail,props)).split('<dialog')[0]!,
    composer:()=>renderToStaticMarkup(createElement(ReplyComposer,props))};
}
const detailPath='../../desktop/src/ReplyDetail.tsx',composerPath='../../desktop/src/ReplyComposer.tsx';
const {ReplyDetail}=await import(detailPath) as {ReplyDetail:ComponentType<ReturnType<typeof fixture>['props']>};
const {ReplyComposer}=await import(composerPath) as {ReplyComposer:ComponentType<ReturnType<typeof fixture>['props']>};

test('an unknown result without a verification job never claims background confirmation is active',()=>{
  const f=fixture(),before=JSON.stringify(f.thread);
  for(const html of [f.detail(),f.composer()]){
    expect(html).toContain('尚未取得可确认的发送结果');
    expect(html).not.toContain('正在后台确认');
    expect(html).not.toContain('回复正在确认');
    expect(html).toContain('已记录的回复 &lt;保留&gt;');
  }
  expect(f.detail()).toContain('查看回复详情');
  expect(f.detail()).not.toContain('打开人工回复');
  expect(f.composer()).toContain('后来输入的新草稿');
  expect(f.composer()).toMatch(/<button[^>]*disabled=""[^>]*>发送<\/button>/u);
  expect(JSON.stringify(f.thread)).toBe(before);
});

test.each(['PENDING','RUNNING'])('an active %s verification is shown consistently on both surfaces',state=>{
  const f=fixture();f.thread.verification={state,attempts:1,last_error:null,verified:0,checked_at:1};
  for(const html of [f.detail(),f.composer()]){
    expect(html).toContain('正在后台核对发送结果');
    expect(html).not.toContain('确认送达');
  }
});

test.each(['REVIEW','EXHAUSTED'])('a finished %s verification explains the missing record without promising further checks',state=>{
  const f=fixture();f.thread.verification={state,attempts:2,last_error:'NO_COMPLETE_PROOF',verified:0,checked_at:1};
  for(const html of [f.detail(),f.composer()]){
    expect(html).toContain('后台核对已结束，尚未取得与本次回复完整对应的平台记录');
    expect(html).toContain('不会重复发送');
    expect(html).not.toContain('正在后台');
    expect(html).not.toContain('回复正在确认');
    expect(html).not.toContain('NO_COMPLETE_PROOF');
  }
});

test('verification deadlines and unknown codes use bounded user-facing explanations',()=>{
  const f=fixture();f.thread.verification={state:'REVIEW',attempts:2,last_error:'VERIFICATION_DEADLINE',verified:0,checked_at:1};
  expect(f.detail()).toContain('后台核对已到时限');expect(f.composer()).toContain('后台核对已到时限');
  f.thread.verification.last_error='PRIVATE_ERROR_CONTENT';
  for(const html of [f.detail(),f.composer()]){
    expect(html).toContain('后台核对已结束');expect(html).not.toContain('PRIVATE_ERROR_CONTENT');
  }
});

test('observing an outgoing message with the same text never confirms the recorded attempt',()=>{
  const f=fixture();
  f.thread.history=[candidate({direction:'OUTGOING',text:f.thread.draft!.text,occurredAt:'2026-11-11T01:00:00Z'})];
  expect(f.composer()).toContain('尚未取得可确认的发送结果');
  expect(f.composer()).not.toContain('<strong>已回复</strong>');
  expect(f.detail()).toContain('回复结果待确认');
  expect(f.thread.replyStatus).toBe('WAITING');
});

test('an uncertain follow-up never borrows the original reply verification task',()=>{
  const f=fixture();f.thread.replyStatus='REPLIED';
  f.thread.verification={state:'RUNNING',attempts:1,last_error:null,verified:0,checked_at:1};
  f.thread.followup={latestTurn:{commandId:'next-command',intentId:'next-intent',status:'UNCERTAIN',text:'后续回复',reason:null,verifiedAt:null},
    draft:null,eligible:false,queueReady:false,reason:'FOLLOWUP_REPLY_UNRESOLVED'};
  for(const html of [f.detail(),f.composer()]){
    expect(html).toContain('尚未取得可确认的发送结果');expect(html).not.toContain('正在后台');
  }
  expect(f.composer()).not.toContain('<strong>已回复</strong>');
});

test('a confirmed result and an unsent draft retain their ordinary reply entry',()=>{
  const f=fixture();f.thread.intent!.status='CONFIRMED';f.thread.replyStatus='REPLIED';
  expect(f.detail()).not.toContain('回复结果待确认');expect(f.detail()).toContain('打开人工回复');
  expect(f.composer()).toContain('<strong>已回复</strong>');
  f.thread.intent=null;f.thread.receipt=null;f.thread.replyStatus='WAITING';f.thread.event.status='AWAITING_APPROVAL';
  expect(f.detail()).not.toContain('回复结果待确认');expect(f.detail()).toContain('打开人工回复');
  expect(f.composer()).not.toContain('data-testid="reply-send-result"');
});

test('before-click failure retains the unsent result and does not claim background confirmation',()=>{
  const f=fixture();f.thread.intent=null;f.thread.receipt=null;
  f.props.send={commandId:'failed-command',status:'FAILED_BEFORE_CLICK',reason:'CONTEXT_VERSION_CONFLICT'};
  const html=f.composer();expect(html).toContain('<strong>尚未发送</strong>');
  expect(html).toContain('上下文已变化');expect(html).not.toContain('正在后台');
});

test('a supplemental success displays its own confirmation time instead of the old uncertain receipt time',()=>{
  const f=fixture(),checked=Date.parse('2026-11-11T05:54:02Z');
  f.thread.replyStatus='REPLIED';
  f.thread.verification={state:'REVIEW',attempts:2,last_error:'NO_COMPLETE_PROOF',verified:1,checked_at:checked};
  const html=f.composer();expect(html).toContain('确认于 '+new Date(checked).toLocaleString('zh-CN',{hour12:false}));
  expect(html).not.toContain('确认于 '+new Date(f.thread.receipt!.verified_at).toLocaleString('zh-CN',{hour12:false}));
});

test('a diagnosed old platform time is explained in the application without an ongoing-check claim',()=>{
  const f=fixture();
  f.thread.verification={state:'REVIEW',attempts:2,last_error:'COMMENT_TIME_BEFORE_INTENT',verified:0,checked_at:1};
  for(const html of [f.detail(),f.composer()]){
    expect(html).toContain('已读到我方回复');expect(html).toContain('早于本机提交时间');
    expect(html).not.toContain('正在后台');expect(html).not.toContain('COMMENT_TIME_BEFORE_INTENT');
  }
});
