import * as React from "react";
import {
  AlertTriangleIcon,
  BookOpenIcon,
  BookmarkPlusIcon,
  CheckCheckIcon,
  CheckCircle2Icon,
  CopyIcon,
  CornerUpLeftIcon,
  EraserIcon,
  EyeIcon,
  ImageIcon,
  MessageSquareTextIcon,
  PackageIcon,
  PanelRightIcon,
  PlayIcon,
  PlusIcon,
  SendIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  SparklesIcon,
  Wand2Icon,
  XIcon,
} from "lucide-react";
import { InboxQueuePanel, type InboxFilterTab } from "@/components/InboxQueuePanel";
import { InboxRightPanel } from "@/components/InboxRightPanel";
import { ContactAvatar, PLATFORM_META } from "@/components/PlatformBadge";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AccountItem, KnowledgeDoc, PlatformId, ThreadItem } from "@/data/mockData";

interface InboxProps {
  accounts: AccountItem[];
  threads: ThreadItem[];
  docs: KnowledgeDoc[];
  selectedId: string;
  drafts: Record<string, string>;
  emergencyStopped: boolean;
  securityHoldActive: boolean;
  onSelectThread: (id: string) => void;
  onDraftChange: (id: string, text: string) => void;
  onSendDm: (id: string) => void;
  onOpenCommentReply: (id: string) => void;
  onMarkAllRead: () => void;
  onDismissMcp: (id: string) => void;
  onOpenVerify: () => void;
  onNotify: (msg: string) => void;
}

const QUICK_SNIPPETS = [
  { label: "顺丰截单", text: "今天 17:00 前下单可当天发顺丰标快，江浙沪次日达。" },
  { label: "礼盒贺卡", text: "标配原木礼盒与防震内托，免费代写手写贺卡，祝词发我就行。" },
];

export function InboxView({
  accounts,
  threads,
  docs,
  selectedId,
  drafts,
  emergencyStopped,
  securityHoldActive,
  onSelectThread,
  onDraftChange,
  onSendDm,
  onOpenCommentReply,
  onMarkAllRead,
  onDismissMcp,
  onOpenVerify,
  onNotify,
}: InboxProps): React.ReactElement {
  const [filter, setFilter] = React.useState<InboxFilterTab>("WAITING");
  const [platformFilter, setPlatformFilter] = React.useState<"ALL" | PlatformId>("ALL");
  const [sortBy, setSortBy] = React.useState<"recent" | "priority">("recent");
  const [query, setQuery] = React.useState("");
  const [inspectorOpen, setInspectorOpen] = React.useState(() =>
    typeof window !== "undefined" ? window.innerWidth >= 1120 : true,
  );
  const [hideCopilot, setHideCopilot] = React.useState<Record<string, boolean>>({});
  const [aiTone, setAiTone] = React.useState<"warm" | "concise" | "pro">("warm");
  const chatScrollRef = React.useRef<HTMLDivElement | null>(null);

  const filtered = threads
    .filter((t) => {
      const acc = accounts.find((a) => a.id === t.accountId);
      const matchPlatform = platformFilter === "ALL" || acc?.platform === platformFilter;
      const matchTab =
        filter === "ALL" ||
        (filter === "UNREAD"
          ? t.unread
          : filter === "WAITING"
            ? t.status !== "CONFIRMED"
            : t.status === filter);
      const q = query.trim().toLowerCase();
      const matchQ =
        !q ||
        t.author.toLowerCase().includes(q) ||
        t.intentChip.toLowerCase().includes(q) ||
        (t.workTitle ?? "").toLowerCase().includes(q) ||
        t.messages.some((m) => m.text.toLowerCase().includes(q));
      return matchPlatform && matchTab && matchQ;
    })
    .sort((a, b) => {
      if (sortBy === "recent") return b.updatedAt.localeCompare(a.updatedAt);
      const rank = (s: ThreadItem["status"]) => (s === "UNCERTAIN" ? 0 : s === "MANUAL_ONLY" ? 1 : s === "WAITING" ? 2 : 3);
      return rank(a.status) - rank(b.status);
    });

  const current = threads.find((t) => t.id === selectedId) ?? filtered[0] ?? threads[0];
  const acc = accounts.find((a) => a.id === current.accountId) ?? accounts[0];
  const pf = PLATFORM_META[acc.platform];
  const currentDraft = drafts[current.id] ?? "";
  const isHeldByScenario = securityHoldActive && current.channel === "COMMENT_NOTIFICATION";
  const activeSuggestion = current.altSuggestions ? current.altSuggestions[aiTone] : current.suggestion;

  React.useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [current.id, current.messages.length]);

  const appendDraft = (text: string, label: string) => {
    onDraftChange(current.id, currentDraft ? `${currentDraft}\n${text}` : text);
    onNotify(`已将「${label}」插入草稿。`);
  };

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <InboxQueuePanel
        accounts={accounts}
        threads={filtered}
        selectedId={current.id}
        drafts={drafts}
        filter={filter}
        platformFilter={platformFilter}
        sortBy={sortBy}
        query={query}
        onFilterChange={setFilter}
        onPlatformFilterChange={setPlatformFilter}
        onToggleSort={() => setSortBy((s) => (s === "priority" ? "recent" : "priority"))}
        onQueryChange={setQuery}
        onSelectThread={onSelectThread}
        onMarkAllRead={onMarkAllRead}
      />

      {/* Column 2: 2-Tier Header + Avatar-Backed Bubbles + Product Card + Rich Composer */}
      <section className="flex min-w-0 flex-1 flex-col bg-background">
        {/* Tier 1: Customer Identity + Receiving Account Badge + Actions */}
        <header className="flex items-center justify-between gap-3 border-b border-border/80 bg-card/75 px-5 py-2.5">
          <div className="flex min-w-0 items-center gap-3">
            <ContactAvatar
              name={current.author}
              platform={acc.platform}
              avatarUrl={current.avatarUrl}
              toneIndex={current.avatarTone}
              size="md"
            />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <h2 className="truncate font-semibold text-[14.5px] text-foreground">{current.author}</h2>
                {current.customerStats.orders >= 2 && (
                  <Badge variant="success" size="sm">复购 {current.customerStats.orders} 单</Badge>
                )}
                <Badge variant="secondary" size="sm">{current.intentChip}</Badge>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-muted/50 px-2 py-0.5 text-[11px] text-muted-foreground">
                  <img
                    src={acc.avatarUrl}
                    alt={acc.label}
                    className="size-3.5 rounded-full object-cover"
                  />
                  <span>接待：{acc.label}</span>
                </span>
              </div>
              <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                {pf.name} · {current.authorTag} · {current.leaseNote}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="outline"
              size="xs"
              onClick={() => onNotify(`已将「${current.author}」标记为关注跟进（演示态）。`)}
            >
              <CheckCircle2Icon />
              标记跟进
            </Button>
            <Button
              variant="outline"
              size="xs"
              onClick={() => onNotify("已在静音有头窗口定位到原会话，未改动你当前的草稿。")}
            >
              <EyeIcon />
              查看原页
            </Button>
            <Button
              variant={inspectorOpen ? "secondary" : "ghost"}
              size="icon-xs"
              aria-label="切换右侧详情栏"
              onClick={() => setInspectorOpen((v) => !v)}
            >
              <PanelRightIcon />
            </Button>
          </div>
        </header>

        {/* Tier 2: Active Consulting Product Context Strip */}
        {current.relatedItem && (
          <div className="flex items-center justify-between gap-3 border-b border-border/75 bg-muted/35 px-5 py-2 text-xs">
            <div className="flex min-w-0 items-center gap-2.5">
              {current.relatedItem.thumbUrl && (
                <img
                  src={current.relatedItem.thumbUrl}
                  alt={current.relatedItem.name}
                  className="size-8 shrink-0 rounded-lg object-cover ring-1 ring-black/10"
                />
              )}
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-foreground">{current.relatedItem.name}</span>
                  <strong className="shrink-0 text-primary tabular-nums">{current.relatedItem.price}</strong>
                </div>
                <div className="truncate text-[11px] text-muted-foreground">
                  SKU {current.relatedItem.sku} · {current.relatedItem.stock}
                </div>
              </div>
            </div>
            {current.status !== "UNCERTAIN" && current.channel !== "COMMENT_NOTIFICATION" && (
              <Button
                variant="outline"
                size="xs"
                className="shrink-0 bg-card"
                onClick={() =>
                  appendDraft(
                    `【${current.relatedItem!.name}】参考价 ${current.relatedItem!.price}，${current.relatedItem!.stock}。`,
                    "商品参数",
                  )
                }
              >
                <PackageIcon />
                发商品说明
              </Button>
            )}
          </div>
        )}

        {/* Chat Stream w/ Subtle Dot Backdrop + Dual-Side Avatars + Embedded Product Card */}
        <div
          ref={chatScrollRef}
          className="flex-1 overflow-y-auto px-5 py-4"
          style={{
            backgroundImage: "radial-gradient(color-mix(in srgb, var(--border) 68%, transparent) 1px, transparent 1px)",
            backgroundSize: "18px 18px",
          }}
        >
          <div className="mx-auto flex max-w-[700px] flex-col gap-3.5">
            <div className="flex items-center justify-center">
              <span className="rounded-full border border-border/80 bg-card/95 px-3 py-0.5 text-[11px] text-muted-foreground shadow-xs/5">
                今天 · 11 月 25 日
              </span>
            </div>

            {current.channel === "COMMENT_NOTIFICATION" ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-3.5 py-2.5 text-xs shadow-xs/5">
                  <MessageSquareTextIcon className="size-4 shrink-0 text-primary" />
                  <div className="min-w-0">
                    <div className="font-medium text-foreground">作品：{current.workTitle}</div>
                    <div className="text-muted-foreground">已还原完整评论上下文，将直接回复高亮的这条评论</div>
                  </div>
                </div>
                {(current.commentChain ?? []).map((c, idx) => (
                  <div
                    key={idx}
                    className={`rounded-xl border px-4 py-3 ${c.level > 1 ? "ml-7" : ""} ${
                      c.isTarget
                        ? "border-primary/45 bg-card shadow-xs ring-1 ring-primary/15"
                        : c.own
                          ? "border-border/80 bg-card"
                          : "border-border/75 bg-card/85"
                    }`}
                  >
                    <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-2 font-medium text-foreground">
                        <img
                          src={c.own ? acc.avatarUrl : current.avatarUrl}
                          alt={c.author}
                          className="size-5 rounded-full object-cover ring-1 ring-black/10"
                        />
                        {c.author}
                        <span className="font-normal text-muted-foreground">
                          {c.level === 1 ? "一级根评论" : "楼中楼"}
                        </span>
                      </span>
                      <div className="flex items-center gap-1.5">
                        {c.isTarget && <Badge variant="default" size="sm">回复目标</Badge>}
                        <span className="tabular-nums">{c.time}</span>
                      </div>
                    </div>
                    <p className="text-[13.5px] leading-relaxed text-foreground">{c.text}</p>
                  </div>
                ))}
              </div>
            ) : (
              current.messages.map((m) =>
                m.dir === "sys" ? (
                  <div key={m.id} className="my-0.5 flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
                    <span className="h-px flex-1 bg-border/80" />
                    <span className="inline-flex items-center gap-1 rounded-full border border-primary/25 bg-card px-2.5 py-0.5 text-primary shadow-xs/5">
                      <SparklesIcon className="size-3" />
                      {m.text}
                    </span>
                    <span className="h-px flex-1 bg-border/80" />
                  </div>
                ) : (
                  <div
                    key={m.id}
                    className={`group flex items-start gap-2.5 ${m.dir === "out" ? "flex-row-reverse" : "flex-row"}`}
                  >
                    <img
                      src={m.dir === "out" ? acc.avatarUrl : current.avatarUrl}
                      alt={m.dir === "out" ? acc.label : current.author}
                      className="mt-4 size-8 shrink-0 rounded-xl object-cover ring-1 ring-black/10 shadow-xs/10 dark:ring-white/15"
                    />
                    <div className={`flex min-w-0 max-w-[78%] flex-col gap-1 ${m.dir === "out" ? "items-end" : "items-start"}`}>
                      <div className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
                        <span className="font-medium text-foreground/80">{m.dir === "out" ? acc.label : current.author}</span>
                        <span className="tabular-nums">{m.time}</span>
                        {m.delivered && <CheckCheckIcon className="size-3 text-success" />}
                        {m.uncertain && <Badge variant="error" size="sm">状态未确认 · 已暂停</Badge>}
                      </div>

                      <div
                        className={`rounded-2xl px-4 py-2.5 text-[13.5px] leading-relaxed ${
                          m.uncertain
                            ? "rounded-tr-sm border border-destructive/30 bg-destructive/8 text-foreground"
                            : m.dir === "out"
                              ? "rounded-tr-sm bg-primary text-primary-foreground shadow-xs"
                              : "rounded-tl-sm border border-border/85 bg-card text-foreground shadow-xs/10"
                        }`}
                      >
                        {m.text && <p className="whitespace-pre-wrap">{m.text}</p>}

                        {m.productCard && (
                          <div className="mt-2.5 flex items-center gap-3 rounded-xl border border-border/80 bg-muted/45 p-2.5">
                            <img
                              src={m.productCard.thumbUrl}
                              alt={m.productCard.name}
                              className="size-13 shrink-0 rounded-lg object-cover ring-1 ring-black/10"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center justify-between gap-2">
                                <span className="truncate text-xs font-semibold text-foreground">{m.productCard.name}</span>
                                <Badge variant="outline" size="sm" className="shrink-0 font-mono text-[10px]">
                                  {m.productCard.sku}
                                </Badge>
                              </div>
                              <div className="mt-1 flex items-center gap-2 text-xs">
                                <strong className="font-semibold text-primary tabular-nums">{m.productCard.price}</strong>
                                <span className="text-[11px] text-muted-foreground">{m.productCard.stock}</span>
                              </div>
                            </div>
                          </div>
                        )}

                        {m.shareCard && (
                          <div className="mt-2.5 flex items-center gap-3 rounded-xl border border-border bg-muted/50 p-2.5">
                            <div className="relative flex h-14 w-20 shrink-0 items-center justify-center rounded-lg bg-[#222a27] text-[#faf9f5]">
                              <PlayIcon className="size-4 fill-current" />
                              <span className="absolute right-1 bottom-1 rounded bg-black/60 px-1 text-[10px] tabular-nums">
                                {m.shareCard.duration}
                              </span>
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-xs font-semibold text-foreground">{m.shareCard.title}</div>
                              <div className="mt-0.5 text-[11px] text-muted-foreground">{m.shareCard.subtitle}</div>
                              <Button
                                variant="outline"
                                size="xs"
                                className="mt-1.5"
                                onClick={() => {
                                  navigator.clipboard?.writeText(m.shareCard!.url).catch(() => {});
                                  onNotify("已复制原生作品链接，未自动打开或下载媒体。");
                                }}
                              >
                                <CopyIcon />
                                复制视频链接
                              </Button>
                            </div>
                          </div>
                        )}

                        {m.imageCard && (
                          <div className="flex items-center gap-3 rounded-xl border border-dashed border-input bg-muted/35 p-2.5">
                            <div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                              <ImageIcon className="size-5" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="text-xs font-medium text-foreground">{m.imageCard.label}</div>
                              <div className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">{m.imageCard.dimensions}</div>
                            </div>
                            <Button variant="outline" size="xs" onClick={() => onNotify("已打开受控有头页查看原图片消息。")}>
                              查看原图
                            </Button>
                          </div>
                        )}
                      </div>

                      {m.dir === "in" && m.text && (
                        <div className="flex items-center gap-2 px-1 text-[10.5px] text-muted-foreground opacity-75 transition-opacity group-hover:opacity-100">
                          <button
                            type="button"
                            onClick={() => appendDraft(`回复「${m.text.slice(0, 14)}…」：`, "引用来信")}
                            className="inline-flex cursor-pointer items-center gap-0.5 hover:text-foreground"
                          >
                            <CornerUpLeftIcon className="size-3" />
                            引用
                          </button>
                          <button
                            type="button"
                            onClick={() => onNotify("已将该轮问答收入待采纳聊天样本库（已自动脱敏）。")}
                            className="inline-flex cursor-pointer items-center gap-0.5 hover:text-foreground"
                          >
                            <BookmarkPlusIcon className="size-3" />
                            收入样本
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ),
              )
            )}
          </div>
        </div>

        {/* Bottom Dock: Elevated AI Copilot + Single-Row Rich Composer */}
        <div className="border-t border-border/80 bg-card/85 px-5 py-3">
          <div className="mx-auto flex max-w-[700px] flex-col gap-2.5">
            {current.status === "UNCERTAIN" ? (
              <Alert variant="error">
                <ShieldAlertIcon />
                <AlertTitle>上一条消息发送状态未确认，已暂停发送</AlertTitle>
                <AlertDescription>系统已提交过一次但暂未收到平台确认，为避免重复打扰客户已暂停继续发送。</AlertDescription>
                <AlertAction>
                  <Button variant="outline" size="xs" onClick={() => onNotify("已完成状态复查：暂未收到平台确认，继续保持暂停防重发。")}>
                    重新查询状态
                  </Button>
                </AlertAction>
              </Alert>
            ) : isHeldByScenario ? (
              <Alert variant="warning">
                <ShieldAlertIcon />
                <AlertTitle>该账号的评论功能需要安全验证</AlertTitle>
                <AlertDescription>完成验证后即可恢复回复，你的草稿已安全保存。</AlertDescription>
                <AlertAction>
                  <Button size="xs" onClick={onOpenVerify}>去完成验证</Button>
                </AlertAction>
              </Alert>
            ) : (
              <>
                {current.mcpConflict && (
                  <Alert variant="warning">
                    <AlertTriangleIcon />
                    <AlertTitle>外部助手更新了建议草稿，已保留你的当前输入</AlertTitle>
                    <AlertDescription>{current.mcpConflict}</AlertDescription>
                    <AlertAction>
                      <Button variant="outline" size="xs" onClick={() => onDismissMcp(current.id)}>保留我的输入</Button>
                    </AlertAction>
                  </Alert>
                )}

                {activeSuggestion && !hideCopilot[current.id] && (
                  <div className="relative overflow-hidden rounded-xl border border-primary/28 bg-primary/[0.05] py-2.5 pr-3.5 pl-4 shadow-xs/5 before:absolute before:top-0 before:bottom-0 before:left-0 before:w-[3px] before:bg-primary">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-primary">
                          <SparklesIcon className="size-3.5" />
                          AI 建议草稿
                        </span>
                        {current.altSuggestions && (
                          <div className="flex items-center gap-0.5 rounded-md border border-border/70 bg-card p-0.5">
                            {([["warm", "温和"], ["concise", "简短"], ["pro", "专业"]] as const).map(([k, l]) => (
                              <button
                                key={k}
                                type="button"
                                onClick={() => setAiTone(k)}
                                className={`cursor-pointer rounded px-1.5 py-0.5 text-[11px] font-medium ${
                                  aiTone === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                                }`}
                              >
                                {l}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button size="xs" onClick={() => { onDraftChange(current.id, activeSuggestion); onNotify("已填入 AI 建议，可自由编辑后发送。"); }}>
                          采纳填入
                        </Button>
                        <Button variant="ghost" size="icon-xs" aria-label="收起建议" onClick={() => setHideCopilot((p) => ({ ...p, [current.id]: true }))}>
                          <XIcon />
                        </Button>
                      </div>
                    </div>
                    <p className="mt-1.5 text-xs leading-relaxed text-foreground/90">{activeSuggestion}</p>
                    {current.knowledgeHits.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {current.knowledgeHits.map((k) => (
                          <Badge key={k} variant="outline" size="sm" className="bg-card/90">引用：{k}</Badge>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {current.channel === "COMMENT_NOTIFICATION" ? (
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-xs/5">
                    <div className="text-xs text-muted-foreground">评论回复使用独立确认窗，完整保留根评论与楼中楼关系，单次确认即发送。</div>
                    <Button size="sm" disabled={emergencyStopped} onClick={() => onOpenCommentReply(current.id)}>
                      <SendIcon />
                      打开评论回复框
                    </Button>
                  </div>
                ) : (
                  <div className="rounded-xl border border-input bg-card p-2.5 shadow-xs focus-within:border-primary/55 focus-within:ring-2 focus-within:ring-ring/30">
                    <div className="mb-1.5 flex flex-wrap items-center justify-between gap-1.5 border-b border-border/60 pb-2">
                      <div className="flex flex-wrap items-center gap-1">
                        {current.relatedItem && (
                          <button
                            type="button"
                            onClick={() =>
                              appendDraft(
                                `【${current.relatedItem!.name}】${current.relatedItem!.price}（${current.relatedItem!.stock}）`,
                                "商品参数",
                              )
                            }
                            className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border/80 bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-foreground hover:border-primary/35 hover:bg-primary/[0.06]"
                          >
                            <PackageIcon className="size-3 text-primary" />
                            插商品
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            const topDoc = docs.find((d) => d.status === "ENABLED");
                            if (topDoc) appendDraft(topDoc.content, topDoc.title);
                          }}
                          className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border/80 bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-foreground hover:border-primary/35 hover:bg-primary/[0.06]"
                        >
                          <BookOpenIcon className="size-3 text-primary" />
                          引知识
                        </button>
                        {QUICK_SNIPPETS.map((s) => (
                          <button
                            key={s.label}
                            type="button"
                            onClick={() => appendDraft(s.text, s.label)}
                            className="inline-flex cursor-pointer items-center gap-0.5 rounded-md border border-border/75 bg-background px-2 py-0.5 text-[11px] text-muted-foreground hover:border-primary/35 hover:text-foreground"
                          >
                            <PlusIcon className="size-2.5" />
                            {s.label}
                          </button>
                        ))}
                      </div>
                      <div className="flex items-center gap-1">
                        {activeSuggestion && (
                          <button
                            type="button"
                            onClick={() => {
                              setAiTone((t) => (t === "warm" ? "concise" : t === "concise" ? "pro" : "warm"));
                              setHideCopilot((p) => ({ ...p, [current.id]: false }));
                            }}
                            className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/10"
                          >
                            <Wand2Icon className="size-3" />
                            换语气
                          </button>
                        )}
                        {currentDraft && (
                          <button
                            type="button"
                            onClick={() => onDraftChange(current.id, "")}
                            className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            <EraserIcon className="size-3" />
                            清空
                          </button>
                        )}
                      </div>
                    </div>

                    <textarea
                      rows={3}
                      disabled={emergencyStopped}
                      value={currentDraft}
                      onChange={(e) => onDraftChange(current.id, e.target.value)}
                      onKeyDown={(e) => {
                        if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && currentDraft.trim()) {
                          e.preventDefault();
                          onSendDm(current.id);
                        }
                      }}
                      placeholder={emergencyStopped ? "全局急停生效中，恢复运行后可继续回复" : "直接输入回复内容，支持连续排队发送（Ctrl + Enter 发送）..."}
                      className="w-full resize-none border-0 bg-transparent px-1.5 py-0.5 text-[13.5px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/75"
                    />

                    <div className="mt-1.5 flex items-center justify-between gap-2 border-t border-border/60 pt-2">
                      <span className="inline-flex items-center gap-1 text-[11.5px] text-success-foreground">
                        <ShieldCheckIcon className="size-3.5" />
                        草稿已自动保存
                      </span>
                      <div className="flex items-center gap-2">
                        <kbd className="hidden rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline">
                          Ctrl + ↵
                        </kbd>
                        <span className="text-[11px] text-muted-foreground tabular-nums">{currentDraft.length} / 500</span>
                        <Button size="sm" disabled={emergencyStopped || !currentDraft.trim()} onClick={() => onSendDm(current.id)}>
                          <SendIcon />
                          发送
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </section>

      {inspectorOpen && (
        <InboxRightPanel
          thread={current}
          account={acc}
          docs={docs}
          currentDraft={currentDraft}
          onInsertText={appendDraft}
          onClose={() => setInspectorOpen(false)}
          onNotify={onNotify}
        />
      )}
    </div>
  );
}
