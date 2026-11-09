import { expect,test } from 'vitest';
import { join } from 'node:path';
import { BrowserProfileOwner } from '../../src/browser/profile-owner.js';
import { InboxCollector } from '../../src/app/inbox-collector.js';
import { ObservedReader } from '../../src/adapters/observed-reader.js';
import { EventStore } from '../../src/storage/store.js';
import { AutomationStore } from '../../src/storage/automation-store.js';
import { migrateClient } from '../../src/storage/client-migration.js';
import { migrateAutomation } from '../../src/storage/automation-migration.js';
import { fixtureServer } from '../fixtures/site.js';
import { mountObserved,observedMapping } from '../fixtures/observed-site.js';
import { privateTemp } from '../helpers.js';

async function setup(){
  const server=await fixtureServer(),root=privateTemp('dm-content-'),owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
  const store=new EventStore(join(root,'poc.sqlite'),true),now=Date.now(),origin=now-10_000;
  await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  const data=new AutomationStore(store,()=>now);data.initialize(origin);store.bindAccount('100');
  data.configureCollection({ownId:'100',comments:false,inbox:true,commentIntervalMs:30_000,dmIntervalMs:15_000});
  await mountObserved(owner,server.origin);
  const mapping=observedMapping(server.origin),signal=new AbortController().signal;
  let collector=new InboxCollector(owner,mapping,data,root,'headless');
  return {server,root,owner,store,data,origin,mapping,signal,get collector(){return collector;},
    rebuild:()=>{collector.dispose();collector=new InboxCollector(owner,mapping,new AutomationStore(store,()=>now),root,'headless');},
    noExternal:()=>{
      expect(data.state().startedAt).toBe(origin);
      expect(store.db.prepare('SELECT kind,used FROM budgets ORDER BY kind').all()).toEqual([{kind:'MODEL',used:0},{kind:'SEND',used:0}]);
      expect(store.db.prepare('SELECT count(*) AS n FROM model_calls').get()).toEqual({n:0});
      expect(store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
    },
    lastRead:()=>(store.db.prepare("SELECT last_read FROM discovered_conversations WHERE id='conv-a'").get() as {last_read:number}|undefined)?.last_read??0,
    close:async()=>{collector.dispose();store.close();await owner.close();await server.close();}};
}

// Fixed MIT DSH 7989640 chat-browser.mjs:411-425/505-525 retains media as metadata-only.
// These DOM nodes are synthetic: no remote media, OCR, transcription or guessed platform subtype fields.
test('native DM media enters the inbox with an explicit unverified type while old history remains baseline across restart',async()=>{
  const f=await setup();
  try{
    await f.owner.dm.evaluate(origin=>{
      const chat=document.querySelector('#chat') as HTMLElement;
      const emoji=document.querySelector('.message:has(img)')!.closest('.box')!.cloneNode(true) as HTMLElement;
      const text=document.querySelector('.box')!.cloneNode(true) as HTMLElement;
      for(const node of chat.querySelectorAll('.box'))node.remove();
      const rows=[{id:'8101',kind:'text',old:false},{id:'8102',kind:'text',old:true},
        {id:'8103',kind:'emoji',old:false},{id:'8104',kind:'emoji',old:true},
        {id:'8105',kind:'video',old:false},{id:'8106',kind:'audio',old:false},{id:'8107',kind:'inline',old:false}];
      const state=window as unknown as {mediaAttributeReads:number};state.mediaAttributeReads=0;
      for(const spec of rows){
        const box=(spec.kind==='emoji'?emoji:text).cloneNode(true) as HTMLElement,row=box.querySelector('.message') as HTMLElement;
        row.style.cssText='min-height:28px;width:320px';
        if(spec.kind==='text')row.querySelector('.text')!.textContent='fixture text '+spec.id;
        else if(spec.kind==='video'||spec.kind==='audio'){
          row.replaceChildren();const media=document.createElement(spec.kind);media.style.cssText='display:block;width:40px;height:24px';
          if(media instanceof HTMLAudioElement)media.controls=true;
          row.append(media);
        }else if(spec.kind==='inline'){
          row.querySelector('.text')!.textContent='unverified inline prefix';const image=document.createElement('img');
          image.alt='private-alt-must-not-be-read';image.style.cssText='display:inline-block;width:24px;height:24px';row.querySelector('.text')!.append(image);
        }else row.querySelector('img')!.setAttribute('style','display:block;width:24px;height:24px');
        for(const media of row.querySelectorAll('img,video,audio')){
          Object.defineProperty(media,'getAttribute',{value(name:string){if(name==='src'||name==='alt')state.mediaAttributeReads++;return Element.prototype.getAttribute.call(this,name);}});
          for(const name of ['src','alt','currentSrc'])Object.defineProperty(media,name,{get(){state.mediaAttributeReads++;return 'private-media-source';}});
        }
        Object.defineProperty(row,'__reactProps$fixture',{value:{children:{props:{message:{serverId:spec.id,conversationId:'conv-a',sender:'200',
          createdAt:new Date(origin+(spec.old?-1000:1000)),_parsedContent:{text:row.textContent}}}}}});chat.append(box);
      }
      document.querySelector('#back')!.addEventListener('click',()=>{chat.hidden=true;});
      document.querySelector('.conversation')!.addEventListener('click',()=>{chat.hidden=false;});chat.hidden=true;
    },f.origin);
    const batch=await new ObservedReader(f.owner.dm,f.mapping).dmWindow(f.mapping.peers[0]!);
    expect(batch.loaded).toBe(7);expect(batch.events).toHaveLength(7);expect(batch.unsupported).toBe(5);
    await f.collector.collect('dm',f.signal);
    const events=f.store.events(),byId=(id:string)=>events.find(event=>event.payload.platformEventId===id)!;
    expect(events.map(event=>event.payload.platformEventId).sort()).toEqual(['8101','8102','8103','8104','8105','8106','8107']);
    expect(byId('8101')).toMatchObject({status:'AWAITING_DRAFT',payload:{text:'fixture text 8101'}});
    expect(byId('8101').payload.observationIssue).toBeUndefined();expect(byId('8102').status).toBe('BASELINE');
    const mediaCases=[['8103','IMAGE','[图片或表情消息，需人工查看]'],['8104','IMAGE','[图片或表情消息，需人工查看]'],
      ['8105','VIDEO','[视频消息，需人工查看]'],['8106','AUDIO','[音频消息，需人工查看]'],['8107','MIXED','[含媒体的消息，需人工查看]']] as const;
    for(const [id,contentType,text] of mediaCases){
      expect(byId(id)).toMatchObject({status:id==='8104'?'BASELINE':'MANUAL_REVIEW',payload:{platformEventId:id,actorId:'200',conversationId:'conv-a',
        direction:'INCOMING',kind:'DM',observationIssue:'DM_CONTENT_UNVERIFIED',contentType,text}});
      expect(byId(id).payload.text).not.toContain('private-');expect(byId(id).payload.text).not.toContain('unverified inline prefix');
    }
    expect(f.lastRead()).toBeGreaterThan(0);
    const identities=events.map(event=>({id:event.id,binding:event.binding,status:event.status,payload:event.payload}));
    f.rebuild();await f.collector.collect('dm',f.signal);await f.collector.collect('dm',f.signal);
    expect(f.store.events().map(event=>({id:event.id,binding:event.binding,status:event.status,payload:event.payload}))).toEqual(identities);
    expect(f.store.db.prepare('SELECT count(*) AS n FROM source_collisions').get()).toEqual({n:0});
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {mediaAttributeReads:number}).mediaAttributeReads)).toBe(0);f.noExternal();
  }finally{await f.close();}
});

test('hidden media does not turn a verified native text row into an unverified attachment',async()=>{
  const f=await setup();
  try{
    await f.owner.dm.evaluate(origin=>{
      const chat=document.querySelector('#chat') as HTMLElement,first=chat.querySelector('.box')!;
      for(const box of chat.querySelectorAll('.box'))if(box!==first)box.remove();
      const row=first.querySelector('.message')!,model=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
      model.serverId='8201';model.createdAt=new Date(origin+1000);model._parsedContent.text='controlled-1';
      const hidden=document.createElement('img');hidden.style.display='none';row.querySelector('.text')!.append(hidden);
      document.querySelector('#back')!.addEventListener('click',()=>{chat.hidden=true;});document.querySelector('.conversation')!.addEventListener('click',()=>{chat.hidden=false;});chat.hidden=true;
    },f.origin);
    await f.collector.collect('dm',f.signal);
    expect(f.store.events()).toHaveLength(1);expect(f.store.events()[0]).toMatchObject({status:'AWAITING_DRAFT',payload:{platformEventId:'8201',text:'controlled-1'}});
    expect(f.store.events()[0]!.payload.observationIssue).toBeUndefined();expect(f.lastRead()).toBeGreaterThan(0);f.noExternal();
  }finally{await f.close();}
});

test('nested foreign native media still fails exact conversation binding instead of becoming a successful parent attachment',async()=>{
  const f=await setup();
  try{
    await f.owner.dm.evaluate(origin=>{
      const chat=document.querySelector('#chat') as HTMLElement,first=chat.querySelector('.box')!;
      for(const box of chat.querySelectorAll('.box'))if(box!==first)box.remove();
      const row=first.querySelector('.message')!,model=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
      model.serverId='8301';model.createdAt=new Date(origin+1000);
      const nested=document.createElement('div');nested.className='message';nested.style.cssText='min-height:28px;width:40px';
      const image=document.createElement('img');image.style.cssText='width:24px;height:24px';nested.append(image);row.append(nested);
      Object.defineProperty(nested,'__reactProps$fixture',{value:{children:{props:{message:{serverId:'8302',conversationId:'foreign',sender:'200',
        createdAt:new Date(origin+1000),_parsedContent:{text:''}}}}}});
      document.querySelector('#back')!.addEventListener('click',()=>{chat.hidden=true;});document.querySelector('.conversation')!.addEventListener('click',()=>{chat.hidden=false;});chat.hidden=true;
    },f.origin);
    await expect(f.collector.collect('dm',f.signal)).rejects.toThrow('OBSERVATION_MESSAGE_CONVERSATION_CONFLICT');
    expect(f.store.events()).toEqual([]);expect(f.lastRead()).toBe(0);f.noExternal();
  }finally{await f.close();}
});

test.each([false,true])('missing native body waits for its own text instead of completing an empty read (empty mounted text: %s)',async emptyText=>{
  const f=await setup();
  try{
    await f.owner.dm.evaluate(({origin,emptyText})=>{
      const chat=document.querySelector('#chat') as HTMLElement,first=chat.querySelector('.box')!;
      for(const box of chat.querySelectorAll('.box'))if(box!==first)box.remove();
      const row=first.querySelector('.message') as HTMLElement;row.replaceChildren();row.style.cssText='min-height:28px;width:320px';
      if(emptyText){const body=document.createElement('span');body.className='text';row.append(body);}
      const model=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
      model.serverId='8401';model.createdAt=new Date(origin+1000);model._parsedContent.text='delayed native body';
      document.querySelector('#back')!.addEventListener('click',()=>{chat.hidden=true;});document.querySelector('.conversation')!.addEventListener('click',()=>{chat.hidden=false;});chat.hidden=true;
    },{origin:f.origin,emptyText});
    const collecting=f.collector.collect('dm',f.signal);
    await f.owner.dm.waitForFunction(()=>!(document.querySelector('#chat') as HTMLElement).hidden);
    await new Promise(resolve=>setTimeout(resolve,120));
    expect(f.store.events()).toEqual([]);expect(f.lastRead()).toBe(0);
    await f.owner.dm.evaluate(()=>{
      const row=document.querySelector('.message')!;let body=row.querySelector('.text');
      if(!body){body=document.createElement('span');body.className='text';row.append(body);}body.textContent='delayed native body';
    });
    await collecting;
    expect(f.store.events()).toHaveLength(1);expect(f.store.events()[0]).toMatchObject({status:'AWAITING_DRAFT',payload:{platformEventId:'8401',text:'delayed native body'}});
    expect(f.store.events()[0]!.payload.observationIssue).toBeUndefined();expect(f.lastRead()).toBeGreaterThan(0);f.noExternal();
  }finally{await f.close();}
});
