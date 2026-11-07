import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const source=process.argv[2]==='source',modules=resolve(source?'src':process.argv[2]??'dist');
const moduleUrl=name=>pathToFileURL(join(modules,name.replace(/\.js$/,source?'.ts':'.js'))).href;
const {EventStore}=await import(moduleUrl('storage/store.js'));
const {ClientService}=await import(moduleUrl('app/service.js'));
const {BrowserService}=await import(moduleUrl('app/browser-service.js'));
const {migrateClient}=await import(moduleUrl('storage/client-migration.js'));
const parent=resolve('.local/inbox-sync-smoke');await mkdir(parent,{recursive:true});
const root=await mkdtemp(join(parent,'run-')),store=new EventStore(join(root,'poc.sqlite'),true);
await migrateClient(store,join(root,'backup.sqlite'));
const calls=[];let release,gate=new Promise(r=>{release=r;});
class FixtureBrowser extends BrowserService{
  identity(){return{identityDigest:'synthetic-account',mappingDigest:'synthetic-mapping',browserMode:'headed',browserVersion:'fixture'};}
  async refreshIdentity(){return this.identity();}
  async observe(_store,source){calls.push(source);if(source==='works')await gate;}
  async close(){}
}
const browser=new FixtureBrowser(root);let service=new ClientService(store,browser);
try{
  const token=service.authority.issueSession();
  const started=await service.dispatch(token,{command:'syncInbox'});
  assert.equal(started.sync.running,true);assert.deepEqual(calls,['works']);
  const repeated=await service.dispatch(token,{command:'syncInbox'});
  assert.equal(repeated.sync.runId,started.sync.runId);assert.deepEqual(calls,['works']);
  assert.equal((await service.dispatch(token,{command:'getStatus'})).sync.source,'works');
  release();await service.drain();assert.deepEqual(calls,['works','dm']);
  const done=await service.dispatch(token,{command:'getStatus'});
  assert.deepEqual(done.sync.results.map(r=>r.state),['SUCCEEDED','SUCCEEDED']);assert.equal(done.sync.running,false);
  assert.equal(started.sync.running,true);
  await service.close();service=new ClientService(store,browser);
  const next=service.authority.issueSession();
  assert.equal((await service.dispatch(next,{command:'getStatus'})).sync.runId,null);assert.deepEqual(calls,['works','dm']);
  gate=new Promise(r=>{release=r;});
  await service.dispatch(next,{command:'syncInbox'});
  assert.deepEqual(calls,['works','dm','works']);
  const stopped=await service.dispatch(next,{command:'emergencyStop'});
  assert.equal(stopped.paused,true);assert.equal(stopped.sync.cancelled,true);
  release();await service.drain();assert.deepEqual(calls,['works','dm','works']);
  assert.equal((await service.dispatch(next,{command:'getStatus'})).sync.running,false);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM send_intents').get().n,0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM model_calls').get().n,0);
  console.log(JSON.stringify({inboxSyncSmoke:'PASS',runtime:source?'tsx-source':'compiled-node',serialChannels:2,
    duplicateCoalesced:true,statusWhileReading:true,emergencyStopBeforeNextChannel:true,restartNoReplay:true,
    synthetic:true,realSends:0,modelCalls:0}));
}finally{release();await service.close();store.close();}
