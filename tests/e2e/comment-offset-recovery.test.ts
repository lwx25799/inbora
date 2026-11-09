import {expect,test} from 'vitest';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {ObservedReader,type ObservationBatch} from '../../src/adapters/observed-reader.js';
import {InboxCollector} from '../../src/app/inbox-collector.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {fixtureServer} from '../fixtures/site.js';
import {observedMapping} from '../fixtures/observed-site.js';
import {database,privateTemp} from '../helpers.js';

async function fixture(terminal?:boolean,belowFold=false){
  const root=privateTemp('comment-restore-guard-'),server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(root,'profile'),true),page=owner.notification;
  const mapping=observedMapping(server.origin),origin=Date.now()-60_000;
  await page.route(server.origin+'/video/*',route=>route.fulfill({contentType:'text/html',body:
    '<style>body{margin:0}#self{display:block;height:24px}#viewport{height:400px;overflow-y:auto;width:500px}.comment{height:120px}</style><a id="self">Self</a>'+
    (belowFold?'<div style="height:818px">synthetic video area</div>':'')+'<div id="viewport"><section id="comment-list"></section></div>'}));
  await page.route(server.origin+'/aweme/v1/web/comment/list/**',route=>route.fulfill({contentType:'application/json',body:
    JSON.stringify({status_code:0,total:10,has_more:terminal===true?0:1,cursor:10,comments:[]})}));
  await page.addInitScript(({origin,response})=>document.addEventListener('DOMContentLoaded',()=>{
    Object.defineProperty(document.querySelector('#self')!,'__reactFiber$fixture',{value:{return:{memoizedProps:{uid:'100',secUid:'self-sec'}}}});
    for(let index=0;index<10;index++){
      const row=document.createElement('div'),id=String(1000+index),text='guard root '+id;row.className='comment';
      row.innerHTML='<a class="author" href="/user/peer-sec">Peer</a><div class="body">'+text+'</div><div class="tooltip" id="tooltip_'+id+'">Actions</div>';
      Object.defineProperty(row,'__reactFiber$fixture',{value:{return:{memoizedProps:{level:1,userInfo:{uid:'100'},awemeInfo:{awemeId:'10'},
        commentInfo:{cid:id,replyId:'0',replyTotal:0,text,createTime:(origin+1000)/1000,user:{uid:'200',secUid:'peer-sec'},status:1}}}}});
      document.querySelector('#comment-list')!.append(row);
    }
    if(response){let emitted=false;document.querySelector('#viewport')!.addEventListener('scroll',()=>{
      if(!emitted){emitted=true;void fetch('/aweme/v1/web/comment/list/?aweme_id=10&cursor=0');}
    });}
  }),{origin,response:terminal!==undefined});
  await page.goto(server.origin+'/video/10');
  return{root,owner,page,mapping,origin,close:async()=>{await owner.close();await server.close();}};
}

test.each(['cancel','account','draft'] as const)('every restore window stops for %s without mutating the protected editor or accepting another window',async action=>{
  const f=await fixture(),abort=new AbortController(),persisted:ObservationBatch[]=[];
  try{
    const reader=new ObservedReader(f.page,f.mapping,undefined,abort.signal);
    await expect(reader.comments(0,true,20_000,{holdScroll:true,stay:false,onRestoreWindow:async batch=>{
      persisted.push(batch);
      if(action==='cancel')abort.abort();
      if(action==='account')await f.page.evaluate(()=>{Object.getOwnPropertyDescriptor(document.querySelector('#self')!,'__reactFiber$fixture')!.value.return.memoizedProps.uid='999';});
      if(action==='draft')await f.page.evaluate(()=>{const input=document.createElement('textarea');input.value='keep synthetic human draft';document.body.append(input);});
    }})).rejects.toThrow({cancel:'OBSERVATION_CANCELLED',account:'OBSERVATION_ACCOUNT_CHANGED',draft:'OBSERVATION_EXISTING_HUMAN_INPUT'}[action]);
    expect(persisted).toHaveLength(1);expect(await f.page.locator('#viewport').evaluate(node=>node.scrollTop)).toBe(0);
    if(action==='draft')expect(await f.page.locator('textarea').inputValue()).toBe('keep synthetic human draft');
  }finally{await f.close();}
});

test.each([true,false])('a below-fold list is revealed before restoring the prefix, cross-work=%s',async crossWork=>{
  const f=await fixture(undefined,true),persisted:ObservationBatch[]=[];
  try{
    if(crossWork)await f.page.goto(f.mapping.origin+'/video/20');
    expect((await f.page.locator('#comment-list').boundingBox())!.y).toBeGreaterThan(await f.page.evaluate(()=>innerHeight));
    await f.owner.actor.run(async()=>{
      await f.page.bringToFront();
      const batch=await new ObservedReader(f.page,f.mapping).comments(0,true,800,{holdScroll:true,stay:false,onRestoreWindow:async window=>{persisted.push(window);}});
      expect(batch.scroll?.top).toBe(800);expect(batch.commentRestoreIncomplete).toBeUndefined();
    });
    expect(persisted[0]!.events.map(event=>event.commentId)).toContain('1000');
    expect(await f.page.evaluate(()=>scrollY)).toBeGreaterThan(0);
  }finally{await f.close();}
});

test('native bottom scroll is delivered through the real reader without a collector wrapper',async()=>{
  const f=await fixture(),errors:string[]=[],navigation:string[]=[];f.page.on('pageerror',error=>errors.push(error.message));f.page.on('framenavigated',frame=>navigation.push(frame.url()));
  try{
    await f.page.evaluate(()=>{const viewport=document.querySelector('#viewport') as HTMLElement;
      (window as unknown as {trace:number[]}).trace=[];
      viewport.addEventListener('scroll',()=>{(window as unknown as {trace:number[]}).trace.push(viewport.scrollTop);if(viewport.scrollTop>=viewport.scrollHeight-viewport.clientHeight-1)
        setTimeout(()=>{const filler=document.createElement('div');filler.style.height='1200px';document.querySelector('#comment-list')!.append(filler);},20);});
    });
    const batch=await new ObservedReader(f.page,f.mapping).comments(0,true,800,{holdScroll:true,stay:true});
    const trace=await f.page.evaluate(()=>(window as unknown as {trace:number[]}).trace);
    expect(batch.scroll,JSON.stringify({errors,navigation,trace})).toMatchObject({top:800,height:2400});
  }finally{await f.close();}
});

test.each([undefined,false,true])('a shrunk native end can replace old geometry only with the normal terminal response (%s)',async terminal=>{
  const f=await fixture(terminal),store=database();
  try{
    await migrateClient(store,join(f.root,'client.sqlite'));await migrateAutomation(store,join(f.root,'automation.sqlite'));
    const data=new AutomationStore(store);data.initialize(f.origin);store.bindAccount('100');
    data.configureCollection({ownId:'100',comments:true,inbox:false,commentIntervalMs:30_000,dmIntervalMs:30_000});
    store.db.prepare("INSERT INTO work_collection_progress VALUES('10',20000,24000,0,0,NULL,0)").run();
    store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='works'").run(JSON.stringify({phase:'comments',pendingRootPages:['10']}));
    const collector=new InboxCollector(f.owner,f.mapping,data,f.root,'headless');
    try{await collector.collect('works',new AbortController().signal);}finally{collector.dispose();}
    const progress=store.db.prepare("SELECT scroll_top,last_height,end_observations,last_read,last_error FROM work_collection_progress WHERE work_id='10'").get();
    if(terminal===true){
      expect(progress).toMatchObject({scroll_top:800,last_height:1200,end_observations:0,last_error:null});
      expect((progress as {last_read:number}).last_read).toBeGreaterThan(0);
    }else{
      expect(progress).toEqual({scroll_top:20000,last_height:24000,end_observations:0,last_read:0,last_error:'OBSERVATION_COMMENT_RESTORE_LIMIT'});
      const cursor=JSON.parse((store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='works'").get() as {cursor_json:string}).cursor_json);
      expect(cursor).toMatchObject({phase:'discovery',workIndex:0,headPending:['10'],pendingRootPages:['10']});
    }
    expect(store.events().some(event=>event.payload.commentId==='1009')).toBe(true);
    expect(store.budgets().map(b=>b.used)).toEqual([0,0]);expect(store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
    expect(data.state().startedAt).toBe(f.origin);
  }finally{store.close();await f.close();}
});
