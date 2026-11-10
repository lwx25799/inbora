import {expect,test} from 'vitest';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {ObservedCommentReply} from '../../src/adapters/observed-comment-reply.js';
import {captureObserved} from '../../src/adapters/observed-reader.js';
import {SendCoordinator} from '../../src/core/send-coordinator.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountCommentReply,commentReplyMapping} from '../fixtures/observed-site.js';
import {database,privateTemp} from '../helpers.js';

async function setup(ownContextLink=false,inline=false){
  const root=privateTemp('nested-comment-send-'),server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(root,'profile'),true),store=database();
  await mountCommentReply(owner,server.origin);const mapping=commentReplyMapping(server.origin);
  mapping.observation.commentAuthors=[{uid:'201',secUid:'child-sec',title:'Child author'}];
  await owner.notification.route('**/aweme/v1/web/comment/list/reply/**',route=>route.fulfill({json:{status_code:0,comments:[]}}));
  await owner.notification.evaluate(({ownContextLink,inline})=>{
    const root=document.querySelector('#root-comment')!,rootInfo=Object.getOwnPropertyDescriptor(root,'__reactFiber$fixture')!.value.return.memoizedProps.commentInfo;
    const native={cid:'21',replyId:'11',text:'exact nested incoming',createTime:Math.floor(Date.now()/1000)-10,user:{uid:'201',secUid:'child-sec'},status:1};
    rootInfo.replyComment.push(native);rootInfo.replyTotal=1;
    const child=document.createElement('div');child.id='target-child';child.className='comment';
    child.innerHTML='<a class="author" href="/user/child-sec">Child author</a><div class="body">exact nested incoming</div><div class="tooltip" id="tooltip_21">Actions</div><button class="reply-action">回复</button>';
    Object.defineProperty(child,'__reactFiber$fixture',{value:{return:{memoizedProps:{commentInfo:native,level:2,levelOneCid:'11',awemeInfo:{awemeId:'10'}}}}});root.append(child);
    const state=window as unknown as {nestedClicks:number;nestedWrongParent:boolean;nestedRows:unknown[]};state.nestedClicks=0;state.nestedWrongParent=false;state.nestedRows=[];
    child.querySelector('.reply-action')!.addEventListener('click',event=>{
      event.stopPropagation();if(child.querySelector('#reply-controls'))return;
      const scope=document.createElement('div');scope.id='reply-controls';
      Object.defineProperty(scope,'__reactFiber$fixture',{value:{return:{return:{memoizedProps:{cid:'21',level:2,levelOneCid:'11',awemeInfo:{awemeId:'10'}}}}}});
      scope.innerHTML='<div id="comment-editor" contenteditable="true" style="white-space:pre-wrap"><div data-contents="true"><div data-block="true"><div class="public-DraftStyleDefault-block"><span><br data-text="true"></span></div></div></div></div><button id="comment-send">Publish</button>';
      child.append(scope);const editor=scope.querySelector('#comment-editor')!;
      editor.addEventListener('textInput',event=>{event.preventDefault();editor.querySelector('.public-DraftStyleDefault-block')!.textContent=(event as InputEvent).data??'';});
      scope.querySelector('#comment-send')!.addEventListener('click',()=>{
        state.nestedClicks++;const text=editor.textContent??'',id=String(900+state.nestedClicks),at=(Date.now()+3)/1000;
        const reply={cid:id,replyId:'11',text,user:{uid:'100',secUid:'self-sec'},status:1,createTime:at};rootInfo.replyComment.push(reply);rootInfo.replyTotal++;
        const row=document.createElement('div');row.className='comment';
        Object.defineProperty(row,'__reactFiber$fixture',{value:{return:{memoizedProps:{commentInfo:reply,level:2,levelOneCid:'11',awemeInfo:{awemeId:'10'}}}}});
        row.innerHTML='<a class="author" href="/user/self-sec">Self</a><div class="body"></div><div class="tooltip" id="tooltip_'+id+'">Actions</div>';
        if(ownContextLink){const context=row.querySelector('a')!.cloneNode(true) as Element;context.setAttribute('href','/user/child-sec');row.prepend(context);}
        row.querySelector('.body')!.textContent=text;root.append(row);scope.remove();
        state.nestedRows=[{cid:id,aweme_id:'10',reply_id:'11',reply_to_reply_id:state.nestedWrongParent?'0':'21',text,status:1,create_time:at,user:{uid:'100',sec_uid:'self-sec'}}];
        sessionStorage.setItem('nested-readback',JSON.stringify({html:document.body.innerHTML,props:Array.from(document.querySelectorAll('.comment')).map(row=>
          Object.getOwnPropertyDescriptor(row,'__reactFiber$fixture')!.value.return.memoizedProps),rows:state.nestedRows,clicks:state.nestedClicks}));
        if(!inline)void fetch('/aweme/v1/web/comment/list/reply/?comment_id=11');
      });
    });
  },{ownContextLink,inline});
  await owner.notification.route(server.origin+'/video/10',route=>route.fulfill({contentType:'text/html',body:'<html><body>Reloading native fixture</body></html>'}));
  await owner.notification.addInitScript(inline=>document.addEventListener('DOMContentLoaded',()=>{
    const serialized=sessionStorage.getItem('nested-readback');if(!serialized)return;const saved=JSON.parse(serialized);
    document.body.innerHTML=saved.html;Object.defineProperty(document.querySelector('#self')!,'__reactFiber$fixture',{value:{return:{memoizedProps:{uid:'100',secUid:'self-sec'}}}});
    Array.from(document.querySelectorAll('.comment')).forEach((row,index)=>Object.defineProperty(row,'__reactFiber$fixture',{value:{return:{memoizedProps:saved.props[index]}}}));
    Object.assign(window,{nestedRows:saved.rows,nestedClicks:saved.clicks});
    void fetch(inline?'/aweme/v1/web/comment/list/?aweme_id=10':'/aweme/v1/web/comment/list/reply/?comment_id=11');
  }),inline);
  await owner.notification.unroute('**/aweme/v1/web/comment/list/reply/**');
  await owner.notification.route('**/aweme/v1/web/comment/list/reply/**',async route=>route.fulfill({json:{status_code:0,
    comments:await owner.notification.evaluate(()=>(window as unknown as {nestedRows:unknown[]}).nestedRows)}}));
  if(inline)await owner.notification.route('**/aweme/v1/web/comment/list/?**',async route=>route.fulfill({json:{status_code:0,comments:[{cid:'11',aweme_id:'10',
    reply_comment:await owner.notification.evaluate(()=>(window as unknown as {nestedRows:unknown[]}).nestedRows)}]}}));
  const batch=await owner.notification.evaluate(captureObserved,{mapping:mapping.observation,channel:'comments' as const,index:0,evidenceId:'synthetic-child-target',allCommentAuthors:true});
  const event=batch.events.find(event=>event.commentId==='21')!;store.observe('COMMENT_NOTIFICATION','work:10',[],'100','synthetic');
  const [eventId]=store.observe('COMMENT_NOTIFICATION','work:10',[event],'100','synthetic');const draft=store.saveDraft(eventId!,'exact one reply to child','mock');
  const adapter=new ObservedCommentReply(owner.notification,mapping,300);
  return{owner,store,event,draft,adapter,mapping,close:async()=>{adapter.dispose();store.close();await owner.close();await server.close();}};
}

test('a nested reply binds the exact root and child composer and confirms one reply to that child',async()=>{
  const f=await setup();try{
    expect(f.event).toMatchObject({kind:'REPLY',commentId:'21',rootCommentId:'11',replyToCommentId:'21'});
    const proof=await f.adapter.inspect(f.event);expect(proof.targetKey).toBe('comment:10:21');f.store.approve(f.draft.id,proof,f.draft.version,f.draft.text);
    expect(await new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).toBe('CONFIRMED');
    expect(await f.owner.notification.evaluate(()=>(window as unknown as {nestedClicks:number}).nestedClicks)).toBe(1);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:1});
    expect(f.store.db.prepare('SELECT used FROM budgets ORDER BY kind').all()).toEqual([{used:0},{used:0}]);
  }finally{await f.close();}
});

test('an already expanded nested thread confirms its exact child from the normal root-list inline after refresh',async()=>{
  const f=await setup(false,true);try{
    f.store.approve(f.draft.id,await f.adapter.inspect(f.event),f.draft.version,f.draft.text);
    expect(await new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).toBe('CONFIRMED');
    expect(await f.owner.notification.evaluate(()=>(window as unknown as {nestedClicks:number}).nestedClicks)).toBe(1);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:1});
  }finally{await f.close();}
});

test('root-list inline cannot convert a direct-root reply into confirmation for the exact child',async()=>{
  const f=await setup(false,true);try{
    await f.owner.notification.evaluate(()=>(window as unknown as {nestedWrongParent:boolean}).nestedWrongParent=true);
    f.store.approve(f.draft.id,await f.adapter.inspect(f.event),f.draft.version,f.draft.text);
    expect(await new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).toBe('UNCERTAIN');
    expect(await f.owner.notification.evaluate(()=>(window as unknown as {nestedClicks:number}).nestedClicks)).toBe(1);
    expect(f.store.db.prepare('SELECT status FROM send_intents').get()).toEqual({status:'UNCERTAIN'});
  }finally{await f.close();}
});

test('a nested reply with one native author link plus a reply-context author still sends to its exact child once',async()=>{
  const f=await setup(true);try{
    await f.owner.notification.evaluate(()=>{const child=document.querySelector('#target-child')!,extra=child.querySelector('a')!.cloneNode(true) as Element;
      extra.setAttribute('href','/user/peer-sec');extra.textContent='Reply context author';child.prepend(extra);});
    const proof=await f.adapter.inspect(f.event);f.store.approve(f.draft.id,proof,f.draft.version,f.draft.text);
    expect(await new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).toBe('CONFIRMED');
    expect(await f.owner.notification.evaluate(()=>(window as unknown as {nestedClicks:number}).nestedClicks)).toBe(1);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:1});
  }finally{await f.close();}
});

test.each(['NONE','DUPLICATE'] as const)('a nested reply cannot guess among %s exact native author matches',async mode=>{
  const f=await setup();try{
    await f.owner.notification.evaluate(mode=>{const child=document.querySelector('#target-child')!,author=child.querySelector('a')!;
      if(mode==='NONE')author.setAttribute('href','/user/context-sec');else child.prepend(author.cloneNode(true));},mode);
    await expect(f.adapter.inspect(f.event)).rejects.toThrow('COMMENT_REPLY_ORIGINAL_CHANGED');
    expect(await f.owner.notification.evaluate(()=>(window as unknown as {nestedClicks:number}).nestedClicks)).toBe(0);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{await f.close();}
});

test.each(['root','child','author','composer-root','composer-child','composer-level','text','human'] as const)(
  'nested reply rejects %s changes before any intent or click',async fault=>{
  const f=await setup();try{
    const snapshot=await f.adapter.inspect(f.event);f.store.approve(f.draft.id,snapshot,f.draft.version,f.draft.text);
    await f.owner.notification.evaluate(fault=>{
      const child=document.querySelector('#target-child')!,native=Object.getOwnPropertyDescriptor(child,'__reactFiber$fixture')!.value.return.memoizedProps;
      const scope=Object.getOwnPropertyDescriptor(document.querySelector('#reply-controls')!,'__reactFiber$fixture')!.value.return.return.memoizedProps;
      if(fault==='root')native.commentInfo.replyId='12';if(fault==='child')native.commentInfo.cid='22';if(fault==='author')native.commentInfo.user.uid='202';
      if(fault==='composer-root')scope.levelOneCid='12';if(fault==='composer-child')scope.cid='11';if(fault==='composer-level')scope.level=1;
      if(fault==='text')native.commentInfo.text='different child text';if(fault==='human')document.querySelector('#comment-editor .public-DraftStyleDefault-block')!.textContent='actual human input';
    },fault);
    await expect(new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).rejects.toThrow();
    expect(await f.owner.notification.evaluate(()=>(window as unknown as {nestedClicks:number}).nestedClicks)).toBe(0);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{await f.close();}
});

test('a confirmed direct-root reply is never accepted as a reply to the bound child',async()=>{
  const f=await setup();try{
    await f.owner.notification.evaluate(()=>(window as unknown as {nestedWrongParent:boolean}).nestedWrongParent=true);
    f.store.approve(f.draft.id,await f.adapter.inspect(f.event),f.draft.version,f.draft.text);
    expect(await new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).toBe('UNCERTAIN');
    expect(await f.owner.notification.evaluate(()=>(window as unknown as {nestedClicks:number}).nestedClicks)).toBe(1);
    expect(f.store.db.prepare('SELECT status FROM send_intents').get()).toEqual({status:'UNCERTAIN'});
  }finally{await f.close();}
});

test('normal bounded root expansion remounts the exact child before opening its composer',async()=>{
  const f=await setup();try{
    await f.owner.notification.evaluate(()=>{
      const root=document.querySelector('#root-comment')!,child=document.querySelector('#target-child')!;child.remove();
      const expand=document.createElement('button');expand.textContent='展开1条回复';
      expand.addEventListener('click',()=>{root.append(child);expand.remove();});root.append(expand);
    });
    expect(await f.adapter.inspect(f.event)).toMatchObject({targetKey:'comment:10:21'});
    expect(await f.owner.notification.locator('#target-child #reply-controls').count()).toBe(1);
    expect(await f.owner.notification.locator('#root-comment > #reply-controls').count()).toBe(0);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{await f.close();}
});

test('opening a child composer cannot dismiss an existing draft in the root composer',async()=>{
  const f=await setup();try{
    await f.owner.notification.locator('#root-comment > .reply-action').click();
    await f.owner.notification.locator('#comment-editor .public-DraftStyleDefault-block').evaluate(line=>{line.textContent='existing root human draft';});
    const before=await f.owner.notification.locator('#root-comment > #reply-controls').innerHTML();
    await expect(f.adapter.inspect(f.event)).rejects.toThrow('COMMENT_REPLY_EXISTING_DRAFT');
    expect(await f.owner.notification.locator('#root-comment > #reply-controls').innerHTML()).toBe(before);
    expect(await f.owner.notification.locator('#target-child #reply-controls').count()).toBe(0);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{await f.close();}
});

test.each([false,true])('normal nested qualification emits only bounded composer fields and callback failures cannot change its result (%s)',async wrong=>{
  const f=await setup();try{
    if(wrong)await f.owner.notification.locator('#target-child .reply-action').evaluate(action=>action.addEventListener('click',()=>{
      Object.getOwnPropertyDescriptor(document.querySelector('#reply-controls')!,'__reactFiber$fixture')!.value.return.return.memoizedProps.levelOneCid='12';
    }));
    const reports:unknown[]=[],adapter=new ObservedCommentReply(f.owner.notification,f.mapping,300,{onQualification(report){reports.push(report);throw Error('PRIVATE_CALLBACK_ERROR');}});
    try{
      const result=adapter.inspect(f.event);if(wrong)await expect(result).rejects.toThrow('COMMENT_REPLY_COMPOSER_CHANGED');else await expect(result).resolves.toMatchObject({targetKey:'comment:10:21'});
      expect(reports).toEqual([expect.objectContaining({nested:true,stage:'SNAPSHOT',verified:!wrong,code:wrong?'COMMENT_REPLY_COMPOSER_CHANGED':null,
        composerCount:1,metadataReady:true,level:2,cidMatches:true,rootMatches:!wrong,workMatches:true,rowOwned:true})]);
      expect(JSON.stringify(reports)).not.toMatch(/PRIVATE|child-sec|exact nested|\/video\/|tooltip|\.comment|"21"|"11"/u);
      expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
    }finally{adapter.dispose();}
  }finally{await f.close();}
});
