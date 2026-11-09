import {expect,test} from 'vitest';
import {join} from 'node:path';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {VerificationScheduler} from '../../src/app/verification-scheduler.js';
import {ChatMessageStore} from '../../src/storage/chat-messages.js';
import {candidate,database,pending,privateTemp,snapshot} from '../helpers.js';
import {digest} from '../../src/core/contracts.js';

test.each([true,false])('a new context-window evidence contract checks an eligible unknown once without resetting its original attempts (%s)',async verified=>{
  const store=database(),root=privateTemp('context-window-verification-');let worker:VerificationScheduler|undefined;
  try{
    const initial=store.saveDraft(pending(store),'approved fixture reply','mock'),draftId=initial.id,event=store.event(initial.eventId);
    store.approve(draftId,{...snapshot(event.payload),contextDigest:'b'.repeat(64)},initial.version,initial.text);
    const draft=store.draft(draftId);
    await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
    store.db.prepare("INSERT INTO draft_revisions VALUES(?,1,'AUTO_POLICY',?,'policy:synthetic',?)").run(draftId,draft.text,Date.now());
    const intent=store.recordIntent(draftId,draft.approval!.snapshot,false,{check:()=>{},committed:()=>{}});
    store.receipt(intent,'UNCERTAIN','POST_INTENT_FAILURE:READBACK:UNCLASSIFIED');
    store.db.prepare("INSERT INTO automation_grants VALUES(1,'AUTO_REPLY','{}','synthetic',?,NULL)").run(Date.now());
    store.db.prepare("INSERT INTO manual_send_commands VALUES('command',?,'policy:synthetic','synthetic','{}','UNCERTAIN',?,NULL,?)").run(event.id,intent,Date.now());
    store.db.prepare("INSERT INTO policy_commands VALUES('command',1,0)").run();
    const boundary=Date.parse(store.intentBoundary(intent));
    new ChatMessageStore(store).observe([candidate({platformEventId:'9001',direction:'OUTGOING',actorId:'own-1',text:draft.text,
      occurredAt:new Date(boundary-949).toISOString()})],'own-1',boundary-1000);
    const now=Date.now(),data=new AutomationStore(store,()=>now);data.initialize(now-1000);
    worker=new VerificationScheduler(data,async()=>({verified:false,evidenceId:'unused'}));worker.enqueue(event.id);
    store.db.prepare("UPDATE verification_jobs SET state='REVIEW',attempts=2,last_error='NO_COMPLETE_PROOF'").run();
    const before={intent:store.db.prepare('SELECT * FROM send_intents').all(),receipt:store.db.prepare('SELECT * FROM delivery_receipts').all(),budgets:store.budgets(),jobs:store.db.prepare('SELECT * FROM verification_jobs').all()};
    let calls=0;await worker.close();worker=new VerificationScheduler(data,async()=>{calls++;return{verified,evidenceId:'synthetic-window-contract',nativeIdDigest:digest('9001')};});
    worker.start();await worker.tick();await worker.close();worker=new VerificationScheduler(data,async()=>{calls++;return{verified:true,evidenceId:'must-not-run'};});
    worker.start();await worker.tick();expect(calls).toBe(1);
    expect(store.db.prepare('SELECT attempts FROM verification_jobs').get()).toEqual({attempts:2});
    expect({intent:store.db.prepare('SELECT * FROM send_intents').all(),receipt:store.db.prepare('SELECT * FROM delivery_receipts').all(),budgets:store.budgets(),jobs:store.db.prepare('SELECT * FROM verification_jobs').all()}).toEqual(before);
    expect(store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='DM_CONTEXT_WINDOW_CHECKED'").get()).toEqual({n:1});
    expect(store.db.prepare('SELECT verified FROM verification_results').all()).toEqual([{verified:Number(verified)}]);
  }finally{await worker?.close();store.close();}
});
