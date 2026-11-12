import {afterEach,expect,test,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {Page} from 'playwright';
import {BrowserService} from '../../src/app/browser-service.js';
import type {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {AccountActor} from '../../src/browser/account-actor.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {Blocked} from '../../src/core/contracts.js';
import {observedMapping} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';

afterEach(()=>vi.restoreAllMocks());
async function setup(mode:'headed'|'headless'='headless'){
  const root=privateTemp('emergency-recovery-browser-'),notification={} as Page,dm={} as Page,context=new EventEmitter();
  const owner={notification,dm,context,actor:new AccountActor(),version:()=> 'synthetic',close:async()=>{}} as unknown as BrowserProfileOwner;
  await writeFile(join(root,'observation-mapping.json'),JSON.stringify({...observedMapping('https://www.douyin.com'),environment:'douyin'}));
  return {browser:BrowserService.adopt(root,owner,mode),notification,dm,context};
}

test('recovery checks the accurate identity and safety guards on both existing owned pages without navigation',async()=>{
  const f=await setup(),pages:Page[]=[];
  vi.spyOn(ObservedReader.prototype,'guard').mockImplementation(async function(this:ObservedReader){pages.push(this.page);expect(this.mapping.self.uid).toBe('100');});
  try{
    await f.browser.verifyEmergencyRecovery('100',new AbortController().signal,()=>{});
    expect(pages).toEqual([f.notification,f.dm]);expect(f.browser.status().mode).toBe('headless');
  }finally{await f.browser.close();}
});

test.each(['notification','dm'] as const)('a blocker on the %s owned page rejects recovery',async blocked=>{
  const f=await setup(),pages:Page[]=[];
  vi.spyOn(ObservedReader.prototype,'guard').mockImplementation(async function(this:ObservedReader){
    pages.push(this.page);if(this.page===f[blocked])throw new Blocked('OBSERVATION_SECURITY_COMPONENT');
  });
  try{
    await expect(f.browser.verifyEmergencyRecovery('100',new AbortController().signal,()=>{})).rejects.toThrow('OBSERVATION_SECURITY_COMPONENT');
    expect(pages).toEqual(blocked==='notification'?[f.notification]:[f.notification,f.dm]);
  }finally{await f.browser.close();}
});

test('headed viewing must return headless before recovery and does not silently switch the browser',async()=>{
  const f=await setup('headed'),guard=vi.spyOn(ObservedReader.prototype,'guard');
  try{
    await expect(f.browser.verifyEmergencyRecovery('100',new AbortController().signal,()=>{})).rejects.toThrow('EMERGENCY_RECOVERY_HEADLESS_REQUIRED');
    expect(guard).not.toHaveBeenCalled();expect(f.browser.status().mode).toBe('headed');
  }finally{await f.browser.close();}
});

test('a mapping for a different account cannot validate recovery',async()=>{
  const f=await setup(),guard=vi.spyOn(ObservedReader.prototype,'guard');
  try{
    await expect(f.browser.verifyEmergencyRecovery('other-account',new AbortController().signal,()=>{})).rejects.toThrow('ACCOUNT_CHANGED');
    expect(guard).not.toHaveBeenCalled();
  }finally{await f.browser.close();}
});

test('natural browser closure during the first page check prevents accepting a stale successful guard',async()=>{
  const f=await setup();
  vi.spyOn(ObservedReader.prototype,'guard').mockImplementation(async()=>{f.context.emit('close');});
  await expect(f.browser.verifyEmergencyRecovery('100',new AbortController().signal,()=>{})).rejects.toThrow('BROWSER_CLOSED');
  expect(f.browser.status().state).toBe('CLOSED');await f.browser.close();
});

test('the verified completion commits before the account actor permits another browser operation',async()=>{
  const f=await setup(),order:string[]=[];let entered!:()=>void,release!:()=>void;
  const waiting=new Promise<void>(resolve=>{entered=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});
  let checks=0;
  vi.spyOn(ObservedReader.prototype,'guard').mockImplementation(async()=>{
    order.push('guard');if(++checks===1){entered();await hold;}
  });
  const recovery=f.browser.verifyEmergencyRecovery('100',new AbortController().signal,()=>{},()=>{order.push('commit');});
  await waiting;const queued=f.browser.actor.run(async()=>{order.push('next-browser-operation');});release();
  await Promise.all([recovery,queued]);expect(order).toEqual(['guard','guard','commit','next-browser-operation']);await f.browser.close();
});
