import {expect,test,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {BrowserService} from '../../src/app/browser-service.js';
import {AccountActor} from '../../src/browser/account-actor.js';
import {ClientService} from '../../src/app/service.js';
import {HumanReplyWorkflow} from '../../src/app/human-reply-workflow.js';
import {DeepSeekProvider} from '../../src/ai/deepseek.js';
import {defaultSettings} from '../../src/app/contracts.js';
import type {ReplyPolicy} from '../../src/app/automation-contracts.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {Blocked,digest,targetKey,type InboundEvent} from '../../src/core/contracts.js';
import {candidate,database,pending,privateTemp,snapshot} from '../helpers.js';

class CommentRecoveryBrowser extends BrowserService {
  private queue=new AccountActor();clicks=0;preparations=0;failure:string|null='COMMENT_REPLY_ROOT_NOT_UNIQUE';
  override get actor(){return this.queue;}
  override identity(){return{identityDigest:digest('own-1'),mappingDigest:'synthetic',browserVersion:'1.0.0.0',browserMode:'headless' as const};}
  override async refreshIdentity(){return this.identity();}
  override async close(){}
  override async adapter(event:InboundEvent){let text='';return{dispose:()=>{},adapter:{inspect:async()=>snapshot(event),
    prepare:async(_event:InboundEvent,value:string)=>{this.preparations++;if(this.failure)throw new Blocked(this.failure);text=value;},
    verifyPrepared:async()=>snapshot(event),baseline:async()=>[],clickOnce:async()=>{this.clicks++;await new Promise(resolve=>setTimeout(resolve,5));},
    readback:async()=>({id:randomUUID(),ownId:'own-1',targetKey:targetKey(event),text,pending:false,sentAt:new Date().toISOString()})}};}
}
const policy:ReplyPolicy={ownId:'own-1',channels:['COMMENT_NOTIFICATION'],model:'deepseek-flash',modelLimit:1,sendLimit:2,expiresAt:null,
  workIds:['10'],futureOwnWorks:false,conversationIds:[],entireInbox:false,containsAny:[],excludesAny:[],instructions:'Answer the comment.',startHour:0,endHour:24};
async function setup(){
  const store=database(),root=privateTemp('policy-comment-root-');await migrateClient(store,join(root,'client.sqlite'));
  const id=pending(store,candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',platformEventId:'11',commentId:'11',videoId:'10',conversationId:null}));
  const browser=new CommentRecoveryBrowser(root);let models=0;
  const provider=new DeepSeekProvider(async()=>{models++;return new Response(JSON.stringify({model:policy.model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'A saved exact comment answer'}}],
    usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}}));});
  const service=new ClientService(store,browser,provider);await service.loadSettings();const token=service.authority.issueSession();
  await service.dispatch(token,{command:'configureAi',settings:defaultSettings,key:'synthetic-only-key'});
  await service.dispatch(token,{command:'setReplyPolicy',policy,confirmed:true});await service.dispatch(token,{command:'setMode',mode:'LIMITED_AUTO'});
  await service.runAutomaticReply();expect(models).toBe(1);expect(browser.clicks).toBe(0);
  expect(store.db.prepare('SELECT state,reason FROM automation_jobs WHERE event_id=?').get(id)).toEqual({state:'FAILED_BEFORE_CLICK',reason:'COMMENT_REPLY_ROOT_NOT_UNIQUE'});
  const draft=service.authority.draftFor(id)!,command=(store.db.prepare('SELECT command_id FROM automation_jobs WHERE event_id=?').get(id) as {command_id:string}).command_id;
  const count=()=>store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='AUTO_COMMENT_ROOT_REQUALIFIED' AND entity_id=?").get(draft.id);
  return{store,service,browser,token,id,draft,command,count,models:()=>models,close:async()=>{await service.close();store.close();}};
}

test('a saved paid comment draft gets one fresh qualification after native root location is fixed, without MODEL allowance or another call',async()=>{
  const f=await setup();try{
    const modelReservations=f.store.db.prepare("SELECT * FROM grant_reservations WHERE kind='MODEL'").all();
    f.browser.failure=null;await f.service.runAutomaticReply();
    expect(f.models()).toBe(1);expect(f.browser.preparations).toBe(2);expect(f.browser.clicks).toBe(1);expect(f.count()).toEqual({n:1});
    expect(f.service.authority.draftFor(f.id)).toMatchObject({id:f.draft.id,version:f.draft.version,text:f.draft.text,origin:'AUTO_POLICY'});
    expect(f.store.event(f.id).status).toBe('CONFIRMED');expect(f.store.budget('MODEL').used).toBe(1);expect(f.store.budget('SEND').used).toBe(1);
    expect(f.store.db.prepare("SELECT * FROM grant_reservations WHERE kind='MODEL'").all()).toEqual(modelReservations);
    await f.service.runAutomaticReply();expect(f.browser.clicks).toBe(1);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents WHERE event_id=?').get(f.id)).toEqual({n:1});
  }finally{await f.close();}
});

test.each(['COMMENT_REPLY_ROOT_NOT_UNIQUE','TARGET_CHANGED_REAPPROVE','RESTART_NO_REPLAY'] as const)
  ('the one root requalification cannot fall back into ordinary retries after %s',async failure=>{
  const f=await setup();try{
    f.browser.failure=failure==='RESTART_NO_REPLAY'?'COMMENT_REPLY_ROOT_NOT_UNIQUE':failure;
    await f.service.runAutomaticReply();expect(f.count()).toEqual({n:1});
    if(failure==='RESTART_NO_REPLAY')f.store.db.prepare("UPDATE automation_jobs SET state='REVIEW',reason='RESTART_NO_REPLAY' WHERE event_id=?").run(f.id);
    for(let turn=0;turn<4;turn++)await f.service.runAutomaticReply();
    expect(f.browser.preparations).toBe(2);expect(f.models()).toBe(1);expect(f.browser.clicks).toBe(0);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
    expect(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type IN ('AUTO_DRAFT_RESUMED','AUTO_VIEWPORT_REQUALIFIED')").get()).toEqual({n:0});
  }finally{await f.close();}
});

test.each(['intent','human','ownership','context','revoked','off','emergency','scope','command','version'] as const)
  ('the paid root draft keeps its original authorization boundary (%s)',async fault=>{
  const f=await setup();try{
    f.browser.failure=null;
    if(fault==='intent'){
      const event=f.store.event(f.id);f.store.approve(f.draft.id,snapshot(event.payload),f.draft.version,f.draft.text);
      const intent=f.store.recordIntent(f.draft.id,snapshot(event.payload),false,{check:()=>{},committed:()=>{}});f.store.receipt(intent,'UNCERTAIN','synthetic-unknown');
    }else if(fault==='human'||fault==='ownership'){
      const owner=f.service.authority.claim(f.token,f.id,f.service.authority.ownership(f.store.event(f.id)).generation);
      if(fault==='human')f.service.authority.save(f.token,f.id,owner.generation,f.draft.version,'A human replacement');
    }else if(fault==='context')f.store.db.prepare("UPDATE automation_jobs SET context_version='different-context' WHERE event_id=?").run(f.id);
    else if(fault==='revoked')await f.service.dispatch(f.token,{command:'setReplyPolicy',policy:null,confirmed:true});
    else if(fault==='off')await f.service.dispatch(f.token,{command:'setAutomaticReply',enabled:false});
    else if(fault==='emergency')await f.service.dispatch(f.token,{command:'emergencyStop'});
    else if(fault==='scope')await f.service.dispatch(f.token,{command:'setReplyPolicy',policy:{...policy,workIds:['20']},confirmed:true});
    else if(fault==='command')f.store.db.prepare("UPDATE manual_send_commands SET params_digest='damaged' WHERE command_id=?").run(f.command);
    else f.store.db.prepare('UPDATE automation_jobs SET draft_version=draft_version+1 WHERE event_id=?').run(f.id);
    const oldReceipts=f.store.db.prepare('SELECT * FROM delivery_receipts').all();await f.service.runAutomaticReply();
    expect(f.count()).toEqual({n:0});expect(f.models()).toBe(1);expect(f.browser.preparations).toBe(1);expect(f.browser.clicks).toBe(0);
    expect(f.store.db.prepare('SELECT * FROM delivery_receipts').all()).toEqual(oldReceipts);
    expect(f.store.budget('MODEL').used).toBe(1);expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:fault==='intent'?1:0});
  }finally{await f.close();}
});

test('a budget-only policy revision keeps the paid draft and inherited MODEL reservation through root qualification',async()=>{
  const f=await setup();try{
    await f.service.dispatch(f.token,{command:'setReplyPolicy',policy:{...policy,modelLimit:null,sendLimit:null},confirmed:true});
    const reservations=f.store.db.prepare("SELECT * FROM grant_reservations WHERE kind='MODEL'").all();
    f.browser.failure=null;await f.service.runAutomaticReply();
    expect(f.models()).toBe(1);expect(f.browser.clicks).toBe(1);expect(f.count()).toEqual({n:1});expect(f.store.budget('MODEL').used).toBe(1);
    expect(f.store.db.prepare("SELECT * FROM grant_reservations WHERE kind='MODEL'").all()).toEqual(reservations);
  }finally{await f.close();}
});

test('a crash after the durable root qualification is consumed cannot replay preparation after service restart',async()=>{
  const f=await setup(),prepare=vi.spyOn(HumanReplyWorkflow.prototype,'prepare').mockRejectedValueOnce(new Error('synthetic-stop-after-claim'));
  let restarted:ClientService|undefined;try{
    await expect(f.service.runAutomaticReply()).rejects.toThrow('synthetic-stop-after-claim');prepare.mockRestore();expect(f.count()).toEqual({n:1});
    expect(f.store.db.prepare('SELECT state FROM automation_jobs WHERE event_id=?').get(f.id)).toEqual({state:'PREPARING'});
    await f.service.close();const browser=new CommentRecoveryBrowser(f.browser.root);browser.failure=null;
    let calls=0;restarted=new ClientService(f.store,browser,new DeepSeekProvider(async()=>{calls++;throw new Error('must not call');}));
    await restarted.loadSettings();const token=restarted.authority.issueSession();
    await restarted.dispatch(token,{command:'configureAi',settings:defaultSettings,key:'synthetic-only-key'});
    await restarted.runAutomaticReply();expect(f.count()).toEqual({n:1});expect(browser.preparations).toBe(0);expect(browser.clicks).toBe(0);expect(calls).toBe(0);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});expect(f.store.budget('MODEL').used).toBe(1);
  }finally{prepare.mockRestore();await restarted?.close();await f.close();}
});

async function afterClosingClaim(){
  const f=await setup();f.browser.failure='CLIENT_CLOSING';await f.service.runAutomaticReply();expect(f.count()).toEqual({n:1});
  expect(f.store.db.prepare('SELECT state,reason FROM automation_jobs WHERE event_id=?').get(f.id)).toEqual({state:'FAILED_BEFORE_CLICK',reason:'CLIENT_CLOSING'});
  return{...f,closeCount:()=>f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='AUTO_COMMENT_ROOT_CLOSE_RESUMED' AND entity_id=?").get(f.draft.id)};
}
test('one exact claimed root preparation interrupted by closing resumes without releasing its marker or spending another model call',async()=>{
  const f=await afterClosingClaim();try{
    const marker=f.store.db.prepare("SELECT * FROM audit_events WHERE event_type='AUTO_COMMENT_ROOT_REQUALIFIED'").all(),modelReservations=f.store.db.prepare("SELECT * FROM grant_reservations WHERE kind='MODEL'").all();
    f.browser.failure=null;await f.service.runAutomaticReply();
    expect(f.browser.preparations).toBe(3);expect(f.browser.clicks).toBe(1);expect(f.models()).toBe(1);expect(f.closeCount()).toEqual({n:1});
    expect(f.service.authority.draftFor(f.id)).toMatchObject({id:f.draft.id,version:1,text:f.draft.text,origin:'AUTO_POLICY'});
    expect(f.store.event(f.id).status).toBe('CONFIRMED');expect(f.store.budget('MODEL').used).toBe(1);
    expect(f.store.db.prepare("SELECT * FROM grant_reservations WHERE kind='MODEL'").all()).toEqual(modelReservations);
    expect(f.store.db.prepare("SELECT * FROM audit_events WHERE event_type='AUTO_COMMENT_ROOT_REQUALIFIED'").all()).toEqual(marker);
    await f.service.runAutomaticReply();expect(f.browser.clicks).toBe(1);expect(f.closeCount()).toEqual({n:1});
  }finally{await f.close();}
});

test.each(['CLIENT_CLOSING','COMMENT_REPLY_ROOT_NOT_FOUND','TARGET_CHANGED_REAPPROVE'] as const)
  ('the closing continuation remains consumed after %s and restart classification',async failure=>{
  const f=await afterClosingClaim();try{
    f.browser.failure=failure;await f.service.runAutomaticReply();expect(f.closeCount()).toEqual({n:1});
    for(let turn=0;turn<3;turn++)await f.service.runAutomaticReply();
    f.store.db.prepare("UPDATE automation_jobs SET state='REVIEW',reason='RESTART_NO_REPLAY' WHERE event_id=?").run(f.id);
    await f.service.runAutomaticReply();expect(f.browser.preparations).toBe(3);expect(f.browser.clicks).toBe(0);expect(f.models()).toBe(1);
    expect(f.count()).toEqual({n:1});expect(f.closeCount()).toEqual({n:1});expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{await f.close();}
});

test.each(['intent','send-reserved','command','marker-version','ownership'] as const)
  ('a closing label cannot bypass persistent send and exact command boundaries (%s)',async fault=>{
  const f=await afterClosingClaim();try{
    f.browser.failure=null;
    const command=(f.store.db.prepare('SELECT command_id FROM automation_jobs WHERE event_id=?').get(f.id) as {command_id:string}).command_id;
    if(fault==='intent'){
      f.store.approve(f.draft.id,snapshot(f.store.event(f.id).payload),f.draft.version,f.draft.text);
      const intent=f.store.recordIntent(f.draft.id,snapshot(f.store.event(f.id).payload),false,{check:()=>{},committed:()=>{}});f.store.receipt(intent,'UNCERTAIN','synthetic-unknown');
    }else if(fault==='send-reserved'){
      const version=(f.store.db.prepare('SELECT grant_version FROM automation_jobs WHERE event_id=?').get(f.id) as {grant_version:number}).grant_version;
      f.store.db.prepare("INSERT INTO grant_reservations VALUES(?,'SEND',?,?)").run(version,f.id,Date.now());
    }else if(fault==='command')f.store.db.prepare("UPDATE manual_send_commands SET reason='TARGET_CHANGED_REAPPROVE' WHERE command_id=?").run(command);
    else if(fault==='marker-version')f.store.db.prepare("UPDATE audit_events SET detail_redacted='{}' WHERE event_type='AUTO_COMMENT_ROOT_REQUALIFIED'").run();
    else f.service.authority.claim(f.token,f.id,f.service.authority.ownership(f.store.event(f.id)).generation);
    const receipts=f.store.db.prepare('SELECT * FROM delivery_receipts').all();await f.service.runAutomaticReply();
    expect(f.closeCount()).toEqual({n:0});expect(f.count()).toEqual({n:1});expect(f.models()).toBe(1);expect(f.browser.clicks).toBe(0);expect(f.browser.preparations).toBe(2);
    expect(f.store.db.prepare('SELECT * FROM delivery_receipts').all()).toEqual(receipts);expect(f.store.budget('MODEL').used).toBe(1);
  }finally{await f.close();}
});

test('a root marker committed after candidate selection is reread inside the qualification transaction',async()=>{
  const f=await setup(),original=f.store.db.transaction.bind(f.store.db);let inserted=false;
  const transaction=vi.spyOn(f.store.db,'transaction').mockImplementation(fn=>{
    if(!inserted){inserted=true;f.store.audit('AUTO_COMMENT_ROOT_REQUALIFIED',f.draft.id,{version:f.draft.version,contract:1});}
    return original(fn);
  });
  try{
    f.browser.failure=null;await expect(f.service.runAutomaticReply()).rejects.toThrow('COMMENT_ROOT_REQUALIFICATION_USED');
    expect(f.count()).toEqual({n:1});expect(f.browser.preparations).toBe(1);expect(f.browser.clicks).toBe(0);expect(f.models()).toBe(1);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{transaction.mockRestore();await f.close();}
});
