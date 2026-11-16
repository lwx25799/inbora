import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Exercise browser-serialized functions under both actual project compilation chains.
const source=process.argv[2]==='source',root=source?'src':'dist',extension=source?'ts':'js';
const load=name=>import(pathToFileURL(resolve(root,`adapters/${name}.${extension}`)).href);
const {captureObserved}=await load('observed-capture');
const {captureCommentThread}=await load('comment-thread-capture');
const {hasVisibleSecurityComponent}=await load('security-components');
const {captureDmReply}=await load('observed-dm-reply');
const {captureCommentReply}=await load('observed-comment-reply');
const {captureAndGuard}=await load('click-guard');
const {inspectMessageImage}=await load('message-preview');
const {inspectMessageShare}=await load('message-share');
const {visibleStoredMessage}=await load('message-view-location');
const {inspectSecuritySignal}=await load('security-inspection');
const {claimFreshCommentDocument,markCommentDocumentRead}=await load('fresh-comment-document');
const {inspectRecoveryNavigation}=await import(pathToFileURL(resolve(root,`app/browser-recovery-locations.${extension}`)).href);
function context(title='',visibleBlocker=false,origin='https://www.douyin.com',width=320,height=180){
  const blocker={tagName:'IFRAME',id:'synthetic-security',isConnected:true,parentElement:null,childNodes:[],querySelectorAll:()=>[],
    getBoundingClientRect:()=>({left:0,top:0,right:width,bottom:height,width,height}),getClientRects:()=>[{left:0,top:0,right:width,bottom:height,width,height}]};
  return {window:{},innerWidth:1280,innerHeight:720,performance:{timeOrigin:1000},location:{origin,href:origin+'/video/work'},document:{title,
    querySelectorAll:selector=>selector==='.security'&&visibleBlocker?[blocker]:[]},
    getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1'})};
}
const mapping={origin:'https://www.douyin.com',securityBlockers:'.security',
  works:[{id:'work',url:'https://www.douyin.com/video/work'}],peers:[{uid:'peer',conversationId:'chat'}],selectors:{selfAvatar:'.self'}};
const observed={mapping,channel:'identity',index:0,evidenceId:'synthetic-only'};
const thread={mapping,event:{videoId:'work'},action:'inspect',offset:0};
let checked=0;
function rejects(fn,input,environment,code){
  const invoke=runInNewContext(`(${fn.toString()})`,environment);
  assert.throws(()=>invoke(input),error=>error?.message===code||code==='OBSERVATION_SECURITY_SUSPECT'&&error?.message.startsWith(code+' INBORA_SECURITY_SIGNAL:'));checked++;
}
rejects(captureObserved,observed,context('',false,'https://example.invalid'),'OBSERVATION_UNEXPECTED_ORIGIN');
for(const title of ['验证码','安全验证','访问受限'])for(const [fn,input] of [[captureObserved,observed],[captureCommentThread,thread]])
  rejects(fn,input,context(title,true),'OBSERVATION_SECURITY_SUSPECT');
for(const [fn,input] of [[captureObserved,observed],[captureCommentThread,thread]])
  rejects(fn,input,context('',true),'OBSERVATION_SECURITY_SUSPECT');
rejects(captureObserved,observed,context(),'OBSERVATION_ACCOUNT_AVATAR_DOM_NOT_READY');
rejects(captureCommentThread,thread,context(),'OBSERVATION_ACCOUNT_CHANGED');
for(const [width,height] of [[0,0],[0,40],[40,0]]){
  rejects(captureObserved,observed,context('',true,undefined,width,height),'OBSERVATION_ACCOUNT_AVATAR_DOM_NOT_READY');
  rejects(captureCommentThread,thread,context('',true,undefined,width,height),'OBSERVATION_ACCOUNT_CHANGED');
}
for(const [width,height,expected] of [[0,0,false],[0,40,false],[40,0,false],[320,180,true]]){
  const invoke=runInNewContext(`(${hasVisibleSecurityComponent.toString()})`,context('',true,undefined,width,height));
  assert.equal(invoke(['.security']),expected);checked++;
}
const dmEvent={channel:'DIRECT_MESSAGE',direction:'INCOMING',kind:'DM',actorId:'peer',conversationId:'chat',platformEventId:'message',occurredAt:'synthetic'},
  commentEvent={...dmEvent,channel:'COMMENT_NOTIFICATION',kind:'COMMENT',videoId:'work'},replyMapping={observation:mapping,blockers:'.dialog'};
for(const [fn,input] of [[captureDmReply,{mapping:replyMapping,event:dmEvent,action:'snapshot'}],
  [captureCommentReply,{mapping:replyMapping,event:commentEvent,action:'snapshot'}],
  [inspectMessageShare,{mapping,event:dmEvent,peer:mapping.peers[0]}],[visibleStoredMessage,{mapping,event:dmEvent,peer:mapping.peers[0]}]])
  rejects(fn,input,context('',true),'OBSERVATION_SECURITY_SUSPECT');
await assert.rejects(runInNewContext(`(${inspectMessageImage.toString()})`,context('',true))({mapping,event:dmEvent,imageIndex:0,peer:mapping.peers[0]}),
  error=>error?.message.startsWith('OBSERVATION_SECURITY_SUSPECT INBORA_SECURITY_SIGNAL:'));checked++;
rejects(captureAndGuard,{mapping:{...mapping,targets:{DIRECT_MESSAGE:{}},guards:{challenge:'.security',loginRequired:'.none',stopped:'.none'}},
  event:dmEvent,channel:'DIRECT_MESSAGE'},context('',true),'CLICK_DOM_GUARD_BLOCKED');
const inspect=runInNewContext(`(${inspectSecuritySignal.toString()})`,context('',true));
assert.equal(inspect({selectors:['.security']}).state,'SUSPECT');checked++;
for(const [origin,empty] of [['https://www.douyin.com',true],['https://example.invalid',false]]){
  const environment=context('',false,origin),invoke=runInNewContext(`(${inspectRecoveryNavigation.toString()})`,environment);
  const result=invoke('https://www.douyin.com');assert.equal(result.originMatches,empty);assert.equal(result.empty,empty);checked++;
}
let documentStartedAt=100_000,documentNow=120_000;
const documentUrl='https://www.douyin.com/video/work';
const documentPage={evaluate:async fn=>runInNewContext(`(${fn.toString()})()`,{
  location:{href:documentUrl},performance:{timeOrigin:documentStartedAt},Date:{now:()=>documentNow},
})};
async function fresh(expected,url=documentUrl,age=30_000){
  assert.equal(await claimFreshCommentDocument(documentPage,url,age),expected);checked++;
}
await fresh(true);await fresh(false);
documentStartedAt=110_000;await markCommentDocumentRead(documentPage);await fresh(false);
documentStartedAt=115_000;await fresh(false,'https://www.douyin.com/video/other');await fresh(true);
documentStartedAt=116_000;documentNow=150_000;await fresh(false);
documentNow=120_000;await fresh(true);await fresh(false);
console.log(`${source?'tsx source':'built Node'} serialized emergency guards passed: ${checked} checks; no browser, runtime or Profile accessed`);
