import {expect,test} from 'vitest';
import {decodeDmSubmission,decodeDmAcknowledgement} from '../../src/adapters/submission-response.js';
import {proofTimeValid,type SendProof} from '../../src/core/contracts.js';
import {dmRequest,dmResponse,int} from '../fixtures/submission.js';
import {EventEmitter} from 'node:events';
import type {Page} from 'playwright';
import {SubmissionResponse,defaultConfirmedCommentPublishStatuses} from '../../src/adapters/submission-response.js';
import {observedMapping} from '../fixtures/observed-site.js';
import {candidate} from '../helpers.js';

test('bounded native DM decoding binds command, sequence, client, server and owner without number precision loss',()=>{
  const sent=decodeDmSubmission(dmRequest('synthetic exact text'));
  expect(sent).toEqual({text:'synthetic exact text',conversation:'conv-a',clientId:'synthetic-client',sequence:'99'});
  expect(decodeDmAcknowledgement(dmResponse({id:7704970939855554001n}),sent,'100')).toBe('7704970939855554001');
});
test.each([{client:'other'},{status:1},{sequence:100},{owner:200},{async:true},{check:1},{id:0n}])('native acknowledgement rejects conflicting fields %#',override=>{
  expect(()=>decodeDmAcknowledgement(dmResponse(override),decodeDmSubmission(dmRequest('test')),'100')).toThrow();
});
test.each([Buffer.alloc(65_537),Buffer.from([128]),Buffer.from([0]),Buffer.from([8,128,0]),Buffer.concat([dmRequest('test'),int(1,100)])])('invalid wire data never becomes submission evidence',body=>{
  expect(()=>decodeDmSubmission(body)).toThrow();
});
test.each(['valid','boundary','request-before','response-before','future','digest','invalid-native-time'])('causal proof gate validates the original boundary and local ordering: %s',kind=>{
  const now=Date.now(),boundary=new Date(now-10).toISOString(),p:SendProof={id:'new',ownId:'100',targetKey:'dm:conv-a',text:'test',pending:false,
    sentAt:new Date(now-1000).toISOString(),submission:{boundary,requestAt:boundary,responseAt:new Date(now-1).toISOString(),requestDigest:'a'.repeat(64),responseDigest:'b'.repeat(64)}};
  if(kind==='boundary')p.submission!.boundary=new Date(now-20).toISOString();
  if(kind==='request-before')p.submission!.requestAt=new Date(now-11).toISOString();
  if(kind==='response-before')p.submission!.responseAt=new Date(now-11).toISOString();
  if(kind==='future')p.submission!.responseAt=new Date(now+10_000).toISOString();
  if(kind==='digest')p.submission!.requestDigest='missing';
  if(kind==='invalid-native-time')p.sentAt='unverifiable';
  expect(proofTimeValid(p,boundary)).toBe(kind==='valid');
  delete p.submission;expect(proofTimeValid(p,boundary)).toBe(false);
});

test.each(['within','edge','too-old','future','boundary','digest','id','comment'] as const)('bounded clock proof validates every preserved binding: %s',kind=>{
  const now=Date.now(),boundary=new Date(now-100).toISOString(),baseline='a'.repeat(64);
  const p:SendProof={id:'888',ownId:'100',targetKey:'dm:conv-a',text:'test',pending:false,
    sentAt:new Date(Date.parse(boundary)-(kind==='edge'?2000:kind==='too-old'?2001:763)).toISOString(),
    clockSkew:{boundary,baselineContextDigest:baseline,remainingContextDigest:baseline,refreshedId:'888'}};
  if(kind==='future')p.sentAt=new Date(now+10000).toISOString();
  if(kind==='boundary')p.clockSkew!.boundary=new Date(now-101).toISOString();
  if(kind==='digest')p.clockSkew!.remainingContextDigest='b'.repeat(64);
  if(kind==='id')p.clockSkew!.refreshedId='999';
  if(kind==='comment')p.targetKey='comment:10:11';
  expect(proofTimeValid(p,boundary)).toBe(kind==='within'||kind==='edge');
  delete p.clockSkew;expect(proofTimeValid(p,boundary)).toBe(false);
});

test.each(['valid','service-worker','navigation','wrong-body','missing-body','old-request','duplicate-key','redirect','bad-status'])('passive response evidence never survives an invalid source or scope: %s',async kind=>{
  const page=new EventEmitter() as EventEmitter&{mainFrame:()=>unknown;url:()=>string},frame={};
  page.mainFrame=()=>frame;page.url=()=> 'https://www.douyin.com/video/10';
  const observer=new SubmissionResponse(page as unknown as Page,observedMapping('https://www.douyin.com')),
    e=candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',videoId:'10',commentId:'11',conversationId:null}),text='synthetic';
  const request={method:()=> 'POST',frame:()=>frame,url:()=> 'https://www.douyin.com/aweme/v1/web/comment/publish',redirectedFrom:()=>kind==='redirect'?{}:null,
    postDataBuffer:()=>Buffer.from('aweme_id=10&reply_id=11&text='+text+(kind==='duplicate-key'?'&reply_id=11':''))};
  if(kind==='old-request')page.emit('request',request);
  observer.arm(e,text,new Date(Date.now()-1).toISOString());
  if(kind!=='old-request')page.emit('request',request);
  let release!:(body:Buffer)=>void;const body=new Promise<Buffer>(resolve=>{release=resolve;});
  page.emit('response',{request:()=>request,status:()=>kind==='bad-status'?403:200,fromServiceWorker:()=>kind==='service-worker',headers:()=>({}),body:()=>body});
  if(kind==='navigation')page.emit('framenavigated',frame);
  release(Buffer.from(kind==='missing-body'?'':JSON.stringify({status_code:0,comment:{cid:'501',reply_id:kind==='wrong-body'?'12':'11',reply_to_reply_id:'0',
    text,user:{uid:'100',sec_uid:'self-sec'},status:7,create_time:1793950000}})));
  await new Promise(resolve=>setImmediate(resolve));
  expect(Boolean(observer.current())).toBe(kind==='valid');observer.dispose();
  expect(page.listenerCount('request')).toBe(0);expect(page.listenerCount('response')).toBe(0);
});

test.each([
  {label:'local-slow-1500ms-direct',offsetMs:1500,withAck:false,expected:true},
  {label:'local-slow-2000ms-edge',offsetMs:2000,withAck:false,expected:true},
  {label:'local-slow-2001ms-rejected',offsetMs:2001,withAck:false,expected:false},
  {label:'local-slow-1500ms-with-ack',offsetMs:1500,withAck:true,expected:true},
  {label:'local-slow-2500ms-with-ack-rejected',offsetMs:2500,withAck:true,expected:false},
])('bidirectional 2000ms clock tolerance handles slow local clock safely: $label',({offsetMs,withAck,expected})=>{
  const now=Date.now(),boundary=new Date(now-50).toISOString();
  const proof:SendProof={id:'new',ownId:'100',targetKey:'dm:conv-a',text:'test',pending:false,
    sentAt:new Date(now+offsetMs).toISOString(),
    ...(withAck?{submission:{boundary,requestAt:boundary,responseAt:new Date(now-1).toISOString(),requestDigest:'a'.repeat(64),responseDigest:'b'.repeat(64)}}:{})};
  expect(proofTimeValid(proof,boundary)).toBe(expected);
});

test.each([
  {label:'no-baseline-presend-plus-500ms-rejected',deltaFromBoundaryMs:500,hasBaseline:false,withSkew:false,target:'dm:conv-a',expected:false},
  {label:'no-baseline-edge-plus-2000ms-rejected',deltaFromBoundaryMs:2000,hasBaseline:false,withSkew:false,target:'dm:conv-a',expected:false},
  {label:'no-baseline-beyond-tolerance-2001ms-accepted',deltaFromBoundaryMs:2001,hasBaseline:false,withSkew:false,target:'dm:conv-a',expected:true},
  {label:'no-baseline-comment-plus-500ms-rejected',deltaFromBoundaryMs:500,hasBaseline:false,withSkew:false,target:'comment:10:11',expected:false},
  {label:'no-baseline-comment-beyond-tolerance-accepted',deltaFromBoundaryMs:2001,hasBaseline:false,withSkew:false,target:'comment:10:11',expected:true},
  {label:'no-baseline-dm-plus-500ms-with-context-skew-accepted',deltaFromBoundaryMs:500,hasBaseline:false,withSkew:true,target:'dm:conv-a',expected:true},
  {label:'no-baseline-comment-with-skew-rejected',deltaFromBoundaryMs:500,hasBaseline:false,withSkew:true,target:'comment:10:11',expected:false},
  {label:'with-baseline-plus-500ms-accepted',deltaFromBoundaryMs:500,hasBaseline:true,withSkew:false,target:'dm:conv-a',expected:true},
])('proofTimeValid guards baseline-less verification against +2000ms pre-send collisions: $label',({deltaFromBoundaryMs,hasBaseline,withSkew,target,expected})=>{
  const now=Date.now(),boundary=new Date(now-2500).toISOString(),baseline='a'.repeat(64);
  const proof:SendProof={id:'m1',ownId:'100',targetKey:target,text:'test',pending:false,
    sentAt:new Date(Date.parse(boundary)+deltaFromBoundaryMs).toISOString(),
    ...(withSkew?{clockSkew:{boundary,baselineContextDigest:baseline,remainingContextDigest:baseline,refreshedId:'m1'}}:{})};
  expect(proofTimeValid(proof,boundary,hasBaseline)).toBe(expected);
});

test('comment publish confirmed status uses named default [7] and supports configured status sets',async()=>{
  expect(defaultConfirmedCommentPublishStatuses).toEqual([7]);
  for(const [configured,status,expected] of [[undefined,7,true],[undefined,1,false],[[7,1],1,true],[[7,1],7,true],[[7,1],0,false]] as const){
    const page=new EventEmitter() as EventEmitter&{mainFrame:()=>unknown;url:()=>string},frame={};
    page.mainFrame=()=>frame;page.url=()=>'https://www.douyin.com/video/10';
    const observer=new SubmissionResponse(page as unknown as Page,observedMapping('https://www.douyin.com'),
      configured?{confirmedCommentStatuses:configured}:undefined);
    const e=candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',videoId:'10',commentId:'11',conversationId:null}),text='synthetic';
    const request={method:()=>'POST',frame:()=>frame,url:()=>'https://www.douyin.com/aweme/v1/web/comment/publish',redirectedFrom:()=>null,
      postDataBuffer:()=>Buffer.from('aweme_id=10&reply_id=11&text='+text)};
    observer.arm(e,text,new Date(Date.now()-1).toISOString());
    page.emit('request',request);
    page.emit('response',{request:()=>request,status:()=>200,fromServiceWorker:()=>false,headers:()=>({}),
      body:async()=>Buffer.from(JSON.stringify({status_code:0,comment:{cid:'501',reply_id:'11',reply_to_reply_id:'0',
        text,user:{uid:'100',sec_uid:'self-sec'},status,create_time:1793950000}}))});
    await new Promise(resolve=>setImmediate(resolve));
    expect(Boolean(observer.current())).toBe(expected);
    observer.dispose();
  }
});
