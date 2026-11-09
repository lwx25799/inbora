import {afterEach,expect,test,vi} from 'vitest';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {AccountActor} from '../../src/browser/account-actor.js';
import type {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {ObservedReader,type ObservationBatch,type DiscoveredPeer} from '../../src/adapters/observed-reader.js';
import {InboxCollector} from '../../src/app/inbox-collector.js';
import {readDmActivity} from '../../src/app/dm-activity.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {Blocked,digest} from '../../src/core/contracts.js';
import {observedMapping} from '../fixtures/observed-site.js';
import {database,privateTemp} from '../helpers.js';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of cleanup.splice(0))await close();});
async function setup(){
  const root=privateTemp('dm-activity-fairness-'),store=database();await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  let now=Date.now(),revision=0;const data=new AutomationStore(store,()=>now),origin=now-60_000;data.initialize(origin);store.bindAccount('100');
  data.configureCollection({ownId:'100',comments:false,inbox:true,commentIntervalMs:30_000,dmIntervalMs:30_000});
  const a:DiscoveredPeer={uid:'200',secUid:'peer-sec',conversationId:'conv-a',title:'Fixture A'},b:DiscoveredPeer={uid:'201',secUid:'peer-b',conversationId:'conv-b',title:'Fixture B'};
  const calls:string[]=[],mapping=observedMapping('http://127.0.0.1:1');
  const owner={actor:new AccountActor(),dm:{},notification:new EventEmitter(),version:()=> '123.0.0.0'} as unknown as BrowserProfileOwner;
  const batch=(peer:DiscoveredPeer):ObservationBatch=>({loaded:1,unsupported:0,evidenceId:'synthetic-activity',events:[{
    accountId:'account_001',channel:'DIRECT_MESSAGE',platformEventId:peer===a?'6301':'6302',actorId:peer.uid!,actorName:peer.title,text:'synthetic full text',
    occurredAt:new Date(origin+1000).toISOString(),videoId:null,commentId:null,conversationId:peer.conversationId,direction:'INCOMING',kind:'DM',evidenceId:'synthetic-activity'}],
    ...(peer.conversationId==='conv-b'?{dmViewport:{top:0,height:144,viewport:144,minimum:0,maximum:0}}:{})});
  vi.spyOn(ObservedReader.prototype,'conversations').mockImplementation(async()=>({events:[],loaded:2,unsupported:0,evidenceId:'synthetic-list',
    peers:[{...a,activity:String(revision)},{...b,activity:'0'}]}));
  vi.spyOn(ObservedReader.prototype,'dmWindow').mockImplementation(async peer=>{calls.push(peer.conversationId);return batch(peer.conversationId==='conv-a'?a:b);});
  vi.spyOn(ObservedReader.prototype,'scrollDm').mockResolvedValue();
  let collector=new InboxCollector(owner,mapping,data,root,'headless');cleanup.push(async()=>{collector.dispose();store.close();});
  return {store,data,a,b,owner,mapping,calls,batch,get collector(){return collector;},advance:(ms:number)=>{now+=ms;revision++;},
    restart(){collector.dispose();collector=new InboxCollector(owner,mapping,data,root,'headless');},
    cursor:()=>JSON.parse((store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='dm'").get() as {cursor_json:string}).cursor_json)};
}

test.each([32_000,61_000])('continuous top activity still gives the next normal turn to an unfinished peer after restart (%s ms cadence)',async cadence=>{
  const f=await setup();await f.collector.collect('dm',new AbortController().signal);expect(f.calls).toEqual(['conv-a']);
  const cursor=f.cursor();cursor.parked=[{peer:f.b,phase:'MIN',top:0,height:144,signature:digest([['6302',f.batch(f.b).events[0]!.occurredAt]]),edge:0,legHasNew:true,minimumOld:false}];
  f.store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='dm'").run(JSON.stringify(cursor));
  f.advance(cadence);await f.collector.collect('dm',new AbortController().signal);expect(f.calls.at(-1)).toBe('conv-a');
  f.restart();f.advance(cadence);await f.collector.collect('dm',new AbortController().signal);expect(f.calls.at(-1)).toBe('conv-b');
  expect(f.cursor().activityNeedsNormal).toBe(false);
  f.advance(cadence);await f.collector.collect('dm',new AbortController().signal);expect(f.calls.at(-1)).toBe('conv-a');
  expect(f.store.db.prepare('SELECT kind,used FROM budgets ORDER BY kind').all()).toEqual([{kind:'MODEL',used:0},{kind:'SEND',used:0}]);
  expect(f.store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
});

test.each(['PLATFORM_STOP','OBSERVATION_ACCOUNT_CHANGED'])('a primary %s does not attempt restore or lose the stop to a later ordinary restore error',async code=>{
  const f=await setup(),conversations=vi.mocked(ObservedReader.prototype.conversations);let calls=0;
  conversations.mockImplementation(async()=>{if(++calls>1)throw new Blocked('OBSERVATION_METADATA_NOT_READY');return {events:[],loaded:1,unsupported:0,evidenceId:'fixture',peers:[f.a]};});
  vi.mocked(ObservedReader.prototype.dmWindow).mockRejectedValue(new Blocked(code));
  const reader=new ObservedReader(f.owner.dm,f.mapping),activity={next:0,initialized:true,items:[]};
  await expect(readDmActivity(reader,f.data,activity,new AbortController().signal,async()=>{},()=>{})).rejects.toThrow(code);expect(calls).toBe(1);
});

test('a repeatedly changing but unreadable activity peer also yields to unfinished normal work after restart',async()=>{
  const f=await setup();await f.collector.collect('dm',new AbortController().signal);
  const cursor=f.cursor();cursor.parked=[{peer:f.b,phase:'MIN',top:0,height:144,signature:'synthetic-pending',edge:0,legHasNew:true,minimumOld:false}];
  f.store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='dm'").run(JSON.stringify(cursor));
  vi.mocked(ObservedReader.prototype.dmWindow).mockImplementation(async peer=>{
    f.calls.push(peer.conversationId);if(peer.conversationId==='conv-a')throw new Blocked('OBSERVATION_DM_CONTENT_DOM_NOT_READY');return f.batch(f.b);
  });
  f.advance(61_000);await expect(f.collector.collect('dm',new AbortController().signal)).rejects.toThrow('OBSERVATION_DM_CONTENT_DOM_NOT_READY');
  f.restart();f.advance(61_000);await f.collector.collect('dm',new AbortController().signal);expect(f.calls.at(-1)).toBe('conv-b');
});

test('a restoration platform stop remains visible when the read succeeded, and ordinary restoration errors are not swallowed',async()=>{
  const f=await setup(),conversations=vi.mocked(ObservedReader.prototype.conversations);let calls=0,code='PLATFORM_STOP';
  conversations.mockImplementation(async()=>{if(++calls%2===0)throw new Blocked(code);return {events:[],loaded:1,unsupported:0,evidenceId:'fixture',peers:[f.a]};});
  const reader=new ObservedReader(f.owner.dm,f.mapping);
  for(const next of ['PLATFORM_STOP','OBSERVATION_METADATA_NOT_READY']){
    code=next;await expect(readDmActivity(reader,f.data,{next:0,initialized:true,items:[]},new AbortController().signal,async()=>{},()=>{})).rejects.toThrow(next);
  }
});
