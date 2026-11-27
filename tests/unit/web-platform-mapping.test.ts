import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  WEB_PLATFORM_ORIGIN_WHITELIST,
  hasCalibratedWebReplyMapping,
  loadWebPlatformObservationMapping,
  loadWebPlatformReplyMapping,
  requireCalibratedWebReplyMapping,
  validateWebPlatformObservationMapping,
  validateWebPlatformReplyMapping,
  webPlatformObservationMappingPath,
  webPlatformObservationMappingSchema,
  webPlatformReplyMappingPath,
  webPlatformReplyMappingSchema,
} from '../../src/config/site-mapping.js';
import { BILIBILI_PLATFORM_ID, XIAOHONGSHU_PLATFORM_ID } from '../../src/contracts/account.js';
import { Blocked } from '../../src/core/contracts.js';

const tempDirs: string[] = [];

async function tempAccountRoot(): Promise<string> {
  const base = resolve('.local/tests');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'web-mapping-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function sampleObservation(
  platform: 'xiaohongshu' | 'bilibili',
  environment: 'fixture' | 'production',
  origin: string,
) {
  return {
    platform,
    environment,
    origin,
    entryUrl: `${origin}/creator/home`,
    selfId: 'self-user-1',
    ...(environment === 'production' ? { evidenceRef: 'ev-prod-calibration-1' } : {}),
    selectors: {
      selfId: '#self-id',
      selfIdAttribute: 'data-uid',
      dm: {
        pane: '#dm-pane',
        messages: '.dm-msg',
        messageText: '.dm-text',
      },
      comment: {
        list: '#comment-list',
        rows: '.comment-row',
        text: '.comment-text',
      },
    },
  };
}

function sampleReply(
  platform: 'xiaohongshu' | 'bilibili',
  environment: 'fixture' | 'production',
  origin: string,
) {
  return {
    platform,
    environment,
    origin,
    entryUrl: `${origin}/creator/home`,
    selfId: 'self-user-1',
    ...(environment === 'production' ? { evidenceRef: 'ev-prod-calibration-1' } : {}),
    selectors: {
      selfId: '#self-id',
      selfIdAttribute: 'data-uid',
      dm: {
        pane: '#dm-pane',
        messages: '.dm-msg',
        messageText: '.dm-text',
        composer: '#dm-composer',
        send: '#dm-send',
        outgoingRows: '.dm-msg.from-me',
      },
      comment: {
        list: '#comment-list',
        rows: '.comment-row',
        text: '.comment-text',
        composer: '#comment-composer',
        send: '#comment-send',
        outgoingRows: '.comment-reply.from-me',
      },
    },
  };
}

test('enforces strict origin whitelist for xiaohongshu, bilibili, and fixture mappings', () => {
  for (const origin of WEB_PLATFORM_ORIGIN_WHITELIST[XIAOHONGSHU_PLATFORM_ID]) {
    expect(validateWebPlatformObservationMapping(sampleObservation('xiaohongshu', 'production', origin)).origin).toBe(origin);
    expect(validateWebPlatformReplyMapping(sampleReply('xiaohongshu', 'production', origin)).origin).toBe(origin);
  }
  for (const origin of WEB_PLATFORM_ORIGIN_WHITELIST[BILIBILI_PLATFORM_ID]) {
    expect(validateWebPlatformObservationMapping(sampleObservation('bilibili', 'production', origin)).origin).toBe(origin);
    expect(validateWebPlatformReplyMapping(sampleReply('bilibili', 'production', origin)).origin).toBe(origin);
  }

  for (const origin of ['http://127.0.0.1', 'http://127.0.0.1:4123', 'http://localhost:8080']) {
    expect(validateWebPlatformObservationMapping(sampleObservation('xiaohongshu', 'fixture', origin), { allowFixture: true }).origin).toBe(origin);
    expect(validateWebPlatformReplyMapping(sampleReply('bilibili', 'fixture', origin), { allowFixture: true }).origin).toBe(origin);
  }

  // allowFixture defaults to false everywhere.
  expect(() =>
    validateWebPlatformReplyMapping(sampleReply('xiaohongshu', 'fixture', 'http://127.0.0.1:3000')),
  ).toThrow('REAL_MAPPING_REQUIRED');

  // Production mappings require non-empty evidenceRef.
  expect(() =>
    validateWebPlatformReplyMapping({
      ...sampleReply('xiaohongshu', 'production', 'https://www.xiaohongshu.com'),
      evidenceRef: undefined,
    }),
  ).toThrow('CALIBRATION_EVIDENCE_REQUIRED');

  // Cross-platform or unwhitelisted production origins are rejected.
  expect(() =>
    validateWebPlatformReplyMapping(sampleReply('xiaohongshu', 'production', 'https://www.bilibili.com')),
  ).toThrow('REAL_MAPPING_REQUIRED');
  expect(() =>
    validateWebPlatformReplyMapping(sampleReply('bilibili', 'production', 'https://www.xiaohongshu.com')),
  ).toThrow('REAL_MAPPING_REQUIRED');
  expect(() =>
    validateWebPlatformObservationMapping(sampleObservation('xiaohongshu', 'production', 'https://evil.example.com')),
  ).toThrow('REAL_MAPPING_REQUIRED');
  expect(() =>
    validateWebPlatformReplyMapping(sampleReply('bilibili', 'production', 'http://127.0.0.1:3000')),
  ).toThrow('REAL_MAPPING_REQUIRED');

  // Fixture mappings reject non-loopback hosts, HTTPS production domains, and allowFixture=false.
  expect(() =>
    validateWebPlatformReplyMapping(sampleReply('xiaohongshu', 'fixture', 'http://192.168.1.10:3000'), { allowFixture: true }),
  ).toThrow('LOCAL_FIXTURE_REQUIRED');
  expect(() =>
    validateWebPlatformReplyMapping(sampleReply('xiaohongshu', 'fixture', 'https://www.xiaohongshu.com'), { allowFixture: true }),
  ).toThrow('LOCAL_FIXTURE_REQUIRED');
  expect(() =>
    validateWebPlatformReplyMapping(sampleReply('xiaohongshu', 'fixture', 'http://127.0.0.1:3000'), { allowFixture: false }),
  ).toThrow('REAL_MAPPING_REQUIRED');

  // Unsafe entryUrl with mismatched origin, blob protocol, or hash is rejected.
  const badEntry = {
    ...sampleReply('xiaohongshu', 'production', 'https://www.xiaohongshu.com'),
    entryUrl: 'https://www.xiaohongshu.com/explore#frag',
  };
  expect(() => validateWebPlatformReplyMapping(badEntry)).toThrow('UNSAFE_OBSERVATION_URL');

  const blobEntry = {
    ...sampleReply('xiaohongshu', 'production', 'https://www.xiaohongshu.com'),
    entryUrl: 'blob:https://www.xiaohongshu.com/550e8400-e29b-41d4-a716-446655440000',
  };
  expect(() => validateWebPlatformReplyMapping(blobEntry)).toThrow('UNSAFE_OBSERVATION_URL');

  const crossOriginEntry = {
    ...sampleReply('bilibili', 'production', 'https://message.bilibili.com'),
    entryUrl: 'https://www.bilibili.com/video/BV1xx',
  };
  expect(() => validateWebPlatformReplyMapping(crossOriginEntry)).toThrow('UNSAFE_OBSERVATION_URL');

  expect(webPlatformObservationMappingSchema.safeParse(sampleObservation('xiaohongshu', 'production', 'https://www.xiaohongshu.com')).success).toBe(true);
  expect(webPlatformReplyMappingSchema.safeParse(sampleReply('bilibili', 'production', 'https://member.bilibili.com')).success).toBe(true);
});

test('private mapping helpers enforce PLATFORM_MAPPING_UNCALIBRATED when absent or invalid', async () => {
  const root = await tempAccountRoot();
  expect(await loadWebPlatformObservationMapping(root, 'xiaohongshu')).toBeNull();
  expect(await loadWebPlatformReplyMapping(root, 'xiaohongshu')).toBeNull();
  expect(await hasCalibratedWebReplyMapping(root, 'xiaohongshu')).toBe(false);
  await expect(requireCalibratedWebReplyMapping(root, 'xiaohongshu')).rejects.toMatchObject({
    code: 'PLATFORM_MAPPING_UNCALIBRATED',
  });

  await mkdir(join(root, 'mappings'), { recursive: true });
  await writeFile(
    webPlatformReplyMappingPath(root, 'xiaohongshu'),
    JSON.stringify(sampleReply('xiaohongshu', 'production', 'https://evil.example.com')),
  );
  expect(await hasCalibratedWebReplyMapping(root, 'xiaohongshu')).toBe(false);
  await expect(loadWebPlatformReplyMapping(root, 'xiaohongshu')).rejects.toBeInstanceOf(Blocked);
  await expect(requireCalibratedWebReplyMapping(root, 'xiaohongshu')).rejects.toMatchObject({
    code: 'PLATFORM_MAPPING_UNCALIBRATED',
  });

  const validObs = sampleObservation('xiaohongshu', 'production', 'https://creator.xiaohongshu.com');
  const validReply = sampleReply('xiaohongshu', 'production', 'https://creator.xiaohongshu.com');
  await writeFile(webPlatformObservationMappingPath(root, 'xiaohongshu'), JSON.stringify(validObs));
  await writeFile(webPlatformReplyMappingPath(root, 'xiaohongshu'), JSON.stringify(validReply));

  expect(await loadWebPlatformObservationMapping(root, 'xiaohongshu')).toMatchObject({
    platform: 'xiaohongshu',
    origin: 'https://creator.xiaohongshu.com',
  });
  expect(await loadWebPlatformReplyMapping(root, 'xiaohongshu')).toMatchObject({
    platform: 'xiaohongshu',
    origin: 'https://creator.xiaohongshu.com',
  });
  expect(await hasCalibratedWebReplyMapping(root, 'xiaohongshu')).toBe(true);
  await expect(requireCalibratedWebReplyMapping(root, 'xiaohongshu')).resolves.toMatchObject({
    selfId: 'self-user-1',
  });
});
