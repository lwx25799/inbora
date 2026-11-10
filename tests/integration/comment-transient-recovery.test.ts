import {expect,test} from 'vitest';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AccountActor} from '../../src/browser/account-actor.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {ClientService} from '../../src/app/service.js';
import {DeepSeekProvider} from '../../src/ai/deepseek.js';
import {defaultSettings} from '../../src/app/contracts.js';
import type {ReplyPolicy} from '../../src/app/automation-contracts.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {Blocked,digest,targetKey,type InboundEvent} from '../../src/core/contracts.js';
import {candidate,database,pending,privateTemp,snapshot} from '../helpers.js';

class TransientCommentBrowser extends BrowserService {
  private queue=new AccountActor();inspections=0;preparations=0;clicks=0;wrongTarget=false;
  badIds=new Set<string>();inspectedIds:string[]=[];
  failure:'ROOT'|'CLOCK'|null='ROOT';
  override get actor(){return this.queue;}
  override identity(){return{identityDigest:digest('own-1'),mappingDigest:'synthetic',browserVersion:'1.0',browserMode:'headless' as const};}
  override async refreshIdentity(){return this.identity();}
  override async close(){}
  override async adapter(event:InboundEvent){let text='';return{dispose:()=>{},adapter:{
    inspect:async()=>{this.inspections++;this.inspectedIds.push(event.commentId!);if(this.failure==='ROOT'||this.badIds.has(event.commentId!))throw new Blocked('COMMENT_REPLY_ROOT_NOT_UNIQUE');
      return{...snapshot(event),...(this.wrongTarget?{targetKey:'comment:10:999'}:{})};},
    prepare:async(_event:InboundEvent,value:string)=>{this.preparations++;if(this.failure==='CLOCK')throw new Blocked('COMMENT_REPLY_CLOCK_UNVERIFIED');text=value;},
    verifyPrepared:async()=>snapshot(event),baseline:async()=>[],clickOnce:async()=>{this.clicks++;await new Promise(resolve=>setTimeout(resolve,5));},
    readback:async()=>({id:randomUUID(),ownId:'own-1',targetKey:targetKey(event),text,pending:false,sentAt:new Date().toISOString()})}};}
}
const policy:ReplyPolicy={ownId:'own-1',channels:['COMMENT_NOTIFICATION'],model:'deepseek-flash',modelLimit:1,sendLimit:1,expiresAt:null,
  workIds:['10'],futureOwnWorks:false,conversationIds:[],entireInbox:false,containsAny:[],excludesAny:[],instructions:'Synthetic exact nested reply',startHour:0,endHour:24};
async function setup(failure:'ROOT'|'CLOCK'){
  const store=database(),root=privateTemp('comment-transient-recovery-');await migrateClient(store,join(root,'client.sqlite'));
  const original=candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',platformEventId:'11',commentId:'11',videoId:'10',conversationId:null});
  const rootId=pending(store,original);store.db.prepare("UPDATE inbound_events SET status='BASELINE' WHERE id=?").run(rootId);
  const id=pending(store,{...original,kind:'REPLY',platformEventId:'21',commentId:'21',rootCommentId:'11',replyToCommentId:'21',
    occurredAt:new Date(Date.parse(original.occurredAt!)+1000).toISOString()});
  const browser=new TransientCommentBrowser(root);browser.failure=failure;let models=0;
  const provider=new DeepSeekProvider(async()=>{models++;return new Response(JSON.stringify({model:policy.model,
    choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'The one saved exact nested answer'}}],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}}));});
  const service=new ClientService(store,browser,provider);await service.loadSettings();const token=service.authority.issueSession();
  await service.dispatch(token,{command:'configureAi',settings:defaultSettings,key:'synthetic-only-key'});
  await service.dispatch(token,{command:'setReplyPolicy',policy,confirmed:true});await service.dispatch(token,{command:'setMode',mode:'LIMITED_AUTO'});
  await service.runAutomaticReply();
  expect(store.db.prepare('SELECT state,reason,draft_version FROM automation_jobs WHERE event_id=?').get(id)).toEqual(failure==='ROOT'?
    {state:'REVIEW',reason:'COMMENT_REPLY_ROOT_NOT_UNIQUE',draft_version:0}:{state:'FAILED_BEFORE_CLICK',reason:'COMMENT_REPLY_CLOCK_UNVERIFIED',draft_version:1});
  expect(models).toBe(failure==='ROOT'?0:1);expect(browser.clicks).toBe(0);
  const job=()=>store.db.prepare('SELECT * FROM automation_jobs WHERE event_id=?').get(id) as {command_id:string;context_version:string};
  return{store,service,browser,token,id,job,models:()=>models,close:async()=>{await service.close();store.close();}};
}

test.each(['ROOT','CLOCK'] as const)('a recovered %s qualification processes the same exact nested event with one total model call',async failure=>{
  const f=await setup(failure);try{
    const draft=f.service.authority.draftFor(f.id),modelReservations=f.store.db.prepare("SELECT * FROM grant_reservations WHERE kind='MODEL'").all();
    f.browser.failure=null;await f.service.runAutomaticReply();
    expect(f.models()).toBe(1);expect(f.browser.clicks).toBe(1);expect(f.store.event(f.id).status).toBe('CONFIRMED');
    if(failure==='CLOCK'){
      expect(f.service.authority.draftFor(f.id)).toMatchObject({id:draft!.id,version:draft!.version,text:draft!.text,origin:'AUTO_POLICY'});
      expect(f.store.db.prepare("SELECT * FROM grant_reservations WHERE kind='MODEL'").all()).toEqual(modelReservations);
    }
    await f.service.runAutomaticReply();expect(f.browser.clicks).toBe(1);expect(f.models()).toBe(1);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents WHERE event_id=?').get(f.id)).toEqual({n:1});
  }finally{await f.close();}
});

test.each(['ROOT','CLOCK'] as const)('a still failing %s qualification consumes one durable continuation and never loops',async failure=>{
  const f=await setup(failure);try{
    const calls=f.browser.inspections;await f.service.runAutomaticReply();expect(f.browser.inspections).toBeGreaterThan(calls);
    const after=f.browser.inspections;f.browser.failure=null;
    for(let turn=0;turn<3;turn++)await f.service.runAutomaticReply();
    expect(f.browser.inspections).toBe(after);expect(f.browser.clicks).toBe(0);expect(f.models()).toBe(failure==='ROOT'?0:1);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{await f.close();}
});

test.each(['target','context','scope','off','reserved','intent'] as const)('root requalification does not bypass %s before the first model call',async fault=>{
  const f=await setup('ROOT');try{
    f.browser.failure=null;
    if(fault==='target')f.browser.wrongTarget=true;
    if(fault==='context')f.store.db.prepare("UPDATE automation_jobs SET context_version='changed-context' WHERE event_id=?").run(f.id);
    if(fault==='scope')await f.service.dispatch(f.token,{command:'setReplyPolicy',policy:{...policy,instructions:'A different rule'},confirmed:true});
    if(fault==='off')await f.service.dispatch(f.token,{command:'setAutomaticReply',enabled:false});
    if(fault==='reserved')f.store.db.prepare("INSERT INTO grant_reservations VALUES(?,'MODEL',?,?)")
      .run((f.store.db.prepare("SELECT version FROM automation_grants WHERE kind='AUTO_REPLY' AND revoked_at IS NULL").get() as {version:number}).version,f.id,Date.now());
    if(fault==='intent'){
      const event=f.store.event(f.id),owner=f.service.authority.claim(f.token,f.id,f.service.authority.ownership(event).generation);
      const draft=f.service.authority.save(f.token,f.id,owner.generation,0,'old unknown text');
      f.store.approve(draft.id,snapshot(event.payload),draft.version,draft.text);
      const intent=f.store.recordIntent(draft.id,snapshot(event.payload),false,{check:()=>{},committed:()=>{}});f.store.receipt(intent,'UNCERTAIN','synthetic-preserved-unknown');
    }
    const old=f.store.db.prepare('SELECT * FROM delivery_receipts').all();await f.service.runAutomaticReply();
    expect(f.models()).toBe(0);expect(f.browser.clicks).toBe(0);expect(f.store.db.prepare('SELECT * FROM delivery_receipts').all()).toEqual(old);
  }finally{await f.close();}
});

test.each(['command','version','send-reserved','context'] as const)('a paid clock continuation preserves the exact %s boundary',async fault=>{
  const f=await setup('CLOCK');try{
    f.browser.failure=null;
    if(fault==='command')f.store.db.prepare("UPDATE manual_send_commands SET params_digest='changed-command' WHERE command_id=?").run(f.job().command_id);
    if(fault==='version')f.store.db.prepare('UPDATE automation_jobs SET draft_version=draft_version+1 WHERE event_id=?').run(f.id);
    if(fault==='send-reserved')f.store.db.prepare("INSERT INTO grant_reservations VALUES(?,'SEND',?,?)")
      .run((f.store.db.prepare("SELECT version FROM automation_grants WHERE kind='AUTO_REPLY' AND revoked_at IS NULL").get() as {version:number}).version,f.id,Date.now());
    if(fault==='context')f.store.db.prepare("UPDATE automation_jobs SET context_version='changed-context' WHERE event_id=?").run(f.id);
    const old=f.store.db.prepare("SELECT * FROM grant_reservations WHERE kind='MODEL'").all();await f.service.runAutomaticReply();
    expect(f.models()).toBe(1);expect(f.browser.clicks).toBe(0);expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
    expect(f.store.db.prepare("SELECT * FROM grant_reservations WHERE kind='MODEL'").all()).toEqual(old);
  }finally{await f.close();}
});

test('one automatic turn rechecks at most one old bad root and still processes an independent eligible target',async()=>{
  const f=await setup('ROOT');try{
    const first=f.store.event(f.id).payload,second=pending(f.store,{...first,platformEventId:'22',commentId:'22',replyToCommentId:'22',
      occurredAt:new Date(Date.parse(first.occurredAt!)+1000).toISOString()});
    const eligible=pending(f.store,{...first,platformEventId:'23',commentId:'23',replyToCommentId:'23',
      occurredAt:new Date(Date.parse(first.occurredAt!)+2000).toISOString()});
    f.store.db.prepare('UPDATE automation_jobs SET context_version=? WHERE event_id=?').run(f.service.authority.contextVersion(f.store.event(f.id)),f.id);
    const grant=(f.store.db.prepare("SELECT version FROM automation_grants WHERE kind='AUTO_REPLY' AND revoked_at IS NULL").get() as {version:number}).version;
    f.store.db.prepare("INSERT INTO automation_jobs VALUES(?,?,'REVIEW',?,?,0,'COMMENT_REPLY_ROOT_NOT_UNIQUE',NULL,?,?)")
      .run(second,grant,f.service.authority.contextVersion(f.store.event(second)),f.service.authority.ownership(f.store.event(second)).generation,Date.now(),Date.now());
    f.browser.failure=null;f.browser.badIds=new Set(['21','22']);const inspected=f.browser.inspectedIds.length;
    await f.service.runAutomaticReply();
    expect(f.browser.inspectedIds.slice(inspected).filter(id=>f.browser.badIds.has(id))).toEqual(['21']);
    expect(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='AUTO_QUALIFICATION_RESUMED'").get()).toEqual({n:1});
    expect(f.store.event(eligible).status).toBe('CONFIRMED');expect(f.models()).toBe(1);expect(f.browser.clicks).toBe(1);
    expect(f.store.db.prepare('SELECT reason FROM automation_jobs WHERE event_id=?').get(second)).toEqual({reason:'COMMENT_REPLY_ROOT_NOT_UNIQUE'});
  }finally{await f.close();}
});
