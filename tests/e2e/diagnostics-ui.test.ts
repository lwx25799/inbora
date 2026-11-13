import {expect,test} from 'vitest';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {resolve} from 'node:path';
import {defaultSettings} from '../../src/app/contracts.js';
import type {Status} from '../../desktop/src/api.js';
import type {BrowserResourcesSnapshot} from '../../src/observability/browser-resource-contracts.js';

test('settings shows cumulative diagnostics, combines events and rejects results after leaving settings',async()=>{
  const server=await createServer({configFile:resolve('desktop/vite.config.ts'),server:{port:0,strictPort:false},logLevel:'error'});await server.listen();
  const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage();
  const status:Status={runtime:'D:\\synthetic\\diagnostics',account:null,operator:{id:'synthetic',permissions:[],expiresAt:Date.now()+60000},
    mode:'MANUAL',configuredMode:'MANUAL',paused:false,browser:{state:'CLOSED',mode:'headless',version:null},lastSync:[],capabilities:[],budgets:[],
    usage:{requests:0,inputTokens:0,outputTokens:0,unresolved:0},settings:defaultSettings,keyPresent:false,modelAuthorized:false,modelBusy:false,
    go:'UNVERIFIED',schema:3,sync:{runId:null,running:false,cancelled:false,source:null,results:[]}};
  const usage={requests:3,knownUsageRequests:2,unknownUsageRequests:1,inputTokens:500,outputTokens:80,elapsedSamples:2,averageElapsedMs:125,p95ElapsedMs:200};
  const capacity={files:0,bytes:0},data={version:1,timeRangeSupported:false,model:{total:usage,groups:[{...usage,model:'deepseek-flash',status:'SUCCEEDED'}]},
    blockers:[{source:'COLLECTION',code:'OBSERVATION_DM_CONTENT_DOM_NOT_READY',count:2}],
    collection:{channels:[{source:'dm',nextAt:Date.now()+60000,lastSuccess:Date.now()-60000,lastError:null,failures:0,elapsedMs:85}],works:{included:1,historical:0,review:0},conversations:{total:3,neverRead:1}},
    performance:[{stage:'QUEUE_WAIT',channel:'SHARED',count:12,failures:0,cancelled:1,lastMs:8,p50Ms:5,p95Ms:12,maxMs:20}],
    evidence:{running:false,nextAt:0,error:null,report:{scope:'EVIDENCE_METADATA',retentionDays:14,referencesComplete:false,unknownReferences:1,cancelled:false,
      total:{files:10,bytes:2048},recognized:{files:9,bytes:2000},expired:{files:2,bytes:400},protected:{files:8,bytes:1600},eligible:capacity,unknown:{files:1,bytes:48},deleted:capacity,remainingEligible:capacity}}};
  const calls:string[]=[],errors:string[]=[];let hold=false,entered=false,release:(()=>void)|undefined,resources:BrowserResourcesSnapshot|undefined;
  page.on('pageerror',error=>errors.push(error.message));
  await page.exposeFunction('fixtureInvoke',async(command:string,args:{body:{command:string}})=>{
    if(command==='desktop_info')return {runtime:status.runtime,version:'synthetic-diagnostics'};
    const name=args.body.command;calls.push(name);
    if(name==='getStatus')return status;
    if(name==='getInbox')return {items:[],total:0,page:0,pageSize:20};
    if(name==='browser')return {available:false};
    if(name==='getDiagnostics'){if(hold){hold=false;entered=true;await new Promise<void>(resolve=>{release=resolve;});}return {...data,...(resources?{browserResources:resources}:{})};}
    throw Error('UNEXPECTED_FIXTURE_COMMAND');
  });
  await page.addInitScript(()=>{
    const callbacks=new Map<number,(event:unknown)=>void>(),listeners=new Map<number,{event:string;handler:number}>();let next=0;
    const fixture=window as unknown as {__TAURI_INTERNALS__:unknown;__TAURI_EVENT_PLUGIN_INTERNALS__:unknown;
      fixtureInvoke:(command:string,args:unknown)=>Promise<unknown>;fixtureEmit:()=>void};
    fixture.__TAURI_INTERNALS__={transformCallback:(callback:(event:unknown)=>void)=>{callbacks.set(++next,callback);return next;},
      invoke:async(command:string,args:Record<string,unknown>)=>{
        if(command==='plugin:event|listen'){const id=++next;listeners.set(id,{event:args.event as string,handler:args.handler as number});return id;}
        if(command==='plugin:event|unlisten')return;
        return fixture.fixtureInvoke(command,args);
      }};
    fixture.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:(_event:string,id:number)=>{const listener=listeners.get(id);if(listener)callbacks.delete(listener.handler);listeners.delete(id);}};
    fixture.fixtureEmit=()=>{for(const [id,listener]of listeners)if(listener.event==='inbora_status_updated')callbacks.get(listener.handler)?.({event:listener.event,id,payload:{event:'send_status_updated'}});};
  });
  const emit=(count=1)=>page.evaluate(count=>{for(let n=0;n<count;n++)(window as unknown as {fixtureEmit:()=>void}).fixtureEmit();},count);
  try{
    await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}`);
    await page.getByRole('heading',{name:'收件箱',exact:true}).waitFor();expect(calls).not.toContain('getDiagnostics');
    await page.getByRole('button',{name:'AI 与设置',exact:true}).click();
    await page.getByText('运行诊断与用量详情',{exact:true}).click();
    await page.getByRole('heading',{name:'运行诊断',exact:true}).waitFor({timeout:1000});
    const panel=page.getByRole('region',{name:'运行诊断'});await panel.getByText('已知输入 500 / 输出 80 Token',{exact:true}).waitFor();
    await panel.getByRole('region',{name:'后台浏览器资源'}).getByText('当前内核未提供浏览器资源监测数据。',{exact:true}).waitFor();
    expect(await panel.innerText()).toContain('用量未知 1 次');expect(await panel.innerText()).toContain('125 ms');
    expect(await panel.innerText()).toContain('200 ms');expect(await panel.innerText()).toContain('排队等待');
    expect(await panel.innerText()).toContain('证据元数据');expect(await panel.innerText()).toContain('不是整个运行目录的磁盘占用');
    expect(await panel.innerText()).toContain('引用尚未全部确认');expect(await panel.innerText()).toContain('费用：未知');
    expect(await panel.innerText()).not.toMatch(/今日|¥|￥|(?:费用|成本)\s*[：:]\s*\d/u);
    usage.requests=7;
    const summary={samples:12,workingSetBytes:{p50:1024**3,p95:1.5*1024**3,max:2*1024**3},privateBytes:{p50:2*1024**3,p95:2.5*1024**3,max:3*1024**3}};
    resources={state:'AVAILABLE',reason:null,intervalMs:60_000,sampledAt:Date.now()-5000,segmentStartedAt:Date.now()-600_000,
      latest:{workingSetBytes:1.5*1024**3,privateBytes:2*1024**3,browserProcesses:7,pageCount:2,elapsedMs:25.5},hour:summary,run:summary};
    const focusBefore=calls.filter(name=>name==='getDiagnostics').length;
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await expect.poll(()=>calls.filter(name=>name==='getDiagnostics').length,{timeout:1000}).toBe(focusBefore+1);
    await panel.getByText('共 7 次 · 已知用量 2 次 · 用量未知 1 次',{exact:true}).waitFor({timeout:1000});
    const browserResources=panel.getByRole('region',{name:'后台浏览器资源'});
    await browserResources.getByText('采样正常',{exact:true}).waitFor({timeout:1000});
    expect(await browserResources.innerText()).toContain('工作集 1.50 GiB · 私有提交量 2.00 GiB');
    expect(await browserResources.innerText()).toContain('页面 2 个 · Edge 进程 7 个');
    expect(await browserResources.innerText()).toContain('共享页的重复计数');
    expect(await browserResources.getByRole('table',{name:'后台浏览器内存摘要'}).innerText()).toContain('最近一小时 / 12');
    resources={...resources,state:'STALE',reason:'SAMPLE_STALE'};await emit();
    await browserResources.getByText('数据已过期 · 最近有效采样已超过 150 秒',{exact:true}).waitFor({timeout:1000});
    expect(await browserResources.innerText()).toContain('工作集 1.50 GiB');
    expect(await browserResources.innerText()).not.toContain('工作集 0.0 MiB');
    const before=calls.filter(name=>name==='getDiagnostics').length;hold=true;await emit(30);await expect.poll(()=>entered).toBe(true);
    await emit(30);expect(calls.filter(name=>name==='getDiagnostics').length).toBe(before+1);
    await page.getByRole('button',{name:'收件箱',exact:true}).click();release?.();
    await page.waitForTimeout(300);expect(calls.filter(name=>name==='getDiagnostics').length).toBe(before+1);
    await emit();await page.waitForTimeout(200);expect(calls.filter(name=>name==='getDiagnostics').length).toBe(before+1);
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForTimeout(200);
    expect(calls.filter(name=>name==='getDiagnostics').length).toBe(before+1);
    expect(errors).toEqual([]);
  }finally{release?.();await browser.close();await server.close();}
});
