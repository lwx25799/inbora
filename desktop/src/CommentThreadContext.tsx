import { useEffect, useRef, useState } from 'react';
import { request, type Thread } from './api';
import { time } from './presentation';
import { MessageText } from './MessageText';
import { cn } from './lib/utils';

type Context = NonNullable<Thread['commentContext']>;
type Item = Context['items'][number];
const order = (a: Item, b: Item) =>
  Number(b.isRoot) - Number(a.isRoot) ||
  (Date.parse(a.occurredAt ?? '') || 0) - (Date.parse(b.occurredAt ?? '') || 0) ||
  a.id.localeCompare(b.id);

const AVATAR_TONES = [
  'bg-[#e6efe9] text-[#174f43] dark:bg-[#1e3630] dark:text-[#8fd9c9]',
  'bg-[#f3eae0] text-[#7c4b1e] dark:bg-[#382b1e] dark:text-[#e8bf8c]',
  'bg-[#e7ecf4] text-[#284c78] dark:bg-[#202d3d] dark:text-[#98c1f0]',
  'bg-[#f2e7e7] text-[#7d3330] dark:bg-[#382222] dark:text-[#eba29e]',
  'bg-[#ecebe4] text-[#4c4d3a] dark:bg-[#2c2d25] dark:text-[#cbcbb6]',
] as const;

function avatarTone(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[hash % AVATAR_TONES.length]!;
}

function avatarInitial(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  return trimmed ? [...trimmed][0]! : '客';
}

export function CommentThreadContext({ thread, choose }: { thread: Thread; choose: (id: string) => void }) {
  const context = thread.commentContext;
  const key = `${thread.event.id}:${context?.projectionRevision ?? ''}`;
  const [view, setView] = useState({ key, context });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const current = useRef(key);
  current.current = key;

  useEffect(() => {
    setView({ key, context });
    setLoading(false);
    setError('');
  }, [key]);

  const shown = view.key === key ? view.context : context;
  if (!shown) {
    return (
      <p className="hint rounded-xl border border-dashed border-border bg-muted/35 px-4 py-3 text-xs text-muted-foreground">
        正在收取从一级根评论开始的上下文。
      </p>
    );
  }

  async function older() {
    if (!shown?.before || loading) return;
    const expected = key;
    setLoading(true);
    setError('');
    try {
      const result = await request<Thread>({
        command: 'getThread',
        eventId: thread.event.id,
        timelineBefore: shown.before,
      });
      if (current.current !== expected || result.event.id !== thread.event.id || !result.commentContext) return;
      const next = result.commentContext;
      setView(prior => {
        const retained =
          prior.key === expected && prior.context?.projectionRevision === next.projectionRevision
            ? prior.context.items
            : [];
        const items = new Map(retained.map(item => [item.id, item]));
        for (const item of next.items) items.set(item.id, item);
        return { key: expected, context: { ...next, items: [...items.values()].sort(order) } };
      });
    } catch {
      if (current.current === expected) setError('较早的评论暂未读取，请稍后再试。');
    } finally {
      if (current.current === expected) setLoading(false);
    }
  }

  return (
    <section
      className="original space-y-3 rounded-2xl border border-border/80 bg-card/75 p-4 shadow-xs/5"
      aria-label="评论完整上下文"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-heading text-xs font-semibold text-foreground">评论对话</h3>
        <span className="text-[11px] text-muted-foreground tabular-nums">{shown.items.length} 条记录</span>
      </div>

      {(shown.rootMissing || !shown.rootVerified || shown.rootAmbiguous) && (
        <p className="hint rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
          一级根评论尚未完整收取，后台正在补齐；AI 暂不生成脱离根评论的回复。
        </p>
      )}

      <div className="space-y-2.5">
        {shown.items.map(message => {
          const isOutgoing = message.direction === 'OUTGOING';
          const isTarget =
            message.direction === 'INCOMING' && message.payload.commentId === thread.event.payload.commentId;
          const speaker = message.payload.actorName || '对方';
          return (
            <article
              key={message.id}
              className={cn(
                'rounded-xl border px-3.5 py-3 transition-colors',
                !message.isRoot && 'ml-5 max-[1050px]:ml-3',
                isOutgoing && 'outgoing',
                isTarget
                  ? 'border-primary/45 bg-card shadow-xs ring-1 ring-primary/15'
                  : isOutgoing
                    ? 'border-primary/25 bg-primary/[0.045]'
                    : 'border-border/80 bg-card/90',
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold ring-1 ring-black/6 dark:ring-white/10',
                    isOutgoing
                      ? 'bg-primary/14 text-primary dark:bg-primary/24'
                      : avatarTone(speaker),
                  )}
                >
                  {isOutgoing ? '我' : avatarInitial(speaker)}
                </span>
                <small className="text-[11.5px] text-muted-foreground tabular-nums">
                  {message.isRoot ? '一级根评论' : isOutgoing ? '我方已回复' : speaker}
                  {isTarget ? ' · 当前回复目标' : ''} · {time(message.occurredAt)}
                </small>
              </div>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-foreground whitespace-pre-wrap [overflow-wrap:anywhere]">
                <MessageText text={message.text} />
              </p>
              {message.direction === 'INCOMING' && !message.historical && message.eventId !== thread.event.id && (
                <button
                  type="button"
                  onClick={() => choose(message.eventId)}
                  className="mt-2 inline-flex h-6.5 cursor-pointer items-center justify-center rounded-md border border-input bg-card px-2.5 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-input/32"
                >
                  查看这条评论
                </button>
              )}
            </article>
          );
        })}

        {!shown.items.some(
          item => item.direction === 'INCOMING' && item.payload.commentId === thread.event.payload.commentId,
        ) && (
          <article className="rounded-xl border border-primary/45 bg-card px-3.5 py-3 shadow-xs ring-1 ring-primary/15">
            <small className="text-[11.5px] text-muted-foreground tabular-nums">
              当前回复目标 · {thread.event.payload.actorName || '对方'} · {time(thread.event.payload.occurredAt)}
            </small>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-foreground whitespace-pre-wrap [overflow-wrap:anywhere]">
              <MessageText text={thread.event.payload.text} />
            </p>
          </article>
        )}
      </div>

      {shown.hasMore && (
        <button
          type="button"
          disabled={loading}
          onClick={() => void older()}
          className="inline-flex h-7 cursor-pointer items-center justify-center rounded-md border border-input bg-card px-3 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55 dark:bg-input/32"
        >
          {loading ? '正在加载较早回复' : '加载较早回复'}
        </button>
      )}
      {error && (
        <p role="status" className="hint text-xs text-warning-foreground">
          {error}
        </p>
      )}
    </section>
  );
}
