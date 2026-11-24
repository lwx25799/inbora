import { afterEach, expect, test } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventStore } from '../../src/storage/store.js';
import { migrateClient } from '../../src/storage/client-migration.js';
import { migrateAutomation } from '../../src/storage/automation-migration.js';
import { AutomationStore } from '../../src/storage/automation-store.js';
import { grantConfiguredModel } from '../../src/app/ai-configuration.js';
import { defaultSettings } from '../../src/app/contracts.js';
import { buildReplySystemPrompt, replyStyleRules } from '../../src/ai/reply-style.js';
import { prompt } from '../../src/ai/draft-service.js';
import { candidate, database, privateTemp } from '../helpers.js';

const stores: EventStore[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup(now = () => Date.now()) {
  const root = privateTemp('ai-config-');
  roots.push(root);
  const store = database();
  stores.push(store);
  await migrateClient(store, join(root, 'client.sqlite'));
  await migrateAutomation(store, join(root, 'automation.sqlite'));
  store.bindAccount('own-1');
  const auto = new AutomationStore(store, now);
  auto.initialize(now() - 1000);
  return { store, auto };
}

test('grantConfiguredModel grants on first key save but does not silently re-grant after revocation or expiry', async () => {
  let clock = Date.parse('2026-11-24T00:00:00Z');
  const { store, auto } = await setup(() => clock);
  grantConfiguredModel(store, auto, defaultSettings);
  const first = auto.active('MODEL');
  expect(first?.scope).toMatchObject({
    ownId: 'own-1',
    channels: ['COMMENT_NOTIFICATION', 'DIRECT_MESSAGE'],
    model: defaultSettings.model,
    expiresAt: null,
  });

  // After explicit revocation, saving a key again must not silently restore a full-channel MODEL grant.
  auto.revoke('MODEL');
  expect(auto.active('MODEL')).toBeNull();
  grantConfiguredModel(store, auto, defaultSettings);
  expect(auto.active('MODEL')).toBeNull();

  // An expired prior MODEL grant must also not be silently replaced by an indefinite grant on key save.
  const second = await setup(() => clock);
  second.auto.grant('MODEL', {
    ownId: 'own-1',
    channels: ['DIRECT_MESSAGE'],
    model: defaultSettings.model,
    modelLimit: 5,
    expiresAt: clock + 1000,
  });
  clock += 2000;
  expect(second.auto.active('MODEL')).toBeNull();
  grantConfiguredModel(second.store, second.auto, defaultSettings);
  expect(second.auto.active('MODEL')).toBeNull();

  // Explicit revocation before any grant also prevents silent auto-grant on subsequent key save.
  const third = await setup(() => clock);
  third.auto.revoke('MODEL');
  grantConfiguredModel(third.store, third.auto, defaultSettings);
  expect(third.auto.active('MODEL')).toBeNull();
});

test('grantConfiguredModel never silently grants MODEL after AUTO_REPLY revocation or expiry', async () => {
  let clock = Date.parse('2026-11-24T00:00:00Z');
  const replyPolicy = {
    ownId: 'own-1',
    model: defaultSettings.model,
    channels: ['DIRECT_MESSAGE' as const],
    modelLimit: 5,
    sendLimit: 5,
    expiresAt: null as number | null,
    workIds: [],
    futureOwnWorks: false,
    conversationIds: ['conversation-1'],
    entireInbox: false,
    containsAny: [],
    excludesAny: [],
    instructions: '简短礼貌',
    startHour: 0,
    endHour: 24,
  };

  // Case 1: AUTO_REPLY granted then explicitly revoked (never had a MODEL grant) -> saving key must not grant MODEL.
  const revokedAuto = await setup(() => clock);
  revokedAuto.auto.grant('AUTO_REPLY', replyPolicy);
  grantConfiguredModel(revokedAuto.store, revokedAuto.auto, defaultSettings);
  expect(revokedAuto.auto.active('MODEL')).toBeNull();
  revokedAuto.auto.revoke('AUTO_REPLY');
  expect(revokedAuto.auto.active('AUTO_REPLY')).toBeNull();
  grantConfiguredModel(revokedAuto.store, revokedAuto.auto, defaultSettings);
  expect(revokedAuto.auto.active('MODEL')).toBeNull();

  // Case 2: AUTO_REPLY granted with expiry and expired naturally -> saving key must not grant indefinite MODEL.
  const expiredAuto = await setup(() => clock);
  expiredAuto.auto.grant('AUTO_REPLY', { ...replyPolicy, expiresAt: clock + 1000 });
  clock += 2000;
  expect(expiredAuto.auto.active('AUTO_REPLY')).toBeNull();
  grantConfiguredModel(expiredAuto.store, expiredAuto.auto, defaultSettings);
  expect(expiredAuto.auto.active('MODEL')).toBeNull();

  // Case 3: AUTO_REPLY explicitly revoked before any grant -> audit record alone blocks silent MODEL grant.
  const preRevokedAuto = await setup(() => clock);
  preRevokedAuto.auto.revoke('AUTO_REPLY');
  grantConfiguredModel(preRevokedAuto.store, preRevokedAuto.auto, defaultSettings);
  expect(preRevokedAuto.auto.active('MODEL')).toBeNull();
});

test('formal reply and sandbox tryReply share the same style rules and omit model id from system settings', () => {
  const settings = {
    persona: '自然简洁',
    business: '生鲜商品不支持无理由退款',
    rules: '遇到投诉请引导人工客服',
  };
  const formal = buildReplySystemPrompt({ baseSystem: prompt(candidate(), []).system, settings });
  const sandbox = buildReplySystemPrompt({ sandbox: true, settings });
  expect(formal).toContain(replyStyleRules);
  expect(sandbox).toContain(replyStyleRules);
  expect(formal).toContain(settings.business);
  expect(sandbox).toContain(settings.business);
  expect(sandbox).toContain('隔离试聊');
  expect(formal).not.toContain('deepseek-flash');
  expect(sandbox).not.toContain('deepseek-flash');
});
