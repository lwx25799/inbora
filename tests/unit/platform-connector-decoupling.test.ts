import { inspect } from 'node:util';
import { describe, expect, test, vi } from 'vitest';
import { BrowserService } from '../../src/app/browser-service.js';
import {
  DEFAULT_ACCOUNT_ID,
  DOUYIN_PLATFORM_ID,
  MOCK_PLATFORM_ID,
  WECHAT_KF_PLATFORM_ID,
  WECOM_AIBOT_PLATFORM_ID,
  accountSummarySchema,
  platformIdSchema,
  platformTransportSchema,
  type AccountSummary,
  type PlatformTransport,
} from '../../src/contracts/account.js';
import { Blocked } from '../../src/core/contracts.js';
import { DouyinPlatformConnector, douyinCapabilities } from '../../src/platform/douyin-platform-connector.js';
import { MockPlatformConnector, mockCapabilities } from '../../src/platform/mock-platform-connector.js';
import {
  WECHAT_KF_DEFAULT_BASE_URL,
  WECHAT_KF_OFFICIAL_HOSTS,
  WECOM_AIBOT_DEFAULT_WS_URL,
  WECOM_AIBOT_OFFICIAL_HOSTS,
  buildOfficialApiChannelIdentity,
  createOfficialApiExecutor,
  createOfficialApiSecretHolder,
  createOfficialApiTransportStatus,
  credentialDigest,
  credentialKeyFragment,
  officialApiEndpointDigest,
  parseOfficialApiEndpoint,
  redactOfficialApiText,
  redactOfficialApiValue,
  validateOfficialApiEndpoint,
} from '../../src/platform/official-api-base.js';
import type {
  ConnectorCapabilityIdentity,
  ConnectorTransportStatus,
  CopilotWebviewTransportStatus,
  DesktopUiaTransportStatus,
  OfficialApiTransportStatus,
} from '../../src/platform/platform-connector.js';

const timestamp = '2026-11-27T06:00:00.000Z';

function baseSummary(): AccountSummary {
  return {
    id: DEFAULT_ACCOUNT_ID,
    accountRef: DEFAULT_ACCOUNT_ID,
    platform: DOUYIN_PLATFORM_ID,
    connector: DOUYIN_PLATFORM_ID,
    ownId: 'own-legacy-1',
    displayLabel: 'Legacy Account',
    status: 'ACTIVE',
    profileRef: 'profile-legacy',
    capabilities: {
      channels: ['COMMENT_NOTIFICATION', 'DIRECT_MESSAGE'],
      loginRecovery: true,
      manualSecurityRecovery: true,
      preview: true,
      readback: true,
    },
    autoReplyEnabled: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe('platform transport contracts & backward compatibility', () => {
  test('registers official API platform IDs and all four reserved transport kinds', () => {
    expect(WECOM_AIBOT_PLATFORM_ID).toBe('wecom-aibot');
    expect(WECHAT_KF_PLATFORM_ID).toBe('wechat-kf');
    expect(platformIdSchema.parse(WECOM_AIBOT_PLATFORM_ID)).toBe('wecom-aibot');
    expect(platformIdSchema.parse(WECHAT_KF_PLATFORM_ID)).toBe('wechat-kf');

    const transports: readonly PlatformTransport[] = ['browser', 'official_api', 'desktop_uia', 'copilot_webview'];
    for (const transport of transports) {
      expect(platformTransportSchema.parse(transport)).toBe(transport);
    }
    expect(platformTransportSchema.safeParse('private_protocol').success).toBe(false);
    expect(platformTransportSchema.safeParse('').success).toBe(false);
  });

  test('parses legacy schema4 AccountSummary without transport and accepts optional transport values', () => {
    const legacy = baseSummary();
    const parsedLegacy = accountSummarySchema.parse(legacy);
    expect(parsedLegacy).toEqual(legacy);
    expect('transport' in parsedLegacy.capabilities).toBe(false);

    for (const transport of ['browser', 'official_api', 'desktop_uia', 'copilot_webview'] as const) {
      const upgraded = {
        ...legacy,
        platform: transport === 'official_api' ? WECHAT_KF_PLATFORM_ID : legacy.platform,
        capabilities: { ...legacy.capabilities, transport },
      };
      expect(accountSummarySchema.parse(upgraded)).toEqual(upgraded);
    }

    expect(
      accountSummarySchema.safeParse({
        ...legacy,
        capabilities: { ...legacy.capabilities, transport: 'raw_socket' },
      }).success,
    ).toBe(false);
    expect(
      accountSummarySchema.safeParse({
        ...legacy,
        capabilities: { ...legacy.capabilities, unexpected: true },
      }).success,
    ).toBe(false);
  });

  test('supports all four discriminated ConnectorTransportStatus variants without browser placeholders', () => {
    const official: OfficialApiTransportStatus = createOfficialApiTransportStatus({
      state: 'CONNECTED',
      protocol: 'wecom_ws',
      endpointDigest: officialApiEndpointDigest(WECOM_AIBOT_DEFAULT_WS_URL, {
        allowedProtocols: ['wss:'],
        allowedHosts: WECOM_AIBOT_OFFICIAL_HOSTS,
      }),
      lastHeartbeatAt: 1_764_224_000_000,
      errorCode: null,
    });
    const desktopUia: DesktopUiaTransportStatus = {
      transport: 'desktop_uia',
      state: 'READY',
      windowAvailable: true,
      accessibilityVisible: true,
    };
    const copilot: CopilotWebviewTransportStatus = {
      transport: 'copilot_webview',
      state: 'ATTACHED',
      targetUrlOrigin: 'https://seller.example.com',
    };
    const statuses: ConnectorTransportStatus[] = [
      { transport: 'browser', state: 'CLOSED', mode: 'headless', version: null, loginRecovery: false },
      official,
      desktopUia,
      copilot,
    ];

    expect(statuses.map(item => item.transport)).toEqual([
      'browser',
      'official_api',
      'desktop_uia',
      'copilot_webview',
    ]);
    expect('browserVersion' in official).toBe(false);
    expect('mode' in official).toBe(false);
    expect(official.protocol).toBe('wecom_ws');
  });
});

describe('Douyin and Mock browser transportStatus', () => {
  test('DouyinPlatformConnector exposes browser transport capability and delegates transportStatus', () => {
    const browser = new BrowserService('synthetic');
    const connector = new DouyinPlatformConnector(browser);
    expect(douyinCapabilities.transport).toBe('browser');
    expect(connector.capabilities.transport).toBe('browser');
    expect(connector.transportStatus()).toEqual({
      transport: 'browser',
      state: 'CLOSED',
      mode: 'headless',
      version: null,
      loginRecovery: false,
    });

    vi.spyOn(browser, 'status').mockReturnValue({
      state: 'LOGIN_RECOVERY',
      mode: 'headed',
      version: '132.0.0.1',
      loginRecovery: true,
    });
    expect(connector.transportStatus()).toEqual({
      transport: 'browser',
      state: 'LOGIN_RECOVERY',
      mode: 'headed',
      version: '132.0.0.1',
      loginRecovery: true,
    });
  });

  test('MockPlatformConnector exposes browser transport capability and reflects open/closed/drift states', async () => {
    const mock = new MockPlatformConnector({ accountId: 'account_mock_transport', ownId: 'mock-own-transport' });
    expect(mockCapabilities.transport).toBe('browser');
    expect(mock.capabilities.transport).toBe('browser');
    expect(mock.platformId).toBe(MOCK_PLATFORM_ID);
    expect(mock.transportStatus()).toEqual({
      transport: 'browser',
      state: 'OPEN',
      mode: 'headless',
      version: null,
      loginRecovery: false,
    });

    await mock.close();
    expect(mock.transportStatus()).toEqual({
      transport: 'browser',
      state: 'CLOSED',
      mode: 'headless',
      version: null,
      loginRecovery: false,
    });

    await mock.open();
    mock.simulateAccountDrift();
    expect(mock.transportStatus()).toEqual({
      transport: 'browser',
      state: 'ACCOUNT_CHANGED',
      mode: 'headless',
      version: null,
      loginRecovery: false,
    });
  });
});

describe('official-api-base SSRF guard, credential redaction, executor and identity builder', () => {
  test('accepts official HTTPS/WSS endpoints and pins public DNS answers', async () => {
    const lookup = vi.fn(async () => [
      { address: '101.226.103.106', family: 4 },
      { address: '2408:8711:10:10::1', family: 6 },
    ]);

    const kf = await validateOfficialApiEndpoint(`${WECHAT_KF_DEFAULT_BASE_URL}/`, {
      allowedProtocols: ['https:'],
      allowedHosts: WECHAT_KF_OFFICIAL_HOSTS,
      lookup,
    });
    expect(kf.normalizedUrl).toBe('https://qyapi.weixin.qq.com/cgi-bin');
    expect(kf.hostname).toBe('qyapi.weixin.qq.com');
    expect(kf.port).toBe(443);
    expect(kf.endpointDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(kf.addresses).toHaveLength(2);

    const pinnedAll = vi.fn();
    kf.pinnedLookup('qyapi.weixin.qq.com', { all: true }, pinnedAll);
    expect(pinnedAll).toHaveBeenCalledExactlyOnceWith(null, [
      { address: '101.226.103.106', family: 4 },
      { address: '2408:8711:10:10::1', family: 6 },
    ]);

    const pinnedIpv6 = vi.fn();
    kf.pinnedLookup('qyapi.weixin.qq.com', { family: 6 }, pinnedIpv6);
    expect(pinnedIpv6).toHaveBeenCalledExactlyOnceWith(null, '2408:8711:10:10::1', 6);

    const pinnedIpv4All = vi.fn();
    kf.pinnedLookup('qyapi.weixin.qq.com', { family: 4, all: true }, pinnedIpv4All);
    expect(pinnedIpv4All).toHaveBeenCalledExactlyOnceWith(null, [{ address: '101.226.103.106', family: 4 }]);

    const wecom = await validateOfficialApiEndpoint(`${WECOM_AIBOT_DEFAULT_WS_URL}:443/`, {
      allowedProtocols: ['wss:'],
      allowedHosts: WECOM_AIBOT_OFFICIAL_HOSTS,
      lookup: async () => [{ address: '119.29.29.29', family: 4 }],
    });
    expect(wecom.normalizedUrl).toBe('wss://openws.work.weixin.qq.com');
    expect(wecom.protocol).toBe('wss:');
    expect(wecom.endpointDigest).toBe(officialApiEndpointDigest(WECOM_AIBOT_DEFAULT_WS_URL));

    const missingIpv6 = vi.fn();
    wecom.pinnedLookup('openws.work.weixin.qq.com', { family: 6 }, missingIpv6);
    expect(missingIpv6).toHaveBeenCalledOnce();
    expect(missingIpv6.mock.calls[0]![0]).toMatchObject({ code: 'ENOTFOUND' });
  });

  test.each([
    ['http://qyapi.weixin.qq.com/cgi-bin', 'OFFICIAL_API_ENDPOINT_PROTOCOL_UNSUPPORTED'],
    ['ws://openws.work.weixin.qq.com', 'OFFICIAL_API_ENDPOINT_PROTOCOL_UNSUPPORTED'],
    ['file:///etc/passwd', 'OFFICIAL_API_ENDPOINT_PROTOCOL_UNSUPPORTED'],
    ['https://user:pass@qyapi.weixin.qq.com/cgi-bin', 'OFFICIAL_API_ENDPOINT_CREDENTIALS_FORBIDDEN'],
    ['https://qyapi.weixin.qq.com:8443/cgi-bin', 'OFFICIAL_API_ENDPOINT_PORT_UNSUPPORTED'],
    ['wss://openws.work.weixin.qq.com:8080', 'OFFICIAL_API_ENDPOINT_PORT_UNSUPPORTED'],
    ['https://localhost/cgi-bin', 'OFFICIAL_API_ENDPOINT_PRIVATE_ADDRESS'],
    ['https://api.localhost/cgi-bin', 'OFFICIAL_API_ENDPOINT_PRIVATE_ADDRESS'],
    ['https://gateway.internal/cgi-bin', 'OFFICIAL_API_ENDPOINT_PRIVATE_ADDRESS'],
    ['https://gateway.local/cgi-bin', 'OFFICIAL_API_ENDPOINT_PRIVATE_ADDRESS'],
    ['https://intranet/cgi-bin', 'OFFICIAL_API_ENDPOINT_PRIVATE_ADDRESS'],
    ['https://127.0.0.1/cgi-bin', 'OFFICIAL_API_ENDPOINT_PRIVATE_ADDRESS'],
    ['https://10.0.0.8/cgi-bin', 'OFFICIAL_API_ENDPOINT_PRIVATE_ADDRESS'],
    ['https://169.254.169.254/latest/meta-data', 'OFFICIAL_API_ENDPOINT_PRIVATE_ADDRESS'],
    ['https://192.168.1.10/cgi-bin', 'OFFICIAL_API_ENDPOINT_PRIVATE_ADDRESS'],
    ['https://172.16.0.1/cgi-bin', 'OFFICIAL_API_ENDPOINT_PRIVATE_ADDRESS'],
    ['https://100.64.0.1/cgi-bin', 'OFFICIAL_API_ENDPOINT_PRIVATE_ADDRESS'],
    ['https://[::1]/cgi-bin', 'OFFICIAL_API_ENDPOINT_PRIVATE_ADDRESS'],
    ['https://[fc00::1]/cgi-bin', 'OFFICIAL_API_ENDPOINT_PRIVATE_ADDRESS'],
    ['https://[::ffff:127.0.0.1]/cgi-bin', 'OFFICIAL_API_ENDPOINT_PRIVATE_ADDRESS'],
    ['https://qyapi.weixin.qq.com/cgi-bin/../secret', 'OFFICIAL_API_ENDPOINT_INVALID'],
    ['https://qyapi.weixin.qq.com\\..\\secret', 'OFFICIAL_API_ENDPOINT_INVALID'],
    ['https://qyapi.weixin.qq.com\\cgi-bin', 'OFFICIAL_API_ENDPOINT_INVALID'],
    ['https://qyapi.weixin.qq.com/cgi-bin?access_token=abc', 'OFFICIAL_API_ENDPOINT_INVALID'],
    ['https://qyapi.weixin.qq.com/cgi-bin#frag', 'OFFICIAL_API_ENDPOINT_INVALID'],
  ] as const)('rejects unsafe endpoint %s with %s', (rawUrl, expectedCode) => {
    expect(() => parseOfficialApiEndpoint(rawUrl)).toThrow(Blocked);
    expect(() => parseOfficialApiEndpoint(rawUrl)).toThrow(expectedCode);
  });

  test('enforces explicit host allowlist and blocks DNS rebinding to private addresses', async () => {
    expect(() =>
      parseOfficialApiEndpoint('https://evil.example.com/cgi-bin', {
        allowedProtocols: ['https:'],
        allowedHosts: WECHAT_KF_OFFICIAL_HOSTS,
      }),
    ).toThrow('OFFICIAL_API_ENDPOINT_HOST_NOT_ALLOWED');

    for (const privateAnswer of [
      { address: '127.0.0.1', family: 4 },
      { address: '10.2.3.4', family: 4 },
      { address: '169.254.169.254', family: 4 },
      { address: '::1', family: 6 },
      { address: 'fe80::1', family: 6 },
    ]) {
      await expect(
        validateOfficialApiEndpoint('https://relay.example.com/cgi-bin', {
          lookup: async () => [{ address: '1.1.1.1', family: 4 }, privateAnswer],
        }),
      ).rejects.toMatchObject({ code: 'OFFICIAL_API_ENDPOINT_PRIVATE_ADDRESS' });
    }

    await expect(
      validateOfficialApiEndpoint('https://unresolvable.example.com/cgi-bin', {
        lookup: async () => {
          throw new Error('ENOTFOUND');
        },
      }),
    ).rejects.toMatchObject({ code: 'OFFICIAL_API_ENDPOINT_DNS_FAILED' });
  });

  test('redacts secrets across digests, secret holder, status and structured records', () => {
    const appSecret = 'synthetic-app-secret-value-9988';
    const token = 'synthetic-callback-token-7766';
    const encodingAESKey = 'syntheticEncodingAesKey0123456789ABCDEFGH12';

    const fullDigest = credentialDigest(appSecret);
    const fragment = credentialKeyFragment(appSecret, 16);
    expect(fullDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(fragment).toBe(fullDigest.slice(0, 16));
    expect(fullDigest).not.toContain(appSecret);
    expect(() => credentialDigest('   ')).toThrow('OFFICIAL_API_CREDENTIAL_REQUIRED');

    const holder = createOfficialApiSecretHolder({ appSecret, token, encodingAESKey });
    const serialized = JSON.stringify(holder) + inspect(holder);
    for (const secret of [appSecret, token, encodingAESKey]) {
      expect(serialized).not.toContain(secret);
    }
    expect(holder.use(secrets => secrets.token === token)).toBe(true);
    expect(holder.digest('appSecret')).toMatch(/^[a-f0-9]{64}$/u);
    expect(holder.keyFragment('encodingAESKey', 16)).toHaveLength(16);
    holder.dispose();
    expect(holder.disposed).toBe(true);
    expect(() => holder.use(secrets => secrets.appSecret)).toThrow('OFFICIAL_API_CREDENTIAL_DISPOSED');

    const rawText = `GET https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpsecret=${appSecret}&access_token=${token} key=${encodingAESKey}`;
    const scrubbedText = redactOfficialApiText(rawText, [appSecret, token, encodingAESKey]);
    for (const secret of [appSecret, token, encodingAESKey]) {
      expect(scrubbedText).not.toContain(secret);
    }

    const sanitized = redactOfficialApiValue(
      {
        endpointDigest: officialApiEndpointDigest(WECHAT_KF_DEFAULT_BASE_URL),
        appSecret,
        token,
        encodingAESKey,
        nested: { note: `leaked ${appSecret}`, authorization: `Bearer ${token}` },
      },
      [appSecret, token, encodingAESKey],
    );
    const sanitizedJson = JSON.stringify(sanitized);
    for (const secret of [appSecret, token, encodingAESKey]) {
      expect(sanitizedJson).not.toContain(secret);
    }
    expect(sanitized).toMatchObject({
      endpointDigest: officialApiEndpointDigest(WECHAT_KF_DEFAULT_BASE_URL),
      appSecret: '[REDACTED]',
      token: '[REDACTED]',
      encodingAESKey: '[REDACTED]',
      nested: { note: 'leaked [REDACTED]', authorization: '[REDACTED]' },
    });

    const safeStatus = createOfficialApiTransportStatus({
      state: 'ERROR',
      protocol: 'wechat_kf_http',
      endpointDigest: officialApiEndpointDigest(WECHAT_KF_DEFAULT_BASE_URL),
      errorCode: `leaked secret ${appSecret}`,
    });
    expect(safeStatus.errorCode).toBe('UNCLASSIFIED_ERROR');
    expect(JSON.stringify(safeStatus)).not.toContain(appSecret);
  });

  test('redacts cookies, short secrets (<4 chars), Error objects and rawHeaders arrays', () => {
    const shortSecret = 'k9x';
    const headerText = `Cookie: sid=sess-123; s=${shortSecret}\r\nSet-Cookie: auth=cookie-456; HttpOnly\r\nX-Note: pin=${shortSecret}`;
    const scrubbedHeaderText = redactOfficialApiText(headerText, [shortSecret, 'E']);
    expect(scrubbedHeaderText).not.toContain('sess-123');
    expect(scrubbedHeaderText).not.toContain('cookie-456');
    expect(scrubbedHeaderText).not.toContain(shortSecret);
    expect(scrubbedHeaderText).toContain('Cookie: [REDACTED]');
    expect(scrubbedHeaderText).toContain('Set-Cookie: [REDACTED]');
    expect(scrubbedHeaderText).toContain('pin=[REDACTED]');
    expect(scrubbedHeaderText).not.toContain('[R[REDACTED]');

    const err = Object.assign(new Error(`upstream failed with ${shortSecret} and Cookie: sid=secret-cookie`), {
      code: 'ECONNRESET',
      rawHeaders: [
        'Content-Type', 'application/json',
        'Set-Cookie', 'sid=raw-cookie-789; Secure',
        'Authorization', 'Bearer raw-bearer-000',
        'X-Custom-Info', `echo-${shortSecret}`,
      ],
    });
    const redactedErr = redactOfficialApiValue(err, [shortSecret]) as Record<string, unknown>;
    expect(redactedErr).toMatchObject({
      name: 'Error',
      code: 'ECONNRESET',
      rawHeaders: [
        'Content-Type', 'application/json',
        'Set-Cookie', '[REDACTED]',
        'Authorization', '[REDACTED]',
        'X-Custom-Info', 'echo-[REDACTED]',
      ],
    });
    expect(String(redactedErr.message)).toContain('[REDACTED]');
    const serializedErr = JSON.stringify(redactedErr);
    expect(serializedErr).not.toContain(shortSecret);
    expect(serializedErr).not.toContain('secret-cookie');
    expect(serializedErr).not.toContain('raw-cookie-789');
    expect(serializedErr).not.toContain('raw-bearer-000');

    const blocked = redactOfficialApiValue(new Blocked('OFFICIAL_API_ERROR')) as Record<string, unknown>;
    expect(blocked).toEqual({
      name: 'Error',
      message: 'OFFICIAL_API_ERROR',
      code: 'OFFICIAL_API_ERROR',
    });
  });

  test('serializes work via OfficialApiSerialExecutor and stops cleanly on abort or dispose', async () => {
    const executor = createOfficialApiExecutor();
    expect(executor.idle).toBe(true);

    const trace: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });

    const first = executor.runInteractive(async () => {
      trace.push('first:start');
      await firstGate;
      trace.push('first:end');
      return 1;
    });
    const second = executor.runBackground(async () => {
      trace.push('second:run');
      return 2;
    });

    const abortedController = new AbortController();
    const abortedTask = executor.runWithSignal(async () => {
      trace.push('aborted:should-not-run');
      return 3;
    }, abortedController.signal);
    abortedController.abort(new Blocked('OFFICIAL_API_ABORTED'));

    // Queued abort rejects immediately while the head task is still blocked.
    await expect(abortedTask).rejects.toMatchObject({ code: 'OFFICIAL_API_ABORTED' });
    expect(trace).not.toContain('first:end');

    expect(executor.idle).toBe(false);
    releaseFirst();

    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(trace).toEqual(['first:start', 'first:end', 'second:run']);
    await expect.poll(() => executor.idle).toBe(true);

    executor.dispose();
    expect(executor.isDisposed).toBe(true);
    await expect(executor.run(async () => 'never')).rejects.toMatchObject({ code: 'OFFICIAL_API_CONNECTOR_CLOSED' });
  });

  test('builds deterministic non-browser OfficialApiCapabilityIdentity digests', () => {
    const kfIdentity: ConnectorCapabilityIdentity = buildOfficialApiChannelIdentity({
      platformId: WECHAT_KF_PLATFORM_ID,
      accountId: 'account_kf_01',
      ownId: 'wk_open_kf_001',
      channel: 'DIRECT_MESSAGE',
      protocol: 'wechat_kf_http',
      endpointUrl: `${WECHAT_KF_DEFAULT_BASE_URL}/`,
      allowedHosts: WECHAT_KF_OFFICIAL_HOSTS,
      scopeId: 'ww_corp_001',
    });

    expect(kfIdentity.transport).toBe('official_api');
    expect(kfIdentity.identityDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(kfIdentity.mappingDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect('browserVersion' in kfIdentity).toBe(false);
    expect('browserMode' in kfIdentity).toBe(false);

    const sameKfIdentity = buildOfficialApiChannelIdentity({
      platformId: WECHAT_KF_PLATFORM_ID,
      accountId: 'account_kf_01',
      ownId: 'wk_open_kf_001',
      channel: 'DIRECT_MESSAGE',
      protocol: 'wechat_kf_http',
      endpointUrl: WECHAT_KF_DEFAULT_BASE_URL,
      allowedHosts: WECHAT_KF_OFFICIAL_HOSTS,
      scopeId: 'ww_corp_001',
    });
    expect(sameKfIdentity).toEqual(kfIdentity);

    expect(() =>
      buildOfficialApiChannelIdentity({
        platformId: WECOM_AIBOT_PLATFORM_ID,
        accountId: 'account_wecom_01',
        ownId: 'bot_001',
        channel: 'DIRECT_MESSAGE',
        protocol: 'wecom_ws',
        endpointUrl: 'https://openws.work.weixin.qq.com',
        allowedHosts: WECOM_AIBOT_OFFICIAL_HOSTS,
      }),
    ).toThrow('OFFICIAL_API_ENDPOINT_PROTOCOL_UNSUPPORTED');
  });
});
