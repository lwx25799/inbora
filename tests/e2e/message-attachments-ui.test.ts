import {expect,test} from 'vitest';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {join,resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {candidate,database,pending,privateTemp} from '../helpers.js';
import type {MessagePreviewAttachment} from '../../src/storage/message-previews.js';
import type {Thread} from '../../desktop/src/api.js';

test('unavailable message previews show one neutral status while ready images and actual text stay visible',async()=>{
  const root=privateTemp('message-attachments-ui-'),store=database();
  for(const index of [0,1,2])pending(store,candidate({platformEventId:`attachment-${index}`,
    text:index===1?'合成实际附加文字':'[图片或表情消息，需人工查看]',contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED',
    occurredAt:new Date(Date.UTC(2026,10,4,1,0,index)).toISOString()}));
  const ids=[0,1,2].map(index=>store.events().find(event=>event.payload.platformEventId===`attachment-${index}`)!.id);
  await migrateClient(store,join(root,'backup.sqlite'));
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();
  const token=service.authority.issueSession();service.authority.setMode(token,'MANUAL');
  const server=await createServer({configFile:resolve('desktop/vite.config.ts'),server:{port:0,strictPort:false},logLevel:'error'});
  await server.listen();const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage();
  page.setDefaultTimeout(3000);const calls:string[]=[],errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const preview=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=16;canvas.height=16;
    canvas.getContext('2d')!.fillRect(0,0,16,16);return canvas.toDataURL('image/png');});
  const unavailable:MessagePreviewAttachment[]=[
    {kind:'IMAGE',state:'UNAVAILABLE',previewId:null,label:null,reason:'MESSAGE_PREVIEW_OBSCURED'},
    {kind:'IMAGE',state:'UNAVAILABLE',previewId:null,label:'图片预览暂不可用',reason:'MESSAGE_PREVIEW_NOT_AVAILABLE'},
  ];
  let previewReady=true;
  const attachments=(eventId:string):MessagePreviewAttachment[]=>eventId===ids[0]
    ?[{kind:'IMAGE',state:previewReady?'READY':'UNAVAILABLE',previewId:'synthetic-ready',label:'合成可用图片'}]:unavailable;
  await page.exposeFunction('fixtureInvoke',async(command:string,args:{body?:Record<string,unknown>})=>{
    if(command==='desktop_info')return {runtime:root,version:'synthetic-attachments'};
    if(command!=='client_request')throw new Error('UNEXPECTED_NATIVE_COMMAND');
    const body=args.body!;calls.push(String(body.command));
    if(body.command==='connect')return service.dispatch(token,{command:'getStatus'});
    if(body.command==='getMessagePreview')return {previewId:body.previewId,mime:'image/png',dataUrl:preview,width:16,height:16};
    const result=await service.dispatch(token,body);
    if(body.command==='getInbox')return {...result as object,items:(result as {items:Record<string,unknown>[]}).items.map(item=>({
      ...item,attachments:unavailable,previewEventId:ids[2],preview:'[图片或表情消息，需人工查看]',
    }))};
    if(body.command==='getThread'||body.command==='openHumanDialog'){
      const thread=result as Thread;thread.timeline!.items=thread.timeline!.items.map(item=>({...item,attachments:attachments(item.eventId)}));
    }
    return result;
  });
  await page.addInitScript(()=>{const fixture=window as unknown as {__TAURI_INTERNALS__:unknown;fixtureInvoke:(command:string,args:unknown)=>Promise<unknown>};
    fixture.__TAURI_INTERNALS__={invoke:(command:string,args:unknown)=>fixture.fixtureInvoke(command,args)};});
  try{
    await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}`);
    await page.locator('.task').waitFor();await page.locator('.task').click();await page.getByRole('textbox',{name:'人工回复草稿'}).waitFor();
    const stream=page.getByRole('log'),messages=stream.locator('.chat-message');expect(await messages.count()).toBe(3);
    try{await messages.nth(0).getByRole('img',{name:'合成可用图片'}).waitFor();}
    catch(error){await writeFile(join(root,'failure.json'),JSON.stringify({calls,errors,html:await stream.innerHTML()},null,2));throw error;}
    expect(await messages.nth(1).getByText('合成实际附加文字',{exact:true}).count()).toBe(1);
    expect(await messages.nth(0).getByText('消息预览暂不可用',{exact:true}).count()).toBe(0);
    const list=page.locator('.task'),unknown=messages.nth(2);
    expect(await unknown.locator('.attachment-unavailable').count()).toBe(1);
    for(const surface of [list,messages.nth(1),unknown])expect(await surface.getByText('消息预览暂不可用',{exact:true}).count()).toBe(1);
    expect(await unknown.locator('.message-quality').innerText()).toContain('AI不会自动处理');
    for(const surface of [list,unknown]){
      expect(await surface.getByText('[图片或表情消息，需人工查看]',{exact:true}).count()).toBe(0);
      expect(await surface.getByText('图片预览暂不可用',{exact:true}).count()).toBe(0);
      expect(await surface.getByText(/分享视频|分享图集/).count()).toBe(0);
    }
    expect(calls.filter(command=>['sendHumanReply','generateSuggestion','openTarget'].includes(command))).toEqual([]);
    expect(errors).toEqual([]);await page.screenshot({path:join(root,'neutral-preview.png')});
    const reads=calls.filter(command=>command==='getMessagePreview').length;
    previewReady=false;await page.getByRole('button',{name:'重新连接内核',exact:true}).click();
    await expect.poll(()=>messages.nth(0).getByRole('img').count()).toBe(0);
    previewReady=true;await page.getByRole('button',{name:'重新连接内核',exact:true}).click();
    await expect.poll(()=>calls.filter(command=>command==='getMessagePreview').length).toBe(reads+1);
    await messages.nth(0).getByRole('img',{name:'合成可用图片'}).waitFor();
    expect(await page.getByRole('button',{name:'在专属浏览器查看原对象',exact:true}).count()).toBe(0);
  }finally{await browser.close();await server.close();await service.close();store.close();}
});
