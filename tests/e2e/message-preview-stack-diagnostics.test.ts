import {expect,test} from 'vitest';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {inspectMessageImage,saveMessagePreviews} from '../../src/adapters/message-preview.js';
import {eventBinding} from '../../src/core/contracts.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountObserved,observedMapping} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jntkAAAAASUVORK5CYII=';
async function setup(depth=0){
  const root=privateTemp('preview-stack-diagnostic-'),server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
  await mountObserved(owner,server.origin);const mapping=observedMapping(server.origin);
  await owner.dm.evaluate(({png,depth})=>{
    const chat=document.querySelector('#chat')!;chat.querySelectorAll('.box').forEach(box=>box.remove());
    const box=document.createElement('div'),row=document.createElement('div'),image=document.createElement('img');
    box.className='box';row.className='message';row.style.cssText='width:120px;min-height:40px;isolation:isolate';
    image.src='data:image/png;base64,'+png;image.alt='PRIVATE_IMAGE_LABEL';image.width=24;image.height=24;
    row.append(image);box.append(row);chat.append(box);
    Object.defineProperty(row,'__reactProps$fixture',{value:{children:{props:{message:{serverId:'99401',conversationId:'conv-a',sender:'200',
      createdAt:new Date(Date.now()-1000),_parsedContent:{text:''}}}}}});
    const r=image.getBoundingClientRect(),foreign=document.createElement('div'),foreignContext=document.createElement('div');
    foreignContext.id='PRIVATE_FOREIGN_CONTEXT';foreignContext.style.cssText='transform:translate(0)';
    foreign.style.cssText=`position:fixed;left:${r.left}px;top:${r.top}px;width:24px;height:24px;pointer-events:none;background:red`;
    foreignContext.append(foreign);document.body.prepend(foreignContext);
    // The overlap gate runs before diagnostics; a tiny pointer-free foreground is still rejected.
    for(let i=0;i<depth;i++){const wrapper=document.createElement('div');foreignContext.replaceWith(wrapper);wrapper.append(foreignContext);}
    let getterCalls=0;Object.defineProperty(foreignContext,'privateDiagnosticGetter',{get(){getterCalls++;throw Error('private getter');}});
    Object.defineProperty(document,'fixtureGetterCalls',{value:()=>getterCalls});
    HTMLCanvasElement.prototype.toDataURL=function(){throw new DOMException('fixture canvas fallback','SecurityError');};
  },{png,depth});
  await owner.dm.locator('.message img').evaluate(image=>(image as HTMLImageElement).decode());
  const batch=await new ObservedReader(owner.dm,mapping).dmWindow(mapping.peers[0]!);
  return {root,owner,mapping,batch,close:async()=>{await owner.close();await server.close();}};
}

test('normal exact-image refusal records first divergent stacking causes and opaque identity without new actions',async()=>{
  const f=await setup();try{
    const before=await f.owner.dm.evaluate(()=>({url:location.href,scroll:scrollY,html:document.body.innerHTML}));
    await saveMessagePreviews(f.owner.dm,f.mapping,f.batch,f.root,new AbortController().signal);
    const raw=readFileSync(join(f.root,'evidence','message-preview-latest.json'),'utf8'),report=JSON.parse(raw),sample=report.imageObstructions[0];
    expect(sample).toMatchObject({eventBinding:eventBinding(f.batch.events[0]!),imageIndex:0,phase:'BEFORE',stage:'OVERLAP',
      stack:{relation:'DIVERGENT',truncated:false,commonPrefix:1,foreignFirst:{z:'ZERO',reasons:['TRANSFORM']},
        imageFirst:{z:'ZERO',reasons:['ISOLATION'],parentLayout:'BLOCK',threeD:false},order:'FOREIGN_BEFORE',
        sameParent:false,zOrder:'EQUAL',foreign3D:false,image3D:false}});
    expect(sample.flow.reason).toBe('STACK');
    expect(raw).not.toMatch(/PRIVATE_|99401|conv-a|data:image|https?:\/\//u);
    expect(await f.owner.dm.evaluate(()=>({url:location.href,scroll:scrollY,html:document.body.innerHTML}))).toEqual(before);
    expect(await f.owner.dm.evaluate(()=>Object.getOwnPropertyDescriptor(document,'fixtureGetterCalls')!.value())).toBe(0);
    const direct=await f.owner.dm.evaluate(inspectMessageImage,{mapping:f.mapping,event:f.batch.events[0]!,imageIndex:0,peer:f.mapping.peers[0]!});
    expect(direct.reason).toBe('MESSAGE_PREVIEW_OBSCURED');expect(direct.clip).toBeNull();
  }finally{await f.close();}
});

test.each(['flex','grid'] as const)('divergent sibling contexts report their shared %s parent without treating its order as safe',async layout=>{
  const f=await setup();try{
    await f.owner.dm.evaluate(layout=>{
      const row=document.querySelector('.message') as HTMLElement,foreign=document.querySelector('#PRIVATE_FOREIGN_CONTEXT') as HTMLElement;
      row.parentElement!.style.display=layout;foreign.style.position='fixed';foreign.style.left='0';foreign.style.top='0';row.before(foreign);
    },layout);
    const report=await f.owner.dm.evaluate(inspectMessageImage,{mapping:f.mapping,event:f.batch.events[0]!,imageIndex:0,peer:f.mapping.peers[0]!});
    expect(report.reason).toBe('MESSAGE_PREVIEW_OBSCURED');expect(report.clip).toBeNull();
    expect(report.obstruction?.stack).toMatchObject({relation:'DIVERGENT',truncated:false,sameParent:true,zOrder:'EQUAL',
      foreignFirst:{z:'ZERO',parentLayout:layout.toUpperCase()},imageFirst:{z:'ZERO',parentLayout:layout.toUpperCase()}});
  }finally{await f.close();}
});

test('equal positive z values and an actual 3D transform remain distinct from ordinary zero contexts',async()=>{
  const f=await setup();try{
    await f.owner.dm.evaluate(()=>{
      const row=document.querySelector('.message') as HTMLElement,foreign=document.querySelector('#PRIVATE_FOREIGN_CONTEXT') as HTMLElement;
      row.style.position='relative';row.style.zIndex='5';foreign.style.position='relative';foreign.style.zIndex='5';foreign.style.transform='translateZ(1px)';
    });
    const report=await f.owner.dm.evaluate(inspectMessageImage,{mapping:f.mapping,event:f.batch.events[0]!,imageIndex:0,peer:f.mapping.peers[0]!});
    expect(report.reason).toBe('MESSAGE_PREVIEW_OBSCURED');expect(report.clip).toBeNull();
    expect(report.obstruction?.stack).toMatchObject({relation:'DIVERGENT',truncated:false,zOrder:'EQUAL',foreign3D:true,image3D:false,
      foreignFirst:{z:'POSITIVE',threeD:true,reasons:['POSITIONED_Z','TRANSFORM']},imageFirst:{z:'POSITIVE',threeD:false}});
  }finally{await f.close();}
});

test('diagnostic ancestry truncation is explicit and cannot turn an existing refusal into a preview',async()=>{
  const f=await setup(260);try{
    const report=await f.owner.dm.evaluate(inspectMessageImage,{mapping:f.mapping,event:f.batch.events[0]!,imageIndex:0,peer:f.mapping.peers[0]!});
    expect(report.reason).toBe('MESSAGE_PREVIEW_OBSCURED');expect(report.clip).toBeNull();
    expect(report.obstruction).toMatchObject({stage:'OVERLAP',stack:{relation:'TRUNCATED',truncated:true,commonPrefix:null,
      foreignFirst:null,imageFirst:null,order:'TRUNCATED'}});
    expect(JSON.stringify(report.obstruction)).not.toMatch(/PRIVATE_|99401|conv-a|data:image|https?:\/\//u);
  }finally{await f.close();}
});
