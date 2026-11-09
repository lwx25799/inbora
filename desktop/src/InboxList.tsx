import type {Inbox} from './api';
import {time} from './presentation';
import {MessageAttachments} from './MessageAttachments';

interface InboxListProps {
  inbox:Inbox;selected:string|null;selectedGroup?:string;channel:'ALL'|'COMMENT_NOTIFICATION'|'DIRECT_MESSAGE';
  setChannel:(channel:InboxListProps['channel'])=>void;filter:'PENDING'|'CONFIRMED';setFilter:(filter:'PENDING'|'CONFIRMED')=>void;
  pageNumber:number;setPageNumber:(page:number)=>void;choose:(id:string)=>void;
}
export function InboxList({inbox,selected,selectedGroup,channel,setChannel,filter,setFilter,pageNumber,setPageNumber,choose}:InboxListProps){
  return <section className="inbox-list">
    <div className="filters">
      <div className="segments" aria-label="通道筛选">{(['ALL','COMMENT_NOTIFICATION','DIRECT_MESSAGE'] as const).map(value=><button key={value}
        className={value===channel?'active':''} onClick={()=>{setChannel(value);setPageNumber(0);}}>
        {value==='ALL'?'全部':value==='DIRECT_MESSAGE'?'私信':'评论'}
      </button>)}</div>
      <select aria-label="任务状态" value={filter} onChange={event=>{setFilter(event.target.value as typeof filter);setPageNumber(0);}}>
        <option value="PENDING">等待回复</option><option value="CONFIRMED">已回复</option>
      </select>
      <small>{inbox.total} 个会话与评论</small>
    </div>
    <div className="task-list scroll">{inbox.items.map(item=>{
      const active=selected===item.id||!!selectedGroup&&item.groupKey===selectedGroup;
      return <button key={item.groupKey??item.id} className={'task '+(active?'selected':'')} aria-pressed={active} onClick={()=>{if(!active)choose(item.resumeEventId??item.id);}}>
        <div><strong>{item.author||'当前联系人'}</strong><span className={'badge '+(['UNCERTAIN','MANUAL_REVIEW'].includes(item.status)?'warn':'')}>
          {item.replyStatus==='REPLIED'?'已回复':'等待回复'}
        </span></div>
        <p>{item.attachments?.[0]?.label||item.preview}</p>
        {item.previewEventId&&item.attachments?.length?<MessageAttachments message={{eventId:item.previewEventId,attachments:item.attachments.slice(0,1)}}/>:null}
        <small>{item.channel==='DIRECT_MESSAGE'?'私信':'评论'} · {time(item.time)}
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
