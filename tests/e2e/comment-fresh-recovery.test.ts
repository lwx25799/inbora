import {expect,test} from 'vitest';
import {rm} from 'node:fs/promises';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {observedMapping} from '../fixtures/observed-site.js';
import {privateTemp,database} from '../helpers.js';
import {InboxCollector} from '../../src/app/inbox-collector.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';

const collection={holdScroll:true,stay:false,freshWithinMs:30_000};

async function fixture(){
  const root=privateTemp('comment-fresh-recovery-'),origin='https://www.douyin.com';
  const owner=await BrowserProfileOwner.launch(join(root,'profile'),true),mapping=observedMapping(origin);
  mapping.works.push({id:'20',url:origin+'/video/20'});
  let navigations=0,rootResponses=0,nextId='11';
  const at=Math.floor(Date.now()/1000)-1;
  await owner.context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/aweme/v1/web/comment/list/'){
      rootResponses++;
      return route.fulfill({contentType:'application/json',body:JSON.stringify({status_code:0,total:1,has_more:0,cursor:1,
        comments:[{cid:nextId,text:'synthetic '+nextId,create_time:at,user:{uid:'200',sec_uid:'peer-sec'}}]})});
    }
    if(route.request().isNavigationRequest()&&route.request().frame()===owner.notification.mainFrame())navigations++;
    const work=url.pathname==='/video/20'?'20':'10',id=nextId;
    return route.fulfill({contentType:'text/html; charset=utf-8',body:
      '<!doctype html><title>Synthetic fresh recovery</title><a id="self">Self</a>'+
      '<section id="comment-list" style="width:480px;min-height:120px"><div class="comment">'+
      '<a class="author" href="/user/peer-sec">Synthetic peer</a><div class="body">synthetic '+id+'</div>'+
      '<div class="tooltip" id="tooltip_'+id+'">Actions</div></div></section><script>'+
      'Object.defineProperty(document.querySelector("#self"),"__reactFiber$fixture",{value:{return:{memoizedProps:{uid:"100",secUid:"self-sec"}}}});'+
      'Object.defineProperty(document.querySelector(".comment"),"__reactFiber$fixture",{value:{return:{memoizedProps:{'+
      'commentInfo:{cid:'+JSON.stringify(id)+',text:'+JSON.stringify('synthetic '+id)+',user:{uid:"200",secUid:"peer-sec"},'+
      'createTime:'+at+',replyId:"0",replyTotal:0,status:1,replyComment:[]},level:1,awemeInfo:{awemeId:'+JSON.stringify(work)+'},userInfo:{uid:"100"}}}}});'+
      'fetch("/aweme/v1/web/comment/list/?aweme_id='+work+'&cursor=0").then(r=>r.json()).then(()=>window.syntheticResponseReady=true);'+
      '</script>'});
  });
  await owner.notification.goto(mapping.works[0]!.url,{waitUntil:'domcontentloaded'});
  await owner.notification.waitForFunction(()=>(window as unknown as {syntheticResponseReady:boolean}).syntheticResponseReady);
  return {root,origin,owner,mapping,get navigations(){return navigations;},get rootResponses(){return rootResponses;},
    setNext:(id:string)=>{nextId=id;},reader:()=>new ObservedReader(owner.notification,mapping),
    close:async()=>{await owner.close();await rm(root,{recursive:true});}};
}

test('the first collection reuses the fresh exact work, while every later turn still refreshes new comments',async()=>{
  const f=await fixture();
  try{
    const first=await f.reader().comments(0,true,0,collection);
    expect(first.events.map(event=>event.commentId)).toEqual(['11']);
    expect(first.events[0]).toMatchObject({videoId:'10',text:'synthetic 11',actorId:'200'});
    expect(f.navigations).toBe(1);
    f.setNext('12');
    const second=await f.reader().comments(0,true,0,collection);
    expect(second.events.map(event=>event.commentId)).toEqual(['12']);expect(f.navigations).toBe(2);
    f.setNext('13');
    const third=await f.reader().comments(0,true,0,collection);
    expect(third.events.map(event=>event.commentId)).toEqual(['13']);expect(f.navigations).toBe(3);
  }finally{await f.close();}
},20_000);

test('a normally refreshed document is already consumed and cannot be reused by the following turn',async()=>{
  const f=await fixture();
  try{
    f.setNext('21');
    const normal=await f.reader().comments(0,true,0,{holdScroll:true,stay:false});
    expect(normal.events.map(event=>event.commentId)).toEqual(['21']);expect(f.navigations).toBe(2);
    f.setNext('22');
    const later=await f.reader().comments(0,true,0,collection);
    expect(later.events.map(event=>event.commentId)).toEqual(['22']);expect(f.navigations).toBe(3);
  }finally{await f.close();}
},20_000);

test.each(['other-work','expired'] as const)('a %s document still needs normal navigation before collection',async variant=>{
  const f=await fixture();
  try{
    if(variant==='other-work')await f.owner.notification.goto(f.mapping.works[1]!.url,{waitUntil:'domcontentloaded'});
    else await f.owner.notification.waitForTimeout(30);
    const before=f.navigations;f.setNext('31');
    const batch=await f.reader().comments(0,true,0,variant==='expired'?{...collection,freshWithinMs:1}:collection);
    expect(batch.events.map(event=>event.commentId)).toEqual(['31']);
    expect(batch.events[0]!.videoId).toBe('10');expect(f.navigations).toBe(before+1);
  }finally{await f.close();}
},20_000);

test.each(['challenge','human-input'] as const)('fresh reuse preserves the %s safety gate without discarding the document',async variant=>{
  const f=await fixture();
  try{
    await f.owner.notification.evaluate(variant=>{
      if(variant==='challenge'){
        const layer=document.createElement('div');layer.setAttribute('data-fixture-challenge','');layer.textContent='Synthetic active verification';
        layer.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.6)';document.body.append(layer);
      }else{
        const draft=document.createElement('textarea');draft.id='synthetic-human-input';draft.value='unsent synthetic human draft';document.body.append(draft);
      }
    },variant);
    await expect(f.reader().comments(0,true,0,collection)).rejects.toThrow(
      variant==='challenge'?'OBSERVATION_SECURITY_SUSPECT':'OBSERVATION_EXISTING_HUMAN_INPUT');
    expect(f.navigations).toBe(1);
    if(variant==='human-input')expect(await f.owner.notification.locator('#synthetic-human-input').inputValue()).toBe('unsent synthetic human draft');
    else expect(await f.owner.notification.locator('[data-fixture-challenge]').count()).toBe(1);
  }finally{await f.close();}
},20_000);

test.each([false,true])('a reused page with no current has_more proof keeps its backlog and success watermark until a later normal refresh (existing backlog: %s)',async existingBacklog=>{
  const f=await fixture(),store=database();let collector:InboxCollector|undefined;
  try{
    await migrateClient(store,join(f.root,'client.sqlite'));await migrateAutomation(store,join(f.root,'automation.sqlite'));
    const now=Date.now(),data=new AutomationStore(store,()=>now);data.initialize(now-60_000);store.bindAccount('100');
    data.configureCollection({ownId:'100',comments:true,inbox:false,commentIntervalMs:15_000,dmIntervalMs:15_000});
    // Only the exact currently loaded work is in this collection scope.
    const mapping={...f.mapping,works:[f.mapping.works[0]!]};
    store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='works'").run(JSON.stringify({phase:'comments',pendingRootPages:existingBacklog?['10']:[]}));
    collector=new InboxCollector(f.owner,mapping,data,f.root,'headless');
    const cursor=()=>JSON.parse((store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='works'").get() as {cursor_json:string}).cursor_json);
    const progress=()=>store.db.prepare("SELECT end_observations,last_read FROM work_collection_progress WHERE work_id='10'").get();
    await collector.collect('works',new AbortController().signal);
    expect(store.events().map(event=>event.payload.commentId)).toEqual(['11']);
    expect(progress()).toMatchObject({end_observations:0,last_read:0});
    expect(cursor().pendingRootPages).toContain('10');
    expect(f.navigations).toBe(1);expect(f.rootResponses).toBe(1);
    // A later scheduled turn, rather than a second forced navigation in the same turn, obtains native completion evidence.
    const saved=cursor();store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='works'").run(JSON.stringify({...saved,phase:'comments',workIndex:0}));
    f.setNext('42');await collector.collect('works',new AbortController().signal);
    expect(f.navigations).toBe(2);expect(f.rootResponses).toBe(2);
    expect(store.events().map(event=>event.payload.commentId).sort()).toEqual(['11','42']);
    expect(cursor().pendingRootPages).not.toContain('10');
    expect(progress()).toMatchObject({last_read:now});
    expect(store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
    expect(store.budgets().map(budget=>budget.used)).toEqual([0,0]);
  }finally{collector?.dispose();store.close();await f.close();}
},20_000);
