import {expect,test} from 'vitest';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {captureObserved} from '../../src/adapters/observed-reader.js';
import {ObservedCommentReply} from '../../src/adapters/observed-comment-reply.js';
import {SendCoordinator} from '../../src/core/send-coordinator.js';
import {ManualCommentRetry} from '../../src/core/manual-comment-retry.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountCommentReply,commentReplyMapping} from '../fixtures/observed-site.js';
import {database,privateTemp} from '../helpers.js';

async function setup(){
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true),store=database();
  await mountCommentReply(owner,server.origin);const mapping=commentReplyMapping(server.origin),adapter=new ObservedCommentReply(owner.notification,mapping,250);
  const batch=await owner.notification.evaluate(captureObserved,{mapping:mapping.observation,channel:'comments' as const,index:0,evidenceId:'fixture-root-snapshot'});
  store.observe('COMMENT_NOTIFICATION','work:10',[],'100','fixture');store.observe('COMMENT_NOTIFICATION','work:10',batch.events,'100','fixture');
  const event=store.events()[0]!,draft=store.saveDraft(event.id,'approved root reply','mock');
  return{owner,store,server,mapping,adapter,event,draft,close:async()=>{store.close();await owner.close();await server.close();}};
}
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
