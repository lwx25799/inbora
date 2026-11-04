import assert from 'node:assert/strict';
import { mkdir,mkdtemp } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { BrowserProfileOwner } from '../dist/browser/profile-owner.js';
import { DomAdapter } from '../dist/adapters/dom-adapter.js';
import { SendCoordinator } from '../dist/core/send-coordinator.js';
import { EventStore } from '../dist/storage/store.js';
import { generateDraft } from '../dist/ai/draft-service.js';
import { browserMetrics } from '../dist/observability/browser-metrics.js';
import { fixtureServer,mapping,rowData } from '../tests/fixtures/site.ts';

// Run compiled application modules under plain Node, without Vitest or tsx transforms.
const base=resolve('.local/built-smoke');await mkdir(base,{recursive:true});const dir=await mkdtemp(join(base,'run-'));
const server=await fixtureServer();assert.equal(new URL(server.origin).hostname,'127.0.0.1');
const owner=await BrowserProfileOwner.launch(join(dir,'profile'),true);
const store=new EventStore(join(dir,'poc.sqlite'),true,()=> '2026-11-03T00:00:00Z');
try{
  await owner.open(server.origin);const config=mapping(server.origin);
  const notification=new DomAdapter(owner.notification,'COMMENT_NOTIFICATION',config);
  const dm=new DomAdapter(owner.dm,'DIRECT_MESSAGE',config);
  await owner.actor.run(async()=>{
    const n=await notification.observeNotifications();store.observe('COMMENT_NOTIFICATION','notifications',n.events,config.ownId,n.evidenceId);
    const d=await dm.observeDm('conversation-1','peer-1');store.observe('DIRECT_MESSAGE','conversation-1',d.events,config.ownId,d.evidenceId);
    await owner.notification.evaluate(e=>window.addNotification(e),rowData('comment'));
    await owner.dm.evaluate(e=>window.addDm('conversation-1',e),rowData('dm'));
    const freshN=await notification.observeNotifications();store.observe('COMMENT_NOTIFICATION','notifications',freshN.events,config.ownId,freshN.evidenceId);
    const freshD=await dm.observeDm('conversation-1','peer-1');store.observe('DIRECT_MESSAGE','conversation-1',freshD.events,config.ownId,freshD.evidenceId);
  });
  assert.equal(store.events().length,2);
  for(const event of store.events()){
    const adapter=event.payload.channel==='DIRECT_MESSAGE'?dm:notification;
    const draft=store.draft(await generateDraft(store,event.id));
    const snapshot=await owner.actor.run(()=>adapter.inspect(event.payload));store.approve(draft.id,snapshot,draft.version,draft.text);
    assert.equal(await new SendCoordinator(store,owner.actor).send(draft.id,adapter,false),'CONFIRMED');
  }
  assert.equal(store.events().filter(event=>event.status==='CONFIRMED').length,2);
  const metrics=await browserMetrics();assert.ok(metrics?.browserProcesses>0);assert.ok(metrics?.workingSetBytes>0);
  console.log(JSON.stringify({compiledBrowserSmoke:'PASS',channels:2,browserVersion:owner.version(),browser:metrics,realSends:0,modelCalls:0}));
}finally{store.close();await owner.close();await server.close();}
