import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { expect, test, vi } from 'vitest';
import {
  channelCredentialDirName, ChannelCredentialStore, type ChannelCredentialProtector,
} from '../../src/app/channel-credentials.js';
import { dpapiWithEntropy } from '../../src/app/credentials.js';
import {
  dispatchTrustedServiceCommand, parseSidecarFrame, routeSidecarEnvelope, type SidecarCommand,
} from '../../src/app/protocol-v2-router.js';
import type { ClientService } from '../../src/app/service.js';
import {
  WECHAT_KF_PLATFORM_ID, WECOM_AIBOT_PLATFORM_ID, type ConfigureOfficialChannelCommand,
} from '../../src/contracts/account.js';
import type { ProtocolScope } from '../../src/contracts/protocol-v2.js';
import { WeChatKfPlatformConnector, wechatKfCapabilities } from '../../src/platform/wechat-kf/connector.js';
import { WecomAibotPlatformConnector, wecomAibotCapabilities } from '../../src/platform/wecom-aibot/connector.js';
import type { WecomWebSocketEvent, WecomWebSocketLike, WecomWebSocketListener } from '../../src/platform/wecom-aibot/types.js';
import { privateTemp } from '../helpers.js';
import { modelFixture } from '../model-provider-helpers.js';

const pipeSecret = 'cd'.repeat(32);
const globalScope: ProtocolScope = { kind: 'GLOBAL' };

function createMemoryProtector(failNextProtect = { fail: false }): ChannelCredentialProtector {
  const prefix = Buffer.from('TESTDPAPI:');
  return {
    async protect(input) {
      if (failNextProtect.fail) {
        failNextProtect.fail = false;
        throw new Error('simulated dpapi failure');
      }
      const masked = Buffer.from(input);
      for (let i = 0; i < masked.length; i++) masked[i] = masked[i]! ^ 0x5a;
      return Buffer.concat([prefix, masked]);
    },
    async unprotect(input) {
      if (!input.subarray(0, prefix.length).equals(prefix)) throw new Error('corrupt');
      const body = Buffer.from(input.subarray(prefix.length));
      for (let i = 0; i < body.length; i++) body[i] = body[i]! ^ 0x5a;
      return body;
    },
  };
}

class FakeWecomSocket implements WecomWebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<WecomWebSocketListener>>();
  private closed = false;

  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: WecomWebSocketListener): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: 'open' | 'message' | 'error' | 'close', listener: WecomWebSocketListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: 'open' | 'message' | 'error' | 'close', event: WecomWebSocketEvent = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  openNow(): void {
    if (this.closed) return;
    this.readyState = 1;
    this.emit('open');
  }

  send(data: string): void {
    this.sent.push(data);
    const frame = JSON.parse(data) as { cmd?: string; headers?: { req_id?: string } };
    const reqId = frame.headers?.req_id ?? 'req-missing';
    if (frame.cmd === 'aibot_subscribe' || frame.cmd === 'aibot_respond_msg') {
      queueMicrotask(() => {
        if (!this.closed) this.emit('message', { data: JSON.stringify({ headers: { req_id: reqId }, errcode: 0, errmsg: 'ok' }) });
      });
    }
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit('close', { code, reason });
  }
}

function harness(f: { service: ClientService; token: string }) {
  const context = {
    accounts: f.service.accounts,
    lifecycleCommandIds: new Map<string, string>(),
    dispatch: (body: SidecarCommand, scope?: ProtocolScope) => {
      if (body.command === 'connect' || body.command === 'disconnect') throw new Error('Unexpected lifecycle');
      return dispatchTrustedServiceCommand(f.service, f.token, body, scope);
    },
  };
  const request = (body: unknown, scope: ProtocolScope, commandId?: string) => {
    const parsed = parseSidecarFrame(JSON.stringify({
      protocol: 2, requestId: randomUUID(), secret: pipeSecret, scope, commandId, body,
    }), pipeSecret);
    if (parsed.kind !== 'request') throw new Error('Expected request frame');
    return routeSidecarEnvelope(parsed.envelope, context);
  };
  const requestV1 = (body: unknown) => {
    const parsed = parseSidecarFrame(JSON.stringify({
      protocol: 1, requestId: randomUUID(), secret: pipeSecret, body,
    }), pipeSecret);
    if (parsed.kind !== 'request') throw new Error('Expected v1 request frame');
    return routeSidecarEnvelope(parsed.envelope, context);
  };
  return { request, requestV1 };
}

test('ChannelCredentialStore uses case-safe dirs, preserves old versioned DPAPI secret on failed rotation, and wipes on delete', async () => {
  const root = privateTemp('channel-creds-');
  const failFlag = { fail: false };
  const store = new ChannelCredentialStore(root, createMemoryProtector(failFlag));
  const accountId = 'account_CaseA';
  const accountLower = 'account_casea';
  expect(channelCredentialDirName(accountId)).not.toBe(channelCredentialDirName(accountLower));

  const rawSecret = 'super-secret-wecom-token-9988';
  const baseCmd: ConfigureOfficialChannelCommand = {
    command: 'accounts',
    action: 'configureOfficialChannel',
    commandId: randomUUID(),
    accountRef: accountId,
    platform: WECOM_AIBOT_PLATFORM_ID,
    botId: 'bot-100',
    wsUrl: 'wss://127.0.0.1/ws',
    credentialMode: 'SET',
    storage: 'DPAPI',
    secret: rawSecret,
  };
  await expect(store.saveConfig(accountId, baseCmd)).rejects.toMatchObject({ code: 'WECOM_WS_UNSAFE_ENDPOINT' });

  const saved = await store.saveConfig(accountId, { ...baseCmd, wsUrl: null });
  const dir = join(root, 'channel-credentials', channelCredentialDirName(accountId));
  const configText = readFileSync(join(dir, 'config.json'), 'utf8');
  expect(configText).not.toContain(rawSecret);
  expect(inspect(store)).not.toContain(rawSecret);
  expect(saved.publicConfig).toMatchObject({ credentialStorage: 'DPAPI', secretConfigured: true });

  // Failed rotation must keep the previous active secret working untouched
  failFlag.fail = true;
  await expect(store.saveConfig(accountId, {
    ...baseCmd, commandId: randomUUID(), wsUrl: null, secret: 'new-secret-that-fails',
  })).rejects.toMatchObject({ code: 'DPAPI_OPERATION_FAILED' });
  expect(await store.loadSecret(accountId, WECOM_AIBOT_PLATFORM_ID)).toEqual({
    platform: WECOM_AIBOT_PLATFORM_ID, secret: rawSecret,
  });

  // Successful rotation removes stale ciphertext file
  await store.saveConfig(accountId, { ...baseCmd, commandId: randomUUID(), wsUrl: null, secret: 'rotated-secret-2' });
  expect(readdirSync(dir).filter(name => name.endsWith('.dpapi'))).toHaveLength(1);
  expect(await store.loadSecret(accountId, WECOM_AIBOT_PLATFORM_ID)).toEqual({
    platform: WECOM_AIBOT_PLATFORM_ID, secret: 'rotated-secret-2',
  });

  // Migrate DPAPI -> MEMORY removes ciphertext
  const migrated = await store.saveConfig(accountId, {
    command: 'accounts',
    action: 'configureOfficialChannel',
    commandId: randomUUID(),
    accountRef: accountId,
    platform: WECOM_AIBOT_PLATFORM_ID,
    botId: 'bot-100',
    wsUrl: null,
    credentialMode: 'KEEP',
    storage: 'MEMORY',
  });
  expect(migrated.publicConfig.credentialStorage).toBe('MEMORY');
  expect(readdirSync(dir).filter(name => name.endsWith('.dpapi'))).toHaveLength(0);

  // Reject unpaired WeChat KF webhook token
  await expect(store.saveConfig('account_kf_pair', {
    command: 'accounts',
    action: 'configureOfficialChannel',
    commandId: randomUUID(),
    accountRef: 'account_kf_pair',
    platform: WECHAT_KF_PLATFORM_ID,
    corpId: 'ww-corp',
    openKfId: 'wk-1',
    credentialMode: 'SET',
    storage: 'DPAPI',
    appSecret: 'kf-secret-123',
    token: 'only-token',
  })).rejects.toMatchObject({ code: 'WECHAT_KF_WEBHOOK_PAIR_REQUIRED' });

  await store.deleteAccount(accountId);
  expect(existsSync(dir)).toBe(false);

  if (process.platform === 'win32') {
    const sample = Buffer.from('dpapi-channel-roundtrip-check', 'utf8');
    const protectedBuf = await dpapiWithEntropy(sample, 'Protect', 'inbora:channel-credential:v1:test');
    const unprotected = await dpapiWithEntropy(protectedBuf, 'Unprotect', 'inbora:channel-credential:v1:test');
    expect(unprotected.toString('utf8')).toBe('dpapi-channel-roundtrip-check');
  }
});

test('WeCom AI Bot enforces immutable identity, V2-only ledger without secret digest, desktop human reply flow, offline reads on stop, and reactivation', async () => {
  const f = await modelFixture();
  const sockets: FakeWecomSocket[] = [];
  const wecomId = 'account_wecom_live';
  const wecomScope: ProtocolScope = { kind: 'ACCOUNT', accountRef: wecomId };
  const secretValue = 'wecom-live-secret-xyz';
  f.service.accounts.configureOfficialOptions({
    protector: createMemoryProtector(),
    createWecomConnector: opts => new WecomAibotPlatformConnector({
      ...opts,
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
      webSocketFactory: () => {
        const socket = new FakeWecomSocket();
        sockets.push(socket);
        queueMicrotask(() => socket.openNow());
        return socket;
      },
    }),
  });
  try {
    const { request, requestV1 } = harness(f);
    const readToken = f.service.authority.issueSession(['READ']);

    expect(await request({
      command: 'accounts',
      action: 'registerAccount',
      commandId: randomUUID(),
      platform: WECOM_AIBOT_PLATFORM_ID,
      connector: WECOM_AIBOT_PLATFORM_ID,
      accountId: wecomId,
      ownId: 'bot-live-1',
      displayLabel: '企微测试机器人',
    }, globalScope)).toMatchObject({
      ok: true,
      result: { id: wecomId, capabilities: wecomAibotCapabilities, autoReplyEnabled: false },
    });

    // V1 must reject new official account mutating actions
    expect(await requestV1({
      command: 'accounts', action: 'connectOfficialChannel', commandId: randomUUID(), accountRef: wecomId,
    })).toMatchObject({ ok: false, error: 'PROTOCOL_V2_ACCOUNT_SCOPE_REQUIRED' });

    // Read-only token rejected on configure
    await expect(f.service.dispatch(readToken, {
      command: 'accounts', action: 'configureOfficialChannel', commandId: randomUUID(),
      accountRef: wecomId, platform: WECOM_AIBOT_PLATFORM_ID, botId: 'bot-live-1',
      credentialMode: 'SET', storage: 'DPAPI', secret: secretValue,
    })).rejects.toThrow('OPERATOR_PERMISSION_DENIED');

    // Changing bound BotID in-place must be rejected
    expect(await request({
      command: 'accounts', action: 'configureOfficialChannel', commandId: randomUUID(),
      accountRef: wecomId, platform: WECOM_AIBOT_PLATFORM_ID, botId: 'bot-different',
      credentialMode: 'SET', storage: 'DPAPI', secret: secretValue,
    }, wecomScope)).toMatchObject({ ok: false, error: 'ACCOUNT_IDENTITY_IMMUTABLE' });

    // Offline active official account serves local read-only inbox & status (schema 4), blocks observe
    expect(await request({ command: 'getInbox', channel: 'ALL', status: 'ALL', page: 0 }, wecomScope))
      .toMatchObject({ ok: true, result: { total: 0 } });
    expect(await request({ command: 'getStatus' }, wecomScope)).toMatchObject({ ok: true, result: { schema: 4 } });
    expect(await request({ command: 'observe', source: 'dm' }, wecomScope, randomUUID()))
      .toMatchObject({ ok: false, error: 'OFFICIAL_CHANNEL_NOT_CONNECTED' });

    const cfgId1 = randomUUID();
    expect(await request({
      command: 'accounts', action: 'configureOfficialChannel', commandId: cfgId1,
      accountRef: wecomId, platform: WECOM_AIBOT_PLATFORM_ID, botId: 'bot-live-1',
      allowGroupMessages: true, credentialMode: 'SET', storage: 'DPAPI', secret: secretValue,
    }, wecomScope)).toMatchObject({ ok: true, result: { botId: 'bot-live-1', secretConfigured: true } });

    // Verify protocol_v2_commands.request_digest did NOT hash the raw secret
    const cfgId2 = randomUUID();
    expect(await request({
      command: 'accounts', action: 'configureOfficialChannel', commandId: cfgId2,
      accountRef: wecomId, platform: WECOM_AIBOT_PLATFORM_ID, botId: 'bot-live-1',
      allowGroupMessages: true, credentialMode: 'SET', storage: 'DPAPI', secret: 'completely-different-secret',
    }, wecomScope)).toMatchObject({ ok: true });
    // Re-assert no secret leaked into audit/ledger
    expect(JSON.stringify(f.store.db.prepare('SELECT detail_redacted FROM audit_events').all())).not.toContain(secretValue);
    expect(JSON.stringify(f.store.db.prepare('SELECT result_json FROM protocol_v2_commands').all())).not.toContain(secretValue);

    expect(await request({
      command: 'accounts', action: 'connectOfficialChannel', commandId: randomUUID(), accountRef: wecomId,
    }, wecomScope)).toMatchObject({
      ok: true,
      result: { connected: true, transportStatus: { transport: 'official_api', state: 'CONNECTED', protocol: 'wecom_ws' } },
    });

    // Inject inbound WeCom message after account.createdAt
    const socket = sockets[0]!;
    const nowSec = Math.floor((Date.now() + 60_000) / 1000);
    socket.emit('message', {
      data: JSON.stringify({
        cmd: 'aibot_msg_callback',
        headers: { req_id: 'req-inbound-001' },
        body: {
          msgid: 'msg-wecom-001',
          aibotid: 'bot-live-1',
          chattype: 'single',
          from: { userid: 'user-zhang', name: '张先生' },
          create_time: nowSec,
          msgtype: 'text',
          text: { content: '你好，桌面工作台直接回复测试' },
        },
      }),
    });

    expect(await request({ command: 'observe', source: 'dm' }, wecomScope, randomUUID())).toMatchObject({ ok: true });
    const inboxRes = await request({ command: 'getInbox', channel: 'ALL', status: 'ALL', page: 0 }, wecomScope);
    const eventId = (inboxRes as { ok: true; result: { items: { id: string }[] } }).result.items[0]!.id;

    // Exercise desktop workbench flow: openHumanDialog -> sendHumanReply -> markInboxRead
    expect(await request({ command: 'setMode', mode: 'MANUAL' }, wecomScope, randomUUID())).toMatchObject({ ok: true });
    const selectionId = randomUUID();
    const opened = await request({ command: 'openHumanDialog', eventId, selectionId }, wecomScope, randomUUID());
    expect(opened).toMatchObject({ ok: true });
    const { ownership, contextVersion } = (opened as { ok: true; result: { ownership: { generation: number }; contextVersion: string } }).result;
    const sendCommandId = randomUUID();
    expect(await request({
      command: 'sendHumanReply',
      commandId: sendCommandId,
      input: {
        eventId, generation: ownership.generation, expectedVersion: 0,
        text: '来自桌面工作台的企微回复', contextVersion, selectionId, suggestionId: null,
      },
    }, wecomScope)).toMatchObject({ ok: true });
    await expect.poll(() => request({ command: 'getSendResult', commandId: sendCommandId }, wecomScope))
      .toMatchObject({ ok: true, result: { status: 'CONFIRMED' } });
    expect(socket.sent.filter(item => item.includes('"aibot_respond_msg"'))).toHaveLength(1);
    expect(await request({ command: 'markInboxRead' }, wecomScope, randomUUID())).toMatchObject({ ok: true });

    // Emergency stop disconnects active official transport, yet offline read-only inspection still works!
    expect(await request({ command: 'emergencyStop' }, globalScope)).toMatchObject({ ok: true });
    expect(await request({ command: 'getSendResult', commandId: sendCommandId }, wecomScope))
      .toMatchObject({ ok: true, result: { status: 'CONFIRMED' } });
    expect(await request({ command: 'getInbox', channel: 'ALL', status: 'ALL', page: 0 }, wecomScope))
      .toMatchObject({ ok: true, result: { total: 1 } });
    expect(await request({ command: 'accounts', action: 'connectOfficialChannel', commandId: randomUUID(), accountRef: wecomId }, wecomScope))
      .toMatchObject({ ok: false, error: 'EMERGENCY_STOPPED' });

    // Disconnect wipes credentials while preserving history, then reactivateAccount restores the same accountId cleanly
    expect(await request({
      command: 'accounts', action: 'disconnectAccount', commandId: randomUUID(), accountRef: wecomId, confirmed: true,
    }, wecomScope)).toMatchObject({ ok: true, result: { status: 'DISCONNECTED' } });
    expect(existsSync(join(f.root, 'channel-credentials', channelCredentialDirName(wecomId)))).toBe(false);
    expect(await request({
      command: 'accounts', action: 'reactivateAccount', commandId: randomUUID(), accountRef: wecomId, confirmed: true,
    }, wecomScope)).toMatchObject({ ok: true, result: { status: 'ACTIVE', id: wecomId } });
    expect(f.store.db.prepare('SELECT count(*) FROM inbound_events WHERE account_id=?').pluck().get(wecomId)).toBe(1);
  } finally {
    await f.close();
  }
});

test('WeChat KF validates credentials on connect, uses account creation boundary, persists cursor and sends once via SendCoordinator', async () => {
  const f = await modelFixture();
  const kfId = 'account_wechat_kf_live';
  const kfScope: ProtocolScope = { kind: 'ACCOUNT', accountRef: kfId };
  const observedCursors: Array<string | undefined> = [];
  const sendCalls: Array<Record<string, unknown>> = [];
  let tokenShouldFail = true;
  const nowSec = Math.floor((Date.now() + 60_000) / 1000);
  const oldHistoricalSec = Math.floor((Date.now() - 3_600_000) / 1000);

  const mockFetch = vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/gettoken')) {
      if (tokenShouldFail) {
        return new Response(JSON.stringify({ errcode: 40001, errmsg: 'invalid secret' }), { status: 200 });
      }
      return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok', access_token: 'kf-access-token-1', expires_in: 7200 }), { status: 200 });
    }
    if (url.includes('/kf/sync_msg')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { cursor?: string };
      observedCursors.push(body.cursor);
      const list = observedCursors.length === 1
        ? [
          {
            msgid: 'kf-msg-historical',
            open_kfid: 'wk-live-01',
            external_userid: 'wm-user-old',
            send_time: oldHistoricalSec,
            origin: 3,
            msgtype: 'text',
            text: { content: '接入前的历史消息' },
          },
          {
            msgid: 'kf-msg-001',
            open_kfid: 'wk-live-01',
            external_userid: 'wm-user-01',
            send_time: nowSec,
            origin: 3,
            msgtype: 'text',
            text: { content: '微信客服新来信' },
          },
        ]
        : [];
      return new Response(JSON.stringify({
        errcode: 0, errmsg: 'ok', next_cursor: 'cursor-page-2', has_more: 0, msg_list: list,
      }), { status: 200 });
    }
    if (url.includes('/kf/send_msg')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      sendCalls.push(body);
      return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok', msgid: body.msgid ?? 'kf-sent-1' }), { status: 200 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  f.service.accounts.configureOfficialOptions({
    protector: createMemoryProtector(),
    createWechatKfConnector: opts => new WeChatKfPlatformConnector({
      ...opts,
      fetchImpl: mockFetch,
      lookup: async () => [{ address: '93.184.216.35', family: 4 }],
    }),
  });

  try {
    const { request } = harness(f);
    expect(await request({
      command: 'accounts', action: 'registerAccount', commandId: randomUUID(),
      platform: WECHAT_KF_PLATFORM_ID, connector: WECHAT_KF_PLATFORM_ID,
      accountId: kfId, ownId: 'wk-live-01', displayLabel: '微信客服官方号',
    }, globalScope)).toMatchObject({ ok: true, result: { id: kfId, capabilities: wechatKfCapabilities } });

    expect(await request({
      command: 'accounts', action: 'configureOfficialChannel', commandId: randomUUID(),
      accountRef: kfId, platform: WECHAT_KF_PLATFORM_ID, corpId: 'ww-live-corp', openKfId: 'wk-live-01',
      credentialMode: 'SET', storage: 'DPAPI', appSecret: 'bad-secret',
    }, kfScope)).toMatchObject({ ok: true });

    // Connect must fail immediately if /gettoken rejects credentials (never falsely report connected)
    expect(await request({
      command: 'accounts', action: 'connectOfficialChannel', commandId: randomUUID(), accountRef: kfId,
    }, kfScope)).toMatchObject({ ok: false, error: 'WECHAT_KF_TOKEN_FETCH_FAILED' });

    tokenShouldFail = false;
    expect(await request({
      command: 'accounts', action: 'connectOfficialChannel', commandId: randomUUID(), accountRef: kfId,
    }, kfScope)).toMatchObject({ ok: true, result: { connected: true } });

    expect(await request({ command: 'observe', source: 'dm' }, kfScope, randomUUID())).toMatchObject({ ok: true });
    // Historical message before account.createdAt must NOT become AWAITING_DRAFT
    expect(f.store.db.prepare('SELECT status FROM inbound_events WHERE account_id=? AND source_key=?')
      .pluck().get(kfId, 'kf-msg-historical')).toBe('BASELINE');
    expect(f.store.db.prepare('SELECT status FROM inbound_events WHERE account_id=? AND source_key=?')
      .pluck().get(kfId, 'kf-msg-001')).toBe('AWAITING_DRAFT');
    expect(f.store.db.prepare(
      "SELECT cursor_data FROM account_cursors WHERE account_id=? AND channel='DIRECT_MESSAGE' AND scope='wechat-kf:wk-live-01'",
    ).pluck().get(kfId)).toBe('cursor-page-2');

    const newEventId = f.store.db.prepare('SELECT id FROM inbound_events WHERE account_id=? AND source_key=?')
      .pluck().get(kfId, 'kf-msg-001') as string;
    expect(await request({ command: 'setMode', mode: 'MANUAL' }, kfScope, randomUUID())).toMatchObject({ ok: true });
    const selectionId = randomUUID();
    const opened = await request({ command: 'openHumanDialog', eventId: newEventId, selectionId }, kfScope, randomUUID());
    const { ownership, contextVersion } = (opened as { ok: true; result: { ownership: { generation: number }; contextVersion: string } }).result;
    const sendCommandId = randomUUID();
    expect(await request({
      command: 'sendHumanReply',
      commandId: sendCommandId,
      input: {
        eventId: newEventId, generation: ownership.generation, expectedVersion: 0,
        text: '微信客服已收到您的咨询', contextVersion, selectionId, suggestionId: null,
      },
    }, kfScope)).toMatchObject({ ok: true });
    await expect.poll(() => request({ command: 'getSendResult', commandId: sendCommandId }, kfScope))
      .toMatchObject({ ok: true, result: { status: 'CONFIRMED' } });
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]).toMatchObject({ touser: 'wm-user-01', open_kfid: 'wk-live-01', msgtype: 'text' });

    // Disconnect transport & reconnect resumes persisted SQLite cursor
    expect(await request({
      command: 'accounts', action: 'disconnectOfficialChannel', commandId: randomUUID(), accountRef: kfId,
    }, kfScope)).toMatchObject({ ok: true, result: { connected: false, secretConfigured: true } });
    expect(await request({
      command: 'accounts', action: 'connectOfficialChannel', commandId: randomUUID(), accountRef: kfId,
    }, kfScope)).toMatchObject({ ok: true, result: { connected: true } });
    expect(await request({ command: 'observe', source: 'dm' }, kfScope, randomUUID())).toMatchObject({ ok: true });
    expect(observedCursors).toEqual([undefined, 'cursor-page-2']);
  } finally {
    await f.close();
  }
});
