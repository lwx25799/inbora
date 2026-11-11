import {expect,test} from 'vitest';
import {createElement,type ComponentType} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {Inbox,Status,Thread} from '../../desktop/src/api.js';
import {defaultSettings} from '../../src/app/contracts.js';
import {eventBinding} from '../../src/core/contracts.js';
import {candidate} from '../helpers.js';

function inboxProps(replyStatus:Inbox['items'][number]['replyStatus']){
  return {inbox:{total:1,unreadTotal:0,page:0,pageSize:20,items:[{id:'synthetic-share',status:'MANUAL_REVIEW',replyStatus,unread:false,
    channel:'DIRECT_MESSAGE',author:'合成联系人',preview:'[分享图集]',time:null,source:'DIRECT_MESSAGE',
    share:{kind:'DOUYIN_WORK' as const,url:'https://www.douyin.com/note/123',workId:'123'}}]},
  selected:null,channel:'ALL' as const,setChannel:()=>{},filter:'UNREAD' as const,setFilter:()=>{},pageNumber:0,setPageNumber:()=>{},
  choose:()=>{},markRead:()=>{},markingRead:false};
}
const inboxPath='../../desktop/src/InboxList.tsx',chatPath='../../desktop/src/DirectMessageChat.tsx';
const {InboxList}=await import(inboxPath) as {InboxList:ComponentType<ReturnType<typeof inboxProps>>};
const {DirectMessageChat}=await import(chatPath) as {DirectMessageChat:ComponentType<ReturnType<typeof chatFixture>['props']>};

test('a shared work is labelled no automatic reply and remains reachable from all messages',()=>{
  const render=(replyStatus:Inbox['items'][number]['replyStatus'])=>renderToStaticMarkup(createElement(InboxList,inboxProps(replyStatus)));
  const html=render('NOT_REQUIRED' as Inbox['items'][number]['replyStatus']);
  expect(html).toContain('>无需自动回复</span>');
  expect(html).not.toContain('badge warn');
  expect(html).toContain('<option value="ALL">全部消息</option>');
  expect(html).toContain('分享图集');expect(html).toContain('https://www.douyin.com/note/123');
  expect(render('WAITING')).toContain('>等待回复</span>');
  expect(render('REPLIED')).toContain('>已回复</span>');
});

function chatFixture(){
  const payload=candidate({text:'[分享图集]',contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED'});
  const thread:Thread={event:{id:'synthetic-share',payload,binding:eventBinding(payload),status:'MANUAL_REVIEW'},
    replyStatus:'NOT_REQUIRED' as Thread['replyStatus'],conversationReplyStatus:'NOT_REQUIRED' as Thread['replyStatus'],
    strong:false,paused:false,frozen:false,intent:null,draft:null,history:[],suggestions:[],contextVersion:'synthetic',
    ownership:{operator_id:null,generation:0,lease_expires_at:0,isMine:false},
    capability:{state:'BLOCKED',reason:'DM_CONTENT_UNVERIFIED',evidence:null},controlledTrial:false,workUrl:null,receipt:null};
  const status:Status={runtime:'synthetic-only',account:{id:'account_001',identity:'own-1'},operator:{id:'fixture',permissions:['READ','EDIT'],expiresAt:Date.now()+60000},
    mode:'MANUAL',configuredMode:'MANUAL',paused:false,browser:{state:'CLOSED',mode:'headless',version:null},lastSync:[],capabilities:[],budgets:[],
    usage:{requests:0,inputTokens:0,outputTokens:0,unresolved:0},settings:defaultSettings,keyPresent:false,modelAuthorized:false,modelBusy:false,
    sync:{runId:null,running:false,cancelled:false,source:null,results:[]},go:'UNVERIFIED',schema:3};
  const props={thread,status,selected:thread.event.id,detailElement:{current:null},dialogElement:{current:null},
    setStatus:()=>{},choose:()=>{},busy:'',act:async(_label:string,action:()=>Promise<void>)=>action(),setNotice:()=>{},openDialog:async()=>{},closeDialog:async()=>{},
    readOnly:false,localDraft:false,saving:false,dirty:false,error:'',notice:'',text:'',setText:()=>{},setSuggestionId:()=>{},setReview:()=>{},
    refreshThread:async()=>{},block:'DM_CONTENT_UNVERIFIED',send:null,sendCurrentText:async()=>{}};
  const render=()=>renderToStaticMarkup(createElement(DirectMessageChat,props));
  return {thread,props,render};
}

test('the message detail uses the authoritative conversation state without claiming the share was sent a reply',()=>{
  const {thread,render}=chatFixture();
  expect(render()).toContain('>无需自动回复</span>');
  expect(render()).not.toContain('>已回复</span>');
  thread.conversationReplyStatus='REPLIED';expect(render()).toContain('>已回复</span>');
  thread.conversationReplyStatus='WAITING';expect(render()).toContain('>等待回复</span>');
});

test('unclassified media requires manual viewing rather than waiting for an automatic reply',()=>{
  const props=inboxProps('MANUAL_ONLY' as Inbox['items'][number]['replyStatus']);
  const item=props.inbox.items[0]!;
  item.preview='[图片或表情消息，需人工查看]';
  const {share:_share,...media}=item;
  const inbox={...props.inbox,items:[media]};
  const html=renderToStaticMarkup(createElement(InboxList,{...props,inbox} as ReturnType<typeof inboxProps>));
  expect(html).toContain('>需人工查看</span>');
  expect(html).not.toContain('>等待回复</span>');expect(html).not.toContain('>已回复</span>');
  expect(html).not.toContain('分享图集');expect(html).not.toContain('>无需自动回复</span>');
  expect(html).toContain('<option value="ALL">全部消息</option>');
  const {thread,render}=chatFixture();
  thread.replyStatus='MANUAL_ONLY' as Thread['replyStatus'];thread.conversationReplyStatus=thread.replyStatus;
  const incoming={id:'in:synthetic-media',eventId:thread.event.id,direction:'INCOMING' as const,text:item.preview,occurredAt:null,
    historical:false,origin:'OBSERVED' as const,contentType:'IMAGE' as const,observationIssue:'DM_CONTENT_UNVERIFIED' as const,attachments:[]};
  thread.timeline={items:[incoming],pageSize:30,hasMore:false,before:null};
  const detail=render();expect(detail).toContain('>需人工查看</span>');expect(detail).toContain('当前查看消息');
  expect(detail).toContain('人工回复草稿');expect(detail).not.toContain('>已回复</span>');
});
