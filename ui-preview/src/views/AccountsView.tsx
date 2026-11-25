import * as React from "react";
import {
  CheckCircle2Icon,
  EyeIcon,
  MessageSquareIcon,
  MonitorIcon,
  PlusIcon,
  RadioIcon,
  SearchIcon,
  SparklesIcon,
} from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { QuotaProgress, UptimePulseBar } from "@/components/DataWidgets";
import { AccountAvatar, PLATFORM_META } from "@/components/PlatformBadge";
import { DonutGauge } from "@/components/RichVisuals";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardFrame,
  CardFrameAction,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import type { AccountItem, PlatformId } from "@/data/mockData";

interface AccountsProps {
  accounts: AccountItem[];
  securityHoldActive: boolean;
  onToggleAuto: (id: string) => void;
  onOpenDetail: (id: string) => void;
  onOpenAdd: () => void;
  onOpenVerify: () => void;
  onNotify: (msg: string) => void;
}

export function AccountsView({
  accounts,
  securityHoldActive,
  onToggleAuto,
  onOpenDetail,
  onOpenAdd,
  onOpenVerify,
  onNotify,
}: AccountsProps): React.ReactElement {
  const [filter, setFilter] = React.useState<"ALL" | PlatformId>("ALL");
  const [search, setSearch] = React.useState("");
  const list = accounts.filter(
    (a) =>
      (filter === "ALL" || a.platform === filter) &&
      (!search.trim() || a.label.includes(search.trim()) || a.handle.includes(search.trim())),
  );

  const activeCount = accounts.filter((a) => a.status === "ACTIVE").length;
  const autoEnabledCount = accounts.filter((a) => a.autoReply).length;
  const todayAuto = accounts.reduce((s, a) => s + a.todayAuto, 0);
  const todayHuman = accounts.reduce((s, a) => s + a.todayHuman, 0);
  const totalUsed = todayAuto + todayHuman;
  const autoPct = totalUsed ? Math.round((todayAuto / totalUsed) * 100) : 0;
  const totalLimit = accounts.reduce((s, a) => s + a.dailyQuota, 0);
  const quotaPct = Math.min(100, Math.round((totalUsed / Math.max(totalLimit, 1)) * 100));

  return (
    <div className="mx-auto max-w-[1240px] space-y-4 px-6 py-5">
      <AppHeader
        title="账号与通道"
        description="统一管理各平台店铺账号、在线状态、头像同步与自动回复开关"
        actions={
          <Button size="sm" onClick={onOpenAdd}>
            <PlusIcon />
            接入新账号
          </Button>
        }
      />

      {/* Row 1: 4 Operator-First Summary Cards w/ Dual Donut Rings */}
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl border border-border/80 bg-card p-4 shadow-xs/5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <CheckCircle2Icon className="size-3.5 text-primary" />
              在线值守账号
            </span>
            <Badge variant="success" size="sm">运行平稳</Badge>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="font-heading text-2xl font-semibold tabular-nums">
              {activeCount} / {accounts.length}
            </span>
            <span className="text-xs text-muted-foreground">覆盖 5 个平台</span>
          </div>
          <p className="mt-1.5 text-[11.5px] text-muted-foreground">
            各账号独立在线互不干扰，自动采集头像便于识别
          </p>
        </div>

        <div className="rounded-2xl border border-border/80 bg-card p-4 shadow-xs/5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <SparklesIcon className="size-3.5 text-primary" />
              自动回复开启
            </span>
            <Badge variant="info" size="sm">随时可切</Badge>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="font-heading text-2xl font-semibold tabular-nums">
              {autoEnabledCount} 个
            </span>
            <span className="text-xs text-muted-foreground">
              {accounts.length - autoEnabledCount} 个仅人工回复
            </span>
          </div>
          <p className="mt-1.5 text-[11.5px] text-muted-foreground">
            关闭自动回复后仍正常接收消息，随时可手动回复
          </p>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/80 bg-card p-4 shadow-xs/5">
          <div className="min-w-0 space-y-1">
            <div className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <MessageSquareIcon className="size-3.5 text-primary" />
              今日接待总量
            </div>
            <div className="font-heading text-xl font-semibold text-foreground tabular-nums">
              {totalUsed} 条
            </div>
            <p className="text-[11px] text-muted-foreground">
              自动 {todayAuto} · 人工 {todayHuman}
            </p>
          </div>
          <DonutGauge
            segments={[
              { label: "自动", value: todayAuto, color: "var(--chart-1)" },
              { label: "人工", value: todayHuman, color: "var(--chart-2)" },
            ]}
            centerValue={`${autoPct}%`}
            centerLabel="自动率"
            size={68}
            stroke={7}
          />
        </div>

        <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/80 bg-card p-4 shadow-xs/5">
          <div className="min-w-0 space-y-1">
            <div className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <RadioIcon className="size-3.5 text-primary" />
              今日发送额度
            </div>
            <div className="font-heading text-xl font-semibold text-foreground tabular-nums">
              {totalUsed} / {totalLimit}
            </div>
            <p className="text-[11px] text-muted-foreground">
              剩余可用 {Math.max(totalLimit - totalUsed, 0)} 条
            </p>
          </div>
          <DonutGauge
            segments={[
              { label: "已用", value: totalUsed, color: "var(--chart-3)" },
              { label: "剩余", value: Math.max(totalLimit - totalUsed, 0), color: "var(--muted)" },
            ]}
            centerValue={`${quotaPct}%`}
            centerLabel="额度"
            size={68}
            stroke={7}
          />
        </div>
      </div>

      {/* Platform Filter Tabs + Search */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={filter} onValueChange={(v) => setFilter(v as "ALL" | PlatformId)}>
          <TabsList>
            <TabsTab value="ALL">全部平台（{accounts.length}）</TabsTab>
            <TabsTab value="douyin">抖音</TabsTab>
            <TabsTab value="wecom">企业微信</TabsTab>
            <TabsTab value="wxkf">微信客服</TabsTab>
            <TabsTab value="xiaohongshu">小红书</TabsTab>
            <TabsTab value="wechat_personal">个人微信</TabsTab>
          </TabsList>
        </Tabs>
        <div className="relative w-full sm:w-[220px]">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            size="sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索账号名称或标识..."
            className="[&_input]:pl-7"
          />
        </div>
      </div>

      {/* Account Matrix */}
      <CardFrame>
        <CardFrameHeader>
          <CardFrameTitle>已接入账号（{list.length}）</CardFrameTitle>
          <CardFrameDescription>
            点击「查看页面」可临时打开对应平台后台窗口，关闭后继续静默值守
          </CardFrameDescription>
          <CardFrameAction>
            <span className="inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
              <MonitorIcon className="size-3.5 text-primary" />
              个人微信需保持电脑微信开启且未锁屏
            </span>
          </CardFrameAction>
        </CardFrameHeader>
        <Card className="overflow-hidden">
          <div className="hidden grid-cols-[minmax(250px,1.25fr)_215px_185px_236px] items-center gap-4 border-b border-border/80 bg-muted/35 px-5 py-2 text-[11px] font-medium text-muted-foreground xl:grid">
            <span>账号信息</span>
            <span>近 24h 在线与渠道</span>
            <span>今日回复与额度</span>
            <span className="text-right">自动回复与操作</span>
          </div>
          <div className="divide-y divide-border/70">
            {list.map((acc) => {
              const pf = PLATFORM_META[acc.platform];
              const isHeld = securityHoldActive && acc.id === "acc_dy_sub";
              const totalSent = acc.todayAuto + acc.todayHuman;
              const tierLabel =
                acc.serviceTier === "队列轮转"
                  ? "智能轮巡"
                  : acc.serviceTier === "官方接口"
                    ? "官方直连"
                    : acc.serviceTier === "前台按需"
                      ? "桌面协作"
                      : "持续在线";
              return (
                <div
                  key={acc.id}
                  className="grid grid-cols-1 items-center gap-4 px-5 py-3.5 transition-colors hover:bg-muted/35 xl:grid-cols-[minmax(250px,1.25fr)_215px_185px_236px]"
                >
                  <div className="flex min-w-0 items-center gap-3.5">
                    <AccountAvatar
                      label={acc.label}
                      platform={acc.platform}
                      avatarUrl={acc.avatarUrl}
                      size="md"
                    />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate font-semibold text-[14px] text-foreground">{acc.label}</span>
                        <Badge
                          variant={
                            isHeld
                              ? "warning"
                              : acc.status === "FOREGROUND_LIMITED"
                                ? "secondary"
                                : "success"
                          }
                          size="sm"
                        >
                          {isHeld
                            ? "需安全验证"
                            : acc.status === "FOREGROUND_LIMITED"
                              ? "桌面待命"
                              : "在线正常"}
                        </Badge>
                        <Badge variant="outline" size="sm">{tierLabel}</Badge>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                        <span>{pf.name}</span>
                        <span>·</span>
                        <span>{acc.handle}</span>
                        <span>·</span>
                        <span>上次同步 {acc.lastSync}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <div className="space-y-1">
                      <div className="text-[11px] text-muted-foreground">近 24h 在线</div>
                      <UptimePulseBar slots={acc.uptime24h} />
                    </div>
                    <div className="flex items-center gap-1">
                      {acc.channels.map((ch) => (
                        <Badge
                          key={ch}
                          variant={isHeld && ch === "COMMENT_NOTIFICATION" ? "warning" : "secondary"}
                          size="sm"
                        >
                          {ch === "DIRECT_MESSAGE" ? "私信" : "评论"}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground tabular-nums">
                      <span>今日 {totalSent} / {acc.dailyQuota}</span>
                      <span>自动 {acc.todayAuto}</span>
                    </div>
                    <QuotaProgress used={totalSent} limit={acc.dailyQuota} />
                  </div>

                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <div className="mr-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span>自动</span>
                      <Switch
                        checked={acc.autoReply}
                        onCheckedChange={() => onToggleAuto(acc.id)}
                        aria-label={`${acc.label} 自动回复开关`}
                      />
                    </div>
                    {isHeld && (
                      <Button size="xs" onClick={onOpenVerify}>去验证</Button>
                    )}
                    {pf.runtimeKind === "WEB_HEADLESS" && (
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() =>
                          onNotify(`已为你打开「${acc.label}」页面窗口，关闭后自动回到后台值守。`)
                        }
                      >
                        <EyeIcon />
                        查看页面
                      </Button>
                    )}
                    <Button variant="ghost" size="xs" onClick={() => onOpenDetail(acc.id)}>详情</Button>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </CardFrame>
    </div>
  );
}
