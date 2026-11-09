import { expect, test } from 'vitest';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eventBinding, eventSchema, isStrong, type InboundEvent } from '../../src/core/contracts.js';
import { DeepSeekProvider } from '../../src/ai/deepseek.js';
import { ClientService } from '../../src/app/service.js';
import { BrowserService } from '../../src/app/browser-service.js';
import { defaultSettings } from '../../src/app/contracts.js';
import { migrateClient } from '../../src/storage/client-migration.js';
import { EventStore } from '../../src/storage/store.js';
import { approved, candidate, database, pending, privateTemp, snapshot } from '../helpers.js';

const media = (extra: Partial<InboundEvent> = {}): InboundEvent => ({
  ...candidate(), text: '[图片/表情消息，需人工查看]', observationIssue: 'DM_CONTENT_UNVERIFIED', contentType: 'IMAGE', ...extra,
}) as InboundEvent;
const response = { model: 'deepseek-flash', choices: [{ index: 0, finish_reason: 'stop',
  message: { role: 'assistant', content: 'Synthetic suggestion' } }],
  usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } };

test.each(['IMAGE', 'VIDEO', 'AUDIO', 'MIXED'])('DM content contract retains %s as unverified without changing old bindings', contentType => {
  const parsed = eventSchema.parse({ ...media(), contentType });
  expect(parsed).toMatchObject({ observationIssue: 'DM_CONTENT_UNVERIFIED', contentType });
  expect(isStrong(parsed)).toBe(false);
  expect(eventBinding(candidate())).toBe('bdbe18aef7ee996c8f37d8e8e92837f26bbfe21e0a552e20f559f2f284c69299');
  expect(eventBinding(candidate({ channel: 'COMMENT_NOTIFICATION', kind: 'COMMENT', videoId: 'work-1',
    commentId: 'parent-1', conversationId: null, observationIssue: 'COMMENT_TEXT_UNVERIFIED' })))
    .toBe('27293ad589081ebb735233176ff9a0706bd974734c5b5d46c32576f35f0c1a94');
  expect(eventBinding(parsed)).not.toBe(eventBinding({ ...parsed, contentType: undefined }));
  expect(eventSchema.safeParse({ ...parsed, contentType: 'EMOJI' }).success).toBe(false);
});

test.each([
  { contentType: 'IMAGE', observationIssue: undefined },
  { channel: 'COMMENT_NOTIFICATION', contentType: 'IMAGE', observationIssue: 'DM_CONTENT_UNVERIFIED' },
  { channel: 'COMMENT_NOTIFICATION', observationIssue: 'DM_CONTENT_UNVERIFIED' },
])('DM media metadata rejects an unpaired or cross-channel contract (%j)', fields => {
  expect(eventSchema.safeParse({ ...candidate(), ...fields }).success).toBe(false);
});

test('raw typed content without an issue cannot bypass the provider quality gate', async () => {
  const store = database();
  let calls = 0, reservations = 0;
  const raw = { ...candidate(), contentType: 'IMAGE' } as InboundEvent;
  try {
    const provider = new DeepSeekProvider(async () => { calls++; return new Response(JSON.stringify(response)); });
    const outcome = await provider.generate(store, raw, [], defaultSettings, 'synthetic-key', true, undefined,
      () => { reservations++; }).then(() => 'MODEL_CALLED', error => (error as Error).message);
    expect({ outcome, calls, reservations, budget: store.db.prepare("SELECT used FROM budgets WHERE kind='MODEL'").get() })
      .toEqual({ outcome: 'DM_CONTENT_UNVERIFIED', calls: 0, reservations: 0, budget: { used: 0 } });
    expect(isStrong(raw)).toBe(false);
    expect(store.db.prepare('SELECT count(*) AS n FROM model_calls').get()).toEqual({ n: 0 });
  } finally { store.close(); }
});

test('nontext native IDs deduplicate after restart, while old history remains baseline and new media remains reviewable', () => {
  const file = join(privateTemp('dm-quality-restart-'), 'poc.sqlite'), boundary = Date.parse(candidate().occurredAt!) - 1000;
  let store = new EventStore(file, true);
  const old = media({ platformEventId: 'old-media', occurredAt: new Date(boundary - 1000).toISOString() });
  const fresh = media({ platformEventId: 'fresh-media' });
  try {
    const observedAt = new Date(boundary + 5000).toISOString();
    store.observe('DIRECT_MESSAGE', 'conversation-1', [old, fresh], 'own-1', 'synthetic', observedAt, boundary);
    store.close(); store = new EventStore(file);
    store.observe('DIRECT_MESSAGE', 'conversation-1', [old, fresh], 'own-1', 'synthetic', observedAt, boundary);
    store.recover();
    expect(store.events().map(item => [item.payload.platformEventId, item.status]))
      .toEqual([['old-media', 'BASELINE'], ['fresh-media', 'MANUAL_REVIEW']]);
    expect(store.events().every(item => !isStrong(item.payload))).toBe(true);
    expect(store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({ n: 0 });
  } finally { store.close(); }
});

test('without a Key, a media task can save the explicit human request but cannot send without fresh native proof or reach a provider', async () => {
  const store = database(), root = privateTemp('dm-media-human-');
  let calls = 0;
  const provider = new DeepSeekProvider(async () => { calls++; return new Response(JSON.stringify(response)); });
  let service: ClientService | undefined;
  try {
    pending(store, media());
    const eventId = store.events()[0]!.id;
    await migrateClient(store, join(root, 'client.sqlite'));
    class NoNativeProof extends BrowserService {override async adapter():Promise<never>{throw Error('NATIVE_MEDIA_PROOF_NOT_AVAILABLE');}}
    service = new ClientService(store, new NoNativeProof(root), provider);
    await service.loadSettings();
    const token = service.authority.issueSession(), selectionId = randomUUID();
    await service.dispatch(token, { command: 'setMode', mode: 'MANUAL' });
    const detail = await service.dispatch(token, { command: 'openHumanDialog', eventId, selectionId }) as {
      ownership: { generation: number }; contextVersion: string;
    };
    await service.dispatch(token, { command: 'saveDraft', eventId, generation: detail.ownership.generation,
      expectedVersion: 0, text: 'Saved synthetic human draft', suggestionId: null });
    const commandId=randomUUID();
    expect(await service.dispatch(token, { command: 'sendHumanReply', commandId, input: {
      eventId, generation: detail.ownership.generation, expectedVersion: 1, text: 'Synthetic human text',
      contextVersion: detail.contextVersion, selectionId, suggestionId: null,
    } })).toMatchObject({status:'PREPARING'});
    await service.drain();expect(await service.dispatch(token,{command:'getSendResult',commandId})).toMatchObject({status:'FAILED_BEFORE_CLICK'});
    expect(service.authority.draftFor(eventId)).toMatchObject({ text: 'Synthetic human text', origin:'HUMAN_TYPED',version: 2 });
    expect(calls).toBe(0);
    expect(store.db.prepare('SELECT count(*) AS n FROM manual_send_commands').get()).toEqual({ n: 1 });
    expect(store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({ n: 0 });
    expect(store.db.prepare('SELECT kind,used FROM budgets ORDER BY kind').all())
      .toEqual([{ kind: 'MODEL', used: 0 }, { kind: 'SEND', used: 0 }]);
  } finally { await service?.close(); store.close(); }
});

test.each(['event', 'stored', 'collision', 'history'])('DM content issue in %s blocks model reservation and transport', async source => {
  const store = database();
  let calls = 0, reservations = 0;
  try {
    const clean = candidate(), issue = media({ text: clean.text });
    if (source === 'stored') pending(store, issue);
    if (source === 'collision') {
      pending(store, clean);
      store.observe('DIRECT_MESSAGE', 'conversation-1', [issue], 'own-1', 'synthetic');
    }
    const provider = new DeepSeekProvider(async () => { calls++; return new Response(JSON.stringify(response)); });
    await expect(provider.generate(store, source === 'event' ? issue : clean, source === 'history' ? [issue] : [],
      defaultSettings, 'synthetic-key', true, undefined, () => { reservations++; })).rejects.toThrow('DM_CONTENT_UNVERIFIED');
    expect(calls).toBe(0); expect(reservations).toBe(0);
    expect(store.db.prepare("SELECT used FROM budgets WHERE kind='MODEL'").get()).toEqual({ used: 0 });
    expect(store.db.prepare('SELECT count(*) AS n FROM model_calls').get()).toEqual({ n: 0 });
  } finally { store.close(); }
});

test('a different clean native message is eligible when its bounded context excludes prior media', () => {
  const store = database();
  try {
    pending(store, media());
    const clean = candidate({ platformEventId: 'later-text', occurredAt: '2026-11-04T01:00:01Z' });
    pending(store, clean);
    expect(() => store.assertModelObservation(clean)).not.toThrow();
    expect(() => store.assertModelObservation(media())).toThrow('DM_CONTENT_UNVERIFIED');
    const comment = candidate({ channel: 'COMMENT_NOTIFICATION', kind: 'COMMENT', platformEventId: 'comment-issue',
      videoId: 'work-1', commentId: 'parent-1', observationIssue: 'COMMENT_TEXT_UNVERIFIED' });
    pending(store, comment);
    expect(() => store.assertModelObservation({ ...comment, platformEventId: 'other-comment', observationIssue: undefined }))
      .toThrow('COMMENT_TEXT_UNVERIFIED');
  } finally { store.close(); }
});

test('quality-only media collisions retain historical baseline and an existing intent approval', () => {
  const store = database();
  try {
    const clean = candidate(), draftId = approved(store), eventId = store.draft(draftId).eventId;
    const intentId = store.recordIntent(draftId, snapshot(clean), false);
    store.receipt(intentId, 'UNCERTAIN', 'synthetic-original');
    const before = { event: store.event(eventId), draft: store.draft(draftId), receipt: store.receiptForEvent(eventId),
      intent: store.db.prepare('SELECT * FROM send_intents WHERE id=?').get(intentId) };
    store.observe('DIRECT_MESSAGE', 'conversation-1', [media({ text: clean.text })], 'own-1', 'synthetic');
    expect(store.event(eventId)).toEqual(before.event); expect(store.draft(draftId)).toEqual(before.draft);
    expect(store.receiptForEvent(eventId)).toEqual(before.receipt);
    expect(store.db.prepare('SELECT * FROM send_intents WHERE id=?').get(intentId)).toEqual(before.intent);
    expect(() => store.assertModelObservation(clean)).toThrow('DM_CONTENT_UNVERIFIED');
    const old = candidate({ platformEventId: 'old-text', conversationId: 'historical-conversation' });
    store.observe('DIRECT_MESSAGE', 'historical-conversation', [old], 'own-1', 'synthetic');
    const baseline = store.events().find(item => item.payload.platformEventId === 'old-text')!;
    expect(baseline.status).toBe('BASELINE');
    store.observe('DIRECT_MESSAGE', 'historical-conversation', [media({ ...old, text: old.text })], 'own-1', 'synthetic');
    expect(store.event(baseline.id)).toEqual(baseline);
  } finally { store.close(); }
});
