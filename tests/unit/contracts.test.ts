import { expect, test } from 'vitest';
import { eventBinding, isEligible, isStrong, validText } from '../../src/core/contracts.js';
import { candidate } from '../helpers.js';

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
