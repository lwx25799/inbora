import { expect, test } from 'vitest';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { EventStore } from '../../src/storage/store.js';
import { approved, candidate, database, privateTemp, snapshot } from '../helpers.js';

test.each([false,true])('historical baseline survives a quality-only change (initially unverified: %s)',initiallyUnverified=>{
  const s=database();
  try{
    const old=candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',videoId:'v1',commentId:'c1',occurredAt:'2026-11-02T00:00:00Z'});
    const start=Date.parse('2026-11-03T00:00:00Z');
    s.observe(old.channel,'work:v1',[{...old,...initiallyUnverified?{observationIssue:'COMMENT_TEXT_UNVERIFIED' as const}:{}}],'own-1','fixture',new Date(start+1000).toISOString(),start);
    expect(s.events()[0]!.status).toBe('BASELINE');
    s.observe(old.channel,'work:v1',[{...old,...initiallyUnverified?{}:{observationIssue:'COMMENT_TEXT_UNVERIFIED' as const}}],'own-1','fixture',new Date(start+2000).toISOString(),start);
    expect(s.events()).toHaveLength(1);expect(s.events()[0]!.status).toBe('BASELINE');
  }finally{s.close();}
});

test.each(['INTENT_RECORDED','CONFIRMED','UNCERTAIN'] as const)('quality-only evidence preserves existing %s intent, receipt and approved revision',state=>{
  const s=database();
  try{
    const e=candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',videoId:'v1',commentId:'c1'}),draftId=approved(s,e);
    const intent=s.recordIntent(draftId,snapshot(e),false);
    if(state!=='INTENT_RECORDED')s.receipt(intent,state,'fixture-receipt');
    const before={draft:s.draft(draftId),intents:s.db.prepare('SELECT * FROM send_intents').all(),receipts:s.db.prepare('SELECT * FROM delivery_receipts').all()};
    s.observe(e.channel,'notifications',[{...e,observationIssue:'COMMENT_TEXT_UNVERIFIED'}],'own-1','fixture');
    expect(s.events()[0]!.status).toBe(state);
    expect({draft:s.draft(draftId),intents:s.db.prepare('SELECT * FROM send_intents').all(),receipts:s.db.prepare('SELECT * FROM delivery_receipts').all()}).toEqual(before);
  }finally{s.close();}
});

test('a later unverified comment body revokes prior approval without creating another task or consuming budget',()=>{
  const s=database();
  try{
    const e=candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',videoId:'v1',commentId:'c1'});
    const id=approved(s,e),draft=s.draft(id);
    s.observe(e.channel,'notifications',[{...e,observationIssue:'COMMENT_TEXT_UNVERIFIED'}],'own-1','fixture');
    expect(s.events()).toHaveLength(1);
    expect(s.events()[0]!.status).toBe('MANUAL_REVIEW');
    expect(s.draft(id)).toMatchObject({status:'DRAFT',approval:null});
    expect(()=>s.approve(id,snapshot(e),draft.version,draft.text)).toThrow('NOT_AWAITING_APPROVAL');
    expect(s.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
    expect(s.db.prepare('SELECT used FROM budgets ORDER BY kind').all()).toEqual([{used:0},{used:0}]);
  }finally{s.close();}
});

test('baseline, five observations, duplicate text next date and independent channel/conversation cursors', () => {
  const s = database();
  try {
    expect(s.observe('DIRECT_MESSAGE', 'conversation-1', [candidate()], 'own-1', 'fixture')).toEqual([]);
    const fresh = candidate({ platformEventId: 'new', occurredAt: '2026-11-05T00:00:00Z' });
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
test('the same exact comment found by notification and permitted work remains one task with both observations',()=>{
  const s=database();
  try {
    const comment=candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',videoId:'v1',commentId:'c1',
      discovery:'NOTIFICATION'});
    s.observe(comment.channel,'notifications',[],'own-1','fixture');
    s.observe(comment.channel,'notifications',[comment],'own-1','fixture');
    s.observe(comment.channel,'work:v1',[{...comment,platformEventId:'c1',discovery:'ALLOWED_WORK'}],'own-1','fixture');
    expect(s.events()).toHaveLength(1);
    expect(s.events()[0]!.status).toBe('AWAITING_DRAFT');
    expect(s.db.prepare('SELECT count(*) AS n FROM observations').get()).toEqual({n:3});
    s.observe(comment.channel,'work:v1',[{...comment,platformEventId:'c1',text:'changed',discovery:'ALLOWED_WORK'}],'own-1','fixture');
    expect(s.events()).toHaveLength(1);
    expect(s.events()[0]!.status).toBe('MANUAL_REVIEW');
    expect(s.db.prepare('SELECT count(*) AS n FROM source_collisions').get()).toEqual({n:1});
  } finally {s.close();}
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
test('observed messages without exposed event, conversation or time fields remain three manual records across restart', () => {
  const file = join(privateTemp(), 'poc.sqlite');
  let s = new EventStore(file, true);
  const events = [1, 2, 3].map(n => candidate({
    platformEventId: null, conversationId: null, occurredAt: null, text: `controlled-message-${n}`,
  }));
  try {
    for (let n = 0; n < 5; n++)
      expect(s.observe('DIRECT_MESSAGE', 'verified-peer-observation', events, 'own-1', `fixture-${n}`)).toEqual([]);
    expect(s.events()).toHaveLength(3);
    expect(s.events().every(e => e.status === 'MANUAL_REVIEW' && e.payload.occurredAt === null &&
      e.payload.platformEventId === null && e.payload.conversationId === null)).toBe(true);
    expect(s.db.prepare('SELECT count(*) AS n FROM observations').get()).toEqual({ n: 5 });
    s.close(); s = new EventStore(file);
    expect(s.recover()).toBe(0);
    expect(s.events()).toHaveLength(3);
    for (const event of s.events()) {
      expect(() => s.saveDraft(event.id, 'must not become sendable', 'mock')).toThrow('EVENT_NOT_DRAFTABLE');
      expect(() => s.assertSendable(event.id)).toThrow('EVENT_NOT_APPROVED');
    }
    expect(s.db.prepare('SELECT id FROM send_intents').all()).toEqual([]);
  } finally { s.close(); }
});
test('missing message time remains manual even when all platform identity fields are present', () => {
  const s = database();
  try {
    expect(s.observe('DIRECT_MESSAGE', 'conversation-1', [candidate({ occurredAt: null })], 'own-1', 'fixture')).toEqual([]);
    expect(s.events()).toHaveLength(1);
    expect(s.events()[0]!.status).toBe('MANUAL_REVIEW');
    expect(s.events()[0]!.payload.occurredAt).toBeNull();
    expect(s.history(candidate())).toEqual([]);
    s.observe('DIRECT_MESSAGE', 'conversation-1', [candidate({ platformEventId: 'known-time' })], 'own-1', 'fixture');
    expect(s.history(candidate()).map(e => e.platformEventId)).toEqual(['known-time']);
  } finally { s.close(); }
});
test('indistinguishable weak messages retain their maximum observed occurrence count without inventing platform IDs', () => {
  const file = join(privateTemp(), 'poc.sqlite');
  let s = new EventStore(file, true);
  const message = candidate({ platformEventId: null, conversationId: null, occurredAt: null });
  try {
    for (let n = 0; n < 5; n++) s.observe('DIRECT_MESSAGE', 'verified-peer', [message, message, message], 'own-1', 'fixture');
    expect(s.events()).toHaveLength(1);
    expect(s.events()[0]!.status).toBe('MANUAL_REVIEW');
    expect(s.events()[0]!.payload.platformEventId).toBeNull();
    expect((s.stats().tasks as { maxObservedOccurrences: number }[])[0]!.maxObservedOccurrences).toBe(3);
    s.close(); s = new EventStore(file);
    s.observe('DIRECT_MESSAGE', 'verified-peer', [message, message], 'own-1', 'fixture');
    expect(s.events()).toHaveLength(1);
    expect((s.stats().tasks as { maxObservedOccurrences: number }[])[0]!.maxObservedOccurrences).toBe(3);
    const distinct = { ...message, text: 'one separate weak message' };
    s.observe('DIRECT_MESSAGE', 'verified-peer', [distinct], 'own-1', 'fixture');
    expect((s.stats().tasks as { maxObservedOccurrences: number }[]).map(e => e.maxObservedOccurrences)).toEqual([3, 1]);
    expect(s.db.prepare('SELECT id FROM send_intents').all()).toEqual([]);
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
    const next = approved(s, candidate({ platformEventId: 'next',occurredAt:'2026-11-05T00:00:00Z' }));
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

test('review: later-loaded old history and unorderable timestamps cannot create new reply tasks', () => {
  const s = database();
  try {
    s.observe('DIRECT_MESSAGE','conversation-1',[candidate({occurredAt:'2026-11-04T12:00:00Z'})],'own-1','fixture');
    expect(s.observe('DIRECT_MESSAGE','conversation-1',[candidate({platformEventId:'older',occurredAt:'2020-01-01T00:00:00Z'})],'own-1','fixture')).toEqual([]);
    expect(s.observe('DIRECT_MESSAGE','conversation-1',[candidate({platformEventId:'relative',occurredAt:'三小时前'})],'own-1','fixture')).toEqual([]);
    expect(s.events().filter(e => e.status==='AWAITING_DRAFT')).toHaveLength(0);
  } finally {s.close();}
});

test('review: late arrival newer than initial baseline remains actionable manual review',()=>{
  const s=database();
  try{
    s.observe('DIRECT_MESSAGE','conversation-1',[candidate({occurredAt:'2026-11-04T10:00:00Z'})],'own-1','fixture');
    s.observe('DIRECT_MESSAGE','conversation-1',[candidate({platformEventId:'b',occurredAt:'2026-11-04T10:02:00Z'})],'own-1','fixture');
    expect(s.observe('DIRECT_MESSAGE','conversation-1',[candidate({platformEventId:'a',occurredAt:'2026-11-04T10:01:00Z'})],'own-1','fixture')).toEqual([]);
    const late=s.events().find(e=>e.payload.platformEventId==='a');expect(late?.status).toBe('MANUAL_REVIEW');
    expect(JSON.stringify(s.stats().tasks)).toContain(late!.id);
  }finally{s.close();}
});
