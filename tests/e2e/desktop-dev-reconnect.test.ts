import { expect,test } from 'vitest';
import { createServer } from 'vite';
import { chromium,type Page } from 'playwright';
import { join,resolve } from 'node:path';
import { ClientService } from '../../src/app/service.js';
import { BrowserService } from '../../src/app/browser-service.js';
import { defaultSettings } from '../../src/app/contracts.js';
import { migrateClient } from '../../src/storage/client-migration.js';
import { candidate,database,pending,privateTemp } from '../helpers.js';

async function setup(memoryKey=false){
  const root=privateTemp('desktop-dev-reconnect-'),store=database();
  const a=pending(store,candidate({platformEventId:'dev-a',conversationId:'conversation-a',actorName:'开发目标A',text:'目标A原始入站'}));
  const b=pending(store,candidate({platformEventId:'dev-b',conversationId:'conversation-b',actorName:'开发目标B',text:'目标B原始入站'}));
  await migrateClient(store,join(root,'schema3.sqlite'));
  let service=new ClientService(store,new BrowserService(root));await service.loadSettings();
  let token=service.authority.issueSession(),epoch=0;
  service.authority.setMode(token,'MANUAL');
  if(memoryKey)await service.dispatch(token,{command:'configureAi',settings:defaultSettings,key:'synthetic-memory-key'});
  const server=await createServer({configFile:resolve('desktop/vite.config.ts'),server:{port:0,strictPort:false},logLevel:'error'});
  await server.listen();const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage();
  const trace:{command:string;eventId?:string;generation?:number;selectionId?:string;epoch:number;text?:string}[]=[];
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  let hold:{command:string;eventId?:string}|undefined,entered=false,release:(()=>void)|undefined;
  await page.exposeFunction('fixtureInvoke',async(command:string,args:{body?:Record<string,unknown>})=>{
    if(command==='desktop_info')return {runtime:root,version:'synthetic-dev'};
    if(command!=='client_request')throw new Error('UNEXPECTED_FIXTURE_COMMAND');
    const body=args.body as {command:string;eventId?:string;generation?:number;selectionId?:string;text?:string};
    trace.push({...body,epoch});
    const result=await service.dispatch(token,body as Parameters<ClientService['dispatch']>[1]);
    if(hold&&body.command===hold.command&&(!hold.eventId||body.eventId===hold.eventId)){
      hold=undefined;entered=true;await new Promise<void>(resolve=>{release=resolve;});
    }
    return result;
  });
  await page.addInitScript(()=>{
    const callbacks=new Map<number,(event:unknown)=>void>(),listeners=new Map<string,number>();let next=0;
    const fixture=window as unknown as {__TAURI_INTERNALS__:unknown;__TAURI_EVENT_PLUGIN_INTERNALS__:unknown;fixtureEmit:()=>void;
      fixtureInvoke:(command:string,args:unknown)=>Promise<unknown>};
    fixture.__TAURI_INTERNALS__={
      transformCallback:(callback:(event:unknown)=>void)=>{callbacks.set(++next,callback);return next;},
      invoke:async(command:string,args:Record<string,unknown>)=>{
        if(command==='plugin:event|listen'){listeners.set(args.event as string,args.handler as number);return args.handler;}
        if(command==='plugin:event|unlisten')return;
        return fixture.fixtureInvoke(command,args);
      },
    };
    fixture.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:(event:string,id:number)=>{listeners.delete(event);callbacks.delete(id);}};
    fixture.fixtureEmit=()=>{
      const id=listeners.get('inbora_status_updated');if(id===undefined)return;
      callbacks.get(id)!({event:'inbora_status_updated',id,payload:{event:'backend_restarted'}});
    };
  });
  const address=server.httpServer!.address() as {port:number};await page.goto(`http://127.0.0.1:${address.port}`);
  await page.getByRole('heading',{name:'收件箱',exact:true}).waitFor();
  const f={page,store,a,b,trace,errors,get service(){return service;},
    hold:(command:string,eventId?:string)=>{hold={command,...(eventId?{eventId}:{})};entered=false;},
    held:()=>entered,release:()=>{release?.();release=undefined;},
    restart:async()=>{await service.close();service=new ClientService(store,new BrowserService(root));await service.loadSettings();token=service.authority.issueSession();epoch++;},
    emit:()=>page.evaluate(()=>(window as unknown as {fixtureEmit:()=>void}).fixtureEmit()),
    close:async()=>{release?.();await page.close();await browser.close();await server.close();await service.close();store.close();}};
  return f;
}
const editor=(page:Page)=>page.getByRole('textbox',{name:'人工回复草稿'});

test('a development backend restart reclaims the same dialog without replaying or overwriting its dirty text',async()=>{
  const f=await setup(true);
  try{
    await f.page.getByRole('button',{name:/开发目标A/}).click();
    await f.page.getByRole('button',{name:'打开人工回复',exact:true}).click();
    await editor(f.page).fill('重启前继续输入的人稿');
    const before=f.trace.filter(item=>item.command==='openHumanDialog').at(-1)!;
    const beforeGeneration=(f.store.db.prepare("SELECT generation FROM thread_ownership WHERE target_key='dm:conversation-a'").get() as {generation:number}).generation;
    f.hold('getStatus');await f.restart();await f.emit();await expect.poll(f.held).toBe(true);
    expect(await editor(f.page).inputValue()).toBe('重启前继续输入的人稿');
    expect(await f.page.getByRole('button',{name:'发送',exact:true}).isDisabled()).toBe(true);
    f.release();await f.page.getByText('开发内核已恢复；人稿保留，未重放模型、保存或发送',{exact:true}).first().waitFor();
    expect(await editor(f.page).inputValue()).toBe('重启前继续输入的人稿');
    const after=f.trace.filter(item=>item.command==='openHumanDialog').at(-1)!;
    expect(after.selectionId).not.toBe(before.selectionId);
    const generation=(f.store.db.prepare("SELECT generation FROM thread_ownership WHERE target_key='dm:conversation-a'").get() as {generation:number}).generation;
    expect(generation).toBeGreaterThan(beforeGeneration);
    await f.page.getByText('未配置 Key，人工回复仍可直接发送。',{exact:true}).waitFor();
    await new Promise(resolve=>setTimeout(resolve,650));
    expect(f.trace.filter(item=>item.epoch===1&&['saveDraft','sendHumanReply','generateSuggestion','connect','configureAi'].includes(item.command))).toEqual([]);
    await editor(f.page).fill('恢复后新的人工输入');
    await f.page.getByText('修改已保存',{exact:true}).waitFor();
    const saved=f.trace.filter(item=>item.command==='saveDraft').at(-1)!;
    expect(saved).toMatchObject({eventId:f.a,epoch:1,text:'恢复后新的人工输入',generation});
    expect(f.store.db.prepare('SELECT count(*) AS n FROM model_calls').get()).toEqual({n:0});
    expect(f.store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('late recovery for A cannot replace B selection or its next saved human text',async()=>{
  const f=await setup();
  try{
    await f.page.getByRole('button',{name:/开发目标A/}).click();
    await f.page.getByText('目标A原始入站',{exact:true}).first().waitFor();
    await f.restart();f.hold('getThread',f.a);await f.emit();await expect.poll(f.held).toBe(true);
    await f.page.getByRole('button',{name:/开发目标B/}).click();
    await f.page.getByText('目标B原始入站',{exact:true}).first().waitFor();
    f.release();await f.page.getByText('开发内核已恢复；人稿保留，未重放模型、保存或发送',{exact:true}).first().waitFor();
    expect(await f.page.locator('.task[aria-pressed="true"]').innerText()).toContain('开发目标B');
    await f.page.getByRole('button',{name:'打开人工回复',exact:true}).click();await editor(f.page).fill('只属于B的人工输入');
    await f.page.getByText('修改已保存',{exact:true}).waitFor();
    expect(f.trace.filter(item=>item.command==='selectTarget').at(-1)?.eventId).toBe(f.b);
    expect(f.trace.filter(item=>item.command==='saveDraft').at(-1)).toMatchObject({eventId:f.b,text:'只属于B的人工输入'});
    expect(f.store.events().find(item=>item.id===f.a)?.payload.text).toBe('目标A原始入站');
    expect(f.trace.some(item=>['sendHumanReply','generateSuggestion'].includes(item.command))).toBe(false);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});
