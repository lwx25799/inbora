import { expect, test, vi } from "vitest";
import { join } from "node:path";
import { BrowserProfileOwner } from "../../src/browser/profile-owner.js";
import { ObservedReader } from "../../src/adapters/observed-reader.js";
import { OwnWorksDiscovery } from "../../src/adapters/own-works-discovery.js";
import { AutomationStore } from "../../src/storage/automation-store.js";
import { migrateClient } from "../../src/storage/client-migration.js";
import { migrateAutomation } from "../../src/storage/automation-migration.js";
import { CollectionScheduler } from "../../src/app/collection-scheduler.js";
import { InboxCollector } from "../../src/app/inbox-collector.js";
import { Blocked,digest } from "../../src/core/contracts.js";
import { readdir,readFile } from 'node:fs/promises';
import { database, privateTemp } from "../helpers.js";
import { fixtureServer } from "../fixtures/site.js";
import { mountObserved, mountDmReply, observedMapping } from "../fixtures/observed-site.js";

function expectFixtureInbox(store:ReturnType<typeof database>,conversationId='conv-a',actorId='200'):void{
  const events=store.events();expect(events).toHaveLength(4);
  expect(events.filter(event=>event.status==='AWAITING_DRAFT').map(event=>event.payload.platformEventId)).toEqual(['1','2','3']);
  expect(events.find(event=>event.payload.platformEventId==='5')).toMatchObject({status:'MANUAL_REVIEW',payload:{
    contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED',text:'[图片或表情消息，需人工查看]'}});
  expect(events.every(event=>event.payload.actorId===actorId&&event.payload.conversationId===conversationId)).toBe(true);
  expect(events.some(event=>event.payload.platformEventId==='4')).toBe(false);
  expect(new Set(events.map(event=>event.payload.platformEventId)).size).toBe(4);
}

test("unknown native peer is discovered and collected by the background timer without AI or manual sync", async () => {
  const server=await fixtureServer(),root=privateTemp('auto-dm-'),owner=await BrowserProfileOwner.launch(join(root,'profile'),true),store=database();
  let scheduler:CollectionScheduler|undefined,collector:InboxCollector|undefined;
  try {
    await migrateClient(store,join(root,'schema3.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
    const data=new AutomationStore(store);data.initialize(Date.now()-10_000);store.bindAccount('100');
    data.configureCollection({ownId:'100',comments:false,inbox:true,commentIntervalMs:30_000,dmIntervalMs:15_000});
    store.db.prepare("UPDATE client_state SET paused=1,mode='DRAFT_ONLY'").run();
    await mountObserved(owner,server.origin);
    await owner.dm.evaluate(()=>{
      const read=(node:Element,key:string)=>Object.getOwnPropertyDescriptor(node,key)!.value;
      const row=document.querySelector('.conversation')!,chat=document.querySelector('#chat') as HTMLElement;
      const native=read(row,'__reactFiber$fixture').return.memoizedProps.conversation;
      native.id='new-conversation';native._toParticipantSecUserId='new-sec';
      row.querySelector('.title')!.textContent='New native peer';
      const head=read(document.querySelector('#header')!,'__reactProps$fixture').children.props.conversation;
      head.id='new-conversation';head._toParticipantSecUserId='new-sec';
      document.querySelector('#chat-title')!.textContent='New native peer';
      for(const message of document.querySelectorAll('.message')) {
        const model=read(message,'__reactProps$fixture').children.props.message;
        model.conversationId='new-conversation';if(model.sender!=='100')model.sender='300';model.createdAt=new Date(Date.now()-1000);
      }
      document.querySelector('#back')!.addEventListener('click',()=>{chat.hidden=true;});
      row.addEventListener('click',()=>{chat.hidden=false;});
    });
    collector=new InboxCollector(owner,observedMapping(server.origin),data,root,'headless');
    scheduler=new CollectionScheduler(data,(source,signal)=>collector!.collect(source,signal));
    scheduler.start();
    await expect.poll(()=>store.events().length,{timeout:10_000}).toBe(4);
    expectFixtureInbox(store,'new-conversation','300');
    expect(store.db.prepare('SELECT uid,sec_uid FROM discovered_conversations').get()).toEqual({uid:'300',sec_uid:'new-sec'});
    expect(store.db.prepare('SELECT count(*) AS n FROM collection_targets').get()).toEqual({n:1});
    store.db.prepare('UPDATE collection_progress SET next_at=0').run();await scheduler.tick();
    expectFixtureInbox(store,'new-conversation','300');
    expect(store.db.prepare('SELECT used FROM budgets').all()).toEqual([{used:0},{used:0}]);
  } finally {await scheduler?.close();collector?.dispose();store.close();await owner.close();await server.close();}
});

test("background conversation discovery preserves a nonempty page editor before switching targets", async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp('auto-human-input-'),'profile'),true);
  try {
    await mountObserved(owner,server.origin);
    await owner.dm.evaluate(()=>{const editor=document.createElement('textarea');editor.value='unsent human input';document.querySelector('#chat')!.append(editor);});
    await expect(new ObservedReader(owner.dm,observedMapping(server.origin)).conversations()).rejects.toThrow('OBSERVATION_EXISTING_HUMAN_INPUT');
    expect(await owner.dm.locator('textarea').inputValue()).toBe('unsent human input');
  }finally{await owner.close();await server.close();}
});

test('a failed native return after successful DM collection retains its read watermark and records one private-safe diagnostic',async()=>{
  const server=await fixtureServer(),root=privateTemp('dm-advance-diagnostic-'),owner=await BrowserProfileOwner.launch(join(root,'profile'),true),store=database();
  let collector:InboxCollector|undefined;
  const now=Date.now(),code='OBSERVATION_DM_BACK_DOM_NOT_READY';
  try{
    await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
    const data=new AutomationStore(store,()=>now);data.initialize(now-10_000);store.bindAccount('100');
    data.configureCollection({ownId:'100',comments:false,inbox:true,commentIntervalMs:30_000,dmIntervalMs:15_000});
    await mountObserved(owner,server.origin);owner.context.setDefaultTimeout(100);
    await owner.dm.evaluate(now=>{
      const chat=document.querySelector('#chat') as HTMLElement;chat.hidden=true;
      document.querySelector('.conversation')!.addEventListener('click',()=>{chat.hidden=false;});
      // The native back control remains visible but does not hide the chat after its ordinary click.
      for(const row of document.querySelectorAll('.message'))
        Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message.createdAt=new Date(now-1000);
    },now);
    collector=new InboxCollector(owner,observedMapping(server.origin),data,root,'headless');
    const signal=new AbortController().signal;
    await expect(collector.collect('dm',signal)).rejects.toMatchObject({code});
    expectFixtureInbox(store);
    expect(store.db.prepare("SELECT last_read FROM discovered_conversations WHERE id='conv-a'").get()).toEqual({last_read:now});
    const diagnostics=()=>readdir(join(root,'evidence')).then(names=>names.filter(name=>name.startsWith('collection-read-')));
    expect(await diagnostics()).toHaveLength(1);
    const diagnostic=JSON.parse(await readFile(join(root,'evidence',(await diagnostics())[0]!),'utf8'));
    expect(diagnostic).toMatchObject({phase:'ADVANCE',code,report:{source:'dm',chatVisible:true,chatInViewport:true,backVisible:true,backInViewport:true}});
    for(const privateValue of ['conv-a','peer-sec','controlled-1','controlled-2','controlled-3','owner text'])
      expect(JSON.stringify(diagnostic)).not.toContain(privateValue);
    // Automatic preview priority gets one HINT attempt, then yields the next turn to the ordinary LIST stage.
    await expect(collector.collect('dm',signal)).rejects.toMatchObject({code});
    expect(await diagnostics()).toHaveLength(1);
    const hintDiagnostic=JSON.parse(await readFile(join(root,'evidence',(await diagnostics())[0]!),'utf8'));
    expect(hintDiagnostic).toMatchObject({phase:'HINT',code});
    await expect(collector.collect('dm',signal)).rejects.toMatchObject({code});
    const listDiagnostic=JSON.parse(await readFile(join(root,'evidence',(await diagnostics())[0]!),'utf8'));
    expect(listDiagnostic).toMatchObject({phase:'LIST',code});
    await expect(collector.collect('dm',signal)).rejects.toMatchObject({code});
    expect(store.db.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type='COLLECTION_READ_DIAGNOSTIC'").get()).toEqual({n:3});
    expect(store.db.prepare("SELECT last_read FROM discovered_conversations WHERE id='conv-a'").get()).toEqual({last_read:now});
    expect(store.db.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type='DM_READ_DEFERRED'").get()).toEqual({n:0});
    expect(store.db.prepare('SELECT count(*) AS n FROM model_calls').get()).toEqual({n:0});
    expect(store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
    expect(store.db.prepare('SELECT used FROM budgets ORDER BY kind').all()).toEqual([{used:0},{used:0}]);
  }finally{collector?.dispose();store.close();await owner.close();await server.close();}
});

test('one unreadable conversation yields to another native peer across collector restart without recording a false successful read',async()=>{
  const server=await fixtureServer(),root=privateTemp('dm-read-fairness-'),owner=await BrowserProfileOwner.launch(join(root,'profile'),true),store=database();
  let collector:InboxCollector|undefined;
  let now=Date.now();
  try{
    await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
    const data=new AutomationStore(store,()=>now);data.initialize(now-10_000);store.bindAccount('100');
    data.configureCollection({ownId:'100',comments:false,inbox:true,commentIntervalMs:30_000,dmIntervalMs:15_000});
    await mountObserved(owner,server.origin);owner.context.setDefaultTimeout(300);
    await owner.dm.evaluate(()=>{
      const chat=document.querySelector('#chat') as HTMLElement,row=document.querySelector('.conversation')!;
      document.querySelector('#back')!.addEventListener('click',()=>{chat.hidden=true;});
      row.addEventListener('click',()=>{chat.hidden=false;});
      for(const message of document.querySelectorAll('.message'))
        Object.getOwnPropertyDescriptor(message,'__reactProps$fixture')!.value.children.props.message.createdAt=new Date(Date.now()-1000);
      const unavailable=document.createElement('div');unavailable.className='conversation';
      unavailable.innerHTML='<span class="title">Unavailable fixture conversation</span>';
      Object.defineProperty(unavailable,'__reactFiber$fixture',{value:{return:{memoizedProps:{conversation:{id:'a-unavailable',_toParticipantSecUserId:'unavailable-sec'}}}}});
      // A normal row whose conversation never mounts, independent of the product reader.
      document.querySelector('#dm-panel')!.prepend(unavailable);
    });
    const mapping=observedMapping(server.origin),signal=new AbortController().signal;
    collector=new InboxCollector(owner,mapping,data,root,'headless');
    await expect(collector.collect('dm',signal)).rejects.toThrow('OBSERVATION_DM_CHAT_NOT_READY');
    const diagnostics=(await readdir(join(root,'evidence'))).filter(name=>name.startsWith('collection-read-'));
    expect(diagnostics).toHaveLength(1);
    const diagnostic=JSON.parse(await readFile(join(root,'evidence',diagnostics[0]!),'utf8'));
    expect(diagnostic).toMatchObject({code:'OBSERVATION_DM_CHAT_NOT_READY',report:{source:'dm',visibleContainers:1,chatVisible:false}});
    expect(JSON.stringify(diagnostic)).not.toContain('a-unavailable');
    expect(store.db.prepare("SELECT detail_redacted FROM audit_events WHERE event_type='DM_READ_DEFERRED'").get())
      .toEqual({detail_redacted:'{"threadReadFailed":true}'});
    const saved=store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='dm'").get() as {cursor_json:string};
    expect(JSON.parse(saved.cursor_json),saved.cursor_json).toEqual({deferred:[{id:'a-unavailable',until:now+120_000,code:'OBSERVATION_DM_CHAT_NOT_READY'}],
      parked:[],recent:['conv-a','a-unavailable'],burst:2,completed:[],activityNeedsNormal:false,previewRetries:[],previewRetryNeedsNormal:false,
      activity:{next:now+30_000,initialized:true,items:[{id:'a-unavailable',signature:digest('')},{id:'conv-a',signature:digest('')}]}});
    expect(store.db.prepare("SELECT last_read FROM discovered_conversations WHERE id='a-unavailable'").get()).toEqual({last_read:0});
    collector.dispose();collector=new InboxCollector(owner,mapping,new AutomationStore(store,()=>now),root,'headless');
    await collector.collect('dm',signal);
    expectFixtureInbox(store);
    expect(store.db.prepare("SELECT last_read FROM discovered_conversations WHERE id='a-unavailable'").get()).toEqual({last_read:0});
    now+=120_001;
    await collector.collect('dm',signal);
    expect(store.db.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type='MESSAGE_PREVIEW_RETRY'").get()).toEqual({n:1});
    // One bounded preview retry cannot postpone the next ordinary retry of the unreadable peer.
    await expect(collector.collect('dm',signal)).rejects.toThrow('OBSERVATION_DM_CHAT_NOT_READY');
    expectFixtureInbox(store);
    expect(store.db.prepare('SELECT used FROM budgets ORDER BY kind').all()).toEqual([{used:0},{used:0}]);
  }finally{collector?.dispose();store.close();await owner.close();await server.close();}
});

test.each(['OBSERVATION_ACCOUNT_CHANGED','OBSERVATION_PAGE_BLOCKED'])('DM failure %s retains the global stop instead of becoming a deferred conversation',async code=>{
  const server=await fixtureServer(),root=privateTemp('dm-stop-'),owner=await BrowserProfileOwner.launch(join(root,'profile'),true),store=database();
  const read=vi.spyOn(ObservedReader.prototype,'dm').mockRejectedValueOnce(new Blocked(code));
  let collector:InboxCollector|undefined,scheduler:CollectionScheduler|undefined;
  try{
    await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
    const data=new AutomationStore(store);data.initialize(Date.now());store.bindAccount('100');
    data.configureCollection({ownId:'100',comments:false,inbox:true,commentIntervalMs:30_000,dmIntervalMs:15_000});
    await mountObserved(owner,server.origin);
    await owner.dm.evaluate(()=>document.querySelector('#back')!.addEventListener('click',()=>{(document.querySelector('#chat') as HTMLElement).hidden=true;}));
    collector=new InboxCollector(owner,observedMapping(server.origin),data,root,'headless');
    scheduler=new CollectionScheduler(data,(source,signal)=>collector!.collect(source,signal));const before=data.now();await scheduler.tick();
    expect(data.state().emergencyStopped).toBe(true);
    const stopped=store.db.prepare("SELECT last_error,cursor_json FROM collection_progress WHERE source='dm'").get() as {last_error:string;cursor_json:string};
    expect(stopped.last_error).toBe(code);
    const cursor=JSON.parse(stopped.cursor_json);
    expect(cursor).toEqual({deferred:[],parked:[],recent:[],burst:0,completed:[],activityNeedsNormal:false,previewRetries:[],previewRetryNeedsNormal:false,
      activity:{next:expect.any(Number),initialized:true,items:[{id:'conv-a',signature:digest('')}]}});
    expect(cursor.activity.next).toBeGreaterThanOrEqual(before+30_000);expect(cursor.activity.next).toBeLessThanOrEqual(data.now()+30_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(store.db.prepare('SELECT last_read FROM discovered_conversations').all()).toEqual([{last_read:0}]);
    expect(store.db.prepare("SELECT last_success FROM collection_progress WHERE source='dm'").get()).toEqual({last_success:null});
    expect(store.db.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type='DM_READ_DEFERRED'").get()).toEqual({n:0});
    expect(store.db.prepare('SELECT used FROM budgets ORDER BY kind').all()).toEqual([{used:0},{used:0}]);
    expect(store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{read.mockRestore();await scheduler?.close();collector?.dispose();store.close();await owner.close();await server.close();}
});

test.each([4,10])('%s unreadable native conversations cannot starve a later readable peer through channel backoff',async unavailableCount=>{
  const server=await fixtureServer(),root=privateTemp('dm-multiple-deferrals-'),owner=await BrowserProfileOwner.launch(join(root,'profile'),true),store=database();
  let collector:InboxCollector|undefined,scheduler:CollectionScheduler|undefined,now=Date.now();
  try{
    await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
    const data=new AutomationStore(store,()=>now);data.initialize(now-10_000);store.bindAccount('100');
    data.configureCollection({ownId:'100',comments:false,inbox:true,commentIntervalMs:30_000,dmIntervalMs:15_000});
    await mountObserved(owner,server.origin);owner.context.setDefaultTimeout(80);
    await owner.dm.evaluate(unavailableCount=>{
      const chat=document.querySelector('#chat') as HTMLElement,row=document.querySelector('.conversation')!;
      document.querySelector('#back')!.addEventListener('click',()=>{chat.hidden=true;});row.addEventListener('click',()=>{chat.hidden=false;});
      for(const message of document.querySelectorAll('.message'))
        Object.getOwnPropertyDescriptor(message,'__reactProps$fixture')!.value.children.props.message.createdAt=new Date(Date.now()-1000);
      for(let i=0;i<unavailableCount;i++){
        const bad=document.createElement('div');bad.className='conversation';bad.innerHTML=`<span class="title">Unavailable ${i}</span>`;
        Object.defineProperty(bad,'__reactFiber$fixture',{value:{return:{memoizedProps:{conversation:{id:`a-unavailable-${i}`,_toParticipantSecUserId:`unavailable-sec-${i}`}}}}});
        document.querySelector('#dm-panel')!.prepend(bad);
      }
    },unavailableCount);
    collector=new InboxCollector(owner,observedMapping(server.origin),data,root,'headless');
    scheduler=new CollectionScheduler(data,(source,signal)=>collector!.collect(source,signal));
    for(let turn=0;turn<unavailableCount+2;turn++){
      await scheduler.tick();
      now=(store.db.prepare("SELECT next_at FROM collection_progress WHERE source='dm'").get() as {next_at:number}).next_at;
      if(turn===2){collector.dispose();collector=new InboxCollector(owner,observedMapping(server.origin),new AutomationStore(store,()=>now),root,'headless');}
    }
    expectFixtureInbox(store);
    expect(store.db.prepare("SELECT last_read FROM discovered_conversations WHERE id LIKE 'a-unavailable-%' AND last_read<>0").all()).toEqual([]);
    const cursor=JSON.parse((store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='dm'").get() as {cursor_json:string}).cursor_json);
    expect(new Set(cursor.deferred.map((item:{id:string})=>item.id)).size).toBe(cursor.deferred.length);
    expect(store.db.prepare('SELECT used FROM budgets ORDER BY kind').all()).toEqual([{used:0},{used:0}]);
  }finally{await scheduler?.close();collector?.dispose();store.close();await owner.close();await server.close();}
});

test.each([false,true])('a deferred work never advances its successful read watermark (previous success: %s)',async priorSuccess=>{
  const server=await fixtureServer(),root=privateTemp('work-failed-watermark-'),owner=await BrowserProfileOwner.launch(join(root,'profile'),true),store=database();
  let collector:InboxCollector|undefined;
  const read=vi.spyOn(ObservedReader.prototype,'comments').mockRejectedValueOnce(new Blocked('OBSERVATION_DOM_NOT_READY'));
  try{
    await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
    const now=Date.now(),data=new AutomationStore(store,()=>now);data.initialize(now-10_000);store.bindAccount('100');
    data.configureCollection({ownId:'100',comments:true,inbox:false,commentIntervalMs:30_000,dmIntervalMs:15_000});
    store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='works'").run(JSON.stringify({phase:'comments'}));
    if(priorSuccess)store.db.prepare('INSERT INTO work_collection_progress VALUES(?,0,0,0,?,NULL,0)').run('10',now-50_000);
    collector=new InboxCollector(owner,observedMapping(server.origin),data,root,'headless');
    await expect(collector.collect('works',new AbortController().signal)).rejects.toThrow('OBSERVATION_DOM_NOT_READY');
    expect(store.db.prepare("SELECT last_read,last_error,next_at FROM work_collection_progress WHERE work_id='10'").get())
      .toEqual({last_read:priorSuccess?now-50_000:0,last_error:'OBSERVATION_DOM_NOT_READY',next_at:now+120_000});
    expect(store.db.prepare('SELECT count(*) AS n FROM observations').get()).toEqual({n:0});
  }finally{read.mockRestore();collector?.dispose();store.close();await owner.close();await server.close();}
});

test("own-profile normal GET and native links discover a post-start video without adding its ID to the mapping",async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp('auto-works-'),'profile'),true);
  const mapping=observedMapping(server.origin);
  let discovery:OwnWorksDiscovery|undefined;
  try {
    await owner.notification.goto(server.origin);
    await owner.notification.setContent('<a id="self">Self</a>');
    await owner.notification.evaluate(()=>Object.defineProperty(document.querySelector('#self')!,'__reactFiber$fixture',{value:{return:{memoizedProps:{uid:'100',secUid:'self-sec'}}}}));
    const published=Math.floor(Date.now()/1000)-1;
    await owner.notification.route(server.origin+'/aweme/v1/web/aweme/post/?sec_user_id=self-sec',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({
      status_code:0,has_more:0,aweme_list:[{aweme_id:'20',create_time:published,author:{uid:'100',sec_uid:'self-sec'}}],
    })}));
    await owner.notification.route(server.origin+'/user/self-sec',route=>route.fulfill({contentType:'text/html',body:
      `<a id="self">Self</a><a href="/video/20">New own work</a><script>
      Object.defineProperty(document.querySelector('#self'),'__reactFiber$fixture',{value:{return:{memoizedProps:{uid:'100',secUid:'self-sec'}}}});
      fetch('/aweme/v1/web/aweme/post/?sec_user_id=self-sec');</script>`}));
    discovery=new OwnWorksDiscovery(owner.notification,mapping);
    const result=await discovery.scan(new ObservedReader(owner.notification,mapping),true,new AbortController().signal);
    expect(mapping.works.map(w=>w.id)).toEqual(['10']);
    expect(result).toEqual({works:[{id:'20',ownId:'100',url:server.origin+'/video/20',publishedAt:published*1000,precisionMs:1000}],pending:[],complete:true});
  }finally{discovery?.dispose();await owner.close();await server.close();}
});

test("SQLite collection resumes discovery after restart and includes downtime works/comments without replaying old tasks",async()=>{
  const server=await fixtureServer(),root=privateTemp('auto-resume-'),owner=await BrowserProfileOwner.launch(join(root,'profile'),true),store=database();
  let collector:InboxCollector|undefined;
  try {
    await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
    const start=Date.now()-20_000,published=Math.floor((start+3000)/1000),works=['20'];
    const data=new AutomationStore(store);data.initialize(start);store.bindAccount('100');
    data.configureCollection({ownId:'100',comments:true,inbox:false,commentIntervalMs:15_000,dmIntervalMs:15_000});
    await owner.notification.goto(server.origin);await owner.notification.setContent('<a id="self">Self</a>');
    const selfScript="Object.defineProperty(document.querySelector('#self'),'__reactFiber$fixture',{value:{return:{memoizedProps:{uid:'100',secUid:'self-sec'}}}});";
    await owner.notification.evaluate(()=>Object.defineProperty(document.querySelector('#self')!,'__reactFiber$fixture',{value:{return:{memoizedProps:{uid:'100',secUid:'self-sec'}}}}));
    await owner.notification.route(server.origin+'/aweme/v1/web/aweme/post/?sec_user_id=self-sec',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({status_code:0,has_more:0,
      aweme_list:works.map(id=>({aweme_id:id,create_time:published,author:{uid:'100',sec_uid:'self-sec'}}))})}));
    await owner.notification.route(server.origin+'/user/self-sec',route=>route.fulfill({contentType:'text/html',body:
      `<a id="self">Self</a>${works.map(id=>`<a href="/video/${id}">Own native work</a>`).join('')}<script>${selfScript}fetch('/aweme/v1/web/aweme/post/?sec_user_id=self-sec');</script>`}));
    await owner.notification.route(server.origin+'/video/*',route=>{
      const id=new URL(route.request().url()).pathname.split('/').at(-1)!,cid=String(Number(id)+100);
      const message='new comment '+id;
      return route.fulfill({contentType:'text/html',body:`<a id="self">Self</a><section id="comment-list">${id==='10'?'<div id="empty-comments">No comments</div>':
        `<div class="comment"><a class="author" href="/user/new-commenter-sec">New commenter</a><div class="body">${message}</div><div class="tooltip" id="tooltip_${cid}">Menu</div></div>`}</section><script>${selfScript}
        const row=document.querySelector('.comment');if(row)Object.defineProperty(row,'__reactFiber$fixture',{value:{return:{memoizedProps:{commentInfo:{cid:'${cid}',text:'${message}',
          createTime:${published+1},user:{uid:'400',secUid:'new-commenter-sec'}},awemeInfo:{awemeId:'${id}'},userInfo:{uid:'100'}}}}});</script>`});
    });
    const mapping=observedMapping(server.origin),signal=new AbortController().signal;
    collector=new InboxCollector(owner,mapping,data,root,'headless');
    for(let turn=0;turn<5;turn++)await collector.collect('works',signal);
    expect(store.events().filter(e=>e.status==='AWAITING_DRAFT')).toHaveLength(1);
    expect(store.events()[0]!.payload).toMatchObject({videoId:'20',actorId:'400'});
    collector.dispose();works.push('21');
    const restarted=new AutomationStore(store);restarted.initialize(Date.now());
    collector=new InboxCollector(owner,mapping,restarted,root,'headless');
    for(let turn=0;turn<7;turn++)await collector.collect('works',signal);
    expect(restarted.state().startedAt).toBe(start);
    expect(store.events().map(e=>e.payload.videoId).sort()).toEqual(['20','21']);
    expect(store.db.prepare("SELECT count(*) AS n FROM discovered_works WHERE state='INCLUDED'").get()).toEqual({n:2});
    expect(store.db.prepare("SELECT count(*) AS n FROM model_calls").get()).toEqual({n:0});
    expect(store.db.prepare("SELECT count(*) AS n FROM send_intents").get()).toEqual({n:0});
  }finally{collector?.dispose();store.close();await owner.close();await server.close();}
});

test('calibrated empty Slate marker permits discovery while unsent media and ordinary zero-width input block it',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp('collector-editor-shape-'),'profile'),true);
  try{
    await mountDmReply(owner,server.origin);
    await owner.dm.evaluate(()=>{const editor=document.querySelector('#native-editor')!;editor.setAttribute('data-slate-editor','true');editor.setAttribute('data-zone-container','*');
      editor.innerHTML='<div class="ace-line" data-node="true"><span data-enter="true" data-string="true" data-leaf="true">\u200B</span></div>';});
    await owner.dm.evaluate(()=>document.querySelector('#back')!.addEventListener('click',()=>{(document.querySelector('#chat') as HTMLElement).hidden=true;}));
    const reader=new ObservedReader(owner.dm,observedMapping(server.origin));
    expect((await reader.conversations()).peers).toHaveLength(1);
    await owner.dm.evaluate(()=>{(document.querySelector('#chat') as HTMLElement).hidden=false;document.querySelector('#native-editor')!.innerHTML='<img src="data:,unsent">';});
    await expect(reader.conversations()).rejects.toThrow('OBSERVATION_EXISTING_HUMAN_INPUT');
    expect(await owner.dm.locator('#native-editor img').count()).toBe(1);
    await owner.dm.evaluate(()=>{const editor=document.querySelector('#native-editor')!;editor.removeAttribute('data-slate-editor');editor.textContent='\u200B';});
    await expect(reader.conversations()).rejects.toThrow('OBSERVATION_EXISTING_HUMAN_INPUT');
  }finally{await owner.close();await server.close();}
});

test('normal profile scrolling follows another response page and unresolved links do not prevent a complete scan',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp('own-two-pages-'),'profile'),true);
  let discovery:OwnWorksDiscovery|undefined;
  try{
    await mountObserved(owner,server.origin);
    await owner.notification.goto(server.origin);await owner.notification.setContent('<a id="self">Self</a>');
    await owner.notification.evaluate(()=>Object.defineProperty(document.querySelector('#self')!,'__reactFiber$fixture',{value:{return:{memoizedProps:{uid:'100',secUid:'self-sec'}}}}));
    await owner.notification.route(server.origin+'/aweme/v1/web/aweme/post/**',route=>{
      const second=new URL(route.request().url()).searchParams.has('next');
      return route.fulfill({contentType:'application/json',body:JSON.stringify({status_code:0,has_more:second?0:1,
        aweme_list:(second?['21','22']:['20']).map(id=>({aweme_id:id,create_time:Math.floor(Date.now()/1000)-1,author:{uid:'100',sec_uid:'self-sec'}}))})});
    });
    await owner.notification.route(server.origin+'/user/self-sec',route=>route.fulfill({contentType:'text/html',body:`<a id="self">Self</a><a href="/video/20">First work</a><div style="height:2000px"></div><script>
      Object.defineProperty(document.querySelector('#self'),'__reactFiber$fixture',{value:{return:{memoizedProps:{uid:'100',secUid:'self-sec'}}}});
      fetch('/aweme/v1/web/aweme/post/?sec_user_id=self-sec');let loaded=false;window.addEventListener('scroll',()=>{if(loaded)return;loaded=true;
      const link=document.createElement('a');link.href='/video/21';link.textContent='Second work';document.body.append(link);fetch('/aweme/v1/web/aweme/post/?sec_user_id=self-sec&next=1');});</script>`}));
    const mapping=observedMapping(server.origin),reader=new ObservedReader(owner.notification,mapping);discovery=new OwnWorksDiscovery(owner.notification,mapping);
    const first=await discovery.scan(reader,true,new AbortController().signal);expect(first.complete).toBe(false);expect(first.works.map(w=>w.id)).toEqual(['20']);
    const second=await discovery.scan(reader,false,new AbortController().signal,first.pending);
    expect(second.complete).toBe(true);expect(second.works.map(w=>w.id)).toEqual(['21']);expect(second.pending.map(w=>w.aweme_id)).toEqual(['22']);
  }finally{discovery?.dispose();await owner.close();await server.close();}
});

test('comment collection continues a native virtual list across bounded turns and protects page input on continuation',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp('comment-continuation-'),'profile'),true);
  try{
    await owner.notification.goto(server.origin);await owner.notification.setContent('<a id="self">Self</a>');
    await owner.notification.evaluate(()=>Object.defineProperty(document.querySelector('#self')!,'__reactFiber$fixture',{value:{return:{memoizedProps:{uid:'100',secUid:'self-sec'}}}}));
    await owner.notification.route(server.origin+'/video/10',route=>route.fulfill({contentType:'text/html',body:`<a id="self">Self</a><section id="comment-list" style="height:100px;overflow-y:auto"><div style="height:700px"><div id="viewport" style="position:sticky;top:0"></div></div></section><script>
      Object.defineProperty(document.querySelector('#self'),'__reactFiber$fixture',{value:{return:{memoizedProps:{uid:'100',secUid:'self-sec'}}}});
      function mount(id){const row=document.createElement('div');row.className='comment';row.innerHTML='<a class="author" href="/user/new-sec">Native author</a><div class="body">Comment '+id+'</div><div class="tooltip" id="tooltip_'+id+'">Menu</div>';
      Object.defineProperty(row,'__reactFiber$fixture',{value:{return:{memoizedProps:{commentInfo:{cid:id,text:'Comment '+id,createTime:Math.floor(Date.now()/1000)-1,user:{uid:'400',secUid:'new-sec'}},awemeInfo:{awemeId:'10'},userInfo:{uid:'100'}}}}});document.querySelector('#viewport').replaceChildren(row);}
      mount('120');document.querySelector('#comment-list').addEventListener('scroll',()=>requestAnimationFrame(()=>requestAnimationFrame(()=>mount('121'))));</script>`}));
    const reader=new ObservedReader(owner.notification,observedMapping(server.origin));
    const first=await reader.comments(0,true);expect(first.events.map(e=>e.platformEventId)).toEqual(['120']);expect(first.scroll!.top).toBeGreaterThan(0);
    const next=await reader.comments(0,true,first.scroll!.top);expect(next.events.map(e=>e.platformEventId)).toEqual(['121']);
    await owner.notification.evaluate(()=>{const input=document.createElement('textarea');input.value='pending human draft';document.body.prepend(input);});
    await expect(reader.comments(0,true,next.scroll!.top)).rejects.toThrow('OBSERVATION_EXISTING_HUMAN_INPUT');
    expect(await owner.notification.locator('textarea').inputValue()).toBe('pending human draft');
  }finally{await owner.close();await server.close();}
});
