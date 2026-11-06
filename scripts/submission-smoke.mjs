import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixtureServer} from '../tests/fixtures/site.ts';
import {mountDmReply,dmReplyMapping,mountCommentReply,commentReplyMapping,mountFreshCommentPage} from '../tests/fixtures/observed-site.ts';
import {dmRequest,dmResponse} from '../tests/fixtures/submission.ts';
const source=process.argv[2]==='source',base=source?'src':'dist';
const url=name=>pathToFileURL(resolve(base,name.replace(/\.js$/,source?'.ts':'.js'))).href;
const {BrowserProfileOwner}=await import(url('browser/profile-owner.js')),
  {ObservedReader,captureObserved}=await import(url('adapters/observed-reader.js')),
  {ObservedDmReply}=await import(url('adapters/observed-dm-reply.js')),
  {ObservedCommentReply}=await import(url('adapters/observed-comment-reply.js')),
  {SendCoordinator}=await import(url('core/send-coordinator.js')),
  {EventStore}=await import(url('storage/store.js'));
const parent=resolve('.local/submission-smoke');await mkdir(parent,{recursive:true});const dir=await mkdtemp(join(parent,'run-'));
const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(dir,'profile'),true),store=new EventStore(join(dir,'poc.sqlite'),true);
try{
  await mountDmReply(owner,server.origin);const dm=dmReplyMapping(server.origin);dm.submissionReceipts=true;
  const batch=await new ObservedReader(owner.dm,dm.observation).dm(0);
  store.observe('DIRECT_MESSAGE','conv-a',[],'100','fixture','2026-11-04T00:00:00Z');
  const id=store.observe('DIRECT_MESSAGE','conv-a',batch.events,'100','fixture')[0],text='synthetic correlated reply',draft=store.saveDraft(id,text,'mock');
  const adapter=new ObservedDmReply(owner.dm,dm);
  await owner.dm.route('https://imapi.douyin.com/v1/message/send',route=>route.fulfill({headers:{'access-control-allow-origin':server.origin,
    'access-control-allow-headers':'content-type'},body:route.request().method()==='OPTIONS'?Buffer.alloc(0):dmResponse()}));
  await owner.dm.evaluate(request=>{
    window.nativeRehydratedTime=new Date(Date.now()-1500).toISOString();
    document.querySelector('#native-send').addEventListener('click',()=>void fetch('https://imapi.douyin.com/v1/message/send',{
      method:'POST',body:Uint8Array.from(atob(request),c=>c.charCodeAt(0))}));
  },dmRequest(text).toString('base64'));
  store.approve(draft.id,await adapter.inspect(store.event(id).payload),draft.version,text);
  assert.equal(await new SendCoordinator(store,owner.actor).send(draft.id,adapter,false),'CONFIRMED');adapter.dispose();
  assert.equal(await owner.dm.evaluate(()=>window.nativeClicks),1);
  await mountCommentReply(owner,server.origin);const cm=commentReplyMapping(server.origin);cm.submissionReceipts=true;
  const comments=await owner.notification.evaluate(captureObserved,{mapping:cm.observation,channel:'comments',index:0,evidenceId:'synthetic'});
  store.observe('COMMENT_NOTIFICATION','work:10',[],'100','fixture','2026-11-04T00:00:00Z');
  const cid=store.observe('COMMENT_NOTIFICATION','work:10',comments.events,'100','fixture')[0],cd=store.saveDraft(cid,text,'mock'),ca=new ObservedCommentReply(owner.notification,cm),at=Math.floor(Date.now()/1000)-2;
  await mountFreshCommentPage(owner.notification,server.origin,text,at);
  await owner.notification.route('**/aweme/v1/web/comment/publish',route=>route.fulfill({json:{status_code:0,comment:{cid:'501',reply_id:'11',reply_to_reply_id:'0',
    text,user:{uid:'100',sec_uid:'self-sec'},status:7,create_time:at}}}));
  await ca.inspect(store.event(cid).payload);
  await owner.notification.locator('#comment-send').evaluate((button,text)=>button.addEventListener('click',()=>void fetch('/aweme/v1/web/comment/publish',{
    method:'POST',body:new URLSearchParams({aweme_id:'10',reply_id:'11',text})})),text);
  store.approve(cd.id,await ca.inspect(store.event(cid).payload),cd.version,text);
  assert.equal(await new SendCoordinator(store,owner.actor).send(cd.id,ca,false),'CONFIRMED');ca.dispose();
  console.log(JSON.stringify({submissionSmoke:'PASS',runtime:source?'tsx-source':'compiled-node',channels:2,refreshedCrossClockProofs:2,realSends:0,modelCalls:0}));
}finally{store.close();await owner.close();await server.close();}
