import {expect,test,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {join} from 'node:path';
import type {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {AccountActor} from '../../src/browser/account-actor.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {InboxCollector} from '../../src/app/inbox-collector.js';
import {CollectionScheduler} from '../../src/app/collection-scheduler.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {EventStore} from '../../src/storage/store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {Blocked} from '../../src/core/contracts.js';
import {candidate,privateTemp} from '../helpers.js';
import {observedMapping} from '../fixtures/observed-site.js';

test.each(['OBSERVATION_COMMENT_SCROLL_UNAVAILABLE','OBSERVATION_CANCELLED','OBSERVATION_ACCOUNT_CHANGED'] as const)(
  'an incomplete child window is checkpointed before its failure cleanup scroll can fail: %s',async secondary=>{
  const root=privateTemp('comment-thread-failure-checkpoint-'),file=join(root,'poc.sqlite');let store=new EventStore(file,true);
  await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  const now=Date.now(),origin=now-60_000,mapping=observedMapping('http://127.0.0.1:1'),page=new EventEmitter();
  Object.assign(page,{bringToFront:async()=>{},url:()=>mapping.works[0]!.url,mainFrame:()=>({})});
  const owner={notification:page,actor:new AccountActor(),version:()=> '1.2.3.4'} as unknown as BrowserProfileOwner;
  let data=new AutomationStore(store,()=>now);data.initialize(origin);store.bindAccount('100');
  data.configureCollection({ownId:'100',comments:true,inbox:false,commentIntervalMs:30_000,dmIntervalMs:30_000});
  data.registerWork({id:'20',ownId:'100',url:mapping.origin+'/video/20',publishedAt:origin+1000,precisionMs:1});
  store.db.prepare("INSERT INTO work_collection_progress VALUES('10',40,1000,0,123,NULL,0)").run();
  store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='works'").run(JSON.stringify({phase:'comments'}));
  const signal=new AbortController(),reads:string[]=[];
  const event=(id:string,work='10')=>candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',actorId:'200',videoId:work,
    platformEventId:id,commentId:id,conversationId:null,occurredAt:new Date(origin+1000).toISOString()});
  const comments=vi.spyOn(ObservedReader.prototype,'comments').mockImplementation(async function(this:ObservedReader){
    const work=this.mapping.works[0]!.id;reads.push(work);const id=work==='10'?'11':'22';
    return{events:[event(id,work)],evidenceId:'synthetic',loaded:1,unsupported:0,
      scroll:{top:40,height:1000,viewport:100,atEnd:false},commentThreads:[{id,total:work==='10'?3:0,mounted:0,expandable:work==='10'}]};
  });
  const thread=vi.spyOn(ObservedReader.prototype,'commentThread').mockImplementation(async()=>({
    events:[event('11'),...['21','22'].map(id=>({...event(id),kind:'REPLY' as const,rootCommentId:'11',replyToCommentId:id}))],
    evidenceId:'synthetic',loaded:3,unsupported:0,
    commentThread:{initialTotal:3,beforeTotal:3,total:3,mounted:2,offset:0,nextOffset:2,expandable:false,expanded:false},
  }));
  const advance=vi.spyOn(ObservedReader.prototype,'advanceComments').mockImplementation(async()=>{
    if(secondary==='OBSERVATION_CANCELLED')signal.abort();throw new Blocked(secondary);
  });
  let collector=new InboxCollector(owner,mapping,data,root,'headless'),scheduler:CollectionScheduler|undefined;
  const cursor=()=>JSON.parse((store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='works'").get() as {cursor_json:string}).cursor_json);
  try{
    scheduler=new CollectionScheduler(data,(source,readingSignal)=>collector.collect(source,readingSignal));
    const first=scheduler.runNow('works',signal.signal);
    if(secondary==='OBSERVATION_COMMENT_SCROLL_UNAVAILABLE')await expect(first).resolves.toEqual({deferredCode:secondary});
    else await expect(first).rejects.toThrow(secondary==='OBSERVATION_CANCELLED'?'COLLECTION_CANCELLED':secondary);
    expect(store.db.prepare("SELECT next_at,last_success,last_error,failures FROM collection_progress WHERE source='works'").get()).toEqual({
      next_at:now+(secondary==='OBSERVATION_ACCOUNT_CHANGED'?60_000:30_000),last_success:null,
      last_error:secondary==='OBSERVATION_CANCELLED'?null:secondary,failures:secondary==='OBSERVATION_CANCELLED'?0:1});
    expect(data.state().emergencyStopped).toBe(secondary==='OBSERVATION_ACCOUNT_CHANGED');
    await scheduler.close();scheduler=undefined;
    expect(thread).toHaveBeenCalledTimes(1);expect(advance).toHaveBeenCalledTimes(1);
    const saved=cursor();expect(saved).toMatchObject({phase:'comments',workIndex:1,threadBurst:0});
    expect(saved.commentThreads).toHaveLength(1);
    expect(saved.commentThreads[0]).toMatchObject({workId:'10',id:'11',total:3,seen:['21','22'],offset:2,done:false,turn:1,retryAt:now+120_000});
    const progress=store.db.prepare("SELECT scroll_top,last_read,last_error,next_at FROM work_collection_progress WHERE work_id='10'").get();
    expect(progress).toEqual({scroll_top:40,last_read:123,last_error:'OBSERVATION_COMMENT_THREAD_INCOMPLETE',next_at:now+120_000});
    collector.dispose();store.close();store=new EventStore(file);data=new AutomationStore(store,()=>now);
    collector=new InboxCollector(owner,mapping,data,root,'headless');expect(cursor()).toEqual(saved);
    // Simulate explicit recovery after the account-stop case; restarting alone cannot clear it.
    if(secondary==='OBSERVATION_ACCOUNT_CHANGED'){expect(data.state().emergencyStopped).toBe(true);data.stop(false);}
    advance.mockResolvedValue({top:0,height:100,viewport:100,atEnd:true});
    await collector.collect('works',new AbortController().signal);expect(reads).toEqual(['10','20']);
    expect(store.db.prepare("SELECT scroll_top,last_read,last_error,next_at FROM work_collection_progress WHERE work_id='10'").get()).toEqual(progress);
    expect(store.budgets().map(b=>b.used)).toEqual([0,0]);expect(store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
    expect(store.db.prepare('SELECT count(*) n FROM model_calls').get()).toEqual({n:0});expect(data.state().startedAt).toBe(origin);
  }finally{await scheduler?.close();collector.dispose();comments.mockRestore();thread.mockRestore();advance.mockRestore();store.close();}
});
