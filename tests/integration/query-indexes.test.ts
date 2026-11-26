import {expect,test} from 'vitest';
import Database from 'better-sqlite3';
import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import {ensureQueryIndexes,queryIndexes} from '../../src/storage/query-indexes.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {pending,privateTemp} from '../helpers.js';
import {EventStore} from '../../src/storage/store.js';

test.each(['client','indexes'])('%s inventory accepts FTS5 shadow tables without rowid',async phase=>{
  const root=privateTemp('query-index-fts-');
  const backup=join(root,'backup.sqlite');
  let store:EventStore|undefined;
  try{
    store=new EventStore(join(root,'poc.sqlite'),true);
    if(phase==='indexes'){
      await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'auto.sqlite'));
    }
    store.db.exec("CREATE VIRTUAL TABLE synthetic_fts USING fts5(body); INSERT INTO synthetic_fts VALUES ('fixture text')");
    expect(store.db.prepare("SELECT wr FROM pragma_table_list WHERE name='synthetic_fts_idx'").get()).toEqual({wr:1});
    const migrate=phase==='client'?migrateClient:ensureQueryIndexes;
    expect(await migrate(store,backup)).toBe(true);
    const query="SELECT rowid,body FROM synthetic_fts WHERE synthetic_fts MATCH 'fixture'";
    expect(store.db.prepare(query).all()).toEqual([{rowid:1,body:'fixture text'}]);
    const restored=new Database(backup,{readonly:true});
    try{expect(restored.prepare(query).all()).toEqual([{rowid:1,body:'fixture text'}]);}finally{restored.close();}
    expect(store.db.pragma('user_version',{simple:true})).toBe(3);
    expect(existsSync(backup+'.trial')).toBe(false);
  }finally{try{store?.close();}finally{await rm(root,{recursive:true,force:true});}}
});

test('indexes preserve business data and schema versions, are backed up, and remain compatible with old migration',async()=>{
  const root=privateTemp('query-index-'),backup=join(root,'indexes.sqlite');
  let store:EventStore|undefined;
  try{
    store=new EventStore(join(root,'poc.sqlite'),true);
    pending(store);await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'auto.sqlite'));
    const before=store.events(),budgets=store.budgets();
    expect(await ensureQueryIndexes(store,backup)).toBe(true);expect(existsSync(backup)).toBe(true);
    const restored=new Database(backup,{readonly:true});try{
      expect(restored.pragma('quick_check',{simple:true})).toBe('ok');
      expect(restored.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'inbora_query_%'").all()).toEqual([]);
    }finally{restored.close();}
    expect(store.events()).toEqual(before);expect(store.budgets()).toEqual(budgets);
    expect(store.db.pragma('user_version',{simple:true})).toBe(3);
    expect(store.db.prepare('SELECT version FROM automation_schema').get()).toEqual({version:3});
    expect(await migrateAutomation(store,join(root,'old-reopen.sqlite'))).toBe(false);
    expect(await ensureQueryIndexes(store,join(root,'unused.sqlite'))).toBe(false);expect(existsSync(join(root,'unused.sqlite'))).toBe(false);
    for(const index of queryIndexes)expect(store.db.prepare('SELECT name FROM sqlite_master WHERE type=\'index\' AND name=?').get(index.name)).toEqual({name:index.name});
    expect(JSON.stringify(store.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM send_intents WHERE target_key=? AND status='UNCERTAIN'").all('dm:one'))).toContain('inbora_query_intent_target');
    expect(store.db.pragma('foreign_key_check')).toEqual([]);
  }finally{try{store?.close();}finally{await rm(root,{recursive:true,force:true});}}
});

test.each(['status','target_key COLLATE NOCASE,status','target_key,status DESC'])('a same-name incompatible index (%s) blocks installation',async columns=>{
  const root=privateTemp('query-index-conflict-');
  let store:EventStore|undefined;
  try{
    store=new EventStore(join(root,'poc.sqlite'),true);
    await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'auto.sqlite'));
    store.db.exec(`CREATE INDEX inbora_query_intent_target ON send_intents(${columns})`);
    await expect(ensureQueryIndexes(store,join(root,'backup.sqlite'))).rejects.toThrow('QUERY_INDEX_DEFINITION_CHANGED');
    expect(store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'inbora_query_%'").get()).toEqual({n:1});
  }finally{try{store?.close();}finally{await rm(root,{recursive:true,force:true});}}
});
