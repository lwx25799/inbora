import type * as React from 'react';
import {
  BellIcon,
  CheckCircle2Icon,
  EyeIcon,
  MonitorIcon,
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
import { capabilityNames, reasons, request, type AccountSummary, type Status } from '@/api';
import { browserState, time } from '@/presentation';

export interface AccountsViewProps {
  status: Status;
  busy: string;
  act: (label: string, fn: () => Promise<void>) => Promise<void>;
  update: (status: Status) => void;
  activeAccountRef?: string | undefined;
  onSelectWorkbenchAccount?: ((account: AccountSummary | null) => void) | undefined;
}

export function AccountsView({
  status,
  busy,
  act,
  update,
  activeAccountRef,
  onSelectWorkbenchAccount,
}: AccountsViewProps): React.ReactElement {
  const browserConnected = status.browser.state.startsWith('OPEN');
  const isHeaded = status.browser.loginRecovery || status.browser.mode === 'headed';
  const holds = status.securityHolds ?? [];

  return (
    <div className="mx-auto max-w-[1200px] space-y-5 px-6 py-5">
      <PageHeader
        title="账号与通道"
        description="管理本地绑定账号、各通道收发能力、浏览器运行窗口以及顶部通知独立同步"
      />

      {/* Row 1: Real Account, Browser & Sync Summary */}
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
            {status.account ? '已绑定本地账号' : '尚未核验账号'}
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {status.account?.identity ? (
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                {status.account.identity}
              </code>
            ) : (
              '完成浏览器登录后将自动绑定本机账号标识'
            )}
          </p>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <MonitorIcon className="size-3.5 text-primary" />
              浏览器运行状态
            </span>
            <Badge variant={isHeaded ? 'warning' : browserConnected ? 'success' : 'secondary'} size="sm">
              {status.browser.mode === 'headed' ? '有头 Edge' : '无头 Edge'}
            </Badge>
          </div>
          <div className="mt-2 text-[13.5px] font-semibold text-foreground">
            {browserState(status.browser.state, status.automation?.emergencyStopped)}
          </div>
          <p className="mt-1 text-xs text-muted-foreground tabular-nums">
            {status.browser.version ? `版本 ${status.browser.version}` : '静音独占后台运行'}
          </p>
        </Card>

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
            activeAccountRef={activeAccountRef}
            onSelectWorkbenchAccount={onSelectWorkbenchAccount}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-5">
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
              <CardFrameTitle>浏览器窗口切换（无头 / 有头）</CardFrameTitle>
              <CardFrameDescription>
                日常默认无头静音运行；仅在需要重新登录或查看原页面时临时切至有头窗口
              </CardFrameDescription>
            </CardFrameHeader>
            <Card className="space-y-3.5 p-5">
              <p className="text-xs leading-relaxed text-muted-foreground">
                有头窗口打开期间，后台收取与自动回复会自动暂缓；操作完成后点击「返回无头运行」即可恢复值守。平台安全验证优先在客户端内直接操作原无头页面完成。
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!!busy || status.browser.state === 'MANUAL_VISIBLE'}
                  onClick={() =>
                    void act('打开有头浏览器', async () =>
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
                  打开有头浏览器
                </Button>
                {isHeaded && (
                  <Button
                    size="sm"
                    disabled={!!busy}
                    onClick={() =>
                      void act('恢复无头运行', async () =>
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
                    返回无头运行
                  </Button>
                )}
              </div>
            </Card>
          </CardFrame>
        </div>
      </div>
    </div>
  );
}
