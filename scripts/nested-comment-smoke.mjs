import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixtureServer} from '../tests/fixtures/site.ts';
import {mountCommentReply,commentReplyMapping} from '../tests/fixtures/observed-site.ts';
const source=process.argv[2]==='source',directory=source?'src':'dist',url=name=>pathToFileURL(resolve(directory,name.replace(/\.js$/,source?'.ts':'.js'))).href;
const {BrowserProfileOwner}=await import(url('browser/profile-owner.js'));
const {captureCommentReply}=await import(url('adapters/observed-comment-reply.js'));
const {eventBinding,targetKey}=await import(url('core/contracts.js'));
const base=resolve('.local/nested-comment-smoke');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'run-'));
const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
try{
  await mountCommentReply(owner,server.origin);const mapping=commentReplyMapping(server.origin);
  mapping.observation.commentAuthors=[{uid:'201',secUid:'child-sec',title:'Child author'}];
  const at=Math.floor(Date.now()/1000)-10;
  await owner.notification.evaluate(at=>{
    const root=document.querySelector('#root-comment'),info=Object.getOwnPropertyDescriptor(root,'__reactFiber$fixture').value.return.memoizedProps.commentInfo;
    const native={cid:'21',replyId:'11',text:'exact child smoke',createTime:at,status:1,user:{uid:'201',secUid:'child-sec'}};
    info.replyComment.push(native);info.replyTotal=1;const child=document.createElement('div');child.className='comment';child.id='child';
    child.innerHTML='<a class="author" href="/user/child-sec">Child</a><div class="body">exact child smoke</div><div class="tooltip" id="tooltip_21">Actions</div><button class="reply-action">回复</button>';
    Object.defineProperty(child,'__reactFiber$fixture',{value:{return:{memoizedProps:{commentInfo:native,level:2,levelOneCid:'11',awemeInfo:{awemeId:'10'}}}}});root.append(child);
    window.nestedSmokeClicks=0;
    child.querySelector('.reply-action').addEventListener('click',()=>{
      const scope=document.createElement('div');scope.id='reply-controls';
      Object.defineProperty(scope,'__reactFiber$fixture',{value:{return:{return:{memoizedProps:{cid:'21',level:2,levelOneCid:'11',awemeInfo:{awemeId:'10'}}}}}});
      scope.innerHTML='<div id="comment-editor" contenteditable="true" style="white-space:pre-wrap"><div data-contents="true"><div data-block="true"><div class="public-DraftStyleDefault-block"><span><br data-text="true"></span></div></div></div></div><button id="comment-send">Publish</button>';
      child.append(scope);scope.querySelector('#comment-editor').addEventListener('textInput',event=>{
        event.preventDefault();scope.querySelector('.public-DraftStyleDefault-block').textContent=event.data;
      });
      scope.querySelector('#comment-send').addEventListener('click',()=>{
        window.nestedSmokeClicks++;const text=scope.querySelector('#comment-editor').textContent;
        const reply={cid:'901',replyId:'11',text,createTime:Date.now()/1000,status:1,user:{uid:'100',secUid:'self-sec'}};
        info.replyComment.push(reply);info.replyTotal++;window.nestedSmokeReply=reply;
        const row=document.createElement('div');row.className='comment';
        Object.defineProperty(row,'__reactFiber$fixture',{value:{return:{memoizedProps:{commentInfo:reply,level:2,levelOneCid:'11',awemeInfo:{awemeId:'10'}}}}});
        row.innerHTML='<a class="author" href="/user/self-sec">Self</a><div class="body"></div><div class="tooltip" id="tooltip_901">Actions</div>';
        row.querySelector('.body').textContent=text;root.append(row);scope.remove();
      });
    });
  },at);
  const event={accountId:'account_001',channel:'COMMENT_NOTIFICATION',platformEventId:'21',actorId:'201',actorName:'Child author',text:'exact child smoke',
    occurredAt:new Date(at*1000).toISOString(),videoId:'10',commentId:'21',conversationId:null,direction:'INCOMING',kind:'REPLY',evidenceId:'synthetic-nested',rootCommentId:'11',replyToCommentId:'21'};
  const baseInput={mapping,event,text:null,token:null,before:null,shape:null},capture=overrides=>owner.notification.evaluate(captureCommentReply,{...baseInput,...overrides});
  await capture({action:'open'});const before=await capture({action:'snapshot'});assert.equal(before.editorText,'');
  assert.deepEqual((await capture({action:'diagnostic'})).qualification,{composerCount:1,metadataReady:true,level:2,cidMatches:true,rootMatches:true,workMatches:true,rowOwned:true});
  assert.equal(targetKey(event),'comment:10:21');assert.notEqual(eventBinding(event),eventBinding({...event,rootCommentId:'12'}));
  const text='exact nested smoke reply',token='synthetic-input-token';
  await capture({action:'fill',text,token,before:{context:before.context,editorText:''}});
  const filled=await capture({action:'finish',text,token,before:{context:before.context,editorText:''}});assert.equal(filled.editorText,text);
  await capture({action:'arm',text,token,shape:filled.shape});
  assert.equal(await owner.notification.evaluate(()=>window.__inboraCommentGate.submit()),true);assert.equal(await owner.notification.evaluate(()=>window.nestedSmokeClicks),1);
  const native=await owner.notification.evaluate(()=>window.nestedSmokeReply),receipt={cid:'901',aweme_id:'10',reply_id:'11',reply_to_reply_id:'21',text,status:1,create_time:native.createTime,user:{uid:'100',sec_uid:'self-sec'}};
  assert.equal((await capture({action:'proofs',receipts:[receipt]})).proofs[0].targetKey,'comment:10:21');
  assert.equal((await capture({action:'proofs',receipts:[{...receipt,reply_to_reply_id:'0'}]})).proofs.length,0);
  assert.equal((await capture({action:'proofs',receipts:[]})).proofs.length,0);
  await assert.rejects(capture({action:'snapshot',event:{...event,rootCommentId:'12'}}));
  console.log(JSON.stringify({nestedCommentSmoke:'PASS',runtime:source?'tsx-source':'compiled-node',assertions:11,syntheticClicks:1,realSends:0,modelCalls:0}));
}finally{await owner.close();await server.close();}
