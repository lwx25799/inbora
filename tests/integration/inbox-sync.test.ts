import {expect,test} from 'vitest';
import {join} from 'node:path';
import {BrowserService} from '../../src/app/browser-service.js';
import {ClientService} from '../../src/app/service.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {Blocked,digest} from '../../src/core/contracts.js';
import {database,privateTemp} from '../helpers.js';
import type {EventStore} from '../../src/storage/store.js';

type Source='works'|'dm'|'notifications';
async function fixture(read:(source:Source)=>Promise<void>){
  const store=database(),root=privateTemp('inbox-sync-');await migrateClient(store,join(root,'backup.sqlite'));
  const calls:Source[]=[];
  class SyncBrowser extends BrowserService{
    closes=0;
    override identity(){return{identityDigest:digest('own-1'),mappingDigest:'sync-fixture',browserMode:'headless' as const,browserVersion:'fixture'};}
    override async refreshIdentity(){return this.identity();}
    override async observe(_store:EventStore,source:Source){calls.push(source);await read(source);}
    override async close(){this.closes++;}
  }
  const browser=new SyncBrowser(root),service=new ClientService(store,browser),token=service.authority.issueSession();
  expect(browser.identity().browserMode).toBe(browser.status().mode);
  for(const channel of ['COMMENT_NOTIFICATION','DIRECT_MESSAGE'] as const)service.authority.attest(channel,'SEND_AVAILABLE',browser.identity(),'synthetic-sync-proof');
  const status=async()=>await service.dispatch(token,{command:'getStatus'}) as {sync:{runId:string|null;running:boolean;cancelled:boolean;source:Source|null;results:{source:Source;state:string;error:string|null}[]}};
  return{store,browser,service,token,calls,status,close:async()=>{await service.close();store.close();}};
}
function deferred(){let release!:()=>void;const promise=new Promise<void>(r=>{release=r;});return{promise,release};}

test('one inbox sync returns immediately, runs channels serially, coalesces repeats and retains authoritative progress',async()=>{
  const first=deferred(),second=deferred(),f=await fixture(source=>source==='works'?first.promise:second.promise);
  try{
    const start=await f.service.dispatch(f.token,{command:'syncInbox'}) as {sync:{runId:string;running:boolean}};
    expect(start.sync.running).toBe(true);expect(start.sync.runId).toBeTruthy();
    await expect.poll(()=>f.calls).toEqual(['works']);
    expect(await f.status()).toMatchObject({sync:{running:true,source:'works'}});
    const repeated=await f.service.dispatch(f.token,{command:'syncInbox'});
    expect(repeated).toMatchObject({sync:{runId:start.sync.runId}});expect(f.calls).toEqual(['works']);
    await expect(f.service.dispatch(f.token,{command:'observe',source:'notifications'})).rejects.toThrow('INBOX_SYNC_IN_PROGRESS');
    first.release();await expect.poll(()=>f.calls).toEqual(['works','dm']);
    expect(await f.status()).toMatchObject({sync:{running:true,source:'dm',results:[{source:'works',state:'SUCCEEDED'},{source:'dm',state:'RUNNING'}]}});
    second.release();await f.service.drain();
    expect(await f.status()).toMatchObject({sync:{running:false,source:null,results:[{state:'SUCCEEDED'},{state:'SUCCEEDED'}]}});
    expect(start.sync.running).toBe(true); // Previously returned snapshots are immutable.
    expect(f.store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
    expect(f.store.db.prepare('SELECT count(*) AS n FROM model_calls').get()).toEqual({n:0});
  }finally{first.release();second.release();await f.close();}
});

test.each(['works','dm'] as const)('ordinary %s failure preserves the other channel and reports a safe error without a retry',async failed=>{
  const f=await fixture(async source=>{if(source===failed)throw new Blocked('OBSERVATION_DOM_NOT_READY');});try{
    await f.service.dispatch(f.token,{command:'syncInbox'});await f.service.drain();
    expect(f.calls).toEqual(['works','dm']);
    const result=(await f.status()).sync;expect(result.running).toBe(false);
    expect(result.results.find(r=>r.source===failed)).toMatchObject({state:'FAILED',error:'OBSERVATION_DOM_NOT_READY'});
    expect(result.results.find(r=>r.source!==failed)).toMatchObject({state:'SUCCEEDED',error:null});
    const caps=f.store.db.prepare('SELECT channel,state FROM channel_capabilities ORDER BY channel').all();
    expect(caps).toEqual([{channel:'COMMENT_NOTIFICATION',state:failed==='works'?'BLOCKED':'SEND_AVAILABLE'},{channel:'DIRECT_MESSAGE',state:failed==='dm'?'BLOCKED':'SEND_AVAILABLE'}]);
  }finally{await f.close();}
});

test.each(['OBSERVATION_PAGE_BLOCKED','OBSERVATION_ACCOUNT_CHANGED','PLATFORM_STOP','CHALLENGE_REQUIRED','LOGIN_REQUIRED','ACCOUNT_NOT_VERIFIED','OWNER_LOCKED_OR_PORT_UNAVAILABLE'])
('account-wide %s stops the next channel',async code=>{
  const f=await fixture(async()=>{throw new Blocked(code);});try{
    await f.service.dispatch(f.token,{command:'syncInbox'});await f.service.drain();
    expect(f.calls).toEqual(['works']);expect((await f.status()).sync.results).toMatchObject([{state:'FAILED',error:code},{state:'SKIPPED'}]);
    expect(f.store.db.prepare("SELECT count(*) AS n FROM channel_capabilities WHERE state='BLOCKED'").get()).toEqual({n:2});
  }finally{await f.close();}
});

test.each(['emergencyStop','browser'] as const)('%s responds while a channel is waiting and prevents the second channel from starting',async command=>{
  const gate=deferred(),f=await fixture(()=>gate.promise);try{
    await f.service.dispatch(f.token,{command:'syncInbox'});await expect.poll(()=>f.calls.length).toBe(1);
    const result=await f.service.dispatch(f.token,command==='browser'?{command:'browser',open:false,mode:'headed'}:{command:'emergencyStop'});
    expect(result).toBeTruthy();expect(await f.status()).toMatchObject({sync:{running:true,cancelled:true}});
    await f.service.dispatch(f.token,{command:'syncInbox'});expect(f.calls).toEqual(['works']);
    gate.release();await f.service.drain();expect(f.calls).toEqual(['works']);
    expect((await f.status()).sync).toMatchObject({running:false,cancelled:true,results:[{state:'CANCELLED'},{state:'CANCELLED'}]});
    await f.service.dispatch(f.token,{command:'syncInbox'});await f.service.drain();expect(f.calls).toEqual(['works','works','dm']);
  }finally{gate.release();await f.close();}
});

test('raw failures stay private, new connections do not replay reads, and a legacy read cannot overlap inbox sync',async()=>{
  const gate=deferred(),f=await fixture(source=>source==='notifications'?gate.promise:Promise.reject(Error('private marker must not escape')));
  let old:Promise<unknown>|undefined;try{
    old=f.service.dispatch(f.token,{command:'observe',source:'notifications'});await expect.poll(()=>f.calls.length).toBe(1);
    await expect(f.service.dispatch(f.token,{command:'syncInbox'})).rejects.toThrow('INBOX_SYNC_IN_PROGRESS');
    gate.release();await old;
    await f.service.dispatch(f.token,{command:'syncInbox'});await f.service.drain();
    const report=await f.status();expect(JSON.stringify(report)).not.toContain('private marker');
    expect(report.sync.results).toMatchObject([{state:'FAILED',error:'OPERATION_FAILED_PRIVATE_DIAGNOSTICS'},{state:'FAILED',error:'OPERATION_FAILED_PRIVATE_DIAGNOSTICS'}]);
    const reconnect=f.service.authority.issueSession();await f.service.dispatch(reconnect,{command:'getStatus'});expect(f.calls).toEqual(['notifications','works','dm']);
  }finally{gate.release();await old?.catch(()=>{});await f.close();}
});

test('a read-only operator cannot start sync and expiry between channels stops the next read',async()=>{
  const gate=deferred(),f=await fixture(()=>gate.promise);try{
    await expect(f.service.dispatch(f.token,{command:'syncInbox',source:'notifications'})).rejects.toThrow();
    const readOnly=f.service.authority.issueSession(['READ']);
    await expect(f.service.dispatch(readOnly,{command:'syncInbox'})).rejects.toThrow('OPERATOR_PERMISSION_DENIED');expect(f.calls).toEqual([]);
    await f.service.dispatch(f.token,{command:'syncInbox'});await expect.poll(()=>f.calls.length).toBe(1);
    f.service.authority.revoke(f.token);gate.release();await f.service.drain();
    const fresh=f.service.authority.issueSession();
    const report=await f.service.dispatch(fresh,{command:'getStatus'});
    expect(report).toMatchObject({sync:{running:false,results:[{source:'works',state:'SUCCEEDED'},{source:'dm',state:'FAILED',error:'OPERATOR_EXPIRED'}]}});
    expect(f.calls).toEqual(['works']);
  }finally{gate.release();await f.close();}
});

test('a real database account mismatch stops before reading the second channel',async()=>{
  let store:EventStore|undefined;
  const f=await fixture(async source=>{store!.observe(source==='dm'?'DIRECT_MESSAGE':'COMMENT_NOTIFICATION','synthetic',[],'wrong-account','synthetic-only');});
  store=f.store;store.bindAccount('original-account');
  try{
    await f.service.dispatch(f.token,{command:'syncInbox'});await f.service.drain();
    expect(f.calls).toEqual(['works']);
    expect((await f.status()).sync.results).toMatchObject([{state:'FAILED',error:'ACCOUNT_CHANGED'},{state:'SKIPPED'}]);
    expect(store.db.prepare('SELECT count(*) AS n FROM observations').get()).toEqual({n:0});
  }finally{await f.close();}
});
