import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, win32 } from 'node:path';
import { chromium } from 'playwright';
import { afterEach, expect, test, vi } from 'vitest';
import { WebPlatformReplyAdapter } from '../../src/adapters/web-platform-adapter.js';
import { WebPlatformReader } from '../../src/adapters/web-platform-reader.js';
import { AccountController } from '../../src/app/account-controller.js';
import { BrowserService } from '../../src/app/browser-service.js';
import {
  dispatchTrustedServiceCommand,
  parseSidecarFrame,
  routeSidecarEnvelope,
  type SidecarCommand,
} from '../../src/app/protocol-v2-router.js';
import { BILIBILI_PLATFORM_ID, XIAOHONGSHU_PLATFORM_ID } from '../../src/contracts/account.js';
import type { ProtocolScope } from '../../src/contracts/protocol-v2.js';
import { Blocked, digest, type InboundEvent } from '../../src/core/contracts.js';
import { MockPlatformConnector } from '../../src/platform/mock-platform-connector.js';
import { WebPlatformWorkerConnector } from '../../src/platform/web-platform-worker-connector.js';
import { AccountStore, resolveWebProfileDir } from '../../src/storage/account-store.js';
import { holdSecurityChannel, resolveSecurityHold, securityRevision } from '../../src/storage/security-holds.js';
import { migrateClient } from '../../src/storage/client-migration.js';
import { migrateToSchema4 } from '../../src/storage/schema4-migration.js';
import { EventStore } from '../../src/storage/store.js';
import { BrowserWorkerHost } from '../../src/workers/browser-worker-host.js';
import { candidate } from '../helpers.js';
import { modelFixture } from '../model-provider-helpers.js';

const secret = 'ef'.repeat(32);
const globalScope: ProtocolScope = { kind: 'GLOBAL' };

function harness(
  f: Parameters<typeof dispatchTrustedServiceCommand>[0] & {
    accounts: NonNullable<Parameters<typeof routeSidecarEnvelope>[1]['accounts']>;
  },
  token: string,
) {
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

test('canonicalizes Windows profileRef variants, blocks pre-commit directory collisions, and isolates startup clashes as UNAVAILABLE', async () => {
  const f = await modelFixture();
  cleanups.push(() => f.close());
  f.service.accounts.configureWebOptions({ workerMode: 'synthetic' });
  const { request } = harness(f.service, f.token);

  const first = await request({
    command: 'accounts',
    action: 'registerAccount',
    commandId: randomUUID(),
    platform: XIAOHONGSHU_PLATFORM_ID,
    connector: XIAOHONGSHU_PLATFORM_ID,
    accountId: 'xhs_desk',
    ownId: 'self-desk-1',
    profileRef: 'profiles/desk',
  }, globalScope);
  expect(first).toMatchObject({ ok: true, result: { id: 'xhs_desk' } });
  expect(f.service.accounts.getWebRuntime('xhs_desk')?.profileDir)
    .toBe(resolveWebProfileDir(f.root, 'xhs_desk', 'profiles/desk'));

  for (const variant of ['PROFILES\\.\\Desk', 'profiles//desk', 'profiles/sub/../desk']) {
    await expect(request({
      command: 'accounts',
      action: 'registerAccount',
      commandId: randomUUID(),
      platform: XIAOHONGSHU_PLATFORM_ID,
      connector: XIAOHONGSHU_PLATFORM_ID,
      accountId: `acc_${randomUUID().slice(0, 6)}`,
      ownId: `self-${randomUUID().slice(0, 6)}`,
      profileRef: variant,
    }, globalScope)).resolves.toMatchObject({ ok: false, error: 'ACCOUNT_PROFILE_CONFLICT' });
  }

  // profileRef: 'desk2' for account 'desk2' resolves to profiles/desk2, blocking a second account claiming 'profiles/desk2',
  // and 'profile' collides with the primary account's <runtime>/profile directory.
  await expect(request({
    command: 'accounts',
    action: 'registerAccount',
    commandId: randomUUID(),
    platform: XIAOHONGSHU_PLATFORM_ID,
    connector: XIAOHONGSHU_PLATFORM_ID,
    accountId: 'desk2',
    ownId: 'self-desk-only',
    profileRef: 'desk2',
  }, globalScope)).resolves.toMatchObject({ ok: true });
  await expect(request({
    command: 'accounts',
    action: 'registerAccount',
    commandId: randomUUID(),
    platform: BILIBILI_PLATFORM_ID,
    connector: BILIBILI_PLATFORM_ID,
    accountId: 'desk2_dup',
    ownId: 'self-desk-dup',
    profileRef: 'profiles/desk2',
  }, globalScope)).resolves.toMatchObject({ ok: false, error: 'ACCOUNT_PROFILE_CONFLICT' });
  await expect(request({
    command: 'accounts',
    action: 'registerAccount',
    commandId: randomUUID(),
    platform: BILIBILI_PLATFORM_ID,
    connector: BILIBILI_PLATFORM_ID,
    accountId: 'primary_clash',
    ownId: 'self-primary-clash',
    profileRef: 'profile',
  }, globalScope)).resolves.toMatchObject({ ok: false, error: 'ACCOUNT_PROFILE_CONFLICT' });

  // Case-variant pre-existing directory blocks registration before SQLite commit.
  await mkdir(join(f.root, 'profiles', 'CaseClash'), { recursive: true });
  await expect(request({
    command: 'accounts',
    action: 'registerAccount',
    commandId: randomUUID(),
    platform: BILIBILI_PLATFORM_ID,
    connector: BILIBILI_PLATFORM_ID,
    accountId: 'caseclash',
    ownId: 'self-clash',
  }, globalScope)).resolves.toMatchObject({ ok: false, error: 'ACCOUNT_PROFILE_CONFLICT' });
  const listed = await request({ command: 'accounts', action: 'listAccounts' }, globalScope) as {
    ok: true;
    result: { accounts: { id: string }[] };
  };
  expect(listed.result.accounts.some(a => a.id === 'caseclash')).toBe(false);

  // Existing startup collision leaves account UNAVAILABLE without aborting AccountController.initialize().
  const startupRoot = join(f.root, 'startup-check');
  await mkdir(join(startupRoot, 'profiles', 'StartupClash'), { recursive: true });
  const dbPath = join(startupRoot, 'main.sqlite');
  const store = new EventStore(dbPath, true);
  cleanups.push(async () => { store.close(); });
  await migrateClient(store, join(startupRoot, 'schema3.sqlite'));
  await migrateToSchema4(store, join(startupRoot, 'schema4.sqlite'));
  const nowIso = new Date().toISOString();
  store.db.prepare('INSERT INTO accounts VALUES (?,?,?,?,?,?,?,?,?)')
    .run('startupclash', 'self-sc', XIAOHONGSHU_PLATFORM_ID, XIAOHONGSHU_PLATFORM_ID, 'SC', 'ACTIVE', '', nowIso, nowIso);
  store.db.prepare('INSERT INTO accounts VALUES (?,?,?,?,?,?,?,?,?)')
    .run('desk', 'self-sd1', XIAOHONGSHU_PLATFORM_ID, XIAOHONGSHU_PLATFORM_ID, 'D1', 'ACTIVE', 'desk', nowIso, nowIso);
  store.db.prepare('INSERT INTO accounts VALUES (?,?,?,?,?,?,?,?,?)')
    .run('desk_dup', 'self-sd2', BILIBILI_PLATFORM_ID, BILIBILI_PLATFORM_ID, 'D2', 'ACTIVE', 'profiles/desk', nowIso, nowIso);
  const primary = new MockPlatformConnector({ accountId: store.accountId, ownId: 'own-primary' });
  const controller = new AccountController(store, primary, Date.now, f.service.authority, () => ({
    models: null,
    provider: f.service['provider'],
    knowledge: f.service['knowledge'].data,
    state: f.service['suggestionState'](),
    signal: new AbortController().signal,
  }));
  cleanups.push(() => controller.close());
  controller.configureWebOptions({ workerMode: 'synthetic' });
  expect(() => controller.initialize()).not.toThrow();
  await expect(controller.dispatch({ command: 'accounts', action: 'getAccountStatus', accountRef: 'startupclash' }))
    .resolves.toMatchObject({ connectorState: 'UNAVAILABLE', connected: false });
  await expect(controller.dispatch({ command: 'accounts', action: 'getAccountStatus', accountRef: 'desk_dup' }))
    .resolves.toMatchObject({ connectorState: 'UNAVAILABLE', connected: false });
  expect(new AccountStore(store.db, Date.now, startupRoot).getAccount('startupclash')?.status).toBe('ACTIVE');
  expect(win32.normalize(resolveWebProfileDir(startupRoot, 'x', 'profiles/a/../b'))).toContain('\\profiles\\b');
});

test('failed worker shutdown keeps CLOSING state, blocks reactivation, and succeeds on retry; secondary resume defers abort reset until hold recovery passes', async () => {
  const f = await modelFixture();
  cleanups.push(() => f.close());
  f.service.accounts.configureWebOptions({ workerMode: 'synthetic' });
  const { request } = harness(f.service, f.token);

  const accountId = 'acc_resilient';
  const scope: ProtocolScope = { kind: 'ACCOUNT', accountRef: accountId };
  expect(await request({
    command: 'accounts',
    action: 'registerAccount',
    commandId: randomUUID(),
    platform: XIAOHONGSHU_PLATFORM_ID,
    connector: XIAOHONGSHU_PLATFORM_ID,
    accountId,
    ownId: 'self-resilient',
  }, globalScope)).toMatchObject({ ok: true });
  expect(await request({ command: 'browser', open: true, mode: 'headless' }, scope, randomUUID()))
    .toMatchObject({ ok: true });

  // Secondary global resume must keep abort state if secondary hold recovery fails after primary recovery passes.
  expect(await request({ command: 'emergencyStop' }, globalScope)).toMatchObject({ ok: true });
  const secStore = new EventStore(f.dbPath, false, undefined, accountId);
  cleanups.push(async () => { secStore.close(); });
  const hold = holdSecurityChannel(secStore, 'DIRECT_MESSAGE', {
    incidentId: randomUUID(),
    reason: 'OBSERVATION_SECURITY_SUSPECT',
    mode: 'headless',
  });
  const primarySpy = vi.spyOn(BrowserService.prototype, 'verifyEmergencyRecovery')
    .mockImplementation(async (_ownId, _sig, _check, complete) => { complete?.(); });
  const holdSpy = vi.spyOn(WebPlatformWorkerConnector.prototype, 'recoverSecurityHolds')
    .mockRejectedValueOnce(new Blocked('OBSERVATION_SECURITY_SUSPECT'));
  try {
    // Revoking the live desktop parent session mid-flight must be rejected by live parent CONTROL recheck before clearing holds or resetting aborts.
    const midRevokedToken = f.service.authority.issueSession();
    primarySpy.mockImplementationOnce(async (_ownId, _sig, _check, complete) => {
      complete?.();
      f.service.authority.revoke(midRevokedToken);
    });
    await expect(harness(f.service, midRevokedToken).request({ command: 'resume', eventId: null }, scope, randomUUID()))
      .resolves.toMatchObject({ ok: false, error: 'OPERATOR_EXPIRED' });
    expect(f.service.accounts.getWebRuntime(accountId)!['stopAbort'].signal.aborted).toBe(true);

    // Re-arm emergency stop so the next secondary resume exercises holdSpy rejection cleanly.
    expect(await request({ command: 'emergencyStop' }, globalScope)).toMatchObject({ ok: true });
    await expect(request({ command: 'resume', eventId: null }, scope, randomUUID()))
      .resolves.toMatchObject({ ok: false, error: 'OBSERVATION_SECURITY_SUSPECT' });
    // Secondary stopAbort remains aborted until its own hold recovery passes.
    expect(f.service.accounts.getWebRuntime(accountId)!['stopAbort'].signal.aborted).toBe(true);
    resolveSecurityHold(secStore, 'DIRECT_MESSAGE', securityRevision(secStore, 'DIRECT_MESSAGE'));
    expect(hold.channel).toBe('DIRECT_MESSAGE');
    await expect(request({ command: 'resume', eventId: null }, scope, randomUUID()))
      .resolves.toMatchObject({ ok: true, result: { paused: false } });
    expect(f.service.accounts.getWebRuntime(accountId)!['stopAbort'].signal.aborted).toBe(false);
  } finally {
    primarySpy.mockRestore();
    holdSpy.mockRestore();
  }

  // Failed worker shutdown reports CLOSING, blocks reactivation, and lets retry finish cleanly.
  const closeSpy = vi.spyOn(WebPlatformWorkerConnector.prototype, 'close')
    .mockRejectedValueOnce(new Blocked('WORKER_CLOSE_FAILED'));
  const disconnectId = randomUUID();
  await expect(request({
    command: 'accounts',
    action: 'disconnectAccount',
    commandId: disconnectId,
    accountRef: accountId,
    confirmed: true,
  }, scope)).resolves.toMatchObject({ ok: false, error: 'WORKER_CLOSE_FAILED' });
  closeSpy.mockRestore();

  await expect(request({
    command: 'accounts',
    action: 'getAccountStatus',
    accountRef: accountId,
  }, scope)).resolves.toMatchObject({ ok: true, result: { connectorState: 'CLOSING', connected: false } });

  await expect(request({
    command: 'accounts',
    action: 'reactivateAccount',
    commandId: randomUUID(),
    accountRef: accountId,
    confirmed: true,
  }, scope)).resolves.toMatchObject({ ok: false, error: 'ACCOUNT_OPERATION_IN_PROGRESS' });

  await expect(request({
    command: 'accounts',
    action: 'disconnectAccount',
    commandId: disconnectId,
    accountRef: accountId,
    confirmed: true,
  }, scope)).resolves.toMatchObject({ ok: true, result: { status: 'DISCONNECTED' } });

  await expect(request({
    command: 'accounts',
    action: 'getAccountStatus',
    accountRef: accountId,
  }, scope)).resolves.toMatchObject({ ok: true, result: { connectorState: 'DISCONNECTED', connected: false } });

  await expect(request({
    command: 'accounts',
    action: 'reactivateAccount',
    commandId: randomUUID(),
    accountRef: accountId,
    confirmed: true,
  }, scope)).resolves.toMatchObject({ ok: true, result: { status: 'ACTIVE' } });
});

test('enforces Douyin vs web 50ms boundary gating and non-revoking pre-click permit denial', async () => {
  const root = join(process.cwd(), '.local', 'tests', `worker-boundary-${randomUUID().slice(0, 8)}`);
  await mkdir(join(root, 'douyin'), { recursive: true });
  await mkdir(join(root, 'xhs'), { recursive: true });
  cleanups.push(() => rm(root, { recursive: true, force: true }));

  const douyinHost = new BrowserWorkerHost({
    profileDir: join(root, 'douyin'),
    platformId: 'douyin',
    mode: 'synthetic',
  });
  cleanups.push(() => douyinHost.close());
  await douyinHost.start();
  await douyinHost.open();
  const dTarget = { handleId: randomUUID(), ownId: 'own-d', event: candidate({ accountId: 'account_001' }) };
  const dDigest = digest(await douyinHost.inspectTarget(dTarget));
  await douyinHost.prepareSend(dDigest, dTarget, 'hi');
  await expect(douyinHost.executeSend({
    intentId: randomUUID(),
    notBefore: new Date(Date.now() + 35).toISOString(),
    text: 'hi',
    targetDigest: dDigest,
  })).rejects.toMatchObject({ code: 'WORKER_SEND_BOUNDARY_INVALID' });

  const xhsHost = new BrowserWorkerHost({
    profileDir: join(root, 'xhs'),
    platformId: XIAOHONGSHU_PLATFORM_ID,
    mode: 'synthetic',
  });
  cleanups.push(() => xhsHost.close());
  await xhsHost.start();
  await xhsHost.open();
  const xTarget = { handleId: randomUUID(), ownId: 'own-x', event: candidate({ accountId: 'acc_x' }) };
  const xDigest = digest(await xhsHost.inspectTarget(xTarget));
  await xhsHost.prepareSend(xDigest, xTarget, 'hi');
  await expect(xhsHost.executeSend({
    intentId: randomUUID(),
    notBefore: new Date(Date.now() + 35).toISOString(),
    text: 'hi',
    targetDigest: xDigest,
  })).resolves.toMatchObject({ intentId: expect.any(String) });
  await xhsHost.prepareSend(xDigest, xTarget, 'hi-2');
  await expect(xhsHost.executeSend({
    intentId: randomUUID(),
    notBefore: new Date(Date.now() + 500).toISOString(),
    text: 'hi-2',
    targetDigest: xDigest,
  })).rejects.toMatchObject({ code: 'WORKER_SEND_BOUNDARY_INVALID' });
});

test('strictly binds DM active pane ID across delayed switch, guards human drafts, retains clickOnce cleanup token, verifies 500ms DM reconciliation, and keeps reply page usable after pre-click permit denial', async () => {
  let posts = 0;
  let dmReplySentAt = '';
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/api/send') {
      posts++;
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}') as { text?: string };
        dmReplySentAt = new Date(Date.now() + 500).toISOString();
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: `out-${posts}`, text: parsed.text ?? '', sentAt: dmReplySentAt }));
      });
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><body>
      <div id="self-id" data-uid="self-dm">self-dm</div>
      <div id="outside-decoy" class="active-conv" data-conversation-id="conv-target">conv-target</div>
      <div id="blocker" class="red-captcha" style="display:none">验证</div>
      <div id="dm-list">
        <div class="conv" data-conversation-id="conv-old" data-peer-id="peer-old"><button class="open" type="button">旧</button></div>
        <div class="conv" data-conversation-id="conv-target" data-peer-id="peer-target"><button class="open" type="button">目标</button></div>
      </div>
      <div id="dm-pane">
        <div class="active-conv" data-conversation-id="conv-old">conv-old</div>
        <div id="msgs"><div class="dm-msg" data-message-id="m-old" data-sender-id="peer-old"><span class="dm-text">旧消息</span><span class="dm-time" data-occurred-at="2026-11-27T01:00:00.000Z">2026-11-27T01:00:00.000Z</span></div></div>
        <div id="outs"></div>
        <textarea id="dm-composer"></textarea>
        <button id="dm-send" type="button">发送</button>
      </div>
      <script>
        const paneHeader = document.querySelector('#dm-pane .active-conv');
        const msgs = document.getElementById('msgs');
        const outs = document.getElementById('outs');
        let current = 'conv-old';
        document.querySelector('.conv[data-conversation-id="conv-target"] .open').addEventListener('click', () => {
          setTimeout(() => {
            current = 'conv-target';
            paneHeader.setAttribute('data-conversation-id', 'conv-target');
            paneHeader.textContent = 'conv-target';
            msgs.innerHTML = '<div class="dm-msg" data-message-id="m-target" data-sender-id="peer-target"><span class="dm-text">发货吗</span><span class="dm-time" data-occurred-at="2026-11-27T01:05:00.000Z">2026-11-27T01:05:00.000Z</span></div>';
            outs.innerHTML = ${JSON.stringify(dmReplySentAt ? '1' : '')} ? outs.innerHTML : '';
          }, 120);
        });
        document.getElementById('dm-send').addEventListener('click', async () => {
          const text = document.getElementById('dm-composer').value;
          const res = await fetch('/api/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
          const d = await res.json();
          document.getElementById('dm-composer').value = '';
          const row = document.createElement('div');
          row.className = 'dm-msg from-me';
          row.setAttribute('data-message-id', d.id);
          row.setAttribute('data-sender-id', 'self-dm');
          row.setAttribute('data-delivery-status', 'confirmed');
          row.innerHTML = '<span class="reply-text"></span><span class="reply-time" data-occurred-at="' + d.sentAt + '">' + d.sentAt + '</span>';
          row.querySelector('.reply-text').textContent = d.text;
          outs.appendChild(row);
        });
      </script>
    </body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Missing addr');
  const origin = `http://127.0.0.1:${addr.port}`;
  cleanups.push(async () => {
    await new Promise<void>(r => server.close(() => r()));
    server.closeAllConnections();
  });

  const mapping = {
    version: 1 as const,
    platform: 'xiaohongshu' as const,
    environment: 'fixture' as const,
    origin,
    entryUrl: `${origin}/`,
    selfId: 'self-dm',
    selectors: {
      selfId: '#self-id',
      selfIdAttribute: 'data-uid',
      securityBlockers: '.red-captcha',
      dm: {
        list: '#dm-list',
        conversationRows: '.conv',
        conversationIdAttribute: 'data-conversation-id',
        peerIdAttribute: 'data-peer-id',
        selectAction: '.open',
        pane: '#dm-pane',
        activeConversationId: '.active-conv',
        activeConversationIdAttribute: 'data-conversation-id',
        messages: '.dm-msg',
        messageIdAttribute: 'data-message-id',
        senderIdAttribute: 'data-sender-id',
        messageText: '.dm-text',
        messageTime: '.dm-time',
        messageTimeAttribute: 'data-occurred-at',
        fromMeClass: 'from-me',
        composer: '#dm-composer',
        send: '#dm-send',
        outgoingRows: '#outs .dm-msg.from-me',
        proofText: '.reply-text',
        proofTime: '.reply-time',
        proofTimeAttribute: 'data-occurred-at',
      },
    },
  };

  const event: InboundEvent = {
    accountId: 'acc_dm_test',
    channel: 'DIRECT_MESSAGE',
    platformEventId: 'm-target',
    actorId: 'peer-target',
    actorName: null,
    text: '发货吗',
    occurredAt: '2026-11-27T01:05:00.000Z',
    videoId: null,
    commentId: null,
    conversationId: 'conv-target',
    direction: 'INCOMING',
    kind: 'DM',
    evidenceId: 'ev-1',
  };

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  cleanups.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(origin, { waitUntil: 'domcontentloaded' });

  // Outside decoy must NOT fool DM reader, and reader waits for delayed pane switch when observing index 1.
  const reader = new WebPlatformReader(page, mapping, 'acc_dm_test');
  const observedOld = await reader.observe('dm', 0);
  expect(observedOld?.scope).toBe('conv-old');
  const observedTarget = await reader.observe('dm', 1);
  expect(observedTarget?.scope).toBe('conv-target');
  expect(observedTarget?.events).toHaveLength(1);

  // Unsaved human text on reply page blocks conversation switch.
  await page.locator('#dm-composer').fill('人工草稿未保存');
  const adapter = new WebPlatformReplyAdapter(page, mapping, 'acc_dm_test');
  await expect(adapter.inspect(event)).rejects.toMatchObject({ code: 'NATIVE_REPLY_EXISTING_DRAFT' });

  // Dedicated verify page checks receipt without disturbing reply page draft!
  const verifyPage = await browser.newPage();
  await verifyPage.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.locator('#dm-composer').fill('');

  // Delayed pane switch succeeds and clickOnce guard failure keeps token so cancelPreparation cleans untouched text.
  await adapter.inspect(event);
  await adapter.prepare(event, '自动回复内容');
  await page.evaluate(() => {
    (document.getElementById('blocker') as HTMLElement).style.display = 'block';
  });
  await expect(adapter.clickOnce(new Date().toISOString(), () => {}, Date.now() + 5_000))
    .rejects.toMatchObject({ code: 'OBSERVATION_SECURITY_SUSPECT' });
  await adapter.cancelPreparation(event, '自动回复内容');
  expect(await page.locator('#dm-composer').inputValue()).toBe('');

  await page.evaluate(() => {
    (document.getElementById('blocker') as HTMLElement).style.display = 'none';
  });
  const intentTime = new Date().toISOString();
  await adapter.inspect(event);
  await adapter.prepare(event, '确认今日发货');
  const baseline = await adapter.baseline(event);
  await adapter.clickOnce(intentTime, () => {}, Date.now() + 5_000);
  const proof = await adapter.readback(event, '确认今日发货', baseline, intentTime);
  expect(proof).toMatchObject({ text: '确认今日发货', ownId: 'self-dm' });
  expect(posts).toBe(1);

  // DM reconciliation verifies positive reply timestamped 500ms after intent.
  const reconciled = await adapter.verifyExisting(event, '确认今日发货', intentTime);
  expect(reconciled).toMatchObject({ text: '确认今日发货', ownId: 'self-dm' });
  // Ensure verifyPage also exists and reply page draft would stay untouched if verifyPage is used.
  await verifyPage.close();
}, 45_000);

test('pre-click permit denial and DOM guard failure keep cleanup ownership and reply page usable; verifyExisting reloads on same URL', async () => {
  let posts = 0;
  let blockOnInput = false;
  let sentReply: { id: string; text: string; sentAt: string } | null = null;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/guard-flag') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ block: blockOnInput }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/send') {
      posts++;
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}') as { text?: string };
        sentReply = { id: `out-${posts}`, text: parsed.text ?? '', sentAt: new Date(Date.now() + 50).toISOString() };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(sentReply));
      });
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><body>
      <div id="self-id" data-uid="self-w">self-w</div>
      <div id="worker-blocker" class="red-captcha" style="display:none">安全验证</div>
      <div id="dm-pane" data-conversation-id="conv-w">
        <div class="dm-msg" data-message-id="m-w" data-sender-id="peer-w"><span class="dm-text">在吗</span><span class="dm-time" data-occurred-at="2026-11-27T01:00:00.000Z">2026-11-27T01:00:00.000Z</span></div>
        <div id="outs"></div>
        <textarea id="dm-composer"></textarea>
        <button id="dm-send" type="button">发送</button>
      </div>
      <script>
        const outs = document.getElementById('outs');
        function appendOut(d) {
          const row = document.createElement('div');
          row.className = 'dm-msg from-me';
          row.setAttribute('data-message-id', d.id);
          row.setAttribute('data-sender-id', 'self-w');
          row.setAttribute('data-delivery-status', 'confirmed');
          row.innerHTML = '<span class="reply-text"></span><span class="reply-time" data-occurred-at="' + d.sentAt + '">' + d.sentAt + '</span>';
          row.querySelector('.reply-text').textContent = d.text;
          outs.appendChild(row);
        }
        const initialReply = ${JSON.stringify(sentReply)};
        if (initialReply) appendOut(initialReply);
        document.getElementById('dm-composer').addEventListener('input', (e) => {
          if (!e.target.value) {
            document.getElementById('worker-blocker').style.display = 'none';
            return;
          }
          void fetch('/guard-flag').then(r => r.json()).then(d => {
            document.getElementById('worker-blocker').style.display = d.block ? 'block' : 'none';
          }).catch(() => {});
        });
        document.getElementById('dm-send').addEventListener('click', async () => {
          const text = document.getElementById('dm-composer').value;
          const res = await fetch('/api/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
          const d = await res.json();
          document.getElementById('dm-composer').value = '';
          appendOut(d);
        });
      </script>
    </body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Missing addr');
  const origin = `http://127.0.0.1:${addr.port}`;
  cleanups.push(async () => {
    await new Promise<void>(r => server.close(() => r()));
    server.closeAllConnections();
  });

  const root = join(process.cwd(), '.local', 'tests', `worker-permit-${randomUUID().slice(0, 8)}`);
  await mkdir(join(root, 'acc', 'mappings'), { recursive: true });
  await mkdir(join(root, 'profile'), { recursive: true });
  cleanups.push(() => rm(root, { recursive: true, force: true }));

  const replyMapping = {
    version: 1,
    platform: XIAOHONGSHU_PLATFORM_ID,
    environment: 'fixture',
    origin,
    entryUrl: `${origin}/`,
    selfId: 'self-w',
    selectors: {
      selfId: '#self-id',
      selfIdAttribute: 'data-uid',
      dm: {
        pane: '#dm-pane',
        activeConversationIdAttribute: 'data-conversation-id',
        messages: '.dm-msg',
        messageIdAttribute: 'data-message-id',
        senderIdAttribute: 'data-sender-id',
        messageText: '.dm-text',
        messageTime: '.dm-time',
        messageTimeAttribute: 'data-occurred-at',
        fromMeClass: 'from-me',
        composer: '#dm-composer',
        send: '#dm-send',
        outgoingRows: '#outs .dm-msg.from-me',
        proofText: '.reply-text',
        proofTime: '.reply-time',
        proofTimeAttribute: 'data-occurred-at',
      },
    },
  };
  await writeFile(join(root, 'acc', 'mappings', 'xiaohongshu.reply.json'), JSON.stringify(replyMapping));

  let allowPermit = false;
  const host = new BrowserWorkerHost({
    profileDir: join(root, 'profile'),
    accountRoot: join(root, 'acc'),
    platformId: XIAOHONGSHU_PLATFORM_ID,
    mode: 'browser',
    allowFixture: true,
    onPermitCheck: () => allowPermit,
  });
  cleanups.push(() => host.close());
  await host.start();
  await host.open();

  const target = {
    handleId: randomUUID(),
    ownId: 'self-w',
    event: candidate({
      accountId: 'acc_w',
      platformEventId: 'm-w',
      conversationId: 'conv-w',
      actorId: 'peer-w',
      text: '在吗',
      occurredAt: '2026-11-27T01:00:00.000Z',
    }),
  };
  const snap = await host.inspectTarget(target);
  const targetDigest = digest(snap);
  await host.prepareSend(targetDigest, target, '您好，在的');
  await expect(host.executeSend({
    intentId: randomUUID(),
    notBefore: new Date().toISOString(),
    text: '您好，在的',
    targetDigest,
    permitExpiresAt: Date.now() + 5_000,
  })).rejects.toMatchObject({ code: 'EMERGENCY_STOPPED' });
  expect(posts).toBe(0);
  await host.cancelPreparation(target.handleId);

  // Swapping the mapping AFTER prepareSend must reject at executeSend with zero outbound posts.
  allowPermit = true;
  await host.prepareSend(targetDigest, target, '您好，在的');
  const swapped = { ...replyMapping, selectors: { ...replyMapping.selectors, selfIdAttribute: 'data-swapped' } };
  await writeFile(join(root, 'acc', 'mappings', 'xiaohongshu.reply.json'), JSON.stringify(swapped));
  await expect(host.executeSend({
    intentId: randomUUID(),
    notBefore: new Date().toISOString(),
    text: '您好，在的',
    targetDigest,
    permitExpiresAt: Date.now() + 5_000,
  })).rejects.toMatchObject({ code: 'TARGET_CHANGED_REAPPROVE' });
  expect(posts).toBe(0);
  await writeFile(join(root, 'acc', 'mappings', 'xiaohongshu.reply.json'), JSON.stringify(replyMapping));
  await host.cancelPreparation(target.handleId);

  // Page was NOT revoked by pre-click denial or rejected execute; verify worker-path DOM guard failure keeps cleanup ownership & page usability.
  blockOnInput = true;
  await host.prepareSend(targetDigest, target, '您好，在的');
  await new Promise(resolve => setTimeout(resolve, 40));
  await expect(host.executeSend({
    intentId: randomUUID(),
    notBefore: new Date().toISOString(),
    text: '您好，在的',
    targetDigest,
    permitExpiresAt: Date.now() + 5_000,
  })).rejects.toMatchObject({ code: 'OBSERVATION_SECURITY_SUSPECT' });
  expect(posts).toBe(0);
  blockOnInput = false;
  await host.cancelPreparation(target.handleId);
  await new Promise(resolve => setTimeout(resolve, 50));

  // Miss on verifyExisting at entryUrl before sending, then recheck same URL after sending (dedicated page reloads!).
  const sendTime = new Date().toISOString();
  await expect(host.verifyExisting({ target, text: '您好，在的', notBefore: sendTime })).resolves.toMatchObject({
    verified: false,
    proof: null,
  });

  // Clearing blocker + cancelPreparation cleaned the editor, so prepareSend + executeSend succeed on the same reply page!
  await host.prepareSend(targetDigest, target, '您好，在的');
  await host.executeSend({
    intentId: randomUUID(),
    notBefore: sendTime,
    text: '您好，在的',
    targetDigest,
    permitExpiresAt: Date.now() + 5_000,
  });
  await expect.poll(() => posts).toBe(1);
  await expect.poll(() => sentReply).not.toBeNull();
  await expect(host.verifyExisting({ target, text: '您好，在的', notBefore: sendTime })).resolves.toMatchObject({
    verified: true,
    proof: { text: '您好，在的', ownId: 'self-w' },
  });
}, 45_000);
