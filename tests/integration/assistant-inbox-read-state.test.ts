import {expect,test} from 'vitest';
import {join} from 'node:path';
import {EventStore} from '../../src/storage/store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {inboxReadBoundary,markInboxRead,scopedReadEventIds} from '../../src/app/inbox-read-state.js';
import {candidate,pending,privateTemp} from '../helpers.js';

async function setup(){
  const root=privateTemp('assistant-read-'),file=join(root,'poc.sqlite'),store=new EventStore(file,true);
  await migrateClient(store,join(root,'schema3.sqlite'));
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();
  const token=service.authority.issueSession();
  const inbox=()=>service.dispatch(token,{command:'getInbox',channel:'ALL',status:'UNREAD',page:0}) as
    Promise<{total:number;items:{id:string;unread:boolean}[]}>;
  return {root,file,store,service,inbox,close:async()=>{await service.close();store.close();}};
}

test('assistant marks only its exact allowed messages and preserves other channels, drafts and budget rows',async()=>{
  const f=await setup();try{
    const dm=pending(f.store,candidate({platformEventId:'allowed'}));
    const comment=pending(f.store,candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',conversationId:null,
      videoId:'synthetic-work',commentId:'synthetic-comment',platformEventId:'comment-outside-scope'}));
    const old=pending(f.store,candidate({conversationId:'old-peer',platformEventId:'old-before-scope'}));
    const original=f.store.db.prepare('SELECT * FROM inbound_events ORDER BY rowid').all();
    const budget=f.store.db.prepare('SELECT * FROM budgets ORDER BY kind').all();
    expect(markInboxRead(f.store,[dm,dm,'nonexistent'])).toEqual({marked:1});
    expect(inboxReadBoundary(f.store)).toBe(0);
    expect((await f.inbox()).items.map(row=>row.id).sort()).toEqual([comment,old].sort());
    expect(markInboxRead(f.store,[dm])).toEqual({marked:0});
    expect(f.store.db.prepare('SELECT * FROM inbound_events ORDER BY rowid').all()).toEqual(original);
    expect(f.store.db.prepare('SELECT * FROM budgets ORDER BY kind').all()).toEqual(budget);
    expect(f.store.db.prepare('SELECT count(*) count FROM send_intents').get()).toEqual({count:0});
  }finally{await f.close();}
});

test('new arrivals after an explicit scope snapshot remain unread, including the same conversation',async()=>{
  const f=await setup();try{
    const first=pending(f.store,candidate({platformEventId:'snapshot-first'})),snapshot=[first];
    const later=pending(f.store,candidate({platformEventId:'snapshot-later',occurredAt:'2026-11-04T02:00:00Z'}));
    expect(markInboxRead(f.store,snapshot)).toEqual({marked:1});
    expect(await f.inbox()).toMatchObject({total:1,items:[{id:later,unread:true}]});
    expect(markInboxRead(f.store,[later])).toEqual({marked:1});
    expect(await f.inbox()).toMatchObject({total:0});
  }finally{await f.close();}
});

test('scoped read survives restart and an ordinary GUI mark still covers the whole account',async()=>{
  const f=await setup(),first=pending(f.store,candidate({platformEventId:'scoped'}));
  pending(f.store,candidate({conversationId:'other-peer',platformEventId:'outside'}));
  markInboxRead(f.store,[first]);await f.close();
  const store=new EventStore(f.file),service=new ClientService(store,new BrowserService(f.root));await service.loadSettings();
  const token=service.authority.issueSession();
  try{
    expect(scopedReadEventIds(store).size).toBe(1);
    expect(await service.dispatch(token,{command:'getInbox',channel:'ALL',status:'UNREAD',page:0})).toMatchObject({total:1});
    expect(await service.dispatch(token,{command:'markInboxRead'})).toEqual({marked:1});
    expect(inboxReadBoundary(store)).toBeGreaterThan(0);
    expect(scopedReadEventIds(store).size).toBe(0);
    expect(await service.dispatch(token,{command:'getInbox',channel:'ALL',status:'UNREAD',page:0})).toMatchObject({total:0});
    pending(store,candidate({platformEventId:'fresh',occurredAt:'2026-11-04T02:00:00Z'}));
    expect(await service.dispatch(token,{command:'getInbox',channel:'ALL',status:'UNREAD',page:0})).toMatchObject({total:1});
  }finally{await service.close();store.close();}
});

test('empty scope has no effect and large exact scopes are stored in bounded local identifier chunks',async()=>{
  const f=await setup();try{
    const ids=Array.from({length:405},(_,i)=>pending(f.store,candidate({platformEventId:`chunk-${i}`,conversationId:`peer-${i}`})));
    expect(markInboxRead(f.store,[])).toEqual({marked:0});
    expect(markInboxRead(f.store,ids)).toEqual({marked:405});
    const rows=f.store.db.prepare("SELECT detail_redacted FROM audit_events WHERE event_type='INBOX_SCOPE_MARKED_READ'").all() as {detail_redacted:string}[];
    expect(rows).toHaveLength(3);
    expect(rows.map(row=>JSON.parse(row.detail_redacted).eventIds.length)).toEqual([200,200,5]);
    expect(rows.every(row=>!row.detail_redacted.includes('chunk-')&&!row.detail_redacted.includes('peer-'))).toBe(true);
    expect(await f.inbox()).toMatchObject({total:0});
  }finally{await f.close();}
});
