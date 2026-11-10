import {expect,test} from 'vitest';
import {EventEmitter} from 'node:events';
import type {Page} from 'playwright';
import {CommentListDiagnostics} from '../../src/adapters/comment-list-diagnostics.js';
import {observedMapping} from '../fixtures/observed-site.js';

function fixture(){
  const mapping=observedMapping('https://www.douyin.com'),page=new EventEmitter() as EventEmitter&{mainFrame:()=>unknown;url:()=>string};
  const frame={},foreign={};let url=mapping.works[0]!.url,bodyReads=0;
  page.mainFrame=()=>frame;page.url=()=>url;const now=Date.UTC(2026,10,9,12),watcher=new CommentListDiagnostics(page as unknown as Page,mapping,mapping.works[0]!,()=>now,now-20*60_000);
  const body={status_code:0,total:20,has_more:1,cursor:20,comments:[{cid:'21',text:'PRIVATE_BODY',create_time:(now-5*60_000)/1000,user:{uid:'200',nickname:'PRIVATE_NAME'}},
    {cid:'22',create_time:(now-60*60_000)/1000,user:{uid:'100'}},{cid:'23',user:{uid:'200'}},{cid:'24',create_time:(now+1000)/1000,user:{uid:'200'}}]};
  const emit=(fault='',custom:unknown=body)=>{
    const request={method:()=>fault==='POST'?'POST':'GET',frame:()=>fault==='FRAME'?foreign:frame,
      url:()=>fault==='ORIGIN'?'https://outside.invalid/aweme/v1/web/comment/list/?aweme_id=10':mapping.origin+'/aweme/v1/web/comment/list/?aweme_id='+
        (fault==='WORK'?'20':fault==='DUPLICATE'?'10&aweme_id=10':'10')+'&cursor=0'};
    page.emit('request',request);page.emit('response',{request:()=>request,status:()=>fault==='HTTP'?500:200,fromServiceWorker:()=>fault==='SW',
      headers:()=>fault==='DECLARED_LARGE'?{'content-length':String(2*1024*1024+1)}:{},body:async()=>{bodyReads++;
        if(fault==='BYTES_LARGE')return Buffer.alloc(2*1024*1024+1);return Buffer.from(fault==='JSON'?'PRIVATE_INVALID_JSON':JSON.stringify(custom));}});
  };
  return{page,frame,body,watcher,emit,reads:()=>bodyReads,change:()=>{url=mapping.origin+'/video/20';},signal:()=>new AbortController().signal};
}

test('only current normal root-list response counts survive, without comment bodies, identifiers or another request',async()=>{
  const f=fixture();try{
    f.emit();const summary=await f.watcher.summary(f.signal());
    expect(summary).toEqual({count:4,total:20,hasMore:true,requestedCursor:0,cursor:20,cursorAdvances:true,afterOrigin:1,fresh30m:1,older30m:1,
      unknownTime:1,futureTime:1,ownCount:1,metadataMissing:1,newestAgeMs:300000,newestNonOwnAgeMs:300000,
      inlineShape:{roots:4,arrays:0,missing:4,other:0,children:0,truncated:false,duplicateIds:0,nativeId:0,workMatches:0,rootMatches:0,
        replyToMissing:0,replyToString:0,replyToNumber:0,replyToNull:0,replyToOther:0,toRoot:0,toKnownChild:0,toSelf:0,toUnknown:0,
        own:0,confirmed:0,timeValid:0,completeOwnChildRelations:0}});
    expect(JSON.stringify(summary)).not.toMatch(/PRIVATE_|"21"|"22"|https:|douyin|nickname/u);expect(f.reads()).toBe(1);
    f.page.emit('framenavigated',f.frame);expect(await f.watcher.summary(f.signal())).toBeNull();
  }finally{f.watcher.dispose();expect(f.page.listenerCount('request')).toBe(0);expect(f.page.listenerCount('response')).toBe(0);}
});

test.each(['POST','FRAME','ORIGIN','WORK','DUPLICATE','HTTP','SW','DECLARED_LARGE','BYTES_LARGE','JSON','BUSINESS','ROWS_LARGE','URL','CANCEL'])
  ('invalid normal response does not become a current summary: %s',async fault=>{
  const f=fixture();try{
    const controller=new AbortController();if(fault==='URL')f.change();if(fault==='CANCEL')controller.abort();
    f.emit(fault,fault==='BUSINESS'?{...f.body,status_code:1}:fault==='ROWS_LARGE'?{...f.body,comments:Array.from({length:101},()=>({}))}:f.body);
    expect(await f.watcher.summary(controller.signal)).toBeNull();
    if(['POST','FRAME','ORIGIN','WORK','DUPLICATE','HTTP','SW','DECLARED_LARGE','URL'].includes(fault))expect(f.reads()).toBe(0);
  }finally{f.watcher.dispose();}
});

test('a second unmatched body, navigation, disposal or missing response never inherits an earlier summary',async()=>{
  const f=fixture();try{
    expect(await f.watcher.summary(f.signal())).toBeNull();f.emit();expect(await f.watcher.summary(f.signal())).not.toBeNull();
    f.emit('JSON');expect(await f.watcher.summary(f.signal())).toBeNull();f.emit();f.change();expect(await f.watcher.summary(f.signal())).toBeNull();
    f.watcher.dispose();expect(await f.watcher.summary(f.signal())).toBeNull();
  }finally{f.watcher.dispose();}
});

test('a late body from the previous navigation epoch cannot populate a later DOM window',async()=>{
  const f=fixture();try{
    let complete!:(body:Buffer)=>void;const request={method:()=> 'GET',frame:()=>f.frame,url:()=> 'https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=10'};
    f.page.emit('request',request);f.page.emit('response',{request:()=>request,status:()=>200,fromServiceWorker:()=>false,headers:()=>({}),body:()=>new Promise<Buffer>(resolve=>{complete=resolve;})});
    f.page.emit('framenavigated',f.frame);complete(Buffer.from(JSON.stringify(f.body)));
    expect(await f.watcher.summary(f.signal())).toBeNull();
  }finally{f.watcher.dispose();}
});

test('missing response metadata stays null or counted missing, never guessed as a known new participant',async()=>{
  const f=fixture();try{
    f.emit('',{status_code:0,comments:[{create_time:Date.UTC(2026,10,9,11,59)/1000}]});
    expect(await f.watcher.summary(f.signal())).toMatchObject({count:1,total:null,hasMore:null,cursor:null,cursorAdvances:null,ownCount:0,metadataMissing:1,newestNonOwnAgeMs:null});
  }finally{f.watcher.dispose();}
});
