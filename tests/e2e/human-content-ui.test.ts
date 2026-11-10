import {expect,test} from 'vitest';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {join,resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {AccountActor} from '../../src/browser/account-actor.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {MessageShareStore} from '../../src/storage/message-shares.js';
import {digest,eventBinding,targetKey,type InboundEvent,type TargetSnapshot} from '../../src/core/contracts.js';
import type {EventStore} from '../../src/storage/store.js';
import {candidate,database,pending,privateTemp,snapshot} from '../helpers.js';

class HumanContentBrowser extends BrowserService {
  private queue=new AccountActor();clicks=0;unknown=false;prepared:string[]=[];
  override get actor(){return this.queue;}
  override identity(){return {identityDigest:digest('own-1'),mappingDigest:'synthetic-human-content',browserVersion:'fixture',browserMode:'headed' as const};}
  override async refreshIdentity(){return this.identity();}
  override async close(){}
  override async adapter(event:InboundEvent,_store?:EventStore,_signal?:AbortSignal,options?:{manualMedia?:boolean}){
    let text='';const inspect=():TargetSnapshot=>{
      const current=snapshot(event);if(!options?.manualMedia)return current;
      const contextDigest=digest('same-native-window');return {...current,contextDigest,manualObservation:{
        kind:'DM_MEDIA',channel:'DIRECT_MESSAGE',eventBinding:eventBinding(event),contextDigest,contentType:event.contentType!,
        nativeKind:800,mediaDigest:digest('stable-exact-media'),freshExact:true,
      }};
    };
    return {dispose:()=>{},adapter:{
    inspect:async()=>inspect(),prepare:async(_event:InboundEvent,value:string)=>{text=value;this.prepared.push(value);},
    verifyPrepared:async()=>inspect(),baseline:async()=>[],clickOnce:async()=>{this.clicks++;await new Promise(resolve=>setTimeout(resolve,3));},
    readback:async()=>this.unknown?null:{id:randomUUID(),ownId:'own-1',targetKey:targetKey(event),text,pending:false,sentAt:new Date().toISOString()},
  }};}
}
async function setup({share=false,unknown=false,comment=false,modelAuthorized=false,legacy=false}:{share?:boolean;unknown?:boolean;comment?:boolean;modelAuthorized?:boolean;legacy?:boolean}={}){
  const store=database(),root=privateTemp('human-content-ui-');
  const payload=comment?candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',videoId:'work',commentId:'parent',conversationId:null,
    observationIssue:'COMMENT_TEXT_UNVERIFIED',actorName:'合成人工内容联系人'}):
    candidate({text:'[图片或表情消息，需人工查看]',contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED',actorName:'合成人工内容联系人'});
  pending(store,payload);const id=store.events().find(event=>event.payload.platformEventId===payload.platformEventId)!.id;
  // Model a migrated nonhuman revision without changing observation quality or clearing source collisions.
  if(legacy)store.db.prepare('INSERT INTO reply_drafts VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),id,'既有非人工来源草稿','synthetic-legacy',1,'DRAFT',null,null);
  await migrateClient(store,join(root,'client.sqlite'));
  if(share)new MessageShareStore(root).save(payload,'own-1',{kind:'DOUYIN_WORK',url:'https://www.douyin.com/video/7312345678901234567',workId:'7312345678901234567'});
  const native=new HumanContentBrowser(root);native.unknown=unknown;const service=new ClientService(store,native);await service.loadSettings();
  const token=service.authority.issueSession();service.authority.setMode(token,'MANUAL');
  const server=await createServer({configFile:resolve('desktop/vite.config.ts'),server:{port:0,strictPort:false},logLevel:'error'});await server.listen();
  const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage();page.setDefaultTimeout(3000);
  const calls:Record<string,unknown>[]=[],errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.exposeFunction('fixtureInvoke',async(command:string,args:{body?:Record<string,unknown>})=>{
    if(command==='desktop_info')return {runtime:root,version:'synthetic-human-content'};
    if(command!=='client_request')throw new Error('UNEXPECTED_NATIVE_COMMAND');const body=args.body!;calls.push(body);
    if(body.command==='generateSuggestion')throw new Error('FIXTURE_PROVIDER_MUST_NOT_BE_CALLED');
    const result=await service.dispatch(token,body);
    return body.command==='getStatus'&&modelAuthorized?{...result as object,modelAuthorized:true}:result;
  });
  await page.addInitScript(()=>{const fixture=window as unknown as {__TAURI_INTERNALS__:unknown;fixtureInvoke:(command:string,args:unknown)=>Promise<unknown>};
    fixture.__TAURI_INTERNALS__={invoke:(command:string,args:unknown)=>fixture.fixtureInvoke(command,args)};});
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}`);await page.locator('.task').click();
  if(comment)await page.getByRole('button',{name:'打开人工回复',exact:true}).click();
  await page.getByRole('textbox',{name:'人工回复草稿'}).waitFor();
  return {id,root,store,native,service,token,page,calls,errors,close:async()=>{
    await writeFile(join(root,'last-state.json'),JSON.stringify({calls,errors,thread:await service.dispatch(token,{command:'getThread',eventId:id}),
      ui:await page.locator('body').innerText()},null,2));
    await browser.close();await server.close();await service.close();store.close();}};
}

test('model authorization never enables AI for an image or shared-work observation with manual content quality',async()=>{
  const f=await setup({modelAuthorized:true,share:true});try{
    expect(await f.page.getByRole('button',{name:'生成 AI 建议',exact:true}).isDisabled()).toBe(true);
    expect(f.calls.some(call=>call.command==='generateSuggestion')).toBe(false);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test.each([false,true])('one human click without a Key sends the exact latest text for nontext or shared-work content (share=$0)',async share=>{
  const f=await setup({share});try{
    const thread=await f.service.dispatch(f.token,{command:'getThread',eventId:f.id}) as {strong:boolean;humanReplyEligibility?:{eligible:boolean}};
    expect(thread.strong).toBe(false);expect(thread.humanReplyEligibility?.eligible).toBe(true);
    const editor=f.page.getByRole('textbox',{name:'人工回复草稿'});await editor.fill('看过消息后输入的旧文字');
    await expect.poll(()=>f.service.authority.draftFor(f.id)?.text).toBe('看过消息后输入的旧文字');
    await editor.fill('点击发送时绑定的最新完整人工回复');const send=f.page.getByRole('button',{name:'发送',exact:true});
    await expect.poll(()=>send.isEnabled()).toBe(true);await send.click();await f.service.drain();
    await expect.poll(()=>f.native.clicks).toBe(1);expect(f.native.prepared).toEqual(['点击发送时绑定的最新完整人工回复']);
    expect(f.store.event(f.id).status).toBe('CONFIRMED');expect(f.service.authority.draftFor(f.id)?.text).toBe('点击发送时绑定的最新完整人工回复');
    expect(f.calls.filter(call=>call.command==='sendHumanReply')).toHaveLength(1);
    expect(f.calls.some(call=>call.command==='generateSuggestion')).toBe(false);
    expect(f.store.db.prepare('SELECT count(*) AS n FROM model_calls').get()).toEqual({n:0});
    expect(f.store.db.prepare('SELECT used FROM budgets ORDER BY kind').all()).toEqual([{used:0},{used:1}]);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('unknown results remain disabled after the single human media reply and never resubmit',async()=>{
  const f=await setup({unknown:true});try{
    await f.page.getByRole('textbox',{name:'人工回复草稿'}).fill('未知结果只提交这一次的人工回复');
    const send=f.page.getByRole('button',{name:'发送',exact:true});await expect.poll(()=>send.isEnabled()).toBe(true);await send.click();await f.service.drain();
    await expect.poll(()=>f.store.event(f.id).status).toBe('UNCERTAIN');
    await f.page.locator('[aria-label="已提交回复"]').getByText('未知结果只提交这一次的人工回复',{exact:true}).waitFor();
    expect(await send.count()?await send.isDisabled():true).toBe(true);
    expect(await f.page.getByRole('textbox',{name:'人工回复草稿'}).isEditable()).toBe(true);
    expect(await f.page.getByRole('textbox',{name:'人工回复草稿'}).inputValue()).toBe('');
    await new Promise(resolve=>setTimeout(resolve,550));expect(f.native.clicks).toBe(1);
    expect(f.calls.filter(call=>call.command==='sendHumanReply')).toHaveLength(1);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('a comment text quality issue is not admitted by the separate human media eligibility',async()=>{
  const f=await setup({comment:true,modelAuthorized:true});try{
    await f.page.getByRole('textbox',{name:'人工回复草稿'}).fill('评论缺全文仍不可发送');
    expect(await f.page.getByRole('button',{name:'发送',exact:true}).isDisabled()).toBe(true);
    expect(await f.page.getByRole('button',{name:'生成 AI 建议',exact:true}).isDisabled()).toBe(true);
    expect(f.native.clicks).toBe(0);expect(f.calls.some(call=>['sendHumanReply','generateSuggestion'].includes(call.command as string))).toBe(false);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('an old nonhuman media draft shows its precise block until new human input autosaves, then one click can send',async()=>{
  const f=await setup({legacy:true,modelAuthorized:true});try{
    const send=f.page.getByRole('button',{name:'发送',exact:true});expect(await send.isDisabled()).toBe(true);
    await f.page.getByText('请直接输入人工回复，此消息不能使用已有的非人工草稿',{exact:true}).waitFor();
    await f.page.getByRole('textbox',{name:'人工回复草稿'}).fill('本人重新输入并自动保存的完整回复');
    await expect.poll(()=>f.service.authority.draftFor(f.id)?.origin).toBe('HUMAN_TYPED');
    await expect.poll(()=>send.isEnabled()).toBe(true);expect(await f.page.getByRole('button',{name:'生成 AI 建议',exact:true}).isDisabled()).toBe(true);
    await send.click();await f.service.drain();await expect.poll(()=>f.native.clicks).toBe(1);
    expect(f.native.prepared).toEqual(['本人重新输入并自动保存的完整回复']);expect(f.store.event(f.id).status).toBe('CONFIRMED');
    expect(f.store.db.prepare('SELECT count(*) AS n FROM model_calls').get()).toEqual({n:0});expect(f.errors).toEqual([]);
  }finally{await f.close();}
});
