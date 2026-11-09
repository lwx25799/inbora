import {afterAll,beforeAll,expect,test,vi} from 'vitest';
import {join} from 'node:path';
import type {Page} from 'playwright';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {InboxCollector} from '../../src/app/inbox-collector.js';
import {OwnWorksDiscovery} from '../../src/adapters/own-works-discovery.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {Blocked} from '../../src/core/contracts.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {fixtureServer} from '../fixtures/site.js';
import {initializeCommentReplyFixture,observedMapping} from '../fixtures/observed-site.js';
import {database,privateTemp} from '../helpers.js';

let page:Page,owner:BrowserProfileOwner,server:Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async()=>{server=await fixtureServer();owner=await BrowserProfileOwner.launch(join(privateTemp('nested-continuation-browser-'),'profile'),true);});
afterAll(async()=>{await owner?.close();await server?.close();});

async function fixture(options:{total?:number;pageSize?:number;draft?:boolean;duplicate?:boolean;wrongRoot?:boolean;lateMount?:boolean;growDuringExpand?:boolean;continuousGrowth?:boolean;missingTotal?:boolean;transparentTooltip?:boolean}={}){
  page=await owner.context.newPage();
  const scopedOwner={notification:page,dm:owner.dm,actor:owner.actor,version:()=>owner.version()} as BrowserProfileOwner;
  const total=options.total??2,pageSize=options.pageSize??total,origin=Date.now()-60_000;
  await page.route(server.origin+'/video/10',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:
    '<a id="self">Self</a><section id="comment-list"><div class="comment" id="root-comment"><a class="author" href="/user/peer-sec">Peer</a><div class="body">root fixture input</div><div class="tooltip" id="tooltip_11">Actions</div><button class="reply-action">回复</button><button class="expand">展开'+total+'条回复</button></div></section>'}));
  await page.addInitScript({content:`document.addEventListener('DOMContentLoaded',()=>{(${initializeCommentReplyFixture.toString()})();});`});
  await page.addInitScript(({total,pageSize,options,origin})=>document.addEventListener('DOMContentLoaded',()=>{
    const root=document.querySelector('#root-comment');if(!root)return;
    const info=Object.getOwnPropertyDescriptor(root,'__reactFiber$fixture')!.value.return.memoizedProps.commentInfo;
    info.replyTotal=total;const state=window as unknown as {expands:number;nativeWrites:number};state.expands=0;state.nativeWrites=0;
    let count=0;
    const append=()=>{
      const end=Math.min(total,count+pageSize);
      for(;count<end;count++){
        const child=document.createElement('div');child.className='comment';const id=String(1000+count),own=count===total-1;
        const text='synthetic child '+count,at=count===0?origin-2000:origin+1000+count;
        child.innerHTML='<a class="author" href="/user/'+(own?'self-sec':'child-sec')+'">Child</a><div class="body">'+text+'</div><div class="tooltip" id="tooltip_'+id+'">Actions</div>';
        Object.defineProperty(child,'__reactFiber$fixture',{value:{return:{memoizedProps:{level:2,levelOneCid:'11',awemeInfo:{awemeId:'10'},
          commentInfo:{cid:id,text,replyId:options.wrongRoot?'12':'11',createTime:at/1000,user:{uid:own?'100':'201',secUid:own?'self-sec':'child-sec'},status:1}}}}});
        root.append(child);
      }
      if(count>=total)root.querySelectorAll('.expand').forEach(n=>n.remove());
    };
    const bind=(button:Element)=>button.addEventListener('click',()=>{state.expands++;if(options.lateMount)return;append();
      if(options.growDuringExpand||options.continuousGrowth){const extra=root.querySelector('.comment')!.cloneNode(true) as Element,id=options.continuousGrowth?String(9000+state.expands):'9999';
        extra.querySelector('.author')!.setAttribute('href','/user/self-sec');extra.querySelector('.body')!.textContent='new own reply';extra.querySelector('.tooltip')!.id='tooltip_'+id;
        Object.defineProperty(extra,'__reactFiber$fixture',{value:{return:{memoizedProps:{level:2,levelOneCid:'11',awemeInfo:{awemeId:'10'},
          commentInfo:{cid:id,replyId:'11',text:'new own reply',createTime:(origin+2000)/1000,user:{uid:'100',secUid:'self-sec'},status:1}}}}});
        root.append(extra);info.replyTotal=total+(options.continuousGrowth?state.expands:1);
        if(options.continuousGrowth){const next=document.createElement('button');next.className='expand';next.textContent='展开1条回复';root.append(next);bind(next);}}
    });
    const button=root.querySelector('.expand')!;bind(button);
    if(options.missingTotal){delete info.replyTotal;button.remove();}
    if(options.transparentTooltip)(root.querySelector('.tooltip') as HTMLElement).style.opacity='0';
    if(options.duplicate){const copy=button.cloneNode(true);root.append(copy);bind(copy as Element);}
    if(options.draft){const draft=document.createElement('textarea');draft.value='keep webpage draft';document.body.append(draft);}
  }),{total,pageSize,options,origin});
  await page.goto(server.origin+'/video/10');
  const root=privateTemp('nested-continuation-db-'),store=database();await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  let now=Date.now();const data=new AutomationStore(store,()=>now);data.initialize(origin);store.bindAccount('100');
  data.configureCollection({ownId:'100',comments:true,inbox:false,commentIntervalMs:15_000,dmIntervalMs:15_000});
  store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='works'").run(JSON.stringify({phase:'comments'}));
  let collector=new InboxCollector(scopedOwner,observedMapping(server.origin),data,root,'headless');
  return {store,data,origin,step:()=>collector.collect('works',new AbortController().signal),tick:()=>{now+=120_001;},
    restart:()=>{collector.dispose();collector=new InboxCollector(scopedOwner,observedMapping(server.origin),data,root,'headless');},
    close:async()=>{collector.dispose();store.close();await page.close();}};
}

test('a collapsed thread is collected automatically with no page sync, own replies count coverage and old children stay baseline',async()=>{
  const f=await fixture({total:3});try{
    await f.step();
    expect(await page.evaluate(()=>(window as unknown as {expands:number}).expands)).toBe(1);
    expect(f.store.events().filter(e=>e.payload.kind==='REPLY')).toHaveLength(2);
    expect(f.store.events().find(e=>e.payload.commentId==='1000')?.status).toBe('BASELINE');
    expect(f.store.events().find(e=>e.payload.commentId==='1001')?.status).toBe('AWAITING_DRAFT');
    expect(f.store.events().some(e=>e.payload.actorId==='100')).toBe(false);
    const saved=JSON.parse((f.store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='works'").get() as {cursor_json:string}).cursor_json);
    expect(saved.commentThreads[0]).toMatchObject({workId:'10',id:'11',done:true,seen:['1000','1001','1002']});
    expect(f.store.budget('MODEL').used).toBe(0);expect(f.store.budget('SEND').used).toBe(0);
    expect((f.store.db.prepare('SELECT count(*) n FROM send_intents').get() as {n:number}).n).toBe(0);
  }finally{await f.close();}
});

test('a completed hidden thread is rescanned after restart when deletion plus a new reply keeps the same total',async()=>{
  const f=await fixture({total:3});try{
    await f.step();const first=JSON.parse((f.store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='works'").get() as {cursor_json:string}).cursor_json);
    expect(first.commentThreads[0]).toMatchObject({done:true,total:3});
    await page.addInitScript(origin=>document.addEventListener('DOMContentLoaded',()=>{
      document.querySelector('#root-comment .expand')!.addEventListener('click',()=>{
        const replaced=document.querySelector('#root-comment .comment')!,native=Object.getOwnPropertyDescriptor(replaced,'__reactFiber$fixture')!.value.return.memoizedProps.commentInfo;
        native.cid='8888';native.text='new exact replacement';native.createTime=(origin+5000)/1000;
        replaced.querySelector('.body')!.textContent=native.text;replaced.querySelector('.tooltip')!.id='tooltip_8888';
      });
    }),f.origin);
    f.tick();f.restart();await f.step();
    expect(f.store.events().find(event=>event.payload.commentId==='8888')).toMatchObject({payload:{text:'new exact replacement'}});
    expect(f.store.events().filter(event=>event.payload.commentId==='8888')).toHaveLength(1);
    expect(f.data.state().startedAt).toBe(f.origin);expect(f.store.budgets().map(b=>b.used)).toEqual([0,0]);
  }finally{await f.close();}
});

test('a continuously growing root yields to another hidden root, another work and new-work discovery without completing its own checkpoint',async()=>{
  const f=await fixture({total:2,continuousGrowth:true});let discovery:ReturnType<typeof vi.spyOn>|undefined;
  try{
    await page.addInitScript(origin=>document.addEventListener('DOMContentLoaded',()=>{
      if(!location.pathname.endsWith('/video/10'))return;
      const root=document.createElement('div');root.className='comment';root.id='other-root';
      root.innerHTML='<a class="author" href="/user/peer-sec">Peer</a><div class="body">other exact root</div><div class="tooltip" id="tooltip_12">Actions</div><button>展开1条回复</button>';
      Object.defineProperty(root,'__reactFiber$fixture',{value:{return:{memoizedProps:{level:1,userInfo:{uid:'100'},awemeInfo:{awemeId:'10'},
        commentInfo:{cid:'12',replyId:'0',replyTotal:1,replyComment:[],text:'other exact root',createTime:(origin+1000)/1000,user:{uid:'200',secUid:'peer-sec'},status:1}}}}});
      root.querySelector('button')!.addEventListener('click',()=>{
        const row=document.createElement('div');row.className='comment';row.innerHTML='<a class="author" href="/user/child-sec">Child</a><div class="body">other hidden child</div><div class="tooltip" id="tooltip_7777">Actions</div>';
        Object.defineProperty(row,'__reactFiber$fixture',{value:{return:{memoizedProps:{level:2,levelOneCid:'12',awemeInfo:{awemeId:'10'},
          commentInfo:{cid:'7777',replyId:'12',text:'other hidden child',createTime:(origin+2000)/1000,user:{uid:'201',secUid:'child-sec'},status:1}}}}});root.append(row);root.querySelector('button')!.remove();
      });document.querySelector('#comment-list')!.append(root);
    }),f.origin);await page.reload({waitUntil:'domcontentloaded'});
    for(const id of ['20','30'])await page.route(server.origin+'/video/'+id,route=>route.fulfill({contentType:'text/html',body:
      `<a id="self">Self</a><section id="comment-list"><div class="comment" id="root-comment"><a class="author" href="/user/peer-sec">Peer</a><div class="body">root fixture input</div><div class="tooltip" id="tooltip_${id}">Actions</div></div></section><script>document.addEventListener('DOMContentLoaded',()=>{const p=Object.getOwnPropertyDescriptor(document.querySelector('#root-comment'),'__reactFiber$fixture').value.return.memoizedProps;p.awemeInfo.awemeId='${id}';p.commentInfo.cid='${id}';p.commentInfo.replyTotal=0;});</script>`}));
    f.data.registerWork({id:'20',ownId:'100',url:server.origin+'/video/20',publishedAt:f.origin+1000,precisionMs:1});
    discovery=vi.spyOn(OwnWorksDiscovery.prototype,'scan').mockResolvedValue({complete:true,pending:[],works:[{id:'30',ownId:'100',url:server.origin+'/video/30',publishedAt:f.origin+2000,precisionMs:1}]});
    await f.step();const initial=JSON.parse((f.store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='works'").get() as {cursor_json:string}).cursor_json);
    expect(initial.commentThreads.find((thread:{id:string})=>thread.id==='11').done).toBe(false);f.restart();
    // Two A windows, two work-20 passes, discovery, then the same bounded rotation reaches new work 30 within ten turns.
    for(let round=0;round<9;round++)await f.step();
    expect(f.store.events().some(event=>event.payload.commentId==='7777')).toBe(true);
    expect(f.store.events().some(event=>event.payload.videoId==='20')).toBe(true);expect(discovery).toHaveBeenCalled();
    expect(f.store.events().some(event=>event.payload.videoId==='30'),JSON.stringify(f.store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='works'").get())).toBe(true);
    const final=JSON.parse((f.store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='works'").get() as {cursor_json:string}).cursor_json);
    expect(final.commentThreads.find((thread:{id:string})=>thread.id==='11')).toMatchObject({done:false});
    expect((f.store.db.prepare('SELECT last_read FROM work_collection_progress WHERE work_id=?').get('10') as {last_read:number}).last_read).toBe(0);
    expect(f.data.state().startedAt).toBe(f.origin);expect(f.store.budgets().map(b=>b.used)).toEqual([0,0]);
    expect((f.store.db.prepare('SELECT count(*) n FROM send_intents').get() as {n:number}).n).toBe(0);
  }finally{discovery?.mockRestore();await f.close();}
});

test.each(['OBSERVATION_CANCELLED','OBSERVATION_COMMENT_SCROLL_UNAVAILABLE'])('the two-window rotation is checkpointed before an advance fails: %s',async code=>{
  const f=await fixture({total:2,continuousGrowth:true});let advance:ReturnType<typeof vi.spyOn>|undefined;
  try{
    await f.step();const read=()=>JSON.parse((f.store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='works'").get() as {cursor_json:string}).cursor_json);
    expect(read().threadBurst).toBe(1);advance=vi.spyOn(ObservedReader.prototype,'advanceComments').mockRejectedValue(new Blocked(code));
    await expect(f.step()).rejects.toThrow(code);expect(advance).toHaveBeenCalledTimes(1);advance.mockRestore();
    const saved=read();expect(saved).toMatchObject({phase:'discovery',workIndex:0,threadBurst:0});
    expect(saved.commentThreads[0]).toMatchObject({done:false,turn:2,offset:4});expect(saved.commentThreads[0].seen).toHaveLength(4);
    f.restart();expect(read()).toEqual(saved);
    expect((f.store.db.prepare('SELECT last_read FROM work_collection_progress WHERE work_id=?').get('10') as {last_read:number}).last_read).toBe(0);
    expect(f.data.state().startedAt).toBe(f.origin);expect(f.store.budgets().map(b=>b.used)).toEqual([0,0]);
  }finally{advance?.mockRestore();await f.close();}
});

test('more than one hundred children continue across bounded windows and collector restart without duplicate tasks',async()=>{
  const f=await fixture({total:105,pageSize:105});try{
    await f.step();const first=f.store.events().filter(e=>e.payload.kind==='REPLY');expect(first).toHaveLength(100);
    const read=(f.store.db.prepare('SELECT last_read FROM work_collection_progress WHERE work_id=?').get('10') as {last_read:number}).last_read;
    expect(read).toBe(0);f.restart();await f.step();
    expect(f.store.events().filter(e=>e.payload.kind==='REPLY')).toHaveLength(104);
    const saved=JSON.parse((f.store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='works'").get() as {cursor_json:string}).cursor_json);
    expect(saved.commentThreads[0].seen).toHaveLength(105);expect(saved.commentThreads[0].done).toBe(true);
    expect((f.store.db.prepare('SELECT count(*) n FROM source_collisions').get() as {n:number}).n).toBe(0);
  }finally{await f.close();}
});

test('a transparent native tooltip remains usable for exact root identity without requiring its hover menu',async()=>{
  const f=await fixture({transparentTooltip:true});try{
    await f.step();expect(f.store.events().some(e=>e.payload.kind==='REPLY')).toBe(true);
    expect(await page.evaluate(()=>(window as unknown as {expands:number}).expands)).toBe(1);
  }finally{await f.close();}
});

test('one native page per turn and a collapsed page after restart retain prior child IDs and eventually finish',async()=>{
  const f=await fixture({total:9,pageSize:3}),discovery=vi.spyOn(OwnWorksDiscovery.prototype,'scan').mockResolvedValue({works:[],pending:[],complete:true});try{
    await f.step();expect(await page.evaluate(()=>(window as unknown as {expands:number}).expands)).toBe(1);
    f.restart();await page.reload({waitUntil:'domcontentloaded'});
    for(let round=0;round<6;round++){
      const cursor=JSON.parse((f.store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='works'").get() as {cursor_json:string}).cursor_json);
      if(cursor.commentThreads[0].done)break;
      const before=await page.evaluate(()=>(window as unknown as {expands:number}).expands);await f.step();
      expect(await page.evaluate(()=>(window as unknown as {expands:number}).expands)).toBe(before+(cursor.phase==='comments'?1:0));
    }
    const saved=JSON.parse((f.store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='works'").get() as {cursor_json:string}).cursor_json);
    expect(saved.commentThreads[0]).toMatchObject({done:true,total:9});expect(saved.commentThreads[0].seen).toHaveLength(9);
    expect(f.store.events().filter(e=>e.payload.kind==='REPLY')).toHaveLength(8);
    expect((f.store.db.prepare('SELECT count(*) n FROM source_collisions').get() as {n:number}).n).toBe(0);
  }finally{discovery.mockRestore();await f.close();}
});

test('wrong child parent stays a manual task while the valid root survives and completion is forbidden',async()=>{
  const f=await fixture({wrongRoot:true});try{
    await expect(f.step()).rejects.toThrow('OBSERVATION_COMMENT_THREAD_INCOMPLETE');
    expect(f.store.events().find(e=>e.payload.commentId==='11')?.status).toBe('BASELINE');
    expect(f.store.events().find(e=>e.payload.commentId==='1000')).toMatchObject({status:'BASELINE',payload:{observationIssue:'COMMENT_PARENT_UNVERIFIED'}});
    expect((f.store.db.prepare('SELECT last_read FROM work_collection_progress WHERE work_id=?').get('10') as {last_read:number}).last_read).toBe(0);
  }finally{await f.close();}
});

test('a new own reply changing total during expand requires a fresh stable count without resetting seen native IDs',async()=>{
  const f=await fixture({total:3,growDuringExpand:true});try{
    await f.step();let saved=JSON.parse((f.store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='works'").get() as {cursor_json:string}).cursor_json);
    expect(saved.commentThreads[0]).toMatchObject({total:4,done:false});expect(saved.commentThreads[0].seen).toHaveLength(4);
    expect((f.store.db.prepare('SELECT last_read FROM work_collection_progress WHERE work_id=?').get('10') as {last_read:number}).last_read).toBe(0);
    await f.step();saved=JSON.parse((f.store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='works'").get() as {cursor_json:string}).cursor_json);
    expect(saved.commentThreads[0]).toMatchObject({total:4,done:true});expect(saved.commentThreads[0].seen).toHaveLength(4);
    expect(f.store.events().some(e=>e.payload.commentId==='9999')).toBe(false);
  }finally{await f.close();}
});

test('a stalled thread defers only its work and another included work keeps collecting',async()=>{
  const f=await fixture({lateMount:true});try{
    await page.route(server.origin+'/video/20',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:
      `<a id="self">Self</a><section id="comment-list"><div class="comment" id="root-comment"><a class="author" href="/user/peer-sec">Peer</a><div class="body">root fixture input</div><div class="tooltip" id="tooltip_12">Actions</div><button class="reply-action">回复</button></div></section><script>
      document.addEventListener('DOMContentLoaded',()=>{const p=Object.getOwnPropertyDescriptor(document.querySelector('#root-comment'),'__reactFiber$fixture').value.return.memoizedProps;
      p.awemeInfo.awemeId='20';p.commentInfo.cid='12';p.commentInfo.replyTotal=0;});</script>`}));
    f.data.registerWork({id:'20',ownId:'100',url:server.origin+'/video/20',publishedAt:f.origin+1000,precisionMs:1});
    await f.step();await expect(f.step()).rejects.toThrow('OBSERVATION_COMMENT_THREAD_INCOMPLETE');
    await f.step();expect(f.store.events().some(e=>e.payload.videoId==='20')).toBe(true);
    expect((f.store.db.prepare('SELECT last_read FROM work_collection_progress WHERE work_id=?').get('10') as {last_read:number}).last_read).toBe(0);
    expect((f.store.db.prepare('SELECT last_read FROM work_collection_progress WHERE work_id=?').get('20') as {last_read:number}).last_read).toBeGreaterThan(0);
  }finally{await f.close();}
});

test.each([{duplicate:true,code:'OBSERVATION_COMMENT_EXPAND_NOT_UNIQUE'},{lateMount:true,code:'OBSERVATION_COMMENT_THREAD_INCOMPLETE'},
  {draft:true,code:'OBSERVATION_EXISTING_HUMAN_INPUT'},{missingTotal:true,code:'OBSERVATION_COMMENT_THREAD_METADATA_NOT_READY'}])('unsafe or still-unmounted child thread stays unfinished: $code',async options=>{
  const f=await fixture(options);try{
    if(options.lateMount)await f.step();
    await expect(f.step()).rejects.toThrow(options.code);
    expect(f.store.events().filter(e=>e.payload.kind==='REPLY')).toEqual([]);
    expect((f.store.db.prepare('SELECT last_read FROM work_collection_progress WHERE work_id=?').get('10') as {last_read:number}).last_read).toBe(0);
    if(options.draft)expect(await page.locator('textarea').inputValue()).toBe('keep webpage draft');
  }finally{await f.close();}
});
