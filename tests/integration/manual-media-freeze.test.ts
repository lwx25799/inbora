import {expect,test} from 'vitest';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {AccountActor} from '../../src/browser/account-actor.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {ClientService} from '../../src/app/service.js';
import {digest,eventBinding,isManualMediaCandidate,isStrong,targetKey,type InboundEvent} from '../../src/core/contracts.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {DeepSeekProvider} from '../../src/ai/deepseek.js';
import {defaultSettings} from '../../src/app/contracts.js';
import {candidate,database,pending,privateTemp,snapshot} from '../helpers.js';

const boundary='2026-11-04T01:00:30.000Z';
function bound(event:InboundEvent){
  const contextDigest=digest('exact synthetic native window');
  return {...snapshot(event),contextDigest,...(isManualMediaCandidate(event)?{manualObservation:{kind:'DM_MEDIA' as const,
    channel:'DIRECT_MESSAGE' as const,eventBinding:eventBinding(event),contextDigest,contentType:event.contentType!,
    nativeKind:800,mediaDigest:digest('synthetic media'),freshExact:true as const}}:{})};
}
class MediaBrowser extends BrowserService {
  private queue=new AccountActor();clicks=0;
  override get actor(){return this.queue;}
  override identity(){return {identityDigest:digest('own-1'),mappingDigest:'synthetic',browserVersion:'1.0',browserMode:'headless' as const};}
  override async refreshIdentity(){return this.identity();}
  override async close(){}
  override async adapter(event:InboundEvent){
    let text='';return {dispose:()=>{},adapter:{inspect:async()=>bound(event),
      prepare:async(_event:InboundEvent,value:string)=>{text=value;},verifyPrepared:async()=>bound(event),baseline:async()=>[],
      clickOnce:async()=>{this.clicks++;await new Promise(resolve=>setTimeout(resolve,5));},
      readback:async()=>({id:'9003',ownId:'own-1',targetKey:targetKey(event),text,pending:false,sentAt:new Date().toISOString()}),
    }};
  }
}
async function setup(oldMedia=true,contentType:InboundEvent['contentType']|null='IMAGE',source='intent',verified=false){
  const store=database(),root=privateTemp('manual-media-freeze-');await migrateClient(store,join(root,'backup.sqlite'));
  let models=0;const provider=new DeepSeekProvider(async()=>{models++;return new Response(JSON.stringify({model:'deepseek-flash',
    choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'synthetic automatic reply'}}],
    usage:{prompt_tokens:1,completion_tokens:2,total_tokens:3}}));});
  const browser=new MediaBrowser(root),service=new ClientService(store,browser,provider);await service.loadSettings();const token=service.authority.issueSession();
  const old=candidate({platformEventId:'9001',...(oldMedia?{contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED',text:'[old share]'}:{})});
  pending(store,old);
  const oldId=store.events().find(e=>e.payload.platformEventId===old.platformEventId)!.id;
  const draft=randomUUID(),intent=randomUUID(),approval={snapshot:bound(old),version:1,textDigest:digest('old human reply')};
  store.db.prepare("INSERT INTO reply_drafts VALUES(?,?,?,'human',1,'APPROVED',?,NULL)").run(draft,oldId,'old human reply',JSON.stringify(approval));
  if(source==='intent'){
    store.db.prepare('INSERT INTO send_intents VALUES(?,?,?,?,?,?,?,?)')
      .run(intent,oldId,draft,targetKey(old),digest(approval.snapshot),approval.textDigest,'UNCERTAIN',boundary);
    store.db.prepare('INSERT INTO delivery_receipts VALUES(?,?,?,?,?)').run(randomUUID(),intent,'UNCERTAIN','NO_UNIQUE_BOUND_PROOF',boundary);
    store.db.prepare("UPDATE inbound_events SET status='UNCERTAIN' WHERE id=?").run(oldId);
    if(verified)store.db.prepare('INSERT INTO verification_results VALUES(?,?,?,?,?)').run(randomUUID(),intent,1,'synthetic complete proof',Date.now());
  }else{
    store.db.prepare(`INSERT INTO human_reply_turns(command_id,event_id,target_key,operator_id,input_digest,params,text,version,status,attempt_started_at,created_at)
      VALUES(?,?,?,?,?,?,?,1,'UNCERTAIN',?,?)`).run(intent,oldId,targetKey(old),'old human','synthetic','{}','old human reply',boundary,Date.now());
  }
  const next=candidate({platformEventId:'9002',occurredAt:'2026-11-04T01:01:30.000Z',
    ...(contentType?{contentType,observationIssue:'DM_CONTENT_UNVERIFIED',text:'[new share]'}:{})});
  pending(store,next);const nextId=store.events().find(e=>e.payload.platformEventId===next.platformEventId)!.id;
  if(contentType==='IMAGE')store.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?)').run(randomUUID(),new Date().toISOString(),
    'INBOUND_DISPLAY_CLASSIFIED',nextId,JSON.stringify({binding:eventBinding(next),eventType:'DOUYIN_WORK_SHARE'}));
  const oldRows=()=>({event:store.event(oldId),draft:store.draft(draft),
    intents:store.db.prepare('SELECT * FROM send_intents WHERE event_id=?').all(oldId),
    receipts:store.db.prepare('SELECT * FROM delivery_receipts WHERE send_intent_id=?').all(intent),
    verification:store.db.prepare('SELECT * FROM verification_results WHERE intent_id=?').all(intent),
    turns:store.db.prepare('SELECT * FROM human_reply_turns WHERE event_id=?').all(oldId)});
  return {store,service,browser,token,next,nextId,oldId,intent,oldRows,models:()=>models,close:async()=>{await service.close();store.close();}};
}

test.each(['IMAGE','VIDEO','AUDIO','MIXED'] as const)('a new %s permits one human reply after an old media reply with append-only delivery proof',async kind=>{
  const f=await setup(true,kind,'intent',true);try{
    const before=f.oldRows();
    expect(f.store.sendFrozen(f.nextId)).toBe(false);
    expect(await f.service.dispatch(f.token,{command:'getThread',eventId:f.nextId})).toMatchObject({frozen:false,humanReplyEligibility:{eligible:true}});
    await f.service.dispatch(f.token,{command:'setMode',mode:'MANUAL'});const selectionId=randomUUID();
    const detail=await f.service.dispatch(f.token,{command:'openHumanDialog',eventId:f.nextId,selectionId}) as {ownership:{generation:number};contextVersion:string};
    const input={eventId:f.nextId,generation:detail.ownership.generation,expectedVersion:0,text:'new explicit human reply',
      contextVersion:detail.contextVersion,selectionId,suggestionId:null},commandId=randomUUID();
    await f.service.dispatch(f.token,{command:'sendHumanReply',commandId,input});await f.service.drain();
    expect(await f.service.dispatch(f.token,{command:'getSendResult',commandId})).toMatchObject({status:'CONFIRMED'});
    await f.service.dispatch(f.token,{command:'sendHumanReply',commandId,input});await f.service.drain();
    expect(f.browser.clicks).toBe(1);expect(f.oldRows()).toEqual(before);expect(isStrong(f.next)).toBe(false);
    expect(()=>f.store.assertModelObservation(f.next)).toThrow('DM_CONTENT_UNVERIFIED');
    expect(f.store.budgets().map(row=>({kind:row.kind,used:row.used}))).toEqual([{kind:'MODEL',used:0},{kind:'SEND',used:1}]);
  }finally{await f.close();}
});

test.each(['intent','followup'])('native identity separates a new text/media message from an old unresolved media %s',async source=>{
  for(const oldMedia of [false,true])for(const nextMedia of [false,true]){
    const f=await setup(oldMedia,nextMedia?'IMAGE':null,source);try{
      const before=f.oldRows();expect(f.store.sendFrozen(f.nextId)).toBe(false);
      expect(f.store.sendFrozen(f.oldId)).toBe(true);expect(f.oldRows()).toEqual(before);
    }finally{await f.close();}
  }
});

test('a later text automatically replies once while the old media outcome stays immutable',async()=>{
  const f=await setup(true,null);try{
    const before=f.oldRows();
    await f.service.dispatch(f.token,{command:'configureAi',settings:defaultSettings,key:'synthetic-offline-key'});
    await f.service.dispatch(f.token,{command:'setReplyPolicy',confirmed:true,policy:{ownId:'own-1',channels:['DIRECT_MESSAGE'],
      model:defaultSettings.model,modelLimit:1,sendLimit:1,expiresAt:null,workIds:[],futureOwnWorks:false,
      conversationIds:[f.next.conversationId!],entireInbox:false,containsAny:[],excludesAny:[],instructions:'synthetic only',startHour:0,endHour:24}});
    await f.service.dispatch(f.token,{command:'setMode',mode:'LIMITED_AUTO'});
    await f.service.runAutomaticReply();await f.service.runAutomaticReply();
    expect(f.store.event(f.nextId).status).toBe('CONFIRMED');expect(f.models()).toBe(1);expect(f.browser.clicks).toBe(1);
    expect(f.oldRows()).toEqual(before);
  }finally{await f.close();}
});

test.each(['same-event','overlap','future','missing-native','missing-actor','missing-conversation','missing-time','other-actor','old-missing-native','old-missing-time','collision','old-collision','in-flight'])(
  'manual media still freezes an ambiguous or unsafe boundary (%s)',async fault=>{
    const f=await setup();try{
      const id=fault.startsWith('old-')?f.oldId:f.nextId,e={...f.store.event(id).payload};
      if(fault.endsWith('missing-native'))e.platformEventId=null;
      if(fault==='missing-actor')e.actorId=null;
      if(fault==='missing-conversation')e.conversationId=null;
      if(fault.endsWith('missing-time'))e.occurredAt=null;
      if(fault==='overlap')e.occurredAt=new Date(Date.parse(boundary)+2000).toISOString();
      if(fault==='future')e.occurredAt=new Date(Date.now()+60_000).toISOString();
      if(fault==='other-actor')e.actorId='someone-else';
      f.store.db.prepare('UPDATE inbound_events SET payload=?,binding=? WHERE id=?').run(JSON.stringify(e),eventBinding(e),id);
      if(fault.endsWith('collision'))f.store.db.prepare('INSERT INTO source_collisions VALUES(?,?,?,?,?)').run(randomUUID(),id,'synthetic','{}','synthetic');
      if(fault==='in-flight')f.store.db.prepare("UPDATE send_intents SET status='INTENT_RECORDED' WHERE id=?").run(f.intent);
      if(fault==='missing-conversation')expect(isManualMediaCandidate(e)).toBe(false);
      else expect(f.store.sendFrozen(fault==='same-event'?f.oldId:f.nextId)).toBe(true);
      expect(f.browser.clicks).toBe(0);
    }finally{await f.close();}
  });
