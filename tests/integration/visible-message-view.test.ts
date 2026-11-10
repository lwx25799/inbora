import {afterEach,expect,test,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {BrowserService} from '../../src/app/browser-service.js';
import {ClientService} from '../../src/app/service.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {ChatMessageStore} from '../../src/storage/chat-messages.js';
import {AccountActor} from '../../src/browser/account-actor.js';
import type {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {observedMapping} from '../fixtures/observed-site.js';
import {candidate,database,privateTemp} from '../helpers.js';
import {VerificationScheduler} from '../../src/app/verification-scheduler.js';
import {eventBinding} from '../../src/core/contracts.js';
import type {HumanReplyWorkflow} from '../../src/app/human-reply-workflow.js';

afterEach(()=>vi.restoreAllMocks());
async function setup(kind:'CURRENT'|'HISTORY'|'OWN'='CURRENT'){
  const root=privateTemp('visible-message-view-'),store=database();await migrateClient(store,join(root,'client.sqlite'));
  const windows:(number|undefined)[]=[],sequence:string[]=[],owners:{closed:boolean;dirty:boolean;actor:AccountActor;context:EventEmitter;
    dm:{bringToFront:()=>Promise<void>;evaluate:()=>Promise<boolean>;locator:()=>{evaluateAll:()=>Promise<boolean>}}}[]=[];
  const browser=new BrowserService(root,async(_profile,headless)=>{
    expect(owners.every(owner=>owner.closed)).toBe(true);sequence.push(headless?'headless':'headed');
    const context=new EventEmitter(),state={closed:false,dirty:false,actor:new AccountActor(),context,dm:{bringToFront:async()=>{sequence.push('front');},evaluate:async()=>windows.at(-1)===500,
      locator:()=>({evaluateAll:async()=>!state.dirty})}};owners.push(state);
    return {...state,notification:state.dm,version:()=> 'fixture',open:async()=>{},close:async()=>{sequence.push('close');state.closed=true;context.emit('close');}} as unknown as BrowserProfileOwner;
  });
  const mapping={...observedMapping('https://www.douyin.com'),environment:'douyin'};await writeFile(join(root,'observation-mapping.json'),JSON.stringify(mapping));
  const service=new ClientService(store,browser);await service.loadSettings();store.bindAccount('100');const data=new AutomationStore(store),origin=data.state().startedAt;
  data.configureCollection({ownId:'100',comments:false,inbox:true,commentIntervalMs:30000,dmIntervalMs:15000});
  const event=candidate({platformEventId:'80201',actorId:kind==='OWN'?'100':'200',direction:kind==='OWN'?'OUTGOING':'INCOMING',conversationId:'conv-a',
    occurredAt:new Date(kind==='CURRENT'?origin+1:origin-60000).toISOString()});
  store.observe('DIRECT_MESSAGE','conv-a',[],'100','fixture',new Date(origin).toISOString());
  if(kind==='OWN')new ChatMessageStore(store).observe([event],'100',origin);else store.observe('DIRECT_MESSAGE','conv-a',[event],'100','fixture',new Date(Date.now()+2).toISOString(),origin);
  const eventId=kind==='OWN'?(store.db.prepare('SELECT id FROM chat_messages').get() as {id:string}).id:store.events()[0]!.id;
  store.db.prepare('INSERT INTO discovered_conversations VALUES(?,?,?,?,?,?,?,0)').run('conv-a','100','200','peer-sec','Fixture peer',Date.now(),Date.now());
  store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='dm'").run(JSON.stringify({parked:[{peer:{conversationId:'conv-a'},phase:'MAX',
    anchor:{top:500,height:1000,ids:['80201']}}]}));
  vi.spyOn(ObservedReader.prototype,'conversations').mockResolvedValue({events:[],loaded:0,unsupported:0,evidenceId:'fixture'});
  const read=vi.spyOn(ObservedReader.prototype,'dmWindow').mockImplementation(async(_peer,top)=>{windows.push(top);return {events:top===500?[event]:[],
    loaded:top===500?1:0,unsupported:0,evidenceId:'fixture',dmViewport:{top:top??0,height:1000,viewport:100,minimum:0,maximum:900}};});
  const token=service.authority.issueSession();return{root,store,browser,service,data,origin,event,eventId,token,sequence,owners,windows,read,
    async close(){await service.close();store.close();}};
}

test.each(['CURRENT','HISTORY','OWN'] as const)('visible viewing locates exact stored %s identity without selecting or changing business state',async kind=>{
  const f=await setup(kind);try{
    await f.browser.open();const tables=['inbound_events','chat_messages','reply_drafts','send_intents','delivery_receipts','budgets','automation_state','cursors','collection_progress'];
    const inventory=()=>tables.map(table=>f.store.db.prepare('SELECT * FROM '+table).all()),before=inventory();
    expect(await f.service.dispatch(f.token,{command:'openTarget',eventId:f.eventId,visible:true})).toEqual({opened:true,located:true});
    expect(f.sequence).toEqual(['headless','close','headed','front']);expect(f.windows).toEqual([undefined,500]);expect(inventory()).toEqual(before);
    expect(f.browser.status()).toMatchObject({mode:'headed',state:'MANUAL_VISIBLE',loginRecovery:true});
    expect(()=>f.service.authority.requireSelection(f.token,f.eventId,randomUUID())).toThrow('TARGET_SELECTION_CHANGED');
    expect(await f.browser.completeLoginIfVerified('100')).toBe(false);
  }finally{await f.close();}
});

test('viewing uses exact native row identity even when media/body readiness omits the observation event',async()=>{
  const f=await setup('OWN');try{
    f.read.mockImplementation(async(_peer,top)=>{f.windows.push(top);return {events:[],loaded:1,unsupported:1,incomplete:'CONTENT_NOT_READY',evidenceId:'fixture',
      dmCoverage:[{id:'80201',occurredAt:f.event.occurredAt!,precisionMs:1,captured:false}],dmViewport:{top:top??0,height:1000,viewport:100,minimum:0,maximum:900}};});
    expect(await f.service.dispatch(f.token,{command:'openTarget',eventId:f.eventId,visible:true})).toEqual({opened:true,located:true});
    expect(f.windows).toEqual([undefined,500]);expect(new ChatMessageStore(f.store).get(f.eventId)?.payload).toEqual(f.event);
  }finally{await f.close();}
});

test('an invalid stored scope never suspends schedules and a refused webpage draft restores only transient viewing suspension',async()=>{
  const f=await setup();try{
    await f.browser.open();const suspend: boolean[]=[];const schedules={suspend:(value:boolean)=>suspend.push(value),drain:async()=>{},cancel:()=>{},close:async()=>{}};
    Object.assign(f.service,{collector:schedules,verification:schedules});
    await expect(f.service.dispatch(f.token,{command:'openTarget',eventId:randomUUID(),visible:true})).rejects.toThrow('EVENT_NOT_FOUND');
    expect(suspend).toEqual([]);expect(f.browser.status()).toMatchObject({mode:'headless',loginRecovery:false});
    f.owners[0]!.dirty=true;
    await expect(f.service.dispatch(f.token,{command:'openTarget',eventId:f.eventId,visible:true})).rejects.toThrow('BROWSER_HAS_HUMAN_INPUT');
    expect(suspend).toEqual([true,true,false,false]);expect(f.owners[0]!.closed).toBe(false);expect(f.sequence).toEqual(['headless']);
    expect(f.browser.status()).toMatchObject({mode:'headless',loginRecovery:false});
  }finally{Object.assign(f.service,{collector:undefined,verification:undefined});await f.close();}
});

test('visible mode waits until an already committed actor readback finishes before releasing its single profile owner',async()=>{
  const f=await setup();let release=()=>{};try{
    await f.browser.open();let enter=()=>{};const entered=new Promise<void>(r=>{enter=r;}),gate=new Promise<void>(r=>{release=r;});
    const receipt=f.browser.actor.run(async()=>{enter();await gate;f.sequence.push('receipt-done');});await entered;
    const pending=f.service.dispatch(f.token,{command:'openTarget',eventId:f.eventId,visible:true});
    await expect.poll(()=>f.browser.loginRecovery).toBe(true);expect(f.owners[0]!.closed).toBe(false);expect(f.sequence).toEqual(['headless']);
    release();await receipt;expect(await pending).toEqual({opened:true,located:true});
    expect(f.sequence).toEqual(['headless','receipt-done','close','headed','front']);
  }finally{release();await f.close();}
});

test('emergency stop during the actor handoff prevents closing, relaunching or locating and stays stopped',async()=>{
  const f=await setup();let release=()=>{};try{
    await f.browser.open();let enter=()=>{};const entered=new Promise<void>(r=>{enter=r;}),gate=new Promise<void>(r=>{release=r;});
    const receipt=f.browser.actor.run(async()=>{enter();await gate;});await entered;
    const pending=f.service.dispatch(f.token,{command:'openTarget',eventId:f.eventId,visible:true});await expect.poll(()=>f.browser.loginRecovery).toBe(true);
    await f.service.dispatch(f.token,{command:'emergencyStop'});release();await receipt;
    await expect(pending).rejects.toThrow('COLLECTION_CANCELLED');expect(f.sequence).toEqual(['headless']);expect(f.windows).toEqual([]);
    expect(f.owners[0]!.closed).toBe(false);expect(f.data.state().emergencyStopped).toBe(true);expect(f.browser.loginRecovery).toBe(false);
  }finally{release();await f.close();}
});

test('a superseded visible request cannot locate after a newer manual request has claimed the owner generation',async()=>{
  const f=await setup();let release=()=>{};try{
    await f.browser.open();let enter=()=>{};const entered=new Promise<void>(r=>{enter=r;}),gate=new Promise<void>(r=>{release=r;});
    const held=f.browser.actor.run(async()=>{enter();await gate;});await entered;
    const first=f.service.dispatch(f.token,{command:'openTarget',eventId:f.eventId,visible:true});
    const failed=expect(first).rejects.toThrow('MESSAGE_VIEW_CANCELLED');await expect.poll(()=>f.browser.loginRecovery).toBe(true);
    const second=f.service.dispatch(f.token,{command:'openTarget',eventId:f.eventId,visible:true});
    await expect.poll(()=>(f.browser as unknown as {loginGeneration:number}).loginGeneration).toBe(2);release();await held;await failed;
    expect(await second).toEqual({opened:true,located:true});expect(f.windows).toEqual([undefined,500]);expect(f.sequence.filter(item=>item==='headed')).toHaveLength(1);
  }finally{release();await f.close();}
});

test.each(['ACTOR','TIME','DUPLICATE','NOT_FOUND'] as const)('visible location never accepts a %s native result as the stored target',async fault=>{
  const f=await setup();try{
    f.read.mockImplementation(async(_peer,top)=>{f.windows.push(top);const event=fault==='ACTOR'?{...f.event,actorId:'201'}:
      fault==='TIME'?{...f.event,occurredAt:new Date(Date.now()-5000).toISOString()}:f.event;
      return {events:fault==='NOT_FOUND'?[]:fault==='DUPLICATE'?[event,event]:[event],loaded:1,unsupported:0,evidenceId:'fixture'};});
    const result=f.service.dispatch(f.token,{command:'openTarget',eventId:f.eventId,visible:true});
    if(fault==='NOT_FOUND')expect(await result).toEqual({opened:true,located:false});else await expect(result).rejects.toThrow('OBSERVATION_ROW_IDENTITY_CONFLICT');
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{await f.close();}
});

test('explicit viewing waits for the last active verification qualification without aborting or consuming another attempt',async()=>{
  const f=await setup();let release=()=>{};try{
    await f.browser.open();await f.service.dispatch(f.token,{command:'setMode',mode:'MANUAL'});
    const detail=await f.service.dispatch(f.token,{command:'openHumanDialog',eventId:f.eventId,selectionId:randomUUID()}) as {ownership:{generation:number}};
    const draft=f.service.authority.save(f.token,f.eventId,detail.ownership.generation,0,'fixture prior reply'),snapshot={accountId:'account_001',ownId:'100',targetKey:'dm:conv-a',
      eventBinding:eventBinding(f.event),contextDigest:'fixture',composerKey:'dm:conv-a',mappingDigest:'fixture'};
    f.store.approve(draft.id,snapshot,draft.version,draft.text);const intent=f.store.recordIntent(draft.id,snapshot,false,{check:()=>{},committed:()=>{}});
    f.store.receipt(intent,'UNCERTAIN','original unknown');
    let verificationSignal:AbortSignal|undefined;const gate=new Promise<void>(r=>{release=r;});
    const verification=new VerificationScheduler(f.data,async(_id,signal)=>{verificationSignal=signal;await gate;return{verified:true,evidenceId:'fixture verified'};});
    verification.enqueue(f.eventId);f.store.db.prepare("UPDATE verification_jobs SET attempts=1,next_at=0 WHERE intent_id=?").run(intent);
    Object.assign(f.service,{verification});const suspend=vi.spyOn(verification,'suspend'),active=verification.tick();await expect.poll(()=>!!verificationSignal).toBe(true);
    const view=f.service.dispatch(f.token,{command:'openTarget',eventId:f.eventId,visible:true});await expect.poll(()=>suspend.mock.calls.length).toBe(1);
    expect(verificationSignal!.aborted).toBe(false);expect(f.browser.status().loginRecovery).toBe(false);expect(f.sequence).toEqual(['headless']);
    await expect(f.service.dispatch(f.token,{command:'sendHumanReply',commandId:randomUUID(),input:{eventId:f.eventId,generation:detail.ownership.generation,
      expectedVersion:draft.version,text:'must wait for manual viewing',selectionId:randomUUID(),contextVersion:'a'.repeat(64),suggestionId:null}})).rejects.toThrow('LOGIN_RECOVERY_IN_PROGRESS');
    release();await active;expect(await view).toEqual({opened:true,located:true});
    expect(f.store.db.prepare('SELECT state,attempts FROM verification_jobs WHERE intent_id=?').get(intent)).toEqual({state:'VERIFIED',attempts:2});
    expect(f.store.db.prepare('SELECT count(*) n FROM verification_results WHERE intent_id=?').get(intent)).toEqual({n:1});
    expect(f.store.db.prepare('SELECT status FROM send_intents WHERE id=?').get(intent)).toEqual({status:'UNCERTAIN'});
  }finally{release();await f.close();}
});

test('a human preparation already awaiting inspection fails before intent when explicit viewing is pending',async()=>{
  const f=await setup();let release=()=>{};try{
    await f.service.dispatch(f.token,{command:'setMode',mode:'MANUAL'});const selectionId=randomUUID();
    const detail=await f.service.dispatch(f.token,{command:'openHumanDialog',eventId:f.eventId,selectionId}) as {ownership:{generation:number};contextVersion:string};
    const workflow=(f.service as unknown as {humanReplies:HumanReplyWorkflow}).humanReplies,id=randomUUID();
    const input={eventId:f.eventId,generation:detail.ownership.generation,expectedVersion:0,text:'preserved not-yet-submitted human sentence',selectionId,
      contextVersion:detail.contextVersion,suggestionId:null};workflow.queue(f.token,id,input);
    let enter=()=>{};const entered=new Promise<void>(r=>{enter=r;}),gate=new Promise<void>(r=>{release=r;});
    const snapshot={accountId:'account_001',ownId:'100',targetKey:'dm:conv-a',eventBinding:eventBinding(f.event),contextDigest:'fixture',composerKey:'dm:conv-a',mappingDigest:'fixture'};
    vi.spyOn(f.browser,'adapter').mockResolvedValue({dispose:()=>{},adapter:{inspect:async()=>{enter();await gate;return snapshot;},prepare:async()=>{},
      verifyPrepared:async()=>snapshot,baseline:async()=>[],clickOnce:async()=>{throw Error('MUST_NOT_CLICK');},readback:async()=>null}});
    await f.browser.open();const task=workflow.prepare(f.token,id);await entered;Object.assign(f.browser,{viewRequests:1});release();await task;
    expect(await f.service.dispatch(f.token,{command:'getSendResult',commandId:id})).toMatchObject({status:'FAILED_BEFORE_CLICK',reason:'LOGIN_RECOVERY_IN_PROGRESS',accepted:false,intentId:null});
    expect(f.service.authority.draftFor(f.eventId)?.text).toBe(input.text);expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{Object.assign(f.browser,{viewRequests:0});release();await f.close();}
});
