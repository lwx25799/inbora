import {expect,test} from 'vitest';
import {rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {observedSecurityBlockers} from '../../src/config/site-mapping.js';
import {observedMapping} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';

async function fixture(){
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
  const browser=new BrowserService(root,launch);
  return {root,entry,work,config,owners,requestedModes,navigations,launch,browser,
    get current(){return owners.at(-1)!;},
    clearHeaded:async()=>{headedChallenge=false;await owners.at(-1)!.notification.evaluate(()=>document.querySelector('#captcha_container')?.remove());},
    clearHeadless:async()=>{headlessChallenge=false;await owners.at(-1)!.notification.evaluate(()=>document.querySelector('#captcha_container')?.remove());},
    close:async()=>{await browser.close();await Promise.allSettled(owners.map(owner=>owner.close()));await rm(root,{recursive:true});}};
}

test('login handling preserves the failing work and rechecks that target after returning headless',async()=>{
  const f=await fixture();
  try{
    await f.browser.open();await f.current.notification.goto(f.work+'?from=synthetic#fragment');await f.current.dm.goto(f.entry+'?from=synthetic#fragment');
    await expect(new ObservedReader(f.current.notification,f.config).guard()).rejects.toThrow('OBSERVATION_SECURITY_COMPONENT');
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
      .rejects.toThrow('OBSERVATION_SECURITY_COMPONENT');
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
      .rejects.toThrow('OBSERVATION_SECURITY_COMPONENT');
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
    await expect(f.browser.verifyEmergencyRecovery('100',new AbortController().signal,()=>{})).rejects.toThrow('OBSERVATION_SECURITY_COMPONENT');
    await f.browser.close();
    restarted=new BrowserService(f.root,f.launch);await restarted.open();
    expect(f.current.notification.url()).toBe(f.work);expect(f.current.dm.url()).toBe(f.entry);
    let completed=0;
    await expect(restarted.verifyEmergencyRecovery('100',new AbortController().signal,()=>{},()=>{completed++;}))
      .rejects.toThrow('OBSERVATION_SECURITY_COMPONENT');
    expect(completed).toBe(0);
  }finally{await restarted?.close();await f.close();}
},30_000);
