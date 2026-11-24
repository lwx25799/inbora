import {useState} from 'react';
import type {KnowledgeEntry,KnowledgeInput} from '../../src/contracts/knowledge.js';
import type {Channel} from '../../src/contracts/events.js';
import {channelName,formatDate,type KnowledgePanelProps} from './knowledge-client';
import {KnowledgeImport} from './KnowledgeImport';

const empty=()=>({id:undefined as string|undefined,title:'',topic:'',text:'',aliases:'',channels:['DIRECT_MESSAGE','COMMENT_NOTIFICATION'] as Channel[],
  effectiveAt:'',expiresAt:'',expectedVersion:undefined as number|undefined});
const toInputDate=(value:number|null)=>value===null?'':new Date(value-new Date(value).getTimezoneOffset()*60_000).toISOString().slice(0,16);

export function KnowledgeDocuments({overview,busy,perform}:KnowledgePanelProps) {
  const [draft,setDraft]=useState(empty),[deleteId,setDeleteId]=useState<string|null>(null);
  const edit=(entry:KnowledgeEntry)=>setDraft({id:entry.id,title:entry.title,topic:entry.topic,text:entry.text,aliases:entry.aliases.join('，'),
    channels:entry.channels,effectiveAt:toInputDate(entry.effectiveAt),expiresAt:toInputDate(entry.expiresAt),expectedVersion:entry.version});
  const aliases=draft.aliases.split(/[,，\n]/u).map(value=>value.trim()).filter(Boolean);
  const valid=!!draft.title.trim()&&!!draft.topic.trim()&&!!draft.text.trim()&&draft.channels.length>0&&
    aliases.length<=30&&aliases.every(value=>value.length<=100)&&
    (!draft.effectiveAt||!draft.expiresAt||Date.parse(draft.expiresAt)>Date.parse(draft.effectiveAt));
  return <div className="knowledge-documents">
    <p className="hint">新增或编辑后保存为停用条目，启用后才参与回复。事实冲突、过期或未生效的知识不会被当成确定答案。</p>
    <KnowledgeImport kind="KNOWLEDGE" busy={busy} perform={perform}/>
    <div className="knowledge-workspace">
      <div className="knowledge-list" aria-label="知识条目列表">
        {overview.knowledge.length===0?<p className="knowledge-empty">还没有知识条目。导入文件，或直接填写一条知识。</p>:overview.knowledge.map(entry=><article key={entry.id} className="knowledge-entry">
          <div className="knowledge-entry-heading"><h4>{entry.title}</h4><span className={`knowledge-state ${entry.state==='ACTIVE'?'active':''}`}>{entry.state==='ACTIVE'?'已启用':'已停用'} · v{entry.version}</span></div>
          <p className="hint">{entry.topic} · {entry.channels.map(channelName).join('、')}</p>
          <p className="knowledge-excerpt">{entry.text.slice(0,220)}{entry.text.length>220?'…':''}</p>
          {(entry.effectiveAt!==null||entry.expiresAt!==null)&&<p className="hint">生效 {formatDate(entry.effectiveAt)} · 失效 {formatDate(entry.expiresAt)}</p>}
          <div className="row"><button disabled={busy} onClick={()=>edit(entry)}>编辑条目</button>
            <button disabled={busy} onClick={()=>void perform(entry.state==='ACTIVE'?'停用知识':'启用知识',{action:'setKnowledgeState',id:entry.id,state:entry.state==='ACTIVE'?'DISABLED':'ACTIVE'})}>{entry.state==='ACTIVE'?'停用知识':'启用知识'}</button>
            <button className="danger" disabled={busy} onClick={()=>setDeleteId(entry.sourceId)}>删除来源</button></div>
          {deleteId===entry.sourceId&&<div className="knowledge-confirm"><p>删除此来源及其全部知识、样本和检索片段？原始聊天与发送记录保留。</p>
            <div className="row"><button className="danger" disabled={busy} onClick={()=>void perform('删除来源',{action:'deleteSource',sourceId:entry.sourceId},()=>setDeleteId(null))}>确认删除来源</button>
              <button disabled={busy} onClick={()=>setDeleteId(null)}>保留来源</button></div></div>}
        </article>)}
      </div>
      <form className="knowledge-editor" onSubmit={event=>{
        event.preventDefault();if(!valid||busy)return;
        const input={...(draft.id?{id:draft.id,expectedVersion:draft.expectedVersion}:{}),title:draft.title,topic:draft.topic,text:draft.text,
          aliases,channels:draft.channels,
          effectiveAt:draft.effectiveAt?Date.parse(draft.effectiveAt):null,expiresAt:draft.expiresAt?Date.parse(draft.expiresAt):null} satisfies KnowledgeInput;
        void perform('保存知识条目',{action:'saveKnowledge',input},()=>setDraft(empty()));
      }}>
        <div className="knowledge-entry-heading"><h3>{draft.id?'编辑知识':'新增知识'}</h3><button type="button" disabled={busy} onClick={()=>setDraft(empty())}>新建条目</button></div>
        <label>知识标题<input maxLength={200} value={draft.title} disabled={busy} onChange={event=>setDraft({...draft,title:event.target.value})}/></label>
        <label>主题<input maxLength={100} value={draft.topic} disabled={busy} onChange={event=>setDraft({...draft,topic:event.target.value})}/></label>
        <label>知识正文<textarea aria-label="知识正文" rows={8} maxLength={100_000} value={draft.text} disabled={busy} onChange={event=>setDraft({...draft,text:event.target.value})}/></label>
        <label>关键词或别名（逗号或换行分隔）<textarea aria-label="关键词或别名（逗号或换行分隔）" rows={2} value={draft.aliases} disabled={busy} onChange={event=>setDraft({...draft,aliases:event.target.value})}/></label>
        <p className="hint">最多30个关键词，每个最多100字。</p>
        <div className="settings-options">{(['DIRECT_MESSAGE','COMMENT_NOTIFICATION'] as const).map(channel=><label className="check" key={channel}>
          <input type="checkbox" checked={draft.channels.includes(channel)} disabled={busy} onChange={event=>setDraft({...draft,channels:event.target.checked?[...draft.channels,channel]:draft.channels.filter(value=>value!==channel)})}/>{channelName(channel)}可用</label>)}</div>
        <div className="knowledge-fields"><label>生效时间（可选）<input type="datetime-local" value={draft.effectiveAt} disabled={busy} onChange={event=>setDraft({...draft,effectiveAt:event.target.value})}/></label>
          <label>失效时间（可选）<input type="datetime-local" value={draft.expiresAt} disabled={busy} onChange={event=>setDraft({...draft,expiresAt:event.target.value})}/></label></div>
        {!valid&&draft.text&&<p className="hint">请填写标题、主题和正文，选择至少一个通道；失效时间须晚于生效时间。</p>}
        <button className="primary" type="submit" disabled={busy||!valid}>保存知识条目</button>
      </form>
    </div>
  </div>;
}
