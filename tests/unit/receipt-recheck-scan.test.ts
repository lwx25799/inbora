import {expect,test,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {EventStore} from '../../src/storage/store.js';
import {claimReceiptRecheck,receiptRecheckVersion} from '../../src/app/receipt-recheck.js';
import {candidate,snapshot} from '../helpers.js';
import {digest,eventBinding,targetKey} from '../../src/core/contracts.js';

function fixture(){
  const store=new EventStore(':memory:',true),now=Date.now()+10_000;
  store.bindAccount('own-1');
  store.db.exec(`CREATE TABLE verification_jobs(intent_id TEXT PRIMARY KEY,event_id TEXT,boundary TEXT,target_digest TEXT,
    attempts INTEGER,next_at INTEGER,deadline INTEGER,state TEXT,last_error TEXT);
    CREATE TABLE verification_results(id TEXT PRIMARY KEY,intent_id TEXT,verified INTEGER,evidence_ref TEXT,checked_at INTEGER);`);
  const add=(index:number,eligible=false)=>{
    const event=candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',videoId:'10',commentId:String(1000+index),
      platformEventId:String(1000+index),conversationId:null}),eventId=randomUUID();
    store.db.prepare("INSERT INTO inbound_events VALUES(?,?,?,?,?,?,?,?,'AWAITING_DRAFT')")
      .run(eventId,event.accountId,event.channel,event.platformEventId,'notifications',targetKey(event),eventBinding(event),JSON.stringify(event));
    const draft=store.saveDraft(eventId,'synthetic reply '+index,'mock'),proof={...snapshot(event),contextDigest:'b'.repeat(64)};
    store.approve(draft.id,proof,draft.version,draft.text);
    const intentId=store.recordIntent(draft.id,proof,false);
    store.receipt(intentId,'UNCERTAIN',eligible?'NO_UNIQUE_BOUND_PROOF':'POST_INTENT_FAILURE:DISPATCH:UNCLASSIFIED');
    store.db.prepare("INSERT INTO verification_jobs VALUES(?,?,?,?,2,?,?,'REVIEW','NO_COMPLETE_PROOF')")
      .run(intentId,eventId,store.intentBoundary(intentId),digest(proof),0,1);
    return intentId;
  };
  const ledger=()=>['send_intents','delivery_receipts','verification_jobs','budgets'].map(table=>
    store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  return {store,now,add,ledger};
}

test('ineligible old receipts cannot hide a qualified intent beyond the first hundred',()=>{
  const f=fixture();try{
    for(let index=0;index<100;index++)f.add(index);
    const first=f.add(100,true),second=f.add(101,true),before=f.ledger();
    const read=vi.spyOn(f.store,'event');
    // A bounded worker scans one page per tick and reaches later pages.
    expect(claimReceiptRecheck(f.store,f.now)).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(100);
    expect(claimReceiptRecheck(f.store,f.now)?.intent_id).toBe(first);
    expect(claimReceiptRecheck(f.store,f.now)?.intent_id).toBe(second);
    expect(claimReceiptRecheck(f.store,f.now)).toBeUndefined();
    expect(f.ledger()).toEqual(before);
    expect(f.store.db.prepare('SELECT count(*) n FROM audit_events WHERE event_type=?').get(receiptRecheckVersion+'_CLAIMED')).toEqual({n:2});
  }finally{f.store.close();}
});

test('skipping an ineligible intent does not consume its chance when evidence later qualifies it',()=>{
  const f=fixture();try{
    const earlier=f.add(1),later=f.add(2,true);
    expect(claimReceiptRecheck(f.store,f.now)?.intent_id).toBe(later);
    expect(claimReceiptRecheck(f.store,f.now)).toBeUndefined();
    f.store.db.prepare("UPDATE delivery_receipts SET proof_ref='NO_UNIQUE_BOUND_PROOF' WHERE send_intent_id=?").run(earlier);
    expect(claimReceiptRecheck(f.store,f.now)?.intent_id).toBe(earlier);
    expect(claimReceiptRecheck(f.store,f.now)).toBeUndefined();
  }finally{f.store.close();}
});
