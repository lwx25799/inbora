import {expect,test} from 'vitest';
import {join} from 'node:path';
import {BrowserService} from '../../src/app/browser-service.js';
import {ClientService} from '../../src/app/service.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {Blocked,digest} from '../../src/core/contracts.js';
import {DeferredObjectRead,type CollectionSource} from '../../src/app/collection-scheduler.js';
import type {EventStore} from '../../src/storage/store.js';
import type {InboxSync} from '../../src/app/contracts.js';
import {database,privateTemp} from '../helpers.js';

async function fixture(read:(source:CollectionSource,signal:AbortSignal)=>Promise<void>=async()=>{}){
  const store=database(),root=privateTemp('manual-sync-scheduler-');await migrateClient(store,join(root,'client.sqlite'));store.bindAccount('own-1');
  const legacy:string[]=[],collected:string[]=[];
  class Browser extends BrowserService{
    override identity(){return {identityDigest:digest('own-1'),mappingDigest:'synthetic',browserMode:'headless' as const,browserVersion:'fixture'};}
    override async refreshIdentity(){return this.identity();}
    override async observe(_store:EventStore,source:string){legacy.push(source);}
    override async collect(_data:AutomationStore,source:CollectionSource,signal:AbortSignal){collected.push(source);await read(source,signal);}
    override async close(){}
  }
  const service=new ClientService(store,new Browser(root));await service.loadSettings();
  const token=service.authority.issueSession(),auto=new AutomationStore(store);
  const configure=(comments:boolean,inbox:boolean)=>{
    auto.configureCollection({ownId:'own-1',comments,inbox,commentIntervalMs:30000,dmIntervalMs:15000});
    store.db.prepare('UPDATE collection_progress SET next_at=?').run(Date.now()+3600000);
  };
  const status=async()=>(await service.dispatch(token,{command:'getStatus'}) as {sync:InboxSync}).sync;
  return {store,service,token,auto,legacy,collected,configure,status,close:async()=>{await service.close();store.close();}};
}

test('manual sync reuses enabled collection scopes and keeps disabled sources on their finite legacy path',async()=>{
  const f=await fixture();try{
    f.configure(false,true);await f.service.dispatch(f.token,{command:'syncInbox'});await f.service.drain();
    expect(f.legacy).toEqual(['works']);expect(f.collected).toEqual(['dm']);
    expect((await f.status()).results.map(row=>row.state)).toEqual(['SUCCEEDED','SUCCEEDED']);
    expect(f.store.db.prepare('SELECT used FROM budgets ORDER BY kind').all()).toEqual([{used:0},{used:0}]);
  }finally{await f.close();}
});

test('a deferred object preserves channel capabilities and cannot be called a completed full sync',async()=>{
  const f=await fixture(async source=>{if(source==='dm')throw new DeferredObjectRead('OBSERVATION_DM_CONTENT_DOM_NOT_READY');});try{
    f.configure(true,true);
    for(const channel of ['COMMENT_NOTIFICATION','DIRECT_MESSAGE'] as const)
      f.service.authority.attest(channel,'SEND_AVAILABLE',f.service.browser.identity(channel)!,'SYNTHETIC_PROOF');
    await f.service.dispatch(f.token,{command:'syncInbox'});await f.service.drain();
    expect(f.legacy).toEqual([]);expect(f.collected).toEqual(['works','dm']);
    expect((await f.status()).results).toEqual([{source:'works',state:'SUCCEEDED',error:null},
      {source:'dm',state:'DEFERRED',error:'OBSERVATION_DM_CONTENT_DOM_NOT_READY'}]);
    expect(f.store.db.prepare('SELECT DISTINCT state FROM channel_capabilities').all()).toEqual([{state:'SEND_AVAILABLE'}]);
    expect(f.store.db.prepare("SELECT last_success FROM collection_progress WHERE source='dm'").get()).toEqual({last_success:null});
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{await f.close();}
});

test('an account failure in shared collection stops the later channel and blocks capabilities',async()=>{
  const f=await fixture(async()=>{throw new Blocked('OBSERVATION_ACCOUNT_CHANGED');});try{
    f.configure(true,true);
    for(const channel of ['COMMENT_NOTIFICATION','DIRECT_MESSAGE'] as const)
      f.service.authority.attest(channel,'SEND_AVAILABLE',f.service.browser.identity(channel)!,'SYNTHETIC_PROOF');
    await f.service.dispatch(f.token,{command:'syncInbox'});await f.service.drain();
    expect(f.collected).toEqual(['works']);expect((await f.status()).results).toMatchObject([
      {state:'FAILED',error:'OBSERVATION_ACCOUNT_CHANGED'},{state:'SKIPPED'}]);
    expect(f.store.db.prepare('SELECT DISTINCT state FROM channel_capabilities').all()).toEqual([{state:'BLOCKED'}]);
  }finally{await f.close();}
});
