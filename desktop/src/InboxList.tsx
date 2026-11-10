import type {Inbox} from './api';
import {time} from './presentation';
import {MessageAttachments,isMediaPlaceholder} from './MessageAttachments';
import {validShare,sharedWorkLabel} from './ShareLink';
import {MessageText} from './MessageText';
import './inbox-channels.css';

interface InboxListProps {
  inbox:Inbox;selected:string|null;selectedGroup?:string;channel:'ALL'|'COMMENT_NOTIFICATION'|'DIRECT_MESSAGE';
  setChannel:(channel:InboxListProps['channel'])=>void;filter:'PENDING'|'CONFIRMED';setFilter:(filter:'PENDING'|'CONFIRMED')=>void;
  pageNumber:number;setPageNumber:(page:number)=>void;choose:(id:string)=>void;
}
export function InboxList({inbox,selected,selectedGroup,channel,setChannel,filter,setFilter,pageNumber,setPageNumber,choose}:InboxListProps){
  return <section className="inbox-list">
    <div className="filters">
      <div className="segments" aria-label="通道筛选">{(['ALL','COMMENT_NOTIFICATION','DIRECT_MESSAGE'] as const).map(value=><button key={value}
        data-channel={value} className={value===channel?'active':''} onClick={()=>{setChannel(value);setPageNumber(0);}}>
        {value==='ALL'?'全部':value==='DIRECT_MESSAGE'?'私信':'评论'}
      </button>)}</div>
      <select aria-label="任务状态" value={filter} onChange={event=>{setFilter(event.target.value as typeof filter);setPageNumber(0);}}>
        <option value="PENDING">等待回复</option><option value="CONFIRMED">已回复</option>
      </select>
      <small>{inbox.total} 个会话与评论</small>
    </div>
    <div className="task-list scroll">{inbox.items.map(item=>{
      const active=selected===item.id||!!selectedGroup&&item.groupKey===selectedGroup;
      const share=validShare(item.share);
      const attachmentPreview=!share&&item.previewEventId&&item.attachments?.length;
      return <button key={item.groupKey??item.id} data-channel={item.channel} className={'task '+(active?'selected':'')} aria-pressed={active} onClick={()=>{const target=item.resumeEventId??item.id;if(selected!==target)choose(target);}}>
        <div><strong>{item.author||'当前联系人'}</strong><span className={'badge '+(['UNCERTAIN','MANUAL_REVIEW'].includes(item.status)?'warn':'')}>
          {item.replyStatus==='REPLIED'?'已回复':'等待回复'}
        </span></div>
        {item.channel!=='DIRECT_MESSAGE'&&(item.commentCount??0)>0&&<small>评论串 · {item.commentCount} 条留言{item.waitingCount?` · ${item.waitingCount} 条待回复`:''}</small>}
        {(!!item.displayText||!attachmentPreview||!isMediaPlaceholder(item.preview))&&<p><MessageText text={item.displayText??(share?`分享${sharedWorkLabel(share)} · ${share.url}`:item.preview)}/></p>}
        {attachmentPreview&&item.previewEventId&&item.attachments?<MessageAttachments allowRefresh={false} message={{eventId:item.previewEventId,attachments:item.attachments.slice(0,1)}}/>:null}
        <small><span className="channel-label">{item.channel==='DIRECT_MESSAGE'?'私信':'评论'}</span> · {time(item.time)}
          {item.channel==='DIRECT_MESSAGE'&&item.messageCount?` · ${item.messageCount} 条入站`:''}</small>
      </button>;
    })}
      {!inbox.items.length&&<div className="empty"><strong>当前没有这类待办</strong><p>后台按已启用范围自动收取，新消息会显示在对应会话。</p></div>}
    </div>
    <div className="pager">
      <button disabled={pageNumber===0} onClick={()=>setPageNumber(pageNumber-1)}>上一页</button><span>{pageNumber+1}</span>
      <button disabled={(pageNumber+1)*inbox.pageSize>=inbox.total} onClick={()=>setPageNumber(pageNumber+1)}>下一页</button>
    </div>
  </section>;
}
