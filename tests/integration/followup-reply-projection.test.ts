import {expect,test} from 'vitest';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {EventStore} from '../../src/storage/store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {digest,eventBinding,targetKey,type InboundEvent,type StoredEvent} from '../../src/core/contracts.js';
import {candidate,privateTemp,snapshot} from '../helpers.js';

const at=(seconds:number)=>new Date(Date.UTC(2026,10,4,1,0,seconds)).toISOString();
async function fixture(channel:InboundEvent['channel']='DIRECT_MESSAGE'){
  const root=privateTemp('followup-projection-'),store=new EventStore(join(root,'poc.sqlite'),true,()=>at(2));
  const scope=channel==='DIRECT_MESSAGE'?'conversation-1':'notifications';
  store.observe(channel,scope,[],'own-1','baseline',at(0));
  const add=(seconds:number,overrides:Partial<InboundEvent>={},observedAt=at(seconds))=>{
    const event=candidate({channel,platformEventId:String(1000+seconds),occurredAt:at(seconds),evidenceId:'incoming-'+seconds,
      ...(channel==='COMMENT_NOTIFICATION'?{kind:'COMMENT',conversationId:null,videoId:'100',commentId:String(1000+seconds)}:{}),...overrides});
    store.observe(channel,scope,[event],'own-1',event.evidenceId,observedAt);
    return store.events().find(item=>item.payload.platformEventId===event.platformEventId)!;
  };
  const anchor=add(1),draft=store.saveDraft(anchor.id,'first confirmed synthetic reply','human');
  store.approve(draft.id,snapshot(anchor.payload),draft.version,draft.text);
  const original=store.recordIntent(draft.id,snapshot(anchor.payload),false);store.receipt(original,'CONFIRMED','synthetic-proof');
  store.db.prepare('UPDATE send_intents SET attempt_started_at=? WHERE id=?').run(at(2),original);
  await migrateClient(store,join(root,'client.sqlite'));
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();const token=service.authority.issueSession();
  const later=add(3);
  const followup=(mutate?:(row:Record<string,unknown>)=>void)=>{
    const text='a confirmed additional synthetic reply',bound={...snapshot(anchor.payload),contextDigest:digest('current-context')};
    const row:Record<string,unknown>={command_id:randomUUID(),event_id:anchor.id,target_key:targetKey(anchor.payload),operator_id:'fixture',
      input_digest:digest('synthetic-input'),params:JSON.stringify({eventId:anchor.id,text}),text,version:1,status:'CONFIRMED',
      approval:JSON.stringify({snapshot:bound,version:1,textDigest:digest(text)}),intent_id:randomUUID(),attempt_started_at:at(4),
      reason:null,proof_ref:digest('synthetic-proof'),verified_at:at(5),native_id_digest:digest('native-followup'),created_at:Date.parse(at(3))};
    mutate?.(row);store.db.prepare(`INSERT INTO human_reply_turns(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
    return row;
  };
  const inbox=()=>service.dispatch(token,{command:'getInbox',channel,status:'ALL',page:0}) as Promise<{
    total:number;items:{id:string;replyStatus:string;resumeEventId:string|null}[];
  }>;
  const ledger=()=>['inbound_events','send_intents','delivery_receipts','human_reply_turns','budgets'].map(table=>store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const save=(event:StoredEvent,seconds:number)=>{
    const id=randomUUID(),text='unfinished synthetic human draft';
    store.db.prepare("INSERT INTO reply_drafts VALUES(?,?,?,'human',1,'DRAFT',NULL,NULL)").run(id,event.id,text);
    store.db.prepare('INSERT INTO draft_revisions VALUES(?,?,?,?,?,?)').run(id,1,'HUMAN_TYPED',text,'fixture',Date.parse(at(seconds)));
  };
  return {store,service,token,anchor,later,add,followup,inbox,ledger,save,close:async()=>{await service.close();store.close();}};
}

test('a confirmed additional DM reply covers already observed incoming text without rewriting either ledger',async()=>{
  const f=await fixture();try{
    expect(await f.inbox()).toMatchObject({items:[{id:f.later.id,replyStatus:'WAITING'}]});
    f.followup();const before=f.ledger();
    expect(await f.inbox()).toMatchObject({items:[{replyStatus:'REPLIED'}]});
    expect(await f.service.dispatch(f.token,{command:'getThread',eventId:f.later.id})).toMatchObject({replyStatus:'WAITING',conversationReplyStatus:'REPLIED'});
    expect(f.ledger()).toEqual(before);
    const next=f.add(6);
    expect(await f.inbox()).toMatchObject({items:[{id:next.id,replyStatus:'WAITING'}]});
  }finally{await f.close();}
});

test.each(['UNCERTAIN','BINDING','TARGET','OWN','TEXT','PARAM_TEXT','VERSION','NO_INTENT','NO_PROOF','NO_NATIVE','BAD_TIME'] as const)
  ('additional reply coverage requires complete trustworthy proof (%s)',async fault=>{
  const f=await fixture();try{
    f.followup(row=>{
      const approval=JSON.parse(row.approval as string);
      if(fault==='UNCERTAIN')row.status='UNCERTAIN';
      if(fault==='BINDING')approval.snapshot.eventBinding=digest('other-event');
      if(fault==='TARGET')row.target_key='dm:other-conversation';
      if(fault==='OWN')approval.snapshot.ownId='different-own';
      if(fault==='TEXT')row.text='unapproved changed reply';
      if(fault==='PARAM_TEXT')row.params=JSON.stringify({eventId:f.anchor.id,text:'different request text'});
      if(fault==='VERSION')row.version=2;
      if(fault==='NO_INTENT')row.intent_id=null;
      if(fault==='NO_PROOF')row.proof_ref=null;
      if(fault==='NO_NATIVE')row.native_id_digest=null;
      if(fault==='BAD_TIME')row.verified_at=at(3);
      row.approval=JSON.stringify(approval);
    });
    expect(await f.inbox()).toMatchObject({items:[{replyStatus:'WAITING'}]});
  }finally{await f.close();}
});

test.each(['ACTOR','PAYLOAD_BINDING','COLLISION','NO_OBSERVATION','LATE_OBSERVATION','SAME_TIME','UNRESOLVED_INTENT'] as const)
  ('additional reply cannot cover an unsafe incoming candidate (%s)',async fault=>{
  const f=await fixture();try{
    if(fault==='ACTOR'){
      const payload={...f.later.payload,actorId:'different-peer'};
      f.store.db.prepare('UPDATE inbound_events SET payload=?,binding=? WHERE id=?').run(JSON.stringify(payload),eventBinding(payload),f.later.id);
    }
    if(fault==='PAYLOAD_BINDING')f.store.db.prepare("UPDATE inbound_events SET binding='different-binding' WHERE id=?").run(f.later.id);
    if(fault==='COLLISION')f.store.db.prepare('INSERT INTO source_collisions VALUES(?,?,?,?,?)').run(randomUUID(),f.later.id,'other','{}','synthetic');
    if(fault==='NO_OBSERVATION')f.store.db.prepare("DELETE FROM observations WHERE evidence_ref='incoming-3'").run();
    if(fault==='LATE_OBSERVATION')f.store.db.prepare("UPDATE observations SET observed_at=? WHERE evidence_ref='incoming-3'").run(at(6));
    if(fault==='SAME_TIME')f.store.db.prepare("UPDATE observations SET observed_at=? WHERE evidence_ref='incoming-3'").run(at(4));
    if(fault==='UNRESOLVED_INTENT'){
      const draft=randomUUID(),intent=randomUUID(),text='unresolved outgoing',bound=snapshot(f.later.payload);
      f.store.db.prepare("INSERT INTO reply_drafts VALUES(?,?,?,'human',1,'APPROVED',?,NULL)")
        .run(draft,f.later.id,text,JSON.stringify({snapshot:bound,version:1,textDigest:digest(text)}));
      f.store.db.prepare("INSERT INTO send_intents VALUES(?,?,?,?,?,?,'UNCERTAIN',?)")
        .run(intent,f.later.id,draft,targetKey(f.later.payload),digest(bound),digest(text),at(3));
      f.store.db.prepare("UPDATE inbound_events SET status='UNCERTAIN' WHERE id=?").run(f.later.id);
    }
    f.followup();expect(await f.inbox()).toMatchObject({items:[{replyStatus:'WAITING'}]});
  }finally{await f.close();}
});

test.each([3,6])('draft resume respects the confirmed followup boundary (saved at %s)',async seconds=>{
  const f=await fixture();try{
    f.save(f.later,seconds);f.followup();
    expect(await f.inbox()).toMatchObject({items:[{replyStatus:'REPLIED',resumeEventId:seconds>4?f.later.id:null}]});
    expect(f.store.db.prepare('SELECT count(*) AS n FROM reply_drafts WHERE event_id=?').get(f.later.id)).toEqual({n:1});
  }finally{await f.close();}
});

test('a confirmed comment followup cannot mark a different parent comment or its child replied',async()=>{
  const f=await fixture('COMMENT_NOTIFICATION');try{
    f.followup();f.add(6,{kind:'REPLY',commentId:'1006',rootCommentId:f.anchor.payload.commentId!,replyToCommentId:'1006'});
    const rows=(await f.inbox()).items;
    expect(rows).toHaveLength(2);expect(rows.every(row=>row.replyStatus==='WAITING')).toBe(true);
    expect(await f.service.dispatch(f.token,{command:'getThread',eventId:f.anchor.id})).toMatchObject({replyStatus:'REPLIED'});
  }finally{await f.close();}
});
