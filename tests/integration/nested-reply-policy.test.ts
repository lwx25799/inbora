import {expect,test} from 'vitest';
import {join} from 'node:path';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {replyPolicySchema} from '../../src/app/automation-contracts.js';
import {candidate,database,privateTemp} from '../helpers.js';

test('the nested comment switch defaults on without rewriting an existing scope, and off leaves root comments and DMs eligible',async()=>{
  const root=privateTemp('nested-policy-'),store=database();try{
    await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));store.bindAccount('own-1');
    const auto=new AutomationStore(store);const origin=Date.now()-60_000;auto.initialize(origin);
    store.db.prepare("UPDATE client_state SET mode='LIMITED_AUTO',paused=0").run();
    const scope={ownId:'own-1',channels:['COMMENT_NOTIFICATION','DIRECT_MESSAGE'],model:'deepseek-flash',modelLimit:10,sendLimit:10,expiresAt:null,
      workIds:['work-1'],futureOwnWorks:false,conversationIds:[],entireInbox:true,containsAny:[],excludesAny:[],instructions:'Synthetic only',startHour:0,endHour:24};
    const legacy=auto.grant('AUTO_REPLY',replyPolicySchema.parse(scope));
    const prior=store.db.prepare('SELECT scope_json,scope_digest FROM automation_grants WHERE version=?').get(legacy.version);
    const at=new Date(origin+1000).toISOString();
    const rootEvent=candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',videoId:'work-1',commentId:'1001',conversationId:null,platformEventId:'1001',occurredAt:at});
    const nestedEvent={...rootEvent,kind:'REPLY' as const,commentId:'1002',platformEventId:'1002',rootCommentId:'1001',replyToCommentId:'1002'};
    const dm=candidate({platformEventId:'new-dm',occurredAt:at});
    const ids=[...store.observe('COMMENT_NOTIFICATION','work-1',[rootEvent,nestedEvent],'own-1','synthetic',new Date().toISOString(),origin),
      ...store.observe('DIRECT_MESSAGE',dm.conversationId!,[dm],'own-1','synthetic',new Date().toISOString(),origin)];
    expect(ids).toHaveLength(3);
    expect(ids.map(id=>auto.policyMatches(legacy,store.event(id)))).toEqual([true,true,true]);
    expect(store.db.prepare('SELECT scope_json,scope_digest FROM automation_grants WHERE version=?').get(legacy.version)).toEqual(prior);
    const off=auto.grant('AUTO_REPLY',replyPolicySchema.parse({...scope,replyToNestedComments:false}));
    expect(ids.map(id=>auto.policyMatches(off,store.event(id)))).toEqual([true,false,true]);
    const on=auto.grant('AUTO_REPLY',replyPolicySchema.parse({...scope,replyToNestedComments:true}));
    expect(ids.map(id=>auto.policyMatches(on,store.event(id)))).toEqual([true,true,true]);
    expect(store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});expect(store.budgets().map(b=>b.used)).toEqual([0,0]);
  }finally{store.close();}
});
