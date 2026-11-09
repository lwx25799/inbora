import {performance} from 'node:perf_hooks';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import Database from 'better-sqlite3';
import {EventStore} from '../src/storage/store.js';
import {eventBinding,targetKey,digest,type InboundEvent} from '../src/core/contracts.js';
import {ClientService} from '../src/app/service.js';
import {BrowserService} from '../src/app/browser-service.js';
import {migrateClient} from '../src/storage/client-migration.js';

const parent=resolve('.local/tests');mkdirSync(parent,{recursive:true});
const fixture=mkdtempSync(join(parent,'query-benchmark-'));
const large=process.argv.includes('--large'),runs=20;
const results:Record<string,unknown>[]=[];

async function measure(mixed:boolean):Promise<void>{
  const root=join(fixture,mixed?'mixed':'sparse');mkdirSync(root,{recursive:true});
  let executions=0,selects=0;
  const file=join(root,'synthetic.sqlite'),store=new EventStore(file,true);
  store.close();
  // SQLite's trace also counts cached BEGIN/COMMIT, exec and pragma statements, not prepare calls.
  Object.defineProperty(store,'db',{value:new Database(file,{verbose:sql=>{executions++;if(/^\s*(SELECT|WITH)\b/iu.test(sql))selects++;}})});
  store.db.pragma('journal_mode = WAL');store.db.pragma('synchronous = FULL');store.db.pragma('foreign_keys = ON');store.db.pragma('busy_timeout = 3000');
  await migrateClient(store,join(root,'client-backup.sqlite'));
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();
  const token=service.authority.issueSession();store.bindAccount('own-synthetic');
  // Performance fixtures must not schedule unrelated browser verification for their synthetic unknown intents.
  store.db.prepare('UPDATE automation_state SET emergency_stopped=1 WHERE id=1').run();
  // Exercise the old slow status-capability fallback, not merely DRAFT_ONLY's short circuit.
  store.db.prepare("UPDATE client_state SET mode='MANUAL'").run();
  const insert=store.db.prepare('INSERT INTO inbound_events VALUES(?,?,?,?,?,?,?,?,?)');
  const append=store.db.transaction((start:number,end:number)=>{for(let i=start;i<end;i++){
    const event:InboundEvent={accountId:'account_001',channel:'DIRECT_MESSAGE',platformEventId:'synthetic-message-'+i,
      actorId:'synthetic-peer-'+Math.floor(i/10),actorName:'Synthetic peer',text:'synthetic message '+i,
      occurredAt:new Date(Date.UTC(2026,10,1)+i*1000).toISOString(),videoId:null,commentId:null,
      conversationId:'synthetic-conversation-'+Math.floor(i/10),direction:'INCOMING',kind:'DM',evidenceId:'synthetic-only'};
    const id=randomUUID(),binding=eventBinding(event),status=mixed&&i%10===0?'UNCERTAIN':'AWAITING_DRAFT';
    insert.run(id,event.accountId,event.channel,event.platformEventId,event.conversationId,targetKey(event),binding,JSON.stringify(event),status);
    if(!mixed)continue;
    if(i%10===0){
      const draft=randomUUID(),intent=randomUUID(),text='Synthetic approved reply '+i;
      const snapshot={accountId:event.accountId,ownId:'own-synthetic',targetKey:targetKey(event),eventBinding:binding,
        contextDigest:'synthetic-context',composerKey:targetKey(event),mappingDigest:'synthetic-mapping'};
      const approval={snapshot,version:1,textDigest:digest(text)};
      store.db.prepare("INSERT INTO reply_drafts VALUES(?,?,?,?,1,'APPROVED',?,NULL)").run(draft,id,text,'mock',JSON.stringify(approval));
      store.db.prepare("INSERT INTO send_intents VALUES(?,?,?,?,?,?,'UNCERTAIN',?)")
        .run(intent,id,draft,targetKey(event),digest(snapshot),digest(text),new Date(Date.parse(event.occurredAt!)+500).toISOString());
      store.db.prepare("INSERT INTO delivery_receipts VALUES(?,?,'UNCERTAIN','synthetic-proof',?)").run(randomUUID(),intent,event.occurredAt);
      store.db.prepare('INSERT INTO verification_results VALUES(?,?,?,?,?)').run(randomUUID(),intent,1,'synthetic-verification',i);
      if(i%20===0)store.db.prepare('INSERT INTO verification_results VALUES(?,?,?,?,?)').run(randomUUID(),intent,0,'synthetic-latest-negative',i-1);
    }else if(i%10===1){
      const draft=randomUUID(),text='Synthetic saved draft '+i;
      store.db.prepare("INSERT INTO reply_drafts VALUES(?,?,?,?,1,'DRAFT',NULL,NULL)").run(draft,id,text,'human');
      store.db.prepare("INSERT INTO draft_revisions VALUES(?,1,'HUMAN_TYPED',?,'synthetic-operator',?)").run(draft,text,i);
    }
    if(i%37===0)store.db.prepare('INSERT INTO source_collisions VALUES(?,?,?,?,?)').run(randomUUID(),id,'synthetic-collision',JSON.stringify(event),'synthetic-evidence');
    store.db.prepare('INSERT INTO observations VALUES(?,?,?,?,?,?)').run(randomUUID(),event.channel,event.conversationId,
      event.occurredAt,1,'synthetic-only');
  }});
  const prepare=store.db.prepare.bind(store.db);
  try{
    let previous=0;
    for(const size of large?[100,1000,10000,100000]:[100,1000,10000]){
      append(previous,size);previous=size;
      const eventId=(prepare('SELECT id FROM inbound_events ORDER BY rowid DESC LIMIT 1').get() as {id:string}).id;
      for(const command of [{command:'getInbox',channel:'DIRECT_MESSAGE',status:'ALL',page:0},{command:'getStatus'},
        {command:'getThread',eventId}] as const){
        process.stderr.write(`Benchmark ${mixed?'mixed':'sparse'} ${size} ${command.command}\n`);
        const firstStarted=performance.now();await service.dispatch(token,command);const firstMs=performance.now()-firstStarted;
        const samples:number[]=[],counts:number[]=[],selectCounts:number[]=[];
        const before=process.memoryUsage();
        for(let run=0;run<runs;run++){
          executions=0;selects=0;const started=performance.now();await service.dispatch(token,command);
          samples.push(performance.now()-started);counts.push(executions);selectCounts.push(selects);
        }
        samples.sort((a,b)=>a-b);const after=process.memoryUsage();
        results.push({fixture:mixed?'mixed':'sparse',events:size,groups:size/10,command:command.command,runs,
          firstMs:Number(firstMs.toFixed(2)),medianMs:Number(samples[Math.floor(runs/2)]!.toFixed(2)),p95Ms:Number(samples[Math.ceil(runs*0.95)-1]!.toFixed(2)),
          sqlExecutionsMin:Math.min(...counts),sqlExecutionsMax:Math.max(...counts),
          sqlSelectsMin:Math.min(...selectCounts),sqlSelectsMax:Math.max(...selectCounts),
          heapDeltaBytes:after.heapUsed-before.heapUsed,rssDeltaBytes:after.rss-before.rss});
      }
    }
  }finally{await service.close();store.close();}
}
await measure(false);await measure(true);
process.stdout.write(JSON.stringify({runtime:process.version,fixture:'SYNTHETIC_ONLY',runs,results,
  artifactDirectory:fixture,sqlCounting:'SQLite verbose trace including transaction control, not prepare calls',
  limits:'No browser/model/send. Heap/RSS are before-after samples, not peak memory. Sparse mirrors the prior input; mixed adds drafts/intents/receipts/proofs/collisions.'},null,2)+'\n');
