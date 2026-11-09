import {expect,test} from 'vitest';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {ObservedDmReply} from '../../src/adapters/observed-dm-reply.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountDmReply,dmReplyMapping} from '../fixtures/observed-site.js';
import {database,privateTemp} from '../helpers.js';

async function setup(){
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp('dm-preparation-cleanup-'),'profile'),true),store=database();
  await mountDmReply(owner,server.origin);const mapping=dmReplyMapping(server.origin),adapter=new ObservedDmReply(owner.dm,mapping,250);
  const batch=await new ObservedReader(owner.dm,mapping.observation).dm(0);
  store.observe('DIRECT_MESSAGE','conv-a',[],'100','synthetic');store.observe('DIRECT_MESSAGE','conv-a',batch.events,'100','synthetic');
  const event=store.events()[0]!.payload,text='synthetic owned program preparation';
  const approved=await adapter.inspect(event);await adapter.prepare(event,text);
  return{owner,store,mapping,adapter,event,text,approved,close:async()=>{adapter.dispose();store.close();await owner.close();await server.close();}};
}

test('only the same live preparation clears its unchanged program text after a pre-intent context change',async()=>{
  const f=await setup();try{
    await f.owner.dm.evaluate(()=>{const box=document.querySelectorAll('.message')[1]!.closest('.box')!;box.parentElement!.append(box);});
    expect((await f.adapter.verifyPrepared(f.event,f.text)).contextDigest).not.toBe(f.approved.contextDigest);
    await f.owner.actor.run(()=>f.adapter.cancelPreparation(f.event,f.text));
    expect(await f.owner.dm.locator('#native-editor').textContent()).toBe('');
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeEditorModel:string}).nativeEditorModel)).toBe('');
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{await f.close();}
});

test.each(['INPUT','SAME_TEXT_INPUT','PASTE','REMOUNT','LOST_TOKEN','WRONG_ACCOUNT','WRONG_CONVERSATION','CHANGED_SHAPE'] as const)(
  'cleanup preserves uncertain or foreign webpage text (%s)',async fault=>{
  const f=await setup();try{
    await f.owner.dm.evaluate(fault=>{
      const editor=document.querySelector('#native-editor') as HTMLElement;
      if(fault==='INPUT')editor.textContent='actual webpage human draft';
      if(fault==='INPUT'||fault==='SAME_TEXT_INPUT')editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'human'}));
      if(fault==='PASTE')editor.dispatchEvent(new Event('paste',{bubbles:true}));
      if(fault==='REMOUNT')editor.replaceWith(editor.cloneNode(true));
      if(fault==='LOST_TOKEN')delete (window as unknown as {__inboraDmPreparation?:unknown}).__inboraDmPreparation;
      if(fault==='WRONG_ACCOUNT')Object.getOwnPropertyDescriptor(document.querySelector('#self')!,'__reactFiber$fixture')!.value.return.memoizedProps.uid='outside';
      if(fault==='WRONG_CONVERSATION')Object.getOwnPropertyDescriptor(document.querySelector('#header')!,'__reactProps$fixture')!.value.children.props.conversation.id='outside';
      if(fault==='CHANGED_SHAPE')editor.innerHTML='<span>'+editor.textContent+'</span>';
    },fault);
    const before=await f.owner.dm.locator('#native-editor').innerHTML();
    await expect(f.owner.actor.run(()=>f.adapter.cancelPreparation(f.event,f.text))).rejects.toThrow();
    expect(await f.owner.dm.locator('#native-editor').innerHTML()).toBe(before);
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
  }finally{await f.close();}
});

test('a replacement adapter cannot clear an earlier preparation and disposal leaves the field intact',async()=>{
  const f=await setup();let replacement:ObservedDmReply|undefined;
  try{
    f.adapter.dispose();replacement=new ObservedDmReply(f.owner.dm,f.mapping,250);
    await expect(f.owner.actor.run(()=>replacement!.cancelPreparation(f.event,f.text))).rejects.toThrow('NATIVE_REPLY_PREPARATION_NOT_OWNED');
    expect(await f.owner.dm.locator('#native-editor').textContent()).toBe(f.text);
  }finally{replacement?.dispose();await f.close();}
});

test('repeated preparation cannot replace a foreign-input latch or revive a lost token',async()=>{
  const f=await setup();try{
    await f.owner.dm.locator('#native-editor').dispatchEvent('input');
    await expect(f.adapter.prepare(f.event,f.text)).rejects.toThrow('NATIVE_REPLY_PREPARATION_ALREADY_OWNED');
    await expect(f.adapter.cancelPreparation(f.event,f.text)).rejects.toThrow('NATIVE_REPLY_PREPARATION_NOT_OWNED');
    expect(await f.owner.dm.locator('#native-editor').textContent()).toBe(f.text);
  }finally{await f.close();}
});

test('cleanup cannot clear after a submission attempt, including an unknown result',async()=>{
  const f=await setup();try{
    await f.owner.dm.evaluate(()=>(window as unknown as {nativeNoReceipt:boolean}).nativeNoReceipt=true);
    await f.adapter.verifyPrepared(f.event,f.text);await f.adapter.clickOnce(new Date().toISOString());
    await expect(f.adapter.cancelPreparation(f.event,f.text)).rejects.toThrow('NATIVE_REPLY_PREPARATION_NOT_OWNED');
    expect(await f.owner.dm.locator('#native-editor').textContent()).toBe(f.text);
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(1);
  }finally{await f.close();}
});
