import {expect,test} from 'vitest';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {join,resolve} from 'node:path';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {candidate,database,pending,privateTemp} from '../helpers.js';

async function setup(clock=false){
  const root=privateTemp('desktop-refresh-'),store=database();
  const add=(name:string,channel:'DIRECT_MESSAGE'|'COMMENT_NOTIFICATION'='DIRECT_MESSAGE')=>pending(store,candidate({
    platformEventId:'refresh-'+name,conversationId:channel==='DIRECT_MESSAGE'?'conversation-'+name:null,
    actorName:name,text:'合成正文'+name,...(channel==='COMMENT_NOTIFICATION'?{channel,kind:'COMMENT',videoId:'work-'+name,commentId:'parent-'+name}:{}),
  }));
  const a=add('刷新目标A'),b=add('刷新目标B');add('刷新评论','COMMENT_NOTIFICATION');
  await migrateClient(store,join(root,'client.sqlite'));
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();const token=service.authority.issueSession();
  service.authority.setMode(token,'MANUAL');
  const server=await createServer({configFile:resolve('desktop/vite.config.ts'),server:{port:0,strictPort:false},logLevel:'error'});
  await server.listen();const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage();
  const trace:{command:string;eventId?:string}[]=[],errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  let hold:string|undefined,holdFailure=false,entered=false,release:(()=>void)|undefined;
  await page.exposeFunction('fixtureInvoke',async(command:string,args:{body:Record<string,unknown>})=>{
    if(command==='desktop_info')return {runtime:root,version:'synthetic-refresh'};
    if(command!=='client_request')throw Error('UNEXPECTED_FIXTURE_COMMAND');
    const body=args.body as {command:string;eventId?:string};trace.push(body);
    if(body.command===hold&&holdFailure){hold=undefined;entered=true;await new Promise<void>(resolve=>{release=resolve;});throw Error('AUTO_POLICY_REQUIRED');}
    const result=await service.dispatch(token,body);
    if(body.command===hold){hold=undefined;entered=true;await new Promise<void>(resolve=>{release=resolve;});}
    return result;
  });
  await page.addInitScript(()=>{
    const callbacks=new Map<number,(event:unknown)=>void>(),listeners=new Map<number,{event:string;handler:number}>();let next=0;
    const fixture=window as unknown as {__TAURI_INTERNALS__:unknown;__TAURI_EVENT_PLUGIN_INTERNALS__:unknown;
      fixtureInvoke:(command:string,args:unknown)=>Promise<unknown>;fixtureEmit:(name:string)=>void};
    fixture.__TAURI_INTERNALS__={transformCallback:(callback:(event:unknown)=>void)=>{callbacks.set(++next,callback);return next;},
      invoke:async(command:string,args:Record<string,unknown>)=>{
        if(command==='plugin:event|listen'){const id=++next;listeners.set(id,{event:args.event as string,handler:args.handler as number});return id;}
        if(command==='plugin:event|unlisten')return;
        return fixture.fixtureInvoke(command,args);
      }};
    fixture.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:(_event:string,id:number)=>{const listener=listeners.get(id);if(listener)callbacks.delete(listener.handler);listeners.delete(id);}};
    fixture.fixtureEmit=name=>{for(const [id,listener]of listeners)if(listener.event==='inbora_status_updated')callbacks.get(listener.handler)?.({event:listener.event,id,payload:{event:name}});};
  });
  if(clock)await page.clock.install();
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}`);
  await page.getByRole('button',{name:/刷新目标A/}).waitFor();
  const emit=(event='inbox_updated',count=1)=>page.evaluate(({event,count})=>{
    for(let n=0;n<count;n++)(window as unknown as {fixtureEmit:(name:string)=>void}).fixtureEmit(event);
  },{event,count});
  return {page,store,service,token,trace,errors,a,b,add,emit,
    hold:(command:string,fail=false)=>{hold=command;holdFailure=fail;entered=false;},held:()=>entered,release:()=>{release?.();release=undefined;},
    close:async()=>{release?.();await browser.close();await server.close();await service.close();store.close();}};
}
const editor=(page:Awaited<ReturnType<typeof setup>>['page'])=>page.getByRole('textbox',{name:'人工回复草稿'});

test('backend events update the inbox and audit promptly, and focus only refreshes read views',async()=>{
  const f=await setup();try{
    const before=f.trace.length;f.add('事件新增');await f.emit('inbox_updated',40);
    await f.page.getByRole('button',{name:/事件新增/}).waitFor({timeout:1000});
    expect(f.trace.slice(before).filter(call=>call.command==='getStatus').length).toBeLessThanOrEqual(2);
    await f.page.getByRole('button',{name:'操作审计',exact:true}).click();
    f.store.audit('SYNTHETIC_EVENT_REFRESH','fixture');await f.emit('status_updated');
    await f.page.getByRole('cell',{name:'SYNTHETIC_EVENT_REFRESH',exact:true}).waitFor({timeout:1000});
    await f.page.getByRole('button',{name:'收件箱',exact:true}).click();
    const focusStart=f.trace.length;f.add('焦点补查');await f.page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await f.page.getByRole('button',{name:/焦点补查/}).waitFor({timeout:1000});
    expect(f.trace.slice(focusStart).every(call=>['getStatus','getInbox','getThread','getAudit'].includes(call.command))).toBe(true);
    expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('slow reads combine a trailing refresh and a stale A detail cannot replace B or human input',async()=>{
  const f=await setup();try{
    await f.page.getByRole('button',{name:/刷新目标A/}).click();await editor(f.page).waitFor();
    f.hold('getThread');await f.emit('send_status_updated');await expect.poll(f.held,{timeout:1000}).toBe(true);
    await f.page.getByRole('button',{name:/刷新目标B/}).click();await editor(f.page).fill('B的人工输入必须保留');
    await f.emit('draft_updated',30);f.release();
    await expect.poll(()=>f.trace.filter(call=>call.command==='getThread').at(-1)?.eventId).toBe(f.b);
    expect(await editor(f.page).inputValue()).toBe('B的人工输入必须保留');
    expect(await f.page.locator('.task[aria-pressed="true"]').innerText()).toContain('刷新目标B');
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
    expect(f.store.db.prepare('SELECT count(*) n FROM model_calls').get()).toEqual({n:0});expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('quiet views use a fifteen-second read-only fallback instead of the former frequent status polling',async()=>{
  const f=await setup(true);try{
    await f.page.clock.runFor(300);const before=f.trace.length;f.add('静默补查');
    await f.page.clock.runFor(14_000);expect(f.trace.slice(before)).toEqual([]);
    await f.page.clock.runFor(1_100);await expect.poll(()=>f.trace.slice(before).filter(call=>call.command==='getStatus').length).toBe(1);
    await f.page.getByRole('button',{name:/静默补查/}).waitFor();
    for(let tick=2;tick<=4;tick++){
      await f.page.clock.runFor(15_000);await expect.poll(()=>f.trace.slice(before).filter(call=>call.command==='getStatus').length).toBe(tick);
    }
    expect(f.trace.filter(call=>call.command==='getStatus').length).toBeLessThanOrEqual(6);
    expect(f.trace.slice(before).every(call=>['getStatus','getInbox','getThread','getAudit'].includes(call.command))).toBe(true);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('a slow background status cannot revert a newer user control response',async()=>{
  const f=await setup();try{
    await f.page.waitForTimeout(250);f.hold('getStatus');await f.emit('status_updated');await expect.poll(f.held).toBe(true);
    await f.page.getByRole('button',{name:'AI 与设置',exact:true}).click();
    const mode=f.page.getByRole('combobox',{name:'工作模式',exact:true});await mode.selectOption('OBSERVE');
    await expect.poll(()=>mode.inputValue()).toBe('OBSERVE');f.release();await f.page.waitForTimeout(300);
    expect(await mode.inputValue()).toBe('OBSERVE');expect(f.service.authority.mode()).toBe('OBSERVE');expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('an automatic reply switch keeps the clicked state while its backend response is delayed',async()=>{
  const f=await setup();try{
    await f.service.dispatch(f.token,{command:'setReplyPolicy',confirmed:true,policy:{ownId:'own-1',channels:['DIRECT_MESSAGE'],model:'deepseek-flash',
      modelLimit:1,sendLimit:1,expiresAt:null,workIds:[],futureOwnWorks:false,conversationIds:[],entireInbox:true,
      containsAny:['never-match'],excludesAny:[],instructions:'Synthetic only',startHour:0,endHour:24}});
    await f.service.dispatch(f.token,{command:'setAutomaticReply',enabled:true});await f.emit('status_updated');
    await expect.poll(()=>f.page.getByRole('switch',{name:'自动回复',exact:true}).isChecked()).toBe(true);
    await f.page.getByRole('button',{name:'AI 与设置',exact:true}).click();
    const toggle=f.page.getByRole('switch',{name:'设置中的自动回复',exact:true});
    f.hold('setAutomaticReply');await toggle.uncheck();await expect.poll(f.held).toBe(true);
    expect(await toggle.isChecked()).toBe(false);expect(await toggle.isDisabled()).toBe(true);
    expect(await f.page.getByRole('switch',{name:'自动回复',exact:true}).isChecked()).toBe(false);
    expect(await f.page.getByRole('switch',{name:'自动回复',exact:true}).isDisabled()).toBe(true);
    expect(await f.page.getByText('正在关闭自动回复…',{exact:false}).count()).toBe(2);
    f.release();await expect.poll(()=>toggle.isDisabled()).toBe(false);expect(await toggle.isChecked()).toBe(false);
    expect(f.service.authority.mode()).toBe('MANUAL');expect(f.trace.filter(call=>call.command==='setAutomaticReply').length).toBe(1);
    expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('a rejected automatic reply change restores both controls and preserves the exact human draft',async()=>{
  const f=await setup();try{
    await f.service.dispatch(f.token,{command:'setReplyPolicy',confirmed:true,policy:{ownId:'own-1',channels:['DIRECT_MESSAGE'],model:'deepseek-flash',
      modelLimit:1,sendLimit:1,expiresAt:null,workIds:[],futureOwnWorks:false,conversationIds:[],entireInbox:true,
      containsAny:['never-match'],excludesAny:[],instructions:'Synthetic only',startHour:0,endHour:24}});await f.emit('status_updated');
    await f.page.getByRole('button',{name:/刷新目标A/}).click();await editor(f.page).fill('开关失败仍保留的准确人稿');
    const toggle=f.page.getByRole('switch',{name:'自动回复',exact:true});await expect.poll(()=>toggle.isDisabled()).toBe(false);
    f.hold('setAutomaticReply',true);await toggle.check();await expect.poll(f.held).toBe(true);
    expect(await toggle.isChecked()).toBe(true);expect(await toggle.isDisabled()).toBe(true);
    await f.page.getByText('正在开启自动回复…',{exact:false}).waitFor();expect(await editor(f.page).inputValue()).toBe('开关失败仍保留的准确人稿');
    f.release();await expect.poll(()=>toggle.isDisabled()).toBe(false);expect(await toggle.isChecked()).toBe(false);
    expect(f.service.authority.mode()).toBe('MANUAL');expect(await editor(f.page).inputValue()).toBe('开关失败仍保留的准确人稿');
    expect(f.service.authority.draftFor(f.a)?.text).toBe('开关失败仍保留的准确人稿');
    expect(f.trace.filter(call=>call.command==='setAutomaticReply').length).toBe(1);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});expect(f.errors).toEqual([]);
  }finally{await f.close();}
});
