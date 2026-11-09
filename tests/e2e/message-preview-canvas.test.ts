import {expect,test,vi} from 'vitest';
import {join} from 'node:path';
import {readFileSync,readdirSync} from 'node:fs';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {inspectMessageImage,saveMessagePreviews} from '../../src/adapters/message-preview.js';
import {MessagePreviewStore} from '../../src/storage/message-previews.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountObserved,observedMapping} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';

async function setup(mode:'SAME'|'TAINTED'|'CORS'='SAME'){
  const root=privateTemp('preview-canvas-'),server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
  await mountObserved(owner,server.origin);const mapping=observedMapping(server.origin),at=Date.now()-1000;
  const dataUrl=await owner.dm.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=24;canvas.height=24;const context=canvas.getContext('2d')!;
    context.fillStyle='rgb(12,100,200)';context.fillRect(0,0,24,24);return canvas.toDataURL('image/png');
  });
  let requests=0;const source=mode!=='SAME'?'https://cdn.fixture.invalid/PRIVATE-IMAGE.png':server.origin+'/PRIVATE-IMAGE.png';
  await owner.dm.route(source,route=>{requests++;return route.fulfill({contentType:'image/png',headers:mode==='CORS'?{'access-control-allow-origin':'*'}:{},body:Buffer.from(dataUrl.split(',')[1]!,'base64')});});
  await owner.dm.evaluate(({source,at,mode})=>{
    const chat=document.querySelector('#chat')!;chat.querySelectorAll('.box').forEach(row=>row.remove());
    const box=document.createElement('div');box.className='box';const row=document.createElement('div');row.className='message';
    row.style.cssText='width:120px;min-height:40px';row.innerHTML='<img alt="owned emoji" width="24" height="24">';
    Object.defineProperty(row,'__reactProps$fixture',{value:{children:{props:{message:{serverId:'99001',conversationId:'conv-a',sender:'200',createdAt:new Date(at),_parsedContent:{text:''}}}}}});
    box.append(row);chat.append(box);const image=row.querySelector('img')!;if(mode==='CORS')image.crossOrigin='anonymous';image.src=source;
  },{source,at,mode});
  await owner.dm.locator('.message img').evaluate(image=>(image as HTMLImageElement).decode());
  const batch=await new ObservedReader(owner.dm,mapping).dmWindow(mapping.peers[0]!),event=batch.events[0]!,cache=new MessagePreviewStore(root);
  const save=()=>saveMessagePreviews(owner.dm,mapping,batch,root,new AbortController().signal);
  return{root,owner,mapping,event,batch,cache,save,requests:()=>requests,close:async()=>{await owner.close();await server.close();}};
}

test('an already loaded exact image is copied without page overlays, screenshots, navigation or another image request',async()=>{
  const f=await setup();try{
    await f.owner.dm.evaluate(()=>{
      const bounds=document.querySelector('.message img')!.getBoundingClientRect(),overlay=document.createElement('div');
      overlay.id='PRIVATE_OVERLAY';overlay.textContent='PRIVATE_FOREIGN_TEXT';overlay.style.cssText=`position:fixed;left:${bounds.left}px;top:${bounds.top}px;width:24px;height:24px;background:red;z-index:10000`;
      document.body.append(overlay);
    });
    const inspected=await f.owner.dm.evaluate(inspectMessageImage,{mapping:f.mapping,event:f.event,imageIndex:0,peer:f.mapping.peers[0]!});
    expect(inspected.reason).toBe('MESSAGE_PREVIEW_OBSCURED');const screenshot=vi.spyOn(f.owner.dm,'screenshot'),beforeRequests=f.requests(),url=f.owner.dm.url();
    await f.save();expect(screenshot).not.toHaveBeenCalled();screenshot.mockRestore();
    const attachment=f.cache.list(f.event,'100')[0]!;expect(attachment).toMatchObject({state:'READY',label:'owned emoji',width:24,height:24});
    const preview=f.cache.read(f.event,'100',attachment.previewId!);
    const pixel=await f.owner.dm.evaluate(async dataUrl=>{
      const image=new Image();image.src=dataUrl;await image.decode();const canvas=document.createElement('canvas');canvas.width=24;canvas.height=24;
      const context=canvas.getContext('2d')!;context.drawImage(image,0,0);return [...context.getImageData(12,12,1,1).data];
    },preview.dataUrl);
    expect(pixel).toEqual([12,100,200,255]);expect(f.requests()).toBe(beforeRequests);expect(f.owner.dm.url()).toBe(url);
    expect(await f.owner.context.pages()).toHaveLength(2);
    for(const file of readdirSync(join(f.root,'evidence','message-previews')).filter(file=>file.endsWith('.json')))
      expect(readFileSync(join(f.root,'evidence','message-previews',file),'utf8')).not.toMatch(/PRIVATE_|https?:|FOREIGN_TEXT/u);
  }finally{await f.close();}
});

test('a normally loaded CORS-enabled cross-origin image is usable without another request',async()=>{
  const f=await setup('CORS');try{
    const requests=f.requests(),screenshot=vi.spyOn(f.owner.dm,'screenshot');await f.save();
    expect(f.cache.list(f.event,'100')[0]).toMatchObject({state:'READY',width:24,height:24});
    expect(f.requests()).toBe(requests);expect(screenshot).not.toHaveBeenCalled();screenshot.mockRestore();
  }finally{await f.close();}
});

test.each([false,true])('a browser-tainted image keeps the original screenshot guard (%s obstruction)',async obscured=>{
  const f=await setup('TAINTED');try{
    if(obscured)await f.owner.dm.evaluate(()=>{
      const r=document.querySelector('.message img')!.getBoundingClientRect(),overlay=document.createElement('div');
      overlay.style.cssText=`position:fixed;left:${r.left}px;top:${r.top}px;width:24px;height:24px;background:red;z-index:10000`;document.body.append(overlay);
    });
    const input={mapping:f.mapping,event:f.event,imageIndex:0,peer:f.mapping.peers[0]!,mode:'CANVAS' as const};
    const report=await f.owner.dm.evaluate(inspectMessageImage,input);expect(report.canvasTainted).toBe(true);expect(report.canvas).toBeUndefined();
    const requests=f.requests(),screenshot=vi.spyOn(f.owner.dm,'screenshot');await f.save();
    expect(f.cache.list(f.event,'100')[0]).toMatchObject(obscured?{state:'UNAVAILABLE',reason:'MESSAGE_PREVIEW_OBSCURED'}:{state:'READY',width:24,height:24});
    expect(screenshot).toHaveBeenCalledTimes(obscured?0:1);screenshot.mockRestore();expect(f.requests()).toBe(requests);
    const diagnostics=JSON.parse(readFileSync(join(f.root,'evidence','message-preview-latest.json'),'utf8'));
    expect(diagnostics.caught.MESSAGE_PREVIEW_CANVAS_TAINTED).toBe(1);expect(JSON.stringify(diagnostics)).not.toMatch(/PRIVATE_|cdn\.fixture|conv-a|99001|owned emoji/u);
  }finally{await f.close();}
});

test.each(['SOURCE','NATIVE_ID','ACCOUNT','CONVERSATION','SIZE','BODY'] as const)('a canvas capture cannot survive an exact %s change',async change=>{
  const f=await setup();try{
    const original=f.owner.dm.evaluate.bind(f.owner.dm);let captured=false;
    const evaluate=vi.spyOn(f.owner.dm,'evaluate').mockImplementation(async(fn,arg)=>{
      const result=await original(fn,arg);
      if(Object.is(fn,inspectMessageImage)&&(arg as {mode?:string})?.mode==='CANVAS'&&!captured){
        captured=true;await original(change=>{
          const row=document.querySelector('.message')!,image=row.querySelector('img')!;
          const native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
          if(change==='SOURCE')image.src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jntkAAAAASUVORK5CYII=';
          if(change==='SIZE'){const canvas=document.createElement('canvas');canvas.width=32;canvas.height=16;image.src=canvas.toDataURL('image/png');}
          if(change==='NATIVE_ID')native.serverId='99002';
          if(change==='ACCOUNT')Object.getOwnPropertyDescriptor(document.querySelector('#self')!,'__reactFiber$fixture')!.value.return.memoizedProps.uid='101';
          if(change==='CONVERSATION')Object.getOwnPropertyDescriptor(document.querySelector('#header')!,'__reactProps$fixture')!.value.children.props.conversation.id='other';
          if(change==='BODY'){const text=document.createElement('span');text.className='text';text.textContent='newly mounted text';row.append(text);native._parsedContent.text='newly mounted text';}
          return change==='SOURCE'||change==='SIZE'?image.decode():undefined;
        },change);
      }
      return result;
    });
    await f.save();evaluate.mockRestore();expect(captured).toBe(true);
    expect(f.cache.list(f.event,'100')[0]).toMatchObject({state:'UNAVAILABLE'});
    expect(readdirSync(join(f.root,'evidence','message-previews')).filter(file=>file.endsWith('.png'))).toEqual([]);
  }finally{await f.close();}
});

test('image-owned accessors are never called to read source, completeness or natural size',async()=>{
  const f=await setup();try{
    await f.owner.dm.evaluate(()=>{
      const image=document.querySelector('.message img')!;Object.assign(window,{imageGetterCalls:0});
      for(const key of ['currentSrc','complete','naturalWidth','naturalHeight'])Object.defineProperty(image,key,{get(){
        (window as unknown as {imageGetterCalls:number}).imageGetterCalls++;throw Error('PRIVATE_GETTER_MUST_NOT_RUN');
      }});
    });
    await f.save();expect(f.cache.list(f.event,'100')[0]).toMatchObject({state:'READY',width:24,height:24});
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {imageGetterCalls:number}).imageGetterCalls)).toBe(0);
  }finally{await f.close();}
});
