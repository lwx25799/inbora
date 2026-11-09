import {request,reasons,type Status,type Thread} from './api';
import {time} from './presentation';
import type {ReplyViewProps} from './reply-view-types';

const draftOrigins = new Map([
  ["HUMAN_TYPED", "人工输入"],
  ["AI_ASSISTED_APPROVED", "已引用 AI 建议"],
  ["LEGACY", "历史草稿"],
]);

export function ReplyComposer(props:ReplyViewProps & {thread:Thread}) {
  const {thread,status,busy,act,setNotice,closeDialog,readOnly,saving,dirty,error,notice,text,setText,setSuggestionId,setReview,refreshThread,block,send,sendCurrentText,setStatus}=props;
  return <div className="reply-composer">
    <p className="composer-status hint">{thread.ownership.isMine?saving?'正在保存':dirty?'正在自动保存':'修改已保存':'正在准备回复输入'}</p>
    {!thread.ownership.isMine&&!thread.intent&&thread.event.payload.channel==='DIRECT_MESSAGE'&&<button onClick={()=>void act('继续写回复',props.openDialog)}>继续写回复</button>}
    {thread.event.payload.channel!=='DIRECT_MESSAGE'&&(error||notice||busy)&&<p role={error?'alert':'status'} className={error?'error':'hint'}>{error||busy||notice}</p>}
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
    onKeyDown={event=>{
      if(event.ctrlKey&&event.key==='Enter'&&!readOnly&&!block&&!busy){event.preventDefault();void act('发送中',sendCurrentText);}
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

  </div>;
}
