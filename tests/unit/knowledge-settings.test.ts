import {beforeEach,expect,test,vi} from 'vitest';
import {createElement,type ReactElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {KnowledgeOverview} from '../../src/knowledge/contracts.js';
import {request} from '../../desktop/src/api.js';
import {describeKnowledgeError,type ImportPreview} from '../../desktop/src/knowledge-client.js';

vi.mock('../../desktop/src/api.js',()=>({request:vi.fn()}));
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
beforeEach(()=>{vi.mocked(request).mockReset();perform.mockReset();});

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
