import {afterEach,expect,test,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {join} from 'node:path';
import {AccountActor} from '../../src/browser/account-actor.js';
import type {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {ObservedReader,type ObservationBatch} from '../../src/adapters/observed-reader.js';
import * as previews from '../../src/adapters/message-preview.js';
import {InboxCollector} from '../../src/app/inbox-collector.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {observedMapping} from '../fixtures/observed-site.js';
import {candidate,database,privateTemp} from '../helpers.js';

afterEach(()=>vi.restoreAllMocks());
async function setup(){
  const root=privateTemp('preview-exact-target-'),store=database();await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  const now=Date.now(),data=new AutomationStore(store,()=>now),origin=now-60000;data.initialize(origin);store.bindAccount('100');
  data.configureCollection({ownId:'100',comments:false,inbox:true,commentIntervalMs:30000,dmIntervalMs:15000});
  const peer={uid:'200',secUid:'peer-sec',title:'Fixture peer',conversationId:'conv-a'},target=candidate({platformEventId:'78101',actorId:'200',conversationId:'conv-a',
    text:'[图片或表情消息，需人工查看]',occurredAt:new Date(origin+1000).toISOString(),contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED'});
  store.observe('DIRECT_MESSAGE','conv-a',[],'100','fixture',new Date(origin).toISOString());store.observe('DIRECT_MESSAGE','conv-a',[target],'100','fixture',new Date(now).toISOString(),origin);
  const saved=store.events()[0]!;store.db.prepare('INSERT INTO discovered_conversations VALUES(?,?,?,?,?,?,?,0)').run('conv-a','100','200','peer-sec','Fixture peer',now,now);
  const parked={peer,phase:'MAX',top:500,height:1000,signature:'old',edge:0,legHasNew:true,minimumOld:false,anchor:{top:500,height:1000,ids:['78101']}};
  const cursor={parked:[parked],recent:['conv-a'],burst:0,completed:[],deferred:[],previewRetries:[],previewRetryNeedsNormal:false};
  store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='dm'").run(JSON.stringify(cursor));
  const owner={actor:new AccountActor(),dm:{bringToFront:async()=>{}},notification:new EventEmitter(),version:()=> '123.0.0.0'} as unknown as BrowserProfileOwner;
  const mapping=observedMapping('http://fixture.invalid'),windows:(number|undefined)[]=[],captured:string[]=[],listOffsets:(number|undefined)[]=[];
  vi.spyOn(ObservedReader.prototype,'conversations').mockImplementation(async(_x,top)=>{listOffsets.push(top);return{events:[],loaded:0,unsupported:0,evidenceId:'list',peers:[peer],scroll:{top:24,height:100,viewport:60,atEnd:false}};});
  const batch=(top=0,include=false):ObservationBatch=>({events:include?[target]:[],loaded:include?1:0,unsupported:include?1:0,evidenceId:'window',
    dmViewport:{top,height:1000,viewport:100,minimum:0,maximum:900}});
  const read=vi.spyOn(ObservedReader.prototype,'dmWindow').mockImplementation(async(_peer,top)=>{windows.push(top);return batch(top,top===500);});
  vi.spyOn(ObservedReader.prototype,'scrollDm').mockResolvedValue();
  vi.spyOn(previews,'saveMessagePreviews').mockImplementation(async(_page,_map,window)=>{captured.push(...window.events.map(event=>event.platformEventId!));});
  const collector=new InboxCollector(owner,mapping,data,root,'headless');
  return{root,store,data,origin,target,saved,cursor,windows,captured,listOffsets,read,batch,collector,close(){collector.dispose();store.close();}};
}

test('an exact retry reaches the saved native target instead of consuming its allowance on an unrelated current window',async()=>{
  const f=await setup();try{
    await f.collector.collect('dm',new AbortController().signal);
    expect(f.captured).toContain(f.target.platformEventId);expect(f.windows).toEqual([undefined,500]);
    expect(f.listOffsets).toEqual([undefined,24]);expect(f.store.event(f.saved.id)).toEqual(f.saved);
    const cursor=JSON.parse((f.store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='dm'").get() as {cursor_json:string}).cursor_json);
    expect(cursor.parked).toEqual(f.cursor.parked);expect(cursor.previewRetryNeedsNormal).toBe(true);
    expect(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='MESSAGE_PREVIEW_RETRY'").get()).toEqual({n:1});
    expect(JSON.parse((f.store.db.prepare("SELECT detail_redacted FROM audit_events WHERE event_type='MESSAGE_PREVIEW_TARGET_ATTEMPT_AUTOMATIC_FOUND'").get() as {detail_redacted:string}).detail_redacted))
      .toEqual({found:true,windows:2,persisted:2});
    expect(f.store.db.prepare('SELECT sum(used) n FROM budgets').get()).toEqual({n:0});expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{f.close();}
});

test('wrong candidate IDs and height changes cannot prove a target, and the quantum stays at four persisted windows',async()=>{
  const f=await setup();try{
    const changed={...f.cursor,parked:[{...f.cursor.parked[0]!,height:800,anchor:{...f.cursor.parked[0]!.anchor,height:800}}]};
    f.store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='dm'").run(JSON.stringify(changed));
    f.read.mockImplementation(async(_peer,top)=>{f.windows.push(top);return{...f.batch(top),events:[{...f.target,platformEventId:'78102'}],loaded:1,unsupported:1};});
    await f.collector.collect('dm',new AbortController().signal);
    expect(f.windows).toEqual([undefined,500,700,780]);expect(f.captured).not.toContain(f.target.platformEventId);
    expect(JSON.parse((f.store.db.prepare("SELECT detail_redacted FROM audit_events WHERE event_type='MESSAGE_PREVIEW_TARGET_ATTEMPT_AUTOMATIC_NOT_FOUND'").get() as {detail_redacted:string}).detail_redacted))
      .toEqual({found:false,windows:4,persisted:4});
    expect(f.listOffsets.at(-1)).toBe(24);
    const before=f.windows.length;await expect(f.collector.collect('dm',new AbortController().signal)).rejects.toThrow('OBSERVATION_DM_ANCHOR_NOT_FOUND');
    expect(f.windows.length).toBeGreaterThan(before);expect(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='MESSAGE_PREVIEW_RETRY'").get()).toEqual({n:1});
  }finally{f.close();}
});

test.each(['ACTOR','TIME','PRECISION','DUPLICATE'] as const)('the native target %s contradiction is never reported found',async change=>{
  const f=await setup();try{
    f.read.mockImplementation(async(_peer,top)=>{f.windows.push(top);if(top===undefined)return f.batch();
      const event=change==='ACTOR'?{...f.target,actorId:'201'}:change==='TIME'?{...f.target,occurredAt:new Date(f.origin+2000).toISOString()}:
        change==='PRECISION'?{...f.target,occurredAtPrecisionMs:1000}:f.target;
      return {...f.batch(top),events:change==='DUPLICATE'?[event,event]:[event],loaded:change==='DUPLICATE'?2:1,unsupported:1};});
    await expect(f.collector.collect('dm',new AbortController().signal)).rejects.toThrow('OBSERVATION_ROW_IDENTITY_CONFLICT');
    const report=JSON.parse((f.store.db.prepare("SELECT detail_redacted FROM audit_events WHERE event_type='MESSAGE_PREVIEW_TARGET_ATTEMPT_AUTOMATIC_IDENTITY_CHANGED'").get() as {detail_redacted:string}).detail_redacted);
    expect(report).toEqual({found:false,windows:2,persisted:1});expect(f.store.event(f.saved.id).payload).toEqual(f.saved.payload);
    expect(f.store.db.prepare('SELECT count(*) n FROM source_collisions').get()).toEqual({n:0});
  }finally{f.close();}
});

test('cancellation after a locating read cannot save that window or restore through a cancelled actor turn',async()=>{
  const f=await setup();try{
    const abort=new AbortController();f.read.mockImplementation(async(_peer,top)=>{f.windows.push(top);if(top!==undefined)abort.abort();return f.batch(top,top===500);});
    await expect(f.collector.collect('dm',abort.signal)).rejects.toThrow('COLLECTION_CANCELLED');
    expect(f.captured).not.toContain(f.target.platformEventId);expect(f.listOffsets).toEqual([undefined]);
    expect(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='MESSAGE_PREVIEW_RETRY'").get()).toEqual({n:1});
    expect(JSON.parse((f.store.db.prepare("SELECT detail_redacted FROM audit_events WHERE event_type='MESSAGE_PREVIEW_TARGET_ATTEMPT_AUTOMATIC_CANCELLED'").get() as {detail_redacted:string}).detail_redacted))
      .toEqual({found:false,windows:2,persisted:1});
  }finally{f.close();}
});

test('explicit selection locates an exhausted exact message without resetting or consuming automatic qualifications',async()=>{
  const f=await setup();try{
    for(let attempt=1;attempt<=2;attempt++)f.store.audit('MESSAGE_PREVIEW_RETRY',f.saved.id,{attempt,attemptedAt:Date.now()-300000+attempt});
    expect(f.collector.prioritize('100','conv-a',f.saved.id,'SELECTION')).toBe(true);
    await f.collector.collect('dm',new AbortController().signal);
    expect(f.windows).toEqual([undefined,500]);expect(f.captured).toContain(f.target.platformEventId);
    expect(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='MESSAGE_PREVIEW_RETRY'").get()).toEqual({n:2});
    expect(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='MESSAGE_PREVIEW_TARGET_ATTEMPT_SELECTION_FOUND'").get()).toEqual({n:1});
    expect(f.collector.prioritize('100','conv-a',f.saved.id,'SELECTION')).toBe(false);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{f.close();}
});

test('two consumed qualifications stay consumed after reconstructing the collector',async()=>{
  const f=await setup();try{
    for(let attempt=1;attempt<=2;attempt++)f.store.audit('MESSAGE_PREVIEW_RETRY',f.saved.id,{attempt,attemptedAt:Date.now()-300000+attempt});
    f.collector.dispose();const owner={actor:new AccountActor(),dm:{bringToFront:async()=>{}},notification:new EventEmitter(),version:()=> '123.0.0.0'} as unknown as BrowserProfileOwner;
    const restored=new InboxCollector(owner,observedMapping('http://fixture.invalid'),f.data,f.root,'headless');
    try{await expect(restored.collect('dm',new AbortController().signal)).rejects.toThrow('OBSERVATION_DM_ANCHOR_NOT_FOUND');expect(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='MESSAGE_PREVIEW_RETRY'").get()).toEqual({n:2});
      expect(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type LIKE 'MESSAGE_PREVIEW_TARGET_ATTEMPT_%'").get()).toEqual({n:0});
    }finally{restored.dispose();}
  }finally{f.close();}
});
