import {expect,test} from 'vitest';
import {retainStoredDmMedia} from '../../src/app/dm-media-representation.js';
import type {InboundEvent} from '../../src/core/contracts.js';
import {join} from 'node:path';
import {ChatMessageStore} from '../../src/storage/chat-messages.js';
import {MessagePreviewStore} from '../../src/storage/message-previews.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {candidate,database,privateTemp} from '../helpers.js';

const strong=()=>candidate({platformEventId:'88911',actorId:'200',conversationId:'conv-a',text:'hello [微笑]'});
const weak=():InboundEvent=>({...strong(),text:'[含媒体的消息，需人工查看]',contentType:'MIXED',observationIssue:'DM_CONTENT_UNVERIFIED'});
function seed(store:ReturnType<typeof database>,event=weak()){
  store.observe('DIRECT_MESSAGE','conv-a',[],'100','fixture','2026-11-04T00:00:00Z');
  store.observe('DIRECT_MESSAGE','conv-a',[event],'100','fixture','2026-11-04T02:00:00Z');return store.events()[0]!;
}

test('the collector carrier is a copied list, retains exact old payloads, and does not change the direct observe collision contract',()=>{
  const store=database();try{
    const saved=seed(store),fresh=strong(),events=[fresh],result=retainStoredDmMedia(store,events);
    expect(result).not.toBe(events);expect(events).toEqual([fresh]);expect(result).toEqual([saved.payload]);
    expect(store.event(saved.id)).toEqual(saved);expect(store.db.prepare('SELECT count(*) n FROM source_collisions').get()).toEqual({n:0});
    store.observe('DIRECT_MESSAGE','conv-a',events,'100','fixture','2026-11-04T02:01:00Z');
    expect(store.db.prepare('SELECT count(*) n FROM source_collisions').get()).toEqual({n:1});expect(store.event(saved.id).payload).toEqual(saved.payload);
  }finally{store.close();}
});

test.each([
  ['actor',{actorId:'201'}],['conversation',{conversationId:'conv-other'}],['direction',{direction:'OUTGOING'}],['kind',{kind:'UNKNOWN'}],
  ['time',{occurredAt:'2026-11-04T01:00:01Z'}],['precision',{occurredAtPrecisionMs:1000}],['work',{videoId:'10'}],['comment',{commentId:'11'}],
] as const)('a changed %s stays on the original collision path',(_name,change)=>{
  const store=database();try{
    const saved=seed(store),fresh={...strong(),...change},result=retainStoredDmMedia(store,[fresh]);expect(result).toEqual([fresh]);
    if(fresh.direction==='INCOMING'&&fresh.kind==='DM'){
      store.observe('DIRECT_MESSAGE',fresh.conversationId!,result,'100','fixture','2026-11-04T02:01:00Z');
      expect(store.db.prepare('SELECT count(*) n FROM source_collisions').get()).toEqual({n:1});
    }
    expect(store.event(saved.id).payload).toEqual(saved.payload);
  }finally{store.close();}
});

test.each([
  ['non-placeholder text',{text:'old readable partial body'}],['video media',{contentType:'VIDEO',text:'[视频消息，需人工查看]'}],
  ['mismatched placeholder',{text:'[图片或表情消息，需人工查看]'}],['strong prior',{contentType:undefined,observationIssue:undefined,text:'old real body'}],
] as const)('the collector does not hide a changed original with %s',(_name,change)=>{
  const store=database();try{
    seed(store,{...weak(),...change} as InboundEvent);const fresh=strong();expect(retainStoredDmMedia(store,[fresh])).toEqual([fresh]);
    store.observe('DIRECT_MESSAGE','conv-a',[fresh],'100','fixture','2026-11-04T02:01:00Z');
    expect(store.db.prepare('SELECT count(*) n FROM source_collisions').get()).toEqual({n:1});
  }finally{store.close();}
});

test('new native IDs and still weak candidates preserve their original input representation',()=>{
  const store=database();try{
    seed(store);const fresh=strong(),unseen={...fresh,platformEventId:'88912'},stillWeak={...fresh,observationIssue:'DM_CONTENT_UNVERIFIED' as const};
    expect(retainStoredDmMedia(store,[unseen,stillWeak])).toEqual([unseen,stillWeak]);
  }finally{store.close();}
});

test('duplicate native IDs do not let the compatibility carrier hide current contradictory bodies',()=>{
  const store=database();try{
    seed(store);const fresh=strong(),conflicting={...fresh,text:'different current body'};
    expect(retainStoredDmMedia(store,[fresh,conflicting])).toEqual([fresh,conflicting]);
    store.observe('DIRECT_MESSAGE','conv-a',[fresh,conflicting],'100','fixture','2026-11-04T02:01:00Z');
    expect(store.db.prepare('SELECT count(*) n FROM source_collisions').get()).toEqual({n:2});
  }finally{store.close();}
});

async function ownChat(){
  const store=database(),root=privateTemp('own-media-representation-');
  await migrateClient(store,join(root,'client-backup.sqlite'));await migrateAutomation(store,join(root,'automation-backup.sqlite'));store.bindAccount('100');
  const fresh={...strong(),actorId:'100',direction:'OUTGOING' as const,platformEventId:'88921'},previous={...fresh,
    text:'[含媒体的消息，需人工查看]',contentType:'MIXED' as const,observationIssue:'DM_CONTENT_UNVERIFIED' as const};
  const chat=new ChatMessageStore(store),origin=Date.parse('2026-11-04T00:00:00Z'),observedAt=Date.parse('2026-11-04T02:00:00Z');
  chat.observe([previous],'100',origin,observedAt);
  const row=store.db.prepare('SELECT * FROM chat_messages').get() as {id:string;conflicted:number};
  return{store,root,fresh,previous,chat,origin,observedAt,row};
}

test('normal own-message enrichment retains the valid weak carrier instead of conflicting or rewriting display history',async()=>{
  const {store,root,fresh,previous,chat,origin,observedAt,row}=await ownChat();
  try{
    const input=JSON.stringify(fresh),budgets=store.db.prepare('SELECT * FROM budgets').all(),retained=retainStoredDmMedia(store,[fresh]);
    chat.observe(retained,'100',origin,observedAt+1000);
    expect(store.db.prepare('SELECT conflicted FROM chat_messages WHERE id=?').get(row.id)).toEqual({conflicted:0});
    expect(retained).toEqual([previous]);expect(JSON.stringify(fresh)).toBe(input);
    expect(store.db.prepare('SELECT * FROM chat_messages WHERE id=?').get(row.id)).toEqual(row);
    expect(chat.get(row.id)?.payload).toEqual(previous);
    const previews=new MessagePreviewStore(root);previews.saveDisplayText(retained[0]!,'100',fresh.text);
    expect(previews.displayText(previous,'100')).toBe(fresh.text);
    const newId={...fresh,platformEventId:'88922'};chat.observe(retainStoredDmMedia(store,[newId]),'100',origin,observedAt+2000);
    expect(store.db.prepare('SELECT count(*) n FROM chat_messages WHERE conflicted=0').get()).toEqual({n:2});
    expect(store.events()).toHaveLength(0);expect(store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
    expect(store.db.prepare('SELECT * FROM budgets').all()).toEqual(budgets);
  }finally{store.close();}
});

test.each(['conflicted','wrong-own','invalid-binding'] as const)('an existing %s own record cannot be reused as a compatible carrier',async fault=>{
  const {store,fresh,chat,origin,observedAt,row}=await ownChat();
  try{
    if(fault==='conflicted')store.db.prepare('UPDATE chat_messages SET conflicted=1 WHERE id=?').run(row.id);
    if(fault==='wrong-own')store.db.prepare('UPDATE chat_messages SET own_id=? WHERE id=?').run('other-own',row.id);
    if(fault==='invalid-binding')store.db.prepare('UPDATE chat_messages SET binding=? WHERE id=?').run('invalid',row.id);
    const retained=retainStoredDmMedia(store,[fresh]);expect(retained).toEqual([fresh]);
    chat.observe(retained,'100',origin,observedAt+1000);expect(store.db.prepare('SELECT conflicted FROM chat_messages WHERE id=?').get(row.id)).toEqual({conflicted:1});
  }finally{store.close();}
});

test('duplicate own native IDs preserve the ordinary conflict path instead of reusing the old weak record',async()=>{
  const {store,fresh,chat,origin,observedAt,row}=await ownChat();
  try{
    const input=[fresh,{...fresh,text:'contradictory current own body'}],retained=retainStoredDmMedia(store,input);
    expect(retained).toEqual(input);chat.observe(retained,'100',origin,observedAt+1000);
    expect(store.db.prepare('SELECT conflicted FROM chat_messages WHERE id=?').get(row.id)).toEqual({conflicted:1});
  }finally{store.close();}
});
