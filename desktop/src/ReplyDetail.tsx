import {request,reasons,sourceNames} from './api';
import {time} from './presentation';
import {ReplyComposer} from './ReplyComposer';
import {DirectMessageChat} from './DirectMessageChat';
import {CommentThreadContext} from './CommentThreadContext';
import type {ReplyViewProps} from './reply-view-types';

export function ReplyDetail(props:ReplyViewProps) {
  const {detailElement,dialogElement,thread,status,selected,busy,act,setNotice,openDialog,closeDialog}=props;
  if(thread?.event.payload.channel==='DIRECT_MESSAGE')return <DirectMessageChat {...props} thread={thread}/>;
  return <section ref={detailElement} className="detail scroll" aria-label="消息详情">
    {!thread?<div className="empty detail-empty">
      <span className="detail-mark">i</span>
      <h2>{selected?'正在读取准确目标':'从左侧选择一条会话或评论'}</h2>
      <p>选择会话即可查看消息并回复，评论保留准确父评论关系。</p>
    </div>:<>
      <div className="detail-heading">
        <div><p className="eyebrow">{thread.event.payload.kind==='REPLY'?'楼中楼评论':'作品评论'} · {sourceNames[thread.event.payload.discovery??'NOTIFICATION']}</p>
          <h2>{thread.event.payload.actorName||'当前联系人'}</h2></div>
        <span className="badge">{thread.replyStatus==='REPLIED'?'已回复':'等待回复'}</span>
      </div>
      <details key={thread.event.id} className="identity">
        <summary>消息信息</summary>
        <dl>
          <dt>本人账号</dt><dd>{status.account?.identity??'未绑定'}</dd>
          <dt>对方账号</dt><dd>{thread.event.payload.actorId??'未取得稳定标识'}</dd>
          <dt>作品</dt><dd>{thread.event.payload.videoId??'未取得'}</dd>
          {thread.workUrl&&<><dt>作品链接</dt><dd>{thread.workUrl}</dd></>}
          <dt>{thread.event.payload.kind==='REPLY'?'当前子评论':'原父评论'}</dt><dd>{thread.event.payload.commentId??'未取得'}</dd>
          {thread.event.payload.kind==='REPLY'&&<><dt>所属根评论</dt><dd>{thread.event.payload.rootCommentId??'后台正在核对层级'}</dd></>}
          <dt>回复关系</dt><dd>{thread.event.payload.kind==='REPLY'?'只回复当前子评论，保留所属根评论关系':'只回复此父评论，不在作品下另发顶层评论'}</dd>
          <dt>原事件</dt><dd>{thread.event.payload.platformEventId??'未取得'}</dd>
        </dl>
      </details>
      {status.browser.mode==='headed'&&!status.browser.loginRecovery&&<button disabled={!!busy} onClick={()=>void act('打开准确原对象',async()=>{
        await request({command:'openTarget',eventId:thread.event.id});setNotice('已在专属浏览器中定位，未填写或发送');
      })}>在专属浏览器查看原对象</button>}
      {thread.event.payload.kind==='REPLY'?<CommentThreadContext thread={thread}/>:<section className="original">
        <h3>原父评论</h3><p>{thread.event.payload.text}</p>
        {thread.event.payload.observationIssue&&<p className="hint">{reasons[thread.event.payload.observationIssue]??thread.event.payload.observationIssue}</p>}
        <small>{time(thread.event.payload.occurredAt)}</small>
      </section>}
      {thread.event.payload.kind!=='REPLY'&&!!thread.timeline?.items.some(message=>message.direction==='OUTGOING')&&<section className="original" aria-label="我的回复">
        <h3>我的回复</h3>{thread.timeline.items.filter(message=>message.direction==='OUTGOING').map(message=><article key={message.id}>
          <p>{message.text}</p><small>已回复 · {time(message.occurredAt)}</small>
        </article>)}
      </section>}
      {thread.event.payload.kind!=='REPLY'&&<details className="history"><summary>有限上下文 · {thread.history.length} 条</summary>
        {thread.history.map((message,index)=><article key={index} className={message.direction==='OUTGOING'?'outgoing':''}>
          <small>{message.direction==='OUTGOING'?'我方已确认回复':'入站观察'} · {time(message.occurredAt)}</small><p>{message.text}</p>
        </article>)}
      </details>}
      <button className="primary" onClick={()=>void act('打开人工回复',openDialog)}>打开人工回复</button>
      <dialog ref={dialogElement} className="human-dialog" aria-label="人工回复对话框" onCancel={event=>{event.preventDefault();void act('保存并关闭',closeDialog);}}>
        <div className="dialog-heading"><h2>回复 {thread.event.payload.actorName||'当前目标'}</h2>
          <button onClick={()=>void act('保存并关闭',closeDialog)}>关闭并保留草稿</button></div>
        {!thread.ownership.isMine&&!thread.intent&&<button onClick={()=>void act('继续写回复',openDialog)}>继续写回复</button>}
        <details className="identity"><summary>会话与作品信息</summary>
          <p>本人：{status.account?.identity} · 对方：{thread.event.payload.actorId}<br/>作品：{thread.event.payload.videoId} · 当前评论：{thread.event.payload.commentId}
            {thread.event.payload.rootCommentId&&<> · 所属根评论：{thread.event.payload.rootCommentId}</>}</p>
        </details>
        {thread.event.payload.kind==='REPLY'?<CommentThreadContext thread={thread}/>:<blockquote>{thread.event.payload.text}</blockquote>}
        {thread.event.payload.observationIssue&&<p className="hint">{reasons[thread.event.payload.observationIssue]??thread.event.payload.observationIssue}</p>}
        {thread.event.payload.kind!=='REPLY'&&<details><summary>上下文 · {thread.history.length} 条</summary>{thread.history.map((message,index)=><p key={index}>{message.direction==='OUTGOING'?'我方：':'对方：'}{message.text}</p>)}</details>}
        <ReplyComposer {...props} thread={thread}/>
      </dialog>
    </>}
  </section>;
}
