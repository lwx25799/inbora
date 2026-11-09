import {useEffect,useRef,useState} from 'react';
import {request,reasons,type BrowserDraftChoice} from './api';

export function BrowserDraftRecovery({busy,act}:{busy:string;act:(label:string,run:()=>Promise<void>)=>Promise<void>}){
  const [choice,setChoice]=useState<BrowserDraftChoice|null>(null),[message,setMessage]=useState('正在检查当前网页未发送内容…');
  const sequence=useRef(0),mounted=useRef(false),stopAutomatic=useRef(false);
  useEffect(()=>{mounted.current=true;stopAutomatic.current=false;let attempts=0,timer:ReturnType<typeof setTimeout>|undefined;
    const check=async()=>{
      if(!mounted.current||stopAutomatic.current)return;const id=++sequence.current;attempts++;
      setMessage('正在检查当前网页未发送内容…');
      try{
        const value=await request<BrowserDraftChoice|null>({command:'browser',action:'inspectSavedDraftRecovery'});
        if(!mounted.current||id!==sequence.current)return;
        setChoice(value);setMessage(value?'':'当前没有可安全清理的已保存自动回复稿，网页输入已保留。');
        if(value)stopAutomatic.current=true;
      }catch{if(mounted.current&&id===sequence.current)setMessage('暂时无法核对当前网页未发送内容，应用回复稿和网页输入均已保留。');}
      if(mounted.current&&id===sequence.current&&!stopAutomatic.current&&attempts<4)timer=setTimeout(()=>void check(),15_000);
    };
    void check();
    return()=>{mounted.current=false;sequence.current++;clearTimeout(timer);};
  },[]);
  return <section aria-label="网页未发送内容恢复">
    <h3>网页未发送内容恢复</h3>
    <p className="hint">保留已保存的应用回复草稿和版本，仅清空当前准确会话中与该自动回复稿完全一致的网页未发送内容；不会发送或重试。</p>
    {choice&&<>
      <p>私信 · {choice.author??'当前会话'} · 已保存版本 {choice.draftVersion}</p>
      <blockquote>{choice.originalText}</blockquote>
      <p className="message-text">{choice.text}</p>
      <button disabled={!!busy} onClick={()=>void act('清空网页未发送内容',async()=>{
        stopAutomatic.current=true;const id=++sequence.current;
        try{
          await request({command:'browser',action:'clearSavedDraftRecovery',eventId:choice.eventId,draftId:choice.draftId,draftVersion:choice.draftVersion,
            expectedText:choice.text,contextVersion:choice.contextVersion,confirmed:true});
          if(mounted.current&&id===sequence.current){setChoice(null);setMessage('网页未发送内容已清空，应用回复草稿和版本已保留；未发送或重试。');}
        }catch(error){const code=typeof error==='string'?error:error instanceof Error?error.message:'';
          if(mounted.current&&id===sequence.current)setMessage(reasons[code]??'未能安全清理网页内容，应用回复稿和网页输入已保留，请重新检查。');throw error;}
      })}>保留应用回复稿并清空网页未发送内容</button>
    </>}
    {message&&<p className="hint" role="status">{message}</p>}
    <button disabled={!!busy} onClick={()=>void act('检查网页未发送内容',async()=>{
      stopAutomatic.current=true;const id=++sequence.current,value=await request<BrowserDraftChoice|null>({command:'browser',action:'inspectSavedDraftRecovery'});
      if(mounted.current&&id===sequence.current){setChoice(value);setMessage(value?'':'当前没有可安全清理的已保存自动回复稿，网页输入已保留。');}
    })}>重新检查网页未发送内容</button>
  </section>;
}
