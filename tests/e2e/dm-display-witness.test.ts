import {expect,test} from 'vitest';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {captureObserved} from '../../src/adapters/observed-reader.js';
import {inspectMessageShare} from '../../src/adapters/message-share.js';
import {saveMessagePreviews} from '../../src/adapters/message-preview.js';
import {MessagePreviewStore} from '../../src/storage/message-previews.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountObserved,observedMapping} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';
import {EventStore} from '../../src/storage/store.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {InboxCollector} from '../../src/app/inbox-collector.js';
import {InboxQueries} from '../../src/app/inbox-queries.js';

test('ordinary enrichment displays exact native text beside unknown media and only exact counterevidence revokes it',async()=>{
 const root=privateTemp('dm-display-witness-'),server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
 try{
  await mountObserved(owner,server.origin);const mapping=observedMapping(server.origin),at=Date.now()-1000;
  await owner.dm.evaluate(at=>{
   const chat=document.querySelector<HTMLElement>('#chat')!,first=chat.querySelector('.box')!;
   for(const box of chat.querySelectorAll('.box'))if(box!==first)box.remove();
   const row=first.querySelector('.message')!;row.innerHTML='<span class="text">EXACT PRIVATE [微笑]\nbody</span><img width="16" height="16" alt="unknown">';
   const native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
   native.serverId='99881';native.type=7;native.createdAt=new Date(at);native._parsedContent.text='EXACT PRIVATE [微笑]\nbody';
  },at);
  const input={mapping,channel:'dm' as const,index:0,evidenceId:'synthetic-display-witness',peer:mapping.peers[0]!,dmWindow:true};
  const batch=await owner.dm.evaluate(captureObserved,input),event=batch.events[0]!,original=JSON.stringify(event),cache=new MessagePreviewStore(root),signal=new AbortController().signal;
  expect(event.observationIssue).toBe('DM_CONTENT_UNVERIFIED');
  const inspected=await owner.dm.evaluate(inspectMessageShare,{mapping,event,peer:mapping.peers[0]!});
  expect(inspected).toHaveProperty('displayText','EXACT PRIVATE [微笑]\nbody');expect(inspected.share).toBeNull();
  expect(JSON.stringify(inspected.diagnostic)).not.toMatch(/EXACT PRIVATE|99881/u);
  await saveMessagePreviews(owner.dm,mapping,batch,root,signal,mapping.peers[0]);
  expect(cache.displayText(event,mapping.self.uid)).toBe('EXACT PRIVATE [微笑]\nbody');expect(JSON.stringify(event)).toBe(original);
  await owner.dm.locator('.text').evaluate(node=>{node.textContent='';});
  await saveMessagePreviews(owner.dm,mapping,batch,root,signal,mapping.peers[0]);
  expect(cache.displayText(event,mapping.self.uid)).toBe('EXACT PRIVATE [微笑]\nbody');
  await owner.dm.locator('.text').evaluate(node=>node.remove());
  await saveMessagePreviews(owner.dm,mapping,batch,root,signal,mapping.peers[0]);
  expect(cache.displayText(event,mapping.self.uid)).toBe('EXACT PRIVATE [微笑]\nbody');
  await owner.dm.locator('.message').evaluate(row=>{const text=document.createElement('span');text.className='text';text.textContent='CONTRADICTORY';row.prepend(text);});
  await saveMessagePreviews(owner.dm,mapping,batch,root,signal,mapping.peers[0]);
  expect(cache.displayText(event,mapping.self.uid)).toBeNull();expect(cache.list(event,mapping.self.uid).length).toBeGreaterThan(0);
  expect(JSON.stringify(event)).toBe(original);
 }finally{await owner.close();await server.close();}
});

test('normal collection invalidates expanded timelines for text enrichment and revocation without replaying work',async()=>{
 const root=privateTemp('dm-display-revision-'),server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(root,'profile'),true),
   store=new EventStore(join(root,'poc.sqlite'),true),origin=Date.now()-10_000;
 await migrateClient(store,join(root,'backup-client.sqlite'));await migrateAutomation(store,join(root,'backup-auto.sqlite'));
 const data=new AutomationStore(store);data.initialize(origin);store.bindAccount('100');
 data.configureCollection({ownId:'100',comments:false,inbox:true,commentIntervalMs:30_000,dmIntervalMs:15_000});
 await mountObserved(owner,server.origin);const mapping=observedMapping(server.origin),collector=new InboxCollector(owner,mapping,data,root,'headless');
 try{
  await owner.dm.evaluate(at=>{
   const chat=document.querySelector<HTMLElement>('#chat')!,first=chat.querySelector('.box')!;
   for(const box of chat.querySelectorAll('.box'))if(box!==first)box.remove();
   const row=first.querySelector('.message')!;row.innerHTML='<span class="text">EXACT BODY</span><img width="16" height="16">';
   const native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
   native.serverId='99882';native.type=7;native.createdAt=new Date(at);native._parsedContent.text='EXACT BODY';
   document.querySelector('#back')!.addEventListener('click',()=>{chat.hidden=true;});
   document.querySelector('.conversation')!.addEventListener('click',()=>{chat.hidden=false;});
  },origin+1000);
  const signal=new AbortController().signal;await collector.collect('dm',signal);
  const event=store.events()[0]!,queries=new InboxQueries(store,root,()=> 'WAITING'),cache=new MessagePreviewStore(root);
  cache.saveDisplayText(event.payload,'100',null);const before=queries.timeline(event).projectionRevision;
  await collector.collect('dm',signal);const enriched=queries.timeline(event).projectionRevision;
  expect(enriched).not.toBe(before);expect(cache.displayText(event.payload,'100')).toBe('EXACT BODY');
  await collector.collect('dm',signal);expect(queries.timeline(event).projectionRevision).toBe(enriched);
  await owner.dm.locator('.text').evaluate(node=>{node.textContent='CONTRADICTORY';});
  await collector.collect('dm',signal);expect(queries.timeline(event).projectionRevision).not.toBe(enriched);
  expect(cache.displayText(event.payload,'100')).toBeNull();expect(store.event(event.id)).toEqual(event);
  expect(store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  expect(store.db.prepare('SELECT sum(used) n FROM budgets').get()).toEqual({n:0});
 }finally{collector.dispose();store.close();await owner.close();await server.close();}
});
