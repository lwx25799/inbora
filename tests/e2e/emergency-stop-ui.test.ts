import {expect,test} from 'vitest';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {resolve} from 'node:path';
import {mkdir} from 'node:fs/promises';
import type {Status} from '../../desktop/src/api.js';
import {defaultSettings} from '../../src/app/contracts.js';

function stoppedStatus(){
  return {runtime:'synthetic-emergency-only',account:{id:'account_001',identity:'own-1'},
    operator:{id:'synthetic',permissions:['READ','CONTROL'],expiresAt:Date.now()+60000},
    mode:'MANUAL',configuredMode:'MANUAL',paused:false,browser:{state:'OPEN_LAST_READ_VERIFIED',mode:'headless',version:'synthetic'},
    lastSync:[],capabilities:[],budgets:[],usage:{requests:0,inputTokens:0,outputTokens:0,unresolved:0},
    settings:defaultSettings,keyPresent:false,modelAuthorized:false,modelBusy:false,
    automation:{startedAt:1794054761443,emergencyStopped:true,
      emergencyStop:{reason:'OBSERVATION_PAGE_BLOCKED',source:'COLLECTION_COMMENTS',stoppedAt:1794399998894,legacy:false},
      collection:null,modelGrant:null,replyPolicy:null,inboxRevision:0,pendingWorks:{count:0},
      collector:{running:false,source:null,fatal:null,channels:[]}},
    sync:{runId:null,running:false,cancelled:false,source:null,results:[]},go:'UNVERIFIED',schema:3} as Status;
}

test.each([{width:900,height:640},{width:1240,height:800}])('emergency reason and recovery remain visible across pages at $width x $height',async viewport=>{
  const status=stoppedStatus(),calls:Record<string,unknown>[]=[],errors:string[]=[];let refuseRecovery=true;
  const server=await createServer({configFile:resolve('desktop/vite.config.ts'),server:{port:0,strictPort:false},logLevel:'error'});
  await server.listen();const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport});
  page.setDefaultTimeout(2000);page.on('pageerror',error=>errors.push(error.message));
  await page.exposeFunction('fixtureInvoke',async(command:string,args:{body?:Record<string,unknown>})=>{
    if(command==='desktop_info')return {runtime:status.runtime,version:'synthetic-only'};
    if(command.startsWith('plugin:event|'))return 1;
    if(command!=='client_request')throw Error('UNEXPECTED_NATIVE_COMMAND');
    const body=args.body!;calls.push(body);
    if(body.command==='getInbox')return {total:0,unreadTotal:0,page:0,pageSize:20,items:[]};
    if(body.command==='getAudit')return {items:[]};
    if(body.command==='selectTarget')return null;
    if(body.command==='getDiagnostics')return {version:1,timeRangeSupported:false,
      model:{total:{requests:0,knownUsageRequests:0,unknownUsageRequests:0,inputTokens:0,outputTokens:0,
        elapsedSamples:0,averageElapsedMs:null,p95ElapsedMs:null},groups:[]},blockers:[],
      collection:{channels:[],works:{included:0,historical:0,review:0},conversations:{total:0,neverRead:0}},performance:[],evidence:null};
    if(body.command==='browser'&&body.action==='inspectSavedDraftRecovery')return null;
    if(body.command==='browser'){
      status.browser={...status.browser,mode:body.mode as 'headed'|'headless',loginRecovery:body.mode==='headed',
        state:body.mode==='headed'?'MANUAL_VISIBLE':'OPEN_LAST_READ_VERIFIED'};return status;
    }
    if(body.command==='resume'){
      if(refuseRecovery)throw Error('OBSERVATION_PAGE_BLOCKED');
      status.automation!.emergencyStopped=false;return status;
    }
    if(body.command==='getStatus'||body.command==='connect')return status;
    throw Error('UNEXPECTED_BUSINESS_COMMAND_'+String(body.command));
  });
  await page.addInitScript(()=>{
    const fixture=window as unknown as {__TAURI_INTERNALS__:unknown;fixtureInvoke:(command:string,args:unknown)=>Promise<unknown>};
    fixture.__TAURI_INTERNALS__={invoke:(command:string,args:unknown)=>fixture.fixtureInvoke(command,args)};
  });
  try{
    await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}`);
    const notice=page.getByRole('region',{name:'全局急停原因与处理'});
    await notice.waitFor();expect(await notice.innerText()).toContain('评论后台收取');
    expect(await notice.innerText()).toContain('页面安全检查未通过');
    expect(await notice.innerText()).toContain('2026');expect(await notice.innerText()).toContain('停止收取、模型和发送');
    const recover=notice.getByRole('button',{name:'检查并恢复运行',exact:true});
    expect(await recover.isVisible()).toBe(true);expect(calls.some(c=>c.command==='resume')).toBe(false);
    const box=await recover.boundingBox();expect(box!.y+box!.height).toBeLessThan(viewport.height);
    await mkdir(resolve('.local/emergency-stop-ui'),{recursive:true});
    await page.screenshot({path:resolve(`.local/emergency-stop-ui/recorded-${viewport.width}.png`)});
    await page.getByRole('button',{name:'AI 与设置',exact:true}).click();
    expect(await page.getByRole('button',{name:'恢复运行',exact:true}).isVisible()).toBe(true);
    expect(await page.getByRole('button',{name:'保存收取范围',exact:true}).isVisible()).toBe(true);
    await page.getByRole('button',{name:'操作审计',exact:true}).click();expect(await recover.isVisible()).toBe(true);
    await page.getByRole('button',{name:'收件箱',exact:true}).click();
    await recover.click();await expect.poll(()=>calls.filter(c=>c.command==='resume').length).toBe(1);
    expect(await notice.isVisible()).toBe(true);
    await notice.getByRole('button',{name:'处理登录或验证',exact:true}).click();
    expect(status.automation!.emergencyStopped).toBe(true);
    expect(calls.filter(c=>c.command==='browser'&&!c.action).at(-1)).toMatchObject({mode:'headed',loginRecovery:true,manualVisible:true});
    await notice.getByRole('button',{name:'返回无头并检查恢复',exact:true}).click();
    await expect.poll(()=>calls.filter(c=>c.command==='resume').length).toBe(2);
    expect(status.browser.mode).toBe('headless');expect(await notice.isVisible()).toBe(true);
    status.automation!.emergencyStop={reason:'EMERGENCY_REASON_UNAVAILABLE',source:'UNKNOWN',stoppedAt:null,legacy:true};
    await page.getByRole('button',{name:'重新连接内核',exact:true}).click();
    await expect.poll(()=>notice.innerText()).toContain('旧版本未记录急停时间');
    expect(await page.getByRole('alert').count()).toBe(0);
    await page.screenshot({path:resolve(`.local/emergency-stop-ui/legacy-${viewport.width}.png`)});
    refuseRecovery=false;await recover.click();await notice.waitFor({state:'detached'});
    expect(calls.filter(c=>c.command==='resume')).toHaveLength(3);
    expect(calls.some(c=>/send|suggestion|generate/i.test(String(c.command)))).toBe(false);expect(errors).toEqual([]);
  }finally{await browser.close();await server.close();}
});
