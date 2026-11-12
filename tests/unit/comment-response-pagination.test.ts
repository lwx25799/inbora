import {expect,test} from 'vitest';
import {EventEmitter} from 'node:events';
import type {Page} from 'playwright';
import {CommentResponses} from '../../src/adapters/comment-responses.js';
import {commentReplyMapping} from '../fixtures/observed-site.js';
import {candidate} from '../helpers.js';

const event=candidate({channel:'COMMENT_NOTIFICATION',kind:'REPLY',videoId:'10',commentId:'21',platformEventId:'21',rootCommentId:'11',replyToCommentId:'21',conversationId:null});
const reply=()=>({cid:'901',aweme_id:'10',reply_id:'11',reply_to_reply_id:'21',text:'SYNTHETIC_REPLY',status:1,
  create_time:1794000000,user:{uid:'100',sec_uid:'SYNTHETIC_SELF'}});
const exact=(rows:unknown[]=[reply()])=>({status_code:0,comments:[{cid:'11',aweme_id:'10',reply_comment:rows}]});
const unrelated={status_code:0,comments:[{cid:'12',aweme_id:'10',reply_comment:[]}]};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
  const frame={},mapping=commentReplyMapping('https://www.douyin.com');
  const page=new EventEmitter() as EventEmitter&{mainFrame:()=>unknown;url:()=>string};
  page.mainFrame=()=>frame;page.url=()=>mapping.observation.works[0]!.url;
  const observer=new CommentResponses(page as unknown as Page,mapping);observer.watch(event);
  const request=(kind:'ROOT'|'REPLY'='ROOT')=>{
    const request={method:()=> 'GET',frame:()=>frame,url:()=>mapping.observation.origin+(kind==='ROOT'
      ?'/aweme/v1/web/comment/list/?aweme_id=10&cursor=20':'/aweme/v1/web/comment/list/reply/?comment_id=11')};
    page.emit('request',request);return request;
  };
  const respond=(request:unknown,body:unknown,fault:'HTTP'|'SW'|'JSON'|null=null)=>page.emit('response',{
    request:()=>request,status:()=>fault==='HTTP'?500:200,fromServiceWorker:()=>fault==='SW',headers:()=>({}),
    body:async()=>Buffer.from(fault==='JSON'?'SYNTHETIC_INVALID_JSON':JSON.stringify(body)),
  });
  const seed=async(kind:'ROOT'|'REPLY'='REPLY')=>{
    respond(request(kind),kind==='ROOT'?exact():{status_code:0,comments:[reply()]});await settle();
    expect(observer.snapshot(event)).toEqual([reply()]);
  };
  return {observer,page,frame,request,respond,seed,close:()=>observer.dispose()};
}

test.each(['ROOT','REPLY'] as const)('unrelated root pagination temporarily hides then restores exact %s evidence',async source=>{
  const f=fixture();try{
    await f.seed(source);const pending=f.request();expect(f.observer.snapshot(event)).toEqual([]);
    f.respond(pending,unrelated);await settle();expect(f.observer.snapshot(event)).toEqual([reply()]);
    expect(f.observer.diagnostics()).toMatchObject({requests:2,responses:2,accepted:1,rows:1,stage:'ROOT'});
  }finally{f.close();}
});

test.each(['ROOT','REPLY'] as const)('overlapping unrelated pagination cannot discard delayed exact %s evidence',async source=>{
  const f=fixture();try{
    const first=f.request(source),later=f.request();f.respond(later,unrelated);await settle();
    expect(f.observer.snapshot(event)).toEqual([]);
    f.respond(first,source==='ROOT'?exact():{status_code:0,comments:[reply()]});await settle();
    expect(f.observer.snapshot(event)).toEqual([reply()]);
  }finally{f.close();}
});

test('a newer unresolved root page hides an earlier completed reply until that page is classified',async()=>{
  const f=fixture();try{
    const first=f.request('REPLY'),later=f.request();f.respond(first,{status_code:0,comments:[reply()]});await settle();
    expect(f.observer.snapshot(event)).toEqual([]);
    f.respond(later,unrelated);await settle();expect(f.observer.snapshot(event)).toEqual([reply()]);
  }finally{f.close();}
});

test.each(['EMPTY','DUPLICATE_ROOT','BAD_CHILD','WRONG_WORK','WRONG_ROOT','DUPLICATE_CHILD','SCHEMA','HTTP','SW','JSON'] as const)(
  'a newer relevant or unclassifiable root %s response revokes old evidence permanently',async fault=>{
  const f=fixture();try{
    await f.seed();const pending=f.request();expect(f.observer.snapshot(event)).toEqual([]);
    const row=reply();const body=fault==='EMPTY'?exact([]):fault==='DUPLICATE_ROOT'?{status_code:0,comments:[...exact().comments,...exact().comments]}
      :fault==='BAD_CHILD'?exact([{...row,cid:901}]):fault==='WRONG_WORK'?exact([{...row,aweme_id:'20'}])
      :fault==='WRONG_ROOT'?exact([{...row,reply_id:'12'}]):fault==='DUPLICATE_CHILD'?exact([row,row])
      :fault==='SCHEMA'?{status_code:1,comments:[]}:exact();
    f.respond(pending,body,['HTTP','SW','JSON'].includes(fault)?fault as 'HTTP'|'SW'|'JSON':null);await settle();
    expect(f.observer.snapshot(event)).toEqual([]);
    f.respond(f.request(),unrelated);await settle();expect(f.observer.snapshot(event)).toEqual([]);
  }finally{f.close();}
});

test('newer exact native contradictions replace the old confirmed row instead of merging with it',async()=>{
  const f=fixture();try{
    await f.seed();const changed={...reply(),status:0,text:'SYNTHETIC_CHANGED'};
    f.respond(f.request(),exact([changed]));await settle();expect(f.observer.snapshot(event)).toEqual([changed]);
    f.respond(f.request(),unrelated);await settle();expect(f.observer.snapshot(event)).toEqual([changed]);
  }finally{f.close();}
});

test.each(['ROOT','REPLY'] as const)('older delayed %s proof cannot revive after a newer exact empty response',async source=>{
  const f=fixture();try{
    const old=f.request(source),newer=f.request();f.respond(newer,exact([]));await settle();
    f.respond(old,source==='ROOT'?exact():{status_code:0,comments:[reply()]});await settle();
    expect(f.observer.snapshot(event)).toEqual([]);
    f.respond(f.request(),unrelated);await settle();expect(f.observer.snapshot(event)).toEqual([]);
  }finally{f.close();}
});

test('a newer exact reply supersedes an older unresolved root page and ignores its late contradiction',async()=>{
  const f=fixture();try{
    const old=f.request(),newer=f.request('REPLY');f.respond(newer,{status_code:0,comments:[reply()]});await settle();
    expect(f.observer.snapshot(event)).toEqual([reply()]);
    f.respond(old,exact([]));await settle();expect(f.observer.snapshot(event)).toEqual([reply()]);
  }finally{f.close();}
});

test('failed newer requests revoke retained evidence and do not leave a pending restore',async()=>{
  const f=fixture();try{
    await f.seed();const pending=f.request();f.page.emit('requestfailed',pending);
    expect(f.observer.snapshot(event)).toEqual([]);
    f.respond(f.request(),unrelated);await settle();expect(f.observer.snapshot(event)).toEqual([]);
  }finally{f.close();}
});

test.each(['NAVIGATION','EVENT','DISPOSE'] as const)('retained evidence and late unrelated responses cannot cross %s',async action=>{
  const f=fixture();try{
    await f.seed();const pending=f.request();
    if(action==='NAVIGATION')f.page.emit('framenavigated',f.frame);
    if(action==='EVENT')f.observer.watch({...event,commentId:'22',platformEventId:'22',replyToCommentId:'22'});
    if(action==='DISPOSE')f.close();
    f.respond(pending,unrelated);await settle();expect(f.observer.snapshot(event)).toEqual([]);
  }finally{f.close();}
});

test('excess pending requests invalidate the bounded window and cannot resurrect its old evidence',async()=>{
  const f=fixture();try{
    await f.seed();const pending=Array.from({length:33},()=>f.request());
    expect(f.observer.snapshot(event)).toEqual([]);
    for(const request of pending){f.respond(request,unrelated);await settle();}
    expect(f.observer.snapshot(event)).toEqual([]);
    await f.seed();
  }finally{f.close();}
});
