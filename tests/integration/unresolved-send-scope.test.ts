import {expect,test} from 'vitest';
import {join} from 'node:path';
import {AccountActor} from '../../src/browser/account-actor.js';
import {SendCoordinator} from '../../src/core/send-coordinator.js';
import {targetKey,type InboundEvent,type ReplyAdapter} from '../../src/core/contracts.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {approved,candidate,database,pending,privateTemp,snapshot} from '../helpers.js';

function legacy(){
  const store=database(),old=candidate(),draft=approved(store,old);
  const intent=store.recordIntent(draft,snapshot(old),false,{check:()=>{},committed:()=>{}});
  const boundary=Date.now()-120_000;
  store.db.prepare('UPDATE send_intents SET attempt_started_at=? WHERE id=?').run(new Date(boundary).toISOString(),intent);
  store.receipt(intent,'UNCERTAIN','synthetic-legacy-proof');
  const next=candidate({platformEventId:'message-2',occurredAt:new Date(boundary+60_000).toISOString()});
  return{store,old,intent,next,boundary};
}

test('a distinct later incoming DM sends once while the old unknown intent and receipt stay unchanged',async()=>{
  const f=legacy();let clicks=0;
  try{
    const oldIntent=f.store.db.prepare('SELECT * FROM send_intents WHERE id=?').get(f.intent);
    const oldReceipt=f.store.db.prepare('SELECT * FROM delivery_receipts WHERE send_intent_id=?').all(f.intent);
    const draft=approved(f.store,f.next);let text='';
    const adapter:ReplyAdapter={inspect:async()=>snapshot(f.next),prepare:async(_e,t)=>{text=t;},verifyPrepared:async()=>snapshot(f.next),
      baseline:async()=>[],clickOnce:async()=>{clicks++;await new Promise(r=>setTimeout(r,5));},
      readback:async()=>({id:'new-native-reply',ownId:'own-1',targetKey:targetKey(f.next),text,pending:false,sentAt:new Date().toISOString()})};
    const sender=new SendCoordinator(f.store,new AccountActor());
    expect(await sender.send(draft,adapter,true)).toBe('CONFIRMED');
    await expect(sender.send(draft,adapter,true)).rejects.toThrow();expect(clicks).toBe(1);
    expect(f.store.db.prepare('SELECT * FROM send_intents WHERE id=?').get(f.intent)).toEqual(oldIntent);
    expect(f.store.db.prepare('SELECT * FROM delivery_receipts WHERE send_intent_id=?').all(f.intent)).toEqual(oldReceipt);
    expect(f.store.db.prepare('SELECT kind,used FROM budgets ORDER BY kind').all()).toEqual([{kind:'MODEL',used:0},{kind:'SEND',used:1}]);
  }finally{f.store.close();}
});

test.each(['same-native','missing-time','before-intent','clock-overlap','future-time','other-sender','in-flight'])(
  'an ambiguous or active send boundary remains blocked (%s)',kind=>{
    const f=legacy();
    try{
      const changes:Partial<InboundEvent>=kind==='same-native'?{platformEventId:f.old.platformEventId}:
        kind==='missing-time'?{occurredAt:null}:kind==='before-intent'?{occurredAt:new Date(f.boundary-1).toISOString()}:
        kind==='clock-overlap'?{occurredAt:new Date(f.boundary+1000).toISOString()}:kind==='future-time'?{occurredAt:new Date(Date.now()+60_000).toISOString()}:
        kind==='other-sender'?{actorId:'another-peer'}:{};
      if(kind==='in-flight')f.store.db.prepare("UPDATE send_intents SET status='INTENT_RECORDED' WHERE id=?").run(f.intent);
      const event={...f.next,...changes};
      if(kind==='same-native'){
        const original=f.store.db.prepare('SELECT event_id FROM send_intents WHERE id=?').get(f.intent) as {event_id:string};
        expect(f.store.sendFrozen(original.event_id)).toBe(true);
      }else if(kind==='missing-time'){
        const id=pending(f.store,f.next);f.store.db.prepare('UPDATE inbound_events SET payload=? WHERE id=?').run(JSON.stringify(event),id);
        expect(f.store.sendFrozen(id)).toBe(true);
      }else{const id=pending(f.store,event);expect(f.store.sendFrozen(id)).toBe(true);}
    }finally{f.store.close();}
  });

test('policy and thread views use the same independent-message boundary without changing the old unknown',async()=>{
  const f=legacy(),root=privateTemp('unresolved-send-scope-');let service:ClientService|undefined;
  try{
    const earlier=pending(f.store,candidate({platformEventId:'earlier-unsent-draft',occurredAt:new Date(f.boundary+5000).toISOString()}));
    const nextId=pending(f.store,f.next);await migrateClient(f.store,join(root,'backup.sqlite'));
    service=new ClientService(f.store,new BrowserService(root));await service.loadSettings();const token=service.authority.issueSession();
    const auto=new AutomationStore(f.store),grant=auto.grant('AUTO_REPLY',{ownId:'own-1',channels:['DIRECT_MESSAGE'],model:'deepseek-flash',
      modelLimit:1,sendLimit:1,expiresAt:null,workIds:[],futureOwnWorks:false,conversationIds:[],entireInbox:true,
      containsAny:[],excludesAny:[],instructions:'Synthetic reply',startHour:0,endHour:24});
    service.authority.setMode(token,'LIMITED_AUTO');
    expect(auto.policyMatches(grant,f.store.event(nextId))).toBe(true);
    const owner=service.authority.claim(token,earlier,service.authority.ownership(f.store.event(earlier)).generation);
    service.authority.save(token,earlier,owner.generation,0,'Older human draft remains saved');
    service.authority.release(token,earlier,owner.generation);service.authority.pause(token,earlier,true);
    await service.dispatch(token,{command:'setAutomaticReply',enabled:true});
    expect(auto.policyMatches(grant,f.store.event(nextId))).toBe(true);
    expect(service.authority.draftFor(earlier)?.text).toBe('Older human draft remains saved');
    expect(await service.dispatch(token,{command:'getThread',eventId:nextId})).toMatchObject({frozen:false,intent:null,replyStatus:'WAITING'});
    const oldId=f.store.db.prepare('SELECT event_id FROM send_intents WHERE id=?').get(f.intent) as {event_id:string};
    expect(await service.dispatch(token,{command:'getThread',eventId:oldId.event_id})).toMatchObject({frozen:true,intent:{status:'UNCERTAIN'},replyStatus:'WAITING'});
    service.authority.claim(token,nextId,service.authority.ownership(f.store.event(nextId)).generation);
    service.authority.pause(token,nextId,true);expect(auto.policyMatches(grant,f.store.event(nextId))).toBe(false);
    await service.dispatch(token,{command:'resumeAutomation',eventId:nextId});
    expect(await service.dispatch(token,{command:'getThread',eventId:nextId})).toMatchObject({frozen:false,paused:false});
    expect(auto.policyMatches(grant,f.store.event(nextId))).toBe(true);
    expect(f.store.db.prepare('SELECT used FROM budgets ORDER BY kind').all()).toEqual([{used:0},{used:0}]);
  }finally{await service?.close();f.store.close();}
});
