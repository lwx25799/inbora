import {expect,test} from 'vitest';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {join,resolve} from 'node:path';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {candidate,database,pending,privateTemp} from '../helpers.js';
import type {Thread} from '../../desktop/src/api.js';

test('explicit visible viewing covers exact current, historical and own media without choosing a reply, and stale or failed results never claim success',async()=>{
  const root=privateTemp('message-visible-view-ui-'),store=database();
  const media=(id:string,conversationId:string,name:string)=>candidate({platformEventId:id,conversationId,actorName:name,
    text:'[图片或表情消息，需人工查看]',contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED'});
  pending(store,media('88101','visible-a','查看目标A'));pending(store,media('88102','visible-b','查看目标B'));
  const a=store.events().find(row=>row.payload.platformEventId==='88101')!.id,b=store.events().find(row=>row.payload.platformEventId==='88102')!.id;
  await migrateClient(store,join(root,'backup.sqlite'));const service=new ClientService(store,new BrowserService(root));await service.loadSettings();
  const token=service.authority.issueSession();service.authority.setMode(token,'MANUAL');
  const server=await createServer({configFile:resolve('desktop/vite.config.ts'),server:{port:0,strictPort:false},logLevel:'error'});await server.listen();
  const browser=await chromium.launchPersistentContext(resolve('.local/display-witness-smoke/source/profile'),{channel:'msedge',headless:true,args:['--mute-audio']});
  const page=await browser.newPage();page.setDefaultTimeout(2500);const calls:Record<string,unknown>[]=[],errors:string[]=[];
  const historical='3720d3c7-5f03-463a-8556-cac422e25490',own='9f675486-d920-4378-b2cb-4d4e8d369840';
  let release:(result:unknown)=>void=()=>{},reject:(error:string)=>void=()=>{};page.on('pageerror',error=>errors.push(error.message));
  await page.exposeFunction('fixtureInvoke',async(command:string,args:{body?:Record<string,unknown>})=>{
    if(command==='desktop_info')return {runtime:root,version:'synthetic-visible-view'};
    if(command!=='client_request')throw Error('UNEXPECTED_NATIVE_COMMAND');const body=args.body!;calls.push(body);
    if(body.command==='connect')return service.dispatch(token,{command:'getStatus'});
    if(body.command==='openTarget')return new Promise((yes,no)=>{release=yes;reject=no;});
    const result=await service.dispatch(token,body);
    if(body.command==='getThread'||body.command==='openHumanDialog'){
      const thread=result as Thread,original=thread.timeline!.items.find(item=>item.eventId===body.eventId)!;
      const attachments=[{kind:'IMAGE' as const,state:'UNAVAILABLE' as const,previewId:null,label:null,reason:'MESSAGE_PREVIEW_SHARE_LINK_UNVERIFIED'}];
      thread.timeline!.items=body.eventId===a?[{...original,attachments},
        {...original,id:'in:'+historical,eventId:historical,historical:true,attachments},
        {...original,id:'observed:'+own,eventId:own,direction:'OUTGOING',historical:true,attachments},
        {...original,id:'out:synthetic',origin:'CONFIRMED',direction:'OUTGOING',attachments},
        {...original,id:'observed:invalid',eventId:'invalid',direction:'OUTGOING',attachments},
        {...original,id:'in:video',eventId:'20263bc5-1449-4873-857d-a246fc59fa5a',contentType:'VIDEO',text:'[视频消息，需人工查看]',attachments:[]},
        {...original,id:'in:audio',eventId:'36fb61b6-b770-4f2c-afd9-a5d0877e10ea',contentType:'AUDIO',text:'[音频消息，需人工查看]',attachments:[]},
        {...original,id:'in:plain',text:'普通完整文字',contentType:undefined,observationIssue:undefined,attachments:[]}]:[{...original,attachments}];
    }
    return result;
  });
  await page.addInitScript(()=>{const fixture=window as unknown as {__TAURI_INTERNALS__:unknown;fixtureInvoke:(command:string,args:unknown)=>Promise<unknown>};
    fixture.__TAURI_INTERNALS__={invoke:(command:string,args:unknown)=>fixture.fixtureInvoke(command,args)};});
  try{
    await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}`);await page.getByRole('button',{name:/查看目标A/}).click();
    const editor=page.getByRole('textbox',{name:'人工回复草稿'});await editor.waitFor();await editor.fill('查看不改变这份人工草稿');
    const messages=page.getByRole('log').locator('.chat-message'),view=page.getByRole('log').getByRole('button',{name:'查看这条消息',exact:true});
    await expect.poll(()=>view.count()).toBe(5);const selections=calls.filter(row=>row.command==='selectTarget').length;
    expect(await messages.filter({hasText:'[视频消息，需人工查看]'}).getByRole('button',{name:'查看这条消息',exact:true}).count()).toBe(1);
    expect(await messages.filter({hasText:'[音频消息，需人工查看]'}).getByRole('button',{name:'查看这条消息',exact:true}).count()).toBe(1);
    const current=messages.filter({hasText:'当前查看消息'}),history=page.getByRole('log').locator('.incoming').filter({hasText:'历史消息'});
    const ownRow=page.getByRole('log').locator('.outgoing').filter({hasText:'历史消息'});
    for(const [index,{row,id,result}]of [{row:current,id:a,result:{opened:true,located:true}},
      {row:history,id:historical,result:{opened:true,located:false}},{row:ownRow,id:own,result:null}].entries()){
      const button=row.getByRole('button',{name:'查看这条消息',exact:true});await button.click();
      await expect.poll(()=>calls.filter(call=>call.command==='openTarget').length).toBe(index+1);
      expect(await button.isDisabled()).toBe(true);await button.evaluate(node=>(node as HTMLButtonElement).click());
      expect(calls.filter(call=>call.command==='openTarget')).toHaveLength(index+1);
      expect(calls.filter(call=>call.command==='openTarget').at(-1)).toEqual({command:'openTarget',eventId:id,visible:true});
      if(result)release(result);else reject('PRIVATE_INTERNAL_ERROR');
      await expect.poll(()=>button.isDisabled()).toBe(false);
      const expected=index<2?'已在浏览器打开会话':'暂时无法打开这条消息，请稍后再试';
      await row.getByRole('status').getByText(expected,{exact:true}).waitFor();expect(await editor.inputValue()).toBe('查看不改变这份人工草稿');
    }
    await current.getByRole('button',{name:'查看这条消息',exact:true}).click();await expect.poll(()=>calls.filter(row=>row.command==='openTarget').length).toBe(4);
    release({opened:false,located:true});await current.getByRole('status').getByText('暂时无法打开这条消息，请稍后再试',{exact:true}).waitFor();
    expect(await current.getByText('已在浏览器打开会话',{exact:true}).count()).toBe(0);
    await current.getByRole('button',{name:'查看这条消息',exact:true}).click();await expect.poll(()=>calls.filter(row=>row.command==='openTarget').length).toBe(5);
    await page.getByRole('button',{name:/查看目标B/}).click();await page.getByRole('heading',{name:'查看目标B',exact:true}).waitFor();await editor.fill('B的独立人工草稿');
    release({opened:true,located:true});await new Promise(resolve=>setTimeout(resolve,100));
    expect(await page.getByText('已在浏览器打开会话',{exact:true}).count()).toBe(0);expect(await editor.inputValue()).toBe('B的独立人工草稿');
    await page.getByRole('log').getByRole('button',{name:'查看这条消息',exact:true}).click();await expect.poll(()=>calls.filter(row=>row.command==='openTarget').length).toBe(6);
    await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'AI 与设置',exact:true}).click();
    release({opened:true,located:true});await new Promise(resolve=>setTimeout(resolve,100));
    expect(await page.getByText('已在浏览器打开会话',{exact:true}).count()).toBe(0);
    expect(calls.filter(row=>row.command==='selectTarget')).toHaveLength(selections+1);
    expect(calls.some(row=>['sendHumanReply','sendHumanFollowup','generateSuggestion','syncInbox','getMessagePreview'].includes(String(row.command)))).toBe(false);
    expect(errors).toEqual([]);expect(store.events()).toHaveLength(2);expect(store.event(b).payload.platformEventId).toBe('88102');
  }finally{release({opened:false,located:false});await browser.close();await server.close();await service.close();store.close();}
});
