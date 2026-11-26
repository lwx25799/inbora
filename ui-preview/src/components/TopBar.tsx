import * as React from "react";
import {
  BellIcon,
  CpuIcon,
  MoonIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldCheckIcon,
  SunIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { PageId } from "@/data/mockData";

const PAGE_CRUMBS: Record<PageId, { group: string; title: string }> = {
  overview: { group: "日常运营", title: "工作台总览" },
  inbox: { group: "日常运营", title: "会话中心" },
  accounts: { group: "资产与智能", title: "账号与通道" },
  automation: { group: "资产与智能", title: "自动化规则" },
  knowledge: { group: "资产与智能", title: "知识库与人格" },
  models: { group: "资产与智能", title: "多模型配置" },
  runtime: { group: "治理与系统", title: "调度与审计" },
  analytics: { group: "治理与系统", title: "数据统计" },
  settings: { group: "治理与系统", title: "系统设置" },
};

const QUICK_NOTICES = [
  { id: "n1", time: "18:41", title: "林晚晴有新咨询待确认", detail: "已根据发货与礼盒说明生成建议草稿" },
  { id: "n2", time: "18:24", title: "陈思齐发来视频与图片", detail: "需要人工查看后回复" },
  { id: "n3", time: "18:08", title: "栖山咖啡器具草稿已更新", detail: "已为你完整保留当前输入内容" },
  { id: "n4", time: "17:58", title: "顾清舟的回复状态待确认", detail: "已暂停继续发送，避免重复打扰客户" },
];

interface TopBarProps {
  page: PageId;
  theme: "light" | "dark";
  activeModel: string;
  mcpEnabled: boolean;
  syncing: boolean;
  pendingCount: number;
  onlineAccounts: number;
  onSync: () => void;
  onOpenCmdk: () => void;
  onToggleTheme: () => void;
  onNavigate: (p: PageId) => void;
}

export function TopBar({
  page,
  theme,
  activeModel,
  syncing,
  pendingCount,
  onlineAccounts,
  onSync,
  onOpenCmdk,
  onToggleTheme,
  onNavigate,
}: TopBarProps): React.ReactElement {
  const [bellOpen, setBellOpen] = React.useState(false);
  const crumb = PAGE_CRUMBS[page];

  return (
    <header className="relative z-20 flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/80 bg-card/65 px-5 backdrop-blur-xs">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">{crumb.group}</span>
          <span className="text-muted-foreground/50">/</span>
          <span className="font-semibold text-foreground">{crumb.title}</span>
        </div>

        <div className="hidden items-center gap-1.5 border-l border-border/80 pl-3 lg:flex">
          <button
            type="button"
            onClick={() => onNavigate("accounts")}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border/75 bg-background px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <span className="size-1.5 rounded-full bg-success" />
            <span>{onlineAccounts} 个账号在线</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate("models")}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border/75 bg-background px-2 py-0.5 font-mono text-[11px] text-foreground transition-colors hover:border-primary/40"
          >
            <CpuIcon className="size-3 text-primary" />
            {activeModel}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onOpenCmdk}
          className="hidden h-7 w-[204px] cursor-pointer items-center justify-between rounded-lg border border-border/85 bg-background px-2.5 text-xs text-muted-foreground transition-colors hover:border-input hover:text-foreground md:flex"
        >
          <span className="flex items-center gap-1.5">
            <SearchIcon className="size-3.5" />
            <span>搜索客户、消息或知识...</span>
          </span>
          <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">⌘K</kbd>
        </button>

        <Button variant="outline" size="xs" onClick={onSync} disabled={syncing}>
          <RefreshCwIcon className={syncing ? "animate-spin" : ""} />
          <span className="hidden sm:inline">{syncing ? "同步中" : "同步消息"}</span>
        </Button>

        <div className="relative">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="消息通知"
            onClick={() => setBellOpen((o) => !o)}
            className="relative"
          >
            <BellIcon />
            {pendingCount > 0 && (
              <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-warning ring-2 ring-card" />
            )}
          </Button>
          {bellOpen && (
            <div className="absolute right-0 mt-2 w-[310px] rounded-xl border border-border bg-popover p-2 shadow-lg">
              <div className="flex items-center justify-between px-2 py-1.5">
                <span className="text-xs font-semibold text-foreground">最新动态提醒</span>
                <Badge variant="secondary" size="sm">{QUICK_NOTICES.length} 条</Badge>
              </div>
              <div className="divide-y divide-border/70">
                {QUICK_NOTICES.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => {
                      setBellOpen(false);
                      onNavigate("inbox");
                    }}
                    className="flex w-full cursor-pointer items-start justify-between gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/60"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-foreground">{n.title}</div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">{n.detail}</div>
                    </div>
                    <span className="shrink-0 text-[10.5px] text-muted-foreground tabular-nums">{n.time}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="切换浅色/深色主题"
          onClick={onToggleTheme}
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </Button>

        <div className="ml-1 hidden items-center gap-2 rounded-lg border border-border/75 bg-background px-2 py-1 sm:flex">
          <span className="inline-flex size-5 items-center justify-center rounded-md bg-primary/15 text-[11px] font-semibold text-primary">
            禾
          </span>
          <span className="text-[11.5px] font-medium text-foreground">值守主管</span>
          <ShieldCheckIcon className="size-3 text-primary" />
        </div>
      </div>
    </header>
  );
}
