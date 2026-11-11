import {expect,test} from 'vitest';
import {randomUUID} from 'node:crypto';
import {WorkbenchAuthority} from '../../src/app/authority.js';
import {setupAssistant as setup} from '../mcp-helpers.js';
import {candidate,pending} from '../helpers.js';
test('actual shared recordIntent consumes the final global and assistant slot exactly once',async()=>{
  const f=await setup({sendLimit:1});try{
    f.store.db.prepare("UPDATE budget_limits SET maximum=1 WHERE kind='SEND'").run();const commandId=randomUUID();
    await f.service.dispatch(f.token,{command:'sendHumanReply',commandId,input:f.input});await f.service.drain();
    expect(f.service.authority.command(commandId)).toMatchObject({status:'CONFIRMED'});expect(f.browser.clicks).toBe(1);
    expect(f.service.authority.draftFor(f.eventId)).toMatchObject({origin:'MCP_ASSISTED'});
    expect(f.service.authority.assistant.usage(f.grant.version)).toEqual({MODEL:0,SEND:1});expect(f.store.budget('SEND')).toMatchObject({used:1,maximum:1});
    await f.service.dispatch(f.token,{command:'sendHumanReply',commandId,input:f.input});expect(f.browser.clicks).toBe(1);
    await expect(f.service.dispatch(f.token,{command:'sendHumanReply',commandId,input:{...f.input,text:'Different text'}})).rejects.toThrow('COMMAND_PARAMETERS_CONFLICT');
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:1});
  }finally{await f.close();}
});

test.each(['REVOKE','EXHAUST','EMERGENCY'] as const)('%s immediately before intent leaves no click, intent or assistant spend',async change=>{
  const f=await setup();try{
    let changed=false;f.browser.beforeCommit=()=>{if(changed)return;changed=true;
      if(change==='REVOKE')f.service.authority.assistant.revoke();
      if(change==='EXHAUST')f.store.db.prepare("UPDATE budget_limits SET maximum=0 WHERE kind='SEND'").run();
      if(change==='EMERGENCY')f.auto.stop(true);
    };
    const commandId=randomUUID();await f.service.dispatch(f.token,{command:'sendHumanReply',commandId,input:f.input});await f.service.drain();
    expect(f.service.authority.command(commandId)).toMatchObject({status:'FAILED_BEFORE_CLICK',intent_id:null});expect(f.browser.clicks).toBe(0);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
    expect(f.service.authority.assistant.usage(f.grant.version).SEND).toBe(0);expect(f.store.budget('SEND').used).toBe(0);
  }finally{await f.close();}
});

test('revocation after durable intent permits required readback without a second send or refunded spend',async()=>{
  const f=await setup({sendLimit:1});try{
    f.browser.afterClick=()=>f.service.authority.assistant.revoke();const commandId=randomUUID();
    await f.service.dispatch(f.token,{command:'sendHumanReply',commandId,input:f.input});await f.service.drain();
    expect(f.service.authority.command(commandId)).toMatchObject({status:'CONFIRMED'});expect(f.browser.clicks).toBe(1);
    expect(f.store.budget('SEND').used).toBe(1);expect(f.service.authority.assistant.usage(f.grant.version).SEND).toBe(1);
    const before=f.store.db.prepare('SELECT * FROM send_intents').all();new WorkbenchAuthority(f.store).recover();
    expect(f.store.db.prepare('SELECT * FROM send_intents').all()).toEqual(before);expect(f.browser.clicks).toBe(1);
  }finally{await f.close();}
});

test('unknown after submit remains unknown on recovery and another operation cannot repeat it',async()=>{
  const f=await setup();try{
    f.browser.unknown=true;const commandId=randomUUID();await f.service.dispatch(f.token,{command:'sendHumanReply',commandId,input:f.input});await f.service.drain();
    expect(f.service.authority.command(commandId)).toMatchObject({status:'UNCERTAIN'});expect(f.browser.clicks).toBe(1);
    await expect(f.service.dispatch(f.token,{command:'sendHumanReply',commandId:randomUUID(),input:{...f.input,expectedVersion:1}})).rejects.toThrow();
    const intents=f.store.db.prepare('SELECT * FROM send_intents').all(),receipts=f.store.db.prepare('SELECT * FROM delivery_receipts').all();
    new WorkbenchAuthority(f.store).recover();
    expect(f.store.db.prepare('SELECT * FROM send_intents').all()).toEqual(intents);
    expect(f.store.db.prepare('SELECT * FROM delivery_receipts').all()).toEqual(receipts);expect(f.browser.clicks).toBe(1);
  }finally{await f.close();}
});

test('assistant sending a pre-existing identical human draft creates its own provenance revision',async()=>{
  const f=await setup();try{
    f.service.authority.release(f.token,f.eventId,f.input.generation);
    const human=f.service.authority.claim(f.gui,f.eventId,f.service.authority.ownership(f.store.event(f.eventId)).generation);
    f.service.authority.save(f.gui,f.eventId,human.generation,0,f.input.text);f.service.authority.release(f.gui,f.eventId,human.generation);
    const own=f.service.authority.claim(f.token,f.eventId,f.service.authority.ownership(f.store.event(f.eventId)).generation),commandId=randomUUID();
    await f.service.dispatch(f.token,{command:'sendHumanReply',commandId,input:{...f.input,generation:own.generation,expectedVersion:1}});await f.service.drain();
    expect(f.service.authority.draftFor(f.eventId)).toMatchObject({origin:'MCP_ASSISTED',version:2});
    expect(f.store.db.prepare('SELECT version,origin FROM draft_revisions ORDER BY version').all()).toEqual([{version:1,origin:'HUMAN_TYPED'},{version:2,origin:'MCP_ASSISTED'}]);
  }finally{await f.close();}
});

test('a pure media event cannot acquire assistant sending or consume a human-media exception',async()=>{
  const f=await setup({media:true});try{
    await expect(f.service.dispatch(f.token,{command:'sendHumanReply',commandId:randomUUID(),input:f.input})).rejects.toThrow();
    expect(f.browser.clicks).toBe(0);expect(f.service.authority.draftFor(f.eventId)).toBeNull();
    expect(f.store.db.prepare('SELECT count(*) n FROM manual_send_commands').get()).toEqual({n:0});expect(f.store.budget('SEND').used).toBe(0);
  }finally{await f.close();}
});

test('paid suggestions reserve existing model grant and assistant grant with one global charge',async()=>{
  const f=await setup({modelLimit:1});try{
    const model=f.auto.grant('MODEL',{ownId:'own-1',channels:['DIRECT_MESSAGE'],model:'deepseek-flash',modelLimit:1,expiresAt:null});
    await f.service.dispatch(f.gui,{command:'configureAi',settings:{model:'deepseek-flash',persona:'',business:'',rules:''},key:'synthetic-only'});
    f.store.db.prepare("UPDATE budget_limits SET maximum=1 WHERE kind='MODEL'").run();
    expect(await f.service.dispatch(f.token,{command:'generateSuggestion',eventId:f.eventId,draftVersion:0})).toMatchObject({text:'Synthetic assistant suggestion'});
    expect(f.calls()).toBe(1);expect(f.store.budget('MODEL').used).toBe(1);
    expect(f.service.authority.assistant.usage(f.grant.version).MODEL).toBe(1);
    expect(f.store.db.prepare("SELECT count(*) n FROM grant_reservations WHERE grant_version=? AND kind='MODEL'").get(model.version)).toEqual({n:1});
    await expect(f.service.dispatch(f.token,{command:'generateSuggestion',eventId:f.eventId,draftVersion:0})).rejects.toThrow();expect(f.calls()).toBe(1);
  }finally{await f.close();}
});

test('late assistant revocation rejects a paid result but retains model spend and the existing draft',async()=>{
  let release=()=>{},entered=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{entered=resolve;});
  const f=await setup({modelGate:async()=>{entered();await gate;}});try{
    f.auto.grant('MODEL',{ownId:'own-1',channels:['DIRECT_MESSAGE'],model:'deepseek-flash',modelLimit:2,expiresAt:null});
    await f.service.dispatch(f.gui,{command:'configureAi',settings:{model:'deepseek-flash',persona:'',business:'',rules:''},key:'synthetic-only'});
    f.service.authority.save(f.token,f.eventId,f.input.generation,0,'Existing assistant draft');
    const request=f.service.dispatch(f.token,{command:'generateSuggestion',eventId:f.eventId,draftVersion:1});await waiting;
    f.service.authority.assistant.revoke();release();await expect(request).rejects.toThrow('ASSISTANT_PERMISSION_REQUIRED');
    expect(f.store.db.prepare('SELECT count(*) n FROM ai_suggestions').get()).toEqual({n:0});expect(f.store.budget('MODEL').used).toBe(1);
    expect(f.service.authority.assistant.usage(f.grant.version).MODEL).toBe(1);expect(f.service.authority.draftFor(f.eventId)?.text).toBe('Existing assistant draft');
  }finally{release();await f.close();}
});

test.each(['CONTEXT','DRAFT','OWNERSHIP','SELECTION'] as const)('late %s change rejects assistant model results before candidate persistence',async change=>{
  let release=()=>{},entered=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{entered=resolve;});
  const f=await setup({modelGate:async()=>{entered();await gate;}});try{
    f.auto.grant('MODEL',{ownId:'own-1',channels:['DIRECT_MESSAGE'],model:'deepseek-flash',modelLimit:2,expiresAt:null});
    await f.service.dispatch(f.gui,{command:'configureAi',settings:{model:'deepseek-flash',persona:'',business:'',rules:''},key:'synthetic-only'});
    const request=f.service.dispatch(f.token,{command:'generateSuggestion',eventId:f.eventId,draftVersion:0});await waiting;
    if(change==='CONTEXT')pending(f.store,candidate({platformEventId:'arrived-during-model',occurredAt:new Date().toISOString(),text:'New context'}));
    if(change==='DRAFT')f.service.authority.save(f.token,f.eventId,f.input.generation,0,'Later edited draft');
    if(change==='OWNERSHIP')f.service.authority.release(f.token,f.eventId,f.input.generation);
    if(change==='SELECTION')f.service.authority.select(f.token,null,randomUUID());
    release();await expect(request).rejects.toThrow(change==='CONTEXT'?'CONTEXT_VERSION_CONFLICT':change==='DRAFT'?'DRAFT_VERSION_CONFLICT':
      change==='SELECTION'?'TARGET_SELECTION_CHANGED':'LEASE_EXPIRED_OR_CHANGED');
    expect(f.store.db.prepare('SELECT count(*) n FROM ai_suggestions').get()).toEqual({n:0});expect(f.calls()).toBe(1);
    expect(f.store.budget('MODEL').used).toBe(1);expect(f.service.authority.assistant.usage(f.grant.version).MODEL).toBe(1);
  }finally{release();await f.close();}
});
