import {afterEach,expect,test,vi} from 'vitest';
import {join} from 'node:path';
import {rm} from 'node:fs/promises';
import {BrowserService} from '../../src/app/browser-service.js';
import {ClientService} from '../../src/app/service.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {Blocked} from '../../src/core/contracts.js';
import {recoverEmergency} from '../../src/app/emergency-recovery.js';
import {EventStore} from '../../src/storage/store.js';
import {pending,privateTemp} from '../helpers.js';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
async function setup(verify:(ownId:string,signal:AbortSignal,check:()=>void)=>Promise<void>){
  const root=privateTemp('emergency-recovery-'),store=new EventStore(join(root,'poc.sqlite'),true);
  let service:ClientService|undefined;
  cleanup.push(async()=>{try{await service?.close();}finally{store.close();await rm(root,{recursive:true,force:true});}});
  await migrateClient(store,join(root,'backup.sqlite'));
  pending(store);
  const browser=new class extends BrowserService{
    override async verifyEmergencyRecovery(ownId:string,signal:AbortSignal,check:()=>void,complete:()=>void=()=>{}){await verify(ownId,signal,check);complete();}
    override async close(){}
  }(root);
  service=new ClientService(store,browser);await service.loadSettings();const token=service.authority.issueSession();
  await service.dispatch(token,{command:'emergencyStop'});
  return {root,store,browser,service,token,data:new AutomationStore(store)};
}
function businessState(store:EventStore){
  return ['reply_drafts','send_intents','delivery_receipts','budgets','automation_grants','cursors','collection_progress']
    .map(table=>store.db.prepare('SELECT * FROM '+table).all());
}

test('a failed recovery check preserves the emergency stop, account pause and all business state',async()=>{
  let checks=0;
  const f=await setup(async(ownId,signal,check)=>{
    checks++;expect(ownId).toBe('own-1');expect(signal.aborted).toBe(false);check();
    expect(f.data.state().emergencyStopped).toBe(true);expect(f.service.authority.paused()).toBe(true);
    throw new Blocked('OBSERVATION_SECURITY_COMPONENT');
  });
  const before=businessState(f.store);
  await expect(f.service.dispatch(f.token,{command:'resume',eventId:null})).rejects.toThrow('OBSERVATION_SECURITY_COMPONENT');
  expect(checks).toBe(1);expect(f.data.state().emergencyStopped).toBe(true);expect(f.service.authority.paused()).toBe(true);
  expect(businessState(f.store)).toEqual(before);
});

test('successful read-only recovery clears the stop only after checking the same account',async()=>{
  let checks=0;
  const f=await setup(async(ownId,_signal,check)=>{
    checks++;expect(ownId).toBe('own-1');check();expect(f.data.state().emergencyStopped).toBe(true);
  });
  const before=businessState(f.store);
  expect(await f.service.dispatch(f.token,{command:'resume',eventId:null})).toMatchObject({paused:false,automation:{emergencyStopped:false}});
  expect(checks).toBe(1);expect(businessState(f.store)).toEqual(before);
});

test('a repeated emergency stop while validation is waiting cannot be cleared by the older recovery',async()=>{
  let entered!:()=>void,release!:()=>void;
  const waiting=new Promise<void>(resolve=>{entered=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});
  const f=await setup(async(_own,_signal,check)=>{check();entered();await hold;check();});
  const resume=f.service.dispatch(f.token,{command:'resume',eventId:null});
  await waiting;
  await f.service.dispatch(f.token,{command:'emergencyStop'});release();
  await expect(resume).rejects.toThrow('EMERGENCY_RECOVERY_CHANGED');
  expect(f.data.state().emergencyStopped).toBe(true);expect(f.service.authority.paused()).toBe(true);
});

test('an ordinary global resume waiting on the browser cannot clear a newer independent stop',async()=>{
  const f=await setup(async()=>{});
  await f.service.dispatch(f.token,{command:'resume',eventId:null});
  await f.service.dispatch(f.token,{command:'pause',eventId:null});
  let entered!:()=>void,release!:()=>void;
  const waiting=new Promise<void>(resolve=>{entered=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});
  let recoverySignal:AbortSignal|undefined;
  vi.spyOn(f.browser,'recoverSecurityHolds').mockImplementation(async(_explicit,signal)=>{
    recoverySignal=signal;entered();await hold;
  });
  const resume=f.service.dispatch(f.token,{command:'resume',eventId:null});
  const stopToken=f.service.authority.issueSession(['READ','CONTROL']);
  try{
    await waiting;
    await f.service.dispatch(stopToken,{command:'emergencyStop'});
    expect(recoverySignal?.aborted).toBe(true);
    const revision=f.data.emergencyRevision();
    release();
    await expect(resume).resolves.toMatchObject({paused:true,automation:{emergencyStopped:true}});
    expect(f.data.emergencyRevision()).toBe(revision);
  }finally{release();f.service.authority.revoke(stopToken);await resume.catch(()=>{});}
});

test('account changes during a recovery check preserve the stop',async()=>{
  const f=await setup(async(_own,_signal,check)=>{
    check();f.store.db.prepare("UPDATE accounts SET own_id='changed-account' WHERE id='account_001'").run();check();
  });
  await expect(f.service.dispatch(f.token,{command:'resume',eventId:null})).rejects.toThrow('ACCOUNT_CHANGED');
  expect(f.data.state().emergencyStopped).toBe(true);expect(f.service.authority.paused()).toBe(true);
});

test.each([false,true])('cancellation returns before an unfinished guard and its late result cannot resume (timeout: %s)',async timeout=>{
  let entered!:()=>void,release!:()=>void;
  const waiting=new Promise<void>(resolve=>{entered=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});
  const f=await setup(async(_own,_signal,check)=>{check();entered();await hold;});
  const abort=new AbortController(),resume=recoverEmergency({store:f.store,data:f.data,authority:f.service.authority,
    browser:f.browser,token:f.token,signal:abort.signal,closing:()=>false});
  await waiting;abort.abort(timeout?new DOMException('synthetic deadline','TimeoutError'):undefined);
  await expect(resume).rejects.toThrow(timeout?'EMERGENCY_RECOVERY_TIMEOUT':'EMERGENCY_RECOVERY_CANCELLED');
  expect(f.data.state().emergencyStopped).toBe(true);release();await Promise.resolve();await Promise.resolve();
  expect(f.data.state().emergencyStopped).toBe(true);expect(f.service.authority.paused()).toBe(true);
});
