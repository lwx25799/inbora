import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureServer } from '../tests/fixtures/site.ts';
import { observedMapping, mountObserved, mountVirtualizedConversations, mountCommentReply } from '../tests/fixtures/observed-site.ts';

const source = process.argv[2] === 'source', root = source ? 'src' : 'dist';
const moduleUrl = name => pathToFileURL(resolve(root,name.replace(/\.js$/,source?'.ts':'.js'))).href;
const {BrowserProfileOwner} = await import(moduleUrl('browser/profile-owner.js'));
const {ObservedReader,captureObserved} = await import(moduleUrl('adapters/observed-reader.js'));
const {validateObservationMapping} = await import(moduleUrl('config/site-mapping.js'));
const {EventStore} = await import(moduleUrl('storage/store.js'));
const base=resolve('.local/observed-smoke');await mkdir(base,{recursive:true});const dir=await mkdtemp(join(base,'run-'));
const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(dir,'profile'),true);
const store=new EventStore(join(dir,'poc.sqlite'),true,()=> '2026-11-03T00:00:00Z');
try {
  await mountObserved(owner,server.origin);
  // Cover the real opening path: the permitted row is selected before delayed header metadata mounts.
  await owner.dm.evaluate(()=>{
    document.querySelector('#chat').hidden=true; window.opened=0;
    const panel=document.querySelector('#dm-panel'),row=document.querySelector('.conversation');
    panel.style.minHeight='24px';panel.hidden=true;row.remove();
    document.querySelector('#dm-open').addEventListener('click',()=>{
      panel.hidden=false;setTimeout(()=>panel.prepend(row),1200);
    });
    row.addEventListener('click',()=>{
      window.opened++;document.querySelector('#chat').hidden=false;
      const header=document.querySelector('#header'),props=Object.getOwnPropertyDescriptor(header,'__reactProps$fixture').value;
      const conversation=props.children.props.conversation;delete props.children.props.conversation;
      setTimeout(()=>props.children.props.conversation=conversation,120);
    });
  });
  const config=validateObservationMapping(observedMapping(server.origin),false);
  const batch=await owner.actor.run(()=>new ObservedReader(owner.dm,config).dm(0));
  assert.equal(batch.events.length,4);assert.equal(batch.unsupported,1);
  assert.equal(await owner.dm.evaluate(()=>window.opened),1);
  store.observe('DIRECT_MESSAGE','conv-a',[],'100','fixture');
  for(let n=0;n<5;n++)store.observe('DIRECT_MESSAGE','conv-a',batch.events,'100','fixture');
  assert.equal(store.events().length,3);assert.ok(store.events().every(e=>e.status==='AWAITING_DRAFT'));
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM send_intents').get().n,0);
  await mountObserved(owner,server.origin);
  await mountVirtualizedConversations(owner.dm,true);
  config.selectors.conversationList='#conversation-list';
  const scrolled=await owner.actor.run(()=>new ObservedReader(owner.dm,config).dm(0));
  assert.deepEqual(scrolled.events.map(e=>e.platformEventId),['1','2','3','4']);
  assert.equal(await owner.dm.evaluate(()=>window.opened),1);
  assert.equal(await owner.dm.evaluate(()=>window.outsideOpened),0);
  assert.ok(await owner.dm.evaluate(()=>window.listScrolls>0));
  await mountCommentReply(owner,server.origin);
  await owner.notification.locator('#comment-list').evaluate(node=>node.style.marginTop='818px');
  await owner.notification.evaluate(captureObserved,{mapping:config,channel:'commentReveal',index:0,evidenceId:'fixture-reveal'});
  assert.ok(await owner.notification.evaluate(()=>scrollY>0&&document.querySelector('#comment-list').getBoundingClientRect().top<innerHeight));
  await owner.notification.evaluate(()=>{
    const root=document.querySelector('#root-comment');
    Object.getOwnPropertyDescriptor(root,'__reactFiber$fixture').value.return.memoizedProps.commentInfo.text='root fixture input[赞]';
    root.querySelector('.body').innerHTML='root fixture input<img width="16" height="16" src="/emoji.png" alt="[赞]">';
  });
  const emoji=await owner.notification.evaluate(captureObserved,{mapping:config,channel:'comments',index:0,evidenceId:'fixture-emoji'});
  assert.equal(emoji.events[0].text,'root fixture input[赞]');assert.equal(emoji.events[0].observationIssue,undefined);
  const diagnostic=await new ObservedReader(owner.notification,config).diagnostic('comments');
  assert.equal(diagnostic.source,'comments');assert.ok(diagnostic.samples.length>0);
  assert.ok(!JSON.stringify(diagnostic).includes('root fixture input'));
  await mountObserved(owner,server.origin);
  await owner.dm.evaluate(()=>{
    const list=document.createElement('div');list.id='history-window';list.style.cssText='height:40px;overflow-y:auto;width:300px';
    for(const box of document.querySelectorAll('.box'))list.append(box);
    document.querySelector('#chat').append(list);
  });
  const windowed=await new ObservedReader(owner.dm,config).dmWindow(config.peers[0],0);
  assert.equal(windowed.dmViewport.viewport,40);assert.equal(windowed.events[0].platformEventId,'1');
  await new ObservedReader(owner.dm,config).scrollDm(config.peers[0],windowed.dmViewport.maximum);
  const backDiagnostic=(await new ObservedReader(owner.dm,config).diagnostic('dm')).back;
  assert.equal(backDiagnostic.count,1);assert.equal(backDiagnostic.nodes[0].tag,'BUTTON');
  assert.ok(!JSON.stringify(backDiagnostic).includes('fixture'));
  await owner.notification.locator('.body img').evaluate(node=>node.removeAttribute('alt'));
  const unverified=await owner.notification.evaluate(captureObserved,{mapping:config,channel:'comments',index:0,evidenceId:'fixture-review'});
  assert.equal(unverified.events[0].observationIssue,'COMMENT_TEXT_UNVERIFIED');
  store.observe('COMMENT_NOTIFICATION','work:10',unverified.events,'100','fixture',new Date().toISOString(),Date.UTC(2026,0,1));
  assert.equal(store.events().at(-1).status,'MANUAL_REVIEW');
  await owner.notification.locator('.body').evaluate(node=>node.remove());
  await assert.rejects(owner.notification.evaluate(captureObserved,{mapping:config,channel:'comments',index:0,evidenceId:'fixture-missing-body'}),/OBSERVATION_COMMENT_TEXT_DOM_NOT_READY/);
  await owner.notification.locator('#self').evaluate(node=>node.remove());
  await assert.rejects(owner.notification.evaluate(captureObserved,{mapping:config,channel:'comments',index:0,evidenceId:'fixture-missing-identity'}),/OBSERVATION_ACCOUNT_AVATAR_DOM_NOT_READY/);
  console.log(JSON.stringify({observedReaderSmoke:'PASS',runtime:source?'tsx-source':'compiled-node',events:3,emojiVerified:true,unverifiedBodyPreserved:true,readStageCodes:true,sends:0}));
} finally {store.close();await owner.close();await server.close();}
