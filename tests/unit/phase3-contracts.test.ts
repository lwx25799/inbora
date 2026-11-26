import { describe, expect, expectTypeOf, test } from 'vitest';
import {
  DEFAULT_ACCOUNT_ID, DOUYIN_PLATFORM_ID, MOCK_PLATFORM_ID, accountIdSchema, accountRefSchema,
  accountSummarySchema, legacyTargetAliasSchema, platformIdSchema, targetRefSchema,
} from '../../src/contracts/account.js';
import {
  accountsCommandSchema, commandSchema, envelopeSchema, protocolVersion, protocolVersionV2, type AccountSummary,
} from '../../src/contracts/client.js';
import {
  MAX_PROTOCOL_V2_FRAME_BYTES, PROTOCOL_V1, PROTOCOL_V2, isMutatingClientCommand, protocolScopeSchema,
  protocolV2EventEnvelopeSchema, protocolV2RequestEnvelopeSchema, protocolV2ResponseEnvelopeSchema, requiredScopeForCommand,
} from '../../src/contracts/protocol-v2.js';
import {
  MAX_WORKER_FRAME_BYTES, WorkerCommandSchema, WorkerRequestEnvelopeSchema, WorkerResponseEnvelopeSchema, WorkerSendBindingSchema,
} from '../../src/contracts/browser-worker.js';
import {
  MAX_NATIVE_BRIDGE_BYTES, NATIVE_BRIDGE_PROTOCOL, nativeBridgeRequestSchema, nativeBridgeResponseSchema,
  nativeProcessRowSchema, nativeProcessSampleSchema, type NativeProcessRow,
} from '../../src/contracts/native-bridge.js';
import type { BrowserProcessRow } from '../../src/observability/browser-metrics.js';

const accountRef = DEFAULT_ACCOUNT_ID;
const commandId = '57263a9b-42a0-49c0-8fee-3a350392d3cf';
const requestId = '86439ba9-cd45-49d2-b893-5db6ac28baed';
const sessionId = '224def56-50b3-4fc5-a32a-14f5775ada81';
const secret = 'a'.repeat(64);
const timestamp = '2026-11-25T00:00:00.000Z';
const listAccounts = { command: 'accounts', action: 'listAccounts' };
const registerAccount = {
  command: 'accounts', action: 'registerAccount', commandId, platform: DOUYIN_PLATFORM_ID, connector: 'web',
};
const getAccountStatus = { command: 'accounts', action: 'getAccountStatus', accountRef };
const disconnectAccount = { command: 'accounts', action: 'disconnectAccount', commandId, accountRef, confirmed: true };

describe('account contracts', () => {
  test('extends the client union and preserves the protocol v1 envelope', () => {
    for (const body of [listAccounts, registerAccount, getAccountStatus, disconnectAccount]) {
      expect(accountsCommandSchema.parse(body)).toEqual(body);
      expect(commandSchema.parse(body)).toEqual(body);
    }
    const v1 = { protocol: protocolVersion, requestId, session: secret, body: { command: 'getStatus' } };
    expect(envelopeSchema.parse(v1)).toEqual(v1);
    expect(protocolVersion).toBe(1);
    expect(protocolVersionV2).toBe(2);
    expect(accountRefSchema).toBe(accountIdSchema);
    expect(accountRefSchema.parse(accountRef)).toBe('account_001');
  });

  test('validates platform and target refs and account registration options', () => {
    expect(platformIdSchema.parse(MOCK_PLATFORM_ID)).toBe('mock-platform');
    expect(platformIdSchema.safeParse('a'.repeat(64)).success).toBe(true);
    expect(platformIdSchema.safeParse('a'.repeat(65)).success).toBe(false);
    expect(targetRefSchema.safeParse('x'.repeat(256)).success).toBe(true);
    expect(targetRefSchema.safeParse('x'.repeat(257)).success).toBe(false);
    const withOptions = { ...registerAccount, accountId: accountRef, ownId: '123', displayLabel: 'Demo', profileRef: 'profile-a' };
    expect(accountsCommandSchema.parse(withOptions)).toEqual(withOptions);
    for (const invalid of [
      { ...listAccounts, action: 'unknown' },
      { ...listAccounts, accountRef },
      { ...registerAccount, platform: 'Douyin' },
      { ...registerAccount, commandId: 'invalid' },
      { ...registerAccount, connector: 'x'.repeat(65) },
      { ...withOptions, profileRef: 'x'.repeat(261) },
      { ...getAccountStatus, accountRef: 'bad/ref' },
      { ...disconnectAccount, confirmed: false },
      { ...disconnectAccount, commandId: undefined },
    ]) expect(accountsCommandSchema.safeParse(invalid).success).toBe(false);
  });

  test('validates account summaries and legacy target aliases', () => {
    const summary: AccountSummary = {
      id: accountRef, accountRef, platform: MOCK_PLATFORM_ID, connector: 'mock', ownId: null,
      displayLabel: 'Mock account', status: 'DISCONNECTED', profileRef: 'profile-a',
      capabilities: {
        channels: ['DIRECT_MESSAGE', 'COMMENT_NOTIFICATION'], loginRecovery: true,
        manualSecurityRecovery: false, preview: true, readback: true,
      },
      autoReplyEnabled: false, createdAt: timestamp, updatedAt: timestamp,
    };
    expect(accountSummarySchema.parse(summary)).toEqual(summary);
    expect(accountSummarySchema.safeParse({ ...summary, status: 'OPEN' }).success).toBe(false);
    expect(accountSummarySchema.safeParse({
      ...summary, capabilities: { ...summary.capabilities, channels: ['EMAIL'] },
    }).success).toBe(false);

    const alias = { accountId: accountRef, legacyTargetKey: 'dm:123', targetRef: 'target-a', channel: 'DIRECT_MESSAGE', createdAt: timestamp };
    expect(legacyTargetAliasSchema.parse(alias)).toEqual(alias);
    expect(legacyTargetAliasSchema.safeParse({ ...alias, targetRef: '' }).success).toBe(false);
  });
});

describe('protocol v2', () => {
  test('classifies valid global and account commands and their mutations', () => {
    const cases = [
      [{ command: 'connect', runtime: 'runtime-a', initialize: false, consent: true }, 'GLOBAL', true],
      [{ command: 'disconnect' }, 'GLOBAL', true],
      [{ command: 'emergencyStop' }, 'GLOBAL', true],
      [{ command: 'modelProviders', action: 'list' }, 'GLOBAL', false],
      [{ command: 'modelProviders', action: 'delete', connectionId: commandId, expectedVersion: 1 }, 'GLOBAL', true],
      [listAccounts, 'GLOBAL', false],
      [registerAccount, 'GLOBAL', true],
      [getAccountStatus, 'ACCOUNT', false],
      [disconnectAccount, 'ACCOUNT', true],
      [{ command: 'getStatus' }, 'ACCOUNT', false],
      [{ command: 'getSendResult', commandId }, 'ACCOUNT', false],
      [{ command: 'setAutomaticReply', enabled: true }, 'ACCOUNT', true],
      [{ command: 'replyKnowledge', action: 'overview' }, 'ACCOUNT', false],
      [{ command: 'replyKnowledge', action: 'deleteSource', sourceId: commandId }, 'ACCOUNT', true],
      [{ command: 'getMessagePreview', eventId: requestId, previewId: secret }, 'ACCOUNT', false],
      [{ command: 'getMessagePreview', eventId: requestId, refresh: true }, 'ACCOUNT', true],
    ] as const;
    for (const [body, scope, mutating] of cases) {
      expect(requiredScopeForCommand(body)).toBe(scope);
      expect(isMutatingClientCommand(body)).toBe(mutating);
    }
  });

  test('rejects malformed bodies, including recognized commands with invalid data', () => {
    for (const body of [
      null, [], 'getStatus', {}, { command: 'unknown' }, { ...listAccounts, action: 'unknown' },
      { command: 'connect', runtime: 'runtime-a', initialize: false, consent: false },
      { command: 'getStatus', unexpected: true }, { ...disconnectAccount, confirmed: false },
      { command: 'getMessagePreview', eventId: requestId },
      { command: 'modelProviders', action: 'delete', connectionId: 'bad', expectedVersion: 1 },
    ]) {
      expect(requiredScopeForCommand(body)).toBeNull();
      expect(isMutatingClientCommand(body)).toBe(false);
    }
  });

  test('validates request version, secret, scope and strict fields', () => {
    expect([PROTOCOL_V1, PROTOCOL_V2, MAX_PROTOCOL_V2_FRAME_BYTES]).toEqual([1, 2, 1_048_576]);
    const scope = { kind: 'ACCOUNT', accountRef };
    const request = { protocol: PROTOCOL_V2, requestId, secret, scope, commandId, body: disconnectAccount };
    expect(protocolV2RequestEnvelopeSchema.parse(request)).toEqual(request);
    const globalRequest = { protocol: PROTOCOL_V2, requestId, secret, scope: { kind: 'GLOBAL' }, body: listAccounts };
    expect(protocolV2RequestEnvelopeSchema.parse(globalRequest)).toEqual(globalRequest);
    expect(protocolScopeSchema.safeParse({ kind: 'GLOBAL', accountRef }).success).toBe(false);
    for (const invalid of [
      { ...request, protocol: PROTOCOL_V1 }, { ...request, requestId: 'invalid' }, { ...request, secret: 'short' },
      { ...request, commandId: 'invalid' }, { ...request, scope: { kind: 'ACCOUNT' } },
      { ...request, scope: { ...scope, extra: 1 } }, { ...request, session: secret },
      { protocol: PROTOCOL_V2, requestId, secret, scope },
    ]) expect(protocolV2RequestEnvelopeSchema.safeParse(invalid).success).toBe(false);
  });

  test('validates both response branches and scoped event envelopes', () => {
    const header = { protocol: PROTOCOL_V2, requestId };
    const success = { ...header, ok: true, result: null };
    const failure = { ...header, ok: false, error: 'INVALID_COMMAND' };
    expect(protocolV2ResponseEnvelopeSchema.parse(success)).toEqual(success);
    expect(protocolV2ResponseEnvelopeSchema.parse(failure)).toEqual(failure);
    expect(protocolV2ResponseEnvelopeSchema.safeParse({ ...failure, result: null }).success).toBe(false);
    expect(protocolV2ResponseEnvelopeSchema.safeParse({ ...header, ok: true }).success).toBe(false);

    const event = { protocol: PROTOCOL_V2, scope: { kind: 'ACCOUNT', accountRef }, event: { event: 'status_updated' } };
    expect(protocolV2EventEnvelopeSchema.parse(event)).toEqual(event);
    expect(protocolV2EventEnvelopeSchema.safeParse({ ...event, requestId }).success).toBe(false);
    expect(protocolV2EventEnvelopeSchema.safeParse({ protocol: PROTOCOL_V2, scope: event.scope }).success).toBe(false);
  });
});

describe('browser worker contracts', () => {
  const header = { id: requestId, sessionId, ownerEpoch: 0 };
  const binding = {
    intentId: commandId, nonce: requestId, sessionId, ownerEpoch: 0, notBefore: timestamp,
    textDigest: 'a'.repeat(64), targetDigest: 'b'.repeat(64),
  };

  test('requires validated send binding fields', () => {
    expect(MAX_WORKER_FRAME_BYTES).toBe(1_048_576);
    expect(WorkerSendBindingSchema.parse(binding)).toEqual(binding);
    for (const invalid of [
      { ...binding, intentId: 'invalid' }, { ...binding, nonce: 'invalid' }, { ...binding, sessionId: 'invalid' },
      { ...binding, ownerEpoch: -1 }, { ...binding, ownerEpoch: 0.5 }, { ...binding, notBefore: '' },
      { ...binding, notBefore: 'x'.repeat(65) }, { ...binding, textDigest: 'A'.repeat(64) },
      { ...binding, targetDigest: 'b'.repeat(63) }, { ...binding, extra: false },
    ]) expect(WorkerSendBindingSchema.safeParse(invalid).success).toBe(false);
  });

  test('validates all action tags and send and readback payloads', () => {
    for (const action of ['hello', 'status', 'open', 'close', 'observe', 'inspectTarget', 'prepareSend', 'cancelPreparation', 'shutdown']) {
      expect(WorkerCommandSchema.parse({ action })).toEqual({ action });
    }
    const execute = { action: 'executeSend', binding, text: 'Exact text' };
    const readback = { action: 'readback', intentId: commandId, baseline: ['previous-id'], notBefore: timestamp, text: execute.text };
    const request = { ...header, command: execute };
    expect(WorkerRequestEnvelopeSchema.parse(request)).toEqual(request);
    expect(WorkerCommandSchema.parse(readback)).toEqual(readback);
    expect(WorkerCommandSchema.safeParse({ action: 'executeSend', text: execute.text }).success).toBe(false);
    expect(WorkerCommandSchema.safeParse({ ...execute, text: null }).success).toBe(false);
    expect(WorkerCommandSchema.safeParse({ ...readback, baseline: [1] }).success).toBe(false);
    expect(WorkerCommandSchema.safeParse({ ...readback, intentId: undefined }).success).toBe(false);
    expect(WorkerCommandSchema.safeParse({ action: 'send' }).success).toBe(false);
    expect(WorkerRequestEnvelopeSchema.safeParse({ ...request, ownerEpoch: -1 }).success).toBe(false);
  });

  test('distinguishes success and failure worker responses', () => {
    const success = { ...header, ok: true, result: { state: 'READY' } };
    const failure = { ...header, ok: false, error: 'OWNER_CHANGED' };
    expect(WorkerResponseEnvelopeSchema.parse(success)).toEqual(success);
    expect(WorkerResponseEnvelopeSchema.parse(failure)).toEqual(failure);
    expect(WorkerResponseEnvelopeSchema.safeParse({ ...failure, error: { message: 'bad' } }).success).toBe(false);
    expect(WorkerResponseEnvelopeSchema.safeParse({ ...failure, result: null }).success).toBe(false);
    expect(WorkerResponseEnvelopeSchema.safeParse({ ...header, ok: true }).success).toBe(false);
  });
});

describe('native bridge contracts', () => {
  const bridge = { bridgeId: requestId, secret };
  const dpapi = { dataBase64: 'YQ==', entropy: 'inbora:model-key:v1' };

  test('validates the native request envelope and each operation', () => {
    expect([NATIVE_BRIDGE_PROTOCOL, MAX_NATIVE_BRIDGE_BYTES]).toEqual([1, 262_144]);
    const header = { kind: 'native_bridge_request', ...bridge };
    const sampling = { op: 'sampleProcessTree', rootPid: 1, targetExe: 'msedge.exe', maxAgeMs: 30_000 };
    for (const payload of [
      { op: 'dpapiProtect', ...dpapi }, { op: 'dpapiUnprotect', ...dpapi },
      { op: 'dpapiUnprotect', ...dpapi, cacheKey: 'credential-a', mtimeMs: 123.5 },
      { op: 'clearDpapiCache' }, { op: 'clearDpapiCache', cacheKey: 'credential-a' }, sampling,
    ]) expect(nativeBridgeRequestSchema.parse({ ...header, payload })).toEqual({ ...header, payload });
    for (const payload of [
      { op: 'dpapiProtect', ...dpapi, dataBase64: '!' }, { op: 'dpapiProtect', ...dpapi, entropy: 9 },
      { op: 'dpapiUnprotect', ...dpapi, mtimeMs: '123' }, { op: 'clearDpapiCache', cacheKey: 4 },
      { ...sampling, rootPid: 0 }, { ...sampling, rootPid: 1.5 }, { ...sampling, maxAgeMs: -1 },
      { ...sampling, maxAgeMs: 30_001 }, { ...sampling, unexpected: true }, { op: 'unknown' },
    ]) expect(nativeBridgeRequestSchema.safeParse({ ...header, payload }).success).toBe(false);
    expect(nativeBridgeRequestSchema.safeParse({ ...header, payload: sampling, secret: 'short' }).success).toBe(false);
  });

  test('validates the native response and process sampling payloads', () => {
    expectTypeOf<NativeProcessRow>().toEqualTypeOf<BrowserProcessRow>();
    const row = {
      pid: 2, parentPid: 0, name: 'msedge.exe', createdAt: 1000,
      workingSetBytes: 4096, privateBytes: null, cpuSeconds: 0.5, statCreatedAt: null,
    };
    const sample = { rows: [row], sampledAt: 1001, cached: false };
    const header = { kind: 'native_bridge_response', ...bridge };
    const success = { ...header, ok: true, result: sample };
    const failure = { ...header, ok: false, error: 'PROCESS_UNAVAILABLE' };
    expect(nativeBridgeResponseSchema.parse(success)).toEqual(success);
    expect(nativeBridgeResponseSchema.parse(failure)).toEqual(failure);
    expect(nativeBridgeResponseSchema.safeParse({ ...failure, result: null }).success).toBe(false);
    expect(nativeBridgeResponseSchema.safeParse({ ...success, bridgeId: 'invalid' }).success).toBe(false);
    expect(nativeProcessRowSchema.parse(row)).toEqual(row);
    expect(nativeProcessSampleSchema.parse(sample)).toEqual(sample);
    expect(nativeProcessRowSchema.safeParse({ ...row, privateBytes: -1 }).success).toBe(false);
    expect(nativeProcessSampleSchema.safeParse({ ...sample, sampledAt: 0 }).success).toBe(false);
    expect(nativeProcessSampleSchema.safeParse({ ...sample, rows: Array<NativeProcessRow>(16_385).fill(row) }).success).toBe(false);
  });
});
