import * as React from "react";
import {
  ActivityIcon,
  BookOpenIcon,
  CpuIcon,
  InboxIcon,
  LayoutDashboardIcon,
  MoonIcon,
  PanelLeftIcon,
  RefreshCwIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  SunIcon,
  UsersIcon,
} from "lucide-react";
import type { Status } from "@/api";
import { BrandTile, BrandWordmark } from "@/components/BrandLogo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { browserState, time } from "@/presentation";

export type DesktopPageId =
  | "overview"
  | "inbox"
  | "accounts"
  | "automation"
  | "knowledge"
  | "models"
  | "runtime"
  | "settings";

export interface DesktopNavItem {
  id: DesktopPageId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

export interface DesktopNavGroup {
  label: string;
  items: DesktopNavItem[];
}

export const DESKTOP_NAV_GROUPS: DesktopNavGroup[] = [
  {
    label: "日常运营",
    items: [
      { id: "overview", label: "工作台总览", icon: LayoutDashboardIcon },
      { id: "inbox", label: "会话中心", icon: InboxIcon },
    ],
  },
  {
    label: "资产与智能",
    items: [
      { id: "accounts", label: "账号与通道", icon: UsersIcon },
      { id: "automation", label: "自动化规则", icon: SlidersHorizontalIcon },
      { id: "knowledge", label: "知识库与人格", icon: BookOpenIcon },
      { id: "models", label: "多模型配置", icon: CpuIcon },
    ],
  },
  {
    label: "治理与系统",
    items: [
      { id: "runtime", label: "调度与审计", icon: ActivityIcon },
      { id: "settings", label: "系统设置", icon: SettingsIcon },
    ],
  },
];

export const DESKTOP_PAGE_CRUMBS: Record<DesktopPageId, { group: string; title: string }> = {
  overview: { group: "日常运营", title: "工作台总览" },
  inbox: { group: "日常运营", title: "会话中心" },
  accounts: { group: "资产与智能", title: "账号与通道" },
  automation: { group: "资产与智能", title: "自动化规则" },
  knowledge: { group: "资产与智能", title: "知识库与人格" },
  models: { group: "资产与智能", title: "多模型配置" },
  runtime: { group: "治理与系统", title: "调度与审计" },
  settings: { group: "治理与系统", title: "系统设置" },
};

export interface AppSidebarProps {
  page: DesktopPageId;
  collapsed: boolean;
  theme: "light" | "dark";
  status: Status;
  version: string;
  busy: string;
  pendingCount: number;
  pendingAutoReply: boolean | null;
  onSelectPage: (page: DesktopPageId) => void;
  onSetCollapsed: (collapsed: boolean) => void;
  onToggleTheme: () => void;
  onToggleAutoReply: (enabled: boolean) => void;
  onReconnect: () => void;
}

type BudgetEntry = Status["budgets"][number];

function findBudget(budgets: Status["budgets"], kind: "SEND" | "MODEL"): BudgetEntry | undefined {
  return budgets.find((item) => item.kind.toUpperCase() === kind);
}

function formatBudgetText(budget: BudgetEntry | undefined): string {
  if (!budget) return "0 / 未设";
  return budget.maximum === null ? `${budget.used} / 不限` : `${budget.used} / ${budget.maximum}`;
}

function computeBudgetPercent(budget: BudgetEntry | undefined): number {
  if (!budget || budget.maximum === null || budget.maximum <= 0) return 0;
  return Math.min(100, Math.round((budget.used / budget.maximum) * 100));
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function AutoReplySwitch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}): React.ReactElement {
  return (
    <span className="relative inline-flex h-[18px] w-[34px] shrink-0 items-center">
      <input
        type="checkbox"
        role="switch"
        aria-label="自动回复"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="peer absolute inset-0 z-10 m-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
      />
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none flex h-full w-full items-center rounded-full p-0.5 transition-[background-color,box-shadow] duration-150 peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-background peer-disabled:opacity-64",
          checked ? "bg-primary" : "bg-input",
        )}
      >
        <span
          className={cn(
            "block size-3.5 rounded-full bg-background shadow-xs transition-transform duration-150",
            checked ? "translate-x-4" : "translate-x-0",
          )}
        />
      </span>
    </span>
  );
}

export function AppSidebar({
  page,
  collapsed,
  theme,
  status,
  version,
  busy,
  pendingCount,
  pendingAutoReply,
  onSelectPage,
  onSetCollapsed,
  onToggleTheme,
  onToggleAutoReply,
  onReconnect,
}: AppSidebarProps): React.ReactElement {
  const collapsedRef = React.useRef(collapsed);
  collapsedRef.current = collapsed;
  const collapseBtnRef = React.useRef<HTMLButtonElement | null>(null);
  const expandBtnRef = React.useRef<HTMLButtonElement | null>(null);
  const restoreToggleFocus = React.useRef(false);

  React.useEffect(() => {
    if (!restoreToggleFocus.current) return;
    restoreToggleFocus.current = false;
    (collapsed ? expandBtnRef.current : collapseBtnRef.current)?.focus();
  }, [collapsed]);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "b" &&
        !isEditableElement(event.target)
      ) {
        event.preventDefault();
        onSetCollapsed(!collapsedRef.current);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onSetCollapsed]);

  const emergencyStopped = Boolean(status.automation?.emergencyStopped || status.paused);
  const securityHoldCount = status.securityHolds?.length ?? 0;
  const browserOpen = status.browser.state.startsWith("OPEN");
  const accountBound = Boolean(status.account?.identity);
  const hasReplyPolicy = Boolean(status.automation?.replyPolicy);
  const autoReplyActive = status.configuredMode === "LIMITED_AUTO" && hasReplyPolicy;
  const autoReplyChecked = pendingAutoReply ?? autoReplyActive;
  const autoReplyDisabled = pendingAutoReply !== null || Boolean(busy) || !hasReplyPolicy;

  const sendBudget = findBudget(status.budgets, "SEND");
  const modelBudget = findBudget(status.budgets, "MODEL");
  const sendPercent = computeBudgetPercent(sendBudget);
  const modelPercent = computeBudgetPercent(modelBudget);

  const statusDotClass = emergencyStopped
    ? "bg-destructive"
    : securityHoldCount > 0
      ? "bg-warning"
      : browserOpen
        ? "bg-success"
        : "bg-muted-foreground/50";

  const workspaceBadge = emergencyStopped
    ? { variant: "error" as const, text: "已急停" }
    : securityHoldCount > 0
      ? { variant: "warning" as const, text: "待核验" }
      : browserOpen
        ? { variant: "success" as const, text: "在线" }
        : { variant: "secondary" as const, text: "连接中" };

  const autoReplyTitle =
    pendingAutoReply !== null
      ? pendingAutoReply
        ? "正在开启自动回复…"
        : "正在关闭自动回复…"
      : emergencyStopped
        ? "已紧急暂停"
        : autoReplyActive
          ? "自动回复：开"
          : "自动回复：关";

  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col border-r border-sidebar-border/80 bg-sidebar",
        collapsed ? "w-[64px]" : "w-[248px]",
      )}
    >
      {/* Top Harbor Frame Brand Header */}
      <div
        className={cn(
          "flex h-13 shrink-0 items-center",
          collapsed ? "justify-center px-2" : "justify-between px-4",
        )}
      >
        <button
          type="button"
          onClick={() => onSelectPage("overview")}
          aria-label="inbora 工作台总览"
          className="flex cursor-pointer items-center gap-2.5 rounded-lg text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <BrandTile size={28} />
          {!collapsed && <BrandWordmark height={15} className="text-foreground" />}
        </button>
        {!collapsed && (
          <Button
            ref={collapseBtnRef}
            variant="ghost"
            size="icon-xs"
            aria-label="收起侧栏"
            title="收起侧栏 (Ctrl+B)"
            onClick={() => {
              restoreToggleFocus.current = true;
              onSetCollapsed(true);
            }}
          >
            <PanelLeftIcon aria-hidden="true" />
          </Button>
        )}
      </div>

      {/* Real Workspace & Runtime Status Card */}
      {collapsed ? (
        <div className="runtime-status sr-only">
          <p>
            {emergencyStopped
              ? "已急停"
              : browserOpen
                ? "账号保持连接"
                : "正在连接账号"}
          </p>
          <small>
            浏览器：{browserState(status.browser.state, status.automation?.emergencyStopped)}
          </small>
        </div>
      ) : (
        <div className="space-y-2 px-3 pb-2">
          <button
            type="button"
            onClick={() => onSelectPage("accounts")}
            className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-xl border border-sidebar-border bg-card px-2.5 py-2 text-left shadow-xs/10 transition-colors hover:border-input"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-xs font-semibold text-primary">
                {accountBound ? "本" : "待"}
              </span>
              <div className="min-w-0 leading-tight">
                <div className="truncate text-xs font-semibold text-foreground">
                  {accountBound ? "本地值守账号" : "本地工作台"}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                  <span className={cn("size-1.5 shrink-0 rounded-full", statusDotClass)} />
                  <span className="truncate">
                    {accountBound ? "已绑定本地账号" : "尚未核验账号"}
                  </span>
                </div>
              </div>
            </div>
            <Badge variant={workspaceBadge.variant} size="sm" className="shrink-0 text-[10px]">
              {workspaceBadge.text}
            </Badge>
          </button>

          <div className="runtime-status space-y-1 rounded-xl border border-sidebar-border/80 bg-card/70 px-2.5 py-2 text-[11px] leading-snug text-muted-foreground">
            <p className="flex items-center gap-1.5 font-medium text-foreground">
              <span
                className={cn(
                  "inline-block size-1.5 shrink-0 rounded-full",
                  statusDotClass,
                )}
              />
              <span className="truncate">
                {emergencyStopped
                  ? "已急停"
                  : browserOpen
                    ? "账号保持连接"
                    : "正在连接账号"}
              </span>
            </p>
            <small className="block break-words text-[10.5px] text-muted-foreground">
              浏览器：{browserState(status.browser.state, status.automation?.emergencyStopped)}
            </small>
            <small className="block truncate text-[10.5px] text-muted-foreground tabular-nums">
              {status.browser.mode === "headed" ? "有头 Edge" : "无头 Edge"}
              {status.browser.version ? ` ${status.browser.version}` : ""}
            </small>
            {status.lastSync.length > 0 ? (
              status.lastSync.map((syncItem) => (
                <small
                  key={syncItem.channel}
                  className="block truncate text-[10px] text-muted-foreground/90 tabular-nums"
                >
                  {syncItem.channel === "DIRECT_MESSAGE" ? "私信" : "评论"}同步 {time(syncItem.at)}
                </small>
              ))
            ) : (
              <small className="block text-[10px] text-muted-foreground/90">
                尚无成功同步记录
              </small>
            )}
          </div>
        </div>
      )}

      {/* Main Navigation */}
      <nav
        className="flex-1 space-y-3 overflow-y-auto px-2.5 py-1.5"
        aria-label="主导航"
      >
        {DESKTOP_NAV_GROUPS.map((group) => (
          <div key={group.label}>
            {!collapsed && (
              <div className="mb-1 flex items-center justify-between px-2 text-[10.5px] font-semibold tracking-wide text-muted-foreground/80">
                <span>{group.label}</span>
              </div>
            )}
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = page === item.id;
                const badgeCount =
                  item.id === "inbox"
                    ? pendingCount
                    : item.id === "runtime"
                      ? securityHoldCount
                      : 0;
                const badgeText = badgeCount > 99 ? "99+" : String(badgeCount);

                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-label={item.label}
                    title={badgeCount > 0 ? `${item.label} (${badgeText})` : item.label}
                    aria-current={active ? "page" : undefined}
                    onClick={() => onSelectPage(item.id)}
                    className={cn(
                      "relative flex h-9 w-full cursor-pointer items-center rounded-xl text-[13px] font-medium outline-none transition-[background-color,border-color,color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring",
                      collapsed ? "justify-center px-0" : "justify-between px-2",
                      active
                        ? "border border-border/80 bg-card text-foreground shadow-xs before:absolute before:top-2 before:bottom-2 before:left-0 before:w-[3px] before:rounded-r-full before:bg-primary"
                        : "border border-transparent text-sidebar-foreground hover:bg-card/65 hover:text-foreground",
                    )}
                  >
                    <span className="flex items-center gap-2.5">
                      <span
                        className={cn(
                          "relative inline-flex size-6 shrink-0 items-center justify-center rounded-lg transition-colors duration-150",
                          active
                            ? "bg-primary text-primary-foreground shadow-xs/20"
                            : "bg-black/[0.045] text-muted-foreground dark:bg-white/[0.06]",
                        )}
                      >
                        <Icon className="size-3.5" />
                        {collapsed && badgeCount > 0 && (
                          <span
                            aria-hidden="true"
                            className={cn(
                              "absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2 ring-sidebar",
                              item.id === "runtime" ? "bg-warning" : "bg-primary",
                            )}
                          />
                        )}
                      </span>
                      {!collapsed && <span>{item.label}</span>}
                    </span>

                    {!collapsed && badgeCount > 0 && (
                      <span
                        className={cn(
                          "rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums",
                          item.id === "runtime"
                            ? "bg-warning/18 text-warning-foreground"
                            : active
                              ? "bg-primary/14 text-primary"
                              : "bg-black/[0.055] text-muted-foreground dark:bg-white/[0.08]",
                        )}
                      >
                        {badgeText}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Bottom Real Budget, Auto-Reply Switch, Theme & Reconnect */}
      <div className="shrink-0 space-y-2 border-t border-sidebar-border bg-sidebar/95 p-2.5">
        {collapsed ? (
          <div className="flex flex-col items-center gap-2">
            <AutoReplySwitch
              checked={autoReplyChecked}
              disabled={autoReplyDisabled}
              onChange={onToggleAutoReply}
            />
            <Button
              ref={expandBtnRef}
              variant="ghost"
              size="icon-xs"
              aria-label="展开侧栏"
              title="展开侧栏 (Ctrl+B)"
              onClick={() => {
                restoreToggleFocus.current = true;
                onSetCollapsed(false);
              }}
            >
              <PanelLeftIcon aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="切换浅色/深色主题"
              title={theme === "dark" ? "切换浅色模式" : "切换深色模式"}
              onClick={onToggleTheme}
            >
              {theme === "dark" ? <SunIcon aria-hidden="true" /> : <MoonIcon aria-hidden="true" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="重新连接内核"
              title="重新连接内核"
              disabled={Boolean(busy)}
              onClick={onReconnect}
            >
              <RefreshCwIcon aria-hidden="true" />
            </Button>
          </div>
        ) : (
          <>
            {/* Real Budget Progress Card */}
            <div className="rounded-xl border border-sidebar-border bg-card/85 px-3 py-2 text-[11px] shadow-xs/5">
              <div className="flex items-center justify-between gap-2 text-muted-foreground">
                <span>发送额度</span>
                <span className="font-mono font-medium text-foreground tabular-nums">
                  {formatBudgetText(sendBudget)}
                </span>
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full rounded-full",
                    sendPercent >= 90 ? "bg-warning" : "bg-primary",
                  )}
                  style={{ width: `${sendPercent}%` }}
                />
              </div>
              <div className="mt-2 flex items-center justify-between gap-2 text-[10.5px] text-muted-foreground">
                <span>模型额度</span>
                <span className="font-mono font-medium text-foreground tabular-nums">
                  {formatBudgetText(modelBudget)}
                </span>
              </div>
              {modelBudget && modelBudget.maximum !== null && (
                <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      modelPercent >= 90 ? "bg-warning" : "bg-chart-3",
                    )}
                    style={{ width: `${modelPercent}%` }}
                  />
                </div>
              )}
            </div>

            {/* Real Unified Auto-Reply Toggle Card */}
            <div className="rounded-xl border border-sidebar-border bg-card px-3 py-2 shadow-xs/10">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      emergencyStopped
                        ? "bg-destructive"
                        : securityHoldCount > 0
                          ? "bg-warning"
                          : autoReplyChecked
                            ? "bg-success"
                            : "bg-muted-foreground/45",
                    )}
                  />
                  <div className="min-w-0 text-xs leading-tight">
                    <div className="truncate font-semibold text-foreground">{autoReplyTitle}</div>
                    <div className="mt-0.5 truncate text-[10.5px] text-muted-foreground">
                      {pendingAutoReply !== null
                        ? "正在同步策略状态"
                        : emergencyStopped
                          ? "请先检查并恢复运行"
                          : hasReplyPolicy
                            ? autoReplyActive
                              ? "按已保存策略运行"
                              : "当前仅人工回复"
                            : "尚未设置自动回复策略"}
                    </div>
                  </div>
                </div>
                <AutoReplySwitch
                  checked={autoReplyChecked}
                  disabled={autoReplyDisabled}
                  onChange={onToggleAutoReply}
                />
              </div>
              {!hasReplyPolicy && pendingAutoReply === null && (
                <button
                  type="button"
                  onClick={() => onSelectPage("automation")}
                  className="mt-2 w-full cursor-pointer rounded-md border border-border/80 bg-muted/45 py-1 text-center text-[11px] font-medium text-primary transition-colors hover:bg-primary/10"
                >
                  设置自动回复
                </button>
              )}
            </div>

            {/* Reconnect + Theme + Version Footer */}
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="xs"
                className="flex-1 justify-center"
                disabled={Boolean(busy)}
                onClick={onReconnect}
              >
                <RefreshCwIcon aria-hidden="true" />
                <span>重新连接内核</span>
              </Button>
              <Button
                variant="outline"
                size="icon-xs"
                aria-label="切换浅色/深色主题"
                title={theme === "dark" ? "切换浅色模式" : "切换深色模式"}
                onClick={onToggleTheme}
              >
                {theme === "dark" ? (
                  <SunIcon aria-hidden="true" />
                ) : (
                  <MoonIcon aria-hidden="true" />
                )}
              </Button>
            </div>
            <div className="flex items-center justify-between px-1 text-[10.5px] text-muted-foreground tabular-nums">
              <span>版本 {version || "读取中"}</span>
              <span>受控试用</span>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
