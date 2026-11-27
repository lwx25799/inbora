import { createCipheriv, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import {
  WECHAT_KF_MAX_TEXT_BYTES,
  WECHAT_KF_WEBHOOK_MAX_BODY_BYTES,
  WeChatKfApiClient,
  WeChatKfError,
  WeChatKfTokenManager,
  WeChatKfWebhookProcessor,
  assertSafeWeChatKfApiBase,
  assertSafeWebhookCallbackUrl,
  buildTokenCacheKey,
  computeSignature,
  decrypt,
  deriveAesKey,
  encrypt,
  handleWebhookVerify,
  parseWebhookEvent,
  pkcs7Pad,
  pkcs7Unpad,
  readBoundedWebhookBody,
  validateWebhookCallbackUrl,
  verifySignature,
} from '../../src/platform/wechat-kf/index.js';

const TEST_AES_KEY = Buffer.alloc(32, 0x5a).toString('base64').slice(0, 43);
const TEST_CORP_ID = 'ww_test_corp_001';
const TEST_TOKEN = 'synthetic_callback_token_01';
const TEST_SECRET = 'synthetic_app_secret_do_not_expose_999';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('wechat-kf crypto (WXBizMsgCrypt)', () => {
  test('deriveAesKey enforces exact 43-char canonical Base64 decoding to 32 bytes', () => {
    const key = deriveAesKey(TEST_AES_KEY);
    expect(key.length).toBe(32);
    expect(key.equals(Buffer.alloc(32, 0x5a))).toBe(true);

    expect(() => deriveAesKey(TEST_AES_KEY.slice(0, 42))).toThrow('WECHAT_KF_INVALID_AES_KEY');
    expect(() => deriveAesKey(`${TEST_AES_KEY}=`)).toThrow('WECHAT_KF_INVALID_AES_KEY');
    expect(() => deriveAesKey(`${TEST_AES_KEY.slice(0, 42)}-`)).toThrow('WECHAT_KF_INVALID_AES_KEY');
    // Non-canonical trailing bits in 43rd char ('B' has bit 0 set where 32B encoding requires 00)
    const nonCanonical = `${'A'.repeat(42)}B`;
    expect(() => deriveAesKey(nonCanonical)).toThrow('WECHAT_KF_INVALID_AES_KEY');
  });

  test('computeSignature and verifySignature use constant-time SHA1 comparison and reject tampering', () => {
    const sig = computeSignature(TEST_TOKEN, '1700000000', 'nonce_abc', 'encrypted_payload');
    expect(sig).toMatch(/^[0-9a-f]{40}$/u);
    expect(verifySignature(TEST_TOKEN, '1700000000', 'nonce_abc', 'encrypted_payload', sig)).toBe(true);
    expect(verifySignature(TEST_TOKEN, '1700000000', 'nonce_abc', 'encrypted_payload', sig.toUpperCase())).toBe(true);
    expect(verifySignature(TEST_TOKEN, '1700000000', 'nonce_abc', 'tampered_payload', sig)).toBe(false);
    expect(verifySignature(TEST_TOKEN, '1700000000', 'nonce_abc', 'encrypted_payload', 'not-a-sha1')).toBe(false);
    expect(verifySignature('', '1700000000', 'nonce_abc', 'encrypted_payload', sig)).toBe(false);
  });

  test('encrypt/decrypt roundtrip preserves UTF-8 message and validates receiverId', () => {
    const message = '<xml><MsgType><![CDATA[event]]></MsgType><Content><![CDATA[你好微信客服]]></Content></xml>';
    const encrypted = encrypt(TEST_AES_KEY, message, TEST_CORP_ID);
    const decrypted = decrypt(TEST_AES_KEY, encrypted, TEST_CORP_ID);
    expect(decrypted).toEqual({ message, receiverId: TEST_CORP_ID });

    expect(() => decrypt(TEST_AES_KEY, encrypted, 'ww_wrong_corp')).toThrow('WECHAT_KF_RECEIVER_ID_MISMATCH');
  });

  test('decrypt rejects tampered ciphertext, invalid PKCS#7 padding, and out-of-bounds msg_len', () => {
    const encrypted = encrypt(TEST_AES_KEY, 'hello', TEST_CORP_ID);
    const tamperedBytes = Buffer.from(encrypted, 'base64');
    tamperedBytes[tamperedBytes.length - 1] = (tamperedBytes[tamperedBytes.length - 1]! ^ 0xff);
    expect(() => decrypt(TEST_AES_KEY, tamperedBytes.toString('base64'), TEST_CORP_ID)).toThrow();

    // PKCS#7 full-byte validation: pad byte = 4, but second-to-last byte corrupted.
    const validPadded = pkcs7Pad(Buffer.alloc(28, 0x41));
    expect(pkcs7Unpad(validPadded).length).toBe(28);
    const badPad = Buffer.from(validPadded);
    badPad[badPad.length - 2] = 0x01;
    expect(() => pkcs7Unpad(badPad)).toThrow('WECHAT_KF_INVALID_PADDING');

    // Pad byte = 0 or > 32 rejected
    const zeroPad = Buffer.alloc(32, 0x00);
    expect(() => pkcs7Unpad(zeroPad)).toThrow('WECHAT_KF_INVALID_PADDING');
    const overPad = Buffer.alloc(32, 33);
    expect(() => pkcs7Unpad(overPad)).toThrow('WECHAT_KF_INVALID_PADDING');

    // Forged msg_len larger than remaining content length
    const aesKey = deriveAesKey(TEST_AES_KEY);
    const iv = aesKey.subarray(0, 16);
    const badContent = Buffer.concat([randomBytes(16), Buffer.from([0x00, 0x01, 0x00, 0x00]), Buffer.from('tiny')]);
    const cipher = createCipheriv('aes-256-cbc', aesKey, iv);
    cipher.setAutoPadding(false);
    const badCipher = Buffer.concat([cipher.update(pkcs7Pad(badContent)), cipher.final()]).toString('base64');
    expect(() => decrypt(TEST_AES_KEY, badCipher)).toThrow('WECHAT_KF_INVALID_PAYLOAD');
  });
});

describe('wechat-kf token cache (singleflight + redacted keys)', () => {
  test('redacts appSecret from cache keys, coalesces concurrent requests, and pre-refreshes 5 min early', async () => {
    const key = buildTokenCacheKey(TEST_CORP_ID, TEST_SECRET);
    expect(key).not.toContain(TEST_SECRET);
    expect(key.startsWith(`${TEST_CORP_ID}:`)).toBe(true);

    let nowMs = 1_700_000_000_000;
    let calls = 0;
    let releaseFirst!: () => void;
    const gate = new Promise<void>(resolve => { releaseFirst = resolve; });

    const fetchImpl = vi.fn<typeof fetch>(async url => {
      calls++;
      expect(String(url)).toMatch(/^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/gettoken\?/u);
      if (calls === 1) await gate;
      return jsonResponse({ errcode: 0, errmsg: 'ok', access_token: `tok_${calls}`, expires_in: 7200 });
    });

    const manager = new WeChatKfTokenManager();
    const p1 = manager.getAccessToken(TEST_CORP_ID, TEST_SECRET, { fetchImpl, now: () => nowMs });
    const p2 = manager.getAccessToken(TEST_CORP_ID, TEST_SECRET, { fetchImpl, now: () => nowMs });
    const p3 = manager.getAccessToken(TEST_CORP_ID, TEST_SECRET, { fetchImpl, now: () => nowMs });
    releaseFirst();

    expect(await Promise.all([p1, p2, p3])).toEqual(['tok_1', 'tok_1', 'tok_1']);
    expect(calls).toBe(1);
    expect(manager.cachedKeys().every(k => !k.includes(TEST_SECRET))).toBe(true);

    // Still valid before 5-minute refresh window
    nowMs += 7200 * 1000 - 5 * 60 * 1000 - 1;
    expect(await manager.getAccessToken(TEST_CORP_ID, TEST_SECRET, { fetchImpl, now: () => nowMs })).toBe('tok_1');
    expect(calls).toBe(1);

    // At 5-minute refresh boundary -> refreshes automatically
    nowMs += 1;
    expect(await manager.getAccessToken(TEST_CORP_ID, TEST_SECRET, { fetchImpl, now: () => nowMs })).toBe('tok_2');
    expect(calls).toBe(2);

    // Explicit clear forces fresh fetch
    manager.clearAccessToken(TEST_CORP_ID, TEST_SECRET);
    expect(await manager.getAccessToken(TEST_CORP_ID, TEST_SECRET, { fetchImpl, now: () => nowMs })).toBe('tok_3');
    expect(calls).toBe(3);
  });

  test('error messages never leak appSecret on token fetch failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ errcode: 40013, errmsg: 'invalid corpid' }));
    const manager = new WeChatKfTokenManager();
    let caught: unknown;
    try {
      await manager.getAccessToken(TEST_CORP_ID, TEST_SECRET, { fetchImpl });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WeChatKfError);
    expect((caught as WeChatKfError).code).toBe('WECHAT_KF_TOKEN_FETCH_FAILED');
    expect(String(caught)).not.toContain(TEST_SECRET);
  });
});

describe('wechat-kf webhook (GET verify, POST decrypt, 64KB cap, idempotency, callback URL SSRF)', () => {
  test('verifies GET echostr and rejects invalid signature or wrong corpId', () => {
    const encryptedEcho = encrypt(TEST_AES_KEY, 'echo_challenge_123', TEST_CORP_ID);
    const sig = computeSignature(TEST_TOKEN, '1700000001', 'n1', encryptedEcho);
    const plain = handleWebhookVerify(
      { msg_signature: sig, timestamp: '1700000001', nonce: 'n1', echostr: encryptedEcho },
      { corpId: TEST_CORP_ID, token: TEST_TOKEN, encodingAESKey: TEST_AES_KEY },
    );
    expect(plain).toBe('echo_challenge_123');

    expect(() => handleWebhookVerify(
      { msg_signature: '0'.repeat(40), timestamp: '1700000001', nonce: 'n1', echostr: encryptedEcho },
      { corpId: TEST_CORP_ID, token: TEST_TOKEN, encodingAESKey: TEST_AES_KEY },
    )).toThrow('WECHAT_KF_INVALID_SIGNATURE');

    expect(() => handleWebhookVerify(
      { msg_signature: sig, timestamp: '1700000001', nonce: 'n1', echostr: encryptedEcho },
      { corpId: 'ww_other_corp', token: TEST_TOKEN, encodingAESKey: TEST_AES_KEY },
    )).toThrow('WECHAT_KF_RECEIVER_ID_MISMATCH');
  });

  test('parses POST encrypted XML, enforces 64KB body cap, rejects XXE, and deduplicates by Token', async () => {
    const innerXml = `<xml>
      <ToUserName><![CDATA[${TEST_CORP_ID}]]></ToUserName>
      <CreateTime>1700000100</CreateTime>
      <MsgType><![CDATA[event]]></MsgType>
      <Event><![CDATA[kf_msg_or_event]]></Event>
      <Token><![CDATA[ENC_SYNC_TOKEN_01]]></Token>
      <OpenKfId><![CDATA[wk_open_kf_001]]></OpenKfId>
    </xml>`;
    const encrypted = encrypt(TEST_AES_KEY, innerXml, TEST_CORP_ID);
    const outerXml = `<xml><ToUserName><![CDATA[${TEST_CORP_ID}]]></ToUserName><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`;
    const sig = computeSignature(TEST_TOKEN, '1700000100', 'n2', encrypted);
    const query = { msg_signature: sig, timestamp: '1700000100', nonce: 'n2' };
    const creds = { corpId: TEST_CORP_ID, token: TEST_TOKEN, encodingAESKey: TEST_AES_KEY };

    const parsed = parseWebhookEvent(query, outerXml, creds);
    expect(parsed).toEqual({
      event: 'kf_msg_or_event',
      token: 'ENC_SYNC_TOKEN_01',
      openKfId: 'wk_open_kf_001',
      createTime: 1700000100,
      toUserName: TEST_CORP_ID,
    });

    // Oversized body > 64KB rejected in both stream reader and parser
    const hugeStream = Readable.from([Buffer.alloc(WECHAT_KF_WEBHOOK_MAX_BODY_BYTES + 1, 0x41)]);
    await expect(readBoundedWebhookBody(hugeStream)).rejects.toThrow('WECHAT_KF_BODY_TOO_LARGE');
    expect(() => parseWebhookEvent(query, 'a'.repeat(WECHAT_KF_WEBHOOK_MAX_BODY_BYTES + 1), creds))
      .toThrow('WECHAT_KF_BODY_TOO_LARGE');

    // XXE / DOCTYPE rejected
    expect(() => parseWebhookEvent(query, `<!DOCTYPE foo><xml><Encrypt>${encrypted}</Encrypt></xml>`, creds))
      .toThrow('WECHAT_KF_INVALID_WEBHOOK_XML');

    // Idempotent Token dedupe + concurrent reentrancy guard
    let onEventCalls = 0;
    let releaseSync!: () => void;
    const syncGate = new Promise<void>(resolve => { releaseSync = resolve; });
    const processor = new WeChatKfWebhookProcessor({
      credentials: creds,
      expectedOpenKfId: 'wk_open_kf_001',
      onEvent: async () => {
        onEventCalls++;
        await syncGate;
      },
    });
    const first = processor.handlePost(query, outerXml);
    const concurrentDup = await processor.handlePost(query, outerXml);
    expect(concurrentDup.duplicate).toBe(true);
    expect(concurrentDup.synced).toBe(false);
    releaseSync();
    const firstResult = await first;
    expect(firstResult.duplicate).toBe(false);
    expect(firstResult.synced).toBe(true);
    const replayDup = await processor.handlePost(query, outerXml);
    expect(replayDup.duplicate).toBe(true);
    expect(onEventCalls).toBe(1);
  });

  test('validates public HTTPS callback and API endpoints while blocking SSRF and credentials in URL', async () => {
    expect(assertSafeWebhookCallbackUrl('https://relay.example.com/wechat-kf/callback').hostname).toBe('relay.example.com');
    expect(assertSafeWeChatKfApiBase('https://qyapi.weixin.qq.com/cgi-bin')).toBe('https://qyapi.weixin.qq.com/cgi-bin');

    const badUrls = [
      'http://relay.example.com/cb',
      'https://user:pass@relay.example.com/cb',
      'https://localhost/cb',
      'https://sub.localhost/cb',
      'https://127.0.0.1/cb',
      'https://10.0.0.1/cb',
      'https://169.254.169.254/latest/meta-data',
      'https://192.168.1.5/cb',
      'https://[::1]/cb',
      'https://relay.example.com:8443/cb',
    ];
    for (const url of badUrls) {
      expect(() => assertSafeWebhookCallbackUrl(url)).toThrow('WECHAT_KF_INVALID_CALLBACK_URL');
      expect(() => assertSafeWeChatKfApiBase(url)).toThrow();
    }

    // DNS rebinding / private A-record check
    await expect(validateWebhookCallbackUrl('https://rebind.example.com/cb', {
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    })).rejects.toThrow('WECHAT_KF_INVALID_CALLBACK_URL');

    await expect(validateWebhookCallbackUrl('https://public.example.com/cb', {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    })).resolves.toBeInstanceOf(URL);
  });
});

describe('wechat-kf api client (sync_msg retry, send_msg 2048B & 95026 & zero-retry, redirect block)', () => {
  test('syncMessages retries at most once when token expires (40014/42001/40001)', async () => {
    let tokenSeq = 0;
    let syncSeq = 0;
    const fetchImpl = vi.fn<typeof fetch>(async url => {
      const target = String(url);
      if (target.includes('/gettoken')) {
        tokenSeq++;
        return jsonResponse({ errcode: 0, errmsg: 'ok', access_token: `t_${tokenSeq}`, expires_in: 7200 });
      }
      syncSeq++;
      if (syncSeq === 1) {
        return jsonResponse({ errcode: 42001, errmsg: 'access_token expired' });
      }
      return jsonResponse({ errcode: 0, errmsg: 'ok', next_cursor: 'cur_2', has_more: 0, msg_list: [] });
    });

    const client = new WeChatKfApiClient({
      credentials: { corpId: TEST_CORP_ID, appSecret: TEST_SECRET },
      fetchImpl,
    });
    const res = await client.syncMessages({ cursor: 'cur_1', open_kfid: 'wk_1' });
    expect(res.next_cursor).toBe('cur_2');
    expect(tokenSeq).toBe(2);
    expect(syncSeq).toBe(2);
  });

  test('sendTextMessage enforces UTF-8 <= 2048B precheck without splitting or calling fetch', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new WeChatKfApiClient({
      credentials: { corpId: TEST_CORP_ID, appSecret: TEST_SECRET },
      fetchImpl,
    });
    // 683 Chinese chars = 2049 UTF-8 bytes (> 2048)
    const tooLongZh = '汉'.repeat(683);
    expect(Buffer.byteLength(tooLongZh, 'utf8')).toBe(WECHAT_KF_MAX_TEXT_BYTES + 1);

    await expect(client.sendTextMessage({
      touser: 'wm_user_1',
      openKfid: 'wk_1',
      content: tooLongZh,
    })).rejects.toThrow('WECHAT_KF_TEXT_TOO_LONG');
    expect(fetchImpl).not.toHaveBeenCalled();

    // Exactly 2048 bytes succeeds
    const exact2048 = 'a'.repeat(WECHAT_KF_MAX_TEXT_BYTES);
    fetchImpl.mockImplementation(async url => {
      if (String(url).includes('/gettoken')) {
        return jsonResponse({ errcode: 0, errmsg: 'ok', access_token: 'tok_ok', expires_in: 7200 });
      }
      return jsonResponse({ errcode: 0, errmsg: 'ok', msgid: 'kf_msg_exact' });
    });
    const sent = await client.sendTextMessage({ touser: 'wm_user_1', openKfid: 'wk_1', content: exact2048 });
    expect(sent.msgid).toBe('kf_msg_exact');
  });

  test('sendTextMessage maps errcode 95026 to WECHAT_KF_SESSION_WINDOW_LIMIT and NEVER retries on timeout/5xx/redirect', async () => {
    let sendCalls = 0;
    let mode: '95026' | 'timeout' | '502' | 'redirect' = '95026';
    const fetchImpl = vi.fn<typeof fetch>(async url => {
      if (String(url).includes('/gettoken')) {
        return jsonResponse({ errcode: 0, errmsg: 'ok', access_token: 'tok_send', expires_in: 7200 });
      }
      sendCalls++;
      if (mode === '95026') return jsonResponse({ errcode: 95026, errmsg: 'reach 48h/5msg limit' });
      if (mode === 'timeout') {
        const err = new Error('timed out');
        err.name = 'TimeoutError';
        throw err;
      }
      if (mode === '502') return new Response('bad gateway', { status: 502 });
      return new Response(null, { status: 302, headers: { location: 'https://evil.example.com' } });
    });

    const client = new WeChatKfApiClient({
      credentials: { corpId: TEST_CORP_ID, appSecret: TEST_SECRET },
      fetchImpl,
    });

    await expect(client.sendTextMessage({ touser: 'wm_1', openKfid: 'wk_1', content: 'hi' }))
      .rejects.toMatchObject({ code: 'WECHAT_KF_SESSION_WINDOW_LIMIT', errcode: 95026 });
    expect(sendCalls).toBe(1);

    mode = 'timeout';
    await expect(client.sendTextMessage({ touser: 'wm_1', openKfid: 'wk_1', content: 'hi' }))
      .rejects.toMatchObject({ code: 'WECHAT_KF_TIMEOUT' });
    expect(sendCalls).toBe(2);

    mode = '502';
    await expect(client.sendTextMessage({ touser: 'wm_1', openKfid: 'wk_1', content: 'hi' }))
      .rejects.toMatchObject({ code: 'WECHAT_KF_HTTP_ERROR', httpStatus: 502 });
    expect(sendCalls).toBe(3);

    mode = 'redirect';
    await expect(client.sendTextMessage({ touser: 'wm_1', openKfid: 'wk_1', content: 'hi' }))
      .rejects.toMatchObject({ code: 'WECHAT_KF_REDIRECT_REJECTED', httpStatus: 302 });
    expect(sendCalls).toBe(4);
  });
});
