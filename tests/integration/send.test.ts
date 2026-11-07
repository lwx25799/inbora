import { expect, test } from 'vitest';
import { AccountActor } from '../../src/browser/account-actor.js';
import { SendCoordinator } from '../../src/core/send-coordinator.js';
import { Blocked, type ReplyAdapter } from '../../src/core/contracts.js';
import { approved, candidate, database, snapshot } from '../helpers.js';

function adapter(overrides: Partial<ReplyAdapter> = {}): ReplyAdapter {
  return {
    inspect: async e => snapshot(e), prepare: async () => {}, verifyPrepared: async e => snapshot(e),
    baseline: async () => ['old'], clickOnce: async () => {},
    readback: async (e, text) => { await new Promise(r=>setTimeout(r,3));return { id:'new',ownId:'own-1',targetKey:snapshot(e).targetKey,text,pending:false,sentAt:new Date().toISOString() }; },
    ...overrides,
  };
}

test.each(['dispatch','readback'] as const)('post-intent %s failure retains a bounded phase and code without retry',async phase=>{
  const s=database();let clicks=0;try{
    const id=approved(s),a=adapter({clickOnce:async()=>{clicks++;if(phase==='dispatch')throw new Blocked('NATIVE_REPLY_CLICK_BLOCKED');},
      readback:async()=>{throw new Blocked('OBSERVATION_ROW_CHANGED');}});
    expect(await new SendCoordinator(s,new AccountActor()).send(id,a,true)).toBe('UNCERTAIN');
    const receipt=s.receiptForEvent(s.draft(id).eventId) as {proof_ref:string};
    expect(receipt?.proof_ref).toBe(phase==='dispatch'?'POST_INTENT_FAILURE:DISPATCH:NATIVE_REPLY_CLICK_BLOCKED':'POST_INTENT_FAILURE:READBACK:OBSERVATION_ROW_CHANGED');
    await expect(new SendCoordinator(s,new AccountActor()).send(id,a,true)).rejects.toThrow();
    expect(clicks).toBe(1);
  }finally{s.close();}
});

test('unclassified post-intent errors never persist arbitrary private diagnostics',async()=>{
  const s=database();try{
    const id=approved(s);
    expect(await new SendCoordinator(s,new AccountActor()).send(id,adapter({readback:async()=>{throw new Blocked('NATIVE_REPLY_PRIVATE_BODY_ABC');}}),true)).toBe('UNCERTAIN');
    expect((s.receiptForEvent(s.draft(id).eventId) as {proof_ref:string}).proof_ref).toBe('POST_INTENT_FAILURE:READBACK:UNCLASSIFIED');
    expect(JSON.stringify(s.db.prepare('SELECT * FROM audit_events').all())).not.toContain('PRIVATE_BODY');
  }finally{s.close();}
});

test.each([true,false])('clock-tolerant proof is bound to the original approved context: %s',async matches=>{
  const s=database();try{
    const id=approved(s),baseline='a'.repeat(64),initial=snapshot(candidate());initial.contextDigest=baseline;
    s.invalidateApproval(id);
    s.approve(id,initial,s.draft(id).version,s.draft(id).text);
    const a=adapter({inspect:async()=>initial,verifyPrepared:async()=>initial,
      readback:async(e,text,_before,boundary)=>({id:'new',ownId:'own-1',targetKey:snapshot(e).targetKey,text,pending:false,
        sentAt:new Date(Date.parse(boundary)-763).toISOString(),clockSkew:{boundary,baselineContextDigest:matches?baseline:'b'.repeat(64),
          remainingContextDigest:matches?baseline:'b'.repeat(64),refreshedId:'new'}})});
    expect(await new SendCoordinator(s,new AccountActor()).send(id,a,true)).toBe(matches?'CONFIRMED':'UNCERTAIN');
    if(matches){
      const row=s.db.prepare("SELECT detail_redacted FROM audit_events WHERE event_type='CLOCK_SKEW_PROOF'").get() as {detail_redacted:string};
      expect(JSON.parse(row.detail_redacted)).toMatchObject({allowedSkewMs:2000,observedSkewMs:763,baselineContextDigest:baseline});
    }
  }finally{s.close();}
});
test('duplicate send commands result in exactly one click and one receipt', async () => {
  const s = database(); let clicks = 0;
  try {
    const id = approved(s); const coordinator = new SendCoordinator(s, new AccountActor());
    const a = adapter({ clickOnce: async () => { clicks++; } });
    const result = await Promise.allSettled([coordinator.send(id, a, false), coordinator.send(id, a, false)]);
    expect(result[0]).toEqual({ status: 'fulfilled', value: 'CONFIRMED' });
    expect(result[1]?.status).toBe('rejected'); expect(clicks).toBe(1);
    expect(s.db.prepare('SELECT * FROM delivery_receipts').all()).toHaveLength(1);
  } finally { s.close(); }
});
test('two targets serialize browser mutations and receipt lookup', async () => {
  const s = database(); let active = 0; let maximum = 0;
  try {
    const first = approved(s);
    const second = approved(s, candidate({ platformEventId: 'other', conversationId: 'conversation-2' }));
    const coordinator = new SendCoordinator(s, new AccountActor());
    const a = adapter({ prepare: async () => { active++; maximum = Math.max(maximum, active); await new Promise(r => setTimeout(r, 15)); },
      readback: async (e, text) => { await new Promise(r=>setTimeout(r,3));active--; return { id: 'new', ownId: 'own-1', targetKey: snapshot(e).targetKey, text, pending: false,sentAt:new Date().toISOString() }; } });
    expect(await Promise.all([coordinator.send(first, a, false), coordinator.send(second, a, false)])).toEqual(['CONFIRMED', 'CONFIRMED']);
    expect(maximum).toBe(1);
  } finally { s.close(); }
});
test('context change after approval blocks before intent; database write failure blocks click', async () => {
  const s = database(); let clicks = 0;
  try {
    const id = approved(s); const c = new SendCoordinator(s, new AccountActor());
    await expect(c.send(id, adapter({ inspect: async e => ({ ...snapshot(e), contextDigest: 'changed' }) }), true)).rejects.toThrow('TARGET_CHANGED');
    expect(s.draft(id).approval).toBeNull();
    const draft = s.draft(id); s.approve(id, snapshot(candidate()), draft.version, draft.text);
    s.db.pragma('query_only=ON');
    await expect(c.send(id, adapter({ clickOnce: async () => { clicks++; } }), true)).rejects.toThrow();
    expect(clicks).toBe(0);
  } finally { s.close(); }
});
test.each(['timeout', 'wrong-target', 'old-id', 'pending', 'no-proof','historical','future','invalid-time'] as const)('%s after intent stays uncertain and cannot repeat', async failure => {
  const s = database(); let clicks = 0;
  try {
    const id = approved(s); const c = new SendCoordinator(s, new AccountActor());
    const a = adapter({ clickOnce: async () => { clicks++; if (failure === 'timeout') throw new Error('browser gone'); },
      readback: async (e, text) => failure === 'no-proof' ? null : ({ id: failure === 'old-id' ? 'old' : 'new', ownId: 'own-1',
        targetKey: failure === 'wrong-target' ? 'dm:other' : snapshot(e).targetKey, text, pending: failure === 'pending',
        sentAt:failure==='historical'?'2020-01-01T00:00:00Z':failure==='future'?'2099-01-01T00:00:00Z':failure==='invalid-time'?'unverifiable':new Date().toISOString() }) });
    expect(await c.send(id, a, true)).toBe('UNCERTAIN');
    await expect(c.send(id, a, true)).rejects.toThrow(); expect(clicks).toBe(1);
    expect(s.uncertain()).toHaveLength(1);
  } finally { s.close(); }
});

test('a fresh request acknowledgement plus refreshed native ID can prove delivery across wall clocks',async()=>{
  const s=database();try{
    const id=approved(s),a=adapter({readback:async(e,text,_before,boundary)=>({id:'new',ownId:'own-1',targetKey:snapshot(e).targetKey,text,pending:false,
      sentAt:new Date(Date.parse(boundary)-1500).toISOString(),submission:{boundary,requestAt:boundary,responseAt:new Date().toISOString(),
        requestDigest:'a'.repeat(64),responseDigest:'b'.repeat(64)}})});
    expect(await new SendCoordinator(s,new AccountActor()).send(id,a,false)).toBe('CONFIRMED');
    const record=s.db.prepare("SELECT detail_redacted FROM audit_events WHERE event_type='SUBMISSION_PROOF'").get() as {detail_redacted:string};
    expect(JSON.parse(record.detail_redacted)).toMatchObject({requestDigest:'a'.repeat(64),responseDigest:'b'.repeat(64)});
    expect(record.detail_redacted).not.toContain(s.draft(id).text);
  }finally{s.close();}
});
