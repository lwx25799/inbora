import {expect,test} from 'vitest';
import {join} from 'node:path';
import {readFile,readdir} from 'node:fs/promises';
import {InboxCollector} from '../../src/app/inbox-collector.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import type {ObservedReader} from '../../src/adapters/observed-reader.js';
import type {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {observedMapping} from '../fixtures/observed-site.js';
import {database,privateTemp} from '../helpers.js';

test('fixed diagnostics distinguish new phases and codes, suppress exact repeats and cap each source at six',async()=>{
  const store=database(),root=privateTemp('bounded-phase-diagnostics-');
  await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  const data=new AutomationStore(store);data.initialize(Date.now()-1000);store.bindAccount('100');
  data.configureCollection({ownId:'100',comments:true,inbox:true,commentIntervalMs:30000,dmIntervalMs:15000});
  const owner={notification:{on(){},off(){}}} as unknown as BrowserProfileOwner;
  const collector=new InboxCollector(owner,observedMapping('http://127.0.0.1:12345'),data,root,'headless');
  let captures=0;const reader={diagnostic:async()=>{captures++;return {source:'dm',messageSamples:[],conversationSamples:[]};}} as unknown as ObservedReader;
  const diagnose=(source:'dm'|'works',code:string,phase:'LIST'|'THREAD'|'ADVANCE'|'HINT')=>(collector as unknown as {
    diagnose(reader:ObservedReader,source:'dm'|'works',code:string,signal:AbortSignal,peer:undefined,phase:string):Promise<void>;
  }).diagnose(reader,source,code,new AbortController().signal,undefined,phase);
  const latest=async(source='dm')=>JSON.parse(await readFile(join(root,'evidence',`collection-read-${source}-latest.json`),'utf8'));
  try{
    await diagnose('dm','OBSERVATION_METADATA_NOT_READY','LIST');
    expect(await latest()).toMatchObject({code:'OBSERVATION_METADATA_NOT_READY'});
    await diagnose('dm','OBSERVATION_METADATA_NOT_READY','LIST');expect(captures).toBe(1);
    await diagnose('dm','OBSERVATION_DM_CONTENT_DOM_NOT_READY','THREAD');
    expect(captures).toBe(2);
    expect(await latest()).toMatchObject({phase:'THREAD',code:'OBSERVATION_DM_CONTENT_DOM_NOT_READY'});
    await diagnose('dm','OBSERVATION_DM_CONTENT_DOM_NOT_READY','HINT');
    expect(await latest()).toMatchObject({phase:'HINT'});
    await diagnose('dm','OBSERVATION_METADATA_NOT_READY','ADVANCE');
    await diagnose('dm','OBSERVATION_DM_CHAT_NOT_READY','THREAD');
    await diagnose('dm','OBSERVATION_MESSAGE_TEXT_CONFLICT','THREAD');expect(captures).toBe(6);
    const before=await latest();await diagnose('dm','OBSERVATION_EXISTING_HUMAN_INPUT','THREAD');expect(captures).toBe(6);expect(await latest()).toEqual(before);
    await diagnose('works','OBSERVATION_METADATA_NOT_READY','THREAD');expect(captures).toBe(7);
    expect((await readdir(join(root,'evidence'))).sort()).toEqual(['collection-read-dm-latest.json','collection-read-works-latest.json']);
    expect(store.db.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type='COLLECTION_READ_DIAGNOSTIC'").get()).toEqual({n:7});
    expect(store.db.prepare('SELECT last_success,last_error FROM collection_progress ORDER BY source').all()).toEqual([
      {last_success:null,last_error:null},{last_success:null,last_error:null},
    ]);
    expect(store.db.prepare('SELECT used FROM budgets ORDER BY kind').all()).toEqual([{used:0},{used:0}]);
  }finally{collector.dispose();store.close();}
});
