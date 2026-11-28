import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { detectImageMimeType } from '../ai/vision-input.js';
import { assertPrivateRuntimeRoot } from '../config/runtime.js';
import { accountIdSchema } from '../contracts/account.js';
import {
  AVATAR_CACHE_MAX_ENTRIES,
  AVATAR_MAX_BYTES,
  AVATAR_MAX_DATA_URL_BYTES,
  avatarRoleSchema,
  type AvatarPreviewResult,
  type AvatarRole,
} from '../contracts/avatar.js';
import { Blocked, requireSafe } from '../core/contracts.js';
import { AccountAiFeaturesStore } from '../storage/account-ai-features.js';

const ENTRY_FILE_RE = /^[a-f0-9]{64}$/u;
const EMPTY_PREVIEW: AvatarPreviewResult = {
  found: false,
  dataUrl: null,
  mimeType: null,
  bytes: 0,
  sha256: null,
};

let monotonicStampMs = 0;
const accountSaveQueues = new Map<string, Promise<unknown>>();
const accessRecencyByDir = new Map<string, Map<string, number>>();

function nextStampMs(): number {
  monotonicStampMs = Math.max(Date.now(), monotonicStampMs + 1);
  return monotonicStampMs;
}

function recordAccessRecency(accountDir: string, entryDigest: string, stamp: number): void {
  let map = accessRecencyByDir.get(accountDir);
  if (!map) {
    map = new Map();
    accessRecencyByDir.set(accountDir, map);
  }
  map.delete(entryDigest);
  map.set(entryDigest, stamp);
  while (map.size > AVATAR_CACHE_MAX_ENTRIES * 2) {
    const oldest = map.keys().next().value;
    if (!oldest) break;
    map.delete(oldest);
  }
}

function enqueueAccountOp<T>(accountDir: string, operation: () => Promise<T>): Promise<T> {
  const prev = accountSaveQueues.get(accountDir) ?? Promise.resolve();
  const next = prev.then(operation, operation);
  const cleanup = next.then(() => undefined, () => undefined);
  accountSaveQueues.set(accountDir, cleanup);
  void cleanup.finally(() => {
    if (accountSaveQueues.get(accountDir) === cleanup) {
      accountSaveQueues.delete(accountDir);
    }
  });
  return next;
}

function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

function validateRuntimeRootPath(runtimeRoot: string): string {
  requireSafe(
    typeof runtimeRoot === 'string'
      && runtimeRoot.trim().length > 0
      && !runtimeRoot.includes('\0')
      && !runtimeRoot.startsWith('synthetic://')
      && !runtimeRoot.startsWith('official-api://'),
    'AVATAR_CACHE_INVALID_PATH',
  );
  return assertPrivateRuntimeRoot(runtimeRoot);
}

function assertRealDirectory(dirPath: string): void {
  const stats = lstatSync(dirPath);
  requireSafe(!stats.isSymbolicLink() && stats.isDirectory(), 'AVATAR_CACHE_INVALID_PATH');
}

function isRealDirectory(dirPath: string): boolean {
  if (!existsSync(dirPath)) return false;
  try {
    const stats = lstatSync(dirPath);
    return !stats.isSymbolicLink() && stats.isDirectory();
  } catch {
    return false;
  }
}

export interface SavedAvatarMeta {
  role: AvatarRole;
  key: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  bytes: number;
  sha256: string;
}

export interface ReadOnlyAvatarStore {
  db: Database.Database;
  accountId: string;
}

/** Private, read-isolated avatar cache under `<runtimeRoot>/avatars/<sha256(accountId)>/`. */
export class AvatarCacheStore {
  readonly runtimeRoot: string;
  readonly avatarsRoot: string;

  constructor(runtimeRoot: string) {
    this.runtimeRoot = validateRuntimeRootPath(runtimeRoot);
    this.avatarsRoot = resolve(this.runtimeRoot, 'avatars');
  }

  private accountDir(accountId: string): string {
    requireSafe(accountIdSchema.safeParse(accountId).success, 'INVALID_ACCOUNT_ID');
    const accountDigest = sha256Hex(accountId);
    const target = resolve(this.avatarsRoot, accountDigest);
    requireSafe(dirname(target) === this.avatarsRoot, 'AVATAR_CACHE_INVALID_PATH');
    return target;
  }

  private entryInfo(accountDir: string, role: AvatarRole, key: string): { path: string; digest: string } {
    requireSafe(avatarRoleSchema.safeParse(role).success, 'AVATAR_INVALID_KEY');
    requireSafe(typeof key === 'string' && key.length >= 1 && key.length <= 256, 'AVATAR_INVALID_KEY');
    const entryDigest = sha256Hex(`${role}\0${key}`);
    const target = resolve(accountDir, entryDigest);
    requireSafe(dirname(target) === accountDir && ENTRY_FILE_RE.test(entryDigest), 'AVATAR_CACHE_INVALID_PATH');
    return { path: target, digest: entryDigest };
  }

  private async ensureAccountDir(accountDir: string): Promise<void> {
    validateRuntimeRootPath(this.runtimeRoot);
    await mkdir(this.avatarsRoot, { recursive: true, mode: 0o700 });
    assertRealDirectory(this.avatarsRoot);
    await mkdir(accountDir, { recursive: true, mode: 0o700 });
    assertRealDirectory(accountDir);
  }

  private async enforceLruCap(accountDir: string): Promise<void> {
    const recencyMap = accessRecencyByDir.get(accountDir);
    const entries: { path: string; name: string; score: number }[] = [];
    for (const name of readdirSync(accountDir)) {
      if (!ENTRY_FILE_RE.test(name)) continue;
      const full = join(accountDir, name);
      try {
        const stats = lstatSync(full);
        if (stats.isSymbolicLink() || !stats.isFile()) continue;
        const score = Math.max(stats.mtimeMs, recencyMap?.get(name) ?? 0);
        entries.push({ path: full, name, score });
      } catch {
        /* ignore disappearing cache entry */
      }
    }
    if (entries.length <= AVATAR_CACHE_MAX_ENTRIES) return;
    entries.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
    const excess = entries.length - AVATAR_CACHE_MAX_ENTRIES;
    for (let i = 0; i < excess; i++) {
      const victim = entries[i]!;
      await rm(victim.path, { force: true }).catch(() => {});
      recencyMap?.delete(victim.name);
    }
  }

  async saveAvatar(
    accountId: string,
    role: AvatarRole,
    key: string,
    bytes: Uint8Array,
    syncCustomerAvatars: boolean,
  ): Promise<SavedAvatarMeta> {
    if (role === 'CUSTOMER' && !syncCustomerAvatars) {
      throw new Blocked('AVATAR_SYNC_DISABLED');
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw new Blocked('AVATAR_INVALID_FORMAT');
    }
    if (bytes.byteLength > AVATAR_MAX_BYTES) {
      throw new Blocked('AVATAR_TOO_LARGE');
    }
    const mimeType = detectImageMimeType(bytes);
    if (!mimeType) {
      throw new Blocked('AVATAR_INVALID_FORMAT');
    }
    const sha256 = sha256Hex(bytes);
    const dataUrl = `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
    if (Buffer.byteLength(dataUrl, 'utf8') > AVATAR_MAX_DATA_URL_BYTES) {
      throw new Blocked('AVATAR_TOO_LARGE');
    }

    const dir = this.accountDir(accountId);
    const entry = this.entryInfo(dir, role, key);

    return enqueueAccountOp(dir, async () => {
      await this.ensureAccountDir(dir);
      const tempPath = join(dir, `.tmp-${randomUUID()}`);
      try {
        await writeFile(tempPath, bytes, { mode: 0o600 });
        const stamp = nextStampMs();
        const stampSec = stamp / 1000;
        await utimes(tempPath, stampSec, stampSec);
        await rename(tempPath, entry.path);
        recordAccessRecency(dir, entry.digest, stamp);
      } catch (error) {
        await rm(tempPath, { force: true }).catch(() => {});
        throw error;
      }

      await this.enforceLruCap(dir);
      return { role, key, mimeType, bytes: bytes.byteLength, sha256 };
    });
  }

  /** Pure read-only preview lookup; enforces sync gate (default false for CUSTOMER), magic bytes, bounds, and junction/symlink isolation. */
  readPreview(
    accountId: string,
    role: AvatarRole,
    key: string,
    syncCustomerAvatars = false,
  ): AvatarPreviewResult {
    if (role === 'CUSTOMER' && !syncCustomerAvatars) return { ...EMPTY_PREVIEW };
    if (!accountIdSchema.safeParse(accountId).success) return { ...EMPTY_PREVIEW };
    if (!avatarRoleSchema.safeParse(role).success) return { ...EMPTY_PREVIEW };
    if (typeof key !== 'string' || key.length < 1 || key.length > 256) return { ...EMPTY_PREVIEW };
    try {
      validateRuntimeRootPath(this.runtimeRoot);
    } catch {
      return { ...EMPTY_PREVIEW };
    }
    if (!isRealDirectory(this.avatarsRoot)) return { ...EMPTY_PREVIEW };

    const dir = this.accountDir(accountId);
    if (!isRealDirectory(dir)) return { ...EMPTY_PREVIEW };

    const entry = this.entryInfo(dir, role, key);
    if (!existsSync(entry.path)) return { ...EMPTY_PREVIEW };

    let bytes: Buffer;
    try {
      const stats = lstatSync(entry.path);
      if (stats.isSymbolicLink() || !stats.isFile()) return { ...EMPTY_PREVIEW };
      if (stats.size <= 0 || stats.size > AVATAR_MAX_BYTES) return { ...EMPTY_PREVIEW };
      bytes = readFileSync(entry.path);
    } catch {
      return { ...EMPTY_PREVIEW };
    }

    if (bytes.byteLength === 0 || bytes.byteLength > AVATAR_MAX_BYTES) return { ...EMPTY_PREVIEW };
    const mimeType = detectImageMimeType(bytes);
    if (!mimeType) return { ...EMPTY_PREVIEW };

    const dataUrl = `data:${mimeType};base64,${bytes.toString('base64')}`;
    if (Buffer.byteLength(dataUrl, 'utf8') > AVATAR_MAX_DATA_URL_BYTES) return { ...EMPTY_PREVIEW };

    recordAccessRecency(dir, entry.digest, nextStampMs());
    return {
      found: true,
      dataUrl,
      mimeType,
      bytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
    };
  }
}

export function readAccountAvatarPreview(
  store: ReadOnlyAvatarStore,
  role: AvatarRole,
  key: string,
): AvatarPreviewResult {
  const dbPath = store.db.name;
  if (!dbPath || dbPath === ':memory:') return { ...EMPTY_PREVIEW };
  const syncCustomerAvatars = role === 'CUSTOMER'
    ? new AccountAiFeaturesStore(store.db, store.accountId).get().syncCustomerAvatars
    : true;
  if (role === 'CUSTOMER' && !syncCustomerAvatars) return { ...EMPTY_PREVIEW };
  return new AvatarCacheStore(dirname(dbPath)).readPreview(store.accountId, role, key, syncCustomerAvatars);
}

/** Offline-safe avatar ingestion helper for account/observation flows when validated image bytes are supplied. */
export async function ingestCachedAvatar(
  store: ReadOnlyAvatarStore,
  input: { role: AvatarRole; key: string; bytes: Uint8Array },
): Promise<{ saved: true; meta: SavedAvatarMeta } | { saved: false; reason: string }> {
  const dbPath = store.db.name;
  if (!dbPath || dbPath === ':memory:') return { saved: false, reason: 'AVATAR_CACHE_UNAVAILABLE' };
  const syncCustomerAvatars = input.role === 'CUSTOMER'
    ? new AccountAiFeaturesStore(store.db, store.accountId).get().syncCustomerAvatars
    : true;
  try {
    const meta = await new AvatarCacheStore(dirname(dbPath)).saveAvatar(
      store.accountId,
      input.role,
      input.key,
      input.bytes,
      syncCustomerAvatars,
    );
    return { saved: true, meta };
  } catch (error) {
    return { saved: false, reason: error instanceof Blocked ? error.code : 'AVATAR_SAVE_FAILED' };
  }
}
