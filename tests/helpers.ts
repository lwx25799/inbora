import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EventStore } from '../src/storage/store.js';
import { eventBinding, targetKey, type InboundEvent, type TargetSnapshot } from '../src/core/contracts.js';

export function privateTemp(prefix = 'test-'): string {
  const base = resolve('.local/tests'); mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}
export function candidate(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    accountId: 'account_001', channel: 'DIRECT_MESSAGE', platformEventId: 'message-1',
    actorId: 'peer-1', actorName: 'Fixture peer', text: 'hello', occurredAt: '2026-11-04T01:00:00Z',
    videoId: null, commentId: null, conversationId: 'conversation-1', direction: 'INCOMING',
    kind: 'DM', evidenceId: 'synthetic-fixture', ...overrides,
  };
}
export function snapshot(e: InboundEvent): TargetSnapshot {
  return { accountId: e.accountId, ownId: 'own-1', targetKey: targetKey(e), eventBinding: eventBinding(e),
    contextDigest: 'context-1', composerKey: targetKey(e), mappingDigest: 'fixture' };
}
export function database(): EventStore { return new EventStore(join(privateTemp(), 'poc.sqlite'), true, () => '2026-11-03T00:00:00Z'); }
export function pending(store: EventStore, e = candidate()): string {
  const scope = e.channel === 'DIRECT_MESSAGE' ? e.conversationId! : 'notifications';
  store.observe(e.channel, scope, [], 'own-1', 'fixture',new Date(Date.parse(e.occurredAt)-1000).toISOString());
  return store.observe(e.channel, scope, [e], 'own-1', 'fixture')[0]!;
}
export function approved(store: EventStore, e = candidate()): string {
  const d = store.saveDraft(pending(store, e), 'approved fixture reply', 'mock');
  store.approve(d.id, snapshot(e), d.version, d.text);
  return d.id;
}
