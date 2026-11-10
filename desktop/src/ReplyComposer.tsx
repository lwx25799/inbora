import {request,reasons,type Thread} from './api';
import {time} from './presentation';
import {completedReply} from './reply-editor-draft';
import type {ReplyViewProps} from './reply-view-types';

const draftOrigins = new Map([
  ["HUMAN_TYPED", "人工输入"],
  ["AI_ASSISTED_APPROVED", "已引用 AI 建议"],
  ["LEGACY", "历史草稿"],
]);

export function ReplyComposer(props:ReplyViewProps & {thread:Thread}) {
  const {thread,status,busy,act,setNotice,readOnly,saving,dirty,error,notice,text,setText,setSuggestionId,setReview,refreshThread,block,send,sendCurrentText}=props;
  const replied=thread.replyStatus==='REPLIED';
  const completed=completedReply(thread),showEditor=!completed||!!text;
  const pending=['PREPARING','QUEUED','PREFLIGHT','SENDING'].includes(send?.status??'');
  const reviewing=thread.verification?.state==='REVIEW';
  const failed=send?.status==='FAILED_BEFORE_CLICK';
  const hasResult=replied||!!thread.intent||!!thread.verification||!!send;
  const resultTitle=replied?'已回复':failed?'尚未发送':pending?'正在发送':'等待确认';
  const resultDetail=replied?null:failed
    ?reasons[send?.reason??'']??'本次未发送，草稿已保留'
    :pending?'正在处理，请勿重复发送'
    :reviewing?'暂时无法确认送达，草稿和记录已保留，请勿重复发送'
    :'正在后台确认送达，请勿重复发送';
  return <div className="reply-composer">
    {thread.event.payload.channel!=='DIRECT_MESSAGE'&&(error||notice||busy)&&<p role={error?'alert':'status'} className={error?'error':'hint'}>{error||busy||notice}</p>}
{showEditor&&<>
    <p className="composer-status hint">{completed?'未发送内容已保留':thread.ownership.isMine?saving?'正在保存':dirty?'正在自动保存':'修改已保存':'正在准备回复输入'}</p>
<section className="editor">
  <div className="editor-title">
    <h3>回复草稿</h3>
    <small>
      {!completed&&<>版本 {thread.draft?.version ?? 0} ·{" "}
      {thread.draft
        ? draftOrigins.get(thread.draft.origin) ?? "来源待核对"
        : "尚未保存"}{" "}
      · </>}{[...text].length}/500 字
    </small>
  </div>
  <textarea
    aria-label="人工回复草稿"
    value={text}
    onFocus={()=>{if(!thread.intent&&!thread.ownership.isMine)void act('准备人工输入',props.openDialog);}}
    readOnly={readOnly}
    placeholder={
      readOnly
        ? "此回复暂时无法编辑"
        : "直接输入回复，无需 Key"
    }
    onChange={(e) => {
      if(!thread.intent&&!thread.ownership.isMine)void act('准备人工输入',props.openDialog);
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
        !thread.strong ||
        thread.event.status==='MANUAL_REVIEW' ||
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
  {!completed&&!status.keyPresent && (
    <p className="hint">
      未配置 Key，人工回复仍可直接发送。
    </p>
  )}
</section>
</>}
{!completed&&thread.suggestions.map((s) => (
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
{hasResult && (
  <section className="receipt" role="status" aria-label="发送结果" data-testid="reply-send-result">
    <strong>{resultTitle}</strong>
    {resultDetail&&<p>{resultDetail}</p>}
    {replied&&thread.receipt&&<small>确认于 {time(thread.receipt.verified_at)}</small>}
  </section>
)}
{!replied&&thread.automationJob?.reason&&<p className="hint">自动回复暂未完成：{reasons[thread.automationJob.reason]??'后台处理遇到问题，消息和草稿已保留'}</p>}
  {!completed&&<div className="send-footer">
    {!hasResult&&<p className="hint">{block || "输入回复后点击发送，系统自动完成其余步骤。"}</p>}
    <div>
      <small>Ctrl+Enter 也可发送当前全文</small>
      <button
        className="primary"
        disabled={!!block || !!busy}
        onClick={() => void act("发送中", sendCurrentText)}
      >
        发送
      </button>
    </div>
  </div>}

  </div>;
}
