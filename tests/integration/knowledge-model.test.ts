import {afterEach,expect,test} from 'vitest';
import {rmSync} from 'node:fs';
import {join} from 'node:path';
import {EventStore} from '../../src/storage/store.js';
import {knowledgeSql} from '../../src/knowledge/migration.js';
import {ReplyKnowledgeStore} from '../../src/knowledge/store.js';
import {LearningModelService,type LearningModelContext} from '../../src/knowledge/model-service.js';
import {defaultSettings} from '../../src/app/contracts.js';
import {privateTemp} from '../helpers.js';

const roots:string[]=[];const stores:EventStore[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
  const root=privateTemp('knowledge-model-');roots.push(root);const store=new EventStore(join(root,'test.sqlite'),true);stores.push(store);
  store.bindAccount('own-1');store.db.exec(knowledgeSql);const knowledge=new ReplyKnowledgeStore(store);
  const checks:number[]=[],reservations:string[]=[];
  const context:LearningModelContext={store,accountId:'account_001',allowedChannels:['DIRECT_MESSAGE','COMMENT_NOTIFICATION'],
    settings:{...defaultSettings},key:'synthetic-only',check:count=>{checks.push(count??1);},reserve:(id)=>{reservations.push(id);}};
  return{store,knowledge,context,checks,reservations};
}
function accept(f:ReturnType<typeof fixture>,count:number){
  f.knowledge.addSamples('account_001',Array.from({length:count},(_,index)=>({channel:'DIRECT_MESSAGE' as const,
    prompt:'清洗问题'+index,response:'可以先看看洗标呀'+index,group:'one-conversation',source:'IMPORTED' as const})));
  const ids=(f.store.db.prepare('SELECT id FROM k_samples ORDER BY created_at,id').all() as {id:string}[]).map(row=>row.id);
  f.knowledge.selectSamples('account_001',ids,true);return ids;
}
function answer(text:string){return new Response(JSON.stringify({model:'deepseek-flash',choices:[{index:0,finish_reason:'stop',
  message:{role:'assistant',content:text}}],usage:{prompt_tokens:11,completion_tokens:4,total_tokens:15}}));}

test('200 complete pairs use five bounded analysis calls and one merge, remain draft, and never create a message task or send',async()=>{
  const f=fixture(),ids=accept(f,200),requests:{max_tokens:number;messages:{content:string}[]}[]=[];
  const service=new LearningModelService(async(_url,input)=>{const body=JSON.parse(String(input?.body));requests.push(body);
    return answer(JSON.stringify({rules:'用短句直接回答，语气亲切，适当使用“呀”。'}));});
  const result=await service.analyze(f.context,{sampleIds:[]});
  expect(result).toMatchObject({calls:6,usedCount:200,omittedCount:0,persona:{state:'DRAFT'}});
  expect(new Set(result.persona.sampleIds)).toEqual(new Set(ids));expect(f.store.budget('MODEL').used).toBe(6);
  for(const request of requests.slice(0,5)){
    expect(request.max_tokens).toBe(2048);expect(request.messages[1]!.content.length).toBeLessThanOrEqual(12000);
    expect(JSON.parse(request.messages[1]!.content).samples).toHaveLength(40);
    expect(request.messages[1]!.content).not.toContain('own-1');
  }
  expect(f.store.db.prepare('SELECT purpose,count(*) n FROM k_model_purposes GROUP BY purpose ORDER BY purpose').all())
    .toEqual([{purpose:'PERSONA_ANALYSIS',n:5},{purpose:'PERSONA_MERGE',n:1}]);
  expect(f.store.db.prepare('SELECT count(*) n FROM inbound_events').get()).toEqual({n:0});
  expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  expect(f.knowledge.overview('account_001').activePersona).toBeNull();
  for(let index=0;index<55;index++)f.knowledge.savePersona('account_001','另一份未发布候选。');
  expect(await service.analyze(f.context,{sampleIds:[],taskId:result.taskId})).toMatchObject({calls:0,persona:{id:result.persona.id}});
  expect(requests).toHaveLength(6);
});

test('a partial failure retains its paid attempt and only an explicit same-task continuation reuses the completed batch',async()=>{
  const f=fixture();accept(f,45);let calls=0,fail=true;
  const service=new LearningModelService(async()=>{calls++;if(calls===2&&fail)throw new Error('private provider body');
    return answer(JSON.stringify({rules:'简短，直接回应问题。'}));});
  await expect(service.analyze(f.context,{sampleIds:[]})).rejects.toThrow('MODEL_FAILED_NO_RETRY');
  const task=f.store.db.prepare('SELECT id,state FROM k_learning_tasks').get() as {id:string;state:string};
  expect(task.state).toBe('FAILED');expect(f.store.budget('MODEL').used).toBe(2);
  expect(f.store.db.prepare('SELECT state FROM k_learning_batches ORDER BY batch_index').all()).toEqual([{state:'SUCCEEDED'},{state:'FAILED'}]);
  fail=false;const result=await service.analyze(f.context,{sampleIds:[],taskId:task.id});
  expect(result.calls).toBe(2);expect(calls).toBe(4);expect(f.store.budget('MODEL').used).toBe(4);
  expect(JSON.stringify(f.store.db.prepare('SELECT * FROM audit_events').all())).not.toContain('private provider body');
});

test('insufficient whole-task allowance, revoked scope and held-out samples fail before the first paid attempt',async()=>{
  const f=fixture();accept(f,200);let calls=0;
  const service=new LearningModelService(async()=>{calls++;return answer('{}');});
  f.store.db.prepare("UPDATE budgets SET maximum=5 WHERE kind='MODEL'").run();
  await expect(service.analyze(f.context,{sampleIds:[]})).rejects.toThrow('MODEL_GRANT_EXHAUSTED');
  expect(calls).toBe(0);expect(f.reservations).toHaveLength(0);
  f.store.db.prepare("UPDATE budgets SET maximum=50 WHERE kind='MODEL'").run();
  await expect(service.analyze({...f.context,allowedChannels:['COMMENT_NOTIFICATION']},{sampleIds:[]})).rejects.toThrow('MODEL_CHANNEL_NOT_AUTHORIZED');
  const id=(f.store.db.prepare('SELECT id FROM k_samples LIMIT 1').get() as {id:string}).id;
  f.store.db.prepare('UPDATE k_samples SET holdout=1 WHERE id=?').run(id);
  await expect(service.analyze(f.context,{sampleIds:[id]})).rejects.toThrow('PERSONA_SAMPLE_SELECTION_INVALID');
  expect(calls).toBe(0);expect(f.store.budget('MODEL').used).toBe(0);
});

test('long complete pairs are omitted rather than cut, and accepted-source changes prevent partial-task continuation',async()=>{
  const f=fixture();accept(f,1);const long='完整内容'.repeat(600);
  f.knowledge.addSamples('account_001',Array.from({length:35},(_,index)=>({channel:'DIRECT_MESSAGE' as const,prompt:long+index,
    response:'答复'.repeat(800)+index,group:'one-conversation',source:'IMPORTED' as const})));
  const ids=(f.store.db.prepare('SELECT id FROM k_samples').all() as {id:string}[]).map(row=>row.id);f.knowledge.selectSamples('account_001',ids,true);
  let calls=0;const service=new LearningModelService(async()=>{calls++;return answer(JSON.stringify({rules:'自然、直接。'}));});
  const result=await service.analyze(f.context,{sampleIds:[]});
  expect(result.omittedCount).toBeGreaterThan(0);expect(result.usedCount+result.omittedCount).toBe(36);expect(calls).toBeLessThanOrEqual(6);
  f.knowledge.selectSamples('account_001',[result.persona.sampleIds[0]!],false);
  await expect(service.analyze(f.context,{sampleIds:[],taskId:result.taskId})).rejects.toThrow('PERSONA_TASK_SELECTION_CHANGED');
});

test('sandbox comparison uses explicit sources and candidates without generating drafts, receipts or send intents',async()=>{
  const f=fixture(),entry=f.knowledge.saveKnowledge('account_001',{title:'清洗',topic:'清洗',text:'清洗时使用冷水。'});
  f.knowledge.setKnowledgeState('account_001',entry.id,'ACTIVE');
  const other=f.knowledge.saveKnowledge('account_001',{title:'其它',topic:'其它',text:'PRIVATE_UNSELECTED'});
  f.knowledge.setKnowledgeState('account_001',other.id,'ACTIVE');
  const active=f.knowledge.savePersona('account_001','简短直接。'),candidate=f.knowledge.savePersona('account_001','更亲切，用“呀”。');
  f.knowledge.publishPersona('account_001',active.id);
  const bodies:string[]=[];const service=new LearningModelService(async(_url,input)=>{bodies.push(String(input?.body));return answer('使用冷水清洗呀。');});
  const result=await service.tryReply(f.context,{channel:'DIRECT_MESSAGE',message:'怎么清洗？',sourceIds:[entry.sourceId],
    personaVersionId:active.id,comparePersonaVersionId:candidate.id});
  expect(result.current.personaId).toBe(active.id);expect(result.comparison?.personaId).toBe(candidate.id);expect(bodies).toHaveLength(2);
  for(const body of bodies){expect(body).toContain('冷水');expect(body).not.toContain('PRIVATE_UNSELECTED');
    expect(JSON.parse(JSON.parse(body).messages[1].content).history).toEqual([]);}
  expect(f.store.db.prepare('SELECT count(*) n FROM reply_drafts').get()).toEqual({n:0});
  expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  expect(f.store.budget('SEND').used).toBe(0);expect(f.store.budget('MODEL').used).toBe(2);
});

test('explicit baseline excludes the published persona and its style examples while a selected persona keeps its separately approved samples',async()=>{
  const f=fixture();f.knowledge.addSamples('account_001',[
    {channel:'DIRECT_MESSAGE',prompt:'清洗问题',response:'可以先看看洗标呀',group:'one',source:'IMPORTED'},
    {channel:'DIRECT_MESSAGE',prompt:'怎么洗呀',response:'先看看洗标就好啦',group:'one',source:'IMPORTED'},
    {channel:'DIRECT_MESSAGE',prompt:'清洗费用',response:'清洗费用为99元',group:'one',source:'IMPORTED'},
  ]);
  const ids=(f.store.db.prepare('SELECT id FROM k_samples').all() as {id:string}[]).map(row=>row.id);f.knowledge.selectSamples('account_001',ids,true);
  const persona=f.knowledge.savePersona('account_001','PUBLISHED_STYLE_ONLY',ids);
  f.knowledge.publishPersona('account_001',persona.id);
  const entry=f.knowledge.saveKnowledge('account_001',{title:'清洗',topic:'清洗',text:'使用冷水。'});f.knowledge.setKnowledgeState('account_001',entry.id,'ACTIVE');
  const bodies:{messages:{content:string}[]}[]=[];
  const service=new LearningModelService(async(_url,input)=>{bodies.push(JSON.parse(String(input?.body)));return answer('使用冷水。');});
  const result=await service.tryReply({...f.context,settings:{...defaultSettings,persona:'LEGACY_ACCOUNT_STYLE'}},
    {channel:'DIRECT_MESSAGE',message:'清洗问题',sourceIds:[entry.sourceId],personaVersionId:persona.id,comparePersonaVersionId:null});
  expect(result.current.personaId).toBe(persona.id);expect(result.comparison?.personaId).toBeNull();
  expect(bodies[0]!.messages[0]!.content).toContain('PUBLISHED_STYLE_ONLY');
  expect(JSON.parse(bodies[0]!.messages[1]!.content).styleExamples).toHaveLength(2);
  expect(bodies[0]!.messages[1]!.content).not.toContain('99元');
  expect(bodies[1]!.messages[0]!.content).toContain('LEGACY_ACCOUNT_STYLE');
  expect(bodies[1]!.messages[0]!.content).not.toContain('PUBLISHED_STYLE_ONLY');
  expect(JSON.parse(bodies[1]!.messages[1]!.content).styleExamples).toEqual([]);
  expect(result.current.knowledge).toEqual([{id:entry.id,title:'清洗',version:1}]);
});

test('deleting a selected source during learning invalidates its task and discards its output without erasing unrelated completed work',async()=>{
  const f=fixture(),first=f.knowledge.saveSource('account_001',{kind:'CHAT',title:'第一份聊天'}),second=f.knowledge.saveSource('account_001',{kind:'CHAT',title:'第二份聊天'});
  f.knowledge.addSamples('account_001',[
    {channel:'DIRECT_MESSAGE',prompt:'清洗问题',response:'先看看洗标呀',group:'one',source:'IMPORTED',sourceId:first.id},
    {channel:'DIRECT_MESSAGE',prompt:'材质问题',response:'摸起来挺柔软呀',group:'one',source:'IMPORTED',sourceId:second.id},
  ]);
  const rows=f.store.db.prepare('SELECT id,source_id FROM k_samples').all() as {id:string;source_id:string}[];
  f.knowledge.selectSamples('account_001',rows.map(row=>row.id),true);let deleting=false;
  const service=new LearningModelService(async()=>{if(deleting)f.knowledge.deleteSource('account_001',second.id);
    return answer(JSON.stringify({rules:'简短自然地回应。'}));});
  const initial=await service.analyze(f.context,{sampleIds:[rows.find(row=>row.source_id===first.id)!.id]});
  const originalOutputs=f.store.db.prepare('SELECT output_json FROM k_learning_batches WHERE task_id=?').all(initial.taskId);
  deleting=true;await expect(service.analyze(f.context,{sampleIds:[rows.find(row=>row.source_id===second.id)!.id]})).rejects.toThrow('PERSONA_TASK_SELECTION_CHANGED');
  const removed=f.store.db.prepare("SELECT id,state FROM k_learning_tasks WHERE id<>?").get(initial.taskId) as {id:string;state:string};
  expect(removed.state).toBe('INVALIDATED');expect(f.store.db.prepare('SELECT output_json FROM k_learning_batches WHERE task_id=?').all(removed.id)).toEqual([{output_json:null}]);
  expect(f.store.db.prepare('SELECT output_json FROM k_learning_batches WHERE task_id=?').all(initial.taskId)).toEqual(originalOutputs);
  expect(f.store.db.prepare('SELECT state FROM k_learning_tasks WHERE id=?').get(initial.taskId)).toEqual({state:'SUCCEEDED'});
  const witness=f.store.db.prepare("SELECT snapshot_json FROM k_generation_contexts WHERE kind='learning' AND entity_id=?").get(removed.id) as {snapshot_json:string};
  expect(JSON.parse(witness.snapshot_json)).toMatchObject({accountId:'account_001',sourceIds:[second.id]});
  expect(witness.snapshot_json).not.toContain('材质问题');expect(witness.snapshot_json).not.toContain('柔软');
  expect(f.store.budget('MODEL').used).toBe(3);expect(f.store.db.prepare('SELECT count(*) n FROM k_personas').get()).toEqual({n:1});
});

test('explicit sample IDs never expand to other accepted samples in the same conversation',async()=>{
  const f=fixture(),ids=accept(f,4),bodies:{messages:{content:string}[]}[]=[];
  const service=new LearningModelService(async(_url,input)=>{bodies.push(JSON.parse(String(input?.body)));return answer(JSON.stringify({rules:'短句自然。'}));});
  const result=await service.analyze(f.context,{sampleIds:[ids[0]!]});
  expect(result.usedCount).toBe(1);expect(result.persona.sampleIds).toEqual([ids[0]!]);
  expect(JSON.parse(bodies[0]!.messages[1]!.content).samples).toHaveLength(1);
});

test('sandbox rejects conflicting or personal knowledge before allowance reservation and rejects a changed source after paid output',async()=>{
  const f=fixture();let calls=0;
  const entry=f.knowledge.saveKnowledge('account_001',{title:'清洗',topic:'清洗',text:'清洗时使用冷水。'});f.knowledge.setKnowledgeState('account_001',entry.id,'ACTIVE');
  const conflicting=f.knowledge.saveKnowledge('account_001',{title:'清洗',topic:'清洗',text:'清洗时使用热水。'});f.knowledge.setKnowledgeState('account_001',conflicting.id,'ACTIVE');
  const request={channel:'DIRECT_MESSAGE' as const,message:'如何清洗',sourceIds:[],personaVersionId:null};
  const service=new LearningModelService(async()=>{calls++;f.knowledge.setKnowledgeState('account_001',entry.id,'DISABLED');return answer('冷水。');});
  await expect(service.tryReply(f.context,request)).rejects.toThrow('KNOWLEDGE_CONFLICT');expect(calls).toBe(0);
  f.knowledge.setKnowledgeState('account_001',conflicting.id,'DISABLED');
  await expect(service.tryReply(f.context,request)).rejects.toThrow('MODEL_FAILED_NO_RETRY');expect(calls).toBe(1);
  expect(f.store.budget('MODEL').used).toBe(1);expect(f.store.db.prepare('SELECT status FROM model_calls').get()).toEqual({status:'FAILED'});
});

test('sandbox comparison rechecks the first selection after the second paid request finishes',async()=>{
  const f=fixture(),ids=accept(f,1),sourceId=(f.store.db.prepare('SELECT source_id FROM k_samples WHERE id=?').get(ids[0]!) as {source_id:string}).source_id;
  const first=f.knowledge.savePersona('account_001','第一份风格。',ids),second=f.knowledge.savePersona('account_001','第二份风格。');
  let release=()=>{},entered=()=>{},calls=0;
  const ready=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const service=new LearningModelService(async()=>{if(++calls===2){entered();await gate;}return answer('自然回复。');});
  const work=service.tryReply(f.context,{channel:'DIRECT_MESSAGE',message:'你好',sourceIds:[],personaVersionId:first.id,comparePersonaVersionId:second.id});
  await ready;f.knowledge.deleteSource('account_001',sourceId);release();
  await expect(work).rejects.toThrow('KNOWLEDGE_CONTEXT_CHANGED');
  expect(calls).toBe(2);expect(f.store.budget('MODEL').used).toBe(2);
  expect(f.knowledge.context('account_001','DIRECT_MESSAGE','你好',{personaId:second.id}).personaId).toBe(second.id);
  expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
});
