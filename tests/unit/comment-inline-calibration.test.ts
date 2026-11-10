import {expect,test} from 'vitest';
import {EventEmitter} from 'node:events';
import type {Page} from 'playwright';
import {CommentListDiagnostics} from '../../src/adapters/comment-list-diagnostics.js';
import {observedMapping} from '../fixtures/observed-site.js';

async function inspect(comments:unknown[]){
  const mapping=observedMapping('https://www.douyin.com'),frame={},page=new EventEmitter() as EventEmitter&{mainFrame:()=>unknown;url:()=>string};
  page.mainFrame=()=>frame;page.url=()=>mapping.works[0]!.url;
  const now=Date.now(),watcher=new CommentListDiagnostics(page as unknown as Page,mapping,mapping.works[0]!,()=>now,now-60_000);
  try{
    const request={method:()=> 'GET',frame:()=>frame,url:()=>mapping.origin+'/aweme/v1/web/comment/list/?aweme_id=10&cursor=0'};
    page.emit('request',request);page.emit('response',{request:()=>request,status:()=>200,fromServiceWorker:()=>false,headers:()=>({}),
      body:async()=>Buffer.from(JSON.stringify({status_code:0,comments}))});
    return await watcher.summary(new AbortController().signal);
  }finally{watcher.dispose();expect(page.listenerCount('request')).toBe(0);}
}
const child=(cid:string,target:unknown,change:Record<string,unknown>={})=>({cid,aweme_id:'10',reply_id:'11',reply_to_reply_id:target,
  text:'PRIVATE_INLINE_BODY',create_time:Math.floor(Date.now()/1000)-10,user:{uid:cid==='21'?'200':'100',sec_uid:'PRIVATE_SEC'},status:1,...change});

test('normal inline children expose only bounded shape counts and exact same-root native relationships',async()=>{
  const summary=await inspect([{cid:'11',text:'PRIVATE_ROOT_BODY',reply_comment:[child('21','0'),child('22','21')]}]);
  expect(summary?.inlineShape).toMatchObject({roots:1,arrays:1,children:2,truncated:false,nativeId:2,workMatches:2,rootMatches:2,
    replyToString:2,toRoot:1,toKnownChild:1,toSelf:0,toUnknown:0,own:1,confirmed:2,timeValid:2,completeOwnChildRelations:1});
  expect(JSON.stringify(summary)).not.toMatch(/PRIVATE_|"11"|"21"|"22"|https:|reply_to_reply_id|aweme_id/u);
});

test.each(['wrong-root','wrong-work','duplicate','number','null','self','missing'] as const)('inline %s remains a diagnostic gap and cannot count as a complete own child relation',async fault=>{
  const target=fault==='number'?21:fault==='null'?null:fault==='self'?'22':fault==='missing'?undefined:'21';
  const other=child('21','0',fault==='wrong-root'?{reply_id:'12'}:fault==='wrong-work'?{aweme_id:'20'}:{});
  const own=child('22',target),summary=await inspect([{cid:'11',reply_comment:[other,own,...(fault==='duplicate'?[own]:[])]}]);
  expect(summary?.inlineShape?.completeOwnChildRelations).toBe(0);
  if(fault==='duplicate')expect(summary?.inlineShape?.duplicateIds).toBe(2);
  if(fault==='number')expect(summary?.inlineShape).toMatchObject({replyToNumber:1,toKnownChild:0});
  if(fault==='missing')expect(summary?.inlineShape?.replyToMissing).toBe(1);
});

test('inline scanning keeps one total 100-child limit and records missing/non-array fields without guessing',async()=>{
  const first=Array.from({length:80},(_,index)=>child(String(1000+index),'0'));
  const second=Array.from({length:80},(_,index)=>child(String(2000+index),'0',{reply_id:'12'}));
  const summary=await inspect([{cid:'11',reply_comment:first},{cid:'12',reply_comment:second},{cid:'13'},
    {cid:'14',reply_comment:{comments:[child('22','21')],PRIVATE_FIELD:'PRIVATE_BODY'}}]);
  expect(summary?.inlineShape).toMatchObject({roots:4,arrays:2,missing:1,other:1,children:100,truncated:true,nativeId:100,completeOwnChildRelations:0});
  expect(JSON.stringify(summary)).not.toContain('PRIVATE');
});
