import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixtureServer} from '../tests/fixtures/site.ts';
import {mountCommentReply,commentReplyMapping} from '../tests/fixtures/observed-site.ts';
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
  await mountCommentReply(owner,server.origin);const mapping=commentReplyMapping(server.origin);
  const batch=await owner.actor.run(()=>owner.notification.evaluate(captureObserved,{mapping:mapping.observation,channel:'comments',index:0,evidenceId:'fixture-root-snapshot'}));
  store.observe('COMMENT_NOTIFICATION','work:10',[],'100','fixture');store.observe('COMMENT_NOTIFICATION','work:10',batch.events,'100','fixture');
  const event=store.events()[0],draft=store.saveDraft(event.id,'local fixture parent reply','mock'),adapter=new ObservedCommentReply(owner.notification,mapping);
  store.approve(draft.id,await owner.actor.run(()=>adapter.inspect(event.payload)),draft.version,draft.text);
  const click=adapter.clickOnce.bind(adapter);adapter.clickOnce=async()=>{
    assert.equal(store.db.prepare('SELECT status FROM send_intents').get().status,'INTENT_RECORDED');await click();};
  assert.equal(await new SendCoordinator(store,owner.actor).send(draft.id,adapter,false),'CONFIRMED');
  assert.equal(await owner.notification.evaluate(()=>window.commentClicks),1);
  console.log(JSON.stringify({nativeCommentReplySmoke:'PASS',runtime:source?'tsx-source':'compiled-node',fixtureClicks:1,realSends:0,modelCalls:0}));
}finally{store.close();await owner.close();await server.close();}
