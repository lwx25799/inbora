import {afterEach, expect, test, vi} from 'vitest';
import {EventEmitter} from 'node:events';
import type {Page, Response} from 'playwright';
import {readNormalJsonResponse, NORMAL_RESPONSE_MAX_BYTES, NORMAL_RESPONSE_TIMEOUT_MS} from '../../src/adapters/normal-response-reader.js';
import {CommentResponses} from '../../src/adapters/comment-responses.js';
import {CommentListDiagnostics} from '../../src/adapters/comment-list-diagnostics.js';
import {commentReplyMapping} from '../fixtures/observed-site.js';
import {candidate} from '../helpers.js';

afterEach(()=>vi.restoreAllMocks());

function response(text='{"status_code":0}', options:{status?:number;sw?:boolean;declared?:number;type?:string;failure?:boolean}={}) {
  const body=vi.fn(async()=>{if(options.failure)throw Error('PRIVATE_NETWORK_BODY');return Buffer.from(text);});
  const value={status:()=>options.status??200,fromServiceWorker:()=>options.sw??false,
    headers:()=>({'content-type':options.type??'application/json',...(options.declared===undefined?{}:{'content-length':String(options.declared)})}),
    body} as unknown as Response;
  return {value,body};
}

test('all simultaneous consumers share one bounded body read and one JSON parse',async()=>{
  const f=response(),parse=vi.spyOn(JSON,'parse');
  const results=await Promise.all([readNormalJsonResponse(f.value,1_000_000),readNormalJsonResponse(f.value,2_000_000)]);
  expect(results).toEqual([{ok:true,value:{status_code:0},byteLength:17},{ok:true,value:{status_code:0},byteLength:17}]);
  expect(f.body).toHaveBeenCalledTimes(1);expect(parse).toHaveBeenCalledTimes(1);
  expect(await readNormalJsonResponse(f.value,1_000_000)).toBe(results[0]);
  expect(f.body).toHaveBeenCalledTimes(1);expect(parse).toHaveBeenCalledTimes(1);
});

test.each([
  ['HTTP',response('PRIVATE_BODY',{status:500}),false],
  ['SERVICE_WORKER',response('PRIVATE_BODY',{sw:true}),false],
  ['SIZE',response('PRIVATE_BODY',{declared:NORMAL_RESPONSE_MAX_BYTES+1}),false],
  ['SIZE',response(' '.repeat(NORMAL_RESPONSE_MAX_BYTES+1)),true],
  ['EMPTY',response('   '),true],
  ['HTML',response('<html>PRIVATE_BODY</html>'),true],
  ['HTML',response('PRIVATE_BODY',{type:'text/html'}),true],
  ['JSON',response('PRIVATE_INVALID_JSON'),true],
  ['NETWORK',response('',{failure:true}),true],
] as const)('response failure uses only a fixed enum: %s',async(reason,f,read)=>{
  const result=await readNormalJsonResponse(f.value,2_000_000);
  expect(result).toEqual({ok:false,reason});expect(f.body).toHaveBeenCalledTimes(read?1:0);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|https:|headers|stack/u);
});

test('a tighter consumer limit does not poison another consumer and never re-reads the response',async()=>{
  const f=response('{"value":"'+ 'x'.repeat(30)+'"}');
  expect(await readNormalJsonResponse(f.value,20)).toEqual({ok:false,reason:'SIZE'});
  expect(await readNormalJsonResponse(f.value,200)).toMatchObject({ok:true,value:{value:'x'.repeat(30)}});
  expect(f.body).toHaveBeenCalledTimes(1);
});

test('a consumer cannot mutate shared body fields or byte limits for another consumer',async()=>{
  const f=response('{"comments":[{"cid":"21","text":"approved"}]}');
  const first=await readNormalJsonResponse(f.value);
  expect(first.ok).toBe(true);if(!first.ok)throw Error('expected accepted fixture');
  expect(Object.isFrozen(first)).toBe(true);expect(Object.isFrozen(first.value)).toBe(true);
  const body=first.value as {comments:{cid:string;text:string}[]};
  expect(Object.isFrozen(body.comments)).toBe(true);expect(Object.isFrozen(body.comments[0])).toBe(true);
  expect(()=>{body.comments[0]!.text='changed';}).toThrow(TypeError);
  expect(()=>{first.byteLength=0;}).toThrow(TypeError);
  expect(await readNormalJsonResponse(f.value)).toBe(first);
  expect(await readNormalJsonResponse(f.value,10)).toEqual({ok:false,reason:'SIZE'});
  expect(body.comments[0]!.text).toBe('approved');expect(f.body).toHaveBeenCalledTimes(1);
});

test('shared response parsing never coerces numeric native identifiers into strings',async()=>{
  const f=response('{"cid":7397583912345678901}');
  const result=await readNormalJsonResponse(f.value,200);
  expect(result.ok&&typeof (result.value as {cid:unknown}).cid).toBe('number');
});

test('a hanging body has one bounded timeout shared by every consumer',async()=>{
  vi.useFakeTimers();
  try {
    const f=response();f.body.mockImplementation(()=>new Promise(()=>{}));
    const first=readNormalJsonResponse(f.value),second=readNormalJsonResponse(f.value);
    await vi.advanceTimersByTimeAsync(NORMAL_RESPONSE_TIMEOUT_MS);
    expect(await first).toEqual({ok:false,reason:'NETWORK'});expect(await second).toEqual({ok:false,reason:'NETWORK'});
    expect(f.body).toHaveBeenCalledTimes(1);
  }finally {vi.useRealTimers();}
});

test('clock evidence and comment diagnostics consume the same response once, then reject a late navigation epoch',async()=>{
  const mapping=commentReplyMapping('https://www.douyin.com'),frame={},page=new EventEmitter() as EventEmitter&{mainFrame:()=>unknown;url:()=>string};
  page.mainFrame=()=>frame;page.url=()=>mapping.observation.works[0]!.url;
  const replies=new CommentResponses(page as unknown as Page,mapping),now=Date.now();
  const diagnostic=new CommentListDiagnostics(page as unknown as Page,mapping.observation,mapping.observation.works[0]!,()=>now,now-1000);
  replies.watch(candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',videoId:'10',commentId:'11',platformEventId:'11',conversationId:null}));
  const request={method:()=> 'GET',frame:()=>frame,url:()=>mapping.observation.origin+'/aweme/v1/web/comment/list/?aweme_id=10&cursor=0'};
  let release!:(value:Buffer)=>void;
  const body=vi.fn(()=>new Promise<Buffer>(resolve=>{release=resolve;}));
  const value={request:()=>request,status:()=>200,fromServiceWorker:()=>false,headers:()=>({date:new Date(now).toUTCString()}),body};
  try {
    page.emit('request',request);page.emit('response',value);
    expect(body).toHaveBeenCalledTimes(1);
    page.emit('framenavigated',frame);
    release(Buffer.from(JSON.stringify({status_code:0,extra:{now},comments:[],cursor:0,has_more:0,total:0})));
    expect(await diagnostic.summary(new AbortController().signal)).toBeNull();
    expect(replies.clockLag()).toBeNull();expect(body).toHaveBeenCalledTimes(1);
  }finally {replies.dispose();diagnostic.dispose();}
});
