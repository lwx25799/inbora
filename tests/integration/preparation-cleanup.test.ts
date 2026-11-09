import {expect,test} from 'vitest';
import {AccountActor} from '../../src/browser/account-actor.js';
import {SendCoordinator} from '../../src/core/send-coordinator.js';
import type {ReplyAdapter} from '../../src/core/contracts.js';
import {approved,database,snapshot} from '../helpers.js';

test.each(['clear','failure'] as const)('pre-intent failure awaits owned preparation cleanup without masking the original guard (%s)',async outcome=>{
  const store=database();try{
    const id=approved(store);let cleanups=0,owned=false;
    const adapter:ReplyAdapter={inspect:async event=>snapshot(event),prepare:async()=>{owned=true;},
      verifyPrepared:async event=>({...snapshot(event),contextDigest:'changed-context'}),baseline:async()=>[],clickOnce:async()=>{throw Error('must not click');},readback:async()=>null,
      cancelPreparation:async()=>{cleanups++;expect(store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
        if(outcome==='failure')throw Error('PRIVATE_CLEANUP_ERROR');owned=false;}};
    await expect(new SendCoordinator(store,new AccountActor()).send(id,adapter,false)).rejects.toThrow('TARGET_CHANGED_REAPPROVE');
    expect(cleanups).toBe(1);expect(owned).toBe(outcome==='failure');
    expect(store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
    expect(store.draft(id).status).toBe('DRAFT');
    const audit=store.db.prepare('SELECT event_type,detail_redacted FROM audit_events').all();
    expect(JSON.stringify(audit)).not.toContain('PRIVATE_CLEANUP_ERROR');
    expect(audit.some(row=>(row as {event_type:string}).event_type==='PREPARATION_DISCARD_FAILED')).toBe(outcome==='failure');
  }finally{store.close();}
});

test('an intent followed by a dispatch exception retains uncertainty and never cleans up or retries',async()=>{
  const store=database();try{
    const id=approved(store);let cleanups=0,clicks=0;
    const adapter:ReplyAdapter={inspect:async event=>snapshot(event),prepare:async()=>{},verifyPrepared:async event=>snapshot(event),
      baseline:async()=>[],clickOnce:async()=>{clicks++;throw Error('private dispatch failure');},readback:async()=>null,
      cancelPreparation:async()=>{cleanups++;}};
    expect(await new SendCoordinator(store,new AccountActor()).send(id,adapter,false)).toBe('UNCERTAIN');
    expect(clicks).toBe(1);expect(cleanups).toBe(0);
    expect(store.db.prepare('SELECT status FROM send_intents').all()).toEqual([{status:'UNCERTAIN'}]);
  }finally{store.close();}
});

test.each(['budget','committed'] as const)('the durable intent boundary decides cleanup when intent creation throws (%s)',async reason=>{
  const store=database();try{
    const id=approved(store);let cleanups=0,reads=0,clicks=0;
    if(reason==='committed'){
      const record=store.recordIntent.bind(store);
      store.recordIntent=(...args)=>{record(...args);throw Error('synthetic-after-commit');};
    }
    const adapter:ReplyAdapter={inspect:async event=>snapshot(event),prepare:async()=>{},verifyPrepared:async event=>{
      if(++reads===2&&reason==='budget')store.db.prepare("UPDATE budgets SET used=maximum WHERE kind='SEND'").run();return snapshot(event);},
      baseline:async()=>[],clickOnce:async()=>{clicks++;},readback:async()=>null,cancelPreparation:async()=>{cleanups++;}};
    await expect(new SendCoordinator(store,new AccountActor()).send(id,adapter,reason==='budget')).rejects.toThrow(reason==='budget'?'BUDGET_EXHAUSTED':'synthetic-after-commit');
    expect(clicks).toBe(0);expect(cleanups).toBe(reason==='budget'?1:0);
    expect(store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:reason==='budget'?0:1});
  }finally{store.close();}
});
