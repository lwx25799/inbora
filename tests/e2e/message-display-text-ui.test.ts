import {expect,test} from 'vitest';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {join,resolve} from 'node:path';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {candidate,database,privateTemp} from '../helpers.js';
import type {Thread} from '../../desktop/src/api.js';

test('exact display text stays readable beside uncertain media without claiming automatic reply or changing the original event',async()=>{
  const root=privateTemp('display-text-ui-'),store=database(),event=candidate({platformEventId:'77201',actorId:'200',conversationId:'conv-a',
    text:'[含媒体的消息，需人工查看]',contentType:'MIXED',observationIssue:'DM_CONTENT_UNVERIFIED'});
  store.observe('DIRECT_MESSAGE','conv-a',[],'own-1','fixture','2026-11-04T00:00:00Z');store.observe('DIRECT_MESSAGE','conv-a',[event],'own-1','fixture');
  await migrateClient(store,join(root,'backup.sqlite'));const saved=store.events()[0]!,service=new ClientService(store,new BrowserService(root));await service.loadSettings();
  const token=service.authority.issueSession();service.authority.setMode(token,'MANUAL');
  const server=await createServer({configFile:resolve('desktop/vite.config.ts'),server:{port:0,strictPort:false},logLevel:'error'});await server.listen();
  const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']}),page=await browser.newPage({viewport:{width:1240,height:800}});
  page.setDefaultTimeout(3000);const calls:string[]=[],errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  let available=true;const text='exact text [微笑] <b>stays text</b>';
  const attachments=[{kind:'IMAGE' as const,state:'UNAVAILABLE' as const,previewId:null,label:null,reason:'MESSAGE_PREVIEW_OBSCURED'}];
  await page.exposeFunction('fixtureInvoke',async(command:string,args:{body?:Record<string,unknown>})=>{
    if(command==='desktop_info')return {runtime:root,version:'synthetic-display-text'};
    if(command!=='client_request')throw Error('UNEXPECTED_NATIVE_COMMAND');const body=args.body!;calls.push(String(body.command));
    if(body.command==='connect')return service.dispatch(token,{command:'getStatus'});
    const result=await service.dispatch(token,body);
    if(body.command==='getInbox')return {...result as object,items:(result as {items:Record<string,unknown>[]}).items.map(item=>({
      ...item,attachments,previewEventId:saved.id,...(available?{displayText:text}:{})}))};
    if(body.command==='getThread'||body.command==='openHumanDialog'){
      const thread=result as Thread;thread.timeline!.items=thread.timeline!.items.map(item=>({...item,attachments,...(available?{displayText:text}:{})}));
    }
    return result;
  });
  await page.addInitScript(()=>{const fixture=window as unknown as {__TAURI_INTERNALS__:unknown;fixtureInvoke:(command:string,args:unknown)=>Promise<unknown>};
    fixture.__TAURI_INTERNALS__={invoke:(command:string,args:unknown)=>fixture.fixtureInvoke(command,args)};});
  try{
    await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}`);
    const task=page.locator('.task');await task.waitFor();expect(await task.locator('.message-text').textContent()).toBe(text.replace('[微笑]','🙂'));
    expect(await task.getByRole('img',{name:'[微笑]',exact:true}).count()).toBe(1);
    await task.click();await page.getByRole('textbox',{name:'人工回复草稿'}).waitFor();const stream=page.getByRole('log');
    expect(await stream.locator('.message-text').textContent()).toBe(text.replace('[微笑]','🙂'));
    expect(await stream.getByRole('img',{name:'[微笑]',exact:true}).count()).toBe(1);expect(await stream.locator('.message-bubble b').count()).toBe(0);
    expect(await stream.getByText('消息预览暂不可用',{exact:true}).count()).toBe(1);
    expect(await stream.getByText('此消息的其他内容仍需人工查看，暂不自动回复',{exact:true}).count()).toBe(1);
    expect(await stream.getByText(event.text,{exact:true}).count()).toBe(0);expect(store.event(saved.id)).toEqual(saved);
    expect(calls.filter(command=>['sendHumanReply','generateSuggestion','openTarget'].includes(command))).toEqual([]);expect(errors).toEqual([]);
    await page.screenshot({path:join(root,'display-text.png')});available=false;
    await page.getByRole('button',{name:'重新连接内核',exact:true}).click();await expect.poll(()=>stream.getByRole('img',{name:'[微笑]',exact:true}).count()).toBe(0);
    expect(await stream.getByText('消息预览暂不可用',{exact:true}).count()).toBe(1);expect(store.event(saved.id)).toEqual(saved);
  }finally{await browser.close();await server.close();await service.close();store.close();}
});
