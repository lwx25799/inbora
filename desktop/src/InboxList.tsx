import type { Inbox } from './api';
import { time, replyStatusLabel } from './presentation';
import { MessageAttachments, isMediaPlaceholder } from './MessageAttachments';
import { validShare, sharedWorkLabel } from './ShareLink';
import { MessageText } from './MessageText';
import { cn } from './lib/utils';

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

function statusBadgeClass(replyStatus: Inbox['items'][number]['replyStatus'], status: string): string {
  const isWarn = replyStatus === 'WAITING' && ['UNCERTAIN', 'MANUAL_REVIEW'].includes(status);
  if (isWarn) {
    return 'badge warn inline-flex h-5 shrink-0 items-center rounded-md bg-warning/14 px-1.5 text-[10.5px] font-medium whitespace-nowrap text-warning-foreground dark:bg-warning/20';
  }
  if (replyStatus === 'REPLIED') {
    return 'badge inline-flex h-5 shrink-0 items-center rounded-md bg-success/10 px-1.5 text-[10.5px] font-medium whitespace-nowrap text-success-foreground dark:bg-success/16';
  }
  if (replyStatus === 'MANUAL_ONLY') {
    return 'badge inline-flex h-5 shrink-0 items-center rounded-md bg-warning/12 px-1.5 text-[10.5px] font-medium whitespace-nowrap text-warning-foreground dark:bg-warning/18';
  }
  if (replyStatus === 'NOT_REQUIRED') {
    return 'badge inline-flex h-5 shrink-0 items-center rounded-md bg-secondary px-1.5 text-[10.5px] font-medium whitespace-nowrap text-secondary-foreground';
  }
  return 'badge inline-flex h-5 shrink-0 items-center rounded-md bg-primary/10 px-1.5 text-[10.5px] font-medium whitespace-nowrap text-primary dark:bg-primary/18';
}

interface InboxListProps {
  inbox: Inbox;
  selected: string | null;
  selectedGroup?: string;
  channel: 'ALL' | 'COMMENT_NOTIFICATION' | 'DIRECT_MESSAGE';
  setChannel: (channel: InboxListProps['channel']) => void;
  filter: 'ALL' | 'UNREAD' | 'PENDING' | 'MANUAL_ONLY' | 'CONFIRMED';
  setFilter: (filter: 'ALL' | 'UNREAD' | 'PENDING' | 'MANUAL_ONLY' | 'CONFIRMED') => void;
  pageNumber: number;
  setPageNumber: (page: number) => void;
  choose: (id: string) => void;
  markRead: () => void;
  markingRead: boolean;
}

export function InboxList({
  inbox,
  selected,
  selectedGroup,
  channel,
  setChannel,
  filter,
  setFilter,
  pageNumber,
  setPageNumber,
  choose,
  markRead,
  markingRead,
}: InboxListProps) {
  return (
    <section className="inbox-list flex h-full min-h-0 w-[304px] max-w-full shrink-0 flex-col border-r border-border bg-muted/30 max-[1050px]:w-[256px]">
      <div className="filters space-y-2.5 border-b border-border/80 bg-card/65 px-3.5 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <h2 className="truncate font-heading text-[14px] font-semibold text-foreground">会话队列</h2>
            <small className="shrink-0 rounded-md bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground tabular-nums">
              {inbox.total} 个会话与评论
            </small>
          </div>
          <span className="inline-flex shrink-0 [&>button]:inline-flex [&>button]:h-7 [&>button]:cursor-pointer [&>button]:items-center [&>button]:justify-center [&>button]:rounded-md [&>button]:border [&>button]:border-input [&>button]:bg-card [&>button]:px-2.5 [&>button]:text-xs [&>button]:font-medium [&>button]:text-foreground [&>button]:shadow-xs/5 [&>button]:transition-colors [&>button]:hover:bg-accent [&>button]:focus-visible:outline-none [&>button]:focus-visible:ring-2 [&>button]:focus-visible:ring-ring [&>button]:disabled:pointer-events-none [&>button]:disabled:opacity-50 dark:[&>button]:bg-input/32 dark:[&>button]:hover:bg-input/55">
            <button disabled={markingRead} onClick={markRead} title="将当前账号已收取的私信和评论全部标为已读">全部已读</button>
          </span>
        </div>

        <div className="segments flex items-center gap-0.5 rounded-lg bg-muted p-0.5" aria-label="通道筛选">
          {(['ALL', 'COMMENT_NOTIFICATION', 'DIRECT_MESSAGE'] as const).map(value => (
            <button
              key={value}
              type="button"
              data-channel={value}
              className={cn(
                'flex-1 cursor-pointer rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                value === channel
                  ? 'active bg-card text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={() => {
                setChannel(value);
                setPageNumber(0);
              }}
            >
              {value === 'ALL' ? '全部' : value === 'DIRECT_MESSAGE' ? '私信' : '评论'}
            </button>
          ))}
        </div>

        <select
          aria-label="任务状态"
          value={filter}
          onChange={event => {
            setFilter(event.target.value as typeof filter);
            setPageNumber(0);
          }}
          className="h-8 w-full rounded-lg border border-input bg-card px-2.5 text-xs font-medium text-foreground shadow-xs/5 outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 dark:bg-input/32"
        >
          <option value="UNREAD">未读</option>
          <option value="PENDING">等待回复</option>
          <option value="MANUAL_ONLY">需人工查看</option>
          <option value="CONFIRMED">已回复</option>
          <option value="ALL">全部消息</option>
        </select>
      </div>

      <div className="task-list scroll flex-1 space-y-1.5 overflow-y-auto p-2.5 overscroll-contain">
        {inbox.items.map(item => {
          const active = selected === item.id || (!!selectedGroup && item.groupKey === selectedGroup);
          const share = validShare(item.share);
          const attachmentPreview = !share && item.previewEventId && item.attachments?.length;
          const displayName = item.author || '当前联系人';
          const isDm = item.channel === 'DIRECT_MESSAGE';
          return (
            <button
              key={item.groupKey ?? item.id}
              type="button"
              data-channel={item.channel}
              className={cn(
                'task relative flex w-full cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                active
                  ? 'selected border-primary/35 bg-card shadow-xs ring-1 ring-primary/15 before:absolute before:top-2.5 before:bottom-2.5 before:left-0 before:w-[3px] before:rounded-r-full before:bg-primary'
                  : 'border-transparent bg-card/55 hover:border-border/80 hover:bg-card',
              )}
              aria-pressed={active}
              onClick={() => {
                const target = item.resumeEventId ?? item.id;
                if (selected !== target) choose(target);
              }}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl text-xs font-semibold ring-1 ring-black/6 dark:ring-white/10',
                  avatarTone(displayName),
                )}
              >
                {avatarInitial(displayName)}
              </span>

              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-start justify-between gap-1.5">
                  <strong className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold text-foreground [overflow-wrap:anywhere]">
                    {item.unread && (
                      <span
                        className="unread-dot inline-block size-2 shrink-0 rounded-full bg-primary"
                        aria-label="未读"
                      />
                    )}
                    <span className="truncate">{displayName}</span>
                  </strong>
                  <span className={statusBadgeClass(item.replyStatus, item.status)}>
                    {replyStatusLabel(item.replyStatus)}
                  </span>
                </div>

                {!isDm && (item.commentCount ?? 0) > 0 && (
                  <small className="block text-[11px] text-muted-foreground tabular-nums">
                    评论串 · {item.commentCount} 条留言
                    {item.waitingCount ? ` · ${item.waitingCount} 条待回复` : ''}
                  </small>
                )}

                {(!!item.displayText || !attachmentPreview || !isMediaPlaceholder(item.preview)) && (
                  <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                    <MessageText
                      text={
                        (item.previewDirection === 'OUTGOING' ? '我：' : '') +
                        (item.displayText ?? (share ? `分享${sharedWorkLabel(share)} · ${share.url}` : item.preview))
                      }
                    />
                  </p>
                )}

                {attachmentPreview && item.previewEventId && item.attachments ? (
                  <MessageAttachments
                    allowRefresh={false}
                    message={{ eventId: item.previewEventId, attachments: item.attachments.slice(0, 1) }}
                  />
                ) : null}

                <small className="flex flex-wrap items-center gap-1 pt-0.5 text-[11px] text-muted-foreground tabular-nums">
                  <span
                    className={cn(
                      'channel-label inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold',
                      isDm
                        ? 'bg-info/10 text-info-foreground dark:bg-info/18'
                        : 'bg-warning/12 text-warning-foreground dark:bg-warning/18',
                    )}
                  >
                    {isDm ? '私信' : '评论'}
                  </span>
                  <span>· {time(item.time)}</span>
                  {isDm && item.messageCount ? <span>· {item.messageCount} 条入站</span> : null}
                </small>
              </div>
            </button>
          );
        })}

        {!inbox.items.length && (
          <div className="empty rounded-xl border border-dashed border-border/80 bg-card/50 px-4 py-8 text-center">
            <strong className="block text-xs font-semibold text-foreground">
              {filter === 'UNREAD' ? '当前没有未读消息' : '当前没有这类待办'}
            </strong>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
              后台按已启用范围自动收取，新消息会显示在对应会话。
            </p>
          </div>
        )}
      </div>

      <div className="pager flex shrink-0 items-center justify-between gap-2 border-t border-border/80 bg-card/65 px-3 py-2">
        <button
          type="button"
          disabled={pageNumber === 0}
          onClick={() => setPageNumber(pageNumber - 1)}
          className="inline-flex h-7 cursor-pointer items-center justify-center rounded-md border border-input bg-card px-2.5 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 dark:bg-input/32"
        >
          上一页
        </button>
        <span className="text-xs font-medium text-muted-foreground tabular-nums">{pageNumber + 1}</span>
        <button
          type="button"
          disabled={(pageNumber + 1) * inbox.pageSize >= inbox.total}
          onClick={() => setPageNumber(pageNumber + 1)}
          className="inline-flex h-7 cursor-pointer items-center justify-center rounded-md border border-input bg-card px-2.5 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 dark:bg-input/32"
        >
          下一页
        </button>
      </div>
    </section>
  );
}
