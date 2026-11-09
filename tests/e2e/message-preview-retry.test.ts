import {afterEach,expect,test,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {join} from 'node:path';
import {readFile,readdir} from 'node:fs/promises';
import {InboxCollector} from '../../src/app/inbox-collector.js';
import {ObservedReader,type DiscoveredPeer} from '../../src/adapters/observed-reader.js';
import {AccountActor} from '../../src/browser/account-actor.js';
import type {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import * as previews from '../../src/adapters/message-preview.js';
import {MessagePreviewStore} from '../../src/storage/message-previews.js';
import {MessageShareStore} from '../../src/storage/message-shares.js';
import {MessagePreviewDiagnostics} from '../../src/observability/message-preview-diagnostics.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {observedMapping} from '../fixtures/observed-site.js';
import {database,privateTemp} from '../helpers.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
const cleanup:(()=>void)[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const close of cleanup.splice(0))close();});
async function setup(){
  const root=privateTemp('message-preview-retry-'),store=database();await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  let now=Date.now();const origin=now-60_000,data=new AutomationStore(store,()=>now);data.initialize(origin);store.bindAccount('100');
  data.configureCollection({ownId:'100',comments:false,inbox:true,commentIntervalMs:30_000,dmIntervalMs:15_000});
  const a:DiscoveredPeer={uid:'200',secUid:'peer-sec',title:'Fixture A',conversationId:'conv-a'},b:DiscoveredPeer={uid:'201',secUid:'peer-b',title:'Fixture B',conversationId:'conv-b'};
  const event={accountId:'account_001' as const,channel:'DIRECT_MESSAGE' as const,platformEventId:'6501',actorId:'200',actorName:a.title,
    text:'[图片或表情消息，需人工查看]',occurredAt:new Date(origin+1000).toISOString(),videoId:null,commentId:null,conversationId:a.conversationId,
    direction:'INCOMING' as const,kind:'DM' as const,evidenceId:'synthetic-preview-retry',contentType:'IMAGE' as const,observationIssue:'DM_CONTENT_UNVERIFIED' as const};
  const calls:string[]=[],mapping=observedMapping('http://127.0.0.1:1'),owner={actor:new AccountActor(),dm:{},notification:new EventEmitter(),version:()=> '123.0.0.0'} as unknown as BrowserProfileOwner;
  vi.spyOn(ObservedReader.prototype,'conversations').mockResolvedValue({events:[],loaded:2,unsupported:0,evidenceId:'fixture-list',peers:[a,b],scroll:{top:24,height:100,viewport:60,atEnd:false}});
  vi.spyOn(ObservedReader.prototype,'dmWindow').mockImplementation(async peer=>{calls.push(peer.conversationId);return {events:peer.conversationId===a.conversationId?[event]:[],loaded:peer.conversationId===a.conversationId?1:0,
    unsupported:peer.conversationId===a.conversationId?1:0,evidenceId:'fixture-window'};});
  const capture=vi.spyOn(previews,'saveMessagePreviews').mockResolvedValue();
  let collector=new InboxCollector(owner,mapping,data,root,'headless');cleanup.push(()=>{collector.dispose();store.close();});
  return {root,store,data,origin,event,a,b,calls,capture,get collector(){return collector;},advance:(ms:number)=>{now+=ms;},
    restart(){collector.dispose();collector=new InboxCollector(owner,mapping,new AutomationStore(store,()=>now),root,'headless');},
    cursor:()=>JSON.parse((store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='dm'").get() as {cursor_json:string}).cursor_json),
    noExternal(){expect(store.db.prepare('SELECT used FROM budgets ORDER BY kind').all()).toEqual([{used:0},{used:0}]);expect(store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});expect(data.state().startedAt).toBe(origin);}};
}

test('new unavailable media is retried without selecting its conversation or leaving Settings, then yields a normal collection turn',async()=>{
  const f=await setup();await f.collector.collect('dm',new AbortController().signal);expect(f.calls).toEqual(['conv-a']);
  f.capture.mockImplementation(async(_page,_mapping,batch)=>{for(const event of batch.events)new MessagePreviewStore(f.root).save(event,'100',[{label:null,png}]);});
  await f.collector.collect('dm',new AbortController().signal);expect(f.calls).toEqual(['conv-a','conv-a']);
  expect(new MessagePreviewStore(f.root).list(f.event,'100')).toMatchObject([{state:'READY'}]);
  await f.collector.collect('dm',new AbortController().signal);expect(f.calls.at(-1)).toBe('conv-b');
  expect(f.store.db.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type='MESSAGE_PREVIEW_RETRY'").get()).toEqual({n:1});f.noExternal();
});

test('failed previews get at most two attempts, observe the same-conversation cooldown, and retain attempt accounting through restart and re-observation',async()=>{
  const f=await setup();await f.collector.collect('dm',new AbortController().signal);await f.collector.collect('dm',new AbortController().signal);
  expect(f.cursor().previewRetries[0]).toMatchObject({attempts:1});
  f.restart();await f.collector.collect('dm',new AbortController().signal);expect(f.calls.at(-1)).toBe('conv-b');
  f.advance(119_999);await f.collector.collect('dm',new AbortController().signal);
  expect(f.store.db.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type='MESSAGE_PREVIEW_RETRY'").get()).toEqual({n:1});
  f.advance(2);await f.collector.collect('dm',new AbortController().signal);
  expect(f.store.db.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type='MESSAGE_PREVIEW_RETRY'").get()).toEqual({n:2});
  f.restart();for(let turn=0;turn<5;turn++){f.advance(120_001);await f.collector.collect('dm',new AbortController().signal);}
  expect(f.store.db.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type='MESSAGE_PREVIEW_RETRY'").get()).toEqual({n:2});f.noExternal();
});

test('cancelling a retry consumes its recorded attempt and a restart still performs normal work before another retry',async()=>{
  const f=await setup();await f.collector.collect('dm',new AbortController().signal);const abort=new AbortController();
  f.capture.mockImplementation(async()=>{abort.abort();});await expect(f.collector.collect('dm',abort.signal)).rejects.toThrow('COLLECTION_CANCELLED');
  expect(f.cursor().previewRetryNeedsNormal).toBe(true);expect(f.cursor().previewRetries[0].attempts).toBe(1);
  f.capture.mockResolvedValue();f.restart();f.advance(120_001);await f.collector.collect('dm',new AbortController().signal);expect(f.calls.at(-1)).toBe('conv-b');f.noExternal();
});

test('the retry queue is bounded to one hundred newly received exact messages and preserves their normal cursor',async()=>{
  const f=await setup(),events=Array.from({length:103},(_,index)=>({...f.event,platformEventId:String(6600+index),occurredAt:new Date(f.origin+2000+index).toISOString()}));
  f.store.observe('DIRECT_MESSAGE','conv-a',events,'100','synthetic-retry-cap',new Date(f.data.now()).toISOString(),f.origin);
  f.store.db.prepare('INSERT INTO discovered_conversations VALUES(?,?,?,?,?,?,?,0)').run('conv-a','100','200','peer-sec','Fixture A',f.data.now(),f.data.now());
  await f.collector.collect('dm',new AbortController().signal);expect(f.cursor().previewRetries).toHaveLength(100);
  expect(f.cursor().previewRetries.every((item:{attempts:number})=>item.attempts<=1)).toBe(true);
  expect(f.cursor().previewRetryNeedsNormal).toBe(true);expect(f.cursor().sweep).toBeUndefined();f.noExternal();
});

test('an explicitly selected pending conversation retains priority over an automatic thumbnail retry',async()=>{
  const f=await setup();await f.collector.collect('dm',new AbortController().signal);expect(f.collector.prioritize('100','conv-b')).toBe(true);
  await f.collector.collect('dm',new AbortController().signal);expect(f.calls.at(-1)).toBe('conv-b');
  expect(f.store.db.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type='MESSAGE_PREVIEW_RETRY'").get()).toEqual({n:0});f.noExternal();
});

test('a failed media peer yields normal work before a different eligible media peer is retried',async()=>{
  const f=await setup();await f.collector.collect('dm',new AbortController().signal);
  const other={...f.event,platformEventId:'6801',actorId:'201',conversationId:'conv-b'};
  f.store.observe('DIRECT_MESSAGE','conv-b',[other],'100','synthetic-retry-peer',new Date(f.data.now()).toISOString(),f.origin);
  const otherId=f.store.events().find(event=>event.payload.platformEventId==='6801')!.id;
  f.store.audit('MESSAGE_PREVIEW_RETRY',otherId,{attempt:1,attemptedAt:f.data.now()-120_001});
  vi.mocked(ObservedReader.prototype.dmWindow).mockImplementation(async peer=>{f.calls.push(peer.conversationId);return {events:[peer.conversationId==='conv-a'?f.event:other],loaded:1,unsupported:1,evidenceId:'fixture'};});
  f.capture.mockImplementation(async(_page,_mapping,batch)=>{for(const event of batch.events)if(event.conversationId==='conv-b')new MessagePreviewStore(f.root).save(event,'100',[{label:null,png}]);});
  await f.collector.collect('dm',new AbortController().signal);expect(f.calls.at(-1)).toBe('conv-a');
  await f.collector.collect('dm',new AbortController().signal);expect(f.calls.at(-1)).toBe('conv-b');
  // Remove the normal-turn synthetic cache to prove the next eligible priority can independently retry B.
  new MessagePreviewStore(f.root).save(other,'100',[]);
  await f.collector.collect('dm',new AbortController().signal);expect(f.calls.at(-1)).toBe('conv-b');
  expect(new MessagePreviewStore(f.root).list(other,'100')).toMatchObject([{state:'READY'}]);f.noExternal();
});

test.each(['BASELINE','BEFORE_ORIGIN','SHARE','READY','STOPPED'] as const)('automatic retries skip %s without spending an attempt',async kind=>{
  const f=await setup();await f.collector.collect('dm',new AbortController().signal);const stored=f.store.events()[0]!;
  if(kind==='BASELINE')f.store.db.prepare("UPDATE inbound_events SET status='BASELINE' WHERE id=?").run(stored.id);
  if(kind==='BEFORE_ORIGIN')f.store.db.prepare("UPDATE inbound_events SET payload=json_set(payload,'$.occurredAt',?) WHERE id=?").run(new Date(f.origin-1000).toISOString(),stored.id);
  if(kind==='SHARE')new MessageShareStore(f.root).save(f.event,'100',{kind:'DOUYIN_WORK',workId:'12345',url:'https://www.douyin.com/video/12345'});
  if(kind==='READY')new MessagePreviewStore(f.root).save(f.event,'100',[{label:null,png}]);
  if(kind==='STOPPED')f.data.stop(true);
  const task=f.collector.collect('dm',new AbortController().signal);if(kind==='STOPPED')await expect(task).rejects.toThrow('COLLECTION_CANCELLED');else await task;
  expect(f.store.db.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type='MESSAGE_PREVIEW_RETRY'").get()).toEqual({n:0});f.noExternal();
});

test('the last nonempty media diagnostic survives an empty batch in one fixed additional file',async()=>{
  const root=privateTemp('preview-nonempty-'),media=new MessagePreviewDiagnostics();media.snapshot.batchDMcount=2;media.snapshot.eligibleCount=1;media.increment('unavailable','MESSAGE_PREVIEW_OBSCURED');await media.save(root);
  const empty=new MessagePreviewDiagnostics();await empty.save(root);
  expect(JSON.parse(await readFile(join(root,'evidence','message-preview-latest.json'),'utf8')).batchDMcount).toBe(0);
  expect(JSON.parse(await readFile(join(root,'evidence','message-preview-last-nonempty.json'),'utf8'))).toMatchObject({batchDMcount:2,eligibleCount:1,unavailable:{MESSAGE_PREVIEW_OBSCURED:1}});
  expect((await readdir(join(root,'evidence'))).sort()).toEqual(['message-preview-last-nonempty.json','message-preview-latest.json']);
});
