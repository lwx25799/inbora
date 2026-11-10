import {expect,test} from 'vitest';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {AccountActor} from '../../src/browser/account-actor.js';
import {HumanFollowups} from '../../src/app/human-followup.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateFollowups} from '../../src/storage/followup-migration.js';
import {ChatMessageStore} from '../../src/storage/chat-messages.js';
import {digest,targetKey,type InboundEvent} from '../../src/core/contracts.js';
import {candidate,database,pending,privateTemp,snapshot} from '../helpers.js';

class FollowupBrowser extends BrowserService{
  private queue=new AccountActor();clicks=0;uncertain=false;lastNative='';inspectGate:()=>Promise<void>=async()=>{};
  override get actor(){return this.queue;}
  override identity(){return {identityDigest:digest('own-1'),mappingDigest:'synthetic-contract',browserVersion:'1.0',browserMode:'headless' as const};}
  override async refreshIdentity(){return this.identity();}
  override async close(){}
  override async adapter(event:InboundEvent){let text='';return {dispose:()=>{},adapter:{
    inspect:async()=>{await this.inspectGate();return snapshot(event);},prepare:async(_e:InboundEvent,value:string)=>{text=value;},
    verifyPrepared:async()=>snapshot(event),baseline:async()=>[],clickOnce:async()=>{this.clicks++;await new Promise(resolve=>setTimeout(resolve,5));},
    readback:async()=>this.uncertain?null:{id:this.lastNative=randomUUID(),ownId:'own-1',targetKey:targetKey(event),text,pending:false,sentAt:new Date().toISOString()},
  }};}
}
async function setup(channel:'DIRECT_MESSAGE'|'COMMENT_NOTIFICATION'='DIRECT_MESSAGE'){
  const store=database(),root=privateTemp('human-followup-');await migrateClient(store,join(root,'client.sqlite'));
  const eventId=pending(store,channel==='DIRECT_MESSAGE'?candidate():candidate({channel,kind:'COMMENT',videoId:'1001',commentId:'1101',platformEventId:'1101',conversationId:null}));
  const browser=new FollowupBrowser(root),service=new ClientService(store,browser);await service.loadSettings();const token=service.authority.issueSession();
  await service.dispatch(token,{command:'setMode',mode:'MANUAL'});const selectionId=randomUUID();
  const detail=await service.dispatch(token,{command:'openHumanDialog',eventId,selectionId}) as {ownership:{generation:number};contextVersion:string};
  const original={eventId,generation:detail.ownership.generation,expectedVersion:0,text:'first explicit human reply',contextVersion:detail.contextVersion,selectionId,suggestionId:null};
  const first=randomUUID();await service.dispatch(token,{command:'sendHumanReply',commandId:first,input:original});await service.drain();
  expect(await service.dispatch(token,{command:'getSendResult',commandId:first})).toMatchObject({status:'CONFIRMED'});
  const followups=new HumanFollowups(store,service.authority,browser,()=>false,()=>{},error=>error instanceof Error?error.message:'UNKNOWN');
  const nextInput=(text='second explicit human reply')=>{
    const next=followups.view(eventId);return {...original,text,expectedVersion:next?.draft?.version??0,contextVersion:service.authority.contextVersion(store.event(eventId))};
  };
  const originalRows=()=>['inbound_events','reply_drafts','send_intents','delivery_receipts'].map(table=>store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  return {store,root,browser,service,token,eventId,first,original,followups,nextInput,originalRows,close:async()=>{await service.close();store.close();}};
}

test.each(['DIRECT_MESSAGE','COMMENT_NOTIFICATION'] as const)('%s confirms two independent followups through the same coordinator and retains original records',async channel=>{
  const f=await setup(channel);try{
    const before=f.originalRows();
    for(const text of ['second reply','third reply']){
      const input=f.nextInput(text),commandId=randomUUID();
      await f.service.dispatch(f.token,{command:'sendHumanFollowup',commandId,input});
      await f.service.dispatch(f.token,{command:'sendHumanFollowup',commandId,input});await f.service.drain();
      expect(await f.service.dispatch(f.token,{command:'getSendResult',commandId})).toMatchObject({status:'CONFIRMED'});
      expect(f.followups.view(f.eventId)).toMatchObject({eligible:true,draft:{text:''},latestTurn:{commandId,text,status:'CONFIRMED'}});
      await expect(f.service.dispatch(f.token,{command:'sendHumanFollowup',commandId,input:{...input,text:'changed'}})).rejects.toThrow('COMMAND_PARAMETERS_CONFLICT');
    }
    expect(f.browser.clicks).toBe(3);expect(f.originalRows()).toEqual(before);
    expect(f.store.db.prepare('SELECT used FROM budgets WHERE kind=?').get('SEND')).toEqual({used:3});
    const thread=await f.service.dispatch(f.token,{command:'getThread',eventId:f.eventId}) as {timeline:{items:{text:string}[]};commentContext?:{items:{text:string}[]}};
    expect(thread.timeline.items.map(item=>item.text)).toEqual(expect.arrayContaining(['second reply','third reply']));
    if(channel==='COMMENT_NOTIFICATION')expect(thread.commentContext?.items.map(item=>item.text)).toEqual(expect.arrayContaining(['second reply','third reply']));
  }finally{await f.close();}
});

test.each(['DIRECT_MESSAGE','COMMENT_NOTIFICATION'] as const)('%s unknown followup keeps its immutable original and freezes new turns without replay after restart',async channel=>{
  const f=await setup(channel);try{
    const before=f.originalRows();f.browser.uncertain=true;const commandId=randomUUID(),input=f.nextInput();
    await f.service.dispatch(f.token,{command:'sendHumanFollowup',commandId,input});await f.service.drain();
    expect(await f.service.dispatch(f.token,{command:'getSendResult',commandId})).toMatchObject({status:'UNCERTAIN'});
    expect(f.store.sendFrozen(f.eventId)).toBe(true);expect(f.followups.view(f.eventId)?.eligible).toBe(false);
    expect(await f.service.dispatch(f.token,{command:'getInbox',channel:'ALL',status:'PENDING',page:0})).toMatchObject({total:1,items:[{replyStatus:'WAITING'}]});
    await expect(f.service.dispatch(f.token,{command:'sendHumanFollowup',commandId:randomUUID(),input:f.nextInput('must not submit')})).rejects.toThrow('FOLLOWUP_REPLY_UNRESOLVED');
    f.followups.recover();expect(f.browser.clicks).toBe(2);expect(f.originalRows()).toEqual(before);
  }finally{await f.close();}
});

test('an unknown followup does not permanently freeze a distinct later inbound in the same DM conversation',async()=>{
  const f=await setup();try{
    f.browser.uncertain=true;const unknown=randomUUID();
    await f.service.dispatch(f.token,{command:'sendHumanFollowup',commandId:unknown,input:f.nextInput()});await f.service.drain();
    const boundary=Date.now()-120_000;
    f.store.db.prepare('UPDATE human_reply_turns SET attempt_started_at=? WHERE command_id=?').run(new Date(boundary).toISOString(),unknown);
    const old=f.followups.turn(unknown),oldOriginal=f.originalRows();
    expect(f.store.db.prepare('SELECT * FROM pauses').all()).toEqual([]);
    const next=pending(f.store,candidate({platformEventId:'independent-after-followup',occurredAt:new Date(boundary+60_000).toISOString()}));
    expect(f.store.sendFrozen(f.eventId)).toBe(true);expect(f.store.sendFrozen(next)).toBe(false);
    const selectionId=randomUUID(),detail=await f.service.dispatch(f.token,{command:'openHumanDialog',eventId:next,selectionId}) as {ownership:{generation:number};contextVersion:string};
    f.browser.uncertain=false;const commandId=randomUUID(),input={...f.original,eventId:next,generation:detail.ownership.generation,
      contextVersion:detail.contextVersion,selectionId,text:'reply only to the independent later inbound'};
    await f.service.dispatch(f.token,{command:'sendHumanReply',commandId,input});await f.service.drain();
    expect(await f.service.dispatch(f.token,{command:'getSendResult',commandId})).toMatchObject({status:'CONFIRMED'});
    await f.service.dispatch(f.token,{command:'sendHumanReply',commandId,input});await f.service.drain();f.followups.recover();
    expect(f.browser.clicks).toBe(3);expect(f.followups.view(next)?.eligible).toBe(true);
    const continuation=randomUUID(),reopened=await f.service.dispatch(f.token,{command:'openHumanDialog',eventId:next,selectionId}) as {ownership:{generation:number};contextVersion:string};
    const followupInput={...input,generation:reopened.ownership.generation,contextVersion:reopened.contextVersion,
      expectedVersion:0,text:'another explicit reply to the independent inbound'};
    await f.service.dispatch(f.token,{command:'sendHumanFollowup',commandId:continuation,input:followupInput});await f.service.drain();
    expect(await f.service.dispatch(f.token,{command:'getSendResult',commandId:continuation})).toMatchObject({status:'CONFIRMED'});
    expect(f.browser.clicks).toBe(4);expect(f.followups.turn(unknown)).toEqual(old);expect(f.store.sendFrozen(f.eventId)).toBe(true);
    for(const [index,table] of ['inbound_events','reply_drafts','send_intents','delivery_receipts'].entries())
      expect(f.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().slice(0,oldOriginal[index]!.length)).toEqual(oldOriginal[index]);
  }finally{await f.close();}
});

test.each(['clock-overlap','before-intent','future-time','missing-time','missing-boundary','other-sender','in-flight'] as const)(
  'a followup unknown still freezes ambiguous or active DM boundaries (%s)',async fault=>{
  const f=await setup();try{
    f.browser.uncertain=true;const unknown=randomUUID();
    await f.service.dispatch(f.token,{command:'sendHumanFollowup',commandId:unknown,input:f.nextInput()});await f.service.drain();
    const boundary=Date.now()-120_000;
    f.store.db.prepare('UPDATE human_reply_turns SET attempt_started_at=?,status=? WHERE command_id=?')
      .run(fault==='missing-boundary'?null:new Date(boundary).toISOString(),fault==='in-flight'?'INTENT_RECORDED':'UNCERTAIN',unknown);
    const occurredAt=fault==='clock-overlap'?new Date(boundary+2000).toISOString():fault==='before-intent'?new Date(boundary-1).toISOString():
      fault==='future-time'?new Date(Date.now()+60_000).toISOString():new Date(boundary+60_000).toISOString();
    const next=pending(f.store,candidate({platformEventId:'independent-'+fault,occurredAt,actorId:fault==='other-sender'?'other-peer':'peer-1'}));
    if(fault==='missing-time')f.store.db.prepare('UPDATE inbound_events SET payload=json_set(payload,\'$.occurredAt\',NULL) WHERE id=?').run(next);
    const old=f.followups.turn(unknown);expect(f.store.sendFrozen(next)).toBe(true);expect(f.store.sendFrozen(f.eventId)).toBe(true);
    expect(f.followups.turn(unknown)).toEqual(old);expect(f.browser.clicks).toBe(2);
  }finally{await f.close();}
});

test('an explicit target pause remains effective for a later inbound after an unknown followup',async()=>{
  const f=await setup();try{
    f.browser.uncertain=true;const unknown=randomUUID();
    await f.service.dispatch(f.token,{command:'sendHumanFollowup',commandId:unknown,input:f.nextInput()});await f.service.drain();
    const boundary=Date.now()-120_000;
    f.store.db.prepare('UPDATE human_reply_turns SET attempt_started_at=? WHERE command_id=?').run(new Date(boundary).toISOString(),unknown);
    const next=pending(f.store,candidate({platformEventId:'later-but-explicitly-paused',occurredAt:new Date(boundary+60_000).toISOString()}));
    f.store.pause(targetKey(f.store.event(next).payload),true);const old=f.followups.turn(unknown);
    const detail=await f.service.dispatch(f.token,{command:'getThread',eventId:next}) as {frozen:boolean;paused:boolean};
    expect(detail).toMatchObject({frozen:false,paused:true});expect(f.browser.clicks).toBe(2);expect(f.followups.turn(unknown)).toEqual(old);
    expect(f.store.db.prepare('SELECT paused FROM pauses WHERE target_key=?').get(targetKey(f.store.event(next).payload))).toEqual({paused:1});
  }finally{await f.close();}
});

test('a later confirmed inbound reply cannot cover an earlier anchors new unknown followup',async()=>{
  const f=await setup();try{
    const next=pending(f.store,candidate({platformEventId:'later-confirmed-inbound',occurredAt:new Date(Date.now()-5000).toISOString()}));
    const selectionId=randomUUID(),detail=await f.service.dispatch(f.token,{command:'openHumanDialog',eventId:next,selectionId}) as {ownership:{generation:number};contextVersion:string};
    await f.service.dispatch(f.token,{command:'sendHumanReply',commandId:randomUUID(),input:{...f.original,eventId:next,generation:detail.ownership.generation,contextVersion:detail.contextVersion,selectionId}});await f.service.drain();
    const reopened=await f.service.dispatch(f.token,{command:'openHumanDialog',eventId:f.eventId,selectionId:f.original.selectionId}) as {ownership:{generation:number};contextVersion:string};
    f.browser.uncertain=true;await f.service.dispatch(f.token,{command:'sendHumanFollowup',commandId:randomUUID(),input:{...f.nextInput(),
      generation:reopened.ownership.generation,contextVersion:reopened.contextVersion}});await f.service.drain();
    expect(await f.service.dispatch(f.token,{command:'getInbox',channel:'DIRECT_MESSAGE',status:'PENDING',page:0})).toMatchObject({total:1,items:[{replyStatus:'WAITING'}]});
  }finally{await f.close();}
});

test('followup drafts save and clear independently and a stale version creates no turn',async()=>{
  const f=await setup();try{
    const before=f.originalRows(),input=f.nextInput();
    const saved=await f.service.dispatch(f.token,{command:'saveHumanFollowupDraft',eventId:f.eventId,generation:input.generation,expectedVersion:0,text:'editable new draft',suggestionId:null}) as {version:number};
    await expect(f.service.dispatch(f.token,{command:'sendHumanFollowup',commandId:randomUUID(),input})).rejects.toThrow('DRAFT_VERSION_CONFLICT');
    await f.service.dispatch(f.token,{command:'saveHumanFollowupDraft',eventId:f.eventId,generation:input.generation,expectedVersion:saved.version,text:'',suggestionId:null});
    expect(f.followups.view(f.eventId)?.draft?.text).toBe('');expect(f.originalRows()).toEqual(before);expect(f.browser.clicks).toBe(1);
  }finally{await f.close();}
});

test('restart before intent restores the unsubmitted full text and never clicks',async()=>{
  const f=await setup();try{
    const id=randomUUID(),input=f.nextInput('restore this unsent reply');
    f.followups.queue(f.token,id,input);expect(f.followups.view(f.eventId)?.draft?.text).toBe('');
    f.followups.recover();expect(f.followups.view(f.eventId)).toMatchObject({draft:{text:input.text},latestTurn:{status:'FAILED_BEFORE_CLICK'}});
    expect(f.browser.clicks).toBe(1);expect(f.store.db.prepare('SELECT intent_id FROM human_reply_turns WHERE command_id=?').get(id)).toEqual({intent_id:null});
  }finally{await f.close();}
});

test('target selection changes during preparation prevent a followup intent and retain its draft',async()=>{
  const f=await setup();try{
    let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;});
    f.browser.inspectGate=async()=>{entered();await new Promise<void>(r=>{release=r;});};
    const id=randomUUID(),input=f.nextInput();await f.service.dispatch(f.token,{command:'sendHumanFollowup',commandId:id,input});await started;
    await f.service.dispatch(f.token,{command:'selectTarget',eventId:null,selectionId:randomUUID()});release();await f.service.drain();
    expect(await f.service.dispatch(f.token,{command:'getSendResult',commandId:id})).toMatchObject({status:'FAILED_BEFORE_CLICK'});
    expect(f.followups.view(f.eventId)?.draft?.text).toBe(input.text);expect(f.browser.clicks).toBe(1);
  }finally{await f.close();}
});

test('a capability block observed during qualification cannot be overwritten by followup attestation',async()=>{
  const f=await setup();try{
    let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;});
    f.browser.inspectGate=async()=>{entered();await new Promise<void>(r=>{release=r;});};
    const id=randomUUID();await f.service.dispatch(f.token,{command:'sendHumanFollowup',commandId:id,input:f.nextInput()});await started;
    f.service.authority.attest('DIRECT_MESSAGE','BLOCKED',f.browser.identity(),'synthetic-block');release();await f.service.drain();
    expect(await f.service.dispatch(f.token,{command:'getSendResult',commandId:id})).toMatchObject({status:'FAILED_BEFORE_CLICK',reason:'CAPABILITY_CHANGED_DURING_CHECK'});
    expect(f.service.authority.capability('DIRECT_MESSAGE',f.browser.identity()).state).toBe('BLOCKED');expect(f.browser.clicks).toBe(1);
  }finally{await f.close();}
});

test('restart after an independent intent marks only that new turn unknown and keeps the old receipt',async()=>{
  const f=await setup();try{
    const before=f.originalRows(),id=randomUUID();f.followups.queue(f.token,id,f.nextInput());
    f.store.db.prepare("UPDATE human_reply_turns SET status='INTENT_RECORDED',intent_id=?,attempt_started_at=? WHERE command_id=?")
      .run(randomUUID(),new Date().toISOString(),id);f.followups.recover();
    expect(f.followups.view(f.eventId)).toMatchObject({eligible:false,latestTurn:{status:'UNCERTAIN'}});
    expect(f.store.sendFrozen(f.eventId)).toBe(true);expect(f.browser.clicks).toBe(1);expect(f.originalRows()).toEqual(before);
  }finally{await f.close();}
});

test('native observation suppresses only the matching followup annotation and preserves another identical message',async()=>{
  const f=await setup();try{
    const id=randomUUID(),text='same followup text';await f.service.dispatch(f.token,{command:'sendHumanFollowup',commandId:id,input:f.nextInput(text)});await f.service.drain();
    const time=new Date().toISOString(),own=candidate({direction:'OUTGOING',actorId:'own-1',text,occurredAt:time,platformEventId:f.browser.lastNative});
    new ChatMessageStore(f.store).observe([own,{...own,platformEventId:randomUUID()}],'own-1',Date.now()-60_000);
    const thread=await f.service.dispatch(f.token,{command:'getThread',eventId:f.eventId}) as {timeline:{items:{text:string}[]}};
    expect(thread.timeline.items.filter(item=>item.text===text)).toHaveLength(2);expect(f.browser.clicks).toBe(2);
  }finally{await f.close();}
});

test('additive followup migration preserves all existing rows and schema versions and creates a restorable backup',async()=>{
  const f=await setup();try{
    f.store.db.exec('DROP TABLE human_reply_turns;DROP TABLE human_reply_drafts');const before=f.originalRows(),backup=join(f.root,'followup-backup.sqlite');
    expect(await migrateFollowups(f.store,backup)).toBe(true);expect(await migrateFollowups(f.store,backup)).toBe(false);
    expect(f.originalRows()).toEqual(before);expect(f.store.db.pragma('user_version',{simple:true})).toBe(3);
    expect(f.store.db.prepare('SELECT version FROM automation_schema').get()).toEqual({version:3});
    const saved=new Database(backup,{readonly:true});try{expect(saved.pragma('quick_check',{simple:true})).toBe('ok');
      expect(saved.prepare('SELECT count(*) n FROM inbound_events').get()).toEqual({n:1});}finally{saved.close();}
  }finally{await f.close();}
});
