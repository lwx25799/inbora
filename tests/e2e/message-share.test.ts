import {expect,test,vi} from 'vitest';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {inspectMessageShare} from '../../src/adapters/message-share.js';
import {saveMessagePreviews} from '../../src/adapters/message-preview.js';
import {MessageShareStore} from '../../src/storage/message-shares.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountObserved,observedMapping} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jntkAAAAASUVORK5CYII=','base64');
async function setup(hrefs:string[],outgoing=false){
  const root=privateTemp('message-share-'),server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
  await mountObserved(owner,server.origin);
  await owner.dm.route(server.origin+'/thumb.png',route=>route.fulfill({contentType:'image/png',body:png}));
  await owner.dm.evaluate(({hrefs,outgoing,origin})=>{
    const chat=document.querySelector('#chat')!;for(const box of chat.querySelectorAll('.box'))box.remove();
    const box=document.createElement('div');box.className=outgoing?'box from-me':'box';
    const row=document.createElement('div');row.className='message';row.style.cssText='min-height:48px;width:320px';
    const card=document.createElement('div');card.className='MessageItemShareAwemecontainer';
    const thumbnail=document.createElement('img');thumbnail.src=origin+'/thumb.png';thumbnail.width=24;thumbnail.height=24;thumbnail.alt='private-card-cover';card.append(thumbnail);
    for(const href of hrefs){const anchor=document.createElement('a');anchor.href=href;anchor.textContent='private-card-title';card.append(anchor);}
    row.append(card);box.append(row);chat.append(box);
    Object.defineProperty(row,'__reactProps$fixture',{value:{children:{props:{message:{serverId:'7771',conversationId:'conv-a',sender:outgoing?'100':'200',
      createdAt:new Date('2026-11-05T00:00:00Z'),_parsedContent:{text:'',itemId:'123456',resourceUrl:'https://private.invalid/not-used'}}}}}});
  },{hrefs,outgoing,origin:server.origin});
  await owner.dm.locator('.message img').evaluate(node=>(node as HTMLImageElement).decode());
  const mapping=observedMapping(server.origin),batch=await new ObservedReader(owner.dm,mapping).dmWindow(mapping.peers[0]!);
  return {root,server,owner,mapping,batch,event:batch.events[0]!,signal:new AbortController().signal,
    close:async()=>{await owner.close();await server.close();}};
}

test.each(['video','note'])('visible owned public %s links are canonical display data and never screenshot the share thumbnail',async kind=>{
  const f=await setup(['https://douyin.com/'+kind+'/123456?from=private#ignored']);
  try{
    const screenshot=vi.spyOn(f.owner.dm,'screenshot');
    await saveMessagePreviews(f.owner.dm,f.mapping,f.batch,f.root,f.signal);
    expect(new MessageShareStore(f.root).read(f.event,'100')).toEqual({kind:'DOUYIN_WORK',url:'https://www.douyin.com/'+kind+'/123456',workId:'123456'});
    expect(screenshot).not.toHaveBeenCalled();expect(f.event).toMatchObject({contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED'});
    const diagnostic=readFileSync(join(f.root,'evidence','message-preview-latest.json'),'utf8');
    expect(diagnostic).not.toContain('123456');expect(diagnostic).not.toContain('private');expect(JSON.parse(diagnostic).shareLinked).toBe(1);
  }finally{await f.close();}
});

test.each([{hrefs:[]},{hrefs:['https://www.douyin.com/video/123456','https://www.douyin.com/note/654321']},{hrefs:['https://private.invalid/video/123456']}])(
  'a div card without one provable public work keeps its fixed metadata diagnostic and never invents a URL ($hrefs)',async({hrefs})=>{
    const f=await setup(hrefs);
    try{
      const screenshot=vi.spyOn(f.owner.dm,'screenshot');await saveMessagePreviews(f.owner.dm,f.mapping,f.batch,f.root,f.signal);
      expect(new MessageShareStore(f.root).read(f.event,'100')).toBeNull();expect(screenshot).not.toHaveBeenCalled();
      const diagnostic=JSON.parse(readFileSync(join(f.root,'evidence','message-preview-latest.json'),'utf8'));
      expect(diagnostic).toMatchObject({shareInspected:1,shareLinked:0,shareDetectedNoLink:1});
      expect(diagnostic.shareSamples[0].parsedFields).toContainEqual({key:'itemId',type:'string',digitId:true});
      expect(JSON.stringify(diagnostic)).not.toContain('123456');expect(JSON.stringify(diagnostic)).not.toContain('private');
    }finally{await f.close();}
  });

test('own-only media can use the exact discovered peer without deriving a peer UID from the own sender',async()=>{
  const f=await setup(['https://www.douyin.com/video/123456'],true);
  try{
    const screenshot=vi.spyOn(f.owner.dm,'screenshot');delete f.batch.bindings;
    await saveMessagePreviews(f.owner.dm,f.mapping,f.batch,f.root,f.signal,{...f.mapping.peers[0]!,uid:null});
    expect(new MessageShareStore(f.root).read(f.event,'100')?.workId).toBe('123456');expect(screenshot).not.toHaveBeenCalled();
    const bad={...f.mapping.peers[0]!,secUid:'foreign-sec'};
    await expect(f.owner.dm.evaluate(inspectMessageShare,{mapping:f.mapping,event:f.event,peer:bad})).rejects.toThrow('MESSAGE_SHARE_TARGET_CHANGED');
  }finally{await f.close();}
});

test.each(['FIRST','AFTER_32_FIELDS'] as const)('a reliable native item ID that conflicts with the owned visible public link cannot become a displayed share (%s)',async order=>{
  const f=await setup(['https://www.douyin.com/video/123456']);
  try{
    await f.owner.dm.evaluate(order=>{
      const parsed=Object.getOwnPropertyDescriptor(document.querySelector('.message')!,'__reactProps$fixture')!.value.children.props.message._parsedContent;
      if(order==='AFTER_32_FIELDS'){delete parsed.itemId;for(let index=0;index<32;index++)parsed['diagnosticField'+index]=false;}
      parsed.itemId='654321';
    },order);
    const screenshot=vi.spyOn(f.owner.dm,'screenshot');await saveMessagePreviews(f.owner.dm,f.mapping,f.batch,f.root,f.signal);
    expect(new MessageShareStore(f.root).read(f.event,'100')).toBeNull();expect(screenshot).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(f.root,'evidence','message-preview-latest.json'),'utf8')).shareDetectedNoLink).toBe(1);
  }finally{await f.close();}
});

test('unrelated hidden links and rendered accessors cannot supply a shared work identity',async()=>{
  const f=await setup([]);
  try{
    await f.owner.dm.evaluate(()=>{
      const link=document.createElement('a');link.href='https://www.douyin.com/video/123456';link.hidden=true;document.querySelector('.message')!.append(link);
      const outside=link.cloneNode(true) as HTMLAnchorElement;outside.hidden=false;document.querySelector('.box')!.prepend(outside);
      const parsed=Object.getOwnPropertyDescriptor(document.querySelector('.message')!,'__reactProps$fixture')!.value.children.props.message._parsedContent;
      Object.defineProperty(parsed,'unsafe',{get(){throw Error('private getter must never run');},enumerable:true});
    });
    const result=await f.owner.dm.evaluate(inspectMessageShare,{mapping:f.mapping,event:f.event,peer:f.mapping.peers[0]!});
    expect(result.share).toBeNull();expect(result.diagnostic.anchors).toBe(0);expect(result.diagnostic.parsedFields).toContainEqual({key:'unsafe',type:'accessor',digitId:false});
    expect(JSON.stringify(result)).not.toContain('123456');expect(JSON.stringify(result)).not.toContain('private');
  }finally{await f.close();}
});

test('bounded native kind and share-info diagnostics contain enums and field shapes without private values',async()=>{
  const f=await setup([]);
  try{
    await f.owner.dm.evaluate(()=>{
      const parsed=Object.getOwnPropertyDescriptor(document.querySelector('.message')!,'__reactProps$fixture')!.value.children.props.message._parsedContent;
      Object.assign(parsed,{aweType:0,awemeType:0,is_slides:false,share_info:[{share_url:'https://www.douyin.com/video/123456?private=1',title:'private-title'},
        {url:'https://private.invalid/'},null,{ignored:'fourth entry'}]});
    });
    const result=await f.owner.dm.evaluate(inspectMessageShare,{mapping:f.mapping,event:f.event,peer:f.mapping.peers[0]!});
    expect(result.diagnostic.nativeKinds).toMatchObject({aweType:0,awemeType:0,isSlides:false});
    expect(result.diagnostic.shareInfo).toHaveLength(3);
    expect(result.diagnostic.shareInfo[0]!.fields).toContainEqual({key:'share_url',type:'string',urlKind:'DOUYIN_VIDEO'});
    expect(JSON.stringify(result.diagnostic)).not.toContain('123456');expect(JSON.stringify(result.diagnostic)).not.toContain('private');
  }finally{await f.close();}
});

test.each([{awemeType:0,isSlides:false,route:'video'},{awemeType:68,isSlides:true,route:'note'}])(
  'the exact observed native div card shows a $route link without treating the distinct aweType as an alias',async({awemeType,isSlides,route})=>{
    const f=await setup([]);
    try{
      await f.owner.dm.evaluate(({awemeType,isSlides})=>{
        const parsed=Object.getOwnPropertyDescriptor(document.querySelector('.message')!,'__reactProps$fixture')!.value.children.props.message._parsedContent;
        Object.assign(parsed,{aweType:800,awemeType,is_slides:isSlides});
      },{awemeType,isSlides});
      const screenshot=vi.spyOn(f.owner.dm,'screenshot');await saveMessagePreviews(f.owner.dm,f.mapping,f.batch,f.root,f.signal);
      expect(new MessageShareStore(f.root).read(f.event,'100')).toEqual({kind:'DOUYIN_WORK',url:'https://www.douyin.com/'+route+'/123456',workId:'123456'});
      expect(screenshot).not.toHaveBeenCalled();expect(f.event.contentType).toBe('IMAGE');
    }finally{await f.close();}
  });
