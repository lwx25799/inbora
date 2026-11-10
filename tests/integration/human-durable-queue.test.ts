import {expect,test} from 'vitest';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {AccountActor} from '../../src/browser/account-actor.js';
import {HumanFollowups} from '../../src/app/human-followup.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {digest,targetKey,type InboundEvent} from '../../src/core/contracts.js';
import {candidate,database,pending,privateTemp,snapshot} from '../helpers.js';

class QueueBrowser extends BrowserService{
  private serial=new AccountActor();clicks:string[]=[];unknownFirst=false;gate:()=>Promise<void>=async()=>{};readGate:()=>Promise<void>=async()=>{};
  override get actor(){return this.serial;}
  override identity(){return{identityDigest:digest('own-1'),mappingDigest:'fixture',browserVersion:'1',browserMode:'headless' as const};}
  override async refreshIdentity(){return this.identity();}
  override async close(){}
  override async adapter(event:InboundEvent){let text='';return{dispose:()=>{},adapter:{inspect:async()=>{await this.gate();return snapshot(event);},
    prepare:async(_e:InboundEvent,t:string)=>{text=t;},verifyPrepared:async()=>snapshot(event),baseline:async()=>[],
    clickOnce:async()=>{this.clicks.push(text);await new Promise(r=>setTimeout(r,5));},
    readback:async()=>{await this.readGate();return this.unknownFirst&&this.clicks.length===1?null:{id:randomUUID(),ownId:'own-1',targetKey:targetKey(event),text,pending:false,sentAt:new Date().toISOString()};},
  }};}
}
async function setup(nested=false){
  const store=database(),root=privateTemp('human-durable-queue-');await migrateClient(store,join(root,'client.sqlite'));
  if(nested)pending(store,candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',videoId:'1001',commentId:'1101',platformEventId:'1101',conversationId:null}));
  const eventId=pending(store,nested?candidate({channel:'COMMENT_NOTIFICATION',kind:'REPLY',videoId:'1001',commentId:'1102',platformEventId:'1102',
    rootCommentId:'1101',replyToCommentId:'1102',conversationId:null,occurredAt:'2026-11-04T01:00:01Z'}):candidate()),browser=new QueueBrowser(root),service=new ClientService(store,browser);await service.loadSettings();
  const token=service.authority.issueSession();await service.dispatch(token,{command:'setMode',mode:'MANUAL'});const selectionId=randomUUID();
  const thread=await service.dispatch(token,{command:'openHumanDialog',eventId,selectionId}) as {ownership:{generation:number};contextVersion:string};
  const input={eventId,generation:thread.ownership.generation,expectedVersion:0,text:'first human sentence',selectionId,contextVersion:thread.contextVersion,suggestionId:null};
  const followups=new HumanFollowups(store,service.authority,browser,()=>false,()=>{},e=>e instanceof Error?e.message:'UNKNOWN');
  return{store,browser,service,token,eventId,input,followups,async close(){await service.close();store.close();}};
}

test.each([false,true])('three explicit human sentences queue durably before first preparation completes; unknownFirst=%s',async unknown=>{
  const f=await setup();let release=()=>{};try{
    let entered=()=>{};const waiting=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});let first=true;
    f.browser.gate=async()=>{if(first){first=false;entered();await gate;}};f.browser.unknownFirst=unknown;
    const original=randomUUID(),queued=await f.service.dispatch(f.token,{command:'sendHumanReply',commandId:original,input:f.input});
    await waiting;expect(f.followups.view(f.eventId)).toMatchObject({queueReady:true});
    expect(queued).toMatchObject({commandId:original,status:'PREPARING',accepted:true});
    const commands:string[]=[];
    for(const text of ['second distinct sentence','third distinct sentence']){
      const commandId=randomUUID(),input={...f.input,text,expectedVersion:f.followups.currentDraft(f.eventId)?.version??0,
        contextVersion:f.service.authority.contextVersion(f.store.event(f.eventId))};commands.push(commandId);
      expect(await f.service.dispatch(f.token,{command:'sendHumanFollowup',commandId,input})).toMatchObject({commandId,status:'PREPARING',accepted:true});
      await f.service.dispatch(f.token,{command:'sendHumanFollowup',commandId,input});
    }
    expect(f.browser.clicks).toEqual([]);expect(f.store.db.prepare('SELECT used FROM budgets WHERE kind=?').get('SEND')).toEqual({used:0});
    release();await f.service.drain();
    expect(f.browser.clicks).toEqual(['first human sentence','second distinct sentence','third distinct sentence']);
    for(const commandId of commands)expect(await f.service.dispatch(f.token,{command:'getSendResult',commandId})).toMatchObject({status:'CONFIRMED',accepted:true});
    expect(await f.service.dispatch(f.token,{command:'getSendResult',commandId:original})).toMatchObject({status:unknown?'UNCERTAIN':'CONFIRMED'});
    expect(f.store.db.prepare('SELECT used FROM budgets WHERE kind=?').get('SEND')).toEqual({used:3});
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:1});
    expect(f.store.db.prepare('SELECT count(*) n FROM human_reply_turns').get()).toEqual({n:2});
  }finally{release();await f.close();}
});

test('known post-intent identity or platform counterevidence cannot grant a new human queue qualification',async()=>{
  const f=await setup();try{
    f.browser.unknownFirst=true;const id=randomUUID();await f.service.dispatch(f.token,{command:'sendHumanReply',commandId:id,input:f.input});await f.service.drain();
    expect(f.followups.view(f.eventId)?.queueReady).toBe(true);
    const intent=f.service.authority.command(id).intent_id;
    f.store.db.prepare("UPDATE delivery_receipts SET proof_ref='POST_INTENT_FAILURE:DISPATCH:NATIVE_REPLY_ACCOUNT_CHANGED' WHERE send_intent_id=?").run(intent);
    expect(f.followups.view(f.eventId)?.queueReady).toBe(false);
    await expect(f.service.dispatch(f.token,{command:'sendHumanFollowup',commandId:randomUUID(),input:{...f.input,text:'distinct but unsafe',
      contextVersion:f.service.authority.contextVersion(f.store.event(f.eventId))}})).rejects.toThrow('FOLLOWUP_REPLY_UNRESOLVED');
    expect(f.browser.clicks).toHaveLength(1);expect(f.store.db.prepare('SELECT count(*) n FROM human_reply_turns').get()).toEqual({n:0});
  }finally{await f.close();}
});

test('a sibling child arriving under the same root cannot be mistaken for preceding own queue progress',async()=>{
  const f=await setup(true);let release=()=>{};try{
    await f.service.dispatch(f.token,{command:'sendHumanReply',commandId:randomUUID(),input:f.input});await f.service.drain();
    let enter=()=>{};const entered=new Promise<void>(r=>{enter=r;}),gate=new Promise<void>(r=>{release=r;});let first=true;
    f.browser.gate=async()=>{if(first){first=false;enter();await gate;}};
    const prior={...f.input,text:'earlier nested sentence',contextVersion:f.service.authority.contextVersion(f.store.event(f.eventId))};
    await f.service.dispatch(f.token,{command:'sendHumanFollowup',commandId:randomUUID(),input:prior});await entered;
    const id=randomUUID();await f.service.dispatch(f.token,{command:'sendHumanFollowup',commandId:id,input:{...prior,text:'queued nested next sentence',
      expectedVersion:f.followups.currentDraft(f.eventId)!.version}});
    pending(f.store,candidate({channel:'COMMENT_NOTIFICATION',kind:'REPLY',videoId:'1001',commentId:'1103',platformEventId:'1103',
      rootCommentId:'1101',replyToCommentId:'1103',conversationId:null,occurredAt:new Date().toISOString()}));
    release();await f.service.drain();
    expect(await f.service.dispatch(f.token,{command:'getSendResult',commandId:id})).toMatchObject({status:'FAILED_BEFORE_CLICK',reason:'CONTEXT_VERSION_CONFLICT',intentId:null});
    expect(f.browser.clicks).toEqual([f.input.text]);
  }finally{release();await f.close();}
});

test.each(['PREPARING','SENDING','UNCERTAIN'] as const)('an unresolved original %s cannot be repeated under a new command ID',async stage=>{
  const f=await setup();let release=()=>{};try{
    let enter=()=>{};const entered=new Promise<void>(r=>{enter=r;}),gate=new Promise<void>(r=>{release=r;});
    if(stage==='PREPARING')f.browser.gate=async()=>{enter();await gate;};
    if(stage==='SENDING')f.browser.readGate=async()=>{enter();await gate;};
    if(stage==='UNCERTAIN')f.browser.unknownFirst=true;
    const commandId=randomUUID();await f.service.dispatch(f.token,{command:'sendHumanReply',commandId,input:f.input});
    if(stage==='UNCERTAIN')await f.service.drain();else await entered;
    const params=JSON.parse(f.service.authority.command(commandId).params);
    expect(Object.keys(params)).toEqual(expect.arrayContaining(['eventId','draftId','draftVersion','text','contextVersion']));expect(typeof params.text).toBe('string');
    await expect(f.service.dispatch(f.token,{command:'sendHumanFollowup',commandId:randomUUID(),input:{...f.input,
      contextVersion:f.service.authority.contextVersion(f.store.event(f.eventId))}})).rejects.toThrow('HUMAN_REPLY_DUPLICATE_UNRESOLVED');
    expect(f.store.db.prepare('SELECT count(*) n FROM human_reply_turns').get()).toEqual({n:0});
    if(stage==='PREPARING')expect(f.browser.clicks).toEqual([]);else expect(f.browser.clicks).toEqual([f.input.text]);
  }finally{release();await f.close();}
});

test.each(['SELECTION','EMERGENCY','INBOUND','RESTART'] as const)('queued followups keep drafts and create no intent after %s',async fault=>{
  const f=await setup();let release=()=>{};try{
    let enter=()=>{};const entered=new Promise<void>(r=>{enter=r;}),gate=new Promise<void>(r=>{release=r;});let first=true;
    f.browser.gate=async()=>{if(first){first=false;enter();await gate;}};
    await f.service.dispatch(f.token,{command:'sendHumanReply',commandId:randomUUID(),input:f.input});await entered;
    const id=randomUUID(),input={...f.input,text:'queued sentence stays durable'};
    expect(await f.service.dispatch(f.token,{command:'sendHumanFollowup',commandId:id,input})).toMatchObject({accepted:true});
    if(fault==='SELECTION')await f.service.dispatch(f.token,{command:'selectTarget',eventId:null,selectionId:randomUUID()});
    if(fault==='EMERGENCY')await f.service.dispatch(f.token,{command:'emergencyStop'});
    if(fault==='INBOUND')pending(f.store,candidate({platformEventId:'new-incoming-while-queued',occurredAt:new Date().toISOString()}));
    if(fault==='RESTART')f.followups.recover();
    release();await f.service.drain();const result=await f.service.dispatch(f.token,{command:'getSendResult',commandId:id});
    expect(result).toMatchObject({status:'FAILED_BEFORE_CLICK',accepted:false,intentId:null});
    expect(f.followups.view(f.eventId)?.draft?.text).toBe(input.text);
    expect(f.store.db.prepare('SELECT count(*) n FROM human_reply_turns WHERE intent_id IS NOT NULL').get()).toEqual({n:0});
    if(fault!=='RESTART')expect(f.browser.clicks).toEqual([]);
  }finally{release();await f.close();}
});

test('a new explicit sentence after an unknown human turn does not rewrite or repeat that turn, while foreign original unknown stays frozen',async()=>{
  const f=await setup();try{
    await f.service.dispatch(f.token,{command:'sendHumanReply',commandId:randomUUID(),input:f.input});await f.service.drain();
    f.browser.unknownFirst=false;const second=randomUUID(),input={...f.input,text:'unknown followup sentence',contextVersion:f.service.authority.contextVersion(f.store.event(f.eventId))};
    const originalAdapter=f.browser.adapter.bind(f.browser);f.browser.adapter=async event=>{const handle=await originalAdapter(event);handle.adapter.readback=async()=>null;return handle;};
    await f.service.dispatch(f.token,{command:'sendHumanFollowup',commandId:second,input});await f.service.drain();const old=f.followups.turn(second);
    f.browser.adapter=originalAdapter;const third=randomUUID();
    await f.service.dispatch(f.token,{command:'sendHumanFollowup',commandId:third,input:{...input,text:'independent next human sentence',
      expectedVersion:f.followups.currentDraft(f.eventId)!.version,contextVersion:f.service.authority.contextVersion(f.store.event(f.eventId))}});await f.service.drain();
    expect(f.followups.turn(second)).toEqual(old);expect(f.browser.clicks).toEqual([f.input.text,input.text,'independent next human sentence']);
    expect(await f.service.dispatch(f.token,{command:'getSendResult',commandId:third})).toMatchObject({status:'CONFIRMED'});
    f.store.db.prepare("UPDATE manual_send_commands SET operator_id='foreign-operator' WHERE event_id=?").run(f.eventId);
    f.store.db.prepare("UPDATE send_intents SET status='UNCERTAIN' WHERE event_id=?").run(f.eventId);
    expect(f.followups.view(f.eventId)?.queueReady).toBe(false);
    await expect(f.service.dispatch(f.token,{command:'sendHumanFollowup',commandId:randomUUID(),input:{...input,text:'must remain blocked',
      expectedVersion:f.followups.currentDraft(f.eventId)!.version,contextVersion:f.service.authority.contextVersion(f.store.event(f.eventId))}})).rejects.toThrow('FOLLOWUP_REQUIRES_CONFIRMED_REPLY');
  }finally{await f.close();}
});
