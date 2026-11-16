import {afterAll,expect,test} from 'vitest';
import Database from 'better-sqlite3';
import {join,resolve} from 'node:path';
import {rmSync,lstatSync,readdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {EventStore} from '../../src/storage/store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateReplyKnowledge} from '../../src/knowledge/migration.js';
import {ReplyKnowledgeStore} from '../../src/knowledge/store.js';
import {chunkText} from '../../src/knowledge/retrieval.js';
import {candidate,pending,privateTemp} from '../helpers.js';
import {digest,eventBinding,targetKey} from '../../src/core/contracts.js';

const account='account_001';
let cleanedDirectories=0,cleanedBytes=0;
function cleanup(root:string){
  const expected=resolve('.local/tests'),target=resolve(root);expect(target.startsWith(expected+'\\')).toBe(true);
  const size=(path:string):number=>{const info=lstatSync(path);return info.isSymbolicLink()?0:info.isDirectory()?readdirSync(path).reduce((n,name)=>n+size(join(path,name)),0):info.size;};
  cleanedBytes+=size(target);rmSync(target,{recursive:true,force:true});cleanedDirectories++;
}
async function fixture(){
  const root=privateTemp('knowledge-data-'),store=new EventStore(join(root,'owner.sqlite'),true);pending(store);
  await migrateClient(store,join(root,'client-backup.sqlite'));await migrateReplyKnowledge(store,join(root,'knowledge-backup.sqlite'));
  let now=1_800_000_000_000;const data=new ReplyKnowledgeStore(store,{now:()=>now});
  return {root,store,data,advance:(milliseconds:number)=>{now+=milliseconds;},close(){store.close();cleanup(root);}};
}
function enabled(data:ReplyKnowledgeStore,title:string,text:string,topic=title,aliases:string[]=[]){
  const result=data.saveKnowledge(account,{title,text,topic,aliases});return data.setKnowledgeState(account,result.id,'ACTIVE');
}

test('knowledge migration exercises restore while preserving all prior tables and remains idempotent',async()=>{
  const root=privateTemp('knowledge-migration-'),store=new EventStore(join(root,'owner.sqlite'),true);pending(store);
  try{
    await migrateClient(store,join(root,'client-backup.sqlite'));
    const names=(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name:string}[]).map(row=>row.name);
    const inventory=(db:Database.Database)=>names.map(name=>[name,db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]);
    const before=inventory(store.db),backupFile=join(root,'knowledge-backup.sqlite');
    expect(await migrateReplyKnowledge(store,backupFile)).toBe(true);expect(inventory(store.db)).toEqual(before);
    expect(store.db.pragma('user_version',{simple:true})).toBe(3);expect(store.db.pragma('foreign_key_check')).toEqual([]);
    const backup=new Database(backupFile,{readonly:true});
    try{expect(inventory(backup)).toEqual(before);expect(backup.prepare("SELECT name FROM sqlite_master WHERE name='k_schema'").get()).toBeUndefined();}
    finally{backup.close();}
    expect(await migrateReplyKnowledge(store,join(root,'unused.sqlite'))).toBe(false);
  }finally{store.close();cleanup(root);}
});

test('knowledge must be explicitly enabled and supports two-character aliases, channels, conflicts and expiry',async()=>{
  const f=await fixture();try{
    const draft=f.data.saveKnowledge(account,{title:'配送说明',topic:'delivery',text:'普通订单在三个工作日内发出。',aliases:['快递','邮寄'],
      channels:['DIRECT_MESSAGE'],expiresAt:1_800_000_001_000});
    expect(f.data.context(account,'DIRECT_MESSAGE','快递').knowledge).toEqual([]);
    f.data.setKnowledgeState(account,draft.id,'ACTIVE');
    expect(f.data.context(account,'DIRECT_MESSAGE','快递').knowledge[0]?.text).toContain('三个工作日');
    expect(f.data.context(account,'COMMENT_NOTIFICATION','快递').knowledge).toEqual([]);
    expect(f.data.context(account,'DIRECT_MESSAGE','配').knowledge).toEqual([]);
    const conflict=enabled(f.data,'快递时效','普通订单需要十个工作日发出。','delivery');
    const blocked=f.data.context(account,'DIRECT_MESSAGE','快递');expect(blocked.conflicts).toEqual(['delivery']);expect(blocked.knowledge).toEqual([]);
    f.data.setKnowledgeState(account,conflict.id,'DISABLED');expect(f.data.context(account,'DIRECT_MESSAGE','快递').knowledge).toHaveLength(1);
    f.advance(1000);expect(f.data.context(account,'DIRECT_MESSAGE','快递').knowledge).toHaveLength(0);
  }finally{f.close();}
});

test('version one without the term index upgrades additively and retains original material and send ledgers',async()=>{
  const f=await fixture();try{
    const value=enabled(f.data,'旧版知识','旧版快递说明。','shipping');
    f.store.db.exec(`DROP TABLE k_terms;DROP TABLE k_candidate_progress;DROP TABLE k_schema;CREATE TABLE k_schema(version INTEGER PRIMARY KEY CHECK(version=1));INSERT INTO k_schema VALUES(1);`);
    const names=(f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name<>'k_schema' ORDER BY name").all() as {name:string}[]).map(row=>row.name);
    const inventory=()=>names.map(name=>{const columns=f.store.db.prepare(`SELECT * FROM "${name}"`).columns().length;
      return [name,f.store.db.prepare(`SELECT * FROM "${name}" ORDER BY ${Array.from({length:columns},(_,index)=>index+1).join(',')}`).all()];});
    const before=inventory();expect(await migrateReplyKnowledge(f.store,join(f.root,'version-one-backup.sqlite'))).toBe(true);
    expect(inventory()).toEqual(before);expect(f.store.db.prepare('SELECT version FROM k_schema').get()).toEqual({version:3});
    expect(f.data.context(account,'DIRECT_MESSAGE','快递').knowledge[0]?.id).toBe(value.id);
    expect(await migrateReplyKnowledge(f.store,join(f.root,'unused-version-two.sqlite'))).toBe(false);
  }finally{f.close();}
});

test('version two upgrades to persistent candidate progress without changing existing knowledge or samples',async()=>{
  const f=await fixture();try{
    const knowledge=enabled(f.data,'已有物流知识','订单使用快递配送。');
    f.data.addSamples(account,[{channel:'DIRECT_MESSAGE',prompt:'在吗',response:'在的呀。',source:'IMPORTED'}]);
    const before=f.data.overview(account);
    f.store.db.exec(`DROP TABLE k_candidate_progress;DROP TABLE k_schema;CREATE TABLE k_schema(version INTEGER PRIMARY KEY CHECK(version=2));INSERT INTO k_schema VALUES(2);`);
    expect(await migrateReplyKnowledge(f.store,join(f.root,'version-two-backup.sqlite'))).toBe(true);
    expect(f.data.overview(account)).toEqual(before);expect(f.data.context(account,'DIRECT_MESSAGE','快递').knowledge[0]!.id).toBe(knowledge.id);
    expect(f.store.db.prepare('SELECT count(*) n FROM k_candidate_progress').get()).toEqual({n:0});
  }finally{f.close();}
});

test('context witness changes for related additions and revocation but survives unrelated knowledge, without deleting prior bindings',async()=>{
  const f=await fixture();try{
    const shipping=enabled(f.data,'物流安排','订单由快递统一配送。','shipping',['发货']);
    const before=f.data.context(account,'DIRECT_MESSAGE','快递何时发货');expect(f.data.isCurrent(before)).toBe(true);
    enabled(f.data,'衣服尺码','尺码从S到XL。','sizes');expect(f.data.isCurrent(before)).toBe(true);
    enabled(f.data,'发货地点','仓库统一发货。','warehouse');expect(f.data.isCurrent(before)).toBe(false);
    const latest=f.data.context(account,'DIRECT_MESSAGE','快递何时发货');
    f.store.db.prepare('INSERT INTO k_generation_contexts VALUES(?,?,?,?)').run('draft','fixture-draft',1,JSON.stringify(latest));
    f.data.deleteSource(account,shipping.sourceId);expect(f.data.isCurrent(latest)).toBe(false);
    expect(f.store.db.prepare('SELECT count(*) n FROM k_generation_contexts').get()).toEqual({n:1});
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{f.close();}
});

test('same-source imports are idempotent, chunks overlap within bounds and index text beyond the first terms',async()=>{
  const f=await fixture();try{
    const source=f.data.saveSource(account,{kind:'KNOWLEDGE',title:'说明文档',digest:'a'.repeat(64)});
    expect(f.data.saveSource(account,{kind:'KNOWLEDGE',title:'说明文档',digest:'a'.repeat(64)}).id).toBe(source.id);
    const text='这是一段用于索引的知识文字。'.repeat(90)+'限量预售';
    const first=f.data.saveKnowledge(account,{sourceId:source.id,title:'说明',topic:'description',text});
    expect(f.data.saveKnowledge(account,{sourceId:source.id,title:'说明',topic:'description',text}).id).toBe(first.id);
    f.data.setKnowledgeState(account,first.id,'ACTIVE');expect(f.data.context(account,'DIRECT_MESSAGE','预售').knowledge.length).toBeGreaterThan(0);
    const chunks=chunkText(text);expect(chunks.length).toBeGreaterThan(1);expect(chunks.every(chunk=>Array.from(chunk).length<=1000)).toBe(true);
    expect(chunks[0]!.slice(-100)).toBe(chunks[1]!.slice(0,100));
    expect(f.data.overview(account).totals.knowledge).toBe(1);
  }finally{f.close();}
});

test('sample selection keeps whole groups held out, excludes pure AI, redacts identifiers and publishes only explicit personas',async()=>{
  const f=await fixture();try{
    f.data.addSamples(account,Array.from({length:10},(_,index)=>({channel:'DIRECT_MESSAGE' as const,prompt:`请问第${index}种情况怎么办`,
      response:`先说说具体情况呀，第${index}种我帮你看看。邮箱 me@example.invalid 手机 13812345678`,source:'IMPORTED' as const,group:'session-'+Math.floor(index/2)})));
    f.data.addSamples(account,[{channel:'DIRECT_MESSAGE',prompt:'自动生成',response:'模型自己回复',source:'AUTO_POLICY',group:'ai'}]);
    const all=f.data.samples(account);expect(all.find(row=>row.source==='AUTO_POLICY')).toMatchObject({excluded:true,reason:'AI_GENERATED'});
    expect(all.filter(row=>row.source!=='AUTO_POLICY').every(row=>!row.response.includes('@')&&!row.response.includes('13812345678'))).toBe(true);
    const selected=all.filter(row=>!row.excluded);f.data.selectSamples(account,selected.map(row=>row.id),true);
    const {training,evaluation}=f.data.learningSamples(account,[]);expect(training).toHaveLength(8);expect(evaluation).toHaveLength(2);
    expect(training.every(row=>!evaluation.some(other=>other.group===row.group))).toBe(true);
    expect(()=>f.data.selectSamples(account,[all.find(row=>row.source==='AUTO_POLICY')!.id],true)).toThrow('PERSONA_SAMPLE_SELECTION_INVALID');
    const p=f.data.savePersona(account,'表达简洁，先回应问题，再自然补问。',training.map(row=>row.id));
    expect(f.data.context(account,'DIRECT_MESSAGE','你好').persona).toBe('');f.data.publishPersona(account,p.id);
    const context=f.data.context(account,'DIRECT_MESSAGE','你好');expect(context.personaId).toBe(p.id);expect(context.examples.length).toBeLessThanOrEqual(3);
    expect(context.examples.every(row=>!evaluation.some(other=>other.id===row.id))).toBe(true);
    expect(()=>f.data.learningSamples(account,[evaluation[0]!.id])).toThrow('PERSONA_SAMPLE_SELECTION_INVALID');
    f.data.selectSamples(account,[training[0]!.id],false);expect(f.data.isCurrent(context)).toBe(false);
    expect(f.data.samples(account).find(row=>row.id===training[0]!.id)).toMatchObject({accepted:false,excluded:true,reason:'USER_EXCLUDED'});
    f.data.selectSamples(account,[training[0]!.id],true);expect(f.data.samples(account).find(row=>row.id===training[0]!.id)).toMatchObject({accepted:true,excluded:false,reason:null});
    expect(f.data.overview(account).personas.find(row=>row.id===p.id)).toMatchObject({state:'INVALID',text:''});
  }finally{f.close();}
});

test('duplicate samples retain other source provenance while deleting the final source invalidates derived personality',async()=>{
  const f=await fixture();try{
    const a=f.data.saveSource(account,{kind:'CHAT',title:'来源甲'}),b=f.data.saveSource(account,{kind:'CHAT',title:'来源乙'});
    const input={channel:'DIRECT_MESSAGE' as const,prompt:'有空吗',response:'在的呀，你说。',source:'IMPORTED' as const,group:'one'};
    expect(f.data.addSamples(account,[{...input,sourceId:a.id}]).added).toBe(1);expect(f.data.addSamples(account,[{...input,sourceId:b.id}]).duplicates).toBe(1);
    const id=f.data.samples(account)[0]!.id;f.data.selectSamples(account,[id],true);
    const p=f.data.savePersona(account,'简短自然。',[id]);f.data.publishPersona(account,p.id);
    f.data.deleteSource(account,a.id);expect(f.data.samples(account)).toHaveLength(1);expect(f.data.samples(account)[0]!.sourceId).toBe(b.id);
    f.data.deleteSource(account,b.id);expect(f.data.samples(account)).toHaveLength(0);expect(f.data.overview(account).activePersona).toBeNull();
    expect(f.data.overview(account).personas.find(row=>row.id===p.id)?.state).toBe('INVALID');
  }finally{f.close();}
});

test('baseline explicitly disables published personality and knowledge source selection does not disable the selected personality',async()=>{
  const f=await fixture();try{
    f.data.addSamples(account,[{channel:'DIRECT_MESSAGE',prompt:'有空吗',response:'在的呀，你说。',source:'IMPORTED'}]);
    const row=f.data.samples(account)[0]!;f.data.selectSamples(account,[row.id],true);
    const beforePublished=f.data.context(account,'DIRECT_MESSAGE','你好');
    const personality=f.data.savePersona(account,'简短自然。',[row.id]);
    const draft=f.data.context(account,'DIRECT_MESSAGE','你好',{personaId:personality.id});expect(draft.personaPinned).toBe(true);
    const baseline=f.data.context(account,'DIRECT_MESSAGE','你好',{personaId:null});
    f.data.publishPersona(account,f.data.savePersona(account,'温和克制。',[row.id]).id);
    expect(f.data.isCurrent(beforePublished)).toBe(false);expect(f.data.isCurrent(draft)).toBe(true);
    expect(f.data.isCurrent(baseline)).toBe(true);
    f.data.publishPersona(account,personality.id);
    const knowledge=enabled(f.data,'物流','订单使用快递配送。');
    expect(f.data.context(account,'DIRECT_MESSAGE','你好',{sourceIds:[knowledge.sourceId]}).personaId).toBe(personality.id);
    expect(baseline).toMatchObject({persona:'',personaId:null,examples:[],accountPersonaOnly:true});expect(f.data.isCurrent(baseline)).toBe(true);
    const automatic=f.data.context(account,'DIRECT_MESSAGE','你好');expect(automatic.personaPinned).toBeUndefined();
    const pinned=f.data.context(account,'DIRECT_MESSAGE','你好',{personaId:personality.id});
    f.data.publishPersona(account,f.data.savePersona(account,'耐心解释。',[row.id]).id);
    expect(f.data.isCurrent(automatic)).toBe(false);expect(f.data.isCurrent(pinned)).toBe(true);
    expect(f.data.context(account,'DIRECT_MESSAGE','你好',{personaId:personality.id})).toMatchObject({personaId:personality.id,personaPinned:true});
    f.data.deleteSource(account,row.sourceId);expect(f.data.isCurrent(pinned)).toBe(false);
    expect(()=>f.data.context(account,'DIRECT_MESSAGE','你好',{personaId:personality.id})).toThrow('PERSONA_VERSION_INVALID');
  }finally{f.close();}
});

test('deleting a source invalidates only related learning batches and preserves the body-free generation witness',async()=>{
  const f=await fixture();try{
    const removed=f.data.saveSource(account,{kind:'CHAT',title:'删除的样本来源'}),retained=f.data.saveSource(account,{kind:'CHAT',title:'保留的样本来源'});
    for(const [id,sourceId]of [['related',removed.id],['unrelated',retained.id]]){
      f.store.db.prepare("INSERT INTO k_learning_tasks VALUES(?,?,?,?,? ,?,NULL)").run(id,account,'sample-digest','settings-digest','RUNNING',Date.now());
      f.store.db.prepare("INSERT INTO k_learning_batches VALUES(?,0,'PERSONA_ANALYSIS','digest',?,'SUCCEEDED',NULL)").run(id,'private-derived-summary');
      f.store.db.prepare("INSERT INTO k_generation_contexts VALUES('learning',?,1,?)").run(id,JSON.stringify({accountId:account,sourceIds:[sourceId],sampleIds:[]}));
    }
    f.data.deleteSource(account,removed.id);
    expect(f.store.db.prepare('SELECT state FROM k_learning_tasks WHERE id=?').get('related')).toEqual({state:'INVALIDATED'});
    expect(f.store.db.prepare('SELECT output_json FROM k_learning_batches WHERE task_id=?').get('related')).toEqual({output_json:null});
    expect(f.store.db.prepare('SELECT state FROM k_learning_tasks WHERE id=?').get('unrelated')).toEqual({state:'RUNNING'});
    expect(f.store.db.prepare('SELECT output_json FROM k_learning_batches WHERE task_id=?').get('unrelated')).toEqual({output_json:'private-derived-summary'});
    expect(f.store.db.prepare('SELECT count(*) n FROM k_generation_contexts').get()).toEqual({n:2});
  }finally{f.close();}
});

test('candidate accumulation advances bounded batches and discovers later verification of old intents without model calls or reimport after deletion',async()=>{
  const f=await fixture();try{
    let lateId='';
    f.store.db.transaction(()=>{
      for(let index=0;index<502;index++){
        const event=candidate({platformEventId:'native-'+index,conversationId:'session-'+index,text:'问题'+index}),eventId=randomUUID(),draftId=randomUUID(),intentId=randomUUID();
        f.store.db.prepare("INSERT INTO inbound_events VALUES(?,?,?,?,?,?,?,?,'CONFIRMED')").run(eventId,account,event.channel,'source-'+index,'fixture',targetKey(event),eventBinding(event),JSON.stringify(event));
        f.store.db.prepare("INSERT INTO reply_drafts VALUES(?,?,?,?,1,'DRAFT',NULL,NULL)").run(draftId,eventId,'人工回复'+index,'human');
        f.store.db.prepare("INSERT INTO draft_revisions VALUES(?,1,'HUMAN_TYPED',?,'fixture',?)").run(draftId,'人工回复'+index,Date.now());
        f.store.db.prepare('INSERT INTO send_intents VALUES(?,?,?,?,?,?,?,?)').run(intentId,eventId,draftId,targetKey(event),'fixture',digest('人工回复'+index),index===0?'UNCERTAIN':'CONFIRMED',new Date().toISOString());
        f.store.db.prepare('INSERT INTO delivery_receipts VALUES(?,?,?,?,?)').run(randomUUID(),intentId,index===0?'UNCERTAIN':'CONFIRMED','synthetic-only',new Date().toISOString());
        if(index===0)lateId=intentId;
      }
    }).immediate();
    const budgets=f.store.db.prepare('SELECT * FROM budgets ORDER BY kind').all();
    expect(f.data.collectCandidates(account)).toMatchObject({added:500,examined:500});
    expect(f.data.collectCandidates(account)).toMatchObject({added:1,examined:1});expect(f.data.collectCandidates(account).examined).toBe(0);
    f.store.db.exec('CREATE TABLE verification_results(id TEXT PRIMARY KEY,intent_id TEXT NOT NULL,verified INTEGER NOT NULL,evidence_ref TEXT NOT NULL,checked_at INTEGER NOT NULL)');
    f.store.db.prepare("INSERT INTO verification_results VALUES('later-proof',?,1,'synthetic-only',?)").run(lateId,Date.now());
    expect(f.data.collectCandidates(account)).toMatchObject({added:1,examined:1});
    const source=f.data.overview(account).sources[0]!;f.data.deleteSource(account,source.id);expect(f.data.collectCandidates(account).examined).toBe(0);
    expect(f.store.db.prepare('SELECT * FROM budgets ORDER BY kind').all()).toEqual(budgets);expect(f.store.db.prepare('SELECT count(*) n FROM model_calls').get()).toEqual({n:0});
  }finally{f.close();}
});

test('retrieval gates slow results before they can reach a model and stays bounded with one hundred thousand unselected samples',async()=>{
  const f=await fixture();try{
    enabled(f.data,'快递说明','快递统一配送。');
    f.data.addSamples(account,[{channel:'DIRECT_MESSAGE',prompt:'在吗',response:'在的呀，你说。',source:'IMPORTED'}]);
    const sample=f.data.samples(account)[0]!;f.data.selectSamples(account,[sample.id],true);
    f.data.publishPersona(account,f.data.savePersona(account,'简短自然。',[sample.id]).id);
    const insert=f.store.db.prepare("INSERT INTO k_samples VALUES(?,?,?,'DIRECT_MESSAGE',?,?,'IMPORTED',NULL,?,?,0,0,0,NULL,?)");
    f.store.db.transaction(()=>{for(let index=0;index<100000;index++)insert.run('bulk-'+index,account,sample.sourceId,'合成问题'+index,'合成回答'+index,
      'bulk-group-'+Math.floor(index/10),'bulk-digest-'+index,Date.now());}).immediate();
    const started=performance.now(),context=f.data.context(account,'DIRECT_MESSAGE','快递'),elapsedMs=performance.now()-started;
    expect(context.knowledge).toHaveLength(1);expect(context.examples).toHaveLength(1);expect(elapsedMs).toBeLessThanOrEqual(500);
    process.stdout.write(JSON.stringify({knowledgeScaleProbe:{samples:100001,elapsedMs:Number(elapsedMs.toFixed(2))}})+'\n');
    let ticks=0;const slow=new ReplyKnowledgeStore(f.store,{measure:()=>ticks++===0?0:501});
    expect(()=>slow.context(account,'DIRECT_MESSAGE','快递')).toThrow('KNOWLEDGE_RETRIEVAL_TIMEOUT');
    expect(f.store.db.prepare('SELECT count(*) n FROM model_calls').get()).toEqual({n:0});
  }finally{f.close();}
});

test('candidate collection uses confirmed matching revisions and never adopts AI replies or unconfirmed drafts automatically',async()=>{
  const f=await fixture();try{
    const save=(id:string,text:string,origin:string,confirmed:boolean)=>{
      const event=candidate({platformEventId:id,text:'请问'+id,conversationId:id}),eventId=pending(f.store,event),draftId=randomUUID();
      f.store.db.prepare("INSERT INTO reply_drafts VALUES(?,?,?,?,1,'DRAFT',NULL,NULL)").run(draftId,eventId,text,'mock');
      f.store.db.prepare('INSERT INTO draft_revisions VALUES(?,1,?,?,?,?)').run(draftId,origin,text,'fixture',Date.now());
      if(confirmed){const intent=randomUUID();
        f.store.db.prepare("INSERT INTO send_intents VALUES(?,?,?,?,?,?,'CONFIRMED',?)").run(intent,eventId,draftId,targetKey(event),'fixture',digest(text),new Date().toISOString());
        f.store.db.prepare("INSERT INTO delivery_receipts VALUES(?,?,'CONFIRMED',?,?)").run(randomUUID(),intent,'synthetic-only',new Date().toISOString());}
    };
    save('human','先把问题发我，我看一下。','HUMAN_TYPED',true);save('automatic','这是自动生成的内容。','AUTO_POLICY',true);save('unsent','还没发出去的草稿。','HUMAN_TYPED',false);
    expect(f.data.collectCandidates(account)).toMatchObject({added:2,examined:2});const rows=f.data.samples(account);
    expect(rows.every(row=>!row.accepted)).toBe(true);expect(rows.find(row=>row.source==='HUMAN_TYPED')?.excluded).toBe(false);
    expect(rows.find(row=>row.source==='AUTO_POLICY')?.excluded).toBe(true);expect(f.data.collectCandidates(account).added).toBe(0);
    expect(()=>f.data.context('another-account','DIRECT_MESSAGE','你好')).toThrow('KNOWLEDGE_ACCOUNT_REQUIRED');
  }finally{f.close();}
});

afterAll(()=>{process.stdout.write(JSON.stringify({knowledgeFixtureCleanup:{directories:cleanedDirectories,bytes:cleanedBytes}})+'\n');});
