import {afterAll,beforeAll,expect,test,vi} from 'vitest';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {captureObserved,ObservedReader} from '../../src/adapters/observed-reader.js';
import {inspectMessageShare} from '../../src/adapters/message-share.js';
import {saveMessagePreviews} from '../../src/adapters/message-preview.js';
import {InboxCollector} from '../../src/app/inbox-collector.js';
import {InboxQueries} from '../../src/app/inbox-queries.js';
import {MessageShareStore} from '../../src/storage/message-shares.js';
import {EventStore} from '../../src/storage/store.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountObserved,observedMapping} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';

const root=privateTemp('native-share-shell-'),origin=Date.now()-10_000;
let server:Awaited<ReturnType<typeof fixtureServer>>,owner:BrowserProfileOwner;
beforeAll(async()=>{server=await fixtureServer();owner=await BrowserProfileOwner.launch(join(root,'profile'),true);});
afterAll(async()=>{await owner?.close();await server?.close();});
interface Spec {type?:number;awemeType?:number;slides?:unknown;thumbnail?:boolean;text?:'EMPTY'|'MISMATCH'|'DUPLICATE'}
async function mount(spec:Spec={awemeType:0}){
  await mountObserved(owner,server.origin);
  await owner.dm.evaluate(({spec,origin})=>{
    const chat=document.querySelector('#chat') as HTMLElement;for(const box of chat.querySelectorAll('.box'))box.remove();
    for(let index=0;index<4;index++){
      const box=document.createElement('div');box.className='box';const row=document.createElement('div');row.className='message';
      row.style.cssText='min-height:32px;width:320px';box.append(row);chat.append(box);
      const parsed:Record<string,unknown>=index===3?{itemId:'123456',aweType:800,awemeType:spec.awemeType}:{text:'fixture text '+index};
      if(index===3&&'slides'in spec)parsed.is_slides=spec.slides;
      if(index<3){const text=document.createElement('span');text.className='text';text.textContent=String(parsed.text);row.append(text);}
      else if(spec.text){
        parsed.text='native full text';for(let n=0;n<(spec.text==='DUPLICATE'?2:1);n++){
          const text=document.createElement('span');text.className='text';text.textContent=spec.text==='MISMATCH'?'different visible text':'';row.append(text);}
      }
      if(index===3&&spec.thumbnail){const image=document.createElement('img');image.style.cssText='width:24px;height:24px';row.append(image);}
      Object.defineProperty(row,'__reactProps$fixture',{value:{children:{props:{message:{serverId:String(6101+index),conversationId:'conv-a',sender:'200',
        createdAt:new Date(origin+1000),type:index===3?(spec.type??8):7,serverStatus:0,_parsedContent:parsed}}}}});
    }
    document.querySelector('#back')!.addEventListener('click',()=>{chat.hidden=true;});
    document.querySelector('.conversation')!.addEventListener('click',()=>{chat.hidden=false;});
  },{spec,origin});
}
function capture(){const mapping=observedMapping(server.origin),input:Parameters<typeof captureObserved>[0]=
  {mapping,channel:'dm',index:0,evidenceId:'synthetic-share-shell',peer:mapping.peers[0]!,dmWindow:true};return owner.dm.evaluate(captureObserved,input);}
function noExternal(store:EventStore){
  expect(store.db.prepare('SELECT kind,used FROM budgets ORDER BY kind').all()).toEqual([{kind:'MODEL',used:0},{kind:'SEND',used:0}]);
  expect(store.db.prepare('SELECT count(*) AS n FROM model_calls').get()).toEqual({n:0});
  expect(store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
}

// DSH 7989640 (MIT) binds rendered itemId to an exact native message; type 8 is a local calibrated fact.
// F2 f6be8c0 (Apache-2.0) records the already adopted video kinds 0/55; no downloader or URL is visited.
test.each([{awemeType:0,slides:false,route:'video'},{awemeType:0,route:'video'},{awemeType:55,slides:false,route:'video'},
  {awemeType:55,route:'video'},{awemeType:68,slides:true,route:'note'},
  {awemeType:68,slides:false,route:'note'},{awemeType:68,route:'note'}])(
  'an exact native share shell without rendered content retains all four rows and its $route display reference ($awemeType/$slides)',async spec=>{
    await mount(spec);const mapping=observedMapping(server.origin),batch=await new ObservedReader(owner.dm,mapping).dmWindow(mapping.peers[0]!);
    expect(batch.events).toHaveLength(4);expect(batch.unsupported).toBe(1);
    expect(batch.events.slice(0,3).map(event=>event.text)).toEqual(['fixture text 0','fixture text 1','fixture text 2']);
    const event=batch.events[3]!;expect(event).toMatchObject({platformEventId:'6104',actorId:'200',conversationId:'conv-a',
      contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED',text:'[图片或表情消息，需人工查看]'});
    const inspection=await owner.dm.evaluate(inspectMessageShare,{mapping,event,peer:mapping.peers[0]!});
    expect(inspection).toMatchObject({detected:true,share:{kind:'DOUYIN_WORK',workId:'123456',url:'https://www.douyin.com/'+spec.route+'/123456'}});
    const screenshot=vi.spyOn(owner.dm,'screenshot');
    try{await saveMessagePreviews(owner.dm,mapping,batch,root,new AbortController().signal);
      expect(new MessageShareStore(root).read(event,'100')).toEqual(inspection.share);expect(screenshot).not.toHaveBeenCalled();
    }finally{screenshot.mockRestore();}
    expect(JSON.stringify(batch)).not.toContain('123456');
  });

test('the normal collector persists the whole window and its weak share without model calls or sends',async()=>{
  await mount({awemeType:55});const store=new EventStore(join(root,'collector.sqlite'),true);
  await migrateClient(store,join(root,'collector-client.sqlite'));await migrateAutomation(store,join(root,'collector-automation.sqlite'));
  const data=new AutomationStore(store);data.initialize(origin);store.bindAccount('100');
  data.configureCollection({ownId:'100',comments:false,inbox:true,commentIntervalMs:30_000,dmIntervalMs:15_000});
  const collector=new InboxCollector(owner,observedMapping(server.origin),data,root,'headless');
  try{
    await collector.collect('dm',new AbortController().signal);expect(store.events()).toHaveLength(4);
    const event=store.events().find(event=>event.payload.platformEventId==='6104')!;
    expect(event.status).toBe('MANUAL_REVIEW');expect(new MessageShareStore(root).read(event.payload,'100')?.workId).toBe('123456');
    expect(()=>store.assertModelObservation(event.payload)).toThrow('DM_CONTENT_UNVERIFIED');
    expect((store.db.prepare("SELECT last_read FROM discovered_conversations WHERE id='conv-a'").get() as {last_read:number}).last_read).toBeGreaterThan(0);
    noExternal(store);
  }finally{collector.dispose();store.close();}
});

test('new auxiliary links invalidate expanded timeline projections once without changing the original event',async()=>{
  const displayRoot=privateTemp('display-revision-');
  await mount({awemeType:999,thumbnail:true});const store=new EventStore(join(displayRoot,'display-revision.sqlite'),true);
  await migrateClient(store,join(displayRoot,'display-client.sqlite'));await migrateAutomation(store,join(displayRoot,'display-automation.sqlite'));
  const data=new AutomationStore(store);data.initialize(origin);store.bindAccount('100');
  data.configureCollection({ownId:'100',comments:false,inbox:true,commentIntervalMs:30_000,dmIntervalMs:15_000});
  const collector=new InboxCollector(owner,observedMapping(server.origin),data,displayRoot,'headless');
  try{
    await collector.collect('dm',new AbortController().signal);
    const event=store.events().find(event=>event.payload.platformEventId==='6104')!,queries=new InboxQueries(store,displayRoot,()=> 'WAITING');
    const before=queries.timeline(event).projectionRevision;
    await owner.dm.evaluate(()=>{Object.getOwnPropertyDescriptor(document.querySelectorAll('.message')[3]!,'__reactProps$fixture')!.value.children.props.message._parsedContent.awemeType=55;});
    await collector.collect('dm',new AbortController().signal);
    const after=queries.timeline(event).projectionRevision;expect(after).not.toBe(before);
    expect(new MessageShareStore(displayRoot).read(event.payload,'100')?.url).toBe('https://www.douyin.com/video/123456');
    await collector.collect('dm',new AbortController().signal);expect(queries.timeline(event).projectionRevision).toBe(after);
    expect(store.event(event.id)).toEqual(event);noExternal(store);
  }finally{collector.dispose();store.close();}
});

test.each([{type:7,awemeType:0},{awemeType:999},{awemeType:0,slides:null},{awemeType:55,slides:'false'},
  {awemeType:0,text:'EMPTY' as const},{awemeType:0,text:'DUPLICATE' as const}])(
  'metadata cannot hide an ordinary missing body, unknown route or mounted text shape ($type/$awemeType/$text)',async spec=>{
    await mount(spec);await expect(capture()).rejects.toThrow('OBSERVATION_DM_CONTENT_DOM_NOT_READY');
  });

test('a mounted full text conflict remains a conflict instead of falling back to the share metadata',async()=>{
  await mount({awemeType:0,text:'MISMATCH'});await expect(capture()).rejects.toThrow('OBSERVATION_MESSAGE_TEXT_CONFLICT');
});

test.each(['ITEM_ACCESSOR','MISSING_ID','MISSING_TIME','ZERO_ID','ZERO_ITEM'] as const)('native share fallback rejects incomplete or accessor-backed identity (%s)',async fault=>{
  await mount({awemeType:0});await owner.dm.evaluate(fault=>{
    const message=Object.getOwnPropertyDescriptor(document.querySelectorAll('.message')[3]!,'__reactProps$fixture')!.value.children.props.message;
    if(fault==='ITEM_ACCESSOR')Object.defineProperty(message._parsedContent,'itemId',{get(){throw Error('GETTER_MUST_NOT_RUN');}});
    if(fault==='MISSING_ID')delete message.serverId;if(fault==='MISSING_TIME')message.createdAt=null;
    if(fault==='ZERO_ID')message.serverId='0';if(fault==='ZERO_ITEM')message._parsedContent.itemId='0';
  },fault);
  await expect(capture()).rejects.toThrow(fault==='ITEM_ACCESSOR'?'RENDERED_ACCESSOR_UNSUPPORTED':'OBSERVATION_DM_CONTENT_DOM_NOT_READY');
});

test.each([{type:7,awemeType:0},{type:8,awemeType:999}])('the auxiliary native-only route does not promote an unknown native kind or work type ($type/$awemeType)',async spec=>{
  await mount({...spec,thumbnail:true});const batch=await capture(),mapping=observedMapping(server.origin);
  const inspection=await owner.dm.evaluate(inspectMessageShare,{mapping,event:batch.events[3]!,peer:mapping.peers[0]!});
  expect(inspection.share).toBeNull();expect(inspection.detected).toBe(false);
});

test.each([{awemeType:68,slides:false,route:'note'},{awemeType:68,route:'note'},{awemeType:68,slides:true,route:'note'},
  {awemeType:0,slides:false,route:'video'},{awemeType:55,slides:false,route:'video'},{awemeType:999,slides:false,route:null}])(
  'a known gallery card route uses its work kind instead of treating false or absent slides as video ($awemeType/$slides)',async spec=>{
    await mount({...spec,thumbnail:true});await owner.dm.evaluate(()=>{document.querySelectorAll('.message')[3]!.querySelector('img')!.className='MessageItemShareAwemecontainer';});
    const batch=await capture(),mapping=observedMapping(server.origin),event=batch.events[3]!;
    const inspection=await owner.dm.evaluate(inspectMessageShare,{mapping,event,peer:mapping.peers[0]!});
    expect(inspection.share?.url??null).toBe(spec.route?'https://www.douyin.com/'+spec.route+'/123456':null);
    expect(event).toMatchObject({contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED'});
  });

test('legacy IMAGE events survive migration, missing thumbnails, restored thumbnails and restart with zero source collisions',async()=>{
  await mount({awemeType:0,thumbnail:true});const before=await capture();let store=new EventStore(join(root,'legacy.sqlite'),true);
  try{
    store.observe('DIRECT_MESSAGE','conv-a',before.events,'100',before.evidenceId,new Date(origin).toISOString());
    const expected=store.events().map(event=>({id:event.id,binding:event.binding,status:event.status,payload:event.payload}));
    await migrateClient(store,join(root,'legacy-client.sqlite'));await migrateAutomation(store,join(root,'legacy-automation.sqlite'));
    store.close();store=new EventStore(join(root,'legacy.sqlite'));
    for(const thumbnail of [false,true,false]){
      await mount({awemeType:0,thumbnail});const batch=await capture();store.observe('DIRECT_MESSAGE','conv-a',batch.events,'100',batch.evidenceId);
      expect(store.events().map(event=>({id:event.id,binding:event.binding,status:event.status,payload:event.payload}))).toEqual(expected);
    }
    expect(store.db.prepare('SELECT count(*) AS n FROM source_collisions').get()).toEqual({n:0});noExternal(store);
  }finally{store.close();}
});
