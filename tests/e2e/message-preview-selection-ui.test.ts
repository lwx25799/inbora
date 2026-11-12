import {expect,test} from 'vitest';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {join,resolve} from 'node:path';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {candidate,database,privateTemp} from '../helpers.js';
import type {Thread} from '../../desktop/src/api.js';

test('viewing an older native media message opens its browser conversation without changing the reply selection or human draft',async()=>{
  const root=privateTemp('preview-selection-ui-'),store=database();
  const media=(id:string,at:number)=>candidate({platformEventId:id,actorId:'200',conversationId:'conv-a',
    text:'[图片或表情消息，需人工查看]',contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED',occurredAt:new Date(at).toISOString()});
  const old=media('99201',Date.UTC(2026,10,4,1)),latest=media('99202',Date.UTC(2026,10,4,2));
  store.observe('DIRECT_MESSAGE','conv-a',[],'own-1','fixture','2026-11-04T00:00:00Z');
  store.observe('DIRECT_MESSAGE','conv-a',[old,latest],'own-1','fixture','2026-11-04T03:00:00Z');
  const oldId=store.events().find(item=>item.payload.platformEventId==='99201')!.id,latestId=store.events().find(item=>item.payload.platformEventId==='99202')!.id;
  await migrateClient(store,join(root,'backup.sqlite'));const service=new ClientService(store,new BrowserService(root));await service.loadSettings();
  const token=service.authority.issueSession();service.authority.setMode(token,'MANUAL');
  const server=await createServer({configFile:resolve('desktop/vite.config.ts'),server:{port:0,strictPort:false},logLevel:'error'});await server.listen();
  const browser=await chromium.launchPersistentContext(resolve('.local/display-witness-smoke/source/profile'),{channel:'msedge',headless:true,args:['--mute-audio'],viewport:{width:1240,height:800}}),page=await browser.newPage();
  page.setDefaultTimeout(3000);const calls:{command:string;eventId:unknown;visible:unknown}[]=[],errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.exposeFunction('fixtureInvoke',async(command:string,args:{body?:Record<string,unknown>})=>{
    if(command==='desktop_info')return {runtime:root,version:'synthetic-exact-selection'};
    if(command!=='client_request')throw Error('UNEXPECTED_NATIVE_COMMAND');const body=args.body!;calls.push({command:String(body.command),eventId:body.eventId,visible:body.visible});
    if(body.command==='openTarget')return {opened:true,located:true};
    if(body.command==='connect')return service.dispatch(token,{command:'getStatus'});const result=await service.dispatch(token,body);
    if(body.command==='getThread'||body.command==='openHumanDialog'){
      const thread=result as Thread,template=thread.timeline!.items.find(item=>item.eventId===oldId)!;
      thread.timeline!.projectionRevision='synthetic-selection-fixture';
      thread.timeline!.items=[{...template,id:'synthetic-history',historical:true},
        {...template,id:'synthetic-own',eventId:'223a7a41-95da-4d5c-85bd-e779a86dd533',direction:'OUTGOING'},...thread.timeline!.items];
    }
    return result;
  });
  await page.addInitScript(()=>{const fixture=window as unknown as {__TAURI_INTERNALS__:unknown;fixtureInvoke:(command:string,args:unknown)=>Promise<unknown>};
    fixture.__TAURI_INTERNALS__={invoke:(command:string,args:unknown)=>fixture.fixtureInvoke(command,args)};});
  try{
    await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}`);await page.locator('.task').waitFor();await page.locator('.task').click();
    const editor=page.getByRole('textbox',{name:'人工回复草稿'});await editor.waitFor();await editor.fill('查看旧消息时保留的人稿');const messages=page.getByRole('log').locator('.chat-message');
    const own=page.getByRole('log').locator('.chat-message.outgoing'),history=messages.filter({hasText:'历史消息'});
    const eligible=page.getByRole('log').locator('.chat-message.incoming').filter({hasNotText:'历史消息'});
    expect(await messages.count()).toBe(4);expect(await history.getByRole('button',{name:'查看这条消息',exact:true}).count()).toBe(1);
    expect(await own.getByRole('button',{name:'查看这条消息',exact:true}).count()).toBe(1);
    expect(await eligible.nth(1).getByText(/当前查看消息/u).count()).toBe(1);
    const selections=calls.filter(call=>call.command==='selectTarget').length;
    await eligible.nth(0).getByRole('button',{name:'查看这条消息',exact:true}).click();
    await expect.poll(()=>calls.filter(call=>call.command==='openTarget').length).toBe(1);
    expect(calls.filter(call=>call.command==='openTarget').at(-1)).toEqual({command:'openTarget',eventId:oldId,visible:true});
    await eligible.nth(0).getByRole('status').getByText('已在浏览器打开会话',{exact:true}).waitFor();
    expect(calls.filter(call=>call.command==='selectTarget')).toHaveLength(selections);
    expect(await eligible.nth(1).getByText(/当前查看消息/u).count()).toBe(1);expect(await editor.inputValue()).toBe('查看旧消息时保留的人稿');
    expect(await eligible.nth(0).getByRole('button',{name:'查看这条消息',exact:true}).count()).toBe(1);
    expect(await eligible.nth(1).getByRole('button',{name:'查看这条消息',exact:true}).count()).toBe(1);
    expect(calls.some(call=>['sendHumanReply','generateSuggestion','syncInbox','getMessagePreview'].includes(call.command))).toBe(false);expect(errors).toEqual([]);
    expect(store.events()).toHaveLength(2);expect(store.events().some(item=>item.id===latestId)).toBe(true);await page.screenshot({path:join(root,'old-media-selected.png')});
  }finally{await browser.close();await server.close();await service.close();store.close();}
});
