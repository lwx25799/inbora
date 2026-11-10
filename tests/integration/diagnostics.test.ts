import Database from 'better-sqlite3';
import {expect,test} from 'vitest';
import {readDiagnostics} from '../../src/app/diagnostics.js';

test('diagnostics aggregate known usage and nearest-rank latency without inventing dates or costs',()=>{
  const db=new Database(':memory:');
  try{
    db.exec(`CREATE TABLE model_calls(id TEXT,model TEXT,status TEXT,input_tokens INTEGER,output_tokens INTEGER,elapsed_ms INTEGER,estimated_cost REAL);`);
    const insert=db.prepare('INSERT INTO model_calls VALUES(?,?,?,?,?,?,?)');
    for(let index=1;index<=20;index++)insert.run(String(index),'deepseek-chat','SUCCEEDED',10,2,index*10,null);
    insert.run('failed','deepseek-chat','FAILED',null,null,500,null);
    insert.run('partial','deepseek-reasoner','FAILED',12,null,null,null);
    insert.run('private','private message body','not a status',null,null,null,null);
    const before=db.prepare('SELECT total_changes() AS n').get(),result=readDiagnostics({db});
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    expect(result.timeRangeSupported).toBe(false);
    expect(result.model.total).toMatchObject({requests:23,knownUsageRequests:20,unknownUsageRequests:3,inputTokens:212,outputTokens:40,
      elapsedSamples:21,averageElapsedMs:2600/21,p95ElapsedMs:200});
    expect(result.model.groups.find(group=>group.model==='deepseek-chat'&&group.status==='SUCCEEDED')).toMatchObject({requests:20,p95ElapsedMs:190});
    expect(result.model.groups.some(group=>group.model==='UNKNOWN_MODEL'&&group.status==='UNKNOWN')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private message body');
    expect(JSON.stringify(result)).not.toContain('estimatedCost');
  }finally{db.close();}
});

test('diagnostics report only current blocked states and redacted collection progress with a top-ten bound',()=>{
  const db=new Database(':memory:');
  try{
    db.exec(`CREATE TABLE model_calls(id TEXT,model TEXT,status TEXT,input_tokens INTEGER,output_tokens INTEGER,elapsed_ms INTEGER,estimated_cost REAL);
      CREATE TABLE collection_progress(source TEXT,next_at INTEGER,last_success INTEGER,last_error TEXT,failures INTEGER,elapsed_ms INTEGER,cursor_json TEXT);
      CREATE TABLE inbound_events(id TEXT,status TEXT);
      CREATE TABLE automation_jobs(state TEXT,reason TEXT,event_id TEXT);
      CREATE TABLE verification_jobs(state TEXT,last_error TEXT,event_id TEXT);
      CREATE TABLE manual_send_commands(status TEXT,reason TEXT,event_id TEXT);
      CREATE TABLE work_collection_progress(last_error TEXT);
      CREATE TABLE discovered_works(state TEXT);
      CREATE TABLE discovered_conversations(last_read INTEGER);
      INSERT INTO collection_progress VALUES('dm',200,100,'DM_THREAD_READ_FAILED',2,40,'{"private":"body"}');
      INSERT INTO automation_jobs VALUES('REVIEW','MODEL_FAILED_NO_RETRY','auto'),('CONFIRMED','STALE_ERROR','auto-old');
      INSERT INTO verification_jobs VALUES('PENDING','PROOF_INCOMPLETE','verify'),('DONE','STALE_ERROR','verify-old');
      INSERT INTO manual_send_commands VALUES('FAILED_BEFORE_CLICK','private message body','manual'),('CONFIRMED','STALE_ERROR','manual-old');
      INSERT INTO discovered_works VALUES('INCLUDED'),('HISTORICAL'),('REVIEW');
      INSERT INTO discovered_conversations VALUES(0),(100);`);
    for(let index=0;index<15;index++)db.prepare('INSERT INTO automation_jobs VALUES(?,?,?)').run('REVIEW','REASON_'+index,'auto-'+index);
    const result=readDiagnostics({db});
    expect(result.blockers).toHaveLength(10);
    expect(result.blockers.some(item=>item.code==='STALE_ERROR')).toBe(false);
    expect(result.collection.channels).toEqual([{source:'dm',nextAt:200,lastSuccess:100,lastError:'DM_THREAD_READ_FAILED',failures:2,elapsedMs:40}]);
    expect(result.collection.works).toEqual({included:1,historical:1,review:1});
    expect(result.collection.conversations).toEqual({total:2,neverRead:1});
    expect(JSON.stringify(result)).not.toMatch(/private|body|STALE_ERROR/u);
  }finally{db.close();}
});
