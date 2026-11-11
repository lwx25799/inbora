import Database from 'better-sqlite3';
import {copyFile,mkdir,rm} from 'node:fs/promises';
import {dirname} from 'node:path';
import {digest,requireSafe} from '../core/contracts.js';
import type {EventStore} from './store.js';

const tables=['assistant_sessions','assistant_commands','assistant_operations'];
const sql=`CREATE TABLE assistant_sessions(operator_id TEXT PRIMARY KEY REFERENCES operator_sessions(id),
  grant_version INTEGER NOT NULL REFERENCES automation_grants(version));
CREATE TABLE assistant_commands(command_id TEXT PRIMARY KEY REFERENCES manual_send_commands(command_id),
  grant_version INTEGER NOT NULL REFERENCES automation_grants(version));
CREATE TABLE assistant_operations(operation_id TEXT PRIMARY KEY,tool TEXT NOT NULL,input_digest TEXT NOT NULL,
  grant_version INTEGER NOT NULL REFERENCES automation_grants(version),event_id TEXT REFERENCES inbound_events(id),
  state TEXT NOT NULL,result_json TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);`;
function inventory(db:Database.Database,names:string[]):string{
  return digest(names.map(name=>[name,db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`).all()]));
}
/** A separate additive extension; old grants, drafts, commands and spend remain byte-for-byte intact. */
export async function migrateLocalAssistant(store:EventStore,backupFile:string):Promise<boolean>{
  requireSafe(store.db.pragma('user_version',{simple:true})===3,'CLIENT_MIGRATION_REQUIRED');
  requireSafe(!!store.db.prepare("SELECT name FROM sqlite_master WHERE name='automation_grants'").get(),'AUTOMATION_MIGRATION_REQUIRED');
  const present=tables.filter(name=>store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
  requireSafe(present.length===0||present.length===tables.length,'ASSISTANT_SCHEMA_INCOMPLETE');
  if(present.length===tables.length)return false;
  const names=(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name:string}[]).map(row=>row.name);
  const before=inventory(store.db,names);await mkdir(dirname(backupFile),{recursive:true});await store.db.backup(backupFile);
  const trialFile=backupFile+'.trial';await copyFile(backupFile,trialFile);
  try{
    const backup=new Database(backupFile,{readonly:true});
    try{requireSafe(backup.pragma('quick_check',{simple:true})==='ok'&&inventory(backup,names)===before,'MIGRATION_BACKUP_RESTORE_FAILED');}
    finally{backup.close();}
    const trial=new Database(trialFile);
    try{
      trial.pragma('foreign_keys=ON');trial.transaction(()=>trial.exec(sql)).immediate();
      requireSafe(trial.pragma('quick_check',{simple:true})==='ok'&&(trial.pragma('foreign_key_check') as unknown[]).length===0&&
        inventory(trial,names)===before,'MIGRATION_TRIAL_FAILED');
    }finally{trial.close();}
    // Exercise rollback on the upgraded private copy, then reopen it as a restored database.
    // The original live database is still untouched at this point.
    await copyFile(backupFile,trialFile);
    const restored=new Database(trialFile,{readonly:true});
    try{
      requireSafe(restored.pragma('quick_check',{simple:true})==='ok'&&
        restored.pragma('user_version',{simple:true})===3&&inventory(restored,names)===before&&
        !tables.some(name=>restored.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)),
        'MIGRATION_BACKUP_RESTORE_FAILED');
    }finally{restored.close();}
    requireSafe(inventory(store.db,names)===before,'DATABASE_CHANGED_DURING_MIGRATION');
    store.db.transaction(()=>store.db.exec(sql)).immediate();return true;
  }finally{await rm(trialFile,{force:true});}
}
