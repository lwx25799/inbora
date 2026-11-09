import {expect,test} from 'vitest';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {candidate,database,pending,privateTemp,approved,snapshot} from '../helpers.js';
import type {InboundEvent} from '../../src/core/contracts.js';
import {MessagePreviewStore} from '../../src/storage/message-previews.js';

interface Item {id:string;eventId:string;direction:string;text:string;historical:boolean}
interface Timeline {items:Item[];pageSize:number;hasMore:boolean;before:string|null;projectionRevision:string}
interface Inbox {total:number;items:{id:string;groupKey:string;latestEventId:string;resumeEventId:string|null;messageCount:number;replyStatus:string;preview:string}[]}
async function setup(){
  const root=privateTemp('conversation-inbox-'),store=database();
  await migrateClient(store,join(root,'migration.sqlite'));
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();
  const token=service.authority.issueSession();
  return {root,store,service,token,close:async()=>{await service.close();store.close();}};
}
const message=(index:number,conversationId='native-conversation')=>candidate({
  platformEventId:`native-${conversationId}-${index}`,conversationId,actorName:'Same display name',
  text:`message ${index}`,occurredAt:new Date(Date.UTC(2026,10,4,1,0,index)).toISOString(),
});

test('the complete backend groups native conversations before filtering and twenty-row pagination',async()=>{
  const f=await setup();try{
    const ids=Array.from({length:25},(_,i)=>pending(f.store,message(i)));
    f.store.db.prepare("UPDATE inbound_events SET status='CONFIRMED' WHERE id=?").run(ids.at(-1));
    const other=pending(f.store,message(1,'another-native-conversation'));
    const commentIds=['work-a','work-b'].map((videoId,index)=>pending(f.store,candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',
      platformEventId:`notification-${videoId}`,videoId,commentId:'same-parent-id',conversationId:null,
      occurredAt:new Date(Date.UTC(2026,10,4,1,1,index)).toISOString()})));
    const inbox=await f.service.dispatch(f.token,{command:'getInbox',channel:'ALL',status:'ALL',page:0}) as Inbox;
    expect(inbox.total).toBe(4);expect(inbox.items).toHaveLength(4);
    expect(inbox.items.find(row=>row.latestEventId===ids.at(-1))).toMatchObject({
      id:ids.at(-1),messageCount:25,replyStatus:'REPLIED',preview:'message 24',groupKey:expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(new Set(inbox.items.map(row=>row.id))).toEqual(new Set([ids.at(-1),other,...commentIds]));
    expect(await f.service.dispatch(f.token,{command:'getInbox',channel:'DIRECT_MESSAGE',status:'CONFIRMED',page:0})).toMatchObject({total:1});
    const groupKeys=inbox.items.map(row=>row.groupKey);expect(new Set(groupKeys).size).toBe(4);
    expect(await f.service.dispatch(f.token,{command:'getInbox',channel:'ALL',status:'ALL',page:1})).toMatchObject({total:4,items:[]});
  }finally{await f.close();}
});

test('an older late backfill remains waiting after a newer incoming message had already been replied',async()=>{
  const f=await setup();try{
    const origin=message(0);f.store.observe(origin.channel,origin.conversationId!,[],'own-1','synthetic-origin',origin.occurredAt!);
    const newest=pending(f.store,message(20));f.store.db.prepare("UPDATE inbound_events SET status='CONFIRMED' WHERE id=?").run(newest);
    const late=message(10);f.store.observe(late.channel,late.conversationId!,[late],'own-1','synthetic-late-backfill');
    const lateId=f.store.events().at(-1)!.id;
    expect(await f.service.dispatch(f.token,{command:'getInbox',channel:'DIRECT_MESSAGE',status:'PENDING',page:0})).toMatchObject({
      total:1,items:[{id:lateId,latestEventId:newest,replyStatus:'WAITING'}],
    });
    expect(f.store.event(newest).status).toBe('CONFIRMED');expect(f.store.event(lateId).status).toBe('MANUAL_REVIEW');
  }finally{await f.close();}
});

test('pagination counts native conversation groups rather than raw message windows',async()=>{
  const f=await setup();try{
    for(let peer=0;peer<24;peer++)for(let index=0;index<3;index++)pending(f.store,message(index,`conversation-${peer}`));
    const pages=await Promise.all([0,1].map(page=>f.service.dispatch(f.token,{command:'getInbox',channel:'DIRECT_MESSAGE',status:'PENDING',page}) as Promise<Inbox>));
    expect(pages.map(page=>page.total)).toEqual([24,24]);expect(pages.map(page=>page.items.length)).toEqual([20,4]);
    expect(new Set(pages.flatMap(page=>page.items.map(item=>item.groupKey))).size).toBe(24);
    expect(pages.flatMap(page=>page.items).every(item=>item.messageCount===3)).toBe(true);
  }finally{await f.close();}
});

test('local timeline pages all received messages beyond AI context and preserves baseline task status',async()=>{
  const f=await setup();try{
    const old=message(-20);f.store.observe(old.channel,old.conversationId!,[old],'own-1','synthetic-baseline');
    const baseline=f.store.events()[0]!;
    const ids=Array.from({length:35},(_,i)=>pending(f.store,message(i)));
    pending(f.store,message(2,'unrelated-native-conversation'));
    const eventId=ids.at(-1)!;
    const latest=await f.service.dispatch(f.token,{command:'getThread',eventId}) as {groupKey:string;timeline:Timeline;history:InboundEvent[]};
    expect(latest.timeline).toMatchObject({pageSize:30,hasMore:true,before:expect.any(String)});
    expect(latest.timeline.items.map(row=>row.eventId)).toEqual(ids.slice(5));expect(latest.history.length).toBeLessThan(30);
    const earlier=await f.service.dispatch(f.token,{command:'getThread',eventId,timelineBefore:latest.timeline.before}) as {timeline:Timeline};
    expect(earlier.timeline).toMatchObject({hasMore:false,before:null});
    expect(earlier.timeline.items.map(row=>row.eventId)).toEqual([baseline.id,...ids.slice(0,5)]);
    expect(earlier.timeline.items[0]).toMatchObject({historical:true,direction:'INCOMING'});
    expect(f.store.event(baseline.id).status).toBe('BASELINE');
    expect((await f.service.dispatch(f.token,{command:'getInbox',channel:'DIRECT_MESSAGE',status:'ALL',page:0}) as Inbox).total).toBe(2);
    const other=f.store.events().at(-1)!;
    await expect(f.service.dispatch(f.token,{command:'getThread',eventId:other.id,timelineBefore:latest.timeline.before})).rejects.toThrow('TIMELINE_CURSOR_INVALID');
    await expect(f.service.dispatch(f.token,{command:'getThread',eventId,timelineBefore:'not-a-valid-cursor'})).rejects.toThrow('TIMELINE_CURSOR_INVALID');
    expect(f.store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
    expect(f.store.db.prepare('SELECT used FROM budgets ORDER BY kind').all()).toEqual([{used:0},{used:0}]);
  }finally{await f.close();}
});

test('same conversation newest incoming does not rewrite selected draft intent or unknown status',async()=>{
  const store=database(),draft=store.draft(approved(store,message(1))),event=store.event(draft.eventId);
  const intent=store.recordIntent(draft.id,snapshot(event.payload),false);store.receipt(intent,'UNCERTAIN','synthetic-unknown');
  const root=privateTemp('conversation-frozen-');await migrateClient(store,join(root,'migration.sqlite'));
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();const token=service.authority.issueSession();
  try{
    const original=store.event(event.id),receipt=store.receiptForEvent(event.id),saved=store.draft(draft.id);
    const newest=pending(store,message(2));
    const inbox=await service.dispatch(token,{command:'getInbox',channel:'DIRECT_MESSAGE',status:'PENDING',page:0}) as Inbox;
    expect(inbox).toMatchObject({total:1,items:[{id:newest,latestEventId:newest,messageCount:2,replyStatus:'WAITING'}]});
    const thread=await service.dispatch(token,{command:'getThread',eventId:event.id}) as {event:{id:string};timeline:Timeline;frozen:boolean};
    expect(thread.event.id).toBe(event.id);expect(thread.frozen).toBe(true);
    expect(thread.timeline.items.map(row=>row.eventId)).toEqual([event.id,newest]);
    expect(thread.timeline.items.every(row=>row.direction==='INCOMING')).toBe(true);
    expect(store.event(event.id)).toEqual(original);expect(store.draft(draft.id)).toEqual(saved);expect(store.receiptForEvent(event.id)).toEqual(receipt);
    store.db.prepare("UPDATE inbound_events SET status='CONFIRMED' WHERE id=?").run(newest);
    expect(await service.dispatch(token,{command:'getInbox',channel:'DIRECT_MESSAGE',status:'PENDING',page:0})).toMatchObject({
      total:1,items:[{id:event.id,latestEventId:newest,replyStatus:'WAITING'}],
    });
  }finally{await service.close();store.close();}
});

test('timeline includes confirmed own replies and follow-up proof, while later contradiction removes only the projection',async()=>{
  const store=database(),draft=store.draft(approved(store,message(1))),event=store.event(draft.eventId);
  const intent=store.recordIntent(draft.id,snapshot(event.payload),false);store.receipt(intent,'UNCERTAIN','synthetic-unknown');
  const root=privateTemp('conversation-proof-');await migrateClient(store,join(root,'migration.sqlite'));
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();const token=service.authority.issueSession();
  try{
    store.db.prepare('INSERT INTO verification_results VALUES(?,?,?,?,?)').run(randomUUID(),intent,1,'synthetic-confirmation',Date.now());
    let thread=await service.dispatch(token,{command:'getThread',eventId:event.id}) as {timeline:Timeline};
    expect(thread.timeline.items.filter(row=>row.direction==='OUTGOING')).toEqual([expect.objectContaining({id:`out:${intent}`,eventId:event.id,text:draft.text})]);
    expect(await service.dispatch(token,{command:'getInbox',channel:'DIRECT_MESSAGE',status:'CONFIRMED',page:0})).toMatchObject({total:1,items:[{id:event.id,replyStatus:'REPLIED'}]});
    store.db.prepare('INSERT INTO verification_results VALUES(?,?,?,?,?)').run(randomUUID(),intent,0,'synthetic-contradiction',Date.now()+1);
    thread=await service.dispatch(token,{command:'getThread',eventId:event.id}) as {timeline:Timeline};
    expect(thread.timeline.items.filter(row=>row.direction==='OUTGOING')).toEqual([]);
    expect(store.event(event.id).status).toBe('UNCERTAIN');expect(store.receiptForEvent(event.id)).toMatchObject({result:'UNCERTAIN'});
  }finally{await service.close();store.close();}
});

test('timeline cursor remains stable after fresh arrivals and weak unknown conversations remain separate',async()=>{
  const f=await setup();try{
    const ids=Array.from({length:35},(_,i)=>pending(f.store,message(i)));
    const latest=await f.service.dispatch(f.token,{command:'getThread',eventId:ids.at(-1)}) as {timeline:Timeline};
    pending(f.store,message(40));
    const earlier=await f.service.dispatch(f.token,{command:'getThread',eventId:ids[0],timelineBefore:latest.timeline.before}) as {timeline:Timeline};
    expect(earlier.timeline.items.map(item=>item.eventId)).toEqual(ids.slice(0,5));
    const weak=[50,51].map(index=>{
      const event={...message(index),conversationId:null};
      f.store.observe(event.channel,'weak-synthetic',[event],'own-1','synthetic-weak');
      return f.store.events().at(-1)!;
    });
    const inbox=await f.service.dispatch(f.token,{command:'getInbox',channel:'DIRECT_MESSAGE',status:'ALL',page:0}) as Inbox;
    expect(inbox.total).toBe(3);
    expect(new Set(inbox.items.map(row=>row.groupKey)).size).toBe(3);
    const detail=await f.service.dispatch(f.token,{command:'getThread',eventId:weak[0]!.id}) as {timeline:Timeline};
    expect(detail.timeline.items.map(item=>item.eventId)).toEqual([weak[0]!.id]);
    expect(f.store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
  }finally{await f.close();}
});

test('confirmed own replies are displayed once without exposing unapproved draft revisions or another target',async()=>{
  const store=database(),draft=store.draft(approved(store,message(1))),event=store.event(draft.eventId);
  const intent=store.recordIntent(draft.id,snapshot(event.payload),false);store.receipt(intent,'CONFIRMED','synthetic-confirmed');
  const root=privateTemp('conversation-confirmed-');await migrateClient(store,join(root,'migration.sqlite'));
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();const token=service.authority.issueSession();
  try{
    const another=pending(store,message(2,'different-conversation'));
    const original=await service.dispatch(token,{command:'getThread',eventId:event.id}) as {timeline:Timeline};
    expect(original.timeline.items.filter(item=>item.direction==='OUTGOING')).toEqual([expect.objectContaining({id:`out:${intent}`,text:draft.text})]);
    const other=await service.dispatch(token,{command:'getThread',eventId:another}) as {timeline:Timeline};
    expect(other.timeline.items.map(item=>item.eventId)).toEqual([another]);
    store.db.prepare('UPDATE reply_drafts SET text=? WHERE id=?').run('synthetic corrupt later text',draft.id);
    const changed=await service.dispatch(token,{command:'getThread',eventId:event.id}) as {timeline:Timeline};
    expect(changed.timeline.items.filter(item=>item.direction==='OUTGOING')).toEqual([]);
  }finally{await service.close();store.close();}
});

test('local media preview is read-only and bound to the exact persisted message and authorized account',async()=>{
  const f=await setup();try{
    const media=candidate({...message(1),text:'[图片/表情消息，需人工查看]',contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED'});
    f.store.observe(media.channel,media.conversationId!,[media],'own-1','synthetic-media');
    const event=f.store.events()[0]!,cache=new MessagePreviewStore(f.root);
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
    cache.save(media,'own-1',[{label:'合成图片',png,width:1,height:1}]);
    const attachment=cache.list(media,'own-1')[0]!;expect(attachment.previewId).toMatch(/^[a-f0-9]{64}$/);
    const detail=await f.service.dispatch(f.token,{command:'getThread',eventId:event.id}) as {timeline:{items:{attachments:unknown[]}[]}};
    expect(detail.timeline.items[0]!.attachments).toEqual([attachment]);
    expect(await f.service.dispatch(f.token,{command:'getMessagePreview',eventId:event.id,previewId:attachment.previewId})).toMatchObject({
      previewId:attachment.previewId,mime:'image/png',width:1,height:1,dataUrl:'data:image/png;base64,'+png.toString('base64'),
    });
    const other={...media,platformEventId:'other-native-media-id'};
    f.store.observe(other.channel,other.conversationId!,[other],'own-1','synthetic-other');const otherId=f.store.events().at(-1)!.id;
    await expect(f.service.dispatch(f.token,{command:'getMessagePreview',eventId:otherId,previewId:attachment.previewId})).rejects.toThrow('MESSAGE_PREVIEW_UNAVAILABLE');
    const controlOnly=f.service.authority.issueSession(['CONTROL']);
    await expect(f.service.dispatch(controlOnly,{command:'getMessagePreview',eventId:event.id,previewId:attachment.previewId})).rejects.toThrow('OPERATOR_PERMISSION_DENIED');
    await expect(f.service.dispatch(f.token,{command:'getMessagePreview',eventId:event.id,previewId:'../../private'})).rejects.toThrow();
    expect(f.store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
    expect(f.store.db.prepare('SELECT used FROM budgets ORDER BY kind').all()).toEqual([{used:0},{used:0}]);
    expect(()=>f.store.assertModelObservation(media)).toThrow('DM_CONTENT_UNVERIFIED');
  }finally{await f.close();}
});

test('saved A draft resumes its original editor after a newer same-conversation arrival and a switch through B',async()=>{
  const f=await setup();try{
    const a=pending(f.store,message(1)),b=pending(f.store,message(1,'conversation-b'));
    await f.service.dispatch(f.token,{command:'setMode',mode:'MANUAL'});
    const detail=await f.service.dispatch(f.token,{command:'openHumanDialog',eventId:a,selectionId:randomUUID()}) as {ownership:{generation:number}};
    const saved=await f.service.dispatch(f.token,{command:'saveDraft',eventId:a,generation:detail.ownership.generation,
      expectedVersion:0,text:'saved original A human text',suggestionId:null});
    const newer=pending(f.store,message(2));
    await f.service.dispatch(f.token,{command:'openHumanDialog',eventId:b,selectionId:randomUUID()});
    const inbox=await f.service.dispatch(f.token,{command:'getInbox',channel:'DIRECT_MESSAGE',status:'PENDING',page:0}) as Inbox;
    const row=inbox.items.find(item=>item.latestEventId===newer)!;
    expect(row).toMatchObject({id:newer,latestEventId:newer,resumeEventId:a,preview:'message 2',replyStatus:'WAITING'});
    const resumed=await f.service.dispatch(f.token,{command:'openHumanDialog',eventId:row.resumeEventId,selectionId:randomUUID()}) as {event:{id:string};draft:unknown};
    expect(resumed.event.id).toBe(a);expect(resumed.draft).toEqual(saved);
    expect(f.store.db.prepare('SELECT count(*) AS n FROM reply_drafts').get()).toEqual({n:1});
    expect(f.store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
  }finally{await f.close();}
});

test('confirmation of a later incoming message never revives an older saved draft on the next waiting arrival',async()=>{
  const store=database(),old=pending(store,message(1)),oldDraft=store.saveDraft(old,'old retained legacy text','mock');
  const latestDraft=store.draft(approved(store,message(2))),latest=store.event(latestDraft.eventId);
  const intent=store.recordIntent(latestDraft.id,snapshot(latest.payload),false);store.receipt(intent,'CONFIRMED','synthetic-confirmed');
  const root=privateTemp('chat-draft-confirmation-');await migrateClient(store,join(root,'client.sqlite'));
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();const token=service.authority.issueSession();
  try{
    expect(await service.dispatch(token,{command:'getInbox',channel:'DIRECT_MESSAGE',status:'CONFIRMED',page:0})).toMatchObject({
      total:1,items:[{id:latest.id,resumeEventId:null,replyStatus:'REPLIED'}],
    });
    const newer=pending(store,message(3));
    expect(await service.dispatch(token,{command:'getInbox',channel:'DIRECT_MESSAGE',status:'PENDING',page:0})).toMatchObject({
      total:1,items:[{id:newer,resumeEventId:null,replyStatus:'WAITING'}],
    });
    expect(service.authority.draftFor(old)).toMatchObject({id:oldDraft.id,text:'old retained legacy text',origin:'LEGACY',version:1});
    expect(store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:1});
  }finally{await service.close();store.close();}
});

test('an older message proof contradiction changes only its exact conversation projection while selection stays unchanged',async()=>{
  const store=database(),draft=store.draft(approved(store,message(1))),old=store.event(draft.eventId);
  const intent=store.recordIntent(draft.id,snapshot(old.payload),false);store.receipt(intent,'UNCERTAIN','synthetic-unknown');
  const root=privateTemp('timeline-projection-');await migrateClient(store,join(root,'client.sqlite'));
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();const token=service.authority.issueSession();
  try{
    const current=pending(store,message(35)),unrelated=pending(store,message(1,'unrelated-conversation'));
    store.db.prepare('INSERT INTO verification_results VALUES(?,?,?,?,?)').run(randomUUID(),intent,1,'synthetic-confirmed',Date.now());
    const get=(eventId:string)=>service.dispatch(token,{command:'getThread',eventId}) as Promise<{event:{id:string};draft:unknown;timeline:Timeline}>;
    const before=await get(current),unrelatedBefore=await get(unrelated);
    expect(before.timeline.projectionRevision).toMatch(/^[a-f0-9]{64}$/);
    store.db.prepare('INSERT INTO verification_results VALUES(?,?,?,?,?)').run(randomUUID(),intent,0,'synthetic-later-contradiction',Date.now()+1);
    const after=await get(current),unrelatedAfter=await get(unrelated);
    expect(after.event.id).toBe(current);expect(after.draft).toEqual(before.draft);
    expect(after.timeline.projectionRevision).not.toBe(before.timeline.projectionRevision);
    expect(unrelatedAfter.timeline.projectionRevision).toBe(unrelatedBefore.timeline.projectionRevision);
  }finally{await service.close();store.close();}
});
