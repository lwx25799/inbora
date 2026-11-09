import {afterAll,beforeAll,expect,test} from 'vitest';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {captureObserved} from '../../src/adapters/observed-reader.js';
import {InboxCollector} from '../../src/app/inbox-collector.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountObserved,observedMapping} from '../fixtures/observed-site.js';
import {database,privateTemp} from '../helpers.js';

let server:Awaited<ReturnType<typeof fixtureServer>>,owner:BrowserProfileOwner;
beforeAll(async()=>{server=await fixtureServer();owner=await BrowserProfileOwner.launch(join(privateTemp('dm-batch-triage-'),'profile'),true);});
afterAll(async()=>{await owner?.close();await server?.close();});

test.each(['locate','conversations'] as const)('a metadata-incomplete unrelated list row does not poison an exact valid target (%s)',async channel=>{
  await mountObserved(owner,server.origin);await owner.dm.evaluate(()=>{
    const incomplete=document.createElement('div');incomplete.className='conversation';incomplete.innerHTML='<span class="title">Unrelated fixture</span>';
    Object.defineProperty(incomplete,'__reactFiber$fixture',{value:{return:{memoizedProps:{conversation:{_toParticipantSecUserId:'unrelated-sec'}}}}});
    document.querySelector('#dm-panel')!.prepend(incomplete);
  });
  const mapping=observedMapping(server.origin),input:Parameters<typeof captureObserved>[0]={mapping,channel,index:0,evidenceId:'synthetic-list-isolation',peer:mapping.peers[0]!};
  const batch=await owner.dm.evaluate(captureObserved,input);
  if(channel==='locate')expect(batch.conversation?.rowIndex).toBe(1);
  else expect(batch.peers).toEqual([mapping.peers[0]]);
  expect(batch.unsupported).toBe(1);
});

test('an unrecognized content row retains other exact window messages without marking a completed read',async()=>{
  await mountObserved(owner,server.origin);const origin=Date.now()-10_000;
  await owner.dm.evaluate(origin=>{
    const chat=document.querySelector('#chat') as HTMLElement;chat.querySelectorAll('.box').forEach(box=>box.remove());
    for(let index=0;index<4;index++){
      const box=document.createElement('div');box.className='box';const row=document.createElement('div');row.className='message';row.style.minHeight='24px';
      const text=index<3?'synthetic safe message '+index:'';
      if(index<3){const body=document.createElement('span');body.className='text';body.textContent=text;row.append(body);}
      Object.defineProperty(row,'__reactProps$fixture',{value:{children:{props:{message:{serverId:String(8100+index),conversationId:'conv-a',sender:'200',
        createdAt:new Date(origin+1000+index),type:index<3?7:999,serverStatus:0,_parsedContent:{text}}}}}});
      box.append(row);chat.append(box);
    }
    document.querySelector('#back')!.addEventListener('click',()=>{chat.hidden=true;});
    document.querySelector('.conversation')!.addEventListener('click',()=>{chat.hidden=false;});
  },origin);
  const store=database(),root=privateTemp('dm-partial-window-');
  await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  let clock=Date.now();const data=new AutomationStore(store,()=>clock);data.initialize(origin);store.bindAccount('100');
  data.configureCollection({ownId:'100',comments:false,inbox:true,commentIntervalMs:30_000,dmIntervalMs:15_000});
  const collector=new InboxCollector(owner,observedMapping(server.origin),data,root,'headless');
  try{
    await expect(collector.collect('dm',new AbortController().signal)).rejects.toThrow('OBSERVATION_DM_CONTENT_DOM_NOT_READY');
    expect(store.events().map(event=>event.payload.platformEventId)).toEqual(['8100','8101','8102']);
    expect(store.db.prepare("SELECT last_read FROM discovered_conversations WHERE id='conv-a'").get()).toEqual({last_read:0});
    expect(store.db.prepare("SELECT last_success FROM collection_progress WHERE source='dm'").get()).toEqual({last_success:null});
    expect(store.db.prepare('SELECT used FROM budgets ORDER BY kind').all()).toEqual([{used:0},{used:0}]);
    expect(store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
    for(const event of store.events())expect(()=>store.assertModelObservation(event.payload)).toThrow('DM_CONTENT_UNVERIFIED');
    const mapping=observedMapping(server.origin),strict:Parameters<typeof captureObserved>[0]={mapping,channel:'dm',index:0,
      evidenceId:'synthetic-strict-read',peer:mapping.peers[0]!,dmWindow:true};
    await expect(owner.dm.evaluate(captureObserved,strict)).rejects.toThrow('OBSERVATION_DM_CONTENT_DOM_NOT_READY');
    const oldIds=store.events().map(event=>event.id);
    await owner.dm.evaluate(()=>{
      const row=document.querySelectorAll('.message')[3]!,body=document.createElement('span');body.className='text';body.textContent='late exact text';row.append(body);
      Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message._parsedContent.text='late exact text';
    });
    clock+=121_000;await collector.collect('dm',new AbortController().signal);
    expect(store.events().map(event=>event.payload.platformEventId)).toEqual(['8100','8101','8102','8103']);
    expect(store.events().slice(0,3).map(event=>event.id)).toEqual(oldIds);
    for(const event of store.events())expect(()=>store.assertModelObservation(event.payload)).not.toThrow();
    expect(store.db.prepare('SELECT count(*) AS n FROM source_collisions').get()).toEqual({n:0});
    expect(store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
  }finally{collector.dispose();store.close();}
});

test.each([null,'200'] as const)('an exact native header cannot authorize conflicting non-self senders (saved UID %s)',async uid=>{
  await mountObserved(owner,server.origin);await owner.dm.evaluate(()=>{
    const native=Object.getOwnPropertyDescriptor(document.querySelectorAll('.message')[1]!,'__reactProps$fixture')!.value.children.props.message;
    native.sender='999';
  });
  const mapping=observedMapping(server.origin),peer={...mapping.peers[0]!,uid},input:Parameters<typeof captureObserved>[0]={
    mapping,channel:'dm',index:0,evidenceId:'synthetic-sender-conflict',peer,dmWindow:true};
  await expect(owner.dm.evaluate(captureObserved,input)).rejects.toThrow('OBSERVATION_SENDER_UNVERIFIED');
});
