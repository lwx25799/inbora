import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { BrowserService } from '../../src/app/browser-service.js';
import { AccountActor } from '../../src/browser/account-actor.js';
import { DEFAULT_ACCOUNT_ID } from '../../src/core/contracts.js';
import { DouyinPlatformConnector } from '../../src/platform/douyin-platform-connector.js';
import { PlatformConnectorRegistry } from '../../src/platform/platform-connector-registry.js';
import type { PlatformConnector } from '../../src/platform/platform-connector.js';
import { AutomationStore } from '../../src/storage/automation-store.js';
import { EventStore } from '../../src/storage/store.js';
import { candidate, privateTemp } from '../helpers.js';

test('registry resolves an exact platform and account pair without replacing its owner', () => {
  const registry = new PlatformConnectorRegistry();
  const first = new DouyinPlatformConnector(new BrowserService('synthetic'));
  const second = new DouyinPlatformConnector(new BrowserService('synthetic', undefined, 'account_002'));
  const differentPlatform = Object.create(first, { platformId: { value: 'synthetic-platform' } }) as PlatformConnector;
  const invalid = Object.create(first, { accountId: { value: '../other' } }) as PlatformConnector;
  registry.register(first);
  registry.register(second);
  registry.register(differentPlatform);
  expect(registry.resolve('douyin', DEFAULT_ACCOUNT_ID)).toBe(first);
  expect(registry.resolve('douyin', 'account_002')).toBe(second);
  expect(registry.resolve('synthetic-platform', DEFAULT_ACCOUNT_ID)).toBe(differentPlatform);
  expect(() => registry.register(first)).toThrow('PLATFORM_CONNECTOR_ALREADY_REGISTERED');
  expect(() => registry.register(invalid)).toThrow('ACCOUNT_ID_INVALID');
  expect(() => registry.resolve('synthetic-platform', 'account_002')).toThrow('PLATFORM_CONNECTOR_NOT_FOUND');
});

test('the Douyin connector delegates every capability and shares the original owner actor', async () => {
  const root = privateTemp('phase1-connector-'), store = new EventStore(join(root, 'poc.sqlite'), true);
  try {
    const data = new AutomationStore(store);
    const browser = new BrowserService('synthetic');
    const connector = new DouyinPlatformConnector(browser);
    const event = candidate();
    const signal = new AbortController().signal;
    const actor = new AccountActor();
    const identity = { identityDigest: 'owner', mappingDigest: 'map', browserVersion: '1', browserMode: 'headless' } as const;
    const session = { sessionId: 'fixture-session', incidentId: 'fixture-incident', channel: event.channel } as const;
    const recoveryStatus = { active: true, incidentId: session.incidentId, channel: event.channel } as const;
    const check = vi.fn(), complete = vi.fn(), beforeOpen = async () => signal;
    const result = { verified: true, evidenceId: 'synthetic-evidence' };
    const target = { eventId: 'message', source: 'INBOUND', purpose: 'DISPLAY' } as const;
    const options = { signal, background: true };

    vi.spyOn(browser, 'actor', 'get').mockReturnValue(actor);
    vi.spyOn(browser, 'ownerEpoch', 'get').mockReturnValue(17);
    vi.spyOn(browser, 'loginRecovery', 'get').mockReturnValue(true);
    vi.spyOn(browser, 'manualRecoveryActive', 'get').mockReturnValue(true);
    vi.spyOn(browser, 'manualRecoveryStatus').mockReturnValue(recoveryStatus);
    expect(connector.platformId).toBe('douyin');
    expect(connector.accountId).toBe(DEFAULT_ACCOUNT_ID);
    expect(connector.capabilities.channels).toEqual(['COMMENT_NOTIFICATION', 'DIRECT_MESSAGE']);
    expect(connector.actor).toBe(actor);
    expect(connector.ownerEpoch).toBe(17);
    expect(connector.loginRecovery).toBe(true);
    expect(connector.manualRecoveryActive).toBe(true);
    expect(connector.manualRecoveryStatus()).toBe(recoveryStatus);
    const onClosed = vi.fn();
    connector.onManualRecoveryClosed = onClosed;
    browser.onManualRecoveryClosed();
    expect(onClosed).toHaveBeenCalledOnce();

    const calls = [
      [vi.spyOn(browser, 'status'), () => connector.status(), []],
      [vi.spyOn(browser, 'resourceIdentity'), () => connector.resourceIdentity(), []],
      [vi.spyOn(browser, 'isIdle'), () => connector.isIdle(), []],
      [vi.spyOn(browser, 'bindStore').mockReturnValue(), () => connector.bindStore(store), [store]],
      [vi.spyOn(browser, 'setRuntimeInstance'), () => connector.setRuntimeInstance('fixture'), ['fixture']],
      [vi.spyOn(browser, 'open').mockResolvedValue(), () => connector.open('headless', signal), ['headless', signal]],
      [vi.spyOn(browser, 'close').mockResolvedValue(), () => connector.close(), []],
      [vi.spyOn(browser, 'identity').mockReturnValue(identity), () => connector.identity(event.channel), [event.channel]],
      [vi.spyOn(browser, 'refreshIdentity').mockResolvedValue(identity), () => connector.refreshIdentity(event.channel), [event.channel]],
      [vi.spyOn(browser, 'beginLoginRecovery').mockResolvedValue(), () => connector.beginLoginRecovery(false, signal, check), [false, signal, check]],
      [vi.spyOn(browser, 'finishLoginRecovery').mockResolvedValue(true), () => connector.finishLoginRecovery(17), [17]],
      [vi.spyOn(browser, 'completeLoginIfVerified').mockResolvedValue(true), () => connector.completeLoginIfVerified('own'), ['own']],
      [vi.spyOn(browser, 'verifyEmergencyRecovery').mockResolvedValue(), () => connector.verifyEmergencyRecovery('own', signal, check, complete), ['own', signal, check, complete]],
      [vi.spyOn(browser, 'openStoredMessage').mockResolvedValue({ opened: true, located: true }), () => connector.openStoredMessage(store, 'message', beforeOpen, check), [store, 'message', beforeOpen, check]],
      [vi.spyOn(browser, 'workUrl').mockResolvedValue(null), () => connector.workUrl(event, store), [event, store]],
      [vi.spyOn(browser, 'closeManualRecovery').mockResolvedValue(), () => connector.closeManualRecovery(), []],
      [vi.spyOn(browser, 'recoverSecurityHolds').mockResolvedValue(), () => connector.recoverSecurityHolds(true, signal), [true, signal]],
      [vi.spyOn(browser, 'observe').mockResolvedValue({ newEventIds: [] }), () => connector.observe(store, 'notifications', signal), [store, 'notifications', signal]],
      [vi.spyOn(browser, 'collect').mockResolvedValue(), () => connector.collect(data, 'dm', signal), [data, 'dm', signal]],
      [vi.spyOn(browser, 'prioritizePreview').mockReturnValue(), () => connector.prioritizePreview(data, event, 'message'), [data, event, 'message']],
      [vi.spyOn(browser, 'prioritizeDisplayPreview').mockReturnValue(true), () => connector.prioritizeDisplayPreview(data, event, target), [data, event, target]],
      [vi.spyOn(browser, 'verifyExisting').mockResolvedValue(result), () => connector.verifyExisting(store, 'message', options), [store, 'message', options]],
      [vi.spyOn(browser, 'verifyExistingFollowup').mockResolvedValue(result), () => connector.verifyExistingFollowup(store, 'turn', options), [store, 'turn', options]],
    ] as const;
    for (const [delegate, operation, args] of calls) {
      const value = await operation();
      expect(delegate).toHaveBeenCalledExactlyOnceWith(...args);
      expect(value).toBe(await delegate.mock.results[0]!.value);
    }

    const recovery = { command: 'securityRecovery', action: 'start', channel: event.channel } as const;
    const recover = vi.spyOn(browser, 'securityRecovery').mockResolvedValue(session);
    expect(await connector.securityRecovery(recovery, 'synthetic-token', check)).toBe(session);
    expect(recover).toHaveBeenCalledExactlyOnceWith(recovery, 'synthetic-token', check);

    const handle = {
      dispose: vi.fn(),
      adapter: { inspect: vi.fn(), prepare: vi.fn(), verifyPrepared: vi.fn(), baseline: vi.fn(), clickOnce: vi.fn(), readback: vi.fn() },
    };
    const adapter = vi.spyOn(browser, 'adapter').mockResolvedValue(handle);
    const adapterOptions = { manualMedia: true, readonlySignal: signal };
    expect(await connector.adapter(event, store, signal, adapterOptions)).toBe(handle);
    expect(adapter).toHaveBeenCalledExactlyOnceWith(event, store, signal, adapterOptions);
    expect(handle.adapter.clickOnce).not.toHaveBeenCalled();
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
