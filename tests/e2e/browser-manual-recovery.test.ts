import {afterAll,beforeAll,expect,test,vi} from 'vitest';
import {chromium,type Browser} from 'playwright';
import {randomUUID} from 'node:crypto';
import {readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {AccountActor} from '../../src/browser/account-actor.js';
import type {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {BrowserManualRecovery} from '../../src/app/browser-manual-recovery.js';
import {BrowserSafety} from '../../src/app/browser-safety.js';
import type {ManualRecoveryFrame,ManualRecoverySession} from '../../src/app/manual-recovery-contracts.js';
import {ObservedReader,captureObserved} from '../../src/adapters/observed-reader.js';
import {EventStore} from '../../src/storage/store.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {holdSecurityChannel,readSecurityHold,resolveSecurityHold} from '../../src/storage/security-holds.js';
import {Blocked} from '../../src/core/contracts.js';
import {recordEmergencyStop,readEmergencyStop} from '../../src/storage/emergency-stop.js';
import {observedMapping,mountObserved,mountCommentReply} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';

const channel='COMMENT_NOTIFICATION' as const,origin='https://www.douyin.com',token='synthetic-native-gui';
const permitted=()=>{};
let browser:Browser;
beforeAll(async()=>{browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']});});
afterAll(async()=>{await browser.close();});

async function fixture(){
  const root=privateTemp('browser-manual-recovery-'),store=new EventStore(join(root,'poc.sqlite'),true);
  await migrateClient(store,join(root,'schema3.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  new AutomationStore(store).initialize(Date.now());store.bindAccount('100');
  const mapping={...observedMapping(origin),environment:'douyin' as const};
  await writeFile(join(root,'observation-mapping.json'),JSON.stringify(mapping));
  const context=await browser.newContext({viewport:{width:1280,height:720}});
  await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Synthetic manual recovery</title>'}));
  const notification=await context.newPage(),dm=await context.newPage();
  const owner={context,notification,dm,actor:new AccountActor(),version:()=>browser.version()} as BrowserProfileOwner;
  await mountObserved(owner,origin);await mountCommentReply(owner,origin);
  const safety=new BrowserSafety(root,store);safety.attach(owner,1,'headless');safety.instanceId='synthetic-backend';
  await notification.evaluate(()=>{
    const challenge=document.createElement('div');challenge.setAttribute('data-fixture-challenge','');
    challenge.style.cssText='position:fixed;left:400px;top:100px;width:400px;height:300px;background:white;z-index:100';
    challenge.innerHTML='<input aria-label="synthetic code"><button>synthetic challenge</button>';
    document.body.append(challenge);
  });
  await expect(owner.actor.run(()=>new ObservedReader(notification,mapping).guard())).rejects.toThrow('OBSERVATION_SECURITY_SUSPECT');
  const held=readSecurityHold(store,channel)!;
  expect((await safety.incidents.read(held.incidentId))?.sameDocument).toBe(true);
  const binding={owner,epoch:1,mode:'headless' as const,transitioning:false};
  const recovery=new BrowserManualRecovery(root,store,safety,()=>binding);
  return{root,store,mapping,owner,safety,binding,recovery,held,
    start:(check=permitted)=>recovery.handle({command:'securityRecovery',action:'start',channel},token,check) as Promise<ManualRecoverySession>,
    async clear(){await notification.locator('[data-fixture-challenge]').evaluate(node=>node.remove());},
    async close(){await recovery.shutdown();await context.close();store.close();await rm(root,{recursive:true,force:true});}};
}
function business(store:EventStore){
  return ['reply_drafts','send_intents','delivery_receipts','budgets','cursors','collection_progress']
    .map(table=>store.db.prepare('SELECT * FROM '+table).all());
}
const command=(session:ManualRecoverySession,action:'frame'|'close'|'finish')=>({command:'securityRecovery' as const,action,sessionId:session.sessionId});

test('native takeover preserves the original document, freezes browser scheduling and closes without clearing the hold',async()=>{
  const f=await fixture();
  try{
    const document=await f.owner.notification.evaluate(()=>({href:location.href,started:performance.timeOrigin})),before=business(f.store);
    const session=await f.start();let competing=false;
    const queued=f.owner.actor.run(async()=>{competing=true;});await Promise.resolve();expect(competing).toBe(false);
    const frame=await f.recovery.handle(command(session,'frame'),token,permitted) as ManualRecoveryFrame;
    expect(frame.documentPreserved).toBe(true);expect(frame.regions).toHaveLength(1);
    await expect(f.recovery.handle(command(session,'frame'),'different-native-gui',permitted)).rejects.toThrow('MANUAL_RECOVERY_OPERATOR_CHANGED');
    expect(f.recovery.active).toBe(true);
    await f.recovery.handle(command(session,'close'),token,permitted);await queued;
    expect(competing).toBe(true);expect(f.recovery.active).toBe(false);
    expect(readSecurityHold(f.store,channel)?.revision).toBe(f.held.revision);
    expect(await f.owner.notification.evaluate(()=>({href:location.href,started:performance.timeOrigin}))).toEqual(document);
    expect(business(f.store)).toEqual(before);
  }finally{await f.close();}
});

test('a reconnected native operator takes over the same document with a fresh session and no input replay',async()=>{
  const f=await fixture();
  try{
    let originalAuthorized=true;
    const first=await f.start(()=>{if(!originalAuthorized)throw new Blocked('OPERATOR_EXPIRED');});
    const oldFrame=await f.recovery.handle(command(first,'frame'),token,permitted) as ManualRecoveryFrame;
    const document=await f.owner.notification.evaluate(()=>performance.timeOrigin),nextToken='synthetic-reconnected-native-gui';
    originalAuthorized=false;
    const next=await f.recovery.handle({command:'securityRecovery',action:'start',channel},nextToken,permitted) as ManualRecoverySession;
    expect(next.sessionId).not.toBe(first.sessionId);expect(next.incidentId).toBe(first.incidentId);
    await expect(f.recovery.handle(command(first,'frame'),token,permitted)).rejects.toThrow('MANUAL_RECOVERY_OPERATOR_CHANGED');
    await expect(f.recovery.handle(command(first,'close'),nextToken,permitted)).rejects.toThrow('MANUAL_RECOVERY_SESSION_EXPIRED');
    expect(f.recovery.active).toBe(true);
    const frame=await f.recovery.handle(command(next,'frame'),nextToken,permitted) as ManualRecoveryFrame;
    await expect(f.recovery.handle({command:'securityRecovery',action:'input',sessionId:next.sessionId,frameId:oldFrame.frameId,
      sequence:1,input:{kind:'pointer',phase:'down',x:410,y:110}},nextToken,permitted)).rejects.toThrow('MANUAL_RECOVERY_FRAME_EXPIRED');
    await f.recovery.handle({command:'securityRecovery',action:'input',sessionId:next.sessionId,frameId:frame.frameId,
      sequence:2,input:{kind:'pointer',phase:'down',x:410,y:110}},nextToken,permitted);
    await f.recovery.handle({command:'securityRecovery',action:'input',sessionId:next.sessionId,frameId:frame.frameId,
      sequence:3,input:{kind:'pointer',phase:'up',x:410,y:110}},nextToken,permitted);
    expect(await f.owner.notification.evaluate(()=>performance.timeOrigin)).toBe(document);
    await f.recovery.handle(command(next,'close'),nextToken,permitted);
    expect(readSecurityHold(f.store,channel)?.revision).toBe(f.held.revision);
  }finally{await f.close();}
});

test.each(['epoch','instance','mode','document'] as const)('an incident from a different %s cannot be offered as the original page',async change=>{
  const f=await fixture();
  try{
    const file=join(f.root,'evidence','security-incidents',f.held.incidentId+'.json');
    const incident=JSON.parse(await readFile(file,'utf8'));
    if(change==='epoch')incident.context.epoch++;
    if(change==='instance')incident.context.instanceId='a-different-backend';
    if(change==='mode')incident.context.mode='headed';
    if(change==='document')incident.initial.documentStartedAt++;
    await writeFile(file,JSON.stringify(incident));
    const goto=vi.spyOn(f.owner.notification,'goto');
    await expect(f.start()).rejects.toThrow('MANUAL_RECOVERY_ORIGINAL_PAGE_UNAVAILABLE');
    expect(goto).not.toHaveBeenCalled();expect(f.recovery.active).toBe(false);
    expect(readSecurityHold(f.store,channel)?.revision).toBe(f.held.revision);
    goto.mockRestore();
  }finally{await f.close();}
});

test('a replaced original page is rejected without restoring an address or removing the persistent hold',async()=>{
  const f=await fixture();
  try{
    await f.owner.notification.reload();
    const document=await f.owner.notification.evaluate(()=>performance.timeOrigin),goto=vi.spyOn(f.owner.notification,'goto');
    await expect(f.start()).rejects.toThrow('MANUAL_RECOVERY_ORIGINAL_PAGE_UNAVAILABLE');
    expect(goto).not.toHaveBeenCalled();expect(await f.owner.notification.evaluate(()=>performance.timeOrigin)).toBe(document);
    expect(readSecurityHold(f.store,channel)?.revision).toBe(f.held.revision);goto.mockRestore();
  }finally{await f.close();}
});

test('a new challenge after document replacement gets a fresh takeover incident while the lost old evidence remains',async()=>{
  const f=await fixture();
  try{
    const oldFile=join(f.root,'evidence','security-incidents',f.held.incidentId+'.json'),oldEvidence=await readFile(oldFile,'utf8');
    await mountCommentReply(f.owner,origin);
    await f.owner.notification.evaluate(()=>{
      const node=document.createElement('div');node.setAttribute('data-fixture-challenge','');
      node.style.cssText='position:fixed;left:400px;top:100px;width:400px;height:300px;background:white;z-index:100';
      node.textContent='Synthetic challenge on a newly loaded document';document.body.append(node);
    });
    f.binding.epoch=2;f.safety.attach(f.owner,2,'headless');f.safety.instanceId='synthetic-new-backend';
    const started=await f.owner.notification.evaluate(()=>performance.timeOrigin);
    await expect(f.safety.recover(f.owner,channel,undefined,true)).rejects.toThrow('OBSERVATION_SECURITY_SUSPECT');
    const fresh=readSecurityHold(f.store,channel)!;
    expect(fresh.incidentId).not.toBe(f.held.incidentId);expect(fresh.revision).not.toBe(f.held.revision);
    expect(await readFile(oldFile,'utf8')).toBe(oldEvidence);
    expect(await f.safety.incidents.read(fresh.incidentId)).toMatchObject({sameDocument:true,
      initial:{documentStartedAt:started},context:{epoch:2,instanceId:'synthetic-new-backend'}});
    const session=await f.start();expect(session.incidentId).toBe(fresh.incidentId);
    await f.recovery.handle(command(session,'close'),token,permitted);
    expect(readSecurityHold(f.store,channel)?.revision).toBe(fresh.revision);
    expect(new AutomationStore(f.store).state().emergencyStopped).toBe(false);
    expect(f.store.budget('MODEL').used).toBe(0);expect(f.store.budget('SEND').used).toBe(0);
  }finally{await f.close();}
});

test('changing the mapping expires the active lease and cannot leave its account actor reserved',async()=>{
  const f=await fixture();
  try{
    const session=await f.start();
    await writeFile(join(f.root,'observation-mapping.json'),JSON.stringify({...f.mapping,observedAt:'2026-11-06T00:00:00Z'}));
    await expect(f.recovery.handle(command(session,'frame'),token,permitted)).rejects.toThrow('MANUAL_RECOVERY_MAPPING_CHANGED');
    expect(f.recovery.active).toBe(false);
    await f.owner.actor.run(async()=>{});expect(readSecurityHold(f.store,channel)?.revision).toBe(f.held.revision);
  }finally{await f.close();}
});

test('an unreadable changed mapping also releases the lease and returns a fixed private-data-free error',async()=>{
  const f=await fixture();
  try{
    const session=await f.start();
    await writeFile(join(f.root,'observation-mapping.json'),'{"private":"https://private.invalid/secret"');
    await expect(f.recovery.handle(command(session,'frame'),token,permitted)).rejects.toThrow('MANUAL_RECOVERY_MAPPING_CHANGED');
    expect(f.recovery.active).toBe(false);await f.owner.actor.run(async()=>{});
    expect(readSecurityHold(f.store,channel)?.revision).toBe(f.held.revision);
  }finally{await f.close();}
});

test('a later stop or hold revision invalidates the original lease and preserves the newer gate',async()=>{
  const f=await fixture();
  try{
    const session=await f.start();
    const newer=holdSecurityChannel(f.store,channel,{incidentId:randomUUID(),reason:f.held.reason,mode:'headless'});
    recordEmergencyStop(f.store,true,Date.now(),'MANUAL_EMERGENCY_STOP','MANUAL');
    await expect(f.recovery.handle(command(session,'frame'),token,permitted)).rejects.toThrow('MANUAL_RECOVERY_SECURITY_CHANGED');
    expect(f.recovery.active).toBe(false);expect(readSecurityHold(f.store,channel)?.revision).toBe(newer.revision);
    expect(readEmergencyStop(f.store)?.reason).toBe('MANUAL_EMERGENCY_STOP');
    await f.owner.actor.run(async()=>{});
  }finally{await f.close();}
});

test('finish rechecks the same original document in its reserved actor and only clears the bound channel hold',async()=>{
  const f=await fixture();
  try{
    const session=await f.start(),before=business(f.store),document=await f.owner.notification.evaluate(()=>performance.timeOrigin);
    await f.clear();const goto=vi.spyOn(f.owner.notification,'goto');
    await f.recovery.handle(command(session,'finish'),token,permitted);
    expect(f.recovery.active).toBe(false);expect(readSecurityHold(f.store,channel)).toBeNull();
    expect(goto).not.toHaveBeenCalled();expect(await f.owner.notification.evaluate(()=>performance.timeOrigin)).toBe(document);
    expect(business(f.store)).toEqual(before);goto.mockRestore();await f.owner.actor.run(async()=>{});
  }finally{await f.close();}
});

test('a verification candidate or a newer stop during finish cannot clear the channel hold',async()=>{
  const f=await fixture();
  try{
    let session=await f.start();
    await expect(f.recovery.handle(command(session,'finish'),token,permitted)).rejects.toThrow('OBSERVATION_SECURITY_SUSPECT');
    expect(f.recovery.active).toBe(false);expect(readSecurityHold(f.store,channel)?.revision).toBe(f.held.revision);
    await f.clear();session=await f.start();
    const evaluate=f.owner.notification.evaluate.bind(f.owner.notification);let changed=false;
    const hook=vi.spyOn(f.owner.notification,'evaluate').mockImplementation(async(fn,arg)=>{
      if((fn as unknown)===captureObserved){changed=true;recordEmergencyStop(f.store,true,Date.now(),'MANUAL_EMERGENCY_STOP','MANUAL');}
      return evaluate(fn,arg);
    });
    await expect(f.recovery.handle(command(session,'finish'),token,permitted)).rejects.toThrow();
    expect(changed).toBe(true);expect(f.recovery.active).toBe(false);
    expect(readSecurityHold(f.store,channel)?.revision).toBe(f.held.revision);
    expect(readEmergencyStop(f.store)?.reason).toBe('MANUAL_EMERGENCY_STOP');hook.mockRestore();
  }finally{await f.close();}
});

test('a confirmed challenge retains its global stop and also records an original-page takeover incident',async()=>{
  const f=await fixture();
  try{
    resolveSecurityHold(f.store,channel,f.held.revision);
    await expect(f.owner.actor.run(()=>f.safety.failure(channel,f.owner.notification,new Blocked('CHALLENGE_REQUIRED'))))
      .rejects.toThrow('CHALLENGE_REQUIRED');
    const hold=readSecurityHold(f.store,channel)!;
    expect(hold).not.toBeNull();expect(hold.incidentId).not.toBe(f.held.incidentId);
    expect((await f.safety.incidents.read(hold.incidentId))?.sameDocument).toBe(true);
    expect(readEmergencyStop(f.store)?.reason).toBe('CHALLENGE_REQUIRED');
    const session=await f.start();expect(session.incidentId).toBe(hold.incidentId);
    await f.recovery.handle(command(session,'close'),token,permitted);
    expect(readSecurityHold(f.store,channel)?.revision).toBe(hold.revision);
    expect(readEmergencyStop(f.store)?.reason).toBe('CHALLENGE_REQUIRED');
  }finally{await f.close();}
});
