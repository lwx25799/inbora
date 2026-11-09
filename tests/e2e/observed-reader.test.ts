import { expect, test } from 'vitest';
import { join } from 'node:path';
import { BrowserProfileOwner } from '../../src/browser/profile-owner.js';
import { ObservedReader, captureObserved } from '../../src/adapters/observed-reader.js';
import { validateObservationMapping } from '../../src/config/site-mapping.js';
import { observedMapping as config, mountObserved as mount, mountVirtualizedConversations, mountCommentReply, reloadableCommentReply } from '../fixtures/observed-site.js';
import { fixtureServer } from '../fixtures/site.js';
import { database, privateTemp } from '../helpers.js';

test.each([false,true])('background comments reveal an offscreen list without discarding webpage input (human input: %s)',async humanInput=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mountCommentReply(owner,server.origin);
    await reloadableCommentReply(owner.notification,server.origin);
    await owner.notification.addInitScript(humanInput=>document.addEventListener('DOMContentLoaded',()=>{
      (document.querySelector('#comment-list') as HTMLElement).style.marginTop='818px';
      if(humanInput){const input=document.createElement('textarea');input.value='keep unsent webpage draft';input.style.cssText='position:fixed;top:0';document.body.append(input);}
    }),humanInput);
    const task=new ObservedReader(owner.notification,config(server.origin)).comments(0,true);
    if(humanInput){
      await expect(task).rejects.toThrow('OBSERVATION_EXISTING_HUMAN_INPUT');
      expect(await owner.notification.locator('textarea').inputValue()).toBe('keep unsent webpage draft');
      expect(await owner.notification.evaluate(()=>scrollY)).toBe(0);
    }else{
      expect((await task).events).toHaveLength(1);
      expect(await owner.notification.evaluate(()=>scrollY)).toBeGreaterThan(0);
    }
  }finally{await owner.close();await server.close();}
});

test('DM window scrolling stays in its exact native chat and preserves existing webpage input',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mount(owner,server.origin);
    await owner.dm.evaluate(()=>{
      const list=document.createElement('div');list.id='history-window';list.style.cssText='height:40px;overflow-y:auto;width:300px';
      for(const box of document.querySelectorAll('.box'))list.append(box);
      document.querySelector('#chat')!.append(list);
    });
    const reader=new ObservedReader(owner.dm,config(server.origin)),peer=config(server.origin).peers[0]!;
    const batch=await reader.dmWindow(peer,0);
    expect(batch.dmViewport).toMatchObject({top:0,viewport:40,minimum:0});
    expect(batch.events.length).toBeGreaterThan(0);expect(batch.events.length).toBeLessThan(4);
    expect(batch.events[0]!.platformEventId).toBe('1');
    await expect(reader.scrollDm({...peer,conversationId:'outside'},50)).rejects.toThrow('OBSERVATION_CONVERSATION_CHANGED');
    expect(await owner.dm.locator('#history-window').evaluate(node=>node.scrollTop)).toBe(0);
    await owner.dm.evaluate(()=>{const input=document.createElement('textarea');input.value='unsent human text';document.querySelector('#chat')!.append(input);});
    await expect(reader.scrollDm(peer,50)).rejects.toThrow('OBSERVATION_EXISTING_HUMAN_INPUT');
    expect(await owner.dm.locator('textarea').inputValue()).toBe('unsent human text');
    expect(await owner.dm.locator('#history-window').evaluate(node=>node.scrollTop)).toBe(0);
  }finally{await owner.close();await server.close();}
});

test('bounded read diagnostics report geometry without reading bodies, inputs or native identifiers',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mountCommentReply(owner,server.origin);await mount(owner,server.origin);
    await owner.notification.evaluate(()=>{
      document.querySelector('#root-comment')!.setAttribute('style','display:contents');
      document.querySelector('.body')!.textContent='PRIVATE-BODY-MUST-NOT-LEAVE';
      const input=document.createElement('input');input.value='PRIVATE-KEY-MUST-NOT-LEAVE';document.querySelector('#comment-list')!.append(input);
    });
    const diagnostic=await new ObservedReader(owner.notification,config(server.origin)).diagnostic('comments');
    expect(diagnostic).toMatchObject({source:'comments',containers:1,visibleContainers:1,roots:1,samples:[{displayContents:true,hasBox:false,bodies:1,visibleBodies:1}]});
    const dm=await new ObservedReader(owner.dm,config(server.origin)).diagnostic('dm');
    expect(dm).toMatchObject({source:'dm',visibleContainers:1,chatVisible:true,chatInViewport:true,backVisible:true,backInViewport:true,rows:1});
    const serialized=JSON.stringify([diagnostic,dm]);
    for(const forbidden of ['PRIVATE-BODY','PRIVATE-KEY','conv-a','peer-sec','controlled-1'])expect(serialized).not.toContain(forbidden);
    const wrong=config(server.origin);wrong.works[0]!.url=server.origin+'/video/999';
    await expect(new ObservedReader(owner.notification,wrong).diagnostic('comments')).rejects.toThrow('OBSERVATION_WORK_CHANGED');
    await owner.dm.evaluate(()=>{Object.getOwnPropertyDescriptor(document.querySelector('#self')!,'__reactFiber$fixture')!.value.return.memoizedProps.uid='outside';});
    await expect(new ObservedReader(owner.dm,config(server.origin)).diagnostic('dm')).rejects.toThrow('OBSERVATION_ACCOUNT_CHANGED');
  }finally{await owner.close();await server.close();}
});

test('bounded back diagnostics distinguish a child control, occlusion and offscreen geometry without leaking content or invoking handlers',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mount(owner,server.origin);
    await owner.dm.evaluate(()=>{
      const state=window as unknown as {backHandlers:number};state.backHandlers=0;
      const wrapper=document.createElement('div');wrapper.id='back';wrapper.className='PRIVATE-WRAPPER';
      wrapper.style.cssText='position:fixed;left:24px;top:24px;width:80px;height:40px;z-index:1000';
      wrapper.setAttribute('data-private','PRIVATE-ATTRIBUTE');
      const button=document.createElement('button');button.style.cssText='position:absolute;inset:0;width:80px;height:40px';
      button.innerHTML='<span style="pointer-events:none">PRIVATE-CONTROL-TEXT</span>';
      Object.defineProperty(button,'__reactProps$private',{value:{onClick:()=>state.backHandlers++,onMouseDown:()=>state.backHandlers++,
        onPointerDown:()=>state.backHandlers++,onMouseUp:()=>state.backHandlers++,privateValue:'PRIVATE-PROPS-VALUE'}});
      wrapper.append(button);
      for(let i=0;i<16;i++){const child=document.createElement('private-secret-tag');child.hidden=true;wrapper.append(child);}
      document.querySelector('#back')!.replaceWith(wrapper);
    });
    const reader=new ObservedReader(owner.dm,config(server.origin)),diagnostic=await reader.diagnostic('dm');
    expect(diagnostic.back).toMatchObject({count:1,centerHit:'DESCENDANT',centerIndex:1});
    expect(diagnostic.back!.nodes).toHaveLength(12);
    expect(diagnostic.back!.nodes![0]).toMatchObject({index:0,parentIndex:null,tag:'DIV',visible:true,inViewport:true,width:80,height:40,props:'NONE'});
    expect(diagnostic.back!.nodes![1]).toMatchObject({index:1,parentIndex:0,tag:'BUTTON',props:'DATA',
      handlers:{onClick:true,onMouseDown:true,onPointerDown:true,onMouseUp:true}});
    expect(diagnostic.back!.nodes![3]!.tag).toBe('OTHER');
    for(const forbidden of ['PRIVATE-WRAPPER','PRIVATE-ATTRIBUTE','PRIVATE-CONTROL-TEXT','PRIVATE-PROPS-VALUE','PRIVATE-SECRET-TAG','private-secret-tag','conv-a','peer-sec'])
      expect(JSON.stringify(diagnostic)).not.toContain(forbidden);
    await owner.dm.evaluate(()=>{
      const cover=document.createElement('div');cover.id='cover';cover.textContent='PRIVATE-OVERLAY';
      cover.style.cssText='position:fixed;left:24px;top:24px;width:80px;height:40px;z-index:2000';document.body.append(cover);
    });
    expect((await reader.diagnostic('dm')).back).toMatchObject({centerHit:'OUTSIDE',centerIndex:null});
    await owner.dm.evaluate(()=>{
      document.querySelector('#cover')!.remove();
      for(const child of document.querySelector('#back')!.querySelectorAll<HTMLElement>('*'))child.style.pointerEvents='none';
    });
    expect((await reader.diagnostic('dm')).back).toMatchObject({centerHit:'SELF',centerIndex:0});
    await owner.dm.evaluate(()=>(document.querySelector('#back') as HTMLElement).style.left='-5000px');
    expect((await reader.diagnostic('dm')).back).toMatchObject({centerHit:'OFFSCREEN',centerIndex:null});
    expect(await owner.dm.evaluate(()=>(window as unknown as {backHandlers:number}).backHandlers)).toBe(0);
  }finally{await owner.close();await server.close();}
});

test.each(['props','handler','multiple'])('back diagnostic rejects %s descriptors without invoking a getter and omits shapes for multiple mapped controls',async kind=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mount(owner,server.origin);
    await owner.dm.evaluate(kind=>{
      const state=window as unknown as {backGetters:number};state.backGetters=0;
      const back=document.querySelector('#back')!,props={};
      if(kind==='props')Object.defineProperty(back,'__reactProps$private',{get(){state.backGetters++;throw new Error('PRIVATE-GETTER');}});
      else if(kind==='handler'){
        Object.defineProperty(props,'onClick',{get(){state.backGetters++;throw new Error('PRIVATE-HANDLER');}});
        Object.defineProperty(back,'__reactProps$private',{value:props});
      }else{
        Object.defineProperty(back,'__reactProps$first',{value:{onClick:()=>state.backGetters++}});
        Object.defineProperty(back,'__reactProps$second',{value:{onClick:()=>state.backGetters++}});
      }
    },kind);
    const reader=new ObservedReader(owner.dm,config(server.origin));
    expect((await reader.diagnostic('dm')).back!.nodes![0]).toMatchObject({props:'REJECTED',
      handlers:{onClick:false,onMouseDown:false,onPointerDown:false,onMouseUp:false}});
    expect(await owner.dm.evaluate(()=>(window as unknown as {backGetters:number}).backGetters)).toBe(0);
    await owner.dm.evaluate(()=>document.querySelector('#chat')!.append(document.querySelector('#back')!.cloneNode(true)));
    expect((await reader.diagnostic('dm')).back).toEqual({count:2});
    expect(await owner.dm.evaluate(()=>(window as unknown as {backGetters:number}).backGetters)).toBe(0);
  }finally{await owner.close();await server.close();}
});

test('conversation discovery waits for native back transition before returning or reopening the same chat',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mount(owner,server.origin);
    await owner.dm.evaluate(()=>{
      const chat=document.querySelector('#chat') as HTMLElement;
      const state=window as unknown as {backs:number;opens:number};state.backs=0;state.opens=0;
      document.querySelector('#back')!.addEventListener('click',()=>{state.backs++;setTimeout(()=>{chat.hidden=true;},180);});
      document.querySelector('.conversation')!.addEventListener('click',()=>{state.opens++;chat.hidden=false;});
    });
    const reader=new ObservedReader(owner.dm,config(server.origin)),found=await reader.conversations();
    expect(await owner.dm.locator('#chat').isVisible()).toBe(false);
    expect(found.peers).toHaveLength(1);
    const batch=await reader.dm(0,found.peers![0]);
    expect(batch.events.map(e=>e.platformEventId)).toEqual(['1','2','3','4']);
    await new Promise(r=>setTimeout(r,220));
    expect(await owner.dm.locator('#chat').isVisible()).toBe(true);
    expect(await owner.dm.evaluate(()=>({backs:(window as unknown as {backs:number}).backs,opens:(window as unknown as {opens:number}).opens}))).toEqual({backs:1,opens:1});
  }finally{await owner.close();await server.close();}
});

test('native-bound conversation title may settle after metadata without selecting another row',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mount(owner,server.origin);
    await owner.dm.evaluate(()=>{
      (document.querySelector('#chat') as HTMLElement).hidden=true;
      const title=document.querySelector('.conversation .title')!,row=document.querySelector('.conversation')!;
      title.textContent='Loading rendered display name';
      (window as unknown as {opened:number}).opened=0;
      row.addEventListener('click',()=>{(window as unknown as {opened:number}).opened++;(document.querySelector('#chat') as HTMLElement).hidden=false;});
      setTimeout(()=>title.textContent='Fixture peer',200);
    });
    expect((await new ObservedReader(owner.dm,config(server.origin)).dm(0)).events).toHaveLength(4);
    expect(await owner.dm.evaluate(()=>(window as unknown as {opened:number}).opened)).toBe(1);
  }finally{await owner.close();await server.close();}
});

test.each([false,true])('a virtualized permitted conversation is found beyond the first viewport (same title: %s)',async sameTitle=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mount(owner,server.origin);await mountVirtualizedConversations(owner.dm,sameTitle);
    const mapping=config(server.origin);
    Object.assign(mapping.selectors,{conversationList:'#conversation-list'});
    const batch=await owner.actor.run(()=>new ObservedReader(owner.dm,mapping).dm(0));
    expect(batch.events.map(e=>e.platformEventId)).toEqual(['1','2','3','4']);
    expect(await owner.dm.evaluate(()=>(window as unknown as {opened:number}).opened)).toBe(1);
    expect(await owner.dm.evaluate(()=>(window as unknown as {outsideOpened:number}).outsideOpened)).toBe(0);
    expect(await owner.dm.evaluate(()=>(window as unknown as {listScrolls:number}).listScrolls)).toBeGreaterThan(0);
  }finally{await owner.close();await server.close();}
});

test('duplicate native conversations remain unselected after scrolling',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mount(owner,server.origin);await mountVirtualizedConversations(owner.dm);
    await owner.dm.evaluate(()=>document.querySelector('#conversation-list')!.addEventListener('scroll',()=>{
      const target=document.querySelector('.conversation')!;
      const native=Object.getOwnPropertyDescriptor(target,'__reactFiber$fixture')!.value;
      if(native.return.memoizedProps.conversation.id!=='conv-a')return;
      const copy=target.cloneNode(true);
      Object.defineProperty(copy,'__reactFiber$fixture',{value:native});target.parentElement!.append(copy);
    }));
    const mapping=config(server.origin);Object.assign(mapping.selectors,{conversationList:'#conversation-list'});
    await expect(new ObservedReader(owner.dm,mapping).dm(0)).rejects.toThrow('OBSERVATION_CONVERSATION_NOT_UNIQUE');
    expect(await owner.dm.evaluate(()=>(window as unknown as {opened:number}).opened)).toBe(0);
  }finally{await owner.close();await server.close();}
});

test('account change during a list scroll cannot select a conversation',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mount(owner,server.origin);await mountVirtualizedConversations(owner.dm);
    await owner.dm.evaluate(()=>document.querySelector('#conversation-list')!.addEventListener('scroll',()=>{
      Object.getOwnPropertyDescriptor(document.querySelector('#self')!,'__reactFiber$fixture')!.value.return.memoizedProps.uid='outside';
    }));
    const mapping=config(server.origin);mapping.selectors.conversationList='#conversation-list';
    await expect(new ObservedReader(owner.dm,mapping).dm(0)).rejects.toThrow('OBSERVATION_ACCOUNT_CHANGED');
    expect(await owner.dm.evaluate(()=>(window as unknown as {opened:number}).opened)).toBe(0);
    expect(await owner.dm.evaluate(()=>(window as unknown as {outsideOpened:number}).outsideOpened)).toBe(0);
  }finally{await owner.close();await server.close();}
});

test('calibrated rendered reader preserves three server identities, excludes outgoing tasks and blocks partial data', async () => {
  const server = await fixtureServer(), owner = await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  const store = database();
  try {
    await mount(owner,server.origin); const mapping = config(server.origin), reader = new ObservedReader(owner.dm,mapping);
    const batch = await owner.actor.run(()=>reader.dm(0));
    expect(batch.events.map(e=>e.platformEventId)).toEqual(['1','2','3','4']);
    expect(batch.unsupported).toBe(1);
    store.observe('DIRECT_MESSAGE','conv-a',[],'100','fixture');
    for(let n=0;n<5;n++) store.observe('DIRECT_MESSAGE','conv-a',batch.events,'100','fixture');
    expect(store.events()).toHaveLength(3);
    expect(store.events().every(e=>e.status==='AWAITING_DRAFT' && e.payload.discovery==='DIRECT_MESSAGE')).toBe(true);
    await owner.dm.locator('.message').first().evaluate(row=>{
      const p=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value;
      Object.defineProperty(p.children.props.message,'createdAt',{get(){ throw new Error('getter must never execute'); }});
    });
    await expect(reader.dm(0)).rejects.toThrow('RENDERED_ACCESSOR_UNSUPPORTED');
    expect(store.db.prepare('SELECT id FROM send_intents').all()).toEqual([]);
  } finally {store.close();await owner.close();await server.close();}
});
test('rendered metadata cannot override a conflicting conversation or direction', async () => {
  const server = await fixtureServer(), owner = await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try {
    await mount(owner,server.origin); const reader=new ObservedReader(owner.dm,config(server.origin));
    await owner.dm.locator('.message').first().evaluate(row=>{
      Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message.conversationId='conv-other';
    });
    await expect(reader.dm(0)).rejects.toThrow('OBSERVATION_MESSAGE_CONVERSATION_CONFLICT');
    await owner.dm.locator('.message').first().evaluate(row=>{
      const m=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
      m.conversationId='conv-a';m.sender='100';
    });
    await expect(reader.dm(0)).rejects.toThrow('OBSERVATION_DIRECTION_CONFLICT');
  } finally {await owner.close();await server.close();}
});
test('same-title unpermitted conversation is blocked before opening, not just before persistence',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try {
    await mount(owner,server.origin);
    await owner.dm.evaluate(()=>{
      (document.querySelector('#chat') as HTMLElement).hidden=true;
      const row=document.querySelector('.conversation')!;
      Object.getOwnPropertyDescriptor(row,'__reactFiber$fixture')!.value.return.memoizedProps.conversation.id='outside';
      (window as unknown as {opened:number}).opened=0;
      row.addEventListener('mousedown',()=>{
        (window as unknown as {opened:number}).opened++;
        (document.querySelector('#chat') as HTMLElement).hidden=false;
        Object.getOwnPropertyDescriptor(document.querySelector('#header')!,'__reactProps$fixture')!.value.children.props.conversation.id='outside';
      });
    });
    await new ObservedReader(owner.dm,config(server.origin)).dm(0).catch(()=>undefined);
    expect(await owner.dm.evaluate(()=>(window as unknown as {opened:number}).opened)).toBe(0);
  } finally {await owner.close();await server.close();}
});
test('hidden message or text is excluded and conflicting conversation aliases fail closed',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try {
    await mount(owner,server.origin);const reader=new ObservedReader(owner.dm,config(server.origin));
    await owner.dm.locator('.message').nth(0).evaluate(row=>(row as HTMLElement).hidden=true);
    await owner.dm.locator('.message .text').nth(1).evaluate(text=>(text as HTMLElement).style.visibility='hidden');
    expect((await reader.dm(0)).events.map(e=>e.platformEventId)).toEqual(['3','4']);
    await owner.dm.locator('#header').evaluate(header=>{
      Object.getOwnPropertyDescriptor(header,'__reactProps$fixture')!.value.children.props.conversation.conversationId='different';
    });
    await expect(reader.dm(0)).rejects.toThrow('OBSERVATION_CONVERSATION_ID_CONFLICT');
  } finally {await owner.close();await server.close();}
});
test('two different rendered conversation identity aliases are rejected',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try {
    await mount(owner,server.origin);
    await owner.dm.locator('#header').evaluate(header=>{
      Object.getOwnPropertyDescriptor(header,'__reactProps$fixture')!.value.children.props.conversation.conversationId='conv-a';
      Object.getOwnPropertyDescriptor(header,'__reactProps$fixture')!.value.children.props.conversation.id='outside';
    });
    await expect(new ObservedReader(owner.dm,config(server.origin)).dm(0)).rejects.toThrow('OBSERVATION_CONVERSATION_ID_CONFLICT');
  } finally {await owner.close();await server.close();}
});
test('a valid active chat remains readable when the covered conversation list is hidden',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try {
    await mount(owner,server.origin);owner.dm.setDefaultTimeout(300);
    await owner.dm.locator('.conversation').evaluate(row=>(row as HTMLElement).hidden=true);
    expect((await new ObservedReader(owner.dm,config(server.origin)).dm(0)).events).toHaveLength(4);
  } finally {await owner.close();await server.close();}
});
test('the full bounded visible window includes a twenty-first new inbound message',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  const store=database();
  try {
    await mount(owner,server.origin);
    await owner.dm.evaluate(()=>{
      for(let id=5;id<=21;id++){
        const box=document.createElement('div');box.className='box';
        const row=document.createElement('div');row.className='message';
        const text=document.createElement('span');text.className='text';text.textContent=`tail-${id}`;row.append(text);box.append(row);
        Object.defineProperty(row,'__reactProps$fixture',{value:{children:{props:{message:{serverId:String(id),
          conversationId:'conv-a',sender:'200',createdAt:new Date('2026-11-05T00:00:00Z'),_parsedContent:{text:text.textContent}}}}}});
        document.querySelector('#chat')!.append(box);
      }
    });
    const reader=new ObservedReader(owner.dm,config(server.origin));const batch=await reader.dm(0);
    expect(batch.events.map(e=>e.platformEventId)).toContain('21');
    expect(batch.events).toHaveLength(21);
    store.observe('DIRECT_MESSAGE','conv-a',[],'100','fixture');
    store.observe('DIRECT_MESSAGE','conv-a',batch.events,'100','fixture');
    expect(store.events()).toHaveLength(20);
  } finally {store.close();await owner.close();await server.close();}
});
test('conversation identity changed in document mousedown cannot open an outside peer',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try {
    await mount(owner,server.origin);
    await owner.dm.evaluate(()=>{
      (document.querySelector('#chat') as HTMLElement).hidden=true;
      (window as unknown as {outsideOpened:number}).outsideOpened=0;
      document.addEventListener('mousedown',()=>{
        const row=document.querySelector('.conversation')!;
        Object.getOwnPropertyDescriptor(row,'__reactFiber$fixture')!.value.return.memoizedProps.conversation.id='outside';
      },true);
      document.querySelector('.conversation')!.addEventListener('mousedown',()=>{
        (window as unknown as {outsideOpened:number}).outsideOpened++;
        (document.querySelector('#chat') as HTMLElement).hidden=false;
        Object.getOwnPropertyDescriptor(document.querySelector('#header')!,'__reactProps$fixture')!.value.children.props.conversation.id='outside';
      });
    });
    const mapping=config(server.origin);mapping.selectors.conversationSelectEvent='mousedown';
    await expect(new ObservedReader(owner.dm,mapping).dm(0)).rejects.toThrow('OBSERVATION_ROW_SELECTION_BLOCKED');
    expect(await owner.dm.evaluate(()=>(window as unknown as {outsideOpened:number}).outsideOpened)).toBe(0);
  } finally {await owner.close();await server.close();}
});
test('work discovery requires exact work, author, tooltip ID and visible text', async () => {
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try {
    owner.notification.setDefaultTimeout(80);
    owner.notification.setDefaultNavigationTimeout(5000);
    const url=server.origin+'/video/10';
    await owner.notification.route(url,route=>route.fulfill({contentType:'text/html',body:`<a id="self" style="visibility:hidden">Self</a>
      <section id="comment-list" style="min-height:24px"><div class="comment"><a class="author" href="/user/peer-sec">Fixture peer</a>
      <div class="tooltip" id="tooltip_50"><span class="body">one comment</span></div></div></section>`}));
    await owner.notification.addInitScript(() => {
      document.addEventListener('DOMContentLoaded',()=>{
        setTimeout(()=>{
          const self=document.querySelector('#self') as HTMLElement;
          Object.defineProperty(self,'__reactFiber$fixture',{value:{return:{memoizedProps:{uid:'100',secUid:'self-sec'}}}});
          self.style.visibility='visible';
        },300);
        const delayed=document.querySelector('.comment')!;
        Object.defineProperty(delayed,'__reactFiber$fixture',{value:{return:{memoizedProps:{
          awemeInfo:{awemeId:'10'},userInfo:{uid:'100'},commentInfo:{cid:'50',text:'one comment',createTime:1793836800,
            user:{uid:'200',secUid:'peer-sec'}}}}}});
        delayed.remove();setTimeout(()=>document.querySelector('#comment-list')!.append(delayed),1000);
      });
    });
    const reader=new ObservedReader(owner.notification,config(server.origin));
    const batch=await reader.comments(0);
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]).toMatchObject({platformEventId:'50',videoId:'10',commentId:'50',actorId:'200',discovery:'ALLOWED_WORK'});
    await owner.notification.locator('.body').evaluate(e=>e.textContent='changed visible text');
    const changed=await owner.notification.evaluate(captureObserved,
      {mapping:config(server.origin),channel:'comments' as const,index:0,evidenceId:'fixture'});
    expect(changed.events[0]).toMatchObject({text:'one comment',observationIssue:'COMMENT_TEXT_UNVERIFIED'});
    expect(changed.unsupported).toBe(1);
    const outside=config(server.origin);outside.works[0]!.url='https://example.com/video/10';
    expect(()=>validateObservationMapping(outside,false)).toThrow('UNSAFE_OBSERVATION_URL');
  } finally {await owner.close();await server.close();}
});
test('only an explicitly mapped empty comment state permits a successful empty work observation',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await owner.notification.route(server.origin+'/video/10',route=>route.fulfill({contentType:'text/html',
      body:'<a id="self">Self</a><section id="comment-list"><div id="empty-comments">No comments</div></section>'}));
    await owner.notification.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>{
      Object.defineProperty(document.querySelector('#self')!,'__reactFiber$fixture',{value:{return:{memoizedProps:{uid:'100',secUid:'self-sec'}}}});
    }));
    const batch=await new ObservedReader(owner.notification,config(server.origin)).comments(0);
    expect(batch.loaded).toBe(0);expect(batch.events).toEqual([]);
    const unmapped=config(server.origin);unmapped.selectors.commentEmpty=null;
    await expect(owner.notification.evaluate(captureObserved,{mapping:unmapped,channel:'comments' as const,index:0,evidenceId:'fixture'}))
      .rejects.toThrow('OBSERVATION_COMMENT_ROOTS_DOM_NOT_READY');
    await owner.notification.locator('#empty-comments').evaluate(node=>node.remove());
    await expect(owner.notification.evaluate(captureObserved,{mapping:config(server.origin),channel:'comments' as const,index:0,evidenceId:'fixture'}))
      .rejects.toThrow('OBSERVATION_COMMENT_ROOTS_DOM_NOT_READY');
  }finally{await owner.close();await server.close();}
});
