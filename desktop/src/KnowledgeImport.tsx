import {useEffect,useRef,useState} from 'react';
import type {Channel} from '../../src/contracts/events.js';
import {knowledgeRequest,type ChatImportMapping,type ImportPreview,type PerformKnowledge} from './knowledge-client';

interface MappingPreview {pairs:{prompt:string;response:string;group?:string}[];total:number;warnings?:string[]}
const importChunkBytes=48*1024;
const maximumFileBytes=20*1024*1024;
function encodeChunk(bytes:Uint8Array):string {
  let value='';for(const byte of bytes)value+=String.fromCharCode(byte);
  return btoa(value);
}
export async function uploadKnowledgeFile(file:File,kind:'KNOWLEDGE'|'CHAT'):Promise<ImportPreview> {
  if(file.size>maximumFileBytes)throw new Error('KNOWLEDGE_IMPORT_TOO_LARGE');
  const upload=await knowledgeRequest<{id:string}>({action:'importStart',name:file.name,bytes:file.size,kind});
  try{
    for(let offset=0,index=0;offset<file.size;offset+=importChunkBytes,index++){
      const chunk=new Uint8Array(await file.slice(offset,offset+importChunkBytes).arrayBuffer());
      await knowledgeRequest({action:'importChunk',id:upload.id,index,data:encodeChunk(chunk)});
    }
    return await knowledgeRequest<ImportPreview>({action:'importFinish',id:upload.id});
  }catch(failure){await knowledgeRequest({action:'importCancel',id:upload.id}).catch(()=>{});throw failure;}
}

export function KnowledgeImport({kind,busy,perform}:{kind:'KNOWLEDGE'|'CHAT';busy:boolean;perform:PerformKnowledge}) {
  const [file,setFile]=useState<File|null>(null),[preview,setPreview]=useState<ImportPreview|null>(null);
  const [mapping,setMapping]=useState<ChatImportMapping>({speakerColumn:'speaker',textColumn:'text',selfName:'',channel:'DIRECT_MESSAGE'});
  const [pairs,setPairs]=useState<MappingPreview|null>(null),[mappingSignature,setMappingSignature]=useState('');
  const input=useRef<HTMLInputElement>(null),uploadId=useRef<string|null>(null);
  useEffect(()=>()=>{if(uploadId.current)void knowledgeRequest({action:'importCancel',id:uploadId.current}).catch(()=>{});},[]);
  const changeMapping=(value:ChatImportMapping)=>{setMapping(value);setPairs(null);setMappingSignature('');};
  const reset=()=>{uploadId.current=null;setPreview(null);setFile(null);setPairs(null);setMappingSignature('');if(input.current)input.current.value='';};
  const mappingReady=!!mapping.selfName.trim()&&!!mapping.speakerColumn&&!!mapping.textColumn&&mapping.speakerColumn!==mapping.textColumn;
  const ready=kind==='KNOWLEDGE'||!!pairs&&pairs.total>0&&mappingSignature===JSON.stringify(mapping);
  return <details className="knowledge-import"><summary>从文件导入{kind==='KNOWLEDGE'?'知识':'聊天记录'}</summary>
    <p className="hint">{kind==='KNOWLEDGE'?'支持 TXT、MD、DOCX、文字 PDF、CSV、XLSX。':'支持 TXT、CSV、JSON、JSONL。TXT 每行使用“发言人: 正文”，可在预览中映射本人。'}每个文件最多20 MiB，解析在本机完成。</p>
    {!preview?<>
      <label>选择{kind==='KNOWLEDGE'?'知识':'聊天'}文件<input ref={input} type="file" disabled={busy}
        accept={kind==='KNOWLEDGE'?'.txt,.md,.docx,.pdf,.csv,.xlsx':'.txt,.csv,.json,.jsonl'} onChange={event=>setFile(event.target.files?.[0]??null)}/></label>
      {file&&<p className={file.size>maximumFileBytes?'error':'hint'}>{file.name} · {(file.size/1024).toFixed(1)} KiB{file.size>maximumFileBytes?'，超过20 MiB限制':''}</p>}
      <button disabled={busy||!file||file.size===0||file.size>maximumFileBytes} onClick={()=>{
        if(file)void perform('解析导入文件',()=>uploadKnowledgeFile(file,kind),result=>{
          uploadId.current=result.id;setPreview(result);setPairs(null);setMappingSignature('');
          setMapping(previous=>({...previous,speakerColumn:result.columns.includes('speaker')?'speaker':result.columns[0]??'',
            textColumn:result.columns.includes('text')?'text':result.columns[1]??''}));
        },false);
      }}>解析并预览</button>
    </>:<>
      <h4>{preview.name}</h4><p className="hint">已解析 {preview.totalRows} 行，尚未导入。</p>
      {preview.warnings.map((warning,index)=><p className="knowledge-warning" key={index}>{warning}</p>)}
      <pre className="knowledge-text-preview">{preview.textPreview}</pre>
      {kind==='CHAT'&&<>
        <div className="knowledge-fields">
          {([['speakerColumn','发言人列'],['textColumn','正文列'],['conversationColumn','会话列（可选）'],['timeColumn','时间列（可选）']] as const).map(([field,label])=><label key={field}>{label}
            <select aria-label={label} value={mapping[field]??''} disabled={busy} onChange={event=>{const value=event.target.value;changeMapping({...mapping,[field]:value||undefined});}}>
              <option value="">{field==='speakerColumn'||field==='textColumn'?'请选择':'不使用'}</option>
              {preview.columns.map(column=><option key={column} value={column}>{column}</option>)}
            </select></label>)}
          <label>本人发言人名称<input value={mapping.selfName} disabled={busy} onChange={event=>changeMapping({...mapping,selfName:event.target.value})}/></label>
          <label>聊天通道<select aria-label="聊天通道" value={mapping.channel} disabled={busy} onChange={event=>changeMapping({...mapping,channel:event.target.value as Channel})}>
            <option value="DIRECT_MESSAGE">私信</option><option value="COMMENT_NOTIFICATION">评论</option></select></label>
        </div>
        <p className="hint">时间列接受 ISO 日期时间或 Unix 时间戳；不选择时间列时按文件顺序配对。</p>
        <p className="hint">只学习与本人准确匹配的回复；其他发言人用于还原来信上下文，不能成为本人人格。</p>
        <button disabled={busy||!mappingReady} onClick={()=>void perform('预览问答配对',{action:'importPreviewMapping',id:preview.id,mapping},result=>{
          setPairs(result as MappingPreview);setMappingSignature(JSON.stringify(mapping));
        },false)}>预览问答配对</button>
        {pairs&&<div className="knowledge-pair-preview"><p>可导入 {pairs.total} 组问答，预览前 {pairs.pairs.length} 组</p>
          {pairs.warnings?.map((warning,index)=><p className="knowledge-warning" key={index}>{warning}</p>)}
          {pairs.pairs.map((pair,index)=><dl key={index}><dt>对方</dt><dd>{pair.prompt}</dd><dt>本人</dt><dd>{pair.response}</dd></dl>)}
        </div>}
      </>}
      <p className="hint">确认后{kind==='KNOWLEDGE'?'保存为停用条目，启用后才供回复使用':'进入待选择样本，采纳后才参与学习'}。</p>
      <div className="row"><button className="primary" disabled={busy||!ready} onClick={()=>void perform('确认导入',{
        action:'importCommit',id:preview.id,...(kind==='CHAT'?{mapping}:{}),
      },()=>reset())}>确认导入</button>
        <button disabled={busy} onClick={()=>void perform('取消导入',{action:'importCancel',id:preview.id},()=>reset(),false)}>取消导入</button></div>
    </>}
  </details>;
}
