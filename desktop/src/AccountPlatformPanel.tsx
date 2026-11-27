import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { DEFAULT_ACCOUNT_ID } from '../../src/contracts/account.js';
import {
  accountRegistrationUnconfirmed,
  disconnectAccountV2,
  isOfficialApiPlatform,
  isWebBrowserPlatform,
  listAccountsV2,
  mockRegistrationAccountRef,
  MOCK_PLATFORM_ID,
  platformNames,
  reactivateAccountV2,
  registerMockAccountV2,
  requestV2,
  runtimeSession,
  type AccountSummary,
  type MockRegistration,
  type Status,
} from './api';
import { explainSafe, extractErrorCode } from './error-messages';
import { OfficialChannelCreator, OfficialChannelManagerPanel } from './OfficialChannelEditor';
import { clearPendingWebRegistration, getPendingWebRegistration, WebChannelCreator } from './WebChannelCreator';
import { resolveWebChannelPresentation, type WebAccountStatusSnapshot } from './web-channel-status';

const title = '已接入账号';
const defaultDisplayLabel = '合成验证账号';
const accountStatusNames: Record<AccountSummary['status'], string> = {
  ACTIVE: '活跃',
  DISCONNECTED: '已解绑',
  PAUSED: '暂停',
  ERROR: '异常',
};

const cardCls = 'settings-section flex flex-col gap-3.5 rounded-2xl border border-border/85 bg-card p-5 text-card-foreground shadow-xs/5';
const headingCls = 'font-heading text-[15px] font-semibold tracking-tight text-foreground';
const hintCls = 'hint text-xs leading-relaxed text-muted-foreground';
const btnOutlineCls = 'inline-flex h-8 shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-lg border border-input bg-popover px-3 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55 dark:bg-input/32 dark:hover:bg-input/64';
const btnPrimaryCls = 'inline-flex h-8 shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-lg border border-primary bg-primary px-3 text-xs font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55';
const btnDangerCls = 'danger inline-flex h-8 shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-lg border border-destructive/35 bg-destructive/8 px-3 text-xs font-medium text-destructive-foreground shadow-xs/5 transition-colors hover:bg-destructive/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55';
const inputCls = 'h-8.5 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-[13px] text-foreground shadow-xs/5 outline-none transition-shadow placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/32';

interface AccountMutation {
  request: () => Promise<AccountSummary>;
  success: string;
  failure: string;
  registration?: MockRegistration;
}

// Settings can unmount while a registration is in flight. Keep its identity on return to the same directory.
const pendingRegistrations = new Map<string, MockRegistration>();

export function AccountPlatformPanel({
  status,
  busy,
  activeAccountRef,
  onSelectWorkbenchAccount,
}: {
  status: Status;
  busy: string;
  activeAccountRef?: string | undefined;
  onSelectWorkbenchAccount?: ((account: AccountSummary | null) => void) | undefined;
}) {
  if (status.schema < 4) {
    return (
      <div className={cardCls}>
        <h2 className={headingCls}>{title}</h2>
        <p className={hintCls}>当前为单账号运行模式</p>
      </div>
    );
  }
  return (
    <ConnectedAccounts
      key={runtimeSession(status)}
      status={status}
      busy={busy}
      activeAccountRef={activeAccountRef}
      onSelectWorkbenchAccount={onSelectWorkbenchAccount}
    />
  );
}

function ConnectedAccounts({
  status,
  busy,
  activeAccountRef,
  onSelectWorkbenchAccount,
}: {
  status: Status;
  busy: string;
  activeAccountRef?: string | undefined;
  onSelectWorkbenchAccount?: ((account: AccountSummary | null) => void) | undefined;
}) {
  const { runtime } = status;
  const [accounts, setAccounts] = useState<AccountSummary[] | null>(null);
  const [displayLabel, setDisplayLabel] = useState('');
  const [registration, setRegistration] = useState(pendingRegistrations.get(runtime) ?? null);
  const [confirmAccount, setConfirmAccount] = useState<string | null>(null);
  const [showOfficialCreator, setShowOfficialCreator] = useState(false);
  const [showWebCreator, setShowWebCreator] = useState(false);
  const [expandedOfficialRef, setExpandedOfficialRef] = useState<string | null>(null);
  const [webStatuses, setWebStatuses] = useState<
    Record<string, { status: WebAccountStatusSnapshot | null; error: boolean }>
  >({});
  const [pending, setPending] = useState<'list' | 'write' | null>('list');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lifetime = useRef<{ busy: boolean } | null>(null);
  const latestStatus = useRef(status);
  latestStatus.current = status;
  const latestAccounts = useRef<AccountSummary[] | null>(null);
  latestAccounts.current = accounts;
  const lifecycleKey = `${status.browser.state}:${status.browser.mode}:${Boolean(status.automation?.emergencyStopped)}`;
  const prevLifecycleKey = useRef(lifecycleKey);
  const disabled = !!busy || pending !== null;

  const fetchWebStatuses = useCallback(async (
    list: AccountSummary[],
    current: { busy: boolean },
  ) => {
    const webAccounts = list.filter(
      account =>
        (account.status === 'ACTIVE' || account.status === 'DISCONNECTED') &&
        isWebBrowserPlatform(account.platform),
    );
    if (webAccounts.length === 0) {
      if (lifetime.current === current) setWebStatuses({});
      return;
    }
    const entries = await Promise.all(
      webAccounts.map(async account => {
        try {
          const statusResult = await requestV2<WebAccountStatusSnapshot>(
            { kind: 'ACCOUNT', accountRef: account.accountRef },
            { command: 'accounts', action: 'getAccountStatus', accountRef: account.accountRef },
          );
          return [account.accountRef, { status: statusResult, error: false }] as const;
        } catch {
          return [account.accountRef, { status: null, error: true }] as const;
        }
      }),
    );
    if (lifetime.current === current) setWebStatuses(Object.fromEntries(entries));
  }, []);

  const run = useCallback(async (mutation?: AccountMutation) => {
    const current = lifetime.current;
    if (!current || current.busy) return;
    const attempt = mutation?.registration;
    const previous = pendingRegistrations.get(runtime);
    if (attempt && previous && attempt !== previous) return;
    if (attempt) {
      pendingRegistrations.set(runtime, attempt);
      setRegistration(attempt);
    }
    function confirmRegistration(confirmed: MockRegistration) {
      if (pendingRegistrations.get(runtime) === confirmed) pendingRegistrations.delete(runtime);
      if (lifetime.current === current) setRegistration(pendingRegistrations.get(runtime) ?? null);
    }
    current.busy = true;
    setPending(mutation ? 'write' : 'list');
    setError('');
    setNotice('');
    setConfirmAccount(null);
    let fallback = '暂时无法读取账号列表，请刷新后重试。';
    let awaitingRegistration = attempt;
    try {
      if (mutation) {
        fallback = mutation.failure;
        await mutation.request();
        awaitingRegistration = undefined;
        if (attempt) confirmRegistration(attempt);
        if (lifetime.current !== current) return;
        fallback = '账号已更新，暂时无法刷新账号列表。';
        setNotice(mutation.success);
        setAccounts(null);
        setPending('list');
      }
      const unresolved = pendingRegistrations.get(runtime);
      const unresolvedWeb = getPendingWebRegistration(runtime);
      const next = await listAccountsV2(latestStatus.current);
      if (lifetime.current === current) {
        setAccounts(next);
        const committedWeb = unresolvedWeb
          ? next.find(account => account.accountRef === unresolvedWeb.accountRef)
          : undefined;
        if (committedWeb) {
          clearPendingWebRegistration(runtime);
          setShowWebCreator(false);
          if (!mutation) {
            setNotice(`已确认账号「${committedWeb.displayLabel}」注册成功，新账号默认关闭自动回复。`);
          }
        }
        void fetchWebStatuses(next, current);
        if (
          unresolved &&
          next.some(
            account =>
              account.accountRef === mockRegistrationAccountRef(unresolved.commandId) &&
              account.platform === MOCK_PLATFORM_ID &&
              account.displayLabel === unresolved.displayLabel,
          )
        ) {
          confirmRegistration(unresolved);
          setNotice('已确认合成验证账号注册成功。');
        }
      }
    } catch (cause) {
      const unconfirmed = awaitingRegistration && accountRegistrationUnconfirmed(cause);
      if (
        awaitingRegistration &&
        !unconfirmed &&
        (!previous ||
          ['ACCOUNT_ID_CONFLICT', 'ACCOUNT_IDENTITY_CONFLICT'].includes(extractErrorCode(cause)))
      ) {
        confirmRegistration(awaitingRegistration);
      }
      if (lifetime.current === current && !unconfirmed) setError(explainSafe(cause, fallback));
    } finally {
      if (lifetime.current === current) {
        current.busy = false;
        setPending(null);
      }
    }
  }, [runtime]);

  function register(input: MockRegistration) {
    void run({
      request: () => registerMockAccountV2(input),
      registration: input,
      success: '合成验证账号已注册。新账号默认关闭自动回复。',
      failure: '合成验证账号注册失败，请刷新账号列表后核对状态。',
    });
  }

  useLayoutEffect(() => {
    lifetime.current = { busy: false };
    void run();
    return () => {
      lifetime.current = null;
    };
  }, [run]);

  if (prevLifecycleKey.current !== lifecycleKey) {
    prevLifecycleKey.current = lifecycleKey;
    const current = lifetime.current;
    const list = latestAccounts.current;
    if (current && list) {
      queueMicrotask(() => {
        if (lifetime.current === current) void fetchWebStatuses(list, current);
      });
    }
  }

  return (
    <div className={cardCls}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className={headingCls}>{title}</h2>
        <div className="row flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={btnPrimaryCls}
            disabled={disabled}
            onClick={() => {
              setShowOfficialCreator(!showOfficialCreator);
              setShowWebCreator(false);
            }}
          >
            {showOfficialCreator ? '收起官方接入' : '接入官方渠道'}
          </button>
          <button
            type="button"
            className={btnOutlineCls}
            disabled={disabled}
            onClick={() => {
              setShowWebCreator(!showWebCreator);
              setShowOfficialCreator(false);
            }}
          >
            {showWebCreator ? '收起网页接入' : '添加小红书 / B 站账号'}
          </button>
          <button
            type="button"
            className={btnOutlineCls}
            disabled={disabled}
            onClick={() => void run()}
          >
            刷新账号列表
          </button>
        </div>
      </div>

      {showOfficialCreator && (
        <OfficialChannelCreator
          disabled={disabled}
          onClose={() => setShowOfficialCreator(false)}
          onRegistered={async (message, accountRef) => {
            const current = lifetime.current;
            if (!current) return;
            setShowOfficialCreator(false);
            setExpandedOfficialRef(accountRef);
            await run();
            if (lifetime.current === current) setNotice(message);
          }}
        />
      )}

      {showWebCreator && (
        <WebChannelCreator
          runtime={runtime}
          disabled={disabled}
          onClose={() => setShowWebCreator(false)}
          onRegistered={async (message) => {
            const current = lifetime.current;
            if (!current) return;
            setShowWebCreator(false);
            await run();
            if (lifetime.current === current) setNotice(message);
          }}
        />
      )}

      {pending && (
        <p className="hint rounded-xl border border-border/75 bg-muted/40 px-3 py-2 text-xs text-muted-foreground" role="status">
          {pending === 'list' ? '正在读取账号列表…' : '正在更新账号…'}
        </p>
      )}
      {error && (
        <p className="hint rounded-xl border border-destructive/30 bg-destructive/6 px-3 py-2 text-xs font-medium text-destructive-foreground" role="status">
          {error}
        </p>
      )}
      {notice && (
        <p className="hint rounded-xl border border-success/30 bg-success/8 px-3 py-2 text-xs font-medium text-success-foreground" role="status">
          {notice}
        </p>
      )}
      {registration && pending !== 'write' && (
        <p className="hint rounded-xl border border-warning/35 bg-warning/8 px-3 py-2 text-xs text-warning-foreground" role="status">
          “{registration.displayLabel}”的注册结果尚未确认。请刷新账号列表核对，或重试同一次注册。
        </p>
      )}
      {accounts?.length === 0 && <p className={hintCls}>暂无已注册账号。</p>}
      {accounts && accounts.length > 0 && (
        <dl className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border/80 bg-background">
          {accounts.map(account => (
            <div key={account.accountRef} className="flex flex-col gap-1.5 px-4 py-3">
              <dt className="text-[13.5px] font-semibold text-foreground">
                {account.displayLabel} ·{' '}
                {Object.hasOwn(platformNames, account.platform)
                  ? platformNames[account.platform]
                  : account.platform}
              </dt>
              <dd className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2 [&>code]:rounded [&>code]:bg-muted [&>code]:px-1.5 [&>code]:py-0.5 [&>code]:font-mono [&>code]:text-[11px] [&>code]:text-foreground">
                  <code>{account.id}</code>
                  {isWebBrowserPlatform(account.platform) && (() => {
                    const platformName = Object.hasOwn(platformNames, account.platform)
                      ? platformNames[account.platform]!
                      : account.platform;
                    const entry = webStatuses[account.accountRef];
                    const webPres = account.status !== 'ACTIVE' && account.status !== 'DISCONNECTED'
                      ? resolveWebChannelPresentation({
                        emergencyStopped: Boolean(status.automation?.emergencyStopped),
                        platformName,
                        webStatus: {
                          connected: false,
                          connectorState: 'ERROR',
                          calibrated: entry?.status?.calibrated,
                        },
                        statusReadError: false,
                        accountStatus: account.status,
                      })
                      : resolveWebChannelPresentation({
                        emergencyStopped: Boolean(status.automation?.emergencyStopped),
                        platformName,
                        webStatus: entry?.status ?? null,
                        statusReadError: Boolean(entry?.error),
                        accountStatus: account.status,
                      });
                    const toneCls = webPres.badgeVariant === 'success'
                      ? 'bg-success/12 text-success-foreground'
                      : webPres.badgeVariant === 'error'
                        ? 'bg-destructive/12 text-destructive-foreground'
                        : webPres.badgeVariant === 'warning'
                          ? 'bg-warning/12 text-warning-foreground'
                          : 'bg-muted text-muted-foreground';
                    return (
                      <>
                        <span className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground">
                          {accountStatusNames[account.status]}
                        </span>
                        <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium ${toneCls}`}>
                          {webPres.stateLabel}
                        </span>
                        {webPres.showUncalibratedAlert && webPres.stateLabel !== '未校准 · 禁发' && (
                          <span className="inline-flex items-center rounded-md bg-warning/12 px-2 py-0.5 text-[11px] font-medium text-warning-foreground">
                            未校准真实页 · 仅离线验证禁发
                          </span>
                        )}
                        {webPres.showUnknownCalibration &&
                          webPres.stateLabel !== '校准待核验' &&
                          webPres.stateLabel !== '未连接 · 校准待核验' &&
                          webPres.stateLabel !== '已关闭 · 校准待核验' && (
                          <span className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                            校准状态未知
                          </span>
                        )}
                      </>
                    );
                  })()}
                </div>
                <p className={hintCls}>
                  {accountStatusNames[account.status]} · 自动回复：
                  {account.autoReplyEnabled ? '开' : '关'}
                  {' · '}支持 {account.capabilities.channels.length} 个通道
                  {' · '}只读回读：{account.capabilities.readback ? '支持' : '不支持'}
                </p>
                {account.id !== DEFAULT_ACCOUNT_ID && account.status === 'ACTIVE' && (
                  confirmAccount === account.accountRef ? (
                    <div className="mt-1 flex flex-col gap-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3">
                      <p className={hintCls}>确认解绑？历史消息与发送收据将完整保留。</p>
                      <div className="row flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          className={btnDangerCls}
                          disabled={disabled}
                          onClick={() =>
                            void run({
                              request: async () => {
                                const result = await disconnectAccountV2(account.accountRef);
                                if (activeAccountRef === account.accountRef) onSelectWorkbenchAccount?.(null);
                                return result;
                              },
                              success: '账号已解绑。',
                              failure: '账号解绑失败，请刷新账号列表后核对状态。',
                            })
                          }
                        >
                          确认解绑
                        </button>
                        <button
                          type="button"
                          className={btnOutlineCls}
                          onClick={() => setConfirmAccount(null)}
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="row flex flex-wrap items-center gap-2 pt-0.5">
                      {isOfficialApiPlatform(account.platform) && (
                        <button
                          type="button"
                          className={btnOutlineCls}
                          disabled={disabled}
                          onClick={() =>
                            setExpandedOfficialRef(
                              expandedOfficialRef === account.accountRef ? null : account.accountRef,
                            )
                          }
                        >
                          {expandedOfficialRef === account.accountRef ? '收起接入管理' : '管理接入'}
                        </button>
                      )}
                      {(isOfficialApiPlatform(account.platform) || isWebBrowserPlatform(account.platform)) &&
                        onSelectWorkbenchAccount && (
                        <button
                          type="button"
                          className={activeAccountRef === account.accountRef ? btnPrimaryCls : btnOutlineCls}
                          disabled={disabled}
                          onClick={() =>
                            onSelectWorkbenchAccount(
                              activeAccountRef === account.accountRef ? null : account,
                            )
                          }
                        >
                          {activeAccountRef === account.accountRef ? '返回主账号工作台' : '切换工作台'}
                        </button>
                      )}
                      <button
                        type="button"
                        className={btnOutlineCls}
                        disabled={disabled}
                        onClick={() => setConfirmAccount(account.accountRef)}
                      >
                        解绑账号
                      </button>
                    </div>
                  )
                )}
                {account.status === 'DISCONNECTED' &&
                  (isOfficialApiPlatform(account.platform) || isWebBrowserPlatform(account.platform)) && (
                  <div className="row flex flex-wrap items-center gap-2 pt-0.5">
                    {isWebBrowserPlatform(account.platform) &&
                    webStatuses[account.accountRef]?.status?.connectorState === 'CLOSING' ? (
                      <button
                        type="button"
                        className={btnOutlineCls}
                        disabled={disabled}
                        onClick={() =>
                          void run({
                            request: () => disconnectAccountV2(account.accountRef),
                            success: '已完成关闭并清理该账号运行实例。',
                            failure: '关闭尚未完成，请稍后重试关闭。',
                          })
                        }
                      >
                        重试关闭
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={btnOutlineCls}
                        disabled={disabled}
                        onClick={() =>
                          void run({
                            request: () => reactivateAccountV2(account.accountRef),
                            success: isOfficialApiPlatform(account.platform)
                              ? '账号已重新启用，请点击“管理接入”重新保存凭据后连接。'
                              : '账号已重新启用。',
                            failure: '重新启用账号失败，请刷新列表后重试。',
                          })
                        }
                      >
                        重新启用
                      </button>
                    )}
                  </div>
                )}
                {account.status === 'ACTIVE' &&
                  isOfficialApiPlatform(account.platform) &&
                  expandedOfficialRef === account.accountRef && (
                    <OfficialChannelManagerPanel
                      account={account}
                      disabled={disabled}
                      emergencyStopped={Boolean(status.automation?.emergencyStopped)}
                      onUpdated={() => run()}
                      onOpenWorkbench={
                        onSelectWorkbenchAccount ? () => onSelectWorkbenchAccount(account) : undefined
                      }
                    />
                  )}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <details
        className="rounded-xl border border-border/75 bg-muted/30 px-3.5 py-2.5"
        open={Boolean(registration)}
      >
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground select-none hover:text-foreground">
          测试用合成账号（可选）
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-xs font-medium text-foreground">
            展示名（可选）
            <input
              type="text"
              className={inputCls}
              value={displayLabel}
              placeholder={defaultDisplayLabel}
              maxLength={128}
              disabled={disabled || !!registration}
              onChange={event => setDisplayLabel(event.target.value)}
            />
          </label>
          <div className="row flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={btnPrimaryCls}
              disabled={disabled || !!registration}
              onClick={() =>
                register({
                  commandId: crypto.randomUUID(),
                  displayLabel: displayLabel.trim() || defaultDisplayLabel,
                })
              }
            >
              注册合成验证账号 (Mock)
            </button>
            {registration && (
              <button
                type="button"
                className={btnOutlineCls}
                disabled={disabled}
                onClick={() => register(registration)}
              >
                重试同一次注册
              </button>
            )}
          </div>
        </div>
      </details>
    </div>
  );
}
