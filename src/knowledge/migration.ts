import Database from 'better-sqlite3';
import {copyFile,mkdir,rm} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {requireSafe} from '../core/contracts.js';
import type {EventStore} from '../storage/store.js';

export const knowledgeSql=`
CREATE TABLE k_schema(version INTEGER PRIMARY KEY CHECK(version=3));
INSERT INTO k_schema VALUES(3);
CREATE TABLE k_sources(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,own_id TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,
  content_digest TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(account_id,own_id,kind,content_digest));
CREATE TABLE k_knowledge(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,source_id TEXT NOT NULL REFERENCES k_sources(id),
  title TEXT NOT NULL,topic TEXT NOT NULL,text TEXT NOT NULL,aliases_json TEXT NOT NULL,channels_json TEXT NOT NULL,
  effective_at INTEGER,expires_at INTEGER,state TEXT NOT NULL,version INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE INDEX k_knowledge_account ON k_knowledge(account_id,state,topic);
CREATE TABLE k_chunks(id TEXT PRIMARY KEY,entry_id TEXT NOT NULL REFERENCES k_knowledge(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,text TEXT NOT NULL,terms TEXT NOT NULL);
CREATE VIRTUAL TABLE k_search USING fts5(chunk_id UNINDEXED,text,tokenize='trigram');
CREATE VIRTUAL TABLE k_terms USING fts5(chunk_id UNINDEXED,terms,tokenize='unicode61');
CREATE TABLE k_samples(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,source_id TEXT NOT NULL REFERENCES k_sources(id),
  channel TEXT NOT NULL,prompt TEXT NOT NULL,response TEXT NOT NULL,origin TEXT NOT NULL,source_ref TEXT,
  group_key TEXT NOT NULL,content_digest TEXT NOT NULL,accepted INTEGER NOT NULL DEFAULT 0,excluded INTEGER NOT NULL DEFAULT 0,
  holdout INTEGER NOT NULL DEFAULT 0,reason TEXT,created_at INTEGER NOT NULL,UNIQUE(account_id,content_digest));
CREATE INDEX k_samples_account ON k_samples(account_id,accepted,holdout,created_at);
CREATE TABLE k_sample_sources(sample_id TEXT NOT NULL REFERENCES k_samples(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES k_sources(id),PRIMARY KEY(sample_id,source_id));
CREATE TABLE k_personas(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,own_id TEXT NOT NULL,text TEXT NOT NULL,
  sample_ids_json TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE INDEX k_personas_account ON k_personas(account_id,state);
CREATE TABLE k_generation_contexts(kind TEXT NOT NULL,entity_id TEXT NOT NULL,version INTEGER NOT NULL,snapshot_json TEXT NOT NULL,
  PRIMARY KEY(kind,entity_id,version));
CREATE TABLE k_learning_tasks(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,sample_digest TEXT NOT NULL,settings_digest TEXT NOT NULL,
  state TEXT NOT NULL,created_at INTEGER NOT NULL,persona_id TEXT);
CREATE TABLE k_learning_batches(task_id TEXT NOT NULL REFERENCES k_learning_tasks(id),batch_index INTEGER NOT NULL,purpose TEXT NOT NULL,
  input_digest TEXT NOT NULL,output_json TEXT,state TEXT NOT NULL,call_id TEXT,PRIMARY KEY(task_id,batch_index));
CREATE TABLE k_model_purposes(call_id TEXT PRIMARY KEY REFERENCES model_calls(id),purpose TEXT NOT NULL,task_id TEXT);
CREATE TABLE k_candidate_progress(account_id TEXT NOT NULL,own_id TEXT NOT NULL,source_ref TEXT NOT NULL,processed_at INTEGER NOT NULL,
  PRIMARY KEY(account_id,own_id,source_ref));`;
const required=['k_schema','k_sources','k_knowledge','k_chunks','k_search','k_terms','k_samples','k_sample_sources','k_personas',
  'k_generation_contexts','k_learning_tasks','k_learning_batches','k_model_purposes','k_candidate_progress'];
const versionOneBase=['k_sources','k_knowledge','k_chunks','k_search','k_samples','k_personas'];
const extendVersionOne=`CREATE VIRTUAL TABLE IF NOT EXISTS k_terms USING fts5(chunk_id UNINDEXED,terms,tokenize='unicode61');
DELETE FROM k_terms;INSERT INTO k_terms(chunk_id,terms) SELECT id,terms FROM k_chunks;
CREATE TABLE IF NOT EXISTS k_sample_sources(sample_id TEXT NOT NULL REFERENCES k_samples(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES k_sources(id),PRIMARY KEY(sample_id,source_id));
INSERT OR IGNORE INTO k_sample_sources SELECT id,source_id FROM k_samples;
CREATE TABLE IF NOT EXISTS k_generation_contexts(kind TEXT NOT NULL,entity_id TEXT NOT NULL,version INTEGER NOT NULL,snapshot_json TEXT NOT NULL,
  PRIMARY KEY(kind,entity_id,version));
CREATE TABLE IF NOT EXISTS k_learning_tasks(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,sample_digest TEXT NOT NULL,settings_digest TEXT NOT NULL,
  state TEXT NOT NULL,created_at INTEGER NOT NULL,persona_id TEXT);
CREATE TABLE IF NOT EXISTS k_learning_batches(task_id TEXT NOT NULL REFERENCES k_learning_tasks(id),batch_index INTEGER NOT NULL,purpose TEXT NOT NULL,
  input_digest TEXT NOT NULL,output_json TEXT,state TEXT NOT NULL,call_id TEXT,PRIMARY KEY(task_id,batch_index));
CREATE TABLE IF NOT EXISTS k_model_purposes(call_id TEXT PRIMARY KEY REFERENCES model_calls(id),purpose TEXT NOT NULL,task_id TEXT);
CREATE INDEX IF NOT EXISTS k_samples_learning ON k_samples(account_id,accepted,holdout,created_at);`;
const extendVersionTwo=`CREATE TABLE k_candidate_progress(account_id TEXT NOT NULL,own_id TEXT NOT NULL,source_ref TEXT NOT NULL,processed_at INTEGER NOT NULL,
  PRIMARY KEY(account_id,own_id,source_ref));
ALTER TABLE k_schema RENAME TO k_schema_previous;
CREATE TABLE k_schema(version INTEGER PRIMARY KEY CHECK(version=3));INSERT INTO k_schema VALUES(3);DROP TABLE k_schema_previous;`;
function inventory(db:Database.Database,names:string[]):string{
  const hash=createHash('sha256');
  for(const name of names){
    hash.update(JSON.stringify(name)+'\n');
    const table='"'+name.replaceAll('"','""')+'"',columns=db.prepare(`SELECT * FROM ${table}`).columns().length;
    for(const row of db.prepare(`SELECT * FROM ${table} ORDER BY ${Array.from({length:columns},(_,index)=>index+1).join(',')}`).iterate())hash.update(JSON.stringify(row)+'\n');
  }
  return hash.digest('hex');
}

/** Exercise a consistent backup, trial upgrade and restored copy before changing the owner database. */
export async function migrateReplyKnowledge(store:EventStore,backupFile:string):Promise<boolean>{
  const dbVersion=store.db.pragma('user_version',{simple:true});
  requireSafe(dbVersion===3||dbVersion===4,'CLIENT_MIGRATION_REQUIRED');
  const has=(name:string)=>!!store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const present=required.filter(has),hasSchema=has('k_schema');
  const versions=hasSchema?store.db.prepare('SELECT version FROM k_schema').all() as {version:number}[]:[];
  requireSafe(!hasSchema||versions.length===1&&[1,2,3].includes(versions[0]!.version),'KNOWLEDGE_SCHEMA_UNSUPPORTED');
  const version=versions[0]?.version??0;
  requireSafe(version===0?present.length===0:versionOneBase.every(has),'KNOWLEDGE_SCHEMA_INCOMPLETE');
  if(version===3){requireSafe(required.every(has),'KNOWLEDGE_SCHEMA_INCOMPLETE');return false;}
  if(version===2)requireSafe(required.filter(name=>name!=='k_candidate_progress').every(has),'KNOWLEDGE_SCHEMA_INCOMPLETE');
  const upgrade=version===1?extendVersionOne.replace('INSERT OR IGNORE INTO k_sample_sources SELECT id,source_id FROM k_samples;',
    has('k_sample_sources')?'':'INSERT OR IGNORE INTO k_sample_sources SELECT id,source_id FROM k_samples;')+extendVersionTwo:version===2?extendVersionTwo:knowledgeSql;
  const names=(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name:string}[]).map(row=>row.name);
  const before=inventory(store.db,names),preserved=names.filter(name=>name!=='k_schema'),preservedBefore=inventory(store.db,preserved);
  await mkdir(dirname(backupFile),{recursive:true});await store.db.backup(backupFile);
  const trialFile=backupFile+'.trial';await copyFile(backupFile,trialFile);
  try{
    const backup=new Database(backupFile,{readonly:true});
    try{requireSafe(backup.pragma('quick_check',{simple:true})==='ok'&&inventory(backup,names)===before,'MIGRATION_BACKUP_RESTORE_FAILED');}
    finally{backup.close();}
    const trial=new Database(trialFile);
    try{
      trial.pragma('foreign_keys=ON');trial.transaction(()=>trial.exec(upgrade)).immediate();
      requireSafe(trial.pragma('quick_check',{simple:true})==='ok'&&(trial.pragma('foreign_key_check') as unknown[]).length===0&&
        inventory(trial,preserved)===preservedBefore&&(trial.prepare('SELECT version FROM k_schema').get() as {version:number}).version===3,'MIGRATION_TRIAL_FAILED');
    }finally{trial.close();}
    await copyFile(backupFile,trialFile);
    const restored=new Database(trialFile,{readonly:true});
    try{requireSafe(restored.pragma('quick_check',{simple:true})==='ok'&&inventory(restored,names)===before,'MIGRATION_BACKUP_RESTORE_FAILED');}
    finally{restored.close();}
    requireSafe(inventory(store.db,names)===before,'DATABASE_CHANGED_DURING_MIGRATION');
    store.db.transaction(()=>store.db.exec(upgrade)).immediate();return true;
  }finally{await rm(trialFile,{force:true});}
}
