import {expect,test,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {BrowserService} from '../../src/app/browser-service.js';
import {ClientService} from '../../src/app/service.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {AccountActor} from '../../src/browser/account-actor.js';
import type {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {mapping} from '../fixtures/site.js';
import {privateTemp,database,pending} from '../helpers.js';
import {observedMapping} from '../fixtures/observed-site.js';

test('ordinary open ignores the legacy headed choice and reconnects in headless mode',async()=>{
  const root=privateTemp('headless-policy-'),launches:boolean[]=[],owners:{closed:number}[]=[];
  const config={...mapping('https://www.douyin.com'),environment:'douyin'};
  await writeFile(join(root,'site-mapping.json'),JSON.stringify(config));
  const browser=new BrowserService(root,async(_profile,headless)=>{
    launches.push(headless);const context=new EventEmitter(),state={closed:0};owners.push(state);
    return {context,actor:new AccountActor(),version:()=> 'synthetic-headless',open:async()=>{},close:async()=>{state.closed++;context.emit('close');}} as unknown as BrowserProfileOwner;
  });
  try{
    await browser.open('headed');expect(launches).toEqual([true]);
    expect(browser.status().mode).toBe('headless');expect(browser.identity('DIRECT_MESSAGE')?.browserMode).toBe('headless');
    await browser.close();await browser.open();expect(launches).toEqual([true,true]);expect(owners[0]!.closed).toBe(1);
  }finally{await browser.close();vi.restoreAllMocks();}
});

async function recoveryFixture(beforeLaunch?:(headless:boolean)=>Promise<void>){
  const root=privateTemp('login-recovery-policy-'),launches:boolean[]=[],sequence:string[]=[];
  const owners:{closed:boolean;context:EventEmitter;pages:{dirty:boolean;locator:()=>{evaluateAll:()=>Promise<boolean>}}[]}[]=[];
  const browser=new BrowserService(root,async(_profile,headless)=>{
    expect(owners.every(owner=>owner.closed)).toBe(true);launches.push(headless);sequence.push(headless?'headless':'headed');
    await beforeLaunch?.(headless);
    const context=new EventEmitter(),actor=new AccountActor();
    const pages=[0,1].map(()=>({dirty:false,locator(){return {evaluateAll:async()=>!this.dirty};}}));
    const state={closed:false,pages,context};owners.push(state);
    return {context,actor,notification:pages[0],dm:pages[1],version:()=> 'synthetic-mode',open:async()=>{},close:async()=>{
      sequence.push('close');state.closed=true;context.emit('close');
    }} as unknown as BrowserProfileOwner;
  });
  await writeFile(join(root,'site-mapping.json'),JSON.stringify({...mapping('https://www.douyin.com'),environment:'douyin',ownId:'100'}));
  await writeFile(join(root,'observation-mapping.json'),JSON.stringify({...observedMapping('https://www.douyin.com'),environment:'douyin'}));
  return {root,browser,launches,owners,sequence};
}

test.each([0,1])('login recovery never closes a webpage draft in page %s and verified login returns to headless',async pageIndex=>{
  const f=await recoveryFixture(),guard=vi.spyOn(ObservedReader.prototype,'guard').mockResolvedValue();
  try{
    await f.browser.open();f.owners[0]!.pages[pageIndex]!.dirty=true;
    await expect(f.browser.beginLoginRecovery()).rejects.toThrow('BROWSER_HAS_HUMAN_INPUT');
    expect(f.owners[0]!.closed).toBe(false);expect(f.launches).toEqual([true]);
    await expect(f.browser.open('headed')).rejects.toThrow('LOGIN_RECOVERY_IN_PROGRESS');
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
  const f=await recoveryFixture(),store=database();await migrateClient(store,join(f.root,'backup.sqlite'));
  pending(store);store.db.prepare("UPDATE accounts SET own_id='100'").run();let now=Date.now();
  const service=new ClientService(store,f.browser,undefined,()=>now);await service.loadSettings();const token=service.authority.issueSession();
  let identified=false;const guard=vi.spyOn(ObservedReader.prototype,'guard').mockImplementation(async()=>{if(!identified)throw Error('LOGIN_REQUIRED');});
  try{
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
  }finally{guard.mockRestore();await service.close();store.close();}
});
