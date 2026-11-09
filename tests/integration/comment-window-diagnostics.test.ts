import {expect,test,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {join} from 'node:path';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import type {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {InboxCollector} from '../../src/app/inbox-collector.js';
import type {ObservationBatch} from '../../src/adapters/observed-reader.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {candidate,database,privateTemp} from '../helpers.js';
import {observedMapping} from '../fixtures/observed-site.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {AccountActor} from '../../src/browser/account-actor.js';

test('successful comment windows overwrite bounded body-free age/count slots without changing read success or sending',async()=>{
  const root=privateTemp('comment-window-diagnostic-'),store=database();await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  let now=Date.now();const origin=now-20*60_000,data=new AutomationStore(store,()=>now);data.initialize(origin);store.bindAccount('100');
  data.configureCollection({ownId:'100',comments:true,inbox:false,commentIntervalMs:15_000,dmIntervalMs:15_000});
  const owner={notification:new EventEmitter(),version:()=> '1.2.3.4'} as unknown as BrowserProfileOwner;
  const collector=new InboxCollector(owner,observedMapping('http://127.0.0.1:1'),data,root,'headless');
  const persist=collector as unknown as {persist(source:'works',scope:string,batch:ObservationBatch,signal:AbortSignal,peer:undefined,window:{headRead:boolean;requestedOffset:number}):Promise<void>};
  const event=(id:string,age:number|null,nested=false)=>candidate({channel:'COMMENT_NOTIFICATION',kind:nested?'REPLY':'COMMENT',platformEventId:id,commentId:id,videoId:'10',
    conversationId:null,actorId:'200',actorName:'PRIVATE_AUTHOR',text:'PRIVATE_BODY',occurredAt:age===null?null:new Date(now-age).toISOString(),
    ...(nested?{rootCommentId:'11',replyToCommentId:id}:{})});
  const batch:ObservationBatch={events:[event('21',10*60_000),event('22',40*60_000,true),event('23',null),event('24',-1000),{...event('25',5*60_000,true),actorId:'100'}],
    evidenceId:'PRIVATE_EVIDENCE',loaded:6,unsupported:2,scroll:{top:0,height:900,viewport:100,atEnd:false}};
  const read=async()=>JSON.parse(await readFile(join(root,'evidence','work-comment-window-latest.json'),'utf8'));
  try{
    const before=store.db.prepare('SELECT * FROM collection_progress').all();
    await persist.persist('works','work:10',batch,new AbortController().signal,undefined,{headRead:true,requestedOffset:0});
    expect((await read()).windows[0]).toMatchObject({stage:'ROOTS',headRead:true,requestedOffset:0,mappedWork:true,includedWork:false,historicalWork:false,eventCount:5,roots:3,children:2,afterOrigin:2,fresh30m:2,
      older30m:1,unknownTime:1,futureTime:1,newestAgeMs:300000,newestEligibleAgeMs:600000,ownEvents:1,eligibleEvents:4,loaded:6,unsupported:2,responseSummary:null});
    expect(JSON.stringify(await read())).not.toMatch(/PRIVATE_|work:10|"21"|"22"|http:|\.comment/u);
    data.registerWork({id:'20',ownId:'100',url:'http://127.0.0.1:1/video/20',publishedAt:origin+1000,precisionMs:1});
    data.registerWork({id:'30',ownId:'100',url:'http://127.0.0.1:1/video/30',publishedAt:origin-1000,precisionMs:1});
    await persist.persist('works','work:20',{...batch,events:[]},new AbortController().signal,undefined,{headRead:false,requestedOffset:800});
    expect((await read()).windows[0]).toMatchObject({mappedWork:false,includedWork:true,historicalWork:false});
    await persist.persist('works','work:30',{...batch,events:[]},new AbortController().signal,undefined,{headRead:false,requestedOffset:800});
    expect((await read()).windows[0]).toMatchObject({mappedWork:false,includedWork:false,historicalWork:true});
    for(let index=0;index<18;index++){now+=1000;await persist.persist('works','work:'+String(20+index),{...batch,events:[]},new AbortController().signal,undefined,{headRead:false,requestedOffset:800});}
    expect((await read()).windows).toHaveLength(16);expect((await read()).windows[0]).toMatchObject({eventCount:0,newestAgeMs:null,headRead:false,requestedOffset:800});
    expect(store.db.prepare('SELECT * FROM collection_progress').all()).toEqual(before);expect(store.budgets().map(b=>b.used)).toEqual([0,0]);
    expect(store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});expect(store.db.prepare('SELECT count(*) n FROM model_calls').get()).toEqual({n:0});
    expect((await readdir(join(root,'evidence'))).filter(file=>file.includes('work-comment-window'))).toEqual(['work-comment-window-latest.json']);
    await writeFile(join(root,'evidence','work-comment-window-latest.json'),'PRIVATE_INVALID_OLD_FILE');
    await persist.persist('works','work:10',batch,new AbortController().signal,undefined,{headRead:false,requestedOffset:120});
    expect(JSON.stringify(await read())).not.toContain('PRIVATE_');
  }finally{collector.dispose();store.close();}
});

test('the current normal root-list response reaches the same collector success slot after its DOM window is read',async()=>{
  const root=privateTemp('comment-response-slot-'),store=database(),now=Date.now(),origin=now-20*60_000;
  await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  const data=new AutomationStore(store,()=>now);data.initialize(origin);store.bindAccount('100');
  data.configureCollection({ownId:'100',comments:true,inbox:false,commentIntervalMs:15_000,dmIntervalMs:15_000});
  store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='works'").run(JSON.stringify({phase:'comments'}));
  const mapping=observedMapping('http://127.0.0.1:1'),frame={},page=new EventEmitter() as EventEmitter&{url:()=>string;mainFrame:()=>unknown};
  page.url=()=>mapping.works[0]!.url;page.mainFrame=()=>frame;
  const owner={notification:page,actor:new AccountActor(),version:()=> '1.2.3.4'} as unknown as BrowserProfileOwner;
  const event=candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',platformEventId:'21',videoId:'10',commentId:'21',conversationId:null,
    actorId:'200',occurredAt:new Date(now-10*60_000).toISOString()});
  const comments=vi.spyOn(ObservedReader.prototype,'comments').mockImplementation(async()=>{
    const request={method:()=> 'GET',frame:()=>frame,url:()=>mapping.origin+'/aweme/v1/web/comment/list/?aweme_id=10&cursor=0'};
    page.emit('request',request);page.emit('response',{request:()=>request,status:()=>200,fromServiceWorker:()=>false,headers:()=>({}),body:async()=>Buffer.from(JSON.stringify({
      status_code:0,total:100,has_more:1,cursor:2,comments:[{cid:'21',text:'PRIVATE_BODY',create_time:(now-10*60_000)/1000,user:{uid:'200'}},
        {cid:'22',create_time:(now-1000)/1000,user:{uid:'100'}}]}))});
    return{events:[event],evidenceId:'synthetic',loaded:1,unsupported:0,scroll:{top:0,height:100,viewport:100,atEnd:true}};
  });
  const advance=vi.spyOn(ObservedReader.prototype,'advanceComments').mockResolvedValue({top:0,height:100,viewport:100,atEnd:true});
  const collector=new InboxCollector(owner,mapping,data,root,'headless');
  try{
    await collector.collect('works',new AbortController().signal);
    const raw=await readFile(join(root,'evidence','work-comment-window-latest.json'),'utf8'),report=JSON.parse(raw);
    expect(report.windows[0]).toMatchObject({eventCount:1,responseSummary:{count:2,total:100,hasMore:true,cursor:2,cursorAdvances:true,ownCount:1,fresh30m:2,newestNonOwnAgeMs:600000}});
    expect(raw).not.toMatch(/PRIVATE_|"21"|"22"|http:|aweme_id/u);expect(page.listenerCount('request')).toBe(0);
    expect(store.budgets().map(b=>b.used)).toEqual([0,0]);expect(store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{collector.dispose();comments.mockRestore();advance.mockRestore();store.close();}
});
