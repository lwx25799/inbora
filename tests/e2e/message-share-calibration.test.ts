import {expect,test,vi} from 'vitest';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import type {Page} from 'playwright';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {inspectMessageShare} from '../../src/adapters/message-share.js';
import {saveMessagePreviews} from '../../src/adapters/message-preview.js';
import {eventBinding} from '../../src/core/contracts.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountObserved,observedMapping} from '../fixtures/observed-site.js';
import {candidate,privateTemp} from '../helpers.js';

test('normal share samples keep an opaque exact event binding and an eight-record bound',async()=>{
  const root=privateTemp('share-bound-calibration-'),mapping=observedMapping('http://fixture.invalid');
  const events=Array.from({length:10},(_,index)=>candidate({actorId:'200',conversationId:'conv-a',platformEventId:'private-native-'+index,
    observationIssue:'DM_CONTENT_UNVERIFIED',contentType:'IMAGE'}));
  const batch={events,evidenceId:'fixture',unsupported:10,loaded:10,bindings:[{targetKey:'dm:conv-a',uid:'200',secUid:'peer',title:'private title',conversationId:'conv-a'}]};
  const screenshot=vi.fn(),evaluate=vi.fn(async(fn:unknown)=>fn===inspectMessageShare?{share:null,detected:true,diagnostic:{anchors:0,cardMarkers:1,
    nativeItemIdPresent:false,nativeItemIdConflict:false,nativeKinds:{aweType:null,awemeType:null,isSlides:null},shareInfo:[],urlKinds:{},parsedFields:[]}}:{});
  await saveMessagePreviews({screenshot,evaluate} as unknown as Page,mapping,batch,root,new AbortController().signal);
  const raw=readFileSync(join(root,'evidence/message-preview-latest.json'),'utf8'),report=JSON.parse(raw);
  expect(report.shareSamples).toHaveLength(8);
  expect(report.shareSamples.map((sample:{eventBinding:string;phase:string})=>[sample.eventBinding,sample.phase]))
    .toEqual(events.slice(0,8).map(event=>[eventBinding(event),'SHARE']));
  expect(evaluate).toHaveBeenCalledTimes(10);expect(screenshot).not.toHaveBeenCalled();expect(raw).not.toMatch(/private|https?:\/\//u);
});

async function setup(){
  const root=privateTemp('share-shape-calibration-'),server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
  await mountObserved(owner,server.origin);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jntkAAAAASUVORK5CYII=','base64');
  await owner.dm.route(server.origin+'/emoji.png',route=>route.fulfill({contentType:'image/png',body:png}));
  await owner.dm.evaluate(origin=>{
    const chat=document.querySelector('#chat')!;chat.querySelectorAll('.box').forEach(box=>box.remove());
    const box=document.createElement('div'),row=document.createElement('div'),text=document.createElement('span'),image=document.createElement('img');
    box.className='box';row.className='message';text.className='text';row.style.cssText='width:300px;min-height:32px';
    image.src=origin+'/emoji.png';image.alt='[微笑]';image.width=24;image.height=24;text.append('hello',image);row.append(text);box.append(row);chat.append(box);
    Object.defineProperty(row,'__reactProps$fixture',{value:{children:{props:{message:{serverId:'99601',conversationId:'conv-a',sender:'200',type:7,
      createdAt:new Date(Date.now()-1000),_parsedContent:{text:'hello[微笑]',related_share_video:{item_id:'123456',share_url:'https://www.douyin.com/video/123456?private=1',
        nested:{aweme_type:0,private_value:'PRIVATE_BODY'},another:{id:'654321'}}}}}}}});
  },server.origin);
  await owner.dm.locator('.message img').evaluate(image=>(image as HTMLImageElement).decode());
  const mapping=observedMapping(server.origin),batch=await new ObservedReader(owner.dm,mapping).dmWindow(mapping.peers[0]!);
  return {root,owner,mapping,event:batch.events[0]!,close:async()=>{await owner.close();await server.close();}};
}

test('sparse native type7 metadata and inline emoji produce only bounded exact-row diagnostic shapes',async()=>{
  const f=await setup();try{
    const input={mapping:f.mapping,event:f.event,peer:f.mapping.peers[0]!};
    const before=await f.owner.dm.evaluate(()=>document.body.innerHTML),report=await f.owner.dm.evaluate(inspectMessageShare,input);
    expect(report).toMatchObject({detected:false,share:null,diagnostic:{calibration:{nativeMessageKind:7,nativeRoute:'UNAVAILABLE',routeReason:'MISSING_ITEM_ID',
      text:{nativeType7:true,ownedTextCount:1,visibleTextCount:1,inlineImages:1,otherMedia:0,reconstructed:true,matchesNative:true}}}});
    expect(report.diagnostic.calibration?.related.fields).toContainEqual(expect.objectContaining({key:'item_id',type:'STRING',digitId:true}));
    expect(report.diagnostic.calibration?.related.fields).toContainEqual(expect.objectContaining({key:'share_url',urlKind:'DOUYIN_VIDEO'}));
    const raw=JSON.stringify(report.diagnostic);expect(raw).not.toMatch(/PRIVATE_BODY|hello|微笑|123456|654321|https?:\/\//u);
    expect(await f.owner.dm.evaluate(()=>document.body.innerHTML)).toBe(before);
  }finally{await f.close();}
});

test('related primitive or accessor metadata is described without parsing JSON, executing getters or inventing a share',async()=>{
  const f=await setup();try{
    await f.owner.dm.evaluate(()=>{
      const parsed=Object.getOwnPropertyDescriptor(document.querySelector('.message')!,'__reactProps$fixture')!.value.children.props.message._parsedContent;
      parsed.related_share_video='{"item_id":"123456"}';
    });
    let report=await f.owner.dm.evaluate(inspectMessageShare,{mapping:f.mapping,event:f.event,peer:f.mapping.peers[0]!});
    expect(report.diagnostic.calibration?.related).toMatchObject({type:'STRING',fields:[]});expect(report.share).toBeNull();
    await f.owner.dm.evaluate(()=>{
      const parsed=Object.getOwnPropertyDescriptor(document.querySelector('.message')!,'__reactProps$fixture')!.value.children.props.message._parsedContent;
      Object.defineProperty(parsed,'related_share_video',{configurable:true,get(){throw Error('PRIVATE_GETTER_MUST_NOT_RUN');}});
    });
    report=await f.owner.dm.evaluate(inspectMessageShare,{mapping:f.mapping,event:f.event,peer:f.mapping.peers[0]!});
    expect(report.diagnostic.calibration?.related).toMatchObject({type:'ACCESSOR',fields:[]});expect(report.share).toBeNull();
  }finally{await f.close();}
});

test('nested shape scans stop at two levels and sixteen total fields, while invalid emoji labels never match',async()=>{
  const f=await setup();try{
    await f.owner.dm.evaluate(()=>{
      const row=document.querySelector('.message')!,parsed=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message._parsedContent;
      parsed.related_share_video={nested:{deeper:{item_id:'123456'}}};for(let index=0;index<40;index++)parsed.related_share_video['field'+index]=false;
      row.querySelector('img')!.setAttribute('alt','unverified ordinary label');
    });
    const report=await f.owner.dm.evaluate(inspectMessageShare,{mapping:f.mapping,event:f.event,peer:f.mapping.peers[0]!});
    expect(report.diagnostic.calibration?.related).toMatchObject({type:'OBJECT',truncated:true});
    expect((report.diagnostic.calibration?.related.fields??[]).length).toBeLessThanOrEqual(16);
    expect(report.diagnostic.calibration?.text).toMatchObject({reconstructed:false,matchesNative:false});
    expect(report.share).toBeNull();expect(report.detected).toBe(false);
  }finally{await f.close();}
});
