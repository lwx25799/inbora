import { useState } from 'react';
import type { Channel } from '../../src/contracts/events.js';
import { formatDate, type KnowledgePanelProps } from './knowledge-client';

interface TrialReply {
  text: string;
  model: string;
  personaId: string | null;
  fingerprint: string;
  knowledge?: { id: string; title: string; version: number }[];
  conflicts?: string[];
}
interface TrialResult {
  current: TrialReply;
  comparison?: TrialReply;
  currentContext?: {
    knowledge?: { id: string; title: string; version: number }[];
    conflicts?: string[];
  };
}

const hintCls = 'hint text-xs leading-relaxed text-muted-foreground';
const labelCls = 'flex flex-col gap-1.5 text-xs font-medium text-foreground';
const selectCls =
  'h-8.5 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-[13px] text-foreground shadow-xs/5 outline-none transition-shadow focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/32';
const textareaCls =
  'w-full min-w-0 rounded-lg border border-input bg-background px-3 py-2 text-[13px] leading-relaxed text-foreground shadow-xs/5 outline-none transition-shadow focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/32';
const submitWrapCls =
  '[&>button.primary]:inline-flex [&>button.primary]:h-8 [&>button.primary]:shrink-0 [&>button.primary]:cursor-pointer [&>button.primary]:items-center [&>button.primary]:justify-center [&>button.primary]:whitespace-nowrap [&>button.primary]:rounded-lg [&>button.primary]:border [&>button.primary]:border-primary [&>button.primary]:bg-primary [&>button.primary]:px-3.5 [&>button.primary]:text-xs [&>button.primary]:font-medium [&>button.primary]:text-primary-foreground [&>button.primary]:shadow-xs [&>button.primary]:transition-colors [&>button.primary]:hover:bg-primary/90 [&>button.primary]:focus-visible:outline-none [&>button.primary]:focus-visible:ring-2 [&>button.primary]:focus-visible:ring-ring [&>button.primary]:disabled:pointer-events-none [&>button.primary]:disabled:opacity-55';

export function KnowledgeTrial({ overview, busy, perform }: KnowledgePanelProps) {
  const [channel, setChannel] = useState<Channel>('DIRECT_MESSAGE'),
    [message, setMessage] = useState('');
  const [persona, setPersona] = useState('current'),
    [comparison, setComparison] = useState('none');
  const [sourceIds, setSourceIds] = useState<string[]>([]),
    [consent, setConsent] = useState(false),
    [result, setResult] = useState<TrialResult | null>(null);
  const [submitted, setSubmitted] = useState('');
  const personas = [
    ...(overview.activePersona ? [overview.activePersona] : []),
    ...overview.personas.filter(
      value => value.id !== overview.activePersonaId && value.state !== 'INVALID',
    ),
  ];
  const selectableSources = overview.sources.filter(
    source => source.kind === 'KNOWLEDGE' || source.kind === 'MANUAL',
  );
  const id = (value: string) =>
    value === 'current' ? overview.activePersonaId : value === 'baseline' ? null : value;

  return (
    <div className="knowledge-trial flex flex-col gap-4">
      <div className="space-y-1">
        <h3 className="font-heading text-[14px] font-semibold text-foreground">
          先试聊，再用于日常回复
        </h3>
        <p className={hintCls}>
          此处只生成模拟回复，不操作网页、不创建发送意图。每个所选人格单独调用一次模型；对比将计入两次模型额度。
        </p>
      </div>

      <form
        className="flex flex-col gap-3.5 rounded-xl border border-border/80 bg-background p-4"
        onSubmit={event => {
          event.preventDefault();
          if (!message.trim() || !consent || busy) return;
          const text = message;
          void perform<TrialResult>(
            '生成试聊回复',
            {
              action: 'tryReply',
              channel,
              message: text,
              sourceIds,
              personaVersionId: id(persona),
              ...(comparison !== 'none' ? { comparePersonaVersionId: id(comparison) } : {}),
              confirmed: true,
            },
            value => {
              setResult(value);
              setSubmitted(text);
            },
            false,
          );
        }}
      >
        <div className="knowledge-fields grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className={labelCls}>
            模拟通道
            <select
              className={selectCls}
              aria-label="模拟通道"
              value={channel}
              disabled={busy}
              onChange={event => setChannel(event.target.value as Channel)}
            >
              <option value="DIRECT_MESSAGE">私信</option>
              <option value="COMMENT_NOTIFICATION">评论</option>
            </select>
          </label>
          <label className={labelCls}>
            本次人格
            <select
              className={selectCls}
              aria-label="本次人格"
              value={persona}
              disabled={busy}
              onChange={event => setPersona(event.target.value)}
            >
              <option value="current">当前已发布人格</option>
              <option value="baseline">仅现有账号人设</option>
              {personas.map(value => (
                <option key={value.id} value={value.id}>
                  {formatDate(value.createdAt)} · {value.state === 'DRAFT' ? '草稿' : '已保存版本'}
                </option>
              ))}
            </select>
          </label>
          <label className={labelCls}>
            对比人格
            <select
              className={selectCls}
              aria-label="对比人格"
              value={comparison}
              disabled={busy}
              onChange={event => setComparison(event.target.value)}
            >
              <option value="none">不对比</option>
              <option value="baseline">仅现有账号人设</option>
              <option value="current">当前已发布人格</option>
              {personas.map(value => (
                <option key={value.id} value={value.id}>
                  {formatDate(value.createdAt)} · {value.state === 'DRAFT' ? '草稿' : '已保存版本'}
                </option>
              ))}
            </select>
          </label>
        </div>

        <details className="rounded-xl border border-border/75 bg-muted/30 px-3.5 py-2.5 text-xs">
          <summary className="cursor-pointer font-medium text-foreground select-none">
            本次知识来源 · {sourceIds.length ? `指定 ${sourceIds.length} 个` : '全部已启用知识'}
          </summary>
          <div className="mt-2.5 flex flex-col gap-2">
            <p className={hintCls}>
              未勾选时使用本账号全部已启用且当前有效的知识；指定来源仍只检索已启用条目。
            </p>
            {selectableSources.map(source => (
              <label
                className="check inline-flex cursor-pointer items-center gap-2 text-xs text-foreground select-none"
                key={source.id}
              >
                <input
                  type="checkbox"
                  className="size-4 cursor-pointer accent-primary"
                  checked={sourceIds.includes(source.id)}
                  disabled={busy}
                  onChange={event =>
                    setSourceIds(previous =>
                      event.target.checked
                        ? [...previous, source.id]
                        : previous.filter(value => value !== source.id),
                    )
                  }
                />
                {source.title}
              </label>
            ))}
          </div>
        </details>

        <label className={labelCls}>
          模拟来信
          <textarea
            className={textareaCls}
            aria-label="模拟来信"
            rows={4}
            maxLength={4000}
            value={message}
            disabled={busy}
            onChange={event => setMessage(event.target.value)}
          />
        </label>

        <label className="check inline-flex cursor-pointer items-start gap-2 text-xs text-foreground select-none">
          <input
            type="checkbox"
            className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary"
            checked={consent}
            disabled={busy}
            onChange={event => setConsent(event.target.checked)}
          />
          我同意将这条模拟来信、所选人格及必要知识和样本片段发送给当前模型，并计入已有模型额度。
        </label>

        <div className={submitWrapCls}>
          <button
            className="primary"
            type="submit"
            disabled={
              busy ||
              !message.trim() ||
              !consent ||
              (comparison !== 'none' && id(comparison) === id(persona))
            }
          >
            生成试聊回复{comparison !== 'none' ? '并对比' : ''}
          </button>
        </div>
        {comparison !== 'none' && id(comparison) === id(persona) && (
          <p className="hint text-xs text-warning-foreground">请选择两个不同的人格进行对比。</p>
        )}
      </form>

      {result && (
        <div className="knowledge-trial-result flex flex-col gap-3 rounded-xl border border-border/80 bg-background p-4">
          <div className="space-y-1">
            <h4 className="text-xs font-semibold text-muted-foreground">本次模拟来信</h4>
            <p className="knowledge-quote rounded-lg bg-muted/40 px-3 py-2 text-[13px] text-foreground">
              {submitted}
            </p>
          </div>
          <div
            className={`knowledge-trial-answers grid grid-cols-1 gap-3.5 ${
              result.comparison ? 'comparison md:grid-cols-2' : ''
            }`}
          >
            {(
              [
                ['本次人格回复', result.current],
                ['对比人格回复', result.comparison],
              ] as const
            ).map(
              ([title, value], idx) =>
                value && (
                  <article
                    key={title}
                    className={`flex flex-col gap-2 rounded-xl border p-4 ${
                      idx === 0
                        ? 'border-primary/25 bg-primary/[0.04]'
                        : 'border-border/80 bg-muted/30'
                    }`}
                  >
                    <h4 className="text-xs font-semibold text-foreground">{title}</h4>
                    <p className="knowledge-answer text-[13.5px] leading-relaxed text-foreground">
                      {value.text}
                    </p>
                    <p className={hintCls}>模型：{value.model} · 仅试聊，未发送</p>
                  </article>
                ),
            )}
          </div>
          {!!(result.current.knowledge ?? result.currentContext?.knowledge)?.length && (
            <details className="rounded-lg border border-border/75 bg-muted/30 px-3 py-2 text-xs">
              <summary className="cursor-pointer font-medium text-foreground select-none">
                本次引用知识
              </summary>
              <div className="mt-2 flex flex-col gap-1 text-muted-foreground">
                {(result.current.knowledge ?? result.currentContext?.knowledge ?? []).map(value => (
                  <p key={value.id}>
                    {value.title} · v{value.version}
                  </p>
                ))}
              </div>
            </details>
          )}
          {!!(result.current.conflicts ?? result.currentContext?.conflicts)?.length && (
            <p className="knowledge-warning rounded-lg border border-warning/35 bg-warning/8 px-3 py-2 text-xs text-warning-foreground">
              检索到知识冲突，请检查来源后再用于正式回复。
            </p>
          )}
        </div>
      )}
    </div>
  );
}
