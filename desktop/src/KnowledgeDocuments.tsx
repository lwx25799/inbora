import { useState } from 'react';
import type { KnowledgeEntry, KnowledgeInput } from '../../src/contracts/knowledge.js';
import type { Channel } from '../../src/contracts/events.js';
import { channelName, formatDate, type KnowledgePanelProps } from './knowledge-client';
import { KnowledgeImport } from './KnowledgeImport';

const empty = () => ({
  id: undefined as string | undefined,
  title: '',
  topic: '',
  text: '',
  aliases: '',
  channels: ['DIRECT_MESSAGE', 'COMMENT_NOTIFICATION'] as Channel[],
  effectiveAt: '',
  expiresAt: '',
  expectedVersion: undefined as number | undefined,
});
const toInputDate = (value: number | null) =>
  value === null
    ? ''
    : new Date(value - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

const hintCls = 'hint text-xs leading-relaxed text-muted-foreground';
const labelCls = 'flex flex-col gap-1.5 text-xs font-medium text-foreground';
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

export function KnowledgeDocuments({ overview, busy, perform }: KnowledgePanelProps) {
  const [draft, setDraft] = useState(empty),
    [deleteId, setDeleteId] = useState<string | null>(null);
  const edit = (entry: KnowledgeEntry) =>
    setDraft({
      id: entry.id,
      title: entry.title,
      topic: entry.topic,
      text: entry.text,
      aliases: entry.aliases.join('，'),
      channels: entry.channels,
      effectiveAt: toInputDate(entry.effectiveAt),
      expiresAt: toInputDate(entry.expiresAt),
      expectedVersion: entry.version,
    });
  const aliases = draft.aliases
    .split(/[,，\n]/u)
    .map(value => value.trim())
    .filter(Boolean);
  const valid =
    !!draft.title.trim() &&
    !!draft.topic.trim() &&
    !!draft.text.trim() &&
    draft.channels.length > 0 &&
    aliases.length <= 30 &&
    aliases.every(value => value.length <= 100) &&
    (!draft.effectiveAt ||
      !draft.expiresAt ||
      Date.parse(draft.expiresAt) > Date.parse(draft.effectiveAt));

  return (
    <div className="knowledge-documents flex flex-col gap-4">
      <p className={hintCls}>
        新增或编辑后保存为停用条目，启用后才参与回复。事实冲突、过期或未生效的知识不会被当成确定答案。
      </p>
      <KnowledgeImport kind="KNOWLEDGE" busy={busy} perform={perform} />
      <div className="knowledge-workspace grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div
          className="knowledge-list flex min-w-0 flex-col gap-3"
          aria-label="知识条目列表"
        >
          {overview.knowledge.length === 0 ? (
            <p className="knowledge-empty rounded-xl border border-dashed border-border bg-muted/25 px-4 py-8 text-center text-xs text-muted-foreground">
              还没有知识条目。导入文件，或直接填写一条知识。
            </p>
          ) : (
            overview.knowledge.map(entry => (
              <article
                key={entry.id}
                className="knowledge-entry flex flex-col gap-2 rounded-xl border border-border/80 bg-background p-4"
              >
                <div className="knowledge-entry-heading flex flex-wrap items-center justify-between gap-2">
                  <h4 className="font-semibold text-[13.5px] text-foreground">{entry.title}</h4>
                  <span
                    className={`knowledge-state rounded-sm px-2 py-0.5 text-[11px] font-medium tabular-nums ${
                      entry.state === 'ACTIVE'
                        ? 'active bg-success/10 text-success-foreground'
                        : 'bg-secondary text-secondary-foreground'
                    }`}
                  >
                    {entry.state === 'ACTIVE' ? '已启用' : '已停用'} · v{entry.version}
                  </span>
                </div>
                <p className={hintCls}>
                  {entry.topic} · {entry.channels.map(channelName).join('、')}
                </p>
                <p className="knowledge-excerpt text-[13px] leading-relaxed text-foreground">
                  {entry.text.slice(0, 220)}
                  {entry.text.length > 220 ? '…' : ''}
                </p>
                {(entry.effectiveAt !== null || entry.expiresAt !== null) && (
                  <p className={`${hintCls} tabular-nums`}>
                    生效 {formatDate(entry.effectiveAt)} · 失效 {formatDate(entry.expiresAt)}
                  </p>
                )}
                <div className="row flex flex-wrap items-center gap-2 pt-1">
                  <button className={btnOutlineCls} disabled={busy} onClick={() => edit(entry)}>
                    编辑条目
                  </button>
                  <button
                    className={btnOutlineCls}
                    disabled={busy}
                    onClick={() =>
                      void perform(entry.state === 'ACTIVE' ? '停用知识' : '启用知识', {
                        action: 'setKnowledgeState',
                        id: entry.id,
                        state: entry.state === 'ACTIVE' ? 'DISABLED' : 'ACTIVE',
                      })
                    }
                  >
                    {entry.state === 'ACTIVE' ? '停用知识' : '启用知识'}
                  </button>
                  <button
                    className={btnDangerCls}
                    disabled={busy}
                    onClick={() => setDeleteId(entry.sourceId)}
                  >
                    删除来源
                  </button>
                </div>
                {deleteId === entry.sourceId && (
                  <div className="knowledge-confirm mt-1 flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/6 p-3">
                    <p className="text-xs text-destructive-foreground">
                      删除此来源及其全部知识、样本和检索片段？原始聊天与发送记录保留。
                    </p>
                    <div className="row flex flex-wrap items-center gap-2">
                      <button
                        className={btnDangerCls}
                        disabled={busy}
                        onClick={() =>
                          void perform(
                            '删除来源',
                            { action: 'deleteSource', sourceId: entry.sourceId },
                            () => setDeleteId(null),
                          )
                        }
                      >
                        确认删除来源
                      </button>
                      <button
                        className={btnOutlineCls}
                        disabled={busy}
                        onClick={() => setDeleteId(null)}
                      >
                        保留来源
                      </button>
                    </div>
                  </div>
                )}
              </article>
            ))
          )}
        </div>

        <form
          className="knowledge-editor flex min-w-0 flex-col gap-3 rounded-xl border border-border/80 bg-background p-4"
          onSubmit={event => {
            event.preventDefault();
            if (!valid || busy) return;
            const input = {
              ...(draft.id ? { id: draft.id, expectedVersion: draft.expectedVersion } : {}),
              title: draft.title,
              topic: draft.topic,
              text: draft.text,
              aliases,
              channels: draft.channels,
              effectiveAt: draft.effectiveAt ? Date.parse(draft.effectiveAt) : null,
              expiresAt: draft.expiresAt ? Date.parse(draft.expiresAt) : null,
            } satisfies KnowledgeInput;
            void perform('保存知识条目', { action: 'saveKnowledge', input }, () => setDraft(empty()));
          }}
        >
          <div className="knowledge-entry-heading flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-heading text-[14px] font-semibold text-foreground">
              {draft.id ? '编辑知识' : '新增知识'}
            </h3>
            <button
              type="button"
              className={btnOutlineCls}
              disabled={busy}
              onClick={() => setDraft(empty())}
            >
              新建条目
            </button>
          </div>

          <label className={labelCls}>
            知识标题
            <input
              className={inputCls}
              maxLength={200}
              value={draft.title}
              disabled={busy}
              onChange={event => setDraft({ ...draft, title: event.target.value })}
            />
          </label>
          <label className={labelCls}>
            主题
            <input
              className={inputCls}
              maxLength={100}
              value={draft.topic}
              disabled={busy}
              onChange={event => setDraft({ ...draft, topic: event.target.value })}
            />
          </label>
          <label className={labelCls}>
            知识正文
            <textarea
              className={textareaCls}
              aria-label="知识正文"
              rows={8}
              maxLength={100_000}
              value={draft.text}
              disabled={busy}
              onChange={event => setDraft({ ...draft, text: event.target.value })}
            />
          </label>
          <label className={labelCls}>
            关键词或别名（逗号或换行分隔）
            <textarea
              className={textareaCls}
              aria-label="关键词或别名（逗号或换行分隔）"
              rows={2}
              value={draft.aliases}
              disabled={busy}
              onChange={event => setDraft({ ...draft, aliases: event.target.value })}
            />
          </label>
          <p className={hintCls}>最多30个关键词，每个最多100字。</p>

          <div className="settings-options flex flex-wrap gap-4">
            {(['DIRECT_MESSAGE', 'COMMENT_NOTIFICATION'] as const).map(channel => (
              <label
                className="check inline-flex cursor-pointer items-center gap-2 text-xs text-foreground select-none"
                key={channel}
              >
                <input
                  type="checkbox"
                  className="size-4 cursor-pointer accent-primary"
                  checked={draft.channels.includes(channel)}
                  disabled={busy}
                  onChange={event =>
                    setDraft({
                      ...draft,
                      channels: event.target.checked
                        ? [...draft.channels, channel]
                        : draft.channels.filter(value => value !== channel),
                    })
                  }
                />
                {channelName(channel)}可用
              </label>
            ))}
          </div>

          <div className="knowledge-fields grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={labelCls}>
              生效时间（可选）
              <input
                type="datetime-local"
                className={inputCls}
                value={draft.effectiveAt}
                disabled={busy}
                onChange={event => setDraft({ ...draft, effectiveAt: event.target.value })}
              />
            </label>
            <label className={labelCls}>
              失效时间（可选）
              <input
                type="datetime-local"
                className={inputCls}
                value={draft.expiresAt}
                disabled={busy}
                onChange={event => setDraft({ ...draft, expiresAt: event.target.value })}
              />
            </label>
          </div>

          {!valid && draft.text && (
            <p className="hint text-xs text-warning-foreground">
              请填写标题、主题和正文，选择至少一个通道；失效时间须晚于生效时间。
            </p>
          )}
          <div className="pt-1">
            <button className={btnPrimaryCls} type="submit" disabled={busy || !valid}>
              保存知识条目
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
