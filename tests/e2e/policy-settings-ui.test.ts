import {expect,test} from 'vitest';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {join,resolve} from 'node:path';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {approved,candidate,database,privateTemp,snapshot} from '../helpers.js';

test('saved policy budgets remain visible and an empty selected scope cannot be enabled',async()=>{
  const root=privateTemp('policy-settings-'),store=database();
  const draft=approved(store),intent=store.recordIntent(draft,snapshot(candidate()),false,{check:()=>{},committed:()=>{}});
  store.receipt(intent,'UNCERTAIN','synthetic-legacy-unknown');
  await migrateClient(store,join(root,'client.sqlite'));
  store.bindAccount('own-1');
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();const token=service.authority.issueSession();
  await service.dispatch(token,{command:'setReplyPolicy',confirmed:true,policy:{ownId:'own-1',channels:['COMMENT_NOTIFICATION','DIRECT_MESSAGE'],
    model:'deepseek-flash',modelLimit:10,sendLimit:10,expiresAt:null,workIds:[],futureOwnWorks:true,conversationIds:[],entireInbox:true,
    containsAny:['synthetic-trigger'],excludesAny:[],instructions:'Synthetic reply rule',startHour:0,endHour:24}});
  const server=await createServer({configFile:resolve('desktop/vite.config.ts'),server:{port:0,strictPort:false},logLevel:'error'});await server.listen();
  const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage();page.setDefaultTimeout(3000);
  await page.exposeFunction('fixtureInvoke',async(command:string,args:{body?:Record<string,unknown>})=>{
    if(command==='desktop_info')return {runtime:root,version:'synthetic-policy'};
    if(command!=='client_request')throw new Error('UNEXPECTED_NATIVE_COMMAND');return service.dispatch(token,args.body!);
  });
  await page.addInitScript(()=>{const bridge=window as unknown as {__TAURI_INTERNALS__:unknown;fixtureInvoke:(command:string,args:unknown)=>Promise<unknown>};
    bridge.__TAURI_INTERNALS__={invoke:(command:string,args:unknown)=>bridge.fixtureInvoke(command,args)};});
  try{
    await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}`);
    await page.getByRole('button',{name:'AI 与设置',exact:true}).click();
    expect(await page.getByRole('switch',{name:'设置中的自动回复',exact:true}).count()).toBe(1);
    expect(await page.getByRole('textbox',{name:'入站须包含任一词',exact:false}).count()).toBe(0);
    expect(await page.getByRole('textbox',{name:'屏蔽词',exact:false}).count()).toBe(1);
    expect(await page.getByRole('button',{name:'交回自动回复',exact:true}).count()).toBe(0);
    expect(await page.getByText('1 条私信发送结果仍不明确',{exact:false}).count()).toBe(1);
    expect(await page.getByRole('spinbutton',{name:'本次持续授权的模型次数'}).inputValue()).toBe('10');
    expect(await page.getByRole('spinbutton',{name:'本次持续授权的发送次数'}).inputValue()).toBe('10');
    expect(await page.getByLabel('我确认当前本人账号',{exact:false}).count()).toBe(0);
    const enable=page.getByRole('button',{name:'按此范围启用规则自动回复',exact:true});expect(await enable.isEnabled()).toBe(true);
    await page.getByLabel('回复策略覆盖本号运行起点后所有新视频').uncheck();
    expect(await enable.isDisabled()).toBe(true);expect(await page.getByText('请为每个已选通道填写作品或会话 ID',{exact:false}).count()).toBe(1);
    await page.getByLabel('回复策略覆盖本号运行起点后所有新视频').check();expect(await enable.isEnabled()).toBe(true);
    expect(store.db.prepare('SELECT used FROM budgets ORDER BY kind').all()).toEqual([{used:0},{used:0}]);
    expect(store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:1});
    expect(store.db.prepare('SELECT status FROM send_intents').get()).toEqual({status:'UNCERTAIN'});
    store.db.prepare('INSERT INTO verification_results VALUES(?,?,?,?,?)').run('synthetic-read-only-proof',intent,1,'synthetic-complete-proof',Date.now());
    await expect.poll(()=>page.getByText('1 条私信发送结果仍不明确',{exact:false}).count(),{timeout:3000}).toBe(0);
    expect(store.db.prepare('SELECT status FROM send_intents').get()).toEqual({status:'UNCERTAIN'});
  }finally{await browser.close();await server.close();await service.close();store.close();}
});
