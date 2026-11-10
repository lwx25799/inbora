import {expect,test} from 'vitest';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import Database from 'better-sqlite3';
import {approved,candidate,database,privateTemp,snapshot} from '../helpers.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {readDiagnostics} from '../../src/app/diagnostics.js';

async function setup(){
  const store=database(),root=privateTemp('diagnostic-blockers-'),draft=approved(store);
  await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'auto.sqlite'));
  const event=store.draft(draft).eventId;
  const command=(status:string,reason:string|null,intent:string|null=null)=>{
    store.db.prepare('INSERT INTO manual_send_commands VALUES(?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(),event,'synthetic-operator','synthetic-digest','{}',status,intent,reason,1);
  };
  const rows=()=>Object.fromEntries((store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name:string}[])
    .map(({name})=>[name,store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  return {store,draft,event,command,rows};
}

test('a later confirmed reply removes historical failures without rewriting their ledger rows',async()=>{
  const f=await setup();try{
    f.command('FAILED_BEFORE_CLICK','TARGET_CHANGED');
    expect(readDiagnostics(f.store).blockers).toContainEqual({source:'MANUAL_SEND',code:'TARGET_CHANGED',count:1});
    const intent=f.store.recordIntent(f.draft,snapshot(candidate()),false,{check:()=>{},committed:()=>{}});
    f.store.receipt(intent,'CONFIRMED','SYNTHETIC_PROOF');f.command('CONFIRMED',null,intent);
    const before=f.rows();expect(readDiagnostics(f.store).blockers).toEqual([]);expect(f.rows()).toEqual(before);
  }finally{f.store.close();}
});

test('only the latest command for an event describes its present manual blocker',async()=>{
  const f=await setup();try{
    f.command('FAILED_BEFORE_CLICK','TARGET_CHANGED');f.command('PREPARING',null);
    expect(readDiagnostics(f.store).blockers).toEqual([]);
    f.command('FAILED_BEFORE_CLICK','MODEL_PAUSED');f.command('FAILED_BEFORE_CLICK','MODEL_PAUSED');
    expect(readDiagnostics(f.store).blockers).toEqual([{source:'MANUAL_SEND',code:'MODEL_PAUSED',count:1}]);
  }finally{f.store.close();}
});

test('latest persistent proof resolves all event blockers and a later negative proof restores them',async()=>{
  const f=await setup();try{
    const intent=f.store.recordIntent(f.draft,snapshot(candidate()),false,{check:()=>{},committed:()=>{}});
    f.store.receipt(intent,'CONFIRMED','SYNTHETIC_CONFIRMED');f.command('UNCERTAIN','PROOF_INCOMPLETE',intent);
    f.store.db.prepare('INSERT INTO automation_jobs VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(f.event,1,'REVIEW','context',0,1,'AUTO_RESULT_STALE',null,1,1);
    f.store.db.prepare('INSERT INTO verification_jobs VALUES(?,?,?,?,?,?,?,?,?)')
      .run(intent,f.event,'boundary','target',2,0,100,'REVIEW','VERIFICATION_DEADLINE');
    f.store.db.prepare('INSERT INTO verification_results VALUES(?,?,?,?,?)').run(randomUUID(),intent,0,'SYNTHETIC_FIRST_NEGATIVE',200);
    const waiting=readDiagnostics(f.store).blockers;
    expect(waiting.map(row=>row.source).sort()).toEqual(['AUTOMATION','MANUAL_SEND','VERIFICATION']);
    f.store.db.prepare('INSERT INTO verification_results VALUES(?,?,?,?,?)').run(randomUUID(),intent,1,'SYNTHETIC_POSITIVE',100);
    const before=f.rows();expect(readDiagnostics(f.store).blockers).toEqual([]);expect(f.rows()).toEqual(before);
    f.store.db.prepare('INSERT INTO verification_results VALUES(?,?,?,?,?)').run(randomUUID(),intent,0,'SYNTHETIC_NEGATIVE',50);
    expect(readDiagnostics(f.store).blockers).toEqual(waiting);
  }finally{f.store.close();}
});

test('legacy diagnostics without query indexes aggregate many proofs without blocking for seconds',()=>{
  const db=new Database(':memory:');try{
    db.exec(`CREATE TABLE model_calls(id TEXT PRIMARY KEY,model TEXT,status TEXT,input_tokens INTEGER,output_tokens INTEGER,elapsed_ms INTEGER,estimated_cost REAL);
      CREATE TABLE inbound_events(id TEXT PRIMARY KEY,status TEXT);
      CREATE TABLE send_intents(id TEXT PRIMARY KEY,event_id TEXT UNIQUE);
      CREATE TABLE verification_results(id TEXT PRIMARY KEY,intent_id TEXT,verified INTEGER,checked_at INTEGER);
      CREATE TABLE automation_jobs(event_id TEXT PRIMARY KEY,state TEXT,reason TEXT);
      CREATE TABLE verification_jobs(intent_id TEXT PRIMARY KEY,event_id TEXT,state TEXT,last_error TEXT);
      CREATE TABLE manual_send_commands(command_id TEXT PRIMARY KEY,event_id TEXT,status TEXT,reason TEXT);`);
    const event=db.prepare("INSERT INTO inbound_events VALUES(?,'CONFIRMED')"),intent=db.prepare('INSERT INTO send_intents VALUES(?,?)');
    const proof=db.prepare('INSERT INTO verification_results VALUES(?,?,?,?)'),auto=db.prepare("INSERT INTO automation_jobs VALUES(?,'REVIEW','SYNTHETIC_AUTO')");
    const verify=db.prepare("INSERT INTO verification_jobs VALUES(?,?,'REVIEW','SYNTHETIC_VERIFY')"),command=db.prepare('INSERT INTO manual_send_commands VALUES(?,?,?,?)');
    db.transaction(()=>{for(let n=0;n<10000;n++){
      const e='event-'+n,i='intent-'+n;event.run(e);intent.run(i,e);
      proof.run('first-'+n,i,1,100);proof.run('latest-'+n,i,n%2,50);auto.run(e);verify.run(i,e);
      command.run('old-'+n,e,'FAILED_BEFORE_CLICK','SYNTHETIC_PRIOR');
      command.run('new-'+n,e,n%2?'CONFIRMED':'FAILED_BEFORE_CLICK','SYNTHETIC_LATEST');
    }})();
    const before=db.prepare('SELECT total_changes() AS n').get(),started=performance.now(),result=readDiagnostics({db});
    // A generous bound distinguishes a batched scan (~0.1s) from the reproduced ~10s correlated scans.
    expect(performance.now()-started).toBeLessThan(2500);
    expect(result.blockers).toEqual([{source:'AUTOMATION',code:'SYNTHETIC_AUTO',count:5000},
      {source:'MANUAL_SEND',code:'SYNTHETIC_LATEST',count:5000},{source:'VERIFICATION',code:'SYNTHETIC_VERIFY',count:5000}]);
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  }finally{db.close();}
});
