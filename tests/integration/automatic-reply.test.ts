import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BrowserService } from "../../src/app/browser-service.js";
import { AccountActor } from "../../src/browser/account-actor.js";
import { ClientService } from "../../src/app/service.js";
import { DeepSeekProvider } from "../../src/ai/deepseek.js";
import { migrateClient } from "../../src/storage/client-migration.js";
import { candidate, database, pending, privateTemp, snapshot } from "../helpers.js";
import { Blocked,digest, targetKey, type InboundEvent } from "../../src/core/contracts.js";
import { defaultSettings } from "../../src/app/contracts.js";
import type { ReplyPolicy } from "../../src/app/automation-contracts.js";

class AutoFixtureBrowser extends BrowserService {
  private queue=new AccountActor();clicks=0;
  beforePrepare:()=>Promise<void>=async()=>{};
  afterClick:()=>Promise<void>=async()=>{};
  afterIdentity:()=>void=()=>{};
  wrongIdentity=false;
  override get actor(){return this.queue;}
  override identity(){return{identityDigest:digest(this.wrongIdentity?'wrong-account':'own-1'),mappingDigest:'synthetic',browserVersion:'1.0.0.0',browserMode:'headed' as const};}
  override async refreshIdentity(){this.afterIdentity();return this.identity();}
  override async close(){}
  override async adapter(e:InboundEvent){let text='';return{dispose:()=>{},adapter:{inspect:async()=>snapshot(e),prepare:async(_e:InboundEvent,t:string)=>{await this.beforePrepare();text=t;},
    verifyPrepared:async()=>snapshot(e),baseline:async()=>[],clickOnce:async()=>{this.clicks++;await this.afterClick();await new Promise(r=>setTimeout(r,5));},
    readback:async()=>({id:randomUUID(),ownId:'own-1',targetKey:targetKey(e),text,pending:false,sentAt:new Date().toISOString()}),
  }};}
}
const policy:ReplyPolicy={ownId:'own-1',channels:['COMMENT_NOTIFICATION','DIRECT_MESSAGE'],model:'deepseek-flash',modelLimit:2,sendLimit:2,expiresAt:null,
  workIds:['work-1'],futureOwnWorks:false,conversationIds:['conversation-1'],entireInbox:false,containsAny:[],excludesAny:['refund'],instructions:'Reply briefly.',startHour:0,endHour:24};
async function setup(wait:()=>Promise<void>=async()=>{}){
  const store=database(),root=privateTemp('automatic-reply-');await migrateClient(store,join(root,'schema3.sqlite'));
  const dm=pending(store),comment=pending(store,candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',platformEventId:'comment-1',videoId:'work-1',commentId:'parent-1',conversationId:null}));
  const browser=new AutoFixtureBrowser(root);let models=0;
  const provider=new DeepSeekProvider(async()=>{models++;await wait();return new Response(JSON.stringify({model:'deepseek-flash',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'Fixture automatic response '+models}}],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}}));});
  const service=new ClientService(store,browser,provider);await service.loadSettings();const token=service.authority.issueSession();
  await service.dispatch(token,{command:'configureAi',settings:defaultSettings,key:'synthetic-contract-key'});
  await service.dispatch(token,{command:'setReplyPolicy',policy,confirmed:true});
  await service.dispatch(token,{command:'setMode',mode:'LIMITED_AUTO'});
  return{store,service,browser,token,dm,comment,models:()=>models,close:async()=>{await service.close();store.close();}};
}
test('a missing nested root resumes automatically only after context arrives, without a paid retry',async()=>{
  const f=await setup();try{
    await f.service.dispatch(f.token,{command:'setReplyPolicy',policy:{...policy,channels:['COMMENT_NOTIFICATION'],workIds:['10']},confirmed:true});
    const child=candidate({channel:'COMMENT_NOTIFICATION',kind:'REPLY',platformEventId:'22',videoId:'10',commentId:'22',
      rootCommentId:'11',replyToCommentId:'22',conversationId:null,text:'the later child question',occurredAt:'2026-11-04T01:01:00Z'});
    const id=pending(f.store,child);await f.service.runAutomaticReply();await f.service.runAutomaticReply();
    expect(f.models()).toBe(0);expect(f.browser.clicks).toBe(0);expect(f.store.budget('MODEL').used).toBe(0);
    expect(f.store.db.prepare('SELECT state,reason FROM automation_jobs WHERE event_id=?').get(id))
      .toEqual({state:'REVIEW',reason:'COMMENT_ROOT_CONTEXT_REQUIRED'});
    expect(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='AUTO_QUALIFICATION_RESUMED'").get()).toEqual({n:0});
    f.store.observe('COMMENT_NOTIFICATION','notifications',[{...child,platformEventId:'11',commentId:'11',kind:'COMMENT',rootCommentId:undefined,
      replyToCommentId:undefined,text:'the original root question',occurredAt:'2026-11-04T00:58:00Z'}],'own-1','root-arrived');
    await f.service.runAutomaticReply();expect(f.models()).toBe(1);expect(f.browser.clicks).toBe(1);
    expect(f.store.event(id).status).toBe('CONFIRMED');expect(f.store.budget('MODEL').used).toBe(1);
    expect(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='AUTO_QUALIFICATION_RESUMED'").get()).toEqual({n:1});
  }finally{await f.close();}
});

test('both channels automatically generate, backend approve, single submit and confirm within one persistent policy',async()=>{
  const f=await setup();try{
    const updates:string[]=[];f.service.events.on('update',(message:{event:string})=>updates.push(message.event));
    await f.service.runAutomaticReply();await f.service.runAutomaticReply();await f.service.runAutomaticReply();
    expect(f.models()).toBe(2);expect(f.browser.clicks).toBe(2);
    expect(f.store.events().map(e=>e.status)).toEqual(['CONFIRMED','CONFIRMED']);
    expect(updates.at(-1)).toBe('inbox_updated');
    expect(await f.service.dispatch(f.token,{command:'getInbox',channel:'ALL',status:'CONFIRMED',page:0})).toMatchObject({
      total:2,items:expect.arrayContaining([expect.objectContaining({id:f.dm,replyStatus:'REPLIED'}),expect.objectContaining({id:f.comment,replyStatus:'REPLIED'})]),
    });
    expect(await f.service.dispatch(f.token,{command:'getInbox',channel:'ALL',status:'PENDING',page:0})).toMatchObject({total:0});
    expect(f.store.db.prepare('SELECT used FROM budgets ORDER BY kind').all()).toEqual([{used:2},{used:2}]);
    expect(f.store.db.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type='AUTO_POLICY_APPROVED'").get()).toEqual({n:2});
    expect(f.store.db.prepare("SELECT count(*) AS n FROM grant_reservations WHERE kind='SEND'").get()).toEqual({n:2});
    expect(f.store.db.prepare("SELECT origin FROM draft_revisions").all()).toEqual([{origin:'AUTO_POLICY'},{origin:'AUTO_POLICY'}]);
  }finally{await f.close();}
});

test('one explicit policy activation resumes ordinary send pause and authorizes both channels without a separate model grant',async()=>{
  const f=await setup();try{
    await f.service.dispatch(f.token,{command:'pause',eventId:null});
    f.store.db.prepare("UPDATE budgets SET used=CASE kind WHEN 'MODEL' THEN 1 ELSE 9 END").run();
    const result=await f.service.dispatch(f.token,{command:'enableReplyPolicy',policy,confirmed:true});
    expect(result).toMatchObject({paused:false,configuredMode:'LIMITED_AUTO',automation:{replyPolicy:{scope:policy}}});
    await f.service.runAutomaticReply();await f.service.runAutomaticReply();await f.service.runAutomaticReply();
    expect(f.models()).toBe(2);expect(f.browser.clicks).toBe(2);
    expect(f.store.db.prepare('SELECT kind,used FROM budgets ORDER BY kind').all()).toEqual([{kind:'MODEL',used:3},{kind:'SEND',used:11}]);
    expect(f.store.events().map(e=>e.status)).toEqual(['CONFIRMED','CONFIRMED']);
  }finally{await f.close();}
});

test('automatic reply switch preserves the policy and remaining budget across off, restart and on',async()=>{
  const f=await setup();let restarted:ClientService|undefined;
  try{
    const before=(await f.service.dispatch(f.token,{command:'getStatus'}) as {automation:{replyPolicy:{version:number}}}).automation.replyPolicy.version;
    const grantCount=f.store.db.prepare('SELECT count(*) AS n FROM automation_grants').get();
    await f.service.dispatch(f.token,{command:'setAutomaticReply',enabled:false});await f.service.runAutomaticReply();
    expect(f.models()).toBe(0);expect(f.browser.clicks).toBe(0);expect(f.service.authority.paused()).toBe(false);
    await f.service.close();restarted=new ClientService(f.store,f.browser);await restarted.loadSettings();const token=restarted.authority.issueSession();
    expect(await restarted.dispatch(token,{command:'getStatus'})).toMatchObject({configuredMode:'MANUAL',paused:false,automation:{replyPolicy:{version:before}}});
    expect(await restarted.dispatch(token,{command:'setAutomaticReply',enabled:true})).toMatchObject({configuredMode:'LIMITED_AUTO',automation:{replyPolicy:{version:before}}});
    expect(f.store.db.prepare('SELECT count(*) AS n FROM automation_grants').get()).toEqual(grantCount);
    expect(f.store.db.prepare('SELECT kind,used FROM budgets ORDER BY kind').all()).toEqual([{kind:'MODEL',used:0},{kind:'SEND',used:0}]);
  }finally{await restarted?.close();await f.close();}
});

test('automatic reply switch cancels a late model even when the same policy is immediately switched on again',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;}),f=await setup(()=>gate);
  let task:Promise<void>|undefined;
  try{
    task=f.service.runAutomaticReply();await expect.poll(f.models).toBe(1);
    await f.service.dispatch(f.token,{command:'setAutomaticReply',enabled:false});
    await f.service.dispatch(f.token,{command:'setAutomaticReply',enabled:true});release();await task;
    expect(f.browser.clicks).toBe(0);expect(f.service.authority.draftFor(f.dm)).toBeNull();
    expect(f.store.db.prepare("SELECT used FROM budgets WHERE kind='MODEL'").get()).toEqual({used:1});
  }finally{release();await task?.catch(()=>{});await f.close();}
});

test('off and on at the qualification return boundary cannot reserve or call a cancelled model task',async()=>{
  const f=await setup();let samples=0;const toggles:Promise<unknown>[]=[];
  try{
    f.browser.afterIdentity=()=>{
      if(++samples===2)queueMicrotask(()=>queueMicrotask(()=>{
        toggles.push(f.service.dispatch(f.token,{command:'setAutomaticReply',enabled:false}));
        toggles.push(f.service.dispatch(f.token,{command:'setAutomaticReply',enabled:true}));
      }));
    };
    await f.service.runAutomaticReply();await Promise.all(toggles);
    expect(f.models()).toBe(0);expect(f.browser.clicks).toBe(0);
    expect(f.store.db.prepare("SELECT used FROM budgets WHERE kind='MODEL'").get()).toEqual({used:0});
    expect(f.store.db.prepare('SELECT count(*) AS n FROM automation_jobs').get()).toEqual({n:0});
    f.browser.afterIdentity=()=>{};await f.service.runAutomaticReply();
    expect(f.models()).toBe(1);expect(f.browser.clicks).toBe(1);
  }finally{await Promise.allSettled(toggles);await f.close();}
});

test.each([false,true])('automatic reply switch stops an unsubmitted command but preserves a submitted readback (submitted: %s)',async submitted=>{
  const f=await setup();let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let entered=false;
  let task:Promise<void>|undefined;
  try{
    const stop=async()=>{entered=true;await gate;};
    if(submitted)f.browser.afterClick=stop;else f.browser.beforePrepare=stop;
    task=f.service.runAutomaticReply();await expect.poll(()=>entered).toBe(true);
    await f.service.dispatch(f.token,{command:'setAutomaticReply',enabled:false});
    if(!submitted)await f.service.dispatch(f.token,{command:'setAutomaticReply',enabled:true});
    release();await task;
    expect(f.browser.clicks).toBe(submitted?1:0);
    expect(f.store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:submitted?1:0});
    if(submitted)expect(f.store.event(f.dm).status).toBe('CONFIRMED');
  }finally{release?.();await task?.catch(()=>{});await f.close();}
});

test('policy activation releases idle per-conversation handoffs and preserves global emergency stop',async()=>{
  const f=await setup();try{
    const thread=await f.service.dispatch(f.token,{command:'openHumanDialog',eventId:f.dm,selectionId:randomUUID()}) as {ownership:{generation:number}};
    await f.service.dispatch(f.token,{command:'closeHumanDialog',eventId:f.dm,generation:thread.ownership.generation});
    await f.service.dispatch(f.token,{command:'enableReplyPolicy',policy,confirmed:true});
    await f.service.runAutomaticReply();await f.service.runAutomaticReply();
    expect(f.models()).toBe(2);expect(f.browser.clicks).toBe(2);expect(f.store.event(f.dm).status).toBe('CONFIRMED');
    await f.service.dispatch(f.token,{command:'emergencyStop'});
    const before=f.store.db.prepare('SELECT * FROM automation_grants').all();
    await expect(f.service.dispatch(f.token,{command:'enableReplyPolicy',policy,confirmed:true})).rejects.toThrow('EMERGENCY_STOPPED');
    expect(f.store.db.prepare('SELECT * FROM automation_grants').all()).toEqual(before);
    expect(f.service.authority.paused()).toBe(true);
  }finally{await f.close();}
});

test('viewing a conversation does not pause policy while actual human editing remains protected by the same global switch',async()=>{
  const f=await setup();try{
    await f.service.dispatch(f.token,{command:'openHumanDialog',eventId:f.dm,selectionId:randomUUID(),editing:false});
    expect(f.service.authority.ownership(f.store.event(f.dm)).operator_id).toBeNull();
    const thread=await f.service.dispatch(f.token,{command:'openHumanDialog',eventId:f.dm,selectionId:randomUUID()}) as {ownership:{generation:number}};
    await f.service.dispatch(f.token,{command:'saveDraft',eventId:f.dm,generation:thread.ownership.generation,expectedVersion:0,text:'Preserved real human draft',suggestionId:null});
    await f.service.dispatch(f.token,{command:'setAutomaticReply',enabled:true});
    await f.service.runAutomaticReply();await f.service.runAutomaticReply();
    expect(f.store.event(f.dm).status).toBe('AWAITING_APPROVAL');
    expect(f.service.authority.draftFor(f.dm)?.text).toBe('Preserved real human draft');
    expect(f.models()).toBe(1);expect(f.browser.clicks).toBe(1);
  }finally{await f.close();}
});

test('policy activation rolls back the grant and mode if account resume fails',async()=>{
  const f=await setup();try{
    await f.service.dispatch(f.token,{command:'pause',eventId:null});
    await f.service.dispatch(f.token,{command:'setMode',mode:'DRAFT_ONLY'});
    const before=f.store.db.prepare('SELECT * FROM automation_grants').all();
    const resume=f.service.authority.pause.bind(f.service.authority);
    f.service.authority.pause=()=>{throw new Error('fixture resume failed');};
    try{await expect(f.service.dispatch(f.token,{command:'enableReplyPolicy',policy,confirmed:true})).rejects.toThrow('fixture resume failed');}
    finally{f.service.authority.pause=resume;}
    expect(f.store.db.prepare('SELECT * FROM automation_grants').all()).toEqual(before);
    expect(f.service.authority.paused()).toBe(true);
    expect(f.service.authority.mode()).toBe('DRAFT_ONLY');
  }finally{await f.close();}
});
test('late model output cannot replace a human takeover draft or submit after grant revocation',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;}),f=await setup(()=>gate);
  try{
    const task=f.service.runAutomaticReply();await expect.poll(f.models).toBe(1);
    const selectionId=randomUUID(),thread=await f.service.dispatch(f.token,{command:'openHumanDialog',eventId:f.dm,selectionId}) as {ownership:{generation:number}};
    await f.service.dispatch(f.token,{command:'saveDraft',eventId:f.dm,generation:thread.ownership.generation,expectedVersion:0,text:'Preserved human text',suggestionId:null});
    await f.service.dispatch(f.token,{command:'setReplyPolicy',policy:null,confirmed:true});release();await task;
    expect(f.browser.clicks).toBe(0);expect(f.service.authority.draftFor(f.dm)?.text).toBe('Preserved human text');
    expect(f.store.db.prepare('SELECT state FROM automation_jobs').get()).toEqual({state:'REVIEW'});
  }finally{release();await f.close();}
});
test('concurrent scheduler turns, paused sending and off-policy events never duplicate a paid call or submit',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;}),f=await setup(()=>gate);
  try{
    const first=f.service.runAutomaticReply();await expect.poll(f.models).toBe(1);
    await f.service.runAutomaticReply();expect(f.models()).toBe(1);
    await f.service.dispatch(f.token,{command:'emergencyStop'});release();await first;
    expect(f.browser.clicks).toBe(0);
    await f.service.runAutomaticReply();expect(f.models()).toBe(1);
    expect(f.store.db.prepare("SELECT used FROM budgets WHERE kind='SEND'").get()).toEqual({used:0});
  }finally{release();await f.close();}
});
test('automatic generation stops before another paid call when policy or global SEND allowance is exhausted',async()=>{
  const f=await setup();try{
    await f.service.dispatch(f.token,{command:'setReplyPolicy',policy:{...policy,modelLimit:2,sendLimit:1},confirmed:true});
    await f.service.runAutomaticReply();await f.service.runAutomaticReply();
    expect(f.models()).toBe(1);expect(f.browser.clicks).toBe(1);
    expect(f.store.db.prepare("SELECT count(*) AS n FROM automation_jobs").get()).toEqual({n:1});
    expect(f.store.events().filter(e=>e.status==='AWAITING_DRAFT')).toHaveLength(1);
  }finally{await f.close();}
});
test('browser identity and exact target are qualified before any paid automatic model request',async()=>{
  const f=await setup();try{
    f.browser.wrongIdentity=true;await f.service.runAutomaticReply();
    expect(f.models()).toBe(0);expect(f.browser.clicks).toBe(0);
    expect(f.store.db.prepare("SELECT reason FROM automation_jobs").get()).toEqual({reason:'ACCOUNT_CHANGED'});
    expect(await f.service.dispatch(f.token,{command:'getStatus'})).toMatchObject({automation:{emergencyStopped:true}});
  }finally{await f.close();}
});

test.each(['CLIENT_CLOSING','TARGET_CHANGED_REAPPROVE','NATIVE_REPLY_EXISTING_DRAFT'])('a policy draft stopped before its intent resumes once without another model call or replaying an unknown (%s)',async code=>{
  const f=await setup();try{
    f.browser.beforePrepare=async()=>{throw new Blocked(code);};
    await f.service.runAutomaticReply();expect(f.models()).toBe(1);expect(f.browser.clicks).toBe(0);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
    const text=f.service.authority.draftFor(f.dm)?.text;f.browser.beforePrepare=async()=>{};
    await f.service.runAutomaticReply();expect(f.models()).toBe(1);expect(f.browser.clicks).toBe(1);
    expect(f.store.event(f.dm).status).toBe('CONFIRMED');expect(f.service.authority.draftFor(f.dm)?.text).toBe(text);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:1});
    expect(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='AUTO_DRAFT_RESUMED'").get()).toEqual({n:1});
  }finally{await f.close();}
});

test('an independent verified text can use verified text context while prior media stays visible and never reaches the model',async()=>{
  const f=await setup();try{
    const media=candidate({platformEventId:'unread-media-context',text:'[图片或表情消息，需人工查看]',occurredAt:'2026-11-04T01:00:00.500Z',
      contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED'});
    pending(f.store,media);
    await f.service.runAutomaticReply();
    expect(f.models()).toBe(1);expect(f.store.event(f.dm).status).toBe('CONFIRMED');
    expect(f.store.events().find(e=>e.payload.platformEventId==='unread-media-context')?.status).toBe('MANUAL_REVIEW');
  }finally{await f.close();}
});

test.each(['intent','human','revoked','context','off'])('policy draft recovery retains the original safety boundary (%s)',async reason=>{
  const f=await setup();try{
    f.browser.beforePrepare=async()=>{throw new Blocked('CLIENT_CLOSING');};await f.service.runAutomaticReply();f.browser.beforePrepare=async()=>{};
    const event=f.store.event(f.dm),draft=f.service.authority.draftFor(f.dm)!;
    if(reason==='intent'){
      f.store.approve(draft.id,snapshot(event.payload),draft.version,draft.text);
      const intent=f.store.recordIntent(draft.id,snapshot(event.payload),false,{check:()=>{},committed:()=>{}});f.store.receipt(intent,'UNCERTAIN','synthetic-existing-intent');
    }else if(reason==='human'){
      const owner=f.service.authority.claim(f.token,f.dm,f.service.authority.ownership(event).generation);
      f.service.authority.save(f.token,f.dm,owner.generation,draft.version,'Actual human revision');
    }else if(reason==='revoked')await f.service.dispatch(f.token,{command:'setReplyPolicy',policy:null,confirmed:true});
    else if(reason==='off')await f.service.dispatch(f.token,{command:'setAutomaticReply',enabled:false});
    else pending(f.store,candidate({platformEventId:'new-context',occurredAt:new Date(Date.now()).toISOString()}));
    await f.service.runAutomaticReply();
    expect(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='AUTO_DRAFT_RESUMED' AND entity_id=?").get(f.dm)).toEqual({n:0});
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents WHERE event_id=?').get(f.dm)).toEqual({n:reason==='intent'?1:0});
  }finally{await f.close();}
});

test('pre-intent qualification stops after two bounded recoveries without another model call or a send intent',async()=>{
  const f=await setup();try{
    await f.service.dispatch(f.token,{command:'setReplyPolicy',policy:{...policy,channels:['DIRECT_MESSAGE']},confirmed:true});
    f.browser.beforePrepare=async()=>{throw new Blocked('TARGET_CHANGED_REAPPROVE');};
    for(let attempt=0;attempt<5;attempt++)await f.service.runAutomaticReply();
    expect(f.models()).toBe(1);expect(f.browser.clicks).toBe(0);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
    expect(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='AUTO_DRAFT_RESUMED'").get()).toEqual({n:2});
  }finally{await f.close();}
});

test('the corrected viewport contract permits only one new qualification after the original two attempts, without resetting them',async()=>{
  const f=await setup();try{
    await f.service.dispatch(f.token,{command:'setReplyPolicy',policy:{...policy,channels:['DIRECT_MESSAGE']},confirmed:true});
    f.browser.beforePrepare=async()=>{throw new Blocked('TARGET_CHANGED_REAPPROVE');};
    for(let attempt=0;attempt<6;attempt++)await f.service.runAutomaticReply();
    expect(f.models()).toBe(1);expect(f.browser.clicks).toBe(0);
    expect(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='AUTO_DRAFT_RESUMED'").get()).toEqual({n:2});
    expect(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='AUTO_VIEWPORT_REQUALIFIED'").get()).toEqual({n:1});
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{await f.close();}
});

test('an old stale recovery candidate cannot starve another eligible policy draft',async()=>{
  const f=await setup();try{
    f.browser.beforePrepare=async()=>{throw new Blocked('CLIENT_CLOSING');};
    await f.service.runAutomaticReply();
    f.store.db.prepare("UPDATE automation_jobs SET context_version='synthetic-stale' WHERE event_id=?").run(f.dm);
    await f.service.runAutomaticReply();expect(f.models()).toBe(2);
    f.browser.beforePrepare=async()=>{};await f.service.runAutomaticReply();
    expect(f.models()).toBe(2);expect(f.browser.clicks).toBe(1);
    expect(f.store.event(f.comment).status).toBe('CONFIRMED');
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents WHERE event_id=?').get(f.dm)).toEqual({n:0});
  }finally{await f.close();}
});

test.each(['budget','rules'] as const)('a saved policy revision only reuses a pending paid draft when its reply rules are unchanged (%s)',async change=>{
  const f=await setup();try{
    const original={...policy,channels:['DIRECT_MESSAGE' as const]};
    await f.service.dispatch(f.token,{command:'setReplyPolicy',policy:original,confirmed:true});
    f.browser.beforePrepare=async()=>{throw new Blocked('CLIENT_CLOSING');};await f.service.runAutomaticReply();
    const text=f.service.authority.draftFor(f.dm)!.text;
    await f.service.dispatch(f.token,{command:'setReplyPolicy',policy:{...original,modelLimit:null,sendLimit:null,
      instructions:change==='rules'?'A materially different reply rule':original.instructions},confirmed:true});
    f.browser.beforePrepare=async()=>{};await f.service.runAutomaticReply();
    expect(f.models()).toBe(1);expect(f.browser.clicks).toBe(change==='budget'?1:0);
    expect(f.service.authority.draftFor(f.dm)!.text).toBe(text);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents WHERE event_id=?').get(f.dm)).toEqual({n:change==='budget'?1:0});
  }finally{await f.close();}
});
