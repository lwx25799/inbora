import { reasons, sourceNames, type ReplyStatus } from './api';
import { time, replyStatusLabel } from './presentation';
import { ReplyComposer } from './ReplyComposer';
import { DirectMessageChat } from './DirectMessageChat';
import { CommentThreadContext } from './CommentThreadContext';
import { MessageText } from './MessageText';
import { BrandTile } from './components/BrandLogo';
import { completedReply, hasSubmittedReply, submittedReplyText } from './reply-editor-draft';
import { replyResultPresentation } from './reply-result-presentation';
import type { ReplyViewProps } from './reply-view-types';
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

function commentBadgeClass(replyStatus: ReplyStatus): string {
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

export function ReplyDetail(props: ReplyViewProps) {
  const { detailElement, dialogElement, thread, status, selected, act, openDialog, closeDialog } = props;
  if (thread?.event.payload.channel === 'DIRECT_MESSAGE') {
    return <DirectMessageChat {...props} thread={thread} />;
  }
  const unresolved = !!thread && hasSubmittedReply(thread) && !completedReply(thread);
  const replyAction = unresolved ? '查看回复详情' : '打开人工回复';
  const actorName = thread?.event.payload.actorName || '当前联系人';

  return (
    <section
      ref={detailElement}
      className="detail scroll flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-background px-6 py-5 overscroll-contain max-[1050px]:px-4 max-[1050px]:py-4"
      aria-label="消息详情"
      data-channel="COMMENT_NOTIFICATION"
    >
      {!thread ? (
        <div className="empty detail-empty mx-auto flex max-w-md flex-col items-center justify-center py-20 text-center">
          <span className="detail-mark mb-4 inline-flex">
            <BrandTile size={44} />
          </span>
          <h2 className="font-heading text-base font-semibold text-foreground">
            {selected ? '正在读取准确目标' : '从左侧选择一条会话或评论'}
          </h2>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            选择会话即可查看消息并回复，评论保留准确父评论关系。
          </p>
        </div>
      ) : (
        <>
          <header className="detail-heading mx-auto flex w-full max-w-[780px] flex-wrap items-start justify-between gap-3 rounded-2xl border border-border/80 bg-card px-5 py-4 shadow-xs/5">
            <div className="flex min-w-0 items-center gap-3">
              <span
                aria-hidden="true"
                className={cn(
                  'flex size-10 shrink-0 items-center justify-center rounded-xl text-sm font-semibold ring-1 ring-black/6 dark:ring-white/10',
                  avatarTone(actorName),
                )}
              >
                {avatarInitial(actorName)}
              </span>
              <div className="min-w-0">
                <p className="eyebrow text-[11.5px] font-medium text-warning-foreground">
                  {thread.event.payload.kind === 'REPLY' ? '楼中楼评论' : '作品评论'} ·{' '}
                  {sourceNames[thread.event.payload.discovery ?? 'NOTIFICATION']}
                </p>
                <h2 className="mt-0.5 truncate font-heading text-base font-semibold text-warning-foreground">{actorName}</h2>
              </div>
            </div>
            <span className={commentBadgeClass(thread.replyStatus)}>{replyStatusLabel(thread.replyStatus)}</span>
          </header>

          <details
            key={thread.event.id}
            className="identity mx-auto w-full max-w-[780px] rounded-xl border border-border/80 bg-muted/40 px-4 py-2.5 text-xs text-foreground"
          >
            <summary className="cursor-pointer select-none font-medium text-muted-foreground transition-colors hover:text-foreground">
              消息信息
            </summary>
            <dl className="mt-3 grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t border-border/70 pt-3">
              <dt className="text-muted-foreground">本人账号</dt>
              <dd className="font-mono text-[11.5px] [overflow-wrap:anywhere]">
                {status.account?.identity ?? '未绑定'}
              </dd>
              <dt className="text-muted-foreground">对方账号</dt>
              <dd className="font-mono text-[11.5px] [overflow-wrap:anywhere]">
                {thread.event.payload.actorId ?? '未取得稳定标识'}
              </dd>
              <dt className="text-muted-foreground">作品</dt>
              <dd className="font-mono text-[11.5px] [overflow-wrap:anywhere]">
                {thread.event.payload.videoId ?? '未取得'}
              </dd>
              {thread.workUrl && (
                <>
                  <dt className="text-muted-foreground">作品链接</dt>
                  <dd className="font-mono text-[11.5px] [overflow-wrap:anywhere]">{thread.workUrl}</dd>
                </>
              )}
              <dt className="text-muted-foreground">
                {thread.event.payload.kind === 'REPLY' ? '当前子评论' : '原父评论'}
              </dt>
              <dd className="font-mono text-[11.5px] [overflow-wrap:anywhere]">
                {thread.event.payload.commentId ?? '未取得'}
              </dd>
              {thread.event.payload.kind === 'REPLY' && (
                <>
                  <dt className="text-muted-foreground">所属根评论</dt>
                  <dd className="font-mono text-[11.5px] [overflow-wrap:anywhere]">
                    {thread.event.payload.rootCommentId ?? '后台正在核对层级'}
                  </dd>
                </>
              )}
              <dt className="text-muted-foreground">回复关系</dt>
              <dd className="text-foreground">
                {thread.event.payload.kind === 'REPLY'
                  ? '只回复当前子评论，保留所属根评论关系'
                  : '只回复此父评论，不在作品下另发顶层评论'}
              </dd>
              <dt className="text-muted-foreground">原事件</dt>
              <dd className="font-mono text-[11.5px] [overflow-wrap:anywhere]">
                {thread.event.payload.platformEventId ?? '未取得'}
              </dd>
            </dl>
          </details>

          {thread.commentContext ? (
            <div className="mx-auto w-full max-w-[780px]">
              <CommentThreadContext thread={thread} choose={props.choose} />
            </div>
          ) : (
            <section className="original mx-auto w-full max-w-[780px] rounded-2xl border border-border/80 bg-card p-4 shadow-xs/5">
              <h3 className="font-heading text-xs font-semibold text-muted-foreground">原父评论</h3>
              <p className="mt-2 text-[14px] leading-relaxed text-foreground whitespace-pre-wrap [overflow-wrap:anywhere]">
                <MessageText text={thread.event.payload.text} />
              </p>
              {thread.event.payload.observationIssue && (
                <p className="hint mt-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-1.5 text-xs text-warning-foreground">
                  {reasons[thread.event.payload.observationIssue] ?? thread.event.payload.observationIssue}
                </p>
              )}
              <small className="mt-2 block text-[11.5px] text-muted-foreground tabular-nums">
                {time(thread.event.payload.occurredAt)}
              </small>
            </section>
          )}

          {!thread.commentContext && !!thread.timeline?.items.some(message => message.direction === 'OUTGOING') && (
            <section
              className="original mx-auto w-full max-w-[780px] space-y-2.5 rounded-2xl border border-primary/25 bg-primary/[0.045] p-4"
              aria-label="我的回复"
            >
              <h3 className="font-heading text-xs font-semibold text-primary">我的回复</h3>
              {thread.timeline.items
                .filter(message => message.direction === 'OUTGOING')
                .map(message => (
                  <article key={message.id} className="rounded-xl border border-border/75 bg-card px-3.5 py-2.5">
                    <p className="text-[13.5px] leading-relaxed text-foreground whitespace-pre-wrap [overflow-wrap:anywhere]">
                      <MessageText text={message.text} />
                    </p>
                    <small className="mt-1 block text-[11px] text-success-foreground tabular-nums">
                      已回复 · {time(message.occurredAt)}
                    </small>
                  </article>
                ))}
            </section>
          )}

          {unresolved && (
            <section
              className="original mx-auto w-full max-w-[780px] rounded-2xl border border-warning/35 bg-warning/10 p-4 text-foreground"
              aria-label="回复结果待确认"
            >
              <h3 className="font-heading text-xs font-semibold text-warning-foreground">回复结果待确认</h3>
              <p className="mt-2 text-[13.5px] leading-relaxed text-foreground whitespace-pre-wrap [overflow-wrap:anywhere]">
                <MessageText text={submittedReplyText(thread)} />
              </p>
              <p className="hint mt-2 text-xs text-muted-foreground">{replyResultPresentation(thread, props.send).detail}</p>
            </section>
          )}

          {!thread.commentContext && thread.history.length > 0 && (
            <details className="history mx-auto w-full max-w-[780px] rounded-xl border border-border/80 bg-card/70 px-4 py-3 text-xs">
              <summary className="cursor-pointer select-none font-medium text-muted-foreground transition-colors hover:text-foreground tabular-nums">
                历史对话记录 · {thread.history.length} 条
              </summary>
              <div className="mt-3 space-y-2">
                {thread.history.map((message, index) => (
                  <article
                    key={index}
                    className={cn(
                      'rounded-xl border px-3.5 py-2.5',
                      message.direction === 'OUTGOING'
                        ? 'outgoing border-primary/25 bg-primary/[0.045]'
                        : 'border-border/80 bg-muted/40',
                    )}
                  >
                    <small className="text-[11px] text-muted-foreground tabular-nums">
                      {message.direction === 'OUTGOING' ? '我方回复' : '对方留言'} · {time(message.occurredAt)}
                    </small>
                    <p className="mt-1 text-[13px] leading-relaxed text-foreground whitespace-pre-wrap [overflow-wrap:anywhere]">
                      <MessageText text={message.text} />
                    </p>
                  </article>
                ))}
              </div>
            </details>
          )}

          <div className="mx-auto flex w-full max-w-[780px] items-center gap-3 pt-1">
            <button
              type="button"
              className="primary inline-flex h-9 cursor-pointer items-center justify-center rounded-lg border border-primary bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs shadow-primary/20 transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              onClick={() => void act(replyAction, openDialog)}
            >
              {replyAction}
            </button>
          </div>

          <dialog
            ref={dialogElement}
            className="human-dialog m-auto w-[min(760px,calc(100vw-48px))] max-h-[calc(100vh-48px)] overflow-y-auto rounded-2xl border border-border bg-card p-6 text-foreground shadow-2xl overscroll-contain backdrop:bg-black/55 backdrop:backdrop-blur-[2px] max-[1050px]:w-[calc(100vw-24px)] max-[1050px]:max-h-[calc(100vh-24px)] max-[1050px]:p-4"
            aria-label="人工回复对话框"
            onCancel={event => {
              event.preventDefault();
              void act('保存并关闭', closeDialog);
            }}
          >
            <div className="space-y-4">
              <div className="dialog-heading flex flex-wrap items-center justify-between gap-3 border-b border-border/80 pb-3">
                <h2 className="font-heading text-base font-semibold text-foreground">
                  回复 {thread.event.payload.actorName || '当前目标'}
                </h2>
                <button
                  type="button"
                  onClick={() => void act('保存并关闭', closeDialog)}
                  className="inline-flex h-7.5 cursor-pointer items-center justify-center rounded-lg border border-input bg-card px-3 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-input/32"
                >
                  关闭并保留草稿
                </button>
              </div>

              {!thread.ownership.isMine && !thread.intent && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-warning/30 bg-warning/8 px-3.5 py-2 text-xs text-warning-foreground">
                  <span>当前编辑权已释放，点击恢复后可继续输入并自动保存。</span>
                  <button
                    type="button"
                    onClick={() => void act('继续写回复', openDialog)}
                    className="inline-flex h-7 cursor-pointer items-center justify-center rounded-lg border border-input bg-card px-3 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-input/32"
                  >
                    继续写回复
                  </button>
                </div>
              )}

              <details className="identity rounded-xl border border-border/80 bg-muted/40 px-3.5 py-2.5 text-xs">
                <summary className="cursor-pointer select-none font-medium text-muted-foreground transition-colors hover:text-foreground">
                  会话与作品信息
                </summary>
                <p className="mt-2 font-mono text-[11.5px] leading-relaxed text-foreground [overflow-wrap:anywhere]">
                  本人：{status.account?.identity} · 对方：{thread.event.payload.actorId}
                  <br />
                  作品：{thread.event.payload.videoId} · 当前评论：{thread.event.payload.commentId}
                  {thread.event.payload.rootCommentId && <> · 所属根评论：{thread.event.payload.rootCommentId}</>}
                </p>
              </details>

              {thread.commentContext ? (
                <CommentThreadContext thread={thread} choose={props.choose} />
              ) : (
                <blockquote className="m-0 rounded-xl border border-border/80 border-l-[3px] border-l-primary bg-muted/45 px-4 py-3 text-[13.5px] leading-relaxed text-foreground whitespace-pre-wrap [overflow-wrap:anywhere]">
                  <MessageText text={thread.event.payload.text} />
                </blockquote>
              )}

              {thread.event.payload.observationIssue && (
                <p className="hint rounded-lg border border-warning/30 bg-warning/10 px-3 py-1.5 text-xs text-warning-foreground">
                  {reasons[thread.event.payload.observationIssue] ?? thread.event.payload.observationIssue}
                </p>
              )}

              {!thread.commentContext && thread.history.length > 0 && (
                <details className="rounded-xl border border-border/80 bg-muted/35 px-3.5 py-2.5 text-xs">
                  <summary className="cursor-pointer select-none font-medium text-muted-foreground transition-colors hover:text-foreground tabular-nums">
                    历史对话记录 · {thread.history.length} 条
                  </summary>
                  <div className="mt-2 space-y-1.5">
                    {thread.history.map((message, index) => (
                      <p key={index} className="leading-relaxed text-foreground">
                        {message.direction === 'OUTGOING' ? '我方：' : '对方：'}
                        <MessageText text={message.text} />
                      </p>
                    ))}
                  </div>
                </details>
              )}

              <ReplyComposer {...props} thread={thread} />
            </div>
          </dialog>
        </>
      )}
    </section>
  );
}
