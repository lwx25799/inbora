import {afterEach,expect,test,vi} from 'vitest';
import {join} from 'node:path';
import {CollectionScheduler,DeferredObjectRead,type CollectionSource} from '../../src/app/collection-scheduler.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {Blocked} from '../../src/core/contracts.js';
import {database,privateTemp} from '../helpers.js';

type Trigger='BACKGROUND'|'MANUAL';
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();vi.useRealTimers();});
async function setup(read:(source:CollectionSource,signal:AbortSignal,trigger:Trigger)=>Promise<void>){
  const store=database(),root=privateTemp('collection-run-now-');
  await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'auto.sqlite'));
  let now=Date.now();const data=new AutomationStore(store,()=>now);data.initialize(now);store.bindAccount('own-1');
  data.configureCollection({ownId:'own-1',comments:true,inbox:true,commentIntervalMs:30_000,dmIntervalMs:15_000});
  const scheduler=new CollectionScheduler(data,read);
  cleanup.push(async()=>{await scheduler.close();store.close();});
  const progress=(source:CollectionSource='dm')=>store.db.prepare('SELECT next_at,last_success,last_error,failures,cursor_json FROM collection_progress WHERE source=?').get(source);
  return{store,data,scheduler,progress,advance:(ms:number)=>{now+=ms;}};
}
function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return{promise,release};}

test('manual collection waits for the active background turn and shares its single reader slot',async()=>{
  const hold=gate(),entered=gate(),calls:{source:CollectionSource;trigger:Trigger}[]=[];let active=0,maximum=0;
  const f=await setup(async(source,_signal,trigger)=>{
    calls.push({source,trigger});maximum=Math.max(maximum,++active);
    if(calls.length===1){entered.release();await hold.promise;}active--;
  });
  const background=f.scheduler.tick();await entered.promise;
  let manual:Promise<unknown>|undefined;
  try{
    manual=f.scheduler.runNow('dm');await Promise.resolve();await f.scheduler.tick();
    expect(calls).toEqual([{source:'works',trigger:'BACKGROUND'}]);
    hold.release();await background;expect(await manual).toEqual({deferredCode:null});
    expect(calls).toEqual([{source:'works',trigger:'BACKGROUND'},{source:'dm',trigger:'MANUAL'}]);expect(maximum).toBe(1);
    expect(f.progress()).toMatchObject({last_success:f.data.now(),last_error:null,failures:0});
  }finally{hold.release();await background;await manual?.catch(()=>{});}
});

test('two manual requests are serialized and each performs one bounded continuation turn',async()=>{
  const hold=gate(),entered=gate(),calls:CollectionSource[]=[];let active=0,maximum=0;
  const f=await setup(async source=>{calls.push(source);maximum=Math.max(maximum,++active);if(calls.length===1){entered.release();await hold.promise;}active--;});
  const first=f.scheduler.runNow('dm');await entered.promise;const second=f.scheduler.runNow('works');
  try{
    await Promise.resolve();expect(calls).toEqual(['dm']);hold.release();
    expect(await first).toEqual({deferredCode:null});expect(await second).toEqual({deferredCode:null});
    expect(calls).toEqual(['dm','works']);expect(maximum).toBe(1);
    expect(f.store.db.prepare('SELECT count(*) n FROM model_calls').get()).toEqual({n:0});
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{hold.release();await Promise.allSettled([first,second]);}
});

test('manual object deferral reports incomplete work, keeps the success waterline and then resumes normally',async()=>{
  let calls=0;const f=await setup(async()=>{if(++calls===1)throw new DeferredObjectRead('OBSERVATION_DM_CONTENT_DOM_NOT_READY');});
  const before=f.data.now(),cursor='{"phase":"MAX","synthetic":true}';
  f.store.db.prepare("UPDATE collection_progress SET next_at=?,last_success=?,cursor_json=? WHERE source='dm'").run(before+600_000,before-1000,cursor);
  expect(await f.scheduler.runNow('dm')).toEqual({deferredCode:'OBSERVATION_DM_CONTENT_DOM_NOT_READY'});
  expect(f.progress()).toEqual({next_at:before+15_000,last_success:before-1000,last_error:'OBSERVATION_DM_CONTENT_DOM_NOT_READY',failures:1,cursor_json:cursor});
  f.advance(15_000);expect(await f.scheduler.runNow('dm')).toEqual({deferredCode:null});
  expect(calls).toBe(2);expect(f.progress()).toEqual({next_at:f.data.now()+15_000,last_success:f.data.now(),last_error:null,failures:0,cursor_json:cursor});
});

test.each(['OBSERVATION_DOM_NOT_READY','OBSERVATION_ACCOUNT_CHANGED','PLATFORM_STOP'])('manual %s failure is persisted and rejected with the same fixed cause',async code=>{
  const f=await setup(async()=>{throw new Blocked(code);});
  await expect(f.scheduler.runNow('dm')).rejects.toThrow(code);
  expect(f.progress()).toMatchObject({next_at:f.data.now()+30_000,last_success:null,last_error:code,failures:1});
  expect(f.data.state().emergencyStopped).toBe(code!=='OBSERVATION_DOM_NOT_READY');
});

test('a raw manual reader failure exposes a fixed code and never persists its private exception text',async()=>{
  const f=await setup(async()=>{throw Error('PRIVATE_READER_BODY');});
  await expect(f.scheduler.runNow('dm')).rejects.toThrow('COLLECTION_FAILED_PRIVATE_DIAGNOSTICS');
  expect(f.progress()).toMatchObject({last_error:'COLLECTION_FAILED_PRIVATE_DIAGNOSTICS',failures:1});
  expect(JSON.stringify(f.scheduler.status())).not.toContain('PRIVATE_READER_BODY');
});

test.each(['CANCEL','CLOSE','SUSPEND','DEADLINE'] as const)('manual %s retains prior real error and cursor without fabricating success',async action=>{
  const entered=gate(),f=await setup(async(_source,signal)=>{entered.release();await new Promise<void>(resolve=>{
    if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});
  });});
  const before=f.data.now(),cursor='{"checkpoint":"synthetic"}';
  f.store.db.prepare("UPDATE collection_progress SET last_success=?,last_error='OBSERVATION_DOM_NOT_READY',failures=3,cursor_json=? WHERE source='dm'").run(before-1000,cursor);
  if(action==='DEADLINE')vi.useFakeTimers();
  const result=f.scheduler.runNow('dm').catch(error=>error);await entered.promise;
  if(action==='DEADLINE'){f.advance(30_000);await vi.advanceTimersByTimeAsync(30_000);}
  else{f.advance(123);if(action==='CLOSE')await f.scheduler.close();else if(action==='SUSPEND')f.scheduler.suspend(true);else f.scheduler.cancel();}
  expect(await result).toBeInstanceOf(Blocked);expect((await result).code).toBe('COLLECTION_CANCELLED');
  expect(f.progress()).toEqual({next_at:f.data.now()+15_000,last_success:before-1000,last_error:'OBSERVATION_DOM_NOT_READY',failures:3,cursor_json:cursor});
});

test('cancelling while a manual request waits prevents it from acquiring a fresh reader turn',async()=>{
  const hold=gate(),entered=gate(),calls:CollectionSource[]=[];
  const f=await setup(async source=>{calls.push(source);entered.release();await hold.promise;});
  const background=f.scheduler.tick();await entered.promise;
  let manual:Promise<unknown>|undefined;
  try{manual=f.scheduler.runNow('dm').catch(error=>error);f.scheduler.cancel();hold.release();await background;
    expect((await manual as Blocked).code).toBe('COLLECTION_CANCELLED');expect(calls).toEqual(['works']);}
  finally{hold.release();await background;await manual;}
});

test('an aborted manual sync waiting for background does not cancel that reader or start a later manual turn',async()=>{
  const hold=gate(),entered=gate(),calls:CollectionSource[]=[];let backgroundSignal:AbortSignal|undefined;
  const f=await setup(async(source,signal)=>{calls.push(source);backgroundSignal=signal;entered.release();await hold.promise;});
  const background=f.scheduler.tick();await entered.promise;const abort=new AbortController();
  const manual=f.scheduler.runNow('dm',abort.signal).catch(error=>error);
  try{
    abort.abort();await Promise.resolve();expect(backgroundSignal?.aborted).toBe(false);expect(f.scheduler.status().running).toBe(true);
    hold.release();await background;expect((await manual).code).toBe('COLLECTION_CANCELLED');expect(calls).toEqual(['works']);
    expect(f.progress()).toMatchObject({next_at:0,last_success:null,last_error:null,failures:0});
  }finally{hold.release();await background;await manual;}
});

test('the external manual abort signal cancels an active turn and preserves its old checkpoint',async()=>{
  const entered=gate(),f=await setup(async(_source,signal)=>{entered.release();await new Promise<void>(resolve=>{
    if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});
  });});
  const cursor='{"pending":"synthetic"}',before=f.data.now();
  f.store.db.prepare("UPDATE collection_progress SET last_success=?,cursor_json=? WHERE source='dm'").run(before-1000,cursor);
  const abort=new AbortController(),result=f.scheduler.runNow('dm',abort.signal).catch(error=>error);await entered.promise;abort.abort();
  expect((await result).code).toBe('COLLECTION_CANCELLED');
  expect(f.progress()).toEqual({next_at:before+15_000,last_success:before-1000,last_error:null,failures:0,cursor_json:cursor});
});

test.each(['OBSERVATION_DOM_NOT_READY','OBSERVATION_ACCOUNT_CHANGED','PLATFORM_STOP'])('a real manual %s failure retains its meaning when external abort races',async code=>{
  const entered=gate();let fail!:(error:Error)=>void;
  const f=await setup(async()=>{entered.release();await new Promise<void>((_resolve,reject)=>{fail=reject;});});
  f.store.db.prepare("UPDATE collection_progress SET failures=3 WHERE source='dm'").run();
  const abort=new AbortController(),result=f.scheduler.runNow('dm',abort.signal).catch(error=>error);await entered.promise;
  abort.abort();fail(new Blocked(code));expect((await result).code).toBe(code);
  expect(f.progress()).toMatchObject({next_at:f.data.now()+240_000,last_success:null,last_error:code,failures:4});
  expect(f.data.state().emergencyStopped).toBe(code!=='OBSERVATION_DOM_NOT_READY');
});

test.each(['CLOSED','SUSPENDED','EMERGENCY','DISABLED'] as const)('manual %s refuses before invoking a reader',async state=>{
  const calls:CollectionSource[]=[],f=await setup(async source=>{calls.push(source);});
  if(state==='CLOSED')await f.scheduler.close();else if(state==='SUSPENDED')f.scheduler.suspend(true);
  else if(state==='EMERGENCY')f.data.stop(true);else f.data.configureCollection({...f.data.state().collection!,inbox:false});
  await expect(f.scheduler.runNow('dm')).rejects.toThrow('COLLECTION_CANCELLED');expect(calls).toEqual([]);
});

test('old sync-busy backoff is cleared without touching real errors, success or continuation',async()=>{
  const calls:CollectionSource[]=[],f=await setup(async source=>{calls.push(source);}),now=f.data.now(),cursor='{"pending":"synthetic"}';
  f.store.db.prepare("UPDATE collection_progress SET next_at=?,last_success=?,last_error='INBOX_SYNC_IN_PROGRESS',failures=5,cursor_json=? WHERE source='dm'").run(now+600_000,now-1000,cursor);
  f.store.db.prepare("UPDATE collection_progress SET next_at=?,last_success=?,last_error='OBSERVATION_DOM_NOT_READY',failures=3,cursor_json=? WHERE source='works'").run(now+600_000,now-2000,cursor);
  await f.scheduler.tick();expect(calls).toEqual([]);
  expect(f.progress()).toEqual({next_at:now+15_000,last_success:now-1000,last_error:null,failures:0,cursor_json:cursor});
  expect(f.progress('works')).toEqual({next_at:now+600_000,last_success:now-2000,last_error:'OBSERVATION_DOM_NOT_READY',failures:3,cursor_json:cursor});
  f.advance(15_000);await f.scheduler.tick();expect(calls).toEqual(['dm']);
});
