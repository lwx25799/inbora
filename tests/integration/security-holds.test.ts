import {expect,test} from 'vitest';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {rm} from 'node:fs/promises';
import {EventStore} from '../../src/storage/store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {WorkbenchAuthority} from '../../src/app/authority.js';
import {VerificationScheduler} from '../../src/app/verification-scheduler.js';
import {BrowserSafety} from '../../src/app/browser-safety.js';
import type {Page} from 'playwright';
import type {ReplyAdapter} from '../../src/core/contracts.js';
import {suggestionEligibility} from '../../src/app/suggestion-eligibility.js';
import {DeepSeekProvider} from '../../src/ai/deepseek.js';
import {HttpDraftProvider} from '../../src/ai/draft-service.js';
import {defaultSettings} from '../../src/app/contracts.js';
import {Blocked,digest} from '../../src/core/contracts.js';
import {holdSecurityChannel,readSecurityHold,resolveSecurityHold,securityRevision,assertSecurityRevision} from '../../src/storage/security-holds.js';
import {approved,candidate,pending,privateTemp,snapshot} from '../helpers.js';

const dm='DIRECT_MESSAGE' as const,comments='COMMENT_NOTIFICATION' as const;
const hold=(store:EventStore,channel=dm)=>holdSecurityChannel(store,channel,{incidentId:randomUUID(),reason:'OBSERVATION_SECURITY_SUSPECT',mode:'headless'});
const output={model:'deepseek-flash',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'A bounded synthetic response'}}],
  usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}};
async function fixture(client=false){
  const root=privateTemp('security-holds-'),file=join(root,'poc.sqlite'),store=new EventStore(file,true);
  store.bindAccount('own-1');
  if(client){await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));}
  return{root,file,store,close:async()=>{store.close();await rm(root,{recursive:true,force:true});}};
}

test('a hold survives restart, capability attestation and mode changes; stale recovery cannot resolve a later incident',async()=>{
  const f=await fixture(true);let restarted:EventStore|undefined;
  try{
    const first=hold(f.store),revision=securityRevision(f.store,dm);
    expect(holdSecurityChannel(f.store,dm,{incidentId:first.incidentId,reason:first.reason,mode:'headed'}).revision).toBe(revision);
    expect(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='SECURITY_CHANNEL_HELD'").get()).toEqual({n:1});
    const authority=new WorkbenchAuthority(f.store),token=authority.issueSession();
    for(const browserMode of ['headless','headed'] as const){
      authority.attest(dm,'SEND_AVAILABLE',{identityDigest:digest('own-1'),mappingDigest:'fixture',browserVersion:'1.0.0.0',browserMode},'synthetic');
      authority.setMode(token,'MANUAL');expect(readSecurityHold(f.store,dm)?.revision).toBe(first.revision);
    }
    expect(readSecurityHold(f.store,comments)).toBeNull();
    f.store.close();restarted=new EventStore(f.file,false);
    expect(readSecurityHold(restarted,dm)?.revision).toBe(first.revision);
    const second=hold(restarted);
    expect(resolveSecurityHold(restarted,dm,first.revision)).toBe(false);
    expect(readSecurityHold(restarted,dm)?.revision).toBe(second.revision);
    expect(resolveSecurityHold(restarted,dm,second.revision)).toBe(true);
    expect(readSecurityHold(restarted,dm)).toBeNull();
    expect(()=>assertSecurityRevision(restarted!,dm,revision)).toThrow('SECURITY_STATE_CHANGED');
  }finally{restarted?.close();if(f.store.db.open)f.store.close();await rm(f.root,{recursive:true,force:true});}
});

test.each(['deepseek','legacy'] as const)('%s provider rejects a held channel before model budget and transport, and permits a clear channel',async kind=>{
  const f=await fixture();let calls=0;
  try{
    const event=candidate(),blocked=hold(f.store);
    const provider=kind==='deepseek'?new DeepSeekProvider(async()=>{calls++;return new Response(JSON.stringify(output));}):
      new HttpDraftProvider({endpoint:'https://synthetic.invalid/model',model:'deepseek-flash',approvedAt:new Date().toISOString()},'synthetic',async()=>{
        calls++;return new Response(JSON.stringify({text:'Synthetic legacy response',model:'deepseek-flash',usage:{inputTokens:1,outputTokens:1},estimatedCost:null}));
      });
    const run=()=>provider instanceof DeepSeekProvider?provider.generate(f.store,event,[],defaultSettings,'synthetic',true):provider.generate(f.store,event,[]);
    await expect(run()).rejects.toThrow('SECURITY_CHANNEL_HELD');
    expect(calls).toBe(0);expect(f.store.budget('MODEL').used).toBe(0);
    expect(f.store.db.prepare('SELECT count(*) n FROM model_calls').get()).toEqual({n:0});
    resolveSecurityHold(f.store,dm,blocked.revision);
    await expect(run()).resolves.toBeDefined();expect(calls).toBe(1);expect(f.store.budget('MODEL').used).toBe(1);
  }finally{await f.close();}
});

test('a model response arriving after hold and recovery is rejected without treating the stale response as succeeded',async()=>{
  const f=await fixture();let release!:()=>void,entered=false;
  const gate=new Promise<void>(yes=>{release=yes;});
  const provider=new DeepSeekProvider(async()=>{entered=true;await gate;return new Response(JSON.stringify(output));});
  try{
    const task=provider.generate(f.store,candidate(),[],defaultSettings,'synthetic',true);
    await expect.poll(()=>entered).toBe(true);
    const blocked=hold(f.store);resolveSecurityHold(f.store,dm,blocked.revision);release();
    await expect(task).rejects.toThrow('MODEL_FAILED_NO_RETRY');
    expect(f.store.budget('MODEL').used).toBe(1);
    expect(f.store.db.prepare('SELECT status,input_tokens,output_tokens FROM model_calls').get()).toEqual({status:'FAILED',input_tokens:2,output_tokens:3});
    expect(f.store.db.prepare('SELECT count(*) n FROM reply_drafts').get()).toEqual({n:0});
  }finally{release?.();await f.close();}
});

test.each(['deepseek','legacy'] as const)('%s direct model boundary blocks a persisted global stop even when the ordinary client pause is clear',async kind=>{
  const f=await fixture(true);let calls=0;
  try{
    const data=new AutomationStore(f.store);data.initialize(Date.now());data.stop(true,'ACCOUNT_CHANGED','UNKNOWN');
    expect(f.store.db.prepare('SELECT paused FROM client_state WHERE id=1').get()).toEqual({paused:0});
    const provider=kind==='deepseek'?new DeepSeekProvider(async()=>{calls++;return new Response(JSON.stringify(output));}):
      new HttpDraftProvider({endpoint:'https://synthetic.invalid/model',model:'deepseek-flash',approvedAt:new Date().toISOString()},'synthetic',async()=>{
        calls++;return new Response(JSON.stringify({text:'Synthetic legacy response',model:'deepseek-flash',usage:{inputTokens:1,outputTokens:1},estimatedCost:null}));
      });
    const run=()=>provider instanceof DeepSeekProvider?provider.generate(f.store,candidate(),[],defaultSettings,'synthetic',true):provider.generate(f.store,candidate(),[]);
    await expect(run()).rejects.toThrow('EMERGENCY_STOPPED');expect(calls).toBe(0);
    expect(f.store.budget('MODEL').used).toBe(0);expect(f.store.db.prepare('SELECT count(*) n FROM model_calls').get()).toEqual({n:0});
    expect(data.resumeEmergency(data.emergencyRevision())).toBe(true);
    await expect(run()).resolves.toBeDefined();expect(calls).toBe(1);
  }finally{await f.close();}
});

test('a global stop and explicit recovery invalidate an already paid model result without consuming a second budget',async()=>{
  const f=await fixture(true);let release!:()=>void,entered=false;
  const gate=new Promise<void>(yes=>{release=yes;}),data=new AutomationStore(f.store);data.initialize(Date.now());
  const provider=new DeepSeekProvider(async()=>{entered=true;await gate;return new Response(JSON.stringify(output));});
  try{
    const task=provider.generate(f.store,candidate(),[],defaultSettings,'synthetic',true);await expect.poll(()=>entered).toBe(true);
    data.stop(true,'ACCOUNT_CHANGED','UNKNOWN');expect(data.resumeEmergency(data.emergencyRevision())).toBe(true);release();
    await expect(task).rejects.toThrow('MODEL_FAILED_NO_RETRY');expect(f.store.budget('MODEL').used).toBe(1);
    expect(f.store.db.prepare('SELECT status FROM model_calls').get()).toEqual({status:'FAILED'});
  }finally{release?.();await f.close();}
});

test('a persisted global stop blocks a previously approved human command and its intent transaction, while explicit recovery remains available',async()=>{
  const f=await fixture(true);
  try{
    const id=pending(f.store),authority=new WorkbenchAuthority(f.store),token=authority.issueSession(),data=new AutomationStore(f.store);data.initialize(Date.now());
    const identity={identityDigest:digest('own-1'),mappingDigest:'fixture',browserVersion:'1.0.0.0',browserMode:'headless' as const};
    authority.attest(dm,'SEND_AVAILABLE',identity,'synthetic');authority.setMode(token,'MANUAL');
    const generation=authority.claim(token,id,0).generation,selectionId=randomUUID();authority.select(token,id,selectionId);
    const draft=authority.save(token,id,generation,0,'An already prepared human response');
    const params={eventId:id,generation,selectionId,draftId:draft.id,draftVersion:draft.version,text:draft.text,contextVersion:authority.contextVersion(f.store.event(id))};
    f.store.approve(draft.id,snapshot(candidate()),draft.version,draft.text);
    expect(()=>authority.assertCanSend(token,params,identity,true,'',true)).not.toThrow();
    data.stop(true,'ACCOUNT_CHANGED','UNKNOWN');expect(authority.paused()).toBe(false);
    expect(()=>authority.assertCanSend(token,params,identity,true,'',true)).toThrow('EMERGENCY_STOPPED');
    expect(()=>f.store.recordIntent(draft.id,snapshot(candidate()),true,{check:()=>{},committed:()=>{}})).toThrow('EMERGENCY_STOPPED');
    expect(f.store.budget('SEND').used).toBe(0);expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
    expect(data.resumeEmergency(data.emergencyRevision())).toBe(true);
    expect(()=>authority.assertCanSend(token,params,identity,true,'',true)).not.toThrow();
  }finally{await f.close();}
});

test('a wrapped manual browser operation persists a confirmed account failure before its caller handles the exception',async()=>{
  const f=await fixture(true);
  try{
    const data=new AutomationStore(f.store);data.initialize(Date.now());
    const safety=new BrowserSafety(f.root,f.store),adapter=safety.wrap({inspect:async()=>{throw new Blocked('ACCOUNT_CHANGED');}} as unknown as ReplyAdapter,dm,{} as Page);
    await expect(adapter.inspect(candidate())).rejects.toThrow('ACCOUNT_CHANGED');
    expect(data.state().emergencyStopped).toBe(true);
    expect(readSecurityHold(f.store,dm)).toBeNull();
    expect(f.store.db.prepare("SELECT detail_redacted FROM audit_events WHERE event_type='EMERGENCY_STOPPED' ORDER BY rowid DESC LIMIT 1").get())
      .toEqual({detail_redacted:expect.stringContaining('ACCOUNT_CHANGED')});
  }finally{await f.close();}
});

test('qualifying permission cannot bypass a hold and an approved intent is blocked in the intent transaction',async()=>{
  const f=await fixture(true);
  try{
    const id=pending(f.store),authority=new WorkbenchAuthority(f.store),token=authority.issueSession();
    const identity={identityDigest:digest('own-1'),mappingDigest:'fixture',browserVersion:'1.0.0.0',browserMode:'headless' as const};
    authority.attest(dm,'SEND_AVAILABLE',identity,'synthetic');authority.setMode(token,'MANUAL');
    const generation=authority.claim(token,id,0).generation,selectionId=randomUUID();authority.select(token,id,selectionId);
    const draft=authority.save(token,id,generation,0,'A human response');
    const params={eventId:id,generation,selectionId,draftId:draft.id,draftVersion:draft.version,text:draft.text,contextVersion:authority.contextVersion(f.store.event(id))};
    expect(()=>authority.assertCanSend(token,params,identity,false,'',true)).not.toThrow();
    const blocked=hold(f.store);
    authority.attest(dm,'SEND_AVAILABLE',identity,'new-synthetic-attestation');
    expect(()=>authority.assertCanSend(token,params,identity,false,'',true)).toThrow('SECURITY_CHANNEL_HELD');
    expect(authority.save(token,id,generation,draft.version,'Human edits remain available').text).toBe('Human edits remain available');
    resolveSecurityHold(f.store,dm,blocked.revision);
    const saved=authority.draftFor(id)!;f.store.approve(saved.id,snapshot(candidate()),saved.version,saved.text);
    hold(f.store);
    expect(()=>f.store.recordIntent(saved.id,snapshot(candidate()),true,{check:()=>{},committed:()=>{}})).toThrow('SECURITY_CHANNEL_HELD');
    expect(f.store.budget('SEND').used).toBe(0);expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{await f.close();}
});

test('held policy and manual suggestion entrypoints stop before reservations without blocking the other channel',async()=>{
  const f=await fixture(true);
  try{
    const id=pending(f.store),event=f.store.event(id),data=new AutomationStore(f.store),authority=new WorkbenchAuthority(f.store),token=authority.issueSession();
    data.initialize(Date.now());
    authority.attest(dm,'SEND_AVAILABLE',{identityDigest:digest('own-1'),mappingDigest:'fixture',browserVersion:'1.0.0.0',browserMode:'headless'},'synthetic');
    const grant=data.grant('AUTO_REPLY',{ownId:'own-1',channels:[dm,comments],model:'deepseek-flash',modelLimit:2,sendLimit:2,expiresAt:null,
      workIds:['work-1'],futureOwnWorks:false,conversationIds:['conversation-1'],entireInbox:false,containsAny:[],excludesAny:[],
      instructions:'Synthetic reply scope',startHour:0,endHour:24});
    authority.setMode(token,'LIMITED_AUTO');
    const state={settings:defaultSettings,keyPresent:true,modelAuthorized:true,modelBusy:false,recovering:false};
    expect(data.policyMatches(grant,event)).toBe(true);
    expect(suggestionEligibility(f.store,authority,data,event,state)).toEqual({eligible:true,reason:null});
    hold(f.store);
    expect(data.policyMatches(grant,event)).toBe(false);
    expect(suggestionEligibility(f.store,authority,data,event,state)).toEqual({eligible:false,reason:'SECURITY_CHANNEL_HELD'});
    expect(()=>data.reserve(grant.version,'MODEL',id)).toThrow('SECURITY_CHANNEL_HELD');
    expect(f.store.db.prepare('SELECT count(*) n FROM grant_reservations').get()).toEqual({n:0});
    const other=pending(f.store,candidate({channel:comments,kind:'COMMENT',platformEventId:'comment-2',videoId:'work-1',commentId:'comment-2',conversationId:null}));
    expect(data.policyMatches(grant,f.store.event(other))).toBe(true);
  }finally{await f.close();}
});

test('held verification does not claim an attempt or consume its deadline, while an independent channel can run',async()=>{
  const f=await fixture();let worker:VerificationScheduler|undefined;
  try{
    const d=approved(f.store),c=approved(f.store,candidate({channel:comments,platformEventId:'comment-1',kind:'COMMENT',videoId:'work-1',commentId:'comment-1',conversationId:null}));
    await migrateClient(f.store,join(f.root,'client.sqlite'));await migrateAutomation(f.store,join(f.root,'automation.sqlite'));
    for(const [draft,event] of [[d,candidate()],[c,candidate({channel:comments,platformEventId:'comment-1',kind:'COMMENT',videoId:'work-1',commentId:'comment-1',conversationId:null})]] as const){
      const intent=f.store.recordIntent(draft,snapshot(event),false,{check:()=>{},committed:()=>{}});f.store.receipt(intent,'UNCERTAIN','synthetic-unknown');
    }
    let now=Date.now(),calls=0;const data=new AutomationStore(f.store,()=>now);data.initialize(now);
    worker=new VerificationScheduler(data,async()=>{calls++;return{verified:false,evidenceId:'synthetic-check'};});
    for(const event of f.store.events())worker.enqueue(event.id);
    const blocked=hold(f.store);now+=200_000;await worker.tick();
    expect(f.store.db.prepare('SELECT state,attempts FROM verification_jobs WHERE event_id=?').get(f.store.draft(d).eventId)).toEqual({state:'PENDING',attempts:0});
    expect(calls).toBe(0);
    resolveSecurityHold(f.store,dm,blocked.revision);await worker.tick();expect(calls).toBe(1);
    expect(f.store.db.prepare('SELECT attempts FROM verification_jobs WHERE event_id=?').get(f.store.draft(d).eventId)).toEqual({attempts:1});
  }finally{await worker?.close();await f.close();}
});

test.each(['OBSERVATION_PAGE_BLOCKED','OBSERVATION_SECURITY_COMPONENT','OBSERVATION_SECURITY_TITLE','OBSERVATION_SECURITY_SUSPECT'])
  ('verification does not promote the unconfirmed %s signal into a global emergency',async code=>{
  const f=await fixture();let worker:VerificationScheduler|undefined;
  try{
    const draft=approved(f.store);await migrateClient(f.store,join(f.root,'client.sqlite'));await migrateAutomation(f.store,join(f.root,'automation.sqlite'));
    const intent=f.store.recordIntent(draft,snapshot(candidate()),false,{check:()=>{},committed:()=>{}});f.store.receipt(intent,'UNCERTAIN','synthetic');
    let now=Date.now();const data=new AutomationStore(f.store,()=>now);data.initialize(now);
    worker=new VerificationScheduler(data,async()=>{throw new Blocked(code);});worker.enqueue(f.store.draft(draft).eventId);
    now+=2000;await worker.tick();expect(data.state().emergencyStopped).toBe(false);
    expect(f.store.db.prepare('SELECT last_error FROM verification_jobs').get()).toEqual({last_error:code});
  }finally{await worker?.close();await f.close();}
});
