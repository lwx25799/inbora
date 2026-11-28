import { useEffect, useRef, useState } from "react";
import type * as React from "react";
import { DownloadIcon } from "lucide-react";
import { DEFAULT_ACCOUNT_ID } from "../../../src/contracts/account.js";
import type {
  AnalyticsRange,
  AnalyticsResponseTimingBasis,
  AnalyticsSummary,
} from "../../../src/contracts/analytics.js";
import { platformNames, requestForAccount } from "@/api";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardFrame,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { explainSafe } from "@/error-messages";
import { budgetKindLabel, formatBudgetLimit } from "@/presentation";

export type { AnalyticsRange, AnalyticsSummary };

export interface AnalyticsViewProps {
  activeAccountRef?: string | null;
  onExportCsv?: (csv: string, range: AnalyticsRange) => void;
}

const RANGE_LABELS: Record<AnalyticsRange, string> = {
  "7d": "近 7 天",
  "14d": "近 14 天",
  "30d": "近 30 天",
};

const FORMULA_INJECTION_RE = /^[\s\u0000-\u001F\u007F]*[=+\-@]|^[\u0000-\u001F\u007F]/u;

export function sanitizeCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let raw = String(value);
  if (FORMULA_INJECTION_RE.test(raw)) {
    raw = `'${raw}`;
  }
  const escaped = raw.replace(/"/gu, '""');
  return /[",\r\n]/u.test(escaped) ? `"${escaped}"` : escaped;
}

function allowlistedPlatformLabel(platform: string): string {
  return Object.hasOwn(platformNames, platform) ? platformNames[platform]! : "其他渠道";
}

function responseTimingLabel(basis: AnalyticsResponseTimingBasis): string {
  if (basis === "PLATFORM_SEND_AT") return "平均发出耗时";
  if (basis === "MIXED") return "平均响应/确认耗时（混合口径）";
  return "平均确认耗时";
}

function csvRow(cells: (string | number | null | undefined)[]): string {
  return cells.map(sanitizeCsvCell).join(",");
}

export function buildAnalyticsCsv(summary: AnalyticsSummary): string {
  const lines: string[] = [];
  lines.push(csvRow(["报表类型", "统计周期", "开始时间", "结束时间", "统计口径说明"]));
  lines.push(
    csvRow([
      "inbora 客服服务统计（不含聊天正文与账号原始标识）",
      RANGE_LABELS[summary.range] ?? summary.range,
      summary.sinceIso,
      summary.untilIso,
      "汇总与趋势/转人工为当期本账号；模型消耗为运行期累计；额度为全局共享；明细为全账号当期（账号以脱敏别名列示）",
    ]),
  );
  lines.push("");

  lines.push(
    csvRow([
      "确认送达总量(当期本账号)",
      "自动回复送达(当期本账号)",
      "FAQ直出送达(当期本账号)",
      "人工确认送达(当期本账号)",
      "历史未知来源送达(当期本账号)",
      "自动回复占比(%)",
      "FAQ直出占比(%)",
      "自动回复尝试次数",
      "自动回复成功率(%)",
      `${responseTimingLabel(summary.scopes.avgResponseBasis)}(秒)`,
      "模型累计调用次数(运行期)",
      "模型成功次数(运行期)",
      "模型失败次数(运行期)",
      "输入Token(运行期)",
      "输出Token(运行期)",
      "总Token(运行期)",
      "转人工总计(当期本账号)",
    ]),
  );
  lines.push(
    csvRow([
      summary.totals.confirmedTotal,
      summary.totals.autoConfirmed,
      summary.totals.faqDirectConfirmed,
      summary.totals.humanConfirmed,
      summary.totals.unknownConfirmed,
      (summary.totals.autoRate * 100).toFixed(1),
      (summary.totals.faqDirectRate * 100).toFixed(1),
      summary.totals.autoReplyAttempts,
      (summary.totals.autoReplySuccessRate * 100).toFixed(1),
      summary.totals.avgResponseMs === null
        ? "-"
        : (summary.totals.avgResponseMs / 1000).toFixed(1),
      summary.modelUsage.requests,
      summary.modelUsage.succeeded,
      summary.modelUsage.failed,
      summary.modelUsage.inputTokens,
      summary.modelUsage.outputTokens,
      summary.modelUsage.totalTokens,
      summary.handoffSummary.total,
    ]),
  );

  if (summary.budgets.length > 0) {
    lines.push("");
    lines.push(csvRow(["全局共享额度类别", "已使用", "上限"]));
    for (const budget of summary.budgets) {
      lines.push(
        csvRow([
          budgetKindLabel(budget.kind),
          budget.used,
          formatBudgetLimit(budget.maximum),
        ]),
      );
    }
  }

  lines.push("");
  lines.push(
    csvRow([
      "日期",
      "展示标签",
      "自动回复送达",
      "FAQ直出送达",
      "人工确认送达",
      "历史未知来源",
      "当日合计",
    ]),
  );
  for (const point of summary.dailySeries) {
    const dayTotal =
      point.autoConfirmed +
      point.faqDirectConfirmed +
      point.humanConfirmed +
      point.unknownConfirmed;
    lines.push(
      csvRow([
        point.date,
        point.label,
        point.autoConfirmed,
        point.faqDirectConfirmed,
        point.humanConfirmed,
        point.unknownConfirmed,
        dayTotal,
      ]),
    );
  }

  lines.push("");
  lines.push(csvRow(["转人工归因标识", "转人工归因类别", "触发次数", "占比(%)"]));
  const sortedHandoffs = [...summary.handoffSummary.byCategory].sort((a, b) => b.count - a.count);
  for (const bucket of sortedHandoffs) {
    lines.push(
      csvRow([
        bucket.key,
        bucket.label,
        bucket.count,
        bucket.percentage.toFixed(1),
      ]),
    );
  }

  lines.push("");
  lines.push(
    csvRow([
      "账号别名(全账号当期)",
      "平台通道",
      "自动回复送达",
      "FAQ直出送达",
      "人工确认送达",
      "历史未知来源",
      "确认合计",
      "自动占比(%)",
    ]),
  );
  summary.accountBreakdown.forEach((row, index) => {
    const autoCount = row.autoConfirmed + row.faqDirectConfirmed;
    const autoPct = row.totalConfirmed > 0 ? ((autoCount / row.totalConfirmed) * 100).toFixed(1) : "0.0";
    lines.push(
      csvRow([
        `账号 ${index + 1}`,
        allowlistedPlatformLabel(row.platform),
        row.autoConfirmed,
        row.faqDirectConfirmed,
        row.humanConfirmed,
        row.unknownConfirmed,
        row.totalConfirmed,
        autoPct,
      ]),
    );
  });

  return `\uFEFF${lines.join("\r\n")}`;
}

function triggerCsvDownload(csv: string, range: AnalyticsRange): void {
  if (typeof document === "undefined" || typeof URL === "undefined") return;
  if (typeof URL.createObjectURL !== "function") return;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `inbora-analytics-${range}.csv`;
    anchor.style.display = "none";
    document.body?.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

function formatPct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

export function AnalyticsView({
  activeAccountRef,
  onExportCsv,
}: AnalyticsViewProps): React.ReactElement {
  const resolvedAccountRef = activeAccountRef?.trim() || DEFAULT_ACCOUNT_ID;
  const [range, setRange] = useState<AnalyticsRange>("7d");
  const [loadedState, setLoadedState] = useState<{
    accountRef: string;
    range: AnalyticsRange;
    summary: AnalyticsSummary;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [exportNotice, setExportNotice] = useState("");
  const loadSeq = useRef(0);

  const summary =
    loadedState &&
    loadedState.accountRef === resolvedAccountRef &&
    loadedState.range === range
      ? loadedState.summary
      : null;

  useEffect(() => {
    let active = true;
    const seq = ++loadSeq.current;
    setLoading(true);
    setError("");
    setExportNotice("");

    void requestForAccount<AnalyticsSummary>(resolvedAccountRef, {
      command: "getAnalytics",
      range,
    })
      .then((result) => {
        if (!active || loadSeq.current !== seq) return;
        setLoadedState({
          accountRef: resolvedAccountRef,
          range,
          summary: result,
        });
      })
      .catch((cause) => {
        if (!active || loadSeq.current !== seq) return;
        setError(explainSafe(cause, "读取数据统计报表失败，请稍后重试。"));
      })
      .finally(() => {
        if (active && loadSeq.current === seq) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [range, resolvedAccountRef]);

  function handleExportCsv() {
    if (!summary) return;
    const csv = buildAnalyticsCsv(summary);
    if (onExportCsv) {
      onExportCsv(csv, range);
    } else {
      triggerCsvDownload(csv, range);
    }
    setExportNotice(`已导出「${RANGE_LABELS[range]}」汇总报表 CSV（不含客户正文与隐私字段）。`);
  }

  const series = summary?.dailySeries ?? [];
  const sortedHandoffBuckets = summary
    ? [...summary.handoffSummary.byCategory].sort((a, b) => b.count - a.count)
    : [];
  const topHandoff = sortedHandoffBuckets[0] ?? null;

  const W = 680;
  const H = 210;
  const padL = 44;
  const padR = 16;
  const padT = 18;
  const padB = 30;
  const maxDayTotal = Math.max(
    1,
    ...series.map(
      (d) =>
        d.autoConfirmed + d.faqDirectConfirmed + d.humanConfirmed + d.unknownConfirmed,
    ),
  );
  const chartCeiling = Math.ceil(maxDayTotal * 1.15);
  const slotW = series.length > 0 ? (W - padL - padR) / series.length : W - padL - padR;
  const barW = Math.min(34, Math.max(8, slotW * 0.46));
  const labelStride = series.length > 16 ? 5 : series.length > 10 ? 2 : 1;

  return (
    <div className="mx-auto max-w-[1220px] space-y-5 px-6 py-5">
      <PageHeader
        title="数据统计"
        description="基于本地已确认送达记录聚合回复结构、模型消耗与转人工原因，不含未送达或待核对消息"
        actions={
          <>
            <Tabs value={range} onValueChange={(value) => setRange(value as AnalyticsRange)}>
              <TabsList>
                <TabsTab value="7d">近 7 天</TabsTab>
                <TabsTab value="14d">近 14 天</TabsTab>
                <TabsTab value="30d">近 30 天</TabsTab>
              </TabsList>
            </Tabs>
            <Button
              variant="outline"
              size="sm"
              disabled={loading || !summary}
              onClick={handleExportCsv}
            >
              <DownloadIcon aria-hidden="true" />
              导出 CSV
            </Button>
          </>
        }
      />

      {error && (
        <div
          className="rounded-xl border border-destructive/30 bg-destructive/8 px-4 py-2.5 text-xs font-medium text-destructive-foreground"
          role="alert"
        >
          {error}
        </div>
      )}

      {exportNotice && (
        <div
          className="rounded-xl border border-success/30 bg-success/8 px-4 py-2.5 text-xs font-medium text-success-foreground"
          role="status"
        >
          {exportNotice}
        </div>
      )}

      {loading && !summary ? (
        <Card className="p-8 text-center text-xs text-muted-foreground">
          正在汇总「{RANGE_LABELS[range]}」数据统计…
        </Card>
      ) : summary ? (
        <>
          {/* 4 KPI Summary Cards */}
          <CardFrame>
            <Card className="overflow-hidden">
              <div className="grid grid-cols-1 divide-y divide-border/70 sm:grid-cols-2 lg:grid-cols-4 lg:divide-x lg:divide-y-0">
                <div className="px-5 py-4">
                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>确认送达总量</span>
                    <Badge variant="outline" size="sm">当期本账号</Badge>
                  </div>
                  <div className="mt-1 font-heading text-2xl font-semibold text-foreground tabular-nums">
                    {summary.totals.confirmedTotal.toLocaleString("zh-CN")}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                    自动 {summary.totals.autoConfirmed.toLocaleString("zh-CN")} · FAQ 直出{" "}
                    {summary.totals.faqDirectConfirmed.toLocaleString("zh-CN")} · 人工{" "}
                    {summary.totals.humanConfirmed.toLocaleString("zh-CN")}
                    {summary.totals.unknownConfirmed > 0
                      ? ` · 未知来源 ${summary.totals.unknownConfirmed.toLocaleString("zh-CN")}`
                      : ""}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
                    {summary.totals.avgResponseMs === null
                      ? "暂无耗时样本"
                      : `${responseTimingLabel(summary.scopes.avgResponseBasis)} ${(summary.totals.avgResponseMs / 1000).toFixed(1)}s`}
                  </div>
                </div>

                <div className="px-5 py-4">
                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>自动回复占比</span>
                    <Badge variant="outline" size="sm">当期本账号</Badge>
                  </div>
                  <div className="mt-1 font-heading text-2xl font-semibold text-primary tabular-nums">
                    {formatPct(summary.totals.autoRate)}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                    FAQ 直出占比 {formatPct(summary.totals.faqDirectRate)}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
                    自动回复成功率 {formatPct(summary.totals.autoReplySuccessRate)}（共{" "}
                    {summary.totals.autoReplyAttempts.toLocaleString("zh-CN")} 次触发）
                  </div>
                </div>

                <div className="px-5 py-4">
                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>额度与模型消耗</span>
                    <Badge variant="outline" size="sm">全局共享额度</Badge>
                  </div>
                  <div className="mt-1 font-heading text-2xl font-semibold text-foreground tabular-nums">
                    {summary.modelUsage.requests.toLocaleString("zh-CN")} 次
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                    运行期累计 · 成功 {summary.modelUsage.succeeded.toLocaleString("zh-CN")} · 失败{" "}
                    {summary.modelUsage.failed.toLocaleString("zh-CN")} · Token{" "}
                    {summary.modelUsage.totalTokens.toLocaleString("zh-CN")}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground tabular-nums">
                    {summary.budgets.length > 0
                      ? `共享额度：${summary.budgets
                          .map(
                            (b) =>
                              `${budgetKindLabel(b.kind)} ${b.used}/${formatBudgetLimit(b.maximum)}`,
                          )
                          .join(" · ")}`
                      : "未配置共享额度上限"}
                  </div>
                </div>

                <div className="px-5 py-4">
                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>转人工触发总计</span>
                    <Badge variant="outline" size="sm">当期本账号</Badge>
                  </div>
                  <div className="mt-1 font-heading text-2xl font-semibold text-foreground tabular-nums">
                    {summary.handoffSummary.total.toLocaleString("zh-CN")} 次
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {topHandoff
                      ? `主要原因：${topHandoff.label}（${topHandoff.percentage.toFixed(1)}%）`
                      : "周期内暂无转人工触发"}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
                    涉及 {sortedHandoffBuckets.length} 类转人工归因
                  </div>
                </div>
              </div>
            </Card>
          </CardFrame>

          {/* Stacked Bar Chart + Handoff Attribution */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
            <CardFrame>
              <CardFrameHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <CardFrameTitle>自动回复、FAQ 直出与人工回复构成</CardFrameTitle>
                    <CardFrameDescription>
                      深松青为策略自动回复，湖松绿为 FAQ 直出，暖赭色为人工接管确认送达
                    </CardFrameDescription>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="size-2.5 rounded-xs bg-[var(--chart-1)]" />
                      自动回复
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="size-2.5 rounded-xs bg-[var(--chart-3)]" />
                      FAQ 直出
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="size-2.5 rounded-xs bg-[var(--chart-2)]" />
                      人工回复
                    </span>
                    {summary.totals.unknownConfirmed > 0 && (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="size-2.5 rounded-xs bg-[var(--chart-4)]" />
                        未知来源
                      </span>
                    )}
                  </div>
                </div>
              </CardFrameHeader>
              <Card className="px-5 py-4">
                {series.length === 0 ? (
                  <p className="py-16 text-center text-xs text-muted-foreground">
                    当前统计周期暂无每日趋势数据
                  </p>
                ) : (
                  <svg
                    viewBox={`0 0 ${W} ${H}`}
                    className="h-[210px] w-full"
                    role="img"
                    aria-label="自动回复、FAQ 直出与人工回复构成柱状图"
                  >
                    {[0, 0.33, 0.66, 1].map((r) => {
                      const y = padT + (H - padT - padB) * (1 - r);
                      return (
                        <g key={r}>
                          <line
                            x1={padL}
                            y1={y}
                            x2={W - padR}
                            y2={y}
                            stroke="var(--border)"
                            strokeDasharray={r === 0 ? undefined : "3 3"}
                          />
                          <text
                            x={padL - 8}
                            y={y + 3.5}
                            textAnchor="end"
                            fontSize="10.5"
                            fill="var(--muted-foreground)"
                            className="tabular-nums"
                          >
                            {Math.round(chartCeiling * r)}
                          </text>
                        </g>
                      );
                    })}
                    {series.map((d, i) => {
                      const cx = padL + slotW * (i + 0.5);
                      const x = cx - barW / 2;
                      const innerH = H - padT - padB;
                      const autoH = (d.autoConfirmed / chartCeiling) * innerH;
                      const faqH = (d.faqDirectConfirmed / chartCeiling) * innerH;
                      const humanH = (d.humanConfirmed / chartCeiling) * innerH;
                      const unknownH = (d.unknownConfirmed / chartCeiling) * innerH;
                      const yAuto = H - padB - autoH;
                      const yFaq = yAuto - faqH;
                      const yHuman = yFaq - humanH;
                      const yUnknown = yHuman - unknownH;
                      const showLabel = i % labelStride === 0 || i === series.length - 1;
                      return (
                        <g key={d.date}>
                          {autoH > 0 && (
                            <rect
                              x={x}
                              y={yAuto}
                              width={barW}
                              height={autoH}
                              rx="3"
                              fill="var(--chart-1)"
                            />
                          )}
                          {faqH > 0 && (
                            <rect
                              x={x}
                              y={yFaq}
                              width={barW}
                              height={Math.max(faqH - 1, 1)}
                              rx="3"
                              fill="var(--chart-3)"
                            />
                          )}
                          {humanH > 0 && (
                            <rect
                              x={x}
                              y={yHuman}
                              width={barW}
                              height={Math.max(humanH - 1, 1)}
                              rx="3"
                              fill="var(--chart-2)"
                            />
                          )}
                          {unknownH > 0 && (
                            <rect
                              x={x}
                              y={yUnknown}
                              width={barW}
                              height={Math.max(unknownH - 1, 1)}
                              rx="3"
                              fill="var(--chart-4)"
                            />
                          )}
                          {showLabel && (
                            <text
                              x={cx}
                              y={H - 8}
                              textAnchor="middle"
                              fontSize="10.5"
                              fill="var(--muted-foreground)"
                              className="tabular-nums"
                            >
                              {d.label}
                            </text>
                          )}
                        </g>
                      );
                    })}
                  </svg>
                )}
              </Card>
            </CardFrame>

            <CardFrame>
              <CardFrameHeader>
                <div className="flex items-center justify-between gap-2">
                  <CardFrameTitle>转人工归因分布</CardFrameTitle>
                  <Badge variant="outline" size="sm" className="tabular-nums">
                    共 {summary.handoffSummary.total} 次
                  </Badge>
                </div>
                <CardFrameDescription>
                  按触发原因汇总频次与占比，便于持续补全知识库与自动规则
                </CardFrameDescription>
              </CardFrameHeader>
              <Card className="p-5">
                {sortedHandoffBuckets.length === 0 ? (
                  <p className="py-14 text-center text-xs text-muted-foreground">
                    当前统计周期内暂无转人工触发记录
                  </p>
                ) : (
                  <div className="space-y-3.5">
                    {sortedHandoffBuckets.map((bucket) => (
                      <div key={bucket.key} className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="truncate font-medium text-foreground">
                            {bucket.label || bucket.key}
                          </span>
                          <span className="shrink-0 text-muted-foreground tabular-nums">
                            {bucket.count.toLocaleString("zh-CN")} 次 ·{" "}
                            {bucket.percentage.toFixed(1)}%
                          </span>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-primary transition-[width] duration-200"
                            style={{
                              width: `${Math.min(100, Math.max(0, bucket.percentage))}%`,
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </CardFrame>
          </div>

          {/* Per-Account Breakdown Table */}
          <CardFrame>
            <CardFrameHeader>
              <div className="flex items-center justify-between gap-2">
                <CardFrameTitle>各账号服务明细</CardFrameTitle>
                <Badge variant="outline" size="sm">全账号明细（当期）</Badge>
              </div>
              <CardFrameDescription>
                统计周期内全部已接入账号的确认送达分布（数值列等宽右对齐，导出 CSV 时以脱敏别名列示）
              </CardFrameDescription>
            </CardFrameHeader>
            <Card className="overflow-hidden">
              {summary.accountBreakdown.length === 0 ? (
                <p className="px-5 py-8 text-center text-xs text-muted-foreground">
                  当前统计周期内暂无账号确认送达记录
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>账号</TableHead>
                      <TableHead>平台通道</TableHead>
                      <TableHead className="text-right">自动回复</TableHead>
                      <TableHead className="text-right">FAQ 直出</TableHead>
                      <TableHead className="text-right">人工回复</TableHead>
                      <TableHead className="text-right">未知来源</TableHead>
                      <TableHead className="text-right">确认合计</TableHead>
                      <TableHead className="text-right">自动占比</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {summary.accountBreakdown.map((row, index) => {
                      const autoTotal = row.autoConfirmed + row.faqDirectConfirmed;
                      const pct =
                        row.totalConfirmed > 0
                          ? `${((autoTotal / row.totalConfirmed) * 100).toFixed(1)}%`
                          : "0.0%";
                      return (
                        <TableRow key={row.accountId}>
                          <TableCell className="font-medium text-foreground">
                            {row.displayLabel || `账号 ${index + 1}`}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {allowlistedPlatformLabel(row.platform)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {row.autoConfirmed.toLocaleString("zh-CN")}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {row.faqDirectConfirmed.toLocaleString("zh-CN")}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {row.humanConfirmed.toLocaleString("zh-CN")}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {row.unknownConfirmed.toLocaleString("zh-CN")}
                          </TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">
                            {row.totalConfirmed.toLocaleString("zh-CN")}
                          </TableCell>
                          <TableCell className="text-right font-medium text-primary tabular-nums">
                            {pct}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </Card>
          </CardFrame>
        </>
      ) : null}
    </div>
  );
}
