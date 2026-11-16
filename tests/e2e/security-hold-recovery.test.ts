import {expect,test,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {BrowserSafety} from '../../src/app/browser-safety.js';
import {ObservedReader,captureObserved} from '../../src/adapters/observed-reader.js';
import type {ObservationMapping} from '../../src/config/site-mapping.js';
import {Blocked,type Channel,type ReplyAdapter} from '../../src/core/contracts.js';
import {EventStore} from '../../src/storage/store.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {readEmergencyStop} from '../../src/storage/emergency-stop.js';
import {holdSecurityChannel,readSecurityHold} from '../../src/storage/security-holds.js';
import {observedMapping,mountObserved,mountCommentReply} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';

const channel='COMMENT_NOTIFICATION' as const,origin='https://www.douyin.com';
async function fixture(path:'video'|'note'='video'){
  const root=privateTemp('security-hold-recovery-'),store=new EventStore(join(root,'poc.sqlite'),true),mapping={...observedMapping(origin),environment:'douyin' as const};
  await migrateClient(store,join(root,'schema3.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  new AutomationStore(store).initialize(Date.now());
  mapping.works[0]!.url=origin+'/'+path+'/10';
  store.bindAccount('100');await writeFile(join(root,'observation-mapping.json'),JSON.stringify(mapping));
  const owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
  // All requests are local synthetic responses. The real Profile is never opened.
  await owner.context.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Synthetic hold recovery</title>'}));
  await mountObserved(owner,origin);await mountCommentReply(owner,origin);
  if(path==='note')await owner.notification.evaluate(()=>history.replaceState(null,'','/note/10'));
  const safety=new BrowserSafety(root,store);safety.attach(owner,1,'headless');safety.instanceId='synthetic-backend';
  const trigger=async(guardMapping:ObservationMapping=mapping,targetChannel:Channel=channel)=>{
    const page=targetChannel==='DIRECT_MESSAGE'?owner.dm:owner.notification;
    await page.evaluate(()=>{const node=document.createElement('div');node.setAttribute('data-fixture-challenge','');
      node.style.cssText='position:fixed;inset:0;background:#eee';node.textContent='Synthetic uncalibrated security candidate';document.body.append(node);});
    await expect(owner.actor.run(()=>new ObservedReader(page,guardMapping).guard())).rejects.toThrow('OBSERVATION_SECURITY_SUSPECT');
    return readSecurityHold(store,targetChannel)!;
  };
  return{root,store,mapping,owner,safety,trigger,
    clear:(targetChannel:Channel=channel)=>(targetChannel==='DIRECT_MESSAGE'?owner.dm:owner.notification).evaluate(()=>document.querySelector('[data-fixture-challenge]')?.remove()),
    close:async()=>{await owner.close();store.close();await rm(root,{recursive:true,force:true});}};
}

test('an exact original target recovers only after its current headless document passes read and security gates',async()=>{
  const f=await fixture();
  try{
    const held=await f.trigger();expect(held).not.toBeNull();expect(()=>f.safety.check(channel)).toThrow('SECURITY_CHANNEL_HELD');
    await expect(f.safety.recover(f.owner,channel,undefined,true)).rejects.toThrow('OBSERVATION_SECURITY_SUSPECT');
    expect(readSecurityHold(f.store,channel)?.revision).toBe(held.revision);
    await f.clear();await expect(f.safety.recover(f.owner,channel,undefined,true)).resolves.toBe(true);
    expect(readSecurityHold(f.store,channel)).toBeNull();expect(()=>f.safety.check(channel)).not.toThrow();
    expect(f.store.budget('MODEL').used).toBe(0);expect(f.store.budget('SEND').used).toBe(0);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{await f.close();}
},30_000);

test.each(['video','note'] as const)('an account-page signal on an authorized %s still recovers the exact original work',async path=>{
  const f=await fixture(path);
  try{
    // A reader for the next work checks the previous document before normal navigation.
    const nextMapping={...f.mapping,works:[{id:'99',url:origin+'/video/99'}]};
    const held=await f.trigger(nextMapping),incident=await f.safety.incidents.read(held.incidentId);
    expect(incident?.initial).toMatchObject({scope:'ACCOUNT_PAGE',href:f.mapping.works[0]!.url});
    expect(incident?.initial?.target).toBeUndefined();
    await expect(f.safety.recover(f.owner,channel,undefined,true)).rejects.toThrow('OBSERVATION_SECURITY_SUSPECT');
    expect(readSecurityHold(f.store,channel)?.revision).toBe(held.revision);
    await f.clear();await expect(f.safety.recover(f.owner,channel,undefined,true)).resolves.toBe(true);
    expect(readSecurityHold(f.store,channel)).toBeNull();
    expect(f.owner.notification.url()).toBe(f.mapping.works[0]!.url);
  }finally{await f.close();}
},30_000);

test.each(['video','note'] as const)('an account-page signal cannot authorize an unknown %s URL',async path=>{
  const f=await fixture();
  try{
    await f.owner.notification.evaluate(path=>history.replaceState(null,'','/'+path+'/99'),path);
    const held=await f.trigger();await f.clear();
    expect((await f.safety.incidents.read(held.incidentId))?.initial).toMatchObject({scope:'ACCOUNT_PAGE'});
    await expect(f.safety.recover(f.owner,channel,undefined,true)).rejects.toThrow('SECURITY_RECOVERY_TARGET_UNAVAILABLE');
    expect(readSecurityHold(f.store,channel)?.revision).toBe(held.revision);
    expect(f.owner.notification.url()).toBe(origin+'/'+path+'/99');
  }finally{await f.close();}
},30_000);

test('a DM account-page signal cannot use an authorized work as its recovery target',async()=>{
  const f=await fixture(),dmChannel='DIRECT_MESSAGE' as const;
  try{
    await f.owner.dm.evaluate(()=>{history.replaceState(null,'','/video/10');(document.querySelector('#chat') as HTMLElement).hidden=true;});
    const nextMapping={...f.mapping,works:[{id:'99',url:origin+'/video/99'}]};
    const held=await f.trigger(nextMapping,dmChannel);await f.clear(dmChannel);
    expect((await f.safety.incidents.read(held.incidentId))?.initial).toMatchObject({scope:'ACCOUNT_PAGE'});
    await expect(f.safety.recover(f.owner,dmChannel,undefined,true)).rejects.toThrow('SECURITY_RECOVERY_TARGET_UNAVAILABLE');
    expect(readSecurityHold(f.store,dmChannel)?.revision).toBe(held.revision);
    expect(readSecurityHold(f.store,channel)).toBeNull();expect(f.owner.dm.url()).toBe(origin+'/video/10');
  }finally{await f.close();}
},30_000);

test('a healthy different work cannot automatically resolve the original work hold or navigate back',async()=>{
  const f=await fixture();
  try{
    const held=await f.trigger();await f.clear();await f.owner.notification.goto(origin+'/video/99');
    await expect(f.safety.recover(f.owner,channel)).resolves.toBe(false);
    expect(f.owner.notification.url()).toBe(origin+'/video/99');expect(readSecurityHold(f.store,channel)?.revision).toBe(held.revision);
  }finally{await f.close();}
},30_000);

test('a queued old recovery cannot clear a newer freeze after it acquires the account actor',async()=>{
  const f=await fixture();let release!:()=>void;
  try{
    const first=await f.trigger();await f.clear();let entered=false;
    const gate=new Promise<void>(yes=>{release=yes;});
    const blocker=f.owner.actor.run(async()=>{entered=true;await gate;});await expect.poll(()=>entered).toBe(true);
    const recovery=f.safety.recover(f.owner,channel,undefined,true);
    const second=holdSecurityChannel(f.store,channel,{incidentId:randomUUID(),reason:first.reason,mode:'headless'});
    release();await blocker;await expect(recovery).rejects.toThrow('SECURITY_RECOVERY_CHANGED');
    expect(readSecurityHold(f.store,channel)?.revision).toBe(second.revision);
    expect(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='SECURITY_CHANNEL_RESOLVED'").get()).toEqual({n:0});
  }finally{release?.();await f.close();}
},30_000);

test('headless hold is not resolved by reattaching the same browser as a headed observation',async()=>{
  const f=await fixture();
  try{
    const held=await f.trigger();await f.clear();f.safety.attach(f.owner,2,'headed');
    await expect(f.safety.recover(f.owner,channel,undefined,true)).resolves.toBe(false);
    expect(readSecurityHold(f.store,channel)?.revision).toBe(held.revision);
  }finally{await f.close();}
},30_000);

test.each(['account','origin'] as const)('an automatic recovery globally stops if %s changes after its preliminary guard',async change=>{
  const f=await fixture();let hook:ReturnType<typeof vi.spyOn>|undefined;
  try{
    const held=await f.trigger();await f.clear();
    const page=f.owner.notification,original=page.evaluate.bind(page);let raced=false;
    hook=vi.spyOn(page,'evaluate').mockImplementation(async(fn,arg)=>{
      if((fn as unknown)===captureObserved&&arg&&typeof arg==='object'&&'channel' in arg&&arg.channel==='comments'){
        raced=true;
        if(change==='origin')await page.goto('https://synthetic-other.invalid/',{waitUntil:'domcontentloaded'});
        else await original(()=>{
          const self=document.querySelector('#self')!;
          Object.getOwnPropertyDescriptor(self,'__reactFiber$fixture')!.value.return.memoizedProps.uid='999';
        });
      }
      return original(fn,arg);
    });
    const code=change==='account'?'OBSERVATION_ACCOUNT_CHANGED':'OBSERVATION_UNEXPECTED_ORIGIN';
    await expect(f.safety.recover(f.owner,channel)).rejects.toMatchObject({code,message:code});
    expect(raced).toBe(true);expect(readSecurityHold(f.store,channel)?.revision).toBe(held.revision);
    expect(f.store.db.prepare('SELECT emergency_stopped FROM automation_state WHERE id=1').get()).toEqual({emergency_stopped:1});
    expect(readEmergencyStop(f.store)).toMatchObject({reason:code,legacy:false});
  }finally{hook?.mockRestore();await f.close();}
},30_000);

test.each(['OBSERVATION_UNEXPECTED_ORIGIN','OBSERVATION_ACCOUNT_CHANGED','NATIVE_REPLY_ACCOUNT_CHANGED','COMMENT_REPLY_ACCOUNT_CHANGED'])(
  'a wrapped final submit gate persists the exact browser strong code %s',async code=>{
    const f=await fixture();
    try{
      const adapter={clickOnce:async()=>{await f.owner.notification.evaluate(value=>{throw Error(value);},code);}} as unknown as ReplyAdapter;
      const wrapped=f.safety.wrap(adapter,channel,f.owner.notification),error=await wrapped.clickOnce().catch(cause=>cause);
      expect(error).toBeInstanceOf(Blocked);expect(error).toMatchObject({code,message:code});
      expect(f.store.db.prepare('SELECT emergency_stopped FROM automation_state WHERE id=1').get()).toEqual({emergency_stopped:1});
      expect(readEmergencyStop(f.store)).toMatchObject({reason:code,legacy:false});
      expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
    }finally{await f.close();}
  },30_000);

test.each(['private prefix OBSERVATION_ACCOUNT_CHANGED','OBSERVATION_UNEXPECTED_ORIGIN private suffix','private detail\nOBSERVATION_ACCOUNT_CHANGED'])(
  'a browser error containing a strong-code phrase is not classified as that cause (%s)',async message=>{
    const f=await fixture();
    try{
      const adapter={clickOnce:async()=>{await f.owner.notification.evaluate(value=>{throw Error(value);},message);}} as unknown as ReplyAdapter;
      const wrapped=f.safety.wrap(adapter,channel,f.owner.notification),error=await wrapped.clickOnce().catch(cause=>cause);
      expect(error).not.toBeInstanceOf(Blocked);
      expect(f.store.db.prepare('SELECT emergency_stopped FROM automation_state WHERE id=1').get()).toEqual({emergency_stopped:0});
      expect(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='EMERGENCY_STOPPED'").get()).toEqual({n:0});
    }finally{await f.close();}
  },30_000);
