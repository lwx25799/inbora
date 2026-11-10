import {expect,test} from 'vitest';
import {retainStoredDmMedia} from '../../src/app/dm-media-representation.js';
import type {InboundEvent} from '../../src/core/contracts.js';
import {candidate,database} from '../helpers.js';

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
