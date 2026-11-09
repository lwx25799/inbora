import {expect,test} from 'vitest';
import Database from 'better-sqlite3';
import {join} from 'node:path';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {candidate,database,privateTemp} from '../helpers.js';
import {ChatMessageStore} from '../../src/storage/chat-messages.js';
import {approved,pending,snapshot} from '../helpers.js';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {MessagePreviewStore} from '../../src/storage/message-previews.js';

test('automation version one upgrades with a consistent restorable backup while all business rows remain unchanged',async()=>{
  const store=database(),root=privateTemp('chat-migration-');
  try{
    await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'first-automation.sqlite'));
    store.db.exec(`DROP TABLE IF EXISTS budget_limits;DROP TABLE IF EXISTS chat_messages;DROP TABLE IF EXISTS chat_delivery_links;DROP TABLE automation_schema;
      CREATE TABLE automation_schema(version INTEGER PRIMARY KEY CHECK(version=1));INSERT INTO automation_schema VALUES(1);`);
    store.db.prepare("UPDATE budgets SET used=CASE kind WHEN 'MODEL' THEN 1 ELSE 9 END").run();
    const names=(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('automation_schema','audit_events') ORDER BY name").all() as {name:string}[]).map(row=>row.name);
    const inventory=()=>names.map(name=>[name,store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]);
    const before=inventory(),oldAudit=store.db.prepare('SELECT * FROM audit_events ORDER BY rowid').all(),backup=join(root,'schema-one.sqlite');
    expect(await migrateAutomation(store,backup)).toBe(true);
    expect(store.db.prepare('SELECT version FROM automation_schema').get()).toEqual({version:3});
    expect(store.db.pragma('user_version',{simple:true})).toBe(3);expect(store.db.pragma('quick_check',{simple:true})).toBe('ok');
    expect(inventory()).toEqual(before);expect(store.db.prepare('SELECT * FROM audit_events ORDER BY rowid').all().slice(0,oldAudit.length)).toEqual(oldAudit);
    const restored=new Database(backup,{readonly:true});try{
      expect(restored.pragma('quick_check',{simple:true})).toBe('ok');expect(restored.prepare('SELECT version FROM automation_schema').get()).toEqual({version:1});
      expect(names.map(name=>[name,restored.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])).toEqual(before);
    }finally{restored.close();}
    expect(await migrateAutomation(store,join(root,'no-replay.sqlite'))).toBe(false);
  }finally{store.close();}
});

test('observed own messages are deduplicated display data, while incoming tasks and AI history stay unchanged',async()=>{
  const store=database(),root=privateTemp('observed-own-chat-');
  try{
    const anchor=pending(store);await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
    const chat=new ChatMessageStore(store),origin=Date.parse('2026-11-04T00:00:00Z');
    const outgoing=candidate({actorId:'own-1',actorName:null,direction:'OUTGOING',platformEventId:'own-native-1'});
    const before={events:store.events(),history:store.history(store.event(anchor).payload),budgets:store.db.prepare('SELECT * FROM budgets').all()};
    chat.observe([outgoing,outgoing,{...outgoing,platformEventId:'not-own',actorId:'someone-else'},candidate()], 'own-1',origin);
    expect(store.db.prepare('SELECT count(*) AS n FROM chat_messages').get()).toEqual({n:1});
    const row=store.db.prepare('SELECT id FROM chat_messages').get() as {id:string};
    expect(chat.get(row.id)).toMatchObject({payload:outgoing,ownId:'own-1',historical:false});
    expect(store.events()).toEqual(before.events);expect(store.history(store.event(anchor).payload)).toEqual(before.history);
    expect(store.db.prepare('SELECT * FROM budgets').all()).toEqual(before.budgets);
    expect(()=>chat.observe([outgoing],'other-own',origin)).toThrow('ACCOUNT_CHANGED');
    chat.observe([{...outgoing,text:'changed same native message'}],'own-1',origin);
    expect(chat.get(row.id)).toBeNull();expect(store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
  }finally{store.close();}
});

test('native observed own messages merge with confirmed sends only by exact native ID, never by equal text',async()=>{
  const store=database(),draft=store.draft(approved(store)),event=store.event(draft.eventId);
  const intent=store.recordIntent(draft.id,snapshot(event.payload),false),root=privateTemp('own-chat-dedupe-');
  await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  store.receipt(intent,'CONFIRMED','synthetic-proof',{id:'confirmed-native-id',ownId:'own-1',targetKey:'dm:conversation-1',
    text:draft.text,pending:false,sentAt:new Date().toISOString()});
  const own=candidate({actorId:'own-1',actorName:null,direction:'OUTGOING',text:draft.text,platformEventId:'confirmed-native-id'});
  new ChatMessageStore(store).observe([own,{...own,platformEventId:'different-native-same-text'}],'own-1',Date.parse('2026-11-03T00:00:00Z'));
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();try{
    const thread=await service.dispatch(service.authority.issueSession(),{command:'getThread',eventId:event.id}) as {timeline:{items:{id:string;direction:string;origin:string;text:string}[]}};
    const outgoing=thread.timeline.items.filter(item=>item.direction==='OUTGOING');
    expect(outgoing).toHaveLength(2);expect(outgoing.every(item=>item.origin==='OBSERVED'&&item.text===draft.text)).toBe(true);
    expect(outgoing.every(item=>item.id.startsWith('observed:'))).toBe(true);
    expect(store.db.prepare('SELECT native_id_digest FROM chat_delivery_links WHERE intent_id=?').get(intent)).toBeTruthy();
  }finally{await service.close();store.close();}
});

test.each([0,10_000])('legacy confirmed display annotations do not duplicate observed native bubbles inside the send-time window (%s)',async offset=>{
  const store=database(),draft=store.draft(approved(store)),event=store.event(draft.eventId),root=privateTemp('legacy-own-bubble-');
  const intent=store.recordIntent(draft.id,snapshot(event.payload),false),boundary=Date.parse(event.payload.occurredAt!);
  store.db.prepare('UPDATE send_intents SET attempt_started_at=? WHERE id=?').run(new Date(boundary).toISOString(),intent);
  store.receipt(intent,'CONFIRMED','synthetic-legacy-confirmed-without-native-id');
  await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  const own=candidate({actorId:'own-1',direction:'OUTGOING',text:draft.text,platformEventId:'legacy-native-one',occurredAt:new Date(boundary+offset).toISOString()});
  new ChatMessageStore(store).observe([own,{...own,platformEventId:'legacy-native-two'}],'own-1',Date.parse('2026-11-03T00:00:00Z'));
  const before=store.db.prepare('SELECT * FROM send_intents').all(),receipts=store.db.prepare('SELECT * FROM delivery_receipts').all();
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();
  try{
    const detail=await service.dispatch(service.authority.issueSession(),{command:'getThread',eventId:event.id}) as {timeline:{items:{id:string;direction:string}[]}};
    const outgoing=detail.timeline.items.filter(item=>item.direction==='OUTGOING');
    expect(outgoing.filter(item=>item.id.startsWith('observed:'))).toHaveLength(2);
    expect(outgoing).toHaveLength(offset===0?2:3);
    expect(store.db.prepare('SELECT * FROM send_intents').all()).toEqual(before);expect(store.db.prepare('SELECT * FROM delivery_receipts').all()).toEqual(receipts);
    expect(store.db.prepare('SELECT count(*) n FROM chat_delivery_links').get()).toEqual({n:0});
  }finally{await service.close();store.close();}
});

test('observed own media has an exact controlled UUID for preview without becoming a reply task',async()=>{
  const store=database(),root=privateTemp('own-media-preview-'),anchor=pending(store);
  await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  const own=candidate({actorId:'own-1',actorName:null,direction:'OUTGOING',platformEventId:'own-native-image',
    text:'[图片或表情消息，需人工查看]',contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED'});
  new ChatMessageStore(store).observe([own],'own-1',Date.parse('2026-11-05T00:00:00Z'));
  const row=store.db.prepare('SELECT id FROM chat_messages').get() as {id:string};
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
  const cache=new MessagePreviewStore(root);cache.save(own,'own-1',[{label:'合成我方图片',png}]);const attachment=cache.list(own,'own-1')[0]!;
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();try{
    const token=service.authority.issueSession();
    expect(await service.dispatch(token,{command:'getMessagePreview',eventId:row.id,previewId:attachment.previewId})).toMatchObject({mime:'image/png',width:1,height:1});
    const thread=await service.dispatch(token,{command:'getThread',eventId:anchor}) as {timeline:{items:{eventId:string;historical:boolean;attachments:unknown[]}[]}};
    expect(thread.timeline.items.find(item=>item.eventId===row.id)).toMatchObject({historical:true,attachments:[attachment]});
    expect(store.events()).toHaveLength(1);expect(store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
  }finally{await service.close();store.close();}
});
