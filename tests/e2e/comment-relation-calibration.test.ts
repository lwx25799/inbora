import {expect,test} from 'vitest';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {captureObserved} from '../../src/adapters/observed-reader.js';
import {recordCommentWindow} from '../../src/observability/comment-window-diagnostics.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountCommentReply,observedMapping} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';

test('ordinary successful comment windows pass fixed relation shapes to the private slot without calling getters or supplying proof',async()=>{
  const root=privateTemp('comment-relation-shape-'),server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
  try{
    await mountCommentReply(owner,server.origin);const mapping=observedMapping(server.origin);
    await owner.notification.evaluate(()=>{
      const root=document.querySelector('#root-comment')!,state=window as unknown as {relationGetterCalls:number};state.relationGetterCalls=0;
      const rootInfo=Object.getOwnPropertyDescriptor(root,'__reactFiber$fixture')!.value.return.memoizedProps.commentInfo;rootInfo.replyTotal=4;
      for(let index=0;index<4;index++){
        const id=String(21+index),native={cid:id,replyId:'11',text:'PRIVATE_RELATION_BODY_'+id,createTime:Math.floor(Date.now()/1000)-10,
          user:{uid:index===0?'200':'100',secUid:index===0?'peer-sec':'self-sec'},status:1} as Record<string,unknown>;
        if(index===0)native.replyToReplyId='0';if(index===1){native.replyToReplyId='21';native.replyToReplyID='11';}
        if(index===2)Object.defineProperty(native,'replyToReplyId',{get(){state.relationGetterCalls++;throw Error('PRIVATE_GETTER');}});
        const row=document.createElement('div');row.className='comment';row.innerHTML='<a class="author" href="/user/'+(index===0?'peer-sec':'self-sec')+'">Author</a><div class="body"></div><div class="tooltip" id="tooltip_'+id+'">Actions</div>';
        row.querySelector('.body')!.textContent=String(native.text);
        Object.defineProperty(row,'__reactFiber$fixture',{value:{return:{memoizedProps:{commentInfo:native,level:2,levelOneCid:'11',awemeInfo:{awemeId:'10'}}}}});root.append(row);
      }
    });
    const batch=await owner.notification.evaluate(captureObserved,{mapping,channel:'comments' as const,index:0,evidenceId:'synthetic-relation-shape',allCommentAuthors:true});
    expect(batch.events).toHaveLength(5);expect(batch.commentRelations).toMatchObject({sampled:3,truncated:true,samples:[
      {own:false,rootBound:true,replyToReplyId:{type:'STRING',zero:true,child:false}},
      {own:true,rootBound:true,replyToReplyId:{type:'STRING',nativeId:true,child:true,root:false,self:false},replyToReplyID:{type:'STRING',root:true,child:false}},
      {own:true,rootBound:true,replyToReplyId:{type:'ACCESSOR',nativeId:false,child:false}}]});
    expect(await owner.notification.evaluate(()=>(window as unknown as {relationGetterCalls:number}).relationGetterCalls)).toBe(0);
    await recordCommentWindow(root,'work:10',batch,Date.now(),Date.now()-60_000,{mappedWork:true,includedWork:false,historicalWork:false,ownId:'100'});
    const raw=await readFile(join(root,'evidence','work-comment-window-latest.json'),'utf8'),report=JSON.parse(raw);
    expect(report.windows[0].commentRelations).toEqual(batch.commentRelations);
    expect(raw).not.toMatch(/PRIVATE_|peer-sec|self-sec|"21"|"22"|"23"|https:|proofs|receipt/u);
  }finally{await owner.close();await server.close();}
});
