import {spawnSync} from 'node:child_process';
import {readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {expect,test} from 'vitest';
import {EventStore} from '../../src/storage/store.js';
import {recordEvidence} from '../../src/observability/evidence.js';
import {digest} from '../../src/core/contracts.js';
import {approved,candidate,privateTemp,snapshot} from '../helpers.js';

test('source CLI diagnostics and both evidence modes preserve in-flight intents without invoking recovery',async()=>{
  const root=privateTemp('diagnostics-cli-'),file=join(root,'poc.sqlite');
  let store:EventStore|undefined;
  try{
    await writeFile(join(root,'runtime.json'),JSON.stringify({version:1,modelGrant:null,evidenceRetentionDays:14}));
    store=new EventStore(file,true);const draft=approved(store);
    const intent=store.recordIntent(draft,snapshot(candidate()),false);
    store.db.prepare('INSERT INTO model_calls VALUES(?,?,?,?,?,?,?)').run('local-call','deepseek-chat','FAILED',null,null,400,null);
    const inventory=()=>digest(['send_intents','delivery_receipts','budgets','audit_events'].map(table=>store!.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
    const before=inventory();
    // Existing synthetic references have no corresponding evidence file; use UUID references for this fixture.
    const referenced=await recordEvidence(join(root,'evidence'),{caseId:'H01',browserVersion:'156.0.4314.58',mode:'headless',
      taskId:null,action:'OBSERVE',result:'UNVERIFIED',source:'LOCAL_FIXTURE',diagnostics:['SYNTHETIC'],proofDigest:null});
    store.db.prepare('UPDATE observations SET evidence_ref=?').run(referenced);
    const payload=JSON.parse((store.db.prepare('SELECT payload FROM inbound_events').get() as {payload:string}).payload);payload.evidenceId=referenced;
    store.db.prepare('UPDATE inbound_events SET payload=?').run(JSON.stringify(payload));
    const free=await recordEvidence(join(root,'evidence'),{caseId:'H01',browserVersion:'156.0.4314.58',mode:'headless',
      taskId:null,action:'OBSERVE',result:'UNVERIFIED',source:'LOCAL_FIXTURE',diagnostics:['SYNTHETIC'],proofDigest:null});
    const freePath=join(root,'evidence',free+'.json'),metadata=JSON.parse(await readFile(freePath,'utf8'));metadata.time='2020-01-01T00:00:00Z';
    await writeFile(freePath,JSON.stringify(metadata));
    const run=(args:string[])=>{
      const result=spawnSync(process.execPath,['--import','tsx',resolve('src/cli.ts'),...args,'--runtime',root],
        {encoding:'utf8',timeout:15000,windowsHide:true});
      expect(result.stderr).toBe('');expect(result.status,result.stdout).toBe(0);return JSON.parse(result.stdout);
    };
    expect(run(['diagnostics']).model.total).toMatchObject({requests:1,unknownUsageRequests:1});
    expect(run(['prune-evidence','--dry-run'])).toMatchObject({eligible:{files:1},deleted:{files:0}});
    expect(run(['prune-evidence'])).toMatchObject({deleted:{files:1}});
    expect(inventory()).toBe(before);
    expect(store.db.prepare('SELECT status FROM send_intents WHERE id=?').get(intent)).toEqual({status:'INTENT_RECORDED'});
  }finally{store?.close();await rm(root,{recursive:true,force:true});}
});
