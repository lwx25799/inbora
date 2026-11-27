import { useEffect, useState } from 'react';
import { RotateCcwIcon, SparklesIcon } from 'lucide-react';
import { request, reasons, type Thread } from './api';
import { time } from './presentation';
import { completedReply, submittedReplyText, hasReplyHistory, canContinueReply } from './reply-editor-draft';
import { replyResultPresentation } from './reply-result-presentation';
import type { ReplyViewProps } from './reply-view-types';
import { cn } from './lib/utils';

const draftOrigins = new Map([
  ['HUMAN_TYPED', '人工输入'],
  ['AI_ASSISTED_APPROVED', '已引用 AI 建议'],
  ['MCP_ASSISTED', '本机助手编辑'],
  ['LEGACY', '历史草稿'],
]);

const suggestionMessages: Record<string, string> = {
  DM_CONTENT_UNVERIFIED: '此消息包含尚未核验的媒体或分享内容，暂不能生成 AI 建议',
  SUGGESTION_ALREADY_SUBMITTED: '此条已提交，可对新的文字留言生成建议',
  MODEL_OUTSIDE_GRANT: '当前回复策略未覆盖这条消息，暂不能生成 AI 建议',
  MODEL_GRANT_EXHAUSTED: '模型额度已用尽，暂不能生成 AI 建议',
  MODEL_KEY_REQUIRED: '模型 Key 尚未就绪，暂不能生成 AI 建议',
  LOGIN_RECOVERY_IN_PROGRESS: '专属浏览器正由本人操作，AI 建议暂不可用',
  REAL_MODEL_AUTHORIZATION_REQUIRED: '尚无覆盖此消息的模型许可，暂不能生成 AI 建议',
  MODEL_ALREADY_PENDING: '正在生成 AI 建议，请稍候',
  SUGGESTION_BUSY: '正在处理当前操作，请稍候生成 AI 建议',
  MODEL_PAUSED: '当前模式或运行状态已暂停 AI 建议',
};

export function ReplyComposer(props: ReplyViewProps & { thread: Thread }) {
  const {
    thread,
    status,
    busy,
    act,
    setNotice,
    readOnly,
    saving,
    dirty,
    error,
    notice,
    text,
    suggestionId = null,
    setText,
    setSuggestionId,
    refreshThread,
    block,
    send,
    sendCurrentText,
  } = props;
  const completed = completedReply(thread);
  const submitted = hasReplyHistory(thread);
  const hasHumanOwnership = thread.ownership.isMine && thread.ownership.lease_expires_at > Date.now();
  const quoteDisabled = readOnly || !!busy || !!thread.intent || !hasHumanOwnership;
  const quoteReason = busy
    ? '正在处理当前操作，请稍候引用'
    : readOnly
      ? status.mode === 'OBSERVE'
        ? '当前为观察模式，切换工作模式后可引用'
        : '正在恢复连接，暂不能引用'
      : thread.intent
        ? '此条消息已有发送意图，暂不能引用建议'
        : !hasHumanOwnership
          ? '当前未持有人工接管，点击输入框进入编辑后可引用'
          : '';
  const suggestionReason = busy
    ? 'SUGGESTION_BUSY'
    : readOnly || status.mode === 'OBSERVE'
      ? 'MODEL_PAUSED'
      : status.modelBusy
        ? 'MODEL_ALREADY_PENDING'
        : submitted
          ? 'SUGGESTION_ALREADY_SUBMITTED'
          : !thread.strong || thread.event.status === 'MANUAL_REVIEW'
            ? thread.event.payload.observationIssue ?? 'TARGET_NEEDS_REVIEW'
            : thread.suggestionEligibility
              ? thread.suggestionEligibility.eligible
                ? null
                : thread.suggestionEligibility.reason ?? 'SUGGESTION_NOT_AVAILABLE'
              : !status.modelAuthorized
                ? 'REAL_MODEL_AUTHORIZATION_REQUIRED'
                : null;
  const turn = thread.followup?.latestTurn;
  const result = replyResultPresentation(thread, send);
  const replied = result.state === 'CONFIRMED';
  const confirmedAt = turn
    ? turn.verifiedAt
    : thread.verification?.verified === 1
      ? thread.verification.checked_at
      : thread.receipt?.result === 'CONFIRMED'
        ? thread.receipt.verified_at
        : null;
  const charCount = [...text].length;
  const sendingNow = busy === '发送中';
  const generatingNow = busy === '生成 AI 建议';
  const undoRoundKey = [
    thread.event.id,
    Number(submitted),
    thread.ownership.generation,
    thread.intent?.id ?? '',
    turn?.commandId ?? '',
    send?.commandId ?? '',
  ].join(':');
  const [undoState, setUndoState] = useState<{
    kind: 'clear' | 'quote';
    roundKey: string;
    expectedText: string;
    previousText: string;
    previousSuggestionId: string | null;
  } | null>(null);

  useEffect(() => {
    setUndoState(current => {
      if (!current) return null;
      if (
        readOnly ||
        !!busy ||
        current.roundKey !== undoRoundKey ||
        current.expectedText !== text
      ) {
        return null;
      }
      return current;
    });
  }, [undoRoundKey, text, readOnly, busy]);

  const activeUndo =
    undoState &&
    !readOnly &&
    !busy &&
    undoState.roundKey === undoRoundKey &&
    undoState.expectedText === text
      ? undoState
      : null;
  const keyAlreadyExplained =
    suggestionReason === 'MODEL_KEY_REQUIRED' ||
    suggestionReason === 'REAL_MODEL_AUTHORIZATION_REQUIRED';

  return (
    <div className="reply-composer space-y-2.5">
      {thread.event.payload.channel !== 'DIRECT_MESSAGE' && (error || notice || busy) && (
        <p
          role={error ? 'alert' : 'status'}
          className={cn(
            'rounded-xl border px-3 py-2 text-xs',
            error
              ? 'error border-destructive/30 bg-destructive/8 text-destructive-foreground'
              : 'hint border-border bg-muted/50 text-muted-foreground',
          )}
        >
          {error || busy || notice}
        </p>
      )}

      {submitted && !completed && (
        <section
          className="original rounded-xl border border-warning/35 bg-warning/10 px-3.5 py-2.5 text-foreground"
          aria-label="已提交回复"
        >
          <h3 className="text-xs font-semibold text-warning-foreground">已提交回复</h3>
          <p className="mt-1 text-[13px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
            {submittedReplyText(thread)}
          </p>
        </section>
      )}

      {(submitted || thread.ownership.isMine) && (
        <p className="composer-status hint text-[11.5px] text-muted-foreground">
          {submitted
            ? completed
              ? '继续输入下一条回复'
              : thread.followup?.queueReady
                ? saving
                  ? '正在保存下一条回复'
                  : dirty
                    ? '下一条回复正在自动保存'
                    : '可继续输入并发送下一条回复'
                : result.state === 'CHECKING'
                  ? '上一条回复正在核对，可先输入新内容'
                  : '上一条回复的发送结果尚未确认，可先输入新内容'
            : saving
              ? '正在保存'
              : dirty
                ? '正在自动保存'
                : '修改已保存'}
        </p>
      )}

      {readOnly && (
        <p
          role="status"
          className="hint rounded-lg border border-border/80 bg-muted/55 px-3 py-1.5 text-xs text-muted-foreground"
        >
          {status.mode === 'OBSERVE' ? '当前为观察模式，切换工作模式后可编辑' : '正在恢复连接，请稍候继续编辑'}
        </p>
      )}

      <section className="editor rounded-xl border border-input bg-card p-3 shadow-xs transition-shadow focus-within:border-primary/55 focus-within:ring-2 focus-within:ring-ring/25">
        <div className="editor-title mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2">
          <h3 className="text-xs font-semibold text-foreground">{submitted ? '继续回复' : '回复草稿'}</h3>
          <small className="text-[11px] text-muted-foreground tabular-nums">
            {!submitted && thread.draft && (
              <>
                版本 {thread.draft.version} ·{' '}
                {draftOrigins.get(thread.draft.origin) ?? '来源待核对'} ·{' '}
              </>
            )}
            <span
              className={
                charCount > 500
                  ? 'font-semibold text-destructive-foreground'
                  : charCount > 450
                    ? 'font-medium text-warning-foreground'
                    : undefined
              }
            >
              {charCount}/500 字
            </span>
          </small>
        </div>

        <textarea
          aria-label="人工回复草稿"
          value={text}
          onFocus={() => {
            if (canContinueReply(thread) && !thread.ownership.isMine) void act('准备人工输入', props.openDialog);
          }}
          readOnly={readOnly}
          placeholder={readOnly ? '此回复暂时无法编辑' : '直接输入回复，无需 Key'}
          onChange={e => {
            if (canContinueReply(thread) && !thread.ownership.isMine) void act('准备人工输入', props.openDialog);
            setUndoState(null);
            setText(e.target.value);
          }}
          onKeyDown={event => {
            if (event.ctrlKey && event.key === 'Enter' && !readOnly && !block && !busy) {
              event.preventDefault();
              void act('发送中', sendCurrentText);
            }
          }}
          className="block min-h-[76px] max-h-[220px] w-full resize-y border-0 bg-transparent px-1 py-0.5 text-[13.5px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/70 read-only:cursor-not-allowed read-only:rounded-md read-only:bg-muted/50 read-only:px-2 read-only:text-muted-foreground"
        />

        <div className="editor-actions mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={readOnly || !!busy || !text}
              onClick={() => {
                setUndoState({
                  kind: 'clear',
                  roundKey: undoRoundKey,
                  expectedText: '',
                  previousText: text,
                  previousSuggestionId: suggestionId,
                });
                setText('');
                setSuggestionId(null);
              }}
              className={cn(
                'inline-flex h-7 cursor-pointer items-center justify-center rounded-md border border-transparent px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                (readOnly || !!busy || !text) && 'pointer-events-none opacity-45',
              )}
            >
              清空
            </button>
            {activeUndo && (
              <span
                role="status"
                className="inline-flex items-center gap-1.5 rounded-md border border-border/80 bg-muted/55 px-2 py-0.5 text-[11.5px] text-foreground"
              >
                <span>{activeUndo.kind === 'clear' ? '已清空草稿' : '已替换为 AI 建议'}</span>
                <button
                  type="button"
                  onClick={() => {
                    const saved = activeUndo;
                    setUndoState(null);
                    setText(saved.previousText);
                    setSuggestionId(saved.previousSuggestionId);
                  }}
                  className="inline-flex cursor-pointer items-center gap-1 font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <RotateCcwIcon aria-hidden="true" className="size-3" />
                  撤销
                </button>
              </span>
            )}
          </div>
          <button
            type="button"
            disabled={!!suggestionReason}
            aria-describedby={suggestionReason ? 'suggestion-unavailable-' + thread.event.id : undefined}
            onClick={() =>
              void act('生成 AI 建议', async () => {
                await request({
                  command: 'generateSuggestion',
                  eventId: thread.event.id,
                  draftVersion: thread.draft?.version ?? 0,
                });
                await refreshThread();
                setNotice('AI 建议已生成，当前人稿未受影响');
              })
            }
            className={cn(
              'inline-flex h-7 cursor-pointer items-center justify-center rounded-md border border-input bg-card px-2.5 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:border-primary/35 hover:bg-primary/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-input/32 dark:hover:bg-input/55',
              !!suggestionReason && 'pointer-events-none opacity-50',
            )}
          >
            {generatingNow ? '正在生成…' : '生成 AI 建议'}
          </button>
        </div>

        {suggestionReason && (
          <p
            id={'suggestion-unavailable-' + thread.event.id}
            className="hint mt-2 text-[11.5px] text-muted-foreground"
            role="status"
          >
            {suggestionMessages[suggestionReason] ??
              reasons[suggestionReason] ??
              '此消息暂不能生成 AI 建议，请保留人稿稍后查看'}
          </p>
        )}

        {!submitted && !status.keyPresent && !keyAlreadyExplained && (
          <p className="hint mt-1.5 text-[11.5px] text-muted-foreground">未配置 Key，人工回复仍可直接发送。</p>
        )}
      </section>

      {!submitted &&
        thread.suggestions.map(s => (
          <section
            className="suggestion relative overflow-hidden rounded-xl border border-primary/28 bg-primary/[0.045] py-3 pr-3.5 pl-4 shadow-xs/5 before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-primary"
            key={s.id}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary">
                <SparklesIcon aria-hidden="true" className="size-3.5 shrink-0" />
                <span>
                  AI 建议{' '}
                  <small className="font-mono text-[11px] font-normal text-muted-foreground">
                    {s.model}
                    {s.draft_version !== (thread.draft?.version ?? 0) ? ' · 基于旧草稿版本' : ''}
                  </small>
                </span>
              </h3>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  disabled={quoteDisabled}
                  title={quoteReason || undefined}
                  onClick={() => {
                    if (quoteDisabled) return;
                    if (text.trim() && text !== s.text) {
                      setUndoState({
                        kind: 'quote',
                        roundKey: undoRoundKey,
                        expectedText: s.text,
                        previousText: text,
                        previousSuggestionId: suggestionId,
                      });
                    } else {
                      setUndoState(null);
                    }
                    setText(s.text);
                    setSuggestionId(s.id);
                  }}
                  className={cn(
                    'inline-flex h-6.5 cursor-pointer items-center justify-center rounded-md border border-primary bg-primary px-2.5 text-xs font-medium text-primary-foreground shadow-xs/15 transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    quoteDisabled && 'pointer-events-none opacity-50',
                  )}
                >
                  引用到编辑器
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void act('拒绝建议', async () => {
                      await request({
                        command: 'dismissSuggestion',
                        suggestionId: s.id,
                      });
                      await refreshThread();
                    })
                  }
                  className="inline-flex h-6.5 cursor-pointer items-center justify-center rounded-md border border-input bg-card px-2.5 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-input/32"
                >
                  拒绝建议
                </button>
              </div>
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-foreground whitespace-pre-wrap [overflow-wrap:anywhere]">
              {s.text}
            </p>
          </section>
        ))}

      {result.state !== 'NONE' && (
        <section
          className={cn(
            'receipt rounded-xl border px-3.5 py-2.5 text-xs [&>strong]:font-semibold [&>strong]:text-foreground',
            result.state === 'CONFIRMED'
              ? 'border-success/30 bg-success/8 text-foreground'
              : result.state === 'FAILED'
                ? 'border-destructive/30 bg-destructive/8 text-foreground'
                : result.state === 'SENDING'
                  ? 'border-primary/30 bg-primary/8 text-foreground'
                  : 'border-warning/35 bg-warning/10 text-foreground',
          )}
          role="status"
          aria-label="发送结果"
          data-testid="reply-send-result"
        >
          <strong>{result.title}</strong>
          {result.detail && <p className="mt-1 leading-relaxed text-muted-foreground">{result.detail}</p>}
          {replied && confirmedAt && (
            <small className="mt-1 block text-[11px] text-success-foreground tabular-nums">
              确认于 {time(confirmedAt)}
            </small>
          )}
        </section>
      )}

      {!replied && thread.automationJob?.reason && (
        <p className="hint text-xs text-muted-foreground">
          自动回复暂未完成：{reasons[thread.automationJob.reason] ?? '后台处理遇到问题，消息和草稿已保留'}
        </p>
      )}

      <div className="send-footer flex flex-wrap items-center justify-between gap-2 pt-0.5">
        <p className="hint min-w-0 text-xs text-muted-foreground">
          {block || '输入回复后点击发送，系统自动完成其余步骤。'}
        </p>
        <div className="flex shrink-0 items-center gap-2.5">
          <small className="text-[11px] text-muted-foreground">Ctrl+Enter 也可发送当前全文</small>
          <button
            type="button"
            className={cn(
              'primary inline-flex h-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-primary bg-primary px-4 text-xs font-medium text-primary-foreground shadow-xs shadow-primary/20 transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
              (!!block || !!busy) && 'pointer-events-none opacity-55',
            )}
            disabled={!!block || !!busy}
            onClick={() => void act('发送中', sendCurrentText)}
          >
            {sendingNow ? '发送中…' : '发送'}
          </button>
        </div>
      </div>
    </div>
  );
}
