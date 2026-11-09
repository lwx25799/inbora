import Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {expect,test} from 'vitest';
import {EvidenceMaintenance} from '../../src/app/evidence-maintenance.js';
import {ClientService} from '../../src/app/service.js';
import {recordEvidence} from '../../src/observability/evidence.js';
import {maintainEvidence} from '../../src/observability/evidence.js';
import {privateTemp} from '../helpers.js';

const input={caseId:'H01' as const,browserVersion:'156.0.4314.58',mode:'headless' as const,taskId:null,
  action:'OBSERVE' as const,result:'UNVERIFIED' as const,source:'LOCAL_FIXTURE' as const,diagnostics:['SYNTHETIC'],proofDigest:null};
const now=Date.parse('2026-11-10T00:00:00Z');
async function fixture(){
  const root=privateTemp('evidence-maintenance-'),directory=join(root,'evidence'),db=new Database(':memory:');
  await writeFile(join(root,'runtime.json'),JSON.stringify({version:1,modelGrant:null,evidenceRetentionDays:14}));
  db.exec(`CREATE TABLE observations(evidence_ref TEXT);CREATE TABLE inbound_events(payload TEXT);
    CREATE TABLE source_collisions(evidence_ref TEXT,payload TEXT);CREATE TABLE delivery_receipts(proof_ref TEXT);
    CREATE TABLE audit_events(entity_id TEXT,detail_redacted TEXT);CREATE TABLE verification_results(evidence_ref TEXT);
    CREATE TABLE channel_capabilities(evidence_ref TEXT);CREATE TABLE controlled_trials(evidence_ref TEXT);
    CREATE TABLE chat_messages(payload TEXT);`);
  const maintenance=new EvidenceMaintenance({db},root,{now:()=>now});
  const old=async()=>{
    const id=await recordEvidence(directory,input),file=join(directory,id+'.json'),value=JSON.parse(await readFile(file,'utf8'));
    value.time='2020-01-01T00:00:00Z';await writeFile(file,JSON.stringify(value));return id;
  };
  return {root,directory,db,maintenance,old,close:async()=>{await maintenance.close();db.close();await rm(root,{recursive:true,force:true});}};
}

test('the same retention module protects every persistent UUID evidence source and reports actual deletion bytes',async()=>{
  const f=await fixture();
  try{
    const ids=await Promise.all(Array.from({length:10},()=>f.old())),unreferenced=ids[9]!;
    f.db.prepare('INSERT INTO observations VALUES(?)').run(ids[0]);
    f.db.prepare('INSERT INTO inbound_events VALUES(?)').run(JSON.stringify({evidenceId:ids[1]}));
    f.db.prepare('INSERT INTO source_collisions VALUES(?,?)').run(ids[2],JSON.stringify({evidenceId:ids[3]}));
    f.db.prepare('INSERT INTO delivery_receipts VALUES(?)').run(ids[4]);
    f.db.prepare('INSERT INTO verification_results VALUES(?)').run(ids[5]);
    f.db.prepare('INSERT INTO channel_capabilities VALUES(?)').run(ids[6]);
    f.db.prepare('INSERT INTO controlled_trials VALUES(?)').run(ids[7]);
    f.db.prepare('INSERT INTO audit_events VALUES(?,?)').run('local',JSON.stringify({proofRef:ids[8]}));
    const bytes=Buffer.byteLength(await readFile(join(f.directory,unreferenced+'.json')));
    const before=await f.maintenance.report();
    expect(before).toMatchObject({scope:'EVIDENCE_METADATA',retentionDays:14,referencesComplete:true,recognized:{files:10},protected:{files:9},eligible:{files:1,bytes},deleted:{files:0,bytes:0}});
    const after=await f.maintenance.prune();
    expect(after.deleted).toEqual({files:1,bytes});
    expect(f.maintenance.status().nextAt).toBe(now+24*3600_000);
    await expect(readFile(join(f.directory,unreferenced+'.json'))).rejects.toMatchObject({code:'ENOENT'});
    for(const id of ids.slice(0,9))expect(await readFile(join(f.directory,id+'.json'),'utf8')).toContain(id);
  }finally{await f.close();}
});

test('chat payloads, nested mapping references and audit UUID values remain protected with all-reference zero-release',async()=>{
  const f=await fixture();
  try{
    const [chat,mapping,audit]=await Promise.all([f.old(),f.old(),f.old()]);
    f.db.prepare('INSERT INTO chat_messages VALUES(?)').run(JSON.stringify({evidenceId:chat}));
    await writeFile(join(f.root,'dm-reply-mapping.json'),JSON.stringify({observation:{evidenceRef:mapping}}));
    f.db.prepare('INSERT INTO audit_events VALUES(?,?)').run('local',JSON.stringify({metadata:{previousEvidence:audit}}));
    expect(await f.maintenance.prune()).toMatchObject({referencesComplete:true,protected:{files:3},eligible:{files:0},deleted:{files:0,bytes:0}});
  }finally{await f.close();}
});

test.each(['{broken','{}','null','{"evidenceId":"unmapped-reference"}'])(
  'an unclear persisted payload %s prevents evidence deletion',async payload=>{
    const f=await fixture();
    try{
      await f.old();f.db.prepare('INSERT INTO inbound_events VALUES(?)').run(payload);
      expect(await f.maintenance.prune()).toMatchObject({referencesComplete:false,eligible:{files:0},deleted:{files:0}});
    }finally{await f.close();}
  },
);

test('retention refreshes references after inspection and protects a newly referenced record',async()=>{
  const f=await fixture();
  try{
    const id=await f.old();
    const report=await maintainEvidence(f.directory,14,{now,protection:{ids:new Set(),complete:true,unknownReferences:0},
      refreshProtection:()=>({ids:new Set([id]),complete:true,unknownReferences:0})});
    expect(report).toMatchObject({protected:{files:1},eligible:{files:0},remainingEligible:{files:0},deleted:{files:0}});
    expect(await readFile(join(f.directory,id+'.json'),'utf8')).toContain(id);
  }finally{await f.close();}
});

test('idle loss cancels a running scan before any deletion',async()=>{
  const f=await fixture();
  try{
    await f.old();const active=f.maintenance.prune();
    expect(await f.maintenance.runIfDue(false)).toBeNull();
    expect(await active).toMatchObject({cancelled:true,deleted:{files:0}});
    expect(f.maintenance.status().nextAt).toBe(now);
    expect(await f.maintenance.runIfDue(true)).toMatchObject({cancelled:false,deleted:{files:1}});
    expect(f.maintenance.status().nextAt).toBe(now+24*3600_000);
  }finally{await f.close();}
});

test.each([false,true])('a no-op automatic turn leaves an idle maintenance scan running (saved policy: %s)',async savedPolicy=>{
  const f=await fixture();
  try{
    await f.old();const active=f.maintenance.prune();
    const idleService={closing:false,key:'synthetic-key',modelPending:new Set(),maintenance:f.maintenance,
      browser:{loginRecovery:false},settings:{model:'deepseek-chat'},automaticAbort:new AbortController(),modelAbort:new AbortController(),
      store:{db:{prepare:()=>({all:()=>[]})},firstAutomaticCandidate:()=>undefined},
      automation:{active:()=>savedPolicy?{version:1,scope:{model:'deepseek-chat',channels:['DIRECT_MESSAGE']}}:null,allowance:()=>true}};
    await ClientService.prototype.runAutomaticReply.call(idleService as unknown as ClientService);
    expect(await active).toMatchObject({cancelled:false,deleted:{files:1}});
  }finally{await f.close();}
});

test('unknown references, malformed JSON, filename mismatches and links are retained instead of guessed',async()=>{
  const f=await fixture();
  try{
    const id=await f.old(),mismatch=await f.old(),target=join(f.root,'external.json'),link=join(f.directory,randomUUID()+'.json');
    await writeFile(join(f.directory,'keep.txt'),'user data');
    await mkdir(join(f.directory,'unknown-directory'));
    const value=JSON.parse(await readFile(join(f.directory,mismatch+'.json'),'utf8'));value.id=randomUUID();
    await writeFile(join(f.directory,mismatch+'.json'),JSON.stringify(value));
    await writeFile(target,JSON.stringify(value));await symlink(target,link,'file');
    f.db.prepare('INSERT INTO inbound_events VALUES(?)').run('{malformed');
    const report=await f.maintenance.prune();
    expect(report.referencesComplete).toBe(false);expect(report.unknownReferences).toBeGreaterThan(0);
    expect(report.deleted.files).toBe(0);expect(report.unknown.files).toBe(4);
    expect(await readFile(join(f.directory,id+'.json'),'utf8')).toContain(id);
    expect(await readFile(target,'utf8')).toContain(value.id);
  }finally{await f.close();}
});

test('retention is bounded to one hundred files, cancellable, idle-only and coalesced',async()=>{
  const f=await fixture();
  try{
    await Promise.all(Array.from({length:102},()=>f.old()));
    const stopped=new AbortController();stopped.abort();
    expect((await f.maintenance.prune(stopped.signal)).deleted.files).toBe(0);
    expect(await f.maintenance.runIfDue(false)).toBeNull();
    const [first,coalesced]=await Promise.all([f.maintenance.prune(),f.maintenance.prune()]);
    expect(first.deleted.files).toBe(100);expect(coalesced).toBe(first);expect(first.remainingEligible.files).toBe(2);
    const second=await f.maintenance.prune();expect(second.deleted.files).toBe(2);
    expect(await f.maintenance.runIfDue(true)).toBeNull();
    await f.maintenance.close();expect(await f.maintenance.runIfDue(true)).toBeNull();
  }finally{await f.close();}
});
