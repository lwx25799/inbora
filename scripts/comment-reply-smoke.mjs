import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixtureServer} from '../tests/fixtures/site.ts';
import {mountCommentReply,commentReplyMapping,reloadableCommentReply} from '../tests/fixtures/observed-site.ts';
const source=process.argv[2]==='source',root=source?'src':'dist';
const url=name=>pathToFileURL(resolve(root,name.replace(/\.js$/,source?'.ts':'.js'))).href;
const {BrowserProfileOwner}=await import(url('browser/profile-owner.js'));
const {captureObserved}=await import(url('adapters/observed-reader.js'));
const {ObservedCommentReply}=await import(url('adapters/observed-comment-reply.js'));
const {SendCoordinator}=await import(url('core/send-coordinator.js'));
const {EventStore}=await import(url('storage/store.js'));
const base=resolve('.local/comment-reply-smoke');await mkdir(base,{recursive:true});const dir=await mkdtemp(join(base,'run-'));
const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(dir,'profile'),true);
const store=new EventStore(join(dir,'poc.sqlite'),true,()=> '2026-11-03T00:00:00Z');
try{
  await mountCommentReply(owner,server.origin);const mapping=commentReplyMapping(server.origin);mapping.portalWorkIds=['10'];
  await owner.notification.locator('.reply-action').evaluate(action=>action.addEventListener('click',()=>{
    const controls=document.querySelector('#root-comment #reply-controls');if(controls)document.body.append(controls);
  }));
  const batch=await owner.actor.run(()=>owner.notification.evaluate(captureObserved,{mapping:mapping.observation,channel:'comments',index:0,evidenceId:'fixture-root-snapshot'}));
  store.observe('COMMENT_NOTIFICATION','work:10',[],'100','fixture');store.observe('COMMENT_NOTIFICATION','work:10',batch.events,'100','fixture');
  const event=store.events()[0],draft=store.saveDraft(event.id,'local fixture parent reply','mock'),adapter=new ObservedCommentReply(owner.notification,mapping);
  const snapshot=await owner.actor.run(()=>adapter.inspect(event.payload));
  const serverTime=Math.floor(Date.now()/1000)*1000-1000;
  await owner.notification.route('**/aweme/v1/web/comment/list/**',route=>route.fulfill({headers:{date:new Date(serverTime).toUTCString()},json:{status_code:0,extra:{now:serverTime},comments:[]}}));
  await owner.notification.evaluate(async()=>{await(await fetch('/aweme/v1/web/comment/list/?aweme_id=10')).json();});
  await owner.notification.locator('#comment-send').evaluate(button=>button.addEventListener('click',()=>{
    const root=document.querySelector('#root-comment'),info=Object.getOwnPropertyDescriptor(root,'__reactFiber$fixture').value.return.memoizedProps.commentInfo;
    const at=Math.floor((Date.now()-1000)/1000);info.replyComment[0].createTime=at;
    Object.getOwnPropertyDescriptor(root.querySelector('.comment'),'__reactFiber$fixture').value.return.memoizedProps.commentInfo.createTime=at;
  }));
  store.approve(draft.id,snapshot,draft.version,draft.text);
  const click=adapter.clickOnce.bind(adapter);adapter.clickOnce=async boundary=>{
    assert.equal(store.db.prepare('SELECT status FROM send_intents').get().status,'INTENT_RECORDED');await click(boundary);};
  assert.equal(await new SendCoordinator(store,owner.actor).send(draft.id,adapter,false),'CONFIRMED');
  assert.equal(await owner.notification.evaluate(()=>window.commentClicks),1);
  // Exercise the independent rendered child + passive server-status path under source and compiled runtimes.
  await mountCommentReply(owner,server.origin);const networkAdapter=new ObservedCommentReply(owner.notification,mapping);
  await networkAdapter.inspect(event.payload);
  const at=(Date.now()-1000)/1000;
  await owner.notification.route('**/aweme/v1/web/comment/list/reply/**',route=>route.fulfill({json:{status_code:0,comments:[{
    cid:'901',aweme_id:'10',reply_id:'11',text:draft.text,user:{uid:'100',sec_uid:'self-sec'},status:1,create_time:at}]}}));
  await owner.notification.evaluate(async({at,text})=>{
    const root=document.querySelector('#root-comment'),child=document.createElement('div');child.className='comment';
    Object.getOwnPropertyDescriptor(root,'__reactFiber$fixture').value.return.memoizedProps.commentInfo.replyTotal=1;
    Object.defineProperty(child,'__reactFiber$fixture',{value:{return:{memoizedProps:{level:2,levelOneCid:'11',awemeInfo:{awemeId:'10'},
      commentInfo:{cid:'901',replyId:'11',text,createTime:at,user:{uid:'100',secUid:'self-sec'}}}}}});
    child.innerHTML='<a class="author" href="/user/self-sec">Self</a><div class="body"></div><div class="tooltip" id="tooltip_901">Actions</div>';
    child.querySelector('.body').textContent=text;root.append(child);await fetch('/aweme/v1/web/comment/list/reply/?comment_id=11');
  },{at,text:draft.text});
  assert.equal((await networkAdapter.readback(event.payload,draft.text,[],new Date(Date.now()-5000).toISOString()))?.id,'901');
  networkAdapter.dispose();adapter.dispose();
  await mountCommentReply(owner,server.origin);
  await reloadableCommentReply(owner.notification,server.origin);
  await owner.notification.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>{
    const list=document.querySelector('#comment-list'),prior=list.cloneNode(true);prior.style.display='none';list.before(prior);
    const hidden=document.createElement('div');hidden.className='comment';hidden.style.display='none';list.prepend(hidden);
    void fetch('/aweme/v1/web/comment/list/?aweme_id=10');
  }));
  await owner.notification.route('**/aweme/v1/web/comment/list/**',route=>{
    const now=Math.floor(Date.now()/1000)*1000-1000;
    return route.fulfill({headers:{date:new Date(now).toUTCString()},json:{status_code:0,extra:{now}}});
  });
  const freshStore=new EventStore(join(dir,'fresh-clock.sqlite'),true,()=> '2026-11-03T00:00:00Z');
  const freshMapping=commentReplyMapping(server.origin);freshMapping.observation.environment='douyin';
  const freshAdapter=new ObservedCommentReply(owner.notification,freshMapping);
  try{
    freshStore.observe('COMMENT_NOTIFICATION','work:10',[],'100','fixture');freshStore.observe('COMMENT_NOTIFICATION','work:10',batch.events,'100','fixture');
    const freshEvent=freshStore.events()[0],freshDraft=freshStore.saveDraft(freshEvent.id,'fresh sender clock fixture','mock');
    freshStore.approve(freshDraft.id,await freshAdapter.inspect(freshEvent.payload),freshDraft.version,freshDraft.text);
    let refreshes=0;const onNavigation=()=>refreshes++;owner.notification.on('framenavigated',onNavigation);
    try{
      assert.equal(await new SendCoordinator(freshStore,owner.actor).send(freshDraft.id,freshAdapter,false),'CONFIRMED');
      assert.equal(refreshes,1);assert.equal(await owner.notification.evaluate(()=>window.commentClicks),1);
    }finally{owner.notification.off('framenavigated',onNavigation);}
  }finally{freshAdapter.dispose();freshStore.close();}
  console.log(JSON.stringify({nativeCommentReplySmoke:'PASS',runtime:source?'tsx-source':'compiled-node',fixtureClicks:2,freshSenderRefreshes:1,realSends:0,modelCalls:0}));
}finally{store.close();await owner.close();await server.close();}
