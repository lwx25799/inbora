import {expect,test} from 'vitest';
import {randomUUID} from 'node:crypto';
import {setupAssistant} from '../mcp-helpers.js';
import {candidate} from '../helpers.js';
import {targetKey} from '../../src/core/contracts.js';

async function enableModel(f:Awaited<ReturnType<typeof setupAssistant>>){
  f.auto.grant('MODEL',{ownId:'own-1',channels:['DIRECT_MESSAGE','COMMENT_NOTIFICATION'],model:'deepseek-flash',modelLimit:5,expiresAt:null});
  await f.service.dispatch(f.gui,{command:'configureAi',settings:{model:'deepseek-flash',persona:'',business:'',rules:''},key:'synthetic-only'});
}

test('pre-origin incoming text in the actual finite DM context is rejected before any paid reservation',async()=>{
  const f=await setupAssistant();try{
    await enableModel(f);const before=f.grant.scope.collection.startedAt-1000;
    f.store.observe('DIRECT_MESSAGE','conversation-1',[candidate({platformEventId:'before-origin',occurredAt:new Date(before).toISOString(),text:'Private old context'})],
      'own-1','synthetic-old',new Date().toISOString(),f.grant.scope.collection.startedAt);
    await expect(f.service.dispatch(f.token,{command:'generateSuggestion',eventId:f.eventId,draftVersion:0})).rejects.toThrow('ASSISTANT_CONTEXT_OUTSIDE_SCOPE');
    expect(f.calls()).toBe(0);expect(f.store.budget('MODEL').used).toBe(0);
    expect(f.store.db.prepare('SELECT count(*) n FROM grant_reservations').get()).toEqual({n:0});
  }finally{await f.close();}
});

test('old unrelated media outside the selected text context does not permanently block assistant suggestions',async()=>{
  const f=await setupAssistant();try{
    await enableModel(f);
    const old=candidate({platformEventId:'old-media',occurredAt:new Date(f.grant.scope.collection.startedAt-1000).toISOString(),
      contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED',text:'[private media]'});
    f.store.observe('DIRECT_MESSAGE','conversation-1',[old],'own-1','synthetic-media',new Date().toISOString(),f.grant.scope.collection.startedAt);
    const suggestion=await f.service.dispatch(f.token,{command:'generateSuggestion',eventId:f.eventId,draftVersion:0});
    expect(suggestion).toMatchObject({text:'Synthetic assistant suggestion'});expect(f.calls()).toBe(1);expect(f.store.budget('MODEL').used).toBe(1);
  }finally{await f.close();}
});

test.each([true,false])('mandatory comment root is validated after provider enrichment; oldRoot=%s',async oldRoot=>{
  const f=await setupAssistant();try{
    const start=f.grant.scope.collection.startedAt,root=candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',platformEventId:'1101',
      videoId:'1001',commentId:'1101',conversationId:null,occurredAt:new Date(start+(oldRoot?-1000:1000)).toISOString(),text:'Root context'});
    const child=candidate({channel:'COMMENT_NOTIFICATION',kind:'REPLY',platformEventId:'1102',videoId:'1001',commentId:'1102',
      rootCommentId:'1101',replyToCommentId:'1102',conversationId:null,occurredAt:new Date(start+2000).toISOString(),text:'Exact child'});
    f.store.observe('COMMENT_NOTIFICATION','work:1001',[root,child],'own-1','synthetic-comment',new Date().toISOString(),start);
    for(const event of [root,child])f.store.db.prepare('INSERT INTO collection_targets VALUES(?,?,?,?,?,?,?)')
      .run(targetKey(event),'own-1',event.actorId,'peer-sec','Fixture peer',null,Date.now());
    const id=f.store.events().find(event=>event.payload.platformEventId==='1102')!.id;
    const {collection:_collection,...scope}=f.grant.scope;
    const grant=f.service.authority.assistant.grant({...scope,channels:['COMMENT_NOTIFICATION']},['1001']);
    const token=f.service.authority.issueAssistantSession(grant.version),selectionId=randomUUID();
    f.service.authority.select(token,id,selectionId);f.service.authority.claim(token,id,0);await enableModel(f);
    const result=f.service.dispatch(token,{command:'generateSuggestion',eventId:id,draftVersion:0});
    if(oldRoot){
      await expect(result).rejects.toThrow('ASSISTANT_CONTEXT_OUTSIDE_SCOPE');expect(f.calls()).toBe(0);expect(f.store.budget('MODEL').used).toBe(0);
      expect(f.store.db.prepare('SELECT count(*) n FROM grant_reservations').get()).toEqual({n:0});
    }else{
      await expect(result).resolves.toMatchObject({text:'Synthetic assistant suggestion'});expect(f.calls()).toBe(1);expect(f.store.budget('MODEL').used).toBe(1);
    }
  }finally{await f.close();}
});
