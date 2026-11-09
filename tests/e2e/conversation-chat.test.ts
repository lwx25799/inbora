import {expect,test} from 'vitest';
import {createServer} from 'vite';
import {chromium,type Page} from 'playwright';
import {join,resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {ChatMessageStore} from '../../src/storage/chat-messages.js';
import {candidate,database,pending,privateTemp,snapshot} from '../helpers.js';
import type {Thread} from '../../desktop/src/api.js';

const editor=(page:Page)=>page.getByRole('textbox',{name:'人工回复草稿'});
async function setup(viewport={width:1240,height:800},weakMedia=false){
  const root=privateTemp('conversation-chat-'),store=database();
  for(let i=0;i<34;i++)pending(store,candidate({platformEventId:`chat-a-${i}`,conversationId:'conversation-a',actorName:'合成同名联系人',
    text:weakMedia&&i===33?'[图片或表情消息，需人工查看]':`会话A消息${String(i).padStart(2,'0')}`,occurredAt:new Date(Date.UTC(2026,10,4,1,0,i)).toISOString(),
    ...(weakMedia&&i===33?{contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED'}:{})}));
  const a=store.events().find(event=>event.payload.platformEventId==='chat-a-33')!.id;
  const b=pending(store,candidate({platformEventId:'chat-b',conversationId:'conversation-b',actorName:'合成同名联系人',text:'会话B独立消息',occurredAt:'2026-11-04T01:01:00Z'}));
  const comment=pending(store,candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',platformEventId:'chat-comment',
    videoId:'fixture-work',commentId:'fixture-parent',conversationId:null,actorName:'合成评论作者',text:'评论父消息不可丢失'}));
  await migrateClient(store,join(root,'client-backup.sqlite'));
  await migrateAutomation(store,join(root,'automation-backup.sqlite'));
  new ChatMessageStore(store).observe([candidate({direction:'OUTGOING',actorId:'own-1',conversationId:'conversation-a',
    platformEventId:'phone-observed',text:'手机端我方消息观察',occurredAt:'2026-11-04T01:00:34Z'})],'own-1',Date.UTC(2026,10,4));
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();const token=service.authority.issueSession();service.authority.setMode(token,'MANUAL');
  const server=await createServer({configFile:resolve('desktop/vite.config.ts'),server:{port:0,strictPort:false},logLevel:'error'});await server.listen();
  const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport});
  page.setDefaultTimeout(3000);
  const preview=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=96;canvas.height=64;
    const ctx=canvas.getContext('2d')!;ctx.fillStyle='#e8c269';ctx.fillRect(0,0,96,64);ctx.fillStyle='#226248';ctx.font='24px sans-serif';ctx.fillText('合成',22,42);return canvas.toDataURL('image/png');});
  const calls:Record<string,unknown>[]=[],errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  let hold:string|undefined,release:(()=>void)|undefined,entered=false,intentFor:string|undefined,timeline:Thread['timeline'],olderTimeline:Thread['timeline'];
  await page.exposeFunction('fixtureInvoke',async(command:string,args:{body?:Record<string,unknown>})=>{
    if(command==='desktop_info')return {runtime:root,version:'synthetic-chat'};
    if(command!=='client_request')throw new Error('UNEXPECTED_NATIVE_COMMAND');
    const body=args.body!;calls.push(body);
    if(hold===body.command){hold=undefined;entered=true;await new Promise<void>(resolve=>{release=resolve;});}
    if(body.command==='getMessagePreview')return {previewId:body.previewId,mime:'image/png',dataUrl:preview,width:96,height:64};
    if(body.command==='connect')return service.dispatch(token,{command:'getStatus'});
    if(body.command==='sendHumanReply'){intentFor=(body.input as {eventId:string}).eventId;return {commandId:body.commandId,status:'UNCERTAIN',reason:null};}
    if(body.command==='generateSuggestion')return {};
    const dispatchBody=timeline&&body.command==='getThread'&&body.timelineBefore?{command:'getThread',eventId:body.eventId}:body;
    const result=await service.dispatch(token,dispatchBody as Parameters<ClientService['dispatch']>[1]);
    if(body.command==='getStatus')return {...result as object,modelAuthorized:true,keyPresent:true,browser:{state:'OPEN_IDENTITY_UNVERIFIED',mode:'headed',version:'synthetic'},
      capabilities:['DIRECT_MESSAGE','COMMENT_NOTIFICATION'].map(channel=>({channel,state:'SEND_AVAILABLE',reason:'',evidence:'synthetic-only'}))};
    if(body.command==='getThread'||body.command==='openHumanDialog'){
      const thread=result as Thread;
      if(thread.timeline?.items.some(item=>item.eventId===a))thread.timeline.items=thread.timeline.items.map(item=>item.eventId===a?{...item,attachments:[{previewId:'fixture-preview',kind:'IMAGE',label:'合成图片',state:'READY'}]}:item);
      if(intentFor===body.eventId)thread.intent={id:'fixture-unknown-intent',status:'UNCERTAIN'};
      thread.capability={state:'SEND_AVAILABLE',reason:'',evidence:'synthetic-only'};if(!weakMedia)thread.strong=true;
      if(timeline)thread.timeline=body.timelineBefore&&olderTimeline?olderTimeline:timeline;
    }
    return result;
  });
  await page.addInitScript(()=>{const fixture=window as unknown as {__TAURI_INTERNALS__:unknown;fixtureInvoke:(command:string,args:unknown)=>Promise<unknown>};fixture.__TAURI_INTERNALS__={invoke:(command:string,args:unknown)=>fixture.fixtureInvoke(command,args)};});
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}`);await page.getByRole('heading',{name:'收件箱',exact:true}).waitFor();
  return {root,store,page,a,b,comment,calls,errors,service,token,preview,
    timeline:(value:NonNullable<Thread['timeline']>,older?:NonNullable<Thread['timeline']>)=>{timeline=value;olderTimeline=older;},
    hold:(command:string)=>{hold=command;entered=false;},held:()=>entered,release:()=>{release?.();release=undefined;},
    close:async()=>{release?.();await page.screenshot({path:join(root,'last-state.png')}).catch(()=>{});
      await writeFile(join(root,'ui-trace.json'),JSON.stringify({calls,errors,text:await page.locator('body').innerText().catch(()=> '')},null,2));
      await browser.close();await server.close();await service.close();store.close();}};
}

test.each([{width:900,height:640},{width:1240,height:800}])('DM conversation streams and its inline composer are usable at $width x $height',async viewport=>{
  const f=await setup(viewport);try{
    await f.page.getByRole('button',{name:'私信',exact:true}).click();
    expect(await f.page.locator('.runtime-status').innerText()).toContain('浏览器：已打开');
    await expect.poll(()=>f.page.locator('.task').count()).toBe(2);
    const row=f.page.locator('.task').filter({hasText:'会话A消息33'});await row.click();
    await editor(f.page).waitFor({timeout:2500});expect(await editor(f.page).isEditable()).toBe(true);
    expect(await f.page.getByRole('button',{name:'打开人工回复',exact:true}).count()).toBe(0);
    expect(f.calls.filter(call=>call.command==='openHumanDialog')).toHaveLength(1);
    await f.page.getByRole('log',{name:'私信消息流'}).getByText('会话A消息33',{exact:true}).waitFor();
    const ownBubble=f.page.locator('.chat-message.outgoing').filter({hasText:'手机端我方消息观察'});
    await ownBubble.waitFor();expect(await ownBubble.innerText()).toContain('我方消息');expect(await ownBubble.innerText()).not.toContain('我方已回复');
    const image=f.page.getByRole('log').getByRole('img',{name:'合成图片'});await image.waitFor();expect(await image.getAttribute('src')).toBe(f.preview);
    expect(await image.evaluate(node=>(node as HTMLImageElement).naturalWidth)).toBe(96);
    await f.page.getByRole('button',{name:'加载更早消息',exact:true}).click();await f.page.getByRole('log').getByText('会话A消息00',{exact:true}).waitFor();
    expect(f.calls.some(call=>call.command==='getThread'&&typeof call.timelineBefore==='string')).toBe(true);
    expect(await f.page.getByRole('log').getByText('会话B独立消息',{exact:true}).count()).toBe(0);
    await editor(f.page).fill('在会话中直接输入的合成人稿');
    await f.page.getByText('修改已保存',{exact:true}).first().waitFor();
    const bounds=await editor(f.page).boundingBox();expect(bounds!.y+bounds!.height).toBeLessThanOrEqual(viewport.height);
    const sendBounds=await f.page.getByRole('button',{name:'发送',exact:true}).boundingBox();expect(sendBounds!.y+sendBounds!.height).toBeLessThanOrEqual(viewport.height);
    expect(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await f.page.getByRole('log').evaluate(node=>{node.scrollTop=node.scrollHeight;});
    await f.page.screenshot({path:join(f.root,`conversation-${viewport.width}.png`)});
    await f.page.getByRole('button',{name:'评论',exact:true}).click();await f.page.locator('.task').filter({hasText:'评论父消息不可丢失'}).click();
    await f.page.getByRole('heading',{name:'原父评论',exact:true}).waitFor();expect(await f.page.getByText('评论父消息不可丢失',{exact:true}).count()).toBeGreaterThan(0);
    expect(f.errors).toEqual([]);expect(f.calls.some(call=>['sendHumanReply','generateSuggestion'].includes(call.command as string))).toBe(false);
  }finally{await f.close();}
});

test('same-conversation new messages and late details preserve the current draft and its exact reply binding',async()=>{
  const f=await setup();try{
    await f.page.locator('.task').filter({hasText:'会话A消息33'}).click();await editor(f.page).waitFor({timeout:2500});
    await editor(f.page).fill('正在输入的A人稿');
    pending(f.store,candidate({platformEventId:'chat-a-new',conversationId:'conversation-a',actorName:'合成同名联系人',text:'后台新收入的A消息',occurredAt:'2026-11-04T01:02:00Z'}));
    await f.page.getByRole('button',{name:'重新连接内核',exact:true}).click();
    await f.page.getByRole('log').getByText('后台新收入的A消息',{exact:true}).waitFor();
    expect(await editor(f.page).inputValue()).toBe('正在输入的A人稿');
    await f.page.locator('.task').filter({hasText:'后台新收入的A消息'}).click();
    expect(await editor(f.page).inputValue()).toBe('正在输入的A人稿');
    expect(f.calls.filter(call=>call.command==='openHumanDialog').at(-1)?.eventId).toBe(f.a);
    f.hold('getThread');await f.page.getByRole('button',{name:'重新连接内核',exact:true}).click();await expect.poll(f.held).toBe(true);
    await f.page.locator('.task').filter({hasText:'会话B独立消息'}).click();await f.page.getByRole('log').getByText('会话B独立消息',{exact:true}).waitFor();
    await editor(f.page).fill('只属于B的继续输入');f.release();
    await new Promise(resolve=>setTimeout(resolve,650));expect(await editor(f.page).inputValue()).toBe('只属于B的继续输入');
    const saved=f.calls.filter(call=>call.command==='saveDraft').at(-1);expect(saved).toMatchObject({eventId:f.b,text:'只属于B的继续输入'});
    expect(await f.page.locator('.task').count()).toBe(3);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('the settings switch controls all conversations while viewing stays passive and focusing the composer protects human input',async()=>{
  const f=await setup();try{
    await f.service.dispatch(f.token,{command:'setReplyPolicy',confirmed:true,policy:{ownId:'own-1',channels:['DIRECT_MESSAGE'],model:'deepseek-flash',
      modelLimit:1,sendLimit:1,expiresAt:null,workIds:[],futureOwnWorks:false,conversationIds:[],entireInbox:true,
      containsAny:['never-match'],excludesAny:[],instructions:'Synthetic test',startHour:0,endHour:24}});
    await f.service.dispatch(f.token,{command:'setAutomaticReply',enabled:true});
    await expect.poll(()=>f.page.getByRole('switch',{name:'自动回复',exact:true}).isChecked(),{timeout:3000}).toBe(true);
    await f.page.locator('.task').filter({hasText:'会话A消息33'}).click();await editor(f.page).waitFor();
    expect(f.calls.filter(call=>call.command==='openHumanDialog')).toHaveLength(0);
    expect(f.service.authority.ownership(f.store.event(f.a)).operator_id).toBeNull();
    expect(await f.page.getByRole('button',{name:'交回自动回复',exact:true}).count()).toBe(0);
    await editor(f.page).fill('统一开关保持这份人稿');
    await expect.poll(()=>f.calls.some(call=>call.command==='openHumanDialog')).toBe(true);
    await expect.poll(()=>f.service.authority.draftFor(f.a)?.text).toBe('统一开关保持这份人稿');
    await f.page.getByRole('button',{name:'AI 与设置',exact:true}).click();
    const toggle=f.page.getByRole('switch',{name:'设置中的自动回复',exact:true});await toggle.uncheck();
    await expect.poll(()=>f.service.authority.mode()).toBe('MANUAL');await expect.poll(()=>toggle.isChecked()).toBe(false);await toggle.check();
    await expect.poll(()=>f.service.authority.mode()).toBe('LIMITED_AUTO');
    expect(f.service.authority.draftFor(f.a)?.text).toBe('统一开关保持这份人稿');
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('a comment follow-up proof shows the exact confirmed reply below its parent without opening an editor',async()=>{
  const f=await setup();try{
    const event=f.store.event(f.comment),owner=f.service.authority.claim(f.token,f.comment,0);
    const draft=f.service.authority.save(f.token,f.comment,owner.generation,0,'针对这条父评论的完整回复');
    f.store.approve(draft.id,snapshot(event.payload),draft.version,draft.text);
    const intent=f.store.recordIntent(draft.id,snapshot(event.payload),false,{check:()=>{},committed:()=>{}});
    f.store.receipt(intent,'UNCERTAIN','synthetic-original-unknown');
    f.store.db.prepare('INSERT INTO verification_results VALUES(?,?,?,?,?)').run('synthetic-comment-proof',intent,1,'synthetic-readback',Date.now());
    await f.page.getByRole('combobox',{name:'任务状态'}).selectOption('CONFIRMED');
    await f.page.locator('.task').filter({hasText:'评论父消息不可丢失'}).click();
    await f.page.getByRole('region',{name:'我的回复',exact:true}).getByText(draft.text,{exact:true}).waitFor();
    expect(await f.page.getByRole('heading',{name:'原父评论',exact:true}).count()).toBe(1);
    expect(await f.page.getByRole('dialog',{name:'人工回复对话框'}).isVisible()).toBe(false);
    expect(f.store.event(f.comment).status).toBe('UNCERTAIN');expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('inline send submits once with the latest human text and an uncertain result remains disabled',async()=>{
  const f=await setup();try{
    await f.page.locator('.task').filter({hasText:'会话B独立消息'}).click();await editor(f.page).waitFor({timeout:2500});
    await editor(f.page).fill('一次业务发送的最新合成全文');await f.page.getByRole('button',{name:'发送',exact:true}).click();
    await expect.poll(()=>f.calls.filter(call=>call.command==='sendHumanReply').length).toBe(1);
    const sent=f.calls.find(call=>call.command==='sendHumanReply')!;expect(sent.commandId).toEqual(expect.any(String));
    expect(sent.input).toMatchObject({eventId:f.b,text:'一次业务发送的最新合成全文'});
    await expect.poll(()=>f.page.getByRole('button',{name:'发送',exact:true}).isDisabled()).toBe(true);
    expect(f.calls.some(call=>call.command==='generateSuggestion')).toBe(false);expect(f.store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('switching before autosave keeps the old exact draft while a late save cannot overwrite the new conversation',async()=>{
  const f=await setup();try{
    await f.page.locator('.task').filter({hasText:'会话A消息33'}).click();await editor(f.page).waitFor();
    f.hold('saveDraft');await editor(f.page).fill('不足五百毫秒即切换的A人稿');
    await f.page.locator('.task').filter({hasText:'会话B独立消息'}).click();await expect.poll(f.held).toBe(true);
    await editor(f.page).fill('等待旧保存时继续输入的A全文');f.release();
    await f.page.getByRole('log').getByText('会话B独立消息',{exact:true}).waitFor();
    await editor(f.page).fill('旧保存完成后继续输入的B人稿');
    await expect.poll(()=>f.service.authority.draftFor(f.a)?.text).toBe('等待旧保存时继续输入的A全文');
    await expect.poll(()=>f.service.authority.draftFor(f.b)?.text).toBe('旧保存完成后继续输入的B人稿');
    expect(await editor(f.page).inputValue()).toBe('旧保存完成后继续输入的B人稿');expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('late media and AI callbacks from the previous conversation cannot replace the selected messages or human draft',async()=>{
  const f=await setup();try{
    f.hold('getMessagePreview');await f.page.locator('.task').filter({hasText:'会话A消息33'}).click();await expect.poll(f.held).toBe(true);
    await f.page.locator('.task').filter({hasText:'会话B独立消息'}).click();await editor(f.page).fill('图片迟到时仍属于B的人稿');f.release();
    await new Promise(resolve=>setTimeout(resolve,100));expect(await f.page.getByRole('img',{name:'合成图片'}).count()).toBe(0);
    expect(await editor(f.page).inputValue()).toBe('图片迟到时仍属于B的人稿');
    f.hold('generateSuggestion');await f.page.getByRole('button',{name:'生成 AI 建议',exact:true}).click();await expect.poll(f.held).toBe(true);
    await f.page.locator('.task').filter({hasText:'会话A消息33'}).click();
    await f.page.getByRole('log').getByText('会话A消息33',{exact:true}).waitFor();await editor(f.page).fill('建议迟到时属于A的新输入');f.release();
    await new Promise(resolve=>setTimeout(resolve,650));expect(await editor(f.page).inputValue()).toBe('建议迟到时属于A的新输入');
    expect(f.calls.filter(call=>call.command==='generateSuggestion')).toEqual([{command:'generateSuggestion',eventId:f.b,draftVersion:expect.any(Number)}]);
    expect(f.calls.some(call=>call.command==='sendHumanReply')).toBe(false);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('returning to a conversation after newer inbound restores its original saved draft event rather than copying it',async()=>{
  const f=await setup();try{
    await f.page.locator('.task').filter({hasText:'会话A消息33'}).click();await editor(f.page).fill('新入站以前已保存的A人稿');
    await expect.poll(()=>f.service.authority.draftFor(f.a)?.text).toBe('新入站以前已保存的A人稿');
    const newest=pending(f.store,candidate({platformEventId:'chat-a-after-draft',conversationId:'conversation-a',actorName:'合成同名联系人',
      text:'A会话新的入站预览',occurredAt:'2026-11-04T01:03:00Z'}));
    await f.page.getByRole('button',{name:'重新连接内核',exact:true}).click();
    await f.page.locator('.task').filter({hasText:'A会话新的入站预览'}).waitFor();
    await f.page.locator('.task').filter({hasText:'会话B独立消息'}).click();await f.page.getByRole('log').getByText('会话B独立消息',{exact:true}).waitFor();
    await f.page.locator('.task').filter({hasText:'A会话新的入站预览'}).click();await f.page.getByRole('log').getByText('A会话新的入站预览',{exact:true}).waitFor();
    expect(await editor(f.page).inputValue()).toBe('新入站以前已保存的A人稿');
    expect(f.calls.filter(call=>call.command==='openHumanDialog').at(-1)?.eventId).toBe(f.a);
    expect(f.service.authority.draftFor(newest)).toBeNull();expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('a fresh authoritative timeline removes superseded confirmed or contradicted own bubbles without changing the human draft',async()=>{
  const f=await setup();try{
    const incoming={id:'in:fixture',eventId:f.a,direction:'INCOMING' as const,text:'权威入站消息',occurredAt:'2026-11-04T01:00:33Z',historical:false,origin:'OBSERVED' as const,attachments:[]};
    const sent={id:'out:fixture',eventId:f.a,direction:'OUTGOING' as const,text:'同一原生我方消息',occurredAt:'2026-11-04T01:00:34Z',historical:false,origin:'CONFIRMED' as const,attachments:[]};
    f.timeline({items:[incoming,sent],pageSize:30,hasMore:false,before:null});
    await f.page.locator('.task').filter({hasText:'会话A消息33'}).click();await editor(f.page).fill('权威流更新时保留的人稿');
    await f.page.getByRole('log').getByText('同一原生我方消息',{exact:true}).waitFor();
    f.timeline({items:[incoming,{...sent,id:'observed:fixture',origin:'OBSERVED'}],pageSize:30,hasMore:false,before:null});
    await f.page.getByRole('button',{name:'重新连接内核',exact:true}).click();
    await expect.poll(async()=>(await f.page.locator('.chat-message.outgoing').allTextContents()).join('')).not.toContain('我方已回复');
    expect(await f.page.getByRole('log').getByText('同一原生我方消息',{exact:true}).count()).toBe(1);
    f.timeline({items:[incoming],pageSize:30,hasMore:false,before:null});await f.page.getByRole('button',{name:'重新连接内核',exact:true}).click();
    await expect.poll(()=>f.page.locator('.chat-message.outgoing').count()).toBe(0);
    expect(await editor(f.page).inputValue()).toBe('权威流更新时保留的人稿');expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('a group projection change invalidates a revoked confirmed bubble in an expanded older page while preserving the composer',async()=>{
  const f=await setup();try{
    const incoming={id:'in:latest',eventId:f.a,direction:'INCOMING' as const,text:'最新权威消息',occurredAt:'2026-11-04T01:00:33Z',historical:false,origin:'OBSERVED' as const,attachments:[]};
    const sent={id:'out:older',eventId:f.a,direction:'OUTGOING' as const,text:'早页已被反证的我方消息',occurredAt:'2026-11-04T01:00:01Z',historical:false,origin:'CONFIRMED' as const,attachments:[]};
    const latest={items:[incoming],pageSize:30,hasMore:true,before:'synthetic-older-cursor',projectionRevision:'revision-before'};
    f.timeline(latest,{items:[sent],pageSize:30,hasMore:false,before:null,projectionRevision:'revision-before'});
    await f.page.locator('.task').filter({hasText:'会话A消息33'}).click();await editor(f.page).fill('早页反证不影响当前输入');
    await f.page.getByRole('button',{name:'加载更早消息',exact:true}).click();await f.page.getByRole('log').getByText(sent.text,{exact:true}).waitFor();
    f.timeline({...latest,projectionRevision:'revision-after'});
    await f.page.getByRole('button',{name:'重新连接内核',exact:true}).click();
    await expect.poll(()=>f.page.getByRole('log').getByText(sent.text,{exact:true}).count()).toBe(0);
    expect(await editor(f.page).inputValue()).toBe('早页反证不影响当前输入');expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('an actual weak image message shows its preview and human composer while AI stays disabled at minimum size',async()=>{
  const f=await setup({width:900,height:640},true);try{
    await f.page.locator('.task').filter({hasText:'[图片或表情消息，需人工查看]'}).click();await editor(f.page).waitFor();
    const image=f.page.getByRole('log').getByRole('img',{name:'合成图片'});await image.waitFor();
    expect(await image.evaluate(node=>(node as HTMLImageElement).naturalWidth)).toBe(96);
    expect(await f.page.getByRole('log').getByText('[图片或表情消息，需人工查看]',{exact:true}).count()).toBe(0);
    await editor(f.page).fill('看图后保留的人工草稿');await expect.poll(()=>f.service.authority.draftFor(f.a)?.text).toBe('看图后保留的人工草稿');
    const send=f.page.getByRole('button',{name:'发送',exact:true});await expect.poll(()=>send.isEnabled()).toBe(true);
    expect(f.service.authority.draftFor(f.a)?.origin).toBe('HUMAN_TYPED');
    expect(await f.page.getByRole('button',{name:'生成 AI 建议',exact:true}).isDisabled()).toBe(true);
    const bounds=await send.boundingBox();expect(bounds!.y+bounds!.height).toBeLessThanOrEqual(640);
    expect(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await image.scrollIntoViewIfNeeded();
    const imageBounds=await image.boundingBox(),streamBounds=await f.page.getByRole('log').boundingBox();
    expect(imageBounds!.y).toBeGreaterThanOrEqual(streamBounds!.y);expect(imageBounds!.y+imageBounds!.height).toBeLessThanOrEqual(streamBounds!.y+streamBounds!.height);
    await f.page.screenshot({path:join(f.root,'weak-image-900.png')});
    expect(f.calls.some(call=>['sendHumanReply','generateSuggestion'].includes(call.command as string))).toBe(false);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});
