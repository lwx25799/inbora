import {expect,test} from 'vitest';
import Database from 'better-sqlite3';
import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {ensureQueryIndexes,queryIndexes} from '../../src/storage/query-indexes.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {database,pending,privateTemp} from '../helpers.js';

test('indexes preserve business data and schema versions, are backed up, and remain compatible with old migration',async()=>{
  const store=database(),root=privateTemp('query-index-'),backup=join(root,'indexes.sqlite');
  try{
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
  }finally{store.close();}
});

test.each(['status','target_key COLLATE NOCASE,status','target_key,status DESC'])('a same-name incompatible index (%s) blocks installation',async columns=>{
  const store=database(),root=privateTemp('query-index-conflict-');try{
    await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'auto.sqlite'));
    store.db.exec(`CREATE INDEX inbora_query_intent_target ON send_intents(${columns})`);
    await expect(ensureQueryIndexes(store,join(root,'backup.sqlite'))).rejects.toThrow('QUERY_INDEX_DEFINITION_CHANGED');
    expect(store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'inbora_query_%'").get()).toEqual({n:1});
  }finally{store.close();}
});
