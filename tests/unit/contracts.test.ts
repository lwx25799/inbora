import { expect, test } from 'vitest';
import { eventBinding, isEligible, isStrong, validText } from '../../src/core/contracts.js';
import { candidate } from '../helpers.js';
import { validateObservationMapping,validateDmReplyMapping,validateCommentReplyMapping } from '../../src/config/site-mapping.js';
import { observedMapping,dmReplyMapping,commentReplyMapping } from '../fixtures/observed-site.js';

test('stable identity requires exact channel-specific identifiers, never just nickname/text', () => {
  expect(isStrong(candidate())).toBe(true);
  expect(isStrong(candidate({ actorId: null }))).toBe(false);
  expect(isStrong(candidate({ channel: 'COMMENT_NOTIFICATION', kind: 'COMMENT' }))).toBe(false);
  expect(isStrong(candidate({ channel: 'COMMENT_NOTIFICATION', kind: 'COMMENT', videoId: 'v', commentId: 'c' }))).toBe(true);
});
test('only incoming eligible business messages from others', () => {
  for (const kind of ['LIKE', 'FOLLOW', 'SYSTEM', 'UNKNOWN'] as const)
    expect(isEligible(candidate({ kind, channel: 'COMMENT_NOTIFICATION' }), 'own-1')).toBe(false);
  for (const direction of ['OUTGOING', 'SYSTEM', 'UNKNOWN'] as const)
    expect(isEligible(candidate({ direction }), 'own-1')).toBe(false);
  expect(isEligible(candidate({ actorId: 'own-1' }), 'own-1')).toBe(false);
  expect(isEligible(candidate(), 'own-1')).toBe(true);
});
test('binding includes actual target, original text and date; evidence reference does not change it', () => {
  const e = candidate();
  expect(eventBinding(e)).not.toBe(eventBinding({ ...e, text: 'changed' }));
  expect(eventBinding(e)).not.toBe(eventBinding({ ...e, occurredAt: 'tomorrow' }));
  expect(eventBinding(e)).toBe(eventBinding({ ...e, evidenceId: 'new observation' }));
});
test('draft text validation retains approved whitespace while blocking empty/oversize/control input', () => {
  expect(validText(' reply ')).toBe(' reply ');
  for (const text of ['', '  ', 'a'.repeat(501), 'x\u0000']) expect(() => validText(text)).toThrow('INVALID_TEXT');
});
test('draft line endings are canonicalized before approval without trimming content',()=>{
  expect(validText(' one\r\ntwo\r')).toBe(' one\ntwo\n');
});
test('observation mapping restricts permitted identities and exact work origins independently of send mapping',()=>{
  const base=observedMapping('http://127.0.0.1:12345');
  expect(validateObservationMapping(base,false).purpose).toBe('observation');
  expect(()=>validateObservationMapping(base,true)).toThrow('REAL_MAPPING_REQUIRED');
  const self=structuredClone(base);self.peers[0]!.uid=self.self.uid;
  expect(()=>validateObservationMapping(self,false)).toThrow('OBSERVATION_SELF_AS_PEER');
  const duplicate=structuredClone(base);duplicate.peers.push({...duplicate.peers[0]!});
  expect(()=>validateObservationMapping(duplicate,false)).toThrow('OBSERVATION_PEER_COLLISION');
  const wrongWork=structuredClone(base);wrongWork.works[0]!.url=base.origin+'/video/11';
  expect(()=>validateObservationMapping(wrongWork,false)).toThrow('OBSERVATION_WORK_ID_CONFLICT');
  const outside=structuredClone(base);outside.entryUrl='https://example.com/';
  expect(()=>validateObservationMapping(outside,false)).toThrow('UNSAFE_OBSERVATION_URL');
});

test('native DM reply mapping is explicit and cannot reuse a read-only mapping or an outside origin',()=>{
  const mapping=dmReplyMapping('http://127.0.0.1:12345');
  expect(validateDmReplyMapping(mapping,false).purpose).toBe('dm-reply');
  expect(()=>validateDmReplyMapping(mapping,true)).toThrow('REAL_MAPPING_REQUIRED');
  expect(()=>validateDmReplyMapping(mapping.observation,false)).toThrow();
  const bad=structuredClone(mapping);bad.observation.entryUrl='https://example.com/';
  expect(()=>validateDmReplyMapping(bad,false)).toThrow('UNSAFE_OBSERVATION_URL');
  expect(()=>validateDmReplyMapping({...mapping,submission:'mouse-click'},false)).toThrow();
});
test('direct parent reply mapping cannot enable fixture or nested-level production sends',()=>{
  const mapping=commentReplyMapping('http://127.0.0.1:12345');
  expect(validateCommentReplyMapping(mapping,false).purpose).toBe('comment-reply');
  expect(()=>validateCommentReplyMapping(mapping,true)).toThrow('REAL_MAPPING_REQUIRED');
  expect(()=>validateCommentReplyMapping({...mapping,rootLevel:2},false)).toThrow();
  expect(()=>validateCommentReplyMapping({...mapping,portalWorkIds:['999']},false)).toThrow('COMMENT_PORTAL_WORK_SCOPE_REQUIRED');
  expect(()=>validateCommentReplyMapping({...mapping,portalWorkIds:['10','10']},false)).toThrow('COMMENT_PORTAL_WORK_SCOPE_REQUIRED');
  expect(()=>validateCommentReplyMapping(mapping.observation,false)).toThrow();
});
