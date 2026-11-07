import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ClientService } from "../../src/app/service.js";
import { BrowserService } from "../../src/app/browser-service.js";
import { AccountActor } from "../../src/browser/account-actor.js";
import { migrateClient } from "../../src/storage/client-migration.js";
import { digest, targetKey, type InboundEvent } from "../../src/core/contracts.js";
import { candidate, database, pending, privateTemp, snapshot } from "../helpers.js";

class HumanBrowser extends BrowserService {
  private queue=new AccountActor();clicks=0;inspectGate:()=>Promise<void>=async()=>{};
  override get actor(){return this.queue;}
  override identity(){return{identityDigest:digest('own-1'),mappingDigest:'synthetic-contract',browserVersion:'1.0.0.0',browserMode:'headed' as const};}
  override async refreshIdentity(){return this.identity();}
  override async close(){}
  override async adapter(e:InboundEvent){let text='';return{dispose:()=>{},adapter:{
    inspect:async()=>{await this.inspectGate();return snapshot(e);},prepare:async(_event:InboundEvent,t:string)=>{text=t;},verifyPrepared:async()=>snapshot(e),baseline:async()=>[],
    clickOnce:async()=>{this.clicks++;await new Promise(r=>setTimeout(r,5));},readback:async()=>({id:randomUUID(),ownId:'own-1',targetKey:targetKey(e),text,pending:false,sentAt:new Date().toISOString()}),
  }};}
}
async function setup(channel:'DIRECT_MESSAGE'|'COMMENT_NOTIFICATION'='DIRECT_MESSAGE'){
  const store=database(),root=privateTemp('human-single-action-');await migrateClient(store,join(root,'backup.sqlite'));
  const eventId=pending(store,channel==='DIRECT_MESSAGE'?candidate():candidate({channel,kind:'COMMENT',videoId:'work',commentId:'parent',conversationId:null}));
  const browser=new HumanBrowser(root),service=new ClientService(store,browser);await service.loadSettings();
  const token=service.authority.issueSession();await service.dispatch(token,{command:'setMode',mode:'MANUAL'});
  const selectionId=randomUUID();
  const detail=await service.dispatch(token,{command:'openHumanDialog',eventId,selectionId}) as {ownership:{generation:number};contextVersion:string};
  const input={eventId,generation:detail.ownership.generation,expectedVersion:0,text:'Latest unsaved full text',contextVersion:detail.contextVersion,selectionId,suggestionId:null};
  return{store,browser,service,token,eventId,input,close:async()=>{await service.close();store.close();}};
}
test.each(['DIRECT_MESSAGE','COMMENT_NOTIFICATION'] as const)('%s one business send persists latest text, verifies the exact contract and submits once',async channel=>{
  const f=await setup(channel);try{
    const commandId=randomUUID();
    const queued=await f.service.dispatch(f.token,{command:'sendHumanReply',commandId,input:f.input});
    expect(queued).toMatchObject({status:'PREPARING'});
    await f.service.dispatch(f.token,{command:'sendHumanReply',commandId,input:f.input});
    await f.service.drain();
    expect(f.browser.clicks).toBe(1);
    expect(f.service.authority.draftFor(f.eventId)).toMatchObject({text:f.input.text,version:1});
    expect(await f.service.dispatch(f.token,{command:'getSendResult',commandId})).toMatchObject({status:'CONFIRMED'});
    await f.service.dispatch(f.token,{command:'sendHumanReply',commandId,input:f.input});expect(f.browser.clicks).toBe(1);
    expect(f.store.db.prepare('SELECT used FROM budgets ORDER BY kind').all()).toEqual([{used:0},{used:1}]);
    await expect(f.service.dispatch(f.token,{command:'sendHumanReply',commandId,input:{...f.input,text:'changed'}})).rejects.toThrow('COMMAND_PARAMETERS_CONFLICT');
  }finally{await f.close();}
});
test('a stale autosave version is rejected without replacing the latest human draft or creating a send command',async()=>{
  const f=await setup();try{
    await f.service.dispatch(f.token,{command:'saveDraft',eventId:f.eventId,generation:f.input.generation,expectedVersion:0,text:'autosaved latest',suggestionId:null});
    await expect(f.service.dispatch(f.token,{command:'sendHumanReply',commandId:randomUUID(),input:f.input})).rejects.toThrow('DRAFT_VERSION_CONFLICT');
    expect(f.service.authority.draftFor(f.eventId)?.text).toBe('autosaved latest');
    expect(f.store.db.prepare('SELECT count(*) AS n FROM manual_send_commands').get()).toEqual({n:0});expect(f.browser.clicks).toBe(0);
  }finally{await f.close();}
});
test('target switching during backend qualification invalidates the preparing command before any click',async()=>{
  const f=await setup();let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let entered=false;
  f.browser.inspectGate=async()=>{entered=true;await gate;};
  try {
    const commandId=randomUUID();await f.service.dispatch(f.token,{command:'sendHumanReply',commandId,input:f.input});
    await expect.poll(()=>entered).toBe(true);
    await f.service.dispatch(f.token,{command:'selectTarget',eventId:null,selectionId:randomUUID()});
    release();await f.service.drain();
    expect(await f.service.dispatch(f.token,{command:'getSendResult',commandId})).toMatchObject({status:'FAILED_BEFORE_CLICK'});
    expect(f.browser.clicks).toBe(0);expect(f.service.authority.draftFor(f.eventId)?.text).toBe(f.input.text);
  }finally{release();await f.close();}
});
test('new durable intent atomically registers restart-only follow-up without replaying its submit',async()=>{
  const f=await setup();try{
    const commandId=randomUUID();
    let release!:()=>void;const gate=new Promise<void>(r=>{release=r;}),original=f.browser.adapter.bind(f.browser);
    let recorded=false;
    f.browser.adapter=async e=>{const handle=await original(e);handle.adapter.clickOnce=async()=>{recorded=true;await gate;};return handle;};
    const task=f.service.dispatch(f.token,{command:'sendHumanReply',commandId,input:f.input});await task;
    await expect.poll(()=>recorded).toBe(true);
    const command=f.service.authority.command(commandId);
    expect(command.intent_id).toBeTruthy();
    expect(f.store.db.prepare('SELECT intent_id,state,attempts FROM verification_jobs').get()).toEqual({intent_id:command.intent_id,state:'PENDING',attempts:0});
    // This assertion observes the committed boundary before the browser operation can return a receipt.
    release();await f.service.drain();expect(f.browser.clicks).toBe(0);
    const {WorkbenchAuthority}=await import('../../src/app/authority.js');
    new WorkbenchAuthority(f.store).recover();
    expect(f.store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:1});
  }finally{await f.close();}
});
