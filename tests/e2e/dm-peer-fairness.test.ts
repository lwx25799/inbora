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

test('a continually growing native peer yields to another already visible readable peer before finishing its entire backlog',async()=>{
  const server=await fixtureServer(),root=privateTemp('growing-dm-peer-proof-');
  const owner=await BrowserProfileOwner.launch(join(root,'profile'),true),store=new EventStore(join(root,'poc.sqlite'),true);
  let collector:InboxCollector|undefined,now=Date.now();const origin=now-60_000;
  try{
    await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
    const data=new AutomationStore(store,()=>now);data.initialize(origin);store.bindAccount('100');
    data.configureCollection({ownId:'100',comments:false,inbox:true,commentIntervalMs:30000,dmIntervalMs:15000});
    await mountObserved(owner,server.origin);
    await owner.dm.evaluate(()=>{
      const chat=document.querySelector('#chat') as HTMLElement;
      const header=Object.getOwnPropertyDescriptor(document.querySelector('#header')!,'__reactProps$fixture')!.value.children.props.conversation;
      for(const box of chat.querySelectorAll('.box'))box.remove();
      const list=document.createElement('div');list.id='growing-list';list.style.cssText='height:144px;width:360px;overflow-y:auto;position:relative';
      const space=document.createElement('div');space.id='growing-space';space.style.height='600px';
      const viewport=document.createElement('div');viewport.id='growing-viewport';viewport.style.cssText='position:sticky;top:0';
      space.append(viewport);list.append(space);chat.append(list);
      const state=window as unknown as {busyCount:number;laterOpens:number;activeConversation:string;busyItems:{id:string;text:string;at:number}[]};
      state.busyCount=0;state.laterOpens=0;state.activeConversation='conv-a';
      state.busyItems=[{id:'1000',text:'busy initial',at:Date.now()-1000}];
      const row=document.querySelector('.conversation')!;
      const later=document.createElement('div');later.className='conversation';later.innerHTML='<span class="title">Later readable peer</span>';
      Object.defineProperty(later,'__reactFiber$fixture',{value:{return:{memoizedProps:{conversation:{id:'z-later',_toParticipantSecUserId:'later-sec'}}}}});
      document.querySelector('#dm-panel')!.prepend(later);
      const show=(id:string)=>{
        state.activeConversation=id;header.id=id;header._toParticipantSecUserId=id==='conv-a'?'peer-sec':'later-sec';
        document.querySelector('#chat-title')!.textContent=id==='conv-a'?'Fixture peer':'Later readable peer';
        chat.hidden=false;viewport.replaceChildren();space.style.height=id==='conv-a'?(600+state.busyCount*100)+'px':'28px';
        const items=id==='conv-a'?state.busyItems:[{id:'2000',text:'later bounded input',at:Date.now()-1000}];
        for(const item of items){
          const box=document.createElement('div');box.className='box';box.style.height='28px';
          const message=document.createElement('div');message.className='message';
          const text=document.createElement('span');text.className='text';text.textContent=item.text;
          message.append(text);box.append(message);viewport.append(box);
          Object.defineProperty(message,'__reactProps$fixture',{value:{children:{props:{message:{serverId:item.id,conversationId:id,
            sender:id==='conv-a'?'200':'300',createdAt:new Date(item.at),_parsedContent:{text:text.textContent}}}}}});
        }
        list.scrollTop=list.scrollHeight-list.clientHeight;
      };
      row.addEventListener('click',()=>show('conv-a'));
      later.addEventListener('click',()=>{state.laterOpens++;show('z-later');});
      document.querySelector('#back')!.addEventListener('click',()=>{chat.hidden=true;});show('conv-a');
    });
    const mapping=observedMapping(server.origin),signal=new AbortController().signal;
    const control=await new ObservedReader(owner.dm,mapping).dmWindow({uid:null,secUid:'later-sec',conversationId:'z-later',title:'Later readable peer'});
    expect(control.events.map(event=>event.platformEventId)).toEqual(['2000']);
    expect(control.dmViewport).toBeUndefined();
    await owner.dm.evaluate(()=>(document.querySelector('.conversation:not(:first-child)') as HTMLElement).click());
    collector=new InboxCollector(owner,mapping,data,root,'headless');const heights:number[]=[];
    for(let turn=0;turn<10;turn++){
      if(turn>0){const growth=await owner.dm.evaluate(()=>{
        const state=window as unknown as {busyCount:number;activeConversation:string;busyItems:{id:string;text:string;at:number}[]};
        state.busyCount++;
        const item={id:String(1000+state.busyCount),text:'busy native '+state.busyCount,at:Date.now()-500};state.busyItems.push(item);
        if(state.activeConversation!=='conv-a'||(document.querySelector('#chat') as HTMLElement).hidden)return null;
        const list=document.querySelector('#growing-list')!,before=list.scrollHeight,viewport=document.querySelector('#growing-viewport')!;
        const box=document.createElement('div');box.className='box';box.style.height='28px';
        const row=document.createElement('div');row.className='message';const text=document.createElement('span');text.className='text';text.textContent=item.text;
        row.append(text);box.append(row);viewport.append(box);
        Object.defineProperty(row,'__reactProps$fixture',{value:{children:{props:{message:{serverId:item.id,conversationId:'conv-a',sender:'200',
          createdAt:new Date(item.at),_parsedContent:{text:text.textContent}}}}}});
        (document.querySelector('#growing-space') as HTMLElement).style.height=(600+state.busyCount*100)+'px';
        return {before,after:list.scrollHeight};
      });if(growth){expect(growth.after).toBeGreaterThan(growth.before);heights.push(growth.after);}}
      await collector.collect('dm',signal);now+=15000;
      if(turn===3){collector.dispose();collector=new InboxCollector(owner,mapping,new AutomationStore(store,()=>now),root,'headless');}
    }
    expect(heights.every((height,index)=>index===0||height>heights[index-1]!)).toBe(true);
    expect(data.state().startedAt).toBe(origin);
    expect(store.db.prepare('SELECT kind,used FROM budgets ORDER BY kind').all()).toEqual([{kind:'MODEL',used:0},{kind:'SEND',used:0}]);
    expect(store.db.prepare('SELECT count(*) AS n FROM model_calls').get()).toEqual({n:0});
    expect(store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
    expect(store.db.prepare("SELECT own_id,uid,sec_uid,last_read FROM discovered_conversations WHERE id='conv-a'").get())
      .toEqual({own_id:'100',uid:'200',sec_uid:'peer-sec',last_read:0});
    expect(store.db.prepare("SELECT own_id,sec_uid FROM discovered_conversations WHERE id='z-later'").get()).toEqual({own_id:'100',sec_uid:'later-sec'});
    expect((store.db.prepare("SELECT last_read FROM discovered_conversations WHERE id='z-later'").get() as {last_read:number}).last_read).toBeGreaterThan(0);
    expect(store.events().some(event=>event.payload.platformEventId==='2000')).toBe(true);
    // Stop growth and allow the parked large continuation to finish without losing its native IDs.
    let finished=false;
    for(let turn=0;turn<40;turn++){
      await collector.collect('dm',signal);now+=15000;
      const reads=store.db.prepare('SELECT last_read FROM discovered_conversations').all() as {last_read:number}[];
      if(reads.every(peer=>peer.last_read>0)){finished=true;break;}
    }
    expect(finished).toBe(true);
    expect(store.events().filter(event=>event.payload.conversationId==='conv-a').map(event=>event.payload.platformEventId).sort())
      .toEqual(Array.from({length:10},(_,index)=>String(1000+index)).sort());
    expect(new Set(store.events().map(event=>event.payload.platformEventId)).size).toBe(store.events().length);
    expect(data.state().startedAt).toBe(origin);
    expect(store.db.prepare('SELECT kind,used FROM budgets ORDER BY kind').all()).toEqual([{kind:'MODEL',used:0},{kind:'SEND',used:0}]);
  }finally{collector?.dispose();store.close();await owner.close();await server.close();}
});

interface Checkpoint {peer:{conversationId:string};top:number;phase:string;[key:string]:unknown}
interface Progress {sweep?:Checkpoint;parked?:Checkpoint[];recent?:string[];burst?:number;deferred:{id:string;until:number;code:string}[]}
const checkpoint=(progress:Progress,id:string)=>[...(progress.parked??[]),...(progress.sweep?[progress.sweep]:[])].find(item=>item.peer.conversationId===id);

async function twoPeers(listWindow=false,bLong=true){
  const server=await fixtureServer(),root=privateTemp('dm-peer-composition-');
  const owner=await BrowserProfileOwner.launch(join(root,'profile'),true),store=new EventStore(join(root,'poc.sqlite'),true);
  let now=Date.now();const origin=now-60_000;
  await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  let data=new AutomationStore(store,()=>now);data.initialize(origin);store.bindAccount('100');
  data.configureCollection({ownId:'100',comments:false,inbox:true,commentIntervalMs:30000,dmIntervalMs:15000});
  await mountObserved(owner,server.origin);
  await owner.dm.evaluate(({origin,listWindow,bLong})=>{
    const chat=document.querySelector('#chat') as HTMLElement,panel=document.querySelector('#dm-panel')!;
    const header=Object.getOwnPropertyDescriptor(document.querySelector('#header')!,'__reactProps$fixture')!.value.children.props.conversation;
    for(const node of chat.querySelectorAll('.box'))node.remove();
    const list=document.createElement('div');list.id='peer-messages';list.style.cssText='height:144px;width:360px;overflow-y:auto;position:relative';
    const space=document.createElement('div');const viewport=document.createElement('div');viewport.style.cssText='position:sticky;top:0;height:96px';
    space.append(viewport);list.append(space);chat.append(list);
    const state=window as unknown as {active:string;backFailure:boolean;backs:number;listScrolls:number};
    state.active='conv-a';state.backFailure=false;state.backs=0;state.listScrolls=0;
    const a=document.querySelector('.conversation')!,b=document.createElement('div');b.className='conversation';b.innerHTML='<span class="title">Peer B</span>';
    Object.defineProperty(b,'__reactFiber$fixture',{value:{return:{memoizedProps:{conversation:{id:'conv-b',_toParticipantSecUserId:'b-sec'}}}}});
    const mount=(old:boolean)=>{
      const base=state.active==='conv-a'?3000:4000;
      const messages=old?[{id:base,at:origin-10000},{id:base+1,at:origin+1000}]:[{id:base+2,at:origin+2000},{id:base+3,at:origin+3000}];
      viewport.replaceChildren(...messages.map(item=>{
        const box=document.createElement('div');box.className='box';box.style.height='28px';
        const row=document.createElement('div');row.className='message';const body=document.createElement('span');body.className='text';body.textContent='native '+item.id;
        row.append(body);box.append(row);
        Object.defineProperty(row,'__reactProps$fixture',{value:{children:{props:{message:{serverId:String(item.id),conversationId:state.active,
          sender:state.active==='conv-a'?'200':'300',createdAt:new Date(item.at),_parsedContent:{text:body.textContent}}}}}});return box;
      }));
    };
    const show=(id:string)=>{
      state.active=id;header.id=id;header._toParticipantSecUserId=id==='conv-a'?'peer-sec':'b-sec';
      document.querySelector('#chat-title')!.textContent=id==='conv-a'?'Fixture peer':'Peer B';chat.hidden=false;
      space.style.height=id==='conv-a'||bLong?'600px':'96px';mount(false);list.scrollTop=list.scrollHeight-list.clientHeight;
    };
    a.addEventListener('click',()=>show('conv-a'));b.addEventListener('click',()=>show('conv-b'));
    list.addEventListener('scroll',()=>requestAnimationFrame(()=>mount(list.scrollTop<=list.clientHeight)));
    document.querySelector('#back')!.addEventListener('click',()=>{state.backs++;if(!state.backFailure)chat.hidden=true;});chat.hidden=true;
    if(listWindow){
      a.remove();const contacts=document.createElement('div');contacts.id='peer-contact-list';contacts.style.cssText='height:80px;width:360px;overflow-y:auto';
      const fill=document.createElement('div');fill.style.height='500px';const windowRows=document.createElement('div');windowRows.style.cssText='position:sticky;top:0';
      windowRows.append(a);fill.append(windowRows);contacts.append(fill);panel.prepend(contacts);
      contacts.addEventListener('scroll',()=>{state.listScrolls++;windowRows.replaceChildren(contacts.scrollTop>10?b:a);});
    }else panel.prepend(b);
  },{origin,listWindow,bLong});
  const mapping=observedMapping(server.origin);if(listWindow)mapping.selectors.conversationList='#peer-contact-list';
  let collector=new InboxCollector(owner,mapping,data,root,'headless');
  const f={owner,store,origin,mapping,signal:new AbortController().signal,
    get collector(){return collector;},get data(){return data;},
    cursor:()=>JSON.parse((store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='dm'").get() as {cursor_json:string}).cursor_json) as Progress,
    lastRead:(id:string)=>(store.db.prepare('SELECT last_read FROM discovered_conversations WHERE id=?').get(id) as {last_read:number}|undefined)?.last_read??0,
    advance:(ms=15000)=>{now+=ms;},
    restart:()=>{collector.dispose();data=new AutomationStore(store,()=>now);data.initialize(now);collector=new InboxCollector(owner,mapping,data,root,'headless');},
    close:async()=>{collector.dispose();store.close();await owner.close();await server.close();}};
  return f;
}

function noExternalCalls(f:Awaited<ReturnType<typeof twoPeers>>):void{
  expect(f.data.state().startedAt).toBe(f.origin);
  expect(f.store.db.prepare('SELECT kind,used FROM budgets ORDER BY kind').all()).toEqual([{kind:'MODEL',used:0},{kind:'SEND',used:0}]);
  expect(f.store.db.prepare('SELECT count(*) AS n FROM model_calls').get()).toEqual({n:0});
  expect(f.store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
  expect(new Set(f.store.events().map(event=>event.payload.platformEventId)).size).toBe(f.store.events().length);
}

test('two-window quantum discovers a readable peer in the next native contact-list window and keeps the first checkpoint',async()=>{
  const f=await twoPeers(true,false);
  try{
    await f.collector.collect('dm',f.signal);expect(f.cursor().burst).toBe(1);expect(f.lastRead('conv-a')).toBe(0);
    f.restart();await f.collector.collect('dm',f.signal);
    expect(f.cursor().sweep).toBeUndefined();expect(checkpoint(f.cursor(),'conv-a')).toBeDefined();expect(f.lastRead('conv-a')).toBe(0);
    await f.owner.dm.waitForFunction(()=>document.querySelector('.conversation .title')?.textContent==='Peer B');
    f.advance();await f.collector.collect('dm',f.signal);
    expect(f.lastRead('conv-b')).toBeGreaterThan(0);
    expect(f.store.events().some(event=>event.payload.platformEventId==='4002')).toBe(true);
    expect(checkpoint(f.cursor(),'conv-a')).toBeDefined();
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {listScrolls:number}).listScrolls)).toBeGreaterThan(0);
    noExternalCalls(f);
  }finally{await f.close();}
});

test('failed A cooling down and unfinished B retain independent checkpoints through A recovery and restart',async()=>{
  const f=await twoPeers();
  try{
    await f.collector.collect('dm',f.signal);const a=checkpoint(f.cursor(),'conv-a');expect(a).toBeDefined();
    const fail=vi.spyOn(ObservedReader.prototype,'dmWindow').mockRejectedValueOnce(new Blocked('OBSERVATION_DOM_NOT_READY'));
    try{await expect(f.collector.collect('dm',f.signal)).rejects.toThrow('OBSERVATION_DOM_NOT_READY');}finally{fail.mockRestore();}
    expect(checkpoint(f.cursor(),'conv-a')).toEqual(a);expect(f.cursor().deferred.map(item=>item.id)).toEqual(['conv-a']);
    f.restart();await f.collector.collect('dm',f.signal);
    const b=checkpoint(f.cursor(),'conv-b');expect(b).toBeDefined();expect(checkpoint(f.cursor(),'conv-a')).toEqual(a);
    f.advance(120001);f.restart();await f.collector.collect('dm',f.signal);
    expect(checkpoint(f.cursor(),'conv-a')).toEqual(a);expect(checkpoint(f.cursor(),'conv-b')).toBeDefined();
    const bParked=checkpoint(f.cursor(),'conv-b');
    await f.collector.collect('dm',f.signal);
    expect(f.cursor().sweep?.peer.conversationId).toBe('conv-a');
    expect(checkpoint(f.cursor(),'conv-b')).toEqual(bParked);expect(f.cursor().deferred).toEqual([]);
    expect(f.lastRead('conv-a')).toBe(0);expect(f.lastRead('conv-b')).toBe(0);
    const ids=[...(f.cursor().parked??[]),...(f.cursor().sweep?[f.cursor().sweep!]:[])].map(item=>item.peer.conversationId);
    expect(new Set(ids).size).toBe(ids.length);expect(new Set(f.cursor().recent).size).toBe(f.cursor().recent?.length);
    noExternalCalls(f);
  }finally{await f.close();}
});

test.each(['back-failure','cancel'])('quantum checkpoint survives %s during return to the list without a false successful read',async action=>{
  const f=await twoPeers();
  try{
    await f.collector.collect('dm',f.signal);const first=checkpoint(f.cursor(),'conv-a');expect(first).toBeDefined();
    const abort=new AbortController();let capture:ReturnType<typeof vi.spyOn>|undefined;
    if(action==='back-failure'){
      f.owner.context.setDefaultTimeout(100);
      await f.owner.dm.evaluate(()=>(window as unknown as {backFailure:boolean}).backFailure=true);
      await expect(f.collector.collect('dm',abort.signal)).rejects.toThrow('OBSERVATION_DM_BACK_DOM_NOT_READY');
    }else{
      const read=ObservedReader.prototype.conversations;
      capture=vi.spyOn(ObservedReader.prototype,'conversations').mockImplementation(async function(this:ObservedReader,scroll){
        if(scroll==='next'){abort.abort();throw new Blocked('COLLECTION_CANCELLED');}
        return read.call(this,scroll);
      });
      try{await expect(f.collector.collect('dm',abort.signal)).rejects.toThrow('COLLECTION_CANCELLED');}finally{capture.mockRestore();}
    }
    const saved=f.cursor();expect(saved.sweep).toBeUndefined();expect(saved.burst).toBe(0);
    expect(saved.parked?.map(item=>item.peer.conversationId)).toEqual(['conv-a']);
    expect(saved.parked![0]!.top).toBeLessThan(first!.top);expect(f.lastRead('conv-a')).toBe(0);expect(saved.deferred).toEqual([]);
    f.restart();await f.owner.dm.evaluate(()=>(window as unknown as {backFailure:boolean}).backFailure=false);
    await f.collector.collect('dm',f.signal);
    expect(f.cursor().sweep?.peer.conversationId).toBe('conv-b');expect(checkpoint(f.cursor(),'conv-a')).toEqual(saved.parked![0]);
    noExternalCalls(f);
  }finally{await f.close();}
});

test('legacy single sweep resumes at its checkpoint with default burst and gains fair parked state across restart',async()=>{
  const f=await twoPeers();
  try{
    await f.collector.collect('dm',f.signal);const legacy=f.cursor().sweep!;
    f.store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='dm'").run(JSON.stringify({deferred:[],sweep:legacy}));
    f.restart();await f.collector.collect('dm',f.signal);
    expect(f.cursor().sweep?.peer.conversationId).toBe('conv-a');expect(f.cursor().sweep!.top).toBeLessThan(legacy.top);
    expect(f.cursor().burst).toBe(1);expect(f.cursor().recent).toEqual(['conv-a']);expect(f.lastRead('conv-a')).toBe(0);
    f.restart();await f.collector.collect('dm',f.signal);
    expect(f.cursor().sweep).toBeUndefined();expect(checkpoint(f.cursor(),'conv-a')).toBeDefined();
    // Legacy cursors have no rotation history: newly observed peers join the FIFO after its restored active peer.
    let bResumed=false;
    for(let turn=0;turn<3;turn++){
      await f.collector.collect('dm',f.signal);
      if(f.cursor().sweep?.peer.conversationId==='conv-b'){bResumed=true;break;}
      expect(checkpoint(f.cursor(),'conv-a')).toBeDefined();expect(f.lastRead('conv-a')).toBe(0);
    }
    expect(bResumed).toBe(true);expect(checkpoint(f.cursor(),'conv-a')).toBeDefined();
    noExternalCalls(f);
  }finally{await f.close();}
});
