import {expect,test,vi} from 'vitest';
import {rm} from 'node:fs/promises';
import {join} from 'node:path';
import type {JSHandle,Page} from 'playwright';
import {AccountActor} from '../../src/browser/account-actor.js';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {ManualRecovery} from '../../src/browser/manual-recovery.js';
import {ObservedReader,captureObserved} from '../../src/adapters/observed-reader.js';
import {ObservedCommentReply,captureCommentReply} from '../../src/adapters/observed-comment-reply.js';
import {ObservedDmReply} from '../../src/adapters/observed-dm-reply.js';
import {captureCommentThread} from '../../src/adapters/comment-thread-capture.js';
import {fixtureServer} from '../fixtures/site.js';
import {commentReplyMapping,dmReplyMapping,mountCommentReply,mountDmReply,observedMapping,reloadableCommentReply} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';

test('P0-5: verifyExisting and ObservedReader.comments guard unsent human drafts before navigating',async()=>{
  const root=privateTemp('p0-5-draft-guard-'),server=await fixtureServer();
  const owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
  let adapter:ObservedCommentReply|undefined;
  try{
    await mountCommentReply(owner,server.origin);
    await reloadableCommentReply(owner.notification,server.origin);
    const mapping=commentReplyMapping(server.origin);
    const batch=await owner.notification.evaluate(captureObserved,{mapping:mapping.observation,channel:'comments' as const,index:0,evidenceId:'fixture'});
    const event=batch.events[0]!;
    await owner.notification.evaluate(()=>{
      const draft=document.createElement('textarea');draft.id='human-comment-draft';draft.value='unsent webpage human draft';
      document.body.append(draft);
    });
    let navigations=0;
    owner.notification.on('framenavigated',frame=>{if(frame===owner.notification.mainFrame())navigations++;});
    adapter=new ObservedCommentReply(owner.notification,mapping,250);
    await expect(adapter.verifyExisting(event,'approved reply',new Date(Date.now()-5000).toISOString())).rejects.toThrow('OBSERVATION_EXISTING_HUMAN_INPUT');
    await expect(new ObservedReader(owner.notification,mapping.observation).comments(0)).rejects.toThrow('OBSERVATION_EXISTING_HUMAN_INPUT');
    expect(navigations).toBe(0);
    expect(await owner.notification.locator('#human-comment-draft').inputValue()).toBe('unsent webpage human draft');
  }finally{adapter?.dispose();await owner.close();await server.close();await rm(root,{recursive:true,force:true});}
});

test('comment-thread-capture allows decorative inline SVG and rejects non-decorative SVG; locateRoot allows Slate empty sentinel',async()=>{
  const root=privateTemp('p0-drift-svg-slate-'),server=await fixtureServer();
  const owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
  try{
    await mountCommentReply(owner,server.origin);
    const mapping=commentReplyMapping(server.origin);
    await owner.notification.evaluate(()=>{
      document.querySelector('#root-comment .body')!.innerHTML='root <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><path d="M0 0L12 12"/></svg>fixture input';
    });
    const event=(await owner.notification.evaluate(captureObserved,{mapping:mapping.observation,channel:'comments' as const,index:0,evidenceId:'fixture'})).events[0]!;
    expect(event.text).toBe('root fixture input');
    const thread=await owner.notification.evaluate(captureCommentThread,{mapping:mapping.observation,event,action:'inspect' as const,offset:0});
    expect(thread.total).toBe(0);
    await owner.notification.evaluate(()=>{
      document.querySelector('#root-comment .body')!.innerHTML='root <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" aria-label="icon"><path d="M0 0L12 12"/></svg>fixture input';
    });
    await expect(owner.notification.evaluate(captureCommentThread,{mapping:mapping.observation,event,action:'inspect' as const,offset:0})).rejects.toThrow('OBSERVATION_COMMENT_THREAD_CHANGED');
    // Restore decorative SVG, push root offscreen, and mount an empty Slate editor sentinel.
    await owner.notification.evaluate(()=>{
      document.querySelector('#root-comment .body')!.innerHTML='root <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><path d="M0 0L12 12"/></svg>fixture input';
      (document.querySelector('#comment-list') as HTMLElement).style.marginTop='2400px';
      const slate=document.createElement('div');slate.id='slate-sentinel';slate.setAttribute('contenteditable','true');
      slate.setAttribute('data-slate-editor','true');slate.setAttribute('data-zone-container','*');
      slate.innerHTML='<div class="ace-line" data-node="true"><span data-enter="true" data-string="true" data-leaf="true">\u200B</span></div>';
      document.body.prepend(slate);
    });
    const located=await owner.notification.evaluate(captureCommentReply,{mapping,event,action:'locateRoot' as const,text:null,token:null,before:null,shape:null});
    expect(located.rootCount).toBe(1);
    await owner.notification.evaluate(()=>{
      scrollTo(0,0);
      document.querySelector('#slate-sentinel span')!.textContent='actual human text';
    });
    await expect(owner.notification.evaluate(captureCommentReply,{mapping,event,action:'locateRoot' as const,text:null,token:null,before:null,shape:null}))
      .rejects.toThrow('COMMENT_REPLY_EXISTING_DRAFT');
  }finally{await owner.close();await server.close();await rm(root,{recursive:true,force:true});}
});

test('ObservedReader.comments waits inside the unique visible commentList and ignores hidden ancestor lists',async()=>{
  const root=privateTemp('p0-comment-list-wait-'),server=await fixtureServer();
  const owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
  try{
    const url=server.origin+'/video/10';
    await owner.notification.route(url,route=>route.fulfill({contentType:'text/html',body:`
      <a id="self">Self</a>
      <div style="opacity:0"><section id="comment-list"><div class="comment">stale hidden row</div></section></div>
      <div style="visibility:hidden"><section id="comment-list"><div class="comment">stale invisible row</div></section></div>
      <section id="comment-list" style="min-height:24px"></section>
    `}));
    await owner.notification.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>{
      Object.defineProperty(document.querySelector('#self')!,'__reactFiber$fixture',{value:{return:{memoizedProps:{uid:'100',secUid:'self-sec'}}}});
      setTimeout(()=>{
        const active=document.querySelectorAll('#comment-list')[2]!;
        const row=document.createElement('div');row.className='comment';
        row.innerHTML='<a class="author" href="/user/peer-sec">Fixture peer</a><div class="tooltip" id="tooltip_77"><span class="body">mounted visible row</span></div>';
        Object.defineProperty(row,'__reactFiber$fixture',{value:{return:{memoizedProps:{
          awemeInfo:{awemeId:'10'},userInfo:{uid:'100'},commentInfo:{cid:'77',text:'mounted visible row',createTime:Math.floor(Date.now()/1000)-5,user:{uid:'200',secUid:'peer-sec'}}}}}});
        active.append(row);
      },250);
    }));
    const batch=await new ObservedReader(owner.notification,observedMapping(server.origin)).comments(0);
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]).toMatchObject({commentId:'77',text:'mounted visible row'});
  }finally{await owner.close();await server.close();await rm(root,{recursive:true,force:true});}
});

test('bidirectional 2000ms clock skew accepts +1000ms server-ahead replies in DM and comment readback while rejecting +3000ms',async()=>{
  const root=privateTemp('p0-bidirectional-skew-'),server=await fixtureServer();
  const owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
  let dmAdapter:ObservedDmReply|undefined,commentAdapter:ObservedCommentReply|undefined;
  try{
    await mountDmReply(owner,server.origin);
    const dmMap=dmReplyMapping(server.origin);
    const dmEvent=(await new ObservedReader(owner.dm,dmMap.observation).dm(0)).events[0]!;
    const boundary=new Date(Date.now()-500).toISOString(),replyText='slow-local-clock reply';
    await owner.dm.evaluate(({replyText,at})=>sessionStorage.setItem('native-receipt',JSON.stringify({id:'910',text:replyText,createdAt:at,clicks:0})),
      {replyText,at:new Date(Date.now()+1000).toISOString()});
    await owner.dm.reload({waitUntil:'domcontentloaded'});
    dmAdapter=new ObservedDmReply(owner.dm,dmMap,400);
    const dmProof=await dmAdapter.verifyExisting(dmEvent,replyText,boundary);
    expect(dmProof).toMatchObject({id:'910',text:replyText});
    await owner.dm.evaluate(({replyText,at})=>sessionStorage.setItem('native-receipt',JSON.stringify({id:'911',text:replyText,createdAt:at,clicks:0})),
      {replyText,at:new Date(Date.now()+5000).toISOString()});
    await owner.dm.reload({waitUntil:'domcontentloaded'});
    await expect(dmAdapter.verifyExisting(dmEvent,replyText,boundary)).rejects.toThrow('NATIVE_REPLY_WINDOW_UNVERIFIED');
    expect(await dmAdapter.readback(dmEvent,replyText,[],boundary)).toBeNull();

    await mountCommentReply(owner,server.origin);
    const cmMap=commentReplyMapping(server.origin);
    const cmEvent=(await owner.notification.evaluate(captureObserved,{mapping:cmMap.observation,channel:'comments' as const,index:0,evidenceId:'fixture'})).events[0]!;
    const aheadSec=Math.floor((Date.now()+1000)/1000);
    await owner.notification.evaluate(({replyText,aheadSec})=>{
      const rootRow=document.querySelector('#root-comment')!,info=Object.getOwnPropertyDescriptor(rootRow,'__reactFiber$fixture')!.value.return.memoizedProps.commentInfo;
      const reply={cid:'920',replyId:'11',text:replyText,createTime:aheadSec,status:1,user:{uid:'100',secUid:'self-sec'}};
      info.replyComment=[reply];info.replyTotal=1;
      const child=document.createElement('div');child.className='comment';
      Object.defineProperty(child,'__reactFiber$fixture',{value:{return:{memoizedProps:{level:2,levelOneCid:'11',awemeInfo:{awemeId:'10'},commentInfo:reply}}}});
      child.innerHTML='<a class="author" href="/user/self-sec">Self</a><div class="body"></div><div class="tooltip" id="tooltip_920">Actions</div>';
      child.querySelector('.body')!.textContent=replyText;rootRow.append(child);
    },{replyText,aheadSec});
    commentAdapter=new ObservedCommentReply(owner.notification,cmMap,400);
    const cmProof=await commentAdapter.readback(cmEvent,replyText,[],boundary);
    expect(cmProof).toMatchObject({id:'920',text:replyText});
  }finally{dmAdapter?.dispose();commentAdapter?.dispose();await owner.close();await server.close();await rm(root,{recursive:true,force:true});}
});

test('headless BrowserProfileOwner auto-closes unexpected popup orphan pages while allowing explicit context.newPage',async()=>{
  const root=privateTemp('p0-orphan-popup-'),server=await fixtureServer();
  const owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
  try{
    await owner.open(server.origin);
    await owner.notification.setContent('<a id="ext" target="_blank" rel="noopener" href="about:blank">open</a>');
    const closedPopups:Promise<void>[]=[];
    owner.context.on('page',page=>{
      if(page!==owner.notification&&page!==owner.dm&&closedPopups.length<2)
        closedPopups.push(new Promise<void>(resolve=>{if(page.isClosed())resolve();else page.once('close',()=>resolve());}));
    });
    await owner.notification.click('#ext');
    await owner.notification.evaluate(()=>window.open('about:blank','_blank','noopener'));
    await expect.poll(()=>closedPopups.length,{timeout:3000}).toBe(2);
    await Promise.all(closedPopups);
    expect(owner.context.pages()).toEqual([owner.notification,owner.dm]);
    const explicit=await owner.context.newPage();
    expect(owner.context.pages()).toHaveLength(3);
    await explicit.close();
  }finally{await owner.close();await server.close();await rm(root,{recursive:true,force:true});}
});

test('ManualRecovery.frame disposes every ElementHandle and JSHandle when mid-loop evaluation throws',async()=>{
  const disposed:string[]=[];
  const makeHandle=(id:string,behavior:'ok'|'throw'|'remaining'):JSHandle=>{
    const handle={
      asElement:()=>behavior==='remaining'&&id==='length'?null:handle,
      evaluate:vi.fn(async()=>{
        if(behavior==='throw')throw new Error('SYNTHETIC_INSPECT_ERROR');
        return{documentMatches:true,region:{x:10,y:10,width:100,height:100},permitted:true};
      }),
      contentFrame:vi.fn(async()=>null),
      dispose:vi.fn(async()=>{disposed.push(id);}),
    };
    return handle as unknown as JSHandle;
  };
  const h0=makeHandle('0','ok'),h1=makeHandle('1','throw'),h2=makeHandle('2','remaining'),hLen=makeHandle('length','remaining');
  const arrayHandle={
    getProperties:vi.fn(async()=>new Map([['0',h0],['1',h1],['2',h2],['length',hLen]])),
    dispose:vi.fn(async()=>{disposed.push('array');}),
  };
  const page={
    isClosed:()=>false,
    mainFrame:()=>({}),
    on:vi.fn(),once:vi.fn(),off:vi.fn(),
    mouse:{move:vi.fn(async()=>{}),up:vi.fn(async()=>{})},
    evaluate:vi.fn(async()=>({href:'https://fixture.invalid/work',started:1000,width:1280,height:720})),
    evaluateHandle:vi.fn(async()=>arrayHandle),
  } as unknown as Page;
  const owner={actor:new AccountActor(),notification:page,dm:page} as BrowserProfileOwner;
  const recovery=new ManualRecovery();
  try{
    const session=await recovery.start(owner,{channel:'COMMENT_NOTIFICATION',epoch:1,incidentId:'inc',revision:'rev',
      document:{href:'https://fixture.invalid/work',started:1000},selectors:['#captcha'],check:()=>{}});
    await expect(recovery.frame(session.sessionId,()=>{})).rejects.toThrow('SYNTHETIC_INSPECT_ERROR');
    expect(disposed.sort()).toEqual(['0','1','2','array','length']);
  }finally{await recovery.shutdown();}
});
