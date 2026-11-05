import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixtureServer} from '../tests/fixtures/site.ts';
import {mountDmReply,dmReplyMapping} from '../tests/fixtures/observed-site.ts';

const source=process.argv[2]==='source',root=source?'src':'dist';
const moduleUrl=name=>pathToFileURL(resolve(root,name.replace(/\.js$/,source?'.ts':'.js'))).href;
const {BrowserProfileOwner}=await import(moduleUrl('browser/profile-owner.js'));
const {ObservedReader}=await import(moduleUrl('adapters/observed-reader.js'));
const {ObservedDmReply}=await import(moduleUrl('adapters/observed-dm-reply.js'));
const {validateDmReplyMapping}=await import(moduleUrl('config/site-mapping.js'));
const {SendCoordinator}=await import(moduleUrl('core/send-coordinator.js'));
const {EventStore}=await import(moduleUrl('storage/store.js'));
const base=resolve('.local/dm-reply-smoke');await mkdir(base,{recursive:true});const dir=await mkdtemp(join(base,'run-'));
const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(dir,'profile'),true);
const store=new EventStore(join(dir,'poc.sqlite'),true,()=> '2026-11-03T00:00:00Z');
try{
  await mountDmReply(owner,server.origin);const mapping=validateDmReplyMapping(dmReplyMapping(server.origin),false);
  const batch=await owner.actor.run(()=>new ObservedReader(owner.dm,mapping.observation).dm(0));
  store.observe('DIRECT_MESSAGE','conv-a',[],'100','fixture');store.observe('DIRECT_MESSAGE','conv-a',batch.events,'100','fixture');
  const event=store.events()[0],draft=store.saveDraft(event.id,'local fixture native reply','mock');
  const adapter=new ObservedDmReply(owner.dm,mapping);
  store.approve(draft.id,await owner.actor.run(()=>adapter.inspect(event.payload)),draft.version,draft.text);
  const click=adapter.clickOnce.bind(adapter);
  adapter.clickOnce=async()=>{assert.equal(store.db.prepare('SELECT status FROM send_intents').get().status,'INTENT_RECORDED');await click();};
  assert.equal(await new SendCoordinator(store,owner.actor).send(draft.id,adapter,false),'CONFIRMED');
  assert.equal(await owner.dm.evaluate(()=>window.nativeClicks),1);
  assert.ok(store.db.prepare('SELECT used FROM budgets').all().every(row=>row.used===0));
  console.log(JSON.stringify({nativeDmReplySmoke:'PASS',runtime:source?'tsx-source':'compiled-node',fixtureClicks:1,realSends:0,modelCalls:0}));
}finally{store.close();await owner.close();await server.close();}
