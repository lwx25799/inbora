import {expect,test} from 'vitest';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Status} from '../../desktop/src/api.js';
import {defaultSettings} from '../../src/app/contracts.js';

test('the original-page dialog forwards bounded human gestures with fresh displayed frame coordinates and preserves holds on close',async()=>{
  const status={runtime:'synthetic-manual-recovery',account:{id:'account_001',identity:'own-1'},
    operator:{id:'synthetic',permissions:['READ','CONTROL'],expiresAt:Date.now()+60000},
    mode:'MANUAL',configuredMode:'MANUAL',paused:false,browser:{state:'OPEN_LAST_READ_VERIFIED',mode:'headless',version:'synthetic'},
    lastSync:[],capabilities:[],budgets:[],usage:{requests:0,inputTokens:0,outputTokens:0,unresolved:0},
    settings:defaultSettings,keyPresent:false,modelAuthorized:false,modelBusy:false,
    securityHolds:[{channel:'COMMENT_NOTIFICATION',reason:'OBSERVATION_SECURITY_SUSPECT',incidentId:randomUUID(),revision:randomUUID(),heldAt:Date.now(),mode:'headless'}],
    sync:{runId:null,running:false,cancelled:false,source:null,results:[]},go:'UNVERIFIED',schema:3} as Status;
  const calls:Record<string,unknown>[]=[],errors:string[]=[],frames=new Map<string,number>();
  const session={sessionId:randomUUID(),channel:'COMMENT_NOTIFICATION',incidentId:status.securityHolds![0]!.incidentId};
  let frameCount=0;
  let startResult:'original'|'recreated'|'clear'='original';
  const image='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#dde5df"/><rect x="400" y="200" width="400" height="300" fill="#287a57"/><text x="440" y="270" fill="white" font-size="28">Synthetic challenge</text></svg>');
  const server=await createServer({configFile:resolve('desktop/vite.config.ts'),server:{port:0,strictPort:false},logLevel:'error'});
  await server.listen();const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:900,height:640}});
  page.setDefaultTimeout(3000);page.on('pageerror',error=>errors.push(error.message));
  await page.exposeFunction('fixtureInvoke',async(command:string,args:{body?:Record<string,unknown>})=>{
    if(command==='desktop_info')return {runtime:status.runtime,version:'synthetic-only'};
    if(command.startsWith('plugin:event|'))return 1;
    if(command!=='client_request')throw Error('UNEXPECTED_NATIVE_COMMAND');
    const body=args.body!;calls.push(body);
    if(body.command==='getInbox')return {total:0,unreadTotal:0,page:0,pageSize:20,items:[]};
    if(body.command==='getStatus'||body.command==='connect')return status;
    if(body.command==='selectTarget')return null;
    if(body.command==='securityRecovery'){
      if(body.action==='start'){
        if(startResult==='clear'){status.securityHolds=[];return{state:'CLEARED'};}
        return{...session,...(startResult==='recreated'?{recreated:true}:{})};
      }
      if(body.action==='frame'){
        const frameId=randomUUID(),expiresAt=Date.now()+3000;frames.set(frameId,expiresAt);frameCount++;
        return {sessionId:session.sessionId,frameId,image,width:1280,height:720,regions:[{x:400,y:200,width:400,height:300}],expiresAt,documentPreserved:true};
      }
      if(body.action==='input'){
        if((frames.get(String(body.frameId))??0)<Date.now())throw Error('MANUAL_RECOVERY_FRAME_EXPIRED');
        return {accepted:true};
      }
      if(body.action==='finish'){status.securityHolds=[];return status;}
      if(body.action==='close')return status;
    }
    throw Error('UNEXPECTED_BUSINESS_COMMAND_'+String(body.command));
  });
  await page.addInitScript(()=>{
    const fixture=window as unknown as {__TAURI_INTERNALS__:unknown;fixtureInvoke:(command:string,args:unknown)=>Promise<unknown>};
    fixture.__TAURI_INTERNALS__={invoke:(command:string,args:unknown)=>fixture.fixtureInvoke(command,args)};
  });
  try{
    await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}`);
    const held=page.getByRole('region',{name:'通道安全状态待核验'});
    await held.getByRole('button',{name:'处理原验证页面',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'处理原验证页面'}),picture=dialog.getByAltText('原验证页面实时画面');
    await picture.waitFor();await expect.poll(()=>picture.evaluate(node=>(node as HTMLImageElement).complete)).toBe(true);
    expect(await dialog.innerText()).toContain('原无头页面');
    const dialogBox=(await dialog.boundingBox())!,finishBox=(await dialog.getByRole('button',{name:'完成并核验',exact:true}).boundingBox())!;
    expect(dialogBox.y).toBeGreaterThanOrEqual(0);expect(dialogBox.y+dialogBox.height).toBeLessThanOrEqual(640);
    expect(finishBox.y+finishBox.height).toBeLessThanOrEqual(640);
    expect(calls.some(body=>body.command==='browser'||body.command==='resume')).toBe(false);
    const box=(await picture.boundingBox())!,point=(x:number,y:number)=>({x:box.x+x*box.width/1280,y:box.y+y*box.height/720});
    await page.mouse.click(point(50,50).x,point(50,50).y);
    expect(calls.filter(body=>body.action==='input')).toHaveLength(0);
    await page.mouse.move(point(450,250).x,point(450,250).y);await page.mouse.down();
    await page.mouse.move(point(600,300).x,point(600,300).y,{steps:15});await page.mouse.up();
    await expect.poll(()=>calls.filter(body=>body.action==='input').some(body=>(body.input as {phase?:string}).phase==='up')).toBe(true);
    const pointerCalls=calls.filter(body=>body.action==='input');
    expect(pointerCalls[0]!.input).toMatchObject({kind:'pointer',phase:'down',x:450,y:250});
    expect(pointerCalls.at(-1)!.input).toMatchObject({kind:'pointer',phase:'up',x:600,y:300});
    expect(pointerCalls.length).toBeLessThan(17);
    expect(pointerCalls.map(body=>body.sequence)).toEqual(pointerCalls.map((_,index)=>index+1));
    // An unchanged screenshot still updates its frame authority after the first frame expires.
    try{await expect.poll(()=>frameCount,{timeout:6000}).toBeGreaterThan(7);}
    catch{
      throw Error('SYNTHETIC_RECOVERY_FRAME_POLL_STOPPED '+JSON.stringify({frameCount,
        actions:calls.filter(body=>body.command==='securityRecovery').map(body=>body.action),
        alerts:await page.getByRole('alert').allTextContents(),dialogVisible:await dialog.isVisible()}));
    }
    await dialog.getByLabel('文字验证码',{exact:true}).fill('123456');
    await dialog.getByRole('button',{name:'输入到验证框',exact:true}).click();
    await expect.poll(()=>calls.filter(body=>body.action==='input').at(-1)?.input).toEqual({kind:'text',text:'123456'});
    expect(await dialog.getByRole('alert').count()).toBe(0);
    await dialog.getByRole('button',{name:'暂不处理',exact:true}).click();await dialog.waitFor({state:'detached'});
    expect(status.securityHolds).toHaveLength(1);expect(await held.isVisible()).toBe(true);
    expect(calls.filter(body=>body.action==='close')).toHaveLength(1);
    startResult='recreated';
    await held.getByRole('button',{name:'处理原验证页面',exact:true}).click();
    const currentDialog=page.getByRole('dialog',{name:'处理当前验证页面'});
    await currentDialog.getByAltText('原验证页面实时画面').waitFor();
    expect(await currentDialog.innerText()).toContain('原现场已丢失');
    expect(await currentDialog.innerText()).toContain('重新检查后出现的新验证');
    await currentDialog.getByRole('button',{name:'完成并核验',exact:true}).click();
    await currentDialog.waitFor({state:'detached'});await held.waitFor({state:'detached'});
    expect(calls.filter(body=>body.action==='finish')).toHaveLength(1);
    await page.reload();
    // The native status can reconnect with an old hold whose authorized page is now clear.
    status.securityHolds=[{channel:'COMMENT_NOTIFICATION',reason:'OBSERVATION_SECURITY_SUSPECT',incidentId:session.incidentId,
      revision:randomUUID(),heldAt:Date.now(),mode:'headless'}];
    startResult='clear';await page.reload();
    await held.getByRole('button',{name:'处理原验证页面',exact:true}).click();
    await held.waitFor({state:'detached'});expect(await page.getByRole('dialog').count()).toBe(0);
    expect(calls.some(body=>/send|generate|suggestion|setAutomaticReply/i.test(String(body.command)))).toBe(false);
    expect(errors).toEqual([]);
  }finally{await browser.close();await server.close();}
});
