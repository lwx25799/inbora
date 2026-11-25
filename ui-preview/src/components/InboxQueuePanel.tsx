import type * as React from "react";
import { ArrowUpDownIcon, CheckCheckIcon, SearchIcon } from "lucide-react";
import { ContactAvatar, PLATFORM_META, PlatformMedallion } from "@/components/PlatformBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  THREAD_CRM_EXTRA,
  type AccountItem,
  type PlatformId,
  type ThreadItem,
} from "@/data/mockData";

export const FILTER_TABS = [
  { id: "WAITING", label: "待处理" },
  { id: "UNREAD", label: "未读" },
  { id: "MANUAL_ONLY", label: "需人工" },
  { id: "CONFIRMED", label: "已回复" },
  { id: "ALL", label: "全部" },
] as const;

export type InboxFilterTab = (typeof FILTER_TABS)[number]["id"];

const ACTIVE_PLATFORMS: Array<"ALL" | PlatformId> = ["ALL", "douyin", "wecom", "wxkf", "xiaohongshu"];

interface InboxQueuePanelProps {
  accounts: AccountItem[];
  threads: ThreadItem[];
  selectedId: string;
  drafts: Record<string, string>;
  filter: InboxFilterTab;
  platformFilter: "ALL" | PlatformId;
  sortBy: "recent" | "priority";
  query: string;
  onFilterChange: (v: InboxFilterTab) => void;
  onPlatformFilterChange: (v: "ALL" | PlatformId) => void;
  onToggleSort: () => void;
  onQueryChange: (v: string) => void;
  onSelectThread: (id: string) => void;
  onMarkAllRead: () => void;
}

export function InboxQueuePanel({
  accounts,
  threads,
  selectedId,
  drafts,
  filter,
  platformFilter,
  sortBy,
  query,
  onFilterChange,
  onPlatformFilterChange,
  onToggleSort,
  onQueryChange,
  onSelectThread,
  onMarkAllRead,
}: InboxQueuePanelProps): React.ReactElement {
  return (
    <section className="flex w-[304px] shrink-0 flex-col border-r border-border bg-muted/30">
      <div className="space-y-2 border-b border-border/80 bg-card/55 px-3.5 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <h1 className="font-semibold text-[14.5px] text-foreground">会话队列</h1>
            <Badge variant="secondary" size="sm">{threads.length}</Badge>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onToggleSort}
              className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border/75 bg-card px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <ArrowUpDownIcon className="size-3" />
              {sortBy === "priority" ? "紧急优先" : "按最新"}
            </button>
            <Button variant="ghost" size="xs" onClick={onMarkAllRead}>
              <CheckCheckIcon />
              已读
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-1 overflow-x-auto pb-0.5">
          {ACTIVE_PLATFORMS.map((p) => {
            const active = platformFilter === p;
            return (
              <button
                key={p}
                type="button"
                onClick={() => onPlatformFilterChange(p)}
                className={`inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-lg border px-1.5 text-[11px] font-medium transition-colors ${
                  active
                    ? "border-primary/40 bg-primary/12 text-primary shadow-xs/5"
                    : "border-border/60 bg-card/75 text-muted-foreground hover:border-border hover:text-foreground"
                }`}
              >
                {p === "ALL" ? (
                  "全渠道"
                ) : (
                  <>
                    <PlatformMedallion platform={p} size="xs" />
                    <span>
                      {p === "douyin"
                        ? "抖音"
                        : p === "wecom"
                          ? "企微"
                          : p === "wxkf"
                            ? "客服"
                            : p === "xiaohongshu"
                              ? "小红书"
                              : PLATFORM_META[p].name.slice(0, 2)}
                    </span>
                  </>
                )}
              </button>
            );
          })}
        </div>

        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            size="sm"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="搜索联系人、订单或意向..."
            className="[&_input]:pl-7"
          />
        </div>

        <div className="flex items-center gap-0.5 rounded-lg bg-muted/95 p-0.5">
          {FILTER_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => onFilterChange(tab.id)}
              className={`flex-1 cursor-pointer rounded-md py-1 text-[11.5px] font-medium transition-colors ${
                filter === tab.id
                  ? "bg-card text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 space-y-1.5 overflow-y-auto p-2.5">
        {threads.map((t) => {
          const tAcc = accounts.find((a) => a.id === t.accountId) ?? accounts[0];
          const active = selectedId === t.id;
          const lastNonSys = [...t.messages].reverse().find((m) => m.dir !== "sys");
          const snippet =
            t.channel === "COMMENT_NOTIFICATION"
              ? (t.commentChain?.[t.commentChain.length - 1]?.text ?? "")
              : (lastNonSys?.text || "分享了视频与图片消息");
          const hasDraft = Boolean((drafts[t.id] ?? "").trim());
          const score = THREAD_CRM_EXTRA[t.id]?.intentScore;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onSelectThread(t.id)}
              className={`relative flex w-full cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-all ${
                active
                  ? "border-primary/35 bg-card shadow-xs ring-1 ring-primary/15 before:absolute before:top-2.5 before:bottom-2.5 before:left-0 before:w-[3px] before:rounded-r-full before:bg-primary"
                  : "border-transparent bg-card/45 hover:border-border/75 hover:bg-card"
              }`}
            >
              <ContactAvatar
                name={t.author}
                platform={tAcc.platform}
                avatarUrl={t.avatarUrl}
                toneIndex={t.avatarTone}
                size="md"
                unreadCount={t.unread ? t.unreadCount : undefined}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-semibold text-[13px] text-foreground">{t.author}</span>
                    {t.customerStats.orders >= 2 && (
                      <span className="shrink-0 rounded bg-primary/12 px-1 py-0.5 text-[9.5px] font-semibold text-primary">
                        VIP
                      </span>
                    )}
                  </div>
                  <span className="shrink-0 text-[10.5px] text-muted-foreground tabular-nums">{t.updatedAt}</span>
                </div>
                <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                  {hasDraft && <span className="mr-1 font-medium text-warning-foreground">[草稿]</span>}
                  {snippet}
                </p>
                <div className="mt-1.5 flex items-center justify-between gap-1.5">
                  <span className="inline-flex min-w-0 items-center gap-1 text-[10.5px] text-muted-foreground">
                    <img
                      src={tAcc.avatarUrl}
                      alt={tAcc.label}
                      className="size-3.5 shrink-0 rounded-full object-cover ring-1 ring-black/10"
                    />
                    <span className="truncate">{tAcc.label}</span>
                    {score ? <span className="shrink-0 text-primary tabular-nums">· {score}%</span> : null}
                  </span>
                  <Badge
                    variant={
                      t.status === "UNCERTAIN"
                        ? "error"
                        : t.status === "MANUAL_ONLY"
                          ? "warning"
                          : t.status === "CONFIRMED"
                            ? "success"
                            : "secondary"
                    }
                    size="sm"
                  >
                    {t.intentChip}
                  </Badge>
                </div>
              </div>
            </button>
          );
        })}
        {!threads.length && (
          <div className="py-12 text-center text-xs text-muted-foreground">当前筛选下暂无会话</div>
        )}
      </div>
    </section>
  );
}
