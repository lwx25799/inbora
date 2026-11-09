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
    const media=document.querySelector('.message img');media.src='/PRIVATE-MEDIA-URL';media.alt='PRIVATE-MEDIA-LABEL';media.width=16;media.height=16;
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
  assert.equal(batch.events.length,5);assert.equal(batch.unsupported,1);
  assert.deepEqual(batch.events.map(event=>event.platformEventId),['1','2','3','4','5']);
  assert.equal(batch.events[4].text,'[图片或表情消息，需人工查看]');
  assert.equal(batch.events[4].contentType,'IMAGE');assert.equal(batch.events[4].observationIssue,'DM_CONTENT_UNVERIFIED');
  assert.ok(!JSON.stringify(batch).includes('PRIVATE-MEDIA-'));
  assert.equal(await owner.dm.evaluate(()=>window.opened),1);
  store.observe('DIRECT_MESSAGE','conv-a',[],'100','fixture');
  for(let n=0;n<5;n++)store.observe('DIRECT_MESSAGE','conv-a',batch.events,'100','fixture');
  assert.equal(store.events().length,4);
  assert.deepEqual(store.events().filter(event=>event.status==='AWAITING_DRAFT').map(event=>event.payload.platformEventId),['1','2','3']);
  assert.equal(store.events().find(event=>event.payload.platformEventId==='5').status,'MANUAL_REVIEW');
  assert.ok(!store.events().some(event=>event.payload.platformEventId==='4'));
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM send_intents').get().n,0);
  await mountObserved(owner,server.origin);
  await mountVirtualizedConversations(owner.dm,true);
  config.selectors.conversationList='#conversation-list';
  const scrolled=await owner.actor.run(()=>new ObservedReader(owner.dm,config).dm(0));
  assert.deepEqual(scrolled.events.map(e=>e.platformEventId),['1','2','3','4','5']);
  assert.equal(scrolled.events[4].contentType,'IMAGE');assert.equal(scrolled.events[4].observationIssue,'DM_CONTENT_UNVERIFIED');
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
  await owner.dm.evaluate(()=>{
    const native=Object.getOwnPropertyDescriptor(document.querySelector('.message'),'__reactProps$fixture').value.children.props.message;
    const parsed=native._parsedContent;delete native._parsedContent;
    const parent=Object.create(Object.getPrototypeOf(native));Object.defineProperty(parent,'_parsedContent',{value:parsed});Object.setPrototypeOf(native,parent);
  });
  const dmDiagnostic=await new ObservedReader(owner.dm,config).diagnostic('dm');
  assert.equal(dmDiagnostic.windowRows,windowed.loaded);assert.equal(dmDiagnostic.contentMissingRows,0);
  assert.deepEqual(dmDiagnostic.messageSamples.map(sample=>sample.windowIndex),Array.from({length:windowed.loaded},(_,index)=>index));
  assert.equal(dmDiagnostic.messageSamples[0].contentMissing,false);assert.equal(dmDiagnostic.messageSamples[0].timeValid,true);
  assert.equal(dmDiagnostic.shareStage,'VERIFIED');assert.ok(dmDiagnostic.messageSamples[0].parsedFields.some(field=>field.key==='text'&&field.type==='string'));
  assert.equal(dmDiagnostic.conversationSamples[0].titleCount,1);assert.equal(dmDiagnostic.conversationSamples[0].titleNonEmpty,true);
  assert.equal(dmDiagnostic.conversationSamples[0].nativeConversationPresent,true);assert.equal(dmDiagnostic.conversationSamples[0].securePeerPresent,true);
  assert.equal(dmDiagnostic.messageSamples[0].textNodes,1);assert.equal(dmDiagnostic.messageSamples[0].nonEmptyTextNodes,1);
  assert.equal(dmDiagnostic.messageSamples[0].visibleCardNodes,0);
  assert.equal(dmDiagnostic.messageSamples[0].parsedPresent,true);assert.equal(dmDiagnostic.messageSamples[0].parsedRejected,false);
  await owner.dm.evaluate(()=>{
    const row=document.querySelector('.message'),native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture').value.children.props.message;
    row.style.minHeight='18px';row.replaceChildren();native.type=800;native.serverStatus=0;
  });
  const missingDiagnostic=await new ObservedReader(owner.dm,config).diagnostic('dm',0,config.peers[0]);
  assert.equal(missingDiagnostic.contentMissingRows,1);assert.equal(missingDiagnostic.messageSamples[0].windowIndex,0);
  assert.equal(missingDiagnostic.messageSamples[0].contentMissing,true);assert.equal(missingDiagnostic.messageSamples[0].nativeKind,800);
  assert.equal(missingDiagnostic.messageSamples[0].nativeStatus,0);
  await assert.rejects(owner.dm.evaluate(captureObserved,{mapping:config,channel:'dm',index:0,evidenceId:'fixture-window-gap',peer:config.peers[0],dmWindow:true}),/OBSERVATION_DM_CONTENT_DOM_NOT_READY/);
  await new ObservedReader(owner.dm,config).scrollDm(config.peers[0],windowed.dmViewport.maximum);
  const backDiagnostic=dmDiagnostic.back;
  assert.equal(backDiagnostic.count,1);assert.equal(backDiagnostic.nodes[0].tag,'BUTTON');
  assert.ok(!JSON.stringify(backDiagnostic).includes('fixture'));
  await owner.dm.evaluate(()=>{
    const back=document.createElement('div');back.id='back';back.style.cssText='position:fixed;left:12px;top:40px;width:32px;height:32px';
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('width','32');svg.setAttribute('height','32');
    back.append(svg);document.querySelector('#back').replaceWith(back);window.svgBackClicks=0;
    svg.addEventListener('click',()=>{window.svgBackClicks++;document.querySelector('#chat').hidden=true;});
  });
  await new ObservedReader(owner.dm,observedMapping(server.origin)).conversations();
  assert.equal(await owner.dm.evaluate(()=>window.svgBackClicks),1);
  assert.equal(await owner.dm.locator('#chat').isVisible(),false);
  await owner.notification.locator('.body img').evaluate(node=>node.removeAttribute('alt'));
  const unverified=await owner.notification.evaluate(captureObserved,{mapping:config,channel:'comments',index:0,evidenceId:'fixture-review'});
  assert.equal(unverified.events[0].observationIssue,'COMMENT_TEXT_UNVERIFIED');
  store.observe('COMMENT_NOTIFICATION','work:10',unverified.events,'100','fixture',new Date().toISOString(),Date.UTC(2026,0,1));
  assert.equal(store.events().at(-1).status,'MANUAL_REVIEW');
  await owner.notification.locator('.body').evaluate(node=>node.remove());
  await assert.rejects(owner.notification.evaluate(captureObserved,{mapping:config,channel:'comments',index:0,evidenceId:'fixture-missing-body'}),/OBSERVATION_COMMENT_TEXT_DOM_NOT_READY/);
  await owner.notification.locator('#self').evaluate(node=>node.remove());
  await assert.rejects(owner.notification.evaluate(captureObserved,{mapping:config,channel:'comments',index:0,evidenceId:'fixture-missing-identity'}),/OBSERVATION_ACCOUNT_AVATAR_DOM_NOT_READY/);
  console.log(JSON.stringify({observedReaderSmoke:'PASS',runtime:source?'tsx-source':'compiled-node',events:4,dmMediaPreserved:true,emojiVerified:true,unverifiedBodyPreserved:true,readStageCodes:true,sends:0}));
} finally {store.close();await owner.close();await server.close();}
