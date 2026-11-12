import {expect,test,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import type {VerificationScheduler} from '../../src/app/verification-scheduler.js';
import type {CollectionScheduler} from '../../src/app/collection-scheduler.js';
import type {AutomationStore} from '../../src/storage/automation-store.js';
import {EventStore} from '../../src/storage/store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {refreshTargets} from '../../desktop/src/read-refresh.js';
import {approved,candidate,privateTemp,snapshot} from '../helpers.js';

test('comment proof completion refreshes the inbox and a later collected child stays independently actionable',async()=>{
  let now=Date.now();const root=privateTemp('comment-inbox-refresh-'),store=new EventStore(join(root,'poc.sqlite'),true,()=>new Date(now).toISOString());
  const original=candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',conversationId:null,videoId:'10',commentId:'11',platformEventId:'11',
    occurredAt:new Date(now-10_000).toISOString()});
  const draft=approved(store,original),eventId=store.draft(draft).eventId,intent=store.recordIntent(draft,snapshot(original),false);
  store.receipt(intent,'UNCERTAIN','synthetic-original-unknown');await migrateClient(store,join(root,'client.sqlite'));
  const browser=new BrowserService(root),verify=vi.spyOn(browser,'verifyExisting').mockResolvedValueOnce({verified:false,evidenceId:'synthetic-incomplete'})
    .mockResolvedValueOnce({verified:true,evidenceId:'synthetic-complete'});
  const collect=vi.spyOn(browser,'collect'),service=new ClientService(store,browser,undefined,()=>now);
  try{
    await service.loadSettings();const token=service.authority.issueSession();
    const internal=service as unknown as {verification:VerificationScheduler;collector:CollectionScheduler;automation:AutomationStore};
    const read=(status:'ALL'|'PENDING'|'CONFIRMED'='ALL')=>service.dispatch(token,{command:'getInbox',channel:'COMMENT_NOTIFICATION',status,page:0});
    const before={intents:store.db.prepare('SELECT * FROM send_intents').all(),receipts:store.db.prepare('SELECT * FROM delivery_receipts').all(),budgets:store.budgets()};
    const updates:string[]=[];service.events.on('update',(message:{event:string})=>updates.push(message.event));
    expect(await read()).toMatchObject({total:1,items:[{id:eventId,replyStatus:'WAITING',waitingCount:1}]});
    now+=2000;await internal.verification.tick();
    expect(await read()).toMatchObject({total:1,items:[{id:eventId,replyStatus:'WAITING'}]});
    now+=10_000;await internal.verification.tick();
    expect(verify).toHaveBeenCalledTimes(2);
    expect(updates.at(-1)).toBe('send_status_updated');
    expect(refreshTargets(updates.at(-1)!)).toEqual(expect.arrayContaining(['inbox','thread']));
    expect(await read('PENDING')).toMatchObject({total:0});
    expect(await read('CONFIRMED')).toMatchObject({total:1,items:[{id:eventId,replyStatus:'REPLIED',waitingCount:0}]});
    expect(await service.dispatch(token,{command:'getThread',eventId})).toMatchObject({replyStatus:'REPLIED',event:{status:'UNCERTAIN'}});
    expect(store.db.prepare('SELECT verified FROM verification_results ORDER BY rowid').all()).toEqual([{verified:0},{verified:1}]);
    const child={...original,platformEventId:'21',commentId:'21',rootCommentId:'11',replyToCommentId:'21',kind:'REPLY' as const,
      occurredAt:new Date(now+1000).toISOString(),text:'new synthetic child'};
    collect.mockImplementation(async(_data,source)=>{
      expect(source).toBe('works');store.observe('COMMENT_NOTIFICATION','notifications',[original,child],'own-1','synthetic-new-child',new Date(now+2000).toISOString());
    });
    internal.automation.configureCollection({ownId:'own-1',comments:true,inbox:false,commentIntervalMs:30_000,dmIntervalMs:15_000});
    await internal.collector.runNow('works');
    expect(updates.at(-1)).toBe('inbox_updated');
    const childId=store.events().find(e=>e.payload.commentId==='21')!.id;
    expect(await read('PENDING')).toMatchObject({total:1,items:[{id:childId,latestEventId:childId,replyStatus:'WAITING',commentCount:2,waitingCount:1}]});
    expect(await service.dispatch(token,{command:'getThread',eventId})).toMatchObject({replyStatus:'REPLIED'});
    await internal.collector.runNow('works');expect(store.events()).toHaveLength(2);
    // A later negative proof must override the old positive in every read without rewriting its receipt.
    store.db.prepare('INSERT INTO verification_results VALUES(?,?,?,?,?)').run(randomUUID(),intent,0,'synthetic-later-contradiction',now+3000);
    expect(await read()).toMatchObject({total:1,items:[{replyStatus:'WAITING',waitingCount:2}]});
    expect(await service.dispatch(token,{command:'getThread',eventId})).toMatchObject({replyStatus:'WAITING'});
    expect({intents:store.db.prepare('SELECT * FROM send_intents').all(),receipts:store.db.prepare('SELECT * FROM delivery_receipts').all(),budgets:store.budgets()}).toEqual(before);
  }finally{await service.close();verify.mockRestore();collect.mockRestore();store.close();}
});
