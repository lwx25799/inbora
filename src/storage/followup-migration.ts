import Database from 'better-sqlite3';
import {copyFile,mkdir,rm} from 'node:fs/promises';
import {dirname} from 'node:path';
import {digest,requireSafe} from '../core/contracts.js';
import type {EventStore} from './store.js';

const sql=`CREATE TABLE human_reply_drafts(event_id TEXT PRIMARY KEY REFERENCES inbound_events(id),
  id TEXT UNIQUE NOT NULL,text TEXT NOT NULL,version INTEGER NOT NULL,operator_id TEXT NOT NULL,saved_at INTEGER NOT NULL);
CREATE TABLE human_reply_turns(command_id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES inbound_events(id),
  target_key TEXT NOT NULL,operator_id TEXT NOT NULL,input_digest TEXT NOT NULL,params TEXT NOT NULL,
  text TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL,approval TEXT,intent_id TEXT UNIQUE,
  attempt_started_at TEXT,reason TEXT,proof_ref TEXT,verified_at TEXT,native_id_digest TEXT,created_at INTEGER NOT NULL);
CREATE INDEX human_reply_turns_target ON human_reply_turns(target_key,status);
CREATE INDEX human_reply_turns_event ON human_reply_turns(event_id);`;
function inventory(db:Database.Database,names:string[]){
  return digest(names.map(name=>[name,db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`).all()]));
}
/** Independent human turns retain the original inbound, draft, intent and receipt unchanged. */
export async function migrateFollowups(store:EventStore,backupFile:string):Promise<boolean>{
  requireSafe(store.db.pragma('user_version',{simple:true})===3,'CLIENT_MIGRATION_REQUIRED');
  const present=(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('human_reply_drafts','human_reply_turns')").all() as {name:string}[]).length;
  requireSafe(present===0||present===2,'FOLLOWUP_SCHEMA_INCOMPLETE');if(present===2)return false;
  const names=(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name:string}[]).map(row=>row.name);
  const before=inventory(store.db,names);await mkdir(dirname(backupFile),{recursive:true});await store.db.backup(backupFile);
  const trialFile=backupFile+'.trial';await copyFile(backupFile,trialFile);
  try{
    const backup=new Database(backupFile,{readonly:true});
    try{requireSafe(backup.pragma('quick_check',{simple:true})==='ok'&&inventory(backup,names)===before,'MIGRATION_BACKUP_RESTORE_FAILED');}finally{backup.close();}
    const trial=new Database(trialFile);
    try{
      trial.pragma('foreign_keys=ON');trial.transaction(()=>trial.exec(sql)).immediate();
      requireSafe(trial.pragma('quick_check',{simple:true})==='ok'&&(trial.pragma('foreign_key_check') as unknown[]).length===0&&inventory(trial,names)===before,'MIGRATION_TRIAL_FAILED');
    }finally{trial.close();}
    requireSafe(inventory(store.db,names)===before,'DATABASE_CHANGED_DURING_MIGRATION');
    store.db.transaction(()=>store.db.exec(sql)).immediate();return true;
  }finally{await rm(trialFile,{force:true});}
}
