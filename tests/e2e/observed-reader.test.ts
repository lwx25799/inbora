import { expect, test } from 'vitest';
import { join } from 'node:path';
import { BrowserProfileOwner } from '../../src/browser/profile-owner.js';
import { ObservedReader, captureObserved } from '../../src/adapters/observed-reader.js';
import { validateObservationMapping } from '../../src/config/site-mapping.js';
import { observedMapping as config, mountObserved as mount } from '../fixtures/observed-site.js';
import { fixtureServer } from '../fixtures/site.js';
import { database, privateTemp } from '../helpers.js';

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
    await expect(owner.notification.evaluate(captureObserved,
      {mapping:config(server.origin),channel:'comments' as const,index:0,evidenceId:'fixture'})).rejects.toThrow('OBSERVATION_COMMENT_TEXT_CONFLICT');
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
      .rejects.toThrow('OBSERVATION_DOM_NOT_READY');
    await owner.notification.locator('#empty-comments').evaluate(node=>node.remove());
    await expect(owner.notification.evaluate(captureObserved,{mapping:config(server.origin),channel:'comments' as const,index:0,evidenceId:'fixture'}))
      .rejects.toThrow('OBSERVATION_DOM_NOT_READY');
  }finally{await owner.close();await server.close();}
});
