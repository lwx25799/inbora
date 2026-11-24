import { expect, test } from 'vitest';
import { accountIdSchema, DEFAULT_ACCOUNT_ID, eventBinding, eventSchema } from '../../src/core/contracts.js';
import { candidate } from '../helpers.js';

test('the account contract accepts a safe ID and never normalizes it', () => {
  expect(DEFAULT_ACCOUNT_ID).toBe('account_001');
  const next = candidate({ accountId: 'account-web_002' });
  expect(accountIdSchema.parse(next.accountId)).toBe(next.accountId);
  expect(eventSchema.parse(next).accountId).toBe(next.accountId);
  for (const accountId of ['', ' ', '../other', 'x:y', 'a/b', 'a\\b', 'a\n', ' a', 'a'.repeat(129), null]) {
    expect(accountIdSchema.safeParse(accountId).success, String(accountId)).toBe(false);
    expect(eventSchema.safeParse({ ...next, accountId }).success).toBe(false);
  }
});

test('legacy bindings are byte-for-byte stable for ordinary, media and nested events', () => {
  const message = candidate();
  expect(eventBinding(message)).toBe('bdbe18aef7ee996c8f37d8e8e92837f26bbfe21e0a552e20f559f2f284c69299');
  expect(eventBinding(candidate({ observationIssue: 'DM_CONTENT_UNVERIFIED', contentType: 'IMAGE' })))
    .toBe('fba6bda6053bbbe63b98d4e0ce8e7d61ff0744be9faa472781fc9116cca9cddb');
  expect(eventBinding(candidate({ channel: 'COMMENT_NOTIFICATION', kind: 'REPLY', videoId: '9', commentId: '12',
    conversationId: null, rootCommentId: '10', replyToCommentId: '12' })))
    .toBe('0889e6e58284caab94c7a585a5793b0ba0d96e66dcd45073e9b8ee7ba09e2932');
  expect(eventBinding({ ...message, accountId: 'account_002' })).not.toBe(eventBinding(message));
});
