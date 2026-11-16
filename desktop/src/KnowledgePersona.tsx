import {useState} from 'react';
import type {PersonaVersion} from '../../src/knowledge/contracts.js';
import {formatDate,type KnowledgePanelProps} from './knowledge-client';

const personaNames:Record<PersonaVersion['state'],string>={DRAFT:'草稿',PUBLISHED:'当前发布',ARCHIVED:'历史版本',INVALID:'来源已失效'};
interface AnalysisResult {taskId:string;persona:PersonaVersion;calls:number;usedCount:number;omittedCount:number}

export function KnowledgePersona({overview,busy,perform}:KnowledgePanelProps) {
  const active=overview.activePersona;
  const [draft,setDraft]=useState(''),[sampleIds,setSampleIds]=useState<string[]>([]),[editingId,setEditingId]=useState<string|null>(null);
  const [consent,setConsent]=useState(false),[result,setResult]=useState('');
  const load=(persona:PersonaVersion)=>{setDraft(persona.text);setSampleIds(persona.sampleIds);setEditingId(persona.id);setResult('');};
  const publishedText=active?.text??'';
  const previousLines=publishedText.split('\n').filter(line=>line.trim()),candidateLines=draft.split('\n').filter(line=>line.trim());
  const removed=previousLines.filter(line=>!candidateLines.includes(line)),added=candidateLines.filter(line=>!previousLines.includes(line));
  const analyze=(taskId?:string)=>void perform<AnalysisResult>(taskId?'继续上次分析':'学习回复人格',{
    action:'analyze',sampleIds:[],...(taskId?{taskId}:{}),confirmed:true,
  },value=>{load(value.persona);setResult(`本次使用 ${value.usedCount} 组样本，因长度限制略过 ${value.omittedCount} 组；完成 ${value.calls} 次模型调用。候选人格检查并发布后才生效。`);});
  const unfinished=overview.learningTasks.filter(task=>task.state==='RUNNING'||task.state==='FAILED');
  return <div className="knowledge-persona">
    <div className="knowledge-toolbar"><div><h3>学习你的表达方式</h3><p className="hint">当前人格：{active?`发布于 ${formatDate(active.createdAt)}`:'尚未发布，沿用已有账号人设'}</p></div>
      <button disabled={busy||!active} onClick={()=>{if(active)load(active);}}>复制当前人格到编辑区</button></div>
    <p className="hint">从已采纳的本人回复中提炼语气、称呼、句式和表达边界，每次最多200组、6次模型调用，按实际样本量与长度计算。知识事实独立维护，不从聊天中自动提取价格或承诺。</p>
    <label className="check"><input type="checkbox" checked={consent} disabled={busy} onChange={event=>setConsent(event.target.checked)}/>
      我同意将必要的已采纳样本片段发送给当前模型，用于本次人格学习，并计入已有模型额度。</label>
    <button disabled={busy||!consent||overview.totals.accepted===0} onClick={()=>analyze()}>从已采纳样本学习</button>
    {unfinished.length>0&&<details className="knowledge-history"><summary>未完成的分析 · {unfinished.length} 个</summary>
      <p className="hint">继续时复用已完成批次，只调用剩余步骤。样本选择或模型已变化时需要重新学习。</p>
      {unfinished.map((task,index)=><div key={task.id} className="knowledge-entry">
        <p>分析 {index+1} · {task.state==='FAILED'?'上次未完成':'处理中或中断'} · 已完成 {task.completed} 个步骤</p>
        <button disabled={busy||!consent} onClick={()=>analyze(task.id)}>继续上次分析</button>
      </div>)}
    </details>}
    {result&&<p role="status" className="hint">{result}</p>}
    <div className="knowledge-persona-comparison"><div><h4>当前已发布人格</h4>
      <pre className="knowledge-text-preview">{publishedText||'尚未发布人格。现有账号人设继续生效。'}</pre></div>
      <form onSubmit={event=>{event.preventDefault();if(!draft.trim()||busy)return;void perform<PersonaVersion>('保存人格草稿',{
        action:'savePersona',text:draft,sampleIds,
      },value=>{setEditingId(value.id);setResult('人格草稿已保存，尚未发布。');});}}>
        <h4>候选人格与人工修改</h4><label>人格内容<textarea aria-label="人格内容" rows={10} maxLength={2000} disabled={busy} value={draft}
          onChange={event=>{setDraft(event.target.value);setEditingId(null);setResult('');}}/></label>
        <p className="hint">{draft.length}/2000 字 · 关联样本 {sampleIds.length} 组{draft===publishedText&&draft?' · 与当前人格一致':''}</p>
        {draft&&draft!==publishedText&&<details className="knowledge-persona-diff"><summary>与当前人格的段落差异</summary>
          {removed.map((line,index)=><p key={`removed-${index}`}><del>移除：{line}</del></p>)}
          {added.map((line,index)=><p key={`added-${index}`}><ins>新增：{line}</ins></p>)}
        </details>}
        <div className="row"><button type="submit" disabled={busy||!draft.trim()}>保存人格草稿</button>
          <button className="primary" type="button" disabled={busy||!editingId||!draft.trim()||draft===publishedText} onClick={()=>{
            if(editingId)void perform('发布回复人格',{action:'publishPersona',id:editingId},()=>setResult('人格已发布，后续生成使用新版本。'));
          }}>发布此人格</button></div>
      </form></div>
    <details className="knowledge-history"><summary>人格版本记录 · {overview.personas.length} 个</summary>
      {overview.personas.length===0?<p className="hint">还没有保存过人格版本。</p>:overview.personas.map(persona=><article key={persona.id} className="knowledge-entry">
        <div className="knowledge-entry-heading"><h4>{formatDate(persona.createdAt)}</h4><span className="knowledge-state">{personaNames[persona.state]}</span></div>
        <p className="knowledge-excerpt">{persona.text.slice(0,240)}</p><p className="hint">关联样本 {persona.sampleIds.length} 组</p>
        <div className="row"><button disabled={busy} onClick={()=>load(persona)}>查看并编辑</button>
          {persona.state==='ARCHIVED'&&<button disabled={busy} onClick={()=>void perform('回退回复人格',{action:'publishPersona',id:persona.id})}>恢复此版本</button>}</div>
      </article>)}
    </details>
  </div>;
}
