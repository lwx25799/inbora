import { useEffect, useRef, useState } from 'react';
import type * as React from 'react';
import {
  BellIcon,
  CheckCircle2Icon,
  EyeIcon,
  MonitorIcon,
  RadioIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
} from 'lucide-react';
import { AccountPlatformPanel } from '@/AccountPlatformPanel';
import { PageHeader } from '@/components/PageHeader';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardFrame,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
} from '@/components/ui/card';
import {
  capabilityNames,
  isOfficialApiPlatform,
  isWebBrowserPlatform,
  platformNames,
  reasons,
  request,
  requestV2,
  WECOM_AIBOT_PLATFORM_ID,
  type AccountSummary,
  type ActiveWorkbenchAccount,
  type OfficialChannelPublicConfig,
  type Status,
} from '@/api';
import { browserState, time } from '@/presentation';
import { resolveWebChannelPresentation, type WebAccountStatusSnapshot } from '@/web-channel-status';

export interface OfficialAccountStatusSnapshot {
  connected: boolean;
  connectorState?: string;
  transportStatus?: OfficialChannelPublicConfig['transportStatus'];
}

export type { WebAccountStatusSnapshot };

export interface AccountsViewProps {
  status: Status;
  busy: string;
  act: (label: string, fn: () => Promise<void>) => Promise<void>;
  update: (status: Status) => void;
  activeAccount?: ActiveWorkbenchAccount | null | undefined;
  activeAccountRef?: string | undefined;
  onSelectWorkbenchAccount?: ((account: AccountSummary | null) => void) | undefined;
  officialAccountStatus?: OfficialAccountStatusSnapshot | null | undefined;
  webAccountStatus?: WebAccountStatusSnapshot | null | undefined;
}

const officialStateLabels: Record<string, string> = {
  CONNECTED: '已连接',
  CONNECTING: '连接中',
  DEGRADED: '连接降级',
  ERROR: '连接异常',
  DISCONNECTED: '未连接',
};

function resolveOfficialTransportPresentation(
  emergencyStopped: boolean,
  isWecomOfficial: boolean,
  officialStatus: OfficialAccountStatusSnapshot | null,
  statusReadError: boolean,
): {
  badgeVariant: 'success' | 'warning' | 'error' | 'secondary';
  stateLabel: string;
  summaryText: string;
} {
  if (emergencyStopped) {
    return {
      badgeVariant: 'error',
      stateLabel: '已急停',
      summaryText: '全局急停生效中，官方通道已暂停',
    };
  }
  const transportState =
    officialStatus?.transportStatus?.state ??
    officialStatus?.connectorState ??
    (officialStatus ? (officialStatus.connected ? 'CONNECTED' : 'DISCONNECTED') : null);
  if (transportState === 'CONNECTED' && officialStatus?.connected !== false) {
    return {
      badgeVariant: 'success',
      stateLabel: officialStateLabels.CONNECTED!,
      summaryText: isWecomOfficial ? '官方长连接已连接，免浏览器运行中' : '官方 API 已连接，免浏览器运行中',
    };
  }
  if (transportState === 'CONNECTING') {
    return {
      badgeVariant: 'warning',
      stateLabel: officialStateLabels.CONNECTING!,
      summaryText: '正在建立官方通道连接…',
    };
  }
  if (transportState === 'DEGRADED') {
    return {
      badgeVariant: 'warning',
      stateLabel: officialStateLabels.DEGRADED!,
      summaryText: '官方通道连接降级，请检查网络或配置',
    };
  }
  if (transportState === 'ERROR') {
    return {
      badgeVariant: 'error',
      stateLabel: officialStateLabels.ERROR!,
      summaryText: '官方通道连接异常，请在左侧「管理接入」核对凭据或状态',
    };
  }
  if (transportState === 'DISCONNECTED' || transportState === 'UNAVAILABLE') {
    return {
      badgeVariant: 'secondary',
      stateLabel: officialStateLabels.DISCONNECTED!,
      summaryText:
        transportState === 'UNAVAILABLE'
          ? '官方通道尚未建立连接，请在左侧「管理接入」中连接通道'
          : '官方通道未连接，请在左侧「已接入账号」连接通道',
    };
  }
  if (officialStatus) {
    return {
      badgeVariant: 'warning',
      stateLabel: '未就绪',
      summaryText: '官方通道当前未处于已连接状态，请展开「管理接入」核对连接状态',
    };
  }
  if (statusReadError) {
    return {
      badgeVariant: 'warning',
      stateLabel: '状态待核验',
      summaryText: '暂未能读取官方通道实时连接状态，请稍后刷新',
    };
  }
  return {
    badgeVariant: 'secondary',
    stateLabel: '读取中',
    summaryText: '正在读取官方通道连接状态…',
  };
}

export function AccountsView({
  status,
  busy,
  act,
  update,
  activeAccount,
  activeAccountRef,
  onSelectWorkbenchAccount,
  officialAccountStatus,
  webAccountStatus,
}: AccountsViewProps): React.ReactElement {
  const resolvedActiveRef = activeAccount?.accountRef ?? activeAccountRef;
  const isOfficialChannel = Boolean(activeAccount && isOfficialApiPlatform(activeAccount.platform));
  const isWebChannel = Boolean(activeAccount && isWebBrowserPlatform(activeAccount.platform));
  const officialPlatformName = activeAccount
    ? (platformNames[activeAccount.platform] ?? activeAccount.platform)
    : '';
  const isWecomOfficial = activeAccount?.platform === WECOM_AIBOT_PLATFORM_ID;
  const browserConnected = status.browser.state.startsWith('OPEN');
  const isHeaded = status.browser.loginRecovery || status.browser.mode === 'headed';
  const holds = status.securityHolds ?? [];
  const [fetchedOfficialStatus, setFetchedOfficialStatus] =
    useState<OfficialAccountStatusSnapshot | null>(null);
  const [officialStatusError, setOfficialStatusError] = useState(false);
  const [fetchedWebStatus, setFetchedWebStatus] =
    useState<WebAccountStatusSnapshot | null>(null);
  const [webStatusError, setWebStatusError] = useState(false);

  const officialAccountRef = isOfficialChannel ? activeAccount?.accountRef : undefined;
  const webAccountRef = isWebChannel ? activeAccount?.accountRef : undefined;
  const emergencyStopped = Boolean(status.automation?.emergencyStopped);
  const statusFetchSeq = useRef(0);
  const webStatusFetchSeq = useRef(0);

  useEffect(() => {
    if (!officialAccountRef || officialAccountStatus !== undefined) {
      statusFetchSeq.current += 1;
      setFetchedOfficialStatus(null);
      setOfficialStatusError(false);
      return;
    }
    let active = true;
    const seq = ++statusFetchSeq.current;
    void requestV2<OfficialAccountStatusSnapshot>(
      { kind: 'ACCOUNT', accountRef: officialAccountRef },
      { command: 'accounts', action: 'getAccountStatus', accountRef: officialAccountRef },
    )
      .then(result => {
        if (!active || statusFetchSeq.current !== seq) return;
        setFetchedOfficialStatus(result);
        setOfficialStatusError(false);
      })
      .catch(() => {
        if (!active || statusFetchSeq.current !== seq) return;
        setFetchedOfficialStatus(null);
        setOfficialStatusError(true);
      });
    return () => {
      active = false;
    };
  }, [officialAccountRef, officialAccountStatus, status]);

  useEffect(() => {
    if (!webAccountRef || webAccountStatus !== undefined) {
      webStatusFetchSeq.current += 1;
      setFetchedWebStatus(null);
      setWebStatusError(false);
      return;
    }
    let active = true;
    const seq = ++webStatusFetchSeq.current;
    void requestV2<WebAccountStatusSnapshot>(
      { kind: 'ACCOUNT', accountRef: webAccountRef },
      { command: 'accounts', action: 'getAccountStatus', accountRef: webAccountRef },
    )
      .then(result => {
        if (!active || webStatusFetchSeq.current !== seq) return;
        setFetchedWebStatus(result);
        setWebStatusError(false);
      })
      .catch(() => {
        if (!active || webStatusFetchSeq.current !== seq) return;
        setFetchedWebStatus(null);
        setWebStatusError(true);
      });
    return () => {
      active = false;
    };
  }, [webAccountRef, webAccountStatus, status]);

  const effectiveOfficialStatus =
    officialAccountStatus !== undefined ? officialAccountStatus : fetchedOfficialStatus;
  const officialPresentation = resolveOfficialTransportPresentation(
    emergencyStopped,
    isWecomOfficial,
    effectiveOfficialStatus,
    officialStatusError,
  );
  const effectiveWebStatus =
    webAccountStatus !== undefined ? webAccountStatus : fetchedWebStatus;
  const webPresentation = resolveWebChannelPresentation({
    emergencyStopped,
    platformName: officialPlatformName,
    webStatus: effectiveWebStatus,
    statusReadError: webStatusError,
  });

  return (
    <div className="mx-auto max-w-[1200px] space-y-5 px-6 py-5">
      <PageHeader
        title="账号与通道"
        description={
          isOfficialChannel
            ? '管理当前官方渠道账号、通道收发能力与多账号工作台切换'
            : isWebChannel
              ? `管理当前${officialPlatformName}账号、通道收发能力与页面安全校准状态`
              : '管理本地绑定账号、各通道收发能力、浏览器运行窗口以及顶部通知独立同步'
        }
      />

      {/* Row 1: Real Account, Browser or Official Channel & Sync Summary */}
      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
        <Card className="p-4">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <CheckCircle2Icon className="size-3.5 text-primary" />
              当前值守账号
            </span>
            <Badge variant={status.account ? 'success' : 'secondary'} size="sm">
              {status.account ? '已绑定' : '待核验'}
            </Badge>
          </div>
          <div className="mt-2 font-heading text-base font-semibold text-foreground">
            {(isOfficialChannel || isWebChannel) && activeAccount
              ? activeAccount.displayLabel
              : status.account
                ? '已绑定本地账号'
                : '尚未核验账号'}
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {(isOfficialChannel || isWebChannel) && activeAccount ? (
              <>
                <span>{officialPlatformName}</span>
                {status.account?.identity && (
                  <>
                    {' · '}
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                      {status.account.identity}
                    </code>
                  </>
                )}
              </>
            ) : status.account?.identity ? (
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                {status.account.identity}
              </code>
            ) : (
              '完成浏览器登录后将自动绑定本机账号标识'
            )}
          </p>
        </Card>

        {isOfficialChannel ? (
          <Card className="p-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5 font-medium">
                <RadioIcon className="size-3.5 text-primary" />
                官方通道状态
              </span>
              <Badge
                variant={officialPresentation.badgeVariant}
                size="sm"
              >
                {isWecomOfficial ? '官方长连接' : '官方 API'} · {officialPresentation.stateLabel}
              </Badge>
            </div>
            <div className="mt-2 text-[13.5px] font-semibold text-foreground">
              免浏览器后台运行
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {officialPresentation.summaryText}
            </p>
          </Card>
        ) : isWebChannel ? (
          <Card className="p-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5 font-medium">
                <MonitorIcon className="size-3.5 text-primary" />
                {officialPlatformName}通道状态
              </span>
              <Badge variant={webPresentation.badgeVariant} size="sm">
                {webPresentation.stateLabel}
              </Badge>
            </div>
            <div className="mt-2 text-[13.5px] font-semibold text-foreground">
              {webPresentation.headline}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {webPresentation.summaryText}
            </p>
          </Card>
        ) : (
          <Card className="p-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5 font-medium">
                <MonitorIcon className="size-3.5 text-primary" />
                浏览器运行状态
              </span>
              <Badge variant={isHeaded ? 'warning' : browserConnected ? 'success' : 'secondary'} size="sm">
                {status.browser.mode === 'headed' ? '登录窗口 Edge' : '后台静音 Edge'}
              </Badge>
            </div>
            <div className="mt-2 text-[13.5px] font-semibold text-foreground">
              {browserState(status.browser.state, status.automation?.emergencyStopped)}
            </div>
            <p className="mt-1 text-xs text-muted-foreground tabular-nums">
              {status.browser.version ? `版本 ${status.browser.version}` : '静音独占后台运行'}
            </p>
          </Card>
        )}

        <Card className="p-4">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <ShieldCheckIcon className="size-3.5 text-primary" />
              最近同步状态
            </span>
            <Badge variant={status.lastSync.length > 0 ? 'success' : 'secondary'} size="sm">
              {status.lastSync.length > 0 ? '已同步' : '待同步'}
            </Badge>
          </div>
          <div className="mt-2 space-y-1 text-xs text-foreground tabular-nums">
            {status.lastSync.length === 0 ? (
              <p className="text-muted-foreground">尚无成功同步记录</p>
            ) : (
              status.lastSync.map(item => (
                <div key={item.channel} className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">
                    {item.channel === 'DIRECT_MESSAGE' ? '私信' : '评论'}
                  </span>
                  <span>{time(item.at)}</span>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      {isWebChannel && webPresentation.showStatusErrorAlert && (
        <Alert variant="warning">
          <ShieldAlertIcon />
          <AlertTitle>暂未能读取{officialPlatformName}通道状态，请刷新后重试</AlertTitle>
          <AlertDescription>
            无法确认当前运行与页面校准状态，已暂停外发操作；请刷新列表或稍后重试。
          </AlertDescription>
        </Alert>
      )}

      {isWebChannel && webPresentation.showUncalibratedAlert && (
        <Alert variant="warning">
          <ShieldAlertIcon />
          <AlertTitle>{officialPlatformName}真实页面尚未完成安全校准，当前禁止发送</AlertTitle>
          <AlertDescription>
            未校准真实页 · 仅离线验证禁发。真实页面完成安全校准前已阻止所有自动与人工发送。
          </AlertDescription>
        </Alert>
      )}

      {isWebChannel && webPresentation.showUnknownCalibration && (
        <Alert variant="warning">
          <ShieldAlertIcon />
          <AlertTitle>{officialPlatformName}真实页面校准状态未知，当前禁止发送</AlertTitle>
          <AlertDescription>
            未确认真实页面是否完成安全校准，暂仅支持本地离线验证；请刷新通道状态后再试。
          </AlertDescription>
        </Alert>
      )}

      {holds.length > 0 && (
        <Alert variant="warning">
          <ShieldAlertIcon />
          <AlertTitle>检测到 {holds.length} 个通道存在安全待核验</AlertTitle>
          <AlertDescription>
            {holds
              .map(
                hold =>
                  `${hold.channel === 'DIRECT_MESSAGE' ? '私信' : '评论'}：${reasons[hold.reason] ?? hold.reason}`,
              )
              .join('；')}
          </AlertDescription>
        </Alert>
      )}

      {/* Row 2: Multi-Account Registry + Channel & Browser Controls */}
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <AccountPlatformPanel
            status={status}
            busy={busy}
            activeAccountRef={resolvedActiveRef}
            onSelectWorkbenchAccount={onSelectWorkbenchAccount}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          {isOfficialChannel ? (
            <CardFrame>
              <CardFrameHeader>
                <CardFrameTitle>官方通道能力与连接摘要</CardFrameTitle>
                <CardFrameDescription>
                  当前账号通过官方接口后台直连运行，无需开启或切换浏览器窗口
                </CardFrameDescription>
              </CardFrameHeader>
              <Card className="space-y-4 p-5">
                <dl className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border/80 bg-background text-xs">
                  {status.capabilities.length === 0 ? (
                    <div className="px-4 py-3 text-muted-foreground">尚无通道能力记录。</div>
                  ) : (
                    status.capabilities.map(c => (
                      <div
                        key={c.channel}
                        className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                      >
                        <dt className="font-medium text-foreground">
                          {c.channel === 'DIRECT_MESSAGE' ? '私信能力' : '评论能力'}
                        </dt>
                        <dd className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
                          <Badge
                            variant={
                              c.state === 'SEND_AVAILABLE'
                                ? 'success'
                                : c.state === 'BLOCKED'
                                  ? 'error'
                                  : 'secondary'
                            }
                            size="sm"
                          >
                            {capabilityNames[c.state] ?? c.state}
                          </Badge>
                          {c.reason && <span>{reasons[c.reason] ?? c.reason}</span>}
                        </dd>
                      </div>
                    ))
                  )}
                </dl>

                <div className="space-y-1.5 rounded-xl border border-border/75 bg-muted/35 px-4 py-3 text-xs text-muted-foreground">
                  <div className="flex items-center justify-between gap-2">
                    <span>所属平台</span>
                    <span className="font-medium text-foreground">{officialPlatformName}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span>接入模式</span>
                    <span className="font-medium text-foreground">
                      {isWecomOfficial ? '官方长连接（免浏览器）' : '官方 API（免浏览器）'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span>连接状态</span>
                    <span className="font-medium text-foreground">{officialPresentation.stateLabel}</span>
                  </div>
                  <p className="pt-1 leading-relaxed">
                    通道能力与模型密钥分别生效；如需调整凭据或连接状态，请在左侧「已接入账号」展开对应账号的「管理接入」。
                  </p>
                </div>
              </Card>
            </CardFrame>
          ) : isWebChannel ? (
            <CardFrame>
              <CardFrameHeader>
                <CardFrameTitle>{officialPlatformName}通道能力与安全校准</CardFrameTitle>
                <CardFrameDescription>
                  当前账号使用独立专属浏览器目录运行，各账号数据隔离
                </CardFrameDescription>
              </CardFrameHeader>
              <Card className="space-y-4 p-5">
                <dl className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border/80 bg-background text-xs">
                  {status.capabilities.length === 0 ? (
                    <div className="px-4 py-3 text-muted-foreground">尚无通道能力记录。</div>
                  ) : (
                    status.capabilities.map(c => (
                      <div
                        key={c.channel}
                        className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                      >
                        <dt className="font-medium text-foreground">
                          {c.channel === 'DIRECT_MESSAGE' ? '私信能力' : '评论能力'}
                        </dt>
                        <dd className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
                          <Badge
                            variant={
                              c.state === 'SEND_AVAILABLE'
                                ? 'success'
                                : c.state === 'BLOCKED'
                                  ? 'error'
                                  : 'secondary'
                            }
                            size="sm"
                          >
                            {capabilityNames[c.state] ?? c.state}
                          </Badge>
                          {c.reason && <span>{reasons[c.reason] ?? c.reason}</span>}
                        </dd>
                      </div>
                    ))
                  )}
                </dl>

                <div className="space-y-1.5 rounded-xl border border-border/75 bg-muted/35 px-4 py-3 text-xs text-muted-foreground">
                  <div className="flex items-center justify-between gap-2">
                    <span>所属平台</span>
                    <span className="font-medium text-foreground">{officialPlatformName}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span>运行状态</span>
                    <span className="font-medium text-foreground">{webPresentation.stateLabel}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span>真实页校准</span>
                    <span className="font-medium text-foreground">{webPresentation.calibrationLabel}</span>
                  </div>
                  <p className="pt-1 leading-relaxed">
                    通道能力与模型密钥分别生效；未完成真实页面安全校准前仅支持本地离线验证，禁止任何对外发送。
                  </p>
                </div>
              </Card>
            </CardFrame>
          ) : (
            <>
              <CardFrame>
                <CardFrameHeader>
                  <CardFrameTitle>通道能力与顶部通知同步</CardFrameTitle>
                  <CardFrameDescription>
                    通道能力与模型密钥分别生效；未配置模型密钥仍可人工回复
                  </CardFrameDescription>
                </CardFrameHeader>
                <Card className="space-y-4 p-5">
                  <dl className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border/80 bg-background text-xs">
                    {status.capabilities.length === 0 ? (
                      <div className="px-4 py-3 text-muted-foreground">尚无通道能力记录。</div>
                    ) : (
                      status.capabilities.map(c => (
                        <div
                          key={c.channel}
                          className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                        >
                          <dt className="font-medium text-foreground">
                            {c.channel === 'DIRECT_MESSAGE' ? '私信能力' : '评论能力'}
                          </dt>
                          <dd className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
                            <Badge
                              variant={
                                c.state === 'SEND_AVAILABLE'
                                  ? 'success'
                                  : c.state === 'BLOCKED'
                                    ? 'error'
                                    : 'secondary'
                              }
                              size="sm"
                            >
                              {capabilityNames[c.state] ?? c.state}
                            </Badge>
                            {c.reason && <span>{reasons[c.reason] ?? c.reason}</span>}
                          </dd>
                        </div>
                      ))
                    )}
                  </dl>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                    <span className="text-xs text-muted-foreground">
                      仅触发一次独立顶部通知读取，不影响既有收取队列
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!!busy}
                      onClick={() =>
                        void act('同步通知', async () => {
                          update(
                            await request<Status>({
                              command: 'observe',
                              source: 'notifications',
                            }),
                          );
                        })
                      }
                    >
                      <BellIcon />
                      同步顶部通知（独立来源）
                    </Button>
                  </div>
                </Card>
              </CardFrame>

              <CardFrame>
                <CardFrameHeader>
                  <CardFrameTitle>浏览器运行窗口切换</CardFrameTitle>
                  <CardFrameDescription>
                    日常默认后台静音运行；仅在需要重新登录或查看原页面时临时打开登录窗口
                  </CardFrameDescription>
                </CardFrameHeader>
                <Card className="space-y-3.5 p-5">
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    登录窗口打开期间，后台收取与自动回复会自动暂缓；操作完成后点击「返回后台静音运行」即可恢复值守。平台安全验证优先在客户端内直接操作原后台页面完成。
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!!busy || status.browser.state === 'MANUAL_VISIBLE'}
                      onClick={() =>
                        void act('打开登录窗口', async () =>
                          update(
                            await request<Status>({
                              command: 'browser',
                              open: true,
                              mode: 'headed',
                              loginRecovery: true,
                              manualVisible: true,
                            }),
                          ),
                        )
                      }
                    >
                      <EyeIcon />
                      打开登录窗口
                    </Button>
                    {isHeaded && (
                      <Button
                        size="sm"
                        disabled={!!busy}
                        onClick={() =>
                          void act('恢复后台静音运行', async () =>
                            update(
                              await request<Status>({
                                command: 'browser',
                                open: true,
                                mode: 'headless',
                              }),
                            ),
                          )
                        }
                      >
                        返回后台静音运行
                      </Button>
                    )}
                  </div>
                </Card>
              </CardFrame>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
