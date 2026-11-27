import { useLayoutEffect, useRef, useState } from 'react';
import {
  accountRegistrationUnconfirmed,
  BILIBILI_PLATFORM_ID,
  listAccountsV2,
  mockRegistrationAccountRef,
  registerWebAccountV2,
  XIAOHONGSHU_PLATFORM_ID,
  type WebBrowserPlatformId,
} from './api';
import { explainSafe, extractErrorCode } from './error-messages';

const labelCls = 'flex flex-col gap-1.5 text-xs font-medium text-foreground';
const hintCls = 'hint text-xs leading-relaxed text-muted-foreground';
const inputCls = 'h-8.5 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-[13px] text-foreground shadow-xs/5 outline-none transition-shadow placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/32';
const btnOutlineCls = 'inline-flex h-8 shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-lg border border-input bg-popover px-3 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55 dark:bg-input/32 dark:hover:bg-input/64';
const btnPrimaryCls = 'inline-flex h-8 shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-lg border border-primary bg-primary px-3 text-xs font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55';

export interface PendingWebRegistration {
  key: string;
  commandId: string;
  accountRef: string;
  platform: WebBrowserPlatformId;
  displayLabel: string;
  ownId: string;
}

// Retain unresolved registrations across form close/reopen remounts per runtime directory.
const pendingWebRegistrations = new Map<string, PendingWebRegistration>();
const pendingListeners = new Set<(runtime: string) => void>();

export function getPendingWebRegistration(runtime: string): PendingWebRegistration | undefined {
  return pendingWebRegistrations.get(runtime);
}

export function clearPendingWebRegistration(runtime: string): void {
  if (!pendingWebRegistrations.delete(runtime)) return;
  for (const listener of pendingListeners) listener(runtime);
}

export interface WebChannelCreatorProps {
  runtime?: string;
  disabled: boolean;
  onRegistered: (notice: string, accountRef: string) => Promise<void>;
  onClose: () => void;
}

function platformDisplayName(platform: WebBrowserPlatformId): string {
  return platform === XIAOHONGSHU_PLATFORM_ID ? '小红书' : 'B 站';
}

export function WebChannelCreator({
  runtime = 'default',
  disabled,
  onRegistered,
  onClose,
}: WebChannelCreatorProps) {
  const initialPending = pendingWebRegistrations.get(runtime) ?? null;
  const [platform, setPlatform] = useState<WebBrowserPlatformId>(
    initialPending?.platform ?? XIAOHONGSHU_PLATFORM_ID,
  );
  const [displayLabel, setDisplayLabel] = useState(initialPending?.displayLabel ?? '');
  const [ownId, setOwnId] = useState(initialPending?.ownId ?? '');
  const [pendingEntry, setPendingEntry] = useState<PendingWebRegistration | null>(initialPending);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);

  useLayoutEffect(() => {
    mounted.current = true;
    const onPendingChanged = (changedRuntime: string) => {
      if (!mounted.current || changedRuntime !== runtime) return;
      const nextPending = pendingWebRegistrations.get(runtime) ?? null;
      setPendingEntry(nextPending);
      if (!nextPending) {
        setDisplayLabel('');
        setOwnId('');
        setError('');
      }
    };
    pendingListeners.add(onPendingChanged);
    const unresolved = pendingWebRegistrations.get(runtime);
    if (unresolved) {
      void listAccountsV2()
        .then(accounts => {
          if (!mounted.current) return;
          const existing = accounts.find(account => account.accountRef === unresolved.accountRef);
          if (!existing) return;
          if (pendingWebRegistrations.get(runtime)?.commandId === unresolved.commandId) {
            pendingWebRegistrations.delete(runtime);
          }
          setPendingEntry(null);
          setDisplayLabel('');
          setOwnId('');
          const title = platformDisplayName(unresolved.platform);
          void onRegistered(
            `已确认${title}账号「${existing.displayLabel}」注册成功，新账号默认关闭自动回复。真实页面完成安全校准前仅支持本地离线验证。`,
            existing.accountRef,
          );
        })
        .catch(() => {
          // Keep unresolved entry so user can safely retry or refresh.
        });
    }
    return () => {
      mounted.current = false;
      pendingListeners.delete(onPendingChanged);
    };
  }, [runtime]);

  const isXiaohongshu = platform === XIAOHONGSHU_PLATFORM_ID;

  function switchPlatform(next: WebBrowserPlatformId) {
    if (next === platform) return;
    setPlatform(next);
    setError('');
  }

  function closePanel() {
    // Keep unresolved pendingWebRegistrations intact across close/reopen so retries cannot duplicate.
    onClose();
  }

  const canSubmit = !disabled && !submitting;
  const lockedPending = pendingEntry !== null;

  function discardPending() {
    if (submitting) return;
    pendingWebRegistrations.delete(runtime);
    setPendingEntry(null);
    setError('');
  }

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');

    const existingPending = pendingWebRegistrations.get(runtime) ?? pendingEntry;
    if (existingPending) {
      try {
        const accounts = await listAccountsV2();
        const committed = accounts.find(account => account.accountRef === existingPending.accountRef);
        if (committed) {
          pendingWebRegistrations.delete(runtime);
          if (mounted.current) {
            setPendingEntry(null);
            setDisplayLabel('');
            setOwnId('');
            await onRegistered(
              `已确认${platformDisplayName(existingPending.platform)}账号「${committed.displayLabel}」注册成功，新账号默认关闭自动回复。真实页面完成安全校准前仅支持本地离线验证。`,
              committed.accountRef,
            );
          }
          return;
        }
      } catch {
        // Even if listAccounts fails, keep locked onto existingPending.commandId so no duplicate can be minted.
      }
    }

    // Lock onto existingPending's original commandId & parameters until its outcome is definitive
    // (found via listAccountsV2, terminal rejection, or explicit user discard).
    const activePlatform = existingPending ? existingPending.platform : platform;
    const activeOwnId = existingPending ? existingPending.ownId : ownId.trim();
    const activePlatformTitle = platformDisplayName(activePlatform);
    const activeLabel = existingPending
      ? existingPending.displayLabel
      : (displayLabel.trim() || (activeOwnId ? `${activePlatformTitle} ${activeOwnId}` : `${activePlatformTitle}账号`));
    const registrationKey = existingPending
      ? existingPending.key
      : JSON.stringify([activePlatform, activeOwnId, activeLabel]);
    const commandId = existingPending ? existingPending.commandId : crypto.randomUUID();
    const nextPending: PendingWebRegistration = existingPending ?? {
      key: registrationKey,
      commandId,
      accountRef: mockRegistrationAccountRef(commandId),
      platform: activePlatform,
      displayLabel: activeLabel,
      ownId: activeOwnId,
    };
    pendingWebRegistrations.set(runtime, nextPending);

    try {
      const account = await registerWebAccountV2({
        commandId,
        platform: activePlatform,
        displayLabel: activeLabel,
        ...(activeOwnId ? { ownId: activeOwnId } : {}),
      });
      if (pendingWebRegistrations.get(runtime)?.commandId === commandId) {
        pendingWebRegistrations.delete(runtime);
      }
      if (mounted.current) {
        setPendingEntry(null);
        setDisplayLabel('');
        setOwnId('');
        await onRegistered(
          `已添加${activePlatformTitle}账号「${activeLabel}」，新账号默认关闭自动回复。真实页面完成安全校准前仅支持本地离线验证。`,
          account.accountRef,
        );
      }
    } catch (cause) {
      const unconfirmed = accountRegistrationUnconfirmed(cause);
      if (unconfirmed) {
        if (mounted.current) setPendingEntry(nextPending);
      } else if (pendingWebRegistrations.get(runtime)?.commandId === commandId) {
        pendingWebRegistrations.delete(runtime);
        if (mounted.current) setPendingEntry(null);
      }
      if (!unconfirmed && extractErrorCode(cause) === 'ACCOUNT_ID_CONFLICT') {
        const accounts = await listAccountsV2().catch(() => []);
        const existing = accounts.find(account => account.accountRef === nextPending.accountRef);
        if (existing && mounted.current) {
          setDisplayLabel('');
          setOwnId('');
          await onRegistered(
            `已确认${activePlatformTitle}账号「${existing.displayLabel}」注册成功，新账号默认关闭自动回复。真实页面完成安全校准前仅支持本地离线验证。`,
            existing.accountRef,
          );
          return;
        }
      }
      if (mounted.current) {
        setError(
          unconfirmed
            ? '注册结果尚未确认。可直接再次点击“添加账号”安全重试同一次注册。'
            : explainSafe(cause, `添加${activePlatformTitle}账号失败，请核对信息后重试。`),
        );
      }
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3.5 rounded-xl border border-primary/25 bg-primary/[0.03] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-[13.5px] font-semibold text-foreground">添加小红书 / B 站账号</h3>
          <p className={hintCls}>每个网页账号使用独立专属浏览器目录运行，互不干扰。</p>
        </div>
        <button type="button" className={btnOutlineCls} disabled={submitting} onClick={closePanel}>
          收起
        </button>
      </div>

      {pendingEntry && !error && (
        <p className="hint rounded-lg border border-warning/35 bg-warning/8 px-3 py-2 text-xs text-warning-foreground" role="status">
          “{pendingEntry.displayLabel}”的注册结果尚未确认。可直接点击“添加账号”安全核对并重试同一次注册。
        </p>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="选择网页渠道平台">
        <button
          type="button"
          className={`flex cursor-pointer flex-col items-start gap-0.5 rounded-xl border px-3.5 py-2.5 text-left transition-colors ${
            isXiaohongshu
              ? 'border-primary bg-primary/8 text-foreground'
              : 'border-border/80 bg-background text-muted-foreground hover:border-input hover:text-foreground'
          }`}
          disabled={submitting || lockedPending}
          onClick={() => switchPlatform(XIAOHONGSHU_PLATFORM_ID)}
        >
          <span className="text-xs font-semibold text-foreground">小红书</span>
          <span className="text-[11px] text-muted-foreground">独立浏览器目录运行，支持私信与评论</span>
        </button>
        <button
          type="button"
          className={`flex cursor-pointer flex-col items-start gap-0.5 rounded-xl border px-3.5 py-2.5 text-left transition-colors ${
            !isXiaohongshu
              ? 'border-primary bg-primary/8 text-foreground'
              : 'border-border/80 bg-background text-muted-foreground hover:border-input hover:text-foreground'
          }`}
          disabled={submitting || lockedPending}
          onClick={() => switchPlatform(BILIBILI_PLATFORM_ID)}
        >
          <span className="text-xs font-semibold text-foreground">B 站</span>
          <span className="text-[11px] text-muted-foreground">独立浏览器目录运行，支持私信与评论</span>
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className={labelCls}>
          展示名称（可选）
          <input
            type="text"
            className={inputCls}
            value={displayLabel}
            maxLength={128}
            placeholder={isXiaohongshu ? '如：小红书客服主号' : '如：B 站官方号'}
            disabled={submitting || lockedPending}
            onChange={event => setDisplayLabel(event.target.value)}
          />
        </label>
        <label className={labelCls}>
          平台账号标识（可选）
          <input
            type="text"
            className={`${inputCls} font-mono text-xs`}
            value={ownId}
            maxLength={128}
            placeholder={isXiaohongshu ? '如：小红书号或主页 ID' : '如：B 站 UID'}
            disabled={submitting || lockedPending}
            onChange={event => setOwnId(event.target.value)}
          />
        </label>
      </div>

      {error && (
        <p className="hint rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-2 text-xs font-medium text-destructive-foreground" role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={btnPrimaryCls}
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {submitting ? '正在添加…' : '添加账号'}
        </button>
        {lockedPending && (
          <button
            type="button"
            className={btnOutlineCls}
            disabled={submitting}
            onClick={discardPending}
          >
            放弃重试并重置
          </button>
        )}
        <span className={hintCls}>新账号默认关闭自动回复；未校准真实页前仅支持本地离线验证，禁止真实发送。</span>
      </div>
    </div>
  );
}
