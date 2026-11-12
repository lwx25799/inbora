import {expect,test} from 'vitest';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {join,resolve} from 'node:path';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {database,privateTemp} from '../helpers.js';

test.each([{width:900,height:640},{width:1240,height:800}])('compact settings retain edits and fit at $width x $height',async viewport=>{
  const root=privateTemp('settings-layout-'),store=database();
  await migrateClient(store,join(root,'backup.sqlite'));store.bindAccount('own-1');
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();const token=service.authority.issueSession();
  await service.dispatch(token,{command:'configureCollection',settings:{ownId:'own-1',comments:true,inbox:true,commentIntervalMs:30_000,dmIntervalMs:15_000}});
  await service.dispatch(token,{command:'setReplyPolicy',confirmed:true,policy:{ownId:'own-1',channels:['DIRECT_MESSAGE','COMMENT_NOTIFICATION'],model:'deepseek-flash',
    modelLimit:10,sendLimit:10,expiresAt:null,workIds:[],futureOwnWorks:true,conversationIds:[],entireInbox:true,
    containsAny:[],excludesAny:[],instructions:'仅回复当前文字留言，保持简短。',startHour:0,endHour:24}});
  const server=await createServer({configFile:resolve('desktop/vite.config.ts'),server:{port:0,strictPort:false},logLevel:'error'});await server.listen();
  const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport});
  page.setDefaultTimeout(3000);const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const commands:string[]=[];
  await page.exposeFunction('fixtureInvoke',async(command:string,args:{body?:Record<string,unknown>})=>{
    if(command==='desktop_info')return {runtime:root,version:'synthetic-settings-layout'};
    if(command!=='client_request')throw Error('UNEXPECTED_NATIVE_COMMAND');
    commands.push(String(args.body!.command));return service.dispatch(token,args.body!);
  });
  await page.addInitScript(()=>{
    const fixture=window as unknown as {__TAURI_INTERNALS__:unknown;fixtureInvoke:(command:string,args:unknown)=>Promise<unknown>};
    fixture.__TAURI_INTERNALS__={invoke:(command:string,args:unknown)=>fixture.fixtureInvoke(command,args)};
  });
  try{
    await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}`);
    await page.getByRole('button',{name:'AI 与设置',exact:true}).click();
    const settings=page.locator('.settings-compact');await settings.waitFor();
    expect(await page.getByRole('switch',{name:'设置中的自动回复'}).isVisible()).toBe(true);
    const columns=await page.locator('.settings-column').evaluateAll(elements=>elements.map(element=>{
      const rect=element.getBoundingClientRect();return {x:rect.x,y:rect.y,width:rect.width,height:rect.height};
    }));
    if(viewport.width===1240){
      expect(columns[1]!.x).toBeGreaterThan(columns[0]!.x+columns[0]!.width);
      expect(Math.abs(columns[1]!.y-columns[0]!.y)).toBeLessThan(1);
    }else{
      expect(Math.abs(columns[0]!.x-columns[1]!.x)).toBeLessThan(1);
      expect(columns[1]!.y).toBeGreaterThan(columns[0]!.y+columns[0]!.height);
    }
    expect(await settings.evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(await page.locator('.settings-diagnostics').getAttribute('open')).toBeNull();
    expect(await page.locator('.settings-disclosure').first().getAttribute('open')).toBeNull();
    await page.getByText('轮询参数 · 评论 30 秒 / 私信 15 秒',{exact:true}).click();
    await page.getByRole('spinbutton',{name:'评论轮询秒数',exact:true}).fill('42');
    await page.getByText('轮询参数 · 评论 42 秒 / 私信 15 秒',{exact:true}).click();
    await page.getByText('轮询参数 · 评论 42 秒 / 私信 15 秒',{exact:true}).click();
    expect(await page.getByRole('spinbutton',{name:'评论轮询秒数',exact:true}).inputValue()).toBe('42');
    await page.getByText('轮询参数 · 评论 42 秒 / 私信 15 秒',{exact:true}).click();
    await page.getByRole('button',{name:'编辑自动回复规则',exact:true}).click();
    await page.getByRole('textbox',{name:'自动回复规则',exact:true}).fill('关闭弹窗后保留的未保存规则');
    await page.keyboard.press('Escape');
    expect(await page.getByRole('dialog',{name:'编辑自动回复规则'}).isVisible()).toBe(false);
    await page.getByRole('button',{name:'编辑自动回复规则',exact:true}).click();
    expect(await page.getByRole('textbox',{name:'自动回复规则',exact:true}).inputValue()).toBe('关闭弹窗后保留的未保存规则');
    await page.screenshot({path:join(root,`rules-${viewport.width}.png`)});
    await page.getByRole('button',{name:'完成编辑',exact:true}).click();
    await page.getByRole('button',{name:'模型详细配置',exact:true}).click();
    await page.getByRole('textbox',{name:'账号人设',exact:true}).fill('未保存的合成账号人设');
    await page.getByRole('textbox',{name:'本次 API Key',exact:true}).fill('synthetic-only-never-saved');
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'模型详细配置',exact:true}).click();
    expect(await page.getByRole('textbox',{name:'账号人设',exact:true}).inputValue()).toBe('未保存的合成账号人设');
    expect(await page.getByRole('textbox',{name:'本次 API Key',exact:true}).inputValue()).toBe('synthetic-only-never-saved');
    await page.getByRole('dialog',{name:'模型详细配置',exact:true}).getByRole('button',{name:'关闭并保留输入',exact:true}).click();
    await settings.evaluate(element=>element.scrollTop=0);
    await page.screenshot({path:join(root,`settings-${viewport.width}.png`)});
    expect(commands).not.toContain('configureAi');expect(commands).not.toContain('enableReplyPolicy');
    expect(store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
    expect(errors).toEqual([]);
    console.log('SETTINGS_SYNTHETIC_EVIDENCE',root);
  }finally{await browser.close();await server.close();await service.close();store.close();}
});