import type {
  BrowserResourceReason,
  BrowserResourcesSnapshot,
} from '../../src/contracts/browser-resources';
import { time } from './presentation';

const states: Record<BrowserResourcesSnapshot['state'], string> = {
  WAITING: '等待采样',
  AVAILABLE: '采样正常',
  UNAVAILABLE: '采样暂不可用',
  STALE: '数据已过期',
  CLOSED: '监测已关闭',
};
const reasons: Record<BrowserResourceReason, string> = {
  NO_OWNER: '等待后台浏览器连接',
  UNSUPPORTED_PLATFORM: '当前系统暂不支持资源采样',
  PROCESS_UNAVAILABLE: '浏览器进程已退出或暂不可读',
  PROCESS_AMBIGUOUS: '浏览器进程归属尚未确认',
  ACCESS_DENIED: '暂时无法读取进程资源',
  TIMEOUT: '本次采样超时',
  CANCELLED: '本次采样已取消',
  INVALID_SAMPLE: '本次采样未取得完整数据',
  OWNER_CHANGED: '浏览器已更换，等待新运行段采样',
  REPORT_WRITE_FAILED: '资源报告暂未写入，后台运行不受影响',
  SAMPLE_STALE: '最近有效采样已超过 150 秒',
  CLOSED: '资源监测已结束',
};
const memory = (bytes: number) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;

export function BrowserResourcesPanel({
  snapshot,
}: {
  snapshot: BrowserResourcesSnapshot | undefined;
}) {
  if (!snapshot)
    return (
      <section
        aria-label="后台浏览器资源"
        className="flex flex-col gap-2 rounded-xl border border-border/80 bg-background p-4"
      >
        <h3 className="font-heading text-[13.5px] font-semibold text-foreground">后台浏览器资源</h3>
        <p className="hint text-xs text-muted-foreground">当前内核未提供浏览器资源监测数据。</p>
      </section>
    );
  const latest = snapshot.latest,
    windows = [
      { label: '最近一小时', summary: snapshot.hour },
      { label: '当前运行段', summary: snapshot.run },
    ];
  const tone =
    snapshot.state === 'AVAILABLE'
      ? 'border-success/30 bg-success/8 text-success-foreground'
      : snapshot.state === 'STALE' || snapshot.state === 'UNAVAILABLE'
        ? 'border-warning/35 bg-warning/8 text-warning-foreground'
        : 'border-border/75 bg-muted/40 text-foreground';

  return (
    <section
      aria-label="后台浏览器资源"
      className="flex flex-col gap-2.5 rounded-xl border border-border/80 bg-background p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-heading text-[13.5px] font-semibold text-foreground">后台浏览器资源</h3>
        <p role="status" className={`rounded-md border px-2.5 py-0.5 text-xs font-medium ${tone}`}>
          {states[snapshot.state]}
          {snapshot.reason ? ` · ${reasons[snapshot.reason]}` : ''}
        </p>
      </div>

      <p className="hint text-xs leading-relaxed text-muted-foreground">
        每 {Math.round(snapshot.intervalMs / 1000)} 秒采样，仅统计本应用持有的后台
        Edge。工作集为进程驻留物理内存之和，含共享页的重复计数；私有提交量为专用提交内存，不等同于物理内存。
      </p>

      <p className="text-xs text-muted-foreground tabular-nums">
        最近有效采样：{snapshot.sampledAt === null ? '尚未取得' : time(snapshot.sampledAt)} ·
        当前运行段开始：
        {snapshot.segmentStartedAt === null ? '尚未取得' : time(snapshot.segmentStartedAt)}
      </p>

      {latest ? (
        <p className="rounded-lg bg-muted/35 px-3 py-2 text-xs font-medium text-foreground tabular-nums">
          最近有效值：工作集 {memory(latest.workingSetBytes)} · 私有提交量{' '}
          {memory(latest.privateBytes)} · 页面 {latest.pageCount} 个 · Edge 进程{' '}
          {latest.browserProcesses} 个 · 采样耗时 {Math.round(latest.elapsedMs)} ms
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">尚无有效资源样本，暂不显示内存数值。</p>
      )}

      {windows.some(window => window.summary) && (
        <div className="overflow-x-auto rounded-lg border border-border/75 bg-card">
          <table className="w-full border-collapse text-left text-xs" aria-label="后台浏览器内存摘要">
            <thead>
              <tr>
                <th className="whitespace-nowrap border-b border-border bg-muted/40 px-3 py-2 text-[11px] font-medium text-muted-foreground">
                  统计范围 / 样本数
                </th>
                <th className="whitespace-nowrap border-b border-border bg-muted/40 px-3 py-2 text-[11px] font-medium text-muted-foreground">
                  工作集 P50 / P95 / 峰值
                </th>
                <th className="whitespace-nowrap border-b border-border bg-muted/40 px-3 py-2 text-[11px] font-medium text-muted-foreground">
                  私有提交量 P50 / P95 / 峰值
                </th>
              </tr>
            </thead>
            <tbody>
              {windows.map(
                window =>
                  window.summary && (
                    <tr key={window.label}>
                      <td className="whitespace-nowrap border-t border-border/60 px-3 py-2 text-foreground tabular-nums">
                        {window.label} / {window.summary.samples}
                      </td>
                      <td className="whitespace-nowrap border-t border-border/60 px-3 py-2 text-foreground tabular-nums">
                        {memory(window.summary.workingSetBytes.p50)} /{' '}
                        {memory(window.summary.workingSetBytes.p95)} /{' '}
                        {memory(window.summary.workingSetBytes.max)}
                      </td>
                      <td className="whitespace-nowrap border-t border-border/60 px-3 py-2 text-foreground tabular-nums">
                        {memory(window.summary.privateBytes.p50)} /{' '}
                        {memory(window.summary.privateBytes.p95)} /{' '}
                        {memory(window.summary.privateBytes.max)}
                      </td>
                    </tr>
                  ),
              )}
            </tbody>
          </table>
        </div>
      )}

      <p className="hint text-xs text-muted-foreground">
        浏览器更换后重新统计运行段；采样异常不影响收取或发送。过期数值保留原采样时间。
      </p>
    </section>
  );
}
