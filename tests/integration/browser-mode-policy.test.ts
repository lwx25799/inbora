import {expect,test,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {join} from 'node:path';
import {rm,writeFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {BrowserService} from '../../src/app/browser-service.js';
import {BrowserRecoveryLocations,inspectRecoveryNavigation} from '../../src/app/browser-recovery-locations.js';
import {ClientService} from '../../src/app/service.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {EventStore} from '../../src/storage/store.js';
import {AccountActor} from '../../src/browser/account-actor.js';
import type {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {mapping} from '../fixtures/site.js';
import {privateTemp,pending} from '../helpers.js';
import {observedMapping} from '../fixtures/observed-site.js';

interface FakePage {
  dirty:boolean;
  url():string;
  goto(url:string):Promise<void>;
  evaluate(fn?:typeof inspectRecoveryNavigation,input?:Parameters<typeof inspectRecoveryNavigation>[0]):Promise<{originMatches:boolean;empty:boolean}>;
}
function fakePage():FakePage{
  let currentUrl='about:blank';
  return {dirty:false,url:()=>currentUrl,goto:async(url:string)=>{currentUrl=url;},
    async evaluate(){return {originMatches:true,empty:!this.dirty};}};
}

test('ordinary open ignores the legacy headed choice and reconnects in headless mode',async()=>{
  const root=privateTemp('headless-policy-'),launches:boolean[]=[],owners:{closed:number}[]=[];
  const config={...mapping('https://www.douyin.com'),environment:'douyin'};
  await writeFile(join(root,'site-mapping.json'),JSON.stringify(config));
  const browser=new BrowserService(root,async(_profile,headless)=>{
    launches.push(headless);const context=new EventEmitter(),state={closed:0};owners.push(state);
    const pages=[fakePage(),fakePage()];
    return {context,notification:pages[0],dm:pages[1],actor:new AccountActor(),version:()=> 'synthetic-headless',
      open:async(origin:string)=>{for(const page of pages)await page.goto(origin);},close:async()=>{state.closed++;context.emit('close');}} as unknown as BrowserProfileOwner;
  });
  try{
    await browser.open('headed');expect(launches).toEqual([true]);
    expect(browser.status().mode).toBe('headless');expect(browser.identity('DIRECT_MESSAGE')?.browserMode).toBe('headless');
    await browser.close();await browser.open();expect(launches).toEqual([true,true]);expect(owners[0]!.closed).toBe(1);
  }finally{await browser.close();vi.restoreAllMocks();}
});

async function recoveryFixture(beforeLaunch?:(headless:boolean)=>Promise<void>){
  const root=privateTemp('login-recovery-policy-'),launches:boolean[]=[],sequence:string[]=[];
  const owners:{closed:boolean;context:EventEmitter;pages:FakePage[]}[]=[];
  const browser=new BrowserService(root,async(_profile,headless)=>{
    expect(owners.every(owner=>owner.closed)).toBe(true);launches.push(headless);sequence.push(headless?'headless':'headed');
    await beforeLaunch?.(headless);
    const context=new EventEmitter(),actor=new AccountActor();
    const pages=[0,1].map(()=>fakePage());
    const state={closed:false,pages,context};owners.push(state);
    return {context,actor,notification:pages[0],dm:pages[1],version:()=> 'synthetic-mode',open:async(origin:string)=>{
      for(const page of pages)await page.goto(origin);
    },close:async()=>{
      sequence.push('close');state.closed=true;context.emit('close');
    }} as unknown as BrowserProfileOwner;
  });
  try{
    await writeFile(join(root,'site-mapping.json'),JSON.stringify({...mapping('https://www.douyin.com'),environment:'douyin',ownId:'100'}));
    await writeFile(join(root,'observation-mapping.json'),JSON.stringify({...observedMapping('https://www.douyin.com'),environment:'douyin'}));
    return {root,browser,launches,owners,sequence};
  }catch(error){
    try{await browser.close();}finally{await rm(root,{recursive:true,force:true});}
    throw error;
  }
}

test('a manual visible window stays open even when the bound account is already verified',async()=>{
  const f=await recoveryFixture(),guard=vi.spyOn(ObservedReader.prototype,'guard').mockResolvedValue();
  try{
    await f.browser.open();await f.browser.beginLoginRecovery(false);
    expect(await f.browser.completeLoginIfVerified('100')).toBe(false);
    expect(f.launches).toEqual([true,false]);expect(guard).not.toHaveBeenCalled();
    expect(f.browser.status()).toMatchObject({mode:'headed',state:'MANUAL_VISIBLE',loginRecovery:true});
    expect(await f.browser.finishLoginRecovery()).toBe(true);
    expect(f.launches).toEqual([true,false,true]);
    expect(f.browser.status()).toMatchObject({mode:'headless',loginRecovery:false});
  }finally{guard.mockRestore();await f.browser.close();}
});

test.each([0,1])('returning from a manual visible window preserves webpage input in page %s',async pageIndex=>{
  const f=await recoveryFixture();
  try{
    await f.browser.open();await f.browser.beginLoginRecovery(false);f.owners[1]!.pages[pageIndex]!.dirty=true;
    await expect(f.browser.finishLoginRecovery()).rejects.toThrow('BROWSER_HAS_HUMAN_INPUT');
    expect(f.owners[1]!.closed).toBe(false);expect(f.launches).toEqual([true,false]);
    expect(f.browser.status()).toMatchObject({mode:'headed',state:'MANUAL_VISIBLE',loginRecovery:true});
  }finally{await f.browser.close();}
});

test.each(['navigation','mode switch'] as const)('%s preserves a folded mapped editor holding an attachment',async operation=>{
  const origin='https://www.douyin.com',f=await recoveryFixture();
  try{
    await f.browser.open();
    const owner=f.owners[0]!,notification=owner.pages[0]!,dm=owner.pages[1]!;
    const mapped=mapping(origin).targets.COMMENT_NOTIFICATION.composer;
    const editor={textContent:'',getBoundingClientRect:()=>({width:0,height:0}),querySelector:()=>({tagName:'IMG'})};
    const env={location:{origin},document:{querySelectorAll:(selector:string)=>selector===mapped?[editor]:[]},
      HTMLInputElement:class{},HTMLTextAreaElement:class{},getComputedStyle:()=>({display:'none',visibility:'hidden'})};
    notification.evaluate=async(fn,input)=>runInNewContext(`(${fn!.toString()})`,env)(input);
    const goto=vi.spyOn(notification,'goto');
    if(operation==='navigation'){
      const locations=new BrowserRecoveryLocations(f.root);
      const profile={notification,dm,actor:new AccountActor()} as unknown as BrowserProfileOwner;
      await locations.capture(profile);
      await notification.goto(origin+'/video/other');
      goto.mockClear();
      await expect(locations.restore(profile)).rejects.toThrow('BROWSER_HAS_HUMAN_INPUT');
      expect(goto).not.toHaveBeenCalled();
      expect(notification.url()).toBe(origin+'/video/other');
    }else{
      await expect(f.browser.beginLoginRecovery()).rejects.toThrow('BROWSER_HAS_HUMAN_INPUT');
      expect(f.launches).toEqual([true]);
      expect(owner.closed).toBe(false);
    }
  }finally{try{await f.browser.close();}finally{await rm(f.root,{recursive:true,force:true});}}
});

test.each(['notification','dm'] as const)('opening keeps both pages in place when %s has a folded draft',async dirtyPage=>{
  const root=privateTemp('launch-with-draft-'),origin='https://www.douyin.com',config=mapping(origin);
  const notification=fakePage(),dm=fakePage(),actor=new AccountActor();
  const owner={context:new EventEmitter(),actor,notification,dm,version:()=> 'synthetic-mode',
    open:vi.fn(async()=>{}),close:vi.fn(async()=>{editor.textContent='';})};
  const browser=new BrowserService(root,async()=>owner as unknown as BrowserProfileOwner);
  const composer=config.targets[dirtyPage==='notification'?'COMMENT_NOTIFICATION':'DIRECT_MESSAGE'].composer;
  const editor={textContent:'unsent draft',getBoundingClientRect:()=>({width:0,height:0}),matches:()=>false,querySelector:()=>null};
  const env={location:{origin},document:{querySelectorAll:(selector:string)=>selector===composer?[editor]:[]},
    HTMLInputElement:class{},HTMLTextAreaElement:class{},getComputedStyle:()=>({display:'none',visibility:'hidden'})};
  owner[dirtyPage].evaluate=async(fn,input)=>runInNewContext(`(${fn!.toString()})`,env)(input);
  try{
    await writeFile(join(root,'site-mapping.json'),JSON.stringify({...config,environment:'douyin'}));
    await writeFile(join(root,'browser-recovery-locations.json'),JSON.stringify({
      version:1,ownId:config.ownId,notification:origin+'/',dm:origin+'/',
    }));
    const currentUrl=origin+'/video/current';
    await notification.goto(currentUrl);
    await dm.goto(currentUrl);
    const navigation=vi.spyOn(notification,'goto'),dmNavigation=vi.spyOn(dm,'goto');
    const opened=await browser.open().catch(error=>error);
    expect(navigation).not.toHaveBeenCalled();
    expect(dmNavigation).not.toHaveBeenCalled();
    expect(owner.close).not.toHaveBeenCalled();
    expect(editor.textContent).toBe('unsent draft');
    expect(opened).toBeUndefined();
    expect(notification.url()).toBe(currentUrl);
    expect(dm.url()).toBe(currentUrl);
    expect(browser.actor).toBe(actor);
    expect(browser.status()).toMatchObject({state:'OPEN_IDENTITY_UNVERIFIED',mode:'headless'});
    expect(browser.identity('DIRECT_MESSAGE')?.browserMode).toBe('headless');
  }finally{try{await browser.close();}finally{await rm(root,{recursive:true,force:true});}}
});

test('closing a manual visible window restores verified headless operation without reopening headed',async()=>{
  const f=await recoveryFixture(),guard=vi.spyOn(ObservedReader.prototype,'guard').mockResolvedValue();
  try{
    await f.browser.open();await f.browser.beginLoginRecovery(false);f.owners[1]!.context.emit('close');
    expect(await f.browser.completeLoginIfVerified('100')).toBe(true);
    expect(f.launches).toEqual([true,false,true]);expect(f.browser.loginRecovery).toBe(false);
  }finally{guard.mockRestore();await f.browser.close();}
});

test.each([0,1])('login recovery never closes a webpage draft in page %s and verified login returns to headless',async pageIndex=>{
  const f=await recoveryFixture(),guard=vi.spyOn(ObservedReader.prototype,'guard').mockResolvedValue();
  try{
    await f.browser.open();f.owners[0]!.pages[pageIndex]!.dirty=true;
    await expect(f.browser.beginLoginRecovery()).rejects.toThrow('BROWSER_HAS_HUMAN_INPUT');
    expect(f.owners[0]!.closed).toBe(false);expect(f.launches).toEqual([true]);
    expect(f.browser.loginRecovery).toBe(false);expect(f.browser.status().mode).toBe('headless');
    f.owners[0]!.pages[pageIndex]!.dirty=false;await f.browser.beginLoginRecovery();
    expect(f.launches).toEqual([true,false]);expect(f.browser.identity('DIRECT_MESSAGE')).toBeNull();
    expect(await f.browser.completeLoginIfVerified('wrong-own')).toBe(false);expect(guard).not.toHaveBeenCalled();
    expect(await f.browser.completeLoginIfVerified('100')).toBe(true);expect(guard).toHaveBeenCalledTimes(2);
    expect(f.sequence).toEqual(['headless','close','headed','close','headless']);
    expect(f.browser.status()).toMatchObject({mode:'headless',loginRecovery:false});
    expect(f.browser.identity('DIRECT_MESSAGE')?.browserMode).toBe('headless');
  }finally{guard.mockRestore();await f.browser.close();}
});

test('an old login completion cannot unlock a newer explicit login recovery',async()=>{
  let release!:()=>void,entered!:()=>void,count=0;
  const blocked=new Promise<void>(resolve=>{release=resolve;}),atReplacement=new Promise<void>(resolve=>{entered=resolve;});
  const f=await recoveryFixture(async()=>{if(++count===3){entered();await blocked;}});
  const guard=vi.spyOn(ObservedReader.prototype,'guard').mockResolvedValue();
  try{
    await f.browser.open();await f.browser.beginLoginRecovery();
    const oldCompletion=f.browser.completeLoginIfVerified('100');await atReplacement;
    const newLogin=f.browser.beginLoginRecovery();release();
    const oldResult=await oldCompletion;await newLogin;
    expect(f.launches).toEqual([true,false,true,false]);expect(f.browser.status().mode).toBe('headed');
    expect(oldResult).toBe(false);expect(f.browser.loginRecovery).toBe(true);
    await expect(f.browser.open()).rejects.toThrow('LOGIN_RECOVERY_IN_PROGRESS');
  }finally{release();guard.mockRestore();await f.browser.close();}
});

test('closing the visible login window only reopens headless and keeps recovery blocked until both pages prove the bound account',async()=>{
  const f=await recoveryFixture();let identified=false;
  const guard=vi.spyOn(ObservedReader.prototype,'guard').mockImplementation(async()=>{if(!identified)throw Error('LOGIN_REQUIRED');});
  try{
    await f.browser.open();await f.browser.beginLoginRecovery();f.owners[1]!.context.emit('close');
    await expect(f.browser.completeLoginIfVerified('100')).rejects.toThrow('LOGIN_REQUIRED');
    expect(f.launches).toEqual([true,false,true]);expect(f.browser.loginRecovery).toBe(true);
    expect(f.browser.status().mode).toBe('headless');expect(f.browser.identity('DIRECT_MESSAGE')).toBeNull();
    await expect(f.browser.open()).rejects.toThrow('LOGIN_RECOVERY_IN_PROGRESS');
    identified=true;expect(await f.browser.completeLoginIfVerified('100')).toBe(true);
    expect(f.launches).toEqual([true,false,true]);expect(f.browser.loginRecovery).toBe(false);
  }finally{guard.mockRestore();await f.browser.close();}
});

test('only the explicit login request is headed and service recovery preserves scopes, budgets and model prohibition',async()=>{
  const f=await recoveryFixture();
  let store:EventStore|undefined,service:ClientService|undefined,guard:ReturnType<typeof vi.spyOn>|undefined;
  try{
    store=new EventStore(join(f.root,'poc.sqlite'),true,()=> '2026-11-03T00:00:00Z');
    await migrateClient(store,join(f.root,'backup.sqlite'));
    pending(store);store.db.prepare("UPDATE accounts SET own_id='100'").run();let now=Date.now();
    service=new ClientService(store,f.browser,undefined,()=>now);await service.loadSettings();const token=service.authority.issueSession();
    let identified=false;guard=vi.spyOn(ObservedReader.prototype,'guard').mockImplementation(async()=>{if(!identified)throw Error('LOGIN_REQUIRED');});
    await service.dispatch(token,{command:'browser',open:true,mode:'headed'});expect(f.launches).toEqual([true]);
    service.authority.attest('DIRECT_MESSAGE','SEND_AVAILABLE',{...f.browser.identity('DIRECT_MESSAGE')!,browserMode:'headed'},'synthetic-headed-only');
    const status=await service.dispatch(token,{command:'getStatus'}) as {capabilities:{channel:string;state:string}[]};
    expect(status.capabilities.find(item=>item.channel==='DIRECT_MESSAGE')?.state).not.toBe('SEND_AVAILABLE');
    const before=store.db.prepare('SELECT * FROM budgets ORDER BY kind').all();
    await service.dispatch(token,{command:'browser',open:true,mode:'headed',loginRecovery:true});expect(f.launches).toEqual([true,false]);
    expect(f.browser.status().state).toBe('LOGIN_RECOVERY');
    const eventId=store.events()[0]!.id;
    await expect(service.dispatch(token,{command:'generateSuggestion',eventId,draftVersion:0})).rejects.toThrow('LOGIN_RECOVERY_IN_PROGRESS');
    await service.runAutomaticReply();service.startOnline();await service.drain();expect(f.launches).toEqual([true,false]);
    expect(store.db.prepare('SELECT * FROM budgets ORDER BY kind').all()).toEqual(before);
    expect(store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
    identified=true;now+=30_001;service.startOnline();await service.drain();
    expect(f.launches).toEqual([true,false,true]);expect(service.authority.paused()).toBe(false);
  }finally{
    try{guard?.mockRestore();}
    finally{
      try{await service?.close();}
      finally{
        try{await f.browser.close();}
        finally{try{store?.close();}finally{await rm(f.root,{recursive:true,force:true});}}
      }
    }
  }
});
