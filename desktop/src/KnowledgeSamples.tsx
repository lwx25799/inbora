import { useState } from 'react';
import { channelName, sourceNames, type KnowledgePanelProps } from './knowledge-client';
import { KnowledgeImport } from './KnowledgeImport';

const hintCls = 'hint text-xs leading-relaxed text-muted-foreground';
const selectCls =
  'h-8 rounded-lg border border-input bg-background px-2.5 text-xs text-foreground shadow-xs/5 outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 dark:bg-input/32';
const btnOutlineCls =
  'inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-input bg-popover px-3 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55 dark:bg-input/32';
const btnPrimaryCls =
  'primary inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-primary bg-primary px-3 text-xs font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55';
const btnDangerCls =
  'danger inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-destructive/35 bg-destructive/8 px-3 text-xs font-medium text-destructive-foreground shadow-xs/5 transition-colors hover:bg-destructive/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55';

export function KnowledgeSamples({ overview, busy, perform }: KnowledgePanelProps) {
  const [selected, setSelected] = useState<string[]>([]),
    [filter, setFilter] = useState<'all' | 'pending' | 'accepted' | 'excluded'>('pending');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const rows = overview.samples.filter(
    sample =>
      filter === 'all' ||
      (filter === 'accepted' && sample.accepted && !sample.excluded) ||
      (filter === 'excluded' && sample.excluded) ||
      (filter === 'pending' && !sample.accepted && !sample.excluded),
  );
  const visibleIds = new Set(rows.map(row => row.id)),
    ids = selected.filter(id => visibleIds.has(id));
  const canAccept =
    ids.length > 0 &&
    rows
      .filter(sample => ids.includes(sample.id))
      .every(sample => !sample.excluded || sample.reason === 'USER_EXCLUDED');
  const choose = (id: string, checked: boolean) =>
    setSelected(previous =>
      checked ? [...new Set([...previous, id])] : previous.filter(value => value !== id),
    );

  const chatSources = overview.sources.filter(source => source.kind === 'CHAT');

  return (
    <div className="knowledge-samples flex flex-col gap-4">
      <div className="knowledge-toolbar flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="font-heading text-[14px] font-semibold text-foreground">选择你的回复样本</h3>
          <p className={`${hintCls} tabular-nums`}>
            已采纳 {overview.totals.accepted} 组 · 留出评估 {overview.totals.holdout} 组
          </p>
        </div>
        <button
          className={btnOutlineCls}
          disabled={busy}
          onClick={() => void perform('收集本人回复候选', { action: 'collectCandidates' })}
        >
          从 Inbora 收集候选
        </button>
      </div>

      <p className={hintCls}>
        先预览再采纳。自动回复和来源不明的记录不会自动成为本人的示范，留出样本仅用于评估。
      </p>

      <KnowledgeImport kind="CHAT" busy={busy} perform={perform} />

      {chatSources.length > 0 && (
        <details className="knowledge-history rounded-xl border border-border/80 bg-muted/30 px-4 py-3 text-[13px]">
          <summary className="cursor-pointer font-medium text-[13px] text-foreground select-none">
            管理聊天来源 · {chatSources.length} 个
          </summary>
          <div className="mt-3 flex flex-col gap-2.5">
            {chatSources.map(source => (
              <article
                key={source.id}
                className="knowledge-entry flex flex-col gap-2 rounded-lg border border-border/75 bg-card p-3"
              >
                <div className="knowledge-entry-heading flex flex-wrap items-center justify-between gap-2">
                  <h4 className="font-medium text-xs text-foreground">{source.title}</h4>
                  <button
                    className={btnDangerCls}
                    disabled={busy}
                    onClick={() => setDeleteId(source.id)}
                  >
                    删除聊天来源
                  </button>
                </div>
                {deleteId === source.id && (
                  <div className="knowledge-confirm flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/6 p-3">
                    <p className="text-xs text-destructive-foreground">
                      删除此来源的全部样本及其检索片段？关联人格将失效，原始会话和发送记录保留。
                    </p>
                    <div className="row flex flex-wrap items-center gap-2">
                      <button
                        className={btnDangerCls}
                        disabled={busy}
                        onClick={() =>
                          void perform(
                            '删除聊天来源',
                            { action: 'deleteSource', sourceId: source.id },
                            () => setDeleteId(null),
                          )
                        }
                      >
                        确认删除聊天来源
                      </button>
                      <button
                        className={btnOutlineCls}
                        disabled={busy}
                        onClick={() => setDeleteId(null)}
                      >
                        保留聊天来源
                      </button>
                    </div>
                  </div>
                )}
              </article>
            ))}
          </div>
        </details>
      )}

      <div className="knowledge-toolbar flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/75 bg-muted/30 px-3.5 py-2.5">
        <label className="knowledge-filter inline-flex items-center gap-2 text-xs font-medium text-foreground">
          样本筛选
          <select
            className={selectCls}
            aria-label="样本筛选"
            value={filter}
            onChange={event => {
              setFilter(event.target.value as typeof filter);
              setSelected([]);
            }}
          >
            <option value="pending">待选择</option>
            <option value="accepted">已采纳</option>
            <option value="excluded">已排除</option>
            <option value="all">全部</option>
          </select>
        </label>
        <div className="row flex flex-wrap items-center gap-2">
          <button
            className={btnOutlineCls}
            disabled={busy || !rows.length}
            onClick={() => setSelected(ids.length === rows.length ? [] : rows.map(row => row.id))}
          >
            {ids.length === rows.length && rows.length ? '取消本页全选' : '选择本页'}
          </button>
          <button
            className={btnPrimaryCls}
            disabled={busy || !canAccept}
            onClick={() =>
              void perform(
                '采纳所选样本',
                { action: 'selectSamples', ids, accepted: true },
                () => setSelected([]),
              )
            }
          >
            采纳所选 {ids.length || ''}
          </button>
          <button
            className={btnOutlineCls}
            disabled={busy || !ids.length}
            onClick={() =>
              void perform(
                '排除所选样本',
                { action: 'selectSamples', ids, accepted: false },
                () => setSelected([]),
              )
            }
          >
            排除所选
          </button>
        </div>
      </div>

      {!!ids.length && !canAccept && (
        <p className="hint rounded-xl border border-warning/35 bg-warning/8 px-3.5 py-2 text-xs text-warning-foreground">
          所选记录含自动排除的敏感内容或纯自动回复，不能直接采纳。手动排除的样本可重新采纳。
        </p>
      )}

      {rows.length === 0 ? (
        <p className="knowledge-empty rounded-xl border border-dashed border-border bg-muted/25 px-4 py-8 text-center text-xs text-muted-foreground">
          本页没有符合筛选的样本。可收集候选、导入聊天记录，或切换筛选。
        </p>
      ) : (
        <div className="knowledge-sample-list flex flex-col gap-3">
          {rows.map(sample => (
            <article
              className="knowledge-sample flex flex-col gap-2.5 rounded-xl border border-border/80 bg-background p-4"
              key={sample.id}
            >
              <div className="knowledge-entry-heading flex flex-wrap items-center justify-between gap-2">
                <label className="check inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-foreground select-none">
                  <input
                    type="checkbox"
                    className="size-4 cursor-pointer accent-primary"
                    disabled={busy}
                    checked={ids.includes(sample.id)}
                    aria-label={`选择样本：${sample.prompt.slice(0, 30)}`}
                    onChange={event => choose(sample.id, event.target.checked)}
                  />
                  {channelName(sample.channel)} · {sourceNames[sample.source] ?? '来源待确认'}
                </label>
                <span
                  className={`knowledge-state rounded-sm px-2 py-0.5 text-[11px] font-medium ${
                    sample.excluded
                      ? 'bg-destructive/10 text-destructive-foreground'
                      : sample.accepted
                        ? 'bg-success/10 text-success-foreground'
                        : 'bg-secondary text-secondary-foreground'
                  }`}
                >
                  {sample.excluded ? '已排除' : sample.accepted ? '已采纳' : '待选择'}
                  {sample.holdout ? ' · 留出评估' : ''}
                </span>
              </div>
              <dl className="grid grid-cols-1 gap-1.5 text-xs">
                <div className="flex flex-col gap-0.5">
                  <dt className="text-[11px] text-muted-foreground">对方</dt>
                  <dd className="text-foreground">{sample.prompt}</dd>
                </div>
                <div className="flex flex-col gap-0.5 rounded-lg bg-muted/40 px-3 py-2">
                  <dt className="text-[11px] font-medium text-primary">本人回复</dt>
                  <dd className="text-[13px] text-foreground">{sample.response}</dd>
                </div>
              </dl>
              {sample.reason && (
                <p className={hintCls}>
                  {sample.reason === 'USER_EXCLUDED'
                    ? '已由你排除，可重新选择并采纳'
                    : sample.reason === 'SENSITIVE_SAMPLE' || sample.reason === 'SENSITIVE_CONTENT'
                      ? '包含敏感信息，不参与模型学习'
                      : sample.reason === 'UNTRUSTED_INSTRUCTION'
                        ? '包含变更规则或泄密指令，不参与学习'
                        : sample.reason === 'SOURCE_UNVERIFIED'
                          ? '来源尚未确认'
                          : sample.reason === 'AI_GENERATED'
                            ? '纯自动回复，不作为本人示范'
                            : '该样本需要人工检查后选择'}
                </p>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
