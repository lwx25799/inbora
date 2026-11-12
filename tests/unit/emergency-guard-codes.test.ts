import {afterEach,expect,test,vi} from 'vitest';
import {captureObserved,type CaptureInput} from '../../src/adapters/observed-capture.js';
import {captureCommentThread,type CommentThreadInput} from '../../src/adapters/comment-thread-capture.js';
import {platformStopCodes} from '../../src/core/emergency-stop.js';

afterEach(()=>vi.unstubAllGlobals());
function setup(title='',visibleBlocker=false,origin='https://www.douyin.com'){
  const blocker={isConnected:true,parentElement:null,getClientRects:()=>[{}]};
  vi.stubGlobal('location',{origin,href:origin+'/video/work'});
  vi.stubGlobal('document',{title,querySelectorAll:(selector:string)=>selector==='.security'&&visibleBlocker?[blocker]:[]});
  vi.stubGlobal('getComputedStyle',()=>({visibility:'visible',display:'block',opacity:'1'}));
  const mapping={origin:'https://www.douyin.com',securityBlockers:'.security',works:[{id:'work',url:'https://www.douyin.com/video/work'}],
    selectors:{selfAvatar:'.self'}} as CaptureInput['mapping'];
  const observed=()=>captureObserved({mapping,channel:'identity',index:0,evidenceId:'synthetic-only'});
  const thread=()=>captureCommentThread({mapping,event:{videoId:'work'},action:'inspect',offset:0} as CommentThreadInput);
  return {observed,thread};
}

test('unexpected origin has its own fixed stop reason, independent of the page title',()=>{
  const {observed}=setup('验证码',true,'https://example.invalid');
  expect(observed).toThrow('OBSERVATION_UNEXPECTED_ORIGIN');
  expect(platformStopCodes).toContain('OBSERVATION_UNEXPECTED_ORIGIN');
});

test.each(['验证码','安全验证','访问受限'])('the %s safety title is distinguished on normal reading and comment-thread checks',title=>{
  const {observed,thread}=setup(title,true);
  expect(observed).toThrow('OBSERVATION_SECURITY_TITLE');expect(thread).toThrow('OBSERVATION_SECURITY_TITLE');
  expect(platformStopCodes).toContain('OBSERVATION_SECURITY_TITLE');
});

test('a visible mapped safety component is distinguished from title and origin failures',()=>{
  const {observed,thread}=setup('',true);
  expect(observed).toThrow('OBSERVATION_SECURITY_COMPONENT');expect(thread).toThrow('OBSERVATION_SECURITY_COMPONENT');
  expect(platformStopCodes).toContain('OBSERVATION_SECURITY_COMPONENT');
});

test('a normal page passes the safety gates and continues to the independent identity gate',()=>{
  const {observed,thread}=setup();
  expect(observed).toThrow('OBSERVATION_ACCOUNT_AVATAR_DOM_NOT_READY');
  expect(thread).toThrow('OBSERVATION_ACCOUNT_CHANGED');
});
