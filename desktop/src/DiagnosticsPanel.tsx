import {useEffect,useState} from 'react';
import {listen} from '@tauri-apps/api/event';
import type {DiagnosticsSnapshot} from '../../src/app/diagnostics';
import type {EvidenceMaintenance} from '../../src/app/evidence-maintenance';
import type {RuntimePerformanceSummary} from '../../src/observability/runtime-performance';
import {request,reasons} from './api';
import {time} from './presentation';
import {ReadRefresh} from './read-refresh';

type DiagnosticsView=DiagnosticsSnapshot&{
  performance:RuntimePerformanceSummary[];evidence:ReturnType<EvidenceMaintenance['status']>;
};
const statuses:Record<string,string>={SUCCEEDED:'成功',FAILED:'失败',STARTED:'未完成',UNKNOWN:'未识别'};
const sources:Record<string,string>={COLLECTION:'收取',WORK:'作品读取',AUTOMATION:'自动回复',VERIFICATION:'送达检查',MANUAL_SEND:'人工回复'};
const stages:Record<string,string>={QUEUE_WAIT:'排队等待',COLLECTION:'收取',RESPONSE_READ:'读取页面响应',RESPONSE_PARSE:'解析页面响应',
  TARGET_LOCATION:'定位作品',PAGE_WAIT:'等待页面数据',CONTENT_CHECK:'核对页面内容',PERSIST:'本地保存',MODEL:'模型生成',DELIVERY:'提交与回读'};
const channel=(value:string)=>value==='DIRECT_MESSAGE'||value==='dm'?'私信':value==='COMMENT_NOTIFICATION'||value==='works'?'评论':'共用';
const duration=(value:number|null)=>value===null?'未记录':`${Math.round(value*100)/100} ms`;
const bytes=(value:number)=>value>=1024*1024?`${(value/1024/1024).toFixed(2)} MB`:value>=1024?`${(value/1024).toFixed(2)} KB`:`${value} B`;
const reason=(code:string)=>reasons[code]??`后台保留处理中（${code}）`;

/** This component is mounted only on Settings; requests never load private bodies or invoke maintenance. */
export function DiagnosticsPanel(){
  const [snapshot,setSnapshot]=useState<DiagnosticsView|null>(null),[failed,setFailed]=useState(false);
  useEffect(()=>{
    let disposed=false,stopListening:(()=>void)|undefined;
    const refresh=new ReadRefresh({diagnostics:async current=>{
      const next=await request<DiagnosticsView>({command:'getDiagnostics'});
      if(!disposed&&current()){setSnapshot(next);setFailed(false);}
    }},()=>{if(!disposed)setFailed(true);});
    const focus=()=>refresh.schedule(['diagnostics']);
    window.addEventListener('focus',focus);
    void listen<{event?:unknown}>('inbora_status_updated',event=>{
      if(!disposed&&typeof event.payload?.event==='string')refresh.schedule(['diagnostics']);
    }).then(stop=>{
      if(disposed)stop();else{stopListening=stop;refresh.schedule(['diagnostics'],0);}
    }).catch(()=>{if(!disposed)refresh.schedule(['diagnostics'],0);});
    return()=>{disposed=true;refresh.dispose();window.removeEventListener('focus',focus);stopListening?.();};
  },[]);
  const usage=snapshot?.model.total,evidence=snapshot?.evidence,report=evidence?.report;
  return <section className="settings-section" aria-label="运行诊断" style={{gridColumn:'1 / -1'}}>
    <h2>运行诊断</h2>
    <p className="hint">累计记录，不按日期或模型用途推算；缺失的使用量保留为未知。</p>
    {failed&&<p role="status">诊断数据暂不可用，后台运行不受影响。</p>}
    {!snapshot&&!failed&&<p>正在读取本地诊断…</p>}
    {snapshot&&usage&&<>
      <h3>模型调用累计</h3>
      <p>共 {usage.requests} 次 · 已知用量 {usage.knownUsageRequests} 次 · 用量未知 {usage.unknownUsageRequests} 次</p>
      <p>已知输入 {usage.inputTokens} / 输出 {usage.outputTokens} Token</p>
      <p>平均耗时 {duration(usage.averageElapsedMs)} · P95 {duration(usage.p95ElapsedMs)} · 已记录耗时 {usage.elapsedSamples} 次</p>
      {snapshot.model.groups.length>0&&<div style={{overflowX:'auto'}}><table aria-label="模型与状态累计">
        <thead><tr><th>模型</th><th>状态</th><th>次数</th><th>用量未知</th><th>已知输入 / 输出 Token</th><th>平均 / P95</th></tr></thead>
        <tbody>{snapshot.model.groups.map(group=><tr key={group.model+':'+group.status}>
          <td>{group.model}</td><td>{statuses[group.status]??'未识别'}</td><td>{group.requests}</td><td>{group.unknownUsageRequests}</td>
          <td>{group.inputTokens} / {group.outputTokens}</td><td>{duration(group.averageElapsedMs)} / {duration(group.p95ElapsedMs)}</td>
        </tr>)}</tbody>
      </table></div>}
      <h3>当前阻塞原因</h3>
      {snapshot.blockers.length===0?<p>当前没有已记录的阻塞原因。</p>:<ul>{snapshot.blockers.map(blocker=><li key={blocker.source+':'+blocker.code}>
        {sources[blocker.source]??'后台处理'}：{reason(blocker.code)} · {blocker.count} 项
      </li>)}</ul>}
      <h3>收取进度</h3>
      {snapshot.collection.channels.length===0?<p>尚未启用后台收取。</p>:<div style={{overflowX:'auto'}}><table aria-label="通道收取进度">
        <thead><tr><th>通道</th><th>上次成功</th><th>下次调度</th><th>最近原因</th><th>耗时</th></tr></thead>
        <tbody>{snapshot.collection.channels.map(item=><tr key={item.source}>
          <td>{channel(item.source)}</td><td>{time(item.lastSuccess)}</td><td>{item.nextAt>0?time(item.nextAt):'等待后台调度'}</td>
          <td>{item.lastError?reason(item.lastError):'无'}</td><td>{duration(item.elapsedMs)}</td>
        </tr>)}</tbody>
      </table></div>}
      <h3>本次运行耗时</h3>
      <p className="hint">各阶段保留最近 128 个样本；次数从本次内核启动累计，重启后重新统计。</p>
      {snapshot.performance.length===0?<p>尚无阶段耗时样本。</p>:<div style={{overflowX:'auto'}}><table aria-label="固定阶段耗时">
        <thead><tr><th>阶段 / 通道</th><th>次数</th><th>失败 / 待补证 / 中止</th><th>最近 / P50 / P95</th></tr></thead>
        <tbody>{snapshot.performance.map(item=><tr key={item.stage+':'+item.channel}>
          <td>{stages[item.stage]??'后台处理'} / {channel(item.channel)}</td><td>{item.count}</td><td>{item.failures} / {item.uncertain??0} / {item.cancelled}</td>
          <td>{duration(item.lastMs)} / {duration(item.p50Ms)} / {duration(item.p95Ms)}</td>
        </tr>)}</tbody>
      </table></div>}
      <h3>证据元数据</h3>
      <p className="hint">仅统计证据目录顶层的元数据扫描，不是整个运行目录的磁盘占用；不包含数据库、浏览器资料或媒体预览子目录。</p>
      {evidence?.running&&<p>后台正在维护证据，仍被引用的记录继续保留。</p>}
      {evidence?.error&&<p>证据维护暂不可用，资料已保留。</p>}
      {!report?<p>尚无证据容量统计。</p>:<>
        <p>本次扫描 {report.total.files} 项 / {bytes(report.total.bytes)} · 识别元数据 {report.recognized.files} 份 / {bytes(report.recognized.bytes)}</p>
        <p>有引用保护 {report.protected.files} 份 / {bytes(report.protected.bytes)} · 可清理 {report.eligible.files} 份 / {bytes(report.eligible.bytes)}</p>
        <p>超过 {report.retentionDays} 天 {report.expired.files} 份 · 未识别保留 {report.unknown.files} 项</p>
        <p>本次清理 {report.deleted.files} 份 / {bytes(report.deleted.bytes)} · 仍待维护 {report.remainingEligible.files} 份</p>
        {!report.referencesComplete&&<p>引用尚未全部确认，相关证据保留。</p>}
        {report.cancelled&&<p>本次维护已中断，未处理记录保留。</p>}
      </>}
      <p>下次证据维护：{evidence&&evidence.nextAt>0?time(evidence.nextAt):'等待后台空闲调度'}</p>
    </>}
  </section>;
}
