import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {request,reasons,type Thread,type TimelineItem} from './api';
import {time} from './presentation';
import {ReplyComposer} from './ReplyComposer';
import {MessageAttachments} from './MessageAttachments';
import type {ReplyViewProps} from './reply-view-types';
import './chat.css';

type Timeline=NonNullable<Thread['timeline']>;
const empty:Timeline={items:[],pageSize:30,hasMore:false,before:null};
const mediaPlaceholders={IMAGE:'[图片或表情消息，需人工查看]',VIDEO:'[视频消息，需人工查看]',AUDIO:'[音频消息，需人工查看]',MIXED:'[含媒体的消息，需人工查看]'};
const imageReplacesPlaceholder=(message:TimelineItem)=>message.observationIssue==='DM_CONTENT_UNVERIFIED'&&message.contentType&&
  message.text===mediaPlaceholders[message.contentType]&&message.attachments.some(item=>item.state==='READY');
const compare=(a:TimelineItem,b:TimelineItem)=>(Date.parse(a.occurredAt??'')||0)-(Date.parse(b.occurredAt??'')||0)||a.id.localeCompare(b.id);
function merge(prior:TimelineItem[],next:TimelineItem[]){
  const incoming=new Map(next.map(item=>[item.id,item]));
  const retained=prior.map(item=>incoming.get(item.id)??item),seen=new Set(prior.map(item=>item.id));
  const additions=next.filter(item=>!seen.has(item.id));return [...retained,...additions].sort(compare);
}

export function DirectMessageChat(props:ReplyViewProps & {thread:Thread}){
  const {thread,status,busy,act,setNotice}=props;
  const group=thread.groupKey??JSON.stringify([thread.event.payload.accountId,thread.event.payload.conversationId]);
  const revision=`${group}:${thread.timeline?.projectionRevision??''}:${thread.frozen}:${thread.verification?.verified??''}`;
  const [view,setView]=useState({key:revision,timeline:thread.timeline??empty,expanded:false});
  const [loading,setLoading]=useState(false),[error,setError]=useState('');
  const current=useRef({group,eventId:thread.event.id});current.current={group,eventId:thread.event.id};
  const scroll=useRef<HTMLDivElement|null>(null),nearBottom=useRef(true),olderHeight=useRef<number|null>(null);
  const visible=view.key===revision?view.timeline:thread.timeline??empty;
  if(view.key!==revision){nearBottom.current=true;olderHeight.current=null;}
  useEffect(()=>{
    const latest=thread.timeline??empty;
    setView(prior=>{
      if(prior.key!==revision)return {key:revision,timeline:latest,expanded:false};
      const oldest=latest.items[0],older=prior.expanded&&latest.hasMore&&oldest?prior.timeline.items.filter(item=>compare(item,oldest)<0):[];
      return {...prior,timeline:{...latest,items:merge(older,latest.items),
        before:prior.expanded?prior.timeline.before:latest.before,hasMore:prior.expanded?prior.timeline.hasMore:latest.hasMore}};
    });
    setError('');setLoading(false);
  },[revision,thread.timeline]);
  useLayoutEffect(()=>{
    const container=scroll.current;if(!container)return;
    if(olderHeight.current!==null){container.scrollTop+=container.scrollHeight-olderHeight.current;olderHeight.current=null;}
    else if(nearBottom.current)container.scrollTop=container.scrollHeight;
  },[visible.items]);
  async function loadOlder(){
    if(loading||!visible.before)return;
    const expected={...current.current},before=visible.before;setLoading(true);setError('');
    try{
      const next=await request<Thread>({command:'getThread',eventId:expected.eventId,timelineBefore:before});
      if(current.current.group!==expected.group||current.current.eventId!==expected.eventId||!next.timeline)return;
      olderHeight.current=scroll.current?.scrollHeight??null;
      setView(prior=>prior.key===revision?{key:revision,expanded:true,timeline:{...next.timeline!,items:merge(prior.timeline.items,next.timeline!.items)}}:prior);
    }catch{if(current.current.group===expected.group)setError('更早消息暂未读取完成，请稍后重试。');}
    finally{if(current.current.group===expected.group)setLoading(false);}
  }
  return <section className="detail chat-detail" aria-label="私信会话">
    <header className="chat-heading">
      <div><p className="eyebrow">私信会话</p><h2>{thread.event.payload.actorName||'当前联系人'}</h2></div>
      <span className="badge">{thread.replyStatus==='REPLIED'?'已回复':'等待回复'}</span>
      <details className="chat-information"><summary>会话信息</summary>
        <p>本人：{status.account?.identity??'已绑定账号'}<br/>对方：{thread.event.payload.actorId??'身份待核对'}<br/>会话：{thread.event.payload.conversationId}</p>
        <button disabled={!!busy} onClick={()=>void act('打开准确会话',async()=>{await request({command:'openTarget',eventId:thread.event.id});setNotice('已在专属浏览器中定位，未填写或发送');})}>在专属浏览器查看原对象</button>
      </details>
    </header>
    <div ref={scroll} className="chat-messages scroll" role="log" aria-label="私信消息流" aria-live="polite"
      onScroll={()=>{const container=scroll.current;if(container)nearBottom.current=container.scrollHeight-container.scrollTop-container.clientHeight<60;}}>
      {visible.hasMore&&<button className="load-earlier" disabled={loading} onClick={()=>void loadOlder()}>{loading?'正在读取更早消息':'加载更早消息'}</button>}
      {error&&<p role="alert" className="hint">{error}</p>}
      {!visible.items.length&&<p className="empty">正在读取会话消息</p>}
      {visible.items.map(message=><article key={message.id} className={'chat-message '+(message.direction==='OUTGOING'?'outgoing':'incoming')}>
        <small>{message.direction==='OUTGOING'?message.origin==='CONFIRMED'?'我方已回复':'我方消息':'对方'} · {time(message.occurredAt)}{message.historical?' · 历史消息':''}</small>
        <div className="message-bubble">{!imageReplacesPlaceholder(message)&&<p>{message.text}</p>}<MessageAttachments message={message}/>
          {message.observationIssue&&<p className="message-quality">{reasons[message.observationIssue]??'此消息需人工查看'}</p>}
        </div>
      </article>)}
    </div>
    <ReplyComposer {...props}/>
  </section>;
}
