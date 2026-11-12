import {expect,test,vi} from 'vitest';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {captureObserved} from '../../src/adapters/observed-reader.js';
import {inspectMessageImage,saveMessagePreviews} from '../../src/adapters/message-preview.js';
import {MessagePreviewStore} from '../../src/storage/message-previews.js';
import {isStrong,type InboundEvent} from '../../src/core/contracts.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountObserved,observedMapping} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';

async function setup(outgoing=false,mixed=false){
  const root=privateTemp('preview-media-carrier-'),server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
  await mountObserved(owner,server.origin);const mapping=observedMapping(server.origin),at=Date.now()-1000;
  let requests=0;await owner.dm.route(server.origin+'/emoji.png',route=>{requests++;return route.fulfill({contentType:'image/png',
    body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jntkAAAAASUVORK5CYII=','base64')});});
  await owner.dm.evaluate(({at,url,outgoing,mixed})=>{
    const chat=document.querySelector('#chat')!,first=chat.querySelector('.box')!;
    for(const box of chat.querySelectorAll('.box'))if(box!==first)box.remove();
    first.className=outgoing?'box from-me':'box';const row=first.querySelector('.message')!;
    row.innerHTML='<span class="text">'+(mixed?'hello ':'')+'<img width="16" height="16" alt="[微笑]" src="'+url+'"></span>';
    const native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
    native.serverId='99711';native.type=7;native.sender=outgoing?'100':'200';native.createdAt=new Date(at);native._parsedContent.text=(mixed?'hello ':'')+'[微笑]';
  },{at,url:server.origin+'/emoji.png',outgoing,mixed});
  await owner.dm.locator('.message img').evaluate(image=>(image as HTMLImageElement).decode());
  const input={mapping,channel:'dm' as const,index:0,evidenceId:'synthetic-carrier-preview',dmWindow:true,peer:mapping.peers[0]!};
  const batch=await owner.dm.evaluate(captureObserved,input),fresh=batch.events[0]!;
  expect(isStrong(fresh)).toBe(true);
  const event:InboundEvent={...fresh,text:mixed?'[含媒体的消息，需人工查看]':'[图片或表情消息，需人工查看]',
    contentType:mixed?'MIXED':'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED'};
  const cache=new MessagePreviewStore(root),save=()=>saveMessagePreviews(owner.dm,mapping,{...batch,events:[event]},root,new AbortController().signal,mapping.peers[0]);
  return{owner,mapping,event,fresh,cache,save,requests:()=>requests,close:async()=>{await owner.close();await server.close();}};
}

test.each([{outgoing:false,mixed:false},{outgoing:false,mixed:true},{outgoing:true,mixed:false},{outgoing:true,mixed:true}])(
  'a stored weak carrier keeps an exact emoji preview after text becomes readable ($outgoing outgoing, $mixed mixed)',async ({outgoing,mixed})=>{
    const f=await setup(outgoing,mixed);try{
      const original=JSON.stringify(f.event),requests=f.requests();await f.save();
      expect(f.cache.list(f.event,'100')).toMatchObject([{state:'READY',label:'[微笑]'}]);
      const previewId=f.cache.list(f.event,'100')[0]!.previewId!;
      expect(f.cache.read(f.event,'100',previewId).dataUrl).toMatch(/^data:image\/png;base64,/u);
      expect(f.cache.displayText(f.event,'100')).toBe(f.fresh.text);
      expect(JSON.stringify(f.event)).toBe(original);expect(isStrong(f.event)).toBe(false);expect(f.requests()).toBe(requests);
      await f.save();expect(f.cache.list(f.event,'100')[0]!.previewId).toBe(previewId);expect(f.requests()).toBe(requests);
    }finally{await f.close();}
  });

test.each(['BODY','NATIVE_ID','SENDER','CONVERSATION','TIME','DUPLICATE'] as const)(
  'a carrier preview rejects a %s change after image capture',async change=>{
    const f=await setup();try{
      const original=f.owner.dm.evaluate.bind(f.owner.dm);let mutated=false;
      const evaluate=vi.spyOn(f.owner.dm,'evaluate').mockImplementation(async(fn,arg)=>{
        const result=await original(fn,arg);
        if(Object.is(fn,inspectMessageImage)&&(arg as {mode?:string})?.mode==='CANVAS'&&!mutated){
          mutated=true;await original(change=>{
            const row=document.querySelector('.message')!,native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
            if(change==='BODY'){row.querySelector('.text')!.prepend('changed ');native._parsedContent.text='changed [微笑]';}
            if(change==='NATIVE_ID')native.serverId='99712';
            if(change==='SENDER')native.sender='201';
            if(change==='CONVERSATION')native.conversationId='other';
            if(change==='TIME')native.createdAt=new Date(native.createdAt.getTime()+1);
            if(change==='DUPLICATE'){
              const clone=row.cloneNode(true);Object.defineProperty(clone,'__reactProps$fixture',{value:{children:{props:{message:native}}}});row.parentElement!.append(clone);
            }
          },change);
        }
        return result;
      });
      await f.save();evaluate.mockRestore();expect(mutated).toBe(true);
      expect(f.cache.list(f.event,'100')).toMatchObject([{state:'UNAVAILABLE'}]);
    }finally{await f.close();}
  });

test.each(['NON_PLACEHOLDER','PRECISION','COMMENT'] as const)('a different stored %s is not treated as a compatible carrier',async change=>{
  const f=await setup();try{
    if(change==='NON_PLACEHOLDER')f.event.text='previous readable body';
    if(change==='PRECISION')f.event.occurredAtPrecisionMs=1000;
    if(change==='COMMENT')f.event.commentId='42';
    await f.save();expect(f.cache.list(f.event,'100')).toMatchObject([{state:'UNAVAILABLE'}]);
  }finally{await f.close();}
});
