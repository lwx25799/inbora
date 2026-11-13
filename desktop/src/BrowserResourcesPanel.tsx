import type {BrowserResourceReason,BrowserResourcesSnapshot} from '../../src/observability/browser-resource-contracts';
import {time} from './presentation';

const states:Record<BrowserResourcesSnapshot['state'],string>={
  WAITING:'等待采样',AVAILABLE:'采样正常',UNAVAILABLE:'采样暂不可用',STALE:'数据已过期',CLOSED:'监测已关闭',
};
const reasons:Record<BrowserResourceReason,string>={
  NO_OWNER:'等待后台浏览器连接',UNSUPPORTED_PLATFORM:'当前系统暂不支持资源采样',PROCESS_UNAVAILABLE:'浏览器进程已退出或暂不可读',
  PROCESS_AMBIGUOUS:'浏览器进程归属尚未确认',ACCESS_DENIED:'暂时无法读取进程资源',TIMEOUT:'本次采样超时',CANCELLED:'本次采样已取消',
  INVALID_SAMPLE:'本次采样未取得完整数据',OWNER_CHANGED:'浏览器已更换，等待新运行段采样',REPORT_WRITE_FAILED:'资源报告暂未写入，后台运行不受影响',
  SAMPLE_STALE:'最近有效采样已超过 150 秒',CLOSED:'资源监测已结束',
};
const memory=(bytes:number)=>bytes>=1024**3?`${(bytes/1024**3).toFixed(2)} GiB`:`${(bytes/1024**2).toFixed(1)} MiB`;

export function BrowserResourcesPanel({snapshot}:{snapshot:BrowserResourcesSnapshot|undefined}){
  if(!snapshot)return <section aria-label="后台浏览器资源"><h3>后台浏览器资源</h3>
    <p className="hint">当前内核未提供浏览器资源监测数据。</p></section>;
  const latest=snapshot.latest,windows=[{label:'最近一小时',summary:snapshot.hour},{label:'当前运行段',summary:snapshot.run}];
  return <section aria-label="后台浏览器资源">
    <h3>后台浏览器资源</h3>
    <p role="status">{states[snapshot.state]}{snapshot.reason?` · ${reasons[snapshot.reason]}`:''}</p>
    <p className="hint">每 {Math.round(snapshot.intervalMs/1000)} 秒采样，仅统计本应用持有的后台 Edge。工作集为进程驻留物理内存之和，含共享页的重复计数；私有提交量为专用提交内存，不等同于物理内存。</p>
    <p>最近有效采样：{snapshot.sampledAt===null?'尚未取得':time(snapshot.sampledAt)} · 当前运行段开始：{snapshot.segmentStartedAt===null?'尚未取得':time(snapshot.segmentStartedAt)}</p>
    {latest?<p>最近有效值：工作集 {memory(latest.workingSetBytes)} · 私有提交量 {memory(latest.privateBytes)} · 页面 {latest.pageCount} 个 · Edge 进程 {latest.browserProcesses} 个 · 采样耗时 {Math.round(latest.elapsedMs)} ms</p>:
      <p>尚无有效资源样本，暂不显示内存数值。</p>}
    {windows.some(window=>window.summary)&&<div style={{overflowX:'auto'}}><table aria-label="后台浏览器内存摘要">
      <thead><tr><th>统计范围 / 样本数</th><th>工作集 P50 / P95 / 峰值</th><th>私有提交量 P50 / P95 / 峰值</th></tr></thead>
      <tbody>{windows.map(window=>window.summary&&<tr key={window.label}>
        <td>{window.label} / {window.summary.samples}</td>
        <td>{memory(window.summary.workingSetBytes.p50)} / {memory(window.summary.workingSetBytes.p95)} / {memory(window.summary.workingSetBytes.max)}</td>
        <td>{memory(window.summary.privateBytes.p50)} / {memory(window.summary.privateBytes.p95)} / {memory(window.summary.privateBytes.max)}</td>
      </tr>)}</tbody>
    </table></div>}
    <p className="hint">浏览器更换后重新统计运行段；采样异常不影响收取或发送。过期数值保留原采样时间。</p>
  </section>;
}
