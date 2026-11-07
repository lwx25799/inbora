import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BrowserService } from "../../src/app/browser-service.js";
import { AccountActor } from "../../src/browser/account-actor.js";
import { ClientService } from "../../src/app/service.js";
import { DeepSeekProvider } from "../../src/ai/deepseek.js";
import { migrateClient } from "../../src/storage/client-migration.js";
import { candidate, database, pending, privateTemp, snapshot } from "../helpers.js";
import { digest, targetKey, type InboundEvent } from "../../src/core/contracts.js";
import { defaultSettings } from "../../src/app/contracts.js";
import type { ReplyPolicy } from "../../src/app/automation-contracts.js";

class AutoFixtureBrowser extends BrowserService {
  private queue=new AccountActor();clicks=0;
  wrongIdentity=false;
  override get actor(){return this.queue;}
  override identity(){return{identityDigest:digest(this.wrongIdentity?'wrong-account':'own-1'),mappingDigest:'synthetic',browserVersion:'1.0.0.0',browserMode:'headed' as const};}
  override async refreshIdentity(){return this.identity();}
  override async close(){}
  override async adapter(e:InboundEvent){let text='';return{dispose:()=>{},adapter:{inspect:async()=>snapshot(e),prepare:async(_e:InboundEvent,t:string)=>{text=t;},
    verifyPrepared:async()=>snapshot(e),baseline:async()=>[],clickOnce:async()=>{this.clicks++;await new Promise(r=>setTimeout(r,5));},
    readback:async()=>({id:randomUUID(),ownId:'own-1',targetKey:targetKey(e),text,pending:false,sentAt:new Date().toISOString()}),
  }};}
}
const policy:ReplyPolicy={ownId:'own-1',channels:['COMMENT_NOTIFICATION','DIRECT_MESSAGE'],model:'deepseek-flash',modelLimit:2,sendLimit:2,expiresAt:null,
  workIds:['work-1'],futureOwnWorks:false,conversationIds:['conversation-1'],entireInbox:false,containsAny:['hello'],excludesAny:['refund'],instructions:'Reply briefly.',startHour:0,endHour:24};
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
test('both channels automatically generate, backend approve, single submit and confirm within one persistent policy',async()=>{
  const f=await setup();try{
    await f.service.runAutomaticReply();await f.service.runAutomaticReply();await f.service.runAutomaticReply();
    expect(f.models()).toBe(2);expect(f.browser.clicks).toBe(2);
    expect(f.store.events().map(e=>e.status)).toEqual(['CONFIRMED','CONFIRMED']);
    expect(f.store.db.prepare('SELECT used FROM budgets ORDER BY kind').all()).toEqual([{used:2},{used:2}]);
    expect(f.store.db.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type='AUTO_POLICY_APPROVED'").get()).toEqual({n:2});
    expect(f.store.db.prepare("SELECT count(*) AS n FROM grant_reservations WHERE kind='SEND'").get()).toEqual({n:2});
    expect(f.store.db.prepare("SELECT origin FROM draft_revisions").all()).toEqual([{origin:'AUTO_POLICY'},{origin:'AUTO_POLICY'}]);
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
