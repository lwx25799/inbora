import {randomUUID} from 'node:crypto';
import type {Page} from 'playwright';
import type {ObservationMapping} from '../config/site-mapping.js';
import {eventSchema,requireSafe,type InboundEvent} from '../core/contracts.js';
import {captureCommentThread} from './comment-thread-capture.js';
import {recoverCommentOffset} from './comment-offset-recovery.js';
import {waitForCommentRender} from './comment-render.js';
import {captureObserved,type CaptureInput,type CaptureOptions,type ObservationBatch,type DiscoveredPeer,type CollectionReadDiagnostic} from './observed-capture.js';
export {captureObserved} from './observed-capture.js';
export type {CaptureInput,CaptureOptions,DiscoveredPeer,CollectionReadDiagnostic,ObservationBatch} from './observed-capture.js';

/** AccountActor owns the entire call, including opening and switching the permitted chat. */
export class ObservedReader {
  constructor(readonly page: Page, readonly mapping: ObservationMapping,private readonly collectionOrigin?:number,private readonly signal?:AbortSignal) {}
  private async capture(channel: CaptureInput['channel'], index: number, selection: CaptureOptions = {}): Promise<ObservationBatch> {
    requireSafe(!this.signal?.aborted,'OBSERVATION_CANCELLED');
    try {
      const result = await this.page.evaluate(captureObserved,{mapping:this.mapping,channel,index,evidenceId:randomUUID(),...selection});
      requireSafe(!this.signal?.aborted,'OBSERVATION_CANCELLED');
      return {...result,events:result.events.map(e=>eventSchema.parse(e))};
    } catch(error) {
      const code=error instanceof Error ? error.message.match(/(?:OBSERVATION|RENDERED)_[A-Z_]+/)?.[0] : null;
      if(!code||/(?:DOM|METADATA)_NOT_READY|RENDERED_BINDING_UNAVAILABLE/.test(code))requireSafe(!this.signal?.aborted,'OBSERVATION_CANCELLED');
      if(code) requireSafe(false,code);throw error;
    }
  }
  private async ready(channel: CaptureInput['channel'],index: number,options:CaptureOptions={}): Promise<ObservationBatch> {
    const deadline=Date.now()+5000;
    for(;;)try{
      const batch=await this.capture(channel,index,options);
      const oldGaps=options.collectionPartial&&this.collectionOrigin!==undefined&&batch.dmCoverage?.every(row=>row.captured||
        Date.parse(row.occurredAt)+row.precisionMs<=this.collectionOrigin!);
      if(batch.incomplete&&options.collectionPartial&&!oldGaps&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,50));continue;}
      return batch;
    }catch(error){
      if(!(error instanceof Error)||!/(?:OBSERVATION_(?:[A-Z]+_)*(?:DOM|METADATA)_NOT_READY|RENDERED_BINDING_UNAVAILABLE)/.test(error.message)||Date.now()>=deadline)throw error;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
  }
  private async transition(code:string,action:()=>Promise<void>):Promise<void> {
    try{await action();}catch(error){
      if(error instanceof Error&&error.name==='TimeoutError')requireSafe(false,code);
      throw error;
    }
  }
  async diagnostic(source:'dm'|'comments',index=0,peer?:DiscoveredPeer):Promise<CollectionReadDiagnostic> {
    const batch=await this.capture('diagnostic',index,{diagnosticSource:source,...(peer?{peer}:{})});
    requireSafe(batch.diagnostic,'OBSERVATION_DIAGNOSTIC_UNAVAILABLE');return batch.diagnostic;
  }
  async dmWindow(peer:DiscoveredPeer,top?:number,collectionPartial=false):Promise<ObservationBatch> {
    const initial=await this.dm(0,peer,collectionPartial);
    if(top!==undefined)await this.scrollDm(peer,top);
    if(initial.incomplete&&top===undefined)return this.capture('dm',0,{peer,dmWindow:true,collectionPartial});
    return this.ready('dm',0,{peer,dmWindow:true,collectionPartial});
  }
  async scrollDm(peer:DiscoveredPeer,top:number):Promise<void> {
    await this.capture('dmScroll',0,{peer,dmTop:top});
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  async guard(): Promise<void> {
    requireSafe(!this.signal?.aborted,'OBSERVATION_CANCELLED');
    await this.page.waitForFunction(({selector,depth})=>{
      const nodes=document.querySelectorAll(selector); if(nodes.length!==1)return false;
      const keys=Object.getOwnPropertyNames(nodes[0]!).filter(k=>k.startsWith('__reactFiber$'));
      if(keys.length!==1)return false;
      let fiber=Object.getOwnPropertyDescriptor(nodes[0]!,keys[0]!)?.value;
      for(let n=0;n<depth;n++) {
        const descriptor=fiber&&Object.getOwnPropertyDescriptor(fiber,'return');
        if(!descriptor||!Object.hasOwn(descriptor,'value'))return false;fiber=descriptor.value;
      }
      const props=fiber&&Object.getOwnPropertyDescriptor(fiber,'memoizedProps')?.value;
      return props&&typeof Object.getOwnPropertyDescriptor(props,'uid')?.value==='string'&&
        typeof Object.getOwnPropertyDescriptor(props,'secUid')?.value==='string';
    },{selector:this.mapping.selectors.selfAvatar,depth:this.mapping.selectors.selfFiberDepth},{timeout:15000});
    await this.capture('identity',0);
  }
  async dm(index: number, discoveredPeer?: DiscoveredPeer,collectionPartial=false): Promise<ObservationBatch> {
    const s = this.mapping.selectors, peer = discoveredPeer??this.mapping.peers[index]; requireSafe(peer,'OBSERVATION_PEER_REQUIRED');
    const options:CaptureOptions=discoveredPeer?{peer:discoveredPeer,collectionPartial}:{};
    await this.guard();
    if (!await this.page.locator(s.dmPanel).isVisible()) await this.transition('OBSERVATION_DM_ENTRY_DOM_NOT_READY',()=>this.page.locator(s.dmEntry).click());
    await this.transition('OBSERVATION_DM_PANEL_DOM_NOT_READY',()=>this.page.locator(s.dmPanel).waitFor({state:'visible'}));
    const chat = this.page.locator(s.chat);
    if (await chat.isVisible()) {
      try { return await this.ready('dm',index,options); } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('OBSERVATION_CONVERSATION_CHANGED')) throw error;
        // A different visible chat must close normally before selecting another permitted row.
        if(discoveredPeer)await this.capture('back',index);
        else await this.page.locator(s.chatBack).click();
        await this.transition('OBSERVATION_DM_BACK_DOM_NOT_READY',()=>chat.waitFor({state:'hidden'}));
      }
    }
    const deadline=Date.now()+12000;
    for(let step=0;step<80 && Date.now()<deadline;step++) {
      const batch=await this.ready('locate',index,{...options,scroll:step===0?'start':'next'}),found=batch.conversation!;
      if(found.rowIndex!==null) {
        // Virtualized rows may change between tasks; the selection task rechecks native identity.
        await this.ready('row',index,{...options,rowIndex:found.rowIndex,select:true});
        try{await chat.waitFor({state:'visible'});}catch(error){
          if(error instanceof Error&&error.name==='TimeoutError')requireSafe(false,'OBSERVATION_DM_CHAT_NOT_READY');
          throw error;
        }
        return this.ready('dm',index,options);
      }
      if(!found.hasList)break;
      await new Promise(resolve=>setTimeout(resolve,150));
    }
    requireSafe(false,'OBSERVATION_CONVERSATION_NOT_FOUND');
  }
  async conversations(scroll?: 'start'|'next',offset?:number):Promise<ObservationBatch> {
    await this.guard();
    const s=this.mapping.selectors;
    if(!await this.page.locator(s.dmPanel).isVisible())await this.transition('OBSERVATION_DM_ENTRY_DOM_NOT_READY',()=>this.page.locator(s.dmEntry).click());
    await this.transition('OBSERVATION_DM_PANEL_DOM_NOT_READY',()=>this.page.locator(s.dmPanel).waitFor({state:'visible'}));
    const chat=this.page.locator(s.chat);
    if(await chat.isVisible()){
      await this.capture('back',0);
      await this.transition('OBSERVATION_DM_BACK_DOM_NOT_READY',()=>chat.waitFor({state:'hidden'}));
    }
    return this.ready('conversations',0,{...(scroll?{scroll}:{}),...(offset!==undefined?{conversationOffset:offset}:{})});
  }
  async navigate(url:string):Promise<void> {
    await this.guard();
    await Promise.all([this.page.waitForNavigation({waitUntil:'domcontentloaded'}),this.capture('navigate',0,{navigationUrl:url})]);
    await this.guard();
  }
  async commentThread(event:InboundEvent,offset=0):Promise<ObservationBatch> {
    const evaluate=async(action:'open'|'position'|'inspect')=>{
      requireSafe(!this.signal?.aborted,'OBSERVATION_CANCELLED');
      try{const value=await this.page.evaluate(captureCommentThread,{mapping:this.mapping,event,action,offset});
        requireSafe(!this.signal?.aborted,'OBSERVATION_CANCELLED');return value;
      }catch(error){const code=error instanceof Error?error.message.match(/(?:OBSERVATION|RENDERED)_[A-Z_]+/)?.[0]:null;
        if(code)requireSafe(false,code);throw error;}
    };
    const before=await evaluate('open');if(before.expanded)await new Promise(resolve=>setTimeout(resolve,150));
    const positioned=await evaluate('position');await new Promise(resolve=>setTimeout(resolve,150));
    const index=this.mapping.works.findIndex(work=>work.id===event.videoId);requireSafe(index>=0,'OBSERVATION_WORK_REQUIRED');
    const batch=await this.capture('comments',index,{allCommentAuthors:true,commentRootId:event.commentId!,commentChildOffset:positioned.offset});
    const after=await evaluate('inspect');return {...batch,commentThread:{...after,expanded:before.expanded,offset:positioned.offset,nextOffset:positioned.nextOffset,beforeTotal:before.initialTotal}};
  }
  async advanceComments(index:number):Promise<NonNullable<ObservationBatch['scroll']>> {
    await this.capture('commentScroll',index);await waitForCommentRender(this.page,this.signal);
    const batch=await this.capture('commentScroll',index,{commentStay:true});requireSafe(batch.scroll,'OBSERVATION_COMMENT_SCROLL_UNAVAILABLE');return batch.scroll;
  }
  async comments(index: number, allCommentAuthors=false, offset=0,collection?:{holdScroll:boolean;stay:boolean;onRestoreWindow?:(batch:ObservationBatch)=>Promise<void>}): Promise<ObservationBatch> {
    const work = this.mapping.works[index]; requireSafe(work,'OBSERVATION_WORK_REQUIRED');
    if(allCommentAuthors){if(offset===0&&!collection?.stay||this.page.url().split('?')[0]!==work.url)await this.navigate(work.url);}
    else await this.page.goto(work.url,{waitUntil:'domcontentloaded'});
    await this.guard();
    if (!await this.page.evaluate(selector=>Array.from(document.querySelectorAll(selector)).some(n=>n.getClientRects().length),this.mapping.selectors.commentList))
      await this.page.locator(this.mapping.selectors.commentEntry).click();
    await this.page.waitForFunction(selector=>Array.from(document.querySelectorAll(selector)).filter(n=>n.getClientRects().length).length===1,
      this.mapping.selectors.commentList);
    if(allCommentAuthors)await this.capture('commentReveal',index,{commentOffset:offset});
    try {
      await this.page.waitForFunction(({rows,empty})=>{
        const visible={check(node:Element):boolean{const r=node.getBoundingClientRect(),style=getComputedStyle(node);
          return r.width>0&&r.height>0&&style.display!=='none'&&style.visibility!=='hidden';}};
        return Array.from(document.querySelectorAll(rows)).some(visible.check)||
          Boolean(empty&&Array.from(document.querySelectorAll(empty)).some(visible.check));
      },{rows:this.mapping.selectors.commentRows,empty:this.mapping.selectors.commentEmpty},{timeout:15000});
    }catch{requireSafe(false,'OBSERVATION_COMMENTS_NOT_READY');}
    const read=()=>this.ready('comments',index,{allCommentAuthors});
    const batch=allCommentAuthors&&offset>0?await recoverCommentOffset(this.page,offset,
      top=>this.capture('commentScroll',index,top===undefined?{commentStay:true}:{commentOffset:top}),
      read,collection?.onRestoreWindow,this.signal):await read();
    if(allCommentAuthors) {
      const input:CaptureInput={mapping:this.mapping,channel:'commentScroll',index,evidenceId:randomUUID(),...(collection?{commentStay:collection.holdScroll}:{})};
      const next=await this.page.evaluate(captureObserved,input);if(next.scroll)batch.scroll=next.scroll;
    }
    return batch;
  }
}
