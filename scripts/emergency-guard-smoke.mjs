import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Exercise browser-serialized functions under both actual project compilation chains.
const source=process.argv[2]==='source',root=source?'src':'dist',extension=source?'ts':'js';
const load=name=>import(pathToFileURL(resolve(root,`adapters/${name}.${extension}`)).href);
const {captureObserved}=await load('observed-capture');
const {captureCommentThread}=await load('comment-thread-capture');
function context(title='',visibleBlocker=false,origin='https://www.douyin.com'){
  const blocker={isConnected:true,parentElement:null,getClientRects:()=>[{}]};
  return {location:{origin,href:origin+'/video/work'},document:{title,
    querySelectorAll:selector=>selector==='.security'&&visibleBlocker?[blocker]:[]},
    getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1'})};
}
const mapping={origin:'https://www.douyin.com',securityBlockers:'.security',
  works:[{id:'work',url:'https://www.douyin.com/video/work'}],selectors:{selfAvatar:'.self'}};
const observed={mapping,channel:'identity',index:0,evidenceId:'synthetic-only'};
const thread={mapping,event:{videoId:'work'},action:'inspect',offset:0};
let checked=0;
function rejects(fn,input,environment,code){
  const invoke=runInNewContext(`(${fn.toString()})`,environment);
  assert.throws(()=>invoke(input),error=>error?.message===code);checked++;
}
rejects(captureObserved,observed,context('',false,'https://example.invalid'),'OBSERVATION_UNEXPECTED_ORIGIN');
for(const title of ['验证码','安全验证','访问受限'])for(const [fn,input] of [[captureObserved,observed],[captureCommentThread,thread]])
  rejects(fn,input,context(title,true),'OBSERVATION_SECURITY_TITLE');
for(const [fn,input] of [[captureObserved,observed],[captureCommentThread,thread]])
  rejects(fn,input,context('',true),'OBSERVATION_SECURITY_COMPONENT');
rejects(captureObserved,observed,context(),'OBSERVATION_ACCOUNT_AVATAR_DOM_NOT_READY');
rejects(captureCommentThread,thread,context(),'OBSERVATION_ACCOUNT_CHANGED');
console.log(`${source?'tsx source':'built Node'} serialized emergency guards passed: ${checked} checks; no browser, runtime or Profile accessed`);
