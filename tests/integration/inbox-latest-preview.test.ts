import {expect,test} from 'vitest';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {ChatMessageStore} from '../../src/storage/chat-messages.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {digest,targetKey} from '../../src/core/contracts.js';
import {candidate,database,pending,privateTemp,snapshot} from '../helpers.js';
import {setupAssistant} from '../mcp-helpers.js';
import {AssistantReads} from '../../src/mcp/assistant-reads.js';

interface Preview {id:string;preview:string;time:string;previewDirection:string;latestEventId:string;replyStatus:string;unread:boolean}
async function setup(){
  const store=database(),root=privateTemp('inbox-latest-preview-');await migrateClient(store,join(root,'backup.sqlite'));
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();const token=service.authority.issueSession();
  const add=(id:string,at:number,conversationId='conversation-1')=>pending(store,candidate({platformEventId:id,conversationId,
    occurredAt:new Date(Date.UTC(2026,10,4,1,0,at)).toISOString(),text:`incoming ${id}`}));
  const observe=(id:string,at:number,text:string,conversationId='conversation-1')=>new ChatMessageStore(store).observe([
    candidate({platformEventId:id,conversationId,actorId:'own-1',direction:'OUTGOING',text,occurredAt:new Date(Date.UTC(2026,10,4,1,0,at)).toISOString()})
  ],'own-1',Date.UTC(2026,10,3),Date.UTC(2026,10,4,1,5));
  const read=(page=0)=>service.dispatch(token,{command:'getInbox',channel:'DIRECT_MESSAGE',status:'ALL',page}) as Promise<{items:Preview[];total:number}>;
  return {store,service,token,add,observe,read,close:async()=>{await service.close();store.close();}};
}

test('a native outgoing message supplies preview, time and ordering without changing the inbound reply target or read state',async()=>{
  const f=await setup();try{
    const incoming=f.add('peer-a',1),other=f.add('peer-b',20,'conversation-2');
    await f.service.dispatch(f.token,{command:'markInboxRead'});
    f.observe('sent-a',30,'last own reply');
    const before=f.store.events();
    expect(await f.read()).toMatchObject({items:[{id:incoming,latestEventId:incoming,preview:'last own reply',previewDirection:'OUTGOING',
      time:'2026-11-04T01:00:30.000Z',unread:false},{id:other,preview:'incoming peer-b',previewDirection:'INCOMING'}]});
    f.add('new-peer-a',40);
    expect((await f.read()).items[0]).toMatchObject({preview:'incoming new-peer-a',previewDirection:'INCOMING',time:'2026-11-04T01:00:40.000Z',unread:true});
    expect(f.store.events().slice(0,before.length)).toEqual(before);
    expect(f.store.budgets().every(row=>row.used===0)).toBe(true);
  }finally{await f.close();}
});

test.each(['CONFIRMED','VERIFIED','UNCERTAIN','CHANGED_DRAFT','NEGATIVE_PROOF'])(
  'only authoritative outgoing evidence may replace an incoming preview (%s)',async status=>{
    const f=await setup();try{
      const eventId=f.add('peer',1),event=f.store.event(eventId),draft=randomUUID(),intent=randomUUID(),text='persisted sent reply',approval={snapshot:snapshot(event.payload),version:1,textDigest:digest(text)};
      f.store.db.prepare("INSERT INTO reply_drafts VALUES(?,?,?,'human',1,'APPROVED',?,NULL)").run(draft,eventId,text,JSON.stringify(approval));
      f.store.db.prepare('INSERT INTO send_intents VALUES(?,?,?,?,?,?,?,?)').run(intent,eventId,draft,targetKey(event.payload),digest(approval.snapshot),digest(text),
        status==='CONFIRMED'||status==='CHANGED_DRAFT'||status==='NEGATIVE_PROOF'?'CONFIRMED':'UNCERTAIN','2026-11-04T01:00:30.000Z');
      if(status==='VERIFIED'||status==='NEGATIVE_PROOF')f.store.db.prepare('INSERT INTO verification_results VALUES(?,?,?,?,?)')
        .run(randomUUID(),intent,status==='VERIFIED'?1:0,'synthetic',Date.now());
      if(status==='CHANGED_DRAFT')f.store.db.prepare("UPDATE reply_drafts SET text='later edit' WHERE id=?").run(draft);
      const eligible=['CONFIRMED','VERIFIED'].includes(status),preview=(await f.read()).items[0]!;
      expect(preview).toMatchObject({preview:eligible?text:'incoming peer',previewDirection:eligible?'OUTGOING':'INCOMING'});
    }finally{await f.close();}
  });

test('latest-message order applies before pagination and excludes outgoing identity conflicts',async()=>{
  const f=await setup();try{
    const ids=Array.from({length:21},(_,i)=>f.add(`incoming-${i}`,i,`conversation-${i}`));
    f.observe('newest-own',40,'last own message','conversation-0');
    f.observe('conflicted',50,'untrusted outgoing','conversation-1');f.observe('conflicted',50,'conflicting text','conversation-1');
    const first=await f.read(),second=await f.read(1);
    expect(first).toMatchObject({total:21,items:expect.any(Array)});expect(first.items).toHaveLength(20);
    expect(first.items[0]).toMatchObject({id:ids[0],preview:'last own message',previewDirection:'OUTGOING'});
    expect([...first.items,...second.items].find(row=>row.id===ids[1])).toMatchObject({preview:'incoming incoming-1',previewDirection:'INCOMING'});
    expect(new Set([...first.items,...second.items].map(row=>row.id)).size).toBe(21);
  }finally{await f.close();}
});

test('an outgoing GUI preview does not relabel our own text as an incoming assistant task',async()=>{
  const f=await setupAssistant();try{
    const text='last own message for GUI preview';
    new ChatMessageStore(f.store).observe([candidate({platformEventId:'9002',actorId:'own-1',direction:'OUTGOING',text,
      occurredAt:new Date(Date.parse(f.payload.occurredAt!)+1000).toISOString()})],'own-1',Date.parse(f.payload.occurredAt!)-1000);
    expect(await f.service.dispatch(f.gui,{command:'getInbox',channel:'DIRECT_MESSAGE',status:'ALL',page:0})).toMatchObject({items:[{preview:text,previewDirection:'OUTGOING'}]});
    expect(await new AssistantReads(f.service).inbox(f.token,{channel:'DIRECT_MESSAGE',status:'ALL',page:0})).toMatchObject({
      items:[{eventId:f.eventId,text:f.payload.text,time:f.payload.occurredAt}],
    });
  }finally{await f.close();}
});
