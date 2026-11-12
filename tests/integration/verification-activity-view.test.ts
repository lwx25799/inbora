import {expect,test} from 'vitest';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {WorkbenchQueries} from '../../src/app/workbench-queries.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {digest} from '../../src/core/contracts.js';
import {approved,candidate,database,privateTemp,snapshot} from '../helpers.js';

test.each(['DIRECT_MESSAGE','COMMENT_NOTIFICATION'] as const)('supplemental %s verification activity and diagnosis stay bound to the exact event',async channel=>{
  const store=database(),root=privateTemp('verification-activity-view-');
  const payload=candidate(channel==='DIRECT_MESSAGE'?{}:{channel,kind:'COMMENT',videoId:'10',commentId:'11',conversationId:null});
  const draft=approved(store,payload),eventId=store.draft(draft).eventId;
  await migrateClient(store,join(root,'client.sqlite'));
  const browser=new BrowserService(root),service=new ClientService(store,browser);
  try{
    await service.loadSettings();const token=service.authority.issueSession();
    store.approve(draft,snapshot(payload),store.draft(draft).version,store.draft(draft).text);
    const intent=store.recordIntent(draft,snapshot(payload),false,{check:()=>{},committed:()=>{}});
    store.receipt(intent,'UNCERTAIN','original-unknown');
    store.db.prepare("INSERT INTO verification_jobs VALUES(?,?,?,?,2,?,?,'REVIEW','NO_COMPLETE_PROOF')")
      .run(intent,eventId,store.intentBoundary(intent),'synthetic-target',0,1);
    const before=store.db.prepare('SELECT * FROM verification_jobs').all();
    const queries=new WorkbenchQueries(store,service.authority,browser);
    const view=(active:string|null)=>queries.thread(token,eventId,new AutomationStore(store),undefined,undefined,active);
    expect(view(null).verification).toMatchObject({state:'REVIEW',attempts:2});
    expect(view(eventId).verification).toMatchObject({state:'RUNNING',attempts:2});
    expect(view(randomUUID()).verification).toMatchObject({state:'REVIEW',attempts:2});
    expect(view(null).verification).toMatchObject({state:'REVIEW',attempts:2});
    expect(store.db.prepare('SELECT * FROM verification_jobs').all()).toEqual(before);
    const old=store.db.prepare('SELECT * FROM send_intents').all();
    if(channel==='COMMENT_NOTIFICATION'){
      const code='COMMENT_READBACK_VERIFY_EXISTING_FILTERED_GET_ACCEPTED_ACK_NONE_GUARD_NONE',
        counts={poll_sameText:1,poll_afterBoundary:0,poll_notFuture:1};
      store.audit(code,digest(['comment',payload.videoId,'other-comment']),counts);
      store.db.prepare('INSERT INTO verification_results VALUES(?,?,0,?,?)').run(randomUUID(),intent,'synthetic-incomplete',Date.now()+1);
      expect(view(null).verification).toMatchObject({last_error:'NO_COMPLETE_PROOF'});
      store.audit(code,digest(['comment',payload.videoId,payload.commentId]),counts);
      store.db.prepare('INSERT INTO verification_results VALUES(?,?,0,?,?)').run(randomUUID(),intent,'synthetic-incomplete',Date.now()+1);
      expect(view(null).verification).toMatchObject({last_error:'COMMENT_TIME_BEFORE_INTENT'});
      expect(store.db.prepare('SELECT * FROM verification_jobs').all()).toEqual(before);
      store.db.prepare('INSERT INTO verification_results VALUES(?,?,0,?,?)').run(randomUUID(),intent,'synthetic-old-check',1);
      expect(view(null).verification).toMatchObject({last_error:'NO_COMPLETE_PROOF'});
    }
    store.db.prepare('INSERT INTO verification_results VALUES(?,?,1,?,?)').run(randomUUID(),intent,'synthetic-verified',Date.now());
    expect(view(null)).toMatchObject({replyStatus:'REPLIED',conversationReplyStatus:'REPLIED',verification:{last_error:'NO_COMPLETE_PROOF',verified:1}});
    expect(store.db.prepare('SELECT * FROM send_intents').all()).toEqual(old);
  }finally{await service.close();store.close();}
});
