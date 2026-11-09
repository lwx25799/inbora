import {expect,test} from 'vitest';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {join,resolve} from 'node:path';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {candidate,database,pending,privateTemp} from '../helpers.js';

interface SharedWork {kind:'DOUYIN_WORK';url:string;workId:string}
async function setup(share:SharedWork,copyFails=false,viewport={width:900,height:640},text='[图片或表情消息，需人工查看]'){
  const root=privateTemp('shared-work-ui-'),store=database();
  const id=pending(store,candidate({text,contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED',actorName:'合成作品分享联系人'}));
  await migrateClient(store,join(root,'client.sqlite'));const service=new ClientService(store,new BrowserService(root));await service.loadSettings();
  const token=service.authority.issueSession();service.authority.setMode(token,'MANUAL');
  const server=await createServer({configFile:resolve('desktop/vite.config.ts'),server:{port:0,strictPort:false},logLevel:'error'});await server.listen();
  const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport});page.setDefaultTimeout(3000);
  const commands:string[]=[],errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.exposeFunction('fixtureInvoke',async(command:string,args:{body?:Record<string,unknown>})=>{
    if(command==='desktop_info')return {runtime:root,version:'synthetic-share'};
    if(command!=='client_request')throw new Error('UNEXPECTED_NATIVE_COMMAND');
    const body=args.body!;commands.push(body.command as string);const result=await service.dispatch(token,body);
    if(body.command==='getInbox')return {...result as object,items:(result as {items:Record<string,unknown>[]}).items.map(item=>({...item,share,attachments:[{kind:'IMAGE',state:'READY',previewId:'old-thumbnail'}]}))};
    if(body.command==='getThread'||body.command==='openHumanDialog'){
      const thread=result as {timeline:{items:Record<string,unknown>[]}};
      thread.timeline.items=thread.timeline.items.map(item=>({...item,share,attachments:[{kind:'IMAGE',state:'READY',previewId:'old-thumbnail'}]}));
    }
    return result;
  });
  await page.addInitScript(copyFails=>{
    const fixture=window as unknown as {__TAURI_INTERNALS__:unknown;fixtureInvoke:(command:string,args:unknown)=>Promise<unknown>;copiedLinks:string[]};
    fixture.__TAURI_INTERNALS__={invoke:(command:string,args:unknown)=>fixture.fixtureInvoke(command,args)};fixture.copiedLinks=[];
    Object.defineProperty(navigator,'clipboard',{value:{writeText:async(text:string)=>{if(copyFails)throw new Error('PRIVATE_CLIPBOARD_ERROR');fixture.copiedLinks.push(text);}}});
  },copyFails);
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}`);await page.getByRole('heading',{name:'收件箱',exact:true}).waitFor();
  return {root,id,page,commands,errors,close:async()=>{await browser.close();await server.close();await service.close();store.close();}};
}

test.each([{type:'video',label:'视频',width:900,height:640},{type:'note',label:'图集',width:1240,height:800}])('a shared $type is an exact selectable link with explicit copy and no navigation or old image preview',async example=>{
  const share:SharedWork={kind:'DOUYIN_WORK',url:`https://www.douyin.com/${example.type}/7312345678901234567`,workId:'7312345678901234567'};
  const f=await setup(share,false,example);try{
    const original=f.page.url();expect(await f.page.locator('.task').innerText()).toContain(`分享${example.label}`);
    await f.page.locator('.task').click();const stream=f.page.getByRole('log');
    const link=stream.getByRole('textbox',{name:`分享${example.label}链接`});await link.waitFor();expect(await link.inputValue()).toBe(share.url);
    expect(await link.getAttribute('readonly')).not.toBeNull();expect(await stream.getByRole('img').count()).toBe(0);
    expect(await stream.getByText('[图片或表情消息，需人工查看]',{exact:true}).count()).toBe(0);
    expect(await f.page.locator('a[href^="https://www.douyin.com/"]').count()).toBe(0);
    expect(await f.page.evaluate(()=>(window as unknown as {copiedLinks:string[]}).copiedLinks)).toEqual([]);
    await stream.getByRole('button',{name:`复制${example.label}链接`,exact:true}).click();
    expect(await f.page.evaluate(()=>(window as unknown as {copiedLinks:string[]}).copiedLinks)).toEqual([share.url]);expect(f.page.url()).toBe(original);
    expect(f.commands.some(command=>['getMessagePreview','openTarget','sendHumanReply','generateSuggestion'].includes(command))).toBe(false);
    expect(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(f.errors).toEqual([]);
    await f.page.screenshot({path:join(f.root,`share-${example.type}.png`)});
  }finally{await f.close();}
});

test('clipboard failure keeps the exact URL selectable with a fixed short recovery hint',async()=>{
  const share:SharedWork={kind:'DOUYIN_WORK',url:'https://www.douyin.com/video/7312345678901234567',workId:'7312345678901234567'};
  const f=await setup(share,true,{width:900,height:640},'对方附加的真实文字仍保留');try{
    await f.page.locator('.task').click();const stream=f.page.getByRole('log');
    await stream.getByRole('button',{name:'复制视频链接',exact:true}).click();
    await stream.getByText('请选中链接后复制',{exact:true}).waitFor();expect(await stream.getByRole('textbox',{name:'分享视频链接'}).inputValue()).toBe(share.url);
    expect(await stream.getByText('对方附加的真实文字仍保留',{exact:true}).count()).toBe(1);
    expect(await f.page.locator('body').innerText()).not.toContain('PRIVATE_CLIPBOARD_ERROR');expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test.each([
  {url:'https://www.douyin.com.evil.example/video/7312345678901234567',workId:'7312345678901234567'},
  {url:'https://www.douyin.com/video/7312345678901234567',workId:'999'},
])('an untrusted or mismatched work URL is never rendered as a copyable share link: $url',async share=>{
  const f=await setup({kind:'DOUYIN_WORK',...share});try{
    await f.page.locator('.task').click();await f.page.getByRole('textbox',{name:'人工回复草稿'}).waitFor();
    expect(await f.page.getByRole('button',{name:/复制.*链接/}).count()).toBe(0);
    expect(await f.page.locator('body').innerText()).not.toContain(share.url);
    expect(await f.page.locator('body').innerText()).not.toContain('evil.example');expect(f.errors).toEqual([]);
  }finally{await f.close();}
});
