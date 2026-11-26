import type * as React from "react";
import type { PlatformId } from "@/data/mockData";

interface PlatformMeta {
  name: string;
  short: string;
  tileBg: string;
  tileFg: string;
  runtimeLabel: string;
  runtimeKind: "WEB_HEADLESS" | "OFFICIAL_API" | "FOREGROUND_UIA";
}

export const PLATFORM_META: Record<PlatformId, PlatformMeta> = {
  douyin: {
    name: "抖音",
    short: "抖",
    tileBg: "bg-[#1f2423] dark:bg-[#2b3331]",
    tileFg: "text-[#faf9f5]",
    runtimeLabel: "无头静音网页",
    runtimeKind: "WEB_HEADLESS",
  },
  wecom: {
    name: "企业微信",
    short: "企",
    tileBg: "bg-[#2563a8]/16 dark:bg-[#4b8fd9]/24",
    tileFg: "text-[#1d4f8a] dark:text-[#8ec2f5]",
    runtimeLabel: "官方接口直连",
    runtimeKind: "OFFICIAL_API",
  },
  wxkf: {
    name: "微信客服",
    short: "客",
    tileBg: "bg-[#158059]/16 dark:bg-[#1ea674]/24",
    tileFg: "text-[#0e6043] dark:text-[#68dca9]",
    runtimeLabel: "官方接口直连",
    runtimeKind: "OFFICIAL_API",
  },
  xiaohongshu: {
    name: "小红书",
    short: "红",
    tileBg: "bg-[#c83e36]/15 dark:bg-[#e0564e]/24",
    tileFg: "text-[#a82c25] dark:text-[#f29690]",
    runtimeLabel: "无头网页轮转",
    runtimeKind: "WEB_HEADLESS",
  },
  bilibili: {
    name: "B站",
    short: "B",
    tileBg: "bg-[#c2547d]/16 dark:bg-[#e0729b]/24",
    tileFg: "text-[#9a355b] dark:text-[#f39ebe]",
    runtimeLabel: "无头网页轮转",
    runtimeKind: "WEB_HEADLESS",
  },
  wechat_personal: {
    name: "个人微信",
    short: "微",
    tileBg: "bg-[#4f7a56]/17 dark:bg-[#6ca175]/24",
    tileFg: "text-[#365a3c] dark:text-[#98cf9f]",
    runtimeLabel: "前台受限通道",
    runtimeKind: "FOREGROUND_UIA",
  },
};

function PlatformGlyph({ platform, size = 12 }: { platform: PlatformId; size?: number }) {
  switch (platform) {
    case "douyin":
      return (
        <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9.5 3v6.5a2.5 2.5 0 1 1-1.8-2.4" />
          <path d="M9.5 3.2c.8 1.5 2 2.3 3.5 2.4" />
        </svg>
      );
    case "wecom":
      return (
        <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2.5" y="3" width="11" height="9" rx="2.5" />
          <path d="M5.5 7.5h5M8 5.5v4" />
        </svg>
      );
    case "wxkf":
      return (
        <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.5 9V7.8a4.5 4.5 0 0 1 9 0V9" />
          <rect x="2.2" y="8.5" width="2.4" height="3.8" rx="1" />
          <rect x="11.4" y="8.5" width="2.4" height="3.8" rx="1" />
          <path d="M12.5 12.2c0 1-.8 1.6-2 1.6H8.8" />
        </svg>
      );
    case "xiaohongshu":
      return (
        <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 2.8h8a1 1 0 0 1 1 1v9.4l-5-2.6-5 2.6V3.8a1 1 0 0 1 1-1Z" />
        </svg>
      );
    case "bilibili":
      return (
        <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="m5.5 2.5 1.8 2M10.5 2.5l-1.8 2" />
          <rect x="2.3" y="4.8" width="11.4" height="8.2" rx="2.2" />
          <path d="M6 8.3v1.4M10 8.3v1.4" />
        </svg>
      );
    case "wechat_personal":
      return (
        <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M13 8.2c0 2.1-2.2 3.8-5 3.8-.7 0-1.4-.1-2-.3L3.2 13l.7-2.2A3.6 3.6 0 0 1 3 8.2c0-2.1 2.2-3.8 5-3.8s5 1.7 5 3.8Z" />
        </svg>
      );
  }
}

export function PlatformMedallion({
  platform,
  size = "sm",
}: {
  platform: PlatformId;
  size?: "xs" | "sm" | "md";
}): React.ReactElement {
  const m = PLATFORM_META[platform];
  const dims =
    size === "xs"
      ? "size-4 rounded-[5px]"
      : size === "md"
        ? "size-7 rounded-lg"
        : "size-5.5 rounded-md";
  const gSize = size === "xs" ? 9 : size === "md" ? 15 : 12;
  return (
    <span
      title={m.name}
      className={`inline-flex shrink-0 items-center justify-center ${dims} ${m.tileBg} ${m.tileFg} ring-1 ring-black/6 dark:ring-white/10`}
    >
      <PlatformGlyph platform={platform} size={gSize} />
    </span>
  );
}

const AVATAR_TONES = [
  "bg-[#e6efe9] text-[#174f43] dark:bg-[#1e3630] dark:text-[#8fd9c9]",
  "bg-[#f3eae0] text-[#7c4b1e] dark:bg-[#382b1e] dark:text-[#e8bf8c]",
  "bg-[#e7ecf4] text-[#284c78] dark:bg-[#202d3d] dark:text-[#98c1f0]",
  "bg-[#f2e7e7] text-[#7d3330] dark:bg-[#382222] dark:text-[#eba29e]",
  "bg-[#ecebe4] text-[#4c4d3a] dark:bg-[#2c2d25] dark:text-[#cbcbb6]",
];

export function ContactAvatar({
  name,
  platform,
  avatarUrl,
  toneIndex = 0,
  size = "md",
  showPlatform = true,
  unreadCount,
}: {
  name: string;
  platform: PlatformId;
  avatarUrl?: string;
  toneIndex?: number;
  size?: "xs" | "sm" | "md" | "lg";
  showPlatform?: boolean;
  unreadCount?: number;
}): React.ReactElement {
  const tone = AVATAR_TONES[toneIndex % AVATAR_TONES.length];
  const initial = name.trim().slice(0, 1);
  const box =
    size === "xs"
      ? "size-7 rounded-lg text-[11px]"
      : size === "sm"
        ? "size-9 rounded-xl text-[13px]"
        : size === "lg"
          ? "size-12 rounded-2xl text-base"
          : "size-10 rounded-xl text-sm";

  return (
    <div className="relative inline-flex shrink-0">
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt={name}
          className={`object-cover ${box} ring-1 ring-black/10 shadow-xs/10 dark:ring-white/15`}
        />
      ) : (
        <div
          className={`flex items-center justify-center font-semibold ${box} ${tone} ring-1 ring-black/6 dark:ring-white/10`}
        >
          <span className={showPlatform ? "-translate-x-[1.5px] -translate-y-[1px]" : ""}>{initial}</span>
        </div>
      )}
      {showPlatform && size !== "xs" && (
        <span className="absolute -right-1 -bottom-1 rounded-[6px] bg-card p-[1.5px] shadow-xs ring-1 ring-black/5 dark:ring-white/10">
          <PlatformMedallion platform={platform} size="xs" />
        </span>
      )}
      {Boolean(unreadCount && unreadCount > 0) && (
        <span className="absolute -top-1 -left-1 inline-flex min-w-[16px] items-center justify-center rounded-full bg-primary px-1 text-[9.5px] font-semibold leading-[15px] text-primary-foreground shadow-xs ring-2 ring-card tabular-nums">
          {unreadCount}
        </span>
      )}
    </div>
  );
}

export function AccountAvatar({
  label,
  platform,
  avatarUrl,
  size = "md",
  statusDot,
}: {
  label: string;
  platform: PlatformId;
  avatarUrl?: string;
  size?: "xs" | "sm" | "md" | "lg";
  statusDot?: "online" | "warn" | "idle";
}): React.ReactElement {
  const box =
    size === "xs"
      ? "size-5 rounded-md"
      : size === "sm"
        ? "size-7 rounded-lg"
        : size === "lg"
          ? "size-12 rounded-2xl"
          : "size-9 rounded-xl";

  return (
    <div className="relative inline-flex shrink-0">
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt={label}
          className={`object-cover ${box} ring-1 ring-black/10 shadow-xs/10 dark:ring-white/15`}
        />
      ) : (
        <PlatformMedallion platform={platform} size={size === "xs" ? "xs" : size === "sm" ? "sm" : "md"} />
      )}
      {avatarUrl && size !== "xs" && (
        <span className="absolute -right-1 -bottom-1 rounded-[6px] bg-card p-[1.5px] shadow-xs ring-1 ring-black/5 dark:ring-white/10">
          <PlatformMedallion platform={platform} size="xs" />
        </span>
      )}
      {statusDot && (
        <span
          className={`absolute -top-0.5 -left-0.5 size-2 rounded-full ring-2 ring-sidebar ${
            statusDot === "online"
              ? "bg-success"
              : statusDot === "warn"
                ? "bg-warning"
                : "bg-muted-foreground/60"
          }`}
        />
      )}
    </div>
  );
}
