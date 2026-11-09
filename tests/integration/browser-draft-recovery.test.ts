import {expect,test} from 'vitest';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {AccountActor} from '../../src/browser/account-actor.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {ClientService} from '../../src/app/service.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {Blocked,digest,targetKey,type InboundEvent} from '../../src/core/contracts.js';
import {database,privateTemp,pending,candidate,snapshot} from '../helpers.js';

async function setup(){
  const root=privateTemp('saved-browser-draft-'),store=database(),eventId=pending(store);await migrateClient(store,join(root,'backup.sqlite'));
  let web='Persisted automatic draft',clears=0,wrongTarget=false,reads=0,afterRead:(()=>void)|undefined,readError:Error|undefined;
  const browser=new class extends BrowserService{
    override get actor(){return actor;}
    override status(){return {state:'OPEN_LAST_READ_VERIFIED',mode:'headless' as const,version:'synthetic'};}
    override async adapter(){return {dispose:()=>{},adapter:{
      inspect:async(event:InboundEvent)=>snapshot(event),prepare:async()=>{throw Error('MUST_NOT_PREPARE');},verifyPrepared:async(event:InboundEvent)=>snapshot(event),
      baseline:async()=>[],clickOnce:async()=>{throw Error('MUST_NOT_SEND');},readback:async()=>null,
      readSavedDraft:async(event:InboundEvent)=>{reads++;if(readError)throw readError;const result={text:web,snapshot:{...snapshot(event),...(wrongTarget?{targetKey:'dm:outside'}:{})}};afterRead?.();return result;},
      clearSavedDraft:async(_event:InboundEvent,expected:string)=>{expect(web).toBe(expected);clears++;web='';},
    }};}
    override async close(){}
  }(root),actor=new AccountActor(),service=new ClientService(store,browser);await service.loadSettings();const token=service.authority.issueSession();
  const draftId=randomUUID(),grant=new AutomationStore(store).grant('AUTO_REPLY',{ownId:'own-1',channels:['DIRECT_MESSAGE'],model:'deepseek-flash',modelLimit:2,sendLimit:2,expiresAt:null,
    workIds:[],futureOwnWorks:false,conversationIds:[],entireInbox:true,containsAny:[],excludesAny:[],instructions:'Synthetic only',startHour:0,endHour:24});
  store.db.prepare("INSERT INTO reply_drafts VALUES(?,?,?,?,1,'DRAFT',NULL,NULL)").run(draftId,eventId,web,'deepseek-flash');
  store.db.prepare("UPDATE inbound_events SET status='AWAITING_APPROVAL' WHERE id=?").run(eventId);
  store.db.prepare("INSERT INTO draft_revisions VALUES(?,1,'AUTO_POLICY',?,?,?)").run(draftId,web,'policy:'+grant.version,Date.now());
  const commandId=randomUUID(),params={eventId,generation:0,draftId,draftVersion:1,text:web,contextVersion:service.authority.contextVersion(store.event(eventId)),selectionId:randomUUID()};
  store.db.prepare('INSERT INTO manual_send_commands VALUES(?,?,?,?,?,?,?,?,?)').run(commandId,eventId,service.authority.operator(token).id,digest(params),JSON.stringify(params),'FAILED_BEFORE_CLICK',null,'TARGET_CHANGED_REAPPROVE',Date.now());
  store.db.prepare('INSERT INTO policy_commands VALUES(?,?,0)').run(commandId,grant.version);
  return {root,store,service,token,eventId,draftId,commandId,get clears(){return clears;},get web(){return web;},get reads(){return reads;},
    readError:(error:Error)=>{readError=error;},
    webText:(value:string)=>{web=value;},wrongTarget:()=>{wrongTarget=true;},afterRead:(fn:()=>void)=>{afterRead=fn;},
    close:async()=>{await service.close();store.close();}};
}

test('readonly discovery preserves the exact persisted draft and only the explicit confirmed recovery clears the web input',async()=>{
  const f=await setup();try{
    const before=['reply_drafts','draft_revisions','manual_send_commands','send_intents','delivery_receipts','budgets'].map(name=>f.store.db.prepare('SELECT * FROM '+name).all());
    const candidate=await f.service.dispatch(f.token,{command:'browser',action:'inspectSavedDraftRecovery'}) as {eventId:string;draftId:string;draftVersion:number;text:string;contextVersion:string};
    expect(candidate).toMatchObject({eventId:f.eventId,draftId:f.draftId,draftVersion:1,text:f.web});expect(f.clears).toBe(0);expect(f.reads).toBe(1);
    await expect(f.service.dispatch(f.token,{command:'browser',action:'clearSavedDraftRecovery',eventId:candidate.eventId,draftId:candidate.draftId,draftVersion:1,expectedText:candidate.text,contextVersion:candidate.contextVersion,confirmed:false})).rejects.toThrow();
    expect(f.clears).toBe(0);
    expect(await f.service.dispatch(f.token,{command:'browser',action:'clearSavedDraftRecovery',eventId:candidate.eventId,draftId:candidate.draftId,draftVersion:1,expectedText:candidate.text,contextVersion:candidate.contextVersion,confirmed:true})).toMatchObject({cleared:true});
    expect(f.clears).toBe(1);expect(f.web).toBe('');
    expect(['reply_drafts','draft_revisions','manual_send_commands','send_intents','delivery_receipts','budgets'].map(name=>f.store.db.prepare('SELECT * FROM '+name).all())).toEqual(before);
  }finally{await f.close();}
});

test.each(['match','empty','mismatch','original-missing','conversation','db-state','private-error','private-code'] as const)(
  'readonly recovery diagnostics distinguish %s using fixed body-free counts and never clear the editor',async fault=>{
  const f=await setup();try{
    if(fault==='empty')f.webText('');if(fault==='mismatch')f.webText('PRIVATE_FOREIGN_WEB_TEXT');
    if(fault==='original-missing')f.readError(new Blocked('NATIVE_REPLY_ORIGINAL_CHANGED'));
    if(fault==='conversation')f.readError(new Blocked('NATIVE_REPLY_CONVERSATION_CHANGED'));
    if(fault==='db-state')f.store.db.prepare("UPDATE inbound_events SET status='MANUAL_REVIEW' WHERE id=?").run(f.eventId);
    if(fault==='private-error')f.readError(Error('PRIVATE_EXCEPTION_BODY conv-a'));
    if(fault==='private-code')f.readError(new Blocked('NATIVE_REPLY_PRIVATE_NATIVE_ID'));
    const before=['reply_drafts','draft_revisions','manual_send_commands','send_intents','delivery_receipts','budgets'].map(name=>f.store.db.prepare('SELECT * FROM '+name).all());
    const result=f.service.dispatch(f.token,{command:'browser',action:'inspectSavedDraftRecovery'});
    if(fault==='private-error')await expect(result).rejects.toThrow();else expect(await result).toEqual(fault==='match'?expect.objectContaining({eventId:f.eventId}):null);
    const text=await readFile(join(f.root,'evidence','browser-draft-recovery-latest.json'),'utf8'),report=JSON.parse(text);
    expect(report).toMatchObject({version:1,candidateLimit:10,candidates:1,dbAccepted:fault==='db-state'?0:1,frames:fault==='db-state'?0:1,matches:fault==='match'?1:0});
    const code=fault==='empty'?'EMPTY_EDITOR':fault==='mismatch'?'TEXT_MISMATCH':fault==='original-missing'?'READ_FRAME_NATIVE_REPLY_ORIGINAL_CHANGED':
      fault==='conversation'?'READ_FRAME_NATIVE_REPLY_CONVERSATION_CHANGED':['private-error','private-code'].includes(fault)?'READ_FRAME_UNCLASSIFIED':null;
    if(code)expect(report.readFailures).toEqual({[code]:1});else expect(report.readFailures).toEqual({});
    expect(report.dbRejected).toEqual(fault==='db-state'?{EVENT_STATE:1}:{});
    for(const forbidden of [f.eventId,f.draftId,'Persisted automatic draft','PRIVATE_','conversation-1','peer-1','hello','#chat','.message'])expect(text).not.toContain(forbidden);
    expect(f.clears).toBe(0);expect(['reply_drafts','draft_revisions','manual_send_commands','send_intents','delivery_receipts','budgets'].map(name=>f.store.db.prepare('SELECT * FROM '+name).all())).toEqual(before);
    expect(f.store.db.prepare('SELECT count(*) n FROM model_calls').get()).toEqual({n:0});
  }finally{await f.close();}
});

test.each(['foreign-text','wrong-target','human-origin','intent','same-event-inflight','same-target-unknown','stale-version','late-context'] as const)('saved web recovery refuses %s without clearing or sending',async change=>{
  const f=await setup();try{
    const choice=await f.service.dispatch(f.token,{command:'browser',action:'inspectSavedDraftRecovery'}) as {text:string;contextVersion:string};
    if(change==='foreign-text')f.webText('Foreign human webpage draft');if(change==='wrong-target')f.wrongTarget();
    if(change==='human-origin')f.store.db.prepare("UPDATE draft_revisions SET origin='HUMAN_TYPED'").run();
    if(change==='stale-version')f.store.db.prepare('UPDATE reply_drafts SET version=2').run();
    if(change==='late-context')f.afterRead(()=>{pending(f.store,candidate({platformEventId:'later',text:'new inbound',occurredAt:'2026-11-05T00:00:00Z'}));});
    if(change==='intent')f.store.db.prepare('INSERT INTO send_intents VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),f.eventId,f.draftId,targetKey(f.store.event(f.eventId).payload),'digest','text','UNCERTAIN',new Date().toISOString());
    if(change==='same-event-inflight')f.store.db.prepare('INSERT INTO send_intents VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),f.eventId,f.draftId,targetKey(f.store.event(f.eventId).payload),'digest','text','INTENT_RECORDED',new Date().toISOString());
    if(change==='same-target-unknown'){
      const other=pending(f.store,candidate({platformEventId:'other',occurredAt:'2026-11-04T01:01:00Z'})),draftId=randomUUID();
      f.store.db.prepare("INSERT INTO reply_drafts VALUES(?,?,?,'mock',1,'APPROVED',NULL,NULL)").run(draftId,other,'Prior unknown reply');
      f.store.db.prepare('INSERT INTO send_intents VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),other,draftId,targetKey(f.store.event(other).payload),'digest','text','UNCERTAIN',new Date().toISOString());
    }
    const old=f.web;
    await expect(f.service.dispatch(f.token,{command:'browser',action:'clearSavedDraftRecovery',eventId:f.eventId,draftId:f.draftId,draftVersion:1,expectedText:choice.text,contextVersion:choice.contextVersion,confirmed:true})).rejects.toThrow();
    expect(f.clears).toBe(0);expect(f.web).toBe(old);expect(f.store.db.prepare('SELECT count(*) n FROM model_calls').get()).toEqual({n:0});
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:['intent','same-event-inflight','same-target-unknown'].includes(change)?1:0});
  }finally{await f.close();}
});

test.each([
  {status:'UNCERTAIN',boundary:'2026-11-04T00:59:50Z',eligible:true},
  {status:'INTENT_RECORDED',boundary:'2026-11-04T00:59:50Z',eligible:false},
  {status:'UNCERTAIN',boundary:'2026-11-04T00:59:59Z',eligible:false},
])('later independent reply recovery respects authoritative $status boundary $boundary without rewriting the old outcome',async({status,boundary,eligible})=>{
  const f=await setup();try{
    const original=candidate({platformEventId:'prior-native',occurredAt:'2026-11-04T00:59:00Z'});
    f.store.observe('DIRECT_MESSAGE',original.conversationId!,[original],'own-1','fixture');
    const prior=f.store.db.prepare('SELECT id FROM inbound_events WHERE source_key=?').get(original.platformEventId) as {id:string};
    const draftId=randomUUID(),intentId=randomUUID();
    f.store.db.prepare("INSERT INTO reply_drafts VALUES(?,?,?,'mock',1,'APPROVED',NULL,NULL)").run(draftId,prior.id,'Prior unknown reply');
    f.store.db.prepare('INSERT INTO send_intents VALUES(?,?,?,?,?,?,?,?)').run(intentId,prior.id,draftId,targetKey(original),'digest','text',status,boundary);
    f.store.db.prepare('INSERT INTO delivery_receipts VALUES(?,?,?,?,?)').run(randomUUID(),intentId,'UNCERTAIN','old-synthetic-proof',boundary);
    expect(f.store.sendFrozen(f.eventId)).toBe(!eligible);
    const before=['reply_drafts','draft_revisions','manual_send_commands','send_intents','delivery_receipts','budgets'].map(name=>f.store.db.prepare('SELECT * FROM '+name).all());
    const choice=await f.service.dispatch(f.token,{command:'browser',action:'inspectSavedDraftRecovery'}) as {text:string;contextVersion:string}|null;
    if(eligible){
      expect(choice).toMatchObject({eventId:f.eventId,draftId:f.draftId,text:f.web});
      expect(await f.service.dispatch(f.token,{command:'browser',action:'clearSavedDraftRecovery',eventId:f.eventId,draftId:f.draftId,draftVersion:1,
        expectedText:choice!.text,contextVersion:choice!.contextVersion,confirmed:true})).toEqual({cleared:true});
      expect(f.clears).toBe(1);
    }else{expect(choice).toBeNull();expect(f.clears).toBe(0);expect(f.web).toBe('Persisted automatic draft');}
    expect(['reply_drafts','draft_revisions','manual_send_commands','send_intents','delivery_receipts','budgets'].map(name=>f.store.db.prepare('SELECT * FROM '+name).all())).toEqual(before);
    expect(f.store.db.prepare('SELECT count(*) n FROM model_calls').get()).toEqual({n:0});
  }finally{await f.close();}
});

test('recovery stays in the strict browser domain and requires CONTROL permission even for candidate inspection',async()=>{
  const f=await setup();try{
    for(const body of [{command:'browser',action:'inspectSavedDraftRecovery',open:true},
      {command:'browser',action:'unknownRecovery'},
      {command:'browser',action:'clearSavedDraftRecovery',eventId:f.eventId}])await expect(f.service.dispatch(f.token,body)).rejects.toThrow();
    const readOnly=f.service.authority.issueSession(['READ']);
    await expect(f.service.dispatch(readOnly,{command:'browser',action:'inspectSavedDraftRecovery'})).rejects.toThrow('OPERATOR_PERMISSION_DENIED');
    expect(f.reads).toBe(0);expect(f.clears).toBe(0);expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{await f.close();}
});
