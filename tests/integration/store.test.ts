import { expect, test } from 'vitest';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { EventStore } from '../../src/storage/store.js';
import { approved, candidate, database, privateTemp, snapshot } from '../helpers.js';

test('baseline, five observations, duplicate text next date and independent channel/conversation cursors', () => {
  const s = database();
  try {
    expect(s.observe('DIRECT_MESSAGE', 'conversation-1', [candidate()], 'own-1', 'fixture')).toEqual([]);
    const fresh = candidate({ platformEventId: 'new', occurredAt: '2026-11-05' });
    for (let i = 0; i < 5; i++) s.observe('DIRECT_MESSAGE', 'conversation-1', [fresh], 'own-1', 'fixture');
    expect(s.events()).toHaveLength(2);
    expect(s.events().map(e => e.status)).toEqual(['BASELINE', 'AWAITING_DRAFT']);
    expect(s.observe('DIRECT_MESSAGE', 'conversation-2', [candidate({ conversationId: 'conversation-2', platformEventId: 'b' })], 'own-1', 'fixture')).toEqual([]);
    expect((s.db.prepare('SELECT count(*) AS n FROM observations').get() as { n: number }).n).toBe(7);
  } finally { s.close(); }
});
test('same-body notifications from different people and videos remain separate', () => {
  const s = database();
  try {
    const e = candidate({ channel: 'COMMENT_NOTIFICATION', kind: 'COMMENT', videoId: 'v1', commentId: 'c1' });
    s.observe(e.channel, 'notifications', [], 'own-1', 'fixture');
    const ids = s.observe(e.channel, 'notifications', [e, { ...e, actorId: 'peer-2', commentId: 'c2', platformEventId: 'n2' },
      { ...e, videoId: 'v2', commentId: 'c3', platformEventId: 'n3' }], 'own-1', 'fixture');
    expect(ids).toHaveLength(3);
  } finally { s.close(); }
});
test('three incoming messages are preserved; own/system messages never become tasks', () => {
  const s = database();
  try {
    s.observe('DIRECT_MESSAGE', 'conversation-1', [], 'own-1', 'fixture');
    expect(s.observe('DIRECT_MESSAGE', 'conversation-1', [candidate(), candidate({ platformEventId: '2' }), candidate({ platformEventId: '3' }),
      candidate({ platformEventId: '4', direction: 'OUTGOING' }), candidate({ platformEventId: '5', kind: 'SYSTEM' })], 'own-1', 'fixture')).toHaveLength(3);
    expect(s.events()).toHaveLength(3);
  } finally { s.close(); }
});
test('source collision and weak key are manual review, invalidating existing approval', () => {
  const s = database();
  try {
    const id = approved(s);
    s.observe('DIRECT_MESSAGE', 'conversation-1', [candidate({ text: 'edited' })], 'own-1', 'fixture');
    expect(s.event(s.draft(id).eventId).status).toBe('MANUAL_REVIEW');
    expect(s.draft(id).approval).toBeNull();
    expect(s.observe('DIRECT_MESSAGE', 'conversation-1', [candidate({ platformEventId: null })], 'own-1', 'fixture')).toEqual([]);
  } finally { s.close(); }
});
test('edit invalidates approval; reject and account mismatch block sends', () => {
  const s = database();
  try {
    const id = approved(s); const d = s.draft(id);
    const edited = s.saveDraft(d.eventId, 'new approved version needed', 'manual');
    expect(edited.version).toBe(2); expect(edited.approval).toBeNull();
    expect(() => s.recordIntent(id, snapshot(candidate()), false)).toThrow('EVENT_NOT_APPROVED');
    expect(() => s.approve(id, snapshot(candidate()), 1, d.text)).toThrow('DRAFT_CHANGED');
    expect(() => s.bindAccount('other-account')).toThrow('ACCOUNT_CHANGED');
    s.reject(id); expect(s.event(d.eventId).status).toBe('REJECTED');
  } finally { s.close(); }
});
test('committed intent survives restart as uncertain, freezing all later tasks on target', () => {
  const file = join(privateTemp(), 'poc.sqlite'); let s = new EventStore(file, true);
  const draft = approved(s); s.recordIntent(draft, snapshot(candidate()), true); s.close();
  s = new EventStore(file);
  try {
    expect(s.recover()).toBe(1); expect(s.recover()).toBe(0); expect(s.uncertain()).toHaveLength(1);
    const next = approved(s, candidate({ platformEventId: 'next' }));
    expect(() => s.assertSendable(s.draft(next).eventId)).toThrow('TARGET_FROZEN');
    expect((s.db.prepare("SELECT used FROM budgets WHERE kind='SEND'").get() as { used: number }).used).toBe(1);
  } finally { s.close(); }
});
test('budget hard limits are durable; failed transaction cannot consume a send', () => {
  const s = database();
  try {
    for (let n = 0; n < 50; n++) s.consumeBudget('MODEL');
    expect(() => s.consumeBudget('MODEL')).toThrow('BUDGET_EXHAUSTED');
    s.db.prepare("UPDATE budgets SET used=20 WHERE kind='SEND'").run();
    const d = approved(s);
    expect(() => s.recordIntent(d, snapshot(candidate()), true)).toThrow('BUDGET_EXHAUSTED');
    expect(s.db.prepare('SELECT id FROM send_intents').all()).toHaveLength(0);
  } finally { s.close(); }
});
test('missing, corrupt and read-only databases fail closed without rebuilding', () => {
  const dir = privateTemp(); const file = join(dir, 'corrupt.sqlite'); writeFileSync(file, 'not sqlite');
  expect(() => new EventStore(file)).toThrow();
  expect(() => new EventStore(join(dir, 'missing.sqlite'))).toThrow('DATABASE_MISSING_USE_INIT');
  const s = database();
  try {
    const id = approved(s); s.db.pragma('query_only=ON');
    expect(() => s.recordIntent(id, snapshot(candidate()), true)).toThrow();
    expect(s.db.prepare('SELECT * FROM send_intents').all()).toHaveLength(0);
  } finally { s.close(); }
});
test('pause persists and prevents a previously approved task', () => {
  const s = database();
  try {
    const d = approved(s); s.pause('dm:conversation-1', true);
    expect(() => s.assertSendable(s.draft(d).eventId)).toThrow('TARGET_PAUSED');
  } finally { s.close(); }
});
