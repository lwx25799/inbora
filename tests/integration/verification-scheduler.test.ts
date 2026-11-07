import { expect, test } from "vitest";
import { join } from "node:path";
import { migrateClient } from "../../src/storage/client-migration.js";
import { migrateAutomation } from "../../src/storage/automation-migration.js";
import { AutomationStore } from "../../src/storage/automation-store.js";
import { VerificationScheduler } from "../../src/app/verification-scheduler.js";
import { approved, candidate, database, privateTemp, snapshot } from "../helpers.js";

test('bounded persistent follow-up appends delivery evidence while original unknown intent and receipt remain unchanged',async()=>{
  const store=database(),root=privateTemp('auto-verification-');let worker:VerificationScheduler|undefined;
  try{
    const id=approved(store);await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
    const intent=store.recordIntent(id,snapshot(candidate()),false,{check:()=>{},committed:()=>{}});
    store.receipt(intent,'UNCERTAIN','original-unknown');let now=Date.now();
    const data=new AutomationStore(store,()=>now);data.initialize(now);
    const before=JSON.stringify(store.db.prepare('SELECT * FROM send_intents').all()),receipt=JSON.stringify(store.db.prepare('SELECT * FROM delivery_receipts').all());
    let calls=0;
    worker=new VerificationScheduler(data,async()=>{calls++;return{verified:calls===2,evidenceId:'synthetic-'+calls};});
    worker.enqueue(store.draft(id).eventId);worker.enqueue(store.draft(id).eventId);now+=2000;await worker.tick();
    await worker.close();worker=new VerificationScheduler(data,async()=>{calls++;return{verified:true,evidenceId:'synthetic-after-restart'};});
    worker.start();now+=10_000;await worker.tick();now+=10_000;await worker.tick();
    expect(calls).toBe(2);expect(store.db.prepare('SELECT state,attempts FROM verification_jobs').get()).toEqual({state:'VERIFIED',attempts:2});
    expect(store.db.prepare('SELECT count(*) AS n FROM verification_results').get()).toEqual({n:2});
    expect(JSON.stringify(store.db.prepare('SELECT * FROM send_intents').all())).toBe(before);
    expect(JSON.stringify(store.db.prepare('SELECT * FROM delivery_receipts').all())).toBe(receipt);
  }finally{await worker?.close();store.close();}
});

test('in-flight verification aborts at its deadline and retains the queue until the operation settles',async()=>{
  const store=database(),root=privateTemp('verification-time-bound-');let worker:VerificationScheduler|undefined,release!:()=>void;
  try{
    const id=approved(store);await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
    const intent=store.recordIntent(id,snapshot(candidate()),false,{check:()=>{},committed:()=>{}});store.receipt(intent,'UNCERTAIN','unknown');
    let now=Date.now();const data=new AutomationStore(store,()=>now);data.initialize(now);
    let signal:AbortSignal|undefined;const gate=new Promise<void>(r=>{release=r;});
    worker=new VerificationScheduler(data,async(_eventId,s)=>{signal=s;await gate;return{verified:true,evidenceId:'late-proof'};});
    worker.enqueue(store.draft(id).eventId);now+=2000;const task=worker.tick();await expect.poll(()=>!!signal).toBe(true);
    now+=120_000;await worker.tick();expect(signal!.aborted).toBe(true);
    expect(store.db.prepare('SELECT state FROM verification_jobs').get()).toEqual({state:'RUNNING'});
    release();await task;
    expect(store.db.prepare('SELECT count(*) AS n FROM verification_results').get()).toEqual({n:0});
  }finally{release?.();await worker?.close();store.close();}
});
