import {expect,test} from 'vitest';
import {createServer} from 'vite';
import {chromium,type Page} from 'playwright';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {candidate,database,pending,privateTemp} from '../helpers.js';
import type {Thread} from '../../desktop/src/api.js';

const editor=(page:Page)=>page.getByRole('textbox',{name:'人工回复草稿'});
type Command={commandId:string;status:string;reason:string|null;accepted?:boolean;intentId?:string};
async function setup(){
  const root=privateTemp('reply-submission-ui-'),store=database(),a=pending(store,candidate({platformEventId:'next-a',conversationId:'next-a',actorName:'连续回复A'}));
  const b=pending(store,candidate({platformEventId:'next-b',conversationId:'next-b',actorName:'连续回复B'}));
  await migrateClient(store,join(root,'backup.sqlite'));const service=new ClientService(store,new BrowserService(root));await service.loadSettings();
  const token=service.authority.issueSession();service.authority.setMode(token,'MANUAL');
  const server=await createServer({configFile:resolve('desktop/vite.config.ts'),server:{port:0,strictPort:false},logLevel:'error'});await server.listen();
  const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']}),page=await browser.newPage();page.setDefaultTimeout(2500);
  const calls:Record<string,unknown>[]=[],errors:string[]=[],commands=new Map<string,{result:Command;text:string;eventId:string}>();
  let next:Partial<Command>={accepted:true,status:'QUEUED'},holdSend=false,release:()=>void=()=>{},entered=false,frozen=false,queueReady=true;
  const followupDrafts=new Map<string,NonNullable<Thread['draft']>>();
  page.on('pageerror',error=>errors.push(error.message));
  await page.exposeFunction('fixtureInvoke',async(command:string,args:{body?:Record<string,unknown>})=>{
    if(command==='desktop_info')return {runtime:root,version:'synthetic-next-draft'};
    if(command!=='client_request')throw Error('UNEXPECTED_NATIVE_COMMAND');const body=args.body!;calls.push(body);
    if(body.command==='connect')return service.dispatch(token,{command:'getStatus'});
    if(body.command==='sendHumanReply'||body.command==='sendHumanFollowup'){
      const input=body.input as {eventId:string;text:string;expectedVersion:number};
      if(holdSend){entered=true;await new Promise<void>(resolve=>{release=resolve;});}
      const result:Command={commandId:body.commandId as string,status:'QUEUED',reason:null,...next};
      commands.set(body.commandId as string,{result,text:input.text,eventId:input.eventId});
      followupDrafts.delete(input.eventId);return result;
    }
    if(body.command==='getSendResult')return commands.get(body.commandId as string)!.result;
    if(body.command==='saveHumanFollowupDraft'){
      const old=followupDrafts.get(body.eventId as string);
      if(body.expectedVersion!==(old?.version??0))throw Error('DRAFT_VERSION_CONFLICT');
      const draft={id:old?.id??randomUUID(),eventId:body.eventId as string,text:body.text as string,model:'human',version:(old?.version??0)+1,
        status:'DRAFT' as const,approval:null,origin:'HUMAN_TYPED'};followupDrafts.set(draft.eventId,draft);return draft;
    }
    const result=await service.dispatch(token,body);
    if(body.command==='getStatus')return {...result as object,capabilities:[{channel:'DIRECT_MESSAGE',state:'SEND_AVAILABLE',reason:'',evidence:'synthetic-only'}]};
    if(body.command==='getThread'||body.command==='openHumanDialog'){
      const thread=result as Thread;thread.strong=true;thread.capability={state:'SEND_AVAILABLE',reason:'',evidence:'synthetic-only'};
      const rows=[...commands.values()].filter(row=>row.eventId===body.eventId),latest=rows.at(-1);
      if(latest){thread.intent=rows.length===1&&latest.result.status==='QUEUED'?null:{id:'fixture-first-intent',status:'SENDING'};thread.frozen=frozen;
        Object.assign(thread,{followup:{eligible:false,queueReady,reason:'HUMAN_REPLY_IN_PROGRESS',draft:followupDrafts.get(thread.event.id)??null,
          latestTurn:{commandId:latest.result.commandId,status:latest.result.status,text:latest.text,reason:latest.result.reason,intentId:null,verifiedAt:null}}});}
    }
    return result;
  });
  await page.addInitScript(()=>{const fixture=window as unknown as {__TAURI_INTERNALS__:unknown;fixtureInvoke:(command:string,args:unknown)=>Promise<unknown>};
    fixture.__TAURI_INTERNALS__={invoke:async(command:string,args:unknown)=>{try{return await fixture.fixtureInvoke(command,args);}catch(error){throw error instanceof Error?error.message:error;}}};});
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}`);await page.getByRole('button',{name:/连续回复A/}).click();await editor(page).waitFor();
  return {page,a,b,calls,errors,commands,followupDrafts,next:(value:Partial<Command>)=>{next=value;},hold:()=>{holdSend=true;},held:()=>entered,
    release:()=>{holdSend=false;release();},fail:()=>{for(const row of commands.values())row.result={...row.result,status:'FAILED_BEFORE_CLICK',reason:'DRAFT_VERSION_CONFLICT'};},
    freeze:(ready:boolean)=>{frozen=true;queueReady=ready;for(const row of commands.values())row.result={...row.result,status:'UNCERTAIN'};},
    close:async()=>{release();await browser.close();await server.close();await service.close();store.close();}};
}

test('a durable accepted command clears only that revision and allows a separately saved next business reply before confirmation',async()=>{
  const f=await setup();try{
    await editor(f.page).fill('第一条持久排队全文');await f.page.getByRole('button',{name:'发送',exact:true}).click();
    await expect.poll(()=>editor(f.page).inputValue()).toBe('');
    await editor(f.page).fill('无需等待上一条确认的第二条');
    await expect.poll(()=>f.followupDrafts.get(f.a)?.text).toBe('无需等待上一条确认的第二条');
    const send=f.page.getByRole('button',{name:'发送',exact:true});await expect.poll(()=>send.isEnabled()).toBe(true);await send.click();
    await expect.poll(()=>editor(f.page).inputValue()).toBe('');
    const submissions=f.calls.filter(row=>['sendHumanReply','sendHumanFollowup'].includes(String(row.command)));
    expect(submissions.map(row=>(row.input as {text:string}).text)).toEqual(['第一条持久排队全文','无需等待上一条确认的第二条']);
    expect(new Set(submissions.map(row=>row.commandId)).size).toBe(2);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test.each(['NEW_INPUT','SAME_TEXT_NEW_REVISION','TARGET_SWITCH'] as const)('late accepted submission preserves %s',async mode=>{
  const f=await setup();try{
    f.hold();await editor(f.page).fill('提交原稿');await f.page.getByRole('button',{name:'发送',exact:true}).click();await expect.poll(f.held).toBe(true);
    if(mode==='TARGET_SWITCH'){await f.page.getByRole('button',{name:/连续回复B/}).click();await f.page.getByRole('heading',{name:'连续回复B',exact:true}).waitFor();await editor(f.page).fill('B的新稿');}
    else {await editor(f.page).fill('');await editor(f.page).fill(mode==='NEW_INPUT'?'之后输入的新稿':'提交原稿');}
    f.release();await new Promise(resolve=>setTimeout(resolve,650));
    expect(await editor(f.page).inputValue()).toBe(mode==='TARGET_SWITCH'?'B的新稿':mode==='NEW_INPUT'?'之后输入的新稿':'提交原稿');
    expect(f.calls.filter(row=>row.command==='sendHumanReply')).toHaveLength(1);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test.each(['NO_ACK','WRONG_COMMAND'] as const)('unproven %s response never clears or replays the submitted input',async fault=>{
  const f=await setup();try{
    f.next(fault==='NO_ACK'?{status:'PREPARING'}:{accepted:true,commandId:randomUUID(),status:'QUEUED'});
    await editor(f.page).fill('未证明接受的人稿');await f.page.getByRole('button',{name:'发送',exact:true}).click();
    await new Promise(resolve=>setTimeout(resolve,650));expect(await editor(f.page).inputValue()).toBe('未证明接受的人稿');
    expect(f.calls.filter(row=>row.command==='sendHumanReply')).toHaveLength(1);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('a later read of the same durable command can acknowledge its submitted revision without submitting again',async()=>{
  const f=await setup();try{
    f.next({status:'PREPARING'});await editor(f.page).fill('只补读命令接受结果');await f.page.getByRole('button',{name:'发送',exact:true}).click();
    await expect.poll(()=>f.commands.size).toBe(1);expect(await editor(f.page).inputValue()).toBe('只补读命令接受结果');
    for(const row of f.commands.values())row.result={...row.result,accepted:true};
    await expect.poll(()=>editor(f.page).inputValue()).toBe('');
    expect(f.calls.filter(row=>row.command==='sendHumanReply')).toHaveLength(1);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('late acknowledgement retained across unchanged-status polls restores an untouched editor on pre-click failure',async()=>{
  const f=await setup();try{
    f.next({status:'PREPARING'});await editor(f.page).fill('迟到接受后失败仍可恢复的原稿');await f.page.getByRole('button',{name:'发送',exact:true}).click();
    await expect.poll(()=>f.commands.size).toBe(1);for(const row of f.commands.values())row.result={...row.result,accepted:true};
    await expect.poll(()=>editor(f.page).inputValue()).toBe('');const acknowledged=f.calls.filter(row=>row.command==='getSendResult').length;
    await expect.poll(()=>f.calls.filter(row=>row.command==='getSendResult').length).toBeGreaterThan(acknowledged);
    f.fail();await f.page.getByTestId('reply-send-result').getByText('尚未发送',{exact:true}).waitFor();
    await expect.poll(()=>editor(f.page).inputValue()).toBe('迟到接受后失败仍可恢复的原稿');
    expect(f.calls.filter(row=>row.command==='sendHumanReply')).toHaveLength(1);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test.each([false,true])('failure before click restores only an untouched cleared editor, newer input=%s',async newer=>{
  const f=await setup();try{
    await editor(f.page).fill('只在未新增输入时恢复的未发全文');await f.page.getByRole('button',{name:'发送',exact:true}).click();
    await expect.poll(()=>editor(f.page).inputValue()).toBe('');if(newer)await editor(f.page).fill('下一稿不被旧失败覆盖');f.fail();
    await f.page.getByTestId('reply-send-result').getByText('尚未发送',{exact:true}).waitFor();
    expect(await editor(f.page).inputValue()).toBe(newer?'下一稿不被旧失败覆盖':'只在未新增输入时恢复的未发全文');
    expect(f.calls.filter(row=>row.command==='sendHumanReply')).toHaveLength(1);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test.each([true,false])('an old unknown freeze admits a distinct human sentence only with authoritative queueReady=%s',async ready=>{
  const f=await setup();try{
    await editor(f.page).fill('已经提交且保持未知的原句');await f.page.getByRole('button',{name:'发送',exact:true}).click();
    await expect.poll(()=>editor(f.page).inputValue()).toBe('');f.freeze(ready);
    await f.page.getByTestId('reply-send-result').getByText('等待确认',{exact:true}).waitFor();
    await editor(f.page).fill('与未知原句不同的独立新内容');
    const send=f.page.getByRole('button',{name:'发送',exact:true});
    if(ready){await expect.poll(()=>f.followupDrafts.get(f.a)?.text).toBe('与未知原句不同的独立新内容');
      expect(await send.isEnabled()).toBe(true);await send.click();await expect.poll(()=>editor(f.page).inputValue()).toBe('');
      expect(f.calls.filter(row=>row.command==='sendHumanFollowup')).toHaveLength(1);
    }else{expect(await send.isDisabled()).toBe(true);expect(f.calls.filter(row=>row.command==='sendHumanFollowup')).toHaveLength(0);}
    expect(f.calls.filter(row=>row.command==='sendHumanReply')).toHaveLength(1);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});
