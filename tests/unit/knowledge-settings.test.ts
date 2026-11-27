import {beforeEach,expect,test,vi} from 'vitest';
import {createElement,type ReactElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {KnowledgeOverview} from '../../src/knowledge/contracts.js';
import {request,desktopInfo} from '../../desktop/src/api.js';
import {describeKnowledgeError,knowledgeRequest,type ImportPreview} from '../../desktop/src/knowledge-client.js';

vi.mock('../../desktop/src/api.js',()=>({request:vi.fn(),desktopInfo:vi.fn()}));
const overview:KnowledgeOverview={available:true,sources:[],knowledge:[],samples:[],personas:[],activePersonaId:null,activePersona:null,
  totals:{sources:0,knowledge:0,samples:0,accepted:0,holdout:0,personas:0},learningTasks:[],page:0,pageSize:50};
const perform=vi.fn();
const props={overview,busy:false,perform};
type Panel=(value:typeof props)=>ReactElement;
const documentsPath='../../desktop/src/KnowledgeDocuments.tsx',samplesPath='../../desktop/src/KnowledgeSamples.tsx';
const personaPath='../../desktop/src/KnowledgePersona.tsx',trialPath='../../desktop/src/KnowledgeTrial.tsx',importPath='../../desktop/src/KnowledgeImport.tsx';
const {KnowledgeDocuments}=await import(documentsPath) as {KnowledgeDocuments:Panel};
const {KnowledgeSamples}=await import(samplesPath) as {KnowledgeSamples:Panel};
const {KnowledgePersona}=await import(personaPath) as {KnowledgePersona:Panel};
const {KnowledgeTrial}=await import(trialPath) as {KnowledgeTrial:Panel};
const {uploadKnowledgeFile}=await import(importPath) as {uploadKnowledgeFile:(file:File,kind:'KNOWLEDGE'|'CHAT')=>Promise<ImportPreview>};
beforeEach(()=>{vi.mocked(request).mockReset();vi.mocked(desktopInfo).mockReset();perform.mockReset();});

test.each([undefined,{replyKnowledge:false}])('overview blocks an outdated native window before requesting private data (%j)',async features=>{
  const info={runtime:'synthetic',version:'0.3.5',...(features?{features}:{})};vi.mocked(desktopInfo).mockResolvedValue(info);
  vi.mocked(request).mockResolvedValue(overview);
  await expect(knowledgeRequest({action:'overview'})).rejects.toThrow('KNOWLEDGE_NATIVE_UPDATE_REQUIRED');
  expect(request).not.toHaveBeenCalled();
  const message=describeKnowledgeError('KNOWLEDGE_NATIVE_UPDATE_REQUIRED');
  expect(message).toContain('当前窗口尚未加载知识与人格功能');expect(message).toContain('启动inbora.cmd');
  expect(message).toContain('无需重新填写运行目录');expect(message).not.toContain('必填项');
});

test('overview rereads native capabilities and permits only a supported window',async()=>{
  const legacy={runtime:'synthetic',version:'0.3.5'},updated={...legacy,features:{replyKnowledge:true}};
  vi.mocked(desktopInfo).mockResolvedValueOnce(legacy).mockResolvedValueOnce(updated);
  vi.mocked(request).mockResolvedValue(overview);
  await expect(knowledgeRequest({action:'overview'})).rejects.toThrow('KNOWLEDGE_NATIVE_UPDATE_REQUIRED');
  vi.mocked(request).mockResolvedValue(overview);
  await expect(knowledgeRequest({action:'overview',page:1})).resolves.toEqual(overview);
  expect(desktopInfo).toHaveBeenCalledTimes(2);expect(request).toHaveBeenCalledExactlyOnceWith({command:'replyKnowledge',action:'overview',page:1});
  expect(describeKnowledgeError('INVALID_COMMAND')).toContain('输入格式不符合要求');
});

test('knowledge and sample forms explain publication, local imports, speaker mapping and source boundaries',()=>{
  const documents=renderToStaticMarkup(createElement(KnowledgeDocuments,props));
  expect(documents).toContain('新增或编辑后保存为停用条目');expect(documents).toContain('知识正文');
  expect(documents).toContain('.txt,.md,.docx,.pdf,.csv,.xlsx');expect(documents).toContain('20 MiB');
  const samples=renderToStaticMarkup(createElement(KnowledgeSamples,props));
  expect(samples).toContain('从 Inbora 收集候选');expect(samples).toContain('发言人: 正文');
  expect(samples).toContain('.txt,.csv,.json,.jsonl');expect(samples).toContain('留出样本仅用于评估');
  expect(samples).not.toContain('send-once');
});

test('learning and trial require explicit model use and offer no sending or browser action',()=>{
  const persona=renderToStaticMarkup(createElement(KnowledgePersona,props));
  expect(persona).toContain('必要的已采纳样本片段发送给当前模型');
  expect(persona).toMatch(/<button disabled="">从已采纳样本学习<\/button>/u);
  expect(persona).toContain('发布此人格');expect(persona).toContain('尚未发布，沿用已有账号人设');
  const trial=renderToStaticMarkup(createElement(KnowledgeTrial,props));
  expect(trial).toContain('不操作网页、不创建发送意图');expect(trial).toContain('对比将计入两次模型额度');
  expect(trial).toMatch(/<button class="primary" type="submit" disabled="">生成试聊回复<\/button>/u);
  expect(trial).not.toContain('>发送<');expect(trial).not.toContain('openTarget');
});

test('existing AI and unknown sample origins remain distinguishable from human and holdout status',()=>{
  const sample={id:'sample',sourceId:'source',channel:'DIRECT_MESSAGE' as const,prompt:'你们怎么称呼客户？',response:'按你喜欢的称呼来。',source:'AI_ASSISTED_APPROVED' as const,
    sourceRef:'private-platform-id',group:'private-conversation-id',accepted:false,excluded:false,holdout:true,reason:null,createdAt:0};
  const rendered=renderToStaticMarkup(createElement(KnowledgeSamples,{...props,overview:{...overview,samples:[sample]}}));
  expect(rendered).toContain('AI辅助后确认');expect(rendered).toContain('待选择 · 留出评估');
  expect(rendered).not.toContain('private-platform-id');expect(rendered).not.toContain('private-conversation-id');
});

test('upload sends exact bytes in sequential 48 KiB chunks and only finishes into a preview',async()=>{
  const preview:ImportPreview={id:'upload',name:'合成聊天.txt',kind:'CHAT',textPreview:'本人: 合成回复',columns:['speaker','text'],rows:[],totalRows:1,warnings:[]};
  const bytes=Uint8Array.from({length:100_000},(_,index)=>index%251);
  vi.mocked(request).mockImplementation(async body=>body.command==='replyKnowledge'&&body.action==='importStart'?{id:'upload'}:
    body.command==='replyKnowledge'&&body.action==='importFinish'?preview:{});
  const result=await uploadKnowledgeFile(new File([bytes],'合成聊天.txt'),'CHAT');expect(result).toEqual(preview);
  const commands=vi.mocked(request).mock.calls.map(([body])=>body).filter(body=>body.command==='replyKnowledge');
  expect(commands.map(body=>body.action)).toEqual(['importStart','importChunk','importChunk','importChunk','importFinish']);
  const chunks=commands.filter(body=>body.action==='importChunk');
  expect(chunks.map(body=>body.index)).toEqual([0,1,2]);
  const restored=Buffer.concat(chunks.map(body=>Buffer.from(body.data,'base64')));
  expect(restored.equals(Buffer.from(bytes))).toBe(true);expect(chunks.map(body=>Buffer.from(body.data,'base64').length)).toEqual([49_152,49_152,1696]);
});

test('upload failure cancels its temporary upload once and never retries or commits',async()=>{
  vi.mocked(request).mockImplementation(async body=>{
    if(body.command!=='replyKnowledge')return {};
    if(body.action==='importStart')return {id:'failed-upload'};
    if(body.action==='importChunk')throw new Error('synthetic failure');return {};
  });
  await expect(uploadKnowledgeFile(new File(['本人: 合成回复'],'聊天.txt'),'CHAT')).rejects.toThrow('synthetic failure');
  const bodies=vi.mocked(request).mock.calls.map(([body])=>body).filter(body=>body.command==='replyKnowledge');
  expect(bodies.map(body=>body.action)).toEqual(['importStart','importChunk','importCancel']);
});

test('oversize file is rejected before any backend request and private exceptions are not exposed',async()=>{
  const file=new File(['synthetic'],'large.txt');Object.defineProperty(file,'size',{value:20*1024*1024+1});
  await expect(uploadKnowledgeFile(file,'KNOWLEDGE')).rejects.toThrow('KNOWLEDGE_IMPORT_TOO_LARGE');expect(request).not.toHaveBeenCalled();
  expect(describeKnowledgeError(new Error('D:\\private\\database.sqlite: private body'))).not.toContain('private');
});

test('interrupted analyses offer explicit continuation and known failures give actionable private-safe guidance',()=>{
  const rendered=renderToStaticMarkup(createElement(KnowledgePersona,{...props,overview:{...overview,
    learningTasks:[{id:'task-private-id',state:'FAILED',personaId:null,completed:2}]}}));
  expect(rendered).toContain('继续上次分析');expect(rendered).toContain('已完成 2 个步骤');
  expect(rendered).not.toContain('task-private-id');expect(rendered).toContain('每次最多200组、6次模型调用');
  expect(describeKnowledgeError('PERSONA_TASK_SELECTION_CHANGED')).toContain('重新学习');
  expect(describeKnowledgeError('MODEL_GRANT_EXHAUSTED')).toContain('剩余模型额度不足');
  expect(describeKnowledgeError('KNOWLEDGE_ACCOUNT_REQUIRED')).toContain('本人账号');
  expect(describeKnowledgeError('KNOWLEDGE_MAPPING_PREVIEW_REQUIRED')).toContain('重新预览问答配对');
  expect(describeKnowledgeError('KNOWLEDGE_PARSE_FAILED')).toContain('加密');
});

test('retrieval debugger state drops stale responses across scope changes and keeps latest embedding status badge',async()=>{
  const debuggerPath='../../desktop/src/KnowledgeRetrievalDebugger.tsx';
  const mod=await import(debuggerPath) as {
    buildDebuggerScopeKey:(channel:'DIRECT_MESSAGE'|'COMMENT_NOTIFICATION',sourceIds:readonly string[])=>string;
    createInitialDebuggerState:(scopeKey:string)=>{
      scopeKey:string;debugSeq:number;statusEpoch:number;appliedStatusEpoch:number;
      debugResult:unknown;embeddingStatus:unknown;error:string;
    };
    invalidateDebuggerScope:(prev:any,nextScopeKey:string)=>any;
    applyDebugResponse:(current:any,req:{seq:number;scopeKey:string;statusEpoch:number},response:any)=>any;
    applyEmbeddingStatusResponse:(current:any,reqEpoch:number,status:any)=>any;
    resolveLatestEmbeddingStatus:(state:any)=>any;
    describeEmbeddingBadge:(status:any)=>{label:string;tone:string};
  };

  const dmScope=mod.buildDebuggerScopeKey('DIRECT_MESSAGE',[]);
  const commentScope=mod.buildDebuggerScopeKey('COMMENT_NOTIFICATION',[]);
  const oldStatus={
    state:'MISSING_NEEDS_DOWNLOAD',engineMode:'FTS5_ENHANCED',modelId:'m',modelPath:null,
    expectedSha256:null,actualSha256:null,sizeBytes:null,dims:512,checkedPaths:[],reason:'MISSING',checkedAt:1,
  };
  const freshStatus={
    state:'REUSED_LOCAL',engineMode:'HYBRID_ONNX',modelId:'m',modelPath:null,
    expectedSha256:null,actualSha256:null,sizeBytes:1024,dims:512,checkedPaths:[],reason:'OK',checkedAt:2,
  };
  const makeDebug=(channel:'DIRECT_MESSAGE'|'COMMENT_NOTIFICATION',onnxStatus:unknown)=>({
    engineMode:'FTS5_ENHANCED',query:'快递',channel,queryTerms:['快递'],wordTerms:['快递'],
    filteredStopTerms:[],minScore:0.25,hits:[],rejectedBelowThreshold:[],conflicts:[],exactFaqHit:null,onnxStatus,
  });

  // 1. In-flight preview on DM is discarded after switching channel to COMMENT_NOTIFICATION.
  let state=mod.createInitialDebuggerState(dmScope);
  const req1={seq:1,scopeKey:dmScope,statusEpoch:1};
  state={...state,debugSeq:1,statusEpoch:1};
  state=mod.invalidateDebuggerScope(state,commentScope);
  const afterStale=mod.applyDebugResponse(state,req1,makeDebug('DIRECT_MESSAGE',oldStatus));
  expect(afterStale.debugResult).toBeNull();
  expect(afterStale.scopeKey).toBe(commentScope);

  // 2. Manual "检查索引状态" refresh overrides older debugResult.onnxStatus and stays visible in badge.
  const req2={seq:state.debugSeq+1,scopeKey:commentScope,statusEpoch:state.statusEpoch+1};
  state={...state,debugSeq:req2.seq,statusEpoch:req2.statusEpoch};
  state=mod.applyDebugResponse(state,req2,makeDebug('COMMENT_NOTIFICATION',oldStatus));
  expect(mod.resolveLatestEmbeddingStatus(state)?.state).toBe('MISSING_NEEDS_DOWNLOAD');

  const statusReqEpoch=state.statusEpoch+1;
  state={...state,statusEpoch:statusReqEpoch};
  state=mod.applyEmbeddingStatusResponse(state,statusReqEpoch,freshStatus);
  expect(mod.resolveLatestEmbeddingStatus(state)?.state).toBe('REUSED_LOCAL');
  expect(mod.describeEmbeddingBadge(mod.resolveLatestEmbeddingStatus(state)).tone).toBe('success');

  // 3. Stale older embeddingStatus response cannot overwrite the newer status.
  const afterOlderStatus=mod.applyEmbeddingStatusResponse(state,1,oldStatus);
  expect(mod.resolveLatestEmbeddingStatus(afterOlderStatus)?.state).toBe('REUSED_LOCAL');
});
