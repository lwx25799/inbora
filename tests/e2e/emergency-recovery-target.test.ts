import {expect,test} from 'vitest';
import {readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {observedSecurityBlockers} from '../../src/config/site-mapping.js';
import {observedMapping} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';
import {EventStore} from '../../src/storage/store.js';
import {readSecurityHold} from '../../src/storage/security-holds.js';

async function fixture(withSafety=false){
  const root=privateTemp('emergency-recovery-target-'),origin='https://www.douyin.com';
  const entry=origin+'/user/self',work=origin+'/video/10';
  const config={...observedMapping(origin),entryUrl:entry,environment:'douyin' as const,securityBlockers:observedSecurityBlockers};
  await writeFile(join(root,'observation-mapping.json'),JSON.stringify(config));
  const owners:BrowserProfileOwner[]=[],requestedModes:boolean[]=[],navigations:string[][]=[];
  let headedChallenge=true,headlessChallenge=true;
  const launch=async(profile:string,headless:boolean)=>{
    requestedModes.push(headless);
    // Exercise real Page replacement and browser lifecycle without opening any visible desktop window.
    const owner=await BrowserProfileOwner.launch(profile,true);owners.push(owner);const visits:string[]=[];navigations.push(visits);
    await owner.context.route('**/*',route=>{
      const url=new URL(route.request().url()),challenge=url.pathname==='/video/10'&&(headless?headlessChallenge:headedChallenge);
      if(route.request().isNavigationRequest()&&!route.request().frame().parentFrame())visits.push(url.href);
      return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:
        '<!doctype html><title>Synthetic recovery target</title><a id="self">Synthetic account</a>'+
        '<script>Object.defineProperty(document.querySelector("#self"),"__reactFiber$fixture",{value:{return:{memoizedProps:{uid:"100",secUid:"self-sec"}}}});</script>'+
        (challenge?'<div id="captcha_container" style="position:fixed;inset:0;background:rgba(0,0,0,.6)">'+
          '<iframe src="https://rmc.bytedance.com/synthetic-verification" style="width:380px;height:348px;border:0" title="Synthetic verification"></iframe></div>':'')});
    });
    return owner;
  };
  const store=new EventStore(join(root,'poc.sqlite'),true);store.bindAccount('100');
  const browser=new BrowserService(root,launch);if(withSafety)browser.bindStore(store);
  return {root,entry,work,config,owners,requestedModes,navigations,launch,browser,store,
    get current(){return owners.at(-1)!;},
    clearHeaded:async()=>{headedChallenge=false;await owners.at(-1)!.notification.evaluate(()=>document.querySelector('#captcha_container')?.remove());},
    clearHeadless:async()=>{headlessChallenge=false;await owners.at(-1)!.notification.evaluate(()=>document.querySelector('#captcha_container')?.remove());},
    close:async()=>{await browser.close();await Promise.allSettled(owners.map(owner=>owner.close()));store.close();await rm(root,{recursive:true});}};
}

test('explicit login handling restores a held work in new documents while an ordinary reopen leaves it parked',async()=>{
  const f=await fixture(true);let restarted:BrowserService|undefined;
  try{
    await f.browser.open();await f.current.notification.goto(f.work);
    const original=f.current.notification;
    await original.evaluate(()=>{document.documentElement.dataset.originalDocument='synthetic-original';});
    await expect(f.browser.actor.run(()=>new ObservedReader(original,f.config).guard())).rejects.toThrow('OBSERVATION_SECURITY_SUSPECT');
    const held=readSecurityHold(f.store,'COMMENT_NOTIFICATION');expect(held).not.toBeNull();
    await original.evaluate(()=>{const editor=document.createElement('textarea');editor.id='synthetic-human-input';editor.value='保留原网页人稿';document.body.append(editor);});
    await expect(f.browser.beginLoginRecovery(false)).rejects.toThrow('BROWSER_HAS_HUMAN_INPUT');
    expect(f.owners).toHaveLength(1);expect(original.isClosed()).toBe(false);
    expect(await original.locator('#synthetic-human-input').inputValue()).toBe('保留原网页人稿');
    await original.locator('#synthetic-human-input').evaluate(editor=>editor.remove());
    await f.browser.beginLoginRecovery(false);
    expect(f.current.notification.url()).toBe(f.work);
    expect(original.isClosed()).toBe(true);expect(f.current.notification).not.toBe(original);
    expect(await f.current.notification.evaluate(()=>document.documentElement.dataset.originalDocument)).toBeUndefined();
    const headed=f.current.notification;
    expect(await f.browser.finishLoginRecovery()).toBe(true);expect(f.current.notification.url()).toBe(f.work);
    expect(headed.isClosed()).toBe(true);expect(f.current.notification).not.toBe(headed);
    expect(readSecurityHold(f.store,'COMMENT_NOTIFICATION')?.revision).toBe(held!.revision);
    await f.browser.close();
    restarted=new BrowserService(f.root,f.launch);restarted.bindStore(f.store);await restarted.open();
    expect(f.current.notification.url()).toBe(f.entry);expect(f.navigations.at(-1)).not.toContain(f.work);
    expect(readSecurityHold(f.store,'COMMENT_NOTIFICATION')?.revision).toBe(held!.revision);
  }finally{await restarted?.close();await f.close();}
},30_000);

test('the first non-collector candidate persists its current work over an older saved recovery location',async()=>{
  const f=await fixture(true);let restarted:BrowserService|undefined;
  try{
    const saved=join(f.root,'browser-recovery-locations.json');
    await writeFile(saved,JSON.stringify({version:1,ownId:'100',notification:f.entry,dm:f.entry}));
    await f.browser.open();await f.current.notification.goto(f.work);
    await expect(f.browser.actor.run(()=>new ObservedReader(f.current.notification,f.config).guard())).rejects.toThrow('OBSERVATION_SECURITY_SUSPECT');
    expect(JSON.parse(await readFile(saved,'utf8'))).toMatchObject({notification:f.work,dm:f.entry});
    const first=readSecurityHold(f.store,'COMMENT_NOTIFICATION');
    await f.current.notification.goto(f.entry);
    await f.current.notification.evaluate(()=>{const node=document.createElement('div');node.id='captcha_container';
      node.style.cssText='position:fixed;inset:0;background:#eee';
      node.innerHTML='<iframe src="https://rmc.bytedance.com/synthetic-verification" style="width:380px;height:348px" title="Synthetic verification"></iframe>';
      document.body.append(node);});
    await expect(f.browser.actor.run(()=>new ObservedReader(f.current.notification,f.config).guard())).rejects.toThrow('OBSERVATION_SECURITY_SUSPECT');
    expect(readSecurityHold(f.store,'COMMENT_NOTIFICATION')?.revision).toBe(first!.revision);
    expect(JSON.parse(await readFile(saved,'utf8'))).toMatchObject({notification:f.work,dm:f.entry});
    await f.browser.close();restarted=new BrowserService(f.root,f.launch);restarted.bindStore(f.store);await restarted.open();
    expect(f.current.notification.url()).toBe(f.entry);
    await restarted.beginLoginRecovery(false);expect(f.current.notification.url()).toBe(f.work);
  }finally{await restarted?.close();await f.close();}
},30_000);

test('a second channel candidate does not replace a held work with the ordinary reopen entry page',async()=>{
  const f=await fixture(true);let restarted:BrowserService|undefined;
  try{
    await f.browser.open();await f.current.notification.goto(f.work);
    await expect(f.browser.actor.run(()=>new ObservedReader(f.current.notification,f.config).guard())).rejects.toThrow('OBSERVATION_SECURITY_SUSPECT');
    const commentHold=readSecurityHold(f.store,'COMMENT_NOTIFICATION');expect(commentHold).not.toBeNull();
    await f.browser.close();restarted=new BrowserService(f.root,f.launch);restarted.bindStore(f.store);await restarted.open();
    expect(f.current.notification.url()).toBe(f.entry);
    await f.current.dm.evaluate(()=>{const node=document.createElement('div');node.id='captcha_container';
      node.style.cssText='position:fixed;inset:0;background:#eee';
      node.innerHTML='<iframe src="https://rmc.bytedance.com/synthetic-verification" style="width:380px;height:348px" title="Synthetic verification"></iframe>';
      document.body.append(node);});
    await expect(restarted.actor.run(()=>new ObservedReader(f.current.dm,f.config).guard())).rejects.toThrow('OBSERVATION_SECURITY_SUSPECT');
    expect(readSecurityHold(f.store,'DIRECT_MESSAGE')).not.toBeNull();
    expect(JSON.parse(await readFile(join(f.root,'browser-recovery-locations.json'),'utf8'))).toMatchObject({notification:f.work,dm:f.entry});
    await restarted.beginLoginRecovery(false);expect(f.current.notification.url()).toBe(f.work);expect(f.current.dm.url()).toBe(f.entry);
    expect(readSecurityHold(f.store,'COMMENT_NOTIFICATION')?.revision).toBe(commentHold!.revision);
  }finally{await restarted?.close();await f.close();}
},30_000);

test('login handling preserves the failing work and rechecks that target after returning headless',async()=>{
  const f=await fixture();
  try{
    await f.browser.open();await f.current.notification.goto(f.work+'?from=synthetic#fragment');await f.current.dm.goto(f.entry+'?from=synthetic#fragment');
    await expect(new ObservedReader(f.current.notification,f.config).guard()).rejects.toThrow('OBSERVATION_SECURITY_SUSPECT');
    await expect(new ObservedReader(f.current.dm,f.config).guard()).resolves.toBeUndefined();
    await f.browser.beginLoginRecovery(false);
    expect(f.requestedModes).toEqual([true,false]);
    expect(f.current.notification.url()).toBe(f.work);expect(f.current.dm.url()).toBe(f.entry);
    expect(await f.current.notification.locator('#captcha_container').count()).toBe(1);
    await f.clearHeaded();
    await expect(new ObservedReader(f.current.notification,f.config).guard()).resolves.toBeUndefined();
    expect(await f.browser.finishLoginRecovery()).toBe(true);
    expect(f.requestedModes).toEqual([true,false,true]);
    expect(f.current.notification.url()).toBe(f.work);expect(f.current.dm.url()).toBe(f.entry);
    let completed=0;
    await expect(f.browser.verifyEmergencyRecovery('100',new AbortController().signal,()=>{},()=>{completed++;}))
      .rejects.toThrow('OBSERVATION_SECURITY_SUSPECT');
    expect(completed).toBe(0);
    await f.current.notification.goto(f.entry);
    await expect(new ObservedReader(f.current.notification,f.config).guard()).resolves.toBeUndefined();
    await f.current.notification.evaluate(()=>{const editor=document.createElement('textarea');editor.id='synthetic-human-input';editor.value='未发送的人工草稿';document.body.append(editor);});
    await expect(f.browser.verifyEmergencyRecovery('100',new AbortController().signal,()=>{},()=>{completed++;}))
      .rejects.toThrow('BROWSER_HAS_HUMAN_INPUT');
    expect(completed).toBe(0);expect(f.current.notification.url()).toBe(f.entry);
    expect(await f.current.notification.locator('#synthetic-human-input').inputValue()).toBe('未发送的人工草稿');
    await f.current.notification.locator('#synthetic-human-input').evaluate(editor=>editor.remove());
    await expect(f.browser.verifyEmergencyRecovery('100',new AbortController().signal,()=>{},()=>{completed++;}))
      .rejects.toThrow('OBSERVATION_SECURITY_SUSPECT');
    expect(completed).toBe(0);expect(f.current.notification.url()).toBe(f.work);
    await f.clearHeadless();
    await expect(f.browser.verifyEmergencyRecovery('100',new AbortController().signal,()=>{},()=>{completed++;})).resolves.toBeUndefined();
    expect(completed).toBe(1);expect(f.current.notification.url()).toBe(f.work);
  }finally{await f.close();}
},30_000);

test.each(['external','different-account','unauthorized-work','work-on-dm','userinfo'] as const)(
  'an invalid persisted recovery scope never navigates either page: %s',async variant=>{
  const f=await fixture();
  try{
    const saved={version:1,ownId:'100',notification:f.work,dm:f.entry};
    if(variant==='external')saved.notification='https://example.invalid/video/10';
    if(variant==='different-account')saved.ownId='101';
    if(variant==='unauthorized-work')saved.notification='https://www.douyin.com/video/999';
    if(variant==='work-on-dm')saved.dm=f.work;
    if(variant==='userinfo')saved.notification='https://synthetic-user@www.douyin.com/video/10';
    await writeFile(join(f.root,'browser-recovery-locations.json'),JSON.stringify(saved));await f.browser.open();
    expect(f.current.notification.url()).toBe(f.entry);expect(f.current.dm.url()).toBe(f.entry);
    expect(f.navigations[0]).toEqual([f.entry,f.entry]);
  }finally{await f.close();}
},30_000);

test('authorized persisted recovery URLs are canonicalized before navigation',async()=>{
  const f=await fixture();
  try{
    await writeFile(join(f.root,'browser-recovery-locations.json'),JSON.stringify({version:1,ownId:'100',
      notification:f.work+'?from=synthetic#fragment',dm:f.entry+'?from=synthetic#fragment'}));
    await f.browser.open();expect(f.current.notification.url()).toBe(f.work);expect(f.current.dm.url()).toBe(f.entry);
    expect(f.navigations[0]).toContain(f.work);expect(f.navigations[0]!.every(url=>!url.includes('?')&&!url.includes('#'))).toBe(true);
  }finally{await f.close();}
},30_000);

test('a new backend retains the persisted failing work and cannot validate only the healthy entry page',async()=>{
  const f=await fixture();let restarted:BrowserService|undefined;
  try{
    await f.browser.open();await f.current.notification.goto(f.work);await f.current.dm.goto(f.entry);
    await expect(f.browser.verifyEmergencyRecovery('100',new AbortController().signal,()=>{})).rejects.toThrow('OBSERVATION_SECURITY_SUSPECT');
    await f.browser.close();
    restarted=new BrowserService(f.root,f.launch);await restarted.open();
    expect(f.current.notification.url()).toBe(f.work);expect(f.current.dm.url()).toBe(f.entry);
    let completed=0;
    await expect(restarted.verifyEmergencyRecovery('100',new AbortController().signal,()=>{},()=>{completed++;}))
      .rejects.toThrow('OBSERVATION_SECURITY_SUSPECT');
    expect(completed).toBe(0);
  }finally{await restarted?.close();await f.close();}
},30_000);
