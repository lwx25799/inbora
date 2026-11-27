import type * as React from "react";
import {
  CpuIcon,
  MoonIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldCheckIcon,
  SunIcon,
} from "lucide-react";
import type { Status } from "@/api";
import { DESKTOP_PAGE_CRUMBS, type DesktopPageId } from "@/components/AppSidebar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatSyncLabel, modes } from "@/presentation";

export interface TopBarProps {
  page: DesktopPageId;
  theme: "light" | "dark";
  status: Status;
  busy: string;
  onSync: () => void;
  onToggleTheme: () => void;
  onOpenPalette: () => void;
  onNavigate: (page: DesktopPageId) => void;
}

function resolveActiveModel(status: Status): { label: string; configured: boolean } {
  const selection = status.modelProviders?.selection;
  if (selection?.modelId) {
    const display = selection.modelDisplayName?.trim();
    return { label: display || selection.modelId, configured: true };
  }
  if (status.modelProvidersSupported === true) {
    return { label: "未选全局模型", configured: false };
  }
  const legacyModel = status.settings.model?.trim();
  if (legacyModel) {
    return { label: legacyModel, configured: status.keyPresent };
  }
  return { label: "未配置模型", configured: false };
}

export function TopBar({
  page,
  theme,
  status,
  busy,
  onSync,
  onToggleTheme,
  onOpenPalette,
  onNavigate,
}: TopBarProps): React.ReactElement {
  const crumb = DESKTOP_PAGE_CRUMBS[page];
  const emergencyStopped = Boolean(status.automation?.emergencyStopped || status.paused);
  const securityHoldCount = status.securityHolds?.length ?? 0;
  const browserOpen = status.browser.state.startsWith("OPEN");
  const activeModel = resolveActiveModel(status);
  const syncLabel = formatSyncLabel(status.sync);
  const modeLabel = modes[status.configuredMode];

  const accountDotClass = emergencyStopped
    ? "bg-destructive"
    : securityHoldCount > 0
      ? "bg-warning"
      : browserOpen
        ? "bg-success"
        : "bg-muted-foreground/50";

  const accountPillLabel = emergencyStopped
    ? "已急停"
    : securityHoldCount > 0
      ? `${securityHoldCount} 项待核验`
      : status.account?.identity && browserOpen
        ? "本地账号在线"
        : browserOpen
          ? "浏览器已打开"
          : "正在连接账号";

  return (
    <header className="relative z-20 flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/80 bg-card/65 px-5 backdrop-blur-xs">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          <span className="shrink-0 text-muted-foreground">{crumb.group}</span>
          <span aria-hidden="true" className="text-muted-foreground/50">
            /
          </span>
          {page === "inbox" ? (
            <h1 className="truncate font-semibold text-foreground">{crumb.title}</h1>
          ) : (
            <span className="truncate font-semibold text-foreground">{crumb.title}</span>
          )}
        </div>

        <div className="hidden items-center gap-1.5 border-l border-border/80 pl-3 lg:flex">
          <button
            type="button"
            onClick={() => onNavigate("accounts")}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border/75 bg-background px-2 py-0.5 text-[11px] text-muted-foreground outline-none transition-colors hover:border-input hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className={cn("size-1.5 shrink-0 rounded-full", accountDotClass)} />
            <span className="whitespace-nowrap">{accountPillLabel}</span>
          </button>

          <button
            type="button"
            onClick={() => onNavigate("models")}
            title={`当前全局模型：${activeModel.label}`}
            className={cn(
              "inline-flex cursor-pointer items-center gap-1 rounded-md border border-border/75 bg-background px-2 py-0.5 font-mono text-[11px] outline-none transition-colors hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring",
              activeModel.configured ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <CpuIcon
              aria-hidden="true"
              className={cn(
                "size-3 shrink-0",
                activeModel.configured ? "text-primary" : "text-muted-foreground",
              )}
            />
            <span className="max-w-[180px] truncate">{activeModel.label}</span>
          </button>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onOpenPalette}
          aria-label="快速跳转与操作"
          title="快速跳转与操作 (Ctrl+K)"
          className="hidden h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-border/80 bg-background px-2 text-[11.5px] text-muted-foreground outline-none transition-colors hover:border-input hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring md:inline-flex"
        >
          <SearchIcon aria-hidden="true" className="size-3 shrink-0" />
          <span>快速跳转</span>
          <kbd className="rounded border border-border/80 bg-muted px-1 py-0 font-mono text-[10px] text-muted-foreground">
            Ctrl+K
          </kbd>
        </button>

        <Button
          variant="outline"
          size="xs"
          onClick={onSync}
          disabled={Boolean(busy) || status.sync.running}
        >
          <RefreshCwIcon
            aria-hidden="true"
            className={status.sync.running ? "animate-spin" : ""}
          />
          <span>{syncLabel}</span>
        </Button>

        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="切换浅色/深色主题"
          title={theme === "dark" ? "切换为暖白纸感（浅色）" : "切换为深松夜览（深色）"}
          onClick={onToggleTheme}
        >
          {theme === "dark" ? (
            <SunIcon aria-hidden="true" />
          ) : (
            <MoonIcon aria-hidden="true" />
          )}
        </Button>

        <button
          type="button"
          onClick={() => onNavigate("automation")}
          title={`当前工作模式：${modeLabel}（点击调整）`}
          className="ml-1 hidden cursor-pointer items-center gap-2 rounded-lg border border-border/75 bg-background px-2 py-1 outline-none transition-colors hover:border-input focus-visible:ring-2 focus-visible:ring-ring sm:flex"
        >
          <span className="inline-flex size-5 items-center justify-center rounded-md bg-primary/15 text-[11px] font-semibold text-primary">
            本
          </span>
          <span className="text-[11.5px] font-medium text-foreground">{modeLabel}</span>
          <ShieldCheckIcon aria-hidden="true" className="size-3 text-primary" />
        </button>
      </div>
    </header>
  );
}
