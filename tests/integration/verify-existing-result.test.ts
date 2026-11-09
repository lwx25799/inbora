import {expect,test,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {join} from 'node:path';
import {BrowserService} from '../../src/app/browser-service.js';
import type {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {digest,type ReplyAdapter,type SendProof} from '../../src/core/contracts.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {approved,database,privateTemp,snapshot} from '../helpers.js';

test.each([false,true])('read-only existing verification exposes only the exact proof native digest when complete (%s)',async complete=>{
  const store=database(),root=privateTemp('verify-existing-result-'),draft=store.draft(approved(store)),event=store.event(draft.eventId);
  const intent=store.recordIntent(draft.id,snapshot(event.payload),false);store.receipt(intent,'UNCERTAIN','synthetic-unknown');
  await migrateClient(store,join(root,'client.sqlite'));
  const before={events:store.events(),intents:store.db.prepare('SELECT * FROM send_intents').all(),
    receipts:store.db.prepare('SELECT * FROM delivery_receipts').all(),budgets:store.db.prepare('SELECT * FROM budgets').all()};
  const owner={context:new EventEmitter(),actor:{run:async(action:()=>unknown)=>action()},version:()=> '123.0.0.0'} as unknown as BrowserProfileOwner;
  const browser=BrowserService.adopt(root,owner,'headless'),proof:SendProof={id:'synthetic-exact-native-id',ownId:'own-1',
    targetKey:'dm:conversation-1',text:draft.text,pending:false,sentAt:new Date().toISOString()};
  const inspect=vi.fn(async()=>snapshot(event.payload)),readback=vi.fn(async()=>complete?proof:null),dispose=vi.fn();
  const adapter:ReplyAdapter={inspect,prepare:vi.fn(),verifyPrepared:vi.fn(),baseline:vi.fn(),clickOnce:vi.fn(),readback};
  const mocked=vi.spyOn(browser,'adapter').mockResolvedValue({adapter,dispose});
  try{
    const result=await browser.verifyExisting(store,event.id,{background:true});
    expect(result).toMatchObject({verified:complete,evidenceId:expect.any(String)});
    if(complete)expect(result).toMatchObject({nativeIdDigest:digest(proof.id)});else expect(result).not.toHaveProperty('nativeIdDigest');
    expect(JSON.stringify(result)).not.toContain(proof.id);expect(inspect).toHaveBeenCalledWith(event.payload);
    expect(readback).toHaveBeenCalledWith(event.payload,draft.text,[],store.intentBoundary(intent));
    expect(adapter.prepare).not.toHaveBeenCalled();expect(adapter.clickOnce).not.toHaveBeenCalled();expect(dispose).toHaveBeenCalledOnce();
    expect(store.events()).toEqual(before.events);expect(store.db.prepare('SELECT * FROM send_intents').all()).toEqual(before.intents);
    expect(store.db.prepare('SELECT * FROM delivery_receipts').all()).toEqual(before.receipts);expect(store.db.prepare('SELECT * FROM budgets').all()).toEqual(before.budgets);
  }finally{mocked.mockRestore();store.close();}
});
