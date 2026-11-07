import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixtureServer} from '../tests/fixtures/site.ts';
import {observedMapping,mountObserved} from '../tests/fixtures/observed-site.ts';
const source=process.argv[2]==='source',root=source?'src':'dist';
const moduleUrl=name=>pathToFileURL(resolve(root,name.replace(/\.js$/,source?'.ts':'.js'))).href;
const {BrowserProfileOwner}=await import(moduleUrl('browser/profile-owner.js'));
const {EventStore}=await import(moduleUrl('storage/store.js'));
const {migrateClient}=await import(moduleUrl('storage/client-migration.js'));
const {migrateAutomation}=await import(moduleUrl('storage/automation-migration.js'));
const {AutomationStore}=await import(moduleUrl('storage/automation-store.js'));
const {InboxCollector}=await import(moduleUrl('app/inbox-collector.js'));
const {CollectionScheduler}=await import(moduleUrl('app/collection-scheduler.js'));
const base=resolve('.local/automation-smoke');await mkdir(base,{recursive:true});const dir=await mkdtemp(join(base,'run-'));
const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(dir,'profile'),true),store=new EventStore(join(dir,'poc.sqlite'),true);
let collector,scheduler;
try{
  await migrateClient(store,join(dir,'client-backup.sqlite'));await migrateAutomation(store,join(dir,'automation-backup.sqlite'));
  const data=new AutomationStore(store);data.initialize(Date.parse('2026-11-04T00:00:00Z'));store.bindAccount('100');
  data.configureCollection({ownId:'100',comments:false,inbox:true,commentIntervalMs:30000,dmIntervalMs:15000});
  await mountObserved(owner,server.origin);
  await owner.dm.evaluate(()=>{
    const chat=document.querySelector('#chat'),row=document.querySelector('.conversation');
    document.querySelector('#back').addEventListener('click',()=>{chat.hidden=true;});row.addEventListener('click',()=>{chat.hidden=false;});
  });
  collector=new InboxCollector(owner,observedMapping(server.origin),data,dir,'headless');
  scheduler=new CollectionScheduler(data,(channel,signal)=>collector.collect(channel,signal));
  await scheduler.tick();assert.equal(store.events().length,3);assert.ok(store.events().every(e=>e.status==='AWAITING_DRAFT'));
  store.db.prepare('UPDATE collection_progress SET next_at=0').run();await scheduler.tick();assert.equal(store.events().length,3);
  data.stop(true);store.db.prepare('UPDATE collection_progress SET next_at=0').run();await scheduler.tick();assert.equal(store.events().length,3);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM send_intents').get().n,0);assert.equal(store.db.prepare('SELECT count(*) AS n FROM model_calls').get().n,0);
  console.log(JSON.stringify({automationSmoke:'PASS',runtime:source?'tsx-source':'compiled-node',events:3,realModels:0,realSends:0}));
}finally{await scheduler?.close();collector?.dispose();store.close();await owner.close();await server.close();}
