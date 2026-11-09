import {expect,test,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {join} from 'node:path';
import type {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {AccountActor} from '../../src/browser/account-actor.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {InboxCollector} from '../../src/app/inbox-collector.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {Blocked} from '../../src/core/contracts.js';
import {candidate,database,privateTemp} from '../helpers.js';
import {observedMapping} from '../fixtures/observed-site.js';

async function fixture(options:{pending?:boolean;head?:boolean;burst?:number;second?:'cancel'|'account';terminal?:boolean}={}){
  const root=privateTemp('comment-root-burst-'),store=database();
  await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  const now=Date.now(),origin=now-60_000,mapping=observedMapping('http://127.0.0.1:1'),frame={};
  const page=new EventEmitter() as EventEmitter&{url:()=>string;mainFrame:()=>unknown};let work='10',top=options.head?80:0,advances=0;
  page.url=()=>mapping.origin+'/video/'+work;page.mainFrame=()=>frame;
  Object.assign(page,{bringToFront:vi.fn(async()=>{})});
  const owner={notification:page,actor:new AccountActor(),version:()=> '1.2.3.4'} as unknown as BrowserProfileOwner;
  const data=new AutomationStore(store,()=>now);data.initialize(origin);store.bindAccount('100');
  data.configureCollection({ownId:'100',comments:true,inbox:false,commentIntervalMs:30_000,dmIntervalMs:30_000});
  data.registerWork({id:'20',ownId:'100',url:mapping.origin+'/video/20',publishedAt:origin+1000,precisionMs:1});
  store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='works'").run(JSON.stringify({phase:'comments',
    pendingRootPages:options.pending?['10']:[],headPending:options.head?['10']:[],threadBurst:options.burst??0}));
  if(options.head)store.db.prepare("INSERT INTO work_collection_progress VALUES('10',80,1000,0,0,NULL,0)").run();
  const controller=new AbortController(),reads:{work:string;offset:number}[]=[];
  const progress=()=>store.db.prepare("SELECT scroll_top,last_read,end_observations FROM work_collection_progress WHERE work_id='10'").get();
  const cursor=()=>JSON.parse((store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='works'").get() as {cursor_json:string}).cursor_json);
  const response=(more:boolean)=>{
    const request={method:()=> 'GET',frame:()=>frame,url:()=>mapping.origin+'/aweme/v1/web/comment/list/?aweme_id=10&cursor='+(more?'0':'5')};
    page.emit('request',request);page.emit('response',{request:()=>request,status:()=>200,fromServiceWorker:()=>false,headers:()=>({}),
      body:async()=>Buffer.from(JSON.stringify({status_code:0,total:10,has_more:Number(more),cursor:more?5:10,comments:[]}))});
  };
  const comments=vi.spyOn(ObservedReader.prototype,'comments').mockImplementation(async function(this:ObservedReader,_index,_all,offset=0){
    work=this.mapping.works[0]!.id;top=offset;reads.push({work,offset});
    if(work==='10'&&reads.length===2){
      expect(progress()).toEqual({scroll_top:80,last_read:0,end_observations:0});
      expect(cursor().threadBurst).toBe(1);
      if(options.second==='cancel')controller.abort();
      if(options.second==='account')throw new Blocked('OBSERVATION_ACCOUNT_CHANGED');
    }
    if(options.terminal&&reads.length===1)response(true);
    const id=work==='20'?'2001':offset>0?'9901':'1101';
    return{events:[candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',actorId:'200',platformEventId:id,commentId:id,videoId:work,
      conversationId:null,occurredAt:new Date(origin+1000).toISOString()})],evidenceId:'synthetic',loaded:1,unsupported:0,
      commentThreads:[{id,total:0,mounted:0,expandable:false}],scroll:{top,height:1000,viewport:100,atEnd:false}};
  });
  const advance=vi.spyOn(ObservedReader.prototype,'advanceComments').mockImplementation(async()=>{
    advances++;top+=80;if(options.terminal&&advances===1)response(false);
    return{top,height:1000,viewport:100,atEnd:false};
  });
  const collector=new InboxCollector(owner,mapping,data,root,'headless');
  return{collector,controller,reads,cursor,progress,store,data,origin,close:()=>{collector.dispose();comments.mockRestore();advance.mockRestore();store.close();}};
}

test('one collection captures a known next root window within the original two-window quantum, then yields to another work',async()=>{
  const f=await fixture({terminal:true});
  try{
    await f.collector.collect('works',f.controller.signal);
    expect(f.collector.owner.notification.bringToFront).toHaveBeenCalledTimes(1);
    expect(f.reads).toEqual([{work:'10',offset:0},{work:'10',offset:80}]);
    expect(f.store.events().some(event=>event.payload.commentId==='9901')).toBe(true);
    expect(f.cursor()).toMatchObject({workIndex:1,threadBurst:0,headPending:['10'],pendingRootPages:[]});
    await f.collector.collect('works',f.controller.signal);
    expect(f.reads.at(-1)).toEqual({work:'20',offset:0});expect(f.reads).toHaveLength(3);
    expect(f.data.state().startedAt).toBe(f.origin);expect(f.data.state().collection?.commentIntervalMs).toBe(30_000);
    expect(f.store.budgets().map(b=>b.used)).toEqual([0,0]);expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{f.close();}
});

test.each([{name:'ordinary',options:{}},{name:'head probe',options:{pending:true,head:true}},{name:'last quantum window',options:{pending:true,burst:1}}])(
  '$name keeps its existing single-window behavior',async({options})=>{
    const f=await fixture(options);
    try{await f.collector.collect('works',f.controller.signal);expect(f.reads).toHaveLength(1);}
    finally{f.close();}
  });

test.each(['cancel','account'] as const)('a %s during the second root read retains the first persisted checkpoint without success',async second=>{
  const f=await fixture({pending:true,second});
  try{
    await expect(f.collector.collect('works',f.controller.signal)).rejects.toThrow(second==='cancel'?'COLLECTION_CANCELLED':'OBSERVATION_ACCOUNT_CHANGED');
    expect(f.reads).toHaveLength(2);expect(f.progress()).toEqual({scroll_top:80,last_read:0,end_observations:0});
    expect(f.cursor()).toMatchObject({workIndex:0,threadBurst:1,pendingRootPages:['10']});
    expect(f.store.events().some(event=>event.payload.commentId==='9901')).toBe(false);
    expect(f.store.budgets().map(b=>b.used)).toEqual([0,0]);expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{f.close();}
});

test('a cancelled source never activates either browser page or reads a root window',async()=>{
  const f=await fixture({pending:true});
  try{
    f.controller.abort();await expect(f.collector.collect('works',f.controller.signal)).rejects.toThrow('COLLECTION_CANCELLED');
    expect(f.collector.owner.notification.bringToFront).not.toHaveBeenCalled();expect(f.reads).toHaveLength(0);
  }finally{f.close();}
});
