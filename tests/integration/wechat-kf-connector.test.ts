import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { SendCoordinator } from '../../src/core/send-coordinator.js';
import { targetKey } from '../../src/core/contracts.js';
import {
  MemoryWeChatKfCursorStore,
  WeChatKfPlatformConnector,
  computeSignature,
  deriveWeChatKfMsgId,
  encrypt,
  type WeChatKfMessage,
} from '../../src/platform/wechat-kf/index.js';
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

describe('WeChatKfPlatformConnector integration', () => {
  test('observes origin=3 customer text & media, ignores origin=4/5 echoes, and delivers single-submit reply via SendCoordinator', async () => {
    await withTempStore(async ({ root, store }) => {
      const nowSec = Math.floor(Date.now() / 1000) - 10;
      let sendFetchCalls = 0;
      let capturedSendBody: Record<string, unknown> | undefined;

      const syncMessages: WeChatKfMessage[] = [
        {
          msgid: 'msg_cust_text_1',
          open_kfid: TEST_OPEN_KFID,
          external_userid: 'wm_customer_001',
          send_time: nowSec,
          origin: 3,
          msgtype: 'text',
          text: { content: '请问怎么发货？' },
        },
        {
          msgid: 'msg_cust_img_2',
          open_kfid: TEST_OPEN_KFID,
          external_userid: 'wm_customer_001',
          send_time: nowSec + 1,
          origin: 3,
          msgtype: 'image',
          image: { media_id: 'media_img_1' },
        },
        {
          msgid: 'msg_sys_event_3',
          open_kfid: TEST_OPEN_KFID,
          external_userid: 'wm_customer_001',
          send_time: nowSec + 2,
          origin: 4,
          msgtype: 'event',
          event: { event_type: 'enter_session' },
        },
        {
          msgid: 'msg_self_echo_4',
          open_kfid: TEST_OPEN_KFID,
          external_userid: 'wm_customer_001',
          send_time: nowSec + 3,
          origin: 5,
          msgtype: 'text',
          text: { content: '客服历史回复' },
        },
      ];

      const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
        const target = String(url);
        if (target.includes('/gettoken')) {
          return jsonResponse({ errcode: 0, errmsg: 'ok', access_token: 'tok_integ_1', expires_in: 7200 });
        }
        if (target.includes('/kf/sync_msg')) {
          return jsonResponse({
            errcode: 0,
            errmsg: 'ok',
            next_cursor: 'cursor_page_1',
            has_more: 0,
            msg_list: syncMessages,
          });
        }
        if (target.includes('/kf/send_msg')) {
          sendFetchCalls++;
          capturedSendBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          return jsonResponse({
            errcode: 0,
            errmsg: 'ok',
            msgid: String(capturedSendBody.msgid ?? 'kf_reply_001'),
          });
        }
        throw new Error(`Unexpected URL: ${target}`);
      });

      const cursorStore = new MemoryWeChatKfCursorStore();
      const connector = new WeChatKfPlatformConnector({
        root,
        openKfId: TEST_OPEN_KFID,
        credentials: () => ({
          corpId: TEST_CORP_ID,
          appSecret: TEST_SECRET,
          token: TEST_TOKEN,
          encodingAESKey: TEST_AES_KEY,
        }),
        fetchImpl,
        cursorStore,
      });

      expect(connector.platformId).toBe('wechat-kf');
      expect(connector.capabilities).toEqual({
        channels: ['DIRECT_MESSAGE'],
        loginRecovery: false,
        manualSecurityRecovery: false,
        preview: false,
        readback: true,
        transport: 'official_api',
      });

      const observed = await connector.observe(store, 'dm');
      expect(observed.newEventIds).toHaveLength(1);
      expect(await connector.currentCursor()).toBe('cursor_page_1');

      const allEvents = store.events();
      expect(allEvents).toHaveLength(2);
      const textEvent = allEvents.find(e => e.payload.platformEventId === 'msg_cust_text_1');
      const imgEvent = allEvents.find(e => e.payload.platformEventId === 'msg_cust_img_2');
      expect(textEvent).toBeDefined();
      expect(textEvent!.status).toBe('AWAITING_DRAFT');
      expect(textEvent!.payload.conversationId).toBe('wm_customer_001');
      expect(store.accountOwnId()).toBe(TEST_OPEN_KFID);

      // Non-text media event is preserved safely as MANUAL_REVIEW with contentType + placeholder
      expect(imgEvent).toBeDefined();
      expect(imgEvent!.status).toBe('MANUAL_REVIEW');
      expect(imgEvent!.payload.contentType).toBe('IMAGE');
      expect(imgEvent!.payload.observationIssue).toBe('DM_CONTENT_UNVERIFIED');
      expect(imgEvent!.payload.text).toBe('[图片消息]');

      // Approve and dispatch via real SendCoordinator
      const draft = store.saveDraft(textEvent!.id, '您好，下单后24小时内发货。', 'test-model');
      const handle = await connector.adapter(textEvent!.payload, store);
      try {
        const snap = await handle.adapter.inspect(textEvent!.payload);
        expect(snap).toMatchObject({
          accountId: store.accountId,
          ownId: TEST_OPEN_KFID,
          targetKey: targetKey(textEvent!.payload),
          eventBinding: textEvent!.binding,
        });
        store.approve(draft.id, snap, draft.version, draft.text);

        const coordinator = new SendCoordinator(store, connector.actor);
        const result = await coordinator.send(draft.id, handle.adapter, false);
        expect(result).toBe('CONFIRMED');
        expect(sendFetchCalls).toBe(1);
        expect(capturedSendBody).toMatchObject({
          touser: 'wm_customer_001',
          open_kfid: TEST_OPEN_KFID,
          msgtype: 'text',
          text: { content: '您好，下单后24小时内发货。' },
        });
        expect(typeof capturedSendBody?.msgid).toBe('string');
        expect(String(capturedSendBody?.msgid)).toMatch(/^[a-f0-9]{32}$/u);

        const receipt = store.receiptForEvent(textEvent!.id) as { result: string; proof_ref: string };
        expect(receipt.result).toBe('CONFIRMED');
        expect(receipt.proof_ref).toMatch(/^[a-f0-9]{64}$/u);
      } finally {
        await handle.dispose();
      }

      // Status, connector serialization, and SQLite audit rows must contain zero raw secrets
      const statusDump = JSON.stringify({
        status: connector.status(),
        transport: connector.transportStatus(),
        connector,
        audits: store.db.prepare('SELECT * FROM audit_events').all(),
        events: store.db.prepare('SELECT * FROM inbound_events').all(),
      });
      expect(statusDump).not.toContain(TEST_SECRET);
      expect(statusDump).not.toContain(TEST_TOKEN);
      expect(statusDump).not.toContain(TEST_AES_KEY);
      expect(connector.transportStatus()).toMatchObject({
        transport: 'official_api',
        state: 'CONNECTED',
        protocol: 'wechat_kf_http',
        errorCode: null,
      });

      await connector.close();
      expect(connector.transportStatus().state).toBe('DISCONNECTED');
    });
  });

  test('network timeout during send enters UNCERTAIN with exactly 1 fetch call (0 resend), then read-only verifyExisting reconciles after restart', async () => {
    await withTempStore(async ({ root, store }) => {
      const baseSec = Math.floor(Date.now() / 1000) - 20;
      let sendCalls = 0;
      let deliveredMsgId: string | undefined;
      let deliveredSec = Math.floor(Date.now() / 1000);

      const initialFetch = vi.fn<typeof fetch>(async (url, init) => {
        const target = String(url);
        if (target.includes('/gettoken')) {
          return jsonResponse({ errcode: 0, errmsg: 'ok', access_token: 'tok_uncertain', expires_in: 7200 });
        }
        if (target.includes('/kf/sync_msg')) {
          return jsonResponse({
            errcode: 0,
            errmsg: 'ok',
            next_cursor: 'cur_after_inbound',
            has_more: 0,
            msg_list: [{
              msgid: 'msg_in_timeout_1',
              open_kfid: TEST_OPEN_KFID,
              external_userid: 'wm_customer_timeout',
              send_time: baseSec,
              origin: 3,
              msgtype: 'text',
              text: { content: '在吗？' },
            }],
          });
        }
        if (target.includes('/kf/send_msg')) {
          sendCalls++;
          const body = JSON.parse(String(init?.body ?? '{}')) as { msgid?: string };
          // Simulate server actually received message, then response timed out on the wire!
          deliveredMsgId = body.msgid;
          deliveredSec = Math.floor(Date.now() / 1000) + 1;
          const err = new Error('request timed out');
          err.name = 'TimeoutError';
          throw err;
        }
        throw new Error(`Unexpected URL: ${target}`);
      });

      const connector1 = new WeChatKfPlatformConnector({
        root,
        openKfId: TEST_OPEN_KFID,
        credentials: { corpId: TEST_CORP_ID, appSecret: TEST_SECRET },
        fetchImpl: initialFetch,
      });

      const { newEventIds } = await connector1.observe(store, 'dm');
      expect(newEventIds).toHaveLength(1);
      const event = store.event(newEventIds[0]!);
      const replyText = '您好，我在的，请问有什么可以帮您？';
      const draft = store.saveDraft(event.id, replyText, 'test-model');

      const handle = await connector1.adapter(event.payload, store);
      try {
        store.approve(draft.id, await handle.adapter.inspect(event.payload), draft.version, draft.text);
        const coordinator = new SendCoordinator(store, connector1.actor);
        const outcome = await coordinator.send(draft.id, handle.adapter, false);
        expect(outcome).toBe('UNCERTAIN');
        expect(sendCalls).toBe(1);
        expect(store.receiptForEvent(event.id)).toMatchObject({
          result: 'UNCERTAIN',
          proof_ref: 'NO_UNIQUE_BOUND_PROOF',
        });
        expect(connector1.transportStatus().state).toBe('DEGRADED');
        expect(connector1.transportStatus().errorCode).toBe('WECHAT_KF_TIMEOUT');

        // Re-attempting send on the same draft must be rejected without calling fetch again
        await expect(coordinator.send(draft.id, handle.adapter, false)).rejects.toThrow();
        expect(sendCalls).toBe(1);
      } finally {
        await handle.dispose();
        await connector1.close();
      }

      // Simulate restart: brand-new connector instance verifies read-only via /kf/sync_msg origin=5
      const intentRow = store.db.prepare('SELECT id FROM send_intents WHERE event_id=?').get(event.id) as { id: string };
      expect(deliveredMsgId).toBe(deriveWeChatKfMsgId(intentRow.id));

      let restartSendCalls = 0;
      let restartSyncCalls = 0;
      const restartCursorStore = new MemoryWeChatKfCursorStore();
      restartCursorStore.save(store.accountId, TEST_OPEN_KFID, 'cur_before_verify');

      const restartFetch = vi.fn<typeof fetch>(async url => {
        const target = String(url);
        if (target.includes('/gettoken')) {
          return jsonResponse({ errcode: 0, errmsg: 'ok', access_token: 'tok_restart', expires_in: 7200 });
        }
        if (target.includes('/kf/send_msg')) {
          restartSendCalls++;
          throw new Error('verifyExisting must NEVER call send_msg');
        }
        if (target.includes('/kf/sync_msg')) {
          restartSyncCalls++;
          return jsonResponse({
            errcode: 0,
            errmsg: 'ok',
            next_cursor: 'cur_should_not_overwrite',
            has_more: 0,
            msg_list: [{
              msgid: deliveredMsgId!,
              open_kfid: TEST_OPEN_KFID,
              external_userid: 'wm_customer_timeout',
              send_time: deliveredSec,
              origin: 5,
              msgtype: 'text',
              text: { content: replyText },
            }],
          });
        }
        throw new Error(`Unexpected URL: ${target}`);
      });

      const connector2 = new WeChatKfPlatformConnector({
        root,
        openKfId: TEST_OPEN_KFID,
        credentials: { corpId: TEST_CORP_ID, appSecret: TEST_SECRET },
        fetchImpl: restartFetch,
        cursorStore: restartCursorStore,
      });

      const verified = await connector2.verifyExisting(store, event.id);
      expect(verified.verified).toBe(true);
      expect(verified.nativeIdDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(restartSendCalls).toBe(0);
      expect(restartSyncCalls).toBe(1);
      // Read-only verifyExisting must NOT advance the observe cursor
      expect(await connector2.currentCursor()).toBe('cur_before_verify');

      await connector2.close();
    });
  });

  test('webhook POST triggers idempotent incremental observe with callback Token', async () => {
    await withTempStore(async ({ root, store }) => {
      const nowSec = Math.floor(Date.now() / 1000) - 5;
      const syncTokens: (string | undefined)[] = [];
      const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
        const target = String(url);
        if (target.includes('/gettoken')) {
          return jsonResponse({ errcode: 0, errmsg: 'ok', access_token: 'tok_wh', expires_in: 7200 });
        }
        const body = JSON.parse(String(init?.body ?? '{}')) as { token?: string };
        syncTokens.push(body.token);
        return jsonResponse({
          errcode: 0,
          errmsg: 'ok',
          next_cursor: 'cur_wh_1',
          has_more: 0,
          msg_list: [{
            msgid: 'msg_from_webhook_1',
            open_kfid: TEST_OPEN_KFID,
            external_userid: 'wm_wh_user',
            send_time: nowSec,
            origin: 3,
            msgtype: 'text',
            text: { content: 'Webhook 通知触发的消息' },
          }],
        });
      });

      const connector = new WeChatKfPlatformConnector({
        root,
        openKfId: TEST_OPEN_KFID,
        credentials: {
          corpId: TEST_CORP_ID,
          appSecret: TEST_SECRET,
          token: TEST_TOKEN,
          encodingAESKey: TEST_AES_KEY,
        },
        fetchImpl,
      });

      const innerXml = `<xml>
        <ToUserName><![CDATA[${TEST_CORP_ID}]]></ToUserName>
        <CreateTime>${nowSec}</CreateTime>
        <MsgType><![CDATA[event]]></MsgType>
        <Event><![CDATA[kf_msg_or_event]]></Event>
        <Token><![CDATA[WH_TOKEN_ONCE]]></Token>
        <OpenKfId><![CDATA[${TEST_OPEN_KFID}]]></OpenKfId>
      </xml>`;
      const encrypted = encrypt(TEST_AES_KEY, innerXml, TEST_CORP_ID);
      const outerXml = `<xml><ToUserName><![CDATA[${TEST_CORP_ID}]]></ToUserName><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`;
      const sig = computeSignature(TEST_TOKEN, String(nowSec), 'nonce_wh', encrypted);
      const query = { msg_signature: sig, timestamp: String(nowSec), nonce: 'nonce_wh' };

      const first = await connector.handleWebhookEvent(query, outerXml, store);
      expect(first.synced).toBe(true);
      expect(first.duplicate).toBe(false);
      expect(syncTokens).toEqual(['WH_TOKEN_ONCE']);
      expect(store.events()).toHaveLength(1);

      // Replaying the same webhook token is deduplicated without hitting sync_msg again
      const second = await connector.handleWebhookEvent(query, outerXml, store);
      expect(second.duplicate).toBe(true);
      expect(second.synced).toBe(false);
      expect(syncTokens).toEqual(['WH_TOKEN_ONCE']);

      await connector.close();
    });
  });

  test('does not advance cursor if a later sync page fails, handles 95026 deterministically, and rejects ambiguous verifyExisting', async () => {
    await withTempStore(async ({ root, store }) => {
      const nowSec = Math.floor(Date.now() / 1000) - 5;
      let syncAttempt = 0;
      let sendCalls = 0;
      let verifyMode: 'none' | 'ambiguous' | 'clock-skew' = 'none';

      const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
        const target = String(url);
        if (target.includes('/gettoken')) {
          return jsonResponse({ errcode: 0, errmsg: 'ok', access_token: 'tok_edge', expires_in: 7200 });
        }
        if (target.includes('/kf/send_msg')) {
          sendCalls++;
          return jsonResponse({ errcode: 95026, errmsg: 'reach 48h/5msg limit' });
        }
        if (target.includes('/kf/sync_msg')) {
          const body = JSON.parse(String(init?.body ?? '{}')) as { cursor?: string };
          if (verifyMode === 'none') {
            syncAttempt++;
            if (syncAttempt === 1) {
              return jsonResponse({
                errcode: 0, errmsg: 'ok', next_cursor: 'cur_p1', has_more: 1,
                msg_list: [{
                  msgid: 'msg_p1', open_kfid: TEST_OPEN_KFID, external_userid: 'wm_edge',
                  send_time: nowSec, origin: 3, msgtype: 'text', text: { content: '第一页' },
                }],
              });
            }
            if (syncAttempt === 2) {
              return new Response('upstream error', { status: 503 });
            }
            // Retry observe from scratch succeeds cleanly
            return jsonResponse({
              errcode: 0, errmsg: 'ok', next_cursor: 'cur_ok', has_more: 0,
              msg_list: [{
                msgid: 'msg_p1', open_kfid: TEST_OPEN_KFID, external_userid: 'wm_edge',
                send_time: nowSec, origin: 3, msgtype: 'text', text: { content: '第一页' },
              }],
            });
          }
          if (verifyMode === 'ambiguous') {
            const sec = Math.floor(Date.now() / 1000) + 1;
            return jsonResponse({
              errcode: 0, errmsg: 'ok', has_more: 0, next_cursor: body.cursor ?? 'cur_amb',
              msg_list: [
                { msgid: 'other_1', open_kfid: TEST_OPEN_KFID, external_userid: 'wm_edge', send_time: sec, origin: 5, msgtype: 'text', text: { content: '窗口受限回复' } },
                { msgid: 'other_2', open_kfid: TEST_OPEN_KFID, external_userid: 'wm_edge', send_time: sec, origin: 5, msgtype: 'text', text: { content: '窗口受限回复' } },
              ],
            });
          }
          // Second-precision send_time truncated slightly before millisecond intent boundary
          const truncatedSec = Math.floor(Date.now() / 1000);
          return jsonResponse({
            errcode: 0, errmsg: 'ok', has_more: 0, next_cursor: 'cur_skew',
            msg_list: [
              { msgid: 'kf_skew_exact', open_kfid: TEST_OPEN_KFID, external_userid: 'wm_edge', send_time: truncatedSec, origin: 5, msgtype: 'text', text: { content: '窗口受限回复' } },
            ],
          });
        }
        throw new Error(`Unexpected URL: ${target}`);
      });

      const cursorStore = new MemoryWeChatKfCursorStore();
      const connector = new WeChatKfPlatformConnector({
        root,
        openKfId: TEST_OPEN_KFID,
        credentials: { corpId: TEST_CORP_ID, appSecret: TEST_SECRET },
        fetchImpl,
        cursorStore,
      });

      // Multi-page failure must NOT persist intermediate cursor
      await expect(connector.observe(store, 'dm')).rejects.toThrow('WECHAT_KF_HTTP_ERROR');
      expect(await connector.currentCursor()).toBeNull();
      expect(store.events()).toHaveLength(0);

      // Next observe succeeds and persists cursor
      const { newEventIds } = await connector.observe(store, 'dm');
      expect(newEventIds).toHaveLength(1);
      expect(await connector.currentCursor()).toBe('cur_ok');

      const event = store.event(newEventIds[0]!);
      const draft = store.saveDraft(event.id, '窗口受限回复', 'test-model');
      const handle = await connector.adapter(event.payload, store);
      try {
        store.approve(draft.id, await handle.adapter.inspect(event.payload), draft.version, draft.text);
        const coordinator = new SendCoordinator(store, connector.actor);
        expect(await coordinator.send(draft.id, handle.adapter, false)).toBe('UNCERTAIN');
        expect(sendCalls).toBe(1);
        expect(connector.transportStatus().errorCode).toBe('WECHAT_KF_SESSION_WINDOW_LIMIT');
      } finally {
        await handle.dispose();
      }

      // Ambiguous origin=5 matches must not verify
      verifyMode = 'ambiguous';
      const amb = await connector.verifyExisting(store, event.id);
      expect(amb.verified).toBe(false);
      expect(sendCalls).toBe(1);

      // Unique second-precision truncated match within tolerance verifies cleanly
      verifyMode = 'clock-skew';
      const skewed = await connector.verifyExisting(store, event.id);
      expect(skewed.verified).toBe(true);
      expect(sendCalls).toBe(1);

      await connector.close();
    });
  });
});
