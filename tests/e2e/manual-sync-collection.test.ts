import {expect,test,vi} from 'vitest';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {ClientService} from '../../src/app/service.js';
import {EventStore} from '../../src/storage/store.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import * as runtime from '../../src/config/runtime.js';
import {fixtureServer} from '../fixtures/site.js';
import {observedMapping,mountObserved} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';

type SyncStatus={sync:{runId:string;running:boolean;results:{source:string;state:string;error:string|null}[]}};

test('manual sync preserves a delayed peer and reuses collection progress to reach the next healthy peer',async()=>{
  const root=privateTemp('manual-sync-collection-'),server=await fixtureServer();
  const owner=await BrowserProfileOwner.launch(join(root,'profile'),true),store=new EventStore(join(root,'poc.sqlite'),true);
  const now=Date.now(),origin=now-10_000,mapping=observedMapping(server.origin);
  let service:ClientService|undefined;
  mapping.peers.push({uid:'300',secUid:'peer-b-sec',conversationId:'conv-b',title:'Second fixture'});
  try{
    await migrateClient(store,join(root,'client.sqlite'));await mountObserved(owner,server.origin);
    await owner.dm.evaluate(origin=>{
      const chat=document.querySelector('#chat') as HTMLElement,panel=document.querySelector('#dm-panel')!;
      const header=Object.getOwnPropertyDescriptor(document.querySelector('#header'),'__reactProps$fixture')!.value.children.props.conversation;
      const view={show(id:string,title:string,secure:string,sender:string){
        header.id=id;header._toParticipantSecUserId=secure;document.querySelector('#chat-title')!.textContent=title;
        for(const box of chat.querySelectorAll('.box'))box.remove();
        const box=document.createElement('div');box.className='box';
        const message=document.createElement('div');message.className='message';message.style.cssText='min-height:28px;width:320px';
        if(id==='conv-b'){
          const body=document.createElement('span');body.className='text';body.textContent='normal later peer';message.append(body);
        }
        Object.defineProperty(message,'__reactProps$fixture',{value:{children:{props:{message:{
          serverId:id==='conv-a'?'8901':'8902',conversationId:id,sender,createdAt:new Date(origin+1000),
          _parsedContent:{text:id==='conv-a'?'delayed missing body':'normal later peer'},
        }}}}});
        box.append(message);chat.append(box);chat.hidden=false;
      }};
      document.querySelector('#back')!.addEventListener('click',()=>{chat.hidden=true;});
      document.querySelector('.conversation')!.addEventListener('click',()=>view.show('conv-a','Fixture peer','peer-sec','200'));
      const next=document.createElement('div');next.className='conversation';next.innerHTML='<span class="title">Second fixture</span>';
      Object.defineProperty(next,'__reactFiber$fixture',{value:{return:{memoizedProps:{conversation:{id:'conv-b',_toParticipantSecUserId:'peer-b-sec'}}}}});
      next.addEventListener('click',()=>view.show('conv-b','Second fixture','peer-b-sec','300'));panel.prepend(next);chat.hidden=true;
    },origin);
    // Only configuration transport is synthetic; native identity/body/row guards and collector persistence are real.
    vi.spyOn(runtime,'loadObservationMapping').mockResolvedValue(mapping);
    const browser=BrowserService.adopt(root,owner,'headless'),observe=browser.observe.bind(browser);
    const observed=vi.spyOn(browser,'observe').mockImplementation((store,source)=>source==='works'?Promise.resolve():observe(store,source));
    const collected=vi.spyOn(browser,'collect');
    service=new ClientService(store,browser,undefined,()=>now,origin);await service.loadSettings();
    const data=new AutomationStore(store,()=>now);store.bindAccount('100');
    data.configureCollection({ownId:'100',comments:false,inbox:true,commentIntervalMs:30_000,dmIntervalMs:15_000});
    // Explicit sync ignores this deadline; a fixture timer must not race the first manual turn.
    store.db.prepare('UPDATE collection_progress SET next_at=?').run(now+3600_000);
    const token=service.authority.issueSession(),status=()=>service!.dispatch(token,{command:'getStatus'}) as Promise<SyncStatus>;
    const first=await service.dispatch(token,{command:'syncInbox'}) as SyncStatus;
    const duplicate=await service.dispatch(token,{command:'syncInbox'}) as SyncStatus;
    expect(duplicate.sync.runId).toBe(first.sync.runId);
    await service.drain();
    expect((await status()).sync.results.find(result=>result.source==='dm'))
      .toMatchObject({state:'DEFERRED',error:'OBSERVATION_DM_CONTENT_DOM_NOT_READY'});
    expect(collected.mock.calls.filter(call=>call[1]==='dm')).toHaveLength(1);
    expect(observed.mock.calls.some(call=>call[1]==='dm')).toBe(false);
    const cursor=JSON.parse((store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='dm'").get() as {cursor_json:string}).cursor_json);
    expect(cursor.deferred).toContainEqual(expect.objectContaining({id:'conv-a',code:'OBSERVATION_DM_CONTENT_DOM_NOT_READY'}));
    const watermark=(id:string)=>(store.db.prepare('SELECT last_read FROM discovered_conversations WHERE id=?').get(id) as {last_read:number}|undefined)?.last_read??0;
    expect(watermark('conv-a')).toBe(0);
    expect(store.db.prepare("SELECT last_success FROM collection_progress WHERE source='dm'").get()).toEqual({last_success:null});
    await service.dispatch(token,{command:'syncInbox'});await service.drain();
    expect((await status()).sync.results.find(result=>result.source==='dm')).toMatchObject({state:'SUCCEEDED',error:null});
    expect(store.events().some(event=>event.payload.platformEventId==='8902'&&event.payload.text==='normal later peer')).toBe(true);
    expect(watermark('conv-b')).toBeGreaterThan(0);expect(watermark('conv-a')).toBe(0);
    expect(store.db.prepare("SELECT last_error,failures FROM collection_progress WHERE source='dm'").get()).toEqual({last_error:null,failures:0});
    expect(data.state().startedAt).toBe(origin);
    expect(store.db.prepare('SELECT kind,used FROM budgets ORDER BY kind').all()).toEqual([{kind:'MODEL',used:0},{kind:'SEND',used:0}]);
    expect(store.db.prepare('SELECT count(*) AS n FROM model_calls').get()).toEqual({n:0});
    expect(store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
  }finally{await service?.close();store.close();await owner.close();await server.close();vi.restoreAllMocks();}
});

test('cancelling legacy mapped sync after its real first read prevents persistence and the next conversation',async()=>{
  const root=privateTemp('manual-sync-legacy-cancel-'),server=await fixtureServer();
  const owner=await BrowserProfileOwner.launch(join(root,'profile'),true),store=new EventStore(join(root,'poc.sqlite'),true);
  const mapping=observedMapping(server.origin),abort=new AbortController(),calls:number[]=[];
  mapping.peers.push({uid:'300',secUid:'peer-b-sec',conversationId:'conv-b',title:'Second fixture'});
  const browser=BrowserService.adopt(root,owner,'headless');
  try{
    await mountObserved(owner,server.origin);vi.spyOn(runtime,'loadObservationMapping').mockResolvedValue(mapping);
    const read=ObservedReader.prototype.dm;
    vi.spyOn(ObservedReader.prototype,'dm').mockImplementation(async function(this:ObservedReader,index,peer,partial){
      calls.push(index);const batch=await read.call(this,index,peer,partial);abort.abort();return batch;
    });
    await expect(browser.observe(store,'dm',abort.signal)).rejects.toThrow('COLLECTION_CANCELLED');
    expect(calls).toEqual([0]);expect(store.db.prepare('SELECT count(*) AS n FROM observations').get()).toEqual({n:0});
    expect(store.events()).toEqual([]);expect(store.db.prepare('SELECT used FROM budgets ORDER BY kind').all()).toEqual([{used:0},{used:0}]);
    expect(store.db.prepare('SELECT count(*) AS n FROM model_calls').get()).toEqual({n:0});
    expect(store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
  }finally{await browser.close();store.close();await server.close();vi.restoreAllMocks();}
});
