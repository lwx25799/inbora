import {expect,test,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {AssistantFacade} from '../../src/mcp/assistant-facade.js';
import {operationSchema,replySchema,statusSchema,threadSchema,diagnosticsSchema} from '../../src/mcp/tool-contracts.js';
import {ChatMessageStore} from '../../src/storage/chat-messages.js';
import {setupAssistant} from '../mcp-helpers.js';
import {candidate,pending} from '../helpers.js';
import {targetKey} from '../../src/core/contracts.js';

async function fixture(){
  const f=await setupAssistant();f.service.authority.release(f.token,f.eventId,f.input.generation);
  const facade=new AssistantFacade(f.service),session=randomUUID();
  const call=(tool:string,args:unknown={})=>facade.dispatch(session,tool,args);
  const run=async(tool:string,args:Record<string,unknown>={},operationId=randomUUID())=>{
    await call(tool,{operationId,...args});await facade.drain();
    return operationSchema.parse(await call('inbora_get_operation',{operationId}));
  };
  const open=async()=>{
    const result=replySchema.parse((await run('inbora_open_reply',{eventId:f.eventId})).result);
    const {kind:_kind,draft:_draft,...binding}=result;return binding;
  };
  return {...f,facade,session,call,run,open,async close(){await facade.close();await f.close();}};
}

test('first authenticated assistant connection enables the existing account range and inherits global allowance',async()=>{
  const f=await fixture();try{
    // Remove only the fixture's preinstalled assistant grant to exercise a genuinely first connection.
    f.store.db.transaction(()=>{
      f.store.db.prepare('DELETE FROM assistant_sessions').run();
      f.store.db.prepare("DELETE FROM automation_grants WHERE kind='LOCAL_ASSISTANT'").run();
      f.store.db.prepare("DELETE FROM audit_events WHERE event_type IN ('LOCAL_ASSISTANT_GRANTED','LOCAL_ASSISTANT_REVOKED')").run();
    }).immediate();
    f.store.db.prepare("UPDATE budget_limits SET maximum=NULL WHERE kind='MODEL'").run();
    f.store.db.prepare("UPDATE budget_limits SET maximum=7 WHERE kind='SEND'").run();
    const budgets=f.store.budgets();
    await expect(f.call('inbora_arbitrary_command')).rejects.toThrow('ASSISTANT_TOOL_NOT_ALLOWED');
    await expect(f.call('inbora_get_status',{arbitrary:true})).rejects.toThrow();
    expect(f.service.authority.assistant.active()).toBeNull();
    const status=statusSchema.parse(await f.call('inbora_get_status'));
    expect(status).toMatchObject({assistant:{enabled:true,expiresAt:null,
      permissions:{read:true,editControl:true,send:true},remaining:{MODEL:null,SEND:7}}});
    const grant=f.service.authority.assistant.active()!;
    expect(grant.scope.channels.sort()).toEqual(['COMMENT_NOTIFICATION','DIRECT_MESSAGE']);
    expect(grant.scope.ownId).toBe('own-1');
    expect(threadSchema.parse(await f.call('inbora_get_thread',{eventId:f.eventId})).event.id).toBe(f.eventId);
    const revision=grant.version;
    await f.call('inbora_get_status');
    expect(f.service.authority.assistant.active()?.version).toBe(revision);
    expect(f.store.budgets()).toEqual(budgets);
    await f.service.dispatch(f.gui,{command:'setLocalAssistantGrant',enabled:false,confirmed:true});
    expect(statusSchema.parse(await f.call('inbora_get_status')).assistant.enabled).toBe(false);
    await expect(f.call('inbora_get_thread',{eventId:f.eventId})).rejects.toThrow('ASSISTANT_PERMISSION_REQUIRED');
    await f.call('inbora_get_status');
    expect(f.service.authority.assistant.active()).toBeNull();
    expect(f.store.db.prepare("SELECT count(*) n FROM automation_grants WHERE kind='LOCAL_ASSISTANT'").get()).toEqual({n:1});
    expect(f.store.budgets()).toEqual(budgets);
    expect(f.browser.clicks).toBe(0);
  }finally{await f.close();}
});

test('only the trusted GUI boolean entrypoint can change connection state; old scope inputs cannot bypass stop ordering',async()=>{
  const f=await fixture();try{
    const before=f.service.authority.assistant.state();
    for(const fields of [{scope:null},{enabled:true,scope:null},{}])
      await expect(f.service.dispatch(f.gui,{command:'setLocalAssistantGrant',confirmed:true,...fields})).rejects.toThrow();
    await expect(f.service.dispatch(f.token,{command:'setLocalAssistantGrant',enabled:true,confirmed:true})).rejects.toThrow('ASSISTANT_CANNOT_GRANT');
    expect(f.service.authority.assistant.state()).toEqual(before);
    await f.service.dispatch(f.gui,{command:'setLocalAssistantGrant',enabled:false,confirmed:true});
    expect(f.service.authority.assistant.state().connectionEnabled).toBe(false);
    await f.call('inbora_get_status');expect(f.service.authority.assistant.active()).toBeNull();
  }finally{await f.close();}
});

test('public status and diagnostics are body-free, reads and mutations cannot self-authorize',async()=>{
  const f=await fixture();try{
    await f.service.dispatch(f.gui,{command:'setLocalAssistantGrant',enabled:false,confirmed:true});
    const status=await f.call('inbora_get_status'),diagnostics=await f.call('inbora_get_diagnostics');
    expect(JSON.stringify([status,diagnostics])).not.toContain('hello');
    expect(status).toMatchObject({assistant:{enabled:false,permissions:{read:false,editControl:false,send:false}}});
    await expect(f.call('inbora_list_inbox')).rejects.toThrow('ASSISTANT_PERMISSION_REQUIRED');
    await expect(f.call('inbora_set_automatic_reply',{operationId:randomUUID(),enabled:true})).rejects.toThrow('ASSISTANT_PERMISSION_REQUIRED');
    await expect(f.call('setLocalAssistantGrant',{scope:{}})).rejects.toThrow('ASSISTANT_TOOL_NOT_ALLOWED');
    expect(f.store.budgets().every(row=>row.used===0)).toBe(true);
  }finally{await f.close();}
});

test('public diagnostics explicitly preserve the bounded resource summary without new permissions or sampler controls',async()=>{
  const f=await fixture(),dispatch=f.service.dispatch.bind(f.service);
  const resources={state:'STALE',reason:'SAMPLE_STALE',intervalMs:60_000,sampledAt:1000,segmentStartedAt:500,
    latest:{workingSetBytes:2048,privateBytes:1024,browserProcesses:6,pageCount:2,elapsedMs:15},hour:null,run:null};
  const spy=vi.spyOn(f.service,'dispatch').mockImplementation(async(token,body)=>{
    const result=await dispatch(token,body);
    return (body as {command:string}).command==='getDiagnostics'?{...result as object,browserResources:resources}:result;
  });
  try{
    await f.service.dispatch(f.gui,{command:'setLocalAssistantGrant',enabled:false,confirmed:true});
    const result=diagnosticsSchema.parse(await f.call('inbora_get_diagnostics'));
    expect(result.browserResources).toEqual(resources);
    expect(JSON.stringify(result)).not.toMatch(/"(?:pid|rootPid|commandLine|url)":|"samples":\[/iu);
    await expect(f.call('inbora_get_diagnostics',{sampleNow:true})).rejects.toThrow();
    expect(f.browser.clicks).toBe(0);expect(f.store.budgets().every(row=>row.used===0)).toBe(true);
  }finally{spy.mockRestore();await f.close();}
});

test('GUI draft lease wins, stale assistant context/draft refused, stable operation IDs never overwrite twice',async()=>{
  const f=await fixture();try{
    const selectionId=randomUUID();
    const gui=await f.service.dispatch(f.gui,{command:'openHumanDialog',eventId:f.eventId,selectionId}) as {ownership:{generation:number}};
    await f.service.dispatch(f.gui,{command:'saveDraft',eventId:f.eventId,generation:gui.ownership.generation,expectedVersion:0,text:'Human text',suggestionId:null});
    expect(await f.run('inbora_open_reply',{eventId:f.eventId})).toMatchObject({state:'FAILED',error:'OTHER_OPERATOR_OWNS'});
    expect(f.service.authority.draftFor(f.eventId)?.text).toBe('Human text');
    await f.service.dispatch(f.gui,{command:'closeHumanDialog',eventId:f.eventId,generation:gui.ownership.generation});
    const binding=await f.open(),id=randomUUID(),params={...binding,text:'Assistant text'};
    expect(await f.run('inbora_save_draft',params,id)).toMatchObject({state:'SUCCEEDED',result:{draft:{version:2,source:'MCP_ASSISTED'}}});
    expect(await f.run('inbora_save_draft',params,id)).toMatchObject({state:'SUCCEEDED'});
    await expect(f.run('inbora_save_draft',{...params,text:'conflict'},id)).rejects.toThrow('OPERATION_PARAMETERS_CONFLICT');
    expect(await f.run('inbora_save_draft',{...params,text:'stale draft'})).toMatchObject({state:'FAILED',error:'DRAFT_VERSION_CONFLICT'});
    pending(f.store,{...f.payload,platformEventId:'second-message',occurredAt:new Date(Date.now()-5).toISOString()});
    expect(await f.run('inbora_send_reply',{...params,expectedVersion:2})).toMatchObject({state:'FAILED',error:'CONTEXT_VERSION_CONFLICT'});
    expect(f.browser.clicks).toBe(0);expect(f.service.authority.draftFor(f.eventId)?.version).toBe(2);
  }finally{await f.close();}
});

test('thread and inbox enforce each member scope, bounded pagination and outgoing historical filtering',async()=>{
  const f=await fixture();try{
    const origin=f.grant.scope.collection.startedAt;
    pending(f.store,candidate({platformEventId:'old-secret',text:'OLD PRIVATE',occurredAt:new Date(origin-1000).toISOString()}));
    new ChatMessageStore(f.store).observe([candidate({platformEventId:'old-own',direction:'OUTGOING',actorId:'own-1',
      text:'OLD OWN PRIVATE',occurredAt:new Date(origin-1000).toISOString()})],'own-1',origin);
    for(let i=0;i<36;i++)pending(f.store,candidate({platformEventId:`page-${i}`,text:`page text ${i}`,occurredAt:new Date(origin+70000+i).toISOString()}));
    const first=threadSchema.parse(await f.call('inbora_get_thread',{eventId:f.eventId}));
    expect(first.timeline.items).toHaveLength(30);expect(first.timeline.hasMore).toBe(true);
    const second=threadSchema.parse(await f.call('inbora_get_thread',{eventId:f.eventId,timelineBefore:first.timeline.before}));
    expect(second.timeline.items.length).toBeLessThanOrEqual(30);
    expect(JSON.stringify([first,second])).not.toContain('OLD PRIVATE');expect(JSON.stringify(second)).not.toContain('OLD OWN PRIVATE');
    await expect(f.call('inbora_list_inbox',{page:-1})).rejects.toThrow();
    const rows=await f.call('inbora_list_inbox',{page:0}) as {items:unknown[];pageSize:number};
    expect(rows.pageSize).toBe(20);expect(rows.items.length).toBeLessThanOrEqual(20);
  }finally{await f.close();}
});

test('partial assistant sync stays in its channel and global automatic policy cannot exceed that scope',async()=>{
  const f=await fixture();try{
    const channels:string[]=[];f.browser.collect=async(_store,source)=>{channels.push(source);};
    const sync=await f.run('inbora_sync_inbox');await f.service.drain();
    expect(sync.state).toBe('SUCCEEDED');expect(channels).toEqual(['dm']);
    f.auto.grant('AUTO_REPLY',{ownId:'own-1',channels:['DIRECT_MESSAGE','COMMENT_NOTIFICATION'],model:'deepseek-flash',modelLimit:2,
      expiresAt:null,workIds:['fixture-work'],futureOwnWorks:true,conversationIds:[],entireInbox:true,containsAny:[],excludesAny:[],
      instructions:'Synthetic rules',startHour:0,endHour:24,sendLimit:2});
    expect(await f.run('inbora_set_automatic_reply',{enabled:true})).toMatchObject({state:'FAILED',error:'ASSISTANT_POLICY_OUTSIDE_SCOPE'});
    expect(f.service.authority.mode()).toBe('MANUAL');
  }finally{await f.close();}
});

test('post-click exception has a queryable unknown result, restart and repeated operation do not replay',async()=>{
  const f=await fixture();try{
    const original=f.browser.adapter.bind(f.browser);
    f.browser.adapter=async event=>{const handle=await original(event);handle.adapter.readback=async()=>{throw new Error('private timeout body');};return handle;};
    const binding=await f.open(),id=randomUUID(),args={...binding,text:'Synthetic one shot'};
    await f.run('inbora_send_reply',args,id);await f.service.drain();
    expect(operationSchema.parse(await f.call('inbora_get_operation',{operationId:id}))).toMatchObject({state:'UNKNOWN',result:{status:'UNCERTAIN'}});
    expect(f.browser.clicks).toBe(1);const intents=f.store.db.prepare('SELECT * FROM send_intents').all(),receipts=f.store.db.prepare('SELECT * FROM delivery_receipts').all();
    await f.facade.close();f.service.authority.recover();const replacement=new AssistantFacade(f.service);
    try{
      const queried=await replacement.dispatch(randomUUID(),'inbora_get_operation',{operationId:id});
      expect(queried).toMatchObject({state:'UNKNOWN'});expect(JSON.stringify(queried)).not.toContain('private timeout body');
      await replacement.dispatch(randomUUID(),'inbora_send_reply',{operationId:id,...args});
      expect(f.browser.clicks).toBe(1);expect(f.store.db.prepare('SELECT * FROM send_intents').all()).toEqual(intents);
      expect(f.store.db.prepare('SELECT * FROM delivery_receipts').all()).toEqual(receipts);
    }finally{await replacement.close();}
  }finally{await f.close();}
});

test('assistant permissions are rechecked after async thread read before exposing private content',async()=>{
  const f=await fixture();try{
    let entered=()=>{},release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{entered=resolve;});
    f.browser.workUrl=async()=>{entered();await gate;return null;};
    const task=f.call('inbora_get_thread',{eventId:f.eventId});await waiting;
    f.service.authority.assistant.revoke();release();
    await expect(task).rejects.toThrow('ASSISTANT_PERMISSION_REQUIRED');
  }finally{await f.close();}
});

test('media inbox rows remain readable and report the existing human-only status without granting assistant sending',async()=>{
  const f=await fixture();try{
    const media={...f.payload,conversationId:'media-only-thread',platformEventId:'900000000000000002',text:'[synthetic image]',
      occurredAt:new Date(Date.now()-10).toISOString(),contentType:'IMAGE' as const,observationIssue:'DM_CONTENT_UNVERIFIED' as const};
    pending(f.store,media);
    const eventId=f.store.events().find(event=>event.payload.platformEventId===media.platformEventId)!.id;
    f.store.db.prepare('INSERT INTO collection_targets VALUES(?,?,?,?,?,?,?)').run(targetKey(media),'own-1',media.actorId,
      'peer-sec','Fixture peer',media.conversationId,Date.now());
    f.store.db.prepare('INSERT INTO discovered_conversations VALUES(?,?,?,?,?,?,?,0)').run(media.conversationId,'own-1',media.actorId,
      'peer-sec','Fixture peer',Date.now(),Date.now());
    const inbox=await f.call('inbora_list_inbox',{status:'MANUAL_ONLY'}) as {items:{eventId:string;replyStatus:string}[]};
    expect(inbox.items).toEqual([expect.objectContaining({eventId,replyStatus:'MANUAL_ONLY'})]);
    const thread=threadSchema.parse(await f.call('inbora_get_thread',{eventId}));
    expect(thread.event).toMatchObject({id:eventId,quality:'UNVERIFIED',replyStatus:'MANUAL_ONLY'});
    await expect(f.call('inbora_open_reply',{operationId:randomUUID(),eventId})).rejects.toThrow('ASSISTANT_TEXT_REQUIRED');
    expect(f.browser.clicks).toBe(0);expect(f.store.budget('SEND').used).toBe(0);
  }finally{await f.close();}
});

test('assistant cannot enable an uncollected work policy but can always disable an existing broader policy',async()=>{
  const f=await fixture();try{
    const {collection:_collection,...scope}=f.grant.scope;
    f.service.authority.assistant.grant({...scope,channels:['COMMENT_NOTIFICATION']});
    f.auto.grant('AUTO_REPLY',{ownId:'own-1',channels:['COMMENT_NOTIFICATION'],model:'deepseek-flash',modelLimit:2,
      expiresAt:null,workIds:['uncollected-work'],futureOwnWorks:false,conversationIds:[],entireInbox:false,containsAny:[],excludesAny:[],
      instructions:'Synthetic rules',startHour:0,endHour:24,sendLimit:2});
    expect(await f.run('inbora_set_automatic_reply',{enabled:true})).toMatchObject({state:'FAILED',error:'ASSISTANT_POLICY_OUTSIDE_SCOPE'});
    expect(f.service.authority.mode()).toBe('MANUAL');
    f.auto.grant('AUTO_REPLY',{ownId:'own-1',channels:['DIRECT_MESSAGE'],model:'deepseek-flash',modelLimit:2,
      expiresAt:null,workIds:[],futureOwnWorks:false,conversationIds:[],entireInbox:true,containsAny:[],excludesAny:[],
      instructions:'Synthetic broader channel',startHour:0,endHour:24,sendLimit:2});
    await f.service.dispatch(f.gui,{command:'setMode',mode:'LIMITED_AUTO'});
    expect(await f.run('inbora_set_automatic_reply',{enabled:false})).toMatchObject({state:'SUCCEEDED',result:{enabled:false}});
    expect(f.service.authority.mode()).toBe('MANUAL');expect(f.browser.clicks).toBe(0);
  }finally{await f.close();}
});

test('public diagnostics sanitize private failure text and status omits private account and rule values',async()=>{
  const f=await fixture();try{
    const privateText='private body https://private.example/target?token=synthetic';
    f.store.db.prepare('UPDATE collection_progress SET last_error=?').run(privateText);
    const status=await f.call('inbora_get_status'),diagnostics=await f.call('inbora_get_diagnostics');
    const wire=JSON.stringify([status,diagnostics]);
    expect(wire).not.toContain(privateText);expect(wire).not.toContain('own-1');expect(wire).not.toContain('peer-1');
    expect(diagnostics).toMatchObject({collection:{channels:expect.arrayContaining([expect.objectContaining({lastError:'UNCLASSIFIED'})])},
      blockers:expect.arrayContaining([expect.objectContaining({code:'UNCLASSIFIED'})])});
  }finally{await f.close();}
});
