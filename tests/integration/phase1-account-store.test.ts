import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { DEFAULT_ACCOUNT_ID, eventBinding } from '../../src/core/contracts.js';
import { migrateClient } from '../../src/storage/client-migration.js';
import { EventStore } from '../../src/storage/store.js';
import { InboxProjection } from '../../src/app/inbox-projection.js';
import { candidate, pending, privateTemp } from '../helpers.js';

test('SQLite accepts only the legacy account and rejects another scope before touching disk', async () => {
  const root = privateTemp('phase1-account-');
  const file = join(root, 'events.sqlite');
  let store: EventStore | undefined;
  try {
    expect(() => new EventStore(file, true, undefined, 'account_002').close()).toThrow('ACCOUNT_UNSUPPORTED_SCHEMA3');
    expect(existsSync(file)).toBe(false);
    const accountStore = new EventStore(file, true, undefined, DEFAULT_ACCOUNT_ID);
    store = accountStore;
    expect(store.db.pragma('user_version', { simple: true })).toBe(2);
    await migrateClient(store, join(root, 'v2.sqlite'));
    expect(store.db.pragma('user_version', { simple: true })).toBe(3);
    expect(store.db.prepare("SELECT sql FROM sqlite_master WHERE name='accounts'").get()).toEqual({
      sql: "CREATE TABLE accounts (id TEXT PRIMARY KEY CHECK(id='account_001'), own_id TEXT NOT NULL)",
    });
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name='legacy_target_aliases'").get()).toBeUndefined();
    expect(() => accountStore.db.prepare('INSERT INTO accounts VALUES (?, ?)').run('account_002', 'other')).toThrow('CHECK constraint failed');

    expect(store.accountId).toBe(DEFAULT_ACCOUNT_ID);
    store.bindAccount(DEFAULT_ACCOUNT_ID, 'synthetic-owner');
    expect(store.accountOwnId(DEFAULT_ACCOUNT_ID)).toBe('synthetic-owner');
    expect(() => accountStore.bindAccount('account_002', 'synthetic-owner')).toThrow('ACCOUNT_CHANGED');
    expect(() => accountStore.bindAccount(DEFAULT_ACCOUNT_ID, 'other-owner')).toThrow('ACCOUNT_CHANGED');
    expect(store.db.prepare('SELECT id, own_id FROM accounts').all()).toEqual([{ id: DEFAULT_ACCOUNT_ID, own_id: 'synthetic-owner' }]);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a foreign payload cannot be projected as a local inbox item even when its row is mislabelled', () => {
  const root = privateTemp('phase1-payload-'), store = new EventStore(join(root, 'events.sqlite'), true);
  try {
    const event = candidate(), id = pending(store, event);
    store.db.prepare('UPDATE inbound_events SET payload=? WHERE id=?').run(JSON.stringify({ ...event, accountId: 'account_002' }), id);
    expect(() => store.event(id)).toThrow('ACCOUNT_CHANGED');
    expect(() => new InboxProjection(store)).toThrow('ACCOUNT_CHANGED');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a batch from another account rolls back without creating a cursor or changing the original binding', () => {
  const root = privateTemp('phase1-batch-'), store = new EventStore(join(root, 'events.sqlite'), true);
  const message = candidate();
  try {
    expect(() => store.observe(message.channel, message.conversationId!, [message, { ...message, accountId: 'account_002' }],
      'own-1', 'synthetic', '2026-11-04T01:00:00Z')).toThrow('ACCOUNT_CHANGED');
    expect(store.db.prepare('SELECT id FROM accounts').all()).toEqual([]);
    expect(store.db.prepare('SELECT id FROM observations').all()).toEqual([]);
    expect(store.db.prepare('SELECT scope FROM cursors').all()).toEqual([]);
    store.observe(message.channel, message.conversationId!, [message], 'own-1', 'synthetic', '2026-11-04T01:00:00Z');
    expect(store.events()).toMatchObject([{ payload: { accountId: DEFAULT_ACCOUNT_ID }, binding: eventBinding(message), status: 'BASELINE' }]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([undefined, null, 100, '', '  '])('an invalid explicit native owner (%s) cannot bind an account', identity => {
  const root = privateTemp('phase1-invalid-owner-'), store = new EventStore(join(root, 'events.sqlite'), true);
  try {
    expect(() => store.bindAccount(DEFAULT_ACCOUNT_ID, identity as string)).toThrow('ACCOUNT_REQUIRED');
    expect(store.accountOwnId()).toBeUndefined();
    store.bindAccount('synthetic-owner');
    expect(store.accountOwnId()).toBe('synthetic-owner');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
