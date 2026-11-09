import {expect,test} from 'vitest';
import {randomUUID} from 'node:crypto';
import {digest,targetKey,type InboundEvent} from '../../src/core/contracts.js';
import {readCommentThreadContext,commentThreadModelHistory,commentThreadPage,sameCommentThread} from '../../src/storage/comment-thread-context.js';
import {database} from '../helpers.js';

function setup(){
  const store=database(),origin=Date.now()-60_000;
  store.bindAccount('100');store.db.exec('CREATE TABLE verification_results(id TEXT,intent_id TEXT,verified INTEGER,evidence_ref TEXT,checked_at INTEGER)');
  const event=(id:string,text:string,offset:number):InboundEvent=>({accountId:'account_001',channel:'COMMENT_NOTIFICATION',platformEventId:id,actorId:'201',actorName:'Synthetic author',
    text,occurredAt:new Date(origin+offset).toISOString(),videoId:'10',commentId:id,conversationId:null,direction:'INCOMING',kind:id==='11'?'COMMENT':'REPLY',evidenceId:'synthetic-thread',
    ...(id==='11'?{}:{rootCommentId:'11',replyToCommentId:id})});
  const root=event('11','the original first root',-1000),a=event('21','first child asks context',1000),b=event('22','current child',3000);
  store.observe('COMMENT_NOTIFICATION','work:10',[root,a,b],'100','synthetic-thread',new Date().toISOString(),origin);
  const stored=(cid:string)=>store.events().find(row=>row.payload.commentId===cid)!;
  const send=(cid:string,text:string,offset:number,status='CONFIRMED')=>{
    const source=stored(cid),draft=randomUUID(),intent=randomUUID();
    store.db.prepare("INSERT INTO reply_drafts VALUES(?,?,?,'mock',1,'APPROVED',NULL,NULL)").run(draft,source.id,text);
    store.db.prepare('INSERT INTO send_intents VALUES(?,?,?,?,?,?,?,?)').run(intent,source.id,draft,targetKey(source.payload),'synthetic-target',digest(text),status,new Date(origin+offset).toISOString());
    store.db.prepare('INSERT INTO delivery_receipts VALUES(?,?,?,?,?)').run(randomUUID(),intent,status,'synthetic-proof',new Date(origin+offset+10).toISOString());return intent;
  };
  return{store,origin,event,root,a,b,stored,send};
}

test('comment context starts at the exact root and includes sibling input and confirmed replies across child targets',()=>{
  const f=setup();try{
    f.send('21','our first answer',2000);
    const context=readCommentThreadContext(f.store,f.b),history=context.items.map(item=>item.payload);
    expect(history.map(item=>item.text)).toEqual(['the original first root','first child asks context','our first answer','current child']);
    expect(history.map(item=>item.direction)).toEqual(['INCOMING','INCOMING','OUTGOING','INCOMING']);
    expect(f.store.event(f.stored('11').id).status).toBe('BASELINE');
    expect(context).toMatchObject({rootVerified:true,rootMissing:false,rootAmbiguous:false,localRecordsOnly:true,observedOwnHistoryComplete:false});
    expect(context.items[2]).toMatchObject({direction:'OUTGOING',origin:'CONFIRMED',payload:{actorId:'100'}});
    expect(commentThreadModelHistory(context,f.b).map(item=>item.text)).toEqual(['the original first root','first child asks context','our first answer']);
    expect(targetKey(f.b)).toBe('comment:10:22');
  }finally{f.store.close();}
});

test('a long child thread retains the root as the fixed first model context item',()=>{
  const f=setup();try{
    const incoming=Array.from({length:12},(_,i)=>f.event(String(31+i),'later child '+i,4000+i));
    f.store.observe('COMMENT_NOTIFICATION','work:10',incoming,'100','synthetic-more',new Date().toISOString(),f.origin);
    const context=readCommentThreadContext(f.store,incoming.at(-1)!),history=commentThreadModelHistory(context,incoming.at(-1)!);
    expect(history[0]?.text).toBe('the original first root');
    expect(history.some(item=>item.text==='later child 10')).toBe(true);
    expect(history).toHaveLength(7);expect(history.some(item=>item.text==='later child 11')).toBe(false);
    const latest=commentThreadPage(context,undefined,4),older=commentThreadPage(context,latest.before!,4);
    expect(latest.items[0]?.isRoot).toBe(true);expect(older.items[0]?.isRoot).toBe(true);expect(latest.hasMore).toBe(true);
    const loaded=new Set<string>();let cursor:string|undefined;
    do{const page=commentThreadPage(context,cursor,4);for(const item of page.items.filter(item=>!item.isRoot)){
      expect(loaded.has(item.id)).toBe(false);loaded.add(item.id);
    }cursor=page.before??undefined;}while(cursor);
    expect(loaded.size).toBe(context.items.length-1);
  }finally{f.store.close();}
});

test('thread membership excludes other roots, works, accounts and ambiguous legacy replies even with the same display author',()=>{
  const f=setup();try{
    const otherRoot={...f.event('31','other root child',4000),rootCommentId:'12'},otherWork={...f.event('32','other work child',5000),videoId:'20'};
    const weak={...f.event('33','missing parent',6000),rootCommentId:undefined,replyToCommentId:undefined};
    f.store.observe('COMMENT_NOTIFICATION','synthetic-other',[otherRoot,otherWork,weak],'100','synthetic',new Date().toISOString(),f.origin);
    const valid=f.stored('21'),foreignId=randomUUID();
    f.store.db.prepare('INSERT INTO inbound_events SELECT ?,?,channel,?,scope,target_key,binding,payload,status FROM inbound_events WHERE id=?')
      .run(foreignId,'foreign-account','foreign-source',valid.id);
    expect(readCommentThreadContext(f.store,f.b).items.map(item=>item.text)).toEqual(['the original first root','first child asks context','current child']);
    expect(sameCommentThread(f.a,f.b)).toBe(true);expect(sameCommentThread(otherRoot,f.b)).toBe(false);
    expect(sameCommentThread(otherWork,f.b)).toBe(false);expect(sameCommentThread(weak,f.b)).toBe(false);
  }finally{f.store.close();}
});

test.each(['MISSING','AMBIGUOUS','UNVERIFIED','BINDING'] as const)('an absent or unproved original root remains explicit and cannot reach model history: %s',fault=>{
  const f=setup();try{
    const root=f.stored('11');
    if(fault==='MISSING')f.store.db.prepare('DELETE FROM inbound_events WHERE id=?').run(root.id);
    if(fault==='AMBIGUOUS')f.store.db.prepare('INSERT INTO inbound_events SELECT ?,account_id,channel,?,scope,target_key,binding,payload,status FROM inbound_events WHERE id=?')
      .run(randomUUID(),'second-native-source',root.id);
    if(fault==='UNVERIFIED')f.store.db.prepare('UPDATE inbound_events SET payload=json_set(payload,\'$.observationIssue\',\'COMMENT_TEXT_UNVERIFIED\') WHERE id=?').run(root.id);
    if(fault==='BINDING')f.store.db.prepare("UPDATE inbound_events SET binding='changed-binding' WHERE id=?").run(root.id);
    const context=readCommentThreadContext(f.store,f.b);expect(context.rootMissing).toBe(fault==='MISSING');expect(context.rootAmbiguous).toBe(fault==='AMBIGUOUS');
    expect(context.rootVerified).toBe(false);expect(()=>commentThreadModelHistory(context,f.b)).toThrow('COMMENT_ROOT_CONTEXT_REQUIRED');
    expect(f.store.events().every(event=>event.payload.text!=='fabricated root')).toBe(true);
  }finally{f.store.close();}
});

test('only latest confirmed delivery evidence contributes outgoing context, including read-only followup and explicit old retry',()=>{
  const f=setup();try{
    const intent=f.send('21','our confirmed answer',2000);
    let context=readCommentThreadContext(f.store,f.b);expect(context.items.some(item=>item.text==='our confirmed answer')).toBe(true);
    f.store.db.prepare('INSERT INTO verification_results VALUES(?,?,?,?,?)').run(randomUUID(),intent,0,'synthetic-counterproof',1);
    context=readCommentThreadContext(f.store,f.b);expect(context.items.some(item=>item.text==='our confirmed answer')).toBe(false);
    f.store.db.prepare("UPDATE send_intents SET status='UNCERTAIN' WHERE id=?").run(intent);
    f.store.db.prepare('INSERT INTO verification_results VALUES(?,?,?,?,?)').run(randomUUID(),intent,1,'synthetic-followup',2);
    context=readCommentThreadContext(f.store,f.b);expect(context.items.filter(item=>item.direction==='OUTGOING')).toHaveLength(1);
    const draft=f.store.db.prepare('SELECT id FROM reply_drafts WHERE event_id=?').get(f.stored('21').id) as {id:string};
    const retry=randomUUID();f.store.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?)').run(retry,new Date(f.origin+2500).toISOString(),'MANUAL_RETRY_INTENT','synthetic-grant',
      JSON.stringify({eventId:f.stored('21').id,draftId:draft.id,textDigest:digest('our confirmed answer')}));
    f.store.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?)').run(randomUUID(),new Date().toISOString(),'MANUAL_RETRY_RECEIPT',retry,JSON.stringify({result:'UNCERTAIN'}));
    expect(readCommentThreadContext(f.store,f.b).items.filter(item=>item.direction==='OUTGOING')).toHaveLength(1);
    f.store.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?)').run(randomUUID(),new Date().toISOString(),'MANUAL_RETRY_RECEIPT',retry,JSON.stringify({result:'CONFIRMED'}));
    expect(readCommentThreadContext(f.store,f.b).items.filter(item=>item.direction==='OUTGOING')).toHaveLength(2);
    const awaiting=f.send('22','not confirmed reply',3500,'UNCERTAIN');
    expect(readCommentThreadContext(f.store,f.b).items.some(item=>item.text==='not confirmed reply')).toBe(false);
    f.store.db.prepare("UPDATE send_intents SET status='CONFIRMED' WHERE id=?").run(awaiting);
    expect(readCommentThreadContext(f.store,f.b).items.some(item=>item.text==='not confirmed reply')).toBe(false);
  }finally{f.store.close();}
});

test.each(['BINDING','COLLISION','TEXT_DIGEST'] as const)('damaged confirmed source or reply data never becomes trusted model context: %s',fault=>{
  const f=setup();try{
    const intent=f.send('21','our first answer',2000),source=f.stored('21');
    if(fault==='BINDING')f.store.db.prepare("UPDATE inbound_events SET binding='changed' WHERE id=?").run(source.id);
    if(fault==='COLLISION')f.store.db.prepare('INSERT INTO source_collisions VALUES(?,?,?,?,?)').run(randomUUID(),source.id,'changed','{}','synthetic');
    if(fault==='TEXT_DIGEST')f.store.db.prepare("UPDATE send_intents SET text_digest='changed' WHERE id=?").run(intent);
    const context=readCommentThreadContext(f.store,f.b),outgoing=context.items.find(item=>item.direction==='OUTGOING');
    if(fault==='TEXT_DIGEST')expect(outgoing).toBeUndefined();else{
      expect(outgoing?.verifiedForModel).toBe(false);expect(()=>commentThreadModelHistory(context,f.b)).toThrow('COMMENT_THREAD_CONTEXT_UNVERIFIED');
    }
    expect(f.store.budget('MODEL').used).toBe(0);expect(f.store.budget('SEND').used).toBe(0);
  }finally{f.store.close();}
});

test('a cursor from another exact thread cannot read this root and tied timestamps remain deterministic',()=>{
  const f=setup();try{
    const ties=[f.event('31','tied one',4000),f.event('32','tied two',4000),f.event('33','tied three',4000)];
    f.store.observe('COMMENT_NOTIFICATION','work:10',ties,'100','synthetic-ties',new Date().toISOString(),f.origin);
    const context=readCommentThreadContext(f.store,f.b),page=commentThreadPage(context,undefined,1);expect(page.hasMore).toBe(true);
    const foreign=Buffer.from(JSON.stringify({group:'other',at:1,order:page.items.at(-1)!.id})).toString('base64url');
    expect(()=>commentThreadPage(context,foreign)).toThrow('TIMELINE_CURSOR_INVALID');
    const before=f.store.db.prepare('SELECT total_changes() n').get();readCommentThreadContext(f.store,f.b);expect(f.store.db.prepare('SELECT total_changes() n').get()).toEqual(before);
    const ids=[];let cursor:string|undefined;do{const next=commentThreadPage(context,cursor,1);ids.push(next.items.at(-1)!.id);cursor=next.before??undefined;}while(cursor);
    expect(new Set(ids).size).toBe(ids.length);expect(ids).toHaveLength(5);
    expect(commentThreadModelHistory(context,f.b,0).map(item=>item.text)).toEqual(['the original first root']);
    expect(()=>commentThreadModelHistory(context,f.b,31)).toThrow('COMMENT_CONTEXT_LIMIT_INVALID');
  }finally{f.store.close();}
});
