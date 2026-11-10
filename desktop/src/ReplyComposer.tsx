import {request,reasons,type Thread} from './api';
import {time} from './presentation';
import {completedReply,submittedReplyText} from './reply-editor-draft';
import type {ReplyViewProps} from './reply-view-types';

const draftOrigins = new Map([
  ["HUMAN_TYPED", "人工输入"],
  ["AI_ASSISTED_APPROVED", "已引用 AI 建议"],
  ["LEGACY", "历史草稿"],
]);

export function ReplyComposer(props:ReplyViewProps & {thread:Thread}) {
  const {thread,status,busy,act,setNotice,readOnly,saving,dirty,error,notice,text,setText,setSuggestionId,setReview,refreshThread,block,send,sendCurrentText}=props;
  const completed=completedReply(thread);
  const turn=thread.followup?.latestTurn;
  const replied=thread.replyStatus==='REPLIED'&&(!turn||turn.status==='CONFIRMED');
  const pending=['PREPARING','APPROVED','INTENT_RECORDED','QUEUED','PREFLIGHT','SENDING'].includes(turn?.status??send?.status??'');
  const reviewing=turn?.status==='UNCERTAIN'||thread.verification?.state==='REVIEW';
  const failed=(turn?.status??send?.status)==='FAILED_BEFORE_CLICK';
  const hasResult=replied||!!thread.intent||!!thread.verification||!!send;
  const resultTitle=replied?'已回复':failed?'尚未发送':pending?'正在发送':'等待确认';
  const resultDetail=replied?null:failed
    ?reasons[turn?.reason??send?.reason??'']??'本次未发送，草稿已保留'
    :pending?'正在处理，请勿重复发送'
    :reviewing?'暂时无法确认送达，草稿和记录已保留，请勿重复发送'
    :'正在后台确认送达，请勿重复发送';
  return <div className="reply-composer">
    {thread.event.payload.channel!=='DIRECT_MESSAGE'&&(error||notice||busy)&&<p role={error?'alert':'status'} className={error?'error':'hint'}>{error||busy||notice}</p>}
{thread.intent&&!completed&&<section className="original" aria-label="已提交回复">
  <h3>已提交回复</h3><p>{submittedReplyText(thread)}</p>
</section>}
    <p className="composer-status hint">{thread.intent?completed?'继续输入下一条回复':'上一条回复正在确认，可先输入新内容':thread.ownership.isMine?saving?'正在保存':dirty?'正在自动保存':'修改已保存':'正在准备回复输入'}</p>
    {readOnly&&<p role="status" className="hint">{status.mode==='OBSERVE'?'当前为观察模式，切换工作模式后可编辑':'正在恢复连接，请稍候继续编辑'}</p>}
<section className="editor">
  <div className="editor-title">
    <h3>{thread.intent?'继续回复':'回复草稿'}</h3>
    <small>
      {!thread.intent&&<>版本 {thread.draft?.version ?? 0} ·{" "}
      {thread.draft
        ? draftOrigins.get(thread.draft.origin) ?? "来源待核对"
        : "尚未保存"}{" "}
      · </>}{[...text].length}/500 字
    </small>
  </div>
  <textarea
    aria-label="人工回复草稿"
    value={text}
    onFocus={()=>{if((!thread.intent||thread.followup?.eligible)&&!thread.ownership.isMine)void act('准备人工输入',props.openDialog);}}
    readOnly={readOnly}
    placeholder={
      readOnly
        ? "此回复暂时无法编辑"
        : "直接输入回复，无需 Key"
    }
    onChange={(e) => {
      if((!thread.intent||thread.followup?.eligible)&&!thread.ownership.isMine)void act('准备人工输入',props.openDialog);
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
  {!thread.intent&&!status.keyPresent && (
    <p className="hint">
      未配置 Key，人工回复仍可直接发送。
    </p>
  )}
</section>
{!thread.intent&&thread.suggestions.map((s) => (
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
    {replied&&(turn?.verifiedAt||thread.receipt)&&<small>确认于 {time(turn?.verifiedAt??thread.receipt?.verified_at??null)}</small>}
  </section>
)}
{!replied&&thread.automationJob?.reason&&<p className="hint">自动回复暂未完成：{reasons[thread.automationJob.reason]??'后台处理遇到问题，消息和草稿已保留'}</p>}
  <div className="send-footer">
    <p className="hint">{block || "输入回复后点击发送，系统自动完成其余步骤。"}</p>
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
  </div>

  </div>;
}
