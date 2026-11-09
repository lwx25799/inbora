import {afterEach,expect,test} from 'vitest';
import Database from 'better-sqlite3';
import {copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {modelGrantSchema,replyPolicySchema} from '../../src/app/automation-contracts.js';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {EventStore} from '../../src/storage/store.js';
import {approved,candidate,database,privateTemp,snapshot} from '../helpers.js';

const stores:EventStore[]=[];afterEach(()=>{for(const store of stores.splice(0))store.close();});
const scope={ownId:'own-1',channels:['DIRECT_MESSAGE'],model:'deepseek-flash',modelLimit:10,sendLimit:10,expiresAt:null,
  workIds:[],futureOwnWorks:false,conversationIds:[],entireInbox:true,containsAny:[],excludesAny:[],instructions:'Synthetic only',startHour:0,endHour:24};
async function setup(){
  const root=privateTemp('unlimited-budget-'),store=database();stores.push(store);await migrateClient(store,join(root,'client.sqlite'));
  store.bindAccount('own-1');await migrateAutomation(store,join(root,'automation.sqlite'));
  const auto=new AutomationStore(store);auto.initialize(Date.now()-1000);return {root,store,auto};
}
const policy=(modelLimit:number|null,sendLimit:number|null)=>replyPolicySchema.parse({...scope,modelLimit,sendLimit});

test('explicit null policy quotas pass the former caps while every global use and reservation stays counted',async()=>{
  const {store,auto}=await setup(),grant=auto.grant('AUTO_REPLY',policy(null,null));
  for(const kind of ['MODEL','SEND'] as const)for(let index=0;index<53;index++)store.db.transaction(()=>{
    auto.reserve(grant.version,kind,`${kind}-${index}`);store.consumeBudget(kind);
  }).immediate();
  expect(store.db.prepare('SELECT kind,used FROM budgets ORDER BY kind').all()).toEqual([{kind:'MODEL',used:53},{kind:'SEND',used:53}]);
  expect(store.db.prepare('SELECT * FROM budget_limits ORDER BY kind').all()).toEqual([{kind:'MODEL',maximum:null},{kind:'SEND',maximum:null}]);
  expect(auto.allowance(grant.version,'MODEL')).toBe(true);expect(auto.allowance(grant.version,'SEND')).toBe(true);
  expect(()=>auto.reserve(grant.version,'MODEL','MODEL-0')).toThrow('GRANT_JOB_ALREADY_RESERVED');
  auto.stop(true);expect(()=>auto.reserve(grant.version,'SEND','stopped')).toThrow('EMERGENCY_STOPPED');auto.stop(false);
  const finite=auto.grant('AUTO_REPLY',policy(55,55));
  expect(store.budgets()).toEqual([{kind:'MODEL',used:53,maximum:55},{kind:'SEND',used:53,maximum:55}]);
  for(const kind of ['MODEL','SEND'] as const)for(let index=53;index<55;index++)store.db.transaction(()=>{
    auto.reserve(finite.version,kind,`${kind}-${index}`);store.consumeBudget(kind);
  }).immediate();
  expect(()=>auto.reserve(finite.version,'MODEL','over-finite')).toThrow('MODEL_GRANT_EXHAUSTED');
  expect(()=>store.consumeBudget('SEND')).toThrow('BUDGET_EXHAUSTED');
  auto.revoke('AUTO_REPLY');expect(()=>auto.reserve(grant.version,'SEND','revoked')).toThrow('GRANT_REVOKED');
});

test('finite saved policy stays finite and changing unlimited back to finite carries consumption without extending an existing finite global cap',async()=>{
  const {store,auto}=await setup();const finite=auto.grant('AUTO_REPLY',policy(10,10));
  const initial=store.db.prepare('SELECT * FROM budgets ORDER BY kind').all();expect(auto.active('AUTO_REPLY')!.scope.modelLimit).toBe(10);
  for(const kind of ['MODEL','SEND'] as const){auto.reserve(finite.version,kind,'consumed');store.consumeBudget(kind);}
  const unlimited=auto.grant('AUTO_REPLY',policy(null,null));
  expect(store.db.prepare('SELECT kind,count(*) n FROM grant_reservations WHERE grant_version=? GROUP BY kind ORDER BY kind').all(unlimited.version))
    .toEqual([{kind:'MODEL',n:1},{kind:'SEND',n:1}]);
  expect(()=>auto.grant('AUTO_REPLY',policy(1,0))).toThrow();expect(auto.active('AUTO_REPLY')!.version).toBe(unlimited.version);
  const restored=auto.grant('AUTO_REPLY',policy(4,3));
  expect(store.db.prepare('SELECT * FROM budget_limits ORDER BY kind').all()).toEqual([{kind:'MODEL',maximum:4},{kind:'SEND',maximum:3}]);
  expect(store.db.prepare('SELECT kind,used FROM budgets ORDER BY kind').all()).toEqual([{kind:'MODEL',used:1},{kind:'SEND',used:1}]);
  expect(store.db.prepare('SELECT kind,maximum FROM budgets ORDER BY kind').all()).toEqual(initial.map(row=>({kind:(row as {kind:string}).kind,maximum:(row as {maximum:number}).maximum})));
  expect(()=>auto.grant('AUTO_REPLY',policy(5,3))).toThrow('MODEL_BUDGET_EXCEEDED');
  expect(auto.active('AUTO_REPLY')!.version).toBe(restored.version);
  for(const kind of ['MODEL','SEND'] as const)expect(()=>auto.reserve(restored.version,kind,'consumed')).toThrow('GRANT_JOB_ALREADY_RESERVED');
});

test('model-only nullable scope and key saves preserve the explicit global choice and prior reservations across restart',async()=>{
  const {root,store,auto}=await setup();
  const model=modelGrantSchema.parse({ownId:'own-1',channels:['DIRECT_MESSAGE'],model:'deepseek-flash',modelLimit:null,expiresAt:null});
  const first=auto.grant('MODEL',model);auto.reserve(first.version,'MODEL','already-used');store.consumeBudget('MODEL');
  const second=auto.grant('MODEL',model);expect(()=>auto.reserve(second.version,'MODEL','already-used')).toThrow('GRANT_JOB_ALREADY_RESERVED');
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();const token=service.authority.issueSession();
  try{
    await service.dispatch(token,{command:'configureAi',settings:{model:'deepseek-flash',persona:'',business:'',rules:''},key:'synthetic-only-key'});
    expect(new AutomationStore(store).active('MODEL')!.scope.modelLimit).toBeNull();
    expect(await service.dispatch(token,{command:'getStatus'})).toMatchObject({budgets:expect.arrayContaining([{kind:'MODEL',used:1,maximum:null}])});
    await service.dispatch(token,{command:'setModelGrant',scope:null,confirmed:true});
    await service.dispatch(token,{command:'configureAi',settings:{model:'deepseek-flash',persona:'',business:'',rules:''},key:'synthetic-only-key'});
    expect(new AutomationStore(store).active('MODEL')!.scope.modelLimit).toBeNull();
    expect(store.db.prepare("SELECT used FROM budgets WHERE kind='MODEL'").get()).toEqual({used:1});
  }finally{await service.close();}
});

test('schema2 private backup upgrades and restores without changing finite caps, usage, reservations or old unknown intents',async()=>{
  const root=privateTemp('unlimited-migration-'),store=database();stores.push(store);
  const draft=approved(store),intent=store.recordIntent(draft,snapshot(candidate()),false);store.receipt(intent,'UNCERTAIN','synthetic-unknown');
  await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'first.sqlite'));
  const data=new AutomationStore(store);data.initialize(Date.now()-1000);const grant=data.grant('AUTO_REPLY',policy(10,10));data.reserve(grant.version,'MODEL','old-reservation');
  // Recreate the actual previous extension version, retaining the same real SQLite business tables.
  store.db.exec(`DROP TABLE IF EXISTS budget_limits;DROP TABLE automation_schema;CREATE TABLE automation_schema(version INTEGER PRIMARY KEY CHECK(version=2));INSERT INTO automation_schema VALUES(2);`);
  store.db.prepare("UPDATE budgets SET used=CASE kind WHEN 'MODEL' THEN 7 ELSE 9 END").run();
  const before=store.db.prepare('SELECT * FROM budgets ORDER BY kind').all(),backup=join(root,'schema2-backup.sqlite');
  expect(await migrateAutomation(store,backup)).toBe(true);expect(store.db.prepare('SELECT version FROM automation_schema').get()).toEqual({version:3});
  expect(store.db.prepare('SELECT * FROM budgets ORDER BY kind').all()).toEqual(before);
  expect(store.db.prepare('SELECT * FROM budget_limits ORDER BY kind').all()).toEqual([{kind:'MODEL',maximum:50},{kind:'SEND',maximum:20}]);
  expect(store.db.prepare('SELECT status FROM send_intents').get()).toEqual({status:'UNCERTAIN'});
  expect(new AutomationStore(store).active('AUTO_REPLY')!.scope).toMatchObject({modelLimit:10,sendLimit:10});
  expect(store.db.prepare('SELECT grant_version,kind,job_key FROM grant_reservations').all()).toEqual([{grant_version:grant.version,kind:'MODEL',job_key:'old-reservation'}]);
  const restored=join(root,'restored.sqlite');await copyFile(backup,restored);const db=new Database(restored,{readonly:true});
  try{expect(db.pragma('quick_check',{simple:true})).toBe('ok');expect(db.prepare('SELECT * FROM budgets ORDER BY kind').all()).toEqual(before);
    expect(db.prepare('SELECT version FROM automation_schema').get()).toEqual({version:2});expect(db.prepare('SELECT status FROM send_intents').get()).toEqual({status:'UNCERTAIN'});
  }finally{db.close();}
  expect(await migrateAutomation(store,join(root,'no-second-migration.sqlite'))).toBe(false);
});

test('two SQLite connections share the final finite allowance and keep counting unlimited reservations',async()=>{
  const {store,auto}=await setup(),other=new EventStore(store.db.name);stores.push(other);
  const second=new AutomationStore(other),grant=auto.grant('AUTO_REPLY',policy(2,2));
  const consume=(data:AutomationStore,key:string)=>data.store.db.transaction(()=>{data.reserve(data.active('AUTO_REPLY')!.version,'MODEL',key);data.store.consumeBudget('MODEL');}).immediate();
  consume(auto,'first');const results=await Promise.allSettled([Promise.resolve().then(()=>consume(auto,'last-a')),Promise.resolve().then(()=>consume(second,'last-b'))]);
  expect(results.map(result=>result.status).sort()).toEqual(['fulfilled','rejected']);expect(store.budget('MODEL').used).toBe(2);
  const unlimited=auto.grant('AUTO_REPLY',policy(null,null));
  await Promise.all(Array.from({length:20},(_,index)=>Promise.resolve().then(()=>consume(index%2?auto:second,`unlimited-${index}`))));
  expect(store.budget('MODEL')).toMatchObject({used:22,maximum:null});
  expect(store.db.prepare("SELECT count(*) n FROM grant_reservations WHERE grant_version=? AND kind='MODEL'").get(unlimited.version)).toEqual({n:22});
  expect(auto.allowance(grant.version,'MODEL')).toBe(false);
});

test('invalid finite changes roll back both global policies and the active scope without resetting previous consumption',async()=>{
  const {store,auto}=await setup(),grant=auto.grant('AUTO_REPLY',policy(10,10));
  store.db.prepare("UPDATE budgets SET used=9 WHERE kind='SEND'").run();
  expect(()=>auto.grant('AUTO_REPLY',policy(null,20))).toThrow('SEND_BUDGET_EXCEEDED');
  expect(auto.active('AUTO_REPLY')!.version).toBe(grant.version);expect(store.budget('MODEL').maximum).toBe(50);
  const unlimited=auto.grant('AUTO_REPLY',policy(null,null));auto.reserve(unlimited.version,'MODEL','consumed-a');store.consumeBudget('MODEL');
  auto.reserve(unlimited.version,'MODEL','consumed-b');store.consumeBudget('MODEL');
  expect(()=>auto.grant('AUTO_REPLY',policy(1,10))).toThrow('MODEL_BUDGET_EXCEEDED');
  expect(auto.active('AUTO_REPLY')!.version).toBe(unlimited.version);expect(store.budget('MODEL')).toMatchObject({used:2,maximum:null});
  for(const invalid of [0,-1,1.5,'',false,undefined,Number.POSITIVE_INFINITY,Number.MAX_SAFE_INTEGER+1])expect(modelGrantSchema.safeParse({
    ownId:'own-1',channels:['DIRECT_MESSAGE'],model:'deepseek-flash',modelLimit:invalid,expiresAt:null,
  }).success).toBe(false);
});
