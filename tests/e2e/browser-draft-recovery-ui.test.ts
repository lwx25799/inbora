import {expect,test} from 'vitest';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AccountActor} from '../../src/browser/account-actor.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {ClientService} from '../../src/app/service.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {digest,type InboundEvent} from '../../src/core/contracts.js';
import {database,privateTemp,pending,snapshot} from '../helpers.js';

test('fault recovery shows the persisted automatic draft and clears only after its explicit button, preserving the draft and all send history',async()=>{
  const root=privateTemp('browser-draft-recovery-ui-'),store=database(),eventId=pending(store);await migrateClient(store,join(root,'backup.sqlite'));
  const saved='Synthetic saved automatic reply';let web=saved,clears=0;const actor=new AccountActor();
  const browserService=new class extends BrowserService{
    override get actor(){return actor;}
    override status(){return {state:'OPEN_LAST_READ_VERIFIED',mode:'headless' as const,version:'synthetic'};}
    override async adapter(){return {dispose:()=>{},adapter:{
      inspect:async(event:InboundEvent)=>snapshot(event),prepare:async()=>{throw Error('MUST_NOT_PREPARE');},verifyPrepared:async(event:InboundEvent)=>snapshot(event),
      baseline:async()=>[],clickOnce:async()=>{throw Error('MUST_NOT_SEND');},readback:async()=>null,
      readSavedDraft:async(event:InboundEvent)=>({text:web,snapshot:snapshot(event)}),
      clearSavedDraft:async(_event:InboundEvent,text:string)=>{expect(web).toBe(text);clears++;web='';},
    }};}
    override async close(){}
  }(root);
  const service=new ClientService(store,browserService);await service.loadSettings();const token=service.authority.issueSession(),draftId=randomUUID(),commandId=randomUUID();
  const grant=new AutomationStore(store).grant('AUTO_REPLY',{ownId:'own-1',channels:['DIRECT_MESSAGE'],model:'deepseek-flash',modelLimit:2,sendLimit:2,expiresAt:null,
    workIds:[],futureOwnWorks:false,conversationIds:[],entireInbox:true,containsAny:[],excludesAny:[],instructions:'Synthetic only',startHour:0,endHour:24});
  store.db.prepare("INSERT INTO reply_drafts VALUES(?,?,?,?,1,'DRAFT',NULL,NULL)").run(draftId,eventId,saved,'deepseek-flash');
  store.db.prepare("UPDATE inbound_events SET status='AWAITING_APPROVAL' WHERE id=?").run(eventId);
  store.db.prepare("INSERT INTO draft_revisions VALUES(?,1,'AUTO_POLICY',?,?,?)").run(draftId,saved,'policy:'+grant.version,Date.now());
  const params={eventId,generation:0,draftId,draftVersion:1,text:saved,contextVersion:service.authority.contextVersion(store.event(eventId)),selectionId:randomUUID()};
  store.db.prepare('INSERT INTO manual_send_commands VALUES(?,?,?,?,?,?,?,?,?)').run(commandId,eventId,service.authority.operator(token).id,digest(params),JSON.stringify(params),'FAILED_BEFORE_CLICK',null,'TARGET_CHANGED_REAPPROVE',Date.now());
  store.db.prepare('INSERT INTO policy_commands VALUES(?,?,0)').run(commandId,grant.version);
  const before=['reply_drafts','draft_revisions','manual_send_commands','send_intents','delivery_receipts','budgets'].map(name=>store.db.prepare('SELECT * FROM '+name).all());
  const server=await createServer({configFile:resolve('desktop/vite.config.ts'),server:{port:0,strictPort:false},logLevel:'error'});await server.listen();
  const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage();page.setDefaultTimeout(3000);await page.clock.install();
  const calls:string[]=[],errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.exposeFunction('fixtureInvoke',async(command:string,args:{body?:Record<string,unknown>})=>{
    if(command==='desktop_info')return {runtime:root,version:'synthetic-recovery'};
    if(command!=='client_request')throw Error('UNEXPECTED_NATIVE_COMMAND');calls.push(String(args.body!.action??args.body!.command));return service.dispatch(token,args.body!);
  });
  await page.addInitScript(()=>{const fixture=window as unknown as {__TAURI_INTERNALS__:unknown;fixtureInvoke:(command:string,args:unknown)=>Promise<unknown>};
    fixture.__TAURI_INTERNALS__={invoke:(command:string,args:unknown)=>fixture.fixtureInvoke(command,args)};});
  try{
    await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}`);
    web='';await page.getByRole('button',{name:'AI 与设置',exact:true}).click();await page.getByText('故障处理',{exact:true}).click();
    const recovery=page.getByRole('region',{name:'网页未发送内容恢复'});
    await recovery.getByText('当前没有可安全清理的已保存自动回复稿，网页输入已保留。',{exact:true}).waitFor();
    expect(clears).toBe(0);web=saved;await page.clock.fastForward(15_000);
    await recovery.getByText(saved,{exact:true}).waitFor();
    expect(calls.filter(command=>command==='inspectSavedDraftRecovery')).toHaveLength(2);
    await page.clock.fastForward(60_000);expect(calls.filter(command=>command==='inspectSavedDraftRecovery')).toHaveLength(2);
    expect(await recovery.innerText()).toContain('保留已保存的应用回复草稿和版本');expect(clears).toBe(0);expect(web).toBe(saved);
    await page.getByRole('button',{name:'收件箱',exact:true}).click();await page.getByRole('button',{name:'AI 与设置',exact:true}).click();await page.getByText('故障处理',{exact:true}).click();
    await recovery.getByRole('button',{name:'保留应用回复稿并清空网页未发送内容',exact:true}).click();
    await recovery.getByText('网页未发送内容已清空，应用回复草稿和版本已保留；未发送或重试。',{exact:true}).waitFor();
    expect(clears).toBe(1);expect(web).toBe('');expect(calls.filter(command=>command==='clearSavedDraftRecovery')).toHaveLength(1);
    expect(['reply_drafts','draft_revisions','manual_send_commands','send_intents','delivery_receipts','budgets'].map(name=>store.db.prepare('SELECT * FROM '+name).all())).toEqual(before);
    expect(calls.some(command=>['sendHumanReply','generateSuggestion'].includes(command))).toBe(false);expect(store.db.prepare('SELECT count(*) n FROM model_calls').get()).toEqual({n:0});expect(errors).toEqual([]);
    await page.getByRole('button',{name:'收件箱',exact:true}).click();await page.getByRole('button',{name:'AI 与设置',exact:true}).click();
    await expect.poll(()=>calls.filter(command=>command==='inspectSavedDraftRecovery').length).toBe(4);
    await page.getByText('故障处理',{exact:true}).click();
    await recovery.getByText('当前没有可安全清理的已保存自动回复稿，网页输入已保留。',{exact:true}).waitFor();
    for(const count of [5,6,7]){
      await page.clock.fastForward(15_000);await expect.poll(()=>calls.filter(command=>command==='inspectSavedDraftRecovery').length).toBe(count);
      await recovery.getByText('当前没有可安全清理的已保存自动回复稿，网页输入已保留。',{exact:true}).waitFor();
    }
    await page.clock.fastForward(60_000);expect(calls.filter(command=>command==='inspectSavedDraftRecovery')).toHaveLength(7);
    await page.getByRole('button',{name:'收件箱',exact:true}).click();await page.clock.fastForward(60_000);
    expect(calls.filter(command=>command==='inspectSavedDraftRecovery')).toHaveLength(7);
  }finally{await browser.close();await server.close();await service.close();store.close();}
});
