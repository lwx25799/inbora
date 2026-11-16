import {useState} from 'react';
import {channelName,sourceNames,type KnowledgePanelProps} from './knowledge-client';
import {KnowledgeImport} from './KnowledgeImport';

export function KnowledgeSamples({overview,busy,perform}:KnowledgePanelProps) {
  const [selected,setSelected]=useState<string[]>([]),[filter,setFilter]=useState<'all'|'pending'|'accepted'|'excluded'>('pending');
  const [deleteId,setDeleteId]=useState<string|null>(null);
  const rows=overview.samples.filter(sample=>filter==='all'||filter==='accepted'&&sample.accepted&&!sample.excluded||
    filter==='excluded'&&sample.excluded||filter==='pending'&&!sample.accepted&&!sample.excluded);
  const visibleIds=new Set(rows.map(row=>row.id)),ids=selected.filter(id=>visibleIds.has(id));
  const canAccept=ids.length>0&&rows.filter(sample=>ids.includes(sample.id)).every(sample=>!sample.excluded||sample.reason==='USER_EXCLUDED');
  const choose=(id:string,checked:boolean)=>setSelected(previous=>checked?[...new Set([...previous,id])]:previous.filter(value=>value!==id));
  return <div className="knowledge-samples">
    <div className="knowledge-toolbar"><div><h3>选择你的回复样本</h3><p className="hint">已采纳 {overview.totals.accepted} 组 · 留出评估 {overview.totals.holdout} 组</p></div>
      <button disabled={busy} onClick={()=>void perform('收集本人回复候选',{action:'collectCandidates'})}>从 Inbora 收集候选</button></div>
    <p className="hint">先预览再采纳。自动回复和来源不明的记录不会自动成为本人的示范，留出样本仅用于评估。</p>
    <KnowledgeImport kind="CHAT" busy={busy} perform={perform}/>
    <details className="knowledge-history"><summary>管理聊天来源</summary>
      {overview.sources.filter(source=>source.kind==='CHAT').map(source=><article key={source.id} className="knowledge-entry">
        <div className="knowledge-entry-heading"><h4>{source.title}</h4><button className="danger" disabled={busy} onClick={()=>setDeleteId(source.id)}>删除聊天来源</button></div>
        {deleteId===source.id&&<div className="knowledge-confirm"><p>删除此来源的全部样本及其检索片段？关联人格将失效，原始会话和发送记录保留。</p>
          <div className="row"><button className="danger" disabled={busy} onClick={()=>void perform('删除聊天来源',{action:'deleteSource',sourceId:source.id},()=>setDeleteId(null))}>确认删除聊天来源</button>
            <button disabled={busy} onClick={()=>setDeleteId(null)}>保留聊天来源</button></div></div>}
      </article>)}
    </details>
    <div className="knowledge-toolbar"><label className="knowledge-filter">样本筛选<select aria-label="样本筛选" value={filter} onChange={event=>{setFilter(event.target.value as typeof filter);setSelected([]);}}>
      <option value="pending">待选择</option><option value="accepted">已采纳</option><option value="excluded">已排除</option><option value="all">全部</option>
    </select></label>
      <div className="row"><button disabled={busy||!rows.length} onClick={()=>setSelected(ids.length===rows.length?[]:rows.map(row=>row.id))}>{ids.length===rows.length&&rows.length?'取消本页全选':'选择本页'}</button>
        <button className="primary" disabled={busy||!canAccept} onClick={()=>void perform('采纳所选样本',{action:'selectSamples',ids,accepted:true},()=>setSelected([]))}>采纳所选 {ids.length||''}</button>
        <button disabled={busy||!ids.length} onClick={()=>void perform('排除所选样本',{action:'selectSamples',ids,accepted:false},()=>setSelected([]))}>排除所选</button></div></div>
    {!!ids.length&&!canAccept&&<p className="hint">所选记录含自动排除的敏感内容或纯自动回复，不能直接采纳。手动排除的样本可重新采纳。</p>}
    {rows.length===0?<p className="knowledge-empty">本页没有符合筛选的样本。可收集候选、导入聊天记录，或切换筛选。</p>:<div className="knowledge-sample-list">
      {rows.map(sample=><article className="knowledge-sample" key={sample.id}>
        <div className="knowledge-entry-heading"><label className="check"><input type="checkbox" disabled={busy} checked={ids.includes(sample.id)}
          aria-label={`选择样本：${sample.prompt.slice(0,30)}`} onChange={event=>choose(sample.id,event.target.checked)}/>
          {channelName(sample.channel)} · {sourceNames[sample.source]??'来源待确认'}</label>
          <span className="knowledge-state">{sample.excluded?'已排除':sample.accepted?'已采纳':'待选择'}{sample.holdout?' · 留出评估':''}</span></div>
        <dl><dt>对方</dt><dd>{sample.prompt}</dd><dt>本人回复</dt><dd>{sample.response}</dd></dl>
        {sample.reason&&<p className="hint">{sample.reason==='USER_EXCLUDED'?'已由你排除，可重新选择并采纳':sample.reason==='SENSITIVE_SAMPLE'||sample.reason==='SENSITIVE_CONTENT'?'包含敏感信息，不参与模型学习':sample.reason==='UNTRUSTED_INSTRUCTION'?'包含变更规则或泄密指令，不参与学习':sample.reason==='SOURCE_UNVERIFIED'?'来源尚未确认':sample.reason==='AI_GENERATED'?'纯自动回复，不作为本人示范':'该样本需要人工检查后选择'}</p>}
      </article>)}
    </div>}
  </div>;
}
