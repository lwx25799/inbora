import {expect,test} from 'vitest';
import {join} from 'node:path';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {ChatMessageStore} from '../../src/storage/chat-messages.js';
import {candidate,database,privateTemp,snapshot} from '../helpers.js';

type MediaFault='NONE'|'MISSING_ID'|'MISSING_TIME'|'MISSING_ACTOR'|'WRONG_ACTOR'|'WRONG_OWN';
async function setup(backfill:'NONE'|'BEFORE'|'AFTER'='NONE',latestFirst=false,mediaFault?:MediaFault){
  const store=database(),root=privateTemp('conversation-reply-projection-'),now=Date.now(),origin=now-60_000;
  const base=candidate({platformEventId:'101',conversationId:'exact-conversation',occurredAt:new Date(now-30_000).toISOString()});
  store.observe('DIRECT_MESSAGE',base.conversationId!,[],'own-1','baseline',new Date(origin).toISOString(),origin);
  const observe=(index:number,at:number,observedAt:number)=>{
    const evidence='observation-'+index,event={...base,platformEventId:mediaFault==='MISSING_ID'&&index===3?null:String(100+index),text:'incoming '+index,
      occurredAt:mediaFault==='MISSING_TIME'&&index===3?null:new Date(at).toISOString(),evidenceId:evidence,
      ...(mediaFault!==undefined&&index===3?{text:'[图片/表情]',contentType:'IMAGE' as const,observationIssue:'DM_CONTENT_UNVERIFIED' as const,
        actorId:mediaFault==='MISSING_ACTOR'?null:mediaFault==='WRONG_ACTOR'?'different-peer':base.actorId}:{})};
    store.observe('DIRECT_MESSAGE',event.conversationId!,[event],'own-1',evidence,new Date(observedAt).toISOString(),origin);
    return store.events().find(row=>row.payload.platformEventId===event.platformEventId)!.id;
  };
  const old=latestFirst?'':observe(1,now-30_000,now-3000),latest=observe(2,now-20_000,now-2000);
  let backfillId:string|null=null;if(backfill==='BEFORE')backfillId=observe(3,now-25_000,now-1000);
  const event=store.event(latest),draft=store.saveDraft(latest,'trusted exact reply','mock');store.approve(draft.id,snapshot(event.payload),1,draft.text);
  const intent=store.recordIntent(draft.id,snapshot(event.payload),false);store.receipt(intent,'CONFIRMED','synthetic-complete-proof');
  if(backfill==='AFTER')backfillId=observe(3,now-25_000,Date.parse(store.intentBoundary(intent))+1000);
  await migrateClient(store,join(root,'client.sqlite'));const service=new ClientService(store,new BrowserService(root));await service.loadSettings();
  if(mediaFault==='WRONG_OWN')store.db.prepare("UPDATE accounts SET own_id='different-own' WHERE id='account_001'").run();
  const token=service.authority.issueSession(),inbox=()=>service.dispatch(token,{command:'getInbox',channel:'DIRECT_MESSAGE',status:'ALL',page:0}) as Promise<{items:{id:string;replyStatus:string}[]}>;
  return{store,service,token,old,latest,backfillId,intent,inbox,close:async()=>{await service.close();store.close();}};
}

test('a retained old editor anchor shares the current conversation badge without changing its event send status',async()=>{
  const f=await setup();try{
    expect((await f.inbox()).items[0]).toMatchObject({id:f.latest,replyStatus:'REPLIED'});
    expect(await f.service.dispatch(f.token,{command:'getThread',eventId:f.old})).toMatchObject({replyStatus:'WAITING',conversationReplyStatus:'REPLIED',event:{id:f.old}});
  }finally{await f.close();}
});

test.each(['BEFORE','AFTER'] as const)('a backfill first observed %s the trusted dispatch is ordered by its durable evidence',async when=>{
  const f=await setup(when,true);try{
    const before={event:f.store.event(f.backfillId!),intent:f.store.db.prepare('SELECT * FROM send_intents').all(),receipt:f.store.db.prepare('SELECT * FROM delivery_receipts').all(),budgets:f.store.budgets()};
    expect((await f.inbox()).items[0]).toMatchObject({replyStatus:when==='BEFORE'?'REPLIED':'WAITING'});
    expect({event:f.store.event(f.backfillId!),intent:f.store.db.prepare('SELECT * FROM send_intents').all(),receipt:f.store.db.prepare('SELECT * FROM delivery_receipts').all(),budgets:f.store.budgets()}).toEqual(before);
  }finally{await f.close();}
});

test('a historical unknown cannot override a newer complete reply or mutate either event ledger',async()=>{
  const f=await setup();try{
    // An old event can retain an independent unknown while the latest incoming has a complete reply.
    const event=f.store.event(f.old),draftId='synthetic-old-draft',intentId='synthetic-old-intent',approval={snapshot:snapshot(event.payload),version:1,textDigest:'old'};
    f.store.db.prepare("INSERT INTO reply_drafts VALUES(?,?,?,'mock',1,'UNCERTAIN',?,NULL)").run(draftId,f.old,'old outgoing',JSON.stringify(approval));
    f.store.db.prepare('INSERT INTO send_intents VALUES(?,?,?,?,?,?,?,?)').run(intentId,f.old,draftId,'dm:exact-conversation','old','old','UNCERTAIN',new Date(Date.now()-10_000).toISOString());
    f.store.db.prepare("UPDATE inbound_events SET status='UNCERTAIN' WHERE id=?").run(f.old);
    const before={old:f.store.event(f.old),intent:f.store.db.prepare('SELECT * FROM send_intents WHERE id=?').get(intentId)};
    expect((await f.inbox()).items[0]).toMatchObject({id:f.latest,replyStatus:'REPLIED'});
    expect(await f.service.dispatch(f.token,{command:'getThread',eventId:f.old})).toMatchObject({replyStatus:'WAITING',conversationReplyStatus:'REPLIED',frozen:true});
    expect({old:f.store.event(f.old),intent:f.store.db.prepare('SELECT * FROM send_intents WHERE id=?').get(intentId)}).toEqual(before);
  }finally{await f.close();}
});

test.each(['NO_EVIDENCE','SAME_MILLISECOND','COLLISION','UNCERTAIN','CONTRADICTION'] as const)
  ('conversation coverage still waits without complete trustworthy proof (%s)',async fault=>{
  const f=await setup('BEFORE',true);try{
    if(fault==='NO_EVIDENCE')f.store.db.prepare("DELETE FROM observations WHERE evidence_ref='observation-3'").run();
    if(fault==='SAME_MILLISECOND')f.store.db.prepare("UPDATE observations SET observed_at=? WHERE evidence_ref='observation-3'").run(f.store.intentBoundary(f.intent));
    if(fault==='COLLISION')f.store.db.prepare('INSERT INTO source_collisions VALUES(?,?,?,?,?)').run('synthetic-collision',f.backfillId,'other','{}','synthetic');
    if(fault==='UNCERTAIN'){f.store.db.prepare("UPDATE send_intents SET status='UNCERTAIN'").run();f.store.db.prepare("UPDATE inbound_events SET status='UNCERTAIN' WHERE id=?").run(f.latest);}
    if(fault==='CONTRADICTION')f.store.db.prepare('INSERT INTO verification_results VALUES(?,?,?,?,?)').run('synthetic-negative',f.intent,0,'synthetic-contradiction',Date.now());
    expect((await f.inbox()).items[0]!.replyStatus).toBe('WAITING');
  }finally{await f.close();}
});

test('a complete follow-up proof covers the conversation without rewriting the original unknown receipt',async()=>{
  const f=await setup('BEFORE',true);try{
    f.store.db.prepare("UPDATE send_intents SET status='UNCERTAIN'").run();f.store.db.prepare("UPDATE inbound_events SET status='UNCERTAIN' WHERE id=?").run(f.latest);
    f.store.db.prepare("UPDATE delivery_receipts SET result='UNCERTAIN',proof_ref='original-unknown'").run();
    f.store.db.prepare('INSERT INTO verification_results VALUES(?,?,?,?,?)').run('synthetic-positive',f.intent,1,'complete-followup',Date.now());
    expect((await f.inbox()).items[0]!.replyStatus).toBe('REPLIED');
    expect(f.store.event(f.latest).status).toBe('UNCERTAIN');expect(f.store.receiptForEvent(f.latest)).toMatchObject({result:'UNCERTAIN',proof_ref:'original-unknown'});
  }finally{await f.close();}
});

test('a newly received message after a trusted reply returns the conversation to waiting without rewriting the old anchor',async()=>{
  const f=await setup();try{
    const at=Date.parse(f.store.intentBoundary(f.intent))+1000,evidence='new-post-reply',payload=candidate({platformEventId:'199',conversationId:'exact-conversation',
      text:'new incoming after reply',occurredAt:new Date(at).toISOString(),evidenceId:evidence});
    f.store.observe('DIRECT_MESSAGE',payload.conversationId!,[payload],'own-1',evidence,new Date(at+1).toISOString());
    expect((await f.inbox()).items[0]!.replyStatus).toBe('WAITING');
    expect(await f.service.dispatch(f.token,{command:'getThread',eventId:f.latest})).toMatchObject({replyStatus:'REPLIED',conversationReplyStatus:'WAITING',event:{id:f.latest}});
  }finally{await f.close();}
});

test('observed strong own messages alone cannot turn an unresolved reply into confirmed conversation status',async()=>{
  const f=await setup();try{
    f.store.db.prepare("UPDATE send_intents SET status='UNCERTAIN'").run();f.store.db.prepare("UPDATE inbound_events SET status='UNCERTAIN' WHERE id=?").run(f.latest);
    new ChatMessageStore(f.store).observe([candidate({platformEventId:'299',conversationId:'exact-conversation',actorId:'own-1',direction:'OUTGOING',
      text:'trusted exact reply',occurredAt:new Date(Date.parse(f.store.intentBoundary(f.intent))-949).toISOString()})],'own-1',Date.now()-60_000);
    expect((await f.inbox()).items[0]!.replyStatus).toBe('WAITING');expect(f.store.event(f.latest).status).toBe('UNCERTAIN');
  }finally{await f.close();}
});

test.each(['NONE','MISSING_ID','MISSING_TIME','MISSING_ACTOR','WRONG_ACTOR','WRONG_OWN'] as const)
  ('a media message observed before a trusted reply is covered only with exact native identity (%s)',async fault=>{
  const f=await setup('BEFORE',true,fault);try{
    const before={event:f.store.event(f.backfillId!),intent:f.store.db.prepare('SELECT * FROM send_intents').all(),
      receipt:f.store.db.prepare('SELECT * FROM delivery_receipts').all(),budgets:f.store.budgets()};
    expect((await f.inbox()).items[0]).toMatchObject({id:fault==='NONE'?f.latest:f.backfillId,replyStatus:fault==='NONE'?'REPLIED':'WAITING'});
    expect(f.store.event(f.backfillId!).status).toBe('MANUAL_REVIEW');
    expect({event:f.store.event(f.backfillId!),intent:f.store.db.prepare('SELECT * FROM send_intents').all(),
      receipt:f.store.db.prepare('SELECT * FROM delivery_receipts').all(),budgets:f.store.budgets()}).toEqual(before);
  }finally{await f.close();}
});
