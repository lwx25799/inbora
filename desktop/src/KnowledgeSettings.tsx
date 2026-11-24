import {useEffect,useRef,useState} from 'react';
import type {KnowledgeOverview} from '../../src/contracts/knowledge.js';
import {KnowledgeDocuments} from './KnowledgeDocuments';
import {KnowledgeSamples} from './KnowledgeSamples';
import {KnowledgePersona} from './KnowledgePersona';
import {KnowledgeTrial} from './KnowledgeTrial';
import {describeKnowledgeError,knowledgeRequest,type KnowledgeAction} from './knowledge-client';
import './knowledge.css';

const tabs=[['knowledge','知识库'],['samples','聊天样本'],['persona','回复人格'],['trial','试聊']] as const;
type Tab=typeof tabs[number][0];

export function KnowledgeSettings({accountId,disabled=false}:{accountId:string|null;disabled?:boolean}) {
  const [tab,setTab]=useState<Tab>('knowledge');
  const [overview,setOverview]=useState<KnowledgeOverview|null>(null);
  const [busy,setBusy]=useState(''),[error,setError]=useState(''),[message,setMessage]=useState('');
  const alive=useRef(true),pending=useRef(false),generation=useRef(0);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;};},[]);
  async function perform<T>(label:string,action:KnowledgeAction|(()=>Promise<T>),onSuccess?:(result:T)=>void,refresh=true):Promise<void> {
    if(pending.current||disabled||!accountId)return;
    const epoch=generation.current;pending.current=true;setBusy(label);setError('');setMessage('');
    const current=()=>alive.current&&generation.current===epoch;
    try{
      const result=typeof action==='function'?await action():await knowledgeRequest<T>(action);
      if(!current())return;
      onSuccess?.(result);
      if(typeof action!=='function'&&action.action==='overview')setOverview(result as KnowledgeOverview);
      else if(refresh){const next=await knowledgeRequest<KnowledgeOverview>({action:'overview',page:overview?.page??0});if(current())setOverview(next);}
      if(current())setMessage(typeof action!=='function'&&action.action==='overview'?'资料已更新':`${label}已完成`);
    }catch(failure){
      if(current())setError(describeKnowledgeError(failure));
      if(current()&&typeof action!=='function'&&action.action==='analyze'){
        const next=await knowledgeRequest<KnowledgeOverview>({action:'overview',page:overview?.page??0}).catch(()=>null);
        if(current()&&next)setOverview(next);
      }
    }
    finally{if(current()){pending.current=false;setBusy('');}}
  }
  useEffect(()=>{
    const epoch=++generation.current;pending.current=false;setBusy('');setOverview(null);setError('');setMessage('');
    if(!accountId)return;
    let cancelled=false;setBusy('读取资料');pending.current=true;
    void knowledgeRequest<KnowledgeOverview>({action:'overview'}).then(result=>{
      if(!cancelled&&alive.current&&generation.current===epoch)setOverview(result);
    }).catch(failure=>{if(!cancelled&&alive.current&&generation.current===epoch)setError(describeKnowledgeError(failure));})
      .finally(()=>{if(!cancelled&&alive.current&&generation.current===epoch){pending.current=false;setBusy('');}});
    return()=>{cancelled=true;};
  },[accountId]);
  const locked=disabled||!!busy||!accountId;
  const panel=overview?{overview,busy:locked||!overview.available,perform}:null;
  return <div className="settings-section knowledge-settings" aria-labelledby="reply-knowledge-title">
    <div className="knowledge-heading"><div><h2 id="reply-knowledge-title">知识与回复人格</h2>
      <p className="hint">知识决定事实，聊天样本用于学习你的表达。资料保存在本机，模型仅接收必要片段。</p></div>
      <button disabled={locked} onClick={()=>void perform('读取资料',{action:'overview',page:overview?.page??0})}>重新读取</button></div>
    <div className="knowledge-tabs" role="tablist" aria-label="知识与人格功能">
      {tabs.map(([value,label])=><button id={`knowledge-tab-${value}`} role="tab" type="button" key={value}
        aria-selected={tab===value} aria-controls={`knowledge-panel-${value}`} tabIndex={tab===value?0:-1}
        onClick={()=>setTab(value)} onKeyDown={event=>{
          const index=tabs.findIndex(([id])=>id===tab);
          const next=event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:
            event.key==='Home'?0:event.key==='End'?tabs.length-1:-1;
          if(next>=0){event.preventDefault();setTab(tabs[next][0]);document.getElementById(`knowledge-tab-${tabs[next][0]}`)?.focus();}
        }}>{label}</button>)}
    </div>
    <div className="knowledge-feedback" aria-live="polite">{busy?<p role="status">{busy}…</p>:error?<p role="alert" className="error">{error}</p>:message?<p role="status">{message}</p>:null}</div>
    {!accountId&&<p className="hint">连接本人账号后可管理此账号的知识与人格。</p>}
    {overview&&!overview.available&&<p className="hint">资料存储尚未就绪，暂不能导入或生成。</p>}
    {panel&&overview&&<>
      <section id="knowledge-panel-knowledge" role="tabpanel" aria-labelledby="knowledge-tab-knowledge" hidden={tab!=='knowledge'}><KnowledgeDocuments {...panel}/></section>
      <section id="knowledge-panel-samples" role="tabpanel" aria-labelledby="knowledge-tab-samples" hidden={tab!=='samples'}><KnowledgeSamples {...panel}/></section>
      <section id="knowledge-panel-persona" role="tabpanel" aria-labelledby="knowledge-tab-persona" hidden={tab!=='persona'}><KnowledgePersona {...panel}/></section>
      <section id="knowledge-panel-trial" role="tabpanel" aria-labelledby="knowledge-tab-trial" hidden={tab!=='trial'}><KnowledgeTrial {...panel}/></section>
      <div className="knowledge-pagination"><span>第 {overview.page+1} 页 · 知识 {overview.totals.knowledge} 条 · 样本 {overview.totals.samples} 条</span>
        <button disabled={locked||overview.page<=0} onClick={()=>void perform('读取上一页',{action:'overview',page:overview.page-1})}>上一页</button>
        <button disabled={locked||Math.max(overview.totals.knowledge,overview.totals.samples,overview.totals.sources,overview.totals.personas)<=(overview.page+1)*overview.pageSize}
          onClick={()=>void perform('读取下一页',{action:'overview',page:overview.page+1})}>下一页</button></div>
    </>}
  </div>;
}
