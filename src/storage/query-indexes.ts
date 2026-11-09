import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {copyFile,mkdir,rm} from 'node:fs/promises';
import {dirname} from 'node:path';
import {requireSafe} from '../core/contracts.js';
import type {EventStore} from './store.js';

export const queryIndexes=[
  {name:'inbora_query_inbound_target',table:'inbound_events',columns:['account_id','channel','target_key']},
  {name:'inbora_query_intent_target',table:'send_intents',columns:['target_key','status']},
  {name:'inbora_query_audit_entity',table:'audit_events',columns:['event_type','entity_id']},
  {name:'inbora_query_observation_source',table:'observations',columns:['channel','scope','evidence_ref']},
  {name:'inbora_query_receipt_intent',table:'delivery_receipts',columns:['send_intent_id']},
  {name:'inbora_query_verification_intent',table:'verification_results',columns:['intent_id']},
] as const;
function inventory(db:Database.Database):string {
  const hash=createHash('sha256');
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name:string}[];
  for(const {name} of tables){
    hash.update(JSON.stringify(name));
    for(const row of db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`).iterate())hash.update(JSON.stringify(row));
  }
  return hash.digest('hex');
}
function missing(db:Database.Database){
  return queryIndexes.filter(index=>{
    const row=db.prepare("SELECT tbl_name,sql FROM sqlite_master WHERE type='index' AND name=?").get(index.name) as {tbl_name:string;sql:string}|undefined;
    if(!row)return true;
    const keys=(db.prepare(`PRAGMA index_xinfo("${index.name}")`).all() as {name:string;coll:string;desc:number;key:number}[]).filter(item=>item.key===1);
    const columns=keys.map(item=>item.name);
    const info=db.prepare(`PRAGMA index_list("${index.table}")`).all() as {name:string;unique:number;partial:number}[];
    const actual=info.find(item=>item.name===index.name);
    requireSafe(row.tbl_name===index.table&&JSON.stringify(columns)===JSON.stringify(index.columns)&&keys.every(item=>item.coll==='BINARY'&&item.desc===0)&&
      actual?.unique===0&&actual.partial===0,'QUERY_INDEX_DEFINITION_CHANGED');
    return false;
  });
}
function healthy(db:Database.Database):boolean {
  return db.pragma('quick_check',{simple:true})==='ok'&&(db.pragma('foreign_key_check') as unknown[]).length===0;
}

/** Purely additive indexes keep both version markers at 3 so old clients can still open new records. */
export async function ensureQueryIndexes(store:EventStore,backupFile:string):Promise<boolean> {
  requireSafe(store.db.pragma('user_version',{simple:true})===3&&
    (store.db.prepare('SELECT version FROM automation_schema').get() as {version:number}).version===3,'QUERY_INDEX_SCHEMA_REQUIRED');
  const needed=missing(store.db);if(!needed.length)return false;
  requireSafe(healthy(store.db),'QUERY_INDEX_DATABASE_INVALID');
  const before=inventory(store.db),sql=needed.map(index=>`CREATE INDEX "${index.name}" ON "${index.table}" (${index.columns.join(',')});`).join('\n');
  await mkdir(dirname(backupFile),{recursive:true});await store.db.backup(backupFile);
  const trialFile=backupFile+'.trial';await copyFile(backupFile,trialFile);
  try{
    const restored=new Database(backupFile,{readonly:true});
    try{requireSafe(healthy(restored)&&inventory(restored)===before,'QUERY_INDEX_BACKUP_INVALID');}finally{restored.close();}
    const trial=new Database(trialFile);
    try{
      trial.pragma('foreign_keys = ON');trial.transaction(()=>trial.exec(sql)).immediate();
      requireSafe(healthy(trial)&&inventory(trial)===before&&missing(trial).length===0,'QUERY_INDEX_TRIAL_FAILED');
    }finally{trial.close();}
    store.db.transaction(()=>{
      requireSafe(inventory(store.db)===before,'DATABASE_CHANGED_DURING_MIGRATION');
      store.db.exec(sql);requireSafe(healthy(store.db)&&missing(store.db).length===0,'QUERY_INDEX_INSTALL_FAILED');
      store.audit('QUERY_INDEXES_INSTALLED','query-indexes-v1',{count:needed.length});
    }).immediate();
    return true;
  }finally{await rm(trialFile,{force:true});}
}
