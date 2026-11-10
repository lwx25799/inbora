import {expect,test} from 'vitest';
import {EventEmitter} from 'node:events';
import type {Page} from 'playwright';
import {CommentResponses} from '../../src/adapters/comment-responses.js';
import {commentReplyMapping} from '../fixtures/observed-site.js';
import {candidate} from '../helpers.js';

const event=candidate({channel:'COMMENT_NOTIFICATION',kind:'REPLY',videoId:'10',commentId:'21',platformEventId:'21',rootCommentId:'11',replyToCommentId:'21',conversationId:null});
const reply=()=>({cid:'901',aweme_id:'10',reply_id:'11',reply_to_reply_id:'21',text:'PRIVATE_INLINE_APPROVED',status:1,
  create_time:Math.floor(Date.now()/1000)-10,user:{uid:'100',sec_uid:'PRIVATE_SEC'}});
function fixture(){
  const frame={},foreign={},mapping=commentReplyMapping('https://www.douyin.com'),page=new EventEmitter() as EventEmitter&{mainFrame:()=>unknown;url:()=>string};
  let work='10';page.mainFrame=()=>frame;page.url=()=>mapping.observation.origin+'/video/'+work;
  const observer=new CommentResponses(page as unknown as Page,mapping);observer.watch(event);
  const request=(kind:'ROOT'|'REPLY'='ROOT',fault='')=>{
    const request={method:()=>fault==='POST'?'POST':'GET',frame:()=>fault==='FRAME'?foreign:frame,url:()=>
      (fault==='ORIGIN'?'https://outside.invalid':mapping.observation.origin)+(kind==='ROOT'?'/aweme/v1/web/comment/list/?aweme_id='+(fault==='QUERY'?'20':'10'):
        '/aweme/v1/web/comment/list/reply/?comment_id=11')};page.emit('request',request);return request;
  };
  const respond=(request:unknown,body:unknown,fault='',headers:Record<string,string>={})=>{
    page.emit('response',{request:()=>request,status:()=>fault==='HTTP'?500:200,fromServiceWorker:()=>fault==='SW',headers:()=>headers,
      body:async()=>Buffer.from(JSON.stringify(body))});
  };
  return{observer,page,frame,request,respond,work:(value:string)=>{work=value;},close:()=>observer.dispose()};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('the exact normal root-list supplies native inline replies without needing a clock sample',async()=>{
  const f=fixture();try{
    const row=reply();f.respond(f.request(),{status_code:0,comments:[{cid:'11',aweme_id:'10',reply_comment:[row]}]});await settle();
    expect(f.observer.snapshot(event)).toEqual([row]);expect(f.observer.clockLag()).toBeNull();
    expect(f.observer.diagnostics()).toMatchObject({requests:1,responses:1,accepted:1,rows:1,stage:'ACCEPTED'});
    expect(JSON.stringify(f.observer.diagnostics())).not.toMatch(/PRIVATE_|901|https:|aweme/u);
  }finally{f.close();}
});

test('unrelated malformed roots cannot erase the one exactly bound root and its strict inline children',async()=>{
  const f=fixture();try{
    const row=reply();f.respond(f.request(),{status_code:0,comments:[null,{text:'PRIVATE_UNRELATED_ROOT',aweme_id:12},
      {cid:'12',aweme_id:{PRIVATE_FIELD:true}},{cid:'11',aweme_id:'10',reply_comment:[row]}]});await settle();
    expect(f.observer.snapshot(event)).toEqual([row]);
  }finally{f.close();}
});

test('valid clock calibration survives a root response with no inline rows and never invents native evidence',async()=>{
  const f=fixture();try{
    const now=Math.floor(Date.now()/1000)*1000-1000;
    f.respond(f.request(),{status_code:0,extra:{now},comments:[{cid:'11'}]},'',{date:new Date(now).toUTCString()});await settle();
    expect(f.observer.snapshot(event)).toEqual([]);expect(f.observer.clockLag()).toBeGreaterThanOrEqual(1000);
  }finally{f.close();}
});

test('a stale root body cannot replace the latest root clock or exact inline rows',async()=>{
  const f=fixture();try{
    const first=f.request(),second=f.request(),now=Math.floor(Date.now()/1000)*1000-1000;
    const row=reply();f.respond(second,{status_code:0,extra:{now},comments:[{cid:'11',reply_comment:[row]}]},'',{date:new Date(now).toUTCString()});await settle();
    f.respond(first,{status_code:0,extra:{now:now-4000},comments:[{cid:'11',reply_comment:[]}]},'',{date:new Date(now-4000).toUTCString()});await settle();
    expect(f.observer.snapshot(event)).toEqual([row]);expect(f.observer.clockLag()).toBeLessThan(3000);
  }finally{f.close();}
});

test.each(['ROOT','DUPLICATE_ROOT','MISSING','ARRAY','WRONG_WORK','WRONG_CHILD_ROOT','DUPLICATE_CHILD','SCHEMA','HTTP','SW','POST','FRAME','ORIGIN','QUERY'] as const)(
  'invalid or unbound root inline cannot populate native rows: %s',async fault=>{
  const f=fixture();try{
    const child={...reply(),...(fault==='WRONG_WORK'?{aweme_id:'20'}:fault==='WRONG_CHILD_ROOT'?{reply_id:'12'}:fault==='SCHEMA'?{cid:901}:{})};
    const root={cid:fault==='ROOT'?'12':'11',aweme_id:'10',...(fault==='MISSING'?{}:{reply_comment:fault==='ARRAY'?{}:[child,...(fault==='DUPLICATE_CHILD'?[child]:[])]})};
    f.respond(f.request('ROOT',fault),{status_code:0,comments:[root,...(fault==='DUPLICATE_ROOT'?[root]:[])]},fault);await settle();
    expect(f.observer.snapshot(event)).toEqual([]);
  }finally{f.close();}
});

test.each(['ROOT','REPLY'] as const)('a later %s request revokes every previous root/reply body until its own result is verified',async later=>{
  const f=fixture();try{
    const first=f.request(later==='ROOT'?'REPLY':'ROOT'),second=f.request(later);
    f.respond(second,{status_code:0,comments:later==='ROOT'?[{cid:'11',reply_comment:[]}]:[]});await settle();
    f.respond(first,{status_code:0,comments:later==='ROOT'?[reply()]:[{cid:'11',reply_comment:[reply()]}]});await settle();
    expect(f.observer.snapshot(event)).toEqual([]);
  }finally{f.close();}
});

test.each(['NAVIGATION','WORK','EVENT','DISPOSE'] as const)('late inline body is rejected after %s',async fault=>{
  const f=fixture();try{
    const request=f.request();
    if(fault==='NAVIGATION')f.page.emit('framenavigated',f.frame);
    if(fault==='WORK')f.work('20');
    if(fault==='EVENT')f.observer.watch({...event,commentId:'22',platformEventId:'22',replyToCommentId:'22'});
    if(fault==='DISPOSE')f.close();
    f.respond(request,{status_code:0,comments:[{cid:'11',reply_comment:[reply()]}]});await settle();
    expect(f.observer.snapshot(event)).toEqual([]);
  }finally{f.close();}
});
