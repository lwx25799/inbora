import {afterEach,expect,test} from 'vitest';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Blocked,targetKey} from '../../src/core/contracts.js';
import {configureAssistantConnection} from '../../src/app/local-assistant-connection.js';
import {LocalAssistantStore} from '../../src/storage/local-assistant-store.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {migrateLocalAssistant} from '../../src/storage/local-assistant-migration.js';
import {EventStore} from '../../src/storage/store.js';
import {candidate,database,privateTemp} from '../helpers.js';
import {observedMapping} from '../fixtures/observed-site.js';

const stores:EventStore[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();});
const now=Date.parse('2026-11-11T08:00:00Z'),start=now-3600_000;
async function setup(ready=true){
  const store=database(),root=privateTemp('assistant-connection-');stores.push(store);
  await migrateClient(store,join(root,'client.sqlite'));
  await migrateAutomation(store,join(root,'automation.sqlite'));
  await migrateLocalAssistant(store,join(root,'assistant.sqlite'));
  const auto=new AutomationStore(store,()=>now);auto.initialize(start);
  if(ready){
    store.bindAccount('100');auto.configureCollection({ownId:'100',comments:true,inbox:true,
      commentIntervalMs:30000,dmIntervalMs:30000});
  }
  const assistant=new LocalAssistantStore(store,()=>now);
  const configure=(mode:'IF_NEW'|'ENABLE'|'DISABLE',check?:()=>void)=>configureAssistantConnection(assistant,root,mode,check);
  const mapping={...observedMapping('https://www.douyin.com'),environment:'douyin' as const};
  return {store,root,auto,assistant,configure,mapping};
}

test('trusted first connection adopts current collection and global limits without touching other grants or spend',async()=>{
  const f=await setup();
  const model=f.auto.grant('MODEL',{ownId:'100',channels:['DIRECT_MESSAGE'],model:'deepseek-flash',modelLimit:2,expiresAt:null});
  f.store.consumeBudget('MODEL');f.store.consumeBudget('SEND');
  const budgets=f.store.budgets(),modelRow=f.store.db.prepare('SELECT * FROM automation_grants WHERE version=?').get(model.version);
  await writeFile(join(f.root,'observation-mapping.json'),JSON.stringify(f.mapping));
  expect(f.assistant.state()).toMatchObject({connectionEnabled:true,grant:null});
  expect(f.assistant.hasGrantHistory()).toBe(false);
  expect(await f.configure('IF_NEW')).toBe(true);
  const grant=f.assistant.require('send');
  expect(grant.scope).toMatchObject({ownId:'100',channels:['COMMENT_NOTIFICATION','DIRECT_MESSAGE'],
    permissions:{read:true,editControl:true,send:true},expiresAt:null,modelLimit:null,sendLimit:null,
    collection:{startedAt:start,comments:true,inbox:true,workIds:['10']}});
  expect(f.assistant.state()).toMatchObject({connectionEnabled:true,remaining:{MODEL:49,SEND:19}});
  expect(f.store.budgets()).toEqual(budgets);
  expect(f.store.db.prepare('SELECT * FROM automation_grants WHERE version=?').get(model.version)).toEqual(modelRow);
  expect(await f.configure('IF_NEW')).toBe(false);expect(f.assistant.active()?.version).toBe(grant.version);
});

test('stopping before the first grant persists and trusted reconnect never restores a revoked connection',async()=>{
  const f=await setup();
  expect(await f.configure('DISABLE')).toBe(true);
  expect(f.assistant.hasGrantHistory()).toBe(true);
  expect(new LocalAssistantStore(f.store,()=>now).state()).toMatchObject({connectionEnabled:false,grant:null});
  expect(await f.configure('IF_NEW')).toBe(false);expect(f.assistant.active()).toBeNull();
  expect(await f.configure('ENABLE')).toBe(true);const version=f.assistant.active()!.version;
  expect(await f.configure('DISABLE')).toBe(true);
  expect(await f.configure('IF_NEW')).toBe(false);
  expect(f.assistant.state()).toMatchObject({connectionEnabled:false,grant:null});
  expect(await f.configure('ENABLE')).toBe(true);expect(f.assistant.active()!.version).toBeGreaterThan(version);
});

test('first connection waits for verified account and nonempty collection, but mapping and lifecycle errors remain visible',async()=>{
  const f=await setup(false);
  expect(await f.configure('IF_NEW')).toBe(false);expect(f.assistant.hasGrantHistory()).toBe(false);
  f.store.bindAccount('100');f.auto.configureCollection({ownId:'100',comments:false,inbox:false,
    commentIntervalMs:30000,dmIntervalMs:30000});
  expect(await f.configure('IF_NEW')).toBe(false);
  f.auto.configureCollection({...f.auto.state().collection!,inbox:true});
  f.store.db.prepare('DELETE FROM accounts').run();
  expect(await f.configure('IF_NEW')).toBe(false);expect(f.assistant.hasGrantHistory()).toBe(false);
  f.store.bindAccount('100');await writeFile(join(f.root,'observation-mapping.json'),'{');
  await expect(f.configure('IF_NEW')).rejects.toThrow(SyntaxError);
  await writeFile(join(f.root,'observation-mapping.json'),JSON.stringify(f.mapping));
  await expect(f.configure('IF_NEW',()=>{throw new Blocked('CLIENT_CLOSING');})).rejects.toThrow('CLIENT_CLOSING');
  expect(f.assistant.hasGrantHistory()).toBe(false);
  expect(await f.configure('IF_NEW')).toBe(true);
  expect(f.assistant.active()!.scope.channels).toEqual(['DIRECT_MESSAGE']);
});

test('awaited mapping binds only verified own works and first connections cannot create duplicate grants or undo disable',async()=>{
  const f=await setup();
  await writeFile(join(f.root,'observation-mapping.json'),JSON.stringify({...f.mapping,self:{uid:'999',secUid:'other-self'}}));
  await Promise.all([f.configure('IF_NEW'),f.configure('IF_NEW')]);
  expect(f.assistant.active()!.scope.collection.workIds).toEqual([]);
  expect(f.store.db.prepare("SELECT count(*) n FROM automation_grants WHERE kind='LOCAL_ASSISTANT'").get()).toEqual({n:1});
  const other=await setup();
  expect(await other.configure('IF_NEW',()=>other.assistant.revoke())).toBe(false);
  expect(other.assistant.state()).toMatchObject({connectionEnabled:false,grant:null});
  expect(other.store.db.prepare("SELECT count(*) n FROM automation_grants WHERE kind='LOCAL_ASSISTANT'").get()).toEqual({n:0});
});

test('legacy finite scope and digest survive connection; nullable reenable preserves consumed assistant and global usage',async()=>{
  const f=await setup();
  const event=candidate({actorId:'200',occurredAt:new Date(start+60000).toISOString()});
  const [eventId]=f.store.observe('DIRECT_MESSAGE',event.conversationId!,[event],'100','synthetic',new Date(now).toISOString(),start);
  f.store.db.prepare('INSERT INTO collection_targets VALUES(?,?,?,?,?,?,?)').run(targetKey(event),'100','200','peer-sec','Fixture peer',event.conversationId,now);
  f.store.db.prepare('INSERT INTO discovered_conversations VALUES(?,?,?,?,?,?,?,0)').run(event.conversationId,'100','200','peer-sec','Fixture peer',now,now);
  const grant=f.assistant.grant({ownId:'100',channels:['DIRECT_MESSAGE'],permissions:{read:true,editControl:true,send:true},
    expiresAt:now+60_000,modelLimit:1,sendLimit:1});
  f.store.db.transaction(()=>{f.assistant.reserve(grant.version,'MODEL','legacy-model',f.store.event(eventId!));f.store.consumeBudget('MODEL');}).immediate();
  const before=f.store.db.prepare('SELECT * FROM automation_grants WHERE version=?').get(grant.version),budgets=f.store.budgets();
  expect(await f.configure('IF_NEW')).toBe(false);
  expect(f.store.db.prepare('SELECT * FROM automation_grants WHERE version=?').get(grant.version)).toEqual(before);
  expect(f.assistant.state()).toMatchObject({remaining:{MODEL:0,SEND:1}});
  expect(new LocalAssistantStore(f.store,()=>now+60001).active()).toBeNull();
  await f.configure('DISABLE');await f.configure('ENABLE');
  const revised=f.assistant.active()!;
  expect(revised.scope).toMatchObject({expiresAt:null,modelLimit:null,sendLimit:null});
  expect(f.assistant.usage(revised.version)).toEqual({MODEL:1,SEND:0});expect(f.store.budgets()).toEqual(budgets);
  f.store.db.prepare("UPDATE budget_limits SET maximum=1 WHERE kind='MODEL'").run();
  expect(f.assistant.allowance(revised.version,'MODEL')).toBe(false);
  expect(()=>f.assistant.reserve(revised.version,'MODEL','exhausted',f.store.event(eventId!))).toThrow('ASSISTANT_MODEL_EXHAUSTED');
  f.store.db.prepare("UPDATE budget_limits SET maximum=NULL WHERE kind='MODEL'").run();
  expect(f.assistant.state().remaining.MODEL).toBeNull();
  expect(f.assistant.allowance(revised.version,'MODEL')).toBe(true);
  f.store.db.transaction(()=>{f.assistant.reserve(revised.version,'MODEL','unlimited-model',f.store.event(eventId!));f.store.consumeBudget('MODEL');}).immediate();
  expect(f.store.budget('MODEL')).toMatchObject({used:2,maximum:null});expect(f.assistant.state().used.MODEL).toBe(2);
  f.store.db.prepare("UPDATE budget_limits SET maximum=1 WHERE kind='SEND'").run();
  f.store.db.transaction(()=>{f.store.consumeBudget('SEND');f.assistant.reserve(revised.version,'SEND','last-send',f.store.event(eventId!),true);}).immediate();
  expect(f.assistant.state().remaining.SEND).toBe(0);expect(f.assistant.allowance(revised.version,'SEND')).toBe(false);
  expect(f.store.budget('SEND')).toMatchObject({used:1,maximum:1});
});

test('explicit disable survives database reopen and an earlier asynchronous enable cannot restore it',async()=>{
  const f=await setup();
  const enabling=f.configure('ENABLE');
  expect(await f.configure('DISABLE')).toBe(true);
  expect(await enabling).toBe(false);expect(f.assistant.state().connectionEnabled).toBe(false);
  const file=f.store.db.name;f.store.close();stores.splice(stores.indexOf(f.store),1);
  const restored=new EventStore(file);stores.push(restored);
  const assistant=new LocalAssistantStore(restored,()=>now);
  expect(assistant.state()).toMatchObject({grant:null,connectionEnabled:false});
  expect(await configureAssistantConnection(assistant,f.root,'IF_NEW')).toBe(false);
  expect(assistant.active()).toBeNull();expect(assistant.hasGrantHistory()).toBe(true);
});
