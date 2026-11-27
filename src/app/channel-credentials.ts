import { randomUUID } from 'node:crypto';
import {
  closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync,
  realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { inspect } from 'node:util';
import { z } from 'zod';
import {
  accountIdSchema, WECHAT_KF_PLATFORM_ID, WECOM_AIBOT_PLATFORM_ID,
  type AccountId, type ChannelCredentialStorage, type ConfigureOfficialChannelCommand,
  type OfficialApiPlatformId, type OfficialChannelPublicConfig,
} from '../contracts/account.js';
import { Blocked, digest, requireSafe } from '../core/contracts.js';
import { parseOfficialApiEndpoint } from '../platform/official-api-base.js';
import { deriveAesKey } from '../platform/wechat-kf/crypto.js';
import {
  clearDeletedDpapiCache, clearDpapiCache, dpapiSecretCacheKey, dpapiWithEntropy,
  invalidateDeletedKey, type DpapiCache,
} from './credentials.js';

const MAX_CONFIG_BYTES = 16_384;
const MAX_SECRET_CIPHERTEXT_BYTES = 32_768;
const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface ChannelCredentialScope {
  readonly accountId: AccountId;
  readonly platform: OfficialApiPlatformId;
}

export interface ChannelCredentialProtector {
  protect(input: Buffer, scope: Readonly<ChannelCredentialScope>): Promise<Buffer>;
  unprotect(input: Buffer, scope: Readonly<ChannelCredentialScope>, cache?: DpapiCache): Promise<Buffer>;
}

export interface WecomAibotSecretPayload {
  readonly platform: typeof WECOM_AIBOT_PLATFORM_ID;
  readonly secret: string;
}

export interface WechatKfSecretPayload {
  readonly platform: typeof WECHAT_KF_PLATFORM_ID;
  readonly appSecret: string;
  readonly token?: string | undefined;
  readonly encodingAESKey?: string | undefined;
}

export type OfficialChannelSecretPayload = WecomAibotSecretPayload | WechatKfSecretPayload;

const storedStorageSchema = z.enum(['MEMORY', 'DPAPI', 'NONE']);
const secretRevisionSchema = z.string().regex(canonicalUuid).nullable();

const storedWecomConfigSchema = z.object({
  version: z.literal(1),
  platform: z.literal(WECOM_AIBOT_PLATFORM_ID),
  botId: z.string().min(1).max(128),
  wsUrl: z.string().max(2048).nullable(),
  allowGroupMessages: z.boolean(),
  storage: storedStorageSchema,
  secretRevision: secretRevisionSchema.optional(),
  updatedAt: z.string(),
}).strict();

const storedWechatKfConfigSchema = z.object({
  version: z.literal(1),
  platform: z.literal(WECHAT_KF_PLATFORM_ID),
  corpId: z.string().min(1).max(128),
  openKfId: z.string().min(1).max(128),
  apiBaseUrl: z.string().max(2048).nullable(),
  storage: storedStorageSchema,
  secretRevision: secretRevisionSchema.optional(),
  webhookSecretConfigured: z.boolean(),
  updatedAt: z.string(),
}).strict();

const storedConfigSchema = z.discriminatedUnion('platform', [
  storedWecomConfigSchema,
  storedWechatKfConfigSchema,
]);
export type StoredOfficialChannelConfig = z.infer<typeof storedConfigSchema>;

const secretStringSchema = z.string().min(1).max(4000).refine(
  value => value.trim().length > 0 && !/[\r\n]/u.test(value) && !/\p{Cs}/u.test(value),
  'INVALID_CHANNEL_SECRET',
);
const wecomSecretSchema = z.object({
  platform: z.literal(WECOM_AIBOT_PLATFORM_ID),
  secret: secretStringSchema,
}).strict();
const wechatKfSecretSchema = z.object({
  platform: z.literal(WECHAT_KF_PLATFORM_ID),
  appSecret: secretStringSchema,
  token: secretStringSchema.optional(),
  encodingAESKey: secretStringSchema.optional(),
}).strict();
const secretPayloadSchema = z.discriminatedUnion('platform', [wecomSecretSchema, wechatKfSecretSchema]);

function credentialEntropy(scope: Readonly<ChannelCredentialScope>): string {
  return `inbora:channel-credential:v1:${digest([scope.accountId, scope.platform])}`;
}

/** Case-sensitive directory name preventing collisions on Windows case-insensitive filesystems. */
export function channelCredentialDirName(accountId: AccountId): string {
  requireSafe(accountIdSchema.safeParse(accountId).success, 'INVALID_ACCOUNT_ID');
  return digest(['channel-credentials-dir', accountId]).slice(0, 32);
}

const windowsChannelProtector: ChannelCredentialProtector = {
  protect: (input, scope) => dpapiWithEntropy(input, 'Protect', credentialEntropy(scope)),
  unprotect: (input, scope, cache) => dpapiWithEntropy(input, 'Unprotect', credentialEntropy(scope), cache),
};

function statIfPresent(path: string) {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function removePrivateFile(file: string): void {
  const stats = statIfPresent(file);
  if (!stats) return;
  requireSafe(stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1, 'CHANNEL_CREDENTIAL_CLEANUP_FAILED');
  unlinkSync(file);
}

function writeAtomicPrivateFile(file: string, content: Buffer | string): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(handle, content);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    const existing = statIfPresent(file);
    if (existing) {
      requireSafe(existing.isFile() && !existing.isSymbolicLink() && existing.nlink === 1, 'INVALID_CHANNEL_CREDENTIAL_PATH');
    }
    renameSync(temporary, file);
  } catch (error) {
    try { removePrivateFile(temporary); } catch { /* ignore temp cleanup failure */ }
    throw error;
  }
}

function readBoundedPrivateFile(file: string, maxBytes: number, errorCode: string): { data: Buffer; mtimeMs: number } {
  const stats = statIfPresent(file);
  requireSafe(stats && stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1
    && stats.size > 0 && stats.size <= maxBytes, errorCode);
  const handle = openSync(file, 'r');
  try {
    const opened = fstatSync(handle);
    requireSafe(opened.dev === stats.dev && opened.ino === stats.ino && opened.nlink === 1
      && opened.size > 0 && opened.size <= maxBytes, errorCode);
    return { data: readFileSync(handle), mtimeMs: opened.mtimeMs };
  } finally {
    closeSync(handle);
  }
}

function normalizeOptionalEndpoint(value: string | null | undefined, platform: OfficialApiPlatformId): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (platform === WECOM_AIBOT_PLATFORM_ID) {
    try {
      return parseOfficialApiEndpoint(trimmed, { allowedProtocols: ['wss:'] }).normalizedUrl;
    } catch {
      throw new Blocked('WECOM_WS_UNSAFE_ENDPOINT');
    }
  }
  try {
    return parseOfficialApiEndpoint(trimmed, { allowedProtocols: ['https:'] }).normalizedUrl.replace(/\/+$/u, '');
  } catch {
    throw new Blocked('WECHAT_KF_UNSAFE_ENDPOINT');
  }
}

function secretFileName(revision: string | null | undefined): string {
  return revision ? `secret.${revision}.dpapi` : 'secret.dpapi';
}

/**
 * Serialized private credential & public metadata store for official API channels.
 * Uses versioned DPAPI ciphertext files so failed rotations never corrupt the active secret.
 */
export class ChannelCredentialStore {
  private static readonly queues = new Map<string, Promise<unknown>>();
  private readonly root: string;
  private readonly queueKey: string;
  private readonly memory = new Map<string, Readonly<OfficialChannelSecretPayload>>();

  constructor(
    root: string,
    private readonly protector: ChannelCredentialProtector = windowsChannelProtector,
    private readonly now: () => number = Date.now,
  ) {
    const resolved = resolve(root);
    const stats = statIfPresent(resolved);
    requireSafe(stats && stats.isDirectory() && !stats.isSymbolicLink(), 'INVALID_CHANNEL_CREDENTIAL_PATH');
    this.root = realpathSync.native(resolved);
    this.queueKey = process.platform === 'win32' ? this.root.toLowerCase() : this.root;
  }

  [inspect.custom](): string {
    return `ChannelCredentialStore { memoryCount: ${this.memory.size} }`;
  }

  private async sequence<T>(operation: () => Promise<T>): Promise<T> {
    const task = (ChannelCredentialStore.queues.get(this.queueKey) ?? Promise.resolve()).catch(() => {}).then(operation);
    ChannelCredentialStore.queues.set(this.queueKey, task);
    try { return await task; }
    finally {
      if (ChannelCredentialStore.queues.get(this.queueKey) === task) {
        ChannelCredentialStore.queues.delete(this.queueKey);
      }
    }
  }

  private memoryKey(accountId: AccountId, platform: OfficialApiPlatformId): string {
    return `${accountId}:${platform}`;
  }

  private accountDir(accountId: AccountId, create: boolean): string | null {
    const dirName = channelCredentialDirName(accountId);
    const base = join(this.root, 'channel-credentials');
    const dir = join(base, dirName);
    for (const path of [this.root, base, dir]) {
      let stats = statIfPresent(path);
      if (!stats && create && path !== this.root) {
        mkdirSync(path, { mode: 0o700 });
        stats = lstatSync(path);
      }
      if (!stats) {
        requireSafe(path !== this.root, 'INVALID_CHANNEL_CREDENTIAL_PATH');
        return null;
      }
      requireSafe(stats.isDirectory() && !stats.isSymbolicLink(), 'INVALID_CHANNEL_CREDENTIAL_PATH');
    }
    return dir;
  }

  private readStoredConfigSync(accountId: AccountId, platform: OfficialApiPlatformId): StoredOfficialChannelConfig | null {
    const dir = this.accountDir(accountId, false);
    if (!dir) return null;
    const configPath = join(dir, 'config.json');
    if (!statIfPresent(configPath)) return null;
    const { data } = readBoundedPrivateFile(configPath, MAX_CONFIG_BYTES, 'CHANNEL_CONFIG_INVALID');
    let parsed: unknown;
    try { parsed = JSON.parse(data.toString('utf8')); }
    catch { throw new Blocked('CHANNEL_CONFIG_INVALID'); }
    const validated = storedConfigSchema.safeParse(parsed);
    requireSafe(validated.success, 'CHANNEL_CONFIG_INVALID');
    requireSafe(validated.data.platform === platform, 'CHANNEL_CONFIG_PLATFORM_MISMATCH');
    return validated.data;
  }

  private async unprotectFile(file: string, scope: Readonly<ChannelCredentialScope>): Promise<OfficialChannelSecretPayload> {
    const { data: encrypted, mtimeMs } = readBoundedPrivateFile(file, MAX_SECRET_CIPHERTEXT_BYTES, 'DPAPI_RESTORE_FAILED');
    let plain: Buffer | undefined;
    try {
      plain = await this.protector.unprotect(encrypted, scope, {
        cacheKey: dpapiSecretCacheKey(file),
        mtimeMs,
      });
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plain);
      const parsed = secretPayloadSchema.safeParse(JSON.parse(text));
      requireSafe(parsed.success && parsed.data.platform === scope.platform, 'DPAPI_RESTORE_FAILED');
      return Object.freeze({ ...parsed.data });
    } catch (error) {
      if (error instanceof Blocked) throw error;
      throw new Blocked('DPAPI_RESTORE_FAILED');
    } finally {
      plain?.fill(0);
      encrypted.fill(0);
    }
  }

  private async stageAndVerifySecretFile(
    file: string,
    scope: Readonly<ChannelCredentialScope>,
    payload: OfficialChannelSecretPayload,
  ): Promise<void> {
    const plain = Buffer.from(JSON.stringify(payload), 'utf8');
    let encrypted: Buffer | undefined;
    try {
      try { encrypted = await this.protector.protect(plain, scope); }
      catch (error) {
        if (error instanceof Blocked) throw error;
        throw new Blocked('DPAPI_OPERATION_FAILED');
      }
      requireSafe(encrypted.byteLength > 0 && encrypted.byteLength <= MAX_SECRET_CIPHERTEXT_BYTES, 'DPAPI_FILE_INVALID');
      await clearDpapiCache(file);
      writeAtomicPrivateFile(file, encrypted);
      const restored = await this.unprotectFile(file, scope);
      requireSafe(JSON.stringify(restored) === JSON.stringify(payload), 'DPAPI_RESTORE_FAILED');
    } catch (error) {
      try { removePrivateFile(file); } catch { /* ignore failed staged file cleanup */ }
      await clearDeletedDpapiCache(file).catch(() => invalidateDeletedKey(this.root, file));
      throw error;
    } finally {
      plain.fill(0);
      encrypted?.fill(0);
    }
  }

  private async removeSecretFile(file: string, confirmCache = true, strict = false): Promise<void> {
    if (statIfPresent(file)) removePrivateFile(file);
    if (confirmCache) {
      try {
        await clearDeletedDpapiCache(file);
      } catch {
        invalidateDeletedKey(this.root, file);
        if (strict) throw new Blocked('CHANNEL_CREDENTIAL_CLEANUP_FAILED');
      }
    } else {
      invalidateDeletedKey(this.root, file);
    }
  }

  private async pruneStaleSecretFiles(dir: string, activeFileName: string | null, confirmCache: boolean, strict = false): Promise<void> {
    for (const name of readdirSync(dir)) {
      if (name === activeFileName) continue;
      if (name === 'secret.dpapi' || (name.startsWith('secret.') && (name.endsWith('.dpapi') || name.endsWith('.tmp')))) {
        await this.removeSecretFile(join(dir, name), confirmCache, strict);
      }
    }
  }

  private buildPublicConfig(
    accountId: AccountId,
    platform: OfficialApiPlatformId,
    fallbackOwnId: string | null,
    stored: StoredOfficialChannelConfig | null,
  ): OfficialChannelPublicConfig {
    const memKey = this.memoryKey(accountId, platform);
    const dir = this.accountDir(accountId, false);
    const activeSecretPath = dir && stored?.storage === 'DPAPI'
      ? join(dir, secretFileName(stored.secretRevision))
      : null;
    const hasDpapiFile = activeSecretPath !== null && statIfPresent(activeSecretPath) !== null;
    const hasMemory = this.memory.has(memKey);

    let credentialStorage: 'MEMORY' | 'DPAPI' | 'NONE' = 'NONE';
    let secretConfigured = false;
    let credentialError: string | null = null;
    if (stored?.storage === 'DPAPI') {
      credentialStorage = 'DPAPI';
      secretConfigured = hasDpapiFile;
      if (!hasDpapiFile) credentialError = 'DPAPI_RESTORE_FAILED';
    } else if (stored?.storage === 'MEMORY') {
      if (hasMemory) {
        credentialStorage = 'MEMORY';
        secretConfigured = true;
      } else {
        credentialStorage = 'NONE';
        secretConfigured = false;
      }
    }

    const base = {
      accountRef: accountId,
      credentialStorage,
      secretConfigured,
      credentialError,
      connected: false,
      transportStatus: null,
      updatedAt: stored?.updatedAt ?? null,
    };

    if (platform === WECOM_AIBOT_PLATFORM_ID) {
      const wecom = stored?.platform === WECOM_AIBOT_PLATFORM_ID ? stored : null;
      return {
        ...base,
        platform: WECOM_AIBOT_PLATFORM_ID,
        botId: wecom?.botId ?? fallbackOwnId ?? '',
        wsUrl: wecom?.wsUrl ?? null,
        allowGroupMessages: wecom?.allowGroupMessages ?? true,
      };
    }

    const kf = stored?.platform === WECHAT_KF_PLATFORM_ID ? stored : null;
    return {
      ...base,
      platform: WECHAT_KF_PLATFORM_ID,
      corpId: kf?.corpId ?? '',
      openKfId: kf?.openKfId ?? fallbackOwnId ?? '',
      apiBaseUrl: kf?.apiBaseUrl ?? null,
      webhookSecretConfigured: secretConfigured && (kf?.webhookSecretConfigured ?? false),
    };
  }

  getPublicConfig(
    accountId: AccountId,
    platform: OfficialApiPlatformId,
    fallbackOwnId: string | null = null,
  ): Promise<OfficialChannelPublicConfig> {
    return this.sequence(async () => {
      const stored = this.readStoredConfigSync(accountId, platform);
      return this.buildPublicConfig(accountId, platform, fallbackOwnId, stored);
    });
  }

  readStoredConfig(accountId: AccountId, platform: OfficialApiPlatformId): Promise<StoredOfficialChannelConfig | null> {
    return this.sequence(async () => this.readStoredConfigSync(accountId, platform));
  }

  saveConfig(
    accountId: AccountId,
    command: ConfigureOfficialChannelCommand,
  ): Promise<{ stored: StoredOfficialChannelConfig; publicConfig: OfficialChannelPublicConfig }> {
    return this.sequence(async () => {
      const platform = command.platform;
      const scope: ChannelCredentialScope = { accountId, platform };
      const existing = this.readStoredConfigSync(accountId, platform);
      const dir = this.accountDir(accountId, true)!;
      const configFile = join(dir, 'config.json');
      const memKey = this.memoryKey(accountId, platform);
      const nowIso = new Date(this.now()).toISOString();
      const existingSecretFile = existing?.storage === 'DPAPI'
        ? join(dir, secretFileName(existing.secretRevision))
        : null;

      let nextSecret: OfficialChannelSecretPayload | null = null;
      let nextStorage: 'MEMORY' | 'DPAPI' | 'NONE' = 'NONE';
      let nextRevision: string | null = null;
      let stageNewDpapi = false;
      let webhookSecretConfigured = existing?.platform === WECHAT_KF_PLATFORM_ID ? existing.webhookSecretConfigured : false;

      if (command.credentialMode === 'SET') {
        const targetStorage: ChannelCredentialStorage = command.storage ?? (existing?.storage === 'MEMORY' ? 'MEMORY' : 'DPAPI');
        nextStorage = targetStorage;
        if (command.platform === WECOM_AIBOT_PLATFORM_ID) {
          requireSafe(command.secret && command.secret.trim().length > 0, 'CHANNEL_CREDENTIAL_REQUIRED');
          nextSecret = Object.freeze({ platform: WECOM_AIBOT_PLATFORM_ID, secret: command.secret.trim() });
        } else {
          requireSafe(command.appSecret && command.appSecret.trim().length > 0, 'CHANNEL_CREDENTIAL_REQUIRED');
          const token = command.token?.trim() || undefined;
          const encodingAESKey = command.encodingAESKey?.trim() || undefined;
          requireSafe(Boolean(token) === Boolean(encodingAESKey), 'WECHAT_KF_WEBHOOK_PAIR_REQUIRED');
          if (encodingAESKey) deriveAesKey(encodingAESKey);
          webhookSecretConfigured = Boolean(token && encodingAESKey);
          nextSecret = Object.freeze({
            platform: WECHAT_KF_PLATFORM_ID,
            appSecret: command.appSecret.trim(),
            ...(token ? { token } : {}),
            ...(encodingAESKey ? { encodingAESKey } : {}),
          });
        }
        if (nextStorage === 'DPAPI') {
          nextRevision = randomUUID();
          stageNewDpapi = true;
        }
      } else if (command.credentialMode === 'DELETE') {
        nextStorage = 'NONE';
        nextRevision = null;
        webhookSecretConfigured = false;
      } else {
        const currentMem = this.memory.get(memKey) ?? null;
        const hasDpapiFile = existingSecretFile !== null && statIfPresent(existingSecretFile) !== null;
        const existingStorage = existing?.storage ?? 'NONE';
        if (existingStorage === 'MEMORY' && currentMem) {
          nextStorage = command.storage ?? 'MEMORY';
          nextSecret = currentMem;
          if (nextStorage === 'DPAPI') {
            nextRevision = randomUUID();
            stageNewDpapi = true;
          }
        } else if (existingStorage === 'DPAPI' && hasDpapiFile && existingSecretFile) {
          nextStorage = command.storage ?? 'DPAPI';
          if (nextStorage === 'MEMORY') {
            nextSecret = await this.unprotectFile(existingSecretFile, scope);
            nextRevision = null;
          } else {
            nextRevision = existing?.secretRevision ?? null;
          }
        } else {
          nextStorage = 'NONE';
          nextRevision = null;
          webhookSecretConfigured = false;
        }
      }

      const nextConfig: StoredOfficialChannelConfig = command.platform === WECOM_AIBOT_PLATFORM_ID
        ? {
          version: 1,
          platform: WECOM_AIBOT_PLATFORM_ID,
          botId: command.botId.trim(),
          wsUrl: normalizeOptionalEndpoint(command.wsUrl, WECOM_AIBOT_PLATFORM_ID),
          allowGroupMessages: command.allowGroupMessages ?? (existing?.platform === WECOM_AIBOT_PLATFORM_ID ? existing.allowGroupMessages : true),
          storage: nextStorage,
          secretRevision: nextRevision,
          updatedAt: nowIso,
        }
        : {
          version: 1,
          platform: WECHAT_KF_PLATFORM_ID,
          corpId: command.corpId.trim(),
          openKfId: command.openKfId.trim(),
          apiBaseUrl: normalizeOptionalEndpoint(command.apiBaseUrl, WECHAT_KF_PLATFORM_ID),
          storage: nextStorage,
          secretRevision: nextRevision,
          webhookSecretConfigured,
          updatedAt: nowIso,
        };

      // Stage & verify new revision without touching previous active secret.
      const stagedFile = stageNewDpapi && nextRevision ? join(dir, secretFileName(nextRevision)) : null;
      if (stagedFile && nextSecret) {
        await this.stageAndVerifySecretFile(stagedFile, scope, nextSecret);
      }

      // Commit config.json atomically before deleting old revision or updating memory.
      try {
        writeAtomicPrivateFile(configFile, JSON.stringify(nextConfig, null, 2));
      } catch (error) {
        if (stagedFile) await this.removeSecretFile(stagedFile, true).catch(() => {});
        throw error;
      }

      // New config is committed; prune superseded ciphertext best-effort so a transient file lock
      // on an obsolete file never makes an already-committed rotation report failure.
      if (nextStorage === 'DPAPI') {
        this.memory.delete(memKey);
        await this.pruneStaleSecretFiles(dir, secretFileName(nextRevision), true, false).catch(() => {});
      } else if (nextStorage === 'MEMORY' && nextSecret) {
        this.memory.set(memKey, nextSecret);
        await this.pruneStaleSecretFiles(dir, null, true, false).catch(() => {});
      } else {
        this.memory.delete(memKey);
        await this.pruneStaleSecretFiles(dir, null, true, true);
      }

      return {
        stored: nextConfig,
        publicConfig: this.buildPublicConfig(accountId, platform, null, nextConfig),
      };
    });
  }

  loadSecret(accountId: AccountId, platform: OfficialApiPlatformId): Promise<Readonly<OfficialChannelSecretPayload>> {
    return this.sequence(async () => {
      const stored = this.readStoredConfigSync(accountId, platform);
      requireSafe(stored && stored.storage !== 'NONE', 'CHANNEL_CREDENTIAL_REQUIRED');
      if (stored.storage === 'MEMORY') {
        const mem = this.memory.get(this.memoryKey(accountId, platform));
        requireSafe(mem && mem.platform === platform, 'CHANNEL_CREDENTIAL_REQUIRED');
        return mem;
      }
      const dir = this.accountDir(accountId, false);
      requireSafe(dir, 'DPAPI_RESTORE_FAILED');
      return this.unprotectFile(join(dir, secretFileName(stored.secretRevision)), { accountId, platform });
    });
  }

  deleteAccount(accountId: AccountId, strict = true): Promise<void> {
    return this.sequence(async () => {
      this.memory.delete(this.memoryKey(accountId, WECOM_AIBOT_PLATFORM_ID));
      this.memory.delete(this.memoryKey(accountId, WECHAT_KF_PLATFORM_ID));
      const dir = this.accountDir(accountId, false);
      if (!dir) return;
      await this.pruneStaleSecretFiles(dir, null, true, strict);
      const configFile = join(dir, 'config.json');
      if (statIfPresent(configFile)) removePrivateFile(configFile);
      try { rmdirSync(dir); } catch { /* ignore non-empty or already removed */ }
    });
  }

  async cleanupAccounts(accountIds: readonly AccountId[]): Promise<void> {
    for (const accountId of accountIds) {
      await this.deleteAccount(accountId, false).catch(() => {});
    }
  }
}
