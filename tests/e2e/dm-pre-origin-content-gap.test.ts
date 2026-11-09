import {afterAll,beforeAll,expect,test} from 'vitest';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {captureObserved} from '../../src/adapters/observed-reader.js';
import {InboxCollector} from '../../src/app/inbox-collector.js';
import {EventStore} from '../../src/storage/store.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountObserved,observedMapping} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';

const parent=privateTemp('dm-pre-origin-gap-');
let server:Awaited<ReturnType<typeof fixtureServer>>,owner:BrowserProfileOwner;
beforeAll(async()=>{server=await fixtureServer();owner=await BrowserProfileOwner.launch(join(parent,'profile'),true);});
afterAll(async()=>{await owner?.close();await server?.close();});
async function setup(spec:{restoredOld?:boolean;latestNew?:boolean;gapOffset?:number|null}={},now:()=>number=Date.now){
  const root=privateTemp('dm-pre-origin-db-'),store=new EventStore(join(root,'poc.sqlite'),true),origin=Date.now()-60_000;
  await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  const data=new AutomationStore(store,now);data.initialize(origin);store.bindAccount('100');
  data.configureCollection({ownId:'100',comments:false,inbox:true,commentIntervalMs:30_000,dmIntervalMs:15_000});
  await mountObserved(owner,server.origin);await owner.dm.evaluate(({origin,spec})=>{
    const chat=document.querySelector('#chat') as HTMLElement;for(const box of chat.querySelectorAll('.box'))box.remove();
    const list=document.createElement('div');list.id='gap-messages';list.style.cssText='height:144px;overflow-y:auto;width:360px;position:relative';
    const space=document.createElement('div');space.style.height='600px';const viewport=document.createElement('div');viewport.style.cssText='position:sticky;top:0;height:84px';
    space.append(viewport);list.append(space);chat.append(list);
    const earlier=[{id:'6201',text:null,at:origin-10_000},{id:'6202',text:'old text two',at:origin-9000}];
    const latest=[{id:'6204',text:'latest text four',at:origin+(spec.latestNew?1000:-2000)},
      {id:'6205',text:null,at:spec.gapOffset===null?null:origin+(spec.gapOffset??-1000)}];
    const state={oldLoads:0,mount(messages:typeof latest){
      viewport.replaceChildren(...messages.map(item=>{
        const box=document.createElement('div');box.className='box';box.style.height='28px';const row=document.createElement('div');row.className='message';row.style.minHeight='28px';
        if(item.text!==null){const text=document.createElement('span');text.className='text';text.textContent=item.text;row.append(text);}box.append(row);
        Object.defineProperty(row,'__reactProps$fixture',{value:{children:{props:{message:{serverId:item.id,conversationId:'conv-a',sender:'200',
          createdAt:item.at===null?null:new Date(item.at),type:item.text===null?17:7,serverStatus:0,_parsedContent:{text:item.text??''}}}}}});return box;
      }));
    },open(){state.mount(spec.restoredOld?earlier:latest);list.scrollTop=spec.restoredOld?0:list.scrollHeight-list.clientHeight;},
    append(){latest.push({id:'6206',text:'new after origin history coverage',at:Date.now()});state.mount(latest);}};
    (window as unknown as {gapState:typeof state}).gapState=state;
    list.addEventListener('scroll',()=>requestAnimationFrame(()=>{if(list.scrollTop<=list.clientHeight){state.oldLoads++;state.mount(earlier);}else state.mount(latest);}));
    document.querySelector('#back')!.addEventListener('click',()=>{chat.hidden=true;});
    document.querySelector('.conversation')!.addEventListener('click',()=>{chat.hidden=false;state.open();});state.open();
  },{origin,spec});
  const mapping=observedMapping(server.origin);let collector=new InboxCollector(owner,mapping,data,root,'headless');
  const cursor=()=>JSON.parse((store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='dm'").get() as {cursor_json:string}).cursor_json);
  const lastRead=()=>(store.db.prepare("SELECT last_read FROM discovered_conversations WHERE id='conv-a'").get() as {last_read:number}|undefined)?.last_read??0;
  return {root,store,data,origin,mapping,cursor,lastRead,get collector(){return collector;},
    restart(){collector.dispose();collector=new InboxCollector(owner,mapping,new AutomationStore(store,now),root,'headless');},
    close(){collector.dispose();store.close();}};
}
function noExternal(store:EventStore){
  expect(store.db.prepare('SELECT kind,used FROM budgets ORDER BY kind').all()).toEqual([{kind:'MODEL',used:0},{kind:'SEND',used:0}]);
  expect(store.db.prepare('SELECT count(*) AS n FROM model_calls').get()).toEqual({n:0});
  expect(store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
}

test('collection metadata covers every exact native row while the missing old voice is never invented as a text event',async()=>{
  const f=await setup();try{
    const input:Parameters<typeof captureObserved>[0]={mapping:f.mapping,channel:'dm',index:0,evidenceId:'synthetic-old-gap',peer:f.mapping.peers[0]!,dmWindow:true,collectionPartial:true};
    const batch=await owner.dm.evaluate(captureObserved,input);
    expect(batch).toMatchObject({loaded:2,incomplete:'CONTENT_NOT_READY'});expect(batch.events.map(event=>event.platformEventId)).toEqual(['6204']);
    expect(batch).toHaveProperty('dmCoverage',[{id:'6204',occurredAt:new Date(f.origin-2000).toISOString(),precisionMs:1,captured:true},
      {id:'6205',occurredAt:new Date(f.origin-1000).toISOString(),precisionMs:1,captured:false}]);
    await expect(owner.dm.evaluate(captureObserved,{...input,collectionPartial:false})).rejects.toThrow('OBSERVATION_DM_CONTENT_DOM_NOT_READY');
  }finally{f.close();}
});

test.each([false,true])('pre-origin content gaps can close a bounded historical pass and routine reads keep its native overlap (restored old: %s)',async restoredOld=>{
  const f=await setup({restoredOld});try{
    let completed=false;
    for(let turn=0;turn<32;turn++){
      await f.collector.collect('dm',new AbortController().signal);
      if(turn===0){expect(f.lastRead()).toBe(0);expect(f.cursor().completed??[]).toHaveLength(0);}
      if(turn===1)f.restart();
      if(f.lastRead()>0){completed=true;break;}
    }
    expect(completed).toBe(true);expect(f.cursor().sweep).toBeUndefined();expect(f.cursor().parked??[]).toEqual([]);
    expect(f.cursor().completed).toHaveLength(1);expect(f.cursor().completed[0].latest).toMatchObject({coverage:'POST_ORIGIN',startedAt:f.origin});
    expect(f.store.events().every(event=>event.status==='BASELINE')).toBe(true);
    expect(f.store.events().some(event=>['6201','6205'].includes(event.payload.platformEventId??''))).toBe(false);
    f.restart();await owner.dm.evaluate(()=>(window as unknown as {gapState:{append():void}}).gapState.append());
    for(let turn=0;turn<2;turn++)await f.collector.collect('dm',new AbortController().signal);
    expect(f.store.events().find(event=>event.payload.platformEventId==='6206')?.status).toBe('AWAITING_DRAFT');
    expect(f.cursor().sweep).toBeUndefined();expect(f.cursor().parked??[]).toEqual([]);noExternal(f.store);
  }finally{f.close();}
});

test('an old restored window cannot stop before the other physical edge containing a new message is checked',async()=>{
  let now=Date.now();const f=await setup({restoredOld:true,latestNew:true},()=>now);try{
    for(let turn=0;turn<32&&f.lastRead()===0;turn++)await f.collector.collect('dm',new AbortController().signal);
    // The physical-edge proof is independent of host speed; the first late-event qualification remains review-only.
    expect(f.lastRead()).toBeGreaterThan(0);expect(f.store.events().find(event=>event.payload.platformEventId==='6204')?.status).toBe('MANUAL_REVIEW');noExternal(f.store);
    expect(f.store.db.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type='LATE_ARRIVAL_QUALIFIED'").get()).toEqual({n:0});
    now+=1000;
    for(let turn=0;turn<2;turn++)await f.collector.collect('dm',new AbortController().signal);
    expect(f.store.events().find(event=>event.payload.platformEventId==='6204')?.status).toBe('AWAITING_DRAFT');
    expect(f.store.db.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type='LATE_ARRIVAL_QUALIFIED'").get()).toEqual({n:1});
    noExternal(f.store);
  }finally{f.close();}
});

test.each([0,1,null])('a current, boundary-overlapping or unknown-time content gap never gains historical completion (%s)',async gapOffset=>{
  const f=await setup({gapOffset,latestNew:true});try{
    await expect(f.collector.collect('dm',new AbortController().signal)).rejects.toThrow(gapOffset===null?'OBSERVATION_METADATA_NOT_READY':'OBSERVATION_DM_CONTENT_DOM_NOT_READY');
    expect(f.lastRead()).toBe(0);expect(f.cursor().completed??[]).toEqual([]);
    if(gapOffset!==null)expect(f.store.events().find(event=>event.payload.platformEventId==='6204')?.status).toBe('AWAITING_DRAFT');
    noExternal(f.store);
  }finally{f.close();}
});
