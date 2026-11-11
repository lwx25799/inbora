import {expect,test} from 'vitest';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {join,resolve} from 'node:path';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {candidate,database,privateTemp} from '../helpers.js';
import type {Thread} from '../../desktop/src/api.js';

test('current, historical and own cached media refresh independently without selecting a reply target or changing a human draft',async()=>{
  const root=privateTemp('preview-refresh-ui-'),store=database(),event=candidate({platformEventId:'77301',actorId:'200',conversationId:'conv-a',
    text:'[图片或表情消息，需人工查看]',contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED'});
  store.observe('DIRECT_MESSAGE','conv-a',[],'own-1','fixture','2026-11-04T00:00:00Z');store.observe('DIRECT_MESSAGE','conv-a',[event],'own-1','fixture');
  const saved=store.events()[0]!;await migrateClient(store,join(root,'backup.sqlite'));const service=new ClientService(store,new BrowserService(root));await service.loadSettings();
  const token=service.authority.issueSession();service.authority.setMode(token,'MANUAL');
  const server=await createServer({configFile:resolve('desktop/vite.config.ts'),server:{port:0,strictPort:false},logLevel:'error'});await server.listen();
  const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']}),page=await browser.newPage({viewport:{width:1240,height:800}});
  page.setDefaultTimeout(2500);const calls:{command:string;eventId?:unknown;refresh?:unknown;previewId?:unknown}[]=[],errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));let release:(value:unknown)=>void=()=>{};
  const historicalId='6704ab5e-914d-4f6b-bd58-ad3813d97d07',ownId='5df61114-2173-49a8-aa30-807133d01447';
  const attachments=[{kind:'IMAGE' as const,state:'UNAVAILABLE' as const,previewId:null,label:null,reason:'MESSAGE_PREVIEW_SHARE_LINK_UNVERIFIED'}];
  await page.exposeFunction('fixtureInvoke',async(command:string,args:{body?:Record<string,unknown>})=>{
    if(command==='desktop_info')return {runtime:root,version:'synthetic-preview-refresh'};
    if(command!=='client_request')throw Error('UNEXPECTED_NATIVE_COMMAND');const body=args.body!;calls.push({command:String(body.command),eventId:body.eventId,refresh:body.refresh,previewId:body.previewId});
    if(body.command==='connect')return service.dispatch(token,{command:'getStatus'});
    if(body.command==='getMessagePreview'&&body.refresh===true)return new Promise(resolve=>{release=resolve;});
    const result=await service.dispatch(token,body);
    if(body.command==='getThread'||body.command==='openHumanDialog'){
      const thread=result as Thread,original=thread.timeline!.items.find(item=>item.eventId===saved.id)!;
      thread.timeline!.items=[{...original,id:'in:'+saved.id,eventId:saved.id,attachments},
        {...original,id:'in:'+historicalId,eventId:historicalId,historical:true,attachments:[]},
        {...original,id:'observed:'+ownId,eventId:ownId,direction:'OUTGOING',historical:true,attachments},
        {...original,id:'observed:unverified',eventId:'unverified',direction:'OUTGOING',historical:true,attachments}];
    }
    return result;
  });
  await page.addInitScript(()=>{const fixture=window as unknown as {__TAURI_INTERNALS__:unknown;fixtureInvoke:(command:string,args:unknown)=>Promise<unknown>};
    fixture.__TAURI_INTERNALS__={invoke:(command:string,args:unknown)=>fixture.fixtureInvoke(command,args)};});
  try{
    await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}`);await page.locator('.task').waitFor();await page.locator('.task').click();
    const draft=page.getByRole('textbox',{name:'人工回复草稿'});await draft.waitFor();await draft.fill('unsaved human text');
    const rows=page.getByRole('log').locator('.chat-message'),buttons=page.getByRole('log').getByRole('button',{name:'更新预览',exact:true});
    expect(await page.getByRole('log').getByText('分享作品链接暂未取得',{exact:true}).count()).toBe(3);
    expect(await buttons.count()).toBe(3);expect(await page.locator('.task button').count()).toBe(0);
    const selectedBefore=calls.filter(c=>c.command==='selectTarget').length;
    const unverified=rows.filter({hasText:'消息身份暂不可核对，无法更新预览'});
    expect(await unverified.count()).toBe(1);expect(await unverified.getByRole('button',{name:'更新预览',exact:true}).count()).toBe(0);
    const cases=[{id:saved.id,row:rows.filter({hasText:'当前查看消息'})},
      {id:historicalId,row:page.getByRole('log').locator('.chat-message.incoming').filter({hasText:'历史消息'})},
      {id:ownId,row:page.getByRole('log').locator('.chat-message.outgoing').filter({hasNotText:'消息身份暂不可核对'})}];
    for(const [index,{id,row}] of cases.entries()){
      const button=row.getByRole('button',{name:'更新预览',exact:true});await button.click();
      await expect.poll(()=>calls.filter(c=>c.command==='getMessagePreview'&&c.refresh===true).length).toBe(index+1);
      expect(await button.isDisabled()).toBe(true);expect(await draft.inputValue()).toBe('unsaved human text');
      release({scheduled:index!==1});await expect.poll(()=>button.isDisabled()).toBe(false);
      expect(calls.filter(c=>c.command==='getMessagePreview'&&c.refresh===true).at(-1)).toEqual({command:'getMessagePreview',eventId:id,refresh:true,previewId:undefined});
      expect(await row.getByText(index===1?'暂时无法更新，请稍后再试':'已请求更新预览，结果会自动显示',{exact:true}).count()).toBe(1);
      expect(await row.getByText(index===1?'消息预览暂不可用':'分享作品链接暂未取得',{exact:true}).count()).toBe(1);
    }
    expect(calls.filter(c=>c.command==='selectTarget').length).toBe(selectedBefore);expect(await draft.inputValue()).toBe('unsaved human text');
    expect(calls.some(c=>['sendHumanReply','generateSuggestion','syncInbox','openTarget'].includes(c.command))).toBe(false);
    expect(store.event(saved.id)).toEqual(saved);expect(errors).toEqual([]);await page.screenshot({path:join(root,'preview-refresh.png')});
  }finally{release({scheduled:false});await browser.close();await server.close();await service.close();store.close();}
});
