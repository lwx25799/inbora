import {expect,test} from 'vitest';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {join,resolve} from 'node:path';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import type {ReplyPolicy} from '../../src/app/automation-contracts.js';
import {database,privateTemp} from '../helpers.js';

test('unlimited model and send choices apply only on explicit policy save and keep accumulated use across reopening settings',async()=>{
  const root=privateTemp('unlimited-budget-ui-'),store=database();await migrateClient(store,join(root,'backup.sqlite'));store.bindAccount('own-1');
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();const token=service.authority.issueSession();
  await service.dispatch(token,{command:'setReplyPolicy',confirmed:true,policy:{ownId:'own-1',channels:['DIRECT_MESSAGE'],model:'deepseek-flash',
    modelLimit:10,sendLimit:10,expiresAt:null,workIds:[],futureOwnWorks:false,conversationIds:[],entireInbox:true,
    containsAny:[],excludesAny:[],instructions:'Synthetic offline only',startHour:0,endHour:24}});
  store.db.prepare("UPDATE budgets SET used=CASE kind WHEN 'MODEL' THEN 4 ELSE 6 END").run();
  const data=new AutomationStore(store),original=data.active('AUTO_REPLY')!;data.reserve(original.version,'MODEL','consumed-model');data.reserve(original.version,'SEND','consumed-send');
  const server=await createServer({configFile:resolve('desktop/vite.config.ts'),server:{port:0,strictPort:false},logLevel:'error'});await server.listen();
  const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage();page.setDefaultTimeout(3000);
  const calls:string[]=[],errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.exposeFunction('fixtureInvoke',async(command:string,args:{body?:Record<string,unknown>})=>{
    if(command==='desktop_info')return {runtime:root,version:'synthetic-unlimited'};
    if(command!=='client_request')throw new Error('UNEXPECTED_NATIVE_COMMAND');calls.push(String(args.body!.command));return service.dispatch(token,args.body!);
  });
  await page.addInitScript(()=>{const fixture=window as unknown as {__TAURI_INTERNALS__:unknown;fixtureInvoke:(command:string,args:unknown)=>Promise<unknown>};
    fixture.__TAURI_INTERNALS__={invoke:(command:string,args:unknown)=>fixture.fixtureInvoke(command,args)};});
  try{
    await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}`);
    await page.getByRole('button',{name:'AI 与设置',exact:true}).click();
    expect(await page.getByLabel('自动回复楼中楼评论',{exact:true}).isChecked()).toBe(true);
    expect(await page.getByRole('spinbutton',{name:'本次持续授权的模型次数',exact:true}).inputValue()).toBe('10');
    expect(await page.getByRole('spinbutton',{name:'本次持续授权的发送次数',exact:true}).inputValue()).toBe('10');
    await page.getByLabel('模型次数无上限',{exact:true}).check();await page.getByLabel('发送次数无上限',{exact:true}).check();
    expect(data.active('AUTO_REPLY')!.version).toBe(original.version);expect(data.active('AUTO_REPLY')!.scope.modelLimit).toBe(10);
    expect(store.budget('MODEL')).toMatchObject({used:4,maximum:50});expect(store.budget('SEND')).toMatchObject({used:6,maximum:20});
    await page.getByLabel('自动回复楼中楼评论',{exact:true}).uncheck();
    expect((data.active('AUTO_REPLY')!.scope as ReplyPolicy).replyToNestedComments).toBeUndefined();
    await page.getByRole('button',{name:'按此范围启用规则自动回复',exact:true}).click();
    await expect.poll(()=>data.active('AUTO_REPLY')!.scope.modelLimit).toBeNull();expect(data.active('AUTO_REPLY')!.scope).toMatchObject({modelLimit:null,sendLimit:null});
    expect((data.active('AUTO_REPLY')!.scope as ReplyPolicy).replyToNestedComments).toBe(false);
    expect(store.budgets()).toEqual([{kind:'MODEL',used:4,maximum:null},{kind:'SEND',used:6,maximum:null}]);
    await expect.poll(()=>page.locator('.settings').innerText()).toContain('MODEL 4/无上限');
    await page.getByRole('button',{name:'收件箱',exact:true}).click();await page.getByRole('button',{name:'AI 与设置',exact:true}).click();
    expect(await page.getByLabel('模型次数无上限',{exact:true}).isChecked()).toBe(true);expect(await page.getByLabel('发送次数无上限',{exact:true}).isChecked()).toBe(true);
    expect(await page.getByLabel('自动回复楼中楼评论',{exact:true}).isChecked()).toBe(false);
    await page.getByLabel('模型次数无上限',{exact:true}).uncheck();await page.getByLabel('发送次数无上限',{exact:true}).uncheck();
    await page.getByRole('spinbutton',{name:'本次持续授权的模型次数',exact:true}).fill('4');
    await page.getByRole('spinbutton',{name:'本次持续授权的发送次数',exact:true}).fill('3');
    await page.getByRole('button',{name:'按此范围启用规则自动回复',exact:true}).click();
    await expect.poll(()=>store.budget('MODEL').maximum).toBe(7);expect(store.budget('SEND')).toMatchObject({used:6,maximum:8});
    await service.dispatch(token,{command:'setReplyPolicy',policy:null,confirmed:true});
    await service.dispatch(token,{command:'setModelGrant',scope:{ownId:'own-1',channels:['DIRECT_MESSAGE'],model:'deepseek-flash',modelLimit:null,expiresAt:null},confirmed:true});
    await page.reload();await page.getByRole('button',{name:'AI 与设置',exact:true}).click();
    expect(await page.getByLabel('模型次数无上限',{exact:true}).isChecked()).toBe(true);expect(await page.getByLabel('发送次数无上限',{exact:true}).isChecked()).toBe(false);
    expect(store.budget('SEND')).toMatchObject({used:6,maximum:8});
    expect(store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});expect(calls.some(command=>['sendHumanReply','generateSuggestion'].includes(command))).toBe(false);
    expect(errors).toEqual([]);
  }finally{await browser.close();await server.close();await service.close();store.close();}
});
