import {afterEach,expect,test,vi} from 'vitest';
import {join} from 'node:path';
import {CollectionScheduler,DeferredObjectRead,type CollectionSource} from '../../src/app/collection-scheduler.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {Blocked} from '../../src/core/contracts.js';
import {database,privateTemp} from '../helpers.js';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();vi.useRealTimers();});
async function setup(collect:(source:CollectionSource,signal:AbortSignal)=>Promise<void>){
  const store=database(),root=privateTemp('collection-cancellation-');
  await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  let now=Date.now();const data=new AutomationStore(store,()=>now);data.initialize(now);store.bindAccount('own-1');
  data.configureCollection({ownId:'own-1',comments:false,inbox:true,commentIntervalMs:30_000,dmIntervalMs:15_000});
  const scheduler=new CollectionScheduler(data,collect);cleanup.push(async()=>{await scheduler.close();store.close();});
  const progress=()=>store.db.prepare("SELECT next_at,last_success,last_error,failures,cursor_json FROM collection_progress WHERE source='dm'").get();
  return {store,data,scheduler,progress,advance:(ms:number)=>{now+=ms;}};
}
function pendingAbort(signal:AbortSignal):Promise<void>{
  return new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});});
}

// DSH 7989640 (MIT), chat-service.mjs:1003-1006 separates aborted maintenance from paused source failure.
// This local scheduler retains its own per-channel cadence and persisted cursor; no upstream send recovery is adopted.
test.each(['CANCEL','CLOSE','SUSPEND','SLICE_TIMEOUT'] as const)('%s preserves the previous real error, checkpoint and success while scheduling only the normal interval',async action=>{
  let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
  const f=await setup(async(_source,signal)=>{entered();await pendingAbort(signal);});
  const before=f.data.now(),cursor=JSON.stringify({active:{conversation:'synthetic-only',phase:'MIN',top:42}});
  f.store.db.prepare("UPDATE collection_progress SET last_success=?,last_error='OBSERVATION_DOM_NOT_READY',failures=3,cursor_json=? WHERE source='dm'").run(before-1000,cursor);
  const budgets=f.store.db.prepare('SELECT * FROM budgets ORDER BY kind').all();
  if(action==='SLICE_TIMEOUT')vi.useFakeTimers();
  const task=f.scheduler.tick();await started;
  if(action==='SLICE_TIMEOUT'){f.advance(30_000);await vi.advanceTimersByTimeAsync(30_000);}
  else{f.advance(123);if(action==='CLOSE')await f.scheduler.close();else if(action==='SUSPEND')f.scheduler.suspend(true);else f.scheduler.cancel();}
  await task;
  expect(f.progress()).toEqual({next_at:f.data.now()+15_000,last_success:before-1000,last_error:'OBSERVATION_DOM_NOT_READY',failures:3,cursor_json:cursor});
  expect(f.data.state().emergencyStopped).toBe(false);expect(f.store.db.prepare('SELECT * FROM budgets ORDER BY kind').all()).toEqual(budgets);
  expect(f.store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
});

test('repeated explicit cancellation and a named cancelled slice never create a fault or fake success, and the next normal read can complete',async()=>{
  let calls=0;const f=await setup(async(_source,signal)=>{calls++;if(calls===1)await pendingAbort(signal);else if(calls===2)throw new Blocked('COLLECTION_CANCELLED');});
  const first=f.scheduler.tick();await Promise.resolve();f.scheduler.cancel();await first;
  expect(f.progress()).toMatchObject({last_success:null,last_error:null,failures:0});
  f.advance(15_000);await f.scheduler.tick();expect(calls).toBe(2);expect(f.progress()).toMatchObject({next_at:f.data.now()+15_000,last_success:null,last_error:null,failures:0});
  f.advance(15_000);await f.scheduler.tick();expect(calls).toBe(3);expect(f.progress()).toMatchObject({last_success:f.data.now(),last_error:null,failures:0});
});

test.each(['DRIVER','OBSERVATION_CANCELLED'])('a cooperative %s rejection after abort remains a cancellation without persisting its private message',async code=>{
  let fail!:(error:Error)=>void;const f=await setup(async()=>new Promise<void>((_resolve,reject)=>{fail=reject;}));
  const task=f.scheduler.tick();await Promise.resolve();f.scheduler.cancel();fail(code==='DRIVER'?Error('PRIVATE_DRIVER_TEXT'):new Blocked('OBSERVATION_CANCELLED'));
  await task;expect(f.progress()).toEqual({next_at:f.data.now()+15_000,last_success:null,last_error:null,failures:0,cursor_json:'{}'});
  expect(JSON.stringify(f.scheduler.status())).not.toContain('PRIVATE_DRIVER_TEXT');
});

test.each(['OBSERVATION_DOM_NOT_READY','OBSERVATION_ACCOUNT_CHANGED','PLATFORM_STOP'])(
  'a specific real %s failure retains exponential backoff and its stop semantics even when cancellation races',async code=>{
    let fail!:(error:Error)=>void;const f=await setup(async()=>new Promise<void>((_resolve,reject)=>{fail=reject;}));
    f.store.db.prepare("UPDATE collection_progress SET failures=3 WHERE source='dm'").run();
    const task=f.scheduler.tick();await Promise.resolve();f.scheduler.cancel();fail(new Blocked(code));await task;
    expect(f.progress()).toMatchObject({next_at:f.data.now()+240_000,last_success:null,last_error:code,failures:4});
    expect(f.data.state().emergencyStopped).toBe(code!=='OBSERVATION_DOM_NOT_READY');
  });

test('a browser close after explicit cancellation is lifecycle interruption while an uncancelled close stays a source failure',async()=>{
  let fail!:(error:Error)=>void;const f=await setup(async()=>new Promise<void>((_resolve,reject)=>{fail=reject;}));
  const first=f.scheduler.tick();await Promise.resolve();f.scheduler.cancel();fail(new Blocked('BROWSER_CLOSED'));await first;
  expect(f.progress()).toMatchObject({next_at:f.data.now()+15_000,last_error:null,last_success:null,failures:0});
  f.advance(15_000);const second=f.scheduler.tick();await Promise.resolve();fail(new Blocked('BROWSER_CLOSED'));await second;
  expect(f.progress()).toMatchObject({next_at:f.data.now()+30_000,last_error:'BROWSER_CLOSED',last_success:null,failures:1});
});

test.each([true,false])('startup only bounds persisted cancellation delays; a real channel error is untouched (cancelled works: %s)',async bothCancelled=>{
  const calls:CollectionSource[]=[],f=await setup(async source=>{calls.push(source);});
  f.data.configureCollection({...f.data.state().collection!,comments:true});
  const before=f.data.now(),cursor=JSON.stringify({active:{phase:'MAX',top:84}});
  f.store.db.prepare("UPDATE collection_progress SET next_at=?,last_success=?,last_error='COLLECTION_CANCELLED',failures=5,cursor_json=?").run(before+600_000,before-1000,cursor);
  if(!bothCancelled)f.store.db.prepare("UPDATE collection_progress SET last_error='OBSERVATION_DOM_NOT_READY' WHERE source='works'").run();
  f.store.db.prepare("UPDATE budgets SET used=CASE kind WHEN 'MODEL' THEN 2 ELSE 1 END").run();
  const budgets=f.store.db.prepare('SELECT * FROM budgets ORDER BY kind').all();f.scheduler.start();await f.scheduler.tick();
  const rows=f.store.db.prepare('SELECT source,next_at,last_success,last_error,failures,cursor_json FROM collection_progress ORDER BY source').all();
  expect(rows).toEqual([{source:'dm',next_at:before+15_000,last_success:before-1000,last_error:'COLLECTION_CANCELLED',failures:5,cursor_json:cursor},
    {source:'works',next_at:before+(bothCancelled?30_000:600_000),last_success:before-1000,last_error:bothCancelled?'COLLECTION_CANCELLED':'OBSERVATION_DOM_NOT_READY',failures:5,cursor_json:cursor}]);
  expect(calls).toEqual([]);expect(f.store.db.prepare('SELECT * FROM budgets ORDER BY kind').all()).toEqual(budgets);
  f.advance(15_000);await f.scheduler.tick();expect(calls).toEqual(['dm']);
});

test('a persisted object deferral retains its normal interval and recorded object error',async()=>{
  const f=await setup(async()=>{throw new DeferredObjectRead('DM_CONTENT_READ_FAILED');});await f.scheduler.tick();
  expect(f.progress()).toMatchObject({next_at:f.data.now()+15_000,last_success:null,last_error:'DM_CONTENT_READ_FAILED',failures:1});
});
