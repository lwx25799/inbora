import {expect,test} from 'vitest';
import {join} from 'node:path';
import {eventBinding,targetKey} from '../../src/core/contracts.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {InboxCollector} from '../../src/app/inbox-collector.js';
import type {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import type {ObservationBatch} from '../../src/adapters/observed-reader.js';
import {observedMapping} from '../fixtures/observed-site.js';
import {qualifyLateArrivals} from '../../src/app/late-arrival-qualification.js';
import {candidate,database,privateTemp} from '../helpers.js';

async function setup(){
  const store=database(),root=privateTemp('late-arrival-');await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  let now=Date.UTC(2026,10,9,12),origin=now-60_000;const data=new AutomationStore(store,()=>now);data.initialize(origin);store.bindAccount('own-1');
  data.configureCollection({ownId:'own-1',comments:true,inbox:true,commentIntervalMs:15_000,dmIntervalMs:15_000});
  const event=candidate({channel:'COMMENT_NOTIFICATION',kind:'REPLY',platformEventId:'21',videoId:'10',commentId:'21',rootCommentId:'11',replyToCommentId:'21',
    conversationId:null,occurredAt:new Date(origin+1000).toISOString(),occurredAtPrecisionMs:1000});
  store.db.prepare('INSERT INTO collection_targets VALUES(?,?,?,?,?,?,?)').run(targetKey(event),'own-1',event.actorId,'synthetic-sec','Synthetic',null,now);
  store.observe(event.channel,'work:10',[{...event,kind:'COMMENT',platformEventId:'99',commentId:'99',rootCommentId:undefined,replyToCommentId:undefined,
    occurredAt:new Date(origin+40_000).toISOString()}],'own-1','newer-first',new Date(now).toISOString(),origin);
  const read=(evidence:string,change={})=>{
    const current={...event,...change,evidenceId:evidence};store.observe(current.channel,'work:10',[current],'own-1',evidence,new Date(now).toISOString(),origin);
    const input={source:'works' as const,scope:'work:10',ownId:'own-1',workIds:['10'],events:[current],evidence,signal:new AbortController().signal};
    qualifyLateArrivals(data,input);return store.events().find(row=>row.payload.platformEventId==='21')!;
  };
  return{store,data,event,origin,root,read,now:()=>now,tick:(ms=1000)=>{now+=ms;},close:()=>store.close()};
}

test('the real collector persistence path promotes two fresh exact observations and keeps legacy observe unchanged',async()=>{
  const f=await setup(),mapping=observedMapping('http://127.0.0.1:1');mapping.self={uid:'own-1',secUid:'own-sec'};
  const owner={notification:{on(){},off(){}},version:()=> '1.2.3.4'} as unknown as BrowserProfileOwner;
  const collector=new InboxCollector(owner,mapping,f.data,f.root,'headless');
  const persist=collector as unknown as {persist(source:'works',scope:string,batch:ObservationBatch,signal:AbortSignal):Promise<void>};
  const batch:ObservationBatch={events:[f.event],evidenceId:'synthetic',loaded:1,unsupported:0,
    bindings:[{targetKey:targetKey(f.event),uid:f.event.actorId!,secUid:'synthetic-sec',title:'Synthetic',conversationId:null}]};
  try{
    await persist.persist('works','work:10',batch,new AbortController().signal);let event=f.store.events().find(row=>row.payload.platformEventId==='21')!;
    expect(event.status).toBe('MANUAL_REVIEW');f.tick();
    await persist.persist('works','work:10',batch,new AbortController().signal);event=f.store.event(event.id);expect(event.status).toBe('AWAITING_DRAFT');
    expect(f.store.budgets().map(b=>b.used)).toEqual([0,0]);expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{collector.dispose();f.close();}
});

test('ordinary PoC observe alone keeps the old conservative late-arrival status',async()=>{
  const f=await setup();try{
    for(let index=0;index<3;index++){
      f.store.observe(f.event.channel,'work:10',[f.event],'own-1','ordinary-'+index,new Date(f.now()).toISOString(),f.origin);f.tick();
    }
    expect(f.store.events().find(row=>row.payload.platformEventId==='21')?.status).toBe('MANUAL_REVIEW');
    expect(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type LIKE 'LATE_ARRIVAL_%'").get()).toEqual({n:0});
  }finally{f.close();}
});

test('a late DM requires the currently enabled own inbox and exact persisted conversation identity',async()=>{
  const f=await setup();try{
    const event=candidate({occurredAt:new Date(f.origin+1000).toISOString(),platformEventId:'7101'}),scope=event.conversationId!;
    f.store.db.prepare('INSERT INTO discovered_conversations VALUES(?,?,?,?,?,?,?,0)').run(scope,'own-1',event.actorId,'dm-sec','Synthetic',f.now(),f.now());
    f.store.db.prepare('INSERT INTO collection_targets VALUES(?,?,?,?,?,?,?)').run(targetKey(event),'own-1',event.actorId,'dm-sec','Synthetic',scope,f.now());
    f.store.observe('DIRECT_MESSAGE',scope,[{...event,platformEventId:'7109',occurredAt:new Date(f.origin+40_000).toISOString()}],'own-1','newer-dm',new Date(f.now()).toISOString(),f.origin);
    const read=(evidence:string)=>{
      f.store.observe('DIRECT_MESSAGE',scope,[event],'own-1',evidence,new Date(f.now()).toISOString(),f.origin);
      qualifyLateArrivals(new AutomationStore(f.store,f.now),{source:'dm',scope,ownId:'own-1',workIds:[],events:[event],evidence,signal:new AbortController().signal});
    };
    read('dm-first');const saved=f.store.events().find(row=>row.payload.platformEventId==='7101')!;expect(saved.status).toBe('MANUAL_REVIEW');
    f.tick();read('dm-second');expect(f.store.event(saved.id).status).toBe('AWAITING_DRAFT');
    expect(f.store.budgets().map(b=>b.used)).toEqual([0,0]);
  }finally{f.close();}
});

test('two distinct stable collector observations qualify a post-origin hidden child without changing baseline, watermarks or budgets',async()=>{
  const f=await setup();try{
    const first=f.read('first');expect(first.status).toBe('MANUAL_REVIEW');const cursor=f.store.db.prepare('SELECT * FROM cursors').all();
    f.tick();const second=f.read('second');expect(second.status).toBe('AWAITING_DRAFT');expect(second.id).toBe(first.id);expect(second.binding).toBe(eventBinding(f.event));
    expect(f.store.db.prepare('SELECT * FROM cursors').all().map(row=>(row as {cursor_data:string}).cursor_data)).toEqual(cursor.map(row=>(row as {cursor_data:string}).cursor_data));
    f.tick();expect(f.read('third').status).toBe('AWAITING_DRAFT');
    expect(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='LATE_ARRIVAL_QUALIFIED'").get()).toEqual({n:1});
    expect(f.store.budgets().map(b=>b.used)).toEqual([0,0]);expect(f.data.state().startedAt).toBe(f.origin);
    expect(f.store.db.prepare('SELECT count(*) n FROM model_calls').get()).toEqual({n:0});expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
    expect(JSON.stringify(f.store.db.prepare("SELECT entity_id,detail_redacted FROM audit_events WHERE event_type LIKE 'LATE_ARRIVAL_%'").all())).not.toMatch(/hello|"first"|"second"|synthetic-sec|work:10|"21"/u);
  }finally{f.close();}
});

test.each(['SAME_EVIDENCE','TOO_SOON','BEFORE_ORIGIN','OVERLAP','MISSING_TIME','FUTURE','WEAK','COLLISION','DRAFT','INTENT','JOB','ACCOUNT','TARGET','DISABLED','CANCELLED','LATER_BASELINE','BASELINE_STATUS','SCOPE'] as const)
  ('late qualification preserves review or baseline for %s',async fault=>{
  const f=await setup();try{
    const change=fault==='BEFORE_ORIGIN'?{occurredAt:new Date(f.origin-1000).toISOString()}:fault==='OVERLAP'?{occurredAt:new Date(f.origin).toISOString()}:
      fault==='MISSING_TIME'?{occurredAt:null}:fault==='FUTURE'?{occurredAt:new Date(f.now()+10_000).toISOString()}:
      fault==='WEAK'?{observationIssue:'COMMENT_TEXT_UNVERIFIED' as const}:{};
    if(fault==='FUTURE')f.store.db.prepare('UPDATE cursors SET cursor_data=?').run(JSON.stringify({baselineTime:f.origin,highWater:f.now()+20_000,bindings:[]}));
    const first=f.read('first',change);f.tick(fault==='TOO_SOON'?999:1000);
    if(fault==='COLLISION')f.store.db.prepare('INSERT INTO source_collisions VALUES(?,?,?,?,?)').run('synthetic-collision',first.id,'other','{}','synthetic');
    if(fault==='DRAFT'||fault==='INTENT')f.store.db.prepare("INSERT INTO reply_drafts VALUES(?,?,?,'HUMAN_TYPED',1,'DRAFT',NULL,NULL)").run('kept-draft',first.id,'Preserve human draft');
    if(fault==='INTENT')f.store.db.prepare('INSERT INTO send_intents VALUES(?,?,?,?,?,?,?,?)').run('old-intent',first.id,'kept-draft',targetKey(first.payload),'old','old','UNCERTAIN','2026-11-09T00:00:00Z');
    if(fault==='JOB')f.store.db.prepare('INSERT INTO automation_jobs VALUES(?,?,?, ?,0,0,NULL,NULL,0,0)').run(first.id,1,'REVIEW','old');
    if(fault==='ACCOUNT')f.store.db.prepare("UPDATE accounts SET own_id='outside'").run();
    if(fault==='TARGET')f.store.db.prepare("UPDATE collection_targets SET uid='outside'").run();
    if(fault==='BASELINE_STATUS')f.store.db.prepare("UPDATE inbound_events SET status='BASELINE' WHERE id=?").run(first.id);
    if(fault==='DISABLED')f.data.configureCollection({ownId:'own-1',comments:false,inbox:true,commentIntervalMs:15_000,dmIntervalMs:15_000});
    if(fault==='LATER_BASELINE')f.store.db.prepare('UPDATE cursors SET cursor_data=?').run(JSON.stringify({baselineTime:f.origin+2000,highWater:f.now(),bindings:[]}));
    const signal=new AbortController();if(fault==='CANCELLED')signal.abort();
    const evidence=fault==='SAME_EVIDENCE'?'first':'second',current={...f.event,...change,evidenceId:evidence};
    if(fault!=='ACCOUNT')f.store.observe(current.channel,'work:10',[current],'own-1',evidence,new Date(f.now()).toISOString(),f.origin);
    qualifyLateArrivals(f.data,{source:'works',scope:fault==='SCOPE'?'work:20':'work:10',ownId:'own-1',workIds:['10'],events:[current],evidence,signal:signal.signal});
    expect(f.store.event(first.id).status).not.toBe('AWAITING_DRAFT');expect(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='LATE_ARRIVAL_QUALIFIED'").get()).toEqual({n:0});
    expect(f.store.budgets().map(b=>b.used)).toEqual([0,0]);
  }finally{f.close();}
});
