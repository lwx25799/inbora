import type { RefObject } from 'react';
import { request, reasons, sourceNames, type Status, type Thread } from './api';
import { time } from './presentation';

const draftOrigins = new Map([
  ["HUMAN_TYPED", "人工输入"],
  ["AI_ASSISTED_APPROVED", "已引用 AI 建议"],
  ["LEGACY", "历史草稿"],
]);
interface ReplyDetailProps {
  detailElement: RefObject<HTMLElement | null>;
  dialogElement: RefObject<HTMLDialogElement | null>;
  thread: Thread | null;
  status: Status;
  setStatus: (status: Status) => void;
  selected: string | null;
  busy: string;
  act: (label: string, action: () => Promise<void>) => Promise<void>;
  setNotice: (text: string) => void;
  openDialog: () => Promise<void>;
  closeDialog: () => Promise<void>;
  readOnly: boolean;
  saving: boolean;
  dirty: boolean;
  error: string;
  notice: string;
  text: string;
  setText: (text: string) => void;
  setSuggestionId: (id: string | null) => void;
  setReview: (value: null) => void;
  refreshThread: () => Promise<unknown>;
  block: string;
  send: { commandId: string; status: string; reason: string | null } | null;
  sendCurrentText: () => Promise<void>;
}

export function ReplyDetail({
  detailElement,
  dialogElement,
  thread,
  status,
  setStatus,
  selected,
  busy,
  act,
  setNotice,
  openDialog,
  closeDialog,
  readOnly,
  saving,
  dirty,
  error,
  notice,
  text,
  setText,
  setSuggestionId,
  setReview,
  refreshThread,
  block,
  send,
  sendCurrentText
}: ReplyDetailProps) {
  return (
            <section
              ref={detailElement}
              className="detail scroll"
              aria-label="消息详情"
            >
              {!thread ? (
                <div className="empty detail-empty">
                  <span className="detail-mark">i</span>
                  <h2>
                    {selected ? "正在读取准确目标" : "从左侧选择一条消息"}
                  </h2>
                  <p>查看原文与准确目标，打开人工回复后输入并发送。</p>
                </div>
              ) : (
                <>
                  <div className="detail-heading">
                    <div>
                      <p className="eyebrow">
                        {thread.event.payload.channel === "DIRECT_MESSAGE"
                          ? "私信会话"
                          : "作品评论"}{" "}
                        ·{" "}
                        {
                          sourceNames[
                            thread.event.payload.discovery ??
                              (thread.event.payload.channel === "DIRECT_MESSAGE"
                                ? "DIRECT_MESSAGE"
                                : "NOTIFICATION")
                          ]
                        }
                      </p>
                    <h2>{thread.event.payload.actorName || "当前联系人"}</h2>
                    </div>
                    <span className="badge">
                      {thread.replyStatus==='REPLIED'?'已回复':'等待回复'}
                    </span>
                  </div>
                  <details key={thread.event.id} className="identity">
                    <summary>消息信息</summary>
                    <dl>
                      <dt>本人账号</dt>
                      <dd>{status.account?.identity ?? "未绑定"}</dd>
                      <dt>对方账号</dt>
                      <dd>
                        {thread.event.payload.actorId ?? "未取得稳定标识"}
                      </dd>
                      {thread.event.payload.channel === "DIRECT_MESSAGE" ? (
                        <>
                          <dt>会话</dt>
                          <dd>
                            {thread.event.payload.conversationId ?? "未取得"}
                          </dd>
                        </>
                      ) : (
                        <>
                          <dt>作品</dt>
                          <dd>{thread.event.payload.videoId ?? "未取得"}</dd>
                          {thread.workUrl && (
                            <>
                              <dt>作品链接</dt>
                              <dd>{thread.workUrl}</dd>
                            </>
                          )}
                          <dt>原父评论</dt>
                          <dd>{thread.event.payload.commentId ?? "未取得"}</dd>
                          <dt>回复关系</dt>
                          <dd>只回复此父评论，不在作品下另发顶层评论</dd>
                        </>
                      )}
                      <dt>原事件</dt>
                      <dd>
                        {thread.event.payload.platformEventId ?? "未取得"}
                      </dd>
                    </dl>
                  </details>
                  <button
                    disabled={!!busy}
                    onClick={() =>
                      void act("打开准确原对象", async () => {
                        await request({
                          command: "openTarget",
                          eventId: thread.event.id,
                        });
                        setNotice("已在专属浏览器中定位，未填写或发送");
                      })
                    }
                  >
                    在专属浏览器查看原对象
                  </button>
                  <section className="original">
                    <h3>
                      {thread.event.payload.channel === "DIRECT_MESSAGE"
                        ? "触发此任务的私信"
                        : "原父评论"}
                    </h3>
                    <p>{thread.event.payload.text}</p>
                    <small>{time(thread.event.payload.occurredAt)}</small>
                  </section>
                  <details className="history">
                    <summary>有限上下文 · {thread.history.length} 条</summary>
                    {thread.history.map((h, i) => (
                      <article
                        key={i}
                        className={h.direction === "OUTGOING" ? "outgoing" : ""}
                      >
                        <small>
                          {h.direction === "OUTGOING"
                            ? "我方已确认回复"
                            : "入站观察"}{" "}
                          · {time(h.occurredAt)}
                        </small>
                        <p>{h.text}</p>
                      </article>
                    ))}
                  </details>
                  <button className="primary" onClick={()=>void act('打开人工回复',openDialog)}>打开人工回复</button>
                  <dialog ref={dialogElement} className="human-dialog" aria-label="人工回复对话框" onCancel={e=>{e.preventDefault();void act('保存并关闭',closeDialog);}}>
                    <div className="dialog-heading"><h2>回复 {thread.event.payload.actorName || '当前目标'}</h2>
                      <button onClick={()=>void act('保存并关闭',closeDialog)}>关闭并保留草稿</button></div>
                    {!thread.ownership.isMine&&!thread.intent&&<button onClick={()=>void act('继续写回复',openDialog)}>继续写回复</button>}
                    <details className="identity"><summary>会话与作品信息</summary><p>本人：{status.account?.identity} · 对方：{thread.event.payload.actorId}<br/>
                      {thread.event.payload.channel==='DIRECT_MESSAGE'?'会话：'+thread.event.payload.conversationId:'作品：'+thread.event.payload.videoId+' · 父评论：'+thread.event.payload.commentId}</p></details>
                    <blockquote>{thread.event.payload.text}</blockquote>
                    <details><summary>上下文 · {thread.history.length} 条</summary>{thread.history.map((h,i)=><p key={i}>{h.direction==='OUTGOING'?'我方：':'对方：'}{h.text}</p>)}</details>
                    <p className="hint">{thread.ownership.isMine?saving?'正在保存':dirty?'正在自动保存':'修改已保存':'此回复暂时只读'}</p>
                    {(error||notice||busy)&&<p role={error?'alert':'status'} className={error?'error':'hint'}>{error||busy||notice}</p>}
                  <section className="editor">
                    <div className="editor-title">
                      <h3>回复草稿</h3>
                      <small>
                        版本 {thread.draft?.version ?? 0} ·{" "}
                        {thread.draft
                          ? draftOrigins.get(thread.draft.origin) ?? "来源待核对"
                          : "尚未保存"}{" "}
                        · {[...text].length}/500 字
                      </small>
                    </div>
                    <textarea
                      aria-label="人工回复草稿"
                      value={text}
                      readOnly={readOnly}
                      placeholder={
                        readOnly
                          ? "此回复暂时无法编辑"
                          : "直接输入回复，无需 Key"
                      }
                      onChange={(e) => {
                        setText(e.target.value);
                        setReview(null);
                      }}
                    />
                    <div className="editor-actions">
                      <div>
                        <button
                          disabled={readOnly || !!busy || !text}
                          onClick={() => {
                            setText("");
                            setSuggestionId(null);
                            setReview(null);
                          }}
                        >
                          清空
                        </button>
                      </div>
                      <button
                        disabled={
                          !!busy ||
                          status.modelBusy ||
                          !status.modelAuthorized ||
                          !!thread.intent ||
                          status.mode === "OBSERVE"
                        }
                        onClick={() =>
                          void act("生成 AI 建议", async () => {
                            await request({
                              command: "generateSuggestion",
                              eventId: thread.event.id,
                              draftVersion: thread.draft?.version ?? 0,
                            });
                            await refreshThread();
                            setNotice("AI 建议已到达，当前人稿保留");
                          })
                        }
                      >
                        生成 AI 建议
                      </button>
                    </div>
                    {!status.keyPresent && (
                      <p className="hint">
                        未配置 Key，人工回复仍可直接发送。
                      </p>
                    )}
                  </section>
                  {thread.suggestions.map((s) => (
                    <section className="suggestion" key={s.id}>
                      <h3>
                        AI 建议{" "}
                        <small>
                          {s.model}
                          {s.draft_version !== (thread.draft?.version ?? 0)
                            ? " · 基于旧草稿版本"
                            : ""}
                        </small>
                      </h3>
                      <p>{s.text}</p>
                      <button
                        disabled={readOnly}
                        onClick={() => {
                          setText(s.text);
                          setSuggestionId(s.id);
                          setReview(null);
                        }}
                      >
                        引用到编辑器
                      </button>
                      <button
                        onClick={() =>
                          void act("拒绝建议", async () => {
                            await request({
                              command: "dismissSuggestion",
                              suggestionId: s.id,
                            });
                            await refreshThread();
                          })
                        }
                      >
                        拒绝建议
                      </button>
                    </section>
                  ))}
                  {thread.receipt && (
                    <section className="receipt">
                      <strong>{thread.replyStatus==='REPLIED'?'已回复':'等待回复'}</strong>
                      <p>回读记录：{time(thread.receipt.verified_at)}</p>
                      <small>送达记录已保存。</small>
                    </section>
                  )}
                  {thread.verification&&<p className="receipt">{thread.verification.verified?'消息已送达，原发送记录已保留':thread.verification.state==='REVIEW'?'暂时无法确定是否送达，已停止重复发送，草稿和记录已保留':'正在后台检查送达情况，无需重复发送'}</p>}
                  {thread.automationJob?.reason&&<p className="hint">自动回复暂未完成：{reasons[thread.automationJob.reason]??'后台处理遇到问题，消息和草稿已保留'}</p>}
                  {send && (
                    <p role="status" className="send-state">
                      {thread.replyStatus==='REPLIED'?'已回复':'等待回复'}
                      {send.reason
                        ? " · " + (reasons[send.reason] ?? send.reason)
                        : ""}
                    </p>
                  )}
                    <div className="send-footer">
                      <p className="hint">
                        {block ||
                          "输入回复后点击发送，系统自动完成其余步骤。"}
                      </p>
                      <div>
                        <small>Ctrl+Enter 也可发送当前全文</small>
                        <button
                          className="primary"
                          disabled={!!block || !!busy}
                          onClick={() => void act("发送中", sendCurrentText)}
                        >
                          发送
                        </button>
                        {thread.paused&&!thread.intent&&<button
                          onClick={() =>
                            void act("继续回复", async () => {
                              setStatus(
                                await request<Status>({
                                  command: 'resume',
                                  eventId: thread.event.id,
                                }),
                              );
                              await refreshThread();
                              setReview(null);
                            })
                          }
                        >
                          继续回复
                        </button>}
                        {!thread.intent&&status.automation&&<button onClick={()=>void act('交回自动回复',async()=>{const eventId=thread.event.id;await closeDialog();await request({command:'resumeAutomation',eventId});await refreshThread();})}>交回自动回复</button>}
                      </div>
                    </div>
                  </dialog>
                </>
              )}
            </section>
  );
}
