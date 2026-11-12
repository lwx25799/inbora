import {expect,test} from 'vitest';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {candidate,database,pending,privateTemp,snapshot} from '../helpers.js';
import {digest,eventBinding,targetKey,type StoredEvent} from '../../src/core/contracts.js';

async function setup(){
  const store=database(),root=privateTemp('share-reply-projection-');
  await migrateClient(store,join(root,'client.sqlite'));
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();const token=service.authority.issueSession();
  const add=(index:number,media=false)=>{pending(store,candidate({platformEventId:String(1000+index),
    occurredAt:new Date(Date.UTC(2026,10,4,1,0,index)).toISOString(),text:media?'[图片或表情消息，需人工查看]':'synthetic incoming '+index,
    ...(media?{contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED'}:{})}));
    return store.events().find(event=>event.payload.platformEventId===String(1000+index))!;};
  const classify=(event:StoredEvent)=>store.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?)')
    .run(randomUUID(),new Date().toISOString(),'INBOUND_DISPLAY_CLASSIFIED',event.id,JSON.stringify({binding:event.binding,eventType:'DOUYIN_WORK_SHARE'}));
  const send=(event:StoredEvent,result:'CONFIRMED'|'UNCERTAIN')=>{
    const text='synthetic exact answer',draft=randomUUID(),id=randomUUID(),bound=snapshot(event.payload),at='2026-11-04T01:00:01.500Z';
    store.db.prepare("INSERT INTO reply_drafts VALUES(?,?,?,'mock',1,'APPROVED',?,NULL)")
      .run(draft,event.id,text,JSON.stringify({snapshot:bound,version:1,textDigest:digest(text)}));
    store.db.prepare('INSERT INTO send_intents VALUES(?,?,?,?,?,?,?,?)').run(id,event.id,draft,targetKey(event.payload),digest(bound),digest(text),result,at);
    store.db.prepare('INSERT INTO delivery_receipts VALUES(?,?,?,?,?)').run(randomUUID(),id,result,'synthetic proof',at);
    store.db.prepare('UPDATE inbound_events SET status=? WHERE id=?').run(result,event.id);return id;
  };
  const inbox=(status='ALL')=>service.dispatch(token,{command:'getInbox',channel:'DIRECT_MESSAGE',status,page:0}) as Promise<{
    total:number;items:{id:string;latestEventId:string;replyStatus:string;preview:string;messageCount:number}[];
  }>;
  const thread=(event:StoredEvent)=>service.dispatch(token,{command:'getThread',eventId:event.id}) as Promise<{
    replyStatus:string;conversationReplyStatus:string;frozen:boolean;timeline:{items:{eventId:string;direction:string}[]};
  }>;
  return{store,root,service,token,add,classify,send,inbox,thread,close:async()=>{await service.close();store.close();}};
}

test('a confirmed text reply followed by a classified share remains replied while retaining the share in history',async()=>{
  const f=await setup();try{
    const text=f.add(1);f.send(text,'CONFIRMED');const share=f.add(2,true);f.classify(share);
    const before={events:f.store.events(),intents:f.store.db.prepare('SELECT * FROM send_intents').all(),receipts:f.store.db.prepare('SELECT * FROM delivery_receipts').all(),budgets:f.store.budgets()};
    expect(await f.inbox()).toMatchObject({total:1,items:[{latestEventId:share.id,replyStatus:'REPLIED',messageCount:2}]});
    expect(await f.inbox('PENDING')).toMatchObject({total:0});expect(await f.inbox('CONFIRMED')).toMatchObject({total:1});
    const detail=await f.thread(share);expect(detail).toMatchObject({replyStatus:'NOT_REQUIRED',conversationReplyStatus:'REPLIED'});
    expect(detail.timeline.items.some(item=>item.eventId===share.id&&item.direction==='INCOMING')).toBe(true);
    expect({events:f.store.events(),intents:f.store.db.prepare('SELECT * FROM send_intents').all(),receipts:f.store.db.prepare('SELECT * FROM delivery_receipts').all(),budgets:f.store.budgets()}).toEqual(before);
  }finally{await f.close();}
});

test('a share-only conversation requires no automatic reply and cannot pretend that an answer was sent',async()=>{
  const f=await setup();try{
    const share=f.add(1,true);f.classify(share);
    expect(await f.inbox()).toMatchObject({total:1,items:[{id:share.id,replyStatus:'NOT_REQUIRED'}]});
    expect(await f.inbox('UNREAD')).toMatchObject({total:1});
    expect(await f.inbox('PENDING')).toMatchObject({total:0});expect(await f.inbox('CONFIRMED')).toMatchObject({total:0});
    expect(await f.thread(share)).toMatchObject({replyStatus:'NOT_REQUIRED',conversationReplyStatus:'NOT_REQUIRED'});
    expect(f.store.event(share.id).status).toBe('MANUAL_REVIEW');
  }finally{await f.close();}
});

test('a later share does not hide an earlier unanswered text or change its exact reply target',async()=>{
  const f=await setup();try{
    const text=f.add(1),share=f.add(2,true);f.classify(share);
    expect(await f.inbox('PENDING')).toMatchObject({total:1,items:[{id:text.id,latestEventId:share.id,replyStatus:'WAITING'}]});
    expect(await f.thread(share)).toMatchObject({replyStatus:'NOT_REQUIRED',conversationReplyStatus:'WAITING'});
  }finally{await f.close();}
});

test.each(['IMAGE','MIXED'] as const)('unclassified %s media keeps a manual-view label without undoing a confirmed text reply',async contentType=>{
  const f=await setup();try{
    const text=f.add(1);f.send(text,'CONFIRMED');
    const media=f.add(2,true);
    if(contentType==='MIXED'){
      const payload={...media.payload,contentType};
      f.store.db.prepare('UPDATE inbound_events SET payload=?,binding=? WHERE id=?').run(JSON.stringify(payload),eventBinding(payload),media.id);
    }
    expect(await f.inbox('PENDING')).toMatchObject({total:0});
    expect(await f.inbox('CONFIRMED')).toMatchObject({total:1,items:[{replyStatus:'REPLIED'}]});
    expect(await f.thread(f.store.event(media.id))).toMatchObject({replyStatus:'MANUAL_ONLY',conversationReplyStatus:'REPLIED'});
  }finally{await f.close();}
});

test.each(['INTENT','COLLISION','BINDING'] as const)('share display classification cannot conceal unresolved evidence: %s',async fault=>{
  const f=await setup();try{
    const share=f.add(1,true);f.classify(share);
    if(fault==='INTENT'){
      f.send(share,'UNCERTAIN');
    }
    if(fault==='COLLISION')f.store.db.prepare('INSERT INTO source_collisions VALUES(?,?,?,?,?)').run(randomUUID(),share.id,'other','{}','synthetic');
    if(fault==='BINDING')f.store.db.prepare("UPDATE inbound_events SET binding='different-binding' WHERE id=?").run(share.id);
    expect(await f.inbox('PENDING')).toMatchObject({total:1,items:[{id:share.id,replyStatus:'WAITING'}]});
    expect(await f.thread(f.store.event(share.id))).toMatchObject({replyStatus:'WAITING',conversationReplyStatus:'WAITING'});
  }finally{await f.close();}
});
