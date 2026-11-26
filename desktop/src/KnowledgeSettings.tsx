import { useEffect, useRef, useState } from 'react';
import type { KnowledgeOverview } from '../../src/contracts/knowledge.js';
import { KnowledgeDocuments } from './KnowledgeDocuments';
import { KnowledgeSamples } from './KnowledgeSamples';
import { KnowledgePersona } from './KnowledgePersona';
import { KnowledgeTrial } from './KnowledgeTrial';
import { describeKnowledgeError, knowledgeRequest, type KnowledgeAction } from './knowledge-client';

const tabs = [
  ['knowledge', '知识库'],
  ['samples', '聊天样本'],
  ['persona', '回复人格'],
  ['trial', '试聊'],
] as const;
type Tab = (typeof tabs)[number][0];

const btnOutlineCls =
  'inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-input bg-popover px-3 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55 dark:bg-input/32 dark:hover:bg-input/64';

export function KnowledgeSettings({
  accountId,
  disabled = false,
}: {
  accountId: string | null;
  disabled?: boolean;
}) {
  const [tab, setTab] = useState<Tab>('knowledge');
  const [overview, setOverview] = useState<KnowledgeOverview | null>(null);
  const [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const alive = useRef(true),
    pending = useRef(false),
    generation = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);
  async function perform<T>(
    label: string,
    action: KnowledgeAction | (() => Promise<T>),
    onSuccess?: (result: T) => void,
    refresh = true,
  ): Promise<void> {
    if (pending.current || disabled || !accountId) return;
    const epoch = generation.current;
    pending.current = true;
    setBusy(label);
    setError('');
    setMessage('');
    const current = () => alive.current && generation.current === epoch;
    try {
      const result =
        typeof action === 'function' ? await action() : await knowledgeRequest<T>(action);
      if (!current()) return;
      onSuccess?.(result);
      if (typeof action !== 'function' && action.action === 'overview')
        setOverview(result as KnowledgeOverview);
      else if (refresh) {
        const next = await knowledgeRequest<KnowledgeOverview>({
          action: 'overview',
          page: overview?.page ?? 0,
        });
        if (current()) setOverview(next);
      }
      if (current())
        setMessage(
          typeof action !== 'function' && action.action === 'overview'
            ? '资料已更新'
            : `${label}已完成`,
        );
    } catch (failure) {
      if (current()) setError(describeKnowledgeError(failure));
      if (current() && typeof action !== 'function' && action.action === 'analyze') {
        const next = await knowledgeRequest<KnowledgeOverview>({
          action: 'overview',
          page: overview?.page ?? 0,
        }).catch(() => null);
        if (current() && next) setOverview(next);
      }
    } finally {
      if (current()) {
        pending.current = false;
        setBusy('');
      }
    }
  }
  useEffect(() => {
    const epoch = ++generation.current;
    pending.current = false;
    setBusy('');
    setOverview(null);
    setError('');
    setMessage('');
    if (!accountId) return;
    let cancelled = false;
    setBusy('读取资料');
    pending.current = true;
    void knowledgeRequest<KnowledgeOverview>({ action: 'overview' })
      .then(result => {
        if (!cancelled && alive.current && generation.current === epoch) setOverview(result);
      })
      .catch(failure => {
        if (!cancelled && alive.current && generation.current === epoch)
          setError(describeKnowledgeError(failure));
      })
      .finally(() => {
        if (!cancelled && alive.current && generation.current === epoch) {
          pending.current = false;
          setBusy('');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);
  const locked = disabled || !!busy || !accountId;
  const panel = overview ? { overview, busy: locked || !overview.available, perform } : null;

  return (
    <div
      className="settings-section knowledge-settings flex flex-col gap-4 rounded-2xl border border-border/85 bg-card p-5 text-card-foreground shadow-xs/5"
      aria-labelledby="reply-knowledge-title"
    >
      <div className="knowledge-heading flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2
            id="reply-knowledge-title"
            className="font-heading text-[15px] font-semibold tracking-tight text-foreground"
          >
            知识与回复人格
          </h2>
          <p className="hint text-xs leading-relaxed text-muted-foreground">
            知识决定事实，聊天样本用于学习你的表达。资料保存在本机，模型仅接收必要片段。
          </p>
        </div>
        <button
          className={btnOutlineCls}
          disabled={locked}
          onClick={() => void perform('读取资料', { action: 'overview', page: overview?.page ?? 0 })}
        >
          重新读取
        </button>
      </div>

      <div
        className="knowledge-tabs flex flex-wrap items-center gap-1 border-b border-border/80 pb-2"
        role="tablist"
        aria-label="知识与人格功能"
      >
        {tabs.map(([value, label]) => {
          const active = tab === value;
          return (
            <button
              id={`knowledge-tab-${value}`}
              role="tab"
              type="button"
              key={value}
              aria-selected={active}
              aria-controls={`knowledge-panel-${value}`}
              tabIndex={active ? 0 : -1}
              className={`cursor-pointer rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                active
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground'
              }`}
              onClick={() => setTab(value)}
              onKeyDown={event => {
                const index = tabs.findIndex(([id]) => id === tab);
                const next =
                  event.key === 'ArrowRight'
                    ? (index + 1) % tabs.length
                    : event.key === 'ArrowLeft'
                      ? (index + tabs.length - 1) % tabs.length
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? tabs.length - 1
                          : -1;
                if (next >= 0) {
                  event.preventDefault();
                  setTab(tabs[next][0]);
                  document.getElementById(`knowledge-tab-${tabs[next][0]}`)?.focus();
                }
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div className="knowledge-feedback" aria-live="polite">
        {busy ? (
          <p
            role="status"
            className="rounded-xl border border-border/75 bg-muted/40 px-3.5 py-2 text-xs text-muted-foreground"
          >
            {busy}…
          </p>
        ) : error ? (
          <p
            role="alert"
            className="error rounded-xl border border-destructive/30 bg-destructive/6 px-3.5 py-2 text-xs font-medium text-destructive-foreground"
          >
            {error}
          </p>
        ) : message ? (
          <p
            role="status"
            className="rounded-xl border border-success/30 bg-success/8 px-3.5 py-2 text-xs font-medium text-success-foreground"
          >
            {message}
          </p>
        ) : null}
      </div>

      {!accountId && (
        <p className="hint rounded-xl border border-border/75 bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
          连接本人账号后可管理此账号的知识与人格。
        </p>
      )}
      {overview && !overview.available && (
        <p className="hint rounded-xl border border-warning/35 bg-warning/8 px-4 py-3 text-xs text-warning-foreground">
          资料存储尚未就绪，暂不能导入或生成。
        </p>
      )}

      {panel && overview && (
        <>
          <section
            id="knowledge-panel-knowledge"
            role="tabpanel"
            aria-labelledby="knowledge-tab-knowledge"
            hidden={tab !== 'knowledge'}
          >
            <KnowledgeDocuments {...panel} />
          </section>
          <section
            id="knowledge-panel-samples"
            role="tabpanel"
            aria-labelledby="knowledge-tab-samples"
            hidden={tab !== 'samples'}
          >
            <KnowledgeSamples {...panel} />
          </section>
          <section
            id="knowledge-panel-persona"
            role="tabpanel"
            aria-labelledby="knowledge-tab-persona"
            hidden={tab !== 'persona'}
          >
            <KnowledgePersona {...panel} />
          </section>
          <section
            id="knowledge-panel-trial"
            role="tabpanel"
            aria-labelledby="knowledge-tab-trial"
            hidden={tab !== 'trial'}
          >
            <KnowledgeTrial {...panel} />
          </section>
          <div className="knowledge-pagination flex flex-wrap items-center justify-between gap-3 border-t border-border/75 pt-3.5 text-xs text-muted-foreground tabular-nums">
            <span>
              第 {overview.page + 1} 页 · 知识 {overview.totals.knowledge} 条 · 样本{' '}
              {overview.totals.samples} 条
            </span>
            <div className="flex items-center gap-2">
              <button
                className={btnOutlineCls}
                disabled={locked || overview.page <= 0}
                onClick={() =>
                  void perform('读取上一页', { action: 'overview', page: overview.page - 1 })
                }
              >
                上一页
              </button>
              <button
                className={btnOutlineCls}
                disabled={
                  locked ||
                  Math.max(
                    overview.totals.knowledge,
                    overview.totals.samples,
                    overview.totals.sources,
                    overview.totals.personas,
                  ) <=
                    (overview.page + 1) * overview.pageSize
                }
                onClick={() =>
                  void perform('读取下一页', { action: 'overview', page: overview.page + 1 })
                }
              >
                下一页
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
