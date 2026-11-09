import {expect,test} from 'vitest';
import {EventEmitter} from 'node:events';
import type {Page} from 'playwright';
import {SubmissionResponse} from '../../src/adapters/submission-response.js';
import {observedMapping} from '../fixtures/observed-site.js';
import {candidate} from '../helpers.js';

test.each(['valid','request-root','request-child','missing-child','duplicate-child','response-root','response-child','missing-response-child','root-response','text','self','pending'] as const)(
  'nested submission correlation requires the independently bound root and child (%s)',async fault=>{
  const page=new EventEmitter() as EventEmitter&{mainFrame:()=>unknown;url:()=>string},frame={};
  page.mainFrame=()=>frame;page.url=()=> 'https://www.douyin.com/video/10';
  const observer=new SubmissionResponse(page as unknown as Page,observedMapping('https://www.douyin.com'));
  const event=candidate({channel:'COMMENT_NOTIFICATION',kind:'REPLY',videoId:'10',commentId:'21',rootCommentId:'11',replyToCommentId:'21',conversationId:null}),text='exact nested approved reply';
  observer.arm(event,text,new Date(Date.now()-1).toISOString());
  const form=new URLSearchParams({aweme_id:'10',reply_id:fault==='request-root'?'21':'11',text,reply_to_reply_id:fault==='request-child'?'11':'21'});
  if(fault==='missing-child')form.delete('reply_to_reply_id');if(fault==='duplicate-child')form.append('reply_to_reply_id','21');
  const request={method:()=> 'POST',frame:()=>frame,url:()=> 'https://www.douyin.com/aweme/v1/web/comment/publish',redirectedFrom:()=>null,postDataBuffer:()=>Buffer.from(form.toString())};
  page.emit('request',request);
  const reply:Record<string,unknown>={cid:'901',aweme_id:'10',reply_id:fault==='response-root'?'21':'11',reply_to_reply_id:fault==='response-child'?'22':fault==='root-response'?'0':'21',
    text:fault==='text'?'other text':text,user:{uid:fault==='self'?'101':'100',sec_uid:'self-sec'},status:fault==='pending'?0:7,create_time:Math.floor(Date.now()/1000)};
  if(fault==='missing-response-child')delete reply.reply_to_reply_id;
  page.emit('response',{request:()=>request,status:()=>200,fromServiceWorker:()=>false,headers:()=>({}),body:async()=>Buffer.from(JSON.stringify({status_code:0,comment:reply}))});
  await new Promise(resolve=>setImmediate(resolve));
  expect(Boolean(observer.current())).toBe(fault==='valid');
  expect(observer.diagnostics()).toMatchObject({requestCount:1,acknowledged:fault==='valid'});observer.dispose();
  expect(page.listenerCount('request')).toBe(0);expect(page.listenerCount('response')).toBe(0);
});
