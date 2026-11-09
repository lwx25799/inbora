import {expect,test} from 'vitest';
import {join} from 'node:path';
import {digest,targetKey} from '../../src/core/contracts.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {ChatMessageStore} from '../../src/storage/chat-messages.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {VerificationScheduler} from '../../src/app/verification-scheduler.js';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {approved,candidate,database,privateTemp,snapshot} from '../helpers.js';

async function fixture(){
  const store=database(),draft=store.draft(approved(store)),event=store.event(draft.eventId),root=privateTemp('chat-followup-link-');
  const intent=store.recordIntent(draft.id,snapshot(event.payload),false);store.receipt(intent,'UNCERTAIN','synthetic-original-unknown');
  await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  let now=Date.now();const data=new AutomationStore(store,()=>now);data.initialize(now);
  return {store,draft,event,root,intent,data,due:()=>{now+=2000;}};
}

test('verified follow-up links the exact native own message without merging a different ID with the same text',async()=>{
  const f=await fixture(),before=f.store.db.prepare('SELECT * FROM send_intents').all(),receipt=f.store.db.prepare('SELECT * FROM delivery_receipts').all();
  const worker=new VerificationScheduler(f.data,async()=>({verified:true,evidenceId:'synthetic-complete-proof',nativeIdDigest:digest('native-proven')}));
  let service:ClientService|undefined;
  try{
    worker.enqueue(f.event.id);f.due();await worker.tick();
    expect(f.store.db.prepare('SELECT native_id_digest FROM chat_delivery_links WHERE intent_id=?').get(f.intent)).toEqual({native_id_digest:digest('native-proven')});
    const own=candidate({actorId:'own-1',direction:'OUTGOING',text:f.draft.text,platformEventId:'native-proven'});
    new ChatMessageStore(f.store).observe([own,{...own,platformEventId:'different-native-same-text'}],'own-1',Date.parse('2026-11-03T00:00:00Z'));
    service=new ClientService(f.store,new BrowserService(f.root));await service.loadSettings();const token=service.authority.issueSession();
    const detail=await service.dispatch(token,{command:'getThread',eventId:f.event.id}) as {timeline:{items:{id:string;direction:string;text:string}[]};frozen:boolean};
    expect(detail.timeline.items.filter(item=>item.direction==='OUTGOING')).toHaveLength(2);
    expect(detail.timeline.items.filter(item=>item.direction==='OUTGOING').every(item=>item.id.startsWith('observed:')&&item.text===f.draft.text)).toBe(true);
    expect(detail.frozen).toBe(true);expect(f.store.db.prepare('SELECT * FROM send_intents').all()).toEqual(before);
    expect(f.store.db.prepare('SELECT * FROM delivery_receipts').all()).toEqual(receipt);
  }finally{await worker.close();await service?.close();f.store.close();}
});

test('incomplete proof or an intent changed during verification never writes a native delivery link',async()=>{
  const f=await fixture();let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});let entered=false;
  const worker=new VerificationScheduler(f.data,async()=>{entered=true;await gate;return {verified:true,evidenceId:'synthetic-late-proof',nativeIdDigest:digest('native')};});
  try{
    worker.enqueue(f.event.id);f.due();const task=worker.tick();await expect.poll(()=>entered).toBe(true);
    f.store.db.prepare('UPDATE send_intents SET target_key=? WHERE id=?').run('dm:different-native-conversation',f.intent);
    release();await task;
    expect(f.store.db.prepare('SELECT count(*) AS n FROM chat_delivery_links').get()).toEqual({n:0});
    expect(f.store.db.prepare('SELECT count(*) AS n FROM verification_results').get()).toEqual({n:0});
    expect(f.store.db.prepare('SELECT state FROM verification_jobs WHERE intent_id=?').get(f.intent)).toEqual({state:'REVIEW'});
    expect(targetKey(f.event.payload)).toBe('dm:conversation-1');
  }finally{release?.();await worker.close();f.store.close();}
  const no=await fixture(),incomplete=new VerificationScheduler(no.data,async()=>({verified:false,evidenceId:'synthetic-incomplete',nativeIdDigest:digest('not-proof')}));
  try{
    incomplete.enqueue(no.event.id);no.due();await incomplete.tick();
    expect(no.store.db.prepare('SELECT count(*) AS n FROM chat_delivery_links').get()).toEqual({n:0});
  }finally{await incomplete.close();no.store.close();}
});

test('a conflicting later native proof removes the confirmed projection while preserving actual observed messages',async()=>{
  const f=await fixture(),first=digest('original-native-id');
  f.store.db.prepare('INSERT INTO chat_delivery_links VALUES(?,?)').run(f.intent,first);
  const own=candidate({actorId:'own-1',direction:'OUTGOING',text:f.draft.text,platformEventId:'original-native-id'});
  new ChatMessageStore(f.store).observe([own],'own-1',Date.parse('2026-11-03T00:00:00Z'));
  const worker=new VerificationScheduler(f.data,async()=>({verified:true,evidenceId:'synthetic-conflicting-proof',nativeIdDigest:digest('different-native-id')}));
  let service:ClientService|undefined;
  try{
    worker.enqueue(f.event.id);f.due();await worker.tick();
    expect(f.store.db.prepare('SELECT native_id_digest FROM chat_delivery_links WHERE intent_id=?').get(f.intent)).toEqual({native_id_digest:first});
    expect(f.store.db.prepare('SELECT verified FROM verification_results WHERE intent_id=?').get(f.intent)).toEqual({verified:0});
    expect(f.store.db.prepare('SELECT state,last_error FROM verification_jobs WHERE intent_id=?').get(f.intent)).toEqual({state:'REVIEW',last_error:'VERIFICATION_NATIVE_ID_CONFLICT'});
    service=new ClientService(f.store,new BrowserService(f.root));await service.loadSettings();
    const detail=await service.dispatch(service.authority.issueSession(),{command:'getThread',eventId:f.event.id}) as {replyStatus:string;timeline:{items:{id:string;direction:string;origin:string}[]}};
    expect(detail.replyStatus).toBe('WAITING');
    expect(detail.timeline.items.filter(item=>item.direction==='OUTGOING')).toEqual([expect.objectContaining({id:expect.stringMatching(/^observed:/),origin:'OBSERVED'})]);
    expect(f.store.event(f.event.id).status).toBe('UNCERTAIN');
  }finally{await worker.close();await service?.close();f.store.close();}
});
