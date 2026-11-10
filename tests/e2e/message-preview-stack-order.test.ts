import {expect,test} from 'vitest';
import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {inspectMessageImage} from '../../src/adapters/message-preview.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountObserved,observedMapping} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';

const cases=[
  {order:'EARLIER',ready:true,red:false},{order:'POSITIONED_EARLIER',ready:true,red:false},
  {order:'ISOLATION_EARLIER',ready:true,red:false},{order:'ISOLATION_LATER',ready:false,red:true},
  {order:'LATER',ready:false,red:true},{order:'NARROW_LATER',ready:false,red:false},
  {order:'FLEX_REVERSE',ready:false,red:true},{order:'GRID_REVERSE',ready:false,red:true},
  {order:'PRESERVE_3D',ready:false,red:true},{order:'PERSPECTIVE',ready:false,red:true},
  {order:'FLAT_PRESERVE_3D',ready:false,red:false},{order:'FLAT_PERSPECTIVE',ready:false,red:false},
  {order:'TOP_LAYER',ready:false,red:true},{order:'NEGATIVE_CHILD',ready:false,red:true},
  {order:'NESTED_PREFIX',ready:false,red:true},{order:'WRAPPED_CONTEXT',ready:false,red:false},
] as const;

test.each(cases)('painted pixels and the obstruction guard agree for $order',async ({order,ready,red})=>{
  const root=privateTemp('preview-stack-order-'),server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
  try{
    await mountObserved(owner,server.origin);const mapping=observedMapping(server.origin),at=Date.now()-1000;
    const data=await owner.dm.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=24;canvas.height=24;
      const context=canvas.getContext('2d')!;context.fillStyle='rgb(12,100,200)';context.fillRect(0,0,24,24);return canvas.toDataURL('image/png');});
    const source='https://cdn.fixture.invalid/stack-order.png';let requests=0;
    await owner.dm.route(source,route=>{requests++;return route.fulfill({contentType:'image/png',body:Buffer.from(data.split(',')[1]!,'base64')});});
    await owner.dm.evaluate(({source,at,order})=>{
      const chat=document.querySelector('#chat')!;chat.querySelectorAll('.box').forEach(box=>box.remove());
      const box=document.createElement('div');box.className='box';
      const row=document.createElement('div');row.className='message';row.style.cssText='display:block;transform:translateZ(0);width:120px;min-height:40px';
      Object.defineProperty(row,'__reactProps$fixture',{value:{children:{props:{message:{serverId:'98991',conversationId:'conv-a',sender:'200',
        createdAt:new Date(at),_parsedContent:{text:''}}}}}});
      const image=document.createElement('img');image.width=24;image.height=24;image.src=source;image.alt='synthetic stack image';row.append(image);
      const group=document.createElement('div');group.style.cssText='display:block;transform:translateZ(0);width:24px;height:24px;pointer-events:none';
      const background=document.createElement('div');background.id='synthetic-background';background.style.cssText='display:block;width:24px;height:24px;background:rgb(220,30,40);pointer-events:none';
      background.append(document.createElement('span'),document.createElement('span'));group.append(background);
      if(order==='LATER'||order==='NARROW_LATER'||order==='ISOLATION_LATER'){box.append(row,group);group.style.marginTop='-40px';}
      else{box.append(group,row);row.style.marginTop='-24px';}
      if(order==='POSITIONED_EARLIER')for(const node of [group,row]){node.style.transform='none';node.style.position='relative';node.style.zIndex='0';}
      if(order==='ISOLATION_EARLIER'||order==='ISOLATION_LATER'){
        box.style.isolation='isolate';
        for(const node of [group,row]){node.style.transform='none';node.style.isolation='isolate';}
        const inner=document.createElement('div');inner.style.cssText='display:block;transform:translateZ(0);width:24px;height:24px';row.append(inner);inner.append(image);
      }
      if(order==='NARROW_LATER'){
        group.style.width='2px';group.style.height='2px';group.style.marginTop='-34px';group.style.marginLeft='6px';
        background.style.width='2px';background.style.height='2px';
      }
      if(order==='FLEX_REVERSE'||order==='GRID_REVERSE'){
        box.style.display=order==='FLEX_REVERSE'?'flex':'grid';box.style.flexDirection='column';
        group.style.order='1';row.style.order='0';row.style.marginTop='0';
        if(order==='FLEX_REVERSE')group.style.marginTop='-40px';
        else for(const node of [group,row])node.style.gridArea='1 / 1';
      }
      if(order==='PRESERVE_3D'||order==='PERSPECTIVE'){
        box.style.transformStyle='preserve-3d';group.style.transform='translateZ(1px)';
        if(order==='PERSPECTIVE')box.style.perspective='100px';
      }
      if(order==='FLAT_PRESERVE_3D')box.style.transformStyle='preserve-3d';
      if(order==='FLAT_PERSPECTIVE')box.style.perspective='100px';
      if(order==='NEGATIVE_CHILD'){
        group.style.position='relative';group.style.zIndex='1';background.style.position='relative';background.style.zIndex='-5';
      }
      if(order==='NESTED_PREFIX'){
        row.style.position='relative';row.style.zIndex='-1';box.replaceChildren(group);group.append(row);group.style.height='40px';
      }
      if(order==='WRAPPED_CONTEXT'){
        const wrapper=document.createElement('div');box.prepend(wrapper);wrapper.append(group);
      }
      chat.append(box);
      if(order==='TOP_LAYER'){
        row.style.marginTop='0';group.setAttribute('popover','manual');
        group.style.cssText+=';position:fixed;margin:0;padding:0;border:0';group.showPopover();
        const bounds=image.getBoundingClientRect();group.style.left=bounds.left+'px';group.style.top=bounds.top+'px';
      }
    },{source,at,order});
    await owner.dm.locator('.message img').evaluate(node=>(node as HTMLImageElement).decode());
    const batch=await new ObservedReader(owner.dm,mapping).dmWindow(mapping.peers[0]!),event=batch.events[0]!;
    const report=await owner.dm.evaluate(inspectMessageImage,{mapping,event,imageIndex:0,peer:mapping.peers[0]!,mode:'CANVAS' as const});
    const bounds=await owner.dm.locator('.message img').boundingBox();expect(bounds).not.toBeNull();
    const screenshot=await owner.dm.screenshot({type:'png',clip:bounds!,scale:'css'});
    const pixels=await owner.dm.evaluate(async data=>{const image=new Image();image.src='data:image/png;base64,'+data;await image.decode();
      const canvas=document.createElement('canvas');canvas.width=24;canvas.height=24;const context=canvas.getContext('2d')!;
      context.drawImage(image,0,0);return {center:Array.from(context.getImageData(12,12,1,1).data),narrow:Array.from(context.getImageData(6,6,1,1).data)};},screenshot.toString('base64'));
    const result={order,pixels,report:report.obstruction,reason:report.reason,canvasTainted:report.canvasTainted,requests};
    await writeFile(join(root,'stack-result.json'),JSON.stringify(result));
    expect(pixels.center,JSON.stringify(result)).toEqual(red?[220,30,40,255]:[12,100,200,255]);
    if(order==='NARROW_LATER')expect(pixels.narrow).toEqual([220,30,40,255]);
    expect(report.canvasTainted).toBe(true);expect(requests).toBe(1);
    if(ready)expect(report.reason,JSON.stringify(result)).toBeNull();
    else expect(report.reason).toBe('MESSAGE_PREVIEW_OBSCURED');
  }finally{await owner.close();await server.close();}
});
