import {expect,test,vi} from 'vitest';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {ObservedDmReply,captureDmReply,type DmContextChange} from '../../src/adapters/observed-dm-reply.js';
import {digest} from '../../src/core/contracts.js';
import {SendCoordinator} from '../../src/core/send-coordinator.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountDmReply,dmReplyMapping} from '../fixtures/observed-site.js';
import {database,privateTemp} from '../helpers.js';

test.each(['COMPLETE','SYNC_COMPLETE','LATE_CHANGE','LOST_OWNER'] as const)('own editor expansion keeps the exact target/latest and validates the final native gate: %s',async fault=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp('dm-context-viewport-'),'profile'),true),store=database();
  const reports:DmContextChange[]=[];let adapter:ObservedDmReply|undefined;
  try{
    await mountDmReply(owner,server.origin);const mapping=dmReplyMapping(server.origin);
    await owner.dm.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>{
      for(const row of document.querySelectorAll('.message')){
        const native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
        if(Number(native.serverId)<=5)native.createdAt=new Date(Date.UTC(2026,10,5,0,0,Number(native.serverId)-1));
      }
    }));
    await owner.dm.evaluate(fault=>{
      const chat=document.querySelector('#chat')!,viewport=document.createElement('div');viewport.id='synthetic-message-viewport';
      viewport.style.cssText='height:150px;overflow:auto';chat.insertBefore(viewport,document.querySelector('#native-controls'));
      const boxes=Array.from(chat.querySelectorAll<HTMLElement>('.box'));
      for(const [index,box]of boxes.entries()){
        box.dataset.index=String(boxes.length-1-index);box.style.height='30px';viewport.append(box);
        const native=Object.getOwnPropertyDescriptor(box.querySelector('.message')!,'__reactProps$fixture')!.value.children.props.message;
        native.createdAt=new Date(Date.UTC(2026,10,5,0,0,index));
      }
      document.querySelector('#native-editor')!.addEventListener('input',()=>{
        (document.querySelector('#native-editor') as HTMLElement).style.height='60px';viewport.style.height='120px';
        if(fault==='SYNC_COMPLETE')boxes[0]!.remove();else queueMicrotask(()=>boxes[0]!.remove());
      },{once:true});
    },fault);
    const batch=await new ObservedReader(owner.dm,mapping.observation).dm(0);
    store.observe('DIRECT_MESSAGE','conv-a',[],'100','synthetic');store.observe('DIRECT_MESSAGE','conv-a',batch.events,'100','synthetic');
    const event=store.events().find(item=>item.payload.platformEventId==='3')!,draft=store.saveDraft(event.id,'synthetic outgoing reply that expands the editor','mock');
    adapter=new ObservedDmReply(owner.dm,mapping,250,{onContextChanged:report=>reports.push(report)});
    const approved=await adapter.inspect(event.payload);store.approve(draft.id,approved,draft.version,draft.text);
    const verify=adapter.verifyPrepared.bind(adapter);let rawReads=0;
    vi.spyOn(adapter,'verifyPrepared').mockImplementation(async(event,text)=>{
      const snapshot=await verify(event,text),input:Parameters<typeof captureDmReply>[0]={mapping,event,action:'proofs',text:null,token:null,before:null,editorShape:null};
      const raw=await owner.dm.evaluate(captureDmReply,input);
      expect(snapshot).toEqual(approved);expect(raw.context).toHaveLength(4);expect(digest(raw.context)).not.toBe(snapshot.contextDigest);rawReads++;return snapshot;
    });
    const click=adapter.clickOnce.bind(adapter);
    if(fault==='LATE_CHANGE'||fault==='LOST_OWNER')vi.spyOn(adapter,'clickOnce').mockImplementation(async boundary=>{
      await owner.dm.evaluate(fault=>{
        if(fault==='LOST_OWNER')delete (window as unknown as {__inboraDmPreparation?:unknown}).__inboraDmPreparation;
        else{const row=document.querySelector('.message')!,native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
          native._parsedContent.text='new retained context';row.querySelector('.text')!.textContent=native._parsedContent.text;}
      },fault);await click(boundary);
    });
    const result=await new SendCoordinator(store,owner.actor).send(draft.id,adapter,false);
    const complete=fault==='COMPLETE'||fault==='SYNC_COMPLETE';expect(result).toBe(complete?'CONFIRMED':'UNCERTAIN');expect(rawReads).toBe(2);
    expect(await owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(complete?1:0);
    expect(store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:1});
    if(!complete)await expect(new SendCoordinator(store,owner.actor).send(draft.id,adapter,false)).rejects.toThrow();
    expect(store.db.prepare('SELECT kind,used FROM budgets ORDER BY kind').all()).toEqual([{kind:'MODEL',used:0},{kind:'SEND',used:0}]);
  }finally{vi.restoreAllMocks();adapter?.dispose();store.close();await owner.close();await server.close();}
});

test.each(['NO_SHRINK','WIDTH_CHANGED','NOT_PHYSICAL_EDGE','TARGET','LATEST','MIDDLE','TWO_ROWS','SAME_TIME','UNKNOWN_TIME','ADDED','TEXT','SYNC_TEXT','SENDER','TIME','TYPE','STATUS','PENDING','FAILED','ORDER','EDITOR','FOREIGN_INPUT'] as const)
  ('viewport shrink cannot mask %s before a durable intent',async fault=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp('dm-context-viewport-negative-'),'profile'),true),store=database();
  let adapter:ObservedDmReply|undefined;
  try{
    await mountDmReply(owner,server.origin);const mapping=dmReplyMapping(server.origin);
    await owner.dm.evaluate(fault=>{
      const chat=document.querySelector('#chat')!,viewport=document.createElement('div');viewport.style.cssText='height:150px;width:320px;overflow:auto';
      chat.insertBefore(viewport,document.querySelector('#native-controls'));const boxes=Array.from(chat.querySelectorAll<HTMLElement>('.box'));
      for(const [index,box]of boxes.entries()){
        box.dataset.index=String(boxes.length-1-index);box.style.height='30px';viewport.append(box);
        const native=Object.getOwnPropertyDescriptor(box.querySelector('.message')!,'__reactProps$fixture')!.value.children.props.message;
        native.createdAt=new Date(Date.UTC(2026,10,5,0,0,index));
        if(index===0&&fault==='SAME_TIME')native.createdAt=new Date(Date.UTC(2026,10,5,0,0,2));
        if(index===0&&fault==='UNKNOWN_TIME')native.createdAt=null;
        if(index===0&&fault==='NOT_PHYSICAL_EDGE')box.style.transform='translateY(40px)';
      }
      const update={run():void{
        if(fault!=='NO_SHRINK')viewport.style.height='120px';if(fault==='WIDTH_CHANGED')viewport.style.width='319px';
        boxes[fault==='TARGET'?2:fault==='LATEST'?4:fault==='MIDDLE'?1:0]!.remove();if(fault==='TWO_ROWS')boxes[1]!.remove();
        const row=boxes[1]!.querySelector('.message')!,native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
        if(fault==='ADDED'){
          const copy=boxes[1]!.cloneNode(true) as HTMLElement;Object.defineProperty(copy.querySelector('.message')!,'__reactProps$fixture',{value:{children:{props:{message:{...native,serverId:'999'}}}}});viewport.append(copy);
        }
        if(fault==='TEXT'||fault==='SYNC_TEXT'){native._parsedContent.text='changed native context';row.querySelector('.text')!.textContent=native._parsedContent.text;}
        if(fault==='SENDER')native.sender='outside';if(fault==='TIME')native.createdAt=new Date('2020-01-01');
        if(fault==='TYPE')native.type=9;if(fault==='STATUS')native.serverStatus=1;
        if(fault==='PENDING'||fault==='FAILED')boxes[1]!.classList.add(fault.toLowerCase());
        if(fault==='ORDER')viewport.append(boxes[1]!);
        if(fault==='EDITOR')document.querySelector('#native-editor')!.replaceWith(document.querySelector('#native-editor')!.cloneNode(true));
        if(fault==='FOREIGN_INPUT')document.querySelector('#native-editor')!.dispatchEvent(new InputEvent('input',{bubbles:true,data:'human'}));
      }};
      document.querySelector('#native-editor')!.addEventListener('input',()=>{if(fault==='SYNC_TEXT')update.run();else queueMicrotask(()=>update.run());},{once:true});
    },fault);
    const batch=await new ObservedReader(owner.dm,mapping.observation).dm(0);
    store.observe('DIRECT_MESSAGE','conv-a',[],'100','synthetic');store.observe('DIRECT_MESSAGE','conv-a',batch.events,'100','synthetic');
    const event=store.events().find(item=>item.payload.platformEventId==='3')!,draft=store.saveDraft(event.id,'bounded synthetic negative reply','mock');
    adapter=new ObservedDmReply(owner.dm,mapping,250);
    if(fault==='UNKNOWN_TIME')await expect(adapter.inspect(event.payload)).rejects.toThrow('NATIVE_REPLY_WINDOW_UNVERIFIED');
    else{
      store.approve(draft.id,await adapter.inspect(event.payload),draft.version,draft.text);
      await expect(new SendCoordinator(store,owner.actor).send(draft.id,adapter,false)).rejects.toThrow(fault==='SYNC_TEXT'?'NATIVE_REPLY_CONTEXT_CHANGED':undefined);
      if(fault==='SYNC_TEXT'){
        expect(await owner.dm.locator('#native-editor').textContent()).toBe('');
        expect(await owner.dm.evaluate(()=>(window as unknown as {nativeEditorModel:string}).nativeEditorModel)).toBe('');
        expect(store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='PREPARATION_DISCARD_FAILED'").get()).toEqual({n:0});
      }
    }
    expect(store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
    expect(await owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
    expect(store.db.prepare('SELECT kind,used FROM budgets ORDER BY kind').all()).toEqual([{kind:'MODEL',used:0},{kind:'SEND',used:0}]);
  }finally{adapter?.dispose();store.close();await owner.close();await server.close();}
});
