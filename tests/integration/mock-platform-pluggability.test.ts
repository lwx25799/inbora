import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { DeepSeekProvider } from '../../src/ai/deepseek.js';
import { WorkbenchAuthority } from '../../src/app/authority.js';
import { BrowserService } from '../../src/app/browser-service.js';
import { ModelCredentialStore } from '../../src/app/credentials.js';
import { ModelProviderController } from '../../src/app/model-provider-controller.js';
import { ModelRouteGuard } from '../../src/app/model-route-guard.js';
import { generateSuggestion } from '../../src/app/suggestion-generation.js';
import { defaultSettings } from '../../src/contracts/client.js';
import { targetKey, type InboundEvent } from '../../src/core/contracts.js';
import { SendCoordinator } from '../../src/core/send-coordinator.js';
import { DouyinPlatformConnector } from '../../src/platform/douyin-platform-connector.js';
import { MockPlatformConnector } from '../../src/platform/mock-platform-connector.js';
import { PlatformConnectorRegistry } from '../../src/platform/platform-connector-registry.js';
import { migrateAutomation } from '../../src/storage/automation-migration.js';
import { AutomationStore } from '../../src/storage/automation-store.js';
import { migrateClient } from '../../src/storage/client-migration.js';
import { migrateLocalAssistant } from '../../src/storage/local-assistant-migration.js';
import { migrateModelProviders } from '../../src/storage/model-provider-migration.js';
import { ModelProviderStore } from '../../src/storage/model-provider-store.js';
import { EventStore } from '../../src/storage/store.js';
import { candidate, privateTemp } from '../helpers.js';
import { chatAnswer } from '../model-provider-helpers.js';

async function withFixture(use: (data: ReturnType<typeof fixture>) => Promise<void>) {
  const data = fixture();
  try { await use(data); }
  finally {
    await data.mock.close();
    data.store.close();
    await rm(data.root, { recursive: true, force: true });
  }
}

function fixture() {
  const root = privateTemp('wave31c-mock-');
  const store = new EventStore(join(root, 'synthetic.sqlite'), true);
  const mock = new MockPlatformConnector({ accountId: store.accountId, ownId: 'mock-own' });
  return { root, store, mock, coordinator: new SendCoordinator(store, mock.actor) };
}

async function observe({ store, mock }: ReturnType<typeof fixture>, overrides: Partial<InboundEvent> = {}) {
  const input = candidate({ platformEventId: randomUUID(), ...overrides });
  mock.inject(input);
  const { newEventIds } = await mock.observe(store, input.channel === 'DIRECT_MESSAGE' ? 'dm' : 'notifications');
  expect(newEventIds).toHaveLength(1);
  return store.event(newEventIds[0]!);
}

function intents(store: EventStore): number {
  return Number(store.db.prepare('SELECT count(*) FROM send_intents').pluck().get());
}

test('registry resolves by the exact platform and account pair', () => {
  const registry = new PlatformConnectorRegistry();
  const mock = new MockPlatformConnector();
  const second = new MockPlatformConnector({ accountId: 'account_002' });
  const douyin = new DouyinPlatformConnector(new BrowserService('synthetic'));
  for (const connector of [mock, second, douyin]) registry.register(connector);
  expect(registry.resolve(mock.platformId, mock.accountId)).toBe(mock);
  expect(registry.resolve(mock.platformId, second.accountId)).toBe(second);
  expect(registry.resolve(douyin.platformId, mock.accountId)).toBe(douyin);
  expect(() => registry.resolve(douyin.platformId, second.accountId)).toThrow('PLATFORM_CONNECTOR_NOT_FOUND');
  expect(() => registry.register(new MockPlatformConnector())).toThrow('PLATFORM_CONNECTOR_ALREADY_REGISTERED');
  expect(mock.capabilities).toEqual({ channels: ['COMMENT_NOTIFICATION', 'DIRECT_MESSAGE'], loginRecovery: false,
    manualSecurityRecovery: false, preview: false, readback: true });
});

test('mock inbound DM and comment each produce a persisted intent and a confirmed receipt through Core', async () => {
  await withFixture(async data => {
    const { store, mock, coordinator } = data;
    const inputs: Partial<InboundEvent>[] = [{ accountId: 'another_account' }, { channel: 'COMMENT_NOTIFICATION', kind: 'COMMENT',
      conversationId: null, videoId: 'video-1', commentId: 'comment-1' }];
    for (const [index, input] of inputs.entries()) {
      const event = await observe(data, input);
      expect(event.payload.accountId).toBe(store.accountId);
      expect(store.accountOwnId()).toBe('mock-own');
      const draft = store.saveDraft(event.id, 'Synthetic reply', 'mock');
      const { adapter, dispose } = await mock.adapter(event.payload, store);
      try {
        const target = await adapter.inspect(event.payload);
        expect(target).toMatchObject({ accountId: mock.accountId, ownId: 'mock-own', eventBinding: event.binding, targetKey: targetKey(event.payload) });
        store.approve(draft.id, target, draft.version, draft.text);
        await adapter.prepare(event.payload, draft.text);
        await expect(adapter.clickOnce(new Date().toISOString(), () => {})).rejects.toThrow('INTENT_BINDING_CHANGED');
        expect(mock.clickCount).toBe(index);
        await adapter.cancelPreparation?.(event.payload, draft.text);
        const click = adapter.clickOnce.bind(adapter);
        const wrapped = { ...adapter, clickOnce: async (...args: Parameters<typeof click>) => {
          expect(store.event(event.id).status).toBe('INTENT_RECORDED');
          expect(intents(store)).toBe(index + 1);
          await click(...args);
        } };
        expect(await coordinator.send(draft.id, wrapped, false)).toBe('CONFIRMED');
        expect(mock.clickCount).toBe(index + 1);
        expect(store.receiptForEvent(event.id)).toMatchObject({ result: 'CONFIRMED', proof_ref: expect.stringMatching(/^[a-f0-9]{64}$/u) });
      } finally { await dispose(); }
    }
  });
});

test.each(['web draft', 'same-text web draft', 'account drift'])('a changed %s is blocked before intent or click', async fault => {
  await withFixture(async data => {
    const { store, mock, coordinator } = data;
    const event = await observe(data);
    const draft = store.saveDraft(event.id, 'Approved reply', 'mock');
    const { adapter } = await mock.adapter(event.payload);
    store.approve(draft.id, await adapter.inspect(event.payload), draft.version, draft.text);
    if (fault === 'account drift') mock.simulateAccountDrift();
    else mock.setWebDraft(targetKey(event.payload), fault === 'same-text web draft' ? draft.text : 'Human text');
    const error = fault === 'account drift' ? 'NATIVE_REPLY_ACCOUNT_CHANGED' : 'NATIVE_REPLY_EXISTING_DRAFT';
    await expect(adapter.prepare(event.payload, draft.text)).rejects.toThrow(error);
    await expect(coordinator.send(draft.id, adapter, false)).rejects.toThrow(error);
    expect(intents(store)).toBe(0);
    expect(mock.clickCount).toBe(0);
    await expect(adapter.inspect(event.payload)).rejects.toThrow(error);
  });
});

test.each(['missing readback', 'click error'])('UNCERTAIN from %s freezes the target across drafts', async fault => {
  await withFixture(async data => {
    const { store, mock, coordinator } = data;
    mock.inject(candidate());
    mock.inject(candidate({ platformEventId: 'message-2', occurredAt: '2026-11-04T01:00:01Z' }));
    const { newEventIds } = await mock.observe(store, 'dm');
    expect(newEventIds).toHaveLength(2);
    const first = store.event(newEventIds[0]!);
    const next = store.event(newEventIds[1]!);
    const draft = store.saveDraft(first.id, 'Uncertain reply', 'mock');
    const { adapter } = await mock.adapter(first.payload);
    store.approve(draft.id, await adapter.inspect(first.payload), draft.version, draft.text);
    if (fault === 'missing readback') mock.hideNextReadback = true;
    else mock.failNextClickOnce = true;
    expect(await coordinator.send(draft.id, adapter, false)).toBe('UNCERTAIN');
    expect(store.receiptForEvent(first.id)).toMatchObject({ result: 'UNCERTAIN' });
    expect(mock.clickCount).toBe(1);

    const nextDraft = store.saveDraft(next.id, 'Different draft on the same target', 'mock');
    const nextHandle = await mock.adapter(next.payload);
    store.approve(nextDraft.id, await nextHandle.adapter.inspect(next.payload), nextDraft.version, nextDraft.text);
    await expect(coordinator.send(nextDraft.id, nextHandle.adapter, false)).rejects.toThrow('TARGET_FROZEN');
    expect(intents(store)).toBe(1);
    expect(mock.clickCount).toBe(1);
  });
});

test('Phase 2 routes a generated draft to human approval and only Core dispatches it', async () => {
  await withFixture(async data => {
    const { root, store, mock, coordinator } = data;
    await migrateClient(store, join(root, 'synthetic-backup.sqlite'));
    await migrateAutomation(store, join(root, 'synthetic-automation-backup.sqlite'));
    await migrateLocalAssistant(store, join(root, 'synthetic-assistant-backup.sqlite'));
    await migrateModelProviders(store, root);
    const event = await observe(data);
    const automation = new AutomationStore(store);
    automation.initialize(Date.now());
    const models = new ModelProviderStore(store.db);
    const guard = new ModelRouteGuard(models, automation);
    const workbench = new WorkbenchAuthority(store);
    workbench.modelRoute = guard;
    const token = workbench.issueSession();
    workbench.setMode(token, 'AI_ASSISTED');
    const { generation } = workbench.claim(token, event.id, 0);
    const transport = vi.fn<typeof fetch>(async () => {
      expect(intents(store)).toBe(0);
      expect(mock.clickCount).toBe(0);
      return chatAnswer('Synthetic model draft.', defaultSettings.model);
    });
    const controller = new ModelProviderController(guard, new ModelCredentialStore(root), transport, () => {});
    try {
      const { selection } = guard.current();
      const connection = models.requireConnection(selection.connectionId!);
      const allowModelConfig = () => { workbench.operator(token, 'CONTROL'); };
      await controller.dispatch({ command: 'modelProviders', action: 'setKey', connectionId: connection.id,
        expectedVersion: connection.version, key: 'synthetic-model-key', storage: 'MEMORY' }, allowModelConfig);
      await controller.dispatch({ command: 'modelProviders', action: 'apply', connectionId: connection.id,
        routeRevision: models.requireConnection(connection.id).draftRevision, modelId: defaultSettings.model,
        expectedSelectionRevision: selection.selectionRevision, commandId: randomUUID(), confirmed: true }, allowModelConfig);
      automation.grant('MODEL', { ownId: 'mock-own', channels: ['DIRECT_MESSAGE'], model: defaultSettings.model,
        modelLimit: 1, expiresAt: null });
      const suggested = await generateSuggestion({ store, authority: workbench, automation, models: controller,
        provider: new DeepSeekProvider(transport), pending: new Set(), emit: () => {}, cancelMaintenance: () => {},
        signal: () => controller.signal, state: () => ({ settings: defaultSettings, keyPresent: true,
          modelAuthorized: false, modelBusy: false, recovering: false, modelRoute: guard }),
      }, token, { command: 'generateSuggestion', eventId: event.id, draftVersion: 0 });
      const draft = workbench.save(token, event.id, generation, 0, suggested.text, suggested.id);
      expect(transport).toHaveBeenCalledTimes(1);
      const callId = models.getGenerationCallId({ ownerKind: 'DRAFT', ownerId: draft.id, ownerVersion: draft.version });
      expect(callId).toEqual(expect.any(String));
      expect(models.getCallRoute(callId!)).toMatchObject({ purpose: 'REPLY_GENERATION', outcome: 'SUCCEEDED' });
      expect(draft).toMatchObject({ text: 'Synthetic model draft.', status: 'DRAFT', origin: 'AI_ASSISTED_APPROVED' });
      const { adapter } = await mock.adapter(event.payload);
      const authority = { check: () => {
        workbench.operator(token, 'SEND');
        workbench.requireOwner(token, store.event(event.id), generation);
      }, committed: vi.fn() };
      await expect(coordinator.send(draft.id, adapter, false, authority)).rejects.toThrow('EVENT_NOT_APPROVED');
      expect(mock.clickCount).toBe(0);
      expect(intents(store)).toBe(0);
      store.approve(draft.id, await adapter.inspect(event.payload), draft.version, draft.text);
      expect(await coordinator.send(draft.id, adapter, false, authority)).toBe('CONFIRMED');
      expect(authority.committed).toHaveBeenCalledTimes(1);
      expect(mock.clickCount).toBe(1);
      expect(store.receiptForEvent(event.id)).toMatchObject({ result: 'CONFIRMED' });
    } finally { controller.close(); }
  });
});
