import type * as React from 'react';
import {
  ActivityIcon,
  ArrowRightIcon,
  BookOpenIcon,
  CpuIcon,
  InboxIcon,
  MessageSquareIcon,
  RadioIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  UsersIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardFrame,
  CardFrameAction,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
} from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  capabilityNames,
  modelPresetNames,
  reasons,
  type Inbox,
  type Status,
} from '@/api';
import {
  browserState,
  compactTime,
  formatSyncLabel,
  modes,
  replyStatusLabel,
  time,
} from '@/presentation';

import type { DesktopPageId } from '@/components/AppSidebar';
export type { DesktopPageId };

export interface OverviewViewProps {
  status: Status;
  inbox: Inbox;
  busy: string;
  pendingAutoReply: boolean | null;
  onNavigate: (page: DesktopPageId) => void;
  onSync: () => void | Promise<void>;
  onSelectEvent: (eventId: string) => void;
  onToggleAuto: (enabled: boolean) => void | Promise<void>;
}

function budgetPercent(used: number, maximum: number | null): number {
  if (maximum === null || maximum <= 0) return 0;
  return Math.min(100, Math.round((used / maximum) * 100));
}

export function OverviewView({
  status,
  inbox,
  busy,
  pendingAutoReply,
  onNavigate,
  onSync,
  onSelectEvent,
  onToggleAuto,
}: OverviewViewProps): React.ReactElement {
  const emergencyStopped = Boolean(status.automation?.emergencyStopped || status.paused);
  const hasPolicy = Boolean(status.automation?.replyPolicy);
  const autoOn = status.configuredMode === 'LIMITED_AUTO' && hasPolicy;
  const effectiveAuto = pendingAutoReply ?? autoOn;

  const waitingItems = inbox.items.filter(item => item.replyStatus === 'WAITING');
  const manualItems = inbox.items.filter(item => item.replyStatus === 'MANUAL_ONLY');
  const waitingCount = waitingItems.length;
  const manualCount = manualItems.length;
  const unreadTotal = inbox.unreadTotal ?? inbox.items.filter(item => item.unread).length;

  const modelBudget = status.budgets.find(b => b.kind === 'MODEL');
  const sendBudget = status.budgets.find(b => b.kind === 'SEND');

  const selection = status.modelProviders?.selection;
  const activeConn =
    selection && selection.connectionId !== null
      ? status.modelProviders?.connections.find(c => c.id === selection.connectionId)
      : undefined;
  const activeModelId =
    selection && selection.connectionId !== null
      ? selection.modelId
      : status.settings.model || '尚未应用模型';
  const activeModelTitle =
    selection && selection.connectionId !== null && selection.modelDisplayName
      ? selection.modelDisplayName
      : activeModelId;
  const activePresetLabel = activeConn?.applied?.presetId
    ? modelPresetNames[activeConn.applied.presetId]
    : activeConn?.presetId
      ? modelPresetNames[activeConn.presetId]
      : null;

  const browserConnected = status.browser.state.startsWith('OPEN');
  const holdsCount = status.securityHolds?.length ?? 0;

  const priorityItems = [
    ...inbox.items.filter(
      item => item.replyStatus === 'WAITING' || item.replyStatus === 'MANUAL_ONLY',
    ),
    ...inbox.items.filter(
      item => item.replyStatus !== 'WAITING' && item.replyStatus !== 'MANUAL_ONLY',
    ),
  ].slice(0, 8);

  return (
    <div className="mx-auto max-w-[1240px] space-y-5 px-6 py-5">
      {/* Duty Header Band */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border/80 bg-card px-5 py-4 shadow-xs/5">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-heading text-[18px] font-semibold text-foreground">
              客服值守总览
            </h1>
            <Badge
              variant={
                emergencyStopped ? 'error' : effectiveAuto ? 'success' : 'secondary'
              }
            >
              <span
                className={`size-1.5 rounded-full ${
                  emergencyStopped
                    ? 'bg-destructive'
                    : effectiveAuto
                      ? 'bg-success'
                      : 'bg-muted-foreground'
                }`}
              />
              {emergencyStopped
                ? '全局急停中'
                : pendingAutoReply !== null
                  ? pendingAutoReply
                    ? '正在开启自动回复…'
                    : '正在关闭自动回复…'
                  : effectiveAuto
                    ? '规则自动回复值守中'
                    : modes[status.configuredMode]}
            </Badge>
            <Badge variant={browserConnected ? 'outline' : 'warning'} size="sm">
              {status.browser.mode === 'headed' ? '登录窗口' : '后台静音'} ·{' '}
              {browserConnected ? '浏览器在线' : '等待连接'}
            </Badge>
            {holdsCount > 0 && (
              <Badge variant="warning" size="sm">
                <ShieldAlertIcon />
                {holdsCount} 个通道待核验
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground tabular-nums">
            账号：{status.account?.identity ? '已绑定本地账号' : '尚未核验账号'} · 当前生效模型：
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11.5px] text-foreground">
              {activeModelTitle}
            </code>
            {activePresetLabel ? `（${activePresetLabel}）` : ''}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {hasPolicy ? (
            <Button
              variant={effectiveAuto ? 'outline' : 'default'}
              size="sm"
              disabled={pendingAutoReply !== null || !!busy || emergencyStopped}
              onClick={() => void onToggleAuto(!effectiveAuto)}
            >
              <SparklesIcon />
              {effectiveAuto ? '暂停自动回复' : '开启自动回复'}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onNavigate('automation')}
            >
              <SlidersHorizontalIcon />
              配置自动回复规则
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={!!busy || status.sync.running}
            onClick={() => void onSync()}
          >
            <RefreshCwIcon className={status.sync.running ? 'animate-spin' : ''} />
            {formatSyncLabel(status.sync)}
          </Button>
          <Button size="sm" onClick={() => onNavigate('inbox')}>
            <InboxIcon />
            进入会话中心（{unreadTotal}）
          </Button>
        </div>
      </div>

      {/* Row 1: 4 Real Interactive Telemetry Cards */}
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        <button
          type="button"
          onClick={() => onNavigate('inbox')}
          className="group cursor-pointer rounded-2xl border border-border/85 bg-card p-4 text-left shadow-xs/5 transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <InboxIcon className="size-3.5 text-primary" />
              未读与待回复
            </span>
            <Badge variant={unreadTotal > 0 ? 'warning' : 'secondary'} size="sm">
              共 {inbox.total} 条
            </Badge>
          </div>
          <div className="mt-2.5 flex items-baseline gap-2">
            <span className="font-heading text-[26px] font-semibold leading-none tracking-[-0.02em] text-foreground tabular-nums">
              {unreadTotal}
            </span>
            <span className="text-xs text-muted-foreground">条未读</span>
          </div>
          <p className="mt-2 flex items-center justify-between gap-1 text-[11.5px] text-muted-foreground tabular-nums">
            <span className="truncate">
              当前列表等待回复 {waitingCount} 条 · 需人工查看 {manualCount} 条
            </span>
            <ArrowRightIcon aria-hidden="true" className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
          </p>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('automation')}
          className="group cursor-pointer rounded-2xl border border-border/85 bg-card p-4 text-left shadow-xs/5 transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <RadioIcon className="size-3.5 text-primary" />
              累计发送额度
            </span>
            <Badge variant="outline" size="sm">
              {sendBudget?.maximum === null ? '无上限' : '已设上限'}
            </Badge>
          </div>
          <div className="mt-2.5 flex items-baseline gap-2">
            <span className="font-heading text-[26px] font-semibold leading-none tracking-[-0.02em] text-foreground tabular-nums">
              {sendBudget ? sendBudget.used : 0}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">
              / {sendBudget ? (sendBudget.maximum === null ? '无上限' : sendBudget.maximum) : '未设置'}
            </span>
          </div>
          {sendBudget && sendBudget.maximum !== null ? (
            <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${budgetPercent(sendBudget.used, sendBudget.maximum)}%` }}
              />
            </div>
          ) : (
            <p className="mt-2 flex items-center justify-between gap-1 text-[11.5px] text-muted-foreground">
              <span className="truncate">已确认发送计数持久保存</span>
              <ArrowRightIcon aria-hidden="true" className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
            </p>
          )}
        </button>

        <button
          type="button"
          onClick={() => onNavigate('models')}
          className="group cursor-pointer rounded-2xl border border-border/85 bg-card p-4 text-left shadow-xs/5 transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <CpuIcon className="size-3.5 text-primary" />
              模型调用与 Token
            </span>
            <Badge variant={status.modelAuthorized ? 'success' : 'secondary'} size="sm">
              {status.modelAuthorized ? '已授权' : '未授权'}
            </Badge>
          </div>
          <div className="mt-2.5 flex items-baseline gap-2">
            <span className="font-heading text-[26px] font-semibold leading-none tracking-[-0.02em] text-foreground tabular-nums">
              {modelBudget ? modelBudget.used : status.usage.requests}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">
              / {modelBudget ? (modelBudget.maximum === null ? '无上限' : modelBudget.maximum) : '次请求'}
            </span>
          </div>
          <p className="mt-2 flex items-center justify-between gap-1 text-[11.5px] text-muted-foreground tabular-nums">
            <span className="truncate">
              输入 {status.usage.inputTokens.toLocaleString('zh-CN')} · 输出{' '}
              {status.usage.outputTokens.toLocaleString('zh-CN')}
            </span>
            <ArrowRightIcon aria-hidden="true" className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
          </p>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('accounts')}
          className="group cursor-pointer rounded-2xl border border-border/85 bg-card p-4 text-left shadow-xs/5 transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <ShieldCheckIcon className="size-3.5 text-primary" />
              通道与同步状态
            </span>
            <Badge variant={holdsCount > 0 ? 'warning' : 'success'} size="sm">
              {holdsCount > 0 ? '待核验' : '正常'}
            </Badge>
          </div>
          <div className="mt-2.5 flex items-baseline gap-2">
            <span className="font-heading text-[22px] font-semibold leading-none text-foreground tabular-nums">
              {status.capabilities.filter(c => c.state === 'SEND_AVAILABLE').length} /{' '}
              {status.capabilities.length || 2}
            </span>
            <span className="text-xs text-muted-foreground">通道可发送</span>
          </div>
          <p className="mt-2 flex items-center justify-between gap-1 text-[11.5px] text-muted-foreground">
            <span className="truncate">
              {browserState(status.browser.state, status.automation?.emergencyStopped)}
            </span>
            <ArrowRightIcon aria-hidden="true" className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
          </p>
        </button>
      </div>

      {/* Row 2: Pending Inbox Queue + Real Channel & Sync Status */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <CardFrame>
          <CardFrameHeader>
            <CardFrameTitle>优先待处理会话（{priorityItems.length}）</CardFrameTitle>
            <CardFrameDescription>
              点击任意消息直接跳转至会话中心查看上下文并回复
            </CardFrameDescription>
            <CardFrameAction>
              <Button variant="outline" size="xs" onClick={() => onNavigate('inbox')}>
                全部会话
                <ArrowRightIcon />
              </Button>
            </CardFrameAction>
          </CardFrameHeader>
          <Card className="overflow-hidden">
            {priorityItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
                <MessageSquareIcon className="size-6 text-muted-foreground/60" />
                <p className="text-sm font-medium text-foreground">当前没有待处理消息</p>
                <p className="max-w-sm text-xs text-muted-foreground">
                  点击上方「同步收件箱」读取最新私信和评论，或前往会话中心查看历史记录。
                </p>
              </div>
            ) : (
              <div className="divide-y divide-border/70">
                {priorityItems.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onSelectEvent(item.resumeEventId ?? item.id)}
                    className="flex w-full cursor-pointer items-start justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/45"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {item.unread && (
                          <span
                            className="size-2 shrink-0 rounded-full bg-primary"
                            aria-label="未读"
                          />
                        )}
                        <span className="truncate text-[13.5px] font-medium text-foreground">
                          {item.author || '当前联系人'}
                        </span>
                        <Badge variant="outline" size="sm">
                          {item.channel === 'DIRECT_MESSAGE' ? '私信' : '评论'}
                        </Badge>
                        <Badge
                          variant={
                            item.replyStatus === 'MANUAL_ONLY'
                              ? 'warning'
                              : item.replyStatus === 'REPLIED'
                                ? 'success'
                                : 'secondary'
                          }
                          size="sm"
                        >
                          {replyStatusLabel(item.replyStatus)}
                        </Badge>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {item.previewDirection === 'OUTGOING' ? '我：' : ''}
                        {item.displayText || item.preview || '（无文字摘要）'}
                      </p>
                    </div>
                    <span
                      className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
                      title={item.time ? time(item.time) : undefined}
                    >
                      {item.time ? compactTime(item.time) : ''}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Card>
        </CardFrame>

        <div className="flex flex-col gap-5">
          <CardFrame>
            <CardFrameHeader>
              <CardFrameTitle>通道能力与最近同步</CardFrameTitle>
              <CardFrameDescription>
                本机后台浏览器实时状态与各通道最近一次成功同步时间
              </CardFrameDescription>
              <CardFrameAction>
                <Button variant="outline" size="xs" onClick={() => onNavigate('accounts')}>
                  <UsersIcon />
                  管理账号
                </Button>
              </CardFrameAction>
            </CardFrameHeader>
            <Card className="space-y-3.5 p-4 text-xs">
              <div className="space-y-2">
                {status.capabilities.length === 0 ? (
                  <p className="text-muted-foreground">尚未收到通道能力状态。</p>
                ) : (
                  status.capabilities.map(c => (
                    <div
                      key={c.channel}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/75 bg-background px-3 py-2.5"
                    >
                      <span className="font-medium text-foreground">
                        {c.channel === 'DIRECT_MESSAGE' ? '私信通道' : '评论通道'}
                      </span>
                      <div className="flex flex-wrap items-center gap-1.5">
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
                        {c.reason && (
                          <span className="text-[11px] text-muted-foreground">
                            {reasons[c.reason] ?? c.reason}
                          </span>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>

              <Separator />

              <div className="space-y-1.5">
                <div className="font-medium text-foreground">最近同步记录</div>
                {status.lastSync.length === 0 ? (
                  <p className="text-muted-foreground">尚无成功同步记录</p>
                ) : (
                  status.lastSync.map(s => (
                    <div
                      key={s.channel}
                      className="flex items-center justify-between gap-2 text-muted-foreground tabular-nums"
                    >
                      <span>{s.channel === 'DIRECT_MESSAGE' ? '私信同步' : '评论同步'}</span>
                      <span className="text-foreground">{time(s.at)}</span>
                    </div>
                  ))
                )}
              </div>
            </Card>
          </CardFrame>

          <CardFrame>
            <CardFrameHeader>
              <CardFrameTitle>常用工作区入口</CardFrameTitle>
              <CardFrameDescription>直达知识库、模型连接与运行审计</CardFrameDescription>
            </CardFrameHeader>
            <Card className="grid grid-cols-2 gap-2.5 p-4">
              <Button
                variant="outline"
                size="sm"
                className="justify-start"
                onClick={() => onNavigate('knowledge')}
              >
                <BookOpenIcon />
                知识库与人格
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="justify-start"
                onClick={() => onNavigate('models')}
              >
                <CpuIcon />
                多模型配置
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="justify-start"
                onClick={() => onNavigate('automation')}
              >
                <SlidersHorizontalIcon />
                自动化规则
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="justify-start"
                onClick={() => onNavigate('runtime')}
              >
                <ActivityIcon />
                调度与审计
              </Button>
            </Card>
          </CardFrame>
        </div>
      </div>
    </div>
  );
}
