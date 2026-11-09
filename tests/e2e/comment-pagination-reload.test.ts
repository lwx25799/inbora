import {expect,test,vi} from 'vitest';
import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {InboxCollector} from '../../src/app/inbox-collector.js';
import {OwnWorksDiscovery} from '../../src/adapters/own-works-discovery.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {fixtureServer} from '../fixtures/site.js';
import {observedMapping} from '../fixtures/observed-site.js';
import {database,privateTemp} from '../helpers.js';

test('fair work rotation resumes beyond a reloaded first-page height and collects the third native page',async()=>{
  const wallStarted=Date.now();let completeTurn:number|null=null;
  const root=privateTemp('comment-reload-pages-'),server=await fixtureServer(),store=database();
  const owner=await BrowserProfileOwner.launch(join(root,'profile'),true),page=owner.notification,origin=Date.now()-60_000;
  await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  let now=Date.now();const data=new AutomationStore(store,()=>now);data.initialize(origin);store.bindAccount('100');
  data.configureCollection({ownId:'100',comments:true,inbox:false,commentIntervalMs:30_000,dmIntervalMs:30_000});
  data.registerWork({id:'20',ownId:'100',url:server.origin+'/video/20',publishedAt:origin+1000,precisionMs:1});
  store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='works'").run(JSON.stringify({phase:'comments'}));
  await page.route(server.origin+'/video/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:
    '<!doctype html><title>local paged comments</title><style>body{margin:0}#self{display:block;height:24px}#viewport{height:400px;overflow-y:auto;width:500px}.comment{height:120px;box-sizing:border-box}</style><a id="self">Self</a><div id="viewport"><section id="comment-list"></section></div>'}));
  const nativeRequests:{work:string;cursor:number}[]=[];
  await page.route(server.origin+'/aweme/v1/web/comment/list/**',route=>{
    const url=new URL(route.request().url()),work=url.searchParams.get('aweme_id')!,cursor=Number(url.searchParams.get('cursor'));
    nativeRequests.push({work,cursor});
    return route.fulfill({contentType:'application/json',body:JSON.stringify({status_code:0,total:work==='10'?30:1,
      has_more:work==='10'&&cursor<20?1:0,cursor:cursor+10,comments:[]})});
  });
  await page.addInitScript(({origin})=>document.addEventListener('DOMContentLoaded',()=>{
    const self=document.querySelector('#self'),viewport=document.querySelector('#viewport') as HTMLElement|null,list=document.querySelector('#comment-list');
    if(!self||!viewport||!list)return;
    Object.defineProperty(self,'__reactFiber$fixture',{value:{return:{memoizedProps:{uid:'100',secUid:'self-sec'}}}});
    const work=location.pathname.split('/').at(-1)!,state=window as unknown as {loadedPages:number;scrollEvents:number;trace:unknown[]};
    state.loadedPages=0;state.scrollEvents=0;state.trace=[];let loading=false;
    const append=()=>{
      const start=state.loadedPages*10,end=work==='10'?start+10:1;
      for(let index=start;index<end;index++){
        const id=work==='10'?String(1000+index):'2001',text='synthetic root '+id,row=document.createElement('div');row.className='comment';
        row.innerHTML='<a class="author" href="/user/peer-sec">Peer</a><div class="body">'+text+'</div><div class="tooltip" id="tooltip_'+id+'">Actions</div>';
        Object.defineProperty(row,'__reactFiber$fixture',{value:{return:{memoizedProps:{level:1,userInfo:{uid:'100'},awemeInfo:{awemeId:work},
          commentInfo:{cid:id,replyId:'0',replyTotal:0,text,createTime:(origin+1000)/1000,user:{uid:'200',secUid:'peer-sec'},status:1}}}}});
        list.append(row);
      }
      state.loadedPages++;loading=false;
      state.trace.push({action:'append',pages:state.loadedPages,top:viewport.scrollTop});
      void fetch('/aweme/v1/web/comment/list/?aweme_id='+work+'&cursor='+start);
    };
    viewport.addEventListener('scroll',()=>{
      state.scrollEvents++;
      state.trace.push({action:'scroll',top:viewport.scrollTop,max:viewport.scrollHeight-viewport.clientHeight,loading});
      if(work==='10'&&!loading&&state.loadedPages<3&&viewport.scrollTop>=viewport.scrollHeight-viewport.clientHeight-1){
        loading=true;setTimeout(append,20);
      }
    });
    append();
  }),{origin});
  const discovery=vi.spyOn(OwnWorksDiscovery.prototype,'scan').mockResolvedValue({works:[],pending:[],complete:true});
  let collector=new InboxCollector(owner,observedMapping(server.origin),data,root,'headless');
  const rounds:unknown[]=[];
  try{
    await page.goto(server.origin+'/video/10');
    expect(await page.locator('#viewport').evaluate(node=>({height:node.scrollHeight,viewport:node.clientHeight,top:node.scrollTop})))
      .toEqual({height:1200,viewport:400,top:0});
    // Sixty bounded turns include the three remaining terminal-page viewport reads after fair work/head/discovery rotations.
    for(let turn=0;turn<60;turn++){
      now+=30_000;await collector.collect('works',new AbortController().signal);
      const progress=store.db.prepare("SELECT scroll_top,last_height,end_observations,last_read FROM work_collection_progress WHERE work_id='10'").get();
      const mounted=await page.evaluate(()=>{const viewport=document.querySelector('#viewport'),state=window as unknown as {loadedPages:number;scrollEvents:number;trace:unknown[]};
        return viewport?{work:location.pathname.split('/').at(-1),top:viewport.scrollTop,height:viewport.scrollHeight,pages:state.loadedPages,scrollEvents:state.scrollEvents,trace:state.trace,visibility:document.visibilityState}:null;});
      rounds.push({turn,progress,mounted});
      if(turn===9){collector.dispose();collector=new InboxCollector(owner,observedMapping(server.origin),new AutomationStore(store,()=>now),root,'headless');}
      if(store.events().filter(event=>event.payload.videoId==='10').length===30){completeTurn=turn+1;break;}
    }
    const ids=store.events().filter(event=>event.payload.videoId==='10').map(event=>event.payload.commentId);
    const result={rounds,nativeRequests,ids,completeTurn,wallTimeMs:Date.now()-wallStarted,
      receivedThirdPage:ids.includes('1020'),otherWorkRead:store.events().some(event=>event.payload.videoId==='20'),discoveryCalls:discovery.mock.calls.length,
      originUnchanged:data.state().startedAt===origin,budgetUsed:store.budgets().map(b=>b.used),sendIntents:store.db.prepare('SELECT count(*) n FROM send_intents').get()};
    await writeFile(join(root,'result.json'),JSON.stringify(result),{mode:0o600});
    expect(result.otherWorkRead).toBe(true);expect(result.discoveryCalls).toBeGreaterThan(0);expect(result.originUnchanged).toBe(true);
    expect(result.budgetUsed).toEqual([0,0]);expect(result.sendIntents).toEqual({n:0});
    expect(result.receivedThirdPage,JSON.stringify(rounds)).toBe(true);expect(ids).toEqual(Array.from({length:30},(_,index)=>String(1000+index)));
    expect(new Set(ids).size).toBe(ids.length);expect(completeTurn).not.toBeNull();
  }finally{collector.dispose();discovery.mockRestore();store.close();await owner.close();await server.close();}
},60_000);
