import { createHash, randomUUID, type Hash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { appendFile, mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { detectImageMimeType } from "../ai/vision-input.js";
import {
  MAX_MEDIA_CHUNK_CHARS,
  mediaAssetMimeTypeSchema,
  mediaAssetSummarySchema,
  type MediaAssetMimeType,
  type MediaAssetSummary,
} from "../contracts/ai-runtime.js";
import { Blocked, requireSafe } from "../core/contracts.js";

export const MAX_MEDIA_ASSET_BYTES = 5 * 1024 * 1024;
const TABLE = "local_media_assets";
const SAFE_FILE_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|webp)$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const UPLOAD_TTL_MS = 10 * 60_000;
const MAX_ACTIVE_UPLOADS = 32;

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS local_media_assets (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png','image/jpeg','image/webp')),
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  file_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;`;

const MIME_EXTENSIONS: Readonly<Record<MediaAssetMimeType, "png" | "jpg" | "webp">> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

interface MediaAssetRow {
  id: string;
  account_id: string;
  name: string;
  mime_type: MediaAssetMimeType;
  bytes: number;
  sha256: string;
  file_name: string;
  created_at: number;
}

interface UploadSession {
  uploadId: string;
  accountId: string;
  mediaDir: string;
  tempPath: string;
  name: string;
  mimeType: MediaAssetMimeType;
  expectedBytes: number;
  expectedSha256: string;
  nextIndex: number;
  receivedBytes: number;
  hasher: Hash;
  createdAt: number;
  expiresAt: number;
}

const activeUploads = new Map<string, UploadSession>();

export interface VerifiedMediaAsset {
  summary: MediaAssetSummary;
  bytes: Uint8Array;
  filePath: string;
}

function decodeBase64Chunk(raw: string, allowDataPrefix: boolean): Buffer {
  let payload = raw.trim();
  if (allowDataPrefix && payload.startsWith("data:")) {
    const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/iu.exec(payload);
    if (!match) throw new Blocked("MEDIA_ASSET_INVALID");
    payload = match[1]!;
  }
  const compact = payload.replace(/\s+/gu, "");
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/u.test(compact) || compact.length % 4 !== 0) {
    throw new Blocked("MEDIA_ASSET_INVALID");
  }
  const bytes = Buffer.from(compact, "base64");
  if (bytes.byteLength === 0) throw new Blocked("MEDIA_ASSET_INVALID");
  return bytes;
}

function toSummary(row: MediaAssetRow): MediaAssetSummary {
  return mediaAssetSummarySchema.parse({
    id: row.id,
    name: row.name,
    mimeType: row.mime_type,
    bytes: row.bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
  });
}

/** Local reply media asset store under `<root>/media-assets/` backed by lazy table `local_media_assets`. */
export class MediaAssetStore {
  readonly mediaDir: string;

  constructor(
    private readonly db: Database.Database,
    private readonly accountId: string,
    root: string,
    private readonly now: () => number = Date.now,
    private readonly unlinkFile: (path: string) => Promise<void> = unlink,
  ) {
    requireSafe(root && !root.startsWith("synthetic://"), "MEDIA_ASSET_INVALID");
    this.mediaDir = resolve(root, "media-assets");
  }

  private hasTable(): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name=?").get(TABLE),
    );
  }

  private safeAssetPath(fileName: string): string {
    if (!SAFE_FILE_NAME_RE.test(fileName) || basename(fileName) !== fileName) {
      throw new Blocked("MEDIA_ASSET_INVALID");
    }
    const target = resolve(this.mediaDir, fileName);
    if (dirname(target) !== this.mediaDir) {
      throw new Blocked("MEDIA_ASSET_INVALID");
    }
    return target;
  }

  private assertNotSymlink(path: string): void {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Blocked("MEDIA_ASSET_INVALID");
    }
  }

  private async ensureMediaDir(): Promise<void> {
    await mkdir(this.mediaDir, { recursive: true, mode: 0o700 });
    const dirStats = lstatSync(this.mediaDir);
    requireSafe(!dirStats.isSymbolicLink() && dirStats.isDirectory(), "MEDIA_ASSET_INVALID");
  }

  private insertAssetRecord(
    id: string,
    name: string,
    mimeType: MediaAssetMimeType,
    bytes: number,
    sha256: string,
    fileName: string,
    createdAt: number,
  ): void {
    this.db.transaction(() => {
      this.db.exec(CREATE_TABLE_SQL);
      this.db
        .prepare(
          `INSERT INTO local_media_assets (id, account_id, name, mime_type, bytes, sha256, file_name, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, this.accountId, name, mimeType, bytes, sha256, fileName, createdAt);
    }).immediate();
  }

  private async pruneExpiredUploads(): Promise<void> {
    const now = this.now();
    for (const [id, session] of activeUploads) {
      if (session.expiresAt <= now) {
        activeUploads.delete(id);
        await rm(session.tempPath, { force: true }).catch(() => {});
      }
    }
    this.sweepOrphanedTempFiles();
  }

  private sweepOrphanedTempFiles(): void {
    if (!existsSync(this.mediaDir)) return;
    try {
      const dirStats = lstatSync(this.mediaDir);
      if (dirStats.isSymbolicLink() || !dirStats.isDirectory()) return;
      const cutoff = this.now() - UPLOAD_TTL_MS;
      for (const entry of readdirSync(this.mediaDir)) {
        if (!entry.startsWith(".tmp-")) continue;
        const uploadId = entry.slice(5);
        const session = activeUploads.get(uploadId);
        if (session && session.expiresAt > this.now()) continue;
        const full = join(this.mediaDir, entry);
        try {
          const stat = lstatSync(full);
          if (!stat.isSymbolicLink() && stat.isFile() && stat.mtimeMs < cutoff) {
            rmSync(full, { force: true });
          }
        } catch {
          /* ignore per-file sweep errors */
        }
      }
    } catch {
      /* ignore sweep errors */
    }
  }

  /** Pure read-only listing; returns empty list without creating table when absent. */
  list(): MediaAssetSummary[] {
    this.sweepOrphanedTempFiles();
    if (!this.hasTable()) return [];
    const rows = this.db
      .prepare(
        `SELECT id, account_id, name, mime_type, bytes, sha256, file_name, created_at
         FROM local_media_assets WHERE account_id=? ORDER BY created_at DESC, rowid DESC`,
      )
      .all(this.accountId) as MediaAssetRow[];
    return rows.map(toSummary);
  }

  get(assetId: string): (MediaAssetSummary & { filePath: string }) | null {
    if (!this.hasTable()) return null;
    const row = this.db
      .prepare(
        `SELECT id, account_id, name, mime_type, bytes, sha256, file_name, created_at
         FROM local_media_assets WHERE id=? AND account_id=?`,
      )
      .get(assetId, this.accountId) as MediaAssetRow | undefined;
    if (!row) return null;
    return { ...toSummary(row), filePath: this.safeAssetPath(row.file_name) };
  }

  async save(input: { name: string; base64: string }): Promise<MediaAssetSummary> {
    const cleanName = input.name.trim();
    requireSafe(cleanName.length > 0 && cleanName.length <= 120, "MEDIA_ASSET_INVALID");
    const bytes = decodeBase64Chunk(input.base64, true);
    if (bytes.byteLength > MAX_MEDIA_ASSET_BYTES) {
      throw new Blocked("MEDIA_ASSET_TOO_LARGE");
    }
    const mimeType = detectImageMimeType(bytes);
    if (!mimeType) {
      throw new Blocked("MEDIA_ASSET_INVALID");
    }

    const id = randomUUID();
    const fileName = `${id}.${MIME_EXTENSIONS[mimeType]}`;
    const target = this.safeAssetPath(fileName);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const createdAt = this.now();

    await this.ensureMediaDir();
    const tempPath = join(this.mediaDir, `.tmp-${id}`);
    try {
      await writeFile(tempPath, bytes, { mode: 0o600 });
      await rename(tempPath, target);
      this.insertAssetRecord(id, cleanName, mimeType, bytes.byteLength, sha256, fileName, createdAt);
    } catch (error) {
      await rm(target, { force: true }).catch(() => {});
      throw error;
    } finally {
      await rm(tempPath, { force: true }).catch(() => {});
    }

    return { id, name: cleanName, mimeType, bytes: bytes.byteLength, sha256, createdAt };
  }

  async startUpload(input: {
    name: string;
    mimeType: MediaAssetMimeType;
    bytes: number;
    sha256: string;
  }): Promise<{ uploadId: string; chunkLimit: number }> {
    const cleanName = input.name.trim();
    requireSafe(cleanName.length > 0 && cleanName.length <= 120, "MEDIA_ASSET_INVALID");
    requireSafe(mediaAssetMimeTypeSchema.safeParse(input.mimeType).success, "MEDIA_ASSET_INVALID");
    requireSafe(Number.isSafeInteger(input.bytes) && input.bytes > 0, "MEDIA_ASSET_INVALID");
    if (input.bytes > MAX_MEDIA_ASSET_BYTES) {
      throw new Blocked("MEDIA_ASSET_TOO_LARGE");
    }
    requireSafe(SHA256_RE.test(input.sha256), "MEDIA_ASSET_INVALID");

    await this.pruneExpiredUploads();
    requireSafe(activeUploads.size < MAX_ACTIVE_UPLOADS, "MEDIA_ASSET_INVALID");
    await this.ensureMediaDir();

    const uploadId = randomUUID();
    const tempPath = join(this.mediaDir, `.tmp-${uploadId}`);
    try {
      await writeFile(tempPath, Buffer.alloc(0), { mode: 0o600 });
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }

    const createdAt = this.now();
    activeUploads.set(uploadId, {
      uploadId,
      accountId: this.accountId,
      mediaDir: this.mediaDir,
      tempPath,
      name: cleanName,
      mimeType: input.mimeType,
      expectedBytes: input.bytes,
      expectedSha256: input.sha256,
      nextIndex: 0,
      receivedBytes: 0,
      hasher: createHash("sha256"),
      createdAt,
      expiresAt: createdAt + UPLOAD_TTL_MS,
    });
    return { uploadId, chunkLimit: MAX_MEDIA_CHUNK_CHARS };
  }

  async appendUploadChunk(input: {
    uploadId: string;
    index: number;
    data: string;
  }): Promise<{ uploadId: string; index: number; receivedBytes: number }> {
    const session = activeUploads.get(input.uploadId);
    requireSafe(
      session && session.accountId === this.accountId && session.mediaDir === this.mediaDir,
      "MEDIA_ASSET_NOT_FOUND",
    );

    const dropSession = async () => {
      activeUploads.delete(input.uploadId);
      await rm(session.tempPath, { force: true }).catch(() => {});
    };

    if (this.now() > session.expiresAt) {
      await dropSession();
      throw new Blocked("MEDIA_UPLOAD_EXPIRED");
    }

    if (input.index !== session.nextIndex || input.data.length > MAX_MEDIA_CHUNK_CHARS) {
      await dropSession();
      throw new Blocked("MEDIA_ASSET_INVALID");
    }

    let chunk: Buffer;
    try {
      chunk = decodeBase64Chunk(input.data, false);
    } catch (error) {
      await dropSession();
      throw error;
    }

    if (session.receivedBytes + chunk.byteLength > MAX_MEDIA_ASSET_BYTES) {
      await dropSession();
      throw new Blocked("MEDIA_ASSET_TOO_LARGE");
    }
    if (session.receivedBytes + chunk.byteLength > session.expectedBytes) {
      await dropSession();
      throw new Blocked("MEDIA_ASSET_INVALID");
    }

    try {
      await appendFile(session.tempPath, chunk);
    } catch (error) {
      await dropSession();
      throw error;
    }

    session.hasher.update(chunk);
    session.receivedBytes += chunk.byteLength;
    session.nextIndex++;
    return { uploadId: input.uploadId, index: input.index, receivedBytes: session.receivedBytes };
  }

  async finishUpload(input: { uploadId: string }): Promise<MediaAssetSummary> {
    const session = activeUploads.get(input.uploadId);
    requireSafe(
      session && session.accountId === this.accountId && session.mediaDir === this.mediaDir,
      "MEDIA_ASSET_NOT_FOUND",
    );
    activeUploads.delete(input.uploadId);

    const id = randomUUID();
    const fileName = `${id}.${MIME_EXTENSIONS[session.mimeType]}`;
    const target = this.safeAssetPath(fileName);
    const createdAt = this.now();

    try {
      requireSafe(createdAt <= session.expiresAt, "MEDIA_UPLOAD_EXPIRED");
      requireSafe(session.receivedBytes === session.expectedBytes, "MEDIA_ASSET_INVALID");
      requireSafe(session.hasher.digest("hex") === session.expectedSha256, "MEDIA_ASSET_INVALID");
      this.assertNotSymlink(session.tempPath);
      const bytes = readFileSync(session.tempPath);
      requireSafe(bytes.byteLength === session.expectedBytes, "MEDIA_ASSET_INVALID");
      requireSafe(detectImageMimeType(bytes) === session.mimeType, "MEDIA_ASSET_INVALID");
      const actualSha256 = createHash("sha256").update(bytes).digest("hex");
      requireSafe(actualSha256 === session.expectedSha256, "MEDIA_ASSET_INVALID");

      await rename(session.tempPath, target);
      try {
        this.insertAssetRecord(
          id,
          session.name,
          session.mimeType,
          bytes.byteLength,
          actualSha256,
          fileName,
          createdAt,
        );
      } catch (error) {
        await rm(target, { force: true }).catch(() => {});
        throw error;
      }

      return {
        id,
        name: session.name,
        mimeType: session.mimeType,
        bytes: bytes.byteLength,
        sha256: actualSha256,
        createdAt,
      };
    } finally {
      await rm(session.tempPath, { force: true }).catch(() => {});
    }
  }

  verifyAsset(assetId: string, expectedDigest: string): VerifiedMediaAsset {
    const record = this.get(assetId);
    if (!record) {
      throw new Blocked("MEDIA_ASSET_NOT_FOUND");
    }
    let bytes: Buffer;
    try {
      this.assertNotSymlink(record.filePath);
      bytes = readFileSync(record.filePath);
    } catch (error) {
      if (error instanceof Blocked) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Blocked("MEDIA_ASSET_NOT_FOUND");
      }
      throw new Blocked("MEDIA_ASSET_INVALID");
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_MEDIA_ASSET_BYTES || bytes.byteLength !== record.bytes) {
      throw new Blocked("MEDIA_ASSET_INVALID");
    }
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (actualSha256 !== record.sha256 || actualSha256 !== expectedDigest) {
      throw new Blocked("MEDIA_ASSET_INVALID");
    }
    if (detectImageMimeType(bytes) !== record.mimeType) {
      throw new Blocked("MEDIA_ASSET_INVALID");
    }
    const { filePath, ...summary } = record;
    return { summary, bytes: new Uint8Array(bytes), filePath };
  }

  async delete(assetId: string): Promise<{ deleted: true; assetId: string }> {
    const record = this.get(assetId);
    if (!record) {
      throw new Blocked("MEDIA_ASSET_NOT_FOUND");
    }
    try {
      await this.unlinkFile(record.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Blocked("MEDIA_ASSET_DELETE_FAILED");
      }
    }
    this.db.transaction(() => {
      const changes = this.db
        .prepare("DELETE FROM local_media_assets WHERE id=? AND account_id=?")
        .run(assetId, this.accountId).changes;
      requireSafe(changes === 1, "MEDIA_ASSET_NOT_FOUND");
    }).immediate();
    return { deleted: true, assetId };
  }
}
