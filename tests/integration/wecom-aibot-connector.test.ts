import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { SendCoordinator } from '../../src/core/send-coordinator.js';
import { EventStore } from '../../src/storage/store.js';
import {
  WECOM_AIBOT_PLATFORM_ID,
  WecomAibotPlatformConnector,
  WsCmd,
  type WecomWebSocketEvent,
  type WecomWebSocketLike,
  type WecomWebSocketListener,
  type WecomWsFrame,
} from '../../src/platform/wecom-aibot/index.js';
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
    for (const listener of [...this.listeners[type]]) {
      listener(event);
    }
  }
}

const tempDirs: string[] = [];
const openStores: EventStore[] = [];
const openConnectors: WecomAibotPlatformConnector[] = [];

function createTestStore(): EventStore {
  const dir = privateTemp('wecom-aibot-');
  tempDirs.push(dir);
  const store = new EventStore(join(dir, 'poc.sqlite'), true);
  openStores.push(store);
  return store;
}

function createConnectedConnector(options: {
  botId?: string;
  secret?: string;
  ackMode: 'auto_ok' | 'drop_on_send';
  autoPersistInbound?: boolean;
}) {
  const sockets: DeterministicWs[] = [];
  const secret = options.secret ?? 'synthetic-wecom-bot-secret-xyz987654321';
  const botId = options.botId ?? 'aibot-corp-001';

  const connector = new WecomAibotPlatformConnector({
    botId,
    secret,
    autoPersistInbound: options.autoPersistInbound ?? false,
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
      queueMicrotask(() => ws.openAndAuth());
      return ws;
    },
  });
  openConnectors.push(connector);
  return { connector, sockets, secret, botId };
}

afterEach(async () => {
  while (openConnectors.length > 0) {
    const connector = openConnectors.pop()!;
    await connector.close();
  }
  while (openStores.length > 0) {
    const store = openStores.pop()!;
    store.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('WecomAibotPlatformConnector integration with EventStore and SendCoordinator', () => {
  test('normalizes single/group/media inbound frames, deduplicates msgid, ignores self-echo, and confirms single-shot approved reply', async () => {
    const store = createTestStore();
    const { connector, sockets, secret, botId } = createConnectedConnector({ ackMode: 'auto_ok' });

    await connector.open();
    connector.bindStore(store);

    expect(connector.platformId).toBe(WECOM_AIBOT_PLATFORM_ID);
    expect(connector.capabilities).toEqual({
      channels: ['DIRECT_MESSAGE'],
      loginRecovery: false,
      manualSecurityRecovery: false,
      preview: false,
      readback: true,
      transport: 'official_api',
    });

    const baseUnix = Math.floor(Date.now() / 1000) - 20;
    const ws = sockets[0]!;

    // 1. Single chat text message
    ws.emitFrame({
      cmd: WsCmd.CALLBACK,
      headers: { req_id: 'inbound-req-001' },
      body: {
        msgid: 'msg-single-1',
        aibotid: botId,
        chattype: 'single',
        from: { userid: 'customer-alice', name: 'Alice' },
        create_time: baseUnix,
        msgtype: 'text',
        text: { content: '请问发货时间是多久？' },
      },
    });
    // 2. Duplicate msgid -> ignored
    ws.emitFrame({
      cmd: WsCmd.CALLBACK,
      headers: { req_id: 'inbound-req-001-dup' },
      body: {
        msgid: 'msg-single-1',
        aibotid: botId,
        chattype: 'single',
        from: { userid: 'customer-alice', name: 'Alice' },
        create_time: baseUnix,
        msgtype: 'text',
        text: { content: '请问发货时间是多久？' },
      },
    });
    // 3. Self echo -> ignored
    ws.emitFrame({
      cmd: WsCmd.CALLBACK,
      headers: { req_id: 'inbound-req-self' },
      body: {
        msgid: 'msg-self-1',
        aibotid: botId,
        chattype: 'single',
        from: { userid: botId },
        create_time: baseUnix + 1,
        msgtype: 'text',
        text: { content: 'self echo' },
      },
    });
    // 4. Group text message
    ws.emitFrame({
      cmd: WsCmd.CALLBACK,
      headers: { req_id: 'inbound-req-group-1' },
      body: {
        msgid: 'msg-group-1',
        aibotid: botId,
        chatid: 'wr-group-99',
        chattype: 'group',
        from: { userid: 'customer-bob' },
        create_time: baseUnix + 2,
        msgtype: 'text',
        text: { content: '群里咨询一下发票' },
      },
    });
    // 5. Image media message with sensitive aeskey that must NEVER leak into event text
    const mediaAesKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    ws.emitFrame({
      cmd: WsCmd.CALLBACK,
      headers: { req_id: 'inbound-req-img-1' },
      body: {
        msgid: 'msg-image-1',
        aibotid: botId,
        chattype: 'single',
        from: { userid: 'customer-carol' },
        create_time: baseUnix + 3,
        msgtype: 'image',
        image: { url: 'https://example.invalid/private-image?token=secret-img', aeskey: mediaAesKey },
      },
    });

    await new Promise(resolve => setTimeout(resolve, 10));
    const observed = await connector.observe(store, 'dm');
    expect(observed.newEventIds).toHaveLength(2);

    const events = store.events();
    expect(events).toHaveLength(3);

    const singleEvent = events.find(e => e.payload.platformEventId === 'msg-single-1')!;
    expect(singleEvent.payload.conversationId).toBe('single:customer-alice');
    expect(singleEvent.status).toBe('AWAITING_DRAFT');

    const groupEvent = events.find(e => e.payload.platformEventId === 'msg-group-1')!;
    expect(groupEvent.payload.conversationId).toBe('group:wr-group-99');
    expect(groupEvent.status).toBe('AWAITING_DRAFT');

    const imageEvent = events.find(e => e.payload.platformEventId === 'msg-image-1')!;
    expect(imageEvent.payload.contentType).toBe('IMAGE');
    expect(imageEvent.payload.observationIssue).toBe('DM_CONTENT_UNVERIFIED');
    expect(imageEvent.payload.text).toBe('[图片消息]');
    expect(imageEvent.payload.text).not.toContain(mediaAesKey);
    expect(imageEvent.status).toBe('MANUAL_REVIEW');

    // Approve draft and dispatch via real SendCoordinator.
    const draft = store.saveDraft(singleEvent.id, '工作日 24 小时内发出，请放心。', 'manual');
    const handle = await connector.adapter(singleEvent.payload, store);
    try {
      const snap = await handle.adapter.inspect(singleEvent.payload);
      store.approve(draft.id, snap, draft.version, draft.text);

      const coordinator = new SendCoordinator(store, connector.actor);
      const outcome = await coordinator.send(draft.id, handle.adapter, true);
      expect(outcome).toBe('CONFIRMED');
    } finally {
      await handle.dispose();
    }

    // Verify exactly 1 response frame sent, bound to original inbound req_id, single final message.
    const outboundReplies = ws.sentFrames.filter(f => f.cmd === WsCmd.RESPONSE);
    expect(outboundReplies).toHaveLength(1);
    expect(outboundReplies[0]!.headers.req_id).toBe('inbound-req-001');
    expect(outboundReplies[0]!.body).toMatchObject({
      msgtype: 'stream',
      stream: {
        finish: true,
        content: '工作日 24 小时内发出，请放心。',
      },
    });

    expect(store.event(singleEvent.id).status).toBe('CONFIRMED');
    const receipt = store.receiptForEvent(singleEvent.id) as { result: string; proof_ref: string };
    expect(receipt.result).toBe('CONFIRMED');

    // verifyExisting honestly reports no history fetch capability and sends 0 frames.
    const verification = await connector.verifyExisting(store, singleEvent.id);
    expect(verification).toEqual({ verified: false, evidenceId: 'wecom-ws-history-unavailable' });
    expect(ws.sentFrames.filter(f => f.cmd === WsCmd.RESPONSE)).toHaveLength(1);

    // Zero credential leakage across status, transportStatus, identity, and entire SQLite store.
    const transportStatus = connector.transportStatus();
    expect(transportStatus.transport).toBe('official_api');
    expect(transportStatus.protocol).toBe('wecom_ws');
    expect(transportStatus.state).toBe('CONNECTED');
    expect(transportStatus.endpointDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(typeof transportStatus.lastHeartbeatAt).toBe('number');

    const serializedOutputs = JSON.stringify({
      root: connector.root,
      status: connector.status(),
      transportStatus,
      resourceIdentity: connector.resourceIdentity(),
      identity: connector.identity('DIRECT_MESSAGE'),
      audits: store.db.prepare('SELECT * FROM audit_events').all(),
      events: store.db.prepare('SELECT * FROM inbound_events').all(),
      receipts: store.db.prepare('SELECT * FROM delivery_receipts').all(),
      intents: store.db.prepare('SELECT * FROM send_intents').all(),
    });
    expect(serializedOutputs).not.toContain(secret);
    expect(serializedOutputs).not.toContain(mediaAesKey);
  });

  test('disconnect during send yields UNCERTAIN with exactly 1 transmitted frame and 0 retries after reconnect', async () => {
    const store = createTestStore();
    const { connector, sockets, secret, botId } = createConnectedConnector({ ackMode: 'drop_on_send' });

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
        create_time: Math.floor(Date.now() / 1000) - 5,
        msgtype: 'text',
        text: { content: '在吗？帮查下订单' },
      },
    });
    await new Promise(resolve => setTimeout(resolve, 10));

    const observed = await connector.observe(store, 'dm');
    expect(observed.newEventIds).toHaveLength(1);
    const event = store.event(observed.newEventIds[0]!);
    const draft = store.saveDraft(event.id, '好的，请提供订单号。', 'manual');

    const handle = await connector.adapter(event.payload, store);
    const coordinator = new SendCoordinator(store, connector.actor);
    try {
      const snap = await handle.adapter.inspect(event.payload);
      store.approve(draft.id, snap, draft.version, draft.text);

      const outcome = await coordinator.send(draft.id, handle.adapter, true);
      expect(outcome).toBe('UNCERTAIN');

      // Re-attempting SendCoordinator.send must be rejected (target frozen / intent exists).
      await expect(coordinator.send(draft.id, handle.adapter, true)).rejects.toThrow();
    } finally {
      await handle.dispose();
    }

    // Wait for automatic reconnect to establish a second socket.
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(sockets.length).toBeGreaterThanOrEqual(2);

    // Across all sockets (including reconnected ones), total reply frames sent MUST equal 1 (zero retries).
    const totalReplyFrames = sockets.reduce(
      (sum, ws) => sum + ws.sentFrames.filter(f => f.cmd === WsCmd.RESPONSE || f.cmd === WsCmd.SEND_MSG).length,
      0,
    );
    expect(totalReplyFrames).toBe(1);

    const receipt = store.receiptForEvent(event.id) as { result: string; proof_ref: string };
    expect(receipt.result).toBe('UNCERTAIN');
    expect(receipt.proof_ref).toBe('NO_UNIQUE_BOUND_PROOF');
    expect(store.uncertain()).toHaveLength(1);

    // Zero secret leakage in audit/status even on failure paths.
    const serialized = JSON.stringify({
      status: connector.status(),
      transportStatus: connector.transportStatus(),
      audits: store.db.prepare('SELECT * FROM audit_events').all(),
      receipts: store.db.prepare('SELECT * FROM delivery_receipts').all(),
    });
    expect(serialized).not.toContain(secret);
  });
});
