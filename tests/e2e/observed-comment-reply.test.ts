import {expect,test,vi} from 'vitest';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {captureObserved} from '../../src/adapters/observed-reader.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {ObservedCommentReply} from '../../src/adapters/observed-comment-reply.js';
import {SendCoordinator} from '../../src/core/send-coordinator.js';
import {ManualCommentRetry} from '../../src/core/manual-comment-retry.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountCommentReply,commentReplyMapping,mountFreshCommentPage,reloadableCommentReply} from '../fixtures/observed-site.js';
import {database,privateTemp} from '../helpers.js';

async function setup(){
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true),store=database();
  await mountCommentReply(owner,server.origin);const mapping=commentReplyMapping(server.origin),adapter=new ObservedCommentReply(owner.notification,mapping,250);
  const batch=await owner.notification.evaluate(captureObserved,{mapping:mapping.observation,channel:'comments' as const,index:0,evidenceId:'fixture-root-snapshot'});
  store.observe('COMMENT_NOTIFICATION','work:10',[],'100','fixture');store.observe('COMMENT_NOTIFICATION','work:10',batch.events,'100','fixture');
  const event=store.events()[0]!,draft=store.saveDraft(event.id,'approved root reply','mock');
  return{owner,store,server,mapping,adapter,event,draft,close:async()=>{store.close();await owner.close();await server.close();}};
}

test.each(['valid','wrong-parent','wrong-text','pending','missing','duplicate'])('independent rendered child cross-checks its normal response: %s',async failure=>{
  const f=await setup();try{
    await f.adapter.inspect(f.event.payload);
    await f.owner.notification.route('**/aweme/v1/web/comment/list/reply/**',route=>route.fulfill({json:{status_code:0,comments:[{
      cid:'501',aweme_id:'10',reply_id:failure==='wrong-parent'?'12':'11',text:failure==='wrong-text'?'other':f.draft.text,
      user:{uid:'100',sec_uid:'self-sec'},...(failure==='missing'?{}:{status:failure==='pending'?0:1}),create_time:Date.now()/1000-1},
      ...(failure==='duplicate'?[{cid:'501',aweme_id:'10',reply_id:'11',text:f.draft.text,user:{uid:'100',sec_uid:'self-sec'},status:1,create_time:Date.now()/1000-1}]:[])]}}));
    const boundary=new Date(Date.now()-3000).toISOString();
    await f.owner.notification.evaluate(async text=>{
      const root=document.querySelector('#root-comment')!,p=Object.getOwnPropertyDescriptor(root,'__reactFiber$fixture')!.value.return.memoizedProps;
      p.commentInfo.replyTotal=1;p.commentInfo.replyComment=[];
      const child=document.createElement('div');child.className='comment';
      const response=await(await fetch('/aweme/v1/web/comment/list/reply/?comment_id=11')).json(),r=response.comments[0];
      Object.defineProperty(child,'__reactFiber$fixture',{value:{return:{memoizedProps:{level:2,levelOneCid:'11',awemeInfo:{awemeId:'10'},
        commentInfo:{cid:r.cid,text,replyId:'11',createTime:r.create_time,user:{uid:'100',secUid:'self-sec'}}}}}});
      child.innerHTML='<a class="author" href="/user/self-sec">Self</a><div class="body"></div><div class="tooltip" id="tooltip_501">Actions</div>';
      child.querySelector('.body')!.textContent=text;root.append(child);
    },f.draft.text);
    expect(await f.adapter.baseline(f.event.payload)).toContain('501');
    if(failure==='valid')expect(await f.adapter.readback(f.event.payload,f.draft.text,[],boundary)).toMatchObject({id:'501',text:f.draft.text});
    else expect(await f.adapter.readback(f.event.payload,f.draft.text,[],boundary)).toBeNull();
  }finally{await f.close();}
});

test('visible native SMS challenge blocks inspection before input or intent',async()=>{
  const f=await setup();try{
    await f.owner.notification.evaluate(()=>{const node=document.createElement('div');node.className='uc-ui-verify-new_header-title';node.textContent='接收短信验证码';document.body.append(node);});
    await expect(f.adapter.inspect(f.event.payload)).rejects.toThrow('COMMENT_REPLY_PAGE_BLOCKED');
    expect(f.store.stats().budgets).toMatchObject([{used:0},{used:0}]);
  }finally{await f.close();}
});

test.each([false,true])('only a calibrated exact bound portal may prepare a root reply; wrong=%s',async wrong=>{
  const f=await setup();try{
    Object.assign(f.mapping,{portalWorkIds:['10']});
    await f.owner.notification.evaluate(()=>{
      const footer=document.createElement('div');footer.id='reply-controls';footer.textContent='Empty top-level composer shell';
      Object.defineProperty(footer,'__reactFiber$fixture',{value:{return:{return:{memoizedProps:{level:0,awemeInfo:{awemeId:'10'}}}}}});document.body.append(footer);
    });
    await f.owner.notification.locator('.reply-action').evaluate((action,wrong)=>action.addEventListener('click',()=>{
      const controls=document.querySelector('#root-comment #reply-controls');if(!controls)return;
      document.body.append(controls);
      if(wrong)Object.getOwnPropertyDescriptor(controls,'__reactFiber$fixture')!.value.return.return.memoizedProps.cid='12';
    }),wrong);
    if(wrong){await expect(f.adapter.inspect(f.event.payload)).rejects.toThrow();expect(f.store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});}
    else{
      f.store.approve(f.draft.id,await f.adapter.inspect(f.event.payload),f.draft.version,f.draft.text);
      expect(await new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).toBe('CONFIRMED');
      expect(await f.owner.notification.evaluate(()=>(window as unknown as {commentClicks:number}).commentClicks)).toBe(1);
    }
  }finally{await f.close();}
});

test('seconds-rounded native receipt is strictly after the durable boundary without relaxing proof checks',async()=>{
  const f=await setup();try{
    await f.adapter.inspect(f.event.payload);await f.adapter.prepare(f.event.payload,f.draft.text);await f.adapter.verifyPrepared(f.event.payload,f.draft.text);
    await f.owner.notification.locator('#comment-send').evaluate(button=>button.addEventListener('click',()=>{
      const root=document.querySelector('#root-comment')!,p=Object.getOwnPropertyDescriptor(root,'__reactFiber$fixture')!.value.return.memoizedProps;
      const at=Math.floor(Date.now()/1000);p.commentInfo.replyComment[0].createTime=at;
      Object.getOwnPropertyDescriptor(root.querySelector('.comment')!,'__reactFiber$fixture')!.value.return.memoizedProps.commentInfo.createTime=at;
    }));
    const boundary=new Date(Date.now()+100).toISOString();
    await (f.adapter as unknown as {clickOnce:(notBefore:string)=>Promise<void>}).clickOnce(boundary);
    expect(await f.adapter.readback(f.event.payload,f.draft.text,[],boundary)).toMatchObject({text:f.draft.text});
  }finally{await f.close();}
});

test.each(['valid','missing','wrong-date','wrong-work','future','stale'])('native clock calibration must be fresh, scoped and corroborated: %s',async kind=>{
  const f=await setup();let restoreClock=()=>{};try{
    await reloadableCommentReply(f.owner.notification,f.server.origin);
    await f.owner.notification.addInitScript(kind=>document.addEventListener('DOMContentLoaded',()=>{
      if(kind!=='missing')void fetch('/aweme/v1/web/comment/list/?aweme_id='+(kind==='wrong-work'?'12':'10'));
    }),kind);
    f.mapping.observation.environment='douyin';
    const snap=await f.adapter.inspect(f.event.payload);f.store.approve(f.draft.id,snap,f.draft.version,f.draft.text);
    if(kind!=='missing'){
      const server=Math.floor(Date.now()/1000)*1000+(kind==='future'?10_000:-1000);
      await f.owner.notification.route('**/aweme/v1/web/comment/list/**',route=>route.fulfill({headers:{date:new Date(server+(kind==='wrong-date'?2000:0)).toUTCString()},
        json:{status_code:0,extra:{now:server},comments:[]}}));
      await f.owner.notification.evaluate(async id=>{await(await fetch('/aweme/v1/web/comment/list/?aweme_id='+id)).json();},kind==='wrong-work'?'12':'10');
    }
    if(kind==='stale'){
      await f.adapter.prepare(f.event.payload,f.draft.text);await f.adapter.verifyPrepared(f.event.payload,f.draft.text);
      const realNow=Date.now,spy=vi.spyOn(Date,'now').mockImplementation(()=>realNow()+31_000);restoreClock=()=>spy.mockRestore();
    }
    if(kind==='valid')expect(await new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).toBe('CONFIRMED');
    else{
      await expect(new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).rejects.toThrow('CLOCK_UNVERIFIED');
      expect(f.store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
      expect(await f.owner.notification.evaluate(()=>(window as unknown as {commentClicks:number}).commentClicks)).toBe(0);
    }
  }finally{restoreClock();await f.close();}
});

test.each(['valid','missing','wrong-date','human-draft','sibling-draft','human-during-wait','context-change'])('fresh comment sender on an already open work acquires its own clock before filling: %s',async kind=>{
  const f=await setup();let navigations=0;try{
    f.mapping.observation.environment='douyin';f.adapter.dispose();
    await reloadableCommentReply(f.owner.notification,f.server.origin);
    await f.owner.notification.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>{
      void fetch('/aweme/v1/web/comment/list/?aweme_id=10');
    }));
    await f.owner.notification.route('**/aweme/v1/web/comment/list/**',route=>{
      const now=Math.floor(Date.now()/1000)*1000-1000;
      return route.fulfill({headers:{date:new Date(now+(kind==='wrong-date'?2000:0)).toUTCString()},
        json:kind==='missing'?{status_code:0}:{status_code:0,extra:{now}}});
    });
    f.adapter=new ObservedCommentReply(f.owner.notification,f.mapping,250);
    const inspected=await f.adapter.inspect(f.event.payload);
    f.store.approve(f.draft.id,inspected,f.draft.version,f.draft.text);
    if(kind==='human-draft')await f.owner.notification.locator('#comment-editor .public-DraftStyleDefault-block').evaluate(node=>{node.textContent='human draft must remain';});
    if(kind==='sibling-draft')await f.owner.notification.locator('#reply-controls').evaluate(node=>{
      const sibling=node.cloneNode(true) as Element;sibling.querySelector('.public-DraftStyleDefault-block')!.textContent='other human draft must remain';document.body.append(sibling);
    });
    if(kind==='human-during-wait')await f.owner.notification.evaluate(()=>setTimeout(()=>{
      document.querySelector('#comment-editor .public-DraftStyleDefault-block')!.textContent='human draft must remain';
    },100));
    if(kind==='context-change')await f.owner.notification.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>{
      const root=document.querySelector('#root-comment')!,props=Object.getOwnPropertyDescriptor(root,'__reactFiber$fixture')!.value.return.memoizedProps;
      props.commentInfo.replyTotal=1;
    }));
    f.owner.notification.on('framenavigated',()=>navigations++);
    if(kind==='valid'){
      expect(await new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).toBe('CONFIRMED');
      expect(navigations).toBe(1);
      expect(await f.owner.notification.evaluate(()=>(window as unknown as {commentClicks:number}).commentClicks)).toBe(1);
    }else{
      const humanDraft=['human-draft','sibling-draft','human-during-wait'].includes(kind);
      await expect(new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).rejects.toThrow(
        humanDraft?'EXISTING_DRAFT':kind==='context-change'?'CONTEXT_CHANGED':'CLOCK_UNVERIFIED');
      expect(navigations).toBe(humanDraft?0:1);
      expect(f.store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
      expect(await f.owner.notification.evaluate(()=>(window as unknown as {commentClicks:number}).commentClicks)).toBe(0);
      if(kind==='human-draft'||kind==='human-during-wait')expect(await f.owner.notification.locator('#comment-editor').textContent()).toBe('human draft must remain');
      else if(kind==='sibling-draft')expect(await f.owner.notification.locator('body > #reply-controls #comment-editor').textContent()).toBe('other human draft must remain');
      else expect(await f.owner.notification.locator('#comment-editor').textContent()).toBe('');
    }
  }finally{await f.close();}
});

test.each(['valid','wrong-parent','wrong-text','wrong-owner','duplicate','missing','wrong-id'])('comment submission response must bind the request and refreshed child: %s',async failure=>{
  const f=await setup();try{
    f.mapping.submissionReceipts=true;f.adapter.dispose();f.adapter=new ObservedCommentReply(f.owner.notification,f.mapping,300);
    const at=Math.floor(Date.now()/1000)-2;
    await f.owner.notification.route('**/aweme/v1/web/comment/publish',route=>route.fulfill({json:{status_code:0,comment:{
      cid:failure==='wrong-id'?'502':'501',reply_id:failure==='wrong-parent'?'12':'11',reply_to_reply_id:'0',
      text:failure==='wrong-text'?'other':f.draft.text,user:{uid:failure==='wrong-owner'?'200':'100',sec_uid:'self-sec'},status:7,create_time:at}}}));
    await mountFreshCommentPage(f.owner.notification,f.server.origin,f.draft.text,at);
    await f.adapter.inspect(f.event.payload);
    await f.owner.notification.locator('#comment-send').evaluate((button,{text,failure})=>button.addEventListener('click',()=>{
      if(failure==='missing')return;const body=new URLSearchParams({aweme_id:'10',reply_id:'11',text});
      for(let n=0;n<(failure==='duplicate'?2:1);n++)void fetch('/aweme/v1/web/comment/publish',{method:'POST',body});
    }),{text:f.draft.text,failure});
    f.store.approve(f.draft.id,await f.adapter.inspect(f.event.payload),f.draft.version,f.draft.text);
    expect(await new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).toBe(failure==='valid'?'CONFIRMED':'UNCERTAIN');
    await expect(new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).rejects.toThrow();
  }finally{f.adapter.dispose();await f.close();}
});

test('comment refresh cannot discard a top-level draft outside the replied parent',async()=>{
  const f=await setup();let navigations=0;try{
    f.owner.notification.on('framenavigated',()=>navigations++);
    await f.adapter.inspect(f.event.payload);
    await f.owner.notification.evaluate(()=>{
      document.querySelector('#reply-controls')!.remove();
      const scope=document.createElement('div');scope.id='reply-controls';
      scope.innerHTML='<div id="comment-editor" contenteditable="true"><div data-contents="true"><div data-block="true"><div class="public-DraftStyleDefault-block">human top-level draft</div></div></div></div>';
      Object.defineProperty(scope,'__reactFiber$fixture',{value:{return:{return:{memoizedProps:{level:0,awemeInfo:{awemeId:'10'}}}}}});document.body.append(scope);
    });
    const hooks=f.adapter as unknown as {frame:(event:unknown,action:string)=>Promise<unknown>};
    await expect(hooks.frame(f.event.payload,'refresh')).rejects.toThrow('EXISTING_DRAFT');
    expect(navigations).toBe(0);expect(await f.owner.notification.locator('#comment-editor').textContent()).toBe('human top-level draft');
  }finally{await f.close();}
});

test('root discovery excludes the fields of an already expanded direct child',async()=>{
  const f=await setup();try{
    f.store.approve(f.draft.id,await f.adapter.inspect(f.event.payload),f.draft.version,f.draft.text);
    expect(await new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).toBe('CONFIRMED');
    const batch=await f.owner.notification.evaluate(captureObserved,{mapping:f.mapping.observation,channel:'comments' as const,index:0,evidenceId:'expanded-fixture'});
    expect(batch.events).toHaveLength(1);expect(batch.events[0]).toMatchObject({commentId:'11',text:'root fixture input'});
  }finally{await f.close();}
});

test('one hidden stale comment list cannot block the unique active list or lend fields',async()=>{
  const f=await setup();try{
    await f.owner.notification.locator('#comment-list').evaluate(list=>{const clone=list.cloneNode(true) as HTMLElement;clone.style.display='none';document.body.append(clone);});
    const batch=await f.owner.notification.evaluate(captureObserved,{mapping:f.mapping.observation,channel:'comments' as const,index:0,evidenceId:'hidden-list'});
    expect(batch.events).toHaveLength(1);expect(await f.adapter.inspect(f.event.payload)).toHaveProperty('ownId','100');
    await f.owner.notification.locator('#comment-list').last().evaluate(n=>(n as HTMLElement).style.display='');
    await expect(f.adapter.inspect(f.event.payload)).rejects.toThrow();
  }finally{await f.close();}
});

test('a hover-only child menu does not hide an otherwise fully verified visible reply',async()=>{
  const f=await setup();try{
    f.store.approve(f.draft.id,await f.adapter.inspect(f.event.payload),f.draft.version,f.draft.text);
    const click=f.adapter.clickOnce.bind(f.adapter);f.adapter.clickOnce=async()=>{await click();await f.owner.notification.locator('#tooltip_501').evaluate(n=>{
      const hover=document.createElement('div');hover.style.opacity='0';n.replaceWith(hover);hover.append(n);
    });};
    expect(await new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).toBe('CONFIRMED');
  }finally{await f.close();}
});

test('a transparent root menu does not block discovery of its visible original comment',async()=>{
  const f=await setup();try{
    await f.owner.notification.locator('#tooltip_11').evaluate(n=>{const wrapper=document.createElement('div');wrapper.style.opacity='0';n.replaceWith(wrapper);wrapper.append(n);});
    const batch=await f.owner.notification.evaluate(captureObserved,{mapping:f.mapping.observation,channel:'comments' as const,index:0,evidenceId:'root-hover-menu'});
    expect(batch.events).toHaveLength(1);expect(batch.events[0]).toHaveProperty('commentId','11');
  }finally{await f.close();}
});

test('a reply-list request from before intent cannot suppress the one bounded read-only refresh',async()=>{
  const f=await setup(),original=ObservedReader.prototype.comments;
  try{
    await f.adapter.inspect(f.event.payload);
    await f.owner.notification.route('**/aweme/v1/web/comment/list/reply/**',route=>route.fulfill({json:{status_code:0,comments:[]}}));
    await f.owner.notification.evaluate(async()=>{await fetch('/aweme/v1/web/comment/list/reply/?comment_id=11');});
    const boundary=new Date(Date.now()+1).toISOString();
    await f.owner.notification.evaluate(()=>{
      const root=document.querySelector('#root-comment')!,p=Object.getOwnPropertyDescriptor(root,'__reactFiber$fixture')!.value.return.memoizedProps;
      p.commentInfo.replyTotal=1;const child=document.createElement('div');child.className='comment';
      Object.defineProperty(child,'__reactFiber$fixture',{value:{return:{memoizedProps:{level:2,levelOneCid:'11',awemeInfo:{awemeId:'10'},
        commentInfo:{cid:'501',replyId:'11',text:'approved root reply',createTime:Date.now()/1000,user:{uid:'100',secUid:'self-sec'}}}}}});root.append(child);
    });
    let refreshes=0;ObservedReader.prototype.comments=async()=>{refreshes++;throw Error('EXPECTED_READ_ONLY_REFRESH');};
    await expect(f.adapter.readback(f.event.payload,f.draft.text,[],boundary)).rejects.toThrow('EXPECTED_READ_ONLY_REFRESH');
    expect(refreshes).toBe(1);expect(await f.owner.notification.evaluate(()=>(window as unknown as {commentClicks:number}).commentClicks)).toBe(0);
  }finally{ObservedReader.prototype.comments=original;await f.close();}
});
test('direct level-one reply records intent before one click and confirms only its exact child',async()=>{
  const f=await setup();try{
    f.store.approve(f.draft.id,await f.adapter.inspect(f.event.payload),f.draft.version,f.draft.text);
    const click=f.adapter.clickOnce.bind(f.adapter);f.adapter.clickOnce=async()=>{
      expect(f.store.db.prepare('SELECT status FROM send_intents').all()).toEqual([{status:'INTENT_RECORDED'}]);await click();};
    expect(await new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).toBe('CONFIRMED');
    expect(await f.owner.notification.evaluate(()=>(window as unknown as {commentClicks:number}).commentClicks)).toBe(1);
    await expect(new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).rejects.toThrow();
  }finally{await f.close();}
});
test.each(['wrong-parent','wrong-self','old','pending','missing','wrong-text'])('unverified %s root receipt freezes without a second click',async kind=>{
  const f=await setup();try{
    f.store.approve(f.draft.id,await f.adapter.inspect(f.event.payload),f.draft.version,f.draft.text);
    await f.owner.notification.evaluate(kind=>(window as unknown as {commentFailure:string}).commentFailure=kind,kind);
    expect(await new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).toBe('UNCERTAIN');
    expect(f.store.uncertain()).toHaveLength(1);
    await expect(new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).rejects.toThrow();
    expect(await f.owner.notification.evaluate(()=>(window as unknown as {commentClicks:number}).commentClicks)).toBe(1);
  }finally{await f.close();}
});
test.each(['account','parent','text','structure'])('final click rechecks %s in the exact original parent',async kind=>{
  const f=await setup();try{
    f.store.approve(f.draft.id,await f.adapter.inspect(f.event.payload),f.draft.version,f.draft.text);
    await f.owner.notification.evaluate(kind=>document.addEventListener('click',event=>{
      if((event.target as Element).id!=='comment-send')return;
      if(kind==='account')Object.getOwnPropertyDescriptor(document.querySelector('#self')!,'__reactFiber$fixture')!.value.return.memoizedProps.uid='900';
      if(kind==='parent')Object.getOwnPropertyDescriptor(document.querySelector('#reply-controls')!,'__reactFiber$fixture')!.value.return.return.memoizedProps.cid='12';
      if(kind==='text')document.querySelector('#comment-editor')!.textContent='unapproved';
      if(kind==='structure')document.querySelector('#comment-editor')!.innerHTML='<div data-contents="true"><div data-block="true"><b>approved root reply</b></div></div>';
    },true),kind);
    expect(await new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).toBe('UNCERTAIN');
    expect(await f.owner.notification.evaluate(()=>(window as unknown as {commentClicks:number}).commentClicks)).toBe(0);
  }finally{await f.close();}
});
test('focus-restored human comment draft survives and stale composer cannot borrow a root approval',async()=>{
  const f=await setup();try{
    f.store.approve(f.draft.id,await f.adapter.inspect(f.event.payload),f.draft.version,f.draft.text);
    await f.owner.notification.locator('#comment-editor').evaluate(editor=>editor.addEventListener('focus',()=>editor.textContent='human draft'));
    await expect(new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).rejects.toThrow();
    expect(await f.owner.notification.locator('#comment-editor').textContent()).toBe('human draft');
    expect(f.store.db.prepare('SELECT * FROM send_intents').all()).toEqual([]);
  }finally{await f.close();}
});
test('original author, work, level, metadata getter and duplicate root are guarded before intent',async()=>{
  const f=await setup();try{
    const event={...f.event.payload,text:'wrong original'};await expect(f.adapter.inspect(event)).rejects.toThrow('COMMENT_REPLY_ORIGINAL_CHANGED');
    await f.owner.notification.locator('#root-comment').evaluate(root=>{
      Object.defineProperty(Object.getOwnPropertyDescriptor(root,'__reactFiber$fixture')!.value.return.memoizedProps,'level',
        {get(){throw Error('Getter must not run');}});
    });
    await expect(f.adapter.inspect(f.event.payload)).rejects.toThrow('COMMENT_REPLY_ACCESSOR');
    expect(f.store.db.prepare('SELECT * FROM send_intents').all()).toEqual([]);
  }finally{await f.close();}
});
test('a notification source ID stays distinct from its accurate original comment CID',async()=>{
  const f=await setup();try{
    expect(await f.adapter.inspect({...f.event.payload,platformEventId:'notification-900'})).toHaveProperty('targetKey','comment:10:11');
  }finally{await f.close();}
});
test('a line break introduced by the editor during filling blocks before intent',async()=>{
  const f=await setup();try{
    f.store.approve(f.draft.id,await f.adapter.inspect(f.event.payload),f.draft.version,f.draft.text);
    await f.owner.notification.locator('#comment-editor').evaluate(editor=>editor.addEventListener('textInput',event=>{
      if((event as InputEvent).inputType!=='insertText')return;
      const block=editor.querySelector('[data-block]')!;block.prepend(document.createElement('br'));
      (window as unknown as {commentModel:string}).commentModel='\n'+(window as unknown as {commentModel:string}).commentModel;
    }));
    await expect(new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).rejects.toThrow('COMMENT_REPLY_EDITOR_UNSUPPORTED');
    expect(f.store.db.prepare('SELECT * FROM send_intents').all()).toEqual([]);
    expect(await f.owner.notification.evaluate(()=>(window as unknown as {commentClicks:number}).commentClicks)).toBe(0);
  }finally{await f.close();}
});
test('native publish control may stay hidden until an asynchronously rendered nonempty draft',async()=>{
  const f=await setup();try{
    // Open the exact target without preparing text; its empty publish icon is hidden.
    await f.adapter.inspect(f.event.payload);
    await f.owner.notification.locator('#comment-send').evaluate(button=>(button as HTMLElement).style.display='none');
    await f.owner.notification.locator('#comment-editor').evaluate(editor=>editor.addEventListener('textInput',()=>{
      setTimeout(()=>{(document.querySelector('#comment-send') as HTMLElement).style.display='block';},150);
    }));
    f.store.approve(f.draft.id,await f.adapter.inspect(f.event.payload),f.draft.version,f.draft.text);
    expect(await new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).toBe('CONFIRMED');
    expect(await f.owner.notification.evaluate(()=>(window as unknown as {commentClicks:number}).commentClicks)).toBe(1);
  }finally{await f.close();}
});
test('controlled Draft input uses a bound textInput event rather than duplicate execCommand reconciliation',async()=>{
  const f=await setup();try{
    f.store.approve(f.draft.id,await f.adapter.inspect(f.event.payload),f.draft.version,f.draft.text);
    await f.owner.notification.locator('#comment-editor').evaluate(editor=>{
      let nativeBefore=false;
      editor.addEventListener('textInput',event=>{
        const input=event as InputEvent;if(input.inputType!=='insertText')return;
        nativeBefore=true;event.preventDefault();
        editor.querySelector('.public-DraftStyleDefault-block')!.textContent=input.data;
        (window as unknown as {commentModel:string}).commentModel=input.data??'';
      });
      editor.addEventListener('input',event=>{
        if(!nativeBefore&&(event as InputEvent).inputType==='insertText')
          editor.querySelector('.public-DraftStyleDefault-block')!.append((event as InputEvent).data??'');
      });
    });
    expect(await new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).toBe('CONFIRMED');
    expect(await f.owner.notification.evaluate(()=>(window as unknown as {commentClicks:number}).commentClicks)).toBe(1);
  }finally{await f.close();}
});
test.each(['draft','target','focus'])('bound input completion rechecks %s and preserves subsequent human text',async kind=>{
  const f=await setup();try{
    f.store.approve(f.draft.id,await f.adapter.inspect(f.event.payload),f.draft.version,f.draft.text);
    const hooks=f.adapter as unknown as {frame:(event:unknown,action?:string,...args:unknown[])=>Promise<unknown>};
    const original=hooks.frame.bind(hooks);let hookCalls=0;
    hooks.frame=async(event,action,...args)=>{const result=await original(event,action,...args);
      if(action==='fill'){hookCalls++;await f.owner.notification.evaluate(kind=>{
        if(kind==='focus'){
          const other=document.createElement('textarea');other.id='other-draft';other.value='human other draft';document.body.append(other);other.focus();
        }else{
          document.querySelector('#comment-editor .public-DraftStyleDefault-block')!.textContent='restored human draft';
          if(kind==='target')Object.getOwnPropertyDescriptor(document.querySelector('#reply-controls')!,'__reactFiber$fixture')!.value.return.return.memoizedProps.cid='12';
        }
      },kind);}return result;};
    if(kind==='focus')expect(await new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).toBe('CONFIRMED');
    else await expect(new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).rejects.toThrow();
    expect(hookCalls).toBe(1);
    if(kind==='focus')expect(await f.owner.notification.locator('#other-draft').inputValue()).toBe('human other draft');
    else expect(await f.owner.notification.locator('#comment-editor').textContent()).toBe('restored human draft');
    expect(f.store.db.prepare('SELECT * FROM send_intents').all()).toHaveLength(kind==='focus'?1:0);
    expect(await f.owner.notification.evaluate(()=>(window as unknown as {commentClicks:number}).commentClicks)).toBe(kind==='focus'?1:0);
  }finally{await f.close();}
});
test('unrelated synthetic beforeinput cannot substitute for an intercepted bound textInput',async()=>{
  const f=await setup();try{
    f.store.approve(f.draft.id,await f.adapter.inspect(f.event.payload),f.draft.version,f.draft.text);
    await f.owner.notification.locator('#comment-editor').evaluate((editor,text)=>{
        editor.addEventListener('textInput',event=>event.stopImmediatePropagation(),true);
        editor.dispatchEvent(new InputEvent('beforeinput',{data:text,inputType:'insertText',bubbles:true,cancelable:true,composed:true}));
      },f.draft.text);
    await expect(new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).rejects.toThrow('COMMENT_REPLY_INPUT_NOT_WITNESSED');
    expect(await f.owner.notification.locator('#comment-editor').textContent()).toBe('');
    expect(f.store.db.prepare('SELECT * FROM send_intents').all()).toEqual([]);
  }finally{await f.close();}
});
test('iframe focus after bound input cannot turn the approved reply into an iframe overwrite',async()=>{
  const f=await setup();try{
    f.store.approve(f.draft.id,await f.adapter.inspect(f.event.payload),f.draft.version,f.draft.text);
    await f.owner.notification.evaluate(()=>{const frame=document.createElement('iframe');frame.id='foreign-editor';document.body.append(frame);
      frame.contentDocument!.body.innerHTML='<textarea>human frame draft</textarea>';});
    const hooks=f.adapter as unknown as {frame:(event:unknown,action?:string,...args:unknown[])=>Promise<unknown>};
    const original=hooks.frame.bind(hooks);let hookCalls=0;
    hooks.frame=async(event,action,...args)=>{const result=await original(event,action,...args);
      if(action==='fill'){hookCalls++;await f.owner.notification.evaluate(()=>{
        const textarea=(document.querySelector('#foreign-editor') as HTMLIFrameElement).contentDocument!.querySelector('textarea')!;
        textarea.focus();textarea.select();
      });}return result;};
    expect(await new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).toBe('CONFIRMED');
    expect(hookCalls).toBe(1);
    expect(await f.owner.notification.evaluate(()=>(document.querySelector('#foreign-editor') as HTMLIFrameElement).contentDocument!.querySelector('textarea')!.value)).toBe('human frame draft');
    expect(await f.owner.notification.evaluate(()=>(window as unknown as {commentClicks:number}).commentClicks)).toBe(1);
  }finally{await f.close();}
});
test.each(['split','nested','foreign-origin','wrong-native'])('a %s child cannot borrow a parent receipt',async kind=>{
  const f=await setup();try{
    f.store.approve(f.draft.id,await f.adapter.inspect(f.event.payload),f.draft.version,f.draft.text);
    const click=f.adapter.clickOnce.bind(f.adapter);f.adapter.clickOnce=async()=>{
      await click();await f.owner.notification.evaluate(kind=>{
        const root=document.querySelector('#root-comment')!,child=root.querySelector('.comment')!;
        if(kind==='split'){
          const body=child.querySelector('.body')!,author=child.querySelector('.author')!;
          const bodyRow=document.createElement('div'),authorRow=document.createElement('div');bodyRow.className=authorRow.className='comment';
          bodyRow.append(body);authorRow.append(author);root.append(bodyRow,authorRow);
        }
        if(kind==='nested'){const wrapper=document.createElement('div');wrapper.className='comment';root.append(wrapper);wrapper.append(child);}
        if(kind==='foreign-origin')child.querySelector('a')!.href='https://outside.example/user/self-sec';
        if(kind==='wrong-native'){
          const f=Object.getOwnPropertyDescriptor(child,'__reactFiber$fixture');
          if(f)f.value.return.memoizedProps.commentInfo.replyId='12';
        }
      },kind);
    };
    expect(await new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).toBe('UNCERTAIN');
    expect(f.store.uncertain()).toHaveLength(1);
  }finally{await f.close();}
});
test.each([false,true])('explicit human comment retry retains the original unknown; missing=%s',async missing=>{
  const f=await setup();try{
    const snap=await f.adapter.inspect(f.event.payload);f.store.approve(f.draft.id,snap,f.draft.version,f.draft.text);
    const original=f.store.recordIntent(f.draft.id,snap,false);f.store.receipt(original,'UNCERTAIN','OLD_UNKNOWN_FIXTURE');
    await f.owner.notification.evaluate(missing=>(window as unknown as {commentFailure:string}).commentFailure=missing?'missing':'',missing);
    const grant=f.store.authorizeCommentRetry(f.draft.id,await f.adapter.inspect(f.event.payload),'explicit fixture human retry');
    const retry=new ManualCommentRetry(f.store,f.owner.actor);
    expect(await retry.send(grant,f.adapter,false)).toBe(missing?'UNCERTAIN':'CONFIRMED');
    expect(f.store.event(f.event.id).status).toBe('UNCERTAIN');expect(f.store.uncertain()).toHaveLength(1);
    expect(await f.owner.notification.evaluate(()=>(window as unknown as {commentClicks:number}).commentClicks)).toBe(1);
    await expect(retry.send(grant,f.adapter,false)).rejects.toThrow('ALREADY_ATTEMPTED');
    expect(await f.owner.notification.evaluate(()=>(window as unknown as {commentClicks:number}).commentClicks)).toBe(1);
  }finally{await f.close();}
});
