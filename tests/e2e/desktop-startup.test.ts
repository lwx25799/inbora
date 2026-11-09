import {afterAll,beforeAll,expect,test} from 'vitest';
import {createServer,type ViteDevServer} from 'vite';
import {chromium,type Browser} from 'playwright';
import {resolve} from 'node:path';
import {defaultSettings} from '../../src/app/contracts.js';
import type {Status} from '../../desktop/src/api.js';

const fixedRuntime='D:\\synthetic\\authorized-runtime',oldRuntime='D:\\synthetic\\previous-runtime';
const fallbackRuntime='D:\\synthetic\\default-runtime',activeRuntime='D:\\synthetic\\already-connected';
const fixtureStatus=(runtime:string):Status=>({
  runtime,account:null,operator:{id:'fixture-operator',permissions:[],expiresAt:Date.now()+60000},
  mode:'MANUAL',configuredMode:'MANUAL',paused:false,browser:{state:'CLOSED',mode:'headed',version:null},
  lastSync:[],capabilities:[],budgets:[],usage:{requests:0,inputTokens:0,outputTokens:0,unresolved:0},
  settings:defaultSettings,keyPresent:false,modelAuthorized:false,modelBusy:false,go:'PENDING',schema:3,
  sync:{runId:null,running:false,cancelled:false,source:null,results:[]},
});
let server:ViteDevServer,browser:Browser,url:string;
beforeAll(async()=>{
  server=await createServer({configFile:resolve('desktop/vite.config.ts'),server:{port:0,strictPort:false},logLevel:'error'});
  await server.listen();url=`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}`;
  browser=await chromium.launch({channel:'msedge',headless:true});
});
afterAll(async()=>{await browser?.close();await server?.close();});

async function setup({previous='',connected=false,fail=false,remembered=fixedRuntime,readyDelay=0,statusError=''}:{previous?:string;connected?:boolean;fail?:boolean;remembered?:string|null;readyDelay?:number;statusError?:string}={}){
  const context=await browser.newContext(),page=await context.newPage(),calls:Record<string,unknown>[]=[];
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  let status=connected?fixtureStatus(activeRuntime):null;const readyAt=Date.now()+readyDelay;
  await page.exposeFunction('fixtureInvoke',async(command:string,args:{body?:Record<string,unknown>})=>{
    if(command==='desktop_info'){
      await new Promise(resolve=>setTimeout(resolve,80));
      return {runtime:fallbackRuntime,rememberedRuntime:remembered,version:'synthetic-startup'};
    }
    if(command!=='client_request')throw new Error('UNEXPECTED_FIXTURE_COMMAND');
    const body=args.body!;calls.push(body);
    if(Date.now()<readyAt)throw new Error('DEV_BACKEND_RESTARTING_READ_STATUS');
    if(body.command==='getStatus'){if(statusError)throw new Error(statusError);if(!status)throw new Error('CONNECT_RUNTIME_FIRST');return status;}
    if(body.command==='connect'){
      if(fail)throw new Error('private-native-path-and-stack-must-not-leak');
      status=fixtureStatus(body.runtime as string);return status;
    }
    if(body.command==='getInbox')return {items:[],total:0,page:0,pageSize:20};
    throw new Error('UNEXPECTED_BUSINESS_COMMAND');
  });
  await page.addInitScript(previous=>{
    localStorage.clear();if(previous)localStorage.setItem('inbora-runtime',previous);
    const fixture=window as unknown as {__TAURI_INTERNALS__:unknown;fixtureInvoke:(command:string,args:unknown)=>Promise<unknown>};
    fixture.__TAURI_INTERNALS__={invoke:(command:string,args:unknown)=>fixture.fixtureInvoke(command,args)};
  },previous);
  await page.goto(url);
  return {page,calls,errors,close:()=>context.close()};
}
const connections=(calls:Record<string,unknown>[])=>calls.filter(call=>call.command==='connect');
const automaticConnect={command:'connect',runtime:fixedRuntime,initialize:false,consent:true};

test('native remembered runtime connects automatically with empty WebView storage and never initializes',async()=>{
  const f=await setup();try{
    await expect.poll(()=>connections(f.calls),{timeout:2500}).toEqual([automaticConnect]);
    await f.page.getByRole('heading',{name:'收件箱',exact:true}).waitFor();
    expect(await f.page.evaluate(()=>localStorage.getItem('inbora-runtime'))).toBe(fixedRuntime);
    expect(f.calls.map(call=>call.command)).not.toContain('sendHumanReply');expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('native remembered runtime takes priority over an older WebView remembered directory',async()=>{
  const f=await setup({previous:oldRuntime});try{
    await expect.poll(()=>connections(f.calls),{timeout:2500}).toEqual([automaticConnect]);
    await f.page.getByRole('heading',{name:'收件箱',exact:true}).waitFor();
    expect(await f.page.evaluate(()=>localStorage.getItem('inbora-runtime'))).toBe(fixedRuntime);
    expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('an existing authoritative connection wins over late native defaults without another connect',async()=>{
  const f=await setup({previous:oldRuntime,connected:true});try{
    await f.page.getByRole('heading',{name:'收件箱',exact:true}).waitFor();
    await f.page.getByRole('button',{name:'AI 与设置',exact:true}).click();
    await expect.poll(()=>f.page.locator('.settings code').allTextContents(),{timeout:2500}).toContain(activeRuntime);
    await new Promise(resolve=>setTimeout(resolve,120));
    expect(await f.page.locator('.settings code').allTextContents()).toContain(activeRuntime);
    expect(connections(f.calls)).toEqual([]);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('automatic connection failure retains the exact authorized directory and shows only a fixed error',async()=>{
  const f=await setup({previous:oldRuntime,fail:true});try{
    await expect.poll(()=>connections(f.calls),{timeout:2500}).toEqual([automaticConnect]);
    await f.page.getByRole('alert').filter({hasText:'无法自动连接已保存的运行目录，请检查目录或重新连接。'}).waitFor({timeout:2500});
    expect(await f.page.getByRole('textbox',{name:'私有运行目录'}).inputValue()).toBe(fixedRuntime);
    expect(await f.page.getByRole('checkbox').first().isChecked()).toBe(false);
    expect(await f.page.locator('body').innerText()).not.toContain('private-native-path-and-stack');
    expect(await f.page.evaluate(()=>localStorage.getItem('inbora-runtime'))).toBe(oldRuntime);
    expect(f.calls.every(call=>['getStatus','connect'].includes(call.command as string))).toBe(true);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('a release without native remembered runtime retains the previously connected WebView directory',async()=>{
  const f=await setup({previous:oldRuntime,remembered:null});try{
    await expect.poll(()=>connections(f.calls),{timeout:2500}).toEqual([{...automaticConnect,runtime:oldRuntime}]);
    await f.page.getByRole('heading',{name:'收件箱',exact:true}).waitFor();expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('a fresh release keeps its default directory for explicit first connection without initializing',async()=>{
  const f=await setup({remembered:null});try{
    await expect.poll(()=>f.page.getByRole('textbox',{name:'私有运行目录'}).inputValue(),{timeout:2500}).toBe(fallbackRuntime);
    expect(connections(f.calls)).toEqual([]);expect(f.calls).toEqual([{command:'getStatus'}]);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('native startup waits for a source backend that is not ready before attempting its one automatic connection',async()=>{
  const f=await setup({readyDelay:700});try{
    await f.page.getByRole('heading',{name:'收件箱',exact:true}).waitFor({timeout:3000});
    expect(f.calls.filter(call=>call.command==='getStatus').length).toBeGreaterThan(1);
    expect(connections(f.calls)).toEqual([automaticConnect]);
    expect(f.calls.slice(0,f.calls.findIndex(call=>call.command==='connect')).every(call=>call.command==='getStatus')).toBe(true);
    expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('startup stops its readiness wait within a bound and never connects to a backend that remains unavailable',async()=>{
  const started=Date.now(),f=await setup({statusError:'DEV_BACKEND_RESTARTING_READ_STATUS'});try{
    await f.page.getByRole('alert').filter({hasText:'无法自动连接已保存的运行目录，请检查目录或重新连接。'}).waitFor({timeout:6000});
    expect(Date.now()-started).toBeLessThan(6500);expect(connections(f.calls)).toEqual([]);
    expect(await f.page.getByRole('textbox',{name:'私有运行目录'}).inputValue()).toBe(fixedRuntime);
    const attempts=f.calls.length;expect(attempts).toBeGreaterThan(1);
    await new Promise(resolve=>setTimeout(resolve,300));expect(f.calls.length).toBe(attempts);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('an unavailable or unsafe backend error cannot be interpreted as permission to connect',async()=>{
  const f=await setup({statusError:'DEV_BACKEND_UNAVAILABLE_RESTART_REQUIRED'});try{
    await f.page.getByRole('alert').waitFor({timeout:2500});
    expect(f.calls).toEqual([{command:'getStatus'}]);expect(connections(f.calls)).toEqual([]);
    expect(await f.page.getByRole('textbox',{name:'私有运行目录'}).inputValue()).toBe(fixedRuntime);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});
