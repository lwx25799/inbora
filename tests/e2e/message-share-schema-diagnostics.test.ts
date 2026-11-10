import {afterAll,beforeAll,expect,test} from 'vitest';
import {join,resolve} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {inspectMessageShare} from '../../src/adapters/message-share.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountObserved,observedMapping} from '../fixtures/observed-site.js';

let server:Awaited<ReturnType<typeof fixtureServer>>,owner:BrowserProfileOwner;
beforeAll(async()=>{server=await fixtureServer();owner=await BrowserProfileOwner.launch(join(resolve('.local/display-witness-smoke/source'),'profile'),true);});
afterAll(async()=>{await owner?.close();await server?.close();});

async function setup(schema:string){
  await mountObserved(owner,server.origin);
  await owner.dm.evaluate(schema=>{
    const chat=document.querySelector('#chat')!;chat.querySelectorAll('.box').forEach(box=>box.remove());
    const box=document.createElement('div'),row=document.createElement('div'),image=document.createElement('img');
    box.className='box';row.className='message';image.width=24;image.height=24;row.style.minHeight='32px';
    image.src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jntkAAAAASUVORK5CYII=';
    row.append(image);box.append(row);chat.append(box);
    Object.defineProperty(row,'__reactProps$fixture',{value:{children:{props:{message:{serverId:'99701',conversationId:'conv-a',sender:'200',type:110,
      createdAt:new Date(Date.now()-1000),_parsedContent:{item_id:'123456',schema,aweme_info:{item_id:'123456',aweme_id:'123456',aweme_type:0,type:0},
        im_dynamic_patch:{raw_data:'PRIVATE_JSON'},ui_info:{private:'PRIVATE_UI'}}}}}}});
  },schema);
  await owner.dm.locator('.message img').evaluate(image=>(image as HTMLImageElement).decode());
  const mapping=observedMapping(server.origin),batch=await new ObservedReader(owner.dm,mapping).dmWindow(mapping.peers[0]!);
  return {owner,input:{mapping,event:batch.events[0]!,peer:mapping.peers[0]!},close:async()=>{}};
}

test.each([
  {schema:'aweme://aweme/detail/123456?enter_from=chat&refer=PRIVATE',kind:'AWEME_DETAIL',matches:true,route:'video'},
  {schema:'https://www.douyin.com/video/123456?private=1',kind:'WEB_VIDEO',matches:true,route:'video'},
  {schema:'https://www.douyin.com/note/123456',kind:'WEB_NOTE',matches:true,route:null},
  {schema:'aweme://im/media_browser_display?schema=aweme%3A%2F%2Faweme%2Fdetail%2F123456',kind:'OTHER',matches:null,route:null},
  {schema:'https://www.douyin.com.evil.invalid/video/123456',kind:'OTHER',matches:null,route:null},
  {schema:'https://user:PRIVATE@www.douyin.com/video/123456',kind:'INVALID',matches:null,route:null},
])('describes sparse schema $kind and admits only its strict route proof',async({schema,kind,matches,route})=>{
  const f=await setup(schema);try{
    const before=await f.owner.dm.evaluate(()=>document.body.innerHTML),report=await f.owner.dm.evaluate(inspectMessageShare,f.input);
    expect(report.share).toEqual(route?{kind:'DOUYIN_WORK',url:'https://www.douyin.com/'+route+'/123456',workId:'123456'}:null);
    expect(report).toMatchObject({detected:true,diagnostic:{calibration:{nativeMessageKind:110,nativeRoute:'UNAVAILABLE',
      modernShare:{snakeItem:{type:'STRING',digitId:true},schema:{kind,itemMatchesSnake:matches},
        awemeInfo:{type:'OBJECT',itemMatchesSnake:true,awemeMatchesSnake:true,awemeType:0,typeValue:0},identityConflict:false}}}});
    expect(JSON.stringify(report.diagnostic)).not.toMatch(/PRIVATE|123456|99701|conv-a|https?:\/\/|aweme:\/\//u);
    expect(await f.owner.dm.evaluate(()=>document.body.innerHTML)).toBe(before);
  }finally{await f.close();}
});

test('conflicting exact native IDs are explicit and never become an inferred video',async()=>{
  const f=await setup('aweme://aweme/detail/654321');try{
    await f.owner.dm.evaluate(()=>{
      const parsed=Object.getOwnPropertyDescriptor(document.querySelector('.message')!,'__reactProps$fixture')!.value.children.props.message._parsedContent;
      parsed.aweme_info.aweme_id='998877';parsed.aweme_info.aweme_type=68;
    });
    const report=await f.owner.dm.evaluate(inspectMessageShare,f.input);
    expect(report.diagnostic.calibration?.modernShare).toMatchObject({schema:{kind:'AWEME_DETAIL',itemMatchesSnake:false},
      awemeInfo:{itemMatchesSnake:true,awemeMatchesSnake:false,awemeType:68},identityConflict:true});
    expect(report.share).toBeNull();expect(report.detected).toBe(true);
  }finally{await f.close();}
});

test('fixed schema and aweme-info descriptors never execute accessors or accept unsafe numeric IDs',async()=>{
  const f=await setup('aweme://aweme/detail/123456');try{
    await f.owner.dm.evaluate(()=>{
      const parsed=Object.getOwnPropertyDescriptor(document.querySelector('.message')!,'__reactProps$fixture')!.value.children.props.message._parsedContent;
      parsed.item_id=123456;Object.defineProperty(parsed,'schema',{get(){throw Error('PRIVATE_GETTER');}});
      Object.defineProperty(parsed.aweme_info,'aweme_type',{get(){throw Error('PRIVATE_GETTER');}});
      parsed.aweme_info.type=100000;
    });
    const report=await f.owner.dm.evaluate(inspectMessageShare,f.input);
    expect(report.diagnostic.calibration?.modernShare).toMatchObject({snakeItem:{type:'NUMBER',digitId:false},schema:{type:'ACCESSOR',kind:'INVALID',itemMatchesSnake:null},
      awemeInfo:{awemeType:null,typeValue:null,itemMatchesSnake:null},identityConflict:false});
    expect(report.share).toBeNull();expect(report.detected).toBe(true);
    expect(JSON.stringify(report.diagnostic)).not.toMatch(/PRIVATE|123456|99701|https?:\/\/|aweme:\/\//u);
  }finally{await f.close();}
});
