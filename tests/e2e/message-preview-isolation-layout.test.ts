import {expect,test} from 'vitest';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {inspectMessageImage} from '../../src/adapters/message-preview.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountObserved,observedMapping} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';

const cases=[
  {branch:'block',ancestor:'block',later:false},{branch:'flex',ancestor:'block',later:false},
  {branch:'grid',ancestor:'block',later:false},{branch:'block',ancestor:'flex',later:false},
  {branch:'block',ancestor:'grid',later:false},{branch:'flex',ancestor:'flex',later:false},
  {branch:'block',ancestor:'block',later:true},{branch:'flex',ancestor:'block',later:true},
  {branch:'grid',ancestor:'block',later:true},{branch:'block',ancestor:'flex',later:true},
  {branch:'block',ancestor:'grid',later:true},{branch:'flex',ancestor:'flex',later:true},
] as const;

test.each(cases)('isolation context with $branch content / $ancestor ancestor (later=$later) follows its shared block parent',async spec=>{
  const root=privateTemp('preview-isolation-layout-'),server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
  try{
    await mountObserved(owner,server.origin);const mapping=observedMapping(server.origin),at=Date.now()-1000;
    const png=await owner.dm.evaluate(()=>{
      const canvas=document.createElement('canvas');canvas.width=24;canvas.height=24;const context=canvas.getContext('2d')!;
      context.fillStyle='rgb(12,100,200)';context.fillRect(0,0,24,24);return canvas.toDataURL('image/png');
    });
    const source='https://cdn.fixture.invalid/isolation.png';let requests=0;
    await owner.dm.route(source,route=>{requests++;return route.fulfill({contentType:'image/png',body:Buffer.from(png.split(',')[1]!,'base64')});});
    await owner.dm.evaluate(({source,at,spec})=>{
      const chat=document.querySelector('#chat')!;chat.querySelectorAll('.box').forEach(box=>box.remove());
      const ancestor=document.createElement('div');ancestor.style.cssText='display:'+spec.ancestor+';flex-direction:column';
      const box=document.createElement('div');box.className='box';box.style.display='block';ancestor.append(box);
      const row=document.createElement('div');row.className='message';row.style.cssText='display:'+spec.branch+';isolation:isolate;width:120px;min-height:40px';
      Object.defineProperty(row,'__reactProps$fixture',{value:{children:{props:{message:{serverId:'99751',conversationId:'conv-a',sender:'200',
        createdAt:new Date(at),_parsedContent:{text:''}}}}}});
      const image=document.createElement('img');image.width=24;image.height=24;image.src=source;image.alt='synthetic image';row.append(image);
      const group=document.createElement('div');group.style.cssText='display:'+spec.branch+';isolation:isolate;width:24px;height:24px;pointer-events:none';
      const background=document.createElement('div');background.style.cssText='display:block;width:24px;height:24px;background:rgb(220,30,40);pointer-events:none';
      background.append(document.createElement('span'),document.createElement('span'));group.append(background);
      if(spec.later){box.append(row,group);group.style.marginTop='-40px';}else{box.append(group,row);row.style.marginTop='-24px';}
      chat.append(ancestor);
    },{source,at,spec});
    await owner.dm.locator('.message img').evaluate(image=>(image as HTMLImageElement).decode());
    const batch=await new ObservedReader(owner.dm,mapping).dmWindow(mapping.peers[0]!),event=batch.events[0]!;
    const inspected=await owner.dm.evaluate(inspectMessageImage,{mapping,event,imageIndex:0,peer:mapping.peers[0]!,mode:'CANVAS' as const});
    const bounds=await owner.dm.locator('.message img').boundingBox();expect(bounds).not.toBeNull();
    const screenshot=await owner.dm.screenshot({type:'png',clip:bounds!,scale:'css'});
    const pixel=await owner.dm.evaluate(async base64=>{
      const image=new Image();image.src='data:image/png;base64,'+base64;await image.decode();
      const canvas=document.createElement('canvas');canvas.width=24;canvas.height=24;const context=canvas.getContext('2d')!;
      context.drawImage(image,0,0);return [...context.getImageData(12,12,1,1).data];
    },screenshot.toString('base64'));
    expect(pixel,JSON.stringify(inspected.obstruction)).toEqual(spec.later?[220,30,40,255]:[12,100,200,255]);
    expect(inspected.canvasTainted).toBe(true);expect(requests).toBe(1);
    expect(inspected.reason,JSON.stringify(inspected.obstruction)).toBe(spec.later?'MESSAGE_PREVIEW_OBSCURED':null);
  }finally{await owner.close();await server.close();}
});
