import {expect,test} from 'vitest';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {EventStore} from '../../src/storage/store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {approved,candidate,pending,privateTemp,snapshot} from '../helpers.js';

interface Inbox {total:number;unreadTotal:number;items:{id:string;unread:boolean;replyStatus:string}[]}
async function setup(){
  const root=privateTemp('inbox-read-'),file=join(root,'poc.sqlite'),store=new EventStore(file,true);
  await migrateClient(store,join(root,'schema3.sqlite'));
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();
  const token=service.authority.issueSession();
  const read=(status='UNREAD',page=0)=>service.dispatch(token,{command:'getInbox',channel:'ALL',status,page}) as Promise<Inbox>;
  return {root,file,store,service,token,read,close:async()=>{await service.close();store.close();}};
}

test('mark all read clears both channels beyond the first page without changing reply state or stored messages',async()=>{
  const f=await setup();try{
    const ids=Array.from({length:24},(_,i)=>pending(f.store,candidate({platformEventId:`read-${i}`,conversationId:`peer-${i}`})));
    ids.push(pending(f.store,candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',conversationId:null,videoId:'work',commentId:'comment',platformEventId:'comment'})));
    f.store.db.prepare("UPDATE inbound_events SET status='CONFIRMED' WHERE id=?").run(ids[0]);
    f.store.db.prepare("UPDATE inbound_events SET status='UNCERTAIN' WHERE id=?").run(ids[1]);
    const original=f.store.db.prepare('SELECT * FROM inbound_events ORDER BY rowid').all();
    const before=await f.read();expect(before).toMatchObject({total:25,unreadTotal:25});
    expect(before.items).toHaveLength(20);expect(before.items.every(row=>row.unread)).toBe(true);
    const updates:string[]=[];f.service.events.on('update',(event:{event:string})=>updates.push(event.event));
    expect(await f.service.dispatch(f.token,{command:'markInboxRead'})).toMatchObject({marked:25});
    expect(updates).toContain('inbox_updated');
    expect(await f.read()).toMatchObject({total:0,unreadTotal:0,items:[]});
    const all=await f.read('ALL');expect(all.total).toBe(25);expect(all.items.every(row=>!row.unread)).toBe(true);
    expect(await f.read('CONFIRMED')).toMatchObject({total:1,items:[{replyStatus:'REPLIED',unread:false}]});
    expect(await f.read('PENDING')).toMatchObject({total:24});
    expect(f.store.db.prepare('SELECT * FROM inbound_events ORDER BY rowid').all()).toEqual(original);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
    expect(f.store.db.prepare('SELECT kind,used FROM budgets ORDER BY kind').all()).toEqual([{kind:'MODEL',used:0},{kind:'SEND',used:0}]);
  }finally{await f.close();}
});

test('read boundary survives database reopening and a new arrival reappears in the same native conversation',async()=>{
  const f=await setup();
  pending(f.store,candidate());
  await f.service.dispatch(f.token,{command:'markInboxRead'});
  expect(await f.service.dispatch(f.token,{command:'markInboxRead'})).toMatchObject({marked:0});
  expect(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='INBOX_MARKED_READ'").get()).toEqual({n:1});
  await f.close();
  const store=new EventStore(f.file),service=new ClientService(store,new BrowserService(f.root));await service.loadSettings();
  const token=service.authority.issueSession();
  try{
    expect(await service.dispatch(token,{command:'getInbox',channel:'ALL',status:'UNREAD',page:0})).toMatchObject({total:0});
    const eventId=pending(store,candidate({platformEventId:'after-read',occurredAt:'2026-11-04T02:00:00Z'}));
    expect(await service.dispatch(token,{command:'getInbox',channel:'ALL',status:'UNREAD',page:0})).toMatchObject({
      total:1,unreadTotal:1,items:[{latestEventId:eventId,unread:true,replyStatus:'WAITING'}],
    });
    expect(store.events()).toHaveLength(2);
  }finally{await service.close();store.close();}
});

test('mark read requires editing permission and refuses caller-supplied read boundaries',async()=>{
  const f=await setup();try{
    pending(f.store,candidate());
    const reader=f.service.authority.issueSession(['READ']);
    await expect(f.service.dispatch(reader,{command:'markInboxRead'})).rejects.toThrow('OPERATOR_PERMISSION_DENIED');
    await expect(f.service.dispatch(f.token,{command:'markInboxRead',through:1_000_000})).rejects.toThrow();
    expect(await f.read()).toMatchObject({total:1,unreadTotal:1});
    expect(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='INBOX_MARKED_READ'").get()).toEqual({n:0});
  }finally{await f.close();}
});

test('mark read preserves an existing human draft, selection and unknown receipt while later arrivals remain unread',async()=>{
  const root=privateTemp('inbox-read-existing-'),store=new EventStore(join(root,'poc.sqlite'),true);
  const submitted=store.draft(approved(store,candidate({platformEventId:'submitted',conversationId:'unknown-peer'})));
  const intent=store.recordIntent(submitted.id,snapshot(store.event(submitted.eventId).payload),false);
  store.receipt(intent,'UNCERTAIN','synthetic-unknown');
  await migrateClient(store,join(root,'schema3.sqlite'));
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();
  const token=service.authority.issueSession();
  try{
    const eventId=pending(store,candidate({platformEventId:'human-draft',conversationId:'draft-peer'}));
    const selectionId=randomUUID();service.authority.setMode(token,'MANUAL');service.authority.select(token,eventId,selectionId);
    const owner=service.authority.claim(token,eventId,0);
    service.authority.save(token,eventId,owner.generation,0,'还没有发出的人工草稿 👩‍🚒');
    const tables=['inbound_events','reply_drafts','send_intents','delivery_receipts','draft_revisions','thread_ownership','budgets','automation_jobs'];
    const state=()=>Object.fromEntries(tables.map(table=>[table,store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const before=state();
    expect(await service.dispatch(token,{command:'markInboxRead'})).toMatchObject({marked:2});
    expect(state()).toEqual(before);
    expect(()=>service.authority.requireSelection(token,eventId,selectionId)).not.toThrow();
    expect(store.sendFrozen(submitted.eventId)).toBe(true);
    expect(await service.dispatch(token,{command:'getInbox',channel:'ALL',status:'UNREAD',page:0})).toMatchObject({total:0});
    const fresh=pending(store,candidate({platformEventId:'after-click',conversationId:'draft-peer',occurredAt:'2026-11-04T02:00:00Z'}));
    expect(await service.dispatch(token,{command:'getInbox',channel:'ALL',status:'UNREAD',page:0})).toMatchObject({total:1,items:[{latestEventId:fresh,unread:true}]});
    expect(service.authority.draftFor(eventId)).toMatchObject({text:'还没有发出的人工草稿 👩‍🚒',status:'DRAFT'});
    expect(store.receiptForEvent(submitted.eventId)).toMatchObject({result:'UNCERTAIN',proof_ref:'synthetic-unknown'});
    expect(()=>service.authority.requireSelection(token,eventId,selectionId)).not.toThrow();
  }finally{await service.close();store.close();}
});
