import {expect,test} from 'vitest';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {InboxQueries,inboxGroupKey} from '../../src/app/inbox-queries.js';
import {digest,targetKey,type InboundEvent} from '../../src/core/contracts.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {candidate,database,privateTemp} from '../helpers.js';

function setup(){
  const store=database(),origin=Date.now()-60_000,root=privateTemp('comment-inbox-');
  store.observe('COMMENT_NOTIFICATION','work:10',[],'own-1','synthetic',new Date(origin).toISOString());
  const event=(id:string,offset:number,extra:Partial<InboundEvent>={})=>candidate({channel:'COMMENT_NOTIFICATION',kind:id==='11'?'COMMENT':'REPLY',
    conversationId:null,videoId:'10',commentId:id,platformEventId:id,actorName:'Same author',text:'same text',
    occurredAt:new Date(origin+offset).toISOString(),...(id==='11'?{}:{rootCommentId:'11',replyToCommentId:id}),...extra});
  const add=(e:InboundEvent)=>{
    store.observe('COMMENT_NOTIFICATION','work:10',[e],'own-1','synthetic');
    return store.events().find(row=>row.payload.platformEventId===e.platformEventId&&row.payload.videoId===e.videoId)!;
  };
  const queries=new InboxQueries(store,root,(_id,status)=>status==='CONFIRMED'?'REPLIED':'WAITING');
  const read=(page=0,status:'ALL'|'PENDING'|'CONFIRMED'='ALL')=>queries.inbox({command:'getInbox',channel:'COMMENT_NOTIFICATION',status,page});
  return {store,origin,root,event,add,read};
}

test('the exact root and its distinct child IDs appear once while independent waiting children remain actionable',()=>{
  const f=setup();try{
    const root=f.add(f.event('11',1000)),a=f.add(f.event('21',2000)),b=f.add(f.event('22',3000));
    f.store.db.prepare("UPDATE inbound_events SET status='CONFIRMED' WHERE id=?").run(b.id);
    expect(f.read()).toMatchObject({total:1,items:[{id:a.id,latestEventId:b.id,commentCount:3,waitingCount:2,replyStatus:'WAITING'}]});
    expect(f.read(0,'CONFIRMED')).toMatchObject({total:0});
    expect(f.read(0,'PENDING')).toMatchObject({total:1});
    expect(f.store.events()).toHaveLength(3);
    expect(f.store.event(root.id).status).not.toBe('CONFIRMED');
  }finally{f.store.close();}
});

test('unknown children are retained independently and grouped display never rewrites their intents or receipts',()=>{
  const f=setup();try{
    const a=f.add(f.event('21',2000)),b=f.add(f.event('22',3000));
    for(const event of [a,b]){
      const draft=f.store.saveDraft(event.id,'approved synthetic reply','mock'),intent=randomUUID();
      f.store.db.prepare('INSERT INTO send_intents VALUES(?,?,?,?,?,?,?,?)').run(intent,event.id,draft.id,targetKey(event.payload),'synthetic-target',digest(draft.text),'UNCERTAIN',new Date().toISOString());
      f.store.db.prepare('INSERT INTO delivery_receipts VALUES(?,?,?,?,?)').run(randomUUID(),intent,'UNCERTAIN','synthetic-proof',new Date().toISOString());
      f.store.db.prepare("UPDATE inbound_events SET status='UNCERTAIN' WHERE id=?").run(event.id);
    }
    const before=f.store.db.prepare('SELECT * FROM send_intents ORDER BY rowid').all();
    expect(f.read()).toMatchObject({total:1,items:[{id:b.id,commentCount:2,waitingCount:2,replyStatus:'WAITING'}]});
    expect(f.store.sendFrozen(a.id)).toBe(true);expect(f.store.sendFrozen(b.id)).toBe(true);
    expect(f.store.db.prepare('SELECT * FROM send_intents ORDER BY rowid').all()).toEqual(before);
    expect(f.store.db.prepare('SELECT COUNT(*) n FROM delivery_receipts').get()).toEqual({n:2});
  }finally{f.store.close();}
});

test('same author or text cannot merge another root, work, account or unproved legacy relationship',()=>{
  const f=setup();try{
    f.add(f.event('21',2000));f.add(f.event('22',3000));
    f.add(f.event('31',4000,{rootCommentId:'12'}));
    f.add(f.event('32',5000,{videoId:'20'}));
    f.add(f.event('33',6000,{rootCommentId:undefined,replyToCommentId:undefined}));
    f.add(f.event('34',7000,{rootCommentId:undefined,replyToCommentId:undefined}));
    const row=f.store.events()[0]!;
    expect(inboxGroupKey({...row,payload:{...row.payload,accountId:'account-other' as 'account_001'}})).not.toBe(inboxGroupKey(row));
    expect(f.read().total).toBe(5);
  }finally{f.store.close();}
});

test('thread pagination and ordering count roots, keep equal-time children and late backfill without hiding waiting state',()=>{
  const f=setup();try{
    const latest=f.add(f.event('21',20_000));f.store.db.prepare("UPDATE inbound_events SET status='CONFIRMED' WHERE id=?").run(latest.id);
    const late=f.add(f.event('22',1000));
    for(let i=0;i<22;i++)f.add(f.event(String(100+i),2000+i,{rootCommentId:String(500+i)}));
    const equal=f.add(f.event('23',20_000));
    const first=f.read(),second=f.read(1);
    expect(first.total).toBe(23);expect(first.items).toHaveLength(20);expect(second.items).toHaveLength(3);
    expect(new Set([...first.items,...second.items].map(item=>item.groupKey)).size).toBe(23);
    expect(first.items[0]).toMatchObject({id:equal.id,latestEventId:equal.id,commentCount:3,waitingCount:2,replyStatus:'WAITING'});
    expect(f.store.event(late.id).status).not.toBe('CONFIRMED');
  }finally{f.store.close();}
});

test('a waiting sibling with a saved human draft remains the resume target even after another sibling was confirmed',async()=>{
  const f=setup();try{
    await migrateClient(f.store,join(f.root,'migration.sqlite'));
    const a=f.add(f.event('21',2000)),b=f.add(f.event('22',3000)),draft={id:randomUUID(),version:1,text:'unfinished human text'};
    f.store.db.prepare("INSERT INTO reply_drafts VALUES(?,?,?,'human',1,'DRAFT',NULL,NULL)").run(draft.id,a.id,draft.text);
    f.store.db.prepare('INSERT INTO draft_revisions VALUES(?,?,?,?,?,?)').run(draft.id,draft.version,'HUMAN_TYPED',draft.text,'synthetic-operator',f.origin+2500);
    f.store.db.prepare("UPDATE inbound_events SET status='CONFIRMED' WHERE id=?").run(b.id);
    expect(f.read()).toMatchObject({total:1,items:[{id:a.id,latestEventId:b.id,resumeEventId:a.id,waitingCount:1}]});
    expect(f.store.event(b.id).status).toBe('CONFIRMED');
  }finally{f.store.close();}
});
