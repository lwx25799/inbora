import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { describe, expect, test, vi } from 'vitest';
import { Blocked, digest, targetKey } from '../../src/core/contracts.js';
import { SendCoordinator } from '../../src/core/send-coordinator.js';
import { createOfficialApiTransportStatus } from '../../src/platform/official-api-base.js';
import {
  MemoryWeChatKfCursorStore,
  WeChatKfPlatformConnector,
  computeSignature,
  deriveWeChatKfMsgId,
  encrypt,
  type WeChatKfMessage,
} from '../../src/platform/wechat-kf/index.js';
import { AccountStore } from '../../src/storage/account-store.js';
import { migrateAutomation } from '../../src/storage/automation-migration.js';
import { AutomationStore } from '../../src/storage/automation-store.js';
import { migrateClient } from '../../src/storage/client-migration.js';
import { migrateLocalAssistant } from '../../src/storage/local-assistant-migration.js';
import { migrateModelProviders } from '../../src/storage/model-provider-migration.js';
import { migrateToSchema4 } from '../../src/storage/schema4-migration.js';
import { EventStore } from '../../src/storage/store.js';
import { privateTemp } from '../helpers.js';

const TEST_AES_KEY = Buffer.alloc(32, 0x3c).toString('base64').slice(0, 43);
const TEST_CORP_ID = 'ww_integ_corp_01';
const TEST_SECRET = 'synthetic_integ_secret_never_in_sqlite_888';
const TEST_TOKEN = 'synthetic_integ_webhook_token_777';
const TEST_OPEN_KFID = 'wk_inbora_kf_001';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function withTempStore(run: (ctx: { root: string; store: EventStore }) => Promise<void>): Promise<void> {
  const root = privateTemp('wechat-kf-integ-');
  const store = new EventStore(join(root, 'wechat-kf.sqlite'), true);
  try {
    await run({ root, store });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function buildWebhookPost(syncToken: string, openKfId = TEST_OPEN_KFID, ts = '1700000100', nonce = 'nonce_wh') {
  const innerXml = `<xml>
    <ToUserName><![CDATA[${TEST_CORP_ID}]]></ToUserName>
    <CreateTime>${ts}</CreateTime>
    <MsgType><![CDATA[event]]></MsgType>
    <Event><![CDATA[kf_msg_or_event]]></Event>
    <Token><![CDATA[${syncToken}]]></Token>
    <OpenKfId><![CDATA[${openKfId}]]></OpenKfId>
  </xml>`;
  const encrypted = encrypt(TEST_AES_KEY, innerXml, TEST_CORP_ID);
  const outerXml = `<xml><ToUserName><![CDATA[${TEST_CORP_ID}]]></ToUserName><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`;
  const sig = computeSignature(TEST_TOKEN, ts, nonce, encrypted);
  return { query: { msg_signature: sig, timestamp: ts, nonce }, body: outerXml };
}

describe('WeChatKfPlatformConnector integration', () => {
  test('collect(startedAt) and firstRunAt enforce baseline/new/restart states and audit msg_send_fail (#43-2, #43-5)', async () => {
    await withTempStore(async ({ root, store }) => {
      await migrateClient(store, join(root, 'client-backup.sqlite'));
      await migrateAutomation(store, join(root, 'auto-backup.sqlite'));
      const automation = new AutomationStore(store);
      const startedAtMs = Date.now() - 10_000;
      automation.initialize(startedAtMs);
      const startedSec = Math.floor(startedAtMs / 1000);

      let batch: WeChatKfMessage[] = [
        // Pre-start history MUST be BASELINE, never AWAITING_DRAFT (#43-5)
        {
          msgid: 'msg_old_history_0',
          open_kfid: TEST_OPEN_KFID,
          external_userid: 'wm_customer_001',
          send_time: startedSec - 60,
          origin: 3,
          msgtype: 'text',
          text: { content: '启动前的旧消息' },
        },
        // Post-start customer text -> AWAITING_DRAFT
        {
          msgid: 'msg_cust_text_1',
          open_kfid: TEST_OPEN_KFID,
          external_userid: 'wm_customer_001',
          send_time: startedSec + 5,
          origin: 3,
          msgtype: 'text',
          text: { content: '请问怎么发货？' },
        },
        // Post-start customer image -> MANUAL_REVIEW with contentType + placeholder
        {
          msgid: 'msg_cust_img_2',
          open_kfid: TEST_OPEN_KFID,
          external_userid: 'wm_customer_001',
          send_time: startedSec + 6,
          origin: 3,
          msgtype: 'image',
          image: { media_id: 'media_img_1' },
        },
        // System msg_send_fail event -> redacted audit, not inbound event (#43-2)
        {
          msgid: 'msg_sys_fail_3',
          open_kfid: TEST_OPEN_KFID,
          send_time: startedSec + 7,
          origin: 4,
          msgtype: 'event',
          event: {
            event_type: 'msg_send_fail',
            open_kfid: TEST_OPEN_KFID,
            external_userid: 'wm_customer_001',
            fail_msgid: 'failed_api_msgid_42',
            fail_type: 10,
          },
        },
        // Servicer echo (origin=5) -> ignored
        {
          msgid: 'msg_self_echo_4',
          open_kfid: TEST_OPEN_KFID,
          external_userid: 'wm_customer_001',
          send_time: startedSec + 8,
          origin: 5,
          msgtype: 'text',
          text: { content: '客服历史回复' },
        },
      ];

      const fetchImpl = vi.fn<typeof fetch>(async url => {
        if (String(url).includes('/gettoken')) {
          return jsonResponse({ errcode: 0, errmsg: 'ok', access_token: 'tok_collect_1', expires_in: 7200 });
        }
        return jsonResponse({ errcode: 0, errmsg: 'ok', next_cursor: 'cursor_p1', has_more: 0, msg_list: batch });
      });

      const cursorStore = new MemoryWeChatKfCursorStore();
      const connector = new WeChatKfPlatformConnector({
        root,
        openKfId: TEST_OPEN_KFID,
        credentials: { corpId: TEST_CORP_ID, appSecret: TEST_SECRET },
        fetchImpl,
        cursorStore,
      });

      await connector.collect(automation, 'dm', new AbortController().signal);
      expect(await connector.currentCursor()).toBe('cursor_p1');

      const initialEvents = store.events();
      expect(initialEvents).toHaveLength(3);
      expect(initialEvents.find(e => e.payload.platformEventId === 'msg_old_history_0')?.status).toBe('BASELINE');
      expect(initialEvents.find(e => e.payload.platformEventId === 'msg_cust_text_1')?.status).toBe('AWAITING_DRAFT');
      const imgEvent = initialEvents.find(e => e.payload.platformEventId === 'msg_cust_img_2')!;
      expect(imgEvent.status).toBe('MANUAL_REVIEW');
      expect(imgEvent.payload.contentType).toBe('IMAGE');
      expect(imgEvent.payload.observationIssue).toBe('DM_CONTENT_UNVERIFIED');

      // msg_send_fail audit persisted with hashed digests only (#43-2)
      const failAudit = store.db
        .prepare("SELECT detail_redacted FROM audit_events WHERE event_type='WECHAT_KF_MSG_SEND_FAIL'")
        .get() as { detail_redacted: string } | undefined;
      expect(failAudit).toBeDefined();
      expect(JSON.parse(failAudit!.detail_redacted)).toEqual({
        failMsgIdDigest: digest('failed_api_msgid_42'),
        failType: 10,
        targetDigest: digest('wm_customer_001'),
      });
      expect(failAudit!.detail_redacted).not.toContain('failed_api_msgid_42');

      // Restart WITHOUT explicit firstRunAt: reads persisted automation_state.started_at for both observe and webhook (#51-1)
      const afterRestartSec = Math.floor(Date.now() / 1000) + 2;
      batch = [
        batch[0]!,
        {
          msgid: 'msg_after_restart_5',
          open_kfid: TEST_OPEN_KFID,
          external_userid: 'wm_customer_001',
          send_time: afterRestartSec,
          origin: 3,
          msgtype: 'text',
          text: { content: '重启后追问' },
        },
        // New peer discovered after restart still respects persisted startedAt for pre-start history & live message
        {
          msgid: 'msg_peer2_old',
          open_kfid: TEST_OPEN_KFID,
          external_userid: 'wm_customer_002',
          send_time: startedSec - 30,
          origin: 3,
          msgtype: 'text',
          text: { content: '新会话的历史旧消息' },
        },
        {
          msgid: 'msg_peer2_live',
          open_kfid: TEST_OPEN_KFID,
          external_userid: 'wm_customer_002',
          send_time: startedSec + 5,
          origin: 3,
          msgtype: 'text',
          text: { content: '新会话首条实时消息' },
        },
      ];
      const restarted = new WeChatKfPlatformConnector({
        root,
        openKfId: TEST_OPEN_KFID,
        credentials: { corpId: TEST_CORP_ID, appSecret: TEST_SECRET, token: TEST_TOKEN, encodingAESKey: TEST_AES_KEY },
        fetchImpl,
      });
      const restartObs = await restarted.observe(store, 'dm');
      expect(restartObs.newEventIds).toHaveLength(2);
      expect(store.events().find(e => e.payload.platformEventId === 'msg_after_restart_5')?.status).toBe('AWAITING_DRAFT');
      expect(store.events().find(e => e.payload.platformEventId === 'msg_peer2_old')?.status).toBe('BASELINE');
      expect(store.events().find(e => e.payload.platformEventId === 'msg_peer2_live')?.status).toBe('AWAITING_DRAFT');

      // Webhook for a brand-new peer without explicit firstRunAt also reuses startedAt -> AWAITING_DRAFT (#51-1)
      batch = [{
        msgid: 'msg_peer3_wh_live',
        open_kfid: TEST_OPEN_KFID,
        external_userid: 'wm_customer_003',
        send_time: afterRestartSec + 1,
        origin: 3,
        msgtype: 'text',
        text: { content: 'Webhook 新客户实时消息' },
      }];
      const whPacket = buildWebhookPost('WH_STARTED_AT_SHARED', TEST_OPEN_KFID, String(afterRestartSec + 1), 'n_shared');
      const whRes = await restarted.handleWebhookEvent(whPacket.query, whPacket.body, store);
      expect(whRes).toMatchObject({ accepted: true, synced: true, truncated: false });
      expect(store.events().find(e => e.payload.platformEventId === 'msg_peer3_wh_live')?.status).toBe('AWAITING_DRAFT');

      await restarted.close();
      await connector.close();
    });
  });

  test('delivers single-submit reply via SendCoordinator, aligns transportStatus contract, and hides secrets from util.inspect (#43-2, #43-8, #43-12)', async () => {
    await withTempStore(async ({ root, store }) => {
      const startMs = Date.now() - 10_000;
      const msgSec = Math.floor(startMs / 1000) + 5;
      let sendFetchCalls = 0;
      let capturedSendBody: Record<string, unknown> | undefined;

      const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
        const target = String(url);
        if (target.includes('/gettoken')) {
          return jsonResponse({ errcode: 0, errmsg: 'ok', access_token: 'tok_secret_integ_1', expires_in: 7200 });
        }
        if (target.includes('/kf/sync_msg')) {
          return jsonResponse({
            errcode: 0, errmsg: 'ok', next_cursor: 'cursor_send_1', has_more: 0,
            msg_list: [{
              msgid: 'msg_send_flow_1', open_kfid: TEST_OPEN_KFID, external_userid: 'wm_customer_001',
              send_time: msgSec, origin: 3, msgtype: 'text', text: { content: '请问怎么发货？' },
            }],
          });
        }
        if (target.includes('/kf/send_msg')) {
          sendFetchCalls++;
          capturedSendBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          return jsonResponse({ errcode: 0, errmsg: 'ok', msgid: String(capturedSendBody.msgid ?? '') });
        }
        throw new Error(`Unexpected URL: ${target}`);
      });

      const connector = new WeChatKfPlatformConnector({
        root,
        openKfId: TEST_OPEN_KFID,
        firstRunAt: startMs,
        credentials: () => ({
          corpId: TEST_CORP_ID,
          appSecret: TEST_SECRET,
          token: TEST_TOKEN,
          encodingAESKey: TEST_AES_KEY,
        }),
        fetchImpl,
      });

      expect(connector.platformId).toBe('wechat-kf');
      expect(connector.capabilities).toEqual({
        channels: ['DIRECT_MESSAGE'],
        loginRecovery: false,
        manualSecurityRecovery: false,
        preview: false,
        readback: false,
        transport: 'official_api',
      });

      // Official API transport status contract alignment (#43-12)
      const verifiedStatus = createOfficialApiTransportStatus(connector.transportStatus());
      expect(verifiedStatus).toMatchObject({
        transport: 'official_api',
        state: 'CONNECTED',
        protocol: 'wechat_kf_http',
        endpointDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        errorCode: null,
      });

      const { newEventIds } = await connector.observe(store, 'dm');
      expect(newEventIds).toHaveLength(1);
      const textEvent = store.event(newEventIds[0]!);

      // Approve and dispatch via SendCoordinator (synchronous adapter.readback proves delivery even with capabilities.readback=false)
      const draft = store.saveDraft(textEvent.id, '您好，下单后24小时内发货。', 'test-model');
      const handle = await connector.adapter(textEvent.payload, store);
      try {
        const snap = await handle.adapter.inspect(textEvent.payload);
        expect(snap).toMatchObject({ accountId: store.accountId, ownId: TEST_OPEN_KFID, targetKey: targetKey(textEvent.payload) });
        store.approve(draft.id, snap, draft.version, draft.text);

        const coordinator = new SendCoordinator(store, connector.actor);
        expect(await coordinator.send(draft.id, handle.adapter, false)).toBe('CONFIRMED');
        expect(sendFetchCalls).toBe(1);
        expect(capturedSendBody).toMatchObject({
          touser: 'wm_customer_001',
          open_kfid: TEST_OPEN_KFID,
          msgtype: 'text',
          text: { content: '您好，下单后24小时内发货。' },
        });
        expect(store.receiptForEvent(textEvent.id)).toMatchObject({
          result: 'CONFIRMED',
          proof_ref: expect.stringMatching(/^[a-f0-9]{64}$/u),
        });
      } finally {
        await handle.dispose();
      }

      // util.inspect, toJSON, status, and SQLite must leak zero credentials or access_token (#43-8)
      const dump = JSON.stringify({
        status: connector.status(),
        transport: connector.transportStatus(),
        connector,
        audits: store.db.prepare('SELECT * FROM audit_events').all(),
      }) + '\n' + inspect(connector, { depth: null, showHidden: true }) + '\n' + inspect(connector.apiClient, { depth: null, showHidden: true });
      expect(dump).not.toContain(TEST_SECRET);
      expect(dump).not.toContain(TEST_TOKEN);
      expect(dump).not.toContain(TEST_AES_KEY);
      expect(dump).not.toContain('tok_secret_integ_1');

      await connector.close();
      expect(connector.transportStatus().state).toBe('DISCONNECTED');
    });
  });

  test('clickOnce re-checks authority/pause/close via beforeSend right before writing HTTPS and aborts with 0 send_msg calls (#43-3)', async () => {
    await withTempStore(async ({ root, store }) => {
      const startMs = Date.now() - 20_000;
      const msgSec = Math.floor(startMs / 1000) + 5;
      let sendCalls = 0;
      let tokenCallCount = 0;
      let revokeDuringTokenFetch: (() => void) | undefined;

      const fetchImpl = vi.fn<typeof fetch>(async url => {
        const target = String(url);
        if (target.includes('/gettoken')) {
          tokenCallCount++;
          revokeDuringTokenFetch?.();
          return jsonResponse({ errcode: 0, errmsg: 'ok', access_token: `tok_pre_${tokenCallCount}`, expires_in: 7200 });
        }
        if (target.includes('/kf/sync_msg')) {
          return jsonResponse({
            errcode: 0, errmsg: 'ok', has_more: 0, next_cursor: 'cur_1',
            msg_list: [{
              msgid: 'msg_revoke_1', open_kfid: TEST_OPEN_KFID, external_userid: 'wm_revoke',
              send_time: msgSec, origin: 3, msgtype: 'text', text: { content: '测试撤销' },
            }],
          });
        }
        if (target.includes('/kf/send_msg')) {
          sendCalls++;
          return jsonResponse({ errcode: 0, errmsg: 'ok', msgid: 'should_never_send' });
        }
        throw new Error(`Unexpected URL: ${target}`);
      });

      const connector = new WeChatKfPlatformConnector({
        root,
        openKfId: TEST_OPEN_KFID,
        firstRunAt: startMs,
        credentials: { corpId: TEST_CORP_ID, appSecret: TEST_SECRET },
        fetchImpl,
      });

      const { newEventIds } = await connector.observe(store, 'dm');
      const event = store.event(newEventIds[0]!);
      const draft = store.saveDraft(event.id, '即将被急停拦截的回复', 'test-model');
      const handle = await connector.adapter(event.payload, store);
      try {
        store.approve(draft.id, await handle.adapter.inspect(event.payload), draft.version, draft.text);
        // Clear cached token so clickOnce must await gettoken; trigger emergency stop during token wait
        connector.apiClient.clearCachedToken();
        let stopped = false;
        revokeDuringTokenFetch = () => { stopped = true; };

        const coordinator = new SendCoordinator(store, connector.actor);
        const outcome = await coordinator.send(draft.id, handle.adapter, false, {
          check: () => {},
          committed: () => {},
          beforeSubmit: () => { if (stopped) throw new Blocked('EMERGENCY_STOPPED'); },
        });
        expect(outcome).toBe('UNCERTAIN');
        expect(sendCalls).toBe(0);
        expect(store.receiptForEvent(event.id)).toMatchObject({
          result: 'UNCERTAIN',
          proof_ref: 'POST_INTENT_FAILURE:DISPATCH:EMERGENCY_STOPPED',
        });
      } finally {
        await handle.dispose();
        await connector.close();
      }
    });
  });

  test('timeout enters UNCERTAIN with 0 resend, verifyExisting honestly returns false even with origin=5 same-text, and rejects after close() (#43-2, #43-11)', async () => {
    await withTempStore(async ({ root, store }) => {
      const startMs = Date.now() - 20_000;
      const msgSec = Math.floor(startMs / 1000) + 5;
      let sendCalls = 0;
      let sentMsgId: string | undefined;

      const initialFetch = vi.fn<typeof fetch>(async (url, init) => {
        const target = String(url);
        if (target.includes('/gettoken')) {
          return jsonResponse({ errcode: 0, errmsg: 'ok', access_token: 'tok_uncertain', expires_in: 7200 });
        }
        if (target.includes('/kf/sync_msg')) {
          return jsonResponse({
            errcode: 0, errmsg: 'ok', next_cursor: 'cur_after_in', has_more: 0,
            msg_list: [{
              msgid: 'msg_in_timeout_1', open_kfid: TEST_OPEN_KFID, external_userid: 'wm_customer_timeout',
              send_time: msgSec, origin: 3, msgtype: 'text', text: { content: '在吗？' },
            }],
          });
        }
        if (target.includes('/kf/send_msg')) {
          sendCalls++;
          sentMsgId = (JSON.parse(String(init?.body ?? '{}')) as { msgid?: string }).msgid;
          const err = new Error('request timed out');
          err.name = 'TimeoutError';
          throw err;
        }
        throw new Error(`Unexpected URL: ${target}`);
      });

      const connector1 = new WeChatKfPlatformConnector({
        root,
        openKfId: TEST_OPEN_KFID,
        firstRunAt: startMs,
        credentials: { corpId: TEST_CORP_ID, appSecret: TEST_SECRET },
        fetchImpl: initialFetch,
      });

      const { newEventIds } = await connector1.observe(store, 'dm');
      const event = store.event(newEventIds[0]!);
      const replyText = '您好，我在的，请问有什么可以帮您？';
      const draft = store.saveDraft(event.id, replyText, 'test-model');

      const handle = await connector1.adapter(event.payload, store);
      try {
        store.approve(draft.id, await handle.adapter.inspect(event.payload), draft.version, draft.text);
        const coordinator = new SendCoordinator(store, connector1.actor);
        expect(await coordinator.send(draft.id, handle.adapter, false)).toBe('UNCERTAIN');
        expect(sendCalls).toBe(1);
        expect(store.receiptForEvent(event.id)).toMatchObject({ result: 'UNCERTAIN', proof_ref: 'NO_UNIQUE_BOUND_PROOF' });
        await expect(coordinator.send(draft.id, handle.adapter, false)).rejects.toThrow();
        expect(sendCalls).toBe(1);
      } finally {
        await handle.dispose();
        await connector1.close();
      }

      const intentRow = store.db.prepare('SELECT id FROM send_intents WHERE event_id=?').get(event.id) as { id: string };
      expect(sentMsgId).toBe(deriveWeChatKfMsgId(intentRow.id));

      // Restarted connector: verifyExisting MUST NOT fabricate proof from origin=5 same-text human replies or call network
      const restartFetch = vi.fn<typeof fetch>(async () => {
        throw new Error('verifyExisting must not call /kf/send_msg or fabricate proof from /kf/sync_msg');
      });
      const restartCursorStore = new MemoryWeChatKfCursorStore();
      restartCursorStore.save(store.accountId, TEST_OPEN_KFID, 'cur_before_verify');

      const connector2 = new WeChatKfPlatformConnector({
        root,
        openKfId: TEST_OPEN_KFID,
        firstRunAt: startMs,
        credentials: { corpId: TEST_CORP_ID, appSecret: TEST_SECRET },
        fetchImpl: restartFetch,
        cursorStore: restartCursorStore,
      });

      const verified = await connector2.verifyExisting(store, event.id);
      expect(verified.verified).toBe(false);
      expect(restartFetch).not.toHaveBeenCalled();
      expect(await connector2.currentCursor()).toBe('cur_before_verify');

      // After close(), verifyExisting rejects with BROWSER_CLOSED (#43-11)
      await connector2.close();
      await expect(connector2.verifyExisting(store, event.id)).rejects.toThrow('BROWSER_CLOSED');
      expect(restartFetch).not.toHaveBeenCalled();
    });
  });

  test('webhook does not leak aborted first signal into later posts and reports maxSyncPages truncation without consuming token (#43-4, #43-11)', async () => {
    await withTempStore(async ({ root, store }) => {
      const startMs = Date.now() - 10_000;
      const msgSec = Math.floor(startMs / 1000) + 5;
      let syncPage = 0;

      const fetchImpl = vi.fn<typeof fetch>(async url => {
        if (String(url).includes('/gettoken')) {
          return jsonResponse({ errcode: 0, errmsg: 'ok', access_token: 'tok_wh', expires_in: 7200 });
        }
        syncPage++;
        if (syncPage === 1) {
          return jsonResponse({
            errcode: 0, errmsg: 'ok', next_cursor: 'cur_p1', has_more: 1,
            msg_list: [{
              msgid: 'msg_wh_1', open_kfid: TEST_OPEN_KFID, external_userid: 'wm_wh_user',
              send_time: msgSec, origin: 3, msgtype: 'text', text: { content: '第一页消息' },
            }],
          });
        }
        return jsonResponse({
          errcode: 0, errmsg: 'ok', next_cursor: 'cur_p2', has_more: 0,
          msg_list: [{
            msgid: 'msg_wh_2', open_kfid: TEST_OPEN_KFID, external_userid: 'wm_wh_user',
            send_time: msgSec + 1, origin: 3, msgtype: 'text', text: { content: '第二页消息' },
          }],
        });
      });

      const connector = new WeChatKfPlatformConnector({
        root,
        openKfId: TEST_OPEN_KFID,
        firstRunAt: startMs,
        maxSyncPages: 1,
        credentials: { corpId: TEST_CORP_ID, appSecret: TEST_SECRET, token: TEST_TOKEN, encodingAESKey: TEST_AES_KEY },
        fetchImpl,
      });

      const firstPacket = buildWebhookPost('WH_TOK_ABORT');
      const aborted = new AbortController();
      aborted.abort();
      await expect(connector.handleWebhookEvent(firstPacket.query, firstPacket.body, store, aborted.signal))
        .rejects.toThrow('WECHAT_KF_TIMEOUT');

      // Second packet with fresh signal must NOT inherit the aborted first signal (#43-4)
      const secondPacket = buildWebhookPost('WH_TOK_PAGED', TEST_OPEN_KFID, '1700000105', 'nonce_2');
      const res1 = await connector.handleWebhookEvent(secondPacket.query, secondPacket.body, store, new AbortController().signal);
      expect(res1).toMatchObject({ accepted: true, duplicate: false, synced: true, truncated: true });
      expect(store.events()).toHaveLength(1);

      // Because res1 was truncated at maxSyncPages with has_more=1, redelivery continues pulling remaining page (#43-11)
      const res2 = await connector.handleWebhookEvent(secondPacket.query, secondPacket.body, store, new AbortController().signal);
      expect(res2).toMatchObject({ accepted: true, duplicate: false, synced: true, truncated: false });
      expect(store.events()).toHaveLength(2);

      // Now fully drained -> third delivery is deduplicated
      const res3 = await connector.handleWebhookEvent(secondPacket.query, secondPacket.body, store, new AbortController().signal);
      expect(res3).toMatchObject({ accepted: true, duplicate: true, synced: false, truncated: false });

      // Upstream has_more=1 with missing or repeated next_cursor marks truncated=true and preserves retry eligibility (#51-5)
      let stallMode: 'missing' | 'repeated' | 'done' = 'missing';
      const stallFetch = vi.fn<typeof fetch>(async url => {
        if (String(url).includes('/gettoken')) {
          return jsonResponse({ errcode: 0, errmsg: 'ok', access_token: 'tok_stall', expires_in: 7200 });
        }
        if (stallMode === 'missing') {
          return jsonResponse({ errcode: 0, errmsg: 'ok', has_more: 1, msg_list: [] });
        }
        if (stallMode === 'repeated') {
          return jsonResponse({ errcode: 0, errmsg: 'ok', next_cursor: 'cur_p2', has_more: 1, msg_list: [] });
        }
        return jsonResponse({ errcode: 0, errmsg: 'ok', next_cursor: 'cur_p3', has_more: 0, msg_list: [] });
      });
      const stallCursor = new MemoryWeChatKfCursorStore();
      stallCursor.save(store.accountId, TEST_OPEN_KFID, 'cur_p2');
      const stallConnector = new WeChatKfPlatformConnector({
        root,
        openKfId: TEST_OPEN_KFID,
        firstRunAt: startMs,
        cursorStore: stallCursor,
        credentials: { corpId: TEST_CORP_ID, appSecret: TEST_SECRET, token: TEST_TOKEN, encodingAESKey: TEST_AES_KEY },
        fetchImpl: stallFetch,
      });
      const stallPacket = buildWebhookPost('WH_TOK_STALL', TEST_OPEN_KFID, '1700000109', 'nonce_stall');
      expect(await stallConnector.handleWebhookEvent(stallPacket.query, stallPacket.body, store))
        .toMatchObject({ accepted: true, duplicate: false, synced: true, truncated: true });
      stallMode = 'repeated';
      expect(await stallConnector.handleWebhookEvent(stallPacket.query, stallPacket.body, store))
        .toMatchObject({ accepted: true, duplicate: false, synced: true, truncated: true });
      stallMode = 'done';
      expect(await stallConnector.handleWebhookEvent(stallPacket.query, stallPacket.body, store))
        .toMatchObject({ accepted: true, duplicate: false, synced: true, truncated: false });
      expect(await stallConnector.handleWebhookEvent(stallPacket.query, stallPacket.body, store))
        .toMatchObject({ accepted: true, duplicate: true, synced: false, truncated: false });

      await stallConnector.close();
      await connector.close();
    });
  });

  test('schema4 bindStore requires an existing wechat-kf account row and refuses missing or Douyin rows (#43-6, #51-2)', async () => {
    const root = privateTemp('wechat-kf-schema4-');
    const dbFile = join(root, 'schema4.sqlite');
    const baseStore = new EventStore(dbFile, true);
    let kfStore: EventStore | undefined;
    try {
      await migrateClient(baseStore, join(root, 'client.bak'));
      await migrateAutomation(baseStore, join(root, 'auto.bak'));
      await migrateLocalAssistant(baseStore, join(root, 'assist.bak'));
      await migrateModelProviders(baseStore, root);
      await migrateToSchema4(baseStore, join(root, 's4.bak'));

      // Before account_001 exists in schema4 accounts table, bindStore MUST refuse instead of inserting default 'douyin' (#51-2)
      const missingRowConnector = new WeChatKfPlatformConnector({
        root,
        accountId: 'account_001',
        openKfId: TEST_OPEN_KFID,
        credentials: { corpId: TEST_CORP_ID, appSecret: TEST_SECRET },
      });
      expect(() => missingRowConnector.bindStore(baseStore)).toThrow('WECHAT_KF_ACCOUNT_CHANGED');
      expect(baseStore.db.prepare('SELECT id FROM accounts WHERE id=?').get('account_001')).toBeUndefined();

      const accounts = new AccountStore(baseStore.db);
      accounts.ensureLegacyPrimaryAccount('douyin-profile');
      // account_001 now exists with platform='douyin', own_id='' -> still refused (#43-6)
      expect(() => missingRowConnector.bindStore(baseStore)).toThrow('WECHAT_KF_ACCOUNT_CHANGED');
      expect(baseStore.accountOwnId('account_001')).toBe('');

      // Registering a dedicated wechat-kf account succeeds cleanly
      accounts.registerAccount({
        commandId: randomUUID(),
        accountId: 'account_kf_1',
        platform: 'wechat-kf',
        connector: 'wechat-kf',
        displayLabel: 'WeChat KF',
      });
      kfStore = new EventStore(dbFile, false, undefined, 'account_kf_1');
      const okConnector = new WeChatKfPlatformConnector({
        root,
        accountId: 'account_kf_1',
        openKfId: TEST_OPEN_KFID,
        credentials: { corpId: TEST_CORP_ID, appSecret: TEST_SECRET },
      });
      okConnector.bindStore(kfStore);
      expect(kfStore.accountOwnId('account_kf_1')).toBe(TEST_OPEN_KFID);
      await okConnector.close();
      await missingRowConnector.close();
    } finally {
      kfStore?.close();
      baseStore.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
