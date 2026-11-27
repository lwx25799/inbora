import { useEffect, useRef, useState } from 'react';
import type { Channel } from '../../src/contracts/events.js';
import {
  channelName,
  describeKnowledgeError,
  formatDate,
  knowledgeRequest,
  type FaqSuggestion,
  type FaqSuggestionStatus,
  type KnowledgePanelProps,
} from './knowledge-client';

type FilterTab = 'ALL' | FaqSuggestionStatus;

interface EditDraft {
  title: string;
  topic: string;
  text: string;
  aliases: string;
  channels: Channel[];
}

const FILTER_TABS: ReadonlyArray<{ value: FilterTab; label: string }> = [
  { value: 'PENDING', label: '待审核' },
  { value: 'ADOPTED', label: '已采纳' },
  { value: 'DISMISSED', label: '已忽略' },
  { value: 'ALL', label: '全部' },
];

const STATUS_BADGE: Record<FaqSuggestionStatus, { label: string; cls: string }> = {
  PENDING: {
    label: '待审核',
    cls: 'border-warning/35 bg-warning/10 text-warning-foreground',
  },
  ADOPTED: {
    label: '已采纳入库',
    cls: 'border-success/35 bg-success/10 text-success-foreground',
  },
  DISMISSED: {
    label: '已忽略',
    cls: 'border-border/80 bg-muted/45 text-muted-foreground',
  },
};

const hintCls = 'hint text-xs leading-relaxed text-muted-foreground';
const labelCls = 'flex flex-col gap-1 text-xs font-medium text-foreground';
const inputCls =
  'h-8.5 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-[13px] text-foreground shadow-xs/5 outline-none transition-shadow focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/32';
const textareaCls =
  'w-full min-w-0 rounded-lg border border-input bg-background px-3 py-2 text-[13px] leading-relaxed text-foreground shadow-xs/5 outline-none transition-shadow focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/32';
const btnOutlineCls =
  'inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-input bg-popover px-3 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55 dark:bg-input/32 dark:hover:bg-input/64';
const btnPrimaryCls =
  'primary inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-primary bg-primary px-3 text-xs font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55';
const btnDangerCls =
  'danger inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-destructive/35 bg-destructive/8 px-3 text-xs font-medium text-destructive-foreground shadow-xs/5 transition-colors hover:bg-destructive/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55';

export function normalizeSuggestionList(raw: unknown): FaqSuggestion[] {
  if (Array.isArray(raw)) return raw as FaqSuggestion[];
  if (raw && typeof raw === 'object' && Array.isArray((raw as { suggestions?: unknown }).suggestions)) {
    return (raw as { suggestions: FaqSuggestion[] }).suggestions;
  }
  return [];
}

function defaultDraftFor(item: FaqSuggestion): EditDraft {
  return {
    title: item.question,
    topic: '人工对话提炼FAQ',
    text: item.suggestedAnswer,
    aliases: item.variants.join('，'),
    channels: item.channels.length ? [...item.channels] : ['DIRECT_MESSAGE'],
  };
}

function parseAliases(raw: string): string[] {
  return raw
    .split(/[,，\n]/u)
    .map(value => value.trim())
    .filter(Boolean);
}

export function FaqSuggestionsPanel({ overview, busy, perform }: KnowledgePanelProps) {
  const [filter, setFilter] = useState<FilterTab>('PENDING');
  const [suggestions, setSuggestions] = useState<FaqSuggestion[]>([]);
  const [drafts, setDrafts] = useState<Record<string, EditDraft>>({});
  const [loading, setLoading] = useState(false);
  const [localError, setLocalError] = useState('');
  const [localNotice, setLocalNotice] = useState('');

  const aliveRef = useRef(true);
  const listEpochRef = useRef(0);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      listEpochRef.current += 1;
    };
  }, []);

  const loadSuggestions = async (targetFilter: FilterTab = filter) => {
    if (!overview.available) return;
    const epoch = ++listEpochRef.current;
    setLoading(true);
    setLocalError('');
    try {
      const raw = await knowledgeRequest<unknown>({
        action: 'listFaqSuggestions',
        ...(targetFilter !== 'ALL' ? { status: targetFilter } : {}),
      });
      if (!aliveRef.current || listEpochRef.current !== epoch) return;
      const items = normalizeSuggestionList(raw);
      setSuggestions(items);
      setDrafts(prev => {
        const next: Record<string, EditDraft> = {};
        for (const item of items) {
          if (item.status === 'PENDING') {
            next[item.id] = prev[item.id] ?? defaultDraftFor(item);
          }
        }
        return next;
      });
    } catch (failure) {
      if (!aliveRef.current || listEpochRef.current !== epoch) return;
      setLocalError(describeKnowledgeError(failure));
    } finally {
      if (aliveRef.current && listEpochRef.current === epoch) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    if (!overview.available) return;
    void loadSuggestions(filter);
  }, [overview.available, filter]);

  const locked = busy || loading || !overview.available;

  const updateDraft = (id: string, item: FaqSuggestion, patch: Partial<EditDraft>) => {
    setDrafts(prev => ({
      ...prev,
      [id]: { ...(prev[id] ?? defaultDraftFor(item)), ...patch },
    }));
  };

  const handleGenerate = () => {
    if (locked) return;
    setLocalError('');
    setLocalNotice('');
    void perform<unknown>(
      '从已解决人工对话提炼',
      { action: 'generateFaqSuggestions' },
      result => {
        const generated = normalizeSuggestionList(result);
        setLocalNotice(
          generated.length > 0
            ? `已新提炼或更新 ${generated.length} 条候选问答建议。`
            : '已完成扫描，暂未发现新增高频相似问答。',
        );
        void loadSuggestions(filter);
      },
      false,
    );
  };

  const handleAdopt = (item: FaqSuggestion) => {
    if (locked) return;
    const draft = drafts[item.id] ?? defaultDraftFor(item);
    const title = draft.title.trim();
    const topic = draft.topic.trim();
    const text = draft.text.trim();
    const aliases = parseAliases(draft.aliases);
    if (!title || !topic || !text || draft.channels.length === 0) {
      setLocalError('请填写完整的问题标题、所属主题、回答正文并至少选择一个适用通道。');
      return;
    }
    if (aliases.length > 30 || aliases.some(alias => alias.length > 100)) {
      setLocalError('相似问法最多 30 个，且单个词条不超过 100 字。');
      return;
    }
    setLocalError('');
    setLocalNotice('');
    void perform(
      '采纳并入库',
      {
        action: 'adoptFaqSuggestion',
        suggestionId: item.id,
        title,
        topic,
        text,
        aliases,
        channels: draft.channels,
        activate: true,
      },
      () => {
        setLocalNotice(`已将「${title}」采纳并启用至知识库。`);
        void loadSuggestions(filter);
      },
      true,
    );
  };

  const handleDismiss = (item: FaqSuggestion) => {
    if (locked) return;
    setLocalError('');
    setLocalNotice('');
    void perform(
      '忽略候选问答',
      { action: 'dismissFaqSuggestion', suggestionId: item.id },
      () => {
        setLocalNotice('已忽略该候选问答，后续提炼将不再重复提示。');
        void loadSuggestions(filter);
      },
      false,
    );
  };

  return (
    <div className="faq-suggestions-panel flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="font-heading text-[14px] font-semibold text-foreground">
            从人工已解决对话提炼候选 FAQ
          </h3>
          <p className={hintCls}>
            自动聚类本账号已确认送达的人工历史回复并脱敏隐私信息，核对或微调后可一键采纳进知识库并立即生效。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={btnOutlineCls}
            disabled={locked}
            onClick={() => void loadSuggestions(filter)}
          >
            {loading ? '读取中…' : '刷新列表'}
          </button>
          <button
            type="button"
            className={btnPrimaryCls}
            disabled={locked}
            onClick={handleGenerate}
          >
            从已解决人工对话提炼
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="候选问答状态筛选">
        {FILTER_TABS.map(item => {
          const active = filter === item.value;
          return (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={active}
              disabled={locked}
              onClick={() => setFilter(item.value)}
              className={`cursor-pointer rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-55 ${
                active
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border/80 bg-background text-muted-foreground hover:text-foreground'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      {localError && (
        <p
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/6 px-3.5 py-2 text-xs font-medium text-destructive-foreground"
        >
          {localError}
        </p>
      )}
      {localNotice && (
        <p
          role="status"
          className="rounded-xl border border-success/30 bg-success/8 px-3.5 py-2 text-xs font-medium text-success-foreground"
        >
          {localNotice}
        </p>
      )}

      {suggestions.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-muted/25 px-4 py-8 text-center text-xs text-muted-foreground">
          {loading
            ? '正在读取候选问答列表…'
            : '当前筛选下暂无候选问答。可点击右上角「从已解决人工对话提炼」扫描历史确认回复。'}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {suggestions.map(item => {
            const badge = STATUS_BADGE[item.status];
            const draft = drafts[item.id] ?? defaultDraftFor(item);
            const isPending = item.status === 'PENDING';
            return (
              <article
                key={item.id}
                className="flex flex-col gap-3 rounded-xl border border-border/80 bg-background p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13.5px] font-semibold text-foreground">
                        {item.question}
                      </span>
                      <span
                        className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium ${badge.cls}`}
                      >
                        {badge.label}
                      </span>
                    </div>
                    <p className="text-[11.5px] text-muted-foreground tabular-nums">
                      来自 {item.sampleCount} 条已确认人工回复 · 适用通道：
                      {item.channels.map(channelName).join(' / ') || '私信'} · 更新于{' '}
                      {formatDate(item.updatedAt)}
                    </p>
                  </div>
                </div>

                {item.variants.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="text-[11.5px] text-muted-foreground">相似问法：</span>
                    {item.variants.map(variant => (
                      <span
                        key={variant}
                        className="rounded-md border border-border/80 bg-muted/35 px-2 py-0.5 text-[11.5px] text-foreground"
                      >
                        {variant}
                      </span>
                    ))}
                  </div>
                )}

                <div className="rounded-lg border border-border/70 bg-muted/25 px-3 py-2 text-xs">
                  <div className="mb-1 text-[11px] font-medium text-muted-foreground">推荐标准回复</div>
                  <p className="leading-relaxed text-foreground">{item.suggestedAnswer}</p>
                </div>

                {isPending && (
                  <div className="flex flex-col gap-3 rounded-xl border border-border/75 bg-muted/20 p-3.5">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className={labelCls}>
                        入库知识标题
                        <input
                          type="text"
                          className={inputCls}
                          aria-label={`入库知识标题-${item.id}`}
                          maxLength={120}
                          disabled={locked}
                          value={draft.title}
                          onChange={event => updateDraft(item.id, item, { title: event.target.value })}
                        />
                      </label>
                      <label className={labelCls}>
                        所属主题
                        <input
                          type="text"
                          className={inputCls}
                          aria-label={`所属主题-${item.id}`}
                          maxLength={80}
                          disabled={locked}
                          value={draft.topic}
                          onChange={event => updateDraft(item.id, item, { topic: event.target.value })}
                        />
                      </label>
                    </div>
                    <label className={labelCls}>
                      相似问法关键词（用逗号或换行分隔）
                      <input
                        type="text"
                        className={inputCls}
                        aria-label={`相似问法关键词-${item.id}`}
                        disabled={locked}
                        value={draft.aliases}
                        onChange={event => updateDraft(item.id, item, { aliases: event.target.value })}
                      />
                    </label>
                    <label className={labelCls}>
                      标准回复正文
                      <textarea
                        rows={3}
                        className={textareaCls}
                        aria-label={`标准回复正文-${item.id}`}
                        maxLength={4000}
                        disabled={locked}
                        value={draft.text}
                        onChange={event => updateDraft(item.id, item, { text: event.target.value })}
                      />
                    </label>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-3 text-xs text-foreground">
                        {(['DIRECT_MESSAGE', 'COMMENT_NOTIFICATION'] as const).map(channel => (
                          <label key={channel} className="inline-flex cursor-pointer items-center gap-1.5 select-none">
                            <input
                              type="checkbox"
                              className="size-4 cursor-pointer accent-primary"
                              disabled={locked}
                              checked={draft.channels.includes(channel)}
                              onChange={event => {
                                const next = event.target.checked
                                  ? [...new Set([...draft.channels, channel])]
                                  : draft.channels.filter(c => c !== channel);
                                updateDraft(item.id, item, { channels: next });
                              }}
                            />
                            {channelName(channel)}
                          </label>
                        ))}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          className={btnDangerCls}
                          disabled={locked}
                          onClick={() => handleDismiss(item)}
                        >
                          丢弃不再提示
                        </button>
                        <button
                          type="button"
                          className={btnPrimaryCls}
                          disabled={locked}
                          onClick={() => handleAdopt(item)}
                        >
                          采纳并入库
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
