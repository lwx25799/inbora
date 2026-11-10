import {expect,test} from 'vitest';
import {join} from 'node:path';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {DeepSeekProvider} from '../../src/ai/deepseek.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {digest,targetKey} from '../../src/core/contracts.js';
import type {ReplyPolicy} from '../../src/app/automation-contracts.js';
import {candidate,database,pending,privateTemp} from '../helpers.js';
import {runtimePerformance} from '../../src/observability/runtime-performance.js';

const policy=(overrides:Partial<ReplyPolicy>={}):ReplyPolicy=>({ownId:'own-1',model:'deepseek-flash',channels:['DIRECT_MESSAGE','COMMENT_NOTIFICATION'],
  modelLimit:null,sendLimit:null,expiresAt:null,workIds:['work-1'],futureOwnWorks:false,conversationIds:['conversation-1'],entireInbox:false,
  containsAny:[],excludesAny:[],instructions:'Only the exact saved policy instruction.',startHour:0,endHour:24,...overrides});
class FixtureBrowser extends BrowserService{
  override identity(){return{identityDigest:digest('own-1'),mappingDigest:'fixture',browserVersion:'1',browserMode:'headless' as const};}
  override async close(){}
}
async function setup(scope:Partial<ReplyPolicy>={}){
  const store=database(),root=privateTemp('manual-suggestion-policy-');await migrateClient(store,join(root,'backup.sqlite'));
  const id=pending(store),browser=new FixtureBrowser(root),current=Date.UTC(2026,10,10,12),calls:{body:string}[]=[];
  let clock=scope.expiresAt&&scope.expiresAt<=current?scope.expiresAt-1000:current;
  let gate:()=>Promise<void>=async()=>{};
  const provider=new DeepSeekProvider(async(_url,input)=>{calls.push({body:String(input?.body)});await gate();return new Response(JSON.stringify({
    model:'deepseek-flash',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'Exact synthetic reply candidate'}}],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}}));});
  const service=new ClientService(store,browser,provider,()=>clock);await service.loadSettings();const token=service.authority.issueSession();
  service.authority.attest('DIRECT_MESSAGE','SEND_AVAILABLE',browser.identity(),'synthetic-only');service.authority.setMode(token,'MANUAL');
  const auto=new AutomationStore(store,()=>clock),grant=auto.grant('AUTO_REPLY',policy(scope));
  // Current grant creation clears the retired positive filter. Preserve a valid historical saved scope for this guard case.
  if(scope.containsAny?.length){const saved={...grant.scope,containsAny:scope.containsAny};
    store.db.prepare('UPDATE automation_grants SET scope_json=?,scope_digest=? WHERE version=?').run(JSON.stringify(saved),digest(saved),grant.version);}
  await service.dispatch(token,{command:'configureAi',settings:{model:'deepseek-flash',persona:'',business:'',rules:'Existing account rule'},key:'synthetic-memory-only'});
  const generation=service.authority.claim(token,id,0).generation;
  clock=current;
  return {store,id,service,token,auto,grant,calls,generation,clock,advance:(ms:number)=>{clock+=ms;},setGate:(value:()=>Promise<void>)=>{gate=value;},
    async close(){await service.close();store.close();}};
}

test('only an active reply policy exposes a permitted first-text suggestion in status and exact thread',async()=>{
  const f=await setup();try{
    expect(f.auto.active('MODEL')).toBeNull();
    expect(await f.service.dispatch(f.token,{command:'getStatus'})).toMatchObject({modelAuthorized:true});
    expect(await f.service.dispatch(f.token,{command:'getThread',eventId:f.id})).toMatchObject({suggestionEligibility:{eligible:true,reason:null}});
  }finally{await f.close();}
});

test('explicit manual suggestion after auto replies are off uses one policy MODEL reservation and its instructions, with no SEND use',async()=>{
  const f=await setup({sendLimit:1});try{
    f.store.db.prepare("UPDATE budgets SET used=1 WHERE kind='SEND'").run();
    await f.service.dispatch(f.token,{command:'setAutomaticReply',enabled:false});
    const result=await f.service.dispatch(f.token,{command:'generateSuggestion',eventId:f.id,draftVersion:0});
    expect(result).toMatchObject({stale:false,text:'Exact synthetic reply candidate'});expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.body).toContain(f.grant.scope.instructions);expect(f.calls[0]!.body).not.toContain('Existing account rule');
    expect(f.store.db.prepare('SELECT kind,count(*) n FROM grant_reservations WHERE grant_version=? GROUP BY kind').all(f.grant.version)).toEqual([{kind:'MODEL',n:1}]);
    expect(f.store.db.prepare('SELECT kind,used FROM budgets ORDER BY kind').all()).toEqual([{kind:'MODEL',used:1},{kind:'SEND',used:1}]);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});expect(f.service.authority.draftFor(f.id)).toBeNull();
  }finally{await f.close();}
});

test.each([
  {scope:{channels:['COMMENT_NOTIFICATION']},reason:'MODEL_OUTSIDE_GRANT'},
  {scope:{model:'deepseek-another'},reason:'MODEL_OUTSIDE_GRANT'},
  {scope:{conversationIds:['other-conversation']},reason:'MODEL_OUTSIDE_GRANT'},
  {scope:{containsAny:['not-present']},reason:'MODEL_OUTSIDE_GRANT'},
  {scope:{excludesAny:['hello']},reason:'MODEL_OUTSIDE_GRANT'},
  {scope:{startHour:21,endHour:22},reason:'MODEL_OUTSIDE_GRANT'},
  {scope:{expiresAt:Date.UTC(2026,10,10,11)},reason:'REAL_MODEL_AUTHORIZATION_REQUIRED'},
] as {scope:Partial<ReplyPolicy>;reason:string}[])('policy scope $scope rejects before any provider call or reservation',async({scope,reason})=>{
  const f=await setup(scope);try{
    await expect(f.service.dispatch(f.token,{command:'generateSuggestion',eventId:f.id,draftVersion:0})).rejects.toThrow(reason);
    expect(f.calls).toEqual([]);expect(f.store.db.prepare('SELECT count(*) n FROM model_calls').get()).toEqual({n:0});
    expect(f.store.db.prepare('SELECT count(*) n FROM grant_reservations').get()).toEqual({n:0});
  }finally{await f.close();}
});

test.each(['REVOKE','EMERGENCY','MODEL_CHANGE'] as const)('late $0 revokes policy results without creating a usable suggestion or refunding its paid attempt',async fault=>{
  const f=await setup();let release=()=>{};try{
    let enter=()=>{};const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});f.setGate(async()=>{enter();await gate;});
    const work=f.service.dispatch(f.token,{command:'generateSuggestion',eventId:f.id,draftVersion:0});await entered;
    if(fault==='REVOKE')await f.service.dispatch(f.token,{command:'setReplyPolicy',policy:null,confirmed:true});
    if(fault==='EMERGENCY')await f.service.dispatch(f.token,{command:'emergencyStop'});
    if(fault==='MODEL_CHANGE')await f.service.dispatch(f.token,{command:'configureAi',settings:{model:'deepseek-other',persona:'',business:'',rules:''},key:''});
    release();await expect(work).rejects.toThrow();expect(f.store.db.prepare('SELECT count(*) n FROM ai_suggestions').get()).toEqual({n:0});
    expect(f.calls).toHaveLength(1);expect(f.store.db.prepare("SELECT used FROM budgets WHERE kind='MODEL'").get()).toEqual({used:1});
    expect(f.store.db.prepare("SELECT count(*) n FROM grant_reservations WHERE kind='MODEL'").get()).toEqual({n:1});
  }finally{release();await f.close();}
});

test('a late saved human revision stays unchanged and the paid candidate is explicitly stale',async()=>{
  const f=await setup();let release=()=>{};try{
    let enter=()=>{};const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});f.setGate(async()=>{enter();await gate;});
    const work=f.service.dispatch(f.token,{command:'generateSuggestion',eventId:f.id,draftVersion:0});await entered;
    f.service.authority.save(f.token,f.id,f.generation,0,'A newer exact human draft',null);release();expect(await work).toMatchObject({stale:true});
    expect(f.service.authority.draftFor(f.id)?.text).toBe('A newer exact human draft');
  }finally{release();await f.close();}
});

test('finite policy MODEL allowance serializes concurrent different events without consuming or requiring SEND',async()=>{
  const f=await setup({modelLimit:1,sendLimit:1});try{
    const second=pending(f.store,candidate({platformEventId:'second-strong'}));
    const results=await Promise.allSettled([f.id,second].map(eventId=>f.service.dispatch(f.token,{command:'generateSuggestion',eventId,draftVersion:0})));
    expect(results.filter(row=>row.status==='fulfilled')).toHaveLength(1);expect(f.calls).toHaveLength(1);
    expect(f.store.db.prepare("SELECT used FROM budgets WHERE kind='MODEL'").get()).toEqual({used:1});
    expect(f.store.db.prepare("SELECT count(*) n FROM grant_reservations WHERE kind='MODEL'").get()).toEqual({n:1});
    expect(f.store.db.prepare("SELECT used FROM budgets WHERE kind='SEND'").get()).toEqual({used:0});
  }finally{await f.close();}
});

test('an explicit MODEL grant outside its channel does not fall back to a wider reply policy',async()=>{
  const f=await setup();try{
    f.auto.grant('MODEL',{ownId:'own-1',channels:['COMMENT_NOTIFICATION'],model:'deepseek-flash',modelLimit:null,expiresAt:null});
    await expect(f.service.dispatch(f.token,{command:'generateSuggestion',eventId:f.id,draftVersion:0})).rejects.toThrow('MODEL_OUTSIDE_GRANT');expect(f.calls).toEqual([]);
  }finally{await f.close();}
});

test('matching MODEL grants keep their existing authorization even if the separate reply policy excludes this text',async()=>{
  const f=await setup({excludesAny:['hello']});try{
    const model=f.auto.grant('MODEL',{ownId:'own-1',channels:['DIRECT_MESSAGE'],model:'deepseek-flash',modelLimit:null,expiresAt:null});
    expect(await f.service.dispatch(f.token,{command:'generateSuggestion',eventId:f.id,draftVersion:0})).toMatchObject({stale:false});
    expect(f.calls).toHaveLength(1);expect(f.calls[0]!.body).not.toContain(f.grant.scope.instructions);
    expect(f.store.db.prepare('SELECT kind,count(*) n FROM grant_reservations WHERE grant_version=? GROUP BY kind').all(model.version)).toEqual([{kind:'MODEL',n:1}]);
  }finally{await f.close();}
});

test.each(['MEDIA','KEY','ACCOUNT','EMERGENCY','READ_ONLY','SUBMITTED'] as const)('exact first-reply eligibility explains %s and rejects before provider/budget',async fault=>{
  const f=await setup();try{
    let eventId=f.id,token=f.token,reason:string;
    if(fault==='MEDIA'){
      pending(f.store,candidate({platformEventId:'weak-current',text:'[图片或表情消息，需人工查看]',contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED'}));
      eventId=f.store.events().find(row=>row.payload.platformEventId==='weak-current')!.id;reason='DM_CONTENT_UNVERIFIED';
    }else if(fault==='KEY'){await f.service.dispatch(f.token,{command:'clearModelKey'});reason='MODEL_KEY_REQUIRED';}
    else if(fault==='ACCOUNT'){f.store.db.prepare("UPDATE accounts SET own_id='different-own'").run();reason='ACCOUNT_NOT_VERIFIED';}
    else if(fault==='EMERGENCY'){await f.service.dispatch(f.token,{command:'emergencyStop'});reason='MODEL_PAUSED';}
    else if(fault==='READ_ONLY'){token=f.service.authority.issueSession(['READ']);reason='OPERATOR_PERMISSION_DENIED';}
    else{f.store.db.prepare('INSERT INTO manual_send_commands VALUES(?,?,?,?,?,?,?,?,?)')
      .run('synthetic-submitted',eventId,'fixture',digest('fixture'),'{}','PREPARING',null,null,f.clock);reason='SUGGESTION_ALREADY_SUBMITTED';}
    expect(await f.service.dispatch(token,{command:'getThread',eventId})).toMatchObject({suggestionEligibility:{eligible:false,reason}});
    await expect(f.service.dispatch(token,{command:'generateSuggestion',eventId,draftVersion:0})).rejects.toThrow(reason);
    expect(f.calls).toEqual([]);expect(f.store.db.prepare('SELECT count(*) n FROM model_calls').get()).toEqual({n:0});
    expect(f.store.db.prepare('SELECT count(*) n FROM grant_reservations').get()).toEqual({n:0});
  }finally{await f.close();}
});

test.each([false,true])('nested exact work scope keeps replyToNestedComments=%s for manual candidates',async enabled=>{
  const f=await setup({replyToNestedComments:enabled});try{
    pending(f.store,candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',platformEventId:'1101',videoId:'work-1',commentId:'1101',conversationId:null}));
    const child=pending(f.store,candidate({channel:'COMMENT_NOTIFICATION',kind:'REPLY',platformEventId:'1102',videoId:'work-1',commentId:'1102',
      rootCommentId:'1101',replyToCommentId:'1102',conversationId:null,occurredAt:'2026-11-04T01:00:01Z'}));
    if(enabled){expect(await f.service.dispatch(f.token,{command:'generateSuggestion',eventId:child,draftVersion:0})).toMatchObject({stale:false});expect(f.calls).toHaveLength(1);}
    else{await expect(f.service.dispatch(f.token,{command:'generateSuggestion',eventId:child,draftVersion:0})).rejects.toThrow('MODEL_OUTSIDE_GRANT');expect(f.calls).toEqual([]);}
  }finally{await f.close();}
});

test('only included work of the authorized own account can use future-own-work manual scope',async()=>{
  const f=await setup({futureOwnWorks:true,workIds:[]});try{
    f.advance(1000);f.auto.registerWork({id:'new-work',ownId:'own-1',url:'https://www.douyin.com/video/new-work',publishedAt:f.clock+1,precisionMs:1});
    const eventId=pending(f.store,candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',platformEventId:'1201',videoId:'new-work',commentId:'1201',conversationId:null}));
    expect(await f.service.dispatch(f.token,{command:'generateSuggestion',eventId,draftVersion:0})).toMatchObject({stale:false});
    f.store.db.prepare("UPDATE discovered_works SET state='REVIEW' WHERE id='new-work'").run();
    await expect(f.service.dispatch(f.token,{command:'generateSuggestion',eventId,draftVersion:0})).rejects.toThrow('MODEL_OUTSIDE_GRANT');
    expect(f.calls).toHaveLength(1);
  }finally{await f.close();}
});

test('a current strong text suggestion omits older weak media rather than treating its placeholder as context or blocking the conversation',async()=>{
  const f=await setup();try{
    const old=candidate({platformEventId:'older-weak-media',text:'[含媒体的消息，需人工查看]',contentType:'MIXED',observationIssue:'DM_CONTENT_UNVERIFIED',occurredAt:'2026-11-04T00:59:00Z'});
    f.store.observe('DIRECT_MESSAGE','conversation-1',[old],'own-1','fixture');expect(f.store.history(f.store.event(f.id).payload)).toContainEqual(old);
    expect(await f.service.dispatch(f.token,{command:'generateSuggestion',eventId:f.id,draftVersion:0})).toMatchObject({stale:false});
    expect(f.calls).toHaveLength(1);expect(f.calls[0]!.body).not.toContain(old.text);expect(f.calls[0]!.body).not.toContain(old.platformEventId!);
  }finally{await f.close();}
});

test.each(['COLLISION','TARGET_PAUSED'] as const)('a current exact %s counterevidence prevents a suggestion before reservation',async fault=>{
  const f=await setup();try{
    const event=f.store.event(f.id).payload;
    if(fault==='COLLISION')f.store.observe('DIRECT_MESSAGE','conversation-1',[{...event,text:'Contradictory exact native message'}],'own-1','fixture');
    else f.store.pause(targetKey(event),true);
    const reason=fault==='COLLISION'?'TARGET_NEEDS_REVIEW':'TARGET_PAUSED';
    expect(await f.service.dispatch(f.token,{command:'getThread',eventId:f.id})).toMatchObject({suggestionEligibility:{eligible:false,reason}});
    await expect(f.service.dispatch(f.token,{command:'generateSuggestion',eventId:f.id,draftVersion:0})).rejects.toThrow(reason);
    expect(f.calls).toEqual([]);expect(f.store.db.prepare('SELECT count(*) n FROM model_calls').get()).toEqual({n:0});
    expect(f.store.db.prepare('SELECT count(*) n FROM grant_reservations').get()).toEqual({n:0});
  }finally{await f.close();}
});

test('an older collided native message is excluded from actual model context without freezing later independent text',async()=>{
  const f=await setup();try{
    const old=candidate({platformEventId:'old-collided',text:'Old collided message must not reach the prompt',occurredAt:'2026-11-04T00:59:00Z'});
    f.store.observe('DIRECT_MESSAGE','conversation-1',[old],'own-1','fixture');
    f.store.observe('DIRECT_MESSAGE','conversation-1',[{...old,text:'Conflicting alternate old native body'}],'own-1','fixture');
    expect(f.store.db.prepare('SELECT count(*) n FROM source_collisions WHERE event_id=?').get(f.id)).toEqual({n:0});
    expect(await f.service.dispatch(f.token,{command:'generateSuggestion',eventId:f.id,draftVersion:0})).toMatchObject({stale:false});
    expect(f.calls).toHaveLength(1);expect(f.calls[0]!.body).not.toContain(old.text);expect(f.calls[0]!.body).not.toContain('Conflicting alternate');
  }finally{await f.close();}
});

test.each(['REPLACE','EXPIRE'] as const)('a late %s of the exact policy cannot publish its old paid candidate',async fault=>{
  const f=await setup(fault==='EXPIRE'?{expiresAt:Date.UTC(2026,10,10,12)+100}:{});let release=()=>{};try{
    let enter=()=>{};const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});f.setGate(async()=>{enter();await gate;});
    const work=f.service.dispatch(f.token,{command:'generateSuggestion',eventId:f.id,draftVersion:0});await entered;
    if(fault==='REPLACE')await f.service.dispatch(f.token,{command:'setReplyPolicy',policy:policy({instructions:'A newly approved separate policy'}),confirmed:true});
    else f.advance(101);
    release();await expect(work).rejects.toThrow();expect(f.store.db.prepare('SELECT count(*) n FROM ai_suggestions').get()).toEqual({n:0});
    expect(f.calls).toHaveLength(1);expect(f.store.db.prepare("SELECT used FROM budgets WHERE kind='MODEL'").get()).toEqual({used:1});
    expect(f.store.db.prepare("SELECT count(*) n FROM grant_reservations WHERE grant_version=? AND kind='MODEL'").get(f.grant.version)).toEqual({n:1});
  }finally{release();await f.close();}
});

test('a provider failure retains one paid attempt and records a failed model stage',async()=>{
  const f=await setup();try{
    const failures=()=>runtimePerformance.snapshot().find(row=>row.stage==='MODEL'&&row.channel==='DIRECT_MESSAGE')?.failures??0,before=failures();
    f.setGate(async()=>{throw Error('synthetic transport failure');});
    await expect(f.service.dispatch(f.token,{command:'generateSuggestion',eventId:f.id,draftVersion:0})).rejects.toThrow('MODEL_FAILED_NO_RETRY');
    expect(failures()).toBe(before+1);expect(f.calls).toHaveLength(1);expect(f.store.db.prepare('SELECT count(*) n FROM ai_suggestions').get()).toEqual({n:0});
    expect(f.store.db.prepare("SELECT used FROM budgets WHERE kind='MODEL'").get()).toEqual({used:1});
  }finally{await f.close();}
});
