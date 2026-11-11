import {afterEach,expect,test} from 'vitest';
import Database from 'better-sqlite3';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {migrateLocalAssistant} from '../../src/storage/local-assistant-migration.js';
import {LocalAssistantStore} from '../../src/storage/local-assistant-store.js';
import {LocalAssistantOperations} from '../../src/storage/local-assistant-operations.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {WorkbenchAuthority} from '../../src/app/authority.js';
import type {LocalAssistantScope} from '../../src/app/local-assistant-contracts.js';
import type {ReplyPolicy} from '../../src/app/automation-contracts.js';
import type {EventStore} from '../../src/storage/store.js';
import {candidate,database,pending,privateTemp} from '../helpers.js';
import {targetKey} from '../../src/core/contracts.js';

const stores:EventStore[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();});
const start=Date.parse('2026-11-04T00:00:00Z'),now=start+2*3600_000;
const scope:LocalAssistantScope={ownId:'own-1',channels:['DIRECT_MESSAGE','COMMENT_NOTIFICATION'],
  permissions:{read:true,editControl:true,send:true},expiresAt:now+86400_000,modelLimit:2,sendLimit:2};
test('status before the additive assistant migration is disabled and never creates authorization tables',async()=>{
  const store=database();stores.push(store);
  await migrateClient(store,join(privateTemp('assistant-before-extension-'),'client.sqlite'));
  const before=store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const assistant=new LocalAssistantStore(store);
  expect(assistant.state()).toEqual({grant:null,used:{MODEL:0,SEND:0},remaining:{MODEL:0,SEND:0},
    reason:'ASSISTANT_PERMISSION_REQUIRED',connectionEnabled:true});
  expect(()=>assistant.require('read')).toThrow('ASSISTANT_PERMISSION_REQUIRED');
  expect(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual(before);
});
async function setup(){
  const store=database();stores.push(store);const root=privateTemp('assistant-authority-');
  await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'auto.sqlite'));
  store.bindAccount('own-1');const auto=new AutomationStore(store,()=>now);auto.initialize(start);
  auto.configureCollection({ownId:'own-1',comments:true,inbox:true,commentIntervalMs:30000,dmIntervalMs:30000});
  const eventId=pending(store),backup=join(root,'assistant.sqlite');await migrateLocalAssistant(store,backup);
  const event=store.event(eventId);
  store.db.prepare('INSERT INTO collection_targets VALUES(?,?,?,?,?,?,?)').run(targetKey(event.payload),'own-1',event.payload.actorId,'peer-sec','Fixture peer',event.payload.conversationId,now);
  store.db.prepare('INSERT INTO discovered_conversations VALUES(?,?,?,?,?,?,?,0)').run(event.payload.conversationId,'own-1',event.payload.actorId,'peer-sec','Fixture peer',now,now);
  const assistant=new LocalAssistantStore(store,()=>now),authority=new WorkbenchAuthority(store,()=>now);
  return {store,root,eventId,backup,auto,assistant,authority,event:store.event(eventId)};
}

test('assistant migration verifies a restorable backup and leaves original tables and schema untouched',async()=>{
  const f=await setup(),backup=new Database(f.backup,{readonly:true});
  try{
    for(const table of ['budgets','budget_limits','inbound_events','automation_grants','send_intents','delivery_receipts','client_state'])
      expect(f.store.db.prepare(`SELECT * FROM ${table}`).all()).toEqual(backup.prepare(`SELECT * FROM ${table}`).all());
    expect(f.store.db.pragma('user_version',{simple:true})).toBe(3);
    expect(backup.prepare("SELECT name FROM sqlite_master WHERE name='assistant_operations'").get()).toBeUndefined();
    expect(await migrateLocalAssistant(f.store,f.backup)).toBe(false);
  }finally{backup.close();}
});

test('assistant grants have independent parsing/digests and never mutate MODEL scopes or global caps',async()=>{
  const f=await setup();const model=f.auto.grant('MODEL',{ownId:'own-1',channels:['DIRECT_MESSAGE'],model:'deepseek-flash',modelLimit:2,expiresAt:null});
  const before=f.store.db.prepare('SELECT * FROM automation_grants WHERE version=?').get(model.version),budgets=f.store.budgets();
  expect(f.assistant.active()).toBeNull();expect(()=>f.assistant.require('read')).toThrow('ASSISTANT_PERMISSION_REQUIRED');
  const grant=f.assistant.grant(scope);
  expect(grant.kind).toBe('LOCAL_ASSISTANT');expect(grant.scope.collection).toEqual({startedAt:start,comments:true,inbox:true,workIds:[]});
  expect(f.auto.active('MODEL')).toEqual(model);expect(f.auto.active('AUTO_REPLY')).toBeNull();
  expect(f.store.db.prepare('SELECT * FROM automation_grants WHERE version=?').get(model.version)).toEqual(before);
  expect(f.store.budgets()).toEqual(budgets);
  f.assistant.revoke();expect(f.assistant.active()).toBeNull();expect(f.auto.active('MODEL')).toEqual(model);
});

test('permission dependencies, account, finite expiry, enabled channel and current collection remain enforced',async()=>{
  const f=await setup();
  expect(()=>f.assistant.grant({...scope,permissions:{read:false,editControl:true,send:true}})).toThrow();
  expect(()=>f.assistant.grant({...scope,expiresAt:now})).toThrow('ASSISTANT_GRANT_EXPIRED');
  expect(()=>f.assistant.grant({...scope,ownId:'different'})).toThrow('ACCOUNT_NOT_VERIFIED');
  const grant=f.assistant.grant({...scope,permissions:{read:false,editControl:true,send:false},sendLimit:0});
  expect(f.assistant.require('editControl',grant.version)).toEqual(grant);
  expect(()=>f.assistant.require('read')).toThrow('ASSISTANT_PERMISSION_REQUIRED');
  f.auto.configureCollection({...f.auto.state().collection!,dmIntervalMs:60000});expect(f.assistant.require('editControl')).toEqual(grant);
  f.auto.configureCollection({...f.auto.state().collection!,comments:false});
  expect(()=>f.assistant.require('editControl')).toThrow('ASSISTANT_SCOPE_CHANGED');
  expect(f.assistant.state().reason).toBe('ASSISTANT_SCOPE_CHANGED');
  expect(()=>f.assistant.grant(scope)).toThrow('ASSISTANT_SCOPE_CHANGED');
  expect(new LocalAssistantStore(f.store,()=>now+86400_001).active()).toBeNull();
});

test('assistant scope excludes pre-start, wrong channel and unverifiable event time; sending excludes media',async()=>{
  const f=await setup(),grant=f.assistant.grant({...scope,channels:['DIRECT_MESSAGE']});
  expect(f.assistant.requireEvent('read',f.event)).toEqual(grant);
  for(const payload of [candidate({occurredAt:new Date(start).toISOString()}),candidate({occurredAt:null}),
    candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',videoId:'work',commentId:'parent',conversationId:null})])
    expect(()=>f.assistant.requireEvent('read',{...f.event,payload})).toThrow('ASSISTANT_TARGET_OUTSIDE_SCOPE');
  expect(()=>f.assistant.requireText({...f.event,payload:candidate({contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED'})})).toThrow('ASSISTANT_TEXT_REQUIRED');
});

test('collector scope binds the exact peer and native conversation rather than display name or timestamp alone',async()=>{
  const f=await setup(),grant=f.assistant.grant(scope);
  expect(f.assistant.inScope(grant,f.event)).toBe(true);
  f.store.db.prepare('UPDATE discovered_conversations SET sec_uid=?').run('different-sec');
  expect(f.assistant.inScope(grant,f.event)).toBe(false);
  f.store.db.prepare('UPDATE discovered_conversations SET sec_uid=?').run('peer-sec');
  f.store.db.prepare('UPDATE collection_targets SET uid=?').run('different-peer');
  expect(f.assistant.inScope(grant,f.event)).toBe(false);
  f.store.db.prepare('UPDATE collection_targets SET uid=?').run(f.event.payload.actorId);
  f.store.db.prepare('UPDATE inbound_events SET scope=? WHERE id=?').run('other-conversation',f.eventId);
  expect(f.assistant.inScope(grant,f.event)).toBe(false);
  f.store.db.prepare('UPDATE inbound_events SET scope=? WHERE id=?').run(f.event.payload.conversationId,f.eventId);
  expect(f.assistant.inScope(grant,f.event)).toBe(true);
  expect(f.assistant.inScope(grant,{...f.event,payload:{...f.event.payload,text:'unbound new text'}})).toBe(false);
});

test('trusted mapped works and newly discovered own works enter scope without admitting unrelated or old works',async()=>{
  const f=await setup(),grant=f.assistant.grant(scope,['already-mapped-empty']);
  // Use the normal observation entrypoint for stored rows; collector target metadata supplies exact admission proof.
  const observe=(workId:string)=>{
    const payload=candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',videoId:workId,commentId:'parent-'+workId,platformEventId:'comment-'+workId,conversationId:null});
    const [id]=f.store.observe(payload.channel,'work:'+workId,[payload],'own-1','synthetic',new Date(now).toISOString(),start);
    f.store.db.prepare('INSERT INTO collection_targets VALUES(?,?,?,?,?,?,?)').run(targetKey(payload),'own-1',payload.actorId,'peer-sec','Fixture peer',null,now);
    return f.store.event(id!);
  };
  const mapped=observe('already-mapped-empty'),unrelated=observe('unrelated-after-grant'),fresh=observe('fresh-own');
  expect(f.assistant.inScope(grant,mapped)).toBe(true);expect(f.assistant.inScope(grant,unrelated)).toBe(false);
  f.auto.registerWork({id:'fresh-own',ownId:'own-1',url:'http://127.0.0.1/video/fresh-own',publishedAt:start+1000,precisionMs:1});
  expect(f.assistant.inScope(grant,fresh)).toBe(true);
  f.store.db.prepare('UPDATE discovered_works SET published_at=? WHERE id=?').run(start-1000,'fresh-own');
  expect(f.assistant.inScope(grant,fresh)).toBe(false);
});

test('assistant session cannot steal GUI ownership and saved revisions never acquire HUMAN_TYPED media status',async()=>{
  const f=await setup(),grant=f.assistant.grant(scope),gui=f.authority.issueSession(),assistant=f.authority.issueAssistantSession(grant.version);
  const human=f.authority.claim(gui,f.eventId,0);
  expect(()=>f.authority.claim(assistant,f.eventId,human.generation)).toThrow('OTHER_OPERATOR_OWNS');
  f.authority.save(gui,f.eventId,human.generation,0,'Existing GUI draft');
  expect(f.authority.draftFor(f.eventId)?.origin).toBe('HUMAN_TYPED');
  f.authority.release(gui,f.eventId,human.generation);
  const own=f.authority.claim(assistant,f.eventId,f.authority.ownership(f.event).generation);
  const saved=f.authority.save(assistant,f.eventId,own.generation,1,'Assisted\r\nreply');
  expect(saved).toMatchObject({text:'Assisted\nreply',origin:'MCP_ASSISTED',version:2});
  expect(()=>f.authority.save(assistant,f.eventId,own.generation,1,'old version')).toThrow('DRAFT_VERSION_CONFLICT');
  f.assistant.revoke();expect(()=>f.authority.save(assistant,f.eventId,own.generation,2,'revoked')).toThrow('LEASE_EXPIRED_OR_CHANGED');
  expect(f.authority.draftFor(f.eventId)).toEqual(saved);
  expect(f.authority.ownership(f.event)).toEqual({operator_id:null,generation:own.generation+1,lease_expires_at:0});
  expect(f.authority.claim(gui,f.eventId,own.generation+1).operator_id).toBe(f.authority.operator(gui).id);
});

test('assistant and global quota reservations roll back together and consumed allowance survives regrant',async()=>{
  const f=await setup(),grant=f.assistant.grant({...scope,modelLimit:1,sendLimit:1});
  const reserve=()=>f.store.db.transaction(()=>{f.assistant.reserve(grant.version,'MODEL','one',f.event);f.store.consumeBudget('MODEL');}).immediate();
  f.store.db.prepare("UPDATE budget_limits SET maximum=0 WHERE kind='MODEL'").run();
  expect(reserve).toThrow('ASSISTANT_MODEL_EXHAUSTED');expect(f.assistant.usage(grant.version).MODEL).toBe(0);
  f.store.db.prepare("UPDATE budget_limits SET maximum=1 WHERE kind='MODEL'").run();reserve();
  expect(f.assistant.usage(grant.version).MODEL).toBe(1);expect(f.store.budget('MODEL').used).toBe(1);
  expect(reserve).toThrow('ASSISTANT_MODEL_EXHAUSTED');f.assistant.revoke();
  expect(()=>f.assistant.grant({...scope,modelLimit:0})).toThrow('ASSISTANT_LIMIT_BELOW_USED');
  const revised=f.assistant.grant({...scope,modelLimit:1});expect(f.assistant.state().remaining.MODEL).toBe(0);
  expect(f.assistant.usage(revised.version).MODEL).toBe(1);expect(f.store.budget('MODEL')).toMatchObject({used:1,maximum:1});
});

test('send reservation permits the last global unit already consumed in the same intent transaction',async()=>{
  const f=await setup(),grant=f.assistant.grant({...scope,sendLimit:1});
  f.store.db.prepare("UPDATE budget_limits SET maximum=1 WHERE kind='SEND'").run();
  f.store.db.transaction(()=>{f.store.consumeBudget('SEND');f.assistant.reserve(grant.version,'SEND','send-one',f.event,true);}).immediate();
  expect(f.assistant.usage(grant.version).SEND).toBe(1);expect(f.store.budget('SEND').used).toBe(1);
  expect(()=>f.assistant.reserve(grant.version,'SEND','send-two',f.event,true)).toThrow('ASSISTANT_SEND_EXHAUSTED');
});

test('emergency stop blocks quota use and durable operation recovery never replays accepted work',async()=>{
  const f=await setup(),grant=f.assistant.grant(scope),ledger=new LocalAssistantOperations(f.store,()=>now),id=randomUUID();
  expect(ledger.begin(id,'inbora_send_reply',{eventId:f.eventId,text:'one'},grant.version,f.eventId)).toBe(true);
  expect(ledger.begin(id,'inbora_send_reply',{eventId:f.eventId,text:'one'},grant.version,f.eventId)).toBe(false);
  expect(()=>ledger.begin(id,'inbora_send_reply',{eventId:f.eventId,text:'changed'},grant.version,f.eventId)).toThrow('OPERATION_PARAMETERS_CONFLICT');
  expect(()=>ledger.begin(id,'inbora_sync_inbox',{eventId:f.eventId,text:'one'},grant.version,f.eventId)).toThrow('OPERATION_PARAMETERS_CONFLICT');
  f.auto.stop(true);expect(()=>f.assistant.reserve(grant.version,'SEND',id,f.event)).toThrow('EMERGENCY_STOPPED');
  new LocalAssistantOperations(f.store,()=>now+1000).recover();
  expect(ledger.get(id)).toMatchObject({state:'UNKNOWN',error:'RESTART_NO_REPLAY',result:null});
  expect(ledger.begin(id,'inbora_send_reply',{eventId:f.eventId,text:'one'},grant.version,f.eventId)).toBe(false);
  expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  expect(f.store.budgets().every(b=>b.used===0)).toBe(true);
});

test('completed result remains queryable after restart and cannot be replaced by a late completion',async()=>{
  const f=await setup(),grant=f.assistant.grant(scope),ledger=new LocalAssistantOperations(f.store,()=>now),id=randomUUID();
  ledger.begin(id,'inbora_save_draft',{text:'saved'},grant.version,f.eventId);ledger.finish(id,{version:1});
  ledger.recover();ledger.finish(id,{version:2});
  expect(ledger.get(id)).toMatchObject({state:'SUCCEEDED',result:{version:1},error:null});
  const failed=randomUUID();ledger.begin(failed,'inbora_sync_inbox',{},grant.version);ledger.fail(failed,'EMERGENCY_STOPPED');
  ledger.finish(failed,{changed:true});expect(ledger.get(failed)).toMatchObject({state:'FAILED',error:'EMERGENCY_STOPPED'});
});

test('assistant automatic control checks complete pending scope without blocking existing human drafts',async()=>{
  const f=await setup(),grant=f.assistant.grant(scope);
  const policy:ReplyPolicy={ownId:'own-1',channels:['DIRECT_MESSAGE'],model:'deepseek-flash',modelLimit:2,sendLimit:2,
    expiresAt:null,workIds:[],futureOwnWorks:false,conversationIds:[],entireInbox:true,containsAny:[],excludesAny:[],
    instructions:'Synthetic rules',startHour:0,endHour:24};
  expect(()=>f.assistant.requirePolicy(grant.version,policy)).not.toThrow();
  const id=pending(f.store,candidate({platformEventId:'uncollected-peer',conversationId:'uncollected-conversation',
    occurredAt:new Date(start+1000).toISOString()}));
  expect(()=>f.assistant.requirePolicy(grant.version,policy)).toThrow('ASSISTANT_POLICY_OUTSIDE_SCOPE');
  const gui=f.authority.issueSession(),own=f.authority.claim(gui,id,0);
  f.authority.save(gui,id,own.generation,0,'An unrelated saved human draft');
  expect(()=>f.assistant.requirePolicy(grant.version,policy)).not.toThrow();
  expect(f.authority.draftFor(id)).toMatchObject({origin:'HUMAN_TYPED',text:'An unrelated saved human draft'});
  expect(f.store.budgets().every(b=>b.used===0)).toBe(true);
});
