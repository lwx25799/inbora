import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import {
  dispatchTrustedServiceCommand,
  parseSidecarFrame,
  routeSidecarEnvelope,
  type SidecarCommand,
} from '../../src/app/protocol-v2-router.js';
import { BrowserService } from '../../src/app/browser-service.js';
import { WorkbenchAuthority } from '../../src/app/authority.js';
import { createWorkerDispatchLedger } from '../../src/app/isolated-douyin-connector.js';
import { OwnerLock } from '../../src/browser/owner-lock.js';
import {
  webPlatformObservationMappingPath,
  webPlatformReplyMappingPath,
} from '../../src/config/web-platform-mapping.js';
import {
  BILIBILI_PLATFORM_ID,
  XIAOHONGSHU_PLATFORM_ID,
} from '../../src/contracts/account.js';
import type { ProtocolScope } from '../../src/contracts/protocol-v2.js';
import { eventBinding, targetKey, type InboundEvent } from '../../src/core/contracts.js';
import { SendCoordinator } from '../../src/core/send-coordinator.js';
import { BilibiliPlatformConnector } from '../../src/platform/bilibili/index.js';
import { webPlatformCapabilities } from '../../src/platform/web-platform-worker-connector.js';
import { XiaohongshuPlatformConnector } from '../../src/platform/xiaohongshu/index.js';
import { migrateClient } from '../../src/storage/client-migration.js';
import { migrateToSchema4 } from '../../src/storage/schema4-migration.js';
import { EventStore } from '../../src/storage/store.js';
import { BrowserWorkerHost } from '../../src/workers/browser-worker-host.js';
import { buildFixtureMappings, startWebFixtureServer } from '../fixtures/web-platform-fixture.js';
import { candidate } from '../helpers.js';
import { modelFixture } from '../model-provider-helpers.js';

const secret = 'cd'.repeat(32);
const globalScope: ProtocolScope = { kind: 'GLOBAL' };

function harness(f: Parameters<typeof dispatchTrustedServiceCommand>[0] & {
  accounts: NonNullable<Parameters<typeof routeSidecarEnvelope>[1]['accounts']>;
}, token: string) {
  const context = {
    accounts: f.accounts,
    lifecycleCommandIds: new Map<string, string>(),
    dispatch: (body: SidecarCommand, scope?: ProtocolScope) => {
      if (body.command === 'connect' || body.command === 'disconnect') throw new Error('Unexpected lifecycle command');
      return dispatchTrustedServiceCommand(f, token, body, scope);
    },
  };
  const request = async (body: unknown, scope?: ProtocolScope, commandId?: string) => {
    const parsed = parseSidecarFrame(
      JSON.stringify({ protocol: 2, requestId: randomUUID(), secret, body, scope, commandId }),
      secret,
    );
    if (parsed.kind !== 'request') throw new Error('Expected parsed request');
    return routeSidecarEnvelope(parsed.envelope, context);
  };
  return { request };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()!();
  }
});

test.each([XIAOHONGSHU_PLATFORM_ID, BILIBILI_PLATFORM_ID] as const)(
  'synthetic lifecycle for %s: register, profile isolation, draft/approve/send CONFIRMED, UNCERTAIN no-replay, stop, disconnect & reactivate',
  async platform => {
    const f = await modelFixture();
    cleanups.push(() => f.close());
    f.service.accounts.configureWebOptions({ workerMode: 'synthetic' });

    const accountId = `acc_${platform}`;
    const ownId = `self_${platform}_1`;
    const scope: ProtocolScope = { kind: 'ACCOUNT', accountRef: accountId };
    const { request } = harness(f.service, f.token);
    const write = (body: unknown) => request(body, scope, randomUUID());
    const read = async <T>(body: unknown): Promise<T> => {
      const reply = await request(body, scope);
      expect(reply).toMatchObject({ ok: true });
      if (!reply.ok) throw new Error(reply.error);
      return reply.result as T;
    };

    const registered = await request({
      command: 'accounts',
      action: 'registerAccount',
      commandId: randomUUID(),
      platform,
      connector: platform,
      accountId,
      ownId,
      displayLabel: `${platform} 账号`,
    }, globalScope);
    expect(registered).toMatchObject({
      ok: true,
      result: { id: accountId, platform, connector: platform, status: 'ACTIVE', capabilities: webPlatformCapabilities },
    });

    const initialStatus = await read<{
      connected: boolean;
      connectorState: string;
      calibrated: boolean;
      capabilities: typeof webPlatformCapabilities;
    }>({ command: 'accounts', action: 'getAccountStatus', accountRef: accountId });
    expect(initialStatus).toMatchObject({
      connected: false,
      connectorState: 'CLOSED',
      calibrated: false,
      capabilities: webPlatformCapabilities,
    });

    // Case-insensitive accountId & profileRef collisions are rejected before runtime creation.
    await expect(request({
      command: 'accounts',
      action: 'registerAccount',
      commandId: randomUUID(),
      platform,
      connector: platform,
      accountId: accountId.toUpperCase(),
      ownId: `other_${ownId}`,
    }, globalScope)).resolves.toMatchObject({ ok: false, error: 'ACCOUNT_ID_CONFLICT' });
    await expect(request({
      command: 'accounts',
      action: 'registerAccount',
      commandId: randomUUID(),
      platform,
      connector: platform,
      accountId: `alias_${platform}`,
      ownId: `other2_${ownId}`,
      profileRef: `PROFILES\\${accountId.toUpperCase()}`,
    }, globalScope)).resolves.toMatchObject({ ok: false, error: 'ACCOUNT_PROFILE_CONFLICT' });

    const runtime = f.service.accounts.getWebRuntime(accountId)!;
    expect(runtime.profileDir).toBe(join(f.root, 'profiles', accountId));

    // Opening worker without verified identity reports OPEN_UNVERIFIED and connected: false.
    await runtime.connector.open('headless');
    expect(await read({
      command: 'accounts',
      action: 'getAccountStatus',
      accountRef: accountId,
    })).toMatchObject({ connected: false, connectorState: 'OPEN_UNVERIFIED', calibrated: false });

    // Delegate replyPipeline & aiRuntime commands cleanly to WebAccountRuntime.
    expect(await read({ command: 'replyPipeline', action: 'getConfig' })).toMatchObject({
      config: expect.objectContaining({ rhythmProfile: expect.any(String) }),
    });
    expect(await read({ command: 'accountAiFeatures', action: 'get' })).toMatchObject({
      visionEnabled: expect.any(Boolean),
    });

    // Open worker and confirm OwnerLock isolates this account's profile directory.
    expect(await write({ command: 'browser', open: true, mode: 'headless' })).toMatchObject({
      ok: true,
      result: { calibrated: false, schema: 4 },
    });
    expect(existsSync(runtime.profileDir)).toBe(true);
    await expect(OwnerLock.acquire(runtime.profileDir)).rejects.toMatchObject({
      code: 'OWNER_LOCKED_OR_PORT_UNAVAILABLE',
    });

    const openedStatus = await read<{ connected: boolean; connectorState: string; calibrated: boolean }>({
      command: 'accounts',
      action: 'getAccountStatus',
      accountRef: accountId,
    });
    expect(openedStatus).toMatchObject({ connected: true, connectorState: 'OPEN', calibrated: false });

    // Seed inbound event in shared SQLite scoped to this accountId and complete manual reply -> CONFIRMED.
    const accountStore = new EventStore(f.dbPath, false, undefined, accountId);
    cleanups.push(async () => { accountStore.close(); });
    const inbound = candidate({
      accountId,
      platformEventId: `${platform}-msg-1`,
      conversationId: `${platform}-conv-1`,
      text: `Hello from ${platform}`,
      occurredAt: new Date().toISOString(),
    });
    const [eventId] = accountStore.observe(
      'DIRECT_MESSAGE',
      inbound.conversationId!,
      [inbound],
      ownId,
      platform,
      new Date().toISOString(),
      Date.now() - 10_000,
    );
    expect(eventId).toBeTruthy();

    expect(await write({ command: 'setMode', mode: 'MANUAL' })).toMatchObject({ ok: true });
    const selectionId = randomUUID();
    expect(await write({ command: 'selectTarget', eventId, selectionId })).toMatchObject({ ok: true });
    const claim = await write({ command: 'claimHuman', eventId, generation: 0 }) as {
      ok: true;
      result: { generation: number };
    };
    const { generation } = claim.result;
    expect(await write({ command: 'saveDraft', eventId, generation, expectedVersion: 0, text: '已收到，马上处理', suggestionId: null }))
      .toMatchObject({ ok: true });
    const thread = await read<{ draft: { id: string; version: number }; contextVersion: string }>({
      command: 'getThread',
      eventId,
    });
    const params = {
      eventId,
      draftId: thread.draft.id,
      draftVersion: thread.draft.version,
      generation,
      contextVersion: thread.contextVersion,
      selectionId,
      text: '已收到，马上处理',
    };
    const preview = await write({ command: 'previewSend', params }) as { ok: true; result: { commandId: string } };
    const commandId = preview.result.commandId;
    expect(await request({ command: 'submitManualSend', commandId, params, confirmed: true }, scope))
      .toMatchObject({ ok: true });
    await expect.poll(() => request({ command: 'getSendResult', commandId }, scope))
      .toMatchObject({ ok: true, result: { status: 'CONFIRMED', intentId: expect.any(String) } });

    const intentId = accountStore.db.prepare('SELECT id FROM send_intents WHERE event_id=?').pluck().get(eventId) as string;
    expect(createWorkerDispatchLedger(accountStore).hasDispatched(intentId)).toBe(true);

    // UNCERTAIN no-replay check: once readback fails, same intentId cannot be re-dispatched.
    const inbound2 = candidate({
      accountId,
      platformEventId: `${platform}-msg-2`,
      conversationId: `${platform}-conv-2`,
      text: `Second ${platform}`,
      occurredAt: new Date().toISOString(),
    });
    const [event2Id] = accountStore.observe(
      'DIRECT_MESSAGE',
      inbound2.conversationId!,
      [inbound2],
      ownId,
      platform,
      new Date().toISOString(),
      Date.now() - 10_000,
    );
    const selection2Id = randomUUID();
    expect(await write({ command: 'selectTarget', eventId: event2Id, selectionId: selection2Id })).toMatchObject({ ok: true });
    const claim2 = await write({ command: 'claimHuman', eventId: event2Id, generation: 0 }) as {
      ok: true;
      result: { generation: number };
    };
    const generation2 = claim2.result.generation;
    expect(await write({ command: 'saveDraft', eventId: event2Id, generation: generation2, expectedVersion: 0, text: '第二次回复', suggestionId: null }))
      .toMatchObject({ ok: true });
    const thread2 = await read<{ draft: { id: string; version: number }; contextVersion: string }>({
      command: 'getThread',
      eventId: event2Id,
    });
    const params2 = {
      eventId: event2Id!,
      draftId: thread2.draft.id,
      draftVersion: thread2.draft.version,
      generation: generation2,
      contextVersion: thread2.contextVersion,
      selectionId: selection2Id,
      text: '第二次回复',
    };
    const preview2 = await write({ command: 'previewSend', params: params2 }) as { ok: true; result: { commandId: string } };
    const command2Id = preview2.result.commandId;
    const readbackSpy = vi.spyOn(BrowserWorkerHost.prototype, 'readback')
      .mockResolvedValueOnce({ verified: false, evidence: null });
    try {
      expect(await request({ command: 'submitManualSend', commandId: command2Id, params: params2, confirmed: true }, scope))
        .toMatchObject({ ok: true });
      await expect.poll(() => request({ command: 'getSendResult', commandId: command2Id }, scope))
        .toMatchObject({ ok: true, result: { status: 'UNCERTAIN', intentId: expect.any(String) } });
    } finally {
      readbackSpy.mockRestore();
    }
    const intent2Id = accountStore.db.prepare('SELECT id FROM send_intents WHERE event_id=?').pluck().get(event2Id) as string;
    expect(accountStore.receiptForEvent(event2Id!)).toMatchObject({ result: 'UNCERTAIN' });
    expect(createWorkerDispatchLedger(accountStore).hasDispatched(intent2Id)).toBe(true);
    // Replay of same commandId remains UNCERTAIN and never re-dispatches.
    expect(await request({ command: 'submitManualSend', commandId: command2Id, params: params2, confirmed: true }, scope))
      .toMatchObject({ ok: true, result: { status: 'UNCERTAIN' } });
    expect(await write({ command: 'previewSend', params: params2 })).toMatchObject({ ok: false });

    // Emergency stop triggers abortInFlight() on WebAccountRuntime and blocks further sends.
    const abortSpy = vi.spyOn(BrowserWorkerHost.prototype, 'abortInFlight');
    try {
      expect(await request({ command: 'emergencyStop' }, globalScope)).toMatchObject({
        ok: true,
        result: { paused: true, emergencyStopped: true },
      });
      expect(abortSpy).toHaveBeenCalled();
    } finally {
      abortSpy.mockRestore();
    }
    expect(await write({ command: 'previewSend', params })).toMatchObject({ ok: false, error: 'EMERGENCY_STOPPED' });

    // Secondary resume (eventId: null) fails when primary global recovery is unqualified, and succeeds once primary recovery passes.
    expect(await write({ command: 'resume', eventId: null })).toMatchObject({ ok: false });
    expect(await write({ command: 'previewSend', params })).toMatchObject({ ok: false, error: 'EMERGENCY_STOPPED' });

    const primaryRecoverySpy = vi.spyOn(BrowserService.prototype, 'verifyEmergencyRecovery')
      .mockImplementation(async (_ownId, _signal, _check, complete) => {
        complete?.();
      });
    try {
      expect(await write({ command: 'resume', eventId: null })).toMatchObject({
        ok: true,
        result: { paused: false },
      });
      expect(await write({ command: 'browser', open: true, mode: 'headless' })).toMatchObject({
        ok: true,
      });
    } finally {
      primaryRecoverySpy.mockRestore();
    }

    // Disconnect and reactivate lifecycle.
    expect(await write({ command: 'accounts', action: 'disconnectAccount', accountRef: accountId, confirmed: true }))
      .toMatchObject({ ok: true, result: { status: 'DISCONNECTED' } });
    expect(await request({ command: 'getInbox', channel: 'ALL', status: 'ALL', page: 0 }, scope))
      .toMatchObject({ ok: false, error: 'ACCOUNT_DISCONNECTED' });
    expect(await write({ command: 'accounts', action: 'reactivateAccount', accountRef: accountId, confirmed: true }))
      .toMatchObject({ ok: true, result: { status: 'ACTIVE', capabilities: webPlatformCapabilities } });
    expect(await request({ command: 'getInbox', channel: 'ALL', status: 'ALL', page: 0 }, scope))
      .toMatchObject({ ok: true, result: { total: 2 } });
  },
  30_000,
);

test('browser mode blocks uncalibrated real page with PLATFORM_MAPPING_UNCALIBRATED and completes local HTTP fixture lifecycle for xiaohongshu (DM) and bilibili (comment)', async () => {
  const base = join(process.cwd(), '.local', 'tests');
  await mkdir(base, { recursive: true });
  const tempRoot = join(base, `web-browser-${randomUUID().slice(0, 8)}`);
  await mkdir(tempRoot, { recursive: true });
  cleanups.push(() => rm(tempRoot, { recursive: true, force: true }));

  const xhsFixture = await startWebFixtureServer({ platform: XIAOHONGSHU_PLATFORM_ID, selfId: 'xhs-self-1' });
  cleanups.push(() => xhsFixture.close());
  const biliFixture = await startWebFixtureServer({ platform: BILIBILI_PLATFORM_ID, selfId: 'bili-self-1' });
  cleanups.push(() => biliFixture.close());

  const dbPath = join(tempRoot, 'web-browser.sqlite');
  const seed = new EventStore(dbPath, true);
  try {
    await migrateClient(seed, join(tempRoot, 'pre-client.sqlite'));
    await migrateToSchema4(seed, join(tempRoot, 'pre-schema4.sqlite'));
    const nowIso = new Date().toISOString();
    seed.db.prepare('INSERT INTO accounts VALUES (?,?,?,?,?,?,?,?,?)')
      .run('acc_xhs', 'xhs-self-1', XIAOHONGSHU_PLATFORM_ID, XIAOHONGSHU_PLATFORM_ID, 'XHS', 'ACTIVE', '', nowIso, nowIso);
    seed.db.prepare('INSERT INTO accounts VALUES (?,?,?,?,?,?,?,?,?)')
      .run('acc_bili', 'bili-self-1', BILIBILI_PLATFORM_ID, BILIBILI_PLATFORM_ID, 'Bili', 'ACTIVE', '', nowIso, nowIso);
  } finally {
    seed.close();
  }

  const xhsAccountRoot = join(tempRoot, 'accounts', 'acc_xhs');
  const biliAccountRoot = join(tempRoot, 'accounts', 'acc_bili');
  await mkdir(join(xhsAccountRoot, 'mappings'), { recursive: true });
  await mkdir(join(biliAccountRoot, 'mappings'), { recursive: true });

  const xhsStore = new EventStore(dbPath, false, undefined, 'acc_xhs');
  cleanups.push(async () => { xhsStore.close(); });
  const xhsConnector = new XiaohongshuPlatformConnector({
    accountId: 'acc_xhs',
    root: xhsAccountRoot,
    profileDir: join(tempRoot, 'profiles', 'acc_xhs'),
    store: xhsStore,
    mode: 'browser',
    allowFixture: true,
    firstRunAt: Date.parse('2026-11-27T00:00:00.000Z'),
  });
  cleanups.push(() => xhsConnector.close());

  // 1. Uncalibrated real page gate & default allowFixture=false both block with PLATFORM_MAPPING_UNCALIBRATED.
  const strictConnector = new XiaohongshuPlatformConnector({
    accountId: 'acc_xhs',
    root: xhsAccountRoot,
    profileDir: join(tempRoot, 'profiles', 'acc_xhs_strict'),
    store: xhsStore,
    mode: 'browser',
    firstRunAt: Date.parse('2026-11-27T00:00:00.000Z'),
  });
  cleanups.push(() => strictConnector.close());
  const uncalibratedEvent = candidate({
    accountId: 'acc_xhs',
    platformEventId: 'dm-in-1',
    conversationId: 'conv-100',
    actorId: 'peer-200',
    text: '你好，请问发货吗？',
    occurredAt: '2026-11-27T01:00:00.000Z',
  });
  await expect(xhsConnector.adapter(uncalibratedEvent, xhsStore)).rejects.toMatchObject({
    code: 'PLATFORM_MAPPING_UNCALIBRATED',
  });

  // 2. Calibrate local HTTP fixture mappings for xiaohongshu (DM) and bilibili (comment).
  const xhsMappings = buildFixtureMappings(XIAOHONGSHU_PLATFORM_ID, xhsFixture.origin, 'xhs-self-1');
  await writeFile(webPlatformObservationMappingPath(xhsAccountRoot, XIAOHONGSHU_PLATFORM_ID), JSON.stringify(xhsMappings.observation));
  await writeFile(webPlatformReplyMappingPath(xhsAccountRoot, XIAOHONGSHU_PLATFORM_ID), JSON.stringify(xhsMappings.reply));
  await expect(strictConnector.adapter(uncalibratedEvent, xhsStore)).rejects.toMatchObject({
    code: 'PLATFORM_MAPPING_UNCALIBRATED',
  });

  const observedXhs = await xhsConnector.observe(xhsStore, 'dm');
  expect(observedXhs.newEventIds).toHaveLength(2);
  const xhsEventId = observedXhs.newEventIds.find(id => xhsStore.event(id).payload.platformEventId === 'dm-in-1')!;
  expect(xhsEventId).toBeTruthy();
  const xhsEvent = xhsStore.event(xhsEventId).payload;
  const xhsAuth = new WorkbenchAuthority(xhsStore, Date.now, 'acc_xhs');
  const xhsToken = xhsAuth.issueSession();
  const xhsIdentity = await xhsConnector.refreshIdentity('DIRECT_MESSAGE');
  expect(xhsIdentity).toBeTruthy();
  xhsAuth.attest('DIRECT_MESSAGE', 'SEND_AVAILABLE', xhsIdentity!, 'fixture');
  xhsAuth.setMode(xhsToken, 'MANUAL');
  const xhsSelectionId = randomUUID();
  xhsAuth.select(xhsToken, xhsEventId, xhsSelectionId);
  const xhsClaim = xhsAuth.claim(xhsToken, xhsEventId, 0);
  const xhsDraft = xhsAuth.save(xhsToken, xhsEventId, xhsClaim.generation, 0, '小红书客服已确认发货', null);
  const xhsHandle = await xhsConnector.adapter(xhsEvent, xhsStore);
  try {
    const xhsSnap = await xhsHandle.adapter.inspect(xhsEvent);
    const xhsParams = {
      eventId: xhsEventId,
      draftId: xhsDraft.id,
      draftVersion: xhsDraft.version,
      generation: xhsClaim.generation,
      contextVersion: xhsAuth.contextVersion(xhsStore.event(xhsEventId)),
      selectionId: xhsSelectionId,
      text: xhsDraft.text,
    };
    const { commandId: xhsCmdId } = xhsAuth.preview(xhsToken, xhsParams, xhsSnap, xhsIdentity);
    xhsAuth.queue(xhsToken, xhsCmdId, xhsParams, xhsIdentity);
    const xhsGuard = xhsAuth.dispatchGuard(xhsToken, xhsCmdId, () => xhsConnector.identity('DIRECT_MESSAGE'));
    const coordinator = new SendCoordinator(xhsStore, xhsConnector.actor, 'acc_xhs');
    await expect(coordinator.send(xhsDraft.id, xhsHandle.adapter, true, xhsGuard)).resolves.toBe('CONFIRMED');
    xhsAuth.finish(xhsCmdId, 'CONFIRMED', null);
    expect(xhsFixture.posts()).toBe(1);
    expect(xhsStore.receiptForEvent(xhsEventId)).toMatchObject({ result: 'CONFIRMED' });
  } finally {
    await xhsHandle.dispose();
  }
  await expect(xhsConnector.verifyExisting(xhsStore, xhsEventId)).resolves.toMatchObject({
    verified: true,
    evidenceId: expect.any(String),
  });

  // 3. Bilibili comment lifecycle in real Playwright fixture mode.
  const biliStore = new EventStore(dbPath, false, undefined, 'acc_bili');
  cleanups.push(async () => { biliStore.close(); });
  const biliMappings = buildFixtureMappings(BILIBILI_PLATFORM_ID, biliFixture.origin, 'bili-self-1');
  await writeFile(webPlatformObservationMappingPath(biliAccountRoot, BILIBILI_PLATFORM_ID), JSON.stringify(biliMappings.observation));
  await writeFile(webPlatformReplyMappingPath(biliAccountRoot, BILIBILI_PLATFORM_ID), JSON.stringify(biliMappings.reply));

  const biliConnector = new BilibiliPlatformConnector({
    accountId: 'acc_bili',
    root: biliAccountRoot,
    profileDir: join(tempRoot, 'profiles', 'acc_bili'),
    store: biliStore,
    mode: 'browser',
    allowFixture: true,
    firstRunAt: Date.parse('2026-11-27T00:00:00.000Z'),
  });
  cleanups.push(() => biliConnector.close());

  const observedBili = await biliConnector.observe(biliStore, 'works');
  expect(observedBili.newEventIds).toHaveLength(2);
  const biliOtherEventId = observedBili.newEventIds.find(id => biliStore.event(id).payload.platformEventId === 'cmt-other')!;
  const biliOtherEvent = biliStore.event(biliOtherEventId).payload;
  const biliEventId = observedBili.newEventIds.find(id => biliStore.event(id).payload.platformEventId === 'cmt-in-1')!;
  expect(biliEventId).toBeTruthy();
  const biliEvent = biliStore.event(biliEventId).payload;
  expect(biliEvent.channel).toBe('COMMENT_NOTIFICATION');
  expect(targetKey(biliEvent)).toBe('comment:vid-300:cmt-in-1');

  const biliAuth = new WorkbenchAuthority(biliStore, Date.now, 'acc_bili');
  const biliToken = biliAuth.issueSession();
  const biliIdentity = await biliConnector.refreshIdentity('COMMENT_NOTIFICATION');
  expect(biliIdentity).toBeTruthy();
  biliAuth.attest('COMMENT_NOTIFICATION', 'SEND_AVAILABLE', biliIdentity!, 'fixture');
  biliAuth.setMode(biliToken, 'MANUAL');

  // Mid-flight mapping swap AFTER prepare must block execute with zero outbound posts.
  const swapSelectionId = randomUUID();
  biliAuth.select(biliToken, biliOtherEventId, swapSelectionId);
  const swapClaim = biliAuth.claim(biliToken, biliOtherEventId, 0);
  const swapDraft = biliAuth.save(biliToken, biliOtherEventId, swapClaim.generation, 0, '映射变更后禁止发送', null);
  const swapHandle = await biliConnector.adapter(biliOtherEvent, biliStore);
  const coordinator = new SendCoordinator(biliStore, biliConnector.actor, 'acc_bili');
  try {
    const swapSnap = await swapHandle.adapter.inspect(biliOtherEvent);
    const blockedParams = {
      eventId: biliOtherEventId, draftId: swapDraft.id, draftVersion: swapDraft.version,
      generation: swapClaim.generation, contextVersion: biliAuth.contextVersion(biliStore.event(biliOtherEventId)),
      selectionId: swapSelectionId, text: swapDraft.text,
    };
    const { commandId: blockedCmdId } = biliAuth.preview(biliToken, blockedParams, swapSnap, biliIdentity);
    biliAuth.queue(biliToken, blockedCmdId, blockedParams, biliIdentity);
    const blockedGuard = biliAuth.dispatchGuard(biliToken, blockedCmdId, () => biliConnector.identity('COMMENT_NOTIFICATION'));
    const swapAdapter = {
      ...swapHandle.adapter,
      prepare: async (current: InboundEvent, text: string) => {
        await swapHandle.adapter.prepare(current, text);
        const modifiedReply = { ...biliMappings.reply, selfId: 'bili-self-1',
          selectors: { ...biliMappings.reply.selectors, selfIdAttribute: 'data-changed' } };
        await writeFile(webPlatformReplyMappingPath(biliAccountRoot, BILIBILI_PLATFORM_ID), JSON.stringify(modifiedReply));
      },
    };
    await expect(coordinator.send(swapDraft.id, swapAdapter, true, blockedGuard)).resolves.toBe('UNCERTAIN');
    expect(biliFixture.posts()).toBe(0);
    expect(biliStore.receiptForEvent(biliOtherEventId)).toMatchObject({
      result: 'UNCERTAIN',
      proof_ref: expect.stringMatching(/^POST_INTENT_FAILURE:DISPATCH:/u),
    });
  } finally {
    await writeFile(webPlatformReplyMappingPath(biliAccountRoot, BILIBILI_PLATFORM_ID), JSON.stringify(biliMappings.reply));
    await swapHandle.dispose();
  }

  const biliSelectionId = randomUUID();
  biliAuth.select(biliToken, biliEventId, biliSelectionId);
  const biliClaim = biliAuth.claim(biliToken, biliEventId, 0);
  const biliDraft = biliAuth.save(biliToken, biliEventId, biliClaim.generation, 0, 'B站评论区下单链接在置顶', null);
  const biliHandle = await biliConnector.adapter(biliEvent, biliStore);
  try {
    const biliSnap = await biliHandle.adapter.inspect(biliEvent);
    const biliParams = {
      eventId: biliEventId,
      draftId: biliDraft.id,
      draftVersion: biliDraft.version,
      generation: biliClaim.generation,
      contextVersion: biliAuth.contextVersion(biliStore.event(biliEventId)),
      selectionId: biliSelectionId,
      text: biliDraft.text,
    };
    const { commandId: biliCmdId } = biliAuth.preview(biliToken, biliParams, biliSnap, biliIdentity);
    biliAuth.queue(biliToken, biliCmdId, biliParams, biliIdentity);
    const biliGuard = biliAuth.dispatchGuard(biliToken, biliCmdId, () => biliConnector.identity('COMMENT_NOTIFICATION'));
    await expect(coordinator.send(biliDraft.id, biliHandle.adapter, true, biliGuard)).resolves.toBe('CONFIRMED');
    biliAuth.finish(biliCmdId, 'CONFIRMED', null);
    expect(biliFixture.posts()).toBe(1);
    expect(biliStore.receiptForEvent(biliEventId)).toMatchObject({ result: 'CONFIRMED' });
    const biliIntentId = biliStore.db.prepare('SELECT id FROM send_intents WHERE event_id=?').pluck().get(biliEventId) as string;
    expect(createWorkerDispatchLedger(biliStore).hasDispatched(biliIntentId)).toBe(true);
    expect(eventBinding(biliEvent)).toBeTruthy();
  } finally {
    await biliHandle.dispose();
  }
  await expect(biliConnector.verifyExisting(biliStore, biliEventId)).resolves.toMatchObject({
    verified: true,
    evidenceId: expect.any(String),
  });
}, 45_000);
