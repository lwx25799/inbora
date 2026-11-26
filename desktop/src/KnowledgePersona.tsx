import { useState } from 'react';
import type { PersonaVersion } from '../../src/contracts/knowledge.js';
import { formatDate, type KnowledgePanelProps } from './knowledge-client';

const personaNames: Record<PersonaVersion['state'], string> = {
  DRAFT: '草稿',
  PUBLISHED: '当前发布',
  ARCHIVED: '历史版本',
  INVALID: '来源已失效',
};
interface AnalysisResult {
  taskId: string;
  persona: PersonaVersion;
  calls: number;
  usedCount: number;
  omittedCount: number;
}

const hintCls = 'hint text-xs leading-relaxed text-muted-foreground';
const textareaCls =
  'w-full min-w-0 rounded-lg border border-input bg-background px-3 py-2 text-[13px] leading-relaxed text-foreground shadow-xs/5 outline-none transition-shadow focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/32';
const btnOutlineCls =
  'inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-input bg-popover px-3 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55 dark:bg-input/32';
const btnPrimaryCls =
  'primary inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-primary bg-primary px-3 text-xs font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55';
const learnBtnWrapperCls =
  '[&>button]:inline-flex [&>button]:h-8 [&>button]:shrink-0 [&>button]:cursor-pointer [&>button]:items-center [&>button]:justify-center [&>button]:whitespace-nowrap [&>button]:rounded-lg [&>button]:border [&>button]:border-primary [&>button]:bg-primary [&>button]:px-3 [&>button]:text-xs [&>button]:font-medium [&>button]:text-primary-foreground [&>button]:shadow-xs [&>button]:transition-colors [&>button]:hover:bg-primary/90 [&>button]:focus-visible:outline-none [&>button]:focus-visible:ring-2 [&>button]:focus-visible:ring-ring [&>button]:disabled:pointer-events-none [&>button]:disabled:opacity-55';

export function KnowledgePersona({ overview, busy, perform }: KnowledgePanelProps) {
  const active = overview.activePersona;
  const [draft, setDraft] = useState(''),
    [sampleIds, setSampleIds] = useState<string[]>([]),
    [editingId, setEditingId] = useState<string | null>(null);
  const [consent, setConsent] = useState(false),
    [result, setResult] = useState('');
  const load = (persona: PersonaVersion) => {
    setDraft(persona.text);
    setSampleIds(persona.sampleIds);
    setEditingId(persona.id);
    setResult('');
  };
  const publishedText = active?.text ?? '';
  const previousLines = publishedText.split('\n').filter(line => line.trim()),
    candidateLines = draft.split('\n').filter(line => line.trim());
  const removed = previousLines.filter(line => !candidateLines.includes(line)),
    added = candidateLines.filter(line => !previousLines.includes(line));
  const analyze = (taskId?: string) =>
    void perform<AnalysisResult>(
      taskId ? '继续上次分析' : '学习回复人格',
      {
        action: 'analyze',
        sampleIds: [],
        ...(taskId ? { taskId } : {}),
        confirmed: true,
      },
      value => {
        load(value.persona);
        setResult(
          `本次使用 ${value.usedCount} 组样本，因长度限制略过 ${value.omittedCount} 组；完成 ${value.calls} 次模型调用。候选人格检查并发布后才生效。`,
        );
      },
    );
  const unfinished = overview.learningTasks.filter(
    task => task.state === 'RUNNING' || task.state === 'FAILED',
  );

  return (
    <div className="knowledge-persona flex flex-col gap-4">
      <div className="knowledge-toolbar flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="font-heading text-[14px] font-semibold text-foreground">学习你的表达方式</h3>
          <p className={hintCls}>
            当前人格：{active ? `发布于 ${formatDate(active.createdAt)}` : '尚未发布，沿用已有账号人设'}
          </p>
        </div>
        <button
          className={btnOutlineCls}
          disabled={busy || !active}
          onClick={() => {
            if (active) load(active);
          }}
        >
          复制当前人格到编辑区
        </button>
      </div>

      <p className={hintCls}>
        从已采纳的本人回复中提炼语气、称呼、句式和表达边界，每次最多200组、6次模型调用，按实际样本量与长度计算。知识事实独立维护，不从聊天中自动提取价格或承诺。
      </p>

      <div className="flex flex-col gap-3 rounded-xl border border-border/80 bg-muted/30 p-3.5">
        <label className="check inline-flex cursor-pointer items-start gap-2 text-xs text-foreground select-none">
          <input
            type="checkbox"
            className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary"
            checked={consent}
            disabled={busy}
            onChange={event => setConsent(event.target.checked)}
          />
          我同意将必要的已采纳样本片段发送给当前模型，用于本次人格学习，并计入已有模型额度。
        </label>
        <div className={learnBtnWrapperCls}>
          <button
            disabled={busy || !consent || overview.totals.accepted === 0}
            onClick={() => analyze()}
          >
            从已采纳样本学习
          </button>
        </div>
      </div>

      {unfinished.length > 0 && (
        <details className="knowledge-history rounded-xl border border-warning/35 bg-warning/6 px-4 py-3 text-[13px]">
          <summary className="cursor-pointer font-medium text-[13px] text-foreground select-none">
            未完成的分析 · {unfinished.length} 个
          </summary>
          <div className="mt-3 flex flex-col gap-2.5">
            <p className={hintCls}>
              继续时复用已完成批次，只调用剩余步骤。样本选择或模型已变化时需要重新学习。
            </p>
            {unfinished.map((task, index) => (
              <div
                key={task.id}
                className="knowledge-entry flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/75 bg-card p-3 text-xs"
              >
                <p className="text-foreground">
                  分析 {index + 1} · {task.state === 'FAILED' ? '上次未完成' : '处理中或中断'} ·
                  已完成 {task.completed} 个步骤
                </p>
                <button
                  className={btnOutlineCls}
                  disabled={busy || !consent}
                  onClick={() => analyze(task.id)}
                >
                  继续上次分析
                </button>
              </div>
            ))}
          </div>
        </details>
      )}

      {result && (
        <p
          role="status"
          className="hint rounded-xl border border-primary/25 bg-primary/[0.06] px-3.5 py-2 text-xs text-foreground"
        >
          {result}
        </p>
      )}

      <div className="knowledge-persona-comparison grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-border/80 bg-background p-4">
          <h4 className="text-[13px] font-semibold text-foreground">当前已发布人格</h4>
          <pre className="knowledge-text-preview min-h-[220px] flex-1 overflow-auto rounded-lg border border-border/70 bg-muted/30 p-3 font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-foreground">
            {publishedText || '尚未发布人格。现有账号人设继续生效。'}
          </pre>
        </div>

        <form
          className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/80 bg-background p-4"
          onSubmit={event => {
            event.preventDefault();
            if (!draft.trim() || busy) return;
            void perform<PersonaVersion>(
              '保存人格草稿',
              {
                action: 'savePersona',
                text: draft,
                sampleIds,
              },
              value => {
                setEditingId(value.id);
                setResult('人格草稿已保存，尚未发布。');
              },
            );
          }}
        >
          <h4 className="text-[13px] font-semibold text-foreground">候选人格与人工修改</h4>
          <label className="flex flex-col gap-1.5 text-xs font-medium text-foreground">
            人格内容
            <textarea
              className={textareaCls}
              aria-label="人格内容"
              rows={10}
              maxLength={2000}
              disabled={busy}
              value={draft}
              onChange={event => {
                setDraft(event.target.value);
                setEditingId(null);
                setResult('');
              }}
            />
          </label>
          <p className={`${hintCls} tabular-nums`}>
            {draft.length}/2000 字 · 关联样本 {sampleIds.length} 组
            {draft === publishedText && draft ? ' · 与当前人格一致' : ''}
          </p>
          {draft && draft !== publishedText && (
            <details className="knowledge-persona-diff rounded-lg border border-border/75 bg-muted/30 px-3 py-2 text-xs">
              <summary className="cursor-pointer font-medium text-foreground select-none">
                与当前人格的段落差异
              </summary>
              <div className="mt-2 flex flex-col gap-1">
                {removed.map((line, index) => (
                  <p key={`removed-${index}`} className="text-destructive-foreground">
                    <del>移除：{line}</del>
                  </p>
                ))}
                {added.map((line, index) => (
                  <p key={`added-${index}`} className="text-success-foreground">
                    <ins className="no-underline">新增：{line}</ins>
                  </p>
                ))}
              </div>
            </details>
          )}
          <div className="row flex flex-wrap items-center gap-2 pt-1">
            <button
              className={btnOutlineCls}
              type="submit"
              disabled={busy || !draft.trim()}
            >
              保存人格草稿
            </button>
            <button
              className={btnPrimaryCls}
              type="button"
              disabled={busy || !editingId || !draft.trim() || draft === publishedText}
              onClick={() => {
                if (editingId)
                  void perform(
                    '发布回复人格',
                    { action: 'publishPersona', id: editingId },
                    () => setResult('人格已发布，后续生成使用新版本。'),
                  );
              }}
            >
              发布此人格
            </button>
          </div>
        </form>
      </div>

      <details className="knowledge-history rounded-xl border border-border/80 bg-muted/30 px-4 py-3 text-[13px]">
        <summary className="cursor-pointer font-medium text-[13px] text-foreground select-none">
          人格版本记录 · {overview.personas.length} 个
        </summary>
        <div className="mt-3 flex flex-col gap-2.5">
          {overview.personas.length === 0 ? (
            <p className={hintCls}>还没有保存过人格版本。</p>
          ) : (
            overview.personas.map(persona => (
              <article
                key={persona.id}
                className="knowledge-entry flex flex-col gap-2 rounded-lg border border-border/75 bg-card p-3.5"
              >
                <div className="knowledge-entry-heading flex flex-wrap items-center justify-between gap-2">
                  <h4 className="font-medium text-xs text-foreground tabular-nums">
                    {formatDate(persona.createdAt)}
                  </h4>
                  <span className="knowledge-state rounded-sm bg-secondary px-2 py-0.5 text-[11px] font-medium text-secondary-foreground">
                    {personaNames[persona.state]}
                  </span>
                </div>
                <p className="knowledge-excerpt text-xs leading-relaxed text-foreground">
                  {persona.text.slice(0, 240)}
                </p>
                <p className={`${hintCls} tabular-nums`}>关联样本 {persona.sampleIds.length} 组</p>
                <div className="row flex flex-wrap items-center gap-2">
                  <button
                    className={btnOutlineCls}
                    disabled={busy}
                    onClick={() => load(persona)}
                  >
                    查看并编辑
                  </button>
                  {persona.state === 'ARCHIVED' && (
                    <button
                      className={btnOutlineCls}
                      disabled={busy}
                      onClick={() =>
                        void perform('回退回复人格', { action: 'publishPersona', id: persona.id })
                      }
                    >
                      恢复此版本
                    </button>
                  )}
                </div>
              </article>
            ))
          )}
        </div>
      </details>
    </div>
  );
}
