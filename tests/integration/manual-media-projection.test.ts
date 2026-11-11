import {expect,test} from 'vitest';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {candidate,database,pending,privateTemp,snapshot} from '../helpers.js';
import {digest,targetKey,type InboundEvent,type StoredEvent} from '../../src/core/contracts.js';

async function setup(){
  const store=database(),root=privateTemp('manual-media-projection-');await migrateClient(store,join(root,'client.sqlite'));
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();const token=service.authority.issueSession();
  const add=(index:number,contentType?:InboundEvent['contentType'],override:Partial<InboundEvent>={})=>{
    pending(store,candidate({platformEventId:String(2000+index),text:contentType?'[需人工查看的消息]':'a real unanswered question',
      occurredAt:new Date(Date.UTC(2026,10,4,1,0,index)).toISOString(),...(contentType?{contentType,observationIssue:'DM_CONTENT_UNVERIFIED'}:{}),...override}));
    return store.events().find(event=>event.payload.platformEventId===String(2000+index))!;
  };
  const send=(event:StoredEvent,status='CONFIRMED')=>{
    const draft=randomUUID(),intent=randomUUID(),text='confirmed synthetic answer',bound=snapshot(event.payload),at='2026-11-04T01:00:01.500Z';
    store.db.prepare("INSERT INTO reply_drafts VALUES(?,?,?,'mock',1,'APPROVED',?,NULL)")
      .run(draft,event.id,text,JSON.stringify({snapshot:bound,version:1,textDigest:digest(text)}));
    store.db.prepare('INSERT INTO send_intents VALUES(?,?,?,?,?,?,?,?)').run(intent,event.id,draft,targetKey(event.payload),digest(bound),digest(text),status,at);
    store.db.prepare('INSERT INTO delivery_receipts VALUES(?,?,?,?,?)').run(randomUUID(),intent,status,'synthetic',at);
    store.db.prepare('UPDATE inbound_events SET status=? WHERE id=?').run(status,event.id);
  };
  const read=(status='ALL')=>service.dispatch(token,{command:'getInbox',channel:'DIRECT_MESSAGE',status,page:0});
  const thread=(event:StoredEvent)=>service.dispatch(token,{command:'getThread',eventId:event.id});
  return {store,service,token,add,send,read,thread,close:async()=>{await service.close();store.close();}};
}

test.each(['IMAGE','MIXED','VIDEO','AUDIO'] as const)('%s without verified text is a manual view, not an automatic reply task',async kind=>{
  const f=await setup();try{
    const media=f.add(1,kind),before=f.store.event(media.id);
    expect(await f.read()).toMatchObject({total:1,items:[{id:media.id,replyStatus:'MANUAL_ONLY'}]});
    expect(await f.read('PENDING')).toMatchObject({total:0});expect(await f.read('CONFIRMED')).toMatchObject({total:0});
    expect(await f.thread(media)).toMatchObject({replyStatus:'MANUAL_ONLY',conversationReplyStatus:'MANUAL_ONLY'});
    expect(f.store.event(media.id)).toEqual(before);expect(f.store.budgets().every(b=>b.used===0)).toBe(true);
  }finally{await f.close();}
});

test('later unsupported media does not undo a confirmed text reply, but an unanswered text stays actionable',async()=>{
  const f=await setup();try{
    const text=f.add(1);f.send(text);const media=f.add(2,'IMAGE');
    expect(await f.read()).toMatchObject({items:[{replyStatus:'REPLIED'}]});
    expect(await f.thread(media)).toMatchObject({replyStatus:'MANUAL_ONLY',conversationReplyStatus:'REPLIED'});
    const unanswered=f.add(3);f.add(4,'VIDEO');
    expect(await f.read('PENDING')).toMatchObject({total:1,items:[{id:unanswered.id,replyStatus:'WAITING'}]});
  }finally{await f.close();}
});

test.each(['INTENT','COLLISION','MISSING_ACTOR','BINDING','FOLLOWUP'] as const)('manual-only classification cannot suppress unresolved or unbound evidence (%s)',async fault=>{
  const f=await setup();try{
    const media=f.add(1,'IMAGE',fault==='MISSING_ACTOR'?{actorId:null}:{});
    if(fault==='INTENT')f.send(media,'UNCERTAIN');
    if(fault==='COLLISION')f.store.db.prepare('INSERT INTO source_collisions VALUES(?,?,?,?,?)').run(randomUUID(),media.id,'other','{}','synthetic');
    if(fault==='BINDING')f.store.db.prepare("UPDATE inbound_events SET binding='changed' WHERE id=?").run(media.id);
    if(fault==='FOLLOWUP')f.store.db.prepare(`INSERT INTO human_reply_turns(command_id,event_id,target_key,operator_id,input_digest,params,text,version,status,created_at)
      VALUES(?,?,?,?,?,?,?,1,'UNCERTAIN',?)`).run(randomUUID(),media.id,targetKey(media.payload),'synthetic','synthetic','{}','one attempted followup',Date.now());
    expect(await f.read('PENDING')).toMatchObject({total:1,items:[{id:media.id,replyStatus:'WAITING'}]});
    expect(await f.thread(media)).toMatchObject({replyStatus:'WAITING',conversationReplyStatus:'WAITING'});
  }finally{await f.close();}
});

test.each([false,true])('manual media drafts remain the resume target with a later share (prior reply: %s)',async replied=>{
  const f=await setup();try{
    if(replied){const original=f.add(1);f.send(original);}
    const media=f.add(2,'IMAGE'),share=f.add(3,'IMAGE'),draft=randomUUID(),text='unfinished manual media response';
    f.store.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?)').run(randomUUID(),new Date().toISOString(),'INBOUND_DISPLAY_CLASSIFIED',share.id,
      JSON.stringify({binding:share.binding,eventType:'DOUYIN_WORK_SHARE'}));
    f.store.db.prepare("INSERT INTO reply_drafts VALUES(?,?,?,'human',1,'DRAFT',NULL,NULL)").run(draft,media.id,text);
    f.store.db.prepare('INSERT INTO draft_revisions VALUES(?,?,?,?,?,?)').run(draft,1,'HUMAN_TYPED',text,'fixture',Date.now());
    expect(await f.read()).toMatchObject({items:[{latestEventId:share.id,resumeEventId:media.id,replyStatus:replied?'REPLIED':'MANUAL_ONLY'}]});
    expect(f.store.db.prepare('SELECT text FROM reply_drafts WHERE id=?').get(draft)).toEqual({text});
  }finally{await f.close();}
});

test('manual-view filter selects only manual-only conversation groups and still finds them after marking read',async()=>{
  const f=await setup();try{
    const media=f.add(1,'IMAGE',{conversationId:'manual-image'}),voice=f.add(2,'AUDIO',{conversationId:'manual-voice'});
    f.add(3,undefined,{conversationId:'unanswered'});
    const replied=f.add(4,undefined,{conversationId:'already-replied'});f.send(replied);
    f.add(5,'MIXED',{conversationId:'already-replied'});
    const share=f.add(6,'IMAGE',{conversationId:'share-only'});
    f.store.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?)').run(randomUUID(),new Date().toISOString(),'INBOUND_DISPLAY_CLASSIFIED',share.id,
      JSON.stringify({binding:share.binding,eventType:'DOUYIN_WORK_SHARE'}));
    const unknown=f.add(7,'VIDEO',{conversationId:'unknown-receipt'});f.send(unknown,'UNCERTAIN');
    const before={events:f.store.events(),intents:f.store.db.prepare('SELECT * FROM send_intents').all(),receipts:f.store.db.prepare('SELECT * FROM delivery_receipts').all()};
    expect(await f.read('MANUAL_ONLY')).toMatchObject({total:2,items:[
      {id:voice.id,replyStatus:'MANUAL_ONLY',unread:true},{id:media.id,replyStatus:'MANUAL_ONLY',unread:true},
    ]});
    expect(await f.read('PENDING')).toMatchObject({total:2});
    expect(await f.read('CONFIRMED')).toMatchObject({total:1,items:[{replyStatus:'REPLIED'}]});
    expect(await f.read('ALL')).toMatchObject({total:6});
    await f.service.dispatch(f.token,{command:'markInboxRead'});
    expect(await f.read('UNREAD')).toMatchObject({total:0});
    expect(await f.read('MANUAL_ONLY')).toMatchObject({total:2,items:[
      {id:voice.id,replyStatus:'MANUAL_ONLY',unread:false},{id:media.id,replyStatus:'MANUAL_ONLY',unread:false},
    ]});
    expect({events:f.store.events(),intents:f.store.db.prepare('SELECT * FROM send_intents').all(),receipts:f.store.db.prepare('SELECT * FROM delivery_receipts').all()}).toEqual(before);
  }finally{await f.close();}
});
