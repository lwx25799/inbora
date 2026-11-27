import { createCipheriv, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { inspect } from 'node:util';
import { describe, expect, test, vi } from 'vitest';
import { Blocked } from '../../src/core/contracts.js';
import { officialApiEndpointDigest } from '../../src/platform/official-api-base.js';
import {
  WECHAT_KF_DEFAULT_API_BASE,
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
  endpointDigest,
  executeSafeWeChatKfJsonRequest,
  handleWebhookVerify,
  parseFlatWeChatXml,
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
    expect(() => deriveAesKey(`${'A'.repeat(42)}B`)).toThrow('WECHAT_KF_INVALID_AES_KEY');
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
    expect(decrypt(TEST_AES_KEY, encrypted, TEST_CORP_ID)).toEqual({ message, receiverId: TEST_CORP_ID });
    expect(() => decrypt(TEST_AES_KEY, encrypted, 'ww_wrong_corp')).toThrow('WECHAT_KF_RECEIVER_ID_MISMATCH');
  });

  test('decrypt and pkcs7Unpad reject non-32B multiples (16B/48B), tampered ciphertext, bad padding, and bad msg_len', () => {
    // Non-32-byte multiples (16B and 48B) must be rejected in both pkcs7Unpad and decrypt (#43-12)
    expect(() => pkcs7Unpad(Buffer.alloc(16, 0x01))).toThrow('WECHAT_KF_INVALID_PADDING');
    expect(() => pkcs7Unpad(Buffer.alloc(48, 0x01))).toThrow('WECHAT_KF_INVALID_PADDING');
    expect(() => decrypt(TEST_AES_KEY, Buffer.alloc(16, 0x11).toString('base64'))).toThrow('WECHAT_KF_INVALID_CIPHERTEXT');
    expect(() => decrypt(TEST_AES_KEY, Buffer.alloc(48, 0x11).toString('base64'))).toThrow('WECHAT_KF_INVALID_CIPHERTEXT');

    const encrypted = encrypt(TEST_AES_KEY, 'hello', TEST_CORP_ID);
    const tamperedBytes = Buffer.from(encrypted, 'base64');
    tamperedBytes[tamperedBytes.length - 1] = tamperedBytes[tamperedBytes.length - 1]! ^ 0xff;
    expect(() => decrypt(TEST_AES_KEY, tamperedBytes.toString('base64'), TEST_CORP_ID)).toThrow();

    const validPadded = pkcs7Pad(Buffer.alloc(28, 0x41));
    expect(pkcs7Unpad(validPadded).length).toBe(28);
    const badPad = Buffer.from(validPadded);
    badPad[badPad.length - 2] = 0x01;
    expect(() => pkcs7Unpad(badPad)).toThrow('WECHAT_KF_INVALID_PADDING');
    expect(() => pkcs7Unpad(Buffer.alloc(32, 0x00))).toThrow('WECHAT_KF_INVALID_PADDING');
    expect(() => pkcs7Unpad(Buffer.alloc(32, 33))).toThrow('WECHAT_KF_INVALID_PADDING');

    const aesKey = deriveAesKey(TEST_AES_KEY);
    const iv = aesKey.subarray(0, 16);
    const badContent = Buffer.concat([randomBytes(16), Buffer.from([0x00, 0x01, 0x00, 0x00]), Buffer.from('tiny')]);
    const cipher = createCipheriv('aes-256-cbc', aesKey, iv);
    cipher.setAutoPadding(false);
    const badCipher = Buffer.concat([cipher.update(pkcs7Pad(badContent)), cipher.final()]).toString('base64');
    expect(() => decrypt(TEST_AES_KEY, badCipher)).toThrow('WECHAT_KF_INVALID_PAYLOAD');
  });
});

describe('wechat-kf token cache (singleflight, private inspect redaction, DNS timeout)', () => {
  test('redacts appSecret from cache keys, coalesces concurrent requests, pre-refreshes, and hides tokens from util.inspect', async () => {
    const key = buildTokenCacheKey(TEST_CORP_ID, TEST_SECRET);
    expect(key).not.toContain(TEST_SECRET);
    expect(key.startsWith(`${TEST_CORP_ID}:`)).toBe(true);
    expect(endpointDigest(WECHAT_KF_DEFAULT_API_BASE)).toBe(
      officialApiEndpointDigest(WECHAT_KF_DEFAULT_API_BASE, { allowedProtocols: ['https:'] }),
    );
    expect(endpointDigest(WECHAT_KF_DEFAULT_API_BASE)).toMatch(/^[a-f0-9]{64}$/u);

    let nowMs = 1_700_000_000_000;
    let calls = 0;
    let releaseFirst!: () => void;
    const gate = new Promise<void>(resolve => { releaseFirst = resolve; });

    const fetchImpl = vi.fn<typeof fetch>(async url => {
      calls++;
      expect(String(url)).toMatch(/^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/gettoken\?/u);
      if (calls === 1) await gate;
      return jsonResponse({ errcode: 0, errmsg: 'ok', access_token: `secret_access_tok_${calls}`, expires_in: 7200 });
    });

    const manager = new WeChatKfTokenManager();
    const p1 = manager.getAccessToken(TEST_CORP_ID, TEST_SECRET, { fetchImpl, now: () => nowMs });
    const p2 = manager.getAccessToken(TEST_CORP_ID, TEST_SECRET, { fetchImpl, now: () => nowMs });
    const p3 = manager.getAccessToken(TEST_CORP_ID, TEST_SECRET, { fetchImpl, now: () => nowMs });
    releaseFirst();

    expect(await Promise.all([p1, p2, p3])).toEqual(['secret_access_tok_1', 'secret_access_tok_1', 'secret_access_tok_1']);
    expect(calls).toBe(1);
    expect(manager.cachedKeys().every(k => !k.includes(TEST_SECRET))).toBe(true);

    // util.inspect must NEVER print plaintext access_token or appSecret (#43-8)
    const inspected = inspect(manager, { depth: null, showHidden: true });
    expect(inspected).not.toContain('secret_access_tok_1');
    expect(inspected).not.toContain(TEST_SECRET);

    nowMs += 7200 * 1000 - 5 * 60 * 1000 - 1;
    expect(await manager.getAccessToken(TEST_CORP_ID, TEST_SECRET, { fetchImpl, now: () => nowMs })).toBe('secret_access_tok_1');
    expect(calls).toBe(1);

    nowMs += 1;
    expect(await manager.getAccessToken(TEST_CORP_ID, TEST_SECRET, { fetchImpl, now: () => nowMs })).toBe('secret_access_tok_2');
    expect(calls).toBe(2);

    manager.clearAccessToken(TEST_CORP_ID, TEST_SECRET);
    expect(await manager.getAccessToken(TEST_CORP_ID, TEST_SECRET, { fetchImpl, now: () => nowMs })).toBe('secret_access_tok_3');
    expect(calls).toBe(3);
  });

  test('first caller abort does not delete shared inFlight and clearAll prevents stale token repopulation (#43-7)', async () => {
    let calls = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });

    const fetchImpl = vi.fn<typeof fetch>(async () => {
      calls++;
      const seq = calls;
      if (seq === 1) await firstGate;
      return jsonResponse({ errcode: 0, errmsg: 'ok', access_token: `tok_race_${seq}`, expires_in: 7200 });
    });

    const manager = new WeChatKfTokenManager();
    const ac1 = new AbortController();
    const p1 = manager.getAccessToken(TEST_CORP_ID, TEST_SECRET, { fetchImpl, signal: ac1.signal });
    const p2 = manager.getAccessToken(TEST_CORP_ID, TEST_SECRET, { fetchImpl });

    // First caller aborts: shared inFlight must remain active for second and third callers
    ac1.abort();
    await expect(p1).rejects.toThrow('WECHAT_KF_TIMEOUT');
    const p3 = manager.getAccessToken(TEST_CORP_ID, TEST_SECRET, { fetchImpl });
    expect(calls).toBe(1);

    // clearAll invalidates global generation while request 1 is still in flight
    manager.clearAll();
    releaseFirst();

    await expect(p2).rejects.toThrow('WECHAT_KF_TOKEN_EXPIRED');
    await expect(p3).rejects.toThrow('WECHAT_KF_TOKEN_EXPIRED');
    expect(manager.cachedKeyCount()).toBe(0);

    // Next call fetches a brand-new token cleanly
    expect(await manager.getAccessToken(TEST_CORP_ID, TEST_SECRET, { fetchImpl })).toBe('tok_race_2');
    expect(calls).toBe(2);
  });

  test('enforces signal timeout during DNS lookup and rejects body already aborted on done (#43-9)', async () => {
    const hangingLookup = () => new Promise<never>(() => {});
    await expect(executeSafeWeChatKfJsonRequest({
      url: 'https://qyapi.weixin.qq.com/cgi-bin/gettoken',
      method: 'GET',
      maxResponseBytes: 4096,
      timeoutMs: 40,
      lookup: hangingLookup,
      fetchImpl: vi.fn(),
    })).rejects.toThrow('WECHAT_KF_TIMEOUT');

    // Aborted right before stream yields done=true must not succeed
    const ac = new AbortController();
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('{"errcode":0}'));
        ac.abort();
        controller.close();
      },
    }), { status: 200 });
    await expect(executeSafeWeChatKfJsonRequest({
      url: 'https://qyapi.weixin.qq.com/cgi-bin/kf/sync_msg',
      method: 'POST',
      body: '{}',
      maxResponseBytes: 4096,
      timeoutMs: 5000,
      signal: ac.signal,
      fetchImpl: async () => response,
    })).rejects.toThrow('WECHAT_KF_TIMEOUT');
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

describe('wechat-kf webhook (linear XML parser, ReDoS defense, abortable body, singleflight dedupe, SSRF)', () => {
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

  test('linear XML scanner rejects 64KB ReDoS whitespace/unclosed input in <100ms and blocks XML injection (#43-1)', () => {
    const creds = { corpId: TEST_CORP_ID, token: TEST_TOKEN, encodingAESKey: TEST_AES_KEY };
    const query = { msg_signature: 'a'.repeat(40), timestamp: '1700000100', nonce: 'n2' };

    const evilWhitespace = `<xml><Encrypt>${' '.repeat(WECHAT_KF_WEBHOOK_MAX_BODY_BYTES - 20)}`;
    const start = performance.now();
    expect(() => parseWebhookEvent(query, evilWhitespace, creds)).toThrow('WECHAT_KF_INVALID_WEBHOOK_XML');
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(100);

    const badXmlCases = [
      '<!DOCTYPE foo><xml><Encrypt>abc</Encrypt></xml>',
      '<xml><!-- comment --><Encrypt>abc</Encrypt></xml>',
      '<xml attr="1"><Encrypt>abc</Encrypt></xml>',
      '<xml><Encrypt id="1">abc</Encrypt></xml>',
      '<xml><Encrypt>a</Encrypt><Encrypt>b</Encrypt></xml>',
      '<xml><Encrypt>&#65;</Encrypt></xml>',
      '<xml><Encrypt>&unknown;</Encrypt></xml>',
      '<xml><Encrypt>abc</Encrypt></xml>trailing',
    ];
    for (const bad of badXmlCases) {
      expect(() => parseFlatWeChatXml(bad)).toThrow('WECHAT_KF_INVALID_WEBHOOK_XML');
    }
  });

  test('enforces 64KB cap, aborts hanging body streams, and merges concurrent same-Token deliveries (#43-4, #43-10)', async () => {
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

    expect(parseWebhookEvent(query, outerXml, creds)).toEqual({
      event: 'kf_msg_or_event',
      token: 'ENC_SYNC_TOKEN_01',
      openKfId: 'wk_open_kf_001',
      createTime: 1700000100,
      toUserName: TEST_CORP_ID,
    });

    const hugeStream = Readable.from([Buffer.alloc(WECHAT_KF_WEBHOOK_MAX_BODY_BYTES + 1, 0x41)]);
    await expect(readBoundedWebhookBody(hugeStream)).rejects.toThrow('WECHAT_KF_BODY_TOO_LARGE');

    // Hanging stream respects AbortSignal immediately (#43-4)
    const ac = new AbortController();
    const hangingStream: AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise(() => {}),
        return: async () => ({ value: undefined, done: true }),
      }),
    };
    const readPromise = readBoundedWebhookBody(hangingStream, WECHAT_KF_WEBHOOK_MAX_BODY_BYTES, ac.signal);
    ac.abort();
    await expect(readPromise).rejects.toThrow('WECHAT_KF_TIMEOUT');

    // Concurrent same-Token requests wait for the first handler to finish before returning duplicate (#43-10)
    let onEventCalls = 0;
    let releaseFirst!: () => void;
    let secondSettledEarly = false;
    const syncGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const processor = new WeChatKfWebhookProcessor({
      credentials: creds,
      expectedOpenKfId: 'wk_open_kf_001',
    });

    const first = processor.handlePost(query, outerXml, {
      onEvent: async () => { onEventCalls++; await syncGate; },
    });
    const second = processor.handlePost(query, outerXml, {
      onEvent: async () => { onEventCalls++; },
    }).then(res => { secondSettledEarly = true; return res; });

    await new Promise(r => setTimeout(r, 15));
    expect(secondSettledEarly).toBe(false);
    releaseFirst();

    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toMatchObject({ accepted: true, duplicate: false, synced: true, truncated: false });
    expect(r2).toMatchObject({ accepted: true, duplicate: true, synced: false, truncated: false });
    expect(onEventCalls).toBe(1);

    // Concurrent same-Token propagates failure to waiter when first attempt fails (#43-10)
    const innerXml2 = innerXml.replace('ENC_SYNC_TOKEN_01', 'ENC_SYNC_TOKEN_FAIL');
    const enc2 = encrypt(TEST_AES_KEY, innerXml2, TEST_CORP_ID);
    const outer2 = `<xml><Encrypt><![CDATA[${enc2}]]></Encrypt></xml>`;
    const q2 = { msg_signature: computeSignature(TEST_TOKEN, '1700000101', 'n3', enc2), timestamp: '1700000101', nonce: 'n3' };
    let failGate!: () => void;
    const gate2 = new Promise<void>(resolve => { failGate = resolve; });
    const f1 = processor.handlePost(q2, outer2, { onEvent: async () => { await gate2; throw new Blocked('SYNC_FAILED'); } });
    const f2 = processor.handlePost(q2, outer2, { onEvent: async () => {} });
    failGate();
    await expect(f1).rejects.toThrow('SYNC_FAILED');
    await expect(f2).rejects.toThrow('SYNC_FAILED');
  });

  test('validates public HTTPS callback and API endpoints while blocking SSRF, backslashes, and credentials', async () => {
    expect(assertSafeWebhookCallbackUrl('https://relay.example.com/wechat-kf/callback').hostname).toBe('relay.example.com');
    expect(assertSafeWeChatKfApiBase(WECHAT_KF_DEFAULT_API_BASE)).toBe(WECHAT_KF_DEFAULT_API_BASE);

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
      'https://relay.example.com\\..\\secret',
    ];
    for (const url of badUrls) {
      expect(() => assertSafeWebhookCallbackUrl(url)).toThrow('WECHAT_KF_INVALID_CALLBACK_URL');
      expect(() => assertSafeWeChatKfApiBase(url)).toThrow();
    }

    await expect(validateWebhookCallbackUrl('https://rebind.example.com/cb', {
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    })).rejects.toThrow('WECHAT_KF_INVALID_CALLBACK_URL');

    await expect(validateWebhookCallbackUrl('https://public.example.com/cb', {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    })).resolves.toBeInstanceOf(URL);
  });
});

describe('wechat-kf api client (sync_msg retry, send_msg 2048B/95026/msgid/beforeSend/0-retry)', () => {
  test('syncMessages retries at most once when token expires (40014/42001/40001)', async () => {
    let tokenSeq = 0;
    let syncSeq = 0;
    const fetchImpl = vi.fn<typeof fetch>(async url => {
      if (String(url).includes('/gettoken')) {
        tokenSeq++;
        return jsonResponse({ errcode: 0, errmsg: 'ok', access_token: `t_${tokenSeq}`, expires_in: 7200 });
      }
      syncSeq++;
      if (syncSeq === 1) return jsonResponse({ errcode: 42001, errmsg: 'access_token expired' });
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
    expect(inspect(client, { depth: null, showHidden: true })).not.toContain('t_2');
    expect(inspect(client, { depth: null, showHidden: true })).not.toContain(TEST_SECRET);
  });

  test('sendTextMessage enforces UTF-8 <= 2048B, exact msgid echo match (#43-2), and pre-write beforeSend guard (#43-3)', async () => {
    let sendCalls = 0;
    let returnMsgId = 'expected0123456789abcdef01234567';
    const fetchImpl = vi.fn<typeof fetch>(async url => {
      if (String(url).includes('/gettoken')) {
        return jsonResponse({ errcode: 0, errmsg: 'ok', access_token: 'tok_ok', expires_in: 7200 });
      }
      sendCalls++;
      return jsonResponse({ errcode: 0, errmsg: 'ok', msgid: returnMsgId });
    });

    const client = new WeChatKfApiClient({
      credentials: { corpId: TEST_CORP_ID, appSecret: TEST_SECRET },
      fetchImpl,
    });

    const tooLongZh = '汉'.repeat(683);
    expect(Buffer.byteLength(tooLongZh, 'utf8')).toBe(WECHAT_KF_MAX_TEXT_BYTES + 1);
    await expect(client.sendTextMessage({ touser: 'wm_1', openKfid: 'wk_1', content: tooLongZh }))
      .rejects.toThrow('WECHAT_KF_TEXT_TOO_LONG');
    expect(fetchImpl).not.toHaveBeenCalled();

    // beforeSend throws after token/DNS -> /kf/send_msg is never sent
    await expect(client.sendTextMessage(
      { touser: 'wm_1', openKfid: 'wk_1', content: 'hi', msgid: returnMsgId },
      { beforeSend: () => { throw new Blocked('EMERGENCY_STOPPED'); } },
    )).rejects.toThrow('EMERGENCY_STOPPED');
    expect(sendCalls).toBe(0);

    // Mismatched response msgid rejected with zero retries
    returnMsgId = 'different_msgid_from_server_9999';
    await expect(client.sendTextMessage({
      touser: 'wm_1', openKfid: 'wk_1', content: 'hi', msgid: 'expected0123456789abcdef01234567',
    })).rejects.toThrow('WECHAT_KF_RESPONSE_INVALID');
    expect(sendCalls).toBe(1);

    // Exact msgid echo succeeds
    returnMsgId = 'expected0123456789abcdef01234567';
    const ok = await client.sendTextMessage({
      touser: 'wm_1', openKfid: 'wk_1', content: 'a'.repeat(WECHAT_KF_MAX_TEXT_BYTES), msgid: returnMsgId,
    });
    expect(ok.msgid).toBe(returnMsgId);
    expect(sendCalls).toBe(2);
  });

  test('sendTextMessage maps errcode 95026 and NEVER retries on timeout, 5xx, or redirect', async () => {
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
