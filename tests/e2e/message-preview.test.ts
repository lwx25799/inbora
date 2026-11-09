import {expect,test,vi} from 'vitest';
import {join} from 'node:path';
import {readdirSync,readFileSync,utimesSync,writeFileSync} from 'node:fs';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {InboxCollector} from '../../src/app/inbox-collector.js';
import {ObservedReader,captureObserved} from '../../src/adapters/observed-reader.js';
import {MessagePreviewStore} from '../../src/storage/message-previews.js';
import {saveMessagePreviews} from '../../src/adapters/message-preview.js';
import {inspectMessageImage} from '../../src/adapters/message-preview.js';
import {EventStore} from '../../src/storage/store.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountObserved,observedMapping} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jntkAAAAASUVORK5CYII=','base64');
async function setup(){
  const server=await fixtureServer(),root=privateTemp('message-preview-'),owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
  const store=new EventStore(join(root,'poc.sqlite'),true),now=Date.now(),origin=now-10_000;
  await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  const data=new AutomationStore(store,()=>now);data.initialize(origin);store.bindAccount('100');
  data.configureCollection({ownId:'100',comments:false,inbox:true,commentIntervalMs:30_000,dmIntervalMs:15_000});
  await mountObserved(owner,server.origin);let requests=0;
  // This suite exercises the screenshot fallback; the native Canvas/CORS route has its own browser regressions.
  await owner.dm.evaluate(()=>{HTMLCanvasElement.prototype.toDataURL=function(){throw new DOMException('Synthetic screenshot fallback','SecurityError');};});
  await owner.dm.route(server.origin+'/preview.png',route=>{requests++;return route.fulfill({contentType:'image/png',body:png});});
  const mapping=observedMapping(server.origin),signal=new AbortController().signal;let collector=new InboxCollector(owner,mapping,data,root,'headless');
  return {root,server,owner,store,data,mapping,signal,origin,get collector(){return collector;},cache:new MessagePreviewStore(root),requests:()=>requests,
    rebuild:()=>{collector.dispose();collector=new InboxCollector(owner,mapping,new AutomationStore(store,()=>now),root,'headless');},
    noExternal:()=>{expect(data.state().startedAt).toBe(origin);expect(store.db.prepare('SELECT kind,used FROM budgets ORDER BY kind').all()).toEqual([{kind:'MODEL',used:0},{kind:'SEND',used:0}]);
      expect(store.db.prepare('SELECT count(*) AS n FROM model_calls').get()).toEqual({n:0});expect(store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});},
    close:async()=>{collector.dispose();store.close();await owner.close();await server.close();}};
}
async function images(f:Awaited<ReturnType<typeof setup>>,specs:{id:string;alt:string|null;source?:string;count?:number;old?:boolean;decoration?:boolean;hidden?:boolean;outgoing?:boolean;width?:number}[]){
  await f.owner.dm.evaluate(({origin,url,specs})=>{
    const chat=document.querySelector('#chat') as HTMLElement;for(const box of chat.querySelectorAll('.box'))box.remove();
    for(const spec of specs){
      const box=document.createElement('div');box.className=spec.outgoing?'box from-me':'box';const row=document.createElement('div');row.className='message';row.style.cssText='min-height:32px;width:320px';box.append(row);
      for(let index=0;index<(spec.count??1);index++){
        const image=document.createElement('img');image.style.cssText='display:inline-block;width:'+(spec.width??24)+'px;height:24px';image.src=spec.source??url;if(spec.alt!==null)image.alt=spec.alt;
        if(spec.hidden)image.style.display='none';
        if(spec.decoration){const menu=document.createElement('div');menu.setAttribute('role','menu');menu.append(image);row.append(menu);}else row.append(image);
      }
      if(spec.hidden){const body=document.createElement('span');body.className='text';body.textContent='visible text';row.append(body);}
      Object.defineProperty(row,'__reactProps$fixture',{value:{children:{props:{message:{serverId:spec.id,conversationId:'conv-a',sender:spec.outgoing?'100':'200',
        createdAt:new Date(origin+(spec.old?-1000:1000)),_parsedContent:{text:spec.hidden?'visible text':''}}}}}});
      const avatar=document.createElement('img');avatar.src=url;avatar.alt='outside-avatar';avatar.style.cssText='width:24px;height:24px';box.prepend(avatar);chat.append(box);
    }
    document.querySelector('#back')!.addEventListener('click',()=>{chat.hidden=true;});document.querySelector('.conversation')!.addEventListener('click',()=>{chat.hidden=false;});chat.hidden=false;
  },{origin:f.origin,url:f.server.origin+'/preview.png',specs});
  await f.owner.dm.locator('#chat img').evaluateAll(nodes=>Promise.all(nodes.map(node=>(node as HTMLImageElement).decode().catch(()=>{}))));
}

test('owned loaded images and emoji have bounded local previews without changing task identity or historical status',async()=>{
  const f=await setup();
  try{
    await images(f,[{id:'9101',alt:'[微笑]\n'},{id:'9102',alt:null},{id:'9103',alt:'old picture',old:true},{id:'9104',alt:'many',count:5}]);
    const requests=f.requests();await f.collector.collect('dm',f.signal);
    expect(f.store.events()).toHaveLength(4);const event=f.store.events().find(item=>item.payload.platformEventId==='9101')!;
    expect(event.status).toBe('MANUAL_REVIEW');expect(event.payload.observationIssue).toBe('DM_CONTENT_UNVERIFIED');
    expect(f.store.events().find(item=>item.payload.platformEventId==='9103')!.status).toBe('BASELINE');
    const attachments=f.cache.list(event.payload,'100');expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({kind:'IMAGE',state:'READY',label:'[微笑]',width:24,height:24});
    expect(attachments[0]!.previewId).toMatch(/^[a-f0-9]{64}$/u);
    const preview=f.cache.read(event.payload,'100',attachments[0]!.previewId!);
    expect(preview.dataUrl).toMatch(/^data:image\/png;base64,/u);expect(Buffer.from(preview.dataUrl.split(',')[1]!,'base64').length).toBeLessThanOrEqual(160*1024);
    expect(f.cache.list(f.store.events().find(item=>item.payload.platformEventId==='9102')!.payload,'100')[0]).toMatchObject({state:'READY',label:null});
    expect(f.cache.list(f.store.events().find(item=>item.payload.platformEventId==='9104')!.payload,'100')).toHaveLength(4);
    expect(f.requests()).toBe(requests);expect(JSON.stringify(attachments)).not.toContain(f.server.origin);
    const folder=join(f.root,'evidence','message-previews'),cacheFiles=readdirSync(folder);
    expect(cacheFiles.every(name=>/^[a-f0-9]{64}\.(?:png|json)$/u.test(name))).toBe(true);
    for(const name of cacheFiles.filter(name=>name.endsWith('.json')))expect(readFileSync(join(folder,name),'utf8')).not.toContain(f.server.origin);
    const ids=f.store.events().map(item=>({id:item.id,binding:item.binding,status:item.status}));f.rebuild();await f.collector.collect('dm',f.signal);
    expect(f.store.events().map(item=>({id:item.id,binding:item.binding,status:item.status}))).toEqual(ids);
    expect(f.cache.list(event.payload,'100')[0]!.previewId).toBe(attachments[0]!.previewId);f.noExternal();
  }finally{await f.close();}
});

test('unsafe sources, decorations and hidden media never become external URLs or the wrong local preview',async()=>{
  const f=await setup();
  try{
    await images(f,[{id:'9201',alt:'unsafe',source:'data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>').toString('base64')},
      {id:'9202',alt:'menu icon',decoration:true},{id:'9203',alt:'hidden',hidden:true}]);
    await f.collector.collect('dm',f.signal);
    const unsafe=f.store.events().find(item=>item.payload.platformEventId==='9201')!,decorative=f.store.events().find(item=>item.payload.platformEventId==='9202')!;
    expect(f.cache.list(unsafe.payload,'100')).toEqual([{previewId:null,kind:'IMAGE',label:'unsafe',state:'UNAVAILABLE',reason:'MESSAGE_PREVIEW_UNSAFE_SOURCE'}]);
    expect(f.cache.list(decorative.payload,'100')).toEqual([{previewId:null,kind:'IMAGE',label:'menu icon',state:'UNAVAILABLE',reason:'MESSAGE_PREVIEW_NOT_CONTENT'}]);
    const hidden=f.store.events().find(item=>item.payload.platformEventId==='9203')!;expect(hidden.payload.contentType).toBeUndefined();expect(f.cache.list(hidden.payload,'100')).toEqual([]);f.noExternal();
  }finally{await f.close();}
});

test('preview reads bind native message and account, reject paths and expire without touching unrelated evidence',async()=>{
  const f=await setup();
  try{
    await images(f,[{id:'9301',alt:'local only'}]);await f.collector.collect('dm',f.signal);
    const event=f.store.events()[0]!.payload,attachment=f.cache.list(event,'100')[0]!,id=attachment.previewId!;
    expect(()=>f.cache.read({...event,platformEventId:'outside'},'100',id)).toThrow('MESSAGE_PREVIEW_UNAVAILABLE');
    expect(()=>f.cache.read(event,'outside',id)).toThrow('MESSAGE_PREVIEW_UNAVAILABLE');expect(()=>f.cache.read(event,'100','../../poc.sqlite')).toThrow('MESSAGE_PREVIEW_UNAVAILABLE');
    const folder=join(f.root,'evidence','message-previews'),manifest=readdirSync(folder).find(name=>name.endsWith('.json'))!;
    const unknown=join(folder,'must-remain.txt');writeFileSync(unknown,'unrelated private fixture');const earlier=new Date(Date.now()-8*86_400_000);utimesSync(join(folder,manifest),earlier,earlier);
    expect(f.cache.list(event,'100')[0]).toMatchObject({state:'READY'}); // Existing default is fourteen days.
    writeFileSync(join(f.root,'runtime.json'),JSON.stringify({version:1,modelGrant:null,evidenceRetentionDays:2}));
    expect(f.cache.list(event,'100')).toEqual([]);expect(()=>f.cache.read(event,'100',id)).toThrow('MESSAGE_PREVIEW_UNAVAILABLE');
    f.rebuild();await f.collector.collect('dm',f.signal);
    expect(f.cache.list(event,'100')[0]).toMatchObject({state:'READY'});expect(readFileSync(unknown,'utf8')).toBe('unrelated private fixture');f.noExternal();
  }finally{await f.close();}
});

test('loaded raster data and same-origin blob previews include exact observed own messages without creating incoming tasks',async()=>{
  const f=await setup();
  try{
    await images(f,[{id:'9501',alt:'data raster',source:'data:image/png;base64,'+png.toString('base64')},{id:'9502',alt:'own picture',outgoing:true}]);
    await f.owner.dm.evaluate(base64=>{
      const bytes=Uint8Array.from(atob(base64),character=>character.charCodeAt(0));
      (document.querySelectorAll('.message img')[1] as HTMLImageElement).src=URL.createObjectURL(new Blob([bytes],{type:'image/png'}));
    },png.toString('base64'));
    await f.owner.dm.locator('.message img').evaluateAll(nodes=>Promise.all(nodes.map(node=>(node as HTMLImageElement).decode())));
    const batch=await new ObservedReader(f.owner.dm,f.mapping).dmWindow(f.mapping.peers[0]!);
    expect(batch.events.map(event=>event.direction)).toEqual(['INCOMING','OUTGOING']);
    await saveMessagePreviews(f.owner.dm,f.mapping,batch,f.root,f.signal);
    for(const event of batch.events){
      const attachment=f.cache.list(event,'100')[0]!;expect(attachment).toMatchObject({state:'READY',width:24,height:24});
      expect(f.cache.read(event,'100',attachment.previewId!).dataUrl).toMatch(/^data:image\/png;base64,/u);
    }
    await f.collector.collect('dm',f.signal);expect(f.store.events().map(event=>event.payload.platformEventId)).toEqual(['9501']);f.noExternal();
  }finally{await f.close();}
});

test('oversized and unloaded body images retain unavailable reasons and source fingerprints never disclose URLs',async()=>{
  const f=await setup();
  try{
    await images(f,[{id:'9601',alt:'large',width:513},{id:'9602',alt:'missing',source:f.server.origin+'/missing-preview.png'}]);
    await f.collector.collect('dm',f.signal);
    expect(f.cache.list(f.store.events()[0]!.payload,'100')[0]).toMatchObject({state:'UNAVAILABLE',reason:'MESSAGE_PREVIEW_TOO_LARGE'});
    expect(f.cache.list(f.store.events()[1]!.payload,'100')[0]).toMatchObject({state:'UNAVAILABLE',reason:'MESSAGE_PREVIEW_NOT_LOADED'});
    await images(f,[{id:'9603',alt:'fingerprint'}]);const batch=await new ObservedReader(f.owner.dm,f.mapping).dmWindow(f.mapping.peers[0]!);
    const proof=await f.owner.dm.evaluate(inspectMessageImage,{mapping:f.mapping,event:batch.events[0]!,imageIndex:0,peer:f.mapping.peers[0]!});
    expect(proof.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/u);expect(JSON.stringify(proof)).not.toContain(f.server.origin);expect(proof).not.toHaveProperty('source');
    await f.owner.dm.evaluate(()=>{
      const row=document.querySelector('.message')!;row.innerHTML='<a href="/card"><div class="unknown-card">unmapped card title</div></a>';
    });
    const cardInput:Parameters<typeof captureObserved>[0]={mapping:f.mapping,channel:'dm',index:0,evidenceId:'synthetic-card',dmWindow:true,peer:f.mapping.peers[0]!};
    await expect(f.owner.dm.evaluate(captureObserved,cardInput))
      .rejects.toThrow('OBSERVATION_DM_CONTENT_DOM_NOT_READY');
    expect(f.store.events().some(event=>event.payload.text.includes('unmapped card'))).toBe(false);f.noExternal();
  }finally{await f.close();}
});

test.each([false,true])('a narrow overlay between the sampled image points cannot leak foreign pixels into a message thumbnail (pointer-free image: %s)',async pointerFree=>{
  const f=await setup();
  try{
    await images(f,[{id:'9701',alt:'exact body'}]);
    await f.owner.dm.evaluate(pointerFree=>{
      if(pointerFree)(document.querySelector('.message img') as HTMLElement).style.pointerEvents='none';
      const bounds=document.querySelector('.message img')!.getBoundingClientRect(),overlay=document.createElement('div');
      overlay.style.cssText='position:fixed;z-index:10000;pointer-events:none;background:red;font-size:1px;width:2px;height:2px;left:'+
        (bounds.left+6)+'px;top:'+(bounds.top+6)+'px';overlay.textContent='foreign';document.body.append(overlay);
    },pointerFree);
    const batch=await new ObservedReader(f.owner.dm,f.mapping).dmWindow(f.mapping.peers[0]!);
    await saveMessagePreviews(f.owner.dm,f.mapping,batch,f.root,f.signal);
    expect(f.cache.list(batch.events[0]!,'100')[0]).toMatchObject({state:'UNAVAILABLE',reason:'MESSAGE_PREVIEW_OBSCURED'});
    expect(JSON.parse(readFileSync(join(f.root,'evidence','message-preview-latest.json'),'utf8')).imageObstructions[0]).toMatchObject({stage:'OVERLAP'});
    expect(readdirSync(join(f.root,'evidence','message-previews')).filter(name=>name.endsWith('.png'))).toEqual([]);f.noExternal();
  }finally{await f.close();}
});

test.each(['POINTER_NONE','NEGATIVE_BACKGROUND'] as const)('an unobscured native image stays previewable with %s',async mode=>{
  const f=await setup();
  try{
    await images(f,[{id:'9811',alt:'exact visible image'}]);
    await f.owner.dm.evaluate(mode=>{
      const image=document.querySelector('.message img') as HTMLElement;
      if(mode==='POINTER_NONE')image.style.pointerEvents='none';
      else{const background=document.createElement('div');background.style.cssText='position:fixed;inset:0;z-index:-1;background:#333';document.body.prepend(background);}
    },mode);
    const batch=await new ObservedReader(f.owner.dm,f.mapping).dmWindow(f.mapping.peers[0]!);
    const inspected=await f.owner.dm.evaluate(inspectMessageImage,{mapping:f.mapping,event:batch.events[0]!,imageIndex:0,peer:f.mapping.peers[0]!});
    expect(inspected.reason).toBeNull();
    await saveMessagePreviews(f.owner.dm,f.mapping,batch,f.root,f.signal);
    expect(f.cache.list(batch.events[0]!,'100')[0]).toMatchObject({state:'READY',width:24,height:24});f.noExternal();
  }finally{await f.close();}
});

test('an exact small native image with uniform pixel-rounded corners stays previewable',async()=>{
  const f=await setup();try{
    await images(f,[{id:'9813',alt:'round native image'}]);
    await f.owner.dm.locator('.message img').evaluate(image=>(image as HTMLElement).style.borderRadius='10px');
    const batch=await new ObservedReader(f.owner.dm,f.mapping).dmWindow(f.mapping.peers[0]!);
    const inspected=await f.owner.dm.evaluate(inspectMessageImage,{mapping:f.mapping,event:batch.events[0]!,imageIndex:0,peer:f.mapping.peers[0]!});
    expect(inspected.reason).toBeNull();
    await saveMessagePreviews(f.owner.dm,f.mapping,batch,f.root,f.signal);
    expect(f.cache.list(batch.events[0]!,'100')[0]).toMatchObject({state:'READY',width:24,height:24});f.noExternal();
  }finally{await f.close();}
});

test.each(['ELEMENT','GENERATED','CLIP','NONUNIFORM'] as const)('rounded geometry cannot hide %s content or unproven clipping',async kind=>{
  const f=await setup();try{
    await images(f,[{id:'9814',alt:'protected rounded image'}]);
    await f.owner.dm.evaluate(kind=>{
      const image=document.querySelector('.message img') as HTMLElement,row=image.closest('.message') as HTMLElement;
      image.style.borderRadius='10px';row.style.position='relative';
      if(kind==='CLIP')image.style.clipPath='inset(2px)';
      else if(kind==='NONUNIFORM')image.style.borderTopRightRadius='0px';
      else if(kind==='GENERATED'){
        const style=document.createElement('style');style.textContent='.message::after{content:"";position:absolute;left:0;top:0;width:2px;height:2px;pointer-events:none;z-index:10;background:red}';document.head.append(style);
      }else{
        const r=image.getBoundingClientRect(),overlay=document.createElement('div');overlay.style.cssText=`position:fixed;z-index:10000;background:red;left:${r.left}px;top:${r.top}px;width:24px;height:24px`;document.body.append(overlay);
      }
    },kind);
    const batch=await new ObservedReader(f.owner.dm,f.mapping).dmWindow(f.mapping.peers[0]!);
    await saveMessagePreviews(f.owner.dm,f.mapping,batch,f.root,f.signal);
    expect(f.cache.list(batch.events[0]!,'100')[0]).toMatchObject({state:'UNAVAILABLE',reason:'MESSAGE_PREVIEW_OBSCURED'});
    expect(readdirSync(join(f.root,'evidence','message-previews')).filter(name=>name.endsWith('.png'))).toEqual([]);f.noExternal();
  }finally{await f.close();}
});

test.each(['ELEMENT','GENERATED'] as const)('a pointer-free image still rejects an opaque %s overlay',async kind=>{
  const f=await setup();
  try{
    await images(f,[{id:'9812',alt:'covered image'}]);
    await f.owner.dm.evaluate(kind=>{
      const image=document.querySelector('.message img') as HTMLElement,row=image.closest('.message') as HTMLElement;
      const renderer=document.createElement('span');renderer.style.cssText='display:inline-block;position:relative;width:24px;height:24px';
      image.replaceWith(renderer);renderer.append(image);image.style.pointerEvents='none';row.style.position='relative';
      if(kind==='GENERATED'){
        const style=document.createElement('style');style.textContent='.message::after{content:"";position:absolute;left:0;top:0;width:24px;height:24px;pointer-events:none;z-index:10;background:red}';document.head.append(style);
      }else{const bounds=image.getBoundingClientRect(),overlay=document.createElement('span');
        overlay.style.cssText=`position:fixed;left:${bounds.left}px;top:${bounds.top}px;width:24px;height:24px;z-index:10;background:red`;
        row.parentElement!.append(overlay);}
    },kind);
    const batch=await new ObservedReader(f.owner.dm,f.mapping).dmWindow(f.mapping.peers[0]!);
    await saveMessagePreviews(f.owner.dm,f.mapping,batch,f.root,f.signal);
    expect(f.cache.list(batch.events[0]!,'100')[0]).toMatchObject({state:'UNAVAILABLE',reason:'MESSAGE_PREVIEW_OBSCURED'});
    expect(readdirSync(join(f.root,'evidence','message-previews')).filter(name=>name.endsWith('.png'))).toEqual([]);f.noExternal();
  }finally{await f.close();}
});

test.each(['SVG','CAPTION'])('an exact message renderer may include its own %s visual control in the bounded preview',async kind=>{
  const f=await setup();try{
    await images(f,[{id:'9819',alt:'owned renderer image'}]);
    await f.owner.dm.evaluate(kind=>{
      const image=document.querySelector('.message img') as HTMLElement,renderer=document.createElement('span');
      renderer.style.cssText='display:inline-block;position:relative;width:24px;height:24px';image.replaceWith(renderer);renderer.append(image);
      const control=kind==='SVG'?document.createElementNS('http://www.w3.org/2000/svg','svg'):document.createElement('span');
      control.setAttribute('style','position:absolute;inset:0;width:24px;height:24px;font-size:8px;z-index:1');
      if(kind==='SVG')control.innerHTML='<circle cx="12" cy="12" r="10" fill="gray"/><path d="M9 7L18 12L9 17Z" fill="white"/>';
      else control.textContent='owned';renderer.append(control);
    },kind);
    const batch=await new ObservedReader(f.owner.dm,f.mapping).dmWindow(f.mapping.peers[0]!);
    await saveMessagePreviews(f.owner.dm,f.mapping,batch,f.root,f.signal);
    expect(f.cache.list(batch.events[0]!,'100')[0]).toMatchObject({state:'READY',width:24,height:24});f.noExternal();
  }finally{await f.close();}
});

test.each(['BODY_CONTROL','NESTED_ZERO_CONTEXT'] as const)('the mapped native message body stays previewable with %s',async shape=>{
  const f=await setup();try{
    await images(f,[{id:'9829',alt:'bound native body'}]);
    await f.owner.dm.evaluate(shape=>{
      const image=document.querySelector('.message img') as HTMLElement,row=image.closest('.message') as HTMLElement;
      if(shape==='BODY_CONTROL'){
        const inner=document.createElement('span');inner.style.cssText='display:inline-block;width:24px;height:24px';image.replaceWith(inner);inner.append(image);
        row.style.position='relative';const control=document.createElement('div');control.style.cssText='position:absolute;left:0;top:0;width:24px;height:24px';
        control.innerHTML='<svg width="24" height="24"><path fill="blue" d="M0 0H24V24H0Z"/></svg>';row.append(control);
      }else{
        const background=document.createElement('div');background.style.cssText='display:block;background:#333;width:24px;height:24px';
        const child=document.createElement('div');child.style.cssText='display:block;height:1px';background.append(child,child.cloneNode());row.before(background);
        row.style.cssText='display:block;transform:translateY(0);margin-top:-24px';
      }
    },shape);
    const batch=await new ObservedReader(f.owner.dm,f.mapping).dmWindow(f.mapping.peers[0]!);
    await saveMessagePreviews(f.owner.dm,f.mapping,batch,f.root,f.signal);
    expect(f.cache.list(batch.events[0]!,'100')[0]).toMatchObject({state:'READY',width:24,height:24});f.noExternal();
  }finally{await f.close();}
});

test.each(['OUTER_MESSAGE_BOX','OTHER_MESSAGE','MENU','HEADER','QUOTE','AVATAR','MODAL'] as const)
  ('renderer ownership never includes %s overlays',async kind=>{
  const f=await setup();try{
    await images(f,[{id:'9820',alt:'guarded renderer image'}]);
    const batch=await new ObservedReader(f.owner.dm,f.mapping).dmWindow(f.mapping.peers[0]!);
    await f.owner.dm.evaluate(kind=>{
      const image=document.querySelector('.message img') as HTMLElement,row=image.closest('.message')!,renderer=document.createElement('span');
      renderer.style.cssText='display:inline-block;position:relative;width:24px;height:24px';image.replaceWith(renderer);renderer.append(image);
      const r=image.getBoundingClientRect(),control=document.createElement(kind==='HEADER'?'header':kind==='QUOTE'?'blockquote':kind==='AVATAR'?'img':'div');
      control.setAttribute('style',`position:fixed;left:${r.left}px;top:${r.top}px;width:24px;height:24px;margin:0;background:red;z-index:10000`);
      if(kind==='OTHER_MESSAGE'){control.className='message';Object.defineProperty(control,'__reactProps$fixture',{value:{children:{props:{message:{serverId:'other-native'}}}}});}
      if(kind==='MENU')control.setAttribute('role','menu');
      if(kind==='MODAL')control.setAttribute('role','dialog');
      if(kind==='OUTER_MESSAGE_BOX')row.parentElement!.append(control);else renderer.append(control);
    },kind);
    const report=await f.owner.dm.evaluate(inspectMessageImage,{mapping:f.mapping,event:batch.events[0]!,imageIndex:0,peer:f.mapping.peers[0]!});
    expect(report.reason).toBe('MESSAGE_PREVIEW_OBSCURED');expect(report.clip).toBeNull();f.noExternal();
  }finally{await f.close();}
});

test.each([false,true])('a flat ordinary block background is drawn below the image while its positioned descendants remain guarded (%s)',async childOverlay=>{
  const f=await setup();try{
    await images(f,[{id:'9821',alt:'image above normal background'}]);
    await f.owner.dm.evaluate(childOverlay=>{
      const image=document.querySelector('.message img')!,row=image.closest('.message')!,background=document.createElement('div'),renderer=document.createElement('span');
      renderer.style.cssText='display:inline-block;width:24px;height:24px';image.replaceWith(renderer);renderer.append(image);
      background.style.cssText='width:24px;height:24px;margin-bottom:-24px;background:red;pointer-events:none';
      background.append(document.createElement('span'),document.createElement('span'));row.before(background);
      if(childOverlay){const r=image.getBoundingClientRect(),child=document.createElement('div');child.style.cssText=`position:fixed;left:${r.left+6}px;top:${r.top+6}px;width:2px;height:2px;background:blue;z-index:10000;pointer-events:none`;background.append(child);}
    },childOverlay);
    const batch=await new ObservedReader(f.owner.dm,f.mapping).dmWindow(f.mapping.peers[0]!);
    const report=await f.owner.dm.evaluate(inspectMessageImage,{mapping:f.mapping,event:batch.events[0]!,imageIndex:0,peer:f.mapping.peers[0]!});
    expect(report.reason).toBe(childOverlay?'MESSAGE_PREVIEW_OBSCURED':null);f.noExternal();
  }finally{await f.close();}
});

test('a static background inside a positioned-auto group cannot masquerade as an earlier ordinary-flow layer',async()=>{
  const f=await setup();try{
    await images(f,[{id:'9822',alt:'protected positioned-group image'}]);
    await f.owner.dm.evaluate(()=>{
      const r=document.querySelector('.message img')!.getBoundingClientRect(),group=document.createElement('div'),background=document.createElement('div');
      group.style.cssText=`position:absolute;left:${r.left}px;top:${r.top}px;width:24px;height:24px;pointer-events:none`;
      background.style.cssText='width:24px;height:24px;background:red;pointer-events:none';group.append(background);document.body.prepend(group);
    });
    const batch=await new ObservedReader(f.owner.dm,f.mapping).dmWindow(f.mapping.peers[0]!);
    const report=await f.owner.dm.evaluate(inspectMessageImage,{mapping:f.mapping,event:batch.events[0]!,imageIndex:0,peer:f.mapping.peers[0]!});
    expect(report.reason).toBe('MESSAGE_PREVIEW_OBSCURED');expect(report.obstruction?.stage).toBe('OVERLAP');f.noExternal();
  }finally{await f.close();}
});

test('hit diagnostics distinguish an image clipped by its exact scrolling ancestor without exposing geometry or identity',async()=>{
  const f=await setup();try{
    await images(f,[{id:'9818',alt:'bound image'}]);
    const batch=await new ObservedReader(f.owner.dm,f.mapping).dmWindow(f.mapping.peers[0]!);
    await f.owner.dm.evaluate(()=>{
      const row=document.querySelector('.message')!,viewport=document.createElement('div');viewport.id='PRIVATE_CLIPPING_IDENTIFIER';
      viewport.style.cssText='position:relative;overflow:hidden;height:20px;width:320px';row.replaceWith(viewport);viewport.append(row);viewport.scrollTop=8;
    });
    const report=await f.owner.dm.evaluate(inspectMessageImage,{mapping:f.mapping,event:batch.events[0]!,imageIndex:0,peer:f.mapping.peers[0]!});
    expect(report.reason).toBe('MESSAGE_PREVIEW_OBSCURED');
    expect(report.obstruction).toMatchObject({stage:'HIT',clipping:{imageInMessageRect:true,imageInChatRect:true,
      hitSameMessage:[true,false,false,true,true],hitInChat:[true,true,true,true,true],overflowAncestorCount:1,truncated:false,
      ancestors:[{index:1,x:true,y:true,containsX:true,containsY:false,pointsOutside:[false,true,true,false,false],sameMessage:false,insideChat:true,transformed:false}]}});
    expect(JSON.stringify(report.obstruction)).not.toMatch(/PRIVATE_|9818|conv-a|bound image|\.message/u);f.noExternal();
  }finally{await f.close();}
});

test.each(['div','span'])('a transparent structural %s has no own paint and its children remain individually checked',async tag=>{
  const f=await setup();try{
    await images(f,[{id:'9816',alt:'exact transparent-wrapper image'}]);
    await f.owner.dm.evaluate(tag=>{
      const image=document.querySelector('.message img') as HTMLElement;image.style.position='relative';
      const r=image.getBoundingClientRect(),wrapper=document.createElement(tag),child=document.createElement('div');
      wrapper.style.cssText=`position:absolute;left:${r.left-10}px;top:${r.top-10}px;width:${r.width+20}px;height:${r.height+20}px`;
      child.style.cssText='position:absolute;left:-5px;top:-5px;width:2px;height:2px;background:red';wrapper.append(child);document.body.prepend(wrapper);
    },tag);
    const batch=await new ObservedReader(f.owner.dm,f.mapping).dmWindow(f.mapping.peers[0]!);
    const inspected=await f.owner.dm.evaluate(inspectMessageImage,{mapping:f.mapping,event:batch.events[0]!,imageIndex:0,peer:f.mapping.peers[0]!});
    expect(inspected.reason,JSON.stringify(inspected.obstruction)).toBeNull();
    await saveMessagePreviews(f.owner.dm,f.mapping,batch,f.root,f.signal);
    expect(f.cache.list(batch.events[0]!,'100')[0]).toMatchObject({state:'READY',width:24,height:24});f.noExternal();
  }finally{await f.close();}
});

test.each(['SCROLLBAR','CSS_CONTENT','BORDER_IMAGE','CHILD_TEXT','CHILD_IMAGE','CHILD_SVG','CHILD_NARROW','PSEUDO','TOP_LAYER'] as const)
  ('transparent structural containers cannot suppress %s paint',async kind=>{
  const f=await setup();try{
    await images(f,[{id:'9817',alt:'protected structural-wrapper image'}]);
    await f.owner.dm.evaluate(({kind,png})=>{
      const image=document.querySelector('.message img') as HTMLElement;image.style.position='relative';
      const r=image.getBoundingClientRect(),wrapper=document.createElement('div');wrapper.id='structural-fixture';
      wrapper.style.cssText=`position:absolute;pointer-events:none;left:${r.left-10}px;top:${r.top-10}px;width:${r.width+20}px;height:${r.height+20}px`;
      if(kind==='SCROLLBAR')wrapper.style.overflow='scroll';
      else if(kind==='TOP_LAYER'){
        wrapper.setAttribute('popover','manual');wrapper.style.cssText+=';margin:0;border:0;padding:0;background:transparent';
        const style=document.createElement('style');style.textContent='#structural-fixture::backdrop{background:red;pointer-events:none}';document.head.append(style);
      }
      else if(kind==='CSS_CONTENT')wrapper.style.content=`url(data:image/png;base64,${png})`;
      else if(kind==='BORDER_IMAGE')wrapper.style.cssText+=';border-image:linear-gradient(red,red) 1 / 4px';
      else if(kind==='PSEUDO'){
        const style=document.createElement('style');style.textContent='#structural-fixture::after{content:"";position:absolute;left:16px;top:16px;width:2px;height:2px;background:red;z-index:10000}';document.head.append(style);
      }else{
        const child=kind==='CHILD_SVG'?document.createElementNS('http://www.w3.org/2000/svg','svg'):document.createElement(kind==='CHILD_IMAGE'?'img':'div');
        child.setAttribute('style','position:absolute;left:16px;top:16px;width:2px;height:2px;font-size:2px;z-index:10000;pointer-events:none');
        if(kind==='CHILD_TEXT')child.textContent='foreign';
        if(kind==='CHILD_IMAGE')child.setAttribute('src',`data:image/png;base64,${png}`);
        if(kind==='CHILD_NARROW')(child as HTMLElement).style.background='red';
        if(kind==='CHILD_SVG')child.innerHTML='<rect width="2" height="2" fill="red"/>';
        wrapper.append(child);
      }
      document.body.prepend(wrapper);if(kind==='TOP_LAYER')wrapper.showPopover();
    },{kind,png:png.toString('base64')});
    const batch=await new ObservedReader(f.owner.dm,f.mapping).dmWindow(f.mapping.peers[0]!);
    const inspected=await f.owner.dm.evaluate(inspectMessageImage,{mapping:f.mapping,event:batch.events[0]!,imageIndex:0,peer:f.mapping.peers[0]!});
    expect(inspected.reason).toBe('MESSAGE_PREVIEW_OBSCURED');expect(inspected.clip).toBeNull();f.noExternal();
  }finally{await f.close();}
});

test('overlap diagnostics expose bounded paint indicators without foreign text, source or attributes',async()=>{
  const f=await setup();try{
    await images(f,[{id:'9815',alt:'bound image'}]);
    await f.owner.dm.evaluate(()=>{
      const r=document.querySelector('.message img')!.getBoundingClientRect(),wrapper=document.createElement('section');
      wrapper.id='PRIVATE_FOREIGN_IDENTIFIER';wrapper.style.cssText=`position:absolute;left:${r.left+6}px;top:${r.top+6}px;width:2px;height:2px;pointer-events:none`;
      document.body.append(wrapper);
    });
    const batch=await new ObservedReader(f.owner.dm,f.mapping).dmWindow(f.mapping.peers[0]!);
    const report=await f.owner.dm.evaluate(inspectMessageImage,{mapping:f.mapping,event:batch.events[0]!,imageIndex:0,peer:f.mapping.peers[0]!});
    expect(report.reason).toBe('MESSAGE_PREVIEW_OBSCURED');
    expect(report.obstruction).toMatchObject({stage:'OVERLAP',paint:{backgroundTransparent:true,backgroundImage:false,borderWidths:false,borderStyles:false,
      shadow:false,outline:false,filter:false,backdrop:false,mask:false,directText:false,pseudo:false,childCount:0,insideImage:true,coversImage:false,beforeImage:false,
      scrollbar:false,replacementContent:false,borderImage:false,textShadow:false,textDecoration:false,appearance:false,reflection:false,topLayer:false,structuralDisplay:true}});
    expect(JSON.stringify(report)).not.toContain('PRIVATE_');f.noExternal();
  }finally{await f.close();}
});

test.each([false,true])('an exact image above an explicit background remains usable, including normal clickable wrappers (%s)',async clickable=>{
  const f=await setup();
  try{
    await images(f,[{id:'9801',alt:'foreground image'}]);
    await f.owner.dm.evaluate(clickable=>{
      const background=document.createElement('div');background.style.cssText='position:fixed;inset:0;z-index:0;background:#333';document.body.prepend(background);
      (document.querySelector('#dm-panel') as HTMLElement).style.cssText='position:relative;z-index:50';
      if(clickable){const image=document.querySelector('.message img')!,button=document.createElement('button');
        button.setAttribute('role','button');image.replaceWith(button);button.append(image);}
    },clickable);
    const batch=await new ObservedReader(f.owner.dm,f.mapping).dmWindow(f.mapping.peers[0]!);
    await saveMessagePreviews(f.owner.dm,f.mapping,batch,f.root,f.signal);
    expect(f.cache.list(batch.events[0]!,'100')[0]).toMatchObject({state:'READY',width:24,height:24});f.noExternal();
  }finally{await f.close();}
});

test.each(['NATIVE_ID','SOURCE','CLIP'] as const)('a target %s change during capture discards pixels instead of binding them to the previous message',async change=>{
  const f=await setup();
  try{
    await images(f,[{id:'9401',alt:'bound image'}]);const batch=await new ObservedReader(f.owner.dm,f.mapping).dmWindow(f.mapping.peers[0]!);
    const original=f.owner.dm.screenshot.bind(f.owner.dm),screenshot=vi.spyOn(f.owner.dm,'screenshot').mockImplementation(async options=>{
      const bytes=await original(options);await f.owner.dm.evaluate(async({change,png})=>{
        const native=Object.getOwnPropertyDescriptor(document.querySelector('.message')!,'__reactProps$fixture')!.value.children.props.message;
        const image=document.querySelector('.message img') as HTMLImageElement;
        if(change==='NATIVE_ID')native.serverId='changed';
        if(change==='SOURCE'){image.src='data:image/png;base64,'+png;await image.decode();}
        if(change==='CLIP')image.style.marginLeft='1px';
      },{change,png:png.toString('base64')});return bytes;
    });
    await saveMessagePreviews(f.owner.dm,f.mapping,batch,f.root,f.signal);screenshot.mockRestore();
    expect(f.cache.list(batch.events[0]!,'100')).toEqual([{previewId:null,kind:'IMAGE',label:'bound image',state:'UNAVAILABLE',
      reason:change==='NATIVE_ID'?'MESSAGE_PREVIEW_CAPTURE_FAILED':'MESSAGE_PREVIEW_TARGET_CHANGED'}]);
    expect(readdirSync(join(f.root,'evidence','message-previews')).filter(name=>name.endsWith('.png'))).toEqual([]);f.noExternal();
  }finally{await f.close();}
});

test.each(['DATA','ACCESSOR','CONFLICT'] as const)('native inherited conversation values reuse the calibrated reader data contract (%s)',async mode=>{
  const f=await setup();
  try{
    await images(f,[{id:'9903',alt:'native prototype image'}]);
    const batch=await new ObservedReader(f.owner.dm,f.mapping).dmWindow(f.mapping.peers[0]!);
    await f.owner.dm.evaluate(mode=>{
      const conversation=Object.getOwnPropertyDescriptor(document.querySelector('#header')!,'__reactProps$fixture')!.value.children.props.conversation;
      const prototype={};
      Object.defineProperty(prototype,'id',mode==='ACCESSOR'?{get(){throw Error('getter must not run');}}:{value:mode==='CONFLICT'?'different-native':'conv-a'});
      Object.setPrototypeOf(conversation,prototype);if(mode!=='CONFLICT')delete conversation.id;
    },mode);
    const inspecting=f.owner.dm.evaluate(inspectMessageImage,{mapping:f.mapping,event:batch.events[0]!,imageIndex:0,peer:f.mapping.peers[0]!});
    if(mode==='DATA')expect(await inspecting).toMatchObject({reason:null,count:1});
    else await expect(inspecting).rejects.toThrow('MESSAGE_PREVIEW_INSPECT_ID_FAILED');
  }finally{await f.close();}
});
