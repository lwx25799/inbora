import {expect,test,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import type {Page} from 'playwright';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {ObservedCommentReply} from '../../src/adapters/observed-comment-reply.js';
import {eventBinding} from '../../src/core/contracts.js';
import {fixtureServer} from '../fixtures/site.js';
import {commentReplyMapping,initializeCommentReplyFixture} from '../fixtures/observed-site.js';
import {candidate,database,privateTemp} from '../helpers.js';

async function fixture(failure:''|'duplicate'|'text'|'identity'|'draft'=''){
  const root=privateTemp('comment-adapter-page-'),server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(root,'profile'),true),page=owner.notification,store=database();
  const mapping=commentReplyMapping(server.origin),event=candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',videoId:'10',commentId:'11',platformEventId:'11',
    actorId:'200',actorName:'Peer',conversationId:null,text:'root fixture input',occurredAt:new Date(1793836800*1000).toISOString()});
  await page.route(server.origin+'/video/*',route=>route.fulfill({contentType:'text/html',body:
    '<style>body{margin:0}#self{display:block;height:24px}#viewport{height:400px;overflow-y:auto;width:500px}.comment{height:150px}</style><a id="self">Self</a><div id="viewport"><section id="comment-list"></section></div>'}));
  await page.addInitScript({content:`window.initializeTarget=${initializeCommentReplyFixture.toString()};`});
  await page.addInitScript(({failure})=>document.addEventListener('DOMContentLoaded',()=>{
    const state=window as unknown as {commentClicks:number;loaded:boolean;scrolls:number;initializeTarget:()=>void};state.commentClicks=0;state.loaded=false;state.scrolls=0;
    Object.defineProperty(document.querySelector('#self')!,'__reactFiber$fixture',{configurable:true,value:{return:{memoizedProps:{uid:failure==='identity'?'999':'100',secUid:'self-sec'}}}});
    const list=document.querySelector('#comment-list')!,viewport=document.querySelector('#viewport') as HTMLElement;
    for(let index=0;index<4;index++){
      const row=document.createElement('div'),id=String(100+index);row.className='comment';
      row.innerHTML='<a class="author" href="/user/peer-sec">Peer</a><div class="body">other exact root</div><div class="tooltip" id="tooltip_'+id+'">Actions</div>';
      Object.defineProperty(row,'__reactFiber$fixture',{value:{return:{memoizedProps:{level:1,userInfo:{uid:'100'},awemeInfo:{awemeId:'10'},
        commentInfo:{cid:id,replyId:'0',replyTotal:0,replyComment:[],text:'other exact root',createTime:1793836800,user:{uid:'200',secUid:'peer-sec'},status:1}}}}});list.append(row);
    }
    viewport.addEventListener('scroll',()=>{
      state.scrolls++;if(state.loaded||viewport.scrollTop<viewport.scrollHeight-viewport.clientHeight-1)return;state.loaded=true;
      setTimeout(()=>{
        const row=document.createElement('div');row.className='comment';row.id='root-comment';
        row.innerHTML='<a class="author" href="/user/peer-sec">Peer</a><div class="body">root fixture input</div><div class="tooltip" id="tooltip_11">Actions</div><button class="reply-action">回复</button>';
        list.append(row);state.initializeTarget();
        if(failure==='text'){Object.getOwnPropertyDescriptor(row,'__reactFiber$fixture')!.value.return.memoizedProps.commentInfo.text='changed target';row.querySelector('.body')!.textContent='changed target';}
        if(failure==='duplicate'){const copy=row.cloneNode(true);Object.defineProperty(copy,'__reactFiber$fixture',{value:Object.getOwnPropertyDescriptor(row,'__reactFiber$fixture')!.value});list.append(copy);}
      },20);
    });
    if(failure==='draft'){const draft=document.createElement('textarea');draft.value='preserve webpage human draft';document.body.append(draft);}
  }),{failure});
  await page.goto(server.origin+'/video/20');
  return{owner,page,store,mapping,event,close:async()=>{store.close();await owner.close();await server.close();}};
}

test('inspection normally locates a second-page exact root after navigation and leaves the original snapshot binding intact without submitting',async()=>{
  const f=await fixture(),adapter=new ObservedCommentReply(f.page,f.mapping);
  try{
    const first=await f.owner.actor.run(()=>adapter.inspect(f.event));
    expect(first).toMatchObject({targetKey:'comment:10:11',eventBinding:eventBinding(f.event),ownId:'100'});
    expect((await f.page.locator('#root-comment').boundingBox())!.y).toBeLessThan(await f.page.evaluate(()=>innerHeight));
    expect(await f.page.evaluate(()=>(window as unknown as {loaded:boolean}).loaded)).toBe(true);
    expect(await f.owner.actor.run(()=>adapter.inspect(f.event))).toEqual(first);
    expect(await f.page.locator('#comment-editor').textContent()).toBe('');
    expect(await f.page.evaluate(()=>(window as unknown as {commentClicks:number}).commentClicks)).toBe(0);
    expect(f.store.budgets().map(b=>b.used)).toEqual([0,0]);expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{adapter.dispose();await f.close();}
});

test.each([{failure:'duplicate',code:'COMMENT_REPLY_ROOT_NOT_UNIQUE'},{failure:'text',code:'COMMENT_REPLY_ORIGINAL_CHANGED'},
  {failure:'identity',code:'OBSERVATION_ACCOUNT_CHANGED'},{failure:'draft',code:'OBSERVATION_EXISTING_HUMAN_INPUT'}] as const)(
  'normal root lookup still refuses $failure before input or submission',async({failure,code})=>{
    const f=await fixture(failure),adapter=new ObservedCommentReply(f.page,f.mapping);
    try{
      await expect(f.owner.actor.run(()=>adapter.inspect(f.event))).rejects.toThrow(code);
      expect(await f.page.evaluate(()=>(window as unknown as {commentClicks:number}).commentClicks)).toBe(0);
      if(failure==='draft')expect(await f.page.locator('textarea').inputValue()).toBe('preserve webpage human draft');
      expect(f.store.budgets().map(b=>b.used)).toEqual([0,0]);expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
    }finally{adapter.dispose();await f.close();}
  });

test.each(['cancelled','expired'] as const)('a just-found root cannot open a composer after its lookup becomes %s',async condition=>{
  const now=vi.spyOn(Date,'now').mockReturnValue(1000),abort=new AbortController(),mapping=commentReplyMapping('http://127.0.0.1:1');
  const page=new EventEmitter() as EventEmitter&{url:()=>string;evaluate:ReturnType<typeof vi.fn>};page.url=()=>mapping.observation.works[0]!.url;
  page.evaluate=vi.fn(async()=>{if(condition==='cancelled')abort.abort();else now.mockReturnValue(31_001);
    return{context:[],proofs:[],ids:[],editorText:'',shape:'',rootCount:1};});
  const adapter=new ObservedCommentReply(page as unknown as Page,mapping,undefined,{signal:abort.signal});
  const event=candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',videoId:'10',commentId:'11',platformEventId:'11',conversationId:null});
  try{
    await expect(adapter.inspect(event)).rejects.toThrow(condition==='cancelled'?'COMMENT_REPLY_CANCELLED':'COMMENT_REPLY_LOCATE_TIMEOUT');
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  }finally{adapter.dispose();now.mockRestore();}
});

test('an already cancelled root lookup performs no page task',async()=>{
  const abort=new AbortController();abort.abort();const page=new EventEmitter() as EventEmitter&{url:()=>string;evaluate:ReturnType<typeof vi.fn>};
  const mapping=commentReplyMapping('http://127.0.0.1:1');page.url=()=>mapping.observation.works[0]!.url;page.evaluate=vi.fn();
  const adapter=new ObservedCommentReply(page as unknown as Page,mapping,undefined,{signal:abort.signal});
  try{await expect(adapter.inspect(candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',videoId:'10',commentId:'11',platformEventId:'11',conversationId:null})))
    .rejects.toThrow('COMMENT_REPLY_CANCELLED');expect(page.evaluate).not.toHaveBeenCalled();}
  finally{adapter.dispose();}
});

test('cancellation between a successful locate and opening the reply composer blocks every later frame',async()=>{
  const abort=new AbortController(),mapping=commentReplyMapping('http://127.0.0.1:1');
  const page=new EventEmitter() as EventEmitter&{url:()=>string;evaluate:ReturnType<typeof vi.fn>};page.url=()=>mapping.observation.works[0]!.url;
  const actions:string[]=[];page.evaluate=vi.fn(async(_capture,input:{action:string})=>{actions.push(input.action);
    if(input.action==='expand')abort.abort();return{context:[],proofs:[],ids:[],editorText:'',shape:'',rootCount:1};});
  const adapter=new ObservedCommentReply(page as unknown as Page,mapping,undefined,{signal:abort.signal});
  try{
    await expect(adapter.inspect(candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',videoId:'10',commentId:'11',platformEventId:'11',conversationId:null})))
      .rejects.toThrow('COMMENT_REPLY_CANCELLED');expect(actions).toEqual(['locateRoot','expand']);
  }finally{adapter.dispose();}
});

test('a cancelled preflight signal does not cancel the existing confirmed-proof readback phase',async()=>{
  const sentAt=new Date(Date.now()-1000).toISOString();
  const preflight=new AbortController();preflight.abort();const mapping=commentReplyMapping('http://127.0.0.1:1');
  const event=candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',videoId:'10',commentId:'11',platformEventId:'11',conversationId:null});
  const page=new EventEmitter() as EventEmitter&{url:()=>string;evaluate:ReturnType<typeof vi.fn>};page.url=()=>mapping.observation.works[0]!.url;
  page.evaluate=vi.fn(async()=>({context:[],proofs:[{id:'501',accountId:'account_001',ownId:'100',targetKey:'comment:10:11',text:'saved reply',
    sentAt,status:'CONFIRMED'}],ids:['501'],editorText:'',shape:''}));
  const adapter=new ObservedCommentReply(page as unknown as Page,mapping,500,{signal:preflight.signal});
  try{
    expect(await adapter.readback(event,'saved reply',[],new Date(Date.now()-2000).toISOString())).toMatchObject({id:'501'});
    expect(page.evaluate).toHaveBeenCalledTimes(2);
  }finally{adapter.dispose();}
});

test('an explicitly cancelled readonly verification performs no browser task',async()=>{
  const readonly=new AbortController();readonly.abort();const mapping=commentReplyMapping('http://127.0.0.1:1');
  const page=new EventEmitter() as EventEmitter&{url:()=>string;evaluate:ReturnType<typeof vi.fn>};page.url=()=>mapping.observation.works[0]!.url;page.evaluate=vi.fn();
  const adapter=new ObservedCommentReply(page as unknown as Page,mapping,500,{readonlySignal:readonly.signal});
  try{
    await expect(adapter.verifyExisting(candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',videoId:'10',commentId:'11',platformEventId:'11',conversationId:null}),
      'saved reply',new Date().toISOString())).rejects.toThrow('COMMENT_REPLY_CANCELLED');expect(page.evaluate).not.toHaveBeenCalled();
  }finally{adapter.dispose();}
});
