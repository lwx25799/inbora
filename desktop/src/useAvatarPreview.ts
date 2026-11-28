import { useEffect, useState } from "react";
import { DEFAULT_ACCOUNT_ID } from "../../src/contracts/account.js";
import {
  AVATAR_MAX_DATA_URL_BYTES,
  type AvatarPreviewResult,
  type AvatarRole,
} from "../../src/contracts/avatar.js";
import {
  getActiveWorkbenchAccount,
  onAccountContextChanged,
  requestForAccount,
} from "./api";

export type { AvatarPreviewResult, AvatarRole };

export interface AvatarCacheResetFilter {
  role?: AvatarRole;
  accountRef?: string;
}

const AVATAR_MISS_TTL_MS = 30_000;
const DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const utf8Encoder = new TextEncoder();

interface AvatarCacheEntry {
  value: string | null;
  expiresAt: number | null;
}

interface InflightAvatarEntry {
  epoch: number;
  promise: Promise<string | null>;
}

interface CacheResetRegistration {
  matches: (filter?: AvatarCacheResetFilter) => boolean;
  onReset: () => void;
}

const avatarPreviewCache = new Map<string, AvatarCacheEntry>();
const inflightAvatarRequests = new Map<string, InflightAvatarEntry>();
const cacheResetListeners = new Set<CacheResetRegistration>();
let globalEpoch = 0;
const scopeEpochs = new Map<string, number>();

function scopeKey(accountRef: string, role: AvatarRole): string {
  return `${accountRef}:${role}`;
}

function getScopeEpoch(accountRef: string, role: AvatarRole): number {
  return globalEpoch * 1_000_000 + (scopeEpochs.get(scopeKey(accountRef, role)) ?? 0);
}

function bumpScopeEpoch(accountRef: string, role: AvatarRole): void {
  const key = scopeKey(accountRef, role);
  scopeEpochs.set(key, (scopeEpochs.get(key) ?? 0) + 1);
}

function parseCacheKey(cacheKey: string): { accountRef: string; role: AvatarRole } | null {
  const firstColon = cacheKey.indexOf(":");
  if (firstColon <= 0) return null;
  const secondColon = cacheKey.indexOf(":", firstColon + 1);
  if (secondColon <= firstColon + 1) return null;
  const accountRef = cacheKey.slice(0, firstColon);
  const role = cacheKey.slice(firstColon + 1, secondColon);
  if (role !== "ACCOUNT" && role !== "CUSTOMER") return null;
  return { accountRef, role };
}

function matchesFilter(
  accountRef: string,
  role: AvatarRole,
  filter?: AvatarCacheResetFilter,
): boolean {
  if (!filter) return true;
  if (filter.role && filter.role !== role) return false;
  if (filter.accountRef && filter.accountRef !== accountRef) return false;
  return true;
}

export function sanitizeAvatarDataUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("data:image/")) return null;
  if (!DATA_IMAGE_RE.test(trimmed)) return null;
  if (utf8Encoder.encode(trimmed).byteLength > AVATAR_MAX_DATA_URL_BYTES) return null;
  return trimmed;
}

export function buildAvatarCacheKey(
  accountRef: string,
  role: AvatarRole,
  key: string,
): string {
  return `${accountRef}:${role}:${key}`;
}

export function resetAvatarPreviewCache(filter?: AvatarCacheResetFilter): void {
  if (!filter || (!filter.role && !filter.accountRef)) {
    globalEpoch += 1;
    scopeEpochs.clear();
    avatarPreviewCache.clear();
    inflightAvatarRequests.clear();
  } else {
    if (filter.accountRef && filter.role) {
      bumpScopeEpoch(filter.accountRef, filter.role);
    } else if (filter.accountRef) {
      bumpScopeEpoch(filter.accountRef, "ACCOUNT");
      bumpScopeEpoch(filter.accountRef, "CUSTOMER");
    } else if (filter.role) {
      // Bump epoch for all known accounts holding entries of that role.
      const seenAccounts = new Set<string>([DEFAULT_ACCOUNT_ID]);
      for (const k of [...avatarPreviewCache.keys(), ...inflightAvatarRequests.keys()]) {
        const parsed = parseCacheKey(k);
        if (parsed) seenAccounts.add(parsed.accountRef);
      }
      for (const acc of seenAccounts) bumpScopeEpoch(acc, filter.role);
    }

    for (const cacheKey of [...avatarPreviewCache.keys()]) {
      const parsed = parseCacheKey(cacheKey);
      if (parsed && matchesFilter(parsed.accountRef, parsed.role, filter)) {
        avatarPreviewCache.delete(cacheKey);
      }
    }
    for (const cacheKey of [...inflightAvatarRequests.keys()]) {
      const parsed = parseCacheKey(cacheKey);
      if (parsed && matchesFilter(parsed.accountRef, parsed.role, filter)) {
        inflightAvatarRequests.delete(cacheKey);
      }
    }
  }

  for (const reg of cacheResetListeners) {
    if (reg.matches(filter)) reg.onReset();
  }
}

export function clearAvatarPreviewCache(roleFilter?: AvatarRole): void {
  resetAvatarPreviewCache(roleFilter ? { role: roleFilter } : undefined);
}

onAccountContextChanged(() => {
  resetAvatarPreviewCache();
});

export function resolveAvatarAccountRef(accountRef?: string | null): string {
  const explicit = accountRef?.trim();
  if (explicit) return explicit;
  return getActiveWorkbenchAccount()?.accountRef ?? DEFAULT_ACCOUNT_ID;
}

function readValidCacheEntry(cacheKey: string, now: number): AvatarCacheEntry | null {
  const entry = avatarPreviewCache.get(cacheKey);
  if (!entry) return null;
  if (entry.expiresAt !== null && now >= entry.expiresAt) {
    avatarPreviewCache.delete(cacheKey);
    return null;
  }
  return entry;
}

export function useAvatarPreview(
  role: AvatarRole,
  key: string | null | undefined,
  accountRef?: string | null,
): string | null {
  const trimmedKey = key?.trim() ?? "";
  const effectiveAccountRef = resolveAvatarAccountRef(accountRef);
  const cacheKey = trimmedKey
    ? buildAvatarCacheKey(effectiveAccountRef, role, trimmedKey)
    : "";

  const [resetSeq, setResetSeq] = useState(0);
  const [missRetryTick, setMissRetryTick] = useState(0);
  const [dataUrl, setDataUrl] = useState<string | null>(() =>
    cacheKey ? (readValidCacheEntry(cacheKey, Date.now())?.value ?? null) : null,
  );

  useEffect(() => {
    const registration: CacheResetRegistration = {
      matches: (filter) => matchesFilter(effectiveAccountRef, role, filter),
      onReset: () => {
        setDataUrl(null);
        setResetSeq((n) => n + 1);
      },
    };
    cacheResetListeners.add(registration);
    return () => {
      cacheResetListeners.delete(registration);
    };
  }, [effectiveAccountRef, role]);

  useEffect(() => {
    if (!cacheKey || !trimmedKey) {
      setDataUrl(null);
      return;
    }

    let active = true;
    let missTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleMissRetry = (expiresAt: number) => {
      if (!active || missTimer !== null) return;
      const delayMs = Math.max(0, expiresAt - Date.now());
      missTimer = setTimeout(() => {
        missTimer = null;
        if (active) setMissRetryTick((n) => n + 1);
      }, delayMs);
    };

    const cached = readValidCacheEntry(cacheKey, Date.now());
    if (cached) {
      setDataUrl(cached.value);
      if (cached.value === null && cached.expiresAt !== null) {
        scheduleMissRetry(cached.expiresAt);
      }
      return () => {
        active = false;
        if (missTimer !== null) clearTimeout(missTimer);
      };
    }

    setDataUrl(null);
    const hookEpoch = getScopeEpoch(effectiveAccountRef, role);

    let inflight = inflightAvatarRequests.get(cacheKey);
    if (!inflight || inflight.epoch !== hookEpoch) {
      const requestEpoch = hookEpoch;
      const promise = requestForAccount<AvatarPreviewResult>(effectiveAccountRef, {
        command: "getAvatarPreview",
        role,
        key: trimmedKey,
      })
        .then((result) => {
          const valid = result?.found === true ? sanitizeAvatarDataUrl(result.dataUrl) : null;
          if (getScopeEpoch(effectiveAccountRef, role) === requestEpoch) {
            avatarPreviewCache.set(cacheKey, {
              value: valid,
              expiresAt: valid === null ? Date.now() + AVATAR_MISS_TTL_MS : null,
            });
          }
          return valid;
        })
        .catch(() => null)
        .finally(() => {
          const currentInflight = inflightAvatarRequests.get(cacheKey);
          if (
            currentInflight &&
            currentInflight.epoch === requestEpoch &&
            currentInflight.promise === promise
          ) {
            inflightAvatarRequests.delete(cacheKey);
          }
        });
      inflight = { epoch: requestEpoch, promise };
      inflightAvatarRequests.set(cacheKey, inflight);
    }

    void inflight.promise.then((resolved) => {
      if (!active || getScopeEpoch(effectiveAccountRef, role) !== hookEpoch) return;
      setDataUrl(resolved);
      if (resolved === null) {
        const stored = avatarPreviewCache.get(cacheKey);
        const expiresAt = stored?.expiresAt ?? Date.now() + AVATAR_MISS_TTL_MS;
        scheduleMissRetry(expiresAt);
      }
    });

    return () => {
      active = false;
      if (missTimer !== null) clearTimeout(missTimer);
    };
  }, [cacheKey, effectiveAccountRef, missRetryTick, resetSeq, role, trimmedKey]);

  return dataUrl;
}
