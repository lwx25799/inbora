import {expect,test} from 'vitest';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {ChatMessageStore} from '../../src/storage/chat-messages.js';
import {VerificationScheduler} from '../../src/app/verification-scheduler.js';
import {claimDmContextVerification} from '../../src/app/dm-context-verification.js';
import {Blocked,digest,eventBinding} from '../../src/core/contracts.js';
import {candidate,database,pending,privateTemp,snapshot} from '../helpers.js';

async function setup(){
  const store=database(),root=privateTemp('context-window-boundaries-'),now=Date.now();
  await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  const data=new AutomationStore(store,()=>now);data.initialize(now-1000);
  store.db.prepare("INSERT INTO automation_grants VALUES(1,'AUTO_REPLY','{}','synthetic',?,NULL)").run(now);
  const add=(index=1)=>{
    const payload=candidate({platformEventId:String(100+index),conversationId:'conversation-'+index}),eventId=pending(store,payload),draftId=randomUUID();
    store.db.prepare("INSERT INTO reply_drafts VALUES(?,?,?,'AUTO_POLICY',1,'DRAFT',NULL,NULL)").run(draftId,eventId,'policy reply '+index);
    store.db.prepare("UPDATE inbound_events SET status='AWAITING_APPROVAL' WHERE id=?").run(eventId);const draft=store.draft(draftId);
    const proof={...snapshot(payload),contextDigest:'b'.repeat(64)};store.approve(draft.id,proof,draft.version,draft.text);
    store.db.prepare("INSERT INTO draft_revisions VALUES(?,1,'AUTO_POLICY',?,'policy:synthetic',?)").run(draft.id,draft.text,now);
    const intentId=store.recordIntent(draft.id,proof,false,{check:()=>{},committed:()=>{}});store.receipt(intentId,'UNCERTAIN','POST_INTENT_FAILURE:READBACK:UNCLASSIFIED');
    const commandId=randomUUID();store.db.prepare("INSERT INTO manual_send_commands VALUES(?,?,'policy:synthetic','synthetic','{}','UNCERTAIN',?,NULL,?)").run(commandId,eventId,intentId,now);
    store.db.prepare('INSERT INTO policy_commands VALUES(?,1,0)').run(commandId);
    const boundary=store.intentBoundary(intentId),nativeId=String(9000+index),chatPayload=candidate({conversationId:payload.conversationId,platformEventId:nativeId,
      direction:'OUTGOING',actorId:'own-1',text:draft.text,occurredAt:new Date(Date.parse(boundary)-949).toISOString()});
    new ChatMessageStore(store).observe([chatPayload],'own-1',Date.parse(boundary)-1000);
    store.db.prepare("INSERT INTO verification_jobs VALUES(?,?,?,?,2,?,?,'REVIEW','NO_COMPLETE_PROOF')").run(intentId,eventId,boundary,digest(proof),now-100,now-1);
    return{eventId,draftId:draft.id,intentId,commandId,payload,chatPayload,boundary,nativeId};
  };
  const item=add();
  const original=()=>({intents:store.db.prepare('SELECT * FROM send_intents ORDER BY id').all(),receipts:store.db.prepare('SELECT * FROM delivery_receipts ORDER BY id').all(),
    jobs:store.db.prepare('SELECT * FROM verification_jobs ORDER BY intent_id').all(),budgets:store.budgets()});
  const mutateChat=(change:Record<string,unknown>)=>{
    const row=store.db.prepare('SELECT id,payload FROM chat_messages WHERE native_id=?').get(item.nativeId) as {id:string;payload:string};
    const payload={...JSON.parse(row.payload),...change};store.db.prepare('UPDATE chat_messages SET payload=?,binding=? WHERE id=?').run(JSON.stringify(payload),eventBinding(payload),row.id);
  };
  return{store,data,now,item,add,original,mutateChat};
}

test.each(['ORIGIN','VERSION','NO_POLICY','CONTEXT','APPROVAL_TEXT','BINDING','TARGET','CHANNEL','ATTEMPTS','JOB_STATE','REASON','CONFIRMED','OLD_VERIFIED',
  'WEAK_OWN','OWN_CONFLICT','DUPLICATE','OTHER_CONVERSATION','OTHER_TEXT','TOO_OLD','AT_INTENT','FUTURE'] as const)
  ('the supplemental contract cannot claim an unrelated or incomplete unknown (%s)',async fault=>{
  const f=await setup();try{
    const {store,item}=f;
    if(fault==='ORIGIN')store.db.prepare("UPDATE draft_revisions SET origin='HUMAN_TYPED'").run();
    if(fault==='VERSION')store.db.prepare('UPDATE reply_drafts SET version=2').run();
    if(fault==='NO_POLICY')store.db.prepare('DELETE FROM policy_commands').run();
    if(['CONTEXT','APPROVAL_TEXT','BINDING'].includes(fault)){
      const approval=store.draft(item.draftId).approval!;
      if(fault==='CONTEXT')approval.snapshot.contextDigest='context-1';if(fault==='APPROVAL_TEXT')approval.textDigest='0'.repeat(64);
      if(fault==='BINDING')approval.snapshot.eventBinding='0'.repeat(64);
      store.db.prepare('UPDATE reply_drafts SET approval=?').run(JSON.stringify(approval));
      store.db.prepare('UPDATE send_intents SET target_digest=?').run(digest(approval.snapshot));store.db.prepare('UPDATE verification_jobs SET target_digest=?').run(digest(approval.snapshot));
    }
    if(fault==='TARGET')store.db.prepare("UPDATE send_intents SET target_key='dm:outside'").run();
    if(fault==='CHANNEL')store.db.prepare("UPDATE inbound_events SET channel='COMMENT_NOTIFICATION'").run();
    if(fault==='ATTEMPTS')store.db.prepare('UPDATE verification_jobs SET attempts=1').run();
    if(fault==='JOB_STATE')store.db.prepare("UPDATE verification_jobs SET state='PENDING'").run();
    if(fault==='REASON')store.db.prepare("UPDATE delivery_receipts SET proof_ref='NO_UNIQUE_BOUND_PROOF'").run();
    if(fault==='CONFIRMED')store.db.prepare("UPDATE send_intents SET status='CONFIRMED'").run();
    if(fault==='OLD_VERIFIED')store.db.prepare("INSERT INTO verification_results VALUES(?,?,1,'old-proof',?)").run(randomUUID(),item.intentId,f.now);
    if(fault==='WEAK_OWN')f.mutateChat({contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED'});
    if(fault==='OWN_CONFLICT')store.db.prepare('UPDATE chat_messages SET conflicted=1').run();
    if(fault==='DUPLICATE')new ChatMessageStore(store).observe([{...item.chatPayload,platformEventId:'9999'}],'own-1',Date.parse(item.boundary)-1000);
    if(fault==='OTHER_CONVERSATION')store.db.prepare("UPDATE chat_messages SET conversation_id='outside'").run();
    if(fault==='OTHER_TEXT')f.mutateChat({text:'other private synthetic text'});
    if(fault==='TOO_OLD'||fault==='AT_INTENT'||fault==='FUTURE')f.mutateChat({occurredAt:new Date(Date.parse(item.boundary)+(fault==='TOO_OLD'?-2001:fault==='AT_INTENT'?0:1)).toISOString()});
    const before=f.original();expect(claimDmContextVerification(store,f.now)).toBeUndefined();expect(f.original()).toEqual(before);
    expect(store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='DM_CONTEXT_WINDOW_CHECKED'").get()).toEqual({n:0});
  }finally{f.store.close();}
});

test('a cross-day same-text own history does not mask the unique in-range native candidate',async()=>{
  const f=await setup();try{
    new ChatMessageStore(f.store).observe([{...f.item.chatPayload,platformEventId:'9999',occurredAt:new Date(Date.parse(f.item.boundary)-86_400_000).toISOString()}],
      'own-1',Date.parse(f.item.boundary)-1000);
    expect(claimDmContextVerification(f.store,f.now)).toMatchObject({intent_id:f.item.intentId,nativeIdDigest:digest(f.item.nativeId)});
  }finally{f.store.close();}
});

test('claim consumption survives a crash before verification and never selects a second eligible intent',async()=>{
  const f=await setup();let worker:VerificationScheduler|undefined;try{
    const latest=f.add(2),before=f.original();expect(claimDmContextVerification(f.store,f.now)?.intent_id).toBe(latest.intentId);
    let calls=0;worker=new VerificationScheduler(f.data,async()=>{calls++;return{verified:true,evidenceId:'must-not-run'};});
    worker.start();await worker.tick();expect(calls).toBe(0);expect(f.original()).toEqual(before);
    expect(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='DM_CONTEXT_WINDOW_CHECKED'").get()).toEqual({n:1});
  }finally{await worker?.close();f.store.close();}
});

test('an ineligible newest matching failure cannot fall back to an older eligible intent',async()=>{
  const f=await setup();try{
    const latest=f.add(2);f.store.db.prepare('UPDATE chat_messages SET conflicted=1 WHERE native_id=?').run(latest.nativeId);
    const before=f.original();expect(claimDmContextVerification(f.store,f.now)).toBeUndefined();expect(f.original()).toEqual(before);
    expect(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='DM_CONTEXT_WINDOW_CHECKED'").get()).toEqual({n:0});
  }finally{f.store.close();}
});

test.each(['EMERGENCY','SUSPENDED'] as const)('no supplemental claim is consumed while %s blocks the worker',async stop=>{
  const f=await setup();let worker:VerificationScheduler|undefined;try{
    let calls=0;worker=new VerificationScheduler(f.data,async()=>{calls++;return{verified:true,evidenceId:'must-not-run'};});
    if(stop==='EMERGENCY')f.data.stop(true);else worker.suspend(true);const before=f.original();await worker.tick();
    expect(calls).toBe(0);expect(f.original()).toEqual(before);
    expect(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='DM_CONTEXT_WINDOW_CHECKED'").get()).toEqual({n:0});
  }finally{await worker?.close();f.store.close();}
});

test.each(['CANCEL','CLOSE','PLATFORM_STOP','WRONG_NATIVE','MISSING_NATIVE'] as const)('a consumed supplemental %s never mutates the old job or replays after restart',async cause=>{
  const f=await setup();let worker:VerificationScheduler|undefined;try{
    const before=f.original();let started!:()=>void,finish!:(value:{verified:boolean;evidenceId:string;nativeIdDigest?:string})=>void,calls=0;
    const begun=new Promise<void>(resolve=>started=resolve),result=new Promise<{verified:boolean;evidenceId:string;nativeIdDigest?:string}>(resolve=>finish=resolve);
    worker=new VerificationScheduler(f.data,async()=>{calls++;started();if(cause==='PLATFORM_STOP')throw new Blocked('OBSERVATION_PAGE_BLOCKED');return result;});
    const task=worker.tick();await begun;
    if(cause==='CANCEL')worker.cancel();const closing=cause==='CLOSE'?worker.close():Promise.resolve();
    finish({verified:true,evidenceId:'synthetic',...(cause==='MISSING_NATIVE'?{}:{nativeIdDigest:digest(cause==='WRONG_NATIVE'?'outside':f.item.nativeId)})});
    await task;await closing;expect(f.original()).toEqual(before);
    expect(f.store.db.prepare('SELECT verified FROM verification_results').all()).toEqual([{verified:0}]);await worker.close();
    worker=new VerificationScheduler(f.data,async()=>{calls++;return{verified:true,evidenceId:'must-not-replay'};});await worker.tick();expect(calls).toBe(1);
    if(cause==='PLATFORM_STOP')expect(f.data.state().emergencyStopped).toBe(true);
  }finally{await worker?.close();f.store.close();}
});
