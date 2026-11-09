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

test('a narrow overlay between the sampled image points cannot leak foreign pixels into a message thumbnail',async()=>{
  const f=await setup();
  try{
    await images(f,[{id:'9701',alt:'exact body'}]);
    await f.owner.dm.evaluate(()=>{
      const bounds=document.querySelector('.message img')!.getBoundingClientRect(),overlay=document.createElement('div');
      overlay.style.cssText='position:fixed;z-index:10000;pointer-events:none;background:red;font-size:1px;width:2px;height:2px;left:'+
        (bounds.left+6)+'px;top:'+(bounds.top+6)+'px';overlay.textContent='foreign';document.body.append(overlay);
    });
    const batch=await new ObservedReader(f.owner.dm,f.mapping).dmWindow(f.mapping.peers[0]!);
    await saveMessagePreviews(f.owner.dm,f.mapping,batch,f.root,f.signal);
    expect(f.cache.list(batch.events[0]!,'100')[0]).toMatchObject({state:'UNAVAILABLE',reason:'MESSAGE_PREVIEW_OBSCURED'});
    expect(readdirSync(join(f.root,'evidence','message-previews')).filter(name=>name.endsWith('.png'))).toEqual([]);f.noExternal();
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

test('a target change during capture discards pixels instead of binding them to the previous message',async()=>{
  const f=await setup();
  try{
    await images(f,[{id:'9401',alt:'bound image'}]);const batch=await new ObservedReader(f.owner.dm,f.mapping).dmWindow(f.mapping.peers[0]!);
    const original=f.owner.dm.screenshot.bind(f.owner.dm),screenshot=vi.spyOn(f.owner.dm,'screenshot').mockImplementation(async options=>{
      const bytes=await original(options);await f.owner.dm.evaluate(()=>{
        const native=Object.getOwnPropertyDescriptor(document.querySelector('.message')!,'__reactProps$fixture')!.value.children.props.message;native.serverId='changed';
      });return bytes;
    });
    await saveMessagePreviews(f.owner.dm,f.mapping,batch,f.root,f.signal);screenshot.mockRestore();
    expect(f.cache.list(batch.events[0]!,'100')).toEqual([{previewId:null,kind:'IMAGE',label:'bound image',state:'UNAVAILABLE',reason:'MESSAGE_PREVIEW_CAPTURE_FAILED'}]);
    expect(readdirSync(join(f.root,'evidence','message-previews')).filter(name=>name.endsWith('.png'))).toEqual([]);f.noExternal();
  }finally{await f.close();}
});
