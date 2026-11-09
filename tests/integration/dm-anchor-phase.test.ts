import { expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { BrowserProfileOwner } from '../../src/browser/profile-owner.js';
import { AccountActor } from '../../src/browser/account-actor.js';
import { InboxCollector } from '../../src/app/inbox-collector.js';
import { ObservedReader, type ObservationBatch } from '../../src/adapters/observed-reader.js';
import { AutomationStore } from '../../src/storage/automation-store.js';
import { migrateClient } from '../../src/storage/client-migration.js';
import { migrateAutomation } from '../../src/storage/automation-migration.js';
import { candidate, database, privateTemp } from '../helpers.js';
import { observedMapping } from '../fixtures/observed-site.js';

test('a changed-height MAX probe keeps its physical phase and scans the gap before marking a conversation read', async () => {
  const root = privateTemp('dm-anchor-phase-'), store = database(), origin = Date.now() - 60_000;
  await migrateClient(store, join(root, 'client.sqlite'));
  await migrateAutomation(store, join(root, 'automation.sqlite'));
  const data = new AutomationStore(store);
  data.initialize(origin);
  store.bindAccount('100');
  data.configureCollection({ ownId: '100', comments: false, inbox: true,
    commentIntervalMs: 30_000, dmIntervalMs: 15_000 });
  const peer = { uid: '200', secUid: 'peer-sec', conversationId: 'conv-a', title: 'Fixture peer' };
  store.db.prepare(`INSERT INTO discovered_conversations(id,own_id,uid,sec_uid,title,first_seen,last_seen)
    VALUES(?,?,?,?,?,?,?)`).run('conv-a', '100', '200', 'peer-sec', peer.title, origin, origin);
  const event = (id: string, at: number) => candidate({ platformEventId: id, actorId: '200',
    conversationId: 'conv-a', occurredAt: new Date(at).toISOString() });
  const old = event('1', origin - 10_000), middle = event('102', origin + 2000), latest = event('104', origin + 5000);
  const batch = (top: number): ObservationBatch => ({
    events: [top === 0 ? old : top >= 504 ? latest : middle],
    evidenceId: 'synthetic-anchor-phase', unsupported: 0, loaded: 1,
    bindings: [{ targetKey: 'dm:conv-a', uid: '200', secUid: 'peer-sec', title: peer.title, conversationId: 'conv-a' }],
    dmViewport: { top, height: 648, viewport: 144, minimum: 0, maximum: 504 },
  });
  // The previous 600px list proved an old MIN endpoint and was about to probe MAX.
  // New native content grows it to 648px; neither the old edge count nor MIN proof remains valid.
  store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='dm'").run(JSON.stringify({
    deferred: [], parked: [], recent: ['conv-a'], burst: 0,
    sweep: { peer, phase: 'PROBE_MAX', top: 456, height: 600, signature: 'old-endpoint',
      edge: 0, legHasNew: false, minimumOld: true, anchor: { top: 0, height: 600, ids: ['1'] } },
  }));
  const reads: number[] = [];
  // Only the native reader transport is replaced. Selection, resumption, persistence,
  // phase transitions, FIFO and successful-read bookkeeping all run in the real collector.
  const window = vi.spyOn(ObservedReader.prototype, 'dmWindow').mockImplementation(async (_peer, top) => {
    const actualTop = top ?? 504;
    reads.push(actualTop);
    return batch(actualTop);
  });
  const scroll = vi.spyOn(ObservedReader.prototype, 'scrollDm').mockResolvedValue();
  const list = vi.spyOn(ObservedReader.prototype, 'conversations').mockResolvedValue({
    events: [], evidenceId: 'synthetic-anchor-list', unsupported: 0, loaded: 1, peers: [peer],
  });
  const owner = { notification: new EventEmitter(), dm: {bringToFront:async()=>{}}, actor: new AccountActor(),
    version: () => '1.0.0.0' } as unknown as BrowserProfileOwner;
  const collector = new InboxCollector(owner, observedMapping('http://127.0.0.1:1234'), data, root, 'headless');
  const progress = () => JSON.parse((store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='dm'")
    .get() as { cursor_json: string }).cursor_json) as {
      sweep?: { phase: string; minimumOld: boolean }; parked: { peer: { conversationId: string }; phase: string }[];
    };
  try {
    const signal = new AbortController().signal;
    await collector.collect('dm', signal);
    expect(progress().sweep).toMatchObject({ phase: 'MIN', minimumOld: false });
    expect(reads).toEqual([504, 0, 504]);
    await collector.collect('dm', signal);
    await collector.collect('dm', signal);
    expect(reads).toContain(389); // 504 - floor(144 * 0.8): forward from the actual MAX window towards MIN.
    expect(store.events().some(item => item.payload.platformEventId === '102')).toBe(true);
    expect(store.events().find(item => item.payload.platformEventId === '1')?.status).toBe('BASELINE');
    expect(store.db.prepare("SELECT last_read FROM discovered_conversations WHERE id='conv-a'").get())
      .toEqual({ last_read: 0 });
    expect(progress().sweep?.phase ?? progress().parked.find(item => item.peer.conversationId === 'conv-a')?.phase)
      .toBe('MIN');
    expect(data.state().startedAt).toBe(origin);
    expect(store.db.prepare('SELECT kind,used FROM budgets ORDER BY kind').all())
      .toEqual([{ kind: 'MODEL', used: 0 }, { kind: 'SEND', used: 0 }]);
    expect(store.db.prepare('SELECT count(*) AS n FROM model_calls').get()).toEqual({ n: 0 });
    expect(store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({ n: 0 });
  } finally {
    window.mockRestore(); scroll.mockRestore(); list.mockRestore(); collector.dispose(); store.close();
  }
});
