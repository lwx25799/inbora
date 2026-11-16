import {afterEach,expect,test} from 'vitest';
import {randomUUID} from 'node:crypto';
import {rmSync} from 'node:fs';
import {join} from 'node:path';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {AccountActor} from '../../src/browser/account-actor.js';
import {DeepSeekProvider} from '../../src/ai/deepseek.js';
import {EventStore} from '../../src/storage/store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {ReplyKnowledgeStore} from '../../src/knowledge/store.js';
import {assertDraftLearningCurrent} from '../../src/knowledge/generation-context.js';
import {Blocked,digest,targetKey,type InboundEvent} from '../../src/core/contracts.js';
import {defaultSettings,type SendParams} from '../../src/app/contracts.js';
import type {ReplyPolicy} from '../../src/app/automation-contracts.js';
import {candidate,pending,privateTemp,snapshot} from '../helpers.js';

const fixtures:{service:ClientService;store:EventStore;root:string}[]=[];
afterEach(async()=>{for(const f of fixtures.splice(0)){await f.service.close();f.store.close();rmSync(f.root,{recursive:true,force:true});}});
class FixtureBrowser extends BrowserService{
  private queue=new AccountActor();clicks=0;beforeFinal=()=>{};afterClick=()=>{};beforePrepare=()=>{};
  override get actor(){return this.queue;}
  override identity(){return{identityDigest:digest('own-1'),mappingDigest:'synthetic',browserVersion:'1.0.0.0',browserMode:'headless' as const};}
  override async refreshIdentity(){return this.identity();}
  override async close(){}
  override async adapter(event:InboundEvent){let text='',verified=0;return{dispose:()=>{},adapter:{inspect:async()=>snapshot(event),
    prepare:async(_event:InboundEvent,value:string)=>{this.beforePrepare();text=value;},baseline:async()=>[],
    verifyPrepared:async()=>{if(++verified===2)this.beforeFinal();return snapshot(event);},cancelPreparation:async()=>{},
    clickOnce:async()=>{this.clicks++;this.afterClick();await new Promise(resolve=>setTimeout(resolve,5));},
    readback:async()=>({id:randomUUID(),ownId:'own-1',targetKey:targetKey(event),text,pending:false,sentAt:new Date().toISOString()})}};}
}
async function fixture(){
  const root=privateTemp('knowledge-generation-'),store=new EventStore(join(root,'test.sqlite'),true);
  await migrateClient(store,join(root,'schema3.sqlite'));const eventId=pending(store,candidate({text:'怎么清洗？'}));
  const browser=new FixtureBrowser(root),bodies:string[]=[];let gate=async()=>{};
  const provider=new DeepSeekProvider(async(_url,input)=>{bodies.push(String(input?.body));await gate();return new Response(JSON.stringify({
    model:'deepseek-flash',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'可以用冷水轻柔清洗。'}}],
    usage:{prompt_tokens:9,completion_tokens:4,total_tokens:13}}));});
  const service=new ClientService(store,browser,provider);fixtures.push({service,store,root});await service.loadSettings();
  const token=service.authority.issueSession();await service.dispatch(token,{command:'configureAi',settings:defaultSettings,key:'synthetic-only'});
  service.authority.attest('DIRECT_MESSAGE','SEND_AVAILABLE',browser.identity(),'synthetic-only');service.authority.setMode(token,'MANUAL');
  const knowledge=new ReplyKnowledgeStore(store),entry=knowledge.saveKnowledge('account_001',{title:'清洗方法',topic:'清洗',text:'清洗时使用冷水。'});
  knowledge.setKnowledgeState('account_001',entry.id,'ACTIVE');
  const p=knowledge.savePersona('account_001','自然直接，用简短句子。');knowledge.publishPersona('account_001',p.id);
  return{store,service,browser,token,eventId,knowledge,entry,bodies,setGate:(value:()=>Promise<void>)=>{gate=value;}};
}
const policy:ReplyPolicy={ownId:'own-1',model:'deepseek-flash',channels:['DIRECT_MESSAGE'],modelLimit:10,sendLimit:10,expiresAt:null,
  workIds:[],futureOwnWorks:false,conversationIds:['conversation-1'],entireInbox:false,containsAny:[],excludesAny:[],
  instructions:'自然回复，不编造事实。',startHour:0,endHour:24};
async function automatic(f:Awaited<ReturnType<typeof fixture>>){
  await f.service.dispatch(f.token,{command:'setReplyPolicy',policy,confirmed:true});
  await f.service.dispatch(f.token,{command:'setMode',mode:'LIMITED_AUTO'});
}

test('real suggestion generation carries knowledge outside exact history and saving preserves the final-send version guard',async()=>{
  const f=await fixture();pending(f.store,candidate({platformEventId:'unrelated',conversationId:'other-conversation',text:'PRIVATE_OTHER_THREAD'}));
  const selectionId=randomUUID();f.service.authority.select(f.token,f.eventId,selectionId);
  const generation=f.service.authority.claim(f.token,f.eventId,0).generation;
  const result=await f.service.dispatch(f.token,{command:'generateSuggestion',eventId:f.eventId,draftVersion:0}) as {id:string;text:string};
  const payload=JSON.parse(JSON.parse(f.bodies[0]!).messages[1].content);
  expect(payload.knowledge).toEqual([{source:'K1',text:'清洗时使用冷水。'}]);
  expect(payload.history.every((row:{text:string})=>row.text!=='清洗时使用冷水。')).toBe(true);
  expect(f.bodies[0]).not.toContain('PRIVATE_OTHER_THREAD');
  const draft=f.service.authority.save(f.token,f.eventId,generation,0,result.text,result.id);
  const params:SendParams={eventId:f.eventId,generation,draftId:draft.id,draftVersion:draft.version,text:draft.text,
    contextVersion:f.service.authority.contextVersion(f.store.event(f.eventId)),selectionId};
  expect(()=>f.service.authority.assertCanSend(f.token,params,f.browser.identity())).not.toThrow();
  const unrelated=f.knowledge.saveKnowledge('account_001',{title:'颜色',topic:'颜色',text:'这款有蓝色。'});f.knowledge.setKnowledgeState('account_001',unrelated.id,'ACTIVE');
  expect(()=>f.service.authority.assertCanSend(f.token,params,f.browser.identity())).not.toThrow();
  f.knowledge.setKnowledgeState('account_001',f.entry.id,'DISABLED');
  expect(()=>f.service.authority.assertCanSend(f.token,params,f.browser.identity())).toThrow('KNOWLEDGE_CONTEXT_CHANGED');
  expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
});

test('knowledge changed during an awaited model call cannot leave a usable suggestion and never refunds its paid attempt',async()=>{
  const f=await fixture();let release=()=>{},entered=()=>{};
  const ready=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  f.setGate(async()=>{entered();await gate;});
  const work=f.service.dispatch(f.token,{command:'generateSuggestion',eventId:f.eventId,draftVersion:0});await ready;
  f.knowledge.setKnowledgeState('account_001',f.entry.id,'DISABLED');release();
  await expect(work).rejects.toThrow('KNOWLEDGE_CONTEXT_CHANGED');
  expect(f.store.db.prepare('SELECT count(*) n FROM ai_suggestions').get()).toEqual({n:0});expect(f.store.budget('MODEL').used).toBe(1);
});

test.each(['suggestion','automatic'] as const)('changed business configuration rejects an awaited %s result before it becomes a usable draft',async kind=>{
  const f=await fixture();if(kind==='automatic')await automatic(f);
  let release=()=>{},entered=()=>{};
  const ready=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  f.setGate(async()=>{entered();await gate;});
  const work=kind==='automatic'?f.service.runAutomaticReply():f.service.dispatch(f.token,{command:'generateSuggestion',eventId:f.eventId,draftVersion:0});
  await ready;await f.service.dispatch(f.token,{command:'configureAi',settings:{...defaultSettings,business:'所有材质信息应按当前洗标核对。'},key:''});release();
  if(kind==='suggestion')await expect(work).rejects.toThrow('AI_SETTINGS_CHANGED');
  else {await work;expect(f.store.db.prepare('SELECT reason FROM automation_jobs WHERE event_id=?').get(f.eventId)).toEqual({reason:'AI_SETTINGS_CHANGED'});}
  expect(f.store.db.prepare('SELECT count(*) n FROM ai_suggestions').get()).toEqual({n:0});
  expect(f.store.db.prepare('SELECT count(*) n FROM reply_drafts').get()).toEqual({n:0});
  expect(f.store.budget('MODEL').used).toBe(1);expect(f.browser.clicks).toBe(0);
});

test('changing an unused legacy persona during a published-persona generation does not discard the result',async()=>{
  const f=await fixture();let release=()=>{},entered=()=>{};
  const ready=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  f.setGate(async()=>{entered();await gate;});
  const work=f.service.dispatch(f.token,{command:'generateSuggestion',eventId:f.eventId,draftVersion:0});await ready;
  await f.service.dispatch(f.token,{command:'configureAi',settings:{...defaultSettings,persona:'旧字段变更'},key:''});release();
  expect(await work).toMatchObject({text:'可以用冷水轻柔清洗。'});expect(f.store.db.prepare('SELECT count(*) n FROM ai_suggestions').get()).toEqual({n:1});
});

test('a new related conflicting source blocks the already generated automatic draft at the final intent check',async()=>{
  const f=await fixture();await automatic(f);
  f.browser.beforeFinal=()=>{const opposite=f.knowledge.saveKnowledge('account_001',{title:'清洗方法',topic:'清洗',text:'必须使用热水清洗。'});
    f.knowledge.setKnowledgeState('account_001',opposite.id,'ACTIVE');};
  await f.service.runAutomaticReply();
  expect(f.bodies).toHaveLength(1);expect(f.browser.clicks).toBe(0);expect(f.store.budget('SEND').used).toBe(0);
  expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  expect(f.store.db.prepare('SELECT reason FROM manual_send_commands').get()).toEqual({reason:'KNOWLEDGE_CONTEXT_CHANGED'});
});

test('deleted knowledge keeps a stale witness and prevents recovery of an old paid automatic draft without another model call',async()=>{
  const f=await fixture();await automatic(f);f.browser.beforePrepare=()=>{throw new Blocked('NATIVE_REPLY_EXISTING_DRAFT');};
  await f.service.runAutomaticReply();expect(f.bodies).toHaveLength(1);expect(f.browser.clicks).toBe(0);
  const draft=f.service.authority.draftFor(f.eventId)!;expect(draft).not.toBeNull();
  f.knowledge.deleteSource('account_001',f.entry.sourceId);f.browser.beforePrepare=()=>{};
  expect(()=>assertDraftLearningCurrent(f.store,draft.id,draft.version)).toThrow('KNOWLEDGE_CONTEXT_CHANGED');
  await f.service.runAutomaticReply();expect(f.bodies).toHaveLength(1);expect(f.browser.clicks).toBe(0);
  expect(f.store.db.prepare('SELECT reason FROM automation_jobs WHERE event_id=?').get(f.eventId)).toEqual({reason:'KNOWLEDGE_CONTEXT_CHANGED'});
});

test('publishing a new persona before the last check blocks the old automatic draft without a click',async()=>{
  const f=await fixture();await automatic(f);
  f.browser.beforeFinal=()=>{const persona=f.knowledge.savePersona('account_001','更亲切，短句。');f.knowledge.publishPersona('account_001',persona.id);};
  await f.service.runAutomaticReply();expect(f.browser.clicks).toBe(0);expect(f.bodies).toHaveLength(1);
  expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  expect(f.store.db.prepare('SELECT reason FROM manual_send_commands').get()).toEqual({reason:'KNOWLEDGE_CONTEXT_CHANGED'});
});

test('a published persona overrides unused legacy persona checks and a committed intent continues only its readback',async()=>{
  const f=await fixture();await automatic(f);
  await f.service.dispatch(f.token,{command:'configureAi',settings:{...defaultSettings,persona:'退款旧设定不再适用'},key:''});
  f.browser.afterClick=()=>{const persona=f.knowledge.savePersona('account_001','更亲切，短句。');f.knowledge.publishPersona('account_001',persona.id);
    f.knowledge.setKnowledgeState('account_001',f.entry.id,'DISABLED');};
  await f.service.runAutomaticReply();
  expect(f.browser.clicks).toBe(1);expect(f.store.event(f.eventId).status).toBe('CONFIRMED');expect(f.store.budget('SEND').used).toBe(1);
  expect(f.bodies[0]).not.toContain('退款旧设定不再适用');
  const draft=f.service.authority.draftFor(f.eventId)!;
  expect(()=>assertDraftLearningCurrent(f.store,draft.id,draft.version)).not.toThrow();
  expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:1});
});
