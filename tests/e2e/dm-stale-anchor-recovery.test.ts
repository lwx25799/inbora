import {afterAll,beforeAll,expect,test,vi} from 'vitest';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {InboxCollector} from '../../src/app/inbox-collector.js';
import {EventStore} from '../../src/storage/store.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountObserved,observedMapping} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';

const parent=privateTemp('dm-stale-anchor-');let server:Awaited<ReturnType<typeof fixtureServer>>,owner:BrowserProfileOwner;
beforeAll(async()=>{server=await fixtureServer();owner=await BrowserProfileOwner.launch(join(parent,'profile'),true);});
afterAll(async()=>{await owner?.close();await server?.close();});
async function setup(){
  const root=privateTemp('dm-stale-anchor-db-'),store=new EventStore(join(root,'poc.sqlite'),true),origin=Date.now()-60_000;
  await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  let now=Date.now();const data=new AutomationStore(store,()=>now);data.initialize(origin);store.bindAccount('100');
  data.configureCollection({ownId:'100',comments:false,inbox:true,commentIntervalMs:30_000,dmIntervalMs:15_000});
  await mountObserved(owner,server.origin);await owner.dm.evaluate(origin=>{
    const chat=document.querySelector('#chat') as HTMLElement;for(const box of chat.querySelectorAll('.box'))box.remove();
    const list=document.createElement('div');list.id='stale-list';list.style.cssText='height:144px;overflow-y:auto;width:360px;position:relative';
    const space=document.createElement('div');space.style.height='600px';const view=document.createElement('div');view.style.cssText='position:sticky;top:0;height:84px';
    space.append(view);list.append(space);chat.append(list);
    const state={changed:false,reads:0,mount(){
      const rows=list.scrollTop<=list.clientHeight?[{id:'7101',text:'old baseline',at:origin-1000},{id:'7102',text:'new earlier',at:origin+1000}]:
        [{id:state.changed?'7304':'7104',text:'latest four',at:origin+4000},{id:state.changed?'7305':'7105',text:'latest five',at:origin+5000}];
      state.reads++;view.replaceChildren(...rows.map(item=>{
        const box=document.createElement('div');box.className='box';box.style.height='28px';const row=document.createElement('div');row.className='message';
        const text=document.createElement('span');text.className='text';text.textContent=item.text;row.append(text);box.append(row);
        Object.defineProperty(row,'__reactProps$fixture',{value:{children:{props:{message:{serverId:item.id,conversationId:'conv-a',sender:'200',
          createdAt:new Date(item.at),type:7,serverStatus:0,_parsedContent:{text:item.text}}}}}});return box;
      }));
    },open(){chat.hidden=false;list.scrollTop=list.scrollHeight-list.clientHeight;state.mount();}};
    (window as unknown as {staleState:typeof state}).staleState=state;
    list.addEventListener('scroll',()=>requestAnimationFrame(()=>state.mount()));document.querySelector('#back')!.addEventListener('click',()=>{chat.hidden=true;});
    document.querySelector('.conversation')!.addEventListener('click',()=>state.open());state.open();
  },origin);
  const mapping=observedMapping(server.origin);let collector=new InboxCollector(owner,mapping,data,root,'headless');
  const cursor=()=>JSON.parse((store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='dm'").get() as {cursor_json:string}).cursor_json);
  const lastRead=()=>(store.db.prepare("SELECT last_read FROM discovered_conversations WHERE id='conv-a'").get() as {last_read:number}|undefined)?.last_read??0;
  return {root,owner,store,data,mapping,origin,cursor,lastRead,get collector(){return collector;},
    recover(){now+=120_001;collector.dispose();collector=new InboxCollector(owner,mapping,new AutomationStore(store,()=>now),root,'headless');},
    close(){collector.dispose();store.close();}};
}

// Fixed MIT DSH 7989640 message-tracker.mjs:64-77 preserves native identity separately from replaceable window evidence.
test('a vanished native anchor discards only that peer position evidence then rebuilds from fresh windows without replay or false completion',async()=>{
  const f=await setup();try{
    await f.collector.collect('dm',new AbortController().signal);const before=f.cursor(),active=before.sweep??before.parked[0];expect(active.anchor.ids).toEqual(['7104','7105']);
    const other={...active,peer:{uid:'201',secUid:'other-sec',title:'Other fixture',conversationId:'conv-b'}};
    before.parked=[other];before.completed=[{id:'conv-a',latest:active.latest},{id:'conv-b',latest:active.latest}];
    f.store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='dm'").run(JSON.stringify(before));
    const priorEvents=f.store.events().map(event=>({id:event.id,binding:event.binding,payload:event.payload})),budget=f.store.db.prepare('SELECT * FROM budgets ORDER BY kind').all();
    await owner.dm.evaluate(()=>{const state=(window as unknown as {staleState:{changed:boolean;open():void}}).staleState;state.changed=true;state.open();});
    const reads=vi.spyOn(ObservedReader.prototype,'dmWindow');
    try{await expect(f.collector.collect('dm',new AbortController().signal)).rejects.toThrow('OBSERVATION_DM_ANCHOR_NOT_FOUND');expect(reads.mock.calls.length).toBeLessThanOrEqual(3);}finally{reads.mockRestore();}
    const stale=f.cursor();expect(stale.sweep?.peer.conversationId).not.toBe('conv-a');expect(stale.parked.filter((item:typeof active)=>item.peer.conversationId==='conv-a')).toEqual([]);
    expect(stale.parked.find((item:typeof active)=>item.peer.conversationId==='conv-b')).toEqual(other);
    expect(stale.completed.map((item:{id:string})=>item.id)).toEqual(['conv-b']);expect(stale.deferred).toMatchObject([{id:'conv-a',code:'OBSERVATION_DM_ANCHOR_NOT_FOUND'}]);
    expect(f.lastRead()).toBe(0);for(const prior of priorEvents)expect(f.store.events().find(event=>event.id===prior.id)).toMatchObject(prior);
    expect(f.store.events().some(event=>event.payload.platformEventId==='7305')).toBe(true);expect(f.data.state().startedAt).toBe(f.origin);
    const blockedCount=f.store.events().length;await f.collector.collect('dm',new AbortController().signal);expect(f.store.events()).toHaveLength(blockedCount);expect(f.lastRead()).toBe(0);
    f.recover();let finished=false;
    for(let turn=0;turn<24;turn++){await f.collector.collect('dm',new AbortController().signal);if(f.lastRead()>0){finished=true;break;}}
    expect(finished).toBe(true);expect(f.cursor().sweep).toBeUndefined();expect(f.cursor().deferred.some((item:{id:string})=>item.id==='conv-a')).toBe(false);
    expect(f.store.events().some(event=>event.payload.platformEventId==='7102')).toBe(true);
    expect(f.store.db.prepare('SELECT * FROM budgets ORDER BY kind').all()).toEqual(budget);expect(f.store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
    expect(f.store.db.prepare('SELECT count(*) AS n FROM source_collisions').get()).toEqual({n:0});
  }finally{f.close();}
});
