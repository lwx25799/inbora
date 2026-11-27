import * as React from "react";
import {
  MoonIcon,
  PanelLeftIcon,
  RefreshCwIcon,
  SearchIcon,
  SunIcon,
} from "lucide-react";
import {
  DESKTOP_NAV_GROUPS,
  type DesktopPageId,
} from "@/components/AppSidebar";
import { cn } from "@/lib/utils";

interface PaletteItem {
  id: string;
  group: "页面跳转" | "快捷操作";
  label: string;
  hint: string;
  keywords: string;
  icon?: React.ComponentType<{ className?: string }>;
  disabled?: boolean;
  run: () => void;
}

const PAGE_KEYWORDS: Record<DesktopPageId, string> = {
  overview: "总览 首页 仪表盘 overview",
  inbox: "会话 消息 私信 评论 回复 inbox",
  accounts: "账号 通道 浏览器 登录 accounts",
  automation: "自动 回复 规则 额度 时段 屏蔽词 提示词 automation",
  knowledge: "知识库 人格 样本 试聊 导入 knowledge",
  models: "模型 key 密钥 deepseek openai claude gemini 供应商 models",
  runtime: "调度 审计 诊断 日志 内存 安全 runtime audit",
  settings: "设置 主题 快捷键 急停 故障 助手 mcp 目录 settings",
};

export interface CommandPaletteProps {
  open: boolean;
  theme: "light" | "dark";
  collapsed: boolean;
  syncDisabled: boolean;
  onClose: () => void;
  onNavigate: (page: DesktopPageId) => void;
  onSync: () => void;
  onToggleTheme: () => void;
  onToggleCollapsed: () => void;
}

export function CommandPalette({
  open,
  theme,
  collapsed,
  syncDisabled,
  onClose,
  onNavigate,
  onSync,
  onToggleTheme,
  onToggleCollapsed,
}: CommandPaletteProps): React.ReactElement | null {
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const dialogRef = React.useRef<HTMLDialogElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const previousFocusRef = React.useRef<HTMLElement | null>(null);
  const closeModeRef = React.useRef<"dismiss" | "page" | "action">("dismiss");

  React.useEffect(() => {
    const dialog = dialogRef.current;
    if (!open) {
      if (dialog?.open) dialog.close();
      return;
    }
    closeModeRef.current = "dismiss";
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setActiveIndex(0);
    if (dialog && !dialog.open && typeof dialog.showModal === "function") {
      dialog.showModal();
    }
    inputRef.current?.focus();
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      if (dialog?.open) dialog.close();
      const mode = closeModeRef.current;
      const previous = previousFocusRef.current;
      if (mode === "page") return;
      if (previous?.isConnected) {
        requestAnimationFrame(() => {
          if (previous.isConnected) previous.focus();
        });
      }
    };
  }, [open]);

  const items = React.useMemo<PaletteItem[]>(() => {
    const pages: PaletteItem[] = DESKTOP_NAV_GROUPS.flatMap((group) =>
      group.items.map((item) => ({
        id: `page:${item.id}`,
        group: "页面跳转" as const,
        label: item.label,
        hint: group.label,
        keywords: `${item.label} ${group.label} ${PAGE_KEYWORDS[item.id]}`,
        icon: item.icon,
        run: () => onNavigate(item.id),
      })),
    );
    const actions: PaletteItem[] = [
      {
        id: "action:sync",
        group: "快捷操作",
        label: "同步收件箱",
        hint: syncDisabled ? "同步中" : "收取最新私信与评论",
        keywords: "同步 刷新 收取 消息 sync",
        icon: RefreshCwIcon,
        disabled: syncDisabled,
        run: onSync,
      },
      {
        id: "action:theme",
        group: "快捷操作",
        label: theme === "dark" ? "切换为暖白纸感（浅色）" : "切换为深松夜览（深色）",
        hint: "外观主题",
        keywords: "主题 浅色 深色 暗夜 护眼 theme dark light",
        icon: theme === "dark" ? SunIcon : MoonIcon,
        run: onToggleTheme,
      },
      {
        id: "action:sidebar",
        group: "快捷操作",
        label: collapsed ? "展开左侧导航栏" : "收起左侧导航栏",
        hint: "Ctrl+B",
        keywords: "侧栏 导航 展开 收起 折叠 sidebar",
        icon: PanelLeftIcon,
        run: onToggleCollapsed,
      },
    ];
    return [...pages, ...actions];
  }, [collapsed, onNavigate, onSync, onToggleCollapsed, onToggleTheme, syncDisabled, theme]);

  const needle = query.trim().toLowerCase();
  const matched = React.useMemo(
    () =>
      items.filter(
        (item) =>
          !needle ||
          item.label.toLowerCase().includes(needle) ||
          item.keywords.toLowerCase().includes(needle),
      ),
    [items, needle],
  );

  React.useEffect(() => {
    setActiveIndex(0);
  }, [needle]);

  if (!open) return null;

  const safeIndex = matched.length ? Math.min(activeIndex, matched.length - 1) : -1;

  const dismiss = () => {
    closeModeRef.current = "dismiss";
    if (dialogRef.current?.open) dialogRef.current.close();
    onClose();
  };

  const runItem = (item: PaletteItem | undefined) => {
    if (!item || item.disabled) return;
    closeModeRef.current = item.group === "页面跳转" ? "page" : "action";
    if (dialogRef.current?.open) dialogRef.current.close();
    onClose();
    item.run();
  };

  return (
    <dialog
      ref={dialogRef}
      data-command-palette="true"
      aria-label="快速跳转与操作"
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const focusable = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            "input:not(:disabled), button:not(:disabled)",
          ),
        );
        if (!focusable.length) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      className="mx-auto mt-[12vh] mb-auto w-[min(480px,calc(100vw-32px))] overflow-hidden rounded-2xl border border-border bg-popover p-0 text-popover-foreground shadow-2xl backdrop:bg-black/42"
    >
      <div className="flex flex-col">
        <div className="flex items-center gap-2.5 border-b border-border/80 px-4 py-3">
          <SearchIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "ArrowDown" && matched.length) {
                event.preventDefault();
                setActiveIndex((index) => (index + 1) % matched.length);
              } else if (event.key === "ArrowUp" && matched.length) {
                event.preventDefault();
                setActiveIndex((index) => (index - 1 + matched.length) % matched.length);
              } else if (event.key === "Enter" && safeIndex >= 0) {
                event.preventDefault();
                runItem(matched[safeIndex]);
              }
            }}
            aria-label="搜索页面或快捷操作"
            placeholder="输入页面名或操作，如“模型”“急停”“主题”…"
            className="min-w-0 flex-1 bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground/75"
          />
          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">
            ESC
          </kbd>
        </div>

        <div className="max-h-[min(460px,65vh)] overflow-y-auto p-2 overscroll-contain">
          {matched.length === 0 ? (
            <p className="px-3 py-8 text-center text-xs text-muted-foreground">
              没有找到匹配的页面或操作
            </p>
          ) : (
            (["页面跳转", "快捷操作"] as const).map((group) => {
              const groupItems = matched
                .map((item, flatIndex) => ({ item, flatIndex }))
                .filter(({ item }) => item.group === group);
              if (groupItems.length === 0) return null;
              return (
                <div key={group} className="mb-1 last:mb-0">
                  <div className="px-2.5 py-1 text-[10.5px] font-semibold text-muted-foreground/85">
                    {group}
                  </div>
                  {groupItems.map(({ item, flatIndex }) => {
                    const Icon = item.icon;
                    const active = flatIndex === safeIndex;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        disabled={item.disabled}
                        onMouseEnter={() => setActiveIndex(flatIndex)}
                        onFocus={() => setActiveIndex(flatIndex)}
                        onClick={() => runItem(item)}
                        className={cn(
                          "flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
                          active
                            ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                            : "text-foreground hover:bg-muted/60",
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-2.5">
                          {Icon && (
                            <Icon
                              aria-hidden="true"
                              className={cn(
                                "size-3.5 shrink-0",
                                active ? "text-primary" : "text-muted-foreground",
                              )}
                            />
                          )}
                          <span className="truncate">{item.label}</span>
                        </span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {item.hint}
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border/75 bg-muted/30 px-4 py-2 text-[11px] text-muted-foreground">
          <span>↑↓ 选择 · Enter 确认</span>
          <span>Ctrl+K 随时唤起</span>
        </div>
      </div>
    </dialog>
  );
}
