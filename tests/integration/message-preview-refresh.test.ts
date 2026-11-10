import {afterEach,expect,test,vi} from 'vitest';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {ChatMessageStore} from '../../src/storage/chat-messages.js';
import {InboxCollector} from '../../src/app/inbox-collector.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {AccountActor} from '../../src/browser/account-actor.js';
import type {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {MessagePreviewStore} from '../../src/storage/message-previews.js';
import * as previews from '../../src/adapters/message-preview.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {observedMapping} from '../fixtures/observed-site.js';
import {candidate,database,privateTemp} from '../helpers.js';
import {commandSchema} from '../../src/app/contracts.js';
import {eventBinding} from '../../src/core/contracts.js';

afterEach(()=>vi.restoreAllMocks());
async function setup(kind:'CURRENT'|'HISTORY'|'OWN'='CURRENT'){
  const root=privateTemp('preview-refresh-'),store=database();await migrateClient(store,join(root,'client.sqlite'));
  const browser=new BrowserService(root),service=new ClientService(store,browser);await service.loadSettings();
  store.bindAccount('100');const data=new AutomationStore(store),origin=data.state().startedAt,now=Date.now();
  data.configureCollection({ownId:'100',comments:false,inbox:true,commentIntervalMs:30000,dmIntervalMs:15000});
  const event=candidate({platformEventId:'79201',actorId:kind==='OWN'?'100':'200',conversationId:'conv-a',direction:kind==='OWN'?'OUTGOING':'INCOMING',
    occurredAt:new Date(kind==='CURRENT'?origin+1:origin-60000).toISOString(),text:'[图片或表情消息，需人工查看]',contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED'});
  store.observe('DIRECT_MESSAGE','conv-a',[],'100','fixture',new Date(origin).toISOString());
  if(kind==='OWN')new ChatMessageStore(store).observe([event],'100',origin,now);
  else store.observe('DIRECT_MESSAGE','conv-a',[event],'100','fixture',new Date(Math.max(now,origin+2)).toISOString(),origin);
  const eventId=kind==='OWN'?(store.db.prepare('SELECT id FROM chat_messages').get() as {id:string}).id:store.events()[0]!.id;
  store.db.prepare('INSERT INTO discovered_conversations VALUES(?,?,?,?,?,?,?,0)').run('conv-a','100','200','peer-sec','Fixture peer',now,now);
  const token=service.authority.issueSession(),hints:unknown[][]=[];
  Object.assign(browser,{collector:{prioritize:(...args:unknown[])=>{hints.push(args);return true;}}});
  return{root,store,data,event,eventId,token,browser,service,hints,async close(){Object.assign(browser,{collector:undefined});await service.close();store.close();}};
}

test.each(['CURRENT','HISTORY','OWN'] as const)('explicit refresh reaches a stored %s media message without selecting a reply target',async kind=>{
  const f=await setup(kind);try{
    const tables=['inbound_events','chat_messages','reply_drafts','send_intents','delivery_receipts','budgets'];
    const inventory=()=>tables.map(table=>f.store.db.prepare('SELECT * FROM '+table).all());const before=inventory();
    expect(await f.service.dispatch(f.token,{command:'getMessagePreview',eventId:f.eventId,refresh:true})).toEqual({scheduled:true});
    expect(f.hints).toEqual([['100','conv-a',{eventId:f.eventId,source:kind==='OWN'?'CHAT':'INBOUND',purpose:'DISPLAY'},'SELECTION']]);
    expect(inventory()).toEqual(before);
    expect(()=>f.service.authority.requireSelection(f.token,f.eventId,randomUUID())).toThrow('TARGET_SELECTION_CHANGED');
  }finally{await f.close();}
});

test('refresh and cached-image reads are strict mutually exclusive requests',()=>{
  const eventId=randomUUID(),previewId='a'.repeat(64);
  for(const extra of [{},{refresh:false},{refresh:true,previewId},{refresh:true,unknown:true}])
    expect(commandSchema.safeParse({command:'getMessagePreview',eventId,...extra}).success).toBe(false);
  expect(commandSchema.safeParse({command:'getMessagePreview',eventId,previewId}).success).toBe(true);
  expect(commandSchema.safeParse({command:'getMessagePreview',eventId,refresh:true}).success).toBe(true);
});

test('refresh requires CONTROL and enabled exact inbox identity without changing an existing reply selection',async()=>{
  const f=await setup();try{
    const selection=randomUUID();f.service.authority.select(f.token,f.eventId,selection);
    await expect(f.service.dispatch(f.service.authority.issueSession(['READ']),{command:'getMessagePreview',eventId:f.eventId,refresh:true}))
      .rejects.toThrow('OPERATOR_PERMISSION_DENIED');expect(f.hints).toEqual([]);
    f.data.stop(true);expect(await f.service.dispatch(f.token,{command:'getMessagePreview',eventId:f.eventId,refresh:true})).toEqual({scheduled:false});
    f.data.stop(false);f.data.configureCollection({...f.data.state().collection!,inbox:false});
    expect(await f.service.dispatch(f.token,{command:'getMessagePreview',eventId:f.eventId,refresh:true})).toEqual({scheduled:false});
    f.data.configureCollection({...f.data.state().collection!,inbox:true});
    f.store.db.prepare("UPDATE discovered_conversations SET uid='201'").run();
    await expect(f.service.dispatch(f.token,{command:'getMessagePreview',eventId:f.eventId,refresh:true})).rejects.toThrow('MESSAGE_PREVIEW_UNAVAILABLE');
    expect(f.hints).toEqual([]);expect(()=>f.service.authority.requireSelection(f.token,f.eventId,selection)).not.toThrow();
  }finally{await f.close();}
});

test.each(['CURRENT','HISTORY','OWN'] as const)('display-only %s refresh preserves stored carriers and business checkpoints when newly observed text is strong',async kind=>{
  const f=await setup(kind);let collector:InboxCollector|undefined;try{
    const owner={actor:new AccountActor(),dm:{bringToFront:async()=>{}},notification:new EventEmitter(),version:()=> '123.0.0.0'} as unknown as BrowserProfileOwner;
    collector=new InboxCollector(owner,observedMapping('http://fixture.invalid'),f.data,f.root,'headless');Object.assign(f.browser,{collector});
    const peer={uid:'200',secUid:'peer-sec',title:'Fixture peer',conversationId:'conv-a'};
    const cursor={parked:[{peer,phase:'MAX',top:500,height:1000,signature:'old',edge:0,legHasNew:true,
      anchor:{top:500,height:1000,ids:[f.event.platformEventId]}}]};
    f.store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='dm'").run(JSON.stringify(cursor));
    for(let attempt=1;attempt<=2;attempt++)f.store.audit('MESSAGE_PREVIEW_RETRY',f.eventId,{attempt,attemptedAt:Date.now()-300000+attempt});
    const tables=['inbound_events','chat_messages','reply_drafts','send_intents','delivery_receipts','budgets','source_collisions','cursors','collection_progress'];
    const inventory=()=>tables.map(table=>f.store.db.prepare('SELECT * FROM '+table).all()),before=inventory(),windows:(number|undefined)[]=[];
    vi.spyOn(ObservedReader.prototype,'conversations').mockResolvedValue({events:[],loaded:0,unsupported:0,evidenceId:'list',scroll:{top:24,height:100,viewport:60,atEnd:false}});
    vi.spyOn(ObservedReader.prototype,'dmWindow').mockImplementation(async(_peer,top)=>{windows.push(top);return {events:top===500?
      [{...f.event,text:'exact newly readable text',contentType:undefined,observationIssue:undefined}]:[candidate({platformEventId:'79202',actorId:'200',conversationId:'conv-a'})],
      loaded:1,unsupported:0,evidenceId:'fixture',dmViewport:{top:top??0,height:1000,viewport:100,minimum:0,maximum:900}};});
    const captured=vi.spyOn(previews,'saveMessagePreviews').mockImplementation(async(_page,_map,batch)=>{
      expect(batch.events).toEqual([f.event]);new MessagePreviewStore(f.root).saveDisplayText(batch.events[0]!,'100','exact newly readable text');
    });
    expect(await f.service.dispatch(f.token,{command:'getMessagePreview',eventId:f.eventId,refresh:true})).toEqual({scheduled:true});
    await collector.collect('dm',new AbortController().signal);
    expect(windows).toEqual([undefined,500]);expect(captured).toHaveBeenCalledTimes(1);expect(inventory()).toEqual(before);
    expect(new MessagePreviewStore(f.root).displayText(f.event,'100')).toBe('exact newly readable text');
    expect(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='MESSAGE_PREVIEW_RETRY'").get()).toEqual({n:2});
    expect(JSON.parse((f.store.db.prepare("SELECT detail_redacted FROM audit_events WHERE event_type='MESSAGE_PREVIEW_TARGET_ATTEMPT_SELECTION_FOUND'").get() as {detail_redacted:string}).detail_redacted))
      .toEqual({found:true,windows:2,persisted:1,displayOnly:true});
    expect(await f.service.dispatch(f.token,{command:'getMessagePreview',eventId:f.eventId,refresh:true})).toEqual({scheduled:false});
    expect(kind==='OWN'?new ChatMessageStore(f.store).get(f.eventId)?.binding:f.store.event(f.eventId).binding).toBe(eventBinding(f.event));
  }finally{collector?.dispose();await f.close();}
});

test.each(['ACTOR','TIME','DUPLICATE','CANCEL'] as const)('display-only refresh rejects %s before changing a stored historical own message or its cache',async change=>{
  const f=await setup('OWN');let collector:InboxCollector|undefined;try{
    const owner={actor:new AccountActor(),dm:{bringToFront:async()=>{}},notification:new EventEmitter(),version:()=> '123.0.0.0'} as unknown as BrowserProfileOwner;
    collector=new InboxCollector(owner,observedMapping('http://fixture.invalid'),f.data,f.root,'headless');Object.assign(f.browser,{collector});
    const abort=new AbortController(),original=new ChatMessageStore(f.store).get(f.eventId);
    new MessagePreviewStore(f.root).saveDisplayText(f.event,'100','retained exact display');
    vi.spyOn(ObservedReader.prototype,'conversations').mockResolvedValue({events:[],loaded:0,unsupported:0,evidenceId:'list'});
    vi.spyOn(ObservedReader.prototype,'dmWindow').mockImplementation(async()=>{
      if(change==='CANCEL')abort.abort();
      const event=change==='ACTOR'?{...f.event,actorId:'200'}:change==='TIME'?{...f.event,occurredAt:new Date().toISOString()}:f.event;
      return{events:change==='DUPLICATE'?[event,event]:[event],loaded:1,unsupported:1,evidenceId:'fixture'};
    });
    const captured=vi.spyOn(previews,'saveMessagePreviews').mockResolvedValue();
    expect(await f.service.dispatch(f.token,{command:'getMessagePreview',eventId:f.eventId,refresh:true})).toEqual({scheduled:true});
    await expect(collector.collect('dm',abort.signal)).rejects.toThrow(change==='CANCEL'?'COLLECTION_CANCELLED':'OBSERVATION_ROW_IDENTITY_CONFLICT');
    expect(captured).not.toHaveBeenCalled();expect(new ChatMessageStore(f.store).get(f.eventId)).toEqual(original);
    expect(new MessagePreviewStore(f.root).displayText(f.event,'100')).toBe('retained exact display');
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{collector?.dispose();await f.close();}
});
