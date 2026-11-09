import {afterEach,expect,test,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import type {Page} from 'playwright';
import {ObservedCommentReply} from '../../src/adapters/observed-comment-reply.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {CommentResponses} from '../../src/adapters/comment-responses.js';
import {commentReadbackAudit,type CommentReadbackDiagnostic} from '../../src/adapters/comment-readback-diagnostics.js';
import {commentReplyMapping} from '../fixtures/observed-site.js';
import {candidate} from '../helpers.js';

afterEach(()=>vi.restoreAllMocks());
const event=candidate({channel:'COMMENT_NOTIFICATION',kind:'REPLY',platformEventId:'21',commentId:'21',videoId:'10',rootCommentId:'11',replyToCommentId:'21',conversationId:null});
function fixture(proofs:unknown[]=[],submission=false,timeout=20,throwCallback=false){
  const page=new EventEmitter() as EventEmitter&{mainFrame:()=>unknown;url:()=>string;evaluate:ReturnType<typeof vi.fn>},frame={};
  page.mainFrame=()=>frame;page.url=()=> 'http://127.0.0.1:1/video/10';
  page.evaluate=vi.fn(async()=>({context:[],proofs,ids:[],editorText:'',shape:'',readbackCounts:{visibleChildren:2,strongChildren:2,ownChildren:1,proofs:proofs.length}}));
  const reports:CommentReadbackDiagnostic[]=[];
  const mapping={...commentReplyMapping('http://127.0.0.1:1'),submissionReceipts:submission};
  vi.spyOn(ObservedReader.prototype,'comments').mockResolvedValue({events:[],loaded:0,unsupported:0,evidenceId:'fixture'});
  const adapter=new ObservedCommentReply(page as unknown as Page,mapping,timeout,{onReadbackDiagnostic:report=>{
    reports.push(report);if(throwCallback)throw Error('PRIVATE_CALLBACK_EXCEPTION');}});
  return{page,frame,reports,adapter,mapping};
}

test('a missing native submission acknowledgment is distinguished without a new page action',async()=>{
  const f=fixture([],true);try{
    expect(await f.adapter.readback(event,'PRIVATE_APPROVED_BODY',[],new Date().toISOString())).toBeNull();
    expect(f.reports).toMatchObject([{stage:'ACK',reason:'NO_ACK',submissionEnabled:true,requestCount:0,acknowledged:false}]);
    expect(f.page.evaluate).not.toHaveBeenCalled();
  }finally{f.adapter.dispose();}
});

test('strict time filtering is reported separately from empty DOM and never becomes a receipt',async()=>{
  const boundary=new Date(Date.now()-1000).toISOString(),proof={id:'901',ownId:'100',targetKey:'comment:10:21',text:'PRIVATE_APPROVED_BODY',pending:false,sentAt:boundary};
  const f=fixture([proof]);try{
    expect(await f.adapter.verifyExisting(event,proof.text,boundary)).toBeNull();
    expect(f.reports.at(-1)).toMatchObject({stage:'VERIFY_EXISTING',reason:'FILTERED',dom:{ownChildren:1,proofs:1},poll:{rawProofs:1,sameText:1,afterBoundary:0,eligibleProofs:0}});
  }finally{f.adapter.dispose();}
});

test('stable complete proofs are unchanged even when the diagnostic callback rejects',async()=>{
  const boundary=new Date(Date.now()-2000).toISOString(),proof={id:'901',ownId:'100',targetKey:'comment:10:21',text:'PRIVATE_APPROVED_BODY',pending:false,sentAt:new Date(Date.now()-1000).toISOString()};
  const f=fixture([proof],false,200,true);try{
    expect(await f.adapter.verifyExisting(event,proof.text,boundary)).toEqual(proof);
    expect(f.reports.at(-1)).toMatchObject({reason:'VERIFIED',poll:{stableSnapshots:2,eligibleProofs:1}});
  }finally{f.adapter.dispose();}
});

test('a context guard still throws its original error and only a fixed diagnostic enum is recorded',async()=>{
  const f=fixture();try{
    f.page.evaluate.mockResolvedValueOnce({context:[],proofs:[],ids:[],editorText:'',shape:''})
      .mockRejectedValueOnce(Error('COMMENT_REPLY_CONTEXT_UNVERIFIED'));
    await expect(f.adapter.verifyExisting(event,'PRIVATE_APPROVED_BODY',new Date().toISOString())).rejects.toThrow('COMMENT_REPLY_CONTEXT_UNVERIFIED');
    expect(f.reports.at(-1)).toMatchObject({stage:'VERIFY_EXISTING',reason:'GUARD_ERROR',guardCode:'COMMENT_REPLY_CONTEXT_UNVERIFIED'});
    expect(commentReadbackAudit(f.reports.at(-1)!).guardFailure).toBe('CONTEXT_UNVERIFIED');
  }finally{f.adapter.dispose();}
});

test.each(['ACCEPTED','SCHEMA','ROOT','SERVICE_WORKER'] as const)('only already observed normal replies populate the bounded response diagnostic: %s',async mode=>{
  const f=fixture(),responses=new CommentResponses(f.page as unknown as Page,f.mapping);responses.watch(event);
  try{
    const request={method:()=> 'GET',frame:()=>f.frame,url:()=> 'http://127.0.0.1:1/aweme/v1/web/comment/list/reply/?comment_id=11'};
    const row={cid:'901',aweme_id:'10',reply_id:mode==='ROOT'?'12':'11',reply_to_reply_id:'21',text:'PRIVATE_RESPONSE_BODY',status:1,create_time:Date.now()/1000,user:{uid:'100',sec_uid:'PRIVATE_SEC'}};
    f.page.emit('request',request);f.page.emit('response',{request:()=>request,status:()=>200,fromServiceWorker:()=>mode==='SERVICE_WORKER',headers:()=>({}),
      text:async()=>JSON.stringify({status_code:0,comments:[mode==='SCHEMA'?{...row,cid:null}:row]})});
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(responses.diagnostics()).toMatchObject({requests:1,responses:1,accepted:mode==='ACCEPTED'?1:0,rows:mode==='ACCEPTED'?1:0,stage:mode});
    expect(JSON.stringify(responses.diagnostics())).not.toMatch(/PRIVATE_|901|reply|http|\/video\//i);
  }finally{responses.dispose();f.adapter.dispose();}
});

test('the audit allowlist removes private properties and raw failures while bounding numeric counts',()=>{
  const raw={stage:'POLL',reason:'FILTERED',submissionEnabled:false,submissionFailure:'PRIVATE_EXCEPTION_BODY',requestCount:20000,
    responses:{requests:1,responses:1,accepted:0,rows:0,stage:'SCHEMA'},dom:{ownChildren:1,proofs:0,rawText:'PRIVATE_DOM_BODY'},poll:{snapshots:3},
    rawUrl:'https://PRIVATE_URL',rawId:'PRIVATE_NATIVE_ID',guardCode:'PRIVATE_GUARD_EXCEPTION'} as unknown as CommentReadbackDiagnostic;
  const value=commentReadbackAudit(raw);
  expect(value).toMatchObject({stage:'POLL',reason:'FILTERED',submissionFailure:'OTHER',guardFailure:'OTHER',responseStage:'SCHEMA',counts:{requestCount:10000,dom_ownChildren:1,dom_proofs:0}});
  expect(JSON.stringify(value)).not.toMatch(/PRIVATE_|https:|rawText|rawUrl|rawId/);
});
