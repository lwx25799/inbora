import {expect,test} from 'vitest';
import {AccountActor} from '../../src/browser/account-actor.js';
import {ManualCommentRetry} from '../../src/core/manual-comment-retry.js';
import {SendCoordinator} from '../../src/core/send-coordinator.js';
import {digest,type ReplyAdapter} from '../../src/core/contracts.js';
import {candidate,database,approved,snapshot} from '../helpers.js';

function setup(){
  const store=database(),event=candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',platformEventId:'comment-1',videoId:'video-1',commentId:'comment-1',conversationId:null});
  const draftId=approved(store,event),draft=store.draft(draftId),priorId=store.recordIntent(draftId,snapshot(event),true);
  store.receipt(priorId,'UNCERTAIN','NO_PROOF');
  return{store,event,draftId,draft,priorId,grant:()=>store.authorizeCommentRetry(draftId,snapshot(event),'explicit synthetic human approval')};
}
function reply(overrides:Partial<ReplyAdapter>={}):ReplyAdapter{return{
  inspect:async e=>snapshot(e),prepare:async()=>{},verifyPrepared:async e=>snapshot(e),baseline:async()=>['old'],clickOnce:async()=>{},
  readback:async(e,text)=>{await new Promise(r=>setTimeout(r,3));return{id:'retry-new',ownId:'own-1',targetKey:snapshot(e).targetKey,text,pending:false,sentAt:new Date().toISOString()};},...overrides};}
test('explicit retry records a separate durable intent, budgets once and never clears the original unknown',async()=>{
  const f=setup();try{
    let clicks=0;const grant=f.grant(),retry=new ManualCommentRetry(f.store,new AccountActor());
    const a=reply({clickOnce:async()=>{expect((f.store.stats().manualRetries as {result:string}[])[0]!.result).toBe('INTENT_RECORDED');clicks++;}});
    expect(await retry.send(grant,a,true)).toBe('CONFIRMED');expect(clicks).toBe(1);
    expect(f.store.event(f.draft.eventId).status).toBe('UNCERTAIN');expect(f.store.uncertain()).toHaveLength(1);
    expect(f.store.db.prepare('SELECT * FROM send_intents').all()).toHaveLength(1);
    expect(f.store.db.prepare("SELECT used FROM budgets WHERE kind='SEND'").get()).toEqual({used:2});
    expect(f.store.history(f.event).filter(e=>e.direction==='OUTGOING')).toMatchObject([{text:f.draft.text}]);
    await expect(retry.send(grant,a,true)).rejects.toThrow('ALREADY_ATTEMPTED');expect(clicks).toBe(1);
    expect(()=>f.grant()).toThrow('ALREADY_ATTEMPTED');
    await expect(new SendCoordinator(f.store,new AccountActor()).send(f.draftId,a,true)).rejects.toThrow();
  }finally{f.store.close();}
});
test.each(['no-proof','wrong-target','old-time','click-error'])('manual retry %s is unknown and remains consumed across recovery',async failure=>{
  const f=setup();try{
    let clicks=0;const grant=f.grant(),a=reply({clickOnce:async()=>{clicks++;if(failure==='click-error')throw Error('timeout');},
      readback:async(e,text)=>failure==='no-proof'?null:{id:'new',ownId:'own-1',targetKey:failure==='wrong-target'?'comment:wrong:parent':snapshot(e).targetKey,
        text,pending:false,sentAt:'2020-01-01T00:00:00Z'}});
    const retry=new ManualCommentRetry(f.store,new AccountActor());expect(await retry.send(grant,a,true)).toBe('UNCERTAIN');
    expect(f.store.recover()).toBe(0);await expect(retry.send(grant,a,true)).rejects.toThrow('ALREADY_ATTEMPTED');expect(clicks).toBe(1);
  }finally{f.store.close();}
});
test('missing authorization, changed context, pause/resume and database refusal prevent retry clicks',async()=>{
  const f=setup();try{
    let clicks=0;const retry=new ManualCommentRetry(f.store,new AccountActor()),a=reply({clickOnce:async()=>{clicks++;}});
    await expect(retry.send('missing',a,true)).rejects.toThrow('AUTHORIZATION_REQUIRED');
    const grant=f.grant();await expect(retry.send(grant,reply({inspect:async e=>({...snapshot(e),contextDigest:'changed'})}),true)).rejects.toThrow('TARGET_CHANGED');
    f.store.pause(snapshot(f.event).targetKey,true);f.store.pause(snapshot(f.event).targetKey,false);
    await expect(retry.send(grant,a,true)).rejects.toThrow('AUTHORIZATION_REVOKED');
    const replacement=f.grant();f.store.db.pragma('query_only=ON');await expect(retry.send(replacement,a,true)).rejects.toThrow();
    expect(clicks).toBe(0);expect(f.store.stats().manualRetries).toEqual([]);
  }finally{f.store.close();}
});
test('two authorized retry commands serialize and original intent limits all grants to one attempt',async()=>{
  const f=setup();try{
    const one=f.grant(),two=f.grant(),retry=new ManualCommentRetry(f.store,new AccountActor());let clicks=0;
    const result=await Promise.allSettled([retry.send(one,reply({clickOnce:async()=>{clicks++;}}),true),retry.send(two,reply(),true)]);
    expect(result[0]!.status).toBe('fulfilled');expect(result[1]!.status).toBe('rejected');expect(clicks).toBe(1);
  }finally{f.store.close();}
});
test('unfinished manual intent recovers to unknown and budget failure is atomic',()=>{
  const f=setup();try{
    const grant=f.grant();f.store.db.prepare("UPDATE budgets SET used=maximum WHERE kind='SEND'").run();
    expect(()=>f.store.recordCommentRetryIntent(grant,snapshot(f.event),true)).toThrow('BUDGET_EXHAUSTED');
    expect(f.store.stats().manualRetries).toEqual([]);
    f.store.db.prepare("UPDATE budgets SET used=1 WHERE kind='SEND'").run();const id=f.store.recordCommentRetryIntent(grant,snapshot(f.event),true);
    expect(f.store.commentRetryBoundary(id)).toMatch(/^\d{4}-/);expect(f.store.recover()).toBe(1);expect(f.store.recover()).toBe(0);
    expect(f.store.stats().manualRetries).toMatchObject([{result:'UNCERTAIN'}]);
    expect(()=>f.store.recordCommentRetryIntent(grant,snapshot(f.event),true)).toThrow('ALREADY_ATTEMPTED');
    expect(digest(f.store.event(f.draft.eventId).payload)).toBe(digest(f.event));
  }finally{f.store.close();}
});
test('a changed preflight consumes the approval even when the old context later returns',async()=>{
  const f=setup();try{
    const grant=f.grant(),retry=new ManualCommentRetry(f.store,new AccountActor());
    await expect(retry.send(grant,reply({inspect:async e=>({...snapshot(e),contextDigest:'changed'})}),true)).rejects.toThrow('TARGET_CHANGED');
    await expect(retry.send(grant,reply(),true)).rejects.toThrow('AUTHORIZATION_REVOKED');
    expect(f.store.stats().manualRetries).toEqual([]);
  }finally{f.store.close();}
});
test('an observed original collision invalidates an unconsumed retry approval',async()=>{
  const f=setup();try{
    const grant=f.grant();
    f.store.observe('COMMENT_NOTIFICATION','notifications',[{...f.event,text:'changed original'}],'own-1','changed-fixture');
    expect(f.store.draft(f.draftId).approval).toBeNull();
    await expect(new ManualCommentRetry(f.store,new AccountActor()).send(grant,reply(),true)).rejects.toThrow('AUTHORIZATION_REVOKED');
    expect(f.store.stats().manualRetries).toEqual([]);
  }finally{f.store.close();}
});
