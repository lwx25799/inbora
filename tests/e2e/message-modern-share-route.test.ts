import {afterAll,beforeAll,expect,test} from 'vitest';
import {join,resolve} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {captureObserved} from '../../src/adapters/observed-reader.js';
import {inspectMessageShare} from '../../src/adapters/message-share.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountObserved,observedMapping} from '../fixtures/observed-site.js';

let server:Awaited<ReturnType<typeof fixtureServer>>,owner:BrowserProfileOwner;
beforeAll(async()=>{server=await fixtureServer();owner=await BrowserProfileOwner.launch(join(resolve('.local/display-witness-smoke/source'),'profile'),true);});
afterAll(async()=>{await owner?.close();await server?.close();});
const cases=[
  {name:'exact web video with snake ID',schema:'https://www.douyin.com/video/123456',info:{},route:'video'},
  {name:'exact web note with nested ID',schema:'https://www.douyin.com/note/123456',info:{item_id:'123456'},route:'note'},
  {name:'detail with known video type',schema:'aweme://aweme/detail/123456',info:{aweme_id:'123456',aweme_type:0},route:'video'},
  {name:'detail with known 55 video type',schema:'aweme://aweme/detail/123456',info:{aweme_type:55},route:'video'},
  {name:'detail with known note type',schema:'aweme://aweme/detail/123456',info:{aweme_type:68},route:'note'},
  {name:'unknown detail route',schema:'aweme://aweme/detail/123456',info:{},route:null},
  {name:'schema ID conflict',schema:'https://www.douyin.com/video/654321',info:{},route:null},
  {name:'nested ID conflict',schema:'https://www.douyin.com/video/123456',info:{aweme_id:'654321'},route:null},
  {name:'explicit video/note conflict',schema:'https://www.douyin.com/video/123456',info:{aweme_type:68},route:null},
  {name:'unknown explicit type',schema:'https://www.douyin.com/video/123456',info:{aweme_type:90},route:null},
  {name:'nested URL is not a route',schema:'aweme://im/media_browser_display?schema=https%3A%2F%2Fwww.douyin.com%2Fvideo%2F123456',info:{},route:null},
  {name:'foreign schema host',schema:'https://www.douyin.com.evil.invalid/video/123456',info:{},route:null},
] as const;

test.each(cases)('$name uses only exact schema/native identity proof',async spec=>{
  await mountObserved(owner,server.origin);const mapping=observedMapping(server.origin);
  await owner.dm.evaluate(({schema,info})=>{
    const chat=document.querySelector('#chat')!,first=chat.querySelector('.box')!;
    for(const box of chat.querySelectorAll('.box'))if(box!==first)box.remove();
    const row=first.querySelector('.message')!;row.innerHTML='<img width="16" height="16">';
    const native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
    native.serverId='99781';native.type=110;native.createdAt=new Date(Date.now()-1000);
    native._parsedContent={item_id:'123456',schema,aweme_info:info};
  },{schema:spec.schema,info:spec.info});
  const batch=await owner.dm.evaluate(captureObserved,{mapping,channel:'dm' as const,index:0,evidenceId:'synthetic-modern-share',peer:mapping.peers[0]!,dmWindow:true});
  const event=batch.events[0]!,before=JSON.stringify(event),report=await owner.dm.evaluate(inspectMessageShare,{mapping,event,peer:mapping.peers[0]!});
  expect(event.observationIssue).toBe('DM_CONTENT_UNVERIFIED');
  expect(report.share).toEqual(spec.route?{kind:'DOUYIN_WORK',url:'https://www.douyin.com/'+spec.route+'/123456',workId:'123456'}:null);
  expect(report.detected).toBe(true);expect(JSON.stringify(event)).toBe(before);
  expect(JSON.stringify(report.diagnostic)).not.toMatch(/123456|654321|99781|https?:\/\/|aweme:\/\//u);
});

test('accessor IDs, conflicting camel IDs and invalid slides never produce modern links',async()=>{
  await mountObserved(owner,server.origin);const mapping=observedMapping(server.origin);
  await owner.dm.evaluate(()=>{
    const chat=document.querySelector('#chat')!,first=chat.querySelector('.box')!;
    for(const box of chat.querySelectorAll('.box'))if(box!==first)box.remove();
    const row=first.querySelector('.message')!;row.innerHTML='<img width="16" height="16">';
    const native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
    native.serverId='99782';native.type=110;native.createdAt=new Date(Date.now()-1000);
    native._parsedContent={item_id:'123456',schema:'https://www.douyin.com/video/123456'};
    Object.defineProperty(native._parsedContent,'aweme_info',{configurable:true,get(){throw Error('GETTER_MUST_NOT_RUN');}});
  });
  const event=(await owner.dm.evaluate(captureObserved,{mapping,channel:'dm' as const,index:0,evidenceId:'synthetic-modern-conflict',peer:mapping.peers[0]!,dmWindow:true})).events[0]!;
  const input={mapping,event,peer:mapping.peers[0]!};expect((await owner.dm.evaluate(inspectMessageShare,input)).share).toBeNull();
  await owner.dm.evaluate(()=>{
    const parsed=Object.getOwnPropertyDescriptor(document.querySelector('.message')!,'__reactProps$fixture')!.value.children.props.message._parsedContent;
    Object.defineProperty(parsed,'aweme_info',{value:{aweme_type:0},configurable:true});parsed.itemId='654321';
  });
  expect((await owner.dm.evaluate(inspectMessageShare,input)).share).toBeNull();
  await owner.dm.evaluate(()=>{
    const parsed=Object.getOwnPropertyDescriptor(document.querySelector('.message')!,'__reactProps$fixture')!.value.children.props.message._parsedContent;
    delete parsed.itemId;parsed.is_slides='false';
  });
  expect((await owner.dm.evaluate(inspectMessageShare,input)).share).toBeNull();
  await owner.dm.evaluate(()=>{
    const row=document.querySelector('.message')!,parsed=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message._parsedContent;
    delete parsed.is_slides;delete parsed.schema;parsed.aweme_info={};
    const anchor=document.createElement('a');anchor.href='https://www.douyin.com/video/654321';anchor.textContent='visible share';row.append(anchor);
  });
  expect((await owner.dm.evaluate(inspectMessageShare,input)).share).toBeNull();
  await owner.dm.evaluate(()=>{
    const row=document.querySelector('.message')!,parsed=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message._parsedContent;
    parsed.schema='https://www.douyin.com/video/123456';
    const anchor=document.createElement('a');anchor.href='https://www.douyin.com/video/123456';anchor.textContent='second visible share';row.append(anchor);
  });
  expect((await owner.dm.evaluate(inspectMessageShare,input)).share).toBeNull();
});
