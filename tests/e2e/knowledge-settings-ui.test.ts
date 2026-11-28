import {expect,test} from 'vitest';
import {createServer,type Plugin} from 'vite';
import {chromium} from 'playwright';
import {resolve} from 'node:path';
import {mkdir} from 'node:fs/promises';
import type {KnowledgeOverview,PersonaVersion} from '../../src/knowledge/contracts.js';
import type {KnowledgeCommand} from '../../src/knowledge/commands.js';

function fixturePlugin():Plugin {
  const entry='\0knowledge-ui-fixture';
  return {name:'synthetic-knowledge-ui',resolveId:id=>id==='/knowledge-ui-entry.ts'?entry:undefined,
    load:id=>id===entry?`import React from 'react';import {createRoot} from 'react-dom/client';
      import {KnowledgeSettings} from '/src/KnowledgeSettings.tsx';import '/src/styles/globals.css';
      createRoot(document.getElementById('root')).render(React.createElement('main',{className:'settings settings-compact'},
        React.createElement(KnowledgeSettings,{accountId:'account_001'})));`:undefined,
    configureServer(server){server.middlewares.use(async(req,res,next)=>{
      if(req.url?.split('?')[0]!=='/knowledge-ui-fixture')return next();
      res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/knowledge-ui-fixture',
        '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>合成知识与人格界面</title><div id="root"></div><script type="module" src="/knowledge-ui-entry.ts"></script></html>'));
    });}};
}

const initial=():KnowledgeOverview=>({available:true,sources:[{id:'source',title:'合成知识来源',kind:'MANUAL',createdAt:0}],knowledge:[],
  samples:[{id:'sample',sourceId:'chat',channel:'DIRECT_MESSAGE',prompt:'怎样挑选尺码？',response:'把平时穿的尺码告诉我，我帮你看看。',
    source:'HUMAN_TYPED',sourceRef:'private-reference',group:'private-group',accepted:false,excluded:false,holdout:false,reason:null,createdAt:0}],
  personas:[],activePersonaId:null,activePersona:null,learningTasks:[{id:'interrupted-task',state:'FAILED',personaId:null,completed:1}],
  totals:{sources:1,knowledge:0,samples:1,accepted:0,holdout:0,personas:0},page:0,pageSize:50});

test('four knowledge tabs support drafts, explicit imports, interrupted learning and a send-free comparison',async()=>{
  const overview=initial(),calls:KnowledgeCommand[]=[],errors:string[]=[];
  const server=await createServer({configFile:resolve('desktop/vite.config.ts'),plugins:[fixturePlugin()],
    server:{port:0,strictPort:false},logLevel:'error'});await server.listen();
  const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1240,height:800}});
  page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
  let failResume=true;
  await page.exposeFunction('fixtureInvoke',async(native:string,args:{body:KnowledgeCommand})=>{
    if(native==='desktop_info')return{runtime:'synthetic',version:'0.3.5',features:{replyKnowledge:true}};
    if(native!=='client_request')throw new Error('UNEXPECTED_NATIVE_COMMAND');const body=args.body;calls.push(body);
    if(body.command!=='replyKnowledge')throw new Error('UNEXPECTED_BUSINESS_COMMAND');
    switch(body.action){
      case 'overview':overview.page=body.page??overview.page;return structuredClone(overview);
      case 'embeddingStatus':return{state:'FALLBACK_FTS5',engineMode:'FTS5_ENHANCED',modelId:'bge-small-zh-v1.5-q8',modelPath:null,expectedSha256:null,actualSha256:null,sizeBytes:null,dims:512,checkedPaths:[],reason:'ONNX_MANAGER_NOT_CONFIGURED',checkedAt:0};
      case 'listFaqSuggestions':return{items:[]};
      case 'saveKnowledge':overview.knowledge=[{...body.input,id:'entry',sourceId:'source',state:'DISABLED',version:1,
        effectiveAt:null,expiresAt:null,updatedAt:0}];overview.totals.knowledge=1;return overview.knowledge[0];
      case 'setKnowledgeState':overview.knowledge[0]!.state=body.state;return overview.knowledge[0];
      case 'selectSamples':for(const sample of overview.samples)if(body.ids.includes(sample.id)){
        sample.accepted=body.accepted;sample.excluded=!body.accepted;sample.reason=body.accepted?null:'USER_EXCLUDED';}
        overview.totals.accepted=overview.samples.filter(sample=>sample.accepted).length;return{};
      case 'importStart':return{id:'upload'};
      case 'importChunk':return{received:1};
      case 'importFinish':return{id:'upload',name:'合成聊天.csv',kind:'CHAT',textPreview:'来信者: 你好\n本人: 你好呀',
        columns:['speaker','text'],rows:[{speaker:'来信者',text:'你好'},{speaker:'本人',text:'你好呀'}],totalRows:2,warnings:[]};
      case 'importPreviewMapping':return{pairs:[{prompt:'你好',response:'你好呀'}],total:1};
      case 'importCommit':return{sourceId:'imported',samples:1};
      case 'importCancel':return{cancelled:true};
      case 'analyze':{
        if(body.taskId&&failResume){failResume=false;throw new Error('PERSONA_TASK_SELECTION_CHANGED');}
        const persona:PersonaVersion={id:'draft-persona',text:'称呼自然，先回答重点，再简短询问。',sampleIds:['sample'],state:'DRAFT',createdAt:0};
        overview.personas=[persona];return{taskId:'new-task',persona,calls:2,usedCount:1,omittedCount:0};
      }
      case 'savePersona':{const persona:PersonaVersion={id:'edited-persona',text:body.text,sampleIds:body.sampleIds,state:'DRAFT',createdAt:1};
        overview.personas.unshift(persona);return persona;}
      case 'publishPersona':{const persona=overview.personas.find(value=>value.id===body.id)!;persona.state='PUBLISHED';
        overview.activePersonaId=persona.id;overview.activePersona=persona;return persona;}
      case 'tryReply':return{current:{text:'你平时穿哪个尺码呀？我帮你看。',model:'synthetic-model',personaId:body.personaVersionId,fingerprint:'fixture'},
        comparison:{text:'请提供您平时的尺码。',model:'synthetic-model',personaId:null,fingerprint:'baseline'},
        currentContext:{knowledge:[{id:'entry',title:'合成尺码说明',version:1}],conflicts:[]}};
      default:throw new Error('UNEXPECTED_KNOWLEDGE_ACTION');
    }
  });
  await page.addInitScript(()=>{const bridge=window as unknown as {__TAURI_INTERNALS__:unknown;fixtureInvoke:(command:string,args:unknown)=>Promise<unknown>};
    bridge.__TAURI_INTERNALS__={invoke:(command:string,args:unknown)=>bridge.fixtureInvoke(command,args)};});
  const visible=()=>page.getByRole('tabpanel');
  const waitIdle=async()=>{await expect.poll(()=>page.getByRole('button',{name:'重新读取',exact:true}).isEnabled()).toBe(true);};
  try{
    await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}/knowledge-ui-fixture`);await waitIdle();
    expect(await page.getByRole('tab').count()).toBe(5);
    expect(await page.getByText('第 1 页',{exact:false}).count()).toBe(1);
    expect(await page.getByRole('button',{name:'上一页',exact:true}).isDisabled()).toBe(true);
    expect(await page.getByRole('button',{name:'下一页',exact:true}).isDisabled()).toBe(true);
    await page.getByRole('tab',{name:'知识库',exact:true}).focus();await page.keyboard.press('ArrowRight');
    expect(await page.getByRole('tab',{name:'聊天样本',exact:true}).getAttribute('aria-selected')).toBe('true');
    await page.getByRole('tab',{name:'知识库',exact:true}).click();
    await visible().getByLabel('知识标题',{exact:true}).fill('合成尺码说明');await visible().getByLabel('主题',{exact:true}).fill('尺码');
    await visible().getByLabel('知识正文',{exact:true}).fill('选择时参考已确认的尺码表。');
    await visible().getByLabel('关键词或别名（逗号或换行分隔）',{exact:true}).fill(Array.from({length:31},(_,index)=>`关键词${index}`).join(','));
    expect(await visible().getByRole('button',{name:'保存知识条目',exact:true}).isDisabled()).toBe(true);
    await visible().getByLabel('关键词或别名（逗号或换行分隔）',{exact:true}).fill('尺码,尺寸');
    await visible().getByRole('button',{name:'保存知识条目',exact:true}).click();await waitIdle();
    expect(await visible().getByText('已停用 · v1',{exact:true}).count()).toBe(1);
    await visible().getByRole('button',{name:'启用知识',exact:true}).click();await waitIdle();
    expect(await visible().getByText('已启用 · v1',{exact:true}).count()).toBe(1);

    await page.getByRole('tab',{name:'聊天样本',exact:true}).click();
    await visible().getByRole('button',{name:'选择本页',exact:true}).click();
    await visible().getByRole('button',{name:'采纳所选 1',exact:true}).click();await waitIdle();
    await visible().getByLabel('样本筛选',{exact:true}).selectOption('accepted');
    await visible().getByRole('button',{name:'选择本页',exact:true}).click();
    await visible().getByRole('button',{name:'排除所选',exact:true}).click();await waitIdle();
    await visible().getByLabel('样本筛选',{exact:true}).selectOption('excluded');
    expect(await visible().getByText('已由你排除，可重新选择并采纳',{exact:true}).count()).toBe(1);
    await visible().getByRole('button',{name:'选择本页',exact:true}).click();
    await visible().getByRole('button',{name:'采纳所选 1',exact:true}).click();await waitIdle();
    await visible().getByText('从文件导入聊天记录',{exact:true}).click();
    await visible().getByLabel('选择聊天文件',{exact:true}).setInputFiles({name:'合成聊天.csv',mimeType:'text/csv',buffer:Buffer.from('speaker,text\n来信者,你好\n本人,你好呀')});
    await visible().getByRole('button',{name:'解析并预览',exact:true}).click();await waitIdle();
    const commit=visible().getByRole('button',{name:'确认导入',exact:true});expect(await commit.isDisabled()).toBe(true);
    await visible().getByLabel('本人发言人名称',{exact:true}).fill('本人');
    await visible().getByRole('button',{name:'预览问答配对',exact:true}).click();await waitIdle();expect(await commit.isEnabled()).toBe(true);
    await visible().getByLabel('本人发言人名称',{exact:true}).fill('另一个本人');expect(await commit.isDisabled()).toBe(true);
    await visible().getByLabel('本人发言人名称',{exact:true}).fill('本人');
    await visible().getByRole('button',{name:'预览问答配对',exact:true}).click();await waitIdle();await commit.click();await waitIdle();
    expect(calls.filter(body=>body.action==='importCommit')).toHaveLength(1);

    await page.getByRole('tab',{name:'回复人格',exact:true}).click();
    const learn=visible().getByRole('button',{name:'从已采纳样本学习',exact:true});expect(await learn.isDisabled()).toBe(true);
    await visible().getByLabel('我同意将必要的已采纳样本片段',{exact:false}).check();
    await visible().getByText('未完成的分析',{exact:false}).click();
    await visible().getByRole('button',{name:'继续上次分析',exact:true}).click();await waitIdle();
    expect(await page.getByRole('alert').textContent()).toContain('重新学习');
    await learn.click();await waitIdle();expect(await visible().getByText('本次使用 1 组样本',{exact:false}).count()).toBe(1);
    await visible().getByLabel('人格内容',{exact:true}).fill('称呼自然，回答简短，避免生硬套话。');
    await visible().getByText('与当前人格的段落差异',{exact:true}).click();
    expect(await visible().getByText('新增：称呼自然，回答简短，避免生硬套话。',{exact:true}).count()).toBe(1);
    expect(await visible().getByRole('button',{name:'发布此人格',exact:true}).isDisabled()).toBe(true);
    await visible().getByRole('button',{name:'保存人格草稿',exact:true}).click();await waitIdle();
    await visible().getByRole('button',{name:'发布此人格',exact:true}).click();await waitIdle();

    await page.getByRole('tab',{name:'试聊',exact:true}).click();
    await visible().getByLabel('模拟来信',{exact:true}).fill('想买一件，怎么选尺码？');
    await visible().getByLabel('对比人格',{exact:true}).selectOption('baseline');
    expect(await visible().getByRole('button',{name:'生成试聊回复并对比',exact:true}).isDisabled()).toBe(true);
    await visible().getByLabel('我同意将这条模拟来信',{exact:false}).check();
    await visible().getByRole('button',{name:'生成试聊回复并对比',exact:true}).click();await waitIdle();
    expect(await visible().getByText('仅试聊，未发送',{exact:false}).count()).toBe(2);
    expect(await visible().getByText('本次回复依据',{exact:false}).count()).toBe(1);expect(await visible().getByText('合成尺码说明 · v1',{exact:true}).count()).toBe(1);
    const trial=calls.find(body=>body.action==='tryReply');expect(trial).toMatchObject({personaVersionId:'edited-persona',comparePersonaVersionId:null,confirmed:true});
    expect(calls.find(body=>body.action==='analyze'&&body.taskId)).toMatchObject({sampleIds:[],taskId:'interrupted-task',confirmed:true});
    for(const viewport of [{width:1240,height:800},{width:900,height:640},{width:640,height:640}]){
      await page.setViewportSize(viewport);
      for(const [index,name] of ['知识库','聊天样本','回复人格','试聊'].entries()){
        await page.getByRole('tab',{name,exact:true}).click();
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
        if(process.env['INBORA_KNOWLEDGE_UI_SCREENSHOTS']){
          const folder=resolve('.local/tests/knowledge-ui-evidence');await mkdir(folder,{recursive:true});
          await page.screenshot({path:resolve(folder,`panel-${index}-${viewport.width}.png`),fullPage:true});
        }
      }
    }
    overview.totals.personas=51;
    await page.getByRole('button',{name:'重新读取',exact:true}).click();await waitIdle();
    expect(await page.getByRole('button',{name:'下一页',exact:true}).isEnabled()).toBe(true);
    await page.getByRole('button',{name:'下一页',exact:true}).click();await waitIdle();
    expect(await page.getByText('第 2 页',{exact:false}).count()).toBe(1);
    expect(await page.getByRole('button',{name:'上一页',exact:true}).isEnabled()).toBe(true);
    await page.getByRole('button',{name:'上一页',exact:true}).click();await waitIdle();
    expect(await page.getByText('第 1 页',{exact:false}).count()).toBe(1);
    expect(errors).toEqual([]);expect(calls.every(body=>body.command==='replyKnowledge')).toBe(true);
  }finally{await browser.close();await server.close();}
},30_000);

test('an outdated native window explains the required restart and reloads forms when capability becomes available',async()=>{
  const server=await createServer({configFile:resolve('desktop/vite.config.ts'),plugins:[fixturePlugin()],
    server:{port:0,strictPort:false},logLevel:'error'});await server.listen();
  const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1240,height:800}});
  let supported=false;const calls:KnowledgeCommand[]=[],errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  page.setDefaultTimeout(5000);
  await page.exposeFunction('fixtureInvoke',async(native:string,args:{body:KnowledgeCommand})=>{
    if(native==='desktop_info')return{runtime:'synthetic',version:'0.3.5',...(supported?{features:{replyKnowledge:true}}:{})};
    if(native!=='client_request')throw new Error('UNEXPECTED_NATIVE_COMMAND');calls.push(args.body);
    if(!supported)throw new Error('INVALID_COMMAND');
    if(args.body.command!=='replyKnowledge')throw new Error('UNEXPECTED_BUSINESS_COMMAND');
    switch(args.body.action){
      case 'overview':return initial();
      case 'embeddingStatus':return{state:'FALLBACK_FTS5',engineMode:'FTS5_ENHANCED',modelId:'bge-small-zh-v1.5-q8',modelPath:null,expectedSha256:null,actualSha256:null,sizeBytes:null,dims:512,checkedPaths:[],reason:'ONNX_MANAGER_NOT_CONFIGURED',checkedAt:0};
      case 'listFaqSuggestions':return{items:[]};
      default:throw new Error('UNEXPECTED_BUSINESS_COMMAND');
    }
  });
  await page.addInitScript(()=>{const bridge=window as unknown as {__TAURI_INTERNALS__:unknown;fixtureInvoke:(command:string,args:unknown)=>Promise<unknown>};
    bridge.__TAURI_INTERNALS__={invoke:(command:string,args:unknown)=>bridge.fixtureInvoke(command,args)};});
  try{
    await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}/knowledge-ui-fixture`);
    await expect.poll(()=>page.getByRole('alert').textContent()).toContain('当前窗口尚未加载知识与人格功能');
    expect(await page.getByRole('alert').textContent()).toContain('启动inbora.cmd');
    expect(await page.getByRole('alert').textContent()).not.toContain('必填项');expect(calls).toEqual([]);
    expect(await page.getByLabel('知识正文',{exact:true}).count()).toBe(0);
    supported=true;await page.getByRole('button',{name:'重新读取',exact:true}).click();
    await expect.poll(()=>page.getByLabel('知识正文',{exact:true}).isVisible()).toBe(true);
    await expect.poll(()=>calls.length).toBe(3);
    expect(await page.getByRole('alert').count()).toBe(0);
    expect(calls).toEqual(expect.arrayContaining([
      {command:'replyKnowledge',action:'overview',page:0},
      {command:'replyKnowledge',action:'embeddingStatus'},
      {command:'replyKnowledge',action:'listFaqSuggestions',status:'PENDING'},
    ]));
    expect(errors).toEqual([]);
  }finally{await browser.close();await server.close();}
},20_000);
