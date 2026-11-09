import { expect,test,vi } from 'vitest';
import { join } from 'node:path';
import { BrowserProfileOwner } from '../../src/browser/profile-owner.js';
import { InboxCollector } from '../../src/app/inbox-collector.js';
import { ObservedReader } from '../../src/adapters/observed-reader.js';
import { Blocked } from '../../src/core/contracts.js';
import { AutomationStore } from '../../src/storage/automation-store.js';
import { EventStore } from '../../src/storage/store.js';
import { migrateClient } from '../../src/storage/client-migration.js';
import { migrateAutomation } from '../../src/storage/automation-migration.js';
import { fixtureServer } from '../fixtures/site.js';
import { mountObserved,observedMapping } from '../fixtures/observed-site.js';
import { privateTemp } from '../helpers.js';

// Standard DOM overflow only; negative mode uses native Chromium column-reverse, never mocked geometry.
test.each([false,true])('fair two-window turns advance into original backlog during chronological appends (negative scroll: %s)',async negative=>{
  const server=await fixtureServer(),root=privateTemp('growing-backlog-proof-');
  const owner=await BrowserProfileOwner.launch(join(root,'profile'),true),store=new EventStore(join(root,'poc.sqlite'),true);
  let collector:InboxCollector|undefined,now=Date.now();const origin=now-60_000;
  try{
    await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
    const data=new AutomationStore(store,()=>now);data.initialize(origin);store.bindAccount('100');
    data.configureCollection({ownId:'100',comments:false,inbox:true,commentIntervalMs:30000,dmIntervalMs:15000});
    await mountObserved(owner,server.origin);
    const geometry=await owner.dm.evaluate(({origin,negative})=>{
      const chat=document.querySelector('#chat') as HTMLElement,header=Object.getOwnPropertyDescriptor(document.querySelector('#header')!,'__reactProps$fixture')!.value.children.props.conversation;
      for(const box of chat.querySelectorAll('.box'))box.remove();
      const list=document.createElement('div');list.id='chronological-list';list.style.cssText='height:144px;width:360px;overflow-y:auto;position:relative';
      if(negative){list.style.display='flex';list.style.flexDirection='column-reverse';}
      const space=document.createElement('div');space.id='chronological-space';
      space.style.flexShrink='0';
      const viewport=document.createElement('div');viewport.style.cssText='position:sticky;top:0;height:144px';space.append(viewport);list.append(space);chat.append(list);
      if(negative)viewport.style.bottom='0';
      const state=window as unknown as {active:string;items:{id:string;at:number}[];append:()=>void};state.active='conv-a';
      state.items=Array.from({length:24},(_,index)=>({id:String(5001+index),at:origin+(index+1)*1000}));
      const mount=()=>{
        const normalized=negative?list.scrollTop+list.scrollHeight-list.clientHeight:list.scrollTop;
        const first=state.active==='conv-a'?Math.min(state.items.length-3,Math.max(0,Math.floor(normalized/48))):0;
        const items=state.active==='conv-a'?state.items.slice(first,first+3):[{id:'6000',at:origin+1000}];
        viewport.replaceChildren(...items.map(item=>{
          const box=document.createElement('div');box.className='box';box.style.height='48px';
          const row=document.createElement('div');row.className='message';const body=document.createElement('span');body.className='text';body.textContent='chronological '+item.id;
          row.append(body);box.append(row);Object.defineProperty(row,'__reactProps$fixture',{value:{children:{props:{message:{serverId:item.id,conversationId:state.active,
            sender:state.active==='conv-a'?'200':'300',createdAt:new Date(item.at),_parsedContent:{text:body.textContent}}}}}});return box;
        }));
      };
      state.append=()=>{
        const index=state.items.length;state.items.push({id:String(5001+index),at:origin+(index+1)*1000});
        if(state.active==='conv-a'&&!chat.hidden){space.style.height=(state.items.length*48)+'px';mount();}
      };
      list.addEventListener('scroll',()=>requestAnimationFrame(mount));
      const show=(id:string)=>{
        state.active=id;header.id=id;header._toParticipantSecUserId=id==='conv-a'?'peer-sec':'b-sec';
        document.querySelector('#chat-title')!.textContent=id==='conv-a'?'Fixture peer':'Peer B';
        chat.hidden=false;space.style.height=id==='conv-a'?(state.items.length*48)+'px':'144px';
        list.scrollTop=negative?0:list.scrollHeight-list.clientHeight;mount();
      };
      document.querySelector('.conversation')!.addEventListener('click',()=>show('conv-a'));
      const b=document.createElement('div');b.className='conversation';b.innerHTML='<span class="title">Peer B</span>';
      Object.defineProperty(b,'__reactFiber$fixture',{value:{return:{memoizedProps:{conversation:{id:'conv-b',_toParticipantSecUserId:'b-sec'}}}}});
      b.addEventListener('click',()=>show('conv-b'));document.querySelector('#dm-panel')!.prepend(b);
      document.querySelector('#back')!.addEventListener('click',()=>{chat.hidden=true;});show('conv-a');
      list.scrollTop=-20;
      const proof={top:list.scrollTop,range:list.scrollHeight-list.clientHeight};
      list.scrollTop=negative?0:list.scrollHeight-list.clientHeight;mount();return proof;
    },{origin,negative});
    expect(geometry.range).toBe(21*48);if(negative)expect(geometry.top).toBeLessThan(0);
    collector=new InboxCollector(owner,observedMapping(server.origin),data,root,'headless');
    const signal=new AbortController().signal;
    for(let turn=0;turn<16;turn++){
      if(turn>0)await owner.dm.evaluate(()=>(window as unknown as {append:()=>void}).append());
      await collector.collect('dm',signal);now+=15000;
      if(turn===4){collector.dispose();collector=new InboxCollector(owner,observedMapping(server.origin),new AutomationStore(store,()=>now),root,'headless');}
    }
    const ids=store.events().map(event=>event.payload.platformEventId!);
    expect(ids).toContain('6000');expect(data.state().startedAt).toBe(origin);
    expect(store.db.prepare('SELECT kind,used FROM budgets ORDER BY kind').all()).toEqual([{kind:'MODEL',used:0},{kind:'SEND',used:0}]);
    expect(store.db.prepare('SELECT count(*) AS n FROM model_calls').get()).toEqual({n:0});expect(store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('5018');
    const original=Array.from({length:24},(_,index)=>String(5001+index));
    expect(original.filter(id=>ids.includes(id))).toEqual(original);
  }finally{collector?.dispose();store.close();await owner.close();await server.close();}
});

interface Anchor {top:number;height:number;ids:string[]}
interface Sweep {peer:{conversationId:string};top:number;anchor:Anchor;[key:string]:unknown}
interface Cursor {sweep?:Sweep;parked:Sweep[];deferred:{id:string;until:number;code:string}[];burst:number}
const aCheckpoint=(cursor:Cursor)=>[...cursor.parked,...(cursor.sweep?[cursor.sweep]:[])].find(sweep=>sweep.peer.conversationId==='conv-a');

async function anchoredPeer(){
  const server=await fixtureServer(),root=privateTemp('dm-anchor-interruption-');
  const owner=await BrowserProfileOwner.launch(join(root,'profile'),true),store=new EventStore(join(root,'poc.sqlite'),true);
  let now=Date.now();const origin=now-60_000;
  await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  const data=new AutomationStore(store,()=>now);data.initialize(origin);store.bindAccount('100');
  data.configureCollection({ownId:'100',comments:false,inbox:true,commentIntervalMs:30000,dmIntervalMs:15000});
  await mountObserved(owner,server.origin);
  await owner.dm.evaluate(origin=>{
    const chat=document.querySelector('#chat') as HTMLElement;
    const header=Object.getOwnPropertyDescriptor(document.querySelector('#header')!,'__reactProps$fixture')!.value.children.props.conversation;
    for(const box of chat.querySelectorAll('.box'))box.remove();
    const list=document.createElement('div');list.id='anchor-list';list.style.cssText='height:144px;width:360px;overflow-y:auto;position:relative';
    const space=document.createElement('div');space.style.height='1152px';
    const viewport=document.createElement('div');viewport.style.cssText='position:sticky;top:0;height:144px';space.append(viewport);list.append(space);chat.append(list);
    const state=window as unknown as {missing:boolean;wrongPeer:boolean;mount:()=>void};state.missing=false;state.wrongPeer=false;
    state.mount=()=>{
      const first=Math.min(21,Math.max(0,Math.floor(list.scrollTop/48)));
      viewport.replaceChildren(...Array.from({length:3},(_,position)=>{
        const index=first+position,id=String((state.missing?9001:7001)+index),box=document.createElement('div');box.className='box';box.style.height='48px';
        const row=document.createElement('div');row.className='message';const text=document.createElement('span');text.className='text';text.textContent='anchor native '+id;
        row.append(text);box.append(row);Object.defineProperty(row,'__reactProps$fixture',{value:{children:{props:{message:{serverId:id,
          conversationId:state.wrongPeer?'outside':'conv-a',sender:'200',createdAt:new Date(origin+(index+1)*1000),_parsedContent:{text:text.textContent}}}}}});return box;
      }));
    };
    list.addEventListener('scroll',()=>requestAnimationFrame(state.mount));
    document.querySelector('.conversation')!.addEventListener('click',()=>{
      chat.hidden=false;header.id=state.wrongPeer?'outside':'conv-a';header._toParticipantSecUserId=state.wrongPeer?'outside-sec':'peer-sec';
      list.scrollTop=list.scrollHeight-list.clientHeight;state.mount();
    });
    document.querySelector('#back')!.addEventListener('click',()=>{chat.hidden=true;});chat.hidden=true;
  },origin);
  const mapping=observedMapping(server.origin),signal=new AbortController().signal;
  let collector=new InboxCollector(owner,mapping,data,root,'headless');
  const cursor=()=>JSON.parse((store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='dm'").get() as {cursor_json:string}).cursor_json) as Cursor;
  return {owner,store,data,origin,mapping,signal,get collector(){return collector;},cursor,
    lastRead:()=>(store.db.prepare("SELECT last_read FROM discovered_conversations WHERE id='conv-a'").get() as {last_read:number}).last_read,
    reopen:async(missing=false,wrongPeer=false)=>owner.dm.evaluate(({missing,wrongPeer})=>{
      const state=window as unknown as {missing:boolean;wrongPeer:boolean};state.missing=missing;state.wrongPeer=wrongPeer;
      (document.querySelector('.conversation') as HTMLElement).click();
    },{missing,wrongPeer}),
    recover:()=>{now+=120001;collector.dispose();collector=new InboxCollector(owner,mapping,new AutomationStore(store,()=>now),root,'headless');},
    noExternal:()=>{
      expect(data.state().startedAt).toBe(origin);expect(store.db.prepare('SELECT kind,used FROM budgets ORDER BY kind').all()).toEqual([{kind:'MODEL',used:0},{kind:'SEND',used:0}]);
      expect(store.db.prepare('SELECT count(*) AS n FROM model_calls').get()).toEqual({n:0});expect(store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
      expect(new Set(store.events().map(event=>event.payload.platformEventId)).size).toBe(store.events().length);
    },
    close:async()=>{collector.dispose();store.close();await owner.close();await server.close();}};
}

test.each(['missing','wrong-peer'])('an unavailable anchor (%s) retains its original checkpoint and successful watermark until scoped recovery',async action=>{
  const f=await anchoredPeer();
  try{
    await f.collector.collect('dm',f.signal);const saved=aCheckpoint(f.cursor())!;
    expect(saved.anchor.ids).toEqual(['7022','7023','7024']);expect(f.lastRead()).toBe(0);
    await f.reopen(action==='missing',action==='wrong-peer');
    const code=action==='missing'?'OBSERVATION_DM_ANCHOR_NOT_FOUND':'OBSERVATION_CONVERSATION_CHANGED';
    await expect(f.collector.collect('dm',f.signal)).rejects.toThrow(code);
    expect(aCheckpoint(f.cursor())).toEqual(saved);expect(f.lastRead()).toBe(0);expect(f.cursor().deferred.map(item=>item.code)).toEqual([code]);
    expect(f.store.events().every(event=>event.payload.conversationId==='conv-a')).toBe(true);
    f.recover();await f.reopen();await f.collector.collect('dm',f.signal);
    expect(aCheckpoint(f.cursor())!.top).toBeLessThan(saved.top);expect(f.lastRead()).toBe(0);expect(f.cursor().deferred).toEqual([]);
    expect(f.store.events().some(event=>event.payload.platformEventId==='7019')).toBe(true);f.noExternal();
  }finally{await f.close();}
});

test.each(['scroll','capture'])('a failure advancing after a verified native anchor (%s) preserves and resumes its checkpoint',async action=>{
  const f=await anchoredPeer();
  try{
    await f.collector.collect('dm',f.signal);const saved=aCheckpoint(f.cursor())!;await f.reopen();
    const matched=await new ObservedReader(f.owner.dm,f.mapping).dmWindow(f.mapping.peers[0]!);
    expect(matched.events.map(event=>event.platformEventId)).toEqual(saved.anchor.ids);
    const original=ObservedReader.prototype.scrollDm;let boundaries=0;
    const fault=vi.spyOn(ObservedReader.prototype,'scrollDm').mockImplementation(async function(this:ObservedReader,peer,top){
      boundaries++;
      if(action==='scroll')throw new Blocked('OBSERVATION_SCROLL_INTERRUPTED');
      await original.call(this,peer,top);
      await this.page.evaluate(()=>{
        const row=document.querySelector('.message')!;
        Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message.conversationId='outside';
      });
    });
    const code=action==='scroll'?'OBSERVATION_SCROLL_INTERRUPTED':'OBSERVATION_MESSAGE_CONVERSATION_CONFLICT';
    try{await expect(f.collector.collect('dm',f.signal)).rejects.toThrow(code);}finally{fault.mockRestore();}
    expect(boundaries).toBe(1);expect(aCheckpoint(f.cursor())).toEqual(saved);expect(f.lastRead()).toBe(0);
    expect(f.cursor().deferred.map(item=>item.code)).toEqual([code]);
    expect(f.store.events().map(event=>event.payload.platformEventId)).toEqual(saved.anchor.ids);
    f.recover();await f.reopen();await f.collector.collect('dm',f.signal);
    expect(aCheckpoint(f.cursor())!.top).toBeLessThan(saved.top);expect(f.lastRead()).toBe(0);expect(f.cursor().deferred).toEqual([]);
    expect(f.store.events().some(event=>event.payload.platformEventId==='7019')).toBe(true);f.noExternal();
  }finally{await f.close();}
});
