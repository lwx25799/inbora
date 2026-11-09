import {expect,test,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {join} from 'node:path';
import type {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {AccountActor} from '../../src/browser/account-actor.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {OwnWorksDiscovery} from '../../src/adapters/own-works-discovery.js';
import {InboxCollector} from '../../src/app/inbox-collector.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {candidate,database,privateTemp} from '../helpers.js';
import {observedMapping} from '../fixtures/observed-site.js';

test('a stable DOM end cannot finish a known more-page response, and normal scroll still reaches the next native page fairly after restart',async()=>{
  const root=privateTemp('comment-root-pages-'),store=database();await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  let now=Date.now(),top=0,pageNumber=1,advances=0;const origin=now-60_000,mapping=observedMapping('http://127.0.0.1:1'),frame={};
  const page=new EventEmitter() as EventEmitter&{url:()=>string;mainFrame:()=>unknown};let currentWork='10';
  page.url=()=>mapping.origin+'/video/'+currentWork;page.mainFrame=()=>frame;
  Object.assign(page,{bringToFront:async()=>{}});
  const owner={notification:page,actor:new AccountActor(),version:()=> '1.2.3.4'} as unknown as BrowserProfileOwner;
  const data=new AutomationStore(store,()=>now);data.initialize(origin);store.bindAccount('100');data.configureCollection({ownId:'100',comments:true,inbox:false,commentIntervalMs:15_000,dmIntervalMs:15_000});
  data.registerWork({id:'20',ownId:'100',url:mapping.origin+'/video/20',publishedAt:origin+1000,precisionMs:1});
  store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='works'").run(JSON.stringify({phase:'comments'}));
  const wire=(more:boolean)=>{
    const request={method:()=> 'GET',frame:()=>frame,url:()=>mapping.origin+'/aweme/v1/web/comment/list/?aweme_id=10&cursor='+(more?'0':'5')};
    page.emit('request',request);page.emit('response',{request:()=>request,status:()=>200,fromServiceWorker:()=>false,headers:()=>({}),body:async()=>Buffer.from(JSON.stringify({
      status_code:0,total:10,has_more:Number(more),cursor:more?5:10,comments:[]}))});
  };
  const reads:{work:string;offset:number;page:number}[]=[];
  const comments=vi.spyOn(ObservedReader.prototype,'comments').mockImplementation(async function(this:ObservedReader,_index,_all,offset=0){
    currentWork=this.mapping.works[0]!.id;top=offset;reads.push({work:currentWork,offset,page:pageNumber});
    if(currentWork==='10'&&reads.filter(read=>read.work==='10').length===1)wire(true);
    const id=currentWork==='20'?'2001':pageNumber===2?'9901':'1101',event=candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',actorId:'200',platformEventId:id,commentId:id,videoId:currentWork,
      conversationId:null,occurredAt:new Date(origin+1000).toISOString()});
    return{events:[event],evidenceId:'synthetic',loaded:1,unsupported:0,commentThreads:[{id,total:0,mounted:0,expandable:false}],scroll:{top,height:100,viewport:20,atEnd:true}};
  });
  const advance=vi.spyOn(ObservedReader.prototype,'advanceComments').mockImplementation(async function(this:ObservedReader){
    if(this.mapping.works[0]!.id==='10'){advances++;top=80;if(advances===3){pageNumber=2;wire(false);}}
    return{top:this.mapping.works[0]!.id==='10'?top:0,height:100,viewport:20,atEnd:true};
  });
  const discovery=vi.spyOn(OwnWorksDiscovery.prototype,'scan').mockResolvedValue({works:[],pending:[],complete:true});
  let collector=new InboxCollector(owner,mapping,data,root,'headless');
  const progress=()=>store.db.prepare("SELECT scroll_top,end_observations,last_read FROM work_collection_progress WHERE work_id='10'").get();
  try{
    await collector.collect('works',new AbortController().signal);expect(progress()).toMatchObject({scroll_top:80,end_observations:0,last_read:0});
    collector.dispose();collector=new InboxCollector(owner,mapping,new AutomationStore(store,()=>now),root,'headless');
    await collector.collect('works',new AbortController().signal);expect(progress()).toMatchObject({scroll_top:80,end_observations:0,last_read:0});
    let completed=false;const checkpoints:unknown[]=[];
    // Two works, a persisted head probe and discovery consume the fair rotation before the second stable tail read.
    for(let turn=0;turn<17;turn++){
      now+=15_000;await collector.collect('works',new AbortController().signal);
      const current=progress() as {scroll_top:number;last_read:number};
      checkpoints.push({turn,...current,cursor:JSON.parse((store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='works'").get() as {cursor_json:string}).cursor_json)});
      if(pageNumber===2&&!reads.some(read=>read.work==='10'&&read.page===2))expect(current.last_read).toBe(0);
      if(current.scroll_top===0&&current.last_read>0)completed=true;
    }
    expect(store.events().some(event=>event.payload.commentId==='9901'),JSON.stringify(reads)).toBe(true);
    expect(store.events().some(event=>event.payload.videoId==='20')).toBe(true);expect(discovery).toHaveBeenCalled();expect(advances).toBeGreaterThanOrEqual(3);
    const saved=JSON.parse((store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='works'").get() as {cursor_json:string}).cursor_json);
    expect(saved.pendingRootPages).not.toContain('10');expect(completed,JSON.stringify(checkpoints)).toBe(true);
    expect((progress() as {last_read:number}).last_read).toBeGreaterThan(0);
    expect(data.state().startedAt).toBe(origin);expect(store.budgets().map(b=>b.used)).toEqual([0,0]);expect(store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{collector.dispose();comments.mockRestore();advance.mockRestore();discovery.mockRestore();store.close();}
});

test('mixed old and new comments on a hot-sorted first page never hide new comments on a later hasMore page',async()=>{
  const root=privateTemp('comment-root-mixed-pages-'),store=database();
  await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  let now=Date.now(),pageNumber=1,advances=0;const origin=now-60_000,mapping=observedMapping('http://127.0.0.1:1'),frame={};
  const page=new EventEmitter() as EventEmitter&{url:()=>string;mainFrame:()=>unknown};
  page.url=()=>mapping.works[0]!.url;page.mainFrame=()=>frame;Object.assign(page,{bringToFront:async()=>{}});
  const owner={notification:page,actor:new AccountActor(),version:()=> '1.2.3.4'} as unknown as BrowserProfileOwner;
  const data=new AutomationStore(store,()=>now);data.initialize(origin);store.bindAccount('100');
  data.configureCollection({ownId:'100',comments:true,inbox:false,commentIntervalMs:15_000,dmIntervalMs:15_000});
  store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='works'").run(JSON.stringify({phase:'comments'}));
  const budgets=store.budgets(),make=(id:string,time:number)=>candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',actorId:'200',
    platformEventId:id,commentId:id,videoId:'10',conversationId:null,occurredAt:new Date(time).toISOString()});
  const old=make('3101',origin-10_000),firstNew=make('3102',origin+1000),lateNew=make('3103',origin+2000);
  const wire=(more:boolean)=>{
    const events=more?[old,firstNew]:[lateNew],request={method:()=> 'GET',frame:()=>frame,
      url:()=>mapping.origin+'/aweme/v1/web/comment/list/?aweme_id=10&cursor='+(more?'0':'2')};
    page.emit('request',request);page.emit('response',{request:()=>request,status:()=>200,fromServiceWorker:()=>false,headers:()=>({}),
      body:async()=>Buffer.from(JSON.stringify({status_code:0,total:3,has_more:Number(more),cursor:more?2:3,
        comments:events.map(event=>({cid:event.commentId,create_time:Date.parse(event.occurredAt!)/1000,user:{uid:event.actorId}}))}))});
  };
  const reads:number[]=[],comments=vi.spyOn(ObservedReader.prototype,'comments').mockImplementation(async()=>{
    reads.push(pageNumber);wire(pageNumber===1);const events=pageNumber===1?[old,firstNew]:[lateNew];
    return{events,evidenceId:'synthetic',loaded:events.length,unsupported:0,
      commentThreads:events.map(event=>({id:event.commentId!,total:0,mounted:0,expandable:false})),
      scroll:{top:pageNumber===1?0:80,height:100,viewport:20,atEnd:true}};
  });
  const advance=vi.spyOn(ObservedReader.prototype,'advanceComments').mockImplementation(async()=>{
    if(++advances===3){pageNumber=2;wire(false);}return{top:80,height:100,viewport:20,atEnd:true};
  });
  const discovery=vi.spyOn(OwnWorksDiscovery.prototype,'scan').mockResolvedValue({works:[],pending:[],complete:true});
  const collector=new InboxCollector(owner,mapping,data,root,'headless');
  const progress=()=>store.db.prepare("SELECT scroll_top,end_observations,last_read FROM work_collection_progress WHERE work_id='10'").get() as
    {scroll_top:number;end_observations:number;last_read:number};
  const savedCursor=()=>JSON.parse((store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='works'").get() as {cursor_json:string}).cursor_json);
  try{
    await collector.collect('works',new AbortController().signal);
    expect(reads).toEqual([1,1]);expect(store.events().map(event=>event.payload.commentId).sort()).toEqual(['3101','3102']);
    expect(progress()).toMatchObject({end_observations:0,last_read:0});expect(savedCursor().pendingRootPages).toContain('10');
    let completed=false;
    for(let turn=0;turn<12;turn++){
      now+=15_000;await collector.collect('works',new AbortController().signal);
      const late=store.events().find(event=>event.payload.commentId===lateNew.commentId),current=progress();
      if(!late)expect(current.last_read).toBe(0);
      if(current.scroll_top===0&&current.last_read>0){expect(late).toBeDefined();completed=true;break;}
    }
    const events=store.events();expect(reads).toContain(2);expect(events).toHaveLength(3);
    expect(events.filter(event=>event.status==='BASELINE').map(event=>event.payload.commentId)).toEqual([old.commentId]);
    expect(events.find(event=>event.payload.commentId===lateNew.commentId)?.status).not.toBe('BASELINE');
    expect(completed).toBe(true);expect(savedCursor().pendingRootPages).not.toContain('10');
    const watermark=store.db.prepare("SELECT cursor_data FROM cursors WHERE channel='COMMENT_NOTIFICATION' AND scope='work:10'").get() as {cursor_data:string};
    expect(JSON.parse(watermark.cursor_data).baselineTime).toBe(origin);expect(data.state().startedAt).toBe(origin);
    expect(store.budgets()).toEqual(budgets);expect(store.budgets().map(budget=>budget.used)).toEqual([0,0]);
    expect(store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{collector.dispose();comments.mockRestore();advance.mockRestore();discovery.mockRestore();store.close();}
});
