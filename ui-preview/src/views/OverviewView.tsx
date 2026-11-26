import * as React from "react";
import {
  ActivityIcon,
  ArrowRightIcon,
  ArrowUpRightIcon,
  BookOpenIcon,
  ClockIcon,
  InboxIcon,
  LayersIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react";
import {
  ChannelSplitBar,
  MiniSparkline,
  QuotaProgress,
  UptimePulseBar,
} from "@/components/DataWidgets";
import { AccountAvatar, ContactAvatar, PLATFORM_META } from "@/components/PlatformBadge";
import { DonutGauge, HourlyHistogram, IntentBreakdownBars } from "@/components/RichVisuals";
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
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  ANALYTICS_SERIES,
  HOURLY_TRAFFIC,
  LIVE_FEED,
  TOP_INTENTS,
  type AccountItem,
  type PageId,
  type ThreadItem,
} from "@/data/mockData";

interface OverviewProps {
  accounts: AccountItem[];
  threads: ThreadItem[];
  syncing: boolean;
  autoReplyEnabled: boolean;
  activeModel: string;
  onSync: () => void;
  onNavigate: (page: PageId) => void;
  onJumpThread: (id: string) => void;
  onToggleAccountAuto: (id: string) => void;
  onOpenAccountSheet: (id: string) => void;
  onOpenAddAccount: () => void;
}

function InteractiveTrendChart({ range }: { range: "7d" | "14d" | "30d" }) {
  const data = ANALYTICS_SERIES[range];
  const [hovered, setHovered] = React.useState<number>(data.length - 1);
  React.useEffect(() => setHovered(data.length - 1), [data.length]);

  const W = 500;
  const H = 166;
  const padL = 34;
  const padR = 12;
  const padT = 14;
  const padB = 26;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const maxVal = Math.max(...data.map((d) => Math.max(d.auto, d.human))) * 1.18;

  const xAt = (i: number) =>
    data.length === 1 ? padL + innerW / 2 : padL + (i / (data.length - 1)) * innerW;
  const yAt = (v: number) => padT + innerH - (v / maxVal) * innerH;

  const autoPath = data
    .map((d, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)} ${yAt(d.auto).toFixed(1)}`)
    .join(" ");
  const humanPath = data
    .map((d, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)} ${yAt(d.human).toFixed(1)}`)
    .join(" ");
  const areaPath = `${autoPath} L${xAt(data.length - 1).toFixed(1)} ${(padT + innerH).toFixed(1)} L${xAt(0).toFixed(1)} ${(padT + innerH).toFixed(1)} Z`;

  const active = data[Math.min(hovered, data.length - 1)];

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-4">
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span className="size-2 rounded-full bg-chart-1" />
            自动回复确认
          </span>
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span className="size-2 rounded-full bg-chart-2" />
            人工接管回复
          </span>
        </div>
        <div className="flex items-center gap-2.5 rounded-lg bg-muted/65 px-2.5 py-1 text-[11px] tabular-nums">
          <span className="font-medium text-foreground">{active.label}</span>
          <span className="text-chart-1">自动 {active.auto}</span>
          <span className="text-chart-2">人工 {active.human}</span>
          <span className="text-muted-foreground">均响 {active.avgSec}s</span>
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="h-[166px] w-full overflow-visible">
        <defs>
          <linearGradient id="ovAutoFillRich" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity="0.01" />
          </linearGradient>
        </defs>
        {[0, 0.5, 1].map((t) => {
          const y = padT + innerH * (1 - t);
          return (
            <g key={t}>
              <line
                x1={padL}
                x2={W - padR}
                y1={y}
                y2={y}
                stroke="var(--border)"
                strokeDasharray={t === 0 ? undefined : "3 3"}
              />
              <text x={padL - 8} y={y + 3.5} textAnchor="end" fill="var(--muted-foreground)" fontSize="10">
                {Math.round(maxVal * t)}
              </text>
            </g>
          );
        })}

        <line
          x1={xAt(hovered)}
          x2={xAt(hovered)}
          y1={padT}
          y2={padT + innerH}
          stroke="var(--border)"
          strokeDasharray="2 2"
        />

        <path d={areaPath} fill="url(#ovAutoFillRich)" />
        <path d={autoPath} fill="none" stroke="var(--chart-1)" strokeWidth="2.1" strokeLinejoin="round" />
        <path d={humanPath} fill="none" stroke="var(--chart-2)" strokeWidth="1.8" strokeLinejoin="round" />

        {data.map((d, i) => {
          const cx = xAt(i);
          const isHot = i === hovered;
          return (
            <g key={d.label} className="cursor-pointer" onMouseEnter={() => setHovered(i)}>
              <rect x={cx - 24} y={padT} width={48} height={innerH + 22} fill="transparent" />
              <circle
                cx={cx}
                cy={yAt(d.auto)}
                r={isHot ? 4.4 : 2.8}
                fill="var(--card)"
                stroke="var(--chart-1)"
                strokeWidth="2"
              />
              <circle
                cx={cx}
                cy={yAt(d.human)}
                r={isHot ? 3.8 : 2.4}
                fill="var(--card)"
                stroke="var(--chart-2)"
                strokeWidth="1.8"
              />
              <text
                x={cx}
                y={H - 5}
                textAnchor="middle"
                fill={isHot ? "var(--foreground)" : "var(--muted-foreground)"}
                fontWeight={isHot ? "600" : "400"}
                fontSize="10.5"
              >
                {d.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function OverviewView({
  accounts,
  threads,
  syncing,
  autoReplyEnabled,
  activeModel,
  onSync,
  onNavigate,
  onJumpThread,
  onToggleAccountAuto,
  onOpenAccountSheet,
  onOpenAddAccount,
}: OverviewProps): React.ReactElement {
  const [chartRange, setChartRange] = React.useState<"7d" | "14d" | "30d">("7d");
  const [rightTab, setRightTab] = React.useState<"todo" | "feed">("todo");
  const [accFilter, setAccFilter] = React.useState("");

  const waiting = threads.filter((t) => t.status === "WAITING").length;
  const manual = threads.filter((t) => t.status === "MANUAL_ONLY").length;
  const todayAuto = accounts.reduce((s, a) => s + a.todayAuto, 0);
  const todayHuman = accounts.reduce((s, a) => s + a.todayHuman, 0);
  const totalToday = todayAuto + todayHuman;
  const autoShare = totalToday ? ((todayAuto / totalToday) * 100).toFixed(1) : "0.0";
  const focusThreads = threads.filter((t) => t.status !== "CONFIRMED" && t.status !== "UNCERTAIN");

  const filteredAccounts = accounts.filter(
    (a) =>
      !accFilter.trim() ||
      a.label.includes(accFilter.trim()) ||
      PLATFORM_META[a.platform].name.includes(accFilter.trim()),
  );

  const channelMix = [
    { platform: "douyin" as const, count: 212, color: "var(--chart-1)" },
    { platform: "wecom" as const, count: 111, color: "var(--chart-3)" },
    { platform: "wxkf" as const, count: 89, color: "var(--chart-4)" },
    { platform: "xiaohongshu" as const, count: 19, color: "var(--chart-2)" },
    { platform: "wechat_personal" as const, count: 9, color: "var(--chart-5)" },
  ];

  const donutSegments = [
    { label: "AI 自动确认", value: todayAuto, color: "var(--chart-1)" },
    { label: "人工确认回复", value: todayHuman, color: "var(--chart-2)" },
    { label: "媒体/规则拦截", value: 28, color: "var(--chart-3)" },
  ];

  return (
    <div className="mx-auto max-w-[1260px] space-y-4 px-6 py-5">
      {/* Studio Duty Header Band + Quick Action Shortcuts */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border/80 bg-gradient-to-r from-primary/[0.06] via-card to-card px-5 py-3.5 shadow-xs/5">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-semibold text-[18px] text-foreground">禾木手作 · 客服值守台</h1>
            <Badge variant={autoReplyEnabled ? "success" : "secondary"}>
              <span className={`size-1.5 rounded-full ${autoReplyEnabled ? "bg-success" : "bg-muted-foreground"}`} />
              {autoReplyEnabled ? "规则自动回复值守中" : "仅人工回复模式"}
            </Badge>
            <Badge variant="outline" className="bg-card/90 text-[11px]">
              <ClockIcon />
              今日值守 09:00 - 22:00
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            30 秒响应达标率 <strong className="text-foreground tabular-nums">98.4%</strong> · 自动额度剩余{" "}
            <strong className="text-foreground tabular-nums">169 / 500</strong> · 生效模型{" "}
            <code className="font-mono text-foreground">{activeModel}</code>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="xs" onClick={() => onNavigate("knowledge")}>
            <BookOpenIcon />
            知识库核对
          </Button>
          <Button variant="outline" size="xs" onClick={() => onNavigate("runtime")}>
            <ActivityIcon />
            审计日志
          </Button>
          <Button variant="outline" size="sm" onClick={onSync} disabled={syncing}>
            <RefreshCwIcon className={syncing ? "animate-spin" : ""} />
            {syncing ? "同步中" : "立即同步"}
          </Button>
          <Button size="sm" onClick={() => onNavigate("inbox")}>
            <InboxIcon />
            处理待办（{waiting + manual}）
          </Button>
        </div>
      </div>

      {/* Row 1: 4 Telemetry KPI Cards with Mini Sparklines */}
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="p-4">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>今日已回复</span>
            <Badge variant="success" size="sm">+14.2%</Badge>
          </div>
          <div className="mt-2 flex items-end justify-between gap-2">
            <div className="min-w-0">
              <div className="font-heading font-semibold text-[26px] leading-none tracking-[-0.02em] tabular-nums">
                {totalToday}
              </div>
              <div className="mt-1.5 whitespace-nowrap text-[11.5px] text-muted-foreground tabular-nums">
                自动 {todayAuto} ({autoShare}%) · 人工 {todayHuman}
              </div>
            </div>
            <MiniSparkline values={[290, 315, 342, 398, 372, 460, 440]} color="var(--chart-1)" width={70} />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>待处理会话</span>
            <Badge variant="warning" size="sm">{manual} 条含媒体</Badge>
          </div>
          <div className="mt-2 flex items-end justify-between gap-2">
            <div className="min-w-0">
              <div className="font-heading font-semibold text-[26px] leading-none tracking-[-0.02em] tabular-nums">
                {waiting + manual}
              </div>
              <div className="mt-1.5 whitespace-nowrap text-[11.5px] text-muted-foreground">
                含 1 条评论 · 1 条草稿待发
              </div>
            </div>
            <MiniSparkline values={[11, 9, 13, 8, 7, 6, 5]} color="var(--chart-2)" width={70} />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>平均首次响应</span>
            <Badge variant="success" size="sm">快 1.4s</Badge>
          </div>
          <div className="mt-2 flex items-end justify-between gap-2">
            <div className="min-w-0">
              <div className="font-heading font-semibold text-[26px] leading-none tracking-[-0.02em] tabular-nums">
                16.9s
              </div>
              <div className="mt-1.5 whitespace-nowrap text-[11.5px] text-muted-foreground">
                30 秒内回复达标率 98.4%
              </div>
            </div>
            <MiniSparkline values={[21.4, 20.1, 19.2, 18.4, 17.9, 16.2, 16.9]} color="var(--chart-3)" width={70} />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>知识库匹配率</span>
            <Badge variant="outline" size="sm">准确可靠</Badge>
          </div>
          <div className="mt-2 flex items-end justify-between gap-2">
            <div className="w-full space-y-1.5">
              <div className="flex items-baseline gap-2">
                <span className="font-heading font-semibold text-[26px] leading-none tracking-[-0.02em] tabular-nums">
                  84.6%
                </span>
                <span className="text-[11.5px] text-muted-foreground">参考店铺知识</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <QuotaProgress used={85} limit={100} />
                <span className="text-[11px] text-muted-foreground">今日额度 66%</span>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Row 2: 3-Column Multi-Chart Analytics & Operations Console */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.32fr_0.96fr_1.02fr]">
        {/* Col 1: Trend Line + 24h Traffic Peak Histogram + Channel Mix */}
        <CardFrame>
          <CardFrameHeader>
            <CardFrameTitle>回复趋势与高峰时段</CardFrameTitle>
            <CardFrameDescription>
              自动与人工接待趋势、高峰时段与渠道占比
            </CardFrameDescription>
            <CardFrameAction>
              <div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
                {(["7d", "14d", "30d"] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setChartRange(r)}
                    className={`cursor-pointer rounded-md px-2 py-0.5 text-[11px] font-medium ${
                      chartRange === r
                        ? "bg-card text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {r === "7d" ? "7天" : r === "14d" ? "14天" : "30天"}
                  </button>
                ))}
              </div>
            </CardFrameAction>
          </CardFrameHeader>
          <Card className="space-y-3.5 px-4 py-4">
            <InteractiveTrendChart range={chartRange} />
            <Separator />
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-foreground">今日分时段咨询分布（09:00 - 19:00）</span>
                <span className="text-[11px] text-muted-foreground tabular-nums">高峰 16:00 · 59 条</span>
              </div>
              <HourlyHistogram data={HOURLY_TRAFFIC} />
            </div>
            <Separator />
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-foreground">各平台消息占比</span>
                <button
                  type="button"
                  onClick={() => onNavigate("analytics")}
                  className="inline-flex cursor-pointer items-center gap-0.5 text-[11px] font-medium text-primary hover:underline"
                >
                  详细报表
                  <ArrowUpRightIcon className="size-3" />
                </button>
              </div>
              <ChannelSplitBar items={channelMix} />
            </div>
          </Card>
        </CardFrame>

        {/* Col 2: Automation Donut Ring + Top 5 Customer Intents Breakdown */}
        <CardFrame>
          <CardFrameHeader>
            <CardFrameTitle>处理构成与热门意图</CardFrameTitle>
            <CardFrameDescription>
              自动解决占比与近 24 小时高频客户咨询分类
            </CardFrameDescription>
          </CardFrameHeader>
          <Card className="flex flex-col justify-between space-y-4 px-4 py-4">
            <div className="flex items-center gap-4">
              <DonutGauge
                segments={donutSegments}
                centerValue={`${autoShare}%`}
                centerLabel="AI 自动解决"
                size={106}
                stroke={11}
              />
              <div className="min-w-0 flex-1 space-y-2 text-xs">
                {donutSegments.map((s) => (
                  <div key={s.label} className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                      <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
                      <span className="truncate">{s.label}</span>
                    </span>
                    <strong className="font-medium text-foreground tabular-nums">{s.value} 条</strong>
                  </div>
                ))}
              </div>
            </div>

            <Separator />

            <div className="space-y-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-foreground">热门客户咨询意图 Top 5</span>
                <Badge variant="outline" size="sm">自动归类</Badge>
              </div>
              <IntentBreakdownBars items={TOP_INTENTS} />
            </div>

            <div className="flex items-center justify-between rounded-xl border border-border/75 bg-muted/35 px-3 py-2 text-[11.5px]">
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <ShieldCheckIcon className="size-3.5 text-primary" />
                防重复发送保护已开启
              </span>
              <span className="font-mono text-primary">0 重复</span>
            </div>
          </Card>
        </CardFrame>

        {/* Col 3: Attention Queue / Live Activity Stream */}
        <CardFrame>
          <CardFrameHeader>
            <CardFrameTitle>值守队列与实时动态</CardFrameTitle>
            <CardFrameDescription>
              人工确认与自动外发流水
            </CardFrameDescription>
            <CardFrameAction>
              <div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
                <button
                  type="button"
                  onClick={() => setRightTab("todo")}
                  className={`cursor-pointer rounded-md px-2 py-0.5 text-[11px] font-medium ${
                    rightTab === "todo" ? "bg-card text-foreground shadow-xs" : "text-muted-foreground"
                  }`}
                >
                  待确认 ({focusThreads.length})
                </button>
                <button
                  type="button"
                  onClick={() => setRightTab("feed")}
                  className={`cursor-pointer rounded-md px-2 py-0.5 text-[11px] font-medium ${
                    rightTab === "feed" ? "bg-card text-foreground shadow-xs" : "text-muted-foreground"
                  }`}
                >
                  实时动态
                </button>
              </div>
            </CardFrameAction>
          </CardFrameHeader>

          <Card className="flex flex-col justify-between divide-y divide-border/70">
            <div className="divide-y divide-border/70">
              {rightTab === "todo"
                ? focusThreads.map((t) => {
                    const acc = accounts.find((a) => a.id === t.accountId) ?? accounts[0];
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => onJumpThread(t.id)}
                        className="flex w-full cursor-pointer items-center justify-between gap-2.5 px-4 py-3 text-left transition-colors hover:bg-muted/45 first:rounded-t-xl"
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <ContactAvatar
                            name={t.author}
                            platform={acc.platform}
                            avatarUrl={t.avatarUrl}
                            toneIndex={t.avatarTone}
                            size="sm"
                          />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate font-medium text-[13px] text-foreground">{t.author}</span>
                              <Badge variant={t.status === "MANUAL_ONLY" ? "warning" : "secondary"} size="sm">
                                {t.intentChip}
                              </Badge>
                            </div>
                            <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                              {acc.label} · {t.relatedItem?.name ?? t.leaseNote}
                            </p>
                          </div>
                        </div>
                        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{t.updatedAt}</span>
                      </button>
                    );
                  })
                : LIVE_FEED.map((f) => (
                    <div key={f.id} className="flex items-start justify-between gap-2.5 px-4 py-3 first:rounded-t-xl">
                      <div className="flex min-w-0 items-start gap-2.5">
                        <ContactAvatar
                          name={f.customer}
                          platform={f.platform}
                          avatarUrl={f.avatarUrl}
                          size="sm"
                        />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5 text-xs">
                            <span className="font-medium text-foreground">{f.customer}</span>
                            <Badge variant={f.mode === "AUTO" ? "success" : "secondary"} size="sm">
                              {f.mode === "AUTO" ? "自动送达" : "人工确认"}
                            </Badge>
                            <span className="text-[11px] text-muted-foreground tabular-nums">{f.latency}</span>
                          </div>
                          <p className="mt-0.5 text-[11.5px] text-muted-foreground">{f.excerpt}</p>
                          <div className="mt-1 inline-flex items-center gap-1 text-[10.5px] text-primary">
                            <SparklesIcon className="size-3" />
                            <span>引用：{f.docCited}</span>
                          </div>
                        </div>
                      </div>
                      <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{f.time}</span>
                    </div>
                  ))}
            </div>

            <div className="flex items-center justify-between rounded-b-xl bg-muted/25 px-4 py-2.5 text-[11.5px] text-muted-foreground">
              <span>当前队列平均等待 <strong className="text-foreground tabular-nums">4.2 分钟</strong></span>
              <button
                type="button"
                onClick={() => onNavigate("inbox")}
                className="inline-flex cursor-pointer items-center gap-1 font-medium text-primary hover:underline"
              >
                进入会话中心
                <ArrowRightIcon className="size-3" />
              </button>
            </div>
          </Card>
        </CardFrame>
      </div>

      {/* Row 3: Rich Multi-Account Operations Matrix with Column Headers & Search */}
      <CardFrame>
        <CardFrameHeader>
          <CardFrameTitle>各渠道账号值守概览（{filteredAccounts.length}）</CardFrameTitle>
          <CardFrameDescription>
            查看各平台在线心跳、今日接待量与自动回复开关
          </CardFrameDescription>
          <CardFrameAction>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-[176px]">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  size="sm"
                  value={accFilter}
                  onChange={(e) => setAccFilter(e.target.value)}
                  placeholder="筛选账号或平台..."
                  className="[&_input]:pl-7"
                />
              </div>
              <Button variant="outline" size="xs" onClick={() => onNavigate("accounts")}>
                全部管理
                <ArrowRightIcon />
              </Button>
              <Button size="xs" onClick={onOpenAddAccount}>
                <PlusIcon />
                接入账号
              </Button>
            </div>
          </CardFrameAction>
        </CardFrameHeader>
        <Card className="overflow-hidden">
          <div className="hidden grid-cols-[minmax(240px,1.3fr)_116px_150px_170px_144px] items-center gap-3 border-b border-border/80 bg-muted/35 px-5 py-2 text-[11px] font-medium text-muted-foreground lg:grid">
            <span>账号与渠道</span>
            <span>值守模式</span>
            <span>近 16h 在线</span>
            <span>今日回复（自动 / 额度）</span>
            <span className="text-right">自动回复 / 操作</span>
          </div>
          <div className="divide-y divide-border/70">
            {filteredAccounts.map((acc) => {
              const pf = PLATFORM_META[acc.platform];
              const total = acc.todayAuto + acc.todayHuman;
              return (
                <div
                  key={acc.id}
                  className="grid grid-cols-1 items-center gap-3 px-5 py-3 transition-colors hover:bg-muted/35 lg:grid-cols-[minmax(240px,1.3fr)_116px_150px_170px_144px]"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <AccountAvatar
                      label={acc.label}
                      platform={acc.platform}
                      avatarUrl={acc.avatarUrl}
                      size="sm"
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-medium text-[13.5px] text-foreground">{acc.label}</span>
                        <Badge variant={acc.status === "FOREGROUND_LIMITED" ? "secondary" : "success"} size="sm">
                          {acc.status === "FOREGROUND_LIMITED" ? "待命" : "在线"}
                        </Badge>
                      </div>
                      <p className="truncate text-[11.5px] text-muted-foreground">
                        {pf.name} · {acc.handle} · {acc.lastSync}
                      </p>
                    </div>
                  </div>

                  <div>
                    <Badge variant="outline" size="sm" className="gap-1">
                      <LayersIcon className="size-3 text-primary" />
                      {acc.serviceTier}
                    </Badge>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <ActivityIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <UptimePulseBar slots={acc.uptime24h} />
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground tabular-nums">
                      <span>{total} / {acc.dailyQuota}</span>
                      <span>自动 {acc.todayAuto}</span>
                    </div>
                    <QuotaProgress used={total} limit={acc.dailyQuota} />
                  </div>

                  <div className="flex items-center justify-end gap-2">
                    <Switch
                      checked={acc.autoReply}
                      onCheckedChange={() => onToggleAccountAuto(acc.id)}
                      aria-label={`${acc.label} 自动回复开关`}
                    />
                    <Button variant="outline" size="xs" onClick={() => onOpenAccountSheet(acc.id)}>
                      详情
                    </Button>
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
