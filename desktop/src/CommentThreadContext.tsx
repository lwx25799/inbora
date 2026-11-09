import {useEffect,useRef,useState} from 'react';
import {request,type Thread} from './api';
import {time} from './presentation';

type Context=NonNullable<Thread['commentContext']>;
type Item=Context['items'][number];
const order=(a:Item,b:Item)=>Number(b.isRoot)-Number(a.isRoot)||(Date.parse(a.occurredAt??'')||0)-(Date.parse(b.occurredAt??'')||0)||a.id.localeCompare(b.id);

export function CommentThreadContext({thread}:{thread:Thread}){
  const context=thread.commentContext,key=`${thread.event.id}:${context?.projectionRevision??''}`;
  const [view,setView]=useState({key,context}),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const current=useRef(key);current.current=key;
  useEffect(()=>{setView({key,context});setLoading(false);setError('');},[key]);
  const shown=view.key===key?view.context:context;
  if(!shown)return <p className="hint">正在收取从一级根评论开始的上下文。</p>;
  async function older(){
    if(!shown?.before||loading)return;const expected=key;setLoading(true);setError('');
    try{
      const result=await request<Thread>({command:'getThread',eventId:thread.event.id,timelineBefore:shown.before});
      if(current.current!==expected||result.event.id!==thread.event.id||!result.commentContext)return;
      const next=result.commentContext;
      setView(prior=>{
        const retained=prior.key===expected&&prior.context?.projectionRevision===next.projectionRevision?prior.context.items:[];
        const items=new Map(retained.map(item=>[item.id,item]));
        for(const item of next.items)items.set(item.id,item);
        return {key:expected,context:{...next,items:[...items.values()].sort(order)}};
      });
    }catch{if(current.current===expected)setError('较早的评论暂未读取，请稍后再试。');}
    finally{if(current.current===expected)setLoading(false);}
  }
  return <section className="original" aria-label="评论完整上下文">
    <h3>评论对话</h3>
    {(shown.rootMissing||!shown.rootVerified||shown.rootAmbiguous)&&<p className="hint">一级根评论尚未完整收取，后台正在补齐；AI 暂不生成脱离根评论的回复。</p>}
    {shown.items.map(message=><article key={message.id} className={message.direction==='OUTGOING'?'outgoing':''}>
      <small>{message.isRoot?'一级根评论':message.direction==='OUTGOING'?'我方已回复':message.payload.actorName||'对方'}
        {message.direction==='INCOMING'&&message.payload.commentId===thread.event.payload.commentId?' · 当前回复目标':''} · {time(message.occurredAt)}</small>
      <p>{message.text}</p>
    </article>)}
    {!shown.items.some(item=>item.direction==='INCOMING'&&item.payload.commentId===thread.event.payload.commentId)&&<article>
      <small>当前回复目标 · {thread.event.payload.actorName||'对方'} · {time(thread.event.payload.occurredAt)}</small>
      <p>{thread.event.payload.text}</p>
    </article>}
    {shown.hasMore&&<button disabled={loading} onClick={()=>void older()}>{loading?'正在加载较早回复':'加载较早回复'}</button>}
    {error&&<p role="status" className="hint">{error}</p>}
  </section>;
}
