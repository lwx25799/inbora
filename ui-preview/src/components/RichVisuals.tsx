import type * as React from "react";

export function DonutGauge({
  segments,
  centerValue,
  centerLabel,
  size = 112,
  stroke = 11,
}: {
  segments: Array<{ label: string; value: number; color: string }>;
  centerValue: string;
  centerLabel: string;
  size?: number;
  stroke?: number;
}): React.ReactElement {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  let offset = 0;

  return (
    <div className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--muted)"
          strokeWidth={stroke}
        />
        {segments.map((seg) => {
          const frac = seg.value / total;
          const dash = Math.max(frac * circ - 2, 0);
          const curOffset = offset;
          offset += frac * circ;
          return (
            <circle
              key={seg.label}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={seg.color}
              strokeWidth={stroke}
              strokeDasharray={`${dash} ${circ}`}
              strokeDashoffset={-curOffset}
              strokeLinecap="round"
            />
          );
        })}
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="font-semibold text-[16px] leading-none text-foreground tabular-nums">
          {centerValue}
        </span>
        <span className="mt-1 text-[10px] text-muted-foreground">{centerLabel}</span>
      </div>
    </div>
  );
}

export function HourlyHistogram({
  data,
}: {
  data: Array<{ hour: string; auto: number; human: number }>;
}): React.ReactElement {
  const max = Math.max(...data.map((d) => d.auto + d.human), 1);
  return (
    <div className="space-y-1.5">
      <div className="flex h-[74px] items-end gap-1.5 pt-2">
        {data.map((d) => {
          const total = d.auto + d.human;
          const hPct = Math.max(12, Math.round((total / max) * 100));
          const autoPct = total > 0 ? Math.round((d.auto / total) * 100) : 0;
          return (
            <div
              key={d.hour}
              className="group flex h-full flex-1 flex-col items-center justify-end gap-1"
              title={`${d.hour}:00 共 ${total} 条（自动 ${d.auto} / 人工 ${d.human}）`}
            >
              <div
                className="flex w-full flex-col justify-end overflow-hidden rounded-t-[4px] bg-chart-2/80 transition-opacity group-hover:opacity-85"
                style={{ height: `${hPct}%` }}
              >
                <div className="w-full bg-primary/85" style={{ height: `${autoPct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between text-[10px] text-muted-foreground tabular-nums">
        {data.map((d, i) => (
          <span key={d.hour} className={i % 2 === 0 ? "flex-1 text-center" : "flex-1 text-center opacity-0 sm:opacity-100"}>
            {d.hour}
          </span>
        ))}
      </div>
    </div>
  );
}

export function IntentBreakdownBars({
  items,
}: {
  items: Array<{ label: string; count: number; pct: number; tone: string }>;
}): React.ReactElement {
  return (
    <div className="space-y-2.5">
      {items.map((it) => (
        <div key={it.label} className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-foreground">{it.label}</span>
            <span className="text-[11.5px] text-muted-foreground tabular-nums">
              {it.count} 条 · <strong className="text-foreground">{it.pct}%</strong>
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full"
              style={{ width: `${it.pct}%`, backgroundColor: it.tone }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export function PersonaRadarSvg({
  axes,
}: {
  axes: Array<{ label: string; value: number; baseline: number }>;
}): React.ReactElement {
  const size = 216;
  const cx = size / 2;
  const cy = size / 2;
  const maxR = 72;
  const n = axes.length;

  const pointAt = (i: number, pct: number) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const r = (pct / 100) * maxR;
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)] as const;
  };

  const poly = (vals: number[]) =>
    vals
      .map((v, i) => {
        const [x, y] = pointAt(i, v);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");

  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="overflow-visible">
        {[25, 50, 75, 100].map((lvl) => (
          <polygon
            key={lvl}
            points={poly(axes.map(() => lvl))}
            fill="none"
            stroke="var(--border)"
            strokeWidth="1"
            strokeDasharray={lvl < 100 ? "2 2" : undefined}
          />
        ))}
        {axes.map((a, i) => {
          const [x, y] = pointAt(i, 100);
          const [lx, ly] = pointAt(i, 124);
          return (
            <g key={a.label}>
              <line x1={cx} y1={cy} x2={x} y2={y} stroke="var(--border)" strokeWidth="1" />
              <text
                x={lx}
                y={ly}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="var(--muted-foreground)"
                fontSize="10.5"
                fontWeight="500"
              >
                {a.label}
              </text>
            </g>
          );
        })}
        <polygon
          points={poly(axes.map((a) => a.baseline))}
          fill="var(--muted-foreground)"
          fillOpacity="0.12"
          stroke="var(--muted-foreground)"
          strokeWidth="1.2"
          strokeDasharray="3 2"
        />
        <polygon
          points={poly(axes.map((a) => a.value))}
          fill="var(--primary)"
          fillOpacity="0.18"
          stroke="var(--primary)"
          strokeWidth="2"
        />
        {axes.map((a, i) => {
          const [x, y] = pointAt(i, a.value);
          return <circle key={a.label} cx={x} cy={y} r="3.2" fill="var(--primary)" />;
        })}
      </svg>
      <div className="mt-1 flex items-center gap-4 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-primary" />
          当前人格 v2
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-[2px] w-3 border-t border-dashed border-muted-foreground" />
          初始基线 v1
        </span>
      </div>
    </div>
  );
}

export function CeramicThumb({
  sku,
  swatch,
}: {
  sku: string;
  swatch: string;
}): React.ReactElement {
  const isPot = sku.includes("CB") || sku.includes("B2B");
  const isBowl = sku.includes("GW");
  return (
    <div
      className="relative flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border/80 bg-muted/60"
      aria-hidden="true"
    >
      <svg width="46" height="46" viewBox="0 0 46 46" fill="none">
        <ellipse cx="23" cy="39" rx="14" ry="3" fill="black" fillOpacity="0.09" />
        {isPot ? (
          <>
            <path d="M12 22 C12 16 32 16 32 22 L30 34 C30 37 14 37 14 34 Z" fill={swatch} />
            <path d="M16 17 Q22 13 28 17" stroke={swatch} strokeWidth="2.4" strokeLinecap="round" />
            <circle cx="22" cy="13.5" r="2" fill={swatch} />
            <path d="M31 23 L40 20" stroke={swatch} strokeWidth="3.2" strokeLinecap="round" />
            <path d="M12 22 Q7 22 7 18" stroke={swatch} strokeWidth="2.4" strokeLinecap="round" />
            <path d="M16 22 C16 20 26 20 26 22" stroke="white" strokeOpacity="0.32" strokeWidth="1.5" strokeLinecap="round" />
          </>
        ) : isBowl ? (
          <>
            <path d="M10 21 C10 32 15 36 23 36 C31 36 36 32 36 21 Z" fill={swatch} />
            <path d="M9 20 Q23 14 37 20" stroke={swatch} strokeWidth="2.5" strokeLinecap="round" />
            <circle cx="23" cy="15" r="2.2" fill={swatch} />
            <ellipse cx="23" cy="37" rx="11" ry="1.8" fill={swatch} fillOpacity="0.65" />
            <path d="M15 24 Q23 27 31 24" stroke="white" strokeOpacity="0.3" strokeWidth="1.5" strokeLinecap="round" />
          </>
        ) : (
          <>
            <path d="M13 13 L33 13 L30.5 35 C30 37.5 16 37.5 15.5 35 Z" fill={swatch} />
            <ellipse cx="23" cy="13" rx="10" ry="2.4" fill="white" fillOpacity="0.24" stroke={swatch} strokeWidth="1.2" />
            <path d="M15 21 Q23 23.5 31 21" stroke="white" strokeOpacity="0.28" strokeWidth="1.6" strokeLinecap="round" />
            <path d="M18 16 L19 32" stroke="white" strokeOpacity="0.18" strokeWidth="2" strokeLinecap="round" />
          </>
        )}
      </svg>
    </div>
  );
}

export function ModelLatencyChart({
  items,
}: {
  items: Array<{ name: string; ms: number; calls: number; active: boolean }>;
}): React.ReactElement {
  const maxMs = Math.max(...items.map((i) => i.ms), 900);
  return (
    <div className="space-y-3">
      {items.map((it) => {
        const w = it.ms > 0 ? Math.max(10, Math.round((it.ms / maxMs) * 100)) : 0;
        return (
          <div key={it.name} className="grid grid-cols-[128px_1fr_64px] items-center gap-3 text-xs">
            <span className="truncate font-medium text-foreground">{it.name}</span>
            <div className="h-2.5 overflow-hidden rounded-full bg-muted">
              {it.ms > 0 ? (
                <div
                  className={`h-full rounded-full ${
                    it.active ? "bg-primary" : it.ms > 750 ? "bg-chart-2" : "bg-chart-3"
                  }`}
                  style={{ width: `${w}%` }}
                />
              ) : (
                <div className="h-full w-full bg-repeating-linear-gradient opacity-20" />
              )}
            </div>
            <span className="text-right font-mono text-[11.5px] text-muted-foreground tabular-nums">
              {it.ms > 0 ? `${it.ms} ms` : "未测速"}
            </span>
          </div>
        );
      })}
    </div>
  );
}
