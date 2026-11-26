import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { expect, test, vi } from 'vitest';
import { CredentialStore, ModelCredentialStore, type ModelCredentialRef } from '../../src/app/credentials.js';
import { auditPage, createRuntimeConnector } from '../../src/app/account-controller.js';
import { ClientService } from '../../src/app/service.js';
import {
  dispatchTrustedServiceCommand, parseSidecarFrame, routeSidecarEnvelope, type SidecarCommand,
} from '../../src/app/protocol-v2-router.js';
import { DEFAULT_ACCOUNT_ID, MOCK_PLATFORM_ID } from '../../src/contracts/account.js';
import type { NativeBridgeRequest } from '../../src/contracts/native-bridge.js';
import { MAX_PROTOCOL_V2_FRAME_BYTES, protocolV2EventEnvelopeSchema, type ProtocolScope } from '../../src/contracts/protocol-v2.js';
import { clearNativeWin32Bridge, registerNativeBridgeTransport } from '../../src/native/win32-bridge.js';
import { BrowserProcessSampler } from '../../src/observability/browser-metrics.js';
import { mockCapabilities } from '../../src/platform/mock-platform-connector.js';
import { candidate, privateTemp } from '../helpers.js';
import { Blocked, eventBinding, targetKey } from '../../src/core/contracts.js';
import { EventStore } from '../../src/storage/store.js';
import { chatAnswer, installFixtureKey, modelFixture } from '../model-provider-helpers.js';
import { holdSecurityChannel, readSecurityHold } from '../../src/storage/security-holds.js';
import { isEmergencyStopped } from '../../src/storage/emergency-stop.js';
import { BrowserWorkerHost } from '../../src/workers/browser-worker-host.js';

vi.mock('node:child_process', { spy: true });

const secret = 'ab'.repeat(32);
const primary: ProtocolScope = { kind: 'ACCOUNT', accountRef: DEFAULT_ACCOUNT_ID };
const globalScope: ProtocolScope = { kind: 'GLOBAL' };
const mockId = 'account_mock';
const secondary: ProtocolScope = { kind: 'ACCOUNT', accountRef: mockId };
const register = () => ({ command: 'accounts', action: 'registerAccount', commandId: randomUUID(),
  platform: MOCK_PLATFORM_ID, connector: MOCK_PLATFORM_ID, accountId: mockId, ownId: 'fixture-mock-own' });
const list = { command: 'accounts', action: 'listAccounts' };
const getStatus = { command: 'getStatus' };

function harness(f: { service: ClientService; token: string }) {
  const context = {
    accounts: f.service.accounts,
    lifecycleCommandIds: new Map<string, string>(),
    dispatch: (body: SidecarCommand, scope?: ProtocolScope) => {
      if (body.command === 'connect' || body.command === 'disconnect') throw new Error('Unexpected runtime lifecycle');
      return dispatchTrustedServiceCommand(f.service, f.token, body, scope);
    },
  };
  const receive = async (line: string) => {
    const parsed = parseSidecarFrame(line, secret);
    if (parsed.kind === 'native') throw new Error('Unexpected native bridge response');
    return parsed.kind === 'response' ? parsed.response : routeSidecarEnvelope(parsed.envelope, context);
  };
  const request = (protocol: 1 | 2, body: unknown, scope?: ProtocolScope, commandId?: string) =>
    receive(JSON.stringify({ protocol, requestId: randomUUID(), secret, body, scope, commandId }));
  return { receive, request };
}

test('runs registered Mock account business commands through authenticated V2 scope', async () => {
  const model = vi.fn<typeof fetch>(async () => chatAnswer('Synthetic model response.'));
  const f = await modelFixture(model);
  try {
    const { request } = harness(f);
    const write = (body: unknown) => request(2, body, secondary, randomUUID());
    const read = async <T>(body: unknown, scope = secondary): Promise<T> => {
      const reply = await request(2, body, scope);
      expect(reply).toMatchObject({ ok: true });
      if (!reply.ok) throw new Error(reply.error);
      return reply.result as T;
    };
    const inbox = { command: 'getInbox', channel: 'ALL', status: 'ALL', page: 0 };
    const audit = { command: 'getAudit', page: 0 };
    expect(await request(2, inbox, secondary)).toMatchObject({ ok: false, error: 'ACCOUNT_NOT_FOUND' });
    const unsupported = { ...register(), accountId: 'account_unsupported', ownId: 'unsupported', connector: 'other-connector' };
    expect(await request(2, unsupported, globalScope)).toMatchObject({ ok: true });
    expect(await request(2, inbox, { kind: 'ACCOUNT', accountRef: unsupported.accountId }))
      .toMatchObject({ ok: false, error: 'ACCOUNT_COMMAND_NOT_SUPPORTED' });
    expect(await request(2, register(), globalScope)).toMatchObject({ ok: true });
    expect(await request(2, inbox, secondary)).toMatchObject({ ok: true, result: { total: 0 } });
    const mock = f.service.accounts.getMockConnector(mockId)!;
    const updates = vi.fn();
    f.service.accounts.updates.on('update', updates);
    const beforeInbox = await read(inbox, primary);
    await installFixtureKey(f.service, f.token);
    const beforeAudit = await read(audit, primary);
    expect(await write({ command: 'setMode', mode: 'MANUAL' })).toMatchObject({ ok: true });
    expect(await write({ command: 'setModelGrant', confirmed: true, scope: { ownId: 'fixture-mock-own',
      channels: ['DIRECT_MESSAGE'], model: 'deepseek-flash', modelLimit: 1, expiresAt: null } })).toMatchObject({ ok: true });
    expect(await read(getStatus)).toMatchObject({ account: { id: mockId }, mode: 'MANUAL', modelAuthorized: true });
    expect(await write({ command: 'pause', eventId: null })).toMatchObject({ result: { paused: true } });
    expect(await write({ command: 'resume', eventId: null })).toMatchObject({ result: { paused: false } });
    expect(await write({ command: 'syncInbox' })).toMatchObject({ ok: true });
    await expect.poll(() => read(getStatus)).toMatchObject({ sync: { running: false } });

    const prepare = async (id: string, generate = false) => {
      const input = candidate({ platformEventId: id, conversationId: id, text: `Inbound ${id}` });
      mock.inject(input);
      expect(await write({ command: 'observe', source: 'dm' })).toMatchObject({ ok: true });
      const { items } = await read<{ items: { id: string; preview: string }[] }>(inbox);
      const eventId = items.find(item => item.preview === input.text)!.id;
      const selectionId = randomUUID();
      expect(await write({ command: 'selectTarget', eventId, selectionId })).toMatchObject({ ok: true });
      const claimed = await write({ command: 'claimHuman', eventId, generation: 0 });
      expect(claimed).toMatchObject({ ok: true });
      const { generation } = (claimed as { result: { generation: number } }).result;
      expect(await write({ command: 'renewHuman', eventId, generation })).toMatchObject({ ok: true });
      let text = 'Synthetic human reply';
      let suggestionId: string | null = null;
      if (generate) {
        const reply = await write({ command: 'generateSuggestion', eventId, draftVersion: 0 });
        expect(reply).toMatchObject({ ok: true, result: { text: 'Synthetic model response.' } });
        ({ id: suggestionId, text } = (reply as { result: { id: string; text: string } }).result);
      }
      expect(await write({ command: 'saveDraft', eventId, generation, expectedVersion: 0, text, suggestionId }))
        .toMatchObject({ ok: true });
      const { draft, contextVersion } = await read<{ draft: { id: string; version: number }; contextVersion: string }>(
        { command: 'getThread', eventId });
      return { eventId, draftId: draft.id, draftVersion: draft.version, generation, contextVersion, selectionId, text };
    };
    const preview = async (params: Awaited<ReturnType<typeof prepare>>) => {
      const reply = await write({ command: 'previewSend', params });
      expect(reply).toMatchObject({ ok: true });
      return (reply as { result: { commandId: string } }).result.commandId;
    };
    const send = (commandId: string, params: Awaited<ReturnType<typeof prepare>>) =>
      request(2, { command: 'submitManualSend', commandId, params, confirmed: true }, secondary);
    const result = (commandId: string, scope = secondary) => request(2, { command: 'getSendResult', commandId }, scope);
    const intents = () => f.store.db.prepare(`SELECT e.account_id,i.status,r.result FROM send_intents i
      JOIN inbound_events e ON e.id=i.event_id JOIN delivery_receipts r ON r.send_intent_id=i.id ORDER BY i.rowid`).all();

    const first = await prepare('mock-inbound-confirmed', true);
    const firstCommand = await preview(first);
    const adapter = mock.adapter.bind(mock);
    const atClick = vi.fn();
    const inspectClick = vi.spyOn(mock, 'adapter').mockImplementationOnce(async (...args) => {
      const handle = await adapter(...args);
      const clickOnce = handle.adapter.clickOnce;
      handle.adapter.clickOnce = async (...clickArgs) => {
        atClick(f.store.db.prepare(`SELECT e.account_id,i.status,c.status AS command_status FROM send_intents i
          JOIN inbound_events e ON e.id=i.event_id JOIN manual_send_commands c ON c.intent_id=i.id
          WHERE c.command_id=?`).get(firstCommand));
        return clickOnce(...clickArgs);
      };
      return handle;
    });
    try {
      expect(await send(firstCommand, first)).toMatchObject({ ok: true });
      await expect.poll(() => result(firstCommand)).toMatchObject({ ok: true, result: { status: 'CONFIRMED' } });
    } finally { inspectClick.mockRestore(); }
    expect(atClick).toHaveBeenCalledExactlyOnceWith({
      account_id: mockId, status: 'INTENT_RECORDED', command_status: 'SENDING',
    });
    expect(model).toHaveBeenCalledTimes(1);
    expect(await result(firstCommand, primary)).toMatchObject({ ok: false, error: 'COMMAND_NOT_FOUND' });
    expect(await request(2, { command: 'getThread', eventId: f.eventId }, secondary)).toMatchObject({ ok: false });

    const external = await prepare('mock-inbound-external');
    const externalCommand = await preview(external);
    mock.setWebDraft(targetKey(candidate({ accountId: mockId, conversationId: 'mock-inbound-external' })), external.text);
    expect(await write({ command: 'previewSend', params: external })).toMatchObject({ ok: false, error: 'NATIVE_REPLY_EXISTING_DRAFT' });
    expect(await send(externalCommand, external)).toMatchObject({ ok: true });
    await expect.poll(() => result(externalCommand)).toMatchObject({ result: {
      status: 'FAILED_BEFORE_CLICK', reason: 'NATIVE_REPLY_EXISTING_DRAFT' } });
    expect(await write({ command: 'previewSend', params: external })).toMatchObject({ ok: false, error: 'NATIVE_REPLY_EXISTING_DRAFT' });
    expect(await write({ command: 'releaseHuman', eventId: external.eventId, generation: external.generation }))
      .toMatchObject({ ok: true, result: { released: true } });
    expect(mock.clickCount).toBe(1);

    const unknown = await prepare('mock-inbound-unknown');
    const unknownCommand = await preview(unknown);
    mock.hideNextReadback = true;
    expect(await send(unknownCommand, unknown)).toMatchObject({ ok: true });
    await expect.poll(() => result(unknownCommand)).toMatchObject({ ok: true, result: { status: 'UNCERTAIN' } });
    expect(await send(unknownCommand, unknown)).toMatchObject({ result: { status: 'UNCERTAIN' } });
    expect(await write({ command: 'previewSend', params: unknown })).toMatchObject({ ok: false });
    expect(await write({ command: 'reconcileUncertain', eventId: unknown.eventId, decision: 'READ_ONLY_VERIFY' }))
      .toMatchObject({ ok: true, result: { verified: false } });
    expect(intents()).toEqual([
      { account_id: mockId, status: 'CONFIRMED', result: 'CONFIRMED' },
      { account_id: mockId, status: 'UNCERTAIN', result: 'UNCERTAIN' },
    ]);
    expect(mock.clickCount).toBe(2);
    expect(await read(audit)).toMatchObject({ items: expect.arrayContaining([
      { event_type: 'CLICK_INTENT_RECORDED', time: expect.any(String), entity_id: expect.any(String), detail_redacted: '{}' },
      expect.objectContaining({ event_type: 'CONFIRMED' }),
      expect.objectContaining({ event_type: 'UNCERTAIN' }),
    ]) });
    expect(await read(inbox, primary)).toEqual(beforeInbox);
    expect(await read(audit, primary)).toEqual(beforeAudit);
    expect(updates).toHaveBeenCalledWith(mockId, { event: 'send_status_updated' });
    expect(updates.mock.calls.every(([accountId]) => accountId === mockId)).toBe(true);

    const stopped = await prepare('mock-inbound-stopped');
    const stoppedCommand = await preview(stopped);
    expect(await request(2, { command: 'emergencyStop' }, globalScope)).toMatchObject({ ok: true });
    expect(await write({ command: 'resume', eventId: null })).toMatchObject({ ok: false, error: 'EMERGENCY_STOPPED' });
    expect(await send(stoppedCommand, stopped)).toMatchObject({ ok: false, error: 'EMERGENCY_STOPPED' });
    expect(mock.clickCount).toBe(2);
    expect(await write({ command: 'accounts', action: 'disconnectAccount', accountRef: mockId, confirmed: true }))
      .toMatchObject({ ok: true, result: { status: 'DISCONNECTED' } });
    expect(await request(2, inbox, secondary)).toMatchObject({ ok: false, error: 'ACCOUNT_DISCONNECTED' });
  } finally { await f.close(); }
});

test('isolated security recovery binds explicit verification to the persisted hold and global stop', async () => {
  const f = await modelFixture();
  const channel = 'DIRECT_MESSAGE';
  const newHold = (store: EventStore, incidentId = randomUUID()) =>
    holdSecurityChannel(store, channel, { incidentId, reason: 'OBSERVATION_SECURITY_SUSPECT', mode: 'headless' });
  const hold = newHold(f.store);
  let store = new EventStore(f.dbPath);
  let connector = createRuntimeConnector(f.root, store, 'synthetic');
  let service: ClientService | undefined;
  const check = () => {};
  try {
    const event = store.event(f.eventId).payload;
    await expect(connector.observe(store, 'dm')).rejects.toMatchObject({ code: 'SECURITY_CHANNEL_HELD' });
    await expect(connector.adapter(event)).rejects.toMatchObject({ code: 'SECURITY_CHANNEL_HELD' });
    await connector.close();
    store.close();
    store = new EventStore(f.dbPath);
    connector = createRuntimeConnector(f.root, store, 'synthetic');
    await connector.recoverSecurityHolds();
    expect(readSecurityHold(store, channel)).toEqual(hold);
    await expect(connector.observe(store, 'dm')).rejects.toMatchObject({ code: 'SECURITY_CHANNEL_HELD' });
    expect(connector.capabilities.manualSecurityRecovery).toBe(true);
    expect(connector.loginRecovery).toBe(false);

    // The synthetic host accepts identity probes only. Ordinary operations must stop in Core.
    const sessionId = randomUUID();
    const host = BrowserWorkerHost.prototype;
    const pid = vi.spyOn(host, 'pid', 'get').mockReturnValue(process.pid);
    const hello = { pid: process.pid, sessionId, ownerEpoch: 1, profileLocked: true, mode: 'synthetic' } as const;
    const boot = vi.spyOn(host, 'start').mockResolvedValue(hello);
    const open = vi.spyOn(host, 'open').mockResolvedValue({ ...hello, state: 'OPEN', executedCount: 0, pageCount: 0, version: 'mock' });
    const close = vi.spyOn(host, 'close').mockResolvedValue(undefined);
    const identity = vi.spyOn(host, 'identity').mockImplementation(async (_channel, ownId) =>
      ownId ? { ownId, mappingDigest: 'fixture', browserVersion: 'mock' } : null);
    const recoverStatus = () => connector.securityRecovery({ command: 'securityRecovery', action: 'status' }, 'operator', check);
    const start = async () => {
      const session = await connector.securityRecovery({ command: 'securityRecovery', action: 'start', channel }, 'operator', check);
      expect(session).toMatchObject({ sessionId: expect.any(String), incidentId: readSecurityHold(store, channel)?.incidentId });
      return (session as { sessionId: string }).sessionId;
    };
    const finish = (sessionId: string) => connector.securityRecovery({ command: 'securityRecovery', action: 'finish', sessionId }, 'operator', check);
    try {
      const stale = await start();
      expect(await recoverStatus()).toMatchObject({ securityHolds: [hold] });
      expect(boot).not.toHaveBeenCalled();
      const current = newHold(store);
      await expect(finish(stale)).rejects.toMatchObject({ code: 'SECURITY_RECOVERY_CHANGED' });
      const session = await start();
      identity.mockResolvedValueOnce({ ownId: 'different-owner', mappingDigest: 'fixture', browserVersion: 'mock' });
      await expect(finish(session)).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
      expect(readSecurityHold(store, channel)).toEqual(current);
      await finish(session);
      expect(readSecurityHold(store, channel)).toBeNull();
      const closeCommand = { command: 'securityRecovery', action: 'close', sessionId: session } as const;
      await expect(connector.securityRecovery(closeCommand, 'operator', check)).resolves.toBeUndefined();
      await expect(connector.securityRecovery(closeCommand, 'operator', check)).resolves.toBeUndefined();

      const suspected = newHold(store);
      identity.mockRejectedValueOnce(new Blocked('OBSERVATION_SECURITY_SUSPECT'));
      await expect(connector.recoverSecurityHolds(true)).rejects.toMatchObject({ code: 'OBSERVATION_SECURITY_SUSPECT' });
      expect(readSecurityHold(store, channel)).toBeTruthy();
      expect(readSecurityHold(store, channel)?.revision).not.toBe(suspected.revision);
      await connector.recoverSecurityHolds(true);
      expect(readSecurityHold(store, channel)).toBeNull();

      const heldDm = newHold(store);
      const heldComment = holdSecurityChannel(store, 'COMMENT_NOTIFICATION', {
        incidentId: randomUUID(), reason: 'OBSERVATION_SECURITY_SUSPECT', mode: 'headless' });
      service = new ClientService(store, connector);
      await service.loadSettings();
      const token = service.authority.issueSession();
      await service.dispatch(token, { command: 'emergencyStop' });
      const { request } = harness({ service, token });
      const probes = identity.mock.calls.length;
      expect(await request(2, { command: 'securityRecovery', action: 'status' }, primary)).toMatchObject({
        ok: true, result: { securityHolds: [heldDm, heldComment] },
      });
      expect(identity).toHaveBeenCalledTimes(probes);
      identity.mockResolvedValueOnce({ ownId: 'own-1', mappingDigest: 'fixture', browserVersion: 'mock' })
        .mockResolvedValueOnce(null);
      await expect(service.dispatch(token, { command: 'resume', eventId: null })).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
      expect(readSecurityHold(store, channel)).toEqual(heldDm);
      expect(readSecurityHold(store, 'COMMENT_NOTIFICATION')).toEqual(heldComment);
      expect(isEmergencyStopped(store)).toBe(true);

      let replacement: ReturnType<typeof newHold> | undefined;
      identity.mockResolvedValueOnce({ ownId: 'own-1', mappingDigest: 'fixture', browserVersion: 'mock' })
        .mockImplementationOnce(async (_channel, ownId) => {
          replacement = newHold(store);
          return { ownId: ownId!, mappingDigest: 'fixture', browserVersion: 'mock' };
        });
      await expect(service.dispatch(token, { command: 'resume', eventId: null }))
        .rejects.toMatchObject({ code: 'SECURITY_RECOVERY_CHANGED' });
      expect(readSecurityHold(store, channel)).toEqual(replacement);
      expect(readSecurityHold(store, 'COMMENT_NOTIFICATION')).toEqual(heldComment);
      expect(isEmergencyStopped(store)).toBe(true);

      await expect(service.dispatch(token, { command: 'resume', eventId: null })).resolves.toMatchObject({
        securityHolds: [], automation: { emergencyStopped: false } });
      expect(store.db.prepare("SELECT count(*) FROM audit_events WHERE event_type='SECURITY_CHANNEL_RESOLVED'").pluck().get()).toBe(4);
      expect(isEmergencyStopped(store)).toBe(false);
    } finally {
      try { await connector.close(); }
      finally { for (const stub of [identity, close, open, boot, pid]) stub.mockRestore(); }
    }
  } finally {
    try { await (service?.close() ?? connector.close()); }
    finally { if (store.db.open) store.close(); await f.close(); }
  }
}, 25_000);

test('validates protocol v2 scope, authentication, byte limits and response version', async () => {
  const f = await modelFixture();
  try {
    const { request, receive } = harness(f);
    const requestId = randomUUID();
    const line = JSON.stringify({ protocol: 2, requestId, secret, scope: primary, body: getStatus });
    expect(await request(2, getStatus)).toMatchObject({ protocol: 2, ok: false, error: 'INVALID_COMMAND' });
    expect(await request(2, getStatus, globalScope)).toMatchObject({ protocol: 2, ok: false, error: 'PROTOCOL_SCOPE_MISMATCH' });
    expect(await request(2, list, primary)).toMatchObject({ protocol: 2, ok: false, error: 'PROTOCOL_SCOPE_MISMATCH' });
    expect(await request(2, list, globalScope)).toMatchObject({ protocol: 2, ok: true, result: { schemaVersion: 4 } });
    expect(await receive(line.replace(secret, '密'.repeat(64)))).toMatchObject({ requestId, protocol: 2, ok: false,
      error: 'IPC_AUTHENTICATION_FAILED' });
    const exactlyAtLimit = line.padEnd(MAX_PROTOCOL_V2_FRAME_BYTES, ' ');
    expect(await receive(exactlyAtLimit)).toMatchObject({ requestId, protocol: 2, ok: true, result: { schema: 4 } });
    expect(await receive(exactlyAtLimit + ' ')).toEqual({ requestId, protocol: 2, ok: false, error: 'IPC_REQUEST_TOO_LARGE' });
    const v1 = JSON.stringify({ protocol: 1, requestId, secret, body: getStatus });
    expect(await receive(v1.padEnd(100_000, ' '))).toMatchObject({ requestId, protocol: 1, ok: true });
    expect(await receive(v1.padEnd(100_001, ' '))).toMatchObject({ protocol: 1, ok: false, error: 'IPC_REQUEST_TOO_LARGE' });
  } finally { await f.close(); }
});

test('blocks ambiguous legacy writes only in multi-account mode and keeps both emergency stop paths live', async () => {
  const f = await modelFixture();
  try {
    const { request } = harness(f);
    const manual = { command: 'setMode', mode: 'MANUAL' };
    expect(await request(1, manual)).toMatchObject({ protocol: 1, ok: true, result: { configuredMode: 'MANUAL' } });
    expect(await request(2, register(), globalScope)).toMatchObject({ protocol: 2, ok: true });
    expect(await request(1, getStatus)).toMatchObject({ protocol: 1, ok: true });
    expect(await request(1, manual)).toMatchObject({ protocol: 1, ok: false, error: 'PROTOCOL_V2_ACCOUNT_SCOPE_REQUIRED' });
    expect(await request(1, { command: 'modelProviders', action: 'delete', connectionId: randomUUID(), expectedVersion: 1 }))
      .toMatchObject({ protocol: 1, ok: false, error: 'PROTOCOL_V2_ACCOUNT_SCOPE_REQUIRED' });
    expect(await request(2, manual, secondary)).toMatchObject({ protocol: 2, ok: false, error: 'INVALID_COMMAND_ID' });
    expect(await request(2, { command: 'markInboxRead' }, secondary, randomUUID()))
      .toMatchObject({ protocol: 2, ok: false, error: 'ACCOUNT_COMMAND_NOT_SUPPORTED' });
    const commandId = randomUUID();
    expect(await request(2, manual, primary, commandId)).toMatchObject({ protocol: 2, ok: true, result: { configuredMode: 'MANUAL' } });
    expect(await request(2, manual, primary, commandId)).toMatchObject({ ok: false, error: 'COMMAND_REPLAY_BLOCKED' });
    expect(await request(2, { ...manual, mode: 'OBSERVE' }, primary, commandId)).toMatchObject({ ok: false,
      error: 'COMMAND_ID_CONFLICT' });
    expect(f.service.accounts.storage?.getProtocolCommand(commandId)).toMatchObject({ status: 'COMPLETED', accountRef: DEFAULT_ACCOUNT_ID });

    f.service.authority.revoke(f.token);
    await expect(f.service.dispatch(f.token, getStatus)).rejects.toThrow('OPERATOR_EXPIRED');
    const stopped = { paused: true, emergencyStopped: true };
    const stop = { command: 'emergencyStop' };
    expect(await request(1, stop)).toMatchObject({ protocol: 1, ok: true, result: stopped });
    expect(await request(2, stop, globalScope, randomUUID())).toMatchObject({ protocol: 2, ok: true, result: stopped });
    const stopId = randomUUID();
    const lifecycleCommandIds = new Map<string, string>();
    const envelope = { protocol: 2 as const, requestId: randomUUID(), secret, scope: globalScope, commandId: stopId, body: stop };
    const attemptDuringConnect = () => { throw new Blocked('CONNECTION_IN_PROGRESS'); };
    expect(await routeSidecarEnvelope(envelope, { lifecycleCommandIds, dispatch: attemptDuringConnect }))
      .toMatchObject({ ok: false, error: 'CONNECTION_IN_PROGRESS' });
    lifecycleCommandIds.set(stopId, 'previous-lifecycle-command');
    for (const id of [stopId, stopId, randomUUID()]) {
      expect(await routeSidecarEnvelope({ ...envelope, requestId: randomUUID(), commandId: id }, {
        lifecycleCommandIds, dispatch: () => dispatchTrustedServiceCommand(f.service, f.token, { command: 'emergencyStop' }),
      })).toMatchObject({ ok: true, result: stopped });
    }
    expect(await request(2, stop, primary)).toMatchObject({ ok: false, error: 'PROTOCOL_SCOPE_MISMATCH' });
    await expect(f.service.dispatch(f.token, getStatus)).rejects.toThrow('OPERATOR_EXPIRED');
  } finally { await f.close(); }
});

test('persistent v2 writes require one authoritative ID and bind retries to the original scope and payload', async () => {
  const f = await modelFixture();
  try {
    const { request } = harness(f);
    const registration = register();
    const { commandId, ...registrationBody } = registration;
    expect(await request(2, registrationBody, globalScope)).toMatchObject({ ok: false, error: 'INVALID_COMMAND_ID' });
    expect(await request(2, registration, globalScope, randomUUID())).toMatchObject({ ok: false, error: 'COMMAND_ID_CONFLICT' });
    const created = await request(2, { ...registrationBody, commandId: commandId.toUpperCase() }, globalScope, commandId);
    expect(created).toMatchObject({ ok: true, result: { id: mockId } });
    expect(await request(2, registration, globalScope, commandId.toUpperCase())).toMatchObject({ ok: true,
      result: created.ok ? created.result : null });
    await expect(f.service.dispatch(f.token, { ...registration, commandId: commandId.toUpperCase() }))
      .resolves.toMatchObject({ id: mockId });

    await installFixtureKey(f.service, f.token);
    const body = { command: 'setModelGrant', confirmed: true, scope: { ownId: 'own-1',
      channels: ['DIRECT_MESSAGE'], model: 'deepseek-flash', modelLimit: 1, expiresAt: null } };
    const grantId = randomUUID();
    expect(await request(2, body, primary)).toMatchObject({ ok: false, error: 'INVALID_COMMAND_ID' });
    expect(await request(2, { ...body, commandId: grantId.toUpperCase() }, primary)).toMatchObject({ ok: true });
    const grantVersions = () => f.store.db.prepare("SELECT version FROM automation_grants WHERE kind='MODEL'").pluck().all();
    const versions = grantVersions();
    expect(versions).toHaveLength(1);
    expect(await request(2, body, primary, grantId.toUpperCase())).toMatchObject({ ok: false, error: 'COMMAND_REPLAY_BLOCKED' });
    expect(await request(2, { ...body, scope: { ...body.scope, modelLimit: 2 } }, primary, grantId))
      .toMatchObject({ ok: false, error: 'COMMAND_ID_CONFLICT' });
    expect(await request(2, { ...registration, commandId: grantId }, globalScope))
      .toMatchObject({ ok: false, error: 'COMMAND_ID_CONFLICT' });
    expect(await request(2, body, primary, commandId)).toMatchObject({ ok: false, error: 'COMMAND_ID_CONFLICT' });
    expect(grantVersions()).toEqual(versions);
    const ledgerIds = (id: string) => f.store.db.prepare('SELECT command_id FROM protocol_v2_commands WHERE lower(command_id)=?')
      .pluck().all(id);
    expect(ledgerIds(commandId)).toEqual([commandId]);
    expect(ledgerIds(grantId)).toEqual([grantId]);
    const oldId = '550E8400-E29B-41D4-A716-446655440000';
    f.store.db.prepare(`INSERT INTO protocol_v2_commands VALUES (?, 'ACCOUNT', ?, 'setModelGrant', NULL,
      'legacy-digest', 'COMPLETED', NULL, NULL, 0, 0)`).run(oldId, DEFAULT_ACCOUNT_ID);
    expect(await request(2, body, primary, oldId.toLowerCase())).toMatchObject({ ok: false, error: 'COMMAND_REPLAY_BLOCKED' });
    expect(ledgerIds(oldId.toLowerCase())).toEqual([oldId]);
  } finally { await f.close(); }
});

test('lists, registers, reads and disconnects an account while preserving bindings, history and idempotency', async () => {
  const f = await modelFixture();
  try {
    const { request } = harness(f);
    const initial = await request(2, list, globalScope);
    expect(initial).toMatchObject({ ok: true, result: { schemaVersion: 4, accounts: [
      { id: DEFAULT_ACCOUNT_ID, ownId: 'own-1', profileRef: f.root },
    ] } });
    const body = register();
    const readToken = f.service.authority.issueSession(['READ']);
    await expect(f.service.dispatch(readToken, list)).resolves.toMatchObject({ schemaVersion: 4 });
    await expect(f.service.dispatch(readToken, body)).rejects.toThrow('OPERATOR_PERMISSION_DENIED');

    const created = await request(2, body, globalScope);
    expect(created).toMatchObject({ ok: true, result: { accountRef: mockId, status: 'ACTIVE', autoReplyEnabled: false,
      capabilities: mockCapabilities } });
    expect(await request(2, body, globalScope)).toMatchObject({ ok: true, result: created.ok ? created.result : null });
    expect(await request(2, { ...body, displayLabel: 'Changed' }, globalScope)).toMatchObject({ ok: false, error: 'COMMAND_ID_CONFLICT' });
    expect(await request(2, { ...body, commandId: randomUUID(), accountId: 'duplicate' }, globalScope)).toMatchObject({
      ok: false, error: 'ACCOUNT_IDENTITY_CONFLICT',
    });
    expect(await request(2, { ...body, commandId: randomUUID(), accountId: DEFAULT_ACCOUNT_ID, ownId: 'different' }, globalScope))
      .toMatchObject({ ok: false, error: 'ACCOUNT_ID_CONFLICT' });
    expect(await request(1, list)).toMatchObject({ ok: true, result: { accounts: expect.arrayContaining([
      expect.objectContaining({ accountRef: mockId, capabilities: mockCapabilities }),
    ]) } });

    const status = { command: 'accounts', action: 'getAccountStatus', accountRef: mockId };
    expect(await request(2, status, primary)).toMatchObject({ ok: false, error: 'PROTOCOL_SCOPE_MISMATCH' });
    expect(await request(2, { ...status, accountRef: 'missing' }, { kind: 'ACCOUNT', accountRef: 'missing' }))
      .toMatchObject({ ok: false, error: 'ACCOUNT_NOT_FOUND' });
    await expect(f.service.dispatch(readToken, status)).resolves.toMatchObject({ connected: true, connectorState: 'OPEN',
      capabilities: mockCapabilities });

    const disconnect = { command: 'accounts', action: 'disconnectAccount', accountRef: mockId,
      confirmed: true, commandId: randomUUID() };
    expect(await request(2, { ...disconnect, confirmed: false }, secondary)).toMatchObject({ ok: false, error: 'INVALID_COMMAND' });
    expect(await request(2, { ...disconnect, accountRef: DEFAULT_ACCOUNT_ID, commandId: randomUUID() }, primary))
      .toMatchObject({ ok: false, error: 'PRIMARY_ACCOUNT_DISCONNECT_BLOCKED' });
    await expect(f.service.dispatch(readToken, disconnect)).rejects.toThrow('OPERATOR_PERMISSION_DENIED');

    const { db } = f.store;
    const event = candidate({ accountId: mockId });
    const [eventId, draftId, intentId] = [randomUUID(), randomUUID(), randomUUID()];
    db.prepare(`INSERT INTO inbound_events (id,account_id,channel,source_key,scope,target_key,binding,payload,status)
      VALUES (?,?,?,?,?,?,?,?,'INTENT_RECORDED')`).run(eventId, mockId, event.channel, event.platformEventId,
      event.conversationId, targetKey(event), eventBinding(event), JSON.stringify(event));
    db.prepare(`INSERT INTO reply_drafts (id,event_id,text,model,version,status) VALUES (?,?,'Fixture','mock',1,'APPROVED')`)
      .run(draftId, eventId);
    const suggestionId = randomUUID();
    db.prepare("INSERT INTO ai_suggestions VALUES (?,?,1,'fixture','Fixture','mock',0,0)").run(suggestionId, eventId);
    expect(await request(2, { command: 'dismissSuggestion', suggestionId }, primary, randomUUID()))
      .toMatchObject({ ok: false, error: 'SUGGESTION_NOT_FOUND' });
    expect(db.prepare('SELECT dismissed FROM ai_suggestions WHERE id=?').pluck().get(suggestionId)).toBe(0);
    const primarySuggestion = randomUUID();
    db.prepare("INSERT INTO ai_suggestions VALUES (?,?,1,'fixture','Fixture','mock',0,0)").run(primarySuggestion, f.eventId);
    expect(await request(2, { command: 'dismissSuggestion', suggestionId: primarySuggestion }, primary, randomUUID()))
      .toMatchObject({ ok: true, result: { dismissed: true } });
    f.store.audit('FIXTURE_PRIMARY_EVENT', f.eventId);
    const followupId = randomUUID(), followupIntentId = randomUUID();
    db.prepare(`INSERT INTO human_reply_turns (command_id,event_id,target_key,operator_id,input_digest,params,text,
      version,status,intent_id,created_at) VALUES (?,?,?,'operator','fixture','{}','Synthetic',1,'CONFIRMED',?,0)`)
      .run(followupId, eventId, targetKey(event), followupIntentId);
    const row = db.prepare("INSERT INTO audit_events VALUES (?,?,?,?,'{}')");
    const old = '2000-01-01T00:00:00.000Z';
    const current = '2999-01-01T00:00:00.000Z';
    row.run(randomUUID(), old, 'FIXTURE_SECONDARY_EVENT', eventId);
    row.run(randomUUID(), old, 'FIXTURE_FOLLOWUP_COMMAND', followupId);
    row.run(randomUUID(), old, 'FIXTURE_FOLLOWUP_INTENT', followupIntentId);
    row.run(randomUUID(), old, 'FIXTURE_PRE_MIGRATION', 'unknown-legacy');
    row.run(randomUUID(), current, 'FIXTURE_POST_MIGRATION', 'unknown-current');
    const linkedId = randomUUID();
    row.run(linkedId, current, 'FIXTURE_EXPLICIT_LINK', f.eventId);
    db.prepare('INSERT INTO account_audit_links (audit_id,account_id) VALUES (?,?)').run(linkedId, mockId);
    const audit = await request(2, { command: 'getAudit', page: 0 }, primary);
    expect(audit).toMatchObject({ ok: true, result: { items: expect.arrayContaining([
      expect.objectContaining({ event_type: 'FIXTURE_PRIMARY_EVENT' }),
      expect.objectContaining({ event_type: 'FIXTURE_PRE_MIGRATION' }),
    ]) } });
    expect(JSON.stringify(audit)).not.toMatch(/FIXTURE_SECONDARY_EVENT|FIXTURE_FOLLOWUP|FIXTURE_EXPLICIT_LINK|FIXTURE_POST_MIGRATION|ACCOUNT_REGISTERED/u);
    db.prepare(`INSERT INTO send_intents VALUES (?,?,?,?,?,?,'INTENT_RECORDED',?)`)
      .run(intentId, eventId, draftId, targetKey(event), 'fixture-target', 'fixture-text', new Date().toISOString());
    expect(await request(2, { ...disconnect, commandId: randomUUID() }, secondary)).toMatchObject({
      ok: false, error: 'ACCOUNT_OPERATION_IN_PROGRESS',
    });
    expect(() => f.store.receipt(intentId, 'UNCERTAIN', 'fixture-unknown')).toThrow('INTENT_NOT_REVIEWABLE');
    const secondaryStore = new EventStore(db.name, false, undefined, mockId);
    try {
      expect(auditPage(secondaryStore, 0).items).toEqual(expect.arrayContaining(
        ['FIXTURE_SECONDARY_EVENT', 'FIXTURE_FOLLOWUP_COMMAND', 'FIXTURE_FOLLOWUP_INTENT', 'FIXTURE_EXPLICIT_LINK']
          .map(event_type => expect.objectContaining({ event_type })),
      ));
      secondaryStore.receipt(intentId, 'UNCERTAIN', 'fixture-unknown');
    }
    finally { secondaryStore.close(); }
    expect(await request(2, disconnect, secondary)).toMatchObject({ ok: true, result: { accountRef: mockId, status: 'DISCONNECTED' } });
    expect(await request(2, disconnect, secondary)).toMatchObject({ ok: true, result: { status: 'DISCONNECTED' } });
    expect(await request(2, body, globalScope)).toMatchObject({ ok: true, result: created.ok ? created.result : null });
    expect(await request(2, status, secondary)).toMatchObject({ ok: true, result: { status: 'DISCONNECTED',
      ownId: body.ownId, connected: false, connectorState: 'DISCONNECTED' } });
    expect(f.service.accounts.hasMultipleActiveAccounts()).toBe(false);
    expect(db.prepare('SELECT status FROM inbound_events WHERE id=?').pluck().get(eventId)).toBe('UNCERTAIN');
    expect(db.prepare('SELECT proof_ref FROM delivery_receipts WHERE send_intent_id=?').pluck().all(intentId)).toEqual(['fixture-unknown']);
    expect(f.store.db.prepare('SELECT event_type FROM audit_events WHERE entity_id=? ORDER BY rowid').pluck().all(mockId))
      .toEqual(['ACCOUNT_REGISTERED', 'ACCOUNT_DISCONNECTED']);
    expect(await request(2, { ...status, accountRef: DEFAULT_ACCOUNT_ID }, primary)).toMatchObject({ ok: true,
      result: { status: 'ACTIVE', ownId: 'own-1' } });
  } finally { await f.close(); }
});

test('the real development proxy carries v2 requests, scoped events and authenticated bridge replies', async () => {
  const root = privateTemp('protocol-v2-dev-');
  const input = new PassThrough(), output = new PassThrough();
  const lines = createInterface({ input: output });
  type Frame = { protocol?: number; ready?: boolean; requestId?: string; kind?: string; bridgeId?: string; event?: unknown };
  const seen: Frame[] = [];
  lines.on('line', line => seen.push(JSON.parse(line) as Frame));
  const url = pathToFileURL(resolve('scripts/dev-sidecar.mjs')).href;
  const { DevelopmentSidecar } = await import(url) as { DevelopmentSidecar: new (options: {
    root: string; secret: string; input: PassThrough; output: PassThrough; watch: boolean;
  }) => { start(): Promise<void>; close(): Promise<void>; runtime?: string;
    current?: { child: { stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream; kill(signal: string): void } } } };
  const supervisor = new DevelopmentSidecar({ root: resolve('.'), input, output, secret, watch: false });
  const watchdog = setTimeout(() => supervisor.current?.child.kill('SIGKILL'), 29_000);
  const waitFor = async (match: (value: Frame) => boolean) => {
    await expect.poll(() => seen.some(match), { timeout: 6_000 }).toBe(true);
    return seen.find(match)!;
  };
  const requestLine = (body: unknown, scope: ProtocolScope | undefined, requestId: string, nonce = secret) =>
    JSON.stringify({ protocol: scope ? 2 : 1, requestId, secret: nonce, scope, commandId: scope ? randomUUID() : undefined, body });
  const request = async (body: unknown, scope?: ProtocolScope, nonce = secret) => {
    const requestId = randomUUID();
    input.write(requestLine(body, scope, requestId, nonce) + '\n');
    return waitFor(frame => frame.requestId === requestId);
  };
  try {
    vi.stubEnv('INBORA_NATIVE_BRIDGE', '1');
    vi.stubEnv('INBORA_BROWSER_WORKER', '');
    await supervisor.start();
    expect(await request(list, globalScope)).toMatchObject({ protocol: 2, ok: false, error: 'CONNECT_RUNTIME_FIRST' });
    expect(await request(getStatus, primary, '0'.repeat(64))).toMatchObject({ protocol: 2, ok: false, error: 'IPC_AUTHENTICATION_FAILED' });
    expect(await request({ command: 'connect', runtime: root, initialize: true, consent: true }, globalScope))
      .toMatchObject({ protocol: 2, ok: true, result: { runtime: root, schema: 4 } });
    expect(supervisor.runtime).toBe(root);
    expect(await request(list, globalScope)).toMatchObject({ protocol: 2, ok: true, result: { schemaVersion: 4 } });

    const oversizedId = randomUUID();
    input.write(requestLine(getStatus, primary, oversizedId).padEnd(MAX_PROTOCOL_V2_FRAME_BYTES + 1, ' '));
    expect(await waitFor(frame => frame.requestId === oversizedId)).toEqual({
      protocol: 2, requestId: oversizedId, ok: false, error: 'IPC_REQUEST_TOO_LARGE',
    });
    input.write('\n');

    const child = supervisor.current!.child;
    const raw = createInterface({ input: child.stdout });
    const directId = randomUUID();
    const direct = new Promise<Frame>(done => raw.on('line', line => {
      const frame = JSON.parse(line) as Frame;
      if (frame.requestId === directId) done(frame);
    }));
    try {
      child.stdin.write(requestLine(getStatus, undefined, directId).padEnd(100_001, ' '));
      expect(await Promise.race([direct, new Promise((_, reject) => {
        const timeout = setTimeout(() => reject(new Error('Sidecar did not reject an unterminated v1 frame')), 5_000);
        void direct.finally(() => clearTimeout(timeout));
      })])).toEqual({ protocol: 1, requestId: directId, ok: false, error: 'IPC_REQUEST_TOO_LARGE' });
    } finally { raw.close(); child.stdout.resume(); child.stdin.write('\n'); }

    expect(await request({ command: 'emergencyStop' }, globalScope)).toMatchObject({ protocol: 2, ok: true, result: { paused: true } });
    const event = await waitFor(frame => frame.protocol === 2 && !!frame.event);
    expect(protocolV2EventEnvelopeSchema.safeParse(event).success).toBe(true);
    expect(seen).toContainEqual({ protocol: 1, event: event.event });
    expect(seen).toContainEqual({ protocol: 2, scope: primary, event: { event: 'send_status_updated' } });

    const seed = new EventStore(join(root, 'poc.sqlite'));
    try {
      const insert = seed.db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?)');
      seed.db.transaction(() => {
        for (let index = 0; index < 50; index++) {
          insert.run(randomUUID(), new Date().toISOString(), 'FIXTURE_AUDIT', DEFAULT_ACCOUNT_ID, JSON.stringify({ text: '字'.repeat(8_000) }));
        }
      }).immediate();
    } finally { seed.close(); }
    expect(await request({ command: 'getAudit', page: 0 }, primary))
      .toMatchObject({ protocol: 2, ok: false, error: 'SIDECAR_RESPONSE_TOO_LARGE' });
    expect(await request({ command: 'getAudit', page: 0 }))
      .toMatchObject({ protocol: 1, ok: true, result: { page: 0, items: expect.any(Array) } });

    const disconnectId = randomUUID();
    input.write(requestLine({ command: 'disconnect' }, globalScope, disconnectId) + '\n');
    const bridge = await waitFor(frame => frame.kind === 'native_bridge_request');
    expect(bridge).toMatchObject({ bridgeId: expect.any(String), secret, payload: { op: 'clearDpapiCache' } });
    expect(seen.some(frame => frame.requestId === disconnectId)).toBe(false);
    const response = { kind: 'native_bridge_response', bridgeId: bridge.bridgeId, secret, ok: true, result: { cleared: true } };
    const write = vi.spyOn(child.stdin, 'write');
    try {
      input.write(JSON.stringify({ ...response, secret: '0'.repeat(64) }) + '\n');
      input.write(JSON.stringify(response).padEnd(262_145, ' ') + '\n');
      expect(write).not.toHaveBeenCalled();
    } finally { write.mockRestore(); }
    input.write(JSON.stringify(response) + '\n');
    expect(await waitFor(frame => frame.requestId === disconnectId))
      .toMatchObject({ protocol: 2, ok: true, result: { connected: false } });
    expect(supervisor.runtime).toBeUndefined();
  } finally {
    try { await supervisor.close(); }
    finally {
      clearTimeout(watchdog);
      vi.unstubAllEnvs();
      lines.close();
      input.end();
      output.end();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('uses the native bridge for both DPAPI stores and process attribution without spawning PowerShell', async () => {
  const root = privateTemp('protocol-v2-win32-');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const sampler = new BrowserProcessSampler();
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    vi.stubEnv('INBORA_NATIVE_BRIDGE', '1');
    vi.mocked(spawn).mockImplementation(() => { throw new Error('Unexpected process spawn'); });
    vi.mocked(execFile).mockImplementation(() => { throw new Error('Unexpected process execution'); });

    const requests: NativeBridgeRequest['payload'][] = [];
    const frames: string[] = [];
    let createdAt = 100;
    let denySample = false;
    let denyClear = false;
    const edgePid = process.pid + 100;
    registerNativeBridgeTransport({ secret, send: ({ bridgeId, payload }) => {
      requests.push(payload);
      let outcome: { ok: true; result: object } | { ok: false; error: string };
      switch (payload.op) {
        case 'dpapiProtect':
          outcome = { ok: true, result: { dataBase64: Buffer.from(`fixture:${payload.dataBase64}`).toString('base64') } };
          break;
        case 'dpapiUnprotect':
          outcome = { ok: true, result: { dataBase64: Buffer.from(payload.dataBase64, 'base64').toString().slice(8) } };
          break;
        case 'clearDpapiCache':
          outcome = denyClear ? { ok: false, error: 'NATIVE_BRIDGE_BUSY' } : { ok: true, result: { cleared: true } };
          break;
        case 'sampleProcessTree':
          outcome = denySample ? { ok: false, error: 'ACCESS_DENIED' } : { ok: true, result: {
            sampledAt: 200, cached: false, rows: [
              { pid: process.pid, parentPid: 0, name: 'node.exe', createdAt, workingSetBytes: null,
                privateBytes: null, cpuSeconds: null, statCreatedAt: null },
              { pid: edgePid, parentPid: process.pid, name: 'msedge.exe', createdAt: 110, workingSetBytes: 1024,
                privateBytes: 512, cpuSeconds: 1, statCreatedAt: 110 },
            ],
          } };
          break;
      }
      const frame = parseSidecarFrame(JSON.stringify({ kind: 'native_bridge_response', bridgeId, secret, ...outcome }), secret);
      frames.push(frame.kind);
    } });

    const legacy = new CredentialStore(root);
    await legacy.save('legacy-fixture-key');
    await expect(legacy.load()).resolves.toBe('legacy-fixture-key');
    const legacyRead = requests.at(-1)!;
    expect(legacyRead).toMatchObject({ op: 'dpapiUnprotect', cacheKey: expect.any(String),
      mtimeMs: (await stat(join(root, 'model-key.dpapi'))).mtimeMs });
    expect(legacyRead.op).toBe('dpapiUnprotect');
    await legacy.delete();
    if (legacyRead.op === 'dpapiUnprotect') {
      expect(requests.at(-1)).toEqual({ op: 'clearDpapiCache', cacheKey: legacyRead.cacheKey });
      expect(requests[1]).toEqual(requests.at(-1));
    }
    await expect(legacy.load()).resolves.toBeNull();

    const models = new ModelCredentialStore(root);
    const ref = await models.save(randomUUID(), 'model-fixture-key', (saved): ModelCredentialRef => ({ ...saved }), 'DPAPI');
    await expect(models.load(ref, () => true)).resolves.toBe('model-fixture-key');
    const modelRead = requests.at(-1)!;
    const file = join(root, 'model-credentials', ref.connectionId, `${ref.credentialRevision}.dpapi`);
    expect(modelRead).toMatchObject({ op: 'dpapiUnprotect', cacheKey: expect.any(String), mtimeMs: (await stat(file)).mtimeMs });
    const finishCredentialCleanup = vi.fn();
    const registry = { listCleanableCredentials: () => [ref], claimCredentialCleanup: () => true, finishCredentialCleanup };
    denyClear = true;
    await models.cleanup(registry);
    expect(finishCredentialCleanup).toHaveBeenLastCalledWith(ref, true);
    await expect.poll(() => models.cacheInvalidationUnconfirmed).toBe(true);
    expect(requests.at(-1)).toEqual({ op: 'clearDpapiCache', cacheKey: undefined });
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    denyClear = false;
    await models.cleanup({ ...registry, listCleanableCredentials: () => [] });
    await expect.poll(() => models.cacheInvalidationUnconfirmed).toBe(false);
    if (modelRead.op === 'dpapiUnprotect') {
      const clear = { op: 'clearDpapiCache', cacheKey: modelRead.cacheKey };
      expect(requests.at(-1)).toEqual(clear);
      expect(requests.filter(payload => payload.op === 'clearDpapiCache' && payload.cacheKey === modelRead.cacheKey))
        .toEqual([clear, clear, clear]);
    }
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });

    const signal = new AbortController().signal;
    await expect(sampler.sample(signal)).resolves.toMatchObject({ ok: true, value: { rootPid: edgePid, browserProcesses: 1 } });
    expect(requests.at(-1)).toEqual({ op: 'sampleProcessTree', rootPid: process.pid, targetExe: 'msedge.exe', maxAgeMs: 2000 });
    createdAt++;
    await expect(sampler.sample(signal)).resolves.toEqual({ ok: false, reason: 'PROCESS_UNAVAILABLE' });
    denySample = true;
    await expect(sampler.sample(signal)).resolves.toEqual({ ok: false, reason: 'ACCESS_DENIED' });
    expect(frames).toEqual(requests.map(() => 'native'));
    expect(spawn).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  } finally {
    await sampler.close();
    clearNativeWin32Bridge();
    vi.unstubAllEnvs();
    vi.mocked(spawn).mockReset();
    vi.mocked(execFile).mockReset();
    Object.defineProperty(process, 'platform', platform);
    await rm(root, { recursive: true, force: true });
  }
});
