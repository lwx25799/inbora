import {expect,test} from 'vitest';
import {rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {Page} from 'playwright';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {ClientService} from '../../src/app/service.js';
import {CollectionScheduler} from '../../src/app/collection-scheduler.js';
import {ObservedReader,captureObserved} from '../../src/adapters/observed-reader.js';
import {captureCommentThread} from '../../src/adapters/comment-thread-capture.js';
import {ObservedDmReply} from '../../src/adapters/observed-dm-reply.js';
import {ObservedCommentReply} from '../../src/adapters/observed-comment-reply.js';
import {DomAdapter} from '../../src/adapters/dom-adapter.js';
import {captureAndGuard} from '../../src/adapters/click-guard.js';
import {inspectMessageImage} from '../../src/adapters/message-preview.js';
import {inspectMessageShare} from '../../src/adapters/message-share.js';
import {visibleStoredMessage} from '../../src/adapters/message-view-location.js';
import {observedSecurityBlockers} from '../../src/config/site-mapping.js';
import {EventStore} from '../../src/storage/store.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {dmReplyMapping,commentReplyMapping,mountDmReply,mountCommentReply} from '../fixtures/observed-site.js';
import {html,mapping,rowData} from '../fixtures/site.js';
import {privateTemp} from '../helpers.js';

type Shape='zero'|'zero-width'|'zero-height'|'hidden-ancestor'|'hidden-child'|'clipped-hidden'|'clipped-clip'|'partial-clip'|'scaled-clip'|
  'visible'|'visible-child'|'visible-text'|'contents'|'contents-clip'|'offscreen';
async function safetyShape(page:Page,shape:Shape):Promise<{rects:number;width:number;height:number}> {
  return page.evaluate(shape=>{
    document.querySelector('#synthetic-security-root')?.remove();
    const root=document.createElement('section');root.id='synthetic-security-root';
    const node=document.createElement('div');node.id='captcha_container_fixture';
    node.style.cssText='position:relative;width:0;height:0;padding:0;border:0;overflow:visible';
    if(shape==='zero-width')node.style.height='40px';
    if(shape==='zero-height')node.style.width='40px';
    if(shape==='visible'||shape==='offscreen'||shape==='hidden-ancestor')node.style.cssText='width:320px;height:180px';
    if(shape==='hidden-ancestor')root.style.opacity='0';
    if(shape==='offscreen')node.style.cssText+=';position:fixed;left:-2000px;top:0';
    if(shape==='visible-text')node.textContent='Synthetic challenge';
    if(shape==='contents'||shape==='contents-clip')node.style.display='contents';
    if(shape==='clipped-hidden'||shape==='partial-clip'||shape==='contents-clip')node.style.overflow='hidden';
    if(shape==='clipped-clip')node.style.overflow='clip';
    if(shape==='partial-clip'){node.style.width='10px';node.style.height='10px';}
    if(shape==='scaled-clip'){
      root.style.cssText='position:absolute;left:10px;top:10px;width:100px;height:100px;overflow:hidden;transform:scale(2);transform-origin:0 0';
      node.style.cssText='position:absolute;left:80px;top:0;width:20px;height:20px';
    }
    if(['visible-child','contents','contents-clip','hidden-child','clipped-hidden','clipped-clip','partial-clip'].includes(shape)){
      const child=document.createElement('div');child.textContent='Synthetic challenge';
      child.style.cssText='position:absolute;width:320px;height:180px;top:0;left:0';
      if(shape==='hidden-child')child.style.display='none';node.append(child);
    }
    root.append(node);document.body.append(root);const rect=node.getBoundingClientRect();
    return {rects:node.getClientRects().length,width:rect.width,height:rect.height};
  },shape);
}
async function fixture(){
  const root=privateTemp('security-placeholder-'),origin='https://www.douyin.com';
  const owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
  // All requests, including fixture initialization, stay local; the real Profile is never opened.
  await owner.context.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Synthetic security fixture</title>'}));
  await mountDmReply(owner,origin);await mountCommentReply(owner,origin);
  const dm=dmReplyMapping(origin),comment=commentReplyMapping(origin);
  for(const mapping of [dm,comment])mapping.observation.securityBlockers=observedSecurityBlockers;
  const dmBatch=await new ObservedReader(owner.dm,dm.observation).dm(0);
  const comments=await owner.notification.evaluate(captureObserved,{mapping:comment.observation,channel:'comments' as const,index:0,evidenceId:'synthetic'});
  const dmAdapter=new ObservedDmReply(owner.dm,dm,250),commentAdapter=new ObservedCommentReply(owner.notification,comment,250);
  return {root,origin,owner,dm,comment,dmEvent:dmBatch.events[0]!,commentEvent:comments.events[0]!,dmAdapter,commentAdapter,
    close:async()=>{dmAdapter.dispose();commentAdapter.dispose();await owner.close();await rm(root,{recursive:true});}};
}

test('invisible captcha placeholders pass reads and reply checks; rendered challenges still block every path',async()=>{
  const f=await fixture();
  try{
    for(const shape of ['zero','zero-width','zero-height','hidden-ancestor','hidden-child','clipped-hidden','clipped-clip','partial-clip','scaled-clip',
      'visible','visible-child','visible-text','contents','contents-clip','offscreen'] as const){
      const blocked=['visible','visible-child','visible-text','contents','contents-clip','offscreen','partial-clip','scaled-clip'].includes(shape);
      const rect=await safetyShape(f.owner.notification,shape);await safetyShape(f.owner.dm,shape);
      if(shape==='zero')expect(rect).toEqual({rects:1,width:0,height:0});
      if(shape==='contents')expect(rect.rects).toBe(0);
      const checks=[
        ()=>new ObservedReader(f.owner.notification,f.comment.observation).guard(),
        ()=>new ObservedReader(f.owner.dm,f.dm.observation).guard(),
        ()=>f.owner.notification.evaluate(captureCommentThread,{mapping:f.comment.observation,event:f.commentEvent,action:'inspect' as const,offset:0}),
        ()=>f.dmAdapter.inspect(f.dmEvent),
        ()=>f.commentAdapter.inspect(f.commentEvent),
      ];
      for(const [index,check] of checks.entries()){
        if(blocked)await expect(check(),`${shape} check ${index}`).rejects.toThrow(index===4?'COMMENT_REPLY_PAGE_BLOCKED':'OBSERVATION_SECURITY_COMPONENT');
        else await expect(check().then(()=>true),`${shape} check ${index}`).resolves.toBe(true);
      }
    }
    for(const shape of ['zero','hidden-ancestor','visible','visible-child','contents'] as const){
      const blocked=['visible','visible-child','contents'].includes(shape);
      for(const page of [f.owner.notification,f.owner.dm]){
        await safetyShape(page,shape);
        await page.evaluate(()=>{const node=document.querySelector('[id^="captcha_container"]')!;node.id='synthetic-reply-blocker';node.setAttribute('role','dialog');});
      }
      for(const [index,check] of [()=>f.dmAdapter.inspect(f.dmEvent),()=>f.commentAdapter.inspect(f.commentEvent)].entries()){
        if(blocked)await expect(check()).rejects.toThrow(index===0?'NATIVE_REPLY_PAGE_BLOCKED':'COMMENT_REPLY_PAGE_BLOCKED');
        else await expect(check().then(()=>true)).resolves.toBe(true);
      }
    }
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
    expect(await f.owner.notification.evaluate(()=>(window as unknown as {commentClicks:number}).commentClicks)).toBe(0);
  }finally{await f.close();}
},30_000);

test('collection and explicit recovery ignore captcha shells without weakening a real verification stop',async()=>{
  const f=await fixture();let store:EventStore|undefined,service:ClientService|undefined,scheduler:CollectionScheduler|undefined;
  try{
    f.dm.observation.environment='douyin';f.comment.observation=f.dm.observation;
    await Promise.all([
      writeFile(join(f.root,'observation-mapping.json'),JSON.stringify(f.dm.observation)),
      writeFile(join(f.root,'dm-reply-mapping.json'),JSON.stringify(f.dm)),
      writeFile(join(f.root,'comment-reply-mapping.json'),JSON.stringify(f.comment)),
    ]);
    store=new EventStore(join(f.root,'poc.sqlite'),true);await migrateClient(store,join(f.root,'backup.sqlite'));store.bindAccount('100');
    const browser=BrowserService.adopt(f.root,f.owner,'headless');service=new ClientService(store,browser);await service.loadSettings();
    const token=service.authority.issueSession(),data=new AutomationStore(store);
    data.configureCollection({ownId:'100',comments:true,inbox:true,commentIntervalMs:15_000,dmIntervalMs:15_000});
    scheduler=new CollectionScheduler(data,async()=>new ObservedReader(f.owner.notification,f.comment.observation).guard());
    await safetyShape(f.owner.notification,'zero');await safetyShape(f.owner.dm,'zero-width');
    await expect(scheduler.runNow('works')).resolves.toEqual({deferredCode:null});
    expect(data.state().emergencyStopped).toBe(false);
    await service.dispatch(token,{command:'emergencyStop'});
    await expect(service.dispatch(token,{command:'resume',eventId:null})).resolves.toMatchObject({automation:{emergencyStopped:false}});
    await safetyShape(f.owner.notification,'visible');
    await expect(scheduler.runNow('works')).rejects.toThrow('OBSERVATION_SECURITY_COMPONENT');
    expect(data.state()).toMatchObject({emergencyStopped:true,emergencyStop:{source:'COLLECTION_COMMENTS',reason:'OBSERVATION_SECURITY_COMPONENT'}});
    await expect(service.dispatch(token,{command:'resume',eventId:null})).rejects.toThrow('OBSERVATION_SECURITY_COMPONENT');
    expect(data.state().emergencyStopped).toBe(true);
    await safetyShape(f.owner.notification,'contents');
    await f.owner.notification.evaluate(()=>{const node=document.querySelector('[id^="captcha_container"]')!;node.id='synthetic-reply-blocker';node.setAttribute('role','dialog');});
    await expect(service.dispatch(token,{command:'resume',eventId:null})).rejects.toThrow('OBSERVATION_SECURITY_COMPONENT');
    expect(data.state().emergencyStopped).toBe(true);
    await safetyShape(f.owner.notification,'zero-height');
    await f.owner.notification.evaluate(()=>{const node=document.querySelector('[id^="captcha_container"]')!;node.id='synthetic-reply-blocker';node.setAttribute('role','dialog');});
    await expect(service.dispatch(token,{command:'resume',eventId:null})).resolves.toMatchObject({automation:{emergencyStopped:false}});
    expect(store.db.prepare('SELECT count(*) AS n FROM model_calls').get()).toEqual({n:0});
    expect(store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
  }finally{await scheduler?.close();await service?.close();store?.close();await f.close();}
},30_000);

test('legacy login, challenge and stop checks agree with their final synchronous DOM gate',async()=>{
  const root=privateTemp('security-placeholder-legacy-'),origin='https://www.douyin.com';
  const owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
  try{
    await owner.context.route('**/*',route=>route.fulfill({contentType:'text/html',body:html}));await owner.open(origin);
    const config=mapping(origin),adapter=new DomAdapter(owner.dm,'DIRECT_MESSAGE',config);
    await adapter.openDm();
    await owner.dm.evaluate(value=>(window as unknown as {addDm:(id:string,event:unknown)=>void}).addDm('conversation-1',value),rowData('dm'));
    const event=(await adapter.observeDm('conversation-1','peer-1')).events[0]!;
    for(const [guard,code] of [['loginRequired','LOGIN_REQUIRED'],['challenge','CHALLENGE_REQUIRED'],['stopped','PLATFORM_STOP']] as const){
      const scoped=structuredClone(config);scoped.guards[guard]=observedSecurityBlockers;
      const current=new DomAdapter(owner.dm,'DIRECT_MESSAGE',scoped);
      for(const shape of ['zero','hidden-ancestor','visible-child','contents','scaled-clip'] as const){
        await safetyShape(owner.dm,shape);const blocked=shape==='visible-child'||shape==='contents'||shape==='scaled-clip';
        const capture=()=>owner.dm.evaluate(captureAndGuard,{mapping:scoped,channel:'DIRECT_MESSAGE' as const,event,text:null,token:null});
        if(blocked){await expect(current.guard()).rejects.toThrow(code);await expect(capture()).rejects.toThrow('CLICK_DOM_GUARD_BLOCKED');}
        else{await expect(current.guard()).resolves.toBeUndefined();await expect(capture()).resolves.toMatchObject({targetKey:'dm:conversation-1'});}
      }
    }
    expect(await owner.dm.evaluate(()=>(window as unknown as {clicks:number}).clicks)).toBe(0);
  }finally{await owner.close();await rm(root,{recursive:true});}
},30_000);

test('preview, share and stored-message views use rendered safety geometry before reading the exact native message',async()=>{
  const f=await fixture();
  try{
    const input={mapping:f.dm.observation,event:f.dmEvent,peer:f.dm.observation.peers[0]!};
    for(const shape of ['zero','clipped-hidden','clipped-clip','partial-clip','visible-child','contents-clip','offscreen','scaled-clip'] as const){
      await safetyShape(f.owner.dm,shape);
      const blocked=['partial-clip','visible-child','contents-clip','offscreen','scaled-clip'].includes(shape);
      const preview=()=>f.owner.dm.evaluate(inspectMessageImage,{...input,imageIndex:0});
      const share=()=>f.owner.dm.evaluate(inspectMessageShare,input);
      const view=()=>f.owner.dm.evaluate(visibleStoredMessage,input);
      if(blocked){
        await expect(preview()).rejects.toThrow('MESSAGE_PREVIEW_INSPECT_ENVIRONMENT_FAILED');
        await expect(share()).rejects.toThrow('MESSAGE_SHARE_TARGET_CHANGED');
        await expect(view()).rejects.toThrow('MESSAGE_VIEW_TARGET_CHANGED');
      }else{
        await expect(preview()).resolves.toMatchObject({count:0,reason:'MESSAGE_PREVIEW_NOT_AVAILABLE'});
        await expect(share()).resolves.toMatchObject({share:null,detected:false});
        await expect(view()).resolves.toBe(true);
      }
    }
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
  }finally{await f.close();}
},30_000);
