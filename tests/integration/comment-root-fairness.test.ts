import {expect,test,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {join} from 'node:path';
import {InboxCollector} from '../../src/app/inbox-collector.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {OwnWorksDiscovery} from '../../src/adapters/own-works-discovery.js';
import type {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {AccountActor} from '../../src/browser/account-actor.js';
import {Blocked} from '../../src/core/contracts.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {observedMapping} from '../fixtures/observed-site.js';
import {candidate,database,privateTemp} from '../helpers.js';

test('continuous new roots at the head do not starve head refresh, another work or own-work discovery',async()=>{
  const root=privateTemp('comment-root-fairness-'),store=database();
  await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  let now=Date.now(),height=1000,top=800;const origin=now-60_000,data=new AutomationStore(store,()=>now);data.initialize(origin);store.bindAccount('100');
  data.configureCollection({ownId:'100',comments:true,inbox:false,commentIntervalMs:15_000,dmIntervalMs:15_000});
  data.registerWork({id:'20',ownId:'100',url:'http://127.0.0.1:1/video/20',publishedAt:origin+1000,precisionMs:1});
  store.db.prepare("INSERT INTO work_collection_progress VALUES('10',800,1000,0,0,NULL,0)").run();
  store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='works'").run(JSON.stringify({phase:'comments'}));
  const mapping=observedMapping('http://127.0.0.1:1'),owner={notification:new EventEmitter(),actor:new AccountActor(),version:()=> '1.2.3.4'} as unknown as BrowserProfileOwner;
  Object.assign(owner.notification,{bringToFront:async()=>{}});
  const reads:{work:string;offset:number}[]=[];let cancelOnRead:AbortController|undefined,stopOnRead=false;
  const comments=vi.spyOn(ObservedReader.prototype,'comments').mockImplementation(async function(this:ObservedReader,_index,_all,offset=0){
    const work=this.mapping.works[0]!.id;reads.push({work,offset});top=offset;
    if(stopOnRead)throw new Blocked('OBSERVATION_ACCOUNT_CHANGED');
    cancelOnRead?.abort();
    const id=work==='10'?(offset===0?'9991':'1101'):'2001';
    const event=candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',videoId:work,commentId:id,platformEventId:id,actorId:'200',conversationId:null,occurredAt:new Date(origin+1000).toISOString()});
    return{events:[event],evidenceId:'synthetic',loaded:1,unsupported:0,scroll:{top:offset,height:work==='10'?height:100,viewport:100,atEnd:work!=='10'},
      bindings:[{targetKey:`comment:${work}:${id}`,uid:'200',secUid:'peer-sec',title:'Synthetic',conversationId:null}],commentThreads:[{id,total:0,mounted:0,expandable:false}]};
  });
  const advance=vi.spyOn(ObservedReader.prototype,'advanceComments').mockImplementation(async function(this:ObservedReader){
    if(this.mapping.works[0]!.id!=='10')return{top:0,height:100,viewport:100,atEnd:true};
    top=Math.min(height-100,top+80);return{top,height,viewport:100,atEnd:top>=height-101};
  });
  const discovery=vi.spyOn(OwnWorksDiscovery.prototype,'scan').mockResolvedValue({works:[],pending:[],complete:true});
  let collector=new InboxCollector(owner,mapping,data,root,'headless');
  try{
    for(let turn=0;turn<12;turn++){
      // Each normal new head row grows the native scroll height; it never makes an old tail a stable end.
      const progress=store.db.prepare("SELECT * FROM work_collection_progress WHERE work_id='10'").get(),count=reads.length;
      height+=24;now+=15_000;await collector.collect('works',new AbortController().signal);
      if(reads.length>count&&reads.at(-1)?.work==='10'&&reads.at(-1)?.offset===0)
        expect(store.db.prepare("SELECT * FROM work_collection_progress WHERE work_id='10'").get()).toEqual(progress);
      if(turn===2){collector.dispose();collector=new InboxCollector(owner,mapping,new AutomationStore(store,()=>now),root,'headless');}
    }
    expect(store.events().some(event=>event.payload.commentId==='9991'),JSON.stringify(reads)).toBe(true);
    expect(store.events().some(event=>event.payload.videoId==='20')).toBe(true);expect(discovery).toHaveBeenCalled();
    expect(reads.filter(read=>read.work==='10').some(read=>read.offset>=800)).toBe(true);
    const cursor=JSON.parse((store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='works'").get() as {cursor_json:string}).cursor_json);
    store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='works'").run(JSON.stringify({...cursor,phase:'comments',workIndex:0,headPending:['10']}));
    const progress=store.db.prepare("SELECT * FROM work_collection_progress WHERE work_id='10'").get();
    cancelOnRead=new AbortController();await expect(collector.collect('works',cancelOnRead.signal)).rejects.toThrow('COLLECTION_CANCELLED');
    expect(reads.at(-1)).toEqual({work:'10',offset:0});
    expect(store.db.prepare("SELECT * FROM work_collection_progress WHERE work_id='10'").get()).toEqual(progress);
    const pending=JSON.parse((store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='works'").get() as {cursor_json:string}).cursor_json);
    expect(pending.headPending).toEqual(['10']);expect(pending.workIndex).toBe(0);
    cancelOnRead=undefined;stopOnRead=true;
    await expect(collector.collect('works',new AbortController().signal)).rejects.toThrow('OBSERVATION_ACCOUNT_CHANGED');
    expect(store.db.prepare("SELECT * FROM work_collection_progress WHERE work_id='10'").get()).toEqual(progress);
    expect(JSON.parse((store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='works'").get() as {cursor_json:string}).cursor_json)).toEqual(pending);
    expect(data.state().startedAt).toBe(origin);expect(store.budgets().map(b=>b.used)).toEqual([0,0]);
    expect(store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{collector.dispose();comments.mockRestore();advance.mockRestore();discovery.mockRestore();store.close();}
});
