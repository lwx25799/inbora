import type * as React from "react";
import { PLATFORM_META } from "@/components/PlatformBadge";
import type { PlatformId } from "@/data/mockData";

export function MiniSparkline({
  values,
  color = "var(--chart-1)",
  width = 88,
  height = 28,
}: {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
}): React.ReactElement {
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = Math.max(max - min, 1);
  const step = width / Math.max(values.length - 1, 1);
  const pts = values.map((v, i) => ({
    x: i * step,
    y: height - 3 - ((v - min) / span) * (height - 6),
  }));
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const area = `${d} L${width} ${height} L0 ${height} Z`;
  const gid = `sp_${values.join("_").slice(0, 12)}`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="shrink-0 overflow-visible">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts[pts.length - 1].x} cy={pts[pts.length - 1].y} r="2.2" fill={color} />
    </svg>
  );
}

export function UptimePulseBar({
  slots,
}: {
  slots: Array<"ok" | "warn" | "idle">;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-[2.5px]" title="近 24 小时通道在线心跳（每格 1 小时）">
      {slots.map((s, i) => (
        <span
          key={i}
          className={`h-3.5 w-[4px] rounded-[2px] ${
            s === "ok"
              ? "bg-primary/75"
              : s === "warn"
                ? "bg-warning"
                : "bg-border"
          }`}
        />
      ))}
    </div>
  );
}

export function QuotaProgress({
  used,
  limit,
  tone = "primary",
}: {
  used: number;
  limit: number;
  tone?: "primary" | "amber";
}): React.ReactElement {
  const pct = Math.min(100, Math.round((used / Math.max(limit, 1)) * 100));
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${tone === "amber" ? "bg-chart-2" : "bg-primary"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[11px] text-muted-foreground tabular-nums">{pct}%</span>
    </div>
  );
}

export function ChannelSplitBar({
  items,
}: {
  items: Array<{ platform: PlatformId; count: number; color: string }>;
}): React.ReactElement {
  const total = items.reduce((s, i) => s + i.count, 0) || 1;
  return (
    <div className="space-y-2">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted gap-0.5">
        {items.map((it) => (
          <div
            key={it.platform}
            style={{ width: `${(it.count / total) * 100}%`, backgroundColor: it.color }}
            className="h-full first:rounded-l-full last:rounded-r-full"
            title={`${PLATFORM_META[it.platform].name}: ${it.count}`}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11.5px]">
        {items.map((it) => (
          <span key={it.platform} className="inline-flex items-center gap-1.5 text-muted-foreground tabular-nums">
            <span className="size-2 rounded-full" style={{ backgroundColor: it.color }} />
            <span className="text-foreground font-medium">{PLATFORM_META[it.platform].name}</span>
            <span>{((it.count / total) * 100).toFixed(1)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function ProviderGlyph({ id }: { id: string }): React.ReactElement {
  const map: Record<string, { label: string; bg: string; fg: string }> = {
    conn_deepseek: { label: "DS", bg: "bg-[#1d4f8a]/12 dark:bg-[#4b8fd9]/20", fg: "text-[#1d4f8a] dark:text-[#8ec2f5]" },
    conn_qwen: { label: "QW", bg: "bg-[#0f5c52]/12 dark:bg-[#30a08e]/20", fg: "text-[#0f5c52] dark:text-[#7ed9c8]" },
    conn_openai: { label: "OA", bg: "bg-[#1f2423]/10 dark:bg-white/12", fg: "text-foreground" },
    conn_anthropic: { label: "CL", bg: "bg-[#b86b14]/14 dark:bg-[#e09632]/20", fg: "text-[#92530a] dark:text-[#f5bc69]" },
  };
  const m = map[id] ?? { label: "AI", bg: "bg-muted", fg: "text-foreground" };
  return (
    <span className={`inline-flex size-9 shrink-0 items-center justify-center rounded-xl font-mono text-xs font-bold ${m.bg} ${m.fg} ring-1 ring-black/6 dark:ring-white/10`}>
      {m.label}
    </span>
  );
}

export function StyleRadarBars({
  metrics,
}: {
  metrics: Array<{ label: string; value: number; note: string }>;
}): React.ReactElement {
  return (
    <div className="space-y-3">
      {metrics.map((m) => (
        <div key={m.label} className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-foreground">{m.label}</span>
            <span className="text-muted-foreground tabular-nums">
              {m.note} · <strong className="text-foreground">{m.value}%</strong>
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary/80" style={{ width: `${m.value}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
