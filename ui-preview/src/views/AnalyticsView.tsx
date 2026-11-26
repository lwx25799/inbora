import * as React from "react";
import { DownloadIcon } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { PLATFORM_META, PlatformMedallion } from "@/components/PlatformBadge";
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
import { ANALYTICS_SERIES, type AccountItem } from "@/data/mockData";

interface AnalyticsProps {
  accounts: AccountItem[];
  onExportCsv: (range: "7d" | "14d" | "30d") => void;
}

export function AnalyticsView({ accounts, onExportCsv }: AnalyticsProps): React.ReactElement {
  const [range, setRange] = React.useState<"7d" | "14d" | "30d">("7d");
  const series = ANALYTICS_SERIES[range];
  const sumAuto = series.reduce((s, d) => s + d.auto, 0);
  const sumHuman = series.reduce((s, d) => s + d.human, 0);
  const total = sumAuto + sumHuman;
  const autoPct = total ? ((sumAuto / total) * 100).toFixed(1) : "0.0";
  const avgSec = (series.reduce((s, d) => s + d.avgSec, 0) / series.length).toFixed(1);

  const W = 680;
  const H = 200;
  const padL = 42;
  const padR = 16;
  const padT = 18;
  const padB = 28;
  const maxVal = Math.max(...series.map((d) => d.auto + d.human)) * 1.15;
  const slotW = (W - padL - padR) / series.length;
  const barW = Math.min(36, slotW * 0.44);

  return (
    <div className="mx-auto max-w-[1160px] px-7 py-6">
      <AppHeader
        title="数据统计"
        description="基于本地确认送达账本聚合回复结构与响应效率，不含未送达或冻结记录"
        actions={
          <>
            <Tabs value={range} onValueChange={(v) => setRange(v as "7d" | "14d" | "30d")}>
              <TabsList>
                <TabsTab value="7d">近 7 天</TabsTab>
                <TabsTab value="14d">近 14 天</TabsTab>
                <TabsTab value="30d">近 30 天</TabsTab>
              </TabsList>
            </Tabs>
            <Button variant="outline" size="sm" onClick={() => onExportCsv(range)}>
              <DownloadIcon />
              导出 CSV
            </Button>
          </>
        }
      />

      <CardFrame className="mb-6">
        <Card className="overflow-hidden">
          <div className="grid grid-cols-2 divide-y divide-border/70 lg:grid-cols-4 lg:divide-x lg:divide-y-0">
            <div className="px-5 py-4">
              <div className="text-xs text-muted-foreground">确认送达总量</div>
              <div className="mt-1 font-semibold text-2xl tabular-nums">
                {total.toLocaleString("zh-CN")}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">全渠道权威回执口径</div>
            </div>
            <div className="px-5 py-4">
              <div className="text-xs text-muted-foreground">自动回复占比</div>
              <div className="mt-1 font-semibold text-2xl text-primary tabular-nums">
                {autoPct}%
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                自动 {sumAuto.toLocaleString("zh-CN")} · 人工 {sumHuman.toLocaleString("zh-CN")}
              </div>
            </div>
            <div className="px-5 py-4">
              <div className="text-xs text-muted-foreground">平均首响耗时</div>
              <div className="mt-1 font-semibold text-2xl tabular-nums">{avgSec}s</div>
              <div className="mt-0.5 text-xs text-muted-foreground">含巡检与送达回读</div>
            </div>
            <div className="px-5 py-4">
              <div className="text-xs text-muted-foreground">模型累计调用</div>
              <div className="mt-1 font-semibold text-2xl tabular-nums">684 次</div>
              <div className="mt-0.5 text-xs text-muted-foreground">含建议、人格与沙盒</div>
            </div>
          </div>
        </Card>
      </CardFrame>

      <CardFrame className="mb-6">
        <CardFrameHeader>
          <CardFrameTitle>自动回复与人工接管构成</CardFrameTitle>
          <CardFrameDescription>
            深松青为自动确认送达，暖赭色为人工接管确认送达
          </CardFrameDescription>
        </CardFrameHeader>
        <Card className="px-5 py-4">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-[200px] w-full" role="img" aria-label="回复构成柱状图">
            {[0, 0.33, 0.66, 1].map((r) => {
              const y = padT + (H - padT - padB) * (1 - r);
              return (
                <g key={r}>
                  <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="var(--border)" strokeDasharray={r === 0 ? undefined : "3 3"} />
                  <text x={padL - 8} y={y + 3.5} textAnchor="end" fontSize="10.5" fill="var(--muted-foreground)" className="tabular-nums">
                    {Math.round(maxVal * r)}
                  </text>
                </g>
              );
            })}
            {series.map((d, i) => {
              const cx = padL + slotW * (i + 0.5);
              const x = cx - barW / 2;
              const innerH = H - padT - padB;
              const autoH = (d.auto / maxVal) * innerH;
              const humanH = (d.human / maxVal) * innerH;
              const yAuto = H - padB - autoH;
              const yHuman = yAuto - humanH;
              return (
                <g key={d.label}>
                  <rect x={x} y={yAuto} width={barW} height={autoH} rx="4" fill="var(--chart-1)" />
                  <rect x={x} y={yHuman} width={barW} height={Math.max(humanH - 2, 0)} rx="4" fill="var(--chart-2)" />
                  <text x={cx} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--muted-foreground)" className="tabular-nums">
                    {d.label}
                  </text>
                </g>
              );
            })}
          </svg>
        </Card>
      </CardFrame>

      <CardFrame>
        <CardFrameHeader>
          <CardFrameTitle>今日各账号服务明细</CardFrameTitle>
          <CardFrameDescription>所有数值列等宽右对齐</CardFrameDescription>
        </CardFrameHeader>
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>账号</TableHead>
                <TableHead>平台通道</TableHead>
                <TableHead className="text-right">自动送达</TableHead>
                <TableHead className="text-right">人工送达</TableHead>
                <TableHead className="text-right">合计</TableHead>
                <TableHead className="text-right">自动占比</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.map((a) => {
                const sum = a.todayAuto + a.todayHuman;
                const pct = sum ? `${((a.todayAuto / sum) * 100).toFixed(1)}%` : "0.0%";
                return (
                  <TableRow key={a.id}>
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <PlatformMedallion platform={a.platform} size="sm" />
                        <span className="font-medium">{a.label}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {PLATFORM_META[a.platform].name} · {PLATFORM_META[a.platform].runtimeLabel}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{a.todayAuto}</TableCell>
                    <TableCell className="text-right tabular-nums">{a.todayHuman}</TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">{sum}</TableCell>
                    <TableCell className="text-right tabular-nums text-primary font-medium">{pct}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      </CardFrame>
    </div>
  );
}
