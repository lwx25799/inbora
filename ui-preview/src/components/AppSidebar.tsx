import type * as React from "react";
import {
  ActivityIcon,
  BarChart3Icon,
  BookOpenIcon,
  CpuIcon,
  InboxIcon,
  LayoutDashboardIcon,
  MoonIcon,
  PanelLeftIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  SunIcon,
  UsersIcon,
} from "lucide-react";
import { BrandTile, BrandWordmark } from "@/components/BrandLogo";
import { AccountAvatar } from "@/components/PlatformBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { AccountItem, PageId, ScenarioMode, ThreadItem } from "@/data/mockData";

export const NAV_GROUPS: Array<{
  label: string;
  items: Array<{ id: PageId; label: string; icon: React.ComponentType<{ className?: string }> }>;
}> = [
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
      { id: "analytics", label: "数据统计", icon: BarChart3Icon },
      { id: "settings", label: "系统设置", icon: SettingsIcon },
    ],
  },
];

interface AppSidebarProps {
  page: PageId;
  collapsed: boolean;
  theme: "light" | "dark";
  scenario: ScenarioMode;
  autoReplyEnabled: boolean;
  emergencyStopped: boolean;
  securityHoldActive: boolean;
  pendingCount: number;
  accounts: AccountItem[];
  threads: ThreadItem[];
  conflictDocsCount: number;
  onSelectPage: (p: PageId) => void;
  onSetCollapsed: (v: boolean) => void;
  onToggleTheme: () => void;
  onSetScenario: (s: ScenarioMode) => void;
  onSetAutoReply: (v: boolean) => void;
  onOpenCmdk: () => void;
  onOpenAddAccount: () => void;
  onQuickSelectAccount: (accountId: string) => void;
}

export function AppSidebar({
  page,
  collapsed,
  theme,
  scenario,
  autoReplyEnabled,
  emergencyStopped,
  securityHoldActive,
  pendingCount,
  accounts,
  threads,
  conflictDocsCount,
  onSelectPage,
  onSetCollapsed,
  onToggleTheme,
  onSetScenario,
  onSetAutoReply,
  onOpenCmdk,
  onOpenAddAccount,
  onQuickSelectAccount,
}: AppSidebarProps): React.ReactElement {
  return (
    <aside
      className={`flex shrink-0 flex-col border-r border-sidebar-border/80 bg-sidebar transition-[width] duration-150 ${
        collapsed ? "w-[64px]" : "w-[248px]"
      }`}
    >
      {/* Top Brand Header */}
      <div
        className={`flex h-13 items-center ${
          collapsed ? "justify-center px-2" : "justify-between px-4"
        }`}
      >
        <button
          type="button"
          onClick={() => onSelectPage("overview")}
          className="flex cursor-pointer items-center gap-2.5 text-foreground"
        >
          <BrandTile size={28} />
          {!collapsed && <BrandWordmark height={15} className="text-foreground" />}
        </button>
        {!collapsed && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="收起侧栏"
            onClick={() => onSetCollapsed(true)}
          >
            <PanelLeftIcon />
          </Button>
        )}
      </div>

      {/* Studio Workspace Card + Omnibox */}
      {!collapsed && (
        <div className="space-y-2 px-3 pb-2">
          <div className="flex items-center justify-between rounded-xl border border-sidebar-border bg-card px-2.5 py-2 shadow-xs/10">
            <div className="flex min-w-0 items-center gap-2.5">
              <img
                src="/avatars/acc-flagship.jpg"
                alt="禾木手作工作室"
                className="size-8 shrink-0 rounded-lg object-cover ring-1 ring-black/10 dark:ring-white/15"
              />
              <div className="min-w-0 leading-tight">
                <div className="truncate text-xs font-semibold text-foreground">禾木手作工作室</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                  <span className="size-1.5 rounded-full bg-success" />
                  <span>{accounts.length} 个账号值守中</span>
                </div>
              </div>
            </div>
            <Badge variant="success" size="sm" className="text-[10px]">在线</Badge>
          </div>
          <button
            type="button"
            onClick={onOpenCmdk}
            className="flex h-8 w-full cursor-pointer items-center justify-between rounded-lg border border-sidebar-border bg-card/85 px-2.5 text-xs text-muted-foreground shadow-xs/5 transition-colors hover:border-input hover:text-foreground"
          >
            <span className="flex items-center gap-2">
              <SearchIcon className="size-3.5" />
              <span>搜索会话、知识或命令...</span>
            </span>
            <kbd className="rounded border border-border bg-sidebar px-1 font-mono text-[10px]">
              ⌘K
            </kbd>
          </button>
        </div>
      )}

      {/* Main Navigation + Live Connected Account Avatar Dock */}
      <nav className="flex-1 space-y-3.5 overflow-y-auto px-2.5 py-1.5" aria-label="主导航">
        {NAV_GROUPS.map((group) => (
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
                const count =
                  item.id === "inbox"
                    ? pendingCount
                    : item.id === "accounts"
                      ? accounts.length
                      : item.id === "knowledge"
                        ? conflictDocsCount
                        : item.id === "runtime" && securityHoldActive
                          ? 1
                          : 0;
                return (
                  <button
                    key={item.id}
                    type="button"
                    title={item.label}
                    onClick={() => onSelectPage(item.id)}
                    className={`relative flex h-9 w-full cursor-pointer items-center rounded-xl text-[13px] font-medium transition-all ${
                      collapsed ? "justify-center px-0" : "justify-between px-2"
                    } ${
                      active
                        ? "border border-border/80 bg-card text-foreground shadow-xs before:absolute before:top-2 before:bottom-2 before:left-0 before:w-[3px] before:rounded-r-full before:bg-primary"
                        : "border border-transparent text-sidebar-foreground hover:bg-card/65 hover:text-foreground"
                    }`}
                  >
                    <span className="flex items-center gap-2.5">
                      <span
                        className={`inline-flex size-6 shrink-0 items-center justify-center rounded-lg transition-colors ${
                          active
                            ? "bg-primary text-primary-foreground shadow-xs/20"
                            : "bg-black/[0.045] text-muted-foreground dark:bg-white/[0.06]"
                        }`}
                      >
                        <Icon className="size-3.5" />
                      </span>
                      {!collapsed && <span>{item.label}</span>}
                    </span>
                    {!collapsed && count > 0 && (
                      <span
                        className={`rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums ${
                          item.id === "runtime" || item.id === "knowledge"
                            ? "bg-warning/18 text-warning-foreground"
                            : active
                              ? "bg-primary/14 text-primary"
                              : "bg-black/[0.055] text-muted-foreground dark:bg-white/[0.08]"
                        }`}
                      >
                        {item.id === "knowledge" ? `${count} 冲突` : item.id === "inbox" ? `${count} 待办` : count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        {/* Live Connected Accounts Avatar Dock (Eliminates Sidebar Emptiness & Showcases Account Avatars) */}
        {!collapsed ? (
          <div className="border-t border-sidebar-border/80 pt-3">
            <div className="mb-1.5 flex items-center justify-between px-2">
              <span className="text-[10.5px] font-semibold tracking-wide text-muted-foreground/85">
                值守账号（{accounts.length}）
              </span>
              <button
                type="button"
                onClick={onOpenAddAccount}
                className="inline-flex cursor-pointer items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium text-primary hover:bg-primary/10"
              >
                <PlusIcon className="size-3" />
                接入
              </button>
            </div>
            <div className="space-y-1">
              {accounts.slice(0, 5).map((acc) => {
                const accPending = threads.filter((t) => t.accountId === acc.id && t.status !== "CONFIRMED").length;
                const isHeld = securityHoldActive && acc.id === "acc_dy_sub";
                return (
                  <button
                    key={acc.id}
                    type="button"
                    onClick={() => onQuickSelectAccount(acc.id)}
                    className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-card/85"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <AccountAvatar
                        label={acc.label}
                        platform={acc.platform}
                        avatarUrl={acc.avatarUrl}
                        size="sm"
                        statusDot={isHeld ? "warn" : acc.status === "FOREGROUND_LIMITED" ? "idle" : "online"}
                      />
                      <div className="min-w-0 leading-tight">
                        <div className="truncate text-[12px] font-medium text-foreground">{acc.label}</div>
                        <div className="truncate text-[10px] text-muted-foreground">
                          {isHeld ? "待安全核验" : acc.autoReply ? "自动值守中" : "仅人工回复"}
                        </div>
                      </div>
                    </div>
                    {accPending > 0 ? (
                      <span className="shrink-0 rounded-full bg-primary/14 px-1.5 py-0.5 text-[10px] font-semibold text-primary tabular-nums">
                        {accPending}
                      </span>
                    ) : (
                      <span className="shrink-0 text-[10px] text-muted-foreground/70 tabular-nums">
                        {acc.todayAuto + acc.todayHuman}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 border-t border-sidebar-border/80 pt-3">
            {accounts.slice(0, 4).map((acc) => (
              <button
                key={acc.id}
                type="button"
                title={acc.label}
                onClick={() => onQuickSelectAccount(acc.id)}
                className="cursor-pointer rounded-lg p-0.5 transition-transform hover:scale-105"
              >
                <AccountAvatar
                  label={acc.label}
                  platform={acc.platform}
                  avatarUrl={acc.avatarUrl}
                  size="sm"
                  statusDot={acc.status === "FOREGROUND_LIMITED" ? "idle" : "online"}
                />
              </button>
            ))}
          </div>
        )}
      </nav>

      {/* Bottom Engine Quota & Auto-Reply Controls */}
      <div className="space-y-2 border-t border-sidebar-border bg-sidebar/95 p-2.5">
        {collapsed ? (
          <div className="flex flex-col items-center gap-1.5">
            <Button variant="ghost" size="icon-xs" aria-label="展开侧栏" onClick={() => onSetCollapsed(false)}>
              <PanelLeftIcon />
            </Button>
            <Button variant="ghost" size="icon-xs" aria-label="切换主题" onClick={onToggleTheme}>
              {theme === "dark" ? <SunIcon /> : <MoonIcon />}
            </Button>
          </div>
        ) : (
          <>
            <div className="rounded-xl border border-sidebar-border bg-card/85 px-3 py-2 text-[11px] shadow-xs/5">
              <div className="flex items-center justify-between text-muted-foreground">
                <span>今日自动回复</span>
                <span className="font-mono font-medium text-foreground tabular-nums">331 / 500</span>
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full w-[66%] rounded-full bg-primary" />
              </div>
              <div className="mt-1.5 flex items-center justify-between text-[10.5px] text-muted-foreground">
                <span>均响 <strong className="text-foreground tabular-nums">16.9s</strong></span>
                <span>知识匹配 <strong className="text-primary tabular-nums">84.6%</strong></span>
              </div>
            </div>

            <div className="flex items-center justify-between rounded-xl border border-sidebar-border bg-card px-3 py-2 shadow-xs/10">
              <div className="flex items-center gap-2">
                <span
                  className={`size-2 rounded-full ${
                    emergencyStopped
                      ? "bg-destructive"
                      : securityHoldActive
                        ? "bg-warning"
                        : "bg-success"
                  }`}
                />
                <div className="text-xs leading-tight">
                  <div className="font-semibold text-foreground">
                    {emergencyStopped ? "已紧急暂停" : autoReplyEnabled ? "自动回复已开" : "仅人工回复"}
                  </div>
                  <div className="text-[10.5px] text-muted-foreground">{accounts.length} 个账号已连接</div>
                </div>
              </div>
              <Switch
                checked={autoReplyEnabled && !emergencyStopped}
                disabled={emergencyStopped}
                onCheckedChange={onSetAutoReply}
                aria-label="自动回复总开关"
              />
            </div>

            <div className="flex items-center justify-between gap-1.5 px-0.5">
              <select
                aria-label="演示场景切换"
                value={scenario}
                onChange={(e) => onSetScenario(e.target.value as ScenarioMode)}
                className="h-7 flex-1 cursor-pointer rounded-md border border-sidebar-border bg-card/85 px-2 text-[11.5px] text-muted-foreground outline-none hover:text-foreground"
              >
                <option value="normal">场景：正常运营（默认）</option>
                <option value="security_hold">场景：通道安全待核验</option>
                <option value="emergency_stop">场景：全局急停状态</option>
              </select>
              <Button variant="outline" size="icon-xs" aria-label="切换浅色/深色主题" onClick={onToggleTheme}>
                {theme === "dark" ? <SunIcon /> : <MoonIcon />}
              </Button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
