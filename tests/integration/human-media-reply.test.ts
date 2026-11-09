import {expect,test} from 'vitest';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {AccountActor} from '../../src/browser/account-actor.js';
import {digest,eventBinding,isStrong,targetKey,type InboundEvent,type TargetSnapshot} from '../../src/core/contracts.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {candidate,database,privateTemp,snapshot} from '../helpers.js';
import {DeepSeekProvider} from '../../src/ai/deepseek.js';
import {defaultSettings} from '../../src/app/contracts.js';

class HumanMediaBrowser extends BrowserService {
  private queue=new AccountActor();clicks=0;fresh=true;mutate=false;inspections=0;gate:()=>Promise<void>=async()=>{};
  adapterRequests=0;deliveryGate:()=>Promise<void>=async()=>{};identityVersion='1.0';
  override get actor(){return this.queue;}
  override identity(){return {identityDigest:digest('own-1'),mappingDigest:'synthetic-native-map',browserVersion:this.identityVersion,browserMode:'headed' as const};}
  override async refreshIdentity(){return this.identity();}
  override async close(){}
  override async adapter(event:InboundEvent,_store?:unknown,_signal?:AbortSignal,options:{manualMedia?:boolean}={}){
    this.adapterRequests++;if(this.adapterRequests===2)await this.deliveryGate();
    let text='';const proof=():TargetSnapshot=>{
      this.inspections++;const contextDigest=digest('exact-native-window');
      return {...snapshot(event),contextDigest,...(options.manualMedia?{manualObservation:{kind:'DM_MEDIA' as const,channel:'DIRECT_MESSAGE' as const,
        eventBinding:eventBinding(event),contextDigest,contentType:event.contentType!,nativeKind:800,
        mediaDigest:digest(this.mutate&&this.inspections>1?'changed-native-media':'same-native-media'),freshExact:this.fresh as true}}:{})};
    };
    return {dispose:()=>{},adapter:{inspect:async()=>{await this.gate();return proof();},prepare:async(_e:InboundEvent,value:string)=>{text=value;},
      verifyPrepared:async()=>proof(),baseline:async()=>[],clickOnce:async()=>{this.clicks++;await new Promise(resolve=>setTimeout(resolve,5));},
      readback:async()=>({id:'9002',ownId:'own-1',targetKey:targetKey(event),text,pending:false,sentAt:new Date().toISOString()}),
    }};
  }
}
async function setup(contentType:'IMAGE'|'VIDEO'|'AUDIO'|'MIXED'='IMAGE'){
  const store=database(),root=privateTemp('human-media-');await migrateClient(store,join(root,'client.sqlite'));
  const event=candidate({platformEventId:'9001',contentType,observationIssue:'DM_CONTENT_UNVERIFIED',text:'[含媒体的消息，需人工查看]'});
  store.observe(event.channel,event.conversationId!,[event],'own-1','synthetic-media');const eventId=store.events()[0]!.id;
  let now=Date.now(),models=0;const provider=new DeepSeekProvider(async()=>{models++;throw Error('synthetic provider must not be reached');});
  const browser=new HumanMediaBrowser(root),service=new ClientService(store,browser,provider,()=>now);await service.loadSettings();const token=service.authority.issueSession();
  await service.dispatch(token,{command:'setMode',mode:'MANUAL'});const selectionId=randomUUID();
  const detail=await service.dispatch(token,{command:'openHumanDialog',eventId,selectionId}) as {ownership:{generation:number};contextVersion:string};
  const input={eventId,generation:detail.ownership.generation,expectedVersion:0,text:'准确人工回复全文',contextVersion:detail.contextVersion,selectionId,suggestionId:null};
  return {store,service,browser,token,event,eventId,input,models:()=>models,advance:(ms:number)=>{now+=ms;},close:async()=>{await service.close();store.close();}};
}

test.each(['IMAGE','VIDEO','AUDIO','MIXED'] as const)('human %s reply qualifies fresh exact media and sends once without changing the original observation',async kind=>{
  const f=await setup(kind);try{
    const original=f.store.event(f.eventId),commandId=randomUUID();
    const result=await f.service.dispatch(f.token,{command:'sendHumanReply',commandId,input:f.input});expect(result).toMatchObject({status:'PREPARING'});
    await f.service.drain();expect(await f.service.dispatch(f.token,{command:'getSendResult',commandId})).toMatchObject({status:'CONFIRMED'});
    expect(f.browser.clicks).toBe(1);expect(f.store.event(f.eventId).payload).toEqual(original.payload);expect(f.store.event(f.eventId).binding).toBe(original.binding);
    expect(isStrong(f.event)).toBe(false);expect(()=>f.store.assertModelObservation(f.event)).toThrow('DM_CONTENT_UNVERIFIED');
    expect(f.service.authority.draftFor(f.eventId)).toMatchObject({origin:'HUMAN_TYPED',text:f.input.text});
    expect(f.store.db.prepare('SELECT kind,used FROM budgets ORDER BY kind').all()).toEqual([{kind:'MODEL',used:0},{kind:'SEND',used:1}]);
    await f.service.dispatch(f.token,{command:'sendHumanReply',commandId,input:f.input});await f.service.drain();expect(f.browser.clicks).toBe(1);
    expect(f.store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:1});
  }finally{await f.close();}
});

test.each(['not-fresh','changed-media'] as const)('manual media proof %s never reaches a durable intent',async kind=>{
  const f=await setup();try{
    f.browser.fresh=kind!=='not-fresh';f.browser.mutate=kind==='changed-media';const commandId=randomUUID();
    await f.service.dispatch(f.token,{command:'sendHumanReply',commandId,input:f.input});await f.service.drain();
    expect(await f.service.dispatch(f.token,{command:'getSendResult',commandId})).toMatchObject({status:'FAILED_BEFORE_CLICK'});
    expect(f.browser.clicks).toBe(0);expect(f.store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
    if(kind==='not-fresh')expect(f.service.authority.capability('DIRECT_MESSAGE',f.browser.identity()).state).not.toBe('SEND_AVAILABLE');
  }finally{await f.close();}
});

test.each(['selection','emergency'] as const)('fresh media qualification cannot survive %s revocation',async action=>{
  const f=await setup();let release!:()=>void,entered=false;const gate=new Promise<void>(resolve=>{release=resolve;});
  f.browser.gate=async()=>{entered=true;await gate;};
  try{
    const commandId=randomUUID();await f.service.dispatch(f.token,{command:'sendHumanReply',commandId,input:f.input});await expect.poll(()=>entered).toBe(true);
    await f.service.dispatch(f.token,action==='selection'?{command:'selectTarget',eventId:null,selectionId:randomUUID()}:{command:'emergencyStop'});
    release();await f.service.drain();
    expect(await f.service.dispatch(f.token,{command:'getSendResult',commandId})).toMatchObject({status:'FAILED_BEFORE_CLICK'});
    expect(f.browser.clicks).toBe(0);expect(f.store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
    expect(f.service.authority.draftFor(f.eventId)?.text).toBe(f.input.text);
  }finally{release?.();await f.close();}
});

test('generic approval cannot admit caller-shaped media proof and an unedited AI revision is not human input',async()=>{
  const f=await setup();try{
    const suggestionId=randomUUID();f.store.db.prepare('INSERT INTO ai_suggestions VALUES(?,?,?,?,?,?,?,0)').run(suggestionId,f.eventId,0,
      f.input.contextVersion,'synthetic AI suggestion','synthetic-model',Date.now());
    await f.service.dispatch(f.token,{command:'saveDraft',eventId:f.eventId,generation:f.input.generation,expectedVersion:0,text:'synthetic AI suggestion',suggestionId});
    const draft=f.service.authority.draftFor(f.eventId)!;
    const contextDigest=digest('exact-native-window'),proof:TargetSnapshot={...snapshot(f.event),contextDigest,manualObservation:{kind:'DM_MEDIA',channel:'DIRECT_MESSAGE',
      eventBinding:eventBinding(f.event),contextDigest,contentType:'IMAGE',nativeKind:800,mediaDigest:digest('same-native-media'),freshExact:true}};
    expect(()=>f.store.approve(draft.id,proof,draft.version,draft.text)).toThrow();
    await expect(f.service.dispatch(f.token,{command:'sendHumanReply',commandId:randomUUID(),input:{...f.input,expectedVersion:draft.version,text:draft.text}})).rejects.toThrow('TARGET_NEEDS_REVIEW');
    expect(f.browser.clicks).toBe(0);expect(f.store.db.prepare('SELECT count(*) AS n FROM manual_send_commands').get()).toEqual({n:0});
    const manual={...f.input,expectedVersion:draft.version,text:'manually replaced exact human input'};
    const commandId=randomUUID();await f.service.dispatch(f.token,{command:'sendHumanReply',commandId,input:manual});await f.service.drain();
    expect(await f.service.dispatch(f.token,{command:'getSendResult',commandId})).toMatchObject({status:'CONFIRMED'});
    expect(f.service.authority.draftFor(f.eventId)?.origin).toBe('HUMAN_TYPED');expect(f.browser.clicks).toBe(1);
  }finally{await f.close();}
});

test.each(['expiry','identity'] as const)('persisted human media qualification cannot be reused after %s changes before dispatch',async action=>{
  const f=await setup();let release!:()=>void,entered=false;const gate=new Promise<void>(resolve=>{release=resolve;});
  f.browser.deliveryGate=async()=>{entered=true;await gate;};
  try{
    const commandId=randomUUID();await f.service.dispatch(f.token,{command:'sendHumanReply',commandId,input:f.input});await expect.poll(()=>entered).toBe(true);
    expect(f.service.authority.command(commandId).status).toBe('QUEUED');
    if(action==='expiry')f.advance(61000);else f.browser.identityVersion='changed-runtime';
    release();await f.service.drain();
    expect(await f.service.dispatch(f.token,{command:'getSendResult',commandId})).toMatchObject({status:'FAILED_BEFORE_CLICK'});
    expect(f.browser.clicks).toBe(0);expect(f.store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
    expect(f.store.db.prepare('SELECT used FROM budgets ORDER BY kind').all()).toEqual([{used:0},{used:0}]);
  }finally{release?.();await f.close();}
});

test('human media eligibility never grants a model call or an automatic policy job',async()=>{
  const f=await setup();try{
    await f.service.dispatch(f.token,{command:'configureAi',settings:defaultSettings,key:'synthetic-offline-only-key'});
    await f.service.dispatch(f.token,{command:'setModelGrant',scope:{ownId:'own-1',channels:['DIRECT_MESSAGE'],model:defaultSettings.model,modelLimit:2,expiresAt:null},confirmed:true});
    await expect(f.service.dispatch(f.token,{command:'generateSuggestion',eventId:f.eventId,draftVersion:0})).rejects.toThrow('DM_CONTENT_UNVERIFIED');
    await f.service.dispatch(f.token,{command:'setReplyPolicy',confirmed:true,policy:{ownId:'own-1',channels:['DIRECT_MESSAGE'],model:defaultSettings.model,
      modelLimit:2,sendLimit:2,expiresAt:null,workIds:[],futureOwnWorks:false,conversationIds:['conversation-1'],entireInbox:false,containsAny:[],excludesAny:[],
      instructions:'synthetic test only',startHour:0,endHour:24}});
    await f.service.dispatch(f.token,{command:'setMode',mode:'LIMITED_AUTO'});await f.service.runAutomaticReply();
    expect(f.models()).toBe(0);expect(f.store.db.prepare('SELECT count(*) AS n FROM model_calls').get()).toEqual({n:0});
    expect(f.store.db.prepare('SELECT count(*) AS n FROM grant_reservations').get()).toEqual({n:0});
    expect(f.store.db.prepare('SELECT count(*) AS n FROM automation_jobs').get()).toEqual({n:0});
    expect(f.browser.clicks).toBe(0);
  }finally{await f.close();}
});

test('native collision rejects human media before qualification and does not copy a draft or reserve a send',async()=>{
  const f=await setup();try{
    f.store.observe(f.event.channel,f.event.conversationId!,[{...f.event,text:'changed-source'}],'own-1','synthetic-conflict');
    const input={...f.input,contextVersion:f.service.authority.contextVersion(f.store.event(f.eventId))};
    await expect(f.service.dispatch(f.token,{command:'sendHumanReply',commandId:randomUUID(),input})).rejects.toThrow('TARGET_NEEDS_REVIEW');
    expect(f.browser.inspections).toBe(0);expect(f.store.db.prepare('SELECT count(*) AS n FROM manual_send_commands').get()).toEqual({n:0});
    expect(f.service.authority.draftFor(f.eventId)).toBeNull();
  }finally{await f.close();}
});
