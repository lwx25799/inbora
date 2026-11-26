import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { ClientService } from '../../src/app/service.js';
import { Blocked, DEFAULT_ACCOUNT_ID, digest } from '../../src/core/contracts.js';
import { SendCoordinator } from '../../src/core/send-coordinator.js';
import type { PlatformConnector } from '../../src/platform/platform-connector.js';
import { PlatformConnectorRegistry } from '../../src/platform/platform-connector-registry.js';
import { migrateClient } from '../../src/storage/client-migration.js';
import { EventStore } from '../../src/storage/store.js';
import { pending, privateTemp, snapshot } from '../helpers.js';

vi.mock('../../src/app/browser-service.js', () => {
  throw new Error('MEMORY_CONNECTOR_IMPORTED_BROWSER_SERVICE');
});

function memoryConnector(root: string, accountId = DEFAULT_ACCOUNT_ID) {
  let opened = false, store: EventStore;
  let queue = Promise.resolve();
  const editor = { humanText: '' };
  const collectionCalls: {store: EventStore; accountId: string; source: string; aborted: boolean}[] = [];
  const identity = { identityDigest: digest('own-1'), mappingDigest: 'memory', browserVersion: '1', browserMode: 'headless' } as const;
  const submissions:{boundary:string|undefined;intent:unknown}[]=[];
  const clickOnce=vi.fn(async(boundary?:string,check?:()=>void)=>{
    check?.();
    const intent=store.db.prepare(`SELECT i.id,i.event_id,i.draft_id,i.attempt_started_at,i.status,e.account_id,c.command_id,c.intent_id
      FROM send_intents i JOIN inbound_events e ON e.id=i.event_id JOIN manual_send_commands c ON c.intent_id=i.id`).get();
    submissions.push({boundary,intent});
  });
  const connector = {
    root, platformId: 'memory', accountId,
    capabilities: { channels: ['DIRECT_MESSAGE'], loginRecovery: false, manualSecurityRecovery: false, preview: false, readback: true },
    actor: {
      run<T>(operation: () => Promise<T>): Promise<T> {
        const task = queue.then(operation);
        queue = task.then(() => {}, () => {});
        return task;
      },
    },
    loginRecovery: false,
    ownerEpoch: 0,
    status: () => ({ state: opened ? 'OPEN_MEMORY' : 'CLOSED', mode: 'headless' as const, version: '1' }),
    resourceIdentity: () => ({ open: opened, epoch: 0, mode: 'headless' as const, pageCount: 0 }),
    isIdle: () => true,
    open: vi.fn(async () => { opened = true; }),
    close: vi.fn(async () => { opened = false; }),
    bindStore: vi.fn((value: EventStore) => { store = value; }),
    setRuntimeInstance: vi.fn(),
    identity: () => identity,
    refreshIdentity: async () => identity,
    verifyManualCheck: vi.fn<PlatformConnector['verifyManualCheck']>(),
    beginLoginRecovery: vi.fn(),
    finishLoginRecovery: async () => false,
    completeLoginIfVerified: async () => false,
    verifyEmergencyRecovery: vi.fn<PlatformConnector['verifyEmergencyRecovery']>(async () => {}),
    openStoredMessage: async () => ({ opened: true as const, located: false }),
    workUrl: async () => null,
    onManualRecoveryClosed: () => {},
    manualRecoveryActive: false,
    manualRecoveryStatus: () => null,
    securityRecovery: vi.fn(),
    closeManualRecovery: vi.fn(async () => {}),
    recoverSecurityHolds: vi.fn(async () => {}),
    observe: vi.fn<PlatformConnector['observe']>(async (data, source) => {
      expect(data).toBe(store);
      expect(source).toBe('works');
      return { newEventIds: [] };
    }),
    collect: vi.fn<PlatformConnector['collect']>(async (data, source, signal) => {
      collectionCalls.push({store: data.store, accountId: data.accountId, source, aborted: signal.aborted});
    }),
    prioritizePreview: vi.fn(),
    prioritizeDisplayPreview: () => false,
    adapter: vi.fn<PlatformConnector['adapter']>(async event => ({
      dispose: vi.fn(),
      adapter: {
        inspect: async () => {
          if (editor.humanText) throw new Blocked('NATIVE_REPLY_EXISTING_DRAFT');
          return snapshot(event);
        },
        prepare: async () => {},
        verifyPrepared: async () => snapshot(event),
        baseline: async () => [],
        clickOnce,
        readback: async () => null,
      },
    })),
    verifyExisting: vi.fn<PlatformConnector['verifyExisting']>(async () => ({ verified: false, evidenceId: 'read-only-evidence' })),
    verifyExistingFollowup: vi.fn<PlatformConnector['verifyExistingFollowup']>(async () => ({ verified: false, evidenceId: 'read-only-followup' })),
  } satisfies PlatformConnector;
  return { connector, editor, collectionCalls, clickOnce, submissions };
}

test('a non-browser connector runs the service, readback and persistent guards through the same send authority', async () => {
  const root = privateTemp('phase1-memory-'), store = new EventStore(join(root, 'events.sqlite'), true);
  let service: ClientService | undefined;
  const sends = vi.spyOn(SendCoordinator.prototype, 'send');
  try {
    await migrateClient(store, join(root, 'v2.sqlite'));
    const eventId = pending(store), { connector, editor, collectionCalls, clickOnce, submissions } = memoryConnector(root);
    const registry = new PlatformConnectorRegistry();
    registry.register(connector);
    service = new ClientService(store, registry.resolve('memory', DEFAULT_ACCOUNT_ID));
    await service.loadSettings();
    service.startOnline();
    await service.drain();
    expect(connector.bindStore).toHaveBeenCalledExactlyOnceWith(store);
    expect(connector.open).toHaveBeenCalledOnce();
    service.setAssistantConnection('synthetic-instance');
    expect(connector.setRuntimeInstance).toHaveBeenCalledExactlyOnceWith('synthetic-instance');
    const token = service.authority.issueSession();
    await service.dispatch(token, { command: 'setMode', mode: 'MANUAL' });
    await service.dispatch(token, { command: 'configureCollection', settings: {
      ownId: 'own-1', comments: false, inbox: true, commentIntervalMs: 30_000, dmIntervalMs: 30_000,
    } });
    await service.dispatch(token, { command: 'syncInbox' });
    await service.drain();
    expect(connector.observe).toHaveBeenCalledWith(store, 'works', expect.any(AbortSignal));
    expect(collectionCalls).toEqual([{ store, accountId: DEFAULT_ACCOUNT_ID, source: 'dm', aborted: false }]);
    await expect(service.dispatch(token, { command: 'getStatus' })).resolves.toMatchObject({
      sync: { running: false, results: [
        { source: 'works', state: 'SUCCEEDED', error: null },
        { source: 'dm', state: 'SUCCEEDED', error: null },
      ] },
    });

    const selectionId = randomUUID();
    const detail = await service.dispatch(token, { command: 'openHumanDialog', eventId, selectionId }) as {
      ownership: { generation: number }; contextVersion: string;
    };
    const input = { eventId, selectionId, generation: detail.ownership.generation, expectedVersion: 0,
      text: 'Local human draft', contextVersion: detail.contextVersion, suggestionId: null };
    const request = { command: 'sendHumanReply', commandId: randomUUID(), input };
    editor.humanText = 'Unsubmitted web draft';
    await service.dispatch(token, request);
    await service.drain();
    await expect(service.dispatch(token, { command: 'getSendResult', commandId: request.commandId }))
      .resolves.toMatchObject({ status: 'FAILED_BEFORE_CLICK', reason: 'NATIVE_REPLY_EXISTING_DRAFT' });
    expect(editor.humanText).toBe('Unsubmitted web draft');
    expect(service.authority.draftFor(eventId)?.text).toBe(input.text);
    expect(sends).not.toHaveBeenCalled();
    expect(clickOnce).not.toHaveBeenCalled();

    editor.humanText = '';
    const send = { ...request, commandId: randomUUID(), input: { ...input, expectedVersion: 1 } };
    await service.dispatch(token, send);
    await service.drain();
    await expect(service.dispatch(token, { command: 'getSendResult', commandId: send.commandId }))
      .resolves.toMatchObject({ status: 'UNCERTAIN', reason: 'NO_UNIQUE_BOUND_PROOF' });
    expect(clickOnce).toHaveBeenCalledOnce();
    expect(submissions).toHaveLength(1);
    const intent=store.uncertain()[0]!;
    expect(intent).toBeDefined();
    const boundary=store.intentBoundary(intent.id);
    expect(Number.isFinite(Date.parse(boundary))).toBe(true);
    expect(submissions[0]).toMatchObject({boundary,intent:{id:intent.id,intent_id:intent.id,event_id:eventId,
      draft_id:service.authority.draftFor(eventId)?.id,command_id:send.commandId,attempt_started_at:boundary,
      status:'INTENT_RECORDED',account_id:DEFAULT_ACCOUNT_ID}});
    await service.dispatch(token, send);
    await service.drain();
    expect(clickOnce).toHaveBeenCalledOnce();
    await service.dispatch(token, { command: 'reconcileUncertain', eventId, decision: 'READ_ONLY_VERIFY' });
    expect(connector.verifyExisting).toHaveBeenCalledWith(store, eventId);
    expect(sends).toHaveBeenCalledOnce();

    await service.dispatch(token, { command: 'emergencyStop' });
    await expect(service.dispatch(token, { command: 'resume', eventId: null })).rejects.toThrow('EMERGENCY_RECOVERY_NOT_VERIFIED');
    expect(connector.verifyEmergencyRecovery).toHaveBeenCalledOnce();
    expect(store.db.prepare('SELECT emergency_stopped FROM automation_state WHERE id=1').get()).toEqual({ emergency_stopped: 1 });
    expect(connector.closeManualRecovery).toHaveBeenCalled();
    expect(sends).toHaveBeenCalledOnce();
    await service.close();
    service = undefined;
    expect(connector.close).toHaveBeenCalledOnce();
  } finally {
    sends.mockRestore();
    try { await service?.close(); }
    finally { store.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test('a different connector account cannot bind to the schema3 service', async () => {
  const root = privateTemp('phase1-memory-account-'), store = new EventStore(join(root, 'events.sqlite'), true);
  try {
    const { connector } = memoryConnector(root, 'account_002');
    expect(() => new ClientService(store, connector)).toThrow('ACCOUNT_CHANGED');
    expect(connector.bindStore).not.toHaveBeenCalled();
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
