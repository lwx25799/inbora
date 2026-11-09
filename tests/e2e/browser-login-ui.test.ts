import {expect,test} from 'vitest';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {join,resolve} from 'node:path';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {database,privateTemp} from '../helpers.js';

test('settings reserves a visible browser for explicit login and offers a headless recovery without changing reply policy',async()=>{
  const root=privateTemp('browser-login-ui-'),store=database();await migrateClient(store,join(root,'backup.sqlite'));
  class LoginBrowser extends BrowserService{
    recovering=false;
    override get loginRecovery(){return this.recovering;}
    override status(){return {state:this.recovering?'LOGIN_RECOVERY':'CLOSED',mode:this.recovering?'headed' as const:'headless' as const,
      loginRecovery:this.recovering,version:null};}
    override async beginLoginRecovery(){this.recovering=true;}
    override async finishLoginRecovery(){this.recovering=false;return true;}
    override async close(){}
  }
  const native=new LoginBrowser(root),service=new ClientService(store,native);await service.loadSettings();const token=service.authority.issueSession();
  const server=await createServer({configFile:resolve('desktop/vite.config.ts'),server:{port:0,strictPort:false},logLevel:'error'});
  await server.listen();const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage();page.setDefaultTimeout(3000);
  const calls:Record<string,unknown>[]=[],errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.exposeFunction('fixtureInvoke',async(command:string,args:{body?:Record<string,unknown>})=>{
    if(command==='desktop_info')return {runtime:root,version:'synthetic-login'};
    if(command!=='client_request')throw new Error('UNEXPECTED_NATIVE_COMMAND');
    const body=args.body!;calls.push(body);return service.dispatch(token,body);
  });
  await page.addInitScript(()=>{const fixture=window as unknown as {__TAURI_INTERNALS__:unknown;fixtureInvoke:(command:string,args:unknown)=>Promise<unknown>};
    fixture.__TAURI_INTERNALS__={invoke:(command:string,args:unknown)=>fixture.fixtureInvoke(command,args)};});
  try{
    await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}`);
    await page.getByRole('button',{name:'AI 与设置',exact:true}).click();
    await expect.poll(()=>calls.filter(body=>body.command==='browser'&&body.action==='inspectSavedDraftRecovery').length).toBe(1);
    expect(await page.getByRole('button',{name:'打开专属浏览器',exact:true}).count()).toBe(0);
    await page.getByRole('button',{name:'登录或处理验证码',exact:true}).click();
    await page.getByText('浏览器：等待本人登录，完成后自动恢复无头运行',{exact:true}).waitFor();
    expect(calls.filter(body=>body.command==='browser')).toEqual([
      {command:'browser',action:'inspectSavedDraftRecovery'},{command:'browser',open:true,mode:'headed',loginRecovery:true},
    ]);
    await page.getByRole('button',{name:'返回无头运行',exact:true}).click();
    await expect.poll(()=>native.loginRecovery).toBe(false);
    expect(calls.filter(body=>body.command==='browser')).toEqual([
      {command:'browser',action:'inspectSavedDraftRecovery'},
      {command:'browser',open:true,mode:'headed',loginRecovery:true},{command:'browser',open:true,mode:'headless'},
    ]);
    expect(calls.filter(body=>body.command==='browser'&&body.action==='clearSavedDraftRecovery')).toEqual([]);
    expect(calls.some(body=>['sendHumanReply','generateSuggestion','setAutomaticReply','enableReplyPolicy'].includes(String(body.command)))).toBe(false);
    expect(errors).toEqual([]);
  }finally{await browser.close();await server.close();await service.close();store.close();}
});
