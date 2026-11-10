import {expect,test} from 'vitest';
import {createServer} from 'vite';
import {chromium,type Page} from 'playwright';
import {join,resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {candidate,database,pending,privateTemp} from '../helpers.js';
import type {Thread} from '../../desktop/src/api.js';

interface SendResult {commandId:string;status:string;reason:string|null}
const editor=(page:Page)=>page.getByRole('textbox',{name:'人工回复草稿'});
async function setup(viewport={width:1240,height:800}){
  const root=privateTemp('manual-send-feedback-'),store=database();
  const a=pending(store,candidate({platformEventId:'feedback-a',conversationId:'feedback-a',actorName:'反馈目标A',text:'A的合成入站'}));
  const b=pending(store,candidate({platformEventId:'feedback-b',conversationId:'feedback-b',actorName:'反馈目标B',text:'B的合成入站'}));
  await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();
  const token=service.authority.issueSession();service.authority.setMode(token,'MANUAL');
  const server=await createServer({configFile:resolve('desktop/vite.config.ts'),server:{port:0,strictPort:false},logLevel:'error'});
  await server.listen();const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport});
  page.setDefaultTimeout(4000);
  const calls:Record<string,unknown>[]=[],errors:string[]=[],commands=new Map<string,{eventId:string;text:string;result:SendResult}>();
  const delays=new Map<string,{entered:boolean;release?:()=>void}>();
  let nextStatus='CONFIRMED',nextReason:string|null=null,rejectSend:string|null=null,polls=0,maxPolls=0;
  page.on('pageerror',error=>errors.push(error.message));
  async function wait(command:string){
    const delay=delays.get(command);if(!delay||delay.entered)return;
    delay.entered=true;await new Promise<void>(resolve=>{delay.release=resolve;});
  }
  await page.exposeFunction('fixtureInvoke',async(command:string,args:{body?:Record<string,unknown>})=>{
    if(command==='desktop_info')return {runtime:root,version:'synthetic-feedback'};
    if(command!=='client_request')throw Error('UNEXPECTED_NATIVE_COMMAND');
    const body=args.body!;calls.push(body);
    if(body.command==='connect')return service.dispatch(token,{command:'getStatus'});
    if(body.command==='sendHumanReply'){
      await wait('sendHumanReply');if(rejectSend)throw Error(rejectSend);
      const result={commandId:body.commandId as string,status:nextStatus,reason:nextReason};
      const input=body.input as {eventId:string;text:string};commands.set(result.commandId,{eventId:input.eventId,text:input.text,result});return result;
    }
    if(body.command==='getSendResult'){
      const row=commands.get(body.commandId as string);if(!row)throw Error('COMMAND_NOT_FOUND');
      const result={...row.result};polls++;maxPolls=Math.max(maxPolls,polls);
      try{await wait('getSendResult');return result;}finally{polls--;}
    }
    const result=await service.dispatch(token,body as Parameters<ClientService['dispatch']>[1]);
    if(body.command==='getStatus')return {...result as object,browser:{state:'OPEN_IDENTITY_UNVERIFIED',mode:'headless',version:'synthetic'},
      capabilities:['DIRECT_MESSAGE','COMMENT_NOTIFICATION'].map(channel=>({channel,state:'SEND_AVAILABLE',reason:'',evidence:'synthetic-only'}))};
    if(body.command==='getThread'||body.command==='openHumanDialog'){
      const thread=result as Thread;thread.strong=true;thread.capability={state:'SEND_AVAILABLE',reason:'',evidence:'synthetic-only'};
      const sent=[...commands.values()].find(row=>row.eventId===body.eventId&&row.result.status==='CONFIRMED');
      if(sent){
        thread.replyStatus='REPLIED';thread.conversationReplyStatus='REPLIED';thread.intent={id:'synthetic-confirmed-intent',status:'CONFIRMED'};
        thread.draft={id:'synthetic-saved-draft',eventId:thread.event.id,text:sent.text,model:'human',version:1,status:'APPROVED',approval:null,origin:'HUMAN_TYPED'};
        thread.receipt={result:'CONFIRMED',verified_at:'2026-11-10T04:35:35Z',proof_ref:'synthetic-only'};
        thread.verification={state:'PENDING',attempts:0,last_error:null,verified:null,checked_at:null};
      }
    }
    return result;
  });
  await page.addInitScript(()=>{
    const callbacks=new Map<number,(event:unknown)=>void>(),listeners=new Map<number,{event:string;handler:number}>();let next=0;
    const fixture=window as unknown as {__TAURI_INTERNALS__:unknown;__TAURI_EVENT_PLUGIN_INTERNALS__:unknown;
      fixtureInvoke:(command:string,args:unknown)=>Promise<unknown>};
    fixture.__TAURI_INTERNALS__={transformCallback:(callback:(event:unknown)=>void)=>{callbacks.set(++next,callback);return next;},
      invoke:async(command:string,args:Record<string,unknown>)=>{
        if(command==='plugin:event|listen'){const id=++next;listeners.set(id,{event:args.event as string,handler:args.handler as number});return id;}
        if(command==='plugin:event|unlisten')return;
        try{return await fixture.fixtureInvoke(command,args);}catch(error){throw error instanceof Error?error.message:error;}
      }};
    fixture.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:(_event:string,id:number)=>{const listener=listeners.get(id);if(listener)callbacks.delete(listener.handler);listeners.delete(id);}};
  });
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}`);
  await page.getByRole('heading',{name:'收件箱',exact:true}).waitFor();
  return {root,page,a,b,calls,errors,commands,store,
    status:(value:string,reason:string|null=null)=>{nextStatus=value;nextReason=reason;},reject:(value:string)=>{rejectSend=value;},
    hold:(command:string)=>delays.set(command,{entered:false}),held:(command:string)=>delays.get(command)?.entered??false,
    release:(command:string)=>{delays.get(command)?.release?.();},maxPolls:()=>maxPolls,
    close:async()=>{for(const delay of delays.values())delay.release?.();
      await writeFile(join(root,'trace.json'),JSON.stringify({calls,errors},null,2));
      await browser.close();await server.close();await service.close();store.close();}};
}

test('a slow human-send acceptance is never polled before the backend returns its command',async()=>{
  const f=await setup();try{
    f.hold('sendHumanReply');await f.page.getByRole('button',{name:/反馈目标A/}).click();
    await editor(f.page).fill('等待后端接收时保留的合成人稿');await f.page.getByRole('button',{name:'发送',exact:true}).click();
    await expect.poll(()=>f.held('sendHumanReply')).toBe(true);
    await new Promise(resolve=>setTimeout(resolve,1150));
    expect(f.calls.filter(call=>call.command==='getSendResult')).toEqual([]);
    expect(await editor(f.page).inputValue()).toBe('等待后端接收时保留的合成人稿');
    expect(await f.page.getByText('COMMAND_NOT_FOUND',{exact:true}).count()).toBe(0);
    f.release('sendHumanReply');await f.page.getByTestId('reply-send-result').getByText('已回复',{exact:true}).waitFor();
    expect(f.calls.filter(call=>call.command==='sendHumanReply')).toHaveLength(1);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('a rejected human-send preserves its actual error and draft without polling a nonexistent command',async()=>{
  const f=await setup();try{
    f.reject('DRAFT_VERSION_CONFLICT');await f.page.getByRole('button',{name:/反馈目标A/}).click();
    await editor(f.page).fill('版本冲突后仍保留的人稿');await f.page.getByRole('button',{name:'发送',exact:true}).click();
    await f.page.getByText('草稿版本已变化，请重新读取并核对',{exact:true}).waitFor();
    await new Promise(resolve=>setTimeout(resolve,1150));
    expect(f.calls.filter(call=>call.command==='getSendResult')).toEqual([]);
    expect(await f.page.getByText('COMMAND_NOT_FOUND',{exact:true}).count()).toBe(0);
    expect(await editor(f.page).inputValue()).toBe('版本冲突后仍保留的人稿');expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test.each([{width:900,height:640},{width:1240,height:800}])('confirmed human send replaces stale pending proof with one result at $width x $height',async viewport=>{
  const f=await setup(viewport);try{
    await f.page.getByRole('button',{name:/反馈目标A/}).click();await editor(f.page).fill('已经确认送达的合成回复');
    await f.page.getByRole('button',{name:'发送',exact:true}).click();
    const result=f.page.getByTestId('reply-send-result');await result.getByText('已回复',{exact:true}).waitFor();
    expect(await result.count()).toBe(1);expect(await result.getAttribute('role')).toBe('status');
    expect(await f.page.locator('.reply-composer').innerText()).not.toContain('正在后台检查送达情况');
    expect(await f.page.locator('.reply-composer').innerText()).not.toContain('送达记录已保存');
    expect(await f.page.locator('.reply-composer .receipt, .reply-composer .send-state').count()).toBe(1);
    expect(await f.page.getByRole('button',{name:'发送',exact:true}).isDisabled()).toBe(true);
    expect(f.calls.filter(call=>call.command==='sendHumanReply')).toHaveLength(1);
    await f.page.screenshot({path:join(f.root,`confirmed-${viewport.width}.png`)});expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('a slow result request never overlaps another poll and cannot overwrite a new target command',async()=>{
  const f=await setup();try{
    f.status('PREPARING');f.hold('getSendResult');await f.page.getByRole('button',{name:/反馈目标A/}).click();
    await editor(f.page).fill('目标A第一次发送');await f.page.getByRole('button',{name:'发送',exact:true}).click();
    await expect.poll(()=>f.held('getSendResult')).toBe(true);await new Promise(resolve=>setTimeout(resolve,1100));
    expect(f.maxPolls()).toBe(1);
    await f.page.getByRole('button',{name:/反馈目标B/}).click();await f.page.getByRole('log').getByText('B的合成入站',{exact:true}).waitFor();
    await editor(f.page).fill('目标B第二次发送');
    f.status('CONFIRMED');await f.page.getByRole('button',{name:'发送',exact:true}).click();
    await f.page.getByTestId('reply-send-result').getByText('已回复',{exact:true}).waitFor();f.release('getSendResult');
    await new Promise(resolve=>setTimeout(resolve,650));
    expect(await f.page.getByTestId('reply-send-result').innerText()).toContain('已回复');
    expect(await f.page.getByRole('log').innerText()).toContain('B的合成入站');
    expect(await editor(f.page).inputValue()).toBe('目标B第二次发送');
    const sent=f.calls.filter(call=>call.command==='sendHumanReply');expect(sent).toHaveLength(2);
    expect(f.calls.filter(call=>call.command==='getSendResult'&&call.commandId===sent[1]!.commandId)).toEqual([]);
    expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('a late acceptance for the previous target cannot attach its send state to the new draft',async()=>{
  const f=await setup();try{
    f.hold('sendHumanReply');await f.page.getByRole('button',{name:/反馈目标A/}).click();
    await editor(f.page).fill('属于A的发送全文');await f.page.getByRole('button',{name:'发送',exact:true}).click();
    await expect.poll(()=>f.held('sendHumanReply')).toBe(true);
    await f.page.getByRole('button',{name:/反馈目标B/}).click();await f.page.getByRole('log').getByText('B的合成入站',{exact:true}).waitFor();
    await editor(f.page).fill('发送响应迟到时属于B的人稿');
    f.release('sendHumanReply');await new Promise(resolve=>setTimeout(resolve,700));
    expect(await f.page.getByRole('log').innerText()).toContain('B的合成入站');
    expect(await editor(f.page).inputValue()).toBe('发送响应迟到时属于B的人稿');
    expect(await f.page.getByTestId('reply-send-result').count()).toBe(0);
    expect(f.calls.filter(call=>call.command==='sendHumanReply')).toHaveLength(1);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('a failure before submission shows not sent with the actual reason and preserves the human draft',async()=>{
  const f=await setup();try{
    f.status('FAILED_BEFORE_CLICK','DRAFT_VERSION_CONFLICT');await f.page.getByRole('button',{name:/反馈目标A/}).click();
    await editor(f.page).fill('未提交时保留的人稿');await f.page.getByRole('button',{name:'发送',exact:true}).click();
    const result=f.page.getByTestId('reply-send-result');await result.getByText('尚未发送',{exact:true}).waitFor();
    expect(await result.innerText()).toContain('草稿版本已变化，请重新读取并核对');
    expect(await result.innerText()).not.toContain('正在后台检查');
    expect(await editor(f.page).inputValue()).toBe('未提交时保留的人稿');expect(f.errors).toEqual([]);
  }finally{await f.close();}
});
