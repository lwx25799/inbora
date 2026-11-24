import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {digest,requireSafe,type Channel} from '../core/contracts.js';
import type {EventStore} from '../storage/store.js';
import {knowledgeInputSchema,sampleInputSchema,knowledgeLimits,type KnowledgeInput,type KnowledgeEntry,type KnowledgeState,
  type KnowledgeOverview,type KnowledgeSource,type SourceInput,type PersonaVersion,type SampleInput,type ReplySample,
  type ReplyKnowledgeContext,type StyleExample} from './contracts.js';
import {chunkText,lexicalTerms,normalized,retrieveKnowledge} from './retrieval.js';
import {assignHoldout,learningSelection,nativeCandidates,redactSampleText,safeStyleExample,sampleBlock,sampleDigest,sampleFromRow,snapshotHoldoutBaseline,type SampleRow} from './samples.js';

interface SourceRow {id:string;kind:KnowledgeSource['kind'];title:string;created_at:number}
interface EntryRow {id:string;source_id:string;title:string;topic:string;text:string;aliases_json:string;channels_json:string;
  effective_at:number|null;expires_at:number|null;state:KnowledgeState;version:number;updated_at:number}
interface PersonaRow {id:string;text:string;sample_ids_json:string;state:PersonaVersion['state'];created_at:number}
export interface ContextOptions {personaId?:string|null;sourceIds?:string[]}
export type ContextWitness=Pick<ReplyKnowledgeContext,'accountId'|'channel'|'query'|'personaId'|'fingerprint'|'sourceIds'|'accountPersonaOnly'|'personaPinned'>;
const entry=(row:EntryRow):KnowledgeEntry=>({id:row.id,sourceId:row.source_id,title:row.title,topic:row.topic,text:row.text,
  aliases:JSON.parse(row.aliases_json) as string[],channels:JSON.parse(row.channels_json) as Channel[],effectiveAt:row.effective_at,
  expiresAt:row.expires_at,state:row.state,version:row.version,updatedAt:row.updated_at});
const persona=(row:PersonaRow):PersonaVersion=>({id:row.id,text:row.text,sampleIds:JSON.parse(row.sample_ids_json) as string[],state:row.state,createdAt:row.created_at});
const source=(row:SourceRow):KnowledgeSource=>({id:row.id,kind:row.kind,title:row.title,createdAt:row.created_at});

/** All private knowledge and style records remain in the account's existing owner database. */
export class ReplyKnowledgeStore {
  private readonly now:()=>number;
  private readonly measure:()=>number;
  constructor(readonly store:EventStore,options:{now?:()=>number;measure?:()=>number}={}){this.now=options.now??Date.now;this.measure=options.measure??(()=>performance.now());}
  available():boolean{return !!this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='k_schema'").get();}
  private own(accountId:string):string{
    requireSafe(this.available(),'KNOWLEDGE_MIGRATION_REQUIRED');
    const row=this.store.db.prepare('SELECT own_id FROM accounts WHERE id=?').get(accountId) as {own_id:string}|undefined;
    requireSafe(row?.own_id,'KNOWLEDGE_ACCOUNT_REQUIRED');return row.own_id;
  }
  private requireSource(accountId:string,id:string):void{
    requireSafe(!!this.store.db.prepare('SELECT id FROM k_sources WHERE id=? AND account_id=? AND own_id=?').get(id,accountId,this.own(accountId)),
      'KNOWLEDGE_SOURCE_NOT_FOUND');
  }
  private activePersona(accountId:string,ownId:string):PersonaVersion|null{
    const row=this.store.db.prepare("SELECT * FROM k_personas WHERE account_id=? AND own_id=? AND state='PUBLISHED' ORDER BY created_at DESC,id LIMIT 1")
      .get(accountId,ownId) as PersonaRow|undefined;return row?persona(row):null;
  }
  overview(accountId:string,page=0):KnowledgeOverview{
    requireSafe(Number.isSafeInteger(page)&&page>=0&&page<=100000,'KNOWLEDGE_PAGE_INVALID');
    const empty:KnowledgeOverview={available:this.available(),sources:[],knowledge:[],samples:[],personas:[],activePersonaId:null,activePersona:null,
      totals:{sources:0,knowledge:0,samples:0,accepted:0,holdout:0,personas:0},learningTasks:[],page,pageSize:knowledgeLimits.pageSize};
    if(!empty.available)return empty;
    const ownId=this.own(accountId),limit=knowledgeLimits.pageSize,offset=page*limit;
    const sources=this.store.db.prepare('SELECT * FROM k_sources WHERE account_id=? AND own_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?')
      .all(accountId,ownId,limit,offset) as SourceRow[];
    const entries=this.store.db.prepare(`SELECT k.* FROM k_knowledge k JOIN k_sources s ON s.id=k.source_id WHERE k.account_id=? AND s.own_id=?
      ORDER BY k.updated_at DESC,k.id LIMIT ? OFFSET ?`).all(accountId,ownId,limit,offset) as EntryRow[];
    const personas=this.store.db.prepare('SELECT * FROM k_personas WHERE account_id=? AND own_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?')
      .all(accountId,ownId,limit,offset) as PersonaRow[];
    const count=(table:string)=> (this.store.db.prepare(`SELECT count(*) n FROM ${table} k JOIN k_sources s ON s.id=k.source_id
      WHERE k.account_id=? AND s.own_id=?`).get(accountId,ownId) as {n:number}).n;
    const stats=this.store.db.prepare(`SELECT coalesce(sum(m.accepted),0) accepted,coalesce(sum(m.holdout),0) holdout FROM k_samples m
      JOIN k_sources s ON s.id=m.source_id WHERE m.account_id=? AND s.own_id=?`).get(accountId,ownId) as {accepted:number;holdout:number};
    const active=this.activePersona(accountId,ownId);
    const learningTasks=this.store.db.prepare(`SELECT t.id,t.state,t.persona_id AS personaId,
      (SELECT count(*) FROM k_learning_batches b WHERE b.task_id=t.id AND b.state='SUCCEEDED') AS completed
      FROM k_learning_tasks t WHERE t.account_id=? ORDER BY t.created_at DESC,t.id LIMIT 10`)
      .all(accountId) as KnowledgeOverview['learningTasks'];
    return {...empty,sources:sources.map(source),knowledge:entries.map(entry),samples:this.samples(accountId,page),personas:personas.map(persona),
      activePersonaId:active?.id??null,activePersona:active,learningTasks,totals:{sources:(this.store.db.prepare('SELECT count(*) n FROM k_sources WHERE account_id=? AND own_id=?')
        .get(accountId,ownId) as {n:number}).n,knowledge:count('k_knowledge'),samples:count('k_samples'),personas:(this.store.db.prepare(
          'SELECT count(*) n FROM k_personas WHERE account_id=? AND own_id=?').get(accountId,ownId) as {n:number}).n,...stats}};
  }
  saveSource(accountId:string,input:SourceInput):KnowledgeSource{
    const ownId=this.own(accountId);requireSafe(['KNOWLEDGE','CHAT','MANUAL'].includes(input.kind)&&input.title.trim().length>0&&input.title.length<=200,'KNOWLEDGE_SOURCE_INVALID');
    requireSafe(input.digest===undefined||/^[a-f0-9]{64}$/u.test(input.digest),'KNOWLEDGE_SOURCE_INVALID');
    const contentDigest=input.digest??digest(randomUUID()),old=this.store.db.prepare('SELECT * FROM k_sources WHERE account_id=? AND own_id=? AND kind=? AND content_digest=?')
      .get(accountId,ownId,input.kind,contentDigest) as SourceRow|undefined;
    if(old)return source(old);
    const row={id:randomUUID(),kind:input.kind,title:input.title.trim(),created_at:this.now()};
    this.store.db.prepare('INSERT INTO k_sources VALUES(?,?,?,?,?,?,?)').run(row.id,accountId,ownId,row.kind,row.title,contentDigest,row.created_at);return source(row);
  }
  saveKnowledge(accountId:string,input:KnowledgeInput):KnowledgeEntry{
    this.own(accountId);const parsed=knowledgeInputSchema.parse(input);
    return this.store.db.transaction(()=>{
      const old=parsed.id?this.store.db.prepare('SELECT * FROM k_knowledge WHERE id=? AND account_id=?').get(parsed.id,accountId) as EntryRow|undefined:undefined;
      requireSafe(!parsed.id||old,'KNOWLEDGE_NOT_FOUND');if(old)this.requireSource(accountId,old.source_id);
      requireSafe(!old||parsed.expectedVersion===old.version,'KNOWLEDGE_VERSION_CONFLICT');
      const sourceId=parsed.sourceId??old?.source_id??this.saveSource(accountId,{kind:'MANUAL',title:parsed.title}).id;
      this.requireSource(accountId,sourceId);
      if(!old){
        const duplicate=this.store.db.prepare(`SELECT * FROM k_knowledge WHERE account_id=? AND source_id=? AND title=? AND topic=? AND text=?
          AND aliases_json=? AND channels_json=? AND effective_at IS ? AND expires_at IS ?`).get(accountId,sourceId,parsed.title,normalized(parsed.topic),parsed.text,
            JSON.stringify(parsed.aliases),JSON.stringify(parsed.channels),parsed.effectiveAt??null,parsed.expiresAt??null) as EntryRow|undefined;
        if(duplicate)return entry(duplicate);
      }
      const id=old?.id??randomUUID(),version=(old?.version??0)+1,now=this.now();
      this.store.db.prepare(`INSERT INTO k_knowledge VALUES(?,?,?,?,?,?,?,?,?,?,'DISABLED',?,?) ON CONFLICT(id) DO UPDATE SET
        source_id=excluded.source_id,title=excluded.title,topic=excluded.topic,text=excluded.text,aliases_json=excluded.aliases_json,
        channels_json=excluded.channels_json,effective_at=excluded.effective_at,expires_at=excluded.expires_at,state='DISABLED',version=excluded.version,updated_at=excluded.updated_at`)
        .run(id,accountId,sourceId,parsed.title,normalized(parsed.topic),parsed.text,JSON.stringify(parsed.aliases),JSON.stringify(parsed.channels),
          parsed.effectiveAt??null,parsed.expiresAt??null,version,now);
      this.store.db.prepare('DELETE FROM k_search WHERE chunk_id IN (SELECT id FROM k_chunks WHERE entry_id=?)').run(id);
      this.store.db.prepare('DELETE FROM k_terms WHERE chunk_id IN (SELECT id FROM k_chunks WHERE entry_id=?)').run(id);
      this.store.db.prepare('DELETE FROM k_chunks WHERE entry_id=?').run(id);
      chunkText(parsed.text).forEach((text,ordinal)=>{
        const chunkId=digest([id,version,ordinal,text]);
        const terms=lexicalTerms([parsed.title,...parsed.aliases,text].join(' '),2000).join(' ');
        this.store.db.prepare('INSERT INTO k_chunks VALUES(?,?,?,?,?)').run(chunkId,id,ordinal,text,terms);
        this.store.db.prepare('INSERT INTO k_terms(chunk_id,terms) VALUES(?,?)').run(chunkId,terms);
        this.store.db.prepare('INSERT INTO k_search(chunk_id,text) VALUES(?,?)').run(chunkId,[parsed.title,...parsed.aliases,text].join('\n'));
      });
      this.store.audit('KNOWLEDGE_SAVED',id,{version});
      return entry(this.store.db.prepare('SELECT * FROM k_knowledge WHERE id=?').get(id) as EntryRow);
    }).immediate();
  }
  setKnowledgeState(accountId:string,id:string,state:KnowledgeState):KnowledgeEntry{
    this.own(accountId);requireSafe(state==='ACTIVE'||state==='DISABLED','KNOWLEDGE_STATE_INVALID');
    const row=this.store.db.prepare('SELECT * FROM k_knowledge WHERE id=? AND account_id=?').get(id,accountId) as EntryRow|undefined;
    requireSafe(row,'KNOWLEDGE_NOT_FOUND');this.requireSource(accountId,row.source_id);
    this.store.db.prepare('UPDATE k_knowledge SET state=?,updated_at=? WHERE id=?').run(state,this.now(),id);
    this.store.audit('KNOWLEDGE_STATE_CHANGED',id,{active:state==='ACTIVE'});return {...entry(row),state};
  }
  samples(accountId:string,page=0):ReplySample[]{
    requireSafe(Number.isSafeInteger(page)&&page>=0&&page<=100000,'KNOWLEDGE_PAGE_INVALID');
    const ownId=this.own(accountId);
    return (this.store.db.prepare(`SELECT m.* FROM k_samples m JOIN k_sources s ON s.id=m.source_id WHERE m.account_id=? AND s.own_id=?
      ORDER BY m.created_at DESC,m.id LIMIT ? OFFSET ?`).all(accountId,ownId,knowledgeLimits.pageSize,page*knowledgeLimits.pageSize) as SampleRow[]).map(sampleFromRow);
  }
  private allSamples(accountId:string):ReplySample[]{
    const ownId=this.own(accountId);
    return (this.store.db.prepare(`SELECT m.* FROM k_samples m JOIN k_sources s ON s.id=m.source_id WHERE m.account_id=? AND s.own_id=?
      ORDER BY m.created_at,m.id LIMIT 100000`).all(accountId,ownId) as SampleRow[]).map(sampleFromRow);
  }
  addSamples(accountId:string,inputs:SampleInput[]):{added:number;duplicates:number;excluded:number}{
    this.own(accountId);requireSafe(inputs.length<=100000,'PERSONA_SAMPLE_LIMIT');
    return this.store.db.transaction(()=>{
      let added=0,duplicates=0,excluded=0,defaultSource:string|undefined;
      for(const input of inputs){
        const value=sampleInputSchema.parse(input),sourceId=value.sourceId??(defaultSource??=this.saveSource(accountId,{kind:'CHAT',title:'手动添加的聊天样本'}).id);
        this.requireSource(accountId,sourceId);
        const prompt=redactSampleText(value.prompt),response=redactSampleText(value.response),contentDigest=digest([this.own(accountId),sampleDigest(value.channel,prompt,response)]);
        const old=this.store.db.prepare('SELECT id FROM k_samples WHERE account_id=? AND content_digest=?').get(accountId,contentDigest) as {id:string}|undefined;
        const id=old?.id??randomUUID();
        if(old)duplicates++;
        else{
          const reason=sampleBlock(value.source,prompt,response);if(reason)excluded++;
          this.store.db.prepare('INSERT INTO k_samples VALUES(?,?,?,?,?,?,?,?,?,?,0,?,0,?,?)').run(id,accountId,sourceId,value.channel,prompt,response,value.source,
            value.sourceRef??null,digest(value.group??value.sourceRef??sourceId),contentDigest,Number(!!reason),reason,this.now());added++;
        }
        this.store.db.prepare('INSERT OR IGNORE INTO k_sample_sources VALUES(?,?)').run(id,sourceId);
      }
      this.store.audit('PERSONA_SAMPLES_ADDED',accountId,{added,duplicates,excluded});return {added,duplicates,excluded};
    }).immediate();
  }
  selectSamples(accountId:string,ids:string[],accepted:boolean):void{
    const ownId=this.own(accountId);requireSafe(ids.length>0&&ids.length<=100000&&new Set(ids).size===ids.length,'PERSONA_SAMPLE_SELECTION_INVALID');
    this.store.db.transaction(()=>{
      const baseline=snapshotHoldoutBaseline(this.store,accountId,ownId);
      for(const id of ids){
        const row=this.store.db.prepare(`SELECT m.* FROM k_samples m JOIN k_sources s ON s.id=m.source_id WHERE m.id=? AND m.account_id=? AND s.own_id=?`)
          .get(id,accountId,ownId) as SampleRow|undefined;
        requireSafe(row&&(!accepted||!row.excluded||row.reason==='USER_EXCLUDED'),'PERSONA_SAMPLE_SELECTION_INVALID');
        if(accepted)this.store.db.prepare('UPDATE k_samples SET accepted=1,excluded=0,reason=NULL WHERE id=?').run(id);
        else if(!row.excluded||row.reason==='USER_EXCLUDED')this.store.db.prepare("UPDATE k_samples SET accepted=0,excluded=1,holdout=0,reason='USER_EXCLUDED' WHERE id=?").run(id);
      }
      assignHoldout(this.store,accountId,ownId,baseline);this.invalidatePersonas(accountId);
      this.store.audit('PERSONA_SAMPLES_SELECTED',accountId,{count:ids.length,accepted});
    }).immediate();
  }
  collectCandidates(accountId:string):{added:number;duplicates:number;excluded:number;examined:number}{
    const ownId=this.own(accountId),candidates=nativeCandidates(this.store,accountId,ownId);
    if(!candidates.refs.length)return {added:0,duplicates:0,excluded:0,examined:0};
    return this.store.db.transaction(()=>{
      const result=candidates.inputs.length?this.addSamples(accountId,candidates.inputs.map(row=>({...row,sourceId:this.saveSource(accountId,
        {kind:'CHAT',title:'应用内已确认回复',digest:digest(['confirmed-replies',ownId])}).id}))):{added:0,duplicates:0,excluded:0};
      const mark=this.store.db.prepare('INSERT OR IGNORE INTO k_candidate_progress VALUES(?,?,?,?)');
      for(const ref of candidates.refs)mark.run(accountId,ownId,ref,this.now());return {...result,examined:candidates.refs.length};
    }).immediate();
  }
  learningSamples(accountId:string,sampleIds?:string[]):{training:ReplySample[];evaluation:ReplySample[]}{
    return learningSelection(this.allSamples(accountId),sampleIds?.length?sampleIds:undefined);
  }
  savePersona(accountId:string,text:string,sampleIds:string[]=[]):PersonaVersion{
    const ownId=this.own(accountId);text=text.trim();requireSafe(text.length>0&&Array.from(text).length<=knowledgeLimits.personaCharacters,'PERSONA_TEXT_INVALID');
    requireSafe(new Set(sampleIds).size===sampleIds.length&&sampleIds.length<=knowledgeLimits.learningPairs,'PERSONA_SAMPLE_SELECTION_INVALID');
    const selected=new Map(this.allSamples(accountId).map(row=>[row.id,row]));
    requireSafe(sampleIds.every(id=>{const row=selected.get(id);return row?.accepted&&!row.excluded&&!row.holdout;}),'PERSONA_SAMPLE_SELECTION_INVALID');
    const value:PersonaVersion={id:randomUUID(),text,sampleIds:[...sampleIds],state:'DRAFT',createdAt:this.now()};
    this.store.db.prepare('INSERT INTO k_personas VALUES(?,?,?,?,?,?,?)').run(value.id,accountId,ownId,text,JSON.stringify(sampleIds),'DRAFT',value.createdAt);
    this.store.audit('PERSONA_DRAFT_SAVED',value.id,{sampleCount:sampleIds.length});return value;
  }
  publishPersona(accountId:string,id:string):PersonaVersion{
    const ownId=this.own(accountId);
    return this.store.db.transaction(()=>{
      this.invalidatePersonas(accountId);
      const row=this.store.db.prepare('SELECT * FROM k_personas WHERE id=? AND account_id=? AND own_id=?').get(id,accountId,ownId) as PersonaRow|undefined;
      requireSafe(row&&['DRAFT','ARCHIVED','PUBLISHED'].includes(row.state),'PERSONA_VERSION_INVALID');
      this.store.db.prepare("UPDATE k_personas SET state='ARCHIVED' WHERE account_id=? AND own_id=? AND state='PUBLISHED'").run(accountId,ownId);
      this.store.db.prepare("UPDATE k_personas SET state='PUBLISHED' WHERE id=?").run(id);this.store.audit('PERSONA_PUBLISHED',id);
      return {...persona(row),state:'PUBLISHED' as const};
    }).immediate();
  }
  private invalidatePersonas(accountId:string):void{
    this.store.db.prepare(`UPDATE k_personas SET state='INVALID',text='' WHERE account_id=? AND state<>'INVALID' AND EXISTS(
      SELECT 1 FROM json_each(k_personas.sample_ids_json) j LEFT JOIN k_samples m ON m.id=j.value
      WHERE m.id IS NULL OR m.accepted=0 OR m.excluded=1 OR m.holdout=1)`).run(accountId);
  }
  deleteSource(accountId:string,sourceId:string):void{
    const ownId=this.own(accountId);
    this.requireSource(accountId,sourceId);
    this.store.db.transaction(()=>{
      const relatedTasks=this.store.db.prepare(`SELECT t.id FROM k_learning_tasks t WHERE t.account_id=? AND EXISTS(
        SELECT 1 FROM k_generation_contexts g,json_each(json_extract(g.snapshot_json,'$.sourceIds')) s
        WHERE g.kind='learning' AND g.entity_id=t.id AND s.value=?)`).all(accountId,sourceId) as {id:string}[];
      this.store.db.prepare('DELETE FROM k_search WHERE chunk_id IN (SELECT c.id FROM k_chunks c JOIN k_knowledge k ON k.id=c.entry_id WHERE k.source_id=?)').run(sourceId);
      this.store.db.prepare('DELETE FROM k_terms WHERE chunk_id IN (SELECT c.id FROM k_chunks c JOIN k_knowledge k ON k.id=c.entry_id WHERE k.source_id=?)').run(sourceId);
      this.store.db.prepare('DELETE FROM k_knowledge WHERE source_id=?').run(sourceId);
      this.store.db.prepare('DELETE FROM k_sample_sources WHERE source_id=?').run(sourceId);
      const samples=this.store.db.prepare('SELECT id FROM k_samples WHERE source_id=?').all(sourceId) as {id:string}[];
      const baseline=samples.length?snapshotHoldoutBaseline(this.store,accountId,ownId):undefined;
      let deletedSamples=0;
      for(const item of samples){
        const other=this.store.db.prepare('SELECT source_id FROM k_sample_sources WHERE sample_id=? ORDER BY source_id LIMIT 1').get(item.id) as {source_id:string}|undefined;
        if(other)this.store.db.prepare('UPDATE k_samples SET source_id=? WHERE id=?').run(other.source_id,item.id);
        else{this.store.db.prepare('DELETE FROM k_samples WHERE id=?').run(item.id);deletedSamples++;}
      }
      this.store.db.prepare('DELETE FROM k_sources WHERE id=?').run(sourceId);
      if(deletedSamples>0)assignHoldout(this.store,accountId,ownId,baseline);
      this.invalidatePersonas(accountId);
      const invalidPersonas=this.store.db.prepare(`SELECT t.id FROM k_learning_tasks t JOIN k_personas p ON p.id=t.persona_id
        WHERE t.account_id=? AND p.state='INVALID'`).all(accountId) as {id:string}[];
      for(const id of new Set([...relatedTasks,...invalidPersonas].map(row=>row.id))){
        this.store.db.prepare("UPDATE k_learning_tasks SET state='INVALIDATED' WHERE id=?").run(id);
        this.store.db.prepare('UPDATE k_learning_batches SET output_json=NULL WHERE task_id=?').run(id);
      }
      this.store.audit('KNOWLEDGE_SOURCE_DELETED',sourceId);
    }).immediate();
  }
  context(accountId:string,channel:Channel,query:string,options:ContextOptions={}):ReplyKnowledgeContext{
    const started=this.measure(),ownId=this.own(accountId);requireSafe(query.length<=20000,'KNOWLEDGE_QUERY_TOO_LARGE');
    if(options.sourceIds){requireSafe(options.sourceIds.length<=1000&&new Set(options.sourceIds).size===options.sourceIds.length,'KNOWLEDGE_SOURCE_SELECTION_INVALID');
      for(const id of options.sourceIds)this.requireSource(accountId,id);}
    const result=retrieveKnowledge(this.store.db,accountId,channel,query,{now:this.now(),ownId,...(options.sourceIds?{sourceIds:options.sourceIds}:{})});
    let selected:PersonaVersion|null=options.personaId===null?null:this.activePersona(accountId,ownId);
    if(options.personaId){
      const row=this.store.db.prepare("SELECT * FROM k_personas WHERE id=? AND account_id=? AND own_id=? AND state IN ('DRAFT','PUBLISHED','ARCHIVED')")
        .get(options.personaId,accountId,ownId) as PersonaRow|undefined;requireSafe(row,'PERSONA_VERSION_INVALID');selected=persona(row);
    }
    const rows=selected?.sampleIds.length?(this.store.db.prepare(`SELECT m.* FROM k_samples m JOIN k_sources s ON s.id=m.source_id
      WHERE m.account_id=? AND s.own_id=? AND m.id IN (${selected.sampleIds.map(()=>'?').join(',')}) LIMIT 200`)
      .all(accountId,ownId,...selected.sampleIds) as SampleRow[]).map(sampleFromRow):[],byId=new Map(rows.map(row=>[row.id,row]));
    if(selected&&selected.sampleIds.some(id=>{const row=byId.get(id);return !row||!row.accepted||row.excluded||row.holdout;}))selected=null;
    const terms=lexicalTerms(query),score=(row:ReplySample)=>terms.reduce((n,term)=>n+Number(normalized(row.prompt).includes(term)),0);
    const eligible=selected?rows.filter(row=>selected!.sampleIds.includes(row.id)&&row.channel===channel&&row.accepted&&!row.excluded&&!row.holdout&&safeStyleExample(row)):[];
    eligible.sort((a,b)=>score(b)-score(a)||a.id.localeCompare(b.id));
    const examples:StyleExample[]=[];let budget:number=knowledgeLimits.exampleCharacters;
    for(const row of eligible){
      if(examples.length===knowledgeLimits.exampleCount)break;
      const length=Array.from(row.prompt+row.response).length;if(length>budget)continue;budget-=length;
      examples.push({id:row.id,prompt:row.prompt,response:row.response,channel:row.channel});
    }
    const value={accountId,channel,query,...(options.sourceIds?{sourceIds:[...options.sourceIds].sort()}:{}),
      ...(options.personaId===null?{accountPersonaOnly:true}:{}),...(options.personaId?{personaPinned:true}:{}),persona:selected?.text??'',personaId:selected?.id??null,
      examples,knowledge:result.knowledge,conflicts:result.conflicts};
    const fingerprint=digest([ownId,value,result.relevant]);requireSafe(this.measure()-started<=500,'KNOWLEDGE_RETRIEVAL_TIMEOUT');
    return {...value,fingerprint};
  }
  isCurrent(snapshot:ContextWitness):boolean{
    try{return this.context(snapshot.accountId,snapshot.channel,snapshot.query,{...(snapshot.accountPersonaOnly?{personaId:null}:snapshot.personaPinned&&snapshot.personaId?{personaId:snapshot.personaId}:{}),
      ...(snapshot.sourceIds?{sourceIds:snapshot.sourceIds}:{})}).fingerprint===snapshot.fingerprint;}catch{return false;}
  }
}
