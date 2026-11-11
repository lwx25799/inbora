import {expect,test} from 'vitest';
import {createElement,type ComponentType} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {Inbox} from '../../desktop/src/api.js';

function props(inbox:Inbox,channel:'ALL'|'DIRECT_MESSAGE'='ALL',filter:'UNREAD'|'MANUAL_ONLY'='UNREAD'){
  return {inbox,selected:null,channel,setChannel:()=>{},filter,setFilter:()=>{},pageNumber:0,setPageNumber:()=>{},
    choose:()=>{},markRead:()=>{},markingRead:false};
}
// The Node compiler does not enable JSX; Vitest transforms and renders the actual component.
const componentPath='../../desktop/src/InboxList.tsx';
const {InboxList}=await import(componentPath) as {InboxList:ComponentType<ReturnType<typeof props>>};

test('the unread view has an explicit all-read action and retains reply status on each row',()=>{
  const html=renderToStaticMarkup(createElement(InboxList,props({total:1,unreadTotal:1,page:0,pageSize:20,
    items:[{id:'synthetic',status:'CONFIRMED',replyStatus:'REPLIED',unread:true,
      channel:'DIRECT_MESSAGE',author:'合成联系人',preview:'合成入站',time:null,source:'DIRECT_MESSAGE'}]})));
  expect(html).toContain('value="UNREAD" selected=""');
  expect(html).toContain('>全部已读</button>');
  expect(html).toContain('aria-label="未读"');
  expect(html).toContain('>已回复</span>');
  expect(html).toContain('value="PENDING"');expect(html).toContain('value="CONFIRMED"');
});

test('empty unread channel keeps the global all-read action available for the other channel',()=>{
  const html=renderToStaticMarkup(createElement(InboxList,props({total:0,unreadTotal:0,page:0,pageSize:20,items:[]},'DIRECT_MESSAGE')));
  expect(html).toContain('当前没有未读消息');
  expect(html).toContain('<button title="将当前账号已收取的私信和评论全部标为已读">全部已读</button>');
});

test('manual-view group is an explicit selectable filter without changing the unread default',()=>{
  const inbox={total:0,unreadTotal:0,page:0,pageSize:20,items:[]};
  const html=renderToStaticMarkup(createElement(InboxList,props(inbox,'ALL','MANUAL_ONLY')));
  expect(html).toContain('<option value="MANUAL_ONLY" selected="">需人工查看</option>');
  expect(renderToStaticMarkup(createElement(InboxList,props(inbox)))).toContain('<option value="UNREAD" selected="">未读</option>');
});
