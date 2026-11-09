import {expect,test,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import type {Page} from 'playwright';
import type {ObservedReader} from '../../src/adapters/observed-reader.js';
import {OwnWorksDiscovery} from '../../src/adapters/own-works-discovery.js';
import {observedMapping} from '../fixtures/observed-site.js';

const data=(id:unknown='20',more=0)=>({status_code:0,has_more:more,aweme_list:[{aweme_id:id,create_time:100,author:{uid:'100',sec_uid:'self-sec'}}]});
function fixture(){
  const mapping=observedMapping('https://www.douyin.com'),frame={},foreign={};let url=mapping.origin+'/video/10',bodyReads=0;
  const page=new EventEmitter() as EventEmitter&{url:()=>string;mainFrame:()=>unknown;evaluate:ReturnType<typeof vi.fn>};
  page.url=()=>url;page.mainFrame=()=>frame;page.evaluate=vi.fn(async()=>[mapping.origin+'/video/20',mapping.origin+'/video/21']);
  const discovery=new OwnWorksDiscovery(page as unknown as Page,mapping);
  let onNavigate=()=>{};
  const reader={guard:vi.fn(async()=>{}),navigate:vi.fn(async(next:string)=>{url=next;page.emit('framenavigated',frame);onNavigate();})} as unknown as ObservedReader;
  function emit(value:unknown=data(),fault='',body?:()=>Promise<Buffer>){
    const request={url:()=>mapping.origin+'/aweme/v1/web/aweme/post/?sec_user_id='+(fault==='DUPLICATE'?'self-sec&sec_user_id=self-sec':'self-sec'),
      frame:()=>fault==='FRAME'?foreign:frame,method:()=>fault==='POST'?'POST':'GET'};
    page.emit('request',request);page.emit('response',{request:()=>request,status:()=>200,ok:()=>true,fromServiceWorker:()=>false,headers:()=>({}),body:async()=>{
      bodyReads++;return body?body():Buffer.from(JSON.stringify(value));}});
  }
  return {page,frame,discovery,reader,emit,reads:()=>bodyReads,onNavigate:(fn:()=>void)=>{onNavigate=fn;}};
}

test('normal own-profile metadata keeps exact string identity and native visible route',async()=>{
  const f=fixture();try {
    f.onNavigate(()=>f.emit());
    expect(await f.discovery.scan(f.reader,true,new AbortController().signal)).toEqual({works:[{id:'20',ownId:'100',url:'https://www.douyin.com/video/20',publishedAt:100000,precisionMs:1000}],pending:[],complete:true});
    expect(f.reads()).toBe(1);
  }finally{f.discovery.dispose();expect(f.page.listenerCount('request')).toBe(0);expect(f.page.listenerCount('response')).toBe(0);}
});

test.each([20,7397583912345678901])('numeric platform identifier is rejected instead of being coerced: %s',async id=>{
  const f=fixture();try {
    f.onNavigate(()=>f.emit(data(id)));
    await expect(f.discovery.scan(f.reader,true,new AbortController().signal)).rejects.toThrow('OWN_WORKS_METADATA_UNVERIFIED');
    expect(f.reads()).toBe(1);
  }finally{f.discovery.dispose();}
});

test.each(['FRAME','POST','DUPLICATE'])('unmatched request does not read any body: %s',async fault=>{
  const f=fixture(),controller=new AbortController();try {
    f.onNavigate(()=>{f.emit(data(),fault);controller.abort();});
    await expect(f.discovery.scan(f.reader,true,controller.signal)).rejects.toThrow('COLLECTION_CANCELLED');
    expect(f.reads()).toBe(0);
  }finally{f.discovery.dispose();}
});

test('request order determines completion even if body completion arrives in reverse order',async()=>{
  const f=fixture();try {
    f.onNavigate(()=>{
      let release!:(body:Buffer)=>void;
      f.emit(undefined,'',()=>new Promise<Buffer>(resolve=>{release=resolve;}));f.emit(data('21',0));
      queueMicrotask(()=>release(Buffer.from(JSON.stringify(data('20',1)))));
    });
    const result=await f.discovery.scan(f.reader,true,new AbortController().signal);
    expect(result.works.map(work=>work.id)).toEqual(['20','21']);expect(result.complete).toBe(true);expect(f.reads()).toBe(2);
  }finally{f.discovery.dispose();}
});

test('cancelled previous generation cannot inject its late response into the next scan',async()=>{
  const f=fixture(),controller=new AbortController();let release!:(body:Buffer)=>void;
  try {
    f.onNavigate(()=>{f.emit(undefined,'',()=>new Promise<Buffer>(resolve=>{release=resolve;}));controller.abort();});
    await expect(f.discovery.scan(f.reader,true,controller.signal)).rejects.toThrow('COLLECTION_CANCELLED');
    f.onNavigate(()=>{f.emit(data('21'));release(Buffer.from(JSON.stringify(data('20'))));});
    const result=await f.discovery.scan(f.reader,true,new AbortController().signal);
    expect(result.works.map(work=>work.id)).toEqual(['21']);expect(result.complete).toBe(true);
  }finally{f.discovery.dispose();}
});

test('navigation during final guard cannot reuse an already accepted profile batch',async()=>{
  const f=fixture();try {
    f.onNavigate(()=>f.emit());
    vi.mocked(f.reader.guard).mockImplementationOnce(async()=>{f.page.emit('framenavigated',f.frame);});
    await expect(f.discovery.scan(f.reader,true,new AbortController().signal)).rejects.toThrow('OWN_WORKS_RESPONSE_UNVERIFIED');
  }finally{f.discovery.dispose();}
});
