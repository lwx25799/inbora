import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { request, reasons, type ReplyStatus, type Thread, type TimelineItem } from './api';
import { time, replyStatusLabel } from './presentation';
import { ReplyComposer } from './ReplyComposer';
import { MessageAttachments, isMediaPlaceholder } from './MessageAttachments';
import { ShareLink, validShare } from './ShareLink';
import { MessageText } from './MessageText';
import type { ReplyViewProps } from './reply-view-types';
import { cn } from './lib/utils';

type Timeline = NonNullable<Thread['timeline']>;
const empty: Timeline = { items: [], pageSize: 30, hasMore: false, before: null };

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

function headerBadgeClass(replyStatus: ReplyStatus): string {
  if (replyStatus === 'REPLIED') {
    return 'badge inline-flex h-5.5 shrink-0 items-center rounded-md bg-success/10 px-2 text-xs font-medium whitespace-nowrap text-success-foreground dark:bg-success/16';
  }
  if (replyStatus === 'MANUAL_ONLY') {
    return 'badge inline-flex h-5.5 shrink-0 items-center rounded-md bg-warning/12 px-2 text-xs font-medium whitespace-nowrap text-warning-foreground dark:bg-warning/18';
  }
  if (replyStatus === 'NOT_REQUIRED') {
    return 'badge inline-flex h-5.5 shrink-0 items-center rounded-md bg-secondary px-2 text-xs font-medium whitespace-nowrap text-secondary-foreground';
  }
  return 'badge inline-flex h-5.5 shrink-0 items-center rounded-md bg-primary/10 px-2 text-xs font-medium whitespace-nowrap text-primary dark:bg-primary/18';
}

const imageReplacesPlaceholder = (message: TimelineItem) =>
  message.observationIssue === 'DM_CONTENT_UNVERIFIED' &&
  message.contentType &&
  isMediaPlaceholder(message.text, message.contentType) &&
  (!!validShare(message.share) || message.attachments.length > 0);

const compare = (a: TimelineItem, b: TimelineItem) =>
  (Date.parse(a.occurredAt ?? '') || 0) - (Date.parse(b.occurredAt ?? '') || 0) || a.id.localeCompare(b.id);

function merge(prior: TimelineItem[], next: TimelineItem[]) {
  const incoming = new Map(next.map(item => [item.id, item]));
  const retained = prior.map(item => incoming.get(item.id) ?? item);
  const seen = new Set(prior.map(item => item.id));
  const additions = next.filter(item => !seen.has(item.id));
  return [...retained, ...additions].sort(compare);
}

function MessageView({ eventId, outgoing }: { eventId: string; outgoing: boolean }) {
  const [opening, setOpening] = useState(false);
  const [feedback, setFeedback] = useState('');
  const pending = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function open() {
    if (pending.current) return;
    pending.current = true;
    setOpening(true);
    setFeedback('');
    try {
      const result = await request<{ opened: boolean; located: boolean }>({
        command: 'openTarget',
        eventId,
        visible: true,
      });
      if (result?.opened !== true || typeof result.located !== 'boolean') {
        throw Error('VISIBLE_MESSAGE_NOT_OPENED');
      }
      if (alive.current) setFeedback('已在浏览器打开会话');
    } catch {
      if (alive.current) setFeedback('暂时无法打开这条消息，请稍后再试');
    } finally {
      pending.current = false;
      if (alive.current) setOpening(false);
    }
  }

  return (
    <div className="message-view mt-2 flex flex-wrap items-center gap-2">
      <button
        type="button"
        aria-label="查看这条消息"
        disabled={opening}
        onClick={event => {
          event.stopPropagation();
          void open();
        }}
        className="inline-flex h-6.5 shrink-0 cursor-pointer items-center justify-center rounded-md border border-input bg-card px-2 text-[11.5px] font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55 dark:bg-input/32 dark:hover:bg-input/55"
      >
        {opening ? '正在打开…' : '查看这条消息'}
      </button>
      {feedback && (
        <small
          role="status"
          className={cn('text-[11px]', outgoing ? 'text-primary-foreground/85' : 'text-muted-foreground')}
        >
          {feedback}
        </small>
      )}
    </div>
  );
}

export function DirectMessageChat(props: ReplyViewProps & { thread: Thread }) {
  const { thread, status } = props;
  const group = thread.groupKey ?? JSON.stringify([thread.event.payload.accountId, thread.event.payload.conversationId]);
  const revision = `${group}:${thread.timeline?.projectionRevision ?? ''}:${thread.frozen}:${thread.verification?.verified ?? ''}`;
  const [view, setView] = useState({ key: revision, timeline: thread.timeline ?? empty, expanded: false });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const current = useRef({ group, eventId: thread.event.id });
  current.current = { group, eventId: thread.event.id };
  const scroll = useRef<HTMLDivElement | null>(null);
  const nearBottom = useRef(true);
  const olderHeight = useRef<number | null>(null);
  const visible = view.key === revision ? view.timeline : thread.timeline ?? empty;
  if (view.key !== revision) {
    nearBottom.current = true;
    olderHeight.current = null;
  }

  useEffect(() => {
    const latest = thread.timeline ?? empty;
    setView(prior => {
      if (prior.key !== revision) return { key: revision, timeline: latest, expanded: false };
      const oldest = latest.items[0];
      const older =
        prior.expanded && latest.hasMore && oldest
          ? prior.timeline.items.filter(item => compare(item, oldest) < 0)
          : [];
      return {
        ...prior,
        timeline: {
          ...latest,
          items: merge(older, latest.items),
          before: prior.expanded ? prior.timeline.before : latest.before,
          hasMore: prior.expanded ? prior.timeline.hasMore : latest.hasMore,
        },
      };
    });
    setError('');
    setLoading(false);
  }, [revision, thread.timeline]);

  useLayoutEffect(() => {
    const container = scroll.current;
    if (!container) return;
    if (olderHeight.current !== null) {
      container.scrollTop += container.scrollHeight - olderHeight.current;
      olderHeight.current = null;
    } else if (nearBottom.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [visible.items]);

  async function loadOlder() {
    if (loading || !visible.before) return;
    const expected = { ...current.current };
    const before = visible.before;
    setLoading(true);
    setError('');
    try {
      const next = await request<Thread>({ command: 'getThread', eventId: expected.eventId, timelineBefore: before });
      if (current.current.group !== expected.group || current.current.eventId !== expected.eventId || !next.timeline) {
        return;
      }
      olderHeight.current = scroll.current?.scrollHeight ?? null;
      setView(prior =>
        prior.key === revision
          ? { key: revision, expanded: true, timeline: { ...next.timeline!, items: merge(prior.timeline.items, next.timeline!.items) } }
          : prior,
      );
    } catch {
      if (current.current.group === expected.group) setError('更早消息暂未读取完成，请稍后重试。');
    } finally {
      if (current.current.group === expected.group) setLoading(false);
    }
  }

  const actorName = thread.event.payload.actorName || '当前联系人';
  const headerReplyStatus: ReplyStatus = ['NOT_REQUIRED', 'MANUAL_ONLY'].includes(thread.replyStatus)
    ? thread.replyStatus
    : thread.conversationReplyStatus ?? thread.replyStatus;

  return (
    <section
      className="detail chat-detail flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
      aria-label="私信会话"
    >
      <header className="chat-heading shrink-0 space-y-2 border-b border-border/80 bg-card/80 px-5 py-3 max-[1050px]:px-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden="true"
              className={cn(
                'flex size-9 shrink-0 items-center justify-center rounded-xl text-sm font-semibold ring-1 ring-black/6 dark:ring-white/10',
                avatarTone(actorName),
              )}
            >
              {avatarInitial(actorName)}
            </span>
            <div className="min-w-0">
              <p className="eyebrow text-[11px] font-medium text-muted-foreground">私信会话</p>
              <h2 className="truncate font-heading text-[15px] font-semibold text-foreground">{actorName}</h2>
            </div>
          </div>
          <span className={headerBadgeClass(headerReplyStatus)}>{replyStatusLabel(headerReplyStatus)}</span>
        </div>

        <details className="chat-information text-xs text-muted-foreground">
          <summary className="w-fit cursor-pointer select-none text-[11.5px] text-muted-foreground transition-colors hover:text-foreground">
            会话信息
          </summary>
          <p className="mt-2 rounded-lg border border-border/75 bg-muted/45 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-foreground">
            本人：{status.account?.identity ?? '已绑定账号'}
            <br />
            对方：{thread.event.payload.actorId ?? '身份待核对'}
            <br />
            会话：{thread.event.payload.conversationId}
          </p>
        </details>
      </header>

      <div
        ref={scroll}
        className="chat-messages scroll min-h-0 flex-1 overflow-y-auto px-5 py-4 overscroll-contain max-[1050px]:px-4"
        style={{
          backgroundImage:
            'radial-gradient(color-mix(in srgb, var(--border) 68%, transparent) 1px, transparent 1px)',
          backgroundSize: '18px 18px',
        }}
        role="log"
        aria-label="私信消息流"
        aria-live="polite"
        onScroll={() => {
          const container = scroll.current;
          if (container) nearBottom.current = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
        }}
      >
        <div className="mx-auto flex w-full max-w-[740px] flex-col gap-3.5">
          {visible.hasMore && (
            <button
              type="button"
              className="load-earlier mx-auto inline-flex h-7 cursor-pointer items-center justify-center rounded-full border border-input bg-card px-3.5 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55"
              disabled={loading}
              onClick={() => void loadOlder()}
            >
              {loading ? '正在读取更早消息' : '加载更早消息'}
            </button>
          )}

          {error && (
            <p
              role="alert"
              className="hint rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive-foreground"
            >
              {error}
            </p>
          )}

          {!visible.items.length &&
            (loading || !thread.timeline ? (
              <p className="empty py-10 text-center text-xs text-muted-foreground">正在读取会话消息…</p>
            ) : (
              <p className="empty py-10 text-center text-xs text-muted-foreground">
                当前会话暂无可显示的消息记录。
              </p>
            ))}

          {visible.items.map(message => {
            const outgoing = message.direction === 'OUTGOING';
            const share = validShare(message.share);
            return (
              <article
                key={message.id}
                className={cn(
                  'chat-message flex items-start gap-2.5',
                  outgoing ? 'outgoing flex-row-reverse' : 'incoming flex-row',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'mt-5 flex size-8 shrink-0 items-center justify-center rounded-xl text-xs font-semibold ring-1 ring-black/6 dark:ring-white/10',
                    outgoing
                      ? 'bg-primary/14 text-primary dark:bg-primary/24 dark:text-primary'
                      : avatarTone(actorName),
                  )}
                >
                  {outgoing ? '我' : avatarInitial(actorName)}
                </span>

                <div
                  className={cn(
                    'flex min-w-0 max-w-[82%] flex-col gap-1 max-[1050px]:max-w-[88%]',
                    outgoing ? 'items-end' : 'items-start',
                  )}
                >
                  <small className="px-1 text-[11px] text-muted-foreground tabular-nums">
                    {outgoing ? (message.origin === 'CONFIRMED' ? '我方已回复' : '我方消息') : '对方'} ·{' '}
                    {time(message.occurredAt)}
                    {message.historical ? ' · 历史消息' : ''}
                    {message.direction === 'INCOMING' && message.eventId === thread.event.id
                      ? ['NOT_REQUIRED', 'MANUAL_ONLY'].includes(thread.replyStatus)
                        ? ' · 当前查看消息'
                        : ' · 当前回复消息'
                      : ''}
                  </small>

                  <div
                    className={cn(
                      'message-bubble rounded-2xl px-4 py-2.5 text-[13.5px] leading-relaxed',
                      outgoing
                        ? 'rounded-tr-sm bg-primary text-primary-foreground shadow-xs'
                        : 'rounded-tl-sm border border-border/85 bg-card text-foreground shadow-xs/10',
                    )}
                  >
                    {(!!message.displayText || !imageReplacesPlaceholder(message)) && (
                      <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                        <MessageText text={message.displayText ?? message.text} />
                      </p>
                    )}

                    {share ? (
                      <ShareLink key={share.url} share={share} />
                    ) : (
                      <MessageAttachments message={message} />
                    )}

                    {message.observationIssue && (
                      <p
                        className={cn(
                          'message-quality mt-1.5 text-[11.5px]',
                          outgoing ? 'text-primary-foreground/85' : 'text-muted-foreground',
                        )}
                      >
                        {share
                          ? '分享内容无需自动回复，可按需人工回复'
                          : message.displayText
                            ? '此消息的其他内容仍需人工查看，暂不自动回复'
                            : reasons[message.observationIssue] ?? '此消息需人工查看'}
                      </p>
                    )}

                    {message.origin === 'OBSERVED' &&
                      message.observationIssue === 'DM_CONTENT_UNVERIFIED' &&
                      ['IMAGE', 'MIXED', 'VIDEO', 'AUDIO'].includes(message.contentType ?? '') &&
                      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(message.eventId) && (
                        <MessageView
                          key={group + ':' + thread.event.id + ':' + message.id}
                          eventId={message.eventId}
                          outgoing={outgoing}
                        />
                      )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </div>

      <div className="max-h-[58%] shrink-0 overflow-y-auto border-t border-border/80 bg-card/90 px-5 py-3 max-[1050px]:px-4">
        <div className="mx-auto w-full max-w-[740px]">
          <ReplyComposer {...props} />
        </div>
      </div>
    </section>
  );
}
