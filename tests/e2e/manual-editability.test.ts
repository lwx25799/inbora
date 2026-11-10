import {expect,test} from 'vitest';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {join,resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {candidate,database,pending,privateTemp} from '../helpers.js';

test.each([
  {mode:'MANUAL',comment:false},{mode:'MANUAL',comment:true},
  {mode:'LIMITED_AUTO',comment:false},{mode:'LIMITED_AUTO',comment:true},
] as const)('ordinary $mode draft remains editable, clears durably and reopens empty (comment=$comment)',async({mode,comment})=>{
  const root=privateTemp('manual-editability-'),store=database();
  const id=pending(store,candidate({platformEventId:comment?'1101':'3001',actorName:'普通草稿测试联系人',
    ...(comment?{channel:'COMMENT_NOTIFICATION',kind:'COMMENT',videoId:'1001',commentId:'1101',conversationId:null}:{}),text:'普通草稿编辑测试入站'}));
  await migrateClient(store,join(root,'client.sqlite'));
  class FixtureBrowser extends BrowserService {override async close(){}}
  const service=new ClientService(store,new FixtureBrowser(root));await service.loadSettings();
  const token=service.authority.issueSession();
  if(mode==='LIMITED_AUTO')await service.dispatch(token,{command:'setReplyPolicy',confirmed:true,policy:{ownId:'own-1',
    channels:['DIRECT_MESSAGE','COMMENT_NOTIFICATION'],model:'deepseek-flash',modelLimit:1,sendLimit:1,expiresAt:null,
    workIds:['1001'],futureOwnWorks:false,conversationIds:[],entireInbox:true,containsAny:['never-match'],excludesAny:[],
    instructions:'Synthetic no-send test',startHour:0,endHour:24}});
  else service.authority.setMode(token,mode);
  const server=await createServer({configFile:resolve('desktop/vite.config.ts'),server:{port:0,strictPort:false},logLevel:'error'});await server.listen();
  const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage();page.setDefaultTimeout(3000);
  const calls:Record<string,unknown>[]=[],errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.exposeFunction('fixtureInvoke',async(command:string,args:{body?:Record<string,unknown>})=>{
    if(command==='desktop_info')return {runtime:root,version:'synthetic-editability'};
    if(command!=='client_request')throw new Error('UNEXPECTED_NATIVE_COMMAND');
    calls.push(args.body!);return service.dispatch(token,args.body!);
  });
  await page.addInitScript(()=>{
    const fixture=window as unknown as {__TAURI_INTERNALS__:unknown;fixtureInvoke:(command:string,args:unknown)=>Promise<unknown>};
    fixture.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:async(command:string,args:unknown)=>{
      if(command.startsWith('plugin:event|'))return 1;
      try{return await fixture.fixtureInvoke(command,args);}catch(error){throw error instanceof Error?error.message:error;}
    }};
  });
  try{
    await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}`);
    const open=async()=>{
      await page.locator('.task').click();
      if(comment)await page.getByRole('button',{name:'打开人工回复',exact:true}).click();
    };
    await open();const editor=page.getByRole('textbox',{name:'人工回复草稿'});await editor.waitFor();
    expect(await editor.isEditable()).toBe(true);await editor.fill('已保存的普通草稿');
    await expect.poll(()=>service.authority.draftFor(id)?.text).toBe('已保存的普通草稿');
    expect(await editor.isEditable()).toBe(true);await editor.fill('保存之后仍能修改');
    await expect.poll(()=>service.authority.draftFor(id)?.text).toBe('保存之后仍能修改');
    await page.getByRole('button',{name:'清空',exact:true}).click();
    await expect.poll(()=>service.authority.draftFor(id)?.text).toBe('');
    expect(await editor.inputValue()).toBe('');await page.reload();await open();
    await expect.poll(()=>editor.inputValue()).toBe('');expect(await editor.isEditable()).toBe(true);
    expect(calls.some(c=>['sendHumanReply','generateSuggestion'].includes(c.command as string))).toBe(false);
    expect(store.db.prepare('SELECT COUNT(*) n FROM send_intents').get()).toEqual({n:0});expect(errors).toEqual([]);
  }finally{
    await writeFile(join(root,'result.json'),JSON.stringify({calls,errors},null,2));
    await browser.close();await server.close();await service.close();store.close();
  }
});
