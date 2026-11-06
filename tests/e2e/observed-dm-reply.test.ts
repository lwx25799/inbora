import {expect,test} from 'vitest';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {ObservedDmReply} from '../../src/adapters/observed-dm-reply.js';
import {SendCoordinator} from '../../src/core/send-coordinator.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountDmReply,dmReplyMapping} from '../fixtures/observed-site.js';
import {database,privateTemp} from '../helpers.js';
import {dmRequest,dmResponse} from '../fixtures/submission.js';

async function setup(){
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true),store=database();
  await mountDmReply(owner,server.origin);const mapping=dmReplyMapping(server.origin),adapter=new ObservedDmReply(owner.dm,mapping,250);
  const batch=await new ObservedReader(owner.dm,mapping.observation).dm(0);
  store.observe('DIRECT_MESSAGE','conv-a',[],'100','fixture');store.observe('DIRECT_MESSAGE','conv-a',batch.events,'100','fixture');
  const event=store.events()[0]!,draft=store.saveDraft(event.id,'approved native fixture reply','mock');
  return{server,owner,store,mapping,adapter,event,draft,close:async()=>{store.close();await owner.close();await server.close();}};
}

test('native SMS verification blocks both direct-message reading and reply inspection',async()=>{
  const f=await setup();try{
    await f.owner.dm.evaluate(()=>{const n=document.createElement('div');n.className='uc-ui-verify-new_header-title';n.textContent='接收短信验证码';document.body.append(n);});
    await expect(new ObservedReader(f.owner.dm,f.mapping.observation).dm(0)).rejects.toThrow('OBSERVATION_PAGE_BLOCKED');
    await expect(f.adapter.inspect(f.event.payload)).rejects.toThrow('PAGE_BLOCKED');
    expect(f.store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
    await f.owner.dm.locator('.uc-ui-verify-new_header-title').evaluate(n=>(n as HTMLElement).style.display='none');
    expect(await f.adapter.inspect(f.event.payload)).toHaveProperty('ownId','100');
  }finally{await f.close();}
});
test.each([true,false])('native SVG reply commits one durable intent and confirms only a bound new receipt, headless=%s',async headless=>{
  const f=await setup();
  try{
    if(!headless){
      // Exercise this calibrated contract in a separate headed owner as well.
      await f.owner.close();f.owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),false);
      await mountDmReply(f.owner,f.server.origin);f.adapter=new ObservedDmReply(f.owner.dm,f.mapping,250);
    }
    const snapshot=await f.adapter.inspect(f.event.payload);f.store.approve(f.draft.id,snapshot,f.draft.version,f.draft.text);
    const original=f.adapter.clickOnce.bind(f.adapter);
    f.adapter.clickOnce=async()=>{expect(f.store.db.prepare('SELECT status FROM send_intents').all()).toEqual([{status:'INTENT_RECORDED'}]);await original();};
    expect(await new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).toBe('CONFIRMED');
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(1);
    await expect(new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).rejects.toThrow();
  }finally{f.store.close();await f.owner.close();await f.server.close();}
});
test.each(['pending','wrong-conversation','old-time','no-receipt'])('native %s proof freezes the task and prohibits a second click',async kind=>{
  const f=await setup();
  try{
    f.store.approve(f.draft.id,await f.adapter.inspect(f.event.payload),f.draft.version,f.draft.text);
    await f.owner.dm.evaluate(kind=>{
      const state=window as unknown as {nativePending:boolean;nativeWrongReceipt:boolean;nativeOldReceipt:boolean;nativeNoReceipt:boolean};
      state.nativePending=kind==='pending';state.nativeWrongReceipt=kind==='wrong-conversation';
      state.nativeOldReceipt=kind==='old-time';state.nativeNoReceipt=kind==='no-receipt';
    },kind);
    expect(await new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).toBe('UNCERTAIN');
    expect(f.store.uncertain()).toHaveLength(1);
    await expect(new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).rejects.toThrow();
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(1);
  }finally{await f.close();}
});

test.each([false,true])('native DM requires a fresh receipt after normal reload; timestamp rolls back=%s',async rollback=>{
  const f=await setup();let reloads=0;
  try{
    f.owner.dm.on('framenavigated',frame=>{if(frame===f.owner.dm.mainFrame())reloads++;});
    if(rollback)await f.owner.dm.evaluate(()=>{(window as unknown as {nativeRehydratedTime:string}).nativeRehydratedTime='2020-01-01T00:00:00Z';});
    f.store.approve(f.draft.id,await f.adapter.inspect(f.event.payload),f.draft.version,f.draft.text);
    expect(await new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).toBe(rollback?'UNCERTAIN':'CONFIRMED');
    expect(reloads).toBe(1);
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(1);
    if(rollback){
      expect(f.store.uncertain()).toHaveLength(1);
      await expect(new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).rejects.toThrow();
    }
  }finally{await f.close();}
});

test('native DM receipt refresh preserves a new human draft without reloading',async()=>{
  const f=await setup();let reloads=0;
  try{
    f.owner.dm.on('framenavigated',frame=>{if(frame===f.owner.dm.mainFrame())reloads++;});
    f.store.approve(f.draft.id,await f.adapter.inspect(f.event.payload),f.draft.version,f.draft.text);
    const click=f.adapter.clickOnce.bind(f.adapter);
    f.adapter.clickOnce=async()=>{await click();await f.owner.dm.locator('#native-editor').fill('human follow-up');};
    expect(await new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).toBe('UNCERTAIN');
    expect(reloads).toBe(0);expect(await f.owner.dm.locator('#native-editor').textContent()).toBe('human follow-up');
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(1);
  }finally{await f.close();}
});

test('native DM final empty snapshot cannot authorize reload over a later human draft',async()=>{
  const f=await setup();let initialComplete=false,injected=false,reloads=0;
  try{
    f.owner.dm.on('framenavigated',frame=>{if(frame===f.owner.dm.mainFrame())reloads++;});
    f.store.approve(f.draft.id,await f.adapter.inspect(f.event.payload),f.draft.version,f.draft.text);
    const hooks=f.adapter as unknown as {frame:(...args:unknown[])=>Promise<unknown>;poll:(...args:unknown[])=>Promise<unknown>},original=hooks.frame.bind(hooks),poll=hooks.poll.bind(hooks);
    hooks.poll=async(...args)=>{const result=await poll(...args);initialComplete=true;return result;};
    hooks.frame=async(...args)=>{
      const result=await original(...args);
      if(args[1]==='proofs'&&initialComplete&&!injected){injected=true;await f.owner.dm.locator('#native-editor').fill('late human follow-up');}
      return result;
    };
    expect(await new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).toBe('UNCERTAIN');
    expect(injected).toBe(true);expect(reloads).toBe(0);
    expect(await f.owner.dm.locator('#native-editor').textContent()).toBe('late human follow-up');
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(1);
  }finally{await f.close();}
});

test.each(['valid','wrong-client','wrong-sequence','wrong-owner','async','duplicate','wrong-id','missing'])('native DM request acknowledgement and refreshed ID agree across wall clocks: %s',async failure=>{
  const f=await setup();try{
    f.mapping.submissionReceipts=true;f.adapter.dispose();f.adapter=new ObservedDmReply(f.owner.dm,f.mapping,300);
    const response=dmResponse({...(failure==='wrong-client'?{client:'outside'}:{}),...(failure==='wrong-sequence'?{sequence:100}:{}),
      ...(failure==='wrong-owner'?{owner:200}:{}),...(failure==='async'?{async:true}:{}),...(failure==='wrong-id'?{id:802n}:{})});
    await f.owner.dm.route('https://imapi.douyin.com/v1/message/send',route=>route.fulfill({headers:{'access-control-allow-origin':f.server.origin,
      'access-control-allow-headers':'content-type'},contentType:'application/octet-stream',body:route.request().method()==='OPTIONS'?Buffer.alloc(0):response}));
    await f.owner.dm.evaluate(({request,failure})=>{
      (window as unknown as {nativeRehydratedTime:string}).nativeRehydratedTime=new Date(Date.now()-1500).toISOString();
      document.querySelector('#native-send')!.addEventListener('click',()=>{
        if(failure==='missing')return;
        const bytes=Uint8Array.from(atob(request),c=>c.charCodeAt(0));
        for(let n=0;n<(failure==='duplicate'?2:1);n++)void fetch('https://imapi.douyin.com/v1/message/send',{method:'POST',body:bytes});
      });
    },{request:dmRequest(f.draft.text).toString('base64'),failure});
    f.store.approve(f.draft.id,await f.adapter.inspect(f.event.payload),f.draft.version,f.draft.text);
    expect(await new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).toBe(failure==='valid'?'CONFIRMED':'UNCERTAIN');
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(1);
    await expect(new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).rejects.toThrow();
  }finally{f.adapter.dispose();await f.close();}
});

test('a second native request after the first acknowledgement revokes the cached proof',async()=>{
  const f=await setup();try{
    f.mapping.submissionReceipts=true;f.adapter.dispose();f.adapter=new ObservedDmReply(f.owner.dm,f.mapping,300);
    await f.owner.dm.route('https://imapi.douyin.com/v1/message/send',route=>route.fulfill({headers:{'access-control-allow-origin':f.server.origin,
      'access-control-allow-headers':'content-type'},body:route.request().method()==='OPTIONS'?Buffer.alloc(0):dmResponse()}));
    const request=dmRequest(f.draft.text).toString('base64');
    await f.owner.dm.locator('#native-send').evaluate((button,request)=>button.addEventListener('click',()=>void fetch('https://imapi.douyin.com/v1/message/send',{
      method:'POST',body:Uint8Array.from(atob(request),c=>c.charCodeAt(0))})),request);
    const hooks=f.adapter as unknown as {poll:(...args:unknown[])=>Promise<unknown>},poll=hooks.poll.bind(hooks);let injected=false;
    hooks.poll=async(...args)=>{const proof=await poll(...args);if(!injected){injected=true;await f.owner.dm.evaluate(async request=>{
      await fetch('https://imapi.douyin.com/v1/message/send',{method:'POST',body:Uint8Array.from(atob(request),c=>c.charCodeAt(0))});
    },request);}return proof;};
    f.store.approve(f.draft.id,await f.adapter.inspect(f.event.payload),f.draft.version,f.draft.text);
    expect(await new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).toBe('UNCERTAIN');
    expect(injected).toBe(true);
  }finally{f.adapter.dispose();await f.close();}
});
test('native guard blocks changed identity in document capture before the SVG handler',async()=>{
  const f=await setup();
  try{
    f.store.approve(f.draft.id,await f.adapter.inspect(f.event.payload),f.draft.version,f.draft.text);
    await f.owner.dm.evaluate(()=>document.addEventListener('click',event=>{
      if((event.target as Element).id!=='native-send')return;
      Object.getOwnPropertyDescriptor(document.querySelector('#header')!,'__reactProps$fixture')!.value.children.props.conversation.id='outside';
    },true));
    expect(await new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).toBe('UNCERTAIN');
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
  }finally{await f.close();}
});
test('composer native identity and disabled control cannot inherit the header approval',async()=>{
  const f=await setup();
  try{
    await f.owner.dm.locator('#native-controls').evaluate(element=>{
      Object.getOwnPropertyDescriptor(element,'__reactFiber$fixture')!.value.return.memoizedProps.curConversation.id='wrong';
    });
    await expect(f.adapter.inspect(f.event.payload)).rejects.toThrow('NATIVE_REPLY_COMPOSER_CONFLICT');
    await f.owner.dm.locator('#native-controls').evaluate(element=>{
      Object.getOwnPropertyDescriptor(element,'__reactFiber$fixture')!.value.return.memoizedProps.curConversation.id='conv-a';
    });
    f.store.approve(f.draft.id,await f.adapter.inspect(f.event.payload),f.draft.version,f.draft.text);
    await f.owner.dm.locator('#native-send').evaluate(e=>e.setAttribute('aria-disabled','true'));
    await expect(new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).rejects.toThrow('NATIVE_REPLY_GUARD_BLOCKED');
    expect(f.store.db.prepare('SELECT * FROM send_intents').all()).toEqual([]);
  }finally{await f.close();}
});
test.each(['line one\nline two','line\n','\nline','line\n\nlast',' spaced  two  ','line one\r\nline two\r\n'])('native draft preserves approved layout %j through readback',async text=>{
  const f=await setup();
  try{
    const draft=f.store.saveDraft(f.event.id,text,'manual');
    expect(draft.text).toBe(text.replace(/\r\n?/gu,'\n'));
    f.store.approve(draft.id,await f.adapter.inspect(f.event.payload),draft.version,draft.text);
    expect(await new SendCoordinator(f.store,f.owner.actor).send(draft.id,f.adapter,false)).toBe('CONFIRMED');
    expect(await f.owner.dm.locator('.message .text').last().textContent()).toBe(draft.text);
  }finally{await f.close();}
});
test.each([false,true])('focus-time restored human draft is never overwritten; outside=%s',async outside=>{
  const f=await setup();
  try{
    f.store.approve(f.draft.id,await f.adapter.inspect(f.event.payload),f.draft.version,f.draft.text);
    await f.owner.dm.locator('#native-editor').evaluate((editor,outside)=>editor.addEventListener('focus',()=>{
      editor.textContent='restored human draft';
      if(outside){
        Object.getOwnPropertyDescriptor(document.querySelector('#header')!,'__reactProps$fixture')!.value.children.props.conversation.id='outside';
        Object.getOwnPropertyDescriptor(document.querySelector('#native-controls')!,'__reactFiber$fixture')!.value.return.memoizedProps.curConversation.id='outside';
      }
    }),outside);
    await expect(new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).rejects.toThrow();
    expect(await f.owner.dm.locator('#native-editor').textContent()).toBe('restored human draft');
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
    expect(f.store.db.prepare('SELECT * FROM send_intents').all()).toEqual([]);
  }finally{await f.close();}
});

test('calibrated editor terminal marker is structural while approved zero-width text is retained',async()=>{
  const f=await setup();
  try{
    await f.owner.dm.locator('#native-editor').evaluate(editor=>{
      editor.setAttribute('data-slate-editor','true');editor.setAttribute('data-zone-container','*');
      editor.addEventListener('input',event=>{
        const input=event as InputEvent;if(input.inputType!=='insertText')return;
        const line=document.createElement('div');line.className='ace-line';line.setAttribute('data-node','true');
        const text=document.createElement('span');text.setAttribute('data-string','true');text.setAttribute('data-leaf','true');text.textContent=input.data;
        const marker=document.createElement('span');marker.setAttribute('data-string','true');marker.setAttribute('data-leaf','true');marker.setAttribute('data-enter','true');marker.textContent='\u200B';
        line.append(text,marker);editor.replaceChildren(line);
      });
    });
    const draft=f.store.saveDraft(f.event.id,'approved\u200Btext','manual');
    f.store.approve(draft.id,await f.adapter.inspect(f.event.payload),draft.version,draft.text);
    expect(await new SendCoordinator(f.store,f.owner.actor).send(draft.id,f.adapter,false)).toBe('CONFIRMED');
    expect(await f.owner.dm.locator('.message .text').last().textContent()).toBe(draft.text);
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(1);
  }finally{await f.close();}
});

test.each(['text','nonterminal','outside','nested'])('unverified %s editor marker blocks before intent',async variant=>{
  const f=await setup();
  try{
    f.store.approve(f.draft.id,await f.adapter.inspect(f.event.payload),f.draft.version,f.draft.text);
    await f.owner.dm.locator('#native-editor').evaluate((editor,variant)=>{
      editor.setAttribute('data-slate-editor','true');editor.setAttribute('data-zone-container','*');
      editor.addEventListener('input',event=>{
        const input=event as InputEvent;if(input.inputType!=='insertText')return;
        const line=document.createElement('div');line.className='ace-line';line.setAttribute('data-node','true');
        const text=document.createTextNode(input.data??''),marker=document.createElement('span');
        marker.setAttribute('data-string','true');marker.setAttribute('data-leaf','true');marker.setAttribute('data-enter','true');
        marker.textContent=variant==='text'?'unapproved':'\u200B';
        if(variant==='nonterminal')line.append(marker,text);else line.append(text,marker);
        if(variant==='outside')line.className='unknown';
        if(variant==='nested'){
          const nested=document.createElement('div');nested.contentEditable='true';nested.setAttribute('data-slate-editor','true');
          nested.setAttribute('data-zone-container','*');nested.append(line);editor.replaceChildren(nested);
        }else editor.replaceChildren(line);
      });
    },variant);
    await expect(new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).rejects.toThrow(
      variant==='nested'?'NATIVE_REPLY_EDITOR_UNSUPPORTED':'NATIVE_REPLY_EDITOR_MARKER_CHANGED');
    expect(f.store.db.prepare('SELECT * FROM send_intents').all()).toEqual([]);
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
  }finally{await f.close();}
});
test('new incoming context, missing latest end, login dialog, getter and existing draft block native reply',async()=>{
  const f=await setup();
  try{
    await f.owner.dm.locator('#native-editor').fill('human draft');
    await expect(f.adapter.inspect(f.event.payload)).rejects.toThrow('NATIVE_REPLY_EXISTING_DRAFT');
    await f.owner.dm.locator('#native-editor').fill('');
    const snapshot=await f.adapter.inspect(f.event.payload);f.store.approve(f.draft.id,snapshot,f.draft.version,f.draft.text);
    await f.owner.dm.locator('.text').nth(1).evaluate(text=>{
      text.textContent='changed context';
      Object.getOwnPropertyDescriptor(text.parentElement!,'__reactProps$fixture')!.value.children.props.message._parsedContent.text=text.textContent;
    });
    await expect(new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).rejects.toThrow('TARGET_CHANGED_REAPPROVE');
    expect(f.store.draft(f.draft.id).approval).toBeNull();
    await f.owner.dm.evaluate(()=>{const dialog=document.createElement('div');dialog.setAttribute('role','dialog');dialog.textContent='扫码登录';document.body.append(dialog);});
    await expect(f.adapter.inspect(f.event.payload)).rejects.toThrow('NATIVE_REPLY_PAGE_BLOCKED');
    await f.owner.dm.locator('[role=dialog]').evaluate(e=>e.remove());
    await f.owner.dm.locator('[data-index="0"]').evaluate(e=>e.setAttribute('data-index','30'));
    await expect(f.adapter.inspect(f.event.payload)).rejects.toThrow('NATIVE_REPLY_LATEST_END_MISSING');
    await f.owner.dm.locator('[data-index="30"]').evaluate(e=>e.setAttribute('data-index','0'));
    await f.owner.dm.locator('.message').first().evaluate(row=>{
      const message=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
      Object.defineProperty(message,'serverStatus',{get(){throw new Error('Getter must not execute');}});
    });
    await expect(f.adapter.inspect(f.event.payload)).rejects.toThrow('NATIVE_REPLY_ACCESSOR_UNSUPPORTED');
    expect(f.store.db.prepare('SELECT * FROM send_intents').all()).toEqual([]);
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
  }finally{await f.close();}
});
test.each([false,true])('unapproved inline line break introduced after intent blocks the click; nested=%s',async nested=>{
  const f=await setup();
  try{
    f.store.approve(f.draft.id,await f.adapter.inspect(f.event.payload),f.draft.version,f.draft.text);
    const click=f.adapter.clickOnce.bind(f.adapter);
    f.adapter.clickOnce=async()=>{
      await f.owner.dm.locator('#native-editor').evaluate((editor,{text,nested})=>{
        const span=document.createElement('span'),line=document.createElement('br');
        if(nested){const paragraph=document.createElement('div');paragraph.append(line);span.append(paragraph);}else span.append(line);
        editor.replaceChildren(span,document.createTextNode(text));
        (window as unknown as {nativeEditorModel:string}).nativeEditorModel='\n'+text;
      },{text:f.draft.text,nested});
      await click();
    };
    expect(await new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).toBe('UNCERTAIN');
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
    expect(f.store.uncertain()).toHaveLength(1);
  }finally{await f.close();}
});
test.each(['pending','failed'])('a %s flag on the message box itself cannot confirm a receipt',async flag=>{
  const f=await setup();
  try{
    f.store.approve(f.draft.id,await f.adapter.inspect(f.event.payload),f.draft.version,f.draft.text);
    const click=f.adapter.clickOnce.bind(f.adapter);
    f.adapter.clickOnce=async()=>{await click();await f.owner.dm.locator('.box').last().evaluate((box,flag)=>box.classList.add(flag),flag);};
    expect(await new SendCoordinator(f.store,f.owner.actor).send(f.draft.id,f.adapter,false)).toBe('UNCERTAIN');
    expect(f.store.uncertain()).toHaveLength(1);
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(1);
  }finally{await f.close();}
});
test.each([false,true])('editor layout changed after preparation cannot reuse the text approval; wrapped=%s',async wrapped=>{
  const f=await setup();
  try{
    const draft=f.store.saveDraft(f.event.id,'a\nb','manual');
    f.store.approve(draft.id,await f.adapter.inspect(f.event.payload),draft.version,draft.text);
    const click=f.adapter.clickOnce.bind(f.adapter);
    f.adapter.clickOnce=async()=>{
      await f.owner.dm.locator('#native-editor').evaluate((editor,wrapped)=>{
        editor.innerHTML=wrapped?'<span>a<br></span><div>b</div>':'a<br><div>b</div>';
        (window as unknown as {nativeEditorModel:string}).nativeEditorModel='a\n\nb';
      },wrapped);await click();
    };
    expect(await new SendCoordinator(f.store,f.owner.actor).send(draft.id,f.adapter,false)).toBe('UNCERTAIN');
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
  }finally{await f.close();}
});
