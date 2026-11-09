import {expect,test,vi} from 'vitest';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {ObservedDmReply} from '../../src/adapters/observed-dm-reply.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountDmReply,dmReplyMapping} from '../fixtures/observed-site.js';
import {database,privateTemp} from '../helpers.js';

async function setup(){
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp('dm-saved-draft-clear-'),'profile'),true),store=database();
  await mountDmReply(owner,server.origin);const mapping=dmReplyMapping(server.origin),creator=new ObservedDmReply(owner.dm,mapping,250);
  const batch=await new ObservedReader(owner.dm,mapping.observation).dm(0);
  store.observe('DIRECT_MESSAGE','conv-a',[],'100','synthetic');store.observe('DIRECT_MESSAGE','conv-a',batch.events,'100','synthetic');
  const event=store.events()[0]!.payload,text='saved exact draft from the previous backend';
  await creator.inspect(event);await creator.prepare(event,text);creator.dispose();
  const adapter=new ObservedDmReply(owner.dm,mapping,250);
  return{owner,store,mapping,adapter,event,text,close:async()=>{adapter.dispose();store.close();await owner.close();await server.close();}};
}

test('a replacement backend cannot cancel a lost preparation but an explicit exact saved-draft clear can remove it',async()=>{
  const f=await setup();try{
    const draft=f.store.saveDraft(f.store.events()[0]!.id,f.text,'synthetic-persisted-model'),before=f.store.draft(draft.id);
    await expect(f.adapter.cancelPreparation(f.event,f.text)).rejects.toThrow('NATIVE_REPLY_PREPARATION_NOT_OWNED');
    const navigate=vi.spyOn(ObservedReader.prototype,'dm').mockRejectedValue(Error('UNEXPECTED_NAVIGATION'));
    expect(await f.owner.actor.run(()=>f.adapter.readSavedDraft(f.event))).toMatchObject({text:f.text,snapshot:{targetKey:'dm:conv-a'}});
    await f.owner.actor.run(()=>f.adapter.clearSavedDraft(f.event,f.text));
    expect(navigate).not.toHaveBeenCalled();navigate.mockRestore();expect(f.store.draft(draft.id)).toEqual(before);
    expect(await f.owner.dm.locator('#native-editor').textContent()).toBe('');
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeEditorModel:string}).nativeEditorModel)).toBe('');
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{vi.restoreAllMocks();await f.close();}
});

test.each(['TEXT','TARGET','ACCOUNT','CONVERSATION','STRUCTURE'] as const)('explicit saved-draft clear leaves unmatched current content untouched (%s)',async fault=>{
  const f=await setup();try{
    await f.owner.dm.evaluate(fault=>{
      if(fault==='ACCOUNT')Object.getOwnPropertyDescriptor(document.querySelector('#self')!,'__reactFiber$fixture')!.value.return.memoizedProps.uid='outside';
      if(fault==='CONVERSATION')Object.getOwnPropertyDescriptor(document.querySelector('#header')!,'__reactProps$fixture')!.value.children.props.conversation.id='outside';
      if(fault==='STRUCTURE')document.querySelector('#native-editor')!.append(document.createElement('img'));
    },fault);
    const before=await f.owner.dm.locator('#native-editor').innerHTML(),event=fault==='TARGET'?{...f.event,platformEventId:'outside'}:f.event;
    await expect(f.owner.actor.run(()=>f.adapter.clearSavedDraft(event,fault==='TEXT'?f.text+' ':f.text))).rejects.toThrow();
    expect(await f.owner.dm.locator('#native-editor').innerHTML()).toBe(before);
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
  }finally{await f.close();}
});

test.each(['INPUT','SAME_TEXT_INPUT','REMOUNT','CONTEXT','LATEST'] as const)('a focus-time %s change cannot be erased by the explicit saved-draft operation',async fault=>{
  const f=await setup();try{
    await f.owner.dm.evaluate(fault=>{
      const editor=document.querySelector('#native-editor') as HTMLElement;editor.blur();
      editor.addEventListener('focus',()=>{
        if(fault==='INPUT')editor.textContent='new real human draft';
        if(fault==='INPUT'||fault==='SAME_TEXT_INPUT')editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'human'}));
        if(fault==='REMOUNT')editor.replaceWith(editor.cloneNode(true));
        if(fault==='CONTEXT'){
          const row=document.querySelectorAll('.message')[1]!,native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
          native._parsedContent.text='changed full native context';row.querySelector('.text')!.textContent=native._parsedContent.text;
        }
        if(fault==='LATEST'){
          document.querySelector('[data-index="0"]')!.setAttribute('data-index','1');document.querySelectorAll('.box')[1]!.setAttribute('data-index','0');
        }
      },{once:true});
    },fault);
    await expect(f.owner.actor.run(()=>f.adapter.clearSavedDraft(f.event,f.text))).rejects.toThrow();
    expect(await f.owner.dm.locator('#native-editor').textContent()).toBe(fault==='INPUT'?'new real human draft':f.text);
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
  }finally{await f.close();}
});
