import {expect,test} from 'vitest';
import {digest,eventBinding,eventSchema,isStrong,targetKey} from '../../src/core/contracts.js';
import {candidate} from '../helpers.js';

const original=()=>candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',platformEventId:'21',commentId:'21',videoId:'10',conversationId:null});
const nested=()=>({...original(),kind:'REPLY' as const,rootCommentId:'11',replyToCommentId:'21'});

test('nested comment retains an exact root and exact reply target distinct from its root',()=>{
  const parsed=eventSchema.parse(nested());
  expect(parsed).toMatchObject({commentId:'21',rootCommentId:'11',replyToCommentId:'21',kind:'REPLY'});
  expect(isStrong(parsed)).toBe(true);expect(targetKey(parsed)).toBe('comment:10:21');
});

test.each([{rootCommentId:'21'},{replyToCommentId:'22'},{rootCommentId:'0'},{rootCommentId:undefined},
  {kind:'COMMENT'},{channel:'DIRECT_MESSAGE'}])('invalid nested target cannot enter a strong event: %j',change=>{
  expect(eventSchema.safeParse({...nested(),...change}).success).toBe(false);
});

test('old unclassified replies lack an exact nested target and remain weak',()=>{
  expect(isStrong({...original(),kind:'REPLY'})).toBe(false);
  expect(isStrong({...nested(),occurredAt:null})).toBe(false);
});

test('new nested metadata participates in the binding while old comment bindings remain byte compatible',()=>{
  const event=original(),legacy=[event.accountId,event.channel,event.platformEventId,event.actorId,event.text,event.occurredAt,
    event.videoId,event.commentId,event.conversationId,event.direction,event.kind];
  expect(eventBinding(event)).toBe(digest(legacy));
  expect(eventBinding({...event,observationIssue:'COMMENT_TEXT_UNVERIFIED'})).toBe(digest([...legacy,'COMMENT_TEXT_UNVERIFIED']));
  expect(eventBinding(nested())).not.toBe(eventBinding({...nested(),rootCommentId:'12'}));
  expect(eventBinding(nested())).toBe(eventBinding({...nested(),evidenceId:'another-read'}));
});
