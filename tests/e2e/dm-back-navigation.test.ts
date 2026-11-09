import { expect,test } from 'vitest';
import { join } from 'node:path';
import { BrowserProfileOwner } from '../../src/browser/profile-owner.js';
import { ObservedReader } from '../../src/adapters/observed-reader.js';
import { fixtureServer } from '../fixtures/site.js';
import { mountObserved,observedMapping } from '../fixtures/observed-site.js';
import { privateTemp } from '../helpers.js';

// MIT DSH fixed 7989640 chat-browser.mjs:1023–1028 normally clicks its exact child back control.
// This fixture independently models the calibrated DIV wrapper / SVG listener boundary without new selectors.
async function backFixture(){
  const server=await fixtureServer(),root=privateTemp('dm-back-navigation-');
  const owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
  await mountObserved(owner,server.origin);owner.context.setDefaultTimeout(600);
  const mapping=observedMapping(server.origin);
  await owner.dm.evaluate(()=>{
    const chat=document.querySelector('#chat') as HTMLElement;
    const state=window as unknown as {svgClicks:number;wrapperClicks:number;pathClicks:number;pointerEvents:number;
      clickTargets:string[];clickedAt:number;hiddenAt:number;openedBeforeHidden:boolean;laterOpens:number;holdOpen:boolean};
    Object.assign(state,{svgClicks:0,wrapperClicks:0,pathClicks:0,pointerEvents:0,clickTargets:[],clickedAt:0,hiddenAt:0,openedBeforeHidden:false,laterOpens:0,holdOpen:false});
    const wrapper=document.createElement('div');wrapper.id='back';
    wrapper.style.cssText='position:fixed;left:32px;top:32px;width:32px;height:32px;z-index:1000';
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('width','32');svg.setAttribute('height','32');svg.style.cssText='display:block;width:32px;height:32px';
    const path=document.createElementNS('http://www.w3.org/2000/svg','path');
    path.setAttribute('d','M24 4 L8 16 L24 28');path.setAttribute('stroke','black');path.style.pointerEvents='none';svg.append(path);wrapper.append(svg);
    Object.defineProperty(svg,'__reactProps$fixture',{value:{onClick:()=>undefined}});
    svg.addEventListener('click',event=>{
      state.svgClicks++;state.clickedAt=performance.now();state.clickTargets.push((event.target as Element).tagName.toUpperCase());
      setTimeout(()=>{if(!state.holdOpen){chat.hidden=true;state.hiddenAt=performance.now();}},120);
    });
    wrapper.addEventListener('click',()=>state.wrapperClicks++);path.addEventListener('click',()=>state.pathClicks++);
    for(const name of ['pointerdown','mousedown','mouseup'])wrapper.addEventListener(name,()=>state.pointerEvents++);
    document.querySelector('#back')!.replaceWith(wrapper);
    const later=document.createElement('div');later.className='conversation';later.innerHTML='<span class="title">Other native peer</span>';
    Object.defineProperty(later,'__reactFiber$fixture',{value:{return:{memoizedProps:{conversation:{id:'conv-b',_toParticipantSecUserId:'b-sec'}}}}});
    later.addEventListener('click',()=>{
      state.laterOpens++;if(!chat.hidden||!state.hiddenAt)state.openedBeforeHidden=true;
      const header=Object.getOwnPropertyDescriptor(document.querySelector('#header')!,'__reactProps$fixture')!.value.children.props.conversation;
      header.id='conv-b';header._toParticipantSecUserId='b-sec';document.querySelector('#chat-title')!.textContent='Other native peer';
      for(const row of document.querySelectorAll('.message')){
        const message=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
        message.conversationId='conv-b';if(message.sender!=='100')message.sender='300';
      }
      chat.hidden=false;
    });
    document.querySelector('#dm-panel')!.prepend(later);
  });
  const counters=()=>owner.dm.evaluate(()=>{
    const state=window as unknown as {svgClicks:number;wrapperClicks:number;pathClicks:number;pointerEvents:number;
      clickTargets:string[];clickedAt:number;hiddenAt:number;openedBeforeHidden:boolean;laterOpens:number};
    return {svgClicks:state.svgClicks,wrapperClicks:state.wrapperClicks,pathClicks:state.pathClicks,pointerEvents:state.pointerEvents,
      clickTargets:state.clickTargets,clickedAt:state.clickedAt,hiddenAt:state.hiddenAt,openedBeforeHidden:state.openedBeforeHidden,laterOpens:state.laterOpens};
  });
  return {owner,mapping,reader:new ObservedReader(owner.dm,mapping),counters,
    close:async()=>{await owner.close();await server.close();}};
}

test.each(['list','switch'])('a single exact SVG back click waits for the native hidden transition before %s continues',async route=>{
  const f=await backFixture();
  try{
    // A click on the calibrated wrapper does not invoke a listener attached to its SVG child.
    await f.owner.dm.evaluate(()=>(document.querySelector('#back') as HTMLElement).click());
    expect((await f.counters()).svgClicks).toBe(0);expect(await f.owner.dm.locator('#chat').isVisible()).toBe(true);
    await f.owner.dm.evaluate(()=>(window as unknown as {wrapperClicks:number}).wrapperClicks=0);
    const diagnostic=await f.reader.diagnostic('dm');
    expect(diagnostic.back).toMatchObject({count:1,centerHit:'DESCENDANT',centerIndex:1});
    expect(diagnostic.back!.nodes![1]).toMatchObject({tag:'SVG',handlers:{onClick:true}});
    if(route==='list'){
      expect((await f.reader.conversations()).peers?.map(peer=>peer.conversationId).sort()).toEqual(['conv-a','conv-b']);
      expect(await f.owner.dm.locator('#chat').isVisible()).toBe(false);
    }else{
      const batch=await f.reader.dm(0,{uid:'300',secUid:'b-sec',conversationId:'conv-b',title:'Other native peer'});
      expect(batch.events.map(event=>event.platformEventId)).toEqual(['1','2','3','4','5']);
      expect(batch.events.every(event=>event.conversationId==='conv-b')).toBe(true);
      expect(await f.owner.dm.locator('#chat').isVisible()).toBe(true);
    }
    const proof=await f.counters();
    expect(proof).toMatchObject({svgClicks:1,wrapperClicks:1,pathClicks:0,pointerEvents:0,clickTargets:['SVG'],openedBeforeHidden:false,laterOpens:route==='list'?0:1});
    expect(proof.hiddenAt-proof.clickedAt).toBeGreaterThanOrEqual(100);
  }finally{await f.close();}
});

test('a center hit on the mapped HTML control itself remains a single normal click',async()=>{
  const f=await backFixture();
  try{
    await f.owner.dm.evaluate(()=>{
      const back=document.querySelector('#back')!;back.replaceChildren();
      back.addEventListener('click',()=>setTimeout(()=>{(document.querySelector('#chat') as HTMLElement).hidden=true;},120));
    });
    expect((await f.reader.diagnostic('dm')).back).toMatchObject({centerHit:'SELF',centerIndex:0});
    await f.reader.conversations();
    expect(await f.owner.dm.locator('#chat').isVisible()).toBe(false);
    expect(await f.counters()).toMatchObject({svgClicks:0,wrapperClicks:1,pathClicks:0,pointerEvents:0});
  }finally{await f.close();}
});

test('a dispatched SVG click without a native transition fails once without a second click or fallback sequence',async()=>{
  const f=await backFixture();
  try{
    await f.owner.dm.evaluate(()=>(window as unknown as {holdOpen:boolean}).holdOpen=true);
    await expect(f.reader.conversations()).rejects.toThrow('OBSERVATION_DM_BACK_DOM_NOT_READY');
    expect(await f.owner.dm.locator('#chat').isVisible()).toBe(true);
    expect(await f.counters()).toMatchObject({svgClicks:1,wrapperClicks:1,pathClicks:0,pointerEvents:0,clickTargets:['SVG'],hiddenAt:0,laterOpens:0});
  }finally{await f.close();}
});

test.each(['obstruction','offscreen','editor','duplicate','account','wrong-chat'])('back navigation preserves the page when its %s gate fails',async gate=>{
  const f=await backFixture();
  try{
    await f.owner.dm.evaluate(gate=>{
      if(gate==='obstruction'){
        const cover=document.createElement('div');cover.id='cover';cover.style.cssText='position:fixed;left:32px;top:32px;width:32px;height:32px;z-index:2000';document.body.append(cover);
      }else if(gate==='offscreen')(document.querySelector('#back') as HTMLElement).style.left='-1000px';
      else if(gate==='editor'){
        const editor=document.createElement('textarea');editor.value='preserve native unsent input';document.querySelector('#chat')!.append(editor);
      }else if(gate==='duplicate')document.querySelector('#chat')!.append(document.querySelector('#back')!.cloneNode(true));
      else if(gate==='wrong-chat')document.body.append(document.querySelector('#back')!);
      else Object.getOwnPropertyDescriptor(document.querySelector('#self')!,'__reactFiber$fixture')!.value.return.memoizedProps.uid='outside';
    },gate);
    if(gate==='editor')await expect(f.reader.conversations()).rejects.toThrow('OBSERVATION_EXISTING_HUMAN_INPUT');
    else if(gate==='account')await expect(f.reader.conversations()).rejects.toThrow('OBSERVATION_ACCOUNT_CHANGED');
    else if(gate==='wrong-chat')await expect(f.reader.conversations()).rejects.toThrow('OBSERVATION_CONVERSATION_CHANGED');
    else await expect(f.reader.conversations()).rejects.toThrow(/OBSERVATION_[A-Z_]+/);
    expect(await f.owner.dm.locator('#chat').isVisible()).toBe(true);
    expect(await f.counters()).toMatchObject({svgClicks:0,pathClicks:0,pointerEvents:0,laterOpens:0});
    if(gate==='obstruction'||gate==='offscreen')expect((await f.counters()).wrapperClicks).toBe(0);
    if(gate==='editor')expect(await f.owner.dm.locator('textarea').inputValue()).toBe('preserve native unsent input');
  }finally{await f.close();}
});
