import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { SendCoordinator } from '../../src/core/send-coordinator.js';
import {
  createOfficialApiTransportStatus,
  officialApiEndpointDigest,
} from '../../src/platform/official-api-base.js';
import {
  WECOM_AIBOT_DEFAULT_WS_URL,
  WECOM_AIBOT_PLATFORM_ID,
  WecomAibotPlatformConnector,
  WsCmd,
  type WecomWebSocketEvent,
  type WecomWebSocketLike,
  type WecomWebSocketListener,
  type WecomWsFrame,
} from '../../src/platform/wecom-aibot/index.js';
import { AccountStore } from '../../src/storage/account-store.js';
import { migrateAutomation } from '../../src/storage/automation-migration.js';
import { AutomationStore } from '../../src/storage/automation-store.js';
import { migrateClient } from '../../src/storage/client-migration.js';
import { migrateToSchema4 } from '../../src/storage/schema4-migration.js';
import { EventStore } from '../../src/storage/store.js';
import { privateTemp } from '../helpers.js';

type SocketEventType = 'open' | 'message' | 'error' | 'close';

class DeterministicWs implements WecomWebSocketLike {
  readyState = 0;
  readonly sentFrames: WecomWsFrame[] = [];
  private readonly listeners: Record<SocketEventType, Set<WecomWebSocketListener>> = {
    open: new Set(),
    message: new Set(),
    error: new Set(),
    close: new Set(),
  };

  constructor(readonly url: string) {}

  addEventListener(type: SocketEventType, listener: WecomWebSocketListener): void {
    this.listeners[type].add(listener);
  }

  removeEventListener(type: SocketEventType, listener: WecomWebSocketListener): void {
    this.listeners[type].delete(listener);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('closed');
    this.sentFrames.push(JSON.parse(data) as WecomWsFrame);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', { code, reason });
  }

  openAndAuth(): void {
    this.readyState = 1;
    this.emit('open', {});
    const sub = this.sentFrames.find(f => f.cmd === WsCmd.SUBSCRIBE);
    if (!sub) throw new Error('missing subscribe frame');
    this.emitFrame({ headers: { req_id: sub.headers.req_id }, errcode: 0, errmsg: 'ok' });
  }

  emitFrame(frame: WecomWsFrame): void {
    this.emit('message', { data: JSON.stringify(frame) });
  }

  drop(code = 1006): void {
    this.readyState = 3;
    this.emit('close', { code, reason: 'dropped' });
  }

  private emit(type: SocketEventType, event: WecomWebSocketEvent): void {
    for (const listener of [...this.listeners[type]]) listener(event);
  }
}

const tempDirs: string[] = [];
const openStores: EventStore[] = [];
const openConnectors: WecomAibotPlatformConnector[] = [];

function createTestStore(): { dir: string; file: string; store: EventStore } {
  const dir = privateTemp('wecom-aibot-');
  const file = join(dir, 'poc.sqlite');
  tempDirs.push(dir);
  const store = new EventStore(file, true);
  openStores.push(store);
  return { dir, file, store };
}

function createConnectedConnector(options: {
  accountId?: string;
  botId?: string;
  secret?: string;
  ackMode: 'auto_ok' | 'drop_on_send' | 'hang_open';
  firstRunAt?: number;
  reqIdTtlMs?: number;
  now?: () => number;
  onWsError?: (error: Error) => void;
}) {
  const sockets: DeterministicWs[] = [];
  const secret = options.secret ?? 'synthetic-wecom-bot-secret-xyz987654321';
  const botId = options.botId ?? 'aibot-corp-001';

  const connector = new WecomAibotPlatformConnector({
    accountId: options.accountId,
    botId,
    secret,
    autoPersistInbound: false,
    firstRunAt: options.firstRunAt,
    reqIdTtlMs: options.reqIdTtlMs,
    now: options.now,
    onWsError: options.onWsError,
    reconnectBaseDelayMs: 50,
    reconnectMaxDelayMs: 200,
    webSocketFactory: url => {
      const ws = new DeterministicWs(url);
      const originalSend = ws.send.bind(ws);
      ws.send = (data: string) => {
        originalSend(data);
        const frame = JSON.parse(data) as WecomWsFrame;
        if (frame.cmd === WsCmd.RESPONSE || frame.cmd === WsCmd.SEND_MSG) {
          queueMicrotask(() => {
            if (options.ackMode === 'auto_ok') {
              ws.emitFrame({ headers: { req_id: frame.headers.req_id }, errcode: 0, errmsg: 'ok' });
            } else if (options.ackMode === 'drop_on_send') {
              ws.drop(1006);
            }
          });
        }
      };
      sockets.push(ws);
      if (options.ackMode !== 'hang_open') {
        queueMicrotask(() => ws.openAndAuth());
      }
      return ws;
    },
  });
  openConnectors.push(connector);
  return { connector, sockets, secret, botId };
}

afterEach(async () => {
  while (openConnectors.length > 0) {
    await openConnectors.pop()!.close();
  }
  while (openStores.length > 0) {
    openStores.pop()!.close();
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('WecomAibotPlatformConnector integration with EventStore and SendCoordinator', () => {
  test('aligns transportStatus/capabilities, guards firstRunAt baseline, isolates malformed frames & missing aibotid, and confirms single-shot reply', async () => {
    const { store } = createTestStore();
    const startMs = Date.now() - 10_000;
    const wsErrors: string[] = [];
    const { connector, sockets, secret, botId } = createConnectedConnector({
      ackMode: 'auto_ok',
      firstRunAt: startMs,
      onWsError: err => wsErrors.push(err.message),
    });

    await connector.open();
    connector.bindStore(store);

    expect(connector.platformId).toBe(WECOM_AIBOT_PLATFORM_ID);
    expect(connector.capabilities).toEqual({
      channels: ['DIRECT_MESSAGE'],
      loginRecovery: false,
      manualSecurityRecovery: false,
      preview: false,
      readback: false,
      transport: 'official_api',
    });

    const ts = connector.transportStatus();
    expect(createOfficialApiTransportStatus(ts)).toEqual(ts);
    expect(ts.endpointDigest).toBe(
      officialApiEndpointDigest(WECOM_AIBOT_DEFAULT_WS_URL, { allowedProtocols: ['wss:'] }),
    );

    const ws = sockets[0]!;
    const afterStartSec = Math.floor((startMs + 3_000) / 1000);
    const beforeStartSec = Math.floor((startMs - 60_000) / 1000);

    // 0. Historical message before firstRunAt -> must become BASELINE, never AWAITING_DRAFT.
    ws.emitFrame({
      cmd: WsCmd.CALLBACK,
      headers: { req_id: 'inbound-req-old' },
      body: {
        msgid: 'msg-history-old',
        aibotid: botId,
        chattype: 'single',
        from: { userid: 'customer-hist' },
        create_time: beforeStartSec,
        msgtype: 'text',
        text: { content: '很久之前的历史消息' },
      },
    });
    // 1. Missing or blank aibotid -> must be rejected.
    ws.emitFrame({
      cmd: WsCmd.CALLBACK,
      headers: { req_id: 'inbound-req-no-aibotid' },
      body: {
        msgid: 'msg-no-aibotid',
        aibotid: '   ',
        chattype: 'single',
        from: { userid: 'customer-x' },
        create_time: afterStartSec,
        msgtype: 'text',
        text: { content: 'missing bot id' },
      },
    });
    // 2. Malformed mixed.msg_item (non-array / null elements) -> handled safely without crashing.
    ws.emitFrame({
      cmd: WsCmd.CALLBACK,
      headers: { req_id: 'inbound-req-malformed-mixed' },
      body: {
        msgid: 'msg-malformed-mixed',
        aibotid: botId,
        chattype: 'single',
        from: { userid: 'customer-mixed' },
        create_time: afterStartSec + 1,
        msgtype: 'mixed',
        mixed: { msg_item: 'not-an-array' as unknown as [] },
      },
    });
    // 3. Single chat text message after firstRunAt
    ws.emitFrame({
      cmd: WsCmd.CALLBACK,
      headers: { req_id: 'inbound-req-001' },
      body: {
        msgid: 'msg-single-1',
        aibotid: botId,
        chattype: 'single',
        from: { userid: 'customer-alice', name: 'Alice' },
        create_time: afterStartSec + 2,
        msgtype: 'text',
        text: { content: '请问发货时间是多久？' },
      },
    });
    // 4. Exact duplicate msgid -> ignored
    ws.emitFrame({
      cmd: WsCmd.CALLBACK,
      headers: { req_id: 'inbound-req-001-dup' },
      body: {
        msgid: 'msg-single-1',
        aibotid: botId,
        chattype: 'single',
        from: { userid: 'customer-alice', name: 'Alice' },
        create_time: afterStartSec + 2,
        msgtype: 'text',
        text: { content: '请问发货时间是多久？' },
      },
    });
    // 5. Self echo -> ignored
    ws.emitFrame({
      cmd: WsCmd.CALLBACK,
      headers: { req_id: 'inbound-req-self' },
      body: {
        msgid: 'msg-self-1',
        aibotid: botId,
        chattype: 'single',
        from: { userid: botId },
        create_time: afterStartSec + 3,
        msgtype: 'text',
        text: { content: 'self echo' },
      },
    });
    // 6. Image media message with sensitive aeskey that must NEVER leak
    const mediaAesKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    ws.emitFrame({
      cmd: WsCmd.CALLBACK,
      headers: { req_id: 'inbound-req-img-1' },
      body: {
        msgid: 'msg-image-1',
        aibotid: botId,
        chattype: 'single',
        from: { userid: 'customer-carol' },
        create_time: afterStartSec + 4,
        msgtype: 'image',
        image: { url: 'https://example.invalid/private-image?token=secret-img', aeskey: mediaAesKey },
      },
    });

    await new Promise(resolve => setTimeout(resolve, 10));
    const observed = await connector.observe(store, 'dm');
    expect(observed.newEventIds).toHaveLength(1);

    const events = store.events();
    expect(events.find(e => e.payload.platformEventId === 'msg-no-aibotid')).toBeUndefined();
    expect(events.find(e => e.payload.platformEventId === 'msg-history-old')?.status).toBe('BASELINE');
    expect(events.find(e => e.payload.platformEventId === 'msg-malformed-mixed')?.payload.text).toBe('[图文混合消息]');

    const singleEvent = events.find(e => e.payload.platformEventId === 'msg-single-1')!;
    expect(singleEvent.payload.conversationId).toBe('single:customer-alice');
    expect(singleEvent.status).toBe('AWAITING_DRAFT');

    const imageEvent = events.find(e => e.payload.platformEventId === 'msg-image-1')!;
    expect(imageEvent.payload.contentType).toBe('IMAGE');
    expect(imageEvent.payload.text).toBe('[图片消息]');
    expect(imageEvent.payload.text).not.toContain(mediaAesKey);
    expect(imageEvent.status).toBe('MANUAL_REVIEW');

    const draft = store.saveDraft(singleEvent.id, '工作日 24 小时内发出，请放心。', 'manual');
    const handle = await connector.adapter(singleEvent.payload, store);
    try {
      const snap = await handle.adapter.inspect(singleEvent.payload);
      store.approve(draft.id, snap, draft.version, draft.text);
      const outcome = await new SendCoordinator(store, connector.actor).send(draft.id, handle.adapter, true);
      expect(outcome).toBe('CONFIRMED');
    } finally {
      await handle.dispose();
    }

    const outboundReplies = ws.sentFrames.filter(f => f.cmd === WsCmd.RESPONSE);
    expect(outboundReplies).toHaveLength(1);
    expect(outboundReplies[0]!.headers.req_id).toBe('inbound-req-001');
    expect(await connector.verifyExisting(store, singleEvent.id)).toEqual({
      verified: false,
      evidenceId: 'wecom-ws-history-unavailable',
    });

    const serializedOutputs = JSON.stringify({
      root: connector.root,
      status: connector.status(),
      transportStatus: connector.transportStatus(),
      identity: connector.identity('DIRECT_MESSAGE'),
      audits: store.db.prepare('SELECT * FROM audit_events').all(),
      events: store.db.prepare('SELECT * FROM inbound_events').all(),
      receipts: store.db.prepare('SELECT * FROM delivery_receipts').all(),
      wsErrors,
    });
    expect(serializedOutputs).not.toContain(secret);
    expect(serializedOutputs).not.toContain(mediaAesKey);
  });

  test('disconnect during send yields UNCERTAIN with 0 retries, and close() interrupts hung open() without deadlocking', async () => {
    const { store } = createTestStore();
    const startMs = Date.now() - 10_000;
    const { connector, sockets, secret, botId } = createConnectedConnector({
      ackMode: 'drop_on_send',
      firstRunAt: startMs,
    });

    await connector.open();
    connector.bindStore(store);

    sockets[0]!.emitFrame({
      cmd: WsCmd.CALLBACK,
      headers: { req_id: 'inbound-req-drop-1' },
      body: {
        msgid: 'msg-drop-1',
        aibotid: botId,
        chattype: 'single',
        from: { userid: 'customer-dave' },
        create_time: Math.floor((startMs + 5_000) / 1000),
        msgtype: 'text',
        text: { content: '在吗？帮查下订单' },
      },
    });
    await new Promise(resolve => setTimeout(resolve, 10));

    const observed = await connector.observe(store, 'dm');
    const event = store.event(observed.newEventIds[0]!);
    const draft = store.saveDraft(event.id, '好的，请提供订单号。', 'manual');

    const handle = await connector.adapter(event.payload, store);
    const coordinator = new SendCoordinator(store, connector.actor);
    try {
      const snap = await handle.adapter.inspect(event.payload);
      store.approve(draft.id, snap, draft.version, draft.text);
      expect(await coordinator.send(draft.id, handle.adapter, true)).toBe('UNCERTAIN');
      await expect(coordinator.send(draft.id, handle.adapter, true)).rejects.toThrow();
    } finally {
      await handle.dispose();
    }

    await new Promise(resolve => setTimeout(resolve, 120));
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    const totalReplyFrames = sockets.reduce(
      (sum, ws) => sum + ws.sentFrames.filter(f => f.cmd === WsCmd.RESPONSE || f.cmd === WsCmd.SEND_MSG).length,
      0,
    );
    expect(totalReplyFrames).toBe(1);
    expect((store.receiptForEvent(event.id) as { proof_ref: string }).proof_ref).toBe('NO_UNIQUE_BOUND_PROOF');
    expect(JSON.stringify(store.db.prepare('SELECT * FROM audit_events').all())).not.toContain(secret);

    // close() must interrupt a hung open() handshake immediately without deadlocking AccountActor.
    const hung = createConnectedConnector({ ackMode: 'hang_open' });
    const hungOpen = hung.connector.open();
    await new Promise(resolve => setTimeout(resolve, 10));
    const closePromise = hung.connector.close();
    await expect(hungOpen).rejects.toThrow('WECOM_WS_CLOSED');
    await closePromise;
    expect(hung.connector.status().state).toBe('CLOSED');
  });

  test('propagates SOURCE_COLLISION for differing bindings, blocks expired group req_id without proactive fallback, and honors collect(startedAt) + schema4 platform isolation', async () => {
    const { dir, file, store } = createTestStore();
    await migrateClient(store, join(dir, 'bak-client.sqlite'));
    await migrateAutomation(store, join(dir, 'bak-auto.sqlite'));
    await migrateToSchema4(store, join(dir, 'bak-s4.sqlite'));

    const accounts = new AccountStore(store.db);
    // Register an unbound Douyin account and a bound-ready WeCom account on schema4.
    const douyinAcct = accounts.registerAccount({
      commandId: '11111111-1111-4111-8111-111111111111',
      platform: 'douyin',
      connector: 'douyin-web',
      accountId: 'acct_douyin_only',
    });
    const wecomAcct = accounts.registerAccount({
      commandId: '22222222-2222-4222-8222-222222222222',
      platform: WECOM_AIBOT_PLATFORM_ID,
      connector: 'wecom-aibot-ws',
      accountId: 'acct_wecom_01',
    });
    store.close();

    // 1. Cross-platform isolation: binding WeCom connector to Douyin schema4 account must throw ACCOUNT_PLATFORM_MISMATCH.
    const douyinStore = new EventStore(file, false, undefined, douyinAcct.id);
    openStores.push(douyinStore);
    const wrongPlatformConn = createConnectedConnector({
      accountId: douyinAcct.id,
      botId: 'aibot-cross-test',
      ackMode: 'auto_ok',
    });
    expect(() => wrongPlatformConn.connector.bindStore(douyinStore)).toThrow('ACCOUNT_PLATFORM_MISMATCH');
    expect(douyinStore.accountOwnId(douyinAcct.id)).toBe('');

    // 2. Proper WeCom schema4 account + collect(AutomationStore) startedAt boundary + SOURCE_COLLISION + group req_id TTL.
    const wecomStore = new EventStore(file, false, undefined, wecomAcct.id);
    openStores.push(wecomStore);
    let clockMs = Date.now();
    const autoStore = new AutomationStore(wecomStore, () => clockMs, wecomAcct.id);
    const startedAt = clockMs - 5_000;
    autoStore.initialize(startedAt);

    const { connector, sockets, botId } = createConnectedConnector({
      accountId: wecomAcct.id,
      botId: 'aibot-s4-01',
      ackMode: 'auto_ok',
      reqIdTtlMs: 1_000,
      now: () => clockMs,
    });
    await connector.open();

    const ws = sockets[0]!;
    // Message older than AutomationStore.startedAt -> BASELINE via collect()
    ws.emitFrame({
      cmd: WsCmd.CALLBACK,
      headers: { req_id: 'req-pre-auto' },
      body: {
        msgid: 'msg-pre-auto',
        aibotid: botId,
        chattype: 'single',
        from: { userid: 'u-old' },
        create_time: Math.floor((startedAt - 30_000) / 1000),
        msgtype: 'text',
        text: { content: '自动化开启前旧消息' },
      },
    });
    // Group message after startedAt -> AWAITING_DRAFT
    const groupTimeSec = Math.floor((startedAt + 2_000) / 1000);
    ws.emitFrame({
      cmd: WsCmd.CALLBACK,
      headers: { req_id: 'req-grp-1' },
      body: {
        msgid: 'msg-grp-1',
        aibotid: botId,
        chatid: 'wr-room-77',
        chattype: 'group',
        from: { userid: 'u-bob' },
        create_time: groupTimeSec,
        msgtype: 'text',
        text: { content: '原始群消息' },
      },
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    await connector.collect(autoStore, 'dm', new AbortController().signal);

    expect(wecomStore.events().find(e => e.payload.platformEventId === 'msg-pre-auto')?.status).toBe('BASELINE');
    const grpEvent = wecomStore.events().find(e => e.payload.platformEventId === 'msg-grp-1')!;
    expect(grpEvent.status).toBe('AWAITING_DRAFT');

    // Expire req_id TTL: group reply MUST fail closed with WECOM_WS_REPLY_ROUTE_MISSING (never fall back to aibot_send_msg).
    clockMs += 2_000;
    const expiredHandle = await connector.adapter(grpEvent.payload, wecomStore);
    try {
      await expect(expiredHandle.adapter.inspect(grpEvent.payload)).rejects.toThrow('WECOM_WS_REPLY_ROUTE_MISSING');
    } finally {
      await expiredHandle.dispose();
    }
    expect(ws.sentFrames.filter(f => f.cmd === WsCmd.SEND_MSG)).toHaveLength(0);

    // Same msgid with mutated text must NOT be masked by seenMsgBindings -> triggers SOURCE_COLLISION & MANUAL_REVIEW.
    ws.emitFrame({
      cmd: WsCmd.CALLBACK,
      headers: { req_id: 'req-grp-1-mut' },
      body: {
        msgid: 'msg-grp-1',
        aibotid: botId,
        chatid: 'wr-room-77',
        chattype: 'group',
        from: { userid: 'u-bob' },
        create_time: groupTimeSec,
        msgtype: 'text',
        text: { content: '被篡改后的群消息' },
      },
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    await connector.observe(wecomStore, 'dm');
    expect(wecomStore.event(grpEvent.id).status).toBe('MANUAL_REVIEW');
    const collisionAudit = wecomStore.db
      .prepare("SELECT event_type FROM audit_events WHERE entity_id=? AND event_type='SOURCE_COLLISION'")
      .get(grpEvent.id);
    expect(collisionAudit).toBeDefined();
  });
});
