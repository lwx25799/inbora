import * as React from "react";
import {
  BookOpenIcon,
  CheckCircle2Icon,
  GaugeIcon,
  MapPinIcon,
  PackageIcon,
  PlusIcon,
  ReceiptTextIcon,
  SearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TagIcon,
  XIcon,
} from "lucide-react";
import { ContactAvatar, PLATFORM_META } from "@/components/PlatformBadge";
import { CeramicThumb } from "@/components/RichVisuals";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  THREAD_CRM_EXTRA,
  type AccountItem,
  type KnowledgeDoc,
  type ThreadItem,
} from "@/data/mockData";

interface InboxRightPanelProps {
  thread: ThreadItem;
  account: AccountItem;
  docs: KnowledgeDoc[];
  currentDraft: string;
  onInsertText: (text: string, label: string) => void;
  onClose: () => void;
  onNotify: (msg: string) => void;
}

export function InboxRightPanel({
  thread,
  account,
  docs,
  onInsertText,
  onClose,
  onNotify,
}: InboxRightPanelProps): React.ReactElement {
  const [panelTab, setPanelTab] = React.useState<"crm" | "kb" | "audit">("crm");
  const [kbQuery, setKbQuery] = React.useState("");
  const pf = PLATFORM_META[account.platform];
  const crm = THREAD_CRM_EXTRA[thread.id] ?? {
    intentScore: 76,
    sentiment: "常规咨询",
    tags: [thread.intentChip, pf.name],
    orders: [],
  };

  const canInsert = thread.status !== "UNCERTAIN" && thread.channel !== "COMMENT_NOTIFICATION";
  const matchedKb = docs
    .filter(
      (d) =>
        d.status === "ENABLED" &&
        (!kbQuery.trim() || d.title.includes(kbQuery.trim()) || d.content.includes(kbQuery.trim())),
    )
    .slice(0, 5);

  return (
    <aside className="flex w-[328px] shrink-0 flex-col overflow-hidden border-l border-border bg-muted/25 max-lg:fixed max-lg:top-14 max-lg:right-2 max-lg:bottom-2 max-lg:z-40 max-lg:rounded-2xl max-lg:border max-lg:bg-popover max-lg:shadow-xl">
      {/* Inspector Header + 3-Tab Switcher */}
      <div className="space-y-2.5 border-b border-border/80 bg-card/60 px-3.5 py-2.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-foreground">客户洞察与工作助手</span>
          <Button variant="ghost" size="icon-xs" aria-label="收起详情栏" onClick={onClose}>
            <XIcon />
          </Button>
        </div>
        <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-0.5 text-[11px] font-medium">
          {(
            [
              ["crm", "客户与订单"],
              ["kb", "知识检索"],
              ["audit", "发送记录"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setPanelTab(id)}
              className={`cursor-pointer rounded-md py-1 transition-colors ${
                panelTab === id ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3.5 text-xs">
        {panelTab === "crm" && (
          <div className="space-y-3.5">
            {/* 1. Customer Profile + Collected Avatar + Tags */}
            <section className="space-y-2.5 rounded-xl border border-border/80 bg-card p-3.5 shadow-xs/5">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <ContactAvatar
                    name={thread.author}
                    platform={account.platform}
                    avatarUrl={thread.avatarUrl}
                    toneIndex={thread.avatarTone}
                    size="lg"
                  />
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-[13.5px] text-foreground">{thread.author}</div>
                    <div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                      <MapPinIcon className="size-3" />
                      {thread.customerStats.city} · {pf.name}
                    </div>
                  </div>
                </div>
                {thread.customerStats.orders >= 2 && (
                  <Badge variant="success" size="sm">VIP 复购</Badge>
                )}
              </div>

              <div className="grid grid-cols-3 divide-x divide-border/70 rounded-lg bg-muted/50 py-1.5 text-center">
                <div>
                  <div className="font-semibold text-[13px] text-foreground tabular-nums">{thread.customerStats.visits}</div>
                  <div className="text-[10px] text-muted-foreground">沟通次数</div>
                </div>
                <div>
                  <div className="font-semibold text-[13px] text-foreground tabular-nums">{thread.customerStats.orders}</div>
                  <div className="text-[10px] text-muted-foreground">关联订单</div>
                </div>
                <div>
                  <div className="font-semibold text-[13px] text-primary tabular-nums">{crm.intentScore}%</div>
                  <div className="text-[10px] text-muted-foreground">成交意向</div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {crm.tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 rounded-md border border-border/75 bg-muted/45 px-2 py-0.5 text-[10.5px] text-foreground"
                  >
                    <TagIcon className="size-2.5 text-primary" />
                    {tag}
                  </span>
                ))}
                <button
                  type="button"
                  onClick={() => onNotify("已打开客户标签编辑（仅存本地，不外传）。")}
                  className="inline-flex cursor-pointer items-center gap-0.5 rounded-md border border-dashed border-input px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:text-foreground"
                >
                  <PlusIcon className="size-2.5" />
                  标签
                </button>
              </div>
            </section>

            {/* 2. AI Intent & Sentiment Meter */}
            <section className="space-y-2 rounded-xl border border-border/80 bg-card p-3.5 shadow-xs/5">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                  <GaugeIcon className="size-3.5 text-primary" />
                  AI 意向与情绪研判
                </span>
                <Badge variant="outline" size="sm">{crm.sentiment}</Badge>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary" style={{ width: `${crm.intentScore}%` }} />
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">{thread.customerStats.note}</p>
            </section>

            {/* 3. Consulting Product Card w/ Custom SVG Ceramic Artwork */}
            {thread.relatedItem && (
              <section className="space-y-2.5 rounded-xl border border-border/80 bg-card p-3.5 shadow-xs/5">
                <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <PackageIcon className="size-3.5 text-primary" />
                    咨询器物 / 关联作品
                  </span>
                  <span className="font-mono">{thread.relatedItem.sku}</span>
                </div>
                <div className="flex items-center gap-3">
                  {thread.relatedItem.thumbUrl ? (
                    <img
                      src={thread.relatedItem.thumbUrl}
                      alt={thread.relatedItem.name}
                      className="size-14 shrink-0 rounded-xl object-cover ring-1 ring-black/10 dark:ring-white/15"
                    />
                  ) : (
                    <CeramicThumb sku={thread.relatedItem.sku} swatch={thread.relatedItem.swatch} />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-foreground">{thread.relatedItem.name}</div>
                    <div className="mt-1 flex items-center gap-2 text-[11.5px]">
                      <strong className="font-semibold text-primary tabular-nums">{thread.relatedItem.price}</strong>
                      <span className="truncate text-muted-foreground">{thread.relatedItem.stock}</span>
                    </div>
                    <div className="mt-2 flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={!canInsert}
                        onClick={() =>
                          onInsertText(
                            `【${thread.relatedItem!.name}】参考价 ${thread.relatedItem!.price}，${thread.relatedItem!.stock}。`,
                            "商品参数",
                          )
                        }
                        className="cursor-pointer rounded-md bg-primary/10 px-2 py-0.5 text-[10.5px] font-medium text-primary hover:bg-primary/18 disabled:opacity-40"
                      >
                        + 插入商品说明
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {/* 4. Historical Orders Timeline */}
            <section className="space-y-2 rounded-xl border border-border/80 bg-card p-3.5 shadow-xs/5">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                  <ReceiptTextIcon className="size-3.5 text-primary" />
                  历史订单记录
                </span>
                <span className="text-[11px] text-muted-foreground tabular-nums">{crm.orders.length} 笔</span>
              </div>
              {crm.orders.length > 0 ? (
                <div className="divide-y divide-border/70">
                  {crm.orders.map((o) => (
                    <div key={o.id} className="flex items-start justify-between gap-2 py-2 first:pt-0.5 last:pb-0">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-[11px] font-medium text-foreground">{o.id}</span>
                          <span className="text-[10.5px] text-muted-foreground">{o.date}</span>
                        </div>
                        <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">{o.title}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="font-medium text-foreground tabular-nums">{o.amount}</div>
                        <div className="text-[10px] text-primary">{o.status}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">暂无本账号已关联订单，成交后将自动归档。</p>
              )}
            </section>

            {/* 5. Top Matched Knowledge Quick Card */}
            {matchedKb[0] && (
              <section className="space-y-1.5 rounded-xl border border-primary/20 bg-primary/[0.04] p-3">
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-1 font-medium text-primary">
                    <SparklesIcon className="size-3" />
                    最相关知识 · {matchedKb[0].title}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPanelTab("kb")}
                    className="cursor-pointer text-[10.5px] text-primary hover:underline"
                  >
                    全部 ({docs.filter((d) => d.status === "ENABLED").length})
                  </button>
                </div>
                <p className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">{matchedKb[0].content}</p>
              </section>
            )}
          </div>
        )}

        {panelTab === "kb" && (
          <div className="space-y-3">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                size="sm"
                value={kbQuery}
                onChange={(e) => setKbQuery(e.target.value)}
                placeholder="检索发货、售后、定制规则..."
                className="[&_input]:pl-7"
              />
            </div>
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <BookOpenIcon className="size-3 text-primary" />
                店铺知识库检索
              </span>
              <span>风格：{thread.personaLabel}</span>
            </div>
            <div className="space-y-2">
              {matchedKb.map((doc, idx) => (
                <div key={doc.id} className="rounded-xl border border-border/80 bg-card p-3 shadow-xs/5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-medium text-foreground">{doc.title}</span>
                      <Badge variant="outline" size="sm" className="font-mono text-[10px]">
                        {Math.max(78, 96 - idx * 5)}%
                      </Badge>
                    </div>
                    <button
                      type="button"
                      disabled={!canInsert}
                      onClick={() => onInsertText(doc.content, doc.title)}
                      className="shrink-0 cursor-pointer rounded-md bg-primary/10 px-2 py-0.5 text-[10.5px] font-medium text-primary hover:bg-primary/18 disabled:opacity-40"
                    >
                      + 插入
                    </button>
                  </div>
                  <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">{doc.content}</p>
                  <div className="mt-2 flex items-center justify-between text-[10.5px] text-muted-foreground">
                    <span>{doc.topic} · {doc.channel}</span>
                    <span className="tabular-nums">7日引用 {doc.hits7d} 次</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {panelTab === "audit" && (
          <div className="space-y-3">
            <section className="space-y-2.5 rounded-xl border border-border/80 bg-card p-3.5 shadow-xs/5">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 font-semibold text-foreground">
                  <ShieldCheckIcon className="size-3.5 text-primary" />
                  当前回复保护状态
                </span>
                <Badge variant={thread.intent?.status === "UNCERTAIN" ? "error" : "success"} size="sm">
                  {thread.intent?.status === "UNCERTAIN" ? "已暂停防重发" : "保护正常"}
                </Badge>
              </div>
              {thread.intent ? (
                <div className="space-y-2 text-[11.5px]">
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">提交时间</span>
                    <span className="text-foreground tabular-nums">{thread.intent.submittedAt}</span>
                  </div>
                  <div className="rounded-lg bg-muted/45 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
                    {thread.intent.rechecks}
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                  <CheckCircle2Icon className="size-3.5 text-primary" />
                  当前草稿仅保存在本地，点击发送后才会发出。
                </div>
              )}
              <Separator />
              <details className="text-[11px] text-muted-foreground">
                <summary className="cursor-pointer select-none hover:text-foreground">
                  展开技术排查信息
                </summary>
                <div className="mt-2 space-y-1.5 font-mono text-[10.5px]">
                  <div className="flex justify-between gap-2">
                    <span>会话标识</span>
                    <span className="truncate text-foreground">{thread.targetId}</span>
                  </div>
                  {thread.intent && (
                    <div className="flex justify-between gap-2">
                      <span>记录编号</span>
                      <span className="text-foreground">{thread.intent.intentId}</span>
                    </div>
                  )}
                </div>
              </details>
            </section>
          </div>
        )}
      </div>
    </aside>
  );
}
