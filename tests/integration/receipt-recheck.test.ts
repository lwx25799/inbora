import {expect,test} from 'vitest';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {migrateFollowups} from '../../src/storage/followup-migration.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {ChatMessageStore} from '../../src/storage/chat-messages.js';
import {VerificationScheduler} from '../../src/app/verification-scheduler.js';
import {receiptRecheckVersion} from '../../src/app/receipt-recheck.js';
import {Blocked,digest,eventBinding} from '../../src/core/contracts.js';
import {candidate,database,pending,privateTemp,snapshot} from '../helpers.js';

async function fixture(kind:'DM'|'REPLY'|'COMMENT'='DM') {
  const store=database(),root=privateTemp('receipt-recheck-');
  await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  await migrateFollowups(store,join(root,'followups.sqlite'));
  const now=Date.now()+10_000,data=new AutomationStore(store,()=>now);data.initialize(now-10_000);
  const add=(index:number,currentKind=kind)=>{
    const payload=candidate({...currentKind==='DM'?{platformEventId:String(100+index),conversationId:'conversation-'+index}:
      {channel:'COMMENT_NOTIFICATION',kind:currentKind,videoId:'10',commentId:String(100+index),platformEventId:String(100+index),
        ...(currentKind==='REPLY'?{rootCommentId:'11',replyToCommentId:String(100+index)}:{}),conversationId:null},
      occurredAt:new Date(Date.parse('2026-11-04T01:00:00Z')+index*1000).toISOString()});
    const eventId=pending(store,payload),draftId=randomUUID(),text='synthetic reply '+index;
    store.db.prepare("INSERT INTO reply_drafts VALUES(?,?,?,'mock',1,'DRAFT',NULL,NULL)").run(draftId,eventId,text);
    store.db.prepare("UPDATE inbound_events SET status='AWAITING_APPROVAL' WHERE id=?").run(eventId);
    const proof={...snapshot(payload),contextDigest:'b'.repeat(64)};
    store.approve(draftId,proof,1,text);
    const intentId=store.recordIntent(draftId,proof,false,{check:()=>{},committed:()=>{}});
    store.receipt(intentId,'UNCERTAIN',currentKind==='DM'?'POST_INTENT_FAILURE:READBACK:UNCLASSIFIED':'NO_UNIQUE_BOUND_PROOF');
    const boundary=store.intentBoundary(intentId),nativeId=String(9000+index);
    const chatPayload=candidate({conversationId:payload.conversationId,platformEventId:nativeId,direction:'OUTGOING',actorId:'own-1',text,
      occurredAt:new Date(Date.parse(boundary)-949).toISOString()});
    if(currentKind==='DM')new ChatMessageStore(store).observe([chatPayload],'own-1',Date.parse(boundary)-1000,now);
    store.db.prepare('INSERT INTO verification_jobs VALUES(?,?,?,?,2,?,?,?,?)').run(intentId,eventId,boundary,digest(proof),now-100,now-1,'REVIEW',
      currentKind==='DM'?'OBSERVATION_DM_CONTENT_DOM_NOT_READY':'NO_COMPLETE_PROOF');
    return {eventId,draftId,intentId,payload,chatPayload,boundary,nativeId,text};
  };
  const item=add(1),ledger=()=>({intents:store.db.prepare('SELECT * FROM send_intents ORDER BY id').all(),
    receipts:store.db.prepare('SELECT * FROM delivery_receipts ORDER BY id').all(),jobs:store.db.prepare('SELECT * FROM verification_jobs ORDER BY intent_id').all(),
    budgets:store.budgets(),pauses:store.db.prepare('SELECT * FROM pauses ORDER BY target_key').all()});
  return {store,data,now,item,add,ledger};
}

test.each(['DM','REPLY','COMMENT'] as const)('fixed readback rechecks each %s intent once and preserves the original ledger',async kind=>{
  const f=await fixture(kind);let worker:VerificationScheduler|undefined;
  try {
    const second=f.add(2),before=f.ledger(),seen:string[]=[];
    f.store.audit('DM_CONTEXT_WINDOW_CHECKED',f.item.intentId);
    const check=async(eventId:string)=>{seen.push(eventId);return {verified:true,evidenceId:'synthetic-proof',
      nativeIdDigest:digest(eventId===f.item.eventId?f.item.nativeId:second.nativeId)};};
    worker=new VerificationScheduler(f.data,check);await worker.tick();await worker.tick();await worker.close();
    worker=new VerificationScheduler(f.data,check);worker.start();await worker.tick();
    expect(new Set(seen)).toEqual(new Set([f.item.eventId,second.eventId]));expect(seen).toHaveLength(2);
    expect(f.store.db.prepare('SELECT verified FROM verification_results').all()).toEqual([{verified:1},{verified:1}]);
    expect(f.ledger()).toEqual(before);
    expect(f.store.db.prepare('SELECT count(*) n FROM audit_events WHERE event_type=?').get(receiptRecheckVersion+'_CLAIMED')).toEqual({n:2});
  } finally {await worker?.close();f.store.close();}
});

test('a normal pending job runs before the repair queue and a repair cannot consume a send or model',async()=>{
  const f=await fixture();let worker:VerificationScheduler|undefined;
  try {
    const normal=f.add(2);f.store.db.prepare("UPDATE verification_jobs SET state='PENDING',attempts=0,deadline=? WHERE intent_id=?")
      .run(f.now+120_000,normal.intentId);
    const calls:string[]=[],budgets=f.store.budgets();
    worker=new VerificationScheduler(f.data,async eventId=>{calls.push(eventId);return {verified:true,evidenceId:'synthetic',
      nativeIdDigest:digest(eventId===normal.eventId?normal.nativeId:f.item.nativeId)};});
    await worker.tick();expect(calls).toEqual([normal.eventId]);await worker.tick();expect(calls).toEqual([normal.eventId,f.item.eventId]);
    expect(f.store.budgets()).toEqual(budgets);
  } finally {await worker?.close();f.store.close();}
});

test.each(['ACCOUNT','BINDING','VERSION','TEXT','TARGET','COLLISION','SUCCESS','CONTRADICTION','ACTIVE_TURN','RECEIPT','JOB_STATE'] as const)
  ('repair cannot claim inconsistent or already proven records: %s',async fault=>{
  const f=await fixture('REPLY');let worker:VerificationScheduler|undefined;
  try {
    const {store,item}=f;
    if(fault==='ACCOUNT')store.db.prepare("UPDATE accounts SET own_id='other-own'").run();
    if(fault==='BINDING')store.db.prepare("UPDATE inbound_events SET binding='wrong'").run();
    if(fault==='VERSION')store.db.prepare('UPDATE reply_drafts SET version=2').run();
    if(fault==='TEXT')store.db.prepare("UPDATE reply_drafts SET text='changed'").run();
    if(fault==='TARGET')store.db.prepare("UPDATE send_intents SET target_key='comment:outside'").run();
    if(fault==='COLLISION')store.db.prepare('INSERT INTO source_collisions VALUES(?,?,?,?,?)').run(randomUUID(),item.eventId,'other','{}','synthetic');
    if(fault==='SUCCESS'||fault==='CONTRADICTION'){
      store.db.prepare('INSERT INTO verification_results VALUES(?,?,1,?,?)').run(randomUUID(),item.intentId,'prior-success',f.now-2);
      if(fault==='CONTRADICTION')store.db.prepare('INSERT INTO verification_results VALUES(?,?,0,?,?)').run(randomUUID(),item.intentId,'later-conflict',f.now-1);
    }
    if(fault==='ACTIVE_TURN')store.db.prepare(`INSERT INTO human_reply_turns VALUES(?,?,?,'human','input','{}','synthetic',1,'UNCERTAIN',NULL,'other-intent',?,NULL,NULL,NULL,NULL,?)`)
      .run(randomUUID(),item.eventId,'comment:10:101',item.boundary,f.now);
    if(fault==='RECEIPT')store.db.prepare("UPDATE delivery_receipts SET proof_ref='POST_INTENT_FAILURE:DISPATCH:UNCLASSIFIED'").run();
    if(fault==='JOB_STATE')store.db.prepare("UPDATE verification_jobs SET state='VERIFIED'").run();
    const before=f.ledger();let calls=0;
    worker=new VerificationScheduler(f.data,async()=>{calls++;return{verified:true,evidenceId:'must-not-run'};});await worker.tick();
    expect(calls).toBe(0);expect(f.ledger()).toEqual(before);
    expect(store.db.prepare('SELECT count(*) n FROM audit_events WHERE event_type=?').get(receiptRecheckVersion+'_CLAIMED')).toEqual({n:0});
  } finally {await worker?.close();f.store.close();}
});

test.each(['DUPLICATE','OTHER_CONVERSATION','WEAK','CONFLICT','NOT_LATEST_INCOMING','NOT_LATEST_OUTGOING','TOO_OLD','TOO_LATE'] as const)
  ('observed own text is only a qualification and cannot claim an unsuitable DM: %s',async fault=>{
  const f=await fixture();let worker:VerificationScheduler|undefined;
  try {
    const {store,item}=f,chat=new ChatMessageStore(store);
    if(fault==='DUPLICATE')chat.observe([{...item.chatPayload,platformEventId:'9999'}],'own-1',Date.parse(item.boundary)-1000,f.now);
    if(fault==='OTHER_CONVERSATION')store.db.prepare("UPDATE chat_messages SET conversation_id='outside'").run();
    if(fault==='CONFLICT')store.db.prepare('UPDATE chat_messages SET conflicted=1').run();
    if(fault==='NOT_LATEST_OUTGOING')chat.observe([{...item.chatPayload,platformEventId:'9999',text:'newer',occurredAt:new Date(Date.parse(item.boundary)+1).toISOString()}],
      'own-1',Date.parse(item.boundary)-1000,f.now);
    if(fault==='NOT_LATEST_INCOMING')pending(store,{...item.payload,platformEventId:'9999',occurredAt:new Date(Date.parse(item.boundary)+1).toISOString()});
    if(['WEAK','TOO_OLD','TOO_LATE'].includes(fault)){
      const payload={...item.chatPayload,...(fault==='WEAK'?{contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED'}:
        {occurredAt:new Date(Date.parse(item.boundary)+(fault==='TOO_OLD'?-2001:120_001)).toISOString()})};
      store.db.prepare('UPDATE chat_messages SET payload=?,binding=?').run(JSON.stringify(payload),eventBinding(payload as typeof item.chatPayload));
    }
    let calls=0;worker=new VerificationScheduler(f.data,async()=>{calls++;return{verified:true,evidenceId:'must-not-run'};});await worker.tick();
    expect(calls).toBe(0);
  } finally {await worker?.close();f.store.close();}
});

test.each(['FAILED','WRONG_NATIVE','MISSING_NATIVE','BINDING_CHANGED','CANCEL','PLATFORM_STOP'] as const)
  ('repair evidence remains bounded, pinned and append-only after %s',async fault=>{
  const f=await fixture();let worker:VerificationScheduler|undefined;
  try {
    const before=f.ledger();let calls=0;
    worker=new VerificationScheduler(f.data,async()=>{
      calls++;
      if(fault==='PLATFORM_STOP')throw new Blocked('OBSERVATION_PAGE_BLOCKED');
      if(fault==='CANCEL')worker!.cancel();
      if(fault==='BINDING_CHANGED')f.store.db.prepare("UPDATE reply_drafts SET text='changed during readback'").run();
      return {verified:fault!=='FAILED',evidenceId:'synthetic',...(fault==='MISSING_NATIVE'?{}:
        {nativeIdDigest:digest(fault==='WRONG_NATIVE'?'other-native':f.item.nativeId)})};
    });
    await worker.tick();await worker.close();
    worker=new VerificationScheduler(f.data,async()=>{calls++;return{verified:true,evidenceId:'must-not-replay'};});worker.start();await worker.tick();
    expect(calls).toBe(1);expect(f.ledger()).toEqual(before);
    expect(f.store.db.prepare('SELECT verified FROM verification_results').all()).toEqual([{verified:0}]);
    if(fault==='PLATFORM_STOP')expect(f.data.state().emergencyStopped).toBe(true);
  } finally {await worker?.close();f.store.close();}
});

test.each(['EMERGENCY','SUSPENDED'] as const)('repair does not claim while %s',async stop=>{
  const f=await fixture('REPLY');let worker:VerificationScheduler|undefined;
  try {
    let calls=0;worker=new VerificationScheduler(f.data,async()=>{calls++;return{verified:true,evidenceId:'must-not-run'};});
    if(stop==='EMERGENCY')f.data.stop(true);else worker.suspend(true);await worker.tick();expect(calls).toBe(0);
    expect(f.store.db.prepare('SELECT count(*) n FROM audit_events WHERE event_type=?').get(receiptRecheckVersion+'_CLAIMED')).toEqual({n:0});
  } finally {await worker?.close();f.store.close();}
});

test.each(['OBSERVATION_DM_CONTENT_DOM_NOT_READY','private contact https://private.invalid'])(
  'repair failure retains a safe current reason without exposing an exception: %s',async message=>{
  const f=await fixture();let worker:VerificationScheduler|undefined;
  try{
    worker=new VerificationScheduler(f.data,async()=>{throw new Blocked(message);});await worker.tick();
    const rows=f.store.db.prepare('SELECT event_type,detail_redacted FROM audit_events WHERE event_type LIKE ?').all(receiptRecheckVersion+'_FAILED_%');
    expect(rows).toEqual([{event_type:receiptRecheckVersion+'_FAILED_'+(message.startsWith('OBSERVATION_')?message:'PRIVATE_DIAGNOSTICS'),detail_redacted:'{}'}]);
    expect(JSON.stringify(rows)).not.toContain('private.invalid');
  }finally{await worker?.close();f.store.close();}
});

test('repair exposes only its active event while running and publishes completion without rewriting its old job',async()=>{
  const f=await fixture('REPLY');let worker:VerificationScheduler|undefined,finish!:(value:{verified:boolean;evidenceId:string})=>void;
  try {
    const result=new Promise<{verified:boolean;evidenceId:string}>(resolve=>{finish=resolve;}),before=f.ledger(),updates:(string|null)[]=[];
    worker=new VerificationScheduler(f.data,async()=>result,()=>updates.push(worker!.activeEventId()));
    expect(worker.activeEventId()).toBeNull();const task=worker.tick();
    await expect.poll(()=>worker!.activeEventId()).toBe(f.item.eventId);
    expect(f.ledger()).toEqual(before);finish({verified:true,evidenceId:'bound-comment-proof'});await task;
    expect(updates).toEqual([f.item.eventId,null]);expect(worker.activeEventId()).toBeNull();
    expect(f.store.db.prepare('SELECT verified FROM verification_results').all()).toEqual([{verified:1}]);
    expect(f.ledger()).toEqual(before);
  } finally {finish?.({verified:false,evidenceId:'cleanup'});await worker?.close();f.store.close();}
});

test('a diagnosed old comment timestamp is not repeatedly retried by a rendering repair',async()=>{
  const f=await fixture('COMMENT');let worker:VerificationScheduler|undefined;
  try{
    f.store.audit('COMMENT_READBACK_VERIFY_EXISTING_FILTERED_GET_ACCEPTED_ACK_NONE_GUARD_NONE',
      digest(['comment',f.item.payload.videoId,f.item.payload.commentId]),{poll_sameText:1,poll_afterBoundary:0,poll_notFuture:1});
    let calls=0;const before=f.ledger();
    worker=new VerificationScheduler(f.data,async()=>{calls++;return{verified:true,evidenceId:'must-not-run'};});
    await worker.tick();expect(calls).toBe(0);expect(f.ledger()).toEqual(before);
  }finally{await worker?.close();f.store.close();}
});
