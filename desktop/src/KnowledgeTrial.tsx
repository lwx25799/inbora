import {useState} from 'react';
import type {Channel} from '../../src/core/contracts.js';
import {formatDate,type KnowledgePanelProps} from './knowledge-client';

interface TrialReply {text:string;model:string;personaId:string|null;fingerprint:string;
  knowledge?:{id:string;title:string;version:number}[];conflicts?:string[]}
interface TrialResult {current:TrialReply;comparison?:TrialReply;currentContext?:{knowledge?:{id:string;title:string;version:number}[];conflicts?:string[]}}

export function KnowledgeTrial({overview,busy,perform}:KnowledgePanelProps) {
  const [channel,setChannel]=useState<Channel>('DIRECT_MESSAGE'),[message,setMessage]=useState('');
  const [persona,setPersona]=useState('current'),[comparison,setComparison]=useState('none');
  const [sourceIds,setSourceIds]=useState<string[]>([]),[consent,setConsent]=useState(false),[result,setResult]=useState<TrialResult|null>(null);
  const [submitted,setSubmitted]=useState('');
  const personas=[...(overview.activePersona?[overview.activePersona]:[]),...overview.personas.filter(value=>value.id!==overview.activePersonaId&&value.state!=='INVALID')];
  const selectableSources=overview.sources.filter(source=>source.kind==='KNOWLEDGE'||source.kind==='MANUAL');
  const id=(value:string)=>value==='current'?overview.activePersonaId:value==='baseline'?null:value;
  return <div className="knowledge-trial"><h3>先试聊，再用于日常回复</h3>
    <p className="hint">此处只生成模拟回复，不操作网页、不创建发送意图。每个所选人格单独调用一次模型；对比将计入两次模型额度。</p>
    <form onSubmit={event=>{event.preventDefault();if(!message.trim()||!consent||busy)return;const text=message;
      void perform<TrialResult>('生成试聊回复',{action:'tryReply',channel,message:text,sourceIds,personaVersionId:id(persona),
        ...(comparison!=='none'?{comparePersonaVersionId:id(comparison)}:{}),confirmed:true},value=>{setResult(value);setSubmitted(text);},false);
    }}>
      <div className="knowledge-fields"><label>模拟通道<select aria-label="模拟通道" value={channel} disabled={busy} onChange={event=>setChannel(event.target.value as Channel)}>
        <option value="DIRECT_MESSAGE">私信</option><option value="COMMENT_NOTIFICATION">评论</option></select></label>
        <label>本次人格<select aria-label="本次人格" value={persona} disabled={busy} onChange={event=>setPersona(event.target.value)}>
          <option value="current">当前已发布人格</option><option value="baseline">仅现有账号人设</option>
          {personas.map(value=><option key={value.id} value={value.id}>{formatDate(value.createdAt)} · {value.state==='DRAFT'?'草稿':'已保存版本'}</option>)}
        </select></label>
        <label>对比人格<select aria-label="对比人格" value={comparison} disabled={busy} onChange={event=>setComparison(event.target.value)}>
          <option value="none">不对比</option><option value="baseline">仅现有账号人设</option><option value="current">当前已发布人格</option>
          {personas.map(value=><option key={value.id} value={value.id}>{formatDate(value.createdAt)} · {value.state==='DRAFT'?'草稿':'已保存版本'}</option>)}
        </select></label></div>
      <details><summary>本次知识来源 · {sourceIds.length?`指定 ${sourceIds.length} 个`:'全部已启用知识'}</summary>
        <p className="hint">未勾选时使用本账号全部已启用且当前有效的知识；指定来源仍只检索已启用条目。</p>
        {selectableSources.map(source=><label className="check" key={source.id}><input type="checkbox" checked={sourceIds.includes(source.id)} disabled={busy}
          onChange={event=>setSourceIds(previous=>event.target.checked?[...previous,source.id]:previous.filter(value=>value!==source.id))}/>{source.title}</label>)}
      </details>
      <label>模拟来信<textarea aria-label="模拟来信" rows={4} maxLength={4000} value={message} disabled={busy} onChange={event=>setMessage(event.target.value)}/></label>
      <label className="check"><input type="checkbox" checked={consent} disabled={busy} onChange={event=>setConsent(event.target.checked)}/>
        我同意将这条模拟来信、所选人格及必要知识和样本片段发送给当前模型，并计入已有模型额度。</label>
      <button className="primary" type="submit" disabled={busy||!message.trim()||!consent||comparison!=='none'&&id(comparison)===id(persona)}>生成试聊回复{comparison!=='none'?'并对比':''}</button>
      {comparison!=='none'&&id(comparison)===id(persona)&&<p className="hint">请选择两个不同的人格进行对比。</p>}
    </form>
    {result&&<div className="knowledge-trial-result"><h4>本次模拟来信</h4><p className="knowledge-quote">{submitted}</p>
      <div className={`knowledge-trial-answers ${result.comparison?'comparison':''}`}>
        {([['本次人格回复',result.current],['对比人格回复',result.comparison]] as const).map(([title,value])=>value&&<article key={title}>
          <h4>{title}</h4><p className="knowledge-answer">{value.text}</p><p className="hint">模型：{value.model} · 仅试聊，未发送</p>
        </article>)}
      </div>
      {!!(result.current.knowledge??result.currentContext?.knowledge)?.length&&<details><summary>本次引用知识</summary>
        {(result.current.knowledge??result.currentContext?.knowledge??[]).map(value=><p key={value.id}>{value.title} · v{value.version}</p>)}</details>}
      {!!(result.current.conflicts??result.currentContext?.conflicts)?.length&&<p className="knowledge-warning">检索到知识冲突，请检查来源后再用于正式回复。</p>}
    </div>}
  </div>;
}
