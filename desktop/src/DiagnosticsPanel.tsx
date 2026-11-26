import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import type {
  DiagnosticsSnapshot,
  EvidenceMaintenanceStatus,
  ModelUsageGroup,
  RuntimePerformanceSummary,
} from '../../src/contracts/diagnostics.js';
import { modelPresetIdSchema } from '../../src/contracts/model-providers.js';
import { modelPresetNames, request, reasons } from './api';
import { time } from './presentation';
import { ReadRefresh } from './read-refresh';
import { BrowserResourcesPanel } from './BrowserResourcesPanel';

type DiagnosticModelGroup = ModelUsageGroup & { provider?: string | null; presetId?: string | null };
type DiagnosticsView = Omit<DiagnosticsSnapshot, 'model'> & {
  model: Omit<DiagnosticsSnapshot['model'], 'groups'> & { groups: DiagnosticModelGroup[] };
  performance: RuntimePerformanceSummary[];
  evidence: EvidenceMaintenanceStatus;
};
const statuses: Record<string, string> = {
  SUCCEEDED: '成功',
  FAILED: '失败',
  STARTED: '未完成',
  UNKNOWN: '未识别',
};
const sources: Record<string, string> = {
  COLLECTION: '收取',
  WORK: '作品读取',
  AUTOMATION: '自动回复',
  VERIFICATION: '送达检查',
  MANUAL_SEND: '人工回复',
};
const stages: Record<string, string> = {
  QUEUE_WAIT: '排队等待',
  COLLECTION: '收取',
  RESPONSE_READ: '读取页面响应',
  RESPONSE_PARSE: '解析页面响应',
  TARGET_LOCATION: '定位作品',
  PAGE_WAIT: '等待页面数据',
  CONTENT_CHECK: '核对页面内容',
  PERSIST: '本地保存',
  MODEL: '模型生成',
  DELIVERY: '提交与回读',
};
const channel = (value: string) =>
  value === 'DIRECT_MESSAGE' || value === 'dm'
    ? '私信'
    : value === 'COMMENT_NOTIFICATION' || value === 'works'
      ? '评论'
      : '共用';
const duration = (value: number | null) =>
  value === null ? '未记录' : `${Math.round(value * 100) / 100} ms`;
const bytes = (value: number) =>
  value >= 1024 * 1024
    ? `${(value / 1024 / 1024).toFixed(2)} MB`
    : value >= 1024
      ? `${(value / 1024).toFixed(2)} KB`
      : `${value} B`;
const reason = (code: string) => reasons[code] ?? `后台保留处理中（${code}）`;

function providerLabel(group: DiagnosticModelGroup) {
  const preset = modelPresetIdSchema.safeParse(group.presetId ?? group.provider);
  return preset.success ? modelPresetNames[preset.data] : '未知（历史记录）';
}

const ignoredDiagnosticsEvents = new Set(['sidecar_response_too_large', 'knowledge_updated']);

const subBlockCls = 'flex flex-col gap-2.5 rounded-xl border border-border/80 bg-background p-4';
const tableWrapCls = 'overflow-x-auto rounded-lg border border-border/75 bg-card';
const tableCls = 'w-full border-collapse text-left text-xs';
const thCls = 'whitespace-nowrap border-b border-border bg-muted/40 px-3 py-2 text-[11px] font-medium text-muted-foreground';
const tdCls = 'whitespace-nowrap border-t border-border/60 px-3 py-2 text-foreground tabular-nums';

/** This component is mounted only on Settings/Runtime; requests never load private bodies or invoke maintenance. */
export function DiagnosticsPanel() {
  const [snapshot, setSnapshot] = useState<DiagnosticsView | null>(null),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false,
      stopListening: (() => void) | undefined;
    const refresh = new ReadRefresh(
      {
        diagnostics: async current => {
          const next = await request<DiagnosticsView>({ command: 'getDiagnostics' });
          if (!disposed && current()) {
            setSnapshot(next);
            setFailed(false);
          }
        },
      },
      () => {
        if (!disposed) setFailed(true);
      },
    );
    const focus = () => refresh.schedule(['diagnostics']);
    window.addEventListener('focus', focus);
    void listen<{ event?: unknown }>('inbora_status_updated', event => {
      const name = event.payload?.event;
      if (!disposed && typeof name === 'string' && !ignoredDiagnosticsEvents.has(name))
        refresh.schedule(['diagnostics']);
    })
      .then(stop => {
        if (disposed) stop();
        else {
          stopListening = stop;
          refresh.schedule(['diagnostics'], 0);
        }
      })
      .catch(() => {
        if (!disposed) refresh.schedule(['diagnostics'], 0);
      });
    return () => {
      disposed = true;
      refresh.dispose();
      window.removeEventListener('focus', focus);
      stopListening?.();
    };
  }, []);
  const usage = snapshot?.model.total,
    evidence = snapshot?.evidence,
    report = evidence?.report;

  return (
    <section
      className="settings-section flex flex-col gap-4 rounded-2xl border border-border/85 bg-card p-5 text-card-foreground shadow-xs/5"
      aria-label="运行诊断"
      style={{ gridColumn: '1 / -1' }}
    >
      <div className="space-y-1">
        <h2 className="font-heading text-[15px] font-semibold text-foreground">运行诊断</h2>
        <p className="hint text-xs leading-relaxed text-muted-foreground">
          累计记录，不按日期或模型用途推算；缺失的使用量保留为未知。
        </p>
      </div>

      {failed && (
        <p
          role="status"
          className="rounded-xl border border-warning/35 bg-warning/8 px-3.5 py-2 text-xs text-warning-foreground"
        >
          诊断数据暂不可用，后台运行不受影响。
        </p>
      )}
      {!snapshot && !failed && (
        <p className="text-xs text-muted-foreground">正在读取本地诊断…</p>
      )}

      {snapshot && usage && (
        <>
          <BrowserResourcesPanel snapshot={snapshot.browserResources} />

          <div className={subBlockCls}>
            <h3 className="font-heading text-[13.5px] font-semibold text-foreground">
              模型调用累计
            </h3>
            <div className="grid grid-cols-1 gap-2 text-xs text-foreground tabular-nums md:grid-cols-2">
              <p className="rounded-lg bg-muted/35 px-3 py-2">
                共 {usage.requests} 次 · 已知用量 {usage.knownUsageRequests} 次 · 用量未知{' '}
                {usage.unknownUsageRequests} 次
              </p>
              <p className="rounded-lg bg-muted/35 px-3 py-2">
                已知输入 {usage.inputTokens} / 输出 {usage.outputTokens} Token
              </p>
              <p className="rounded-lg bg-muted/35 px-3 py-2 md:col-span-2">
                平均耗时 {duration(usage.averageElapsedMs)} · P95 {duration(usage.p95ElapsedMs)} ·
                已记录耗时 {usage.elapsedSamples} 次
              </p>
            </div>
            <p className="hint text-xs text-muted-foreground">
              费用：未知；不依据缺失用量或未经核对的单价推算。
            </p>
            {snapshot.modelBreakdownTruncated && (
              <p className="hint text-xs text-muted-foreground">
                模型明细仅展示 {snapshot.model.groups.length} 组
                {snapshot.modelBreakdownTotal !== undefined &&
                  `（共 ${snapshot.modelBreakdownTotal} 组）`}
                ，上方累计包含全部记录。
              </p>
            )}
            {snapshot.model.groups.length > 0 && (
              <div className={tableWrapCls}>
                <table className={tableCls} aria-label="模型与状态累计">
                  <thead>
                    <tr>
                      <th className={thCls}>提供商</th>
                      <th className={thCls}>模型</th>
                      <th className={thCls}>状态</th>
                      <th className={thCls}>次数</th>
                      <th className={thCls}>用量未知</th>
                      <th className={thCls}>已知输入 / 输出 Token</th>
                      <th className={thCls}>平均 / P95</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.model.groups.map(group => (
                      <tr
                        key={JSON.stringify([
                          group.presetId ?? group.provider ?? null,
                          group.model,
                          group.status,
                        ])}
                      >
                        <td className={tdCls}>{providerLabel(group)}</td>
                        <td className={`${tdCls} font-mono`}>{group.model}</td>
                        <td className={tdCls}>{statuses[group.status] ?? '未识别'}</td>
                        <td className={tdCls}>{group.requests}</td>
                        <td className={tdCls}>{group.unknownUsageRequests}</td>
                        <td className={tdCls}>
                          {group.inputTokens} / {group.outputTokens}
                        </td>
                        <td className={tdCls}>
                          {duration(group.averageElapsedMs)} / {duration(group.p95ElapsedMs)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className={subBlockCls}>
            <h3 className="font-heading text-[13.5px] font-semibold text-foreground">
              当前阻塞原因
            </h3>
            {snapshot.blockers.length === 0 ? (
              <p className="text-xs text-muted-foreground">当前没有已记录的阻塞原因。</p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-xs text-foreground">
                {snapshot.blockers.map(blocker => (
                  <li
                    key={blocker.source + ':' + blocker.code}
                    className="rounded-lg border border-warning/30 bg-warning/6 px-3 py-2 text-warning-foreground"
                  >
                    {sources[blocker.source] ?? '后台处理'}：{reason(blocker.code)} ·{' '}
                    {blocker.count} 项
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className={subBlockCls}>
            <h3 className="font-heading text-[13.5px] font-semibold text-foreground">收取进度</h3>
            {snapshot.collection.channels.length === 0 ? (
              <p className="text-xs text-muted-foreground">尚未启用后台收取。</p>
            ) : (
              <div className={tableWrapCls}>
                <table className={tableCls} aria-label="通道收取进度">
                  <thead>
                    <tr>
                      <th className={thCls}>通道</th>
                      <th className={thCls}>上次成功</th>
                      <th className={thCls}>下次调度</th>
                      <th className={thCls}>最近原因</th>
                      <th className={thCls}>耗时</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.collection.channels.map(item => (
                      <tr key={item.source}>
                        <td className={tdCls}>{channel(item.source)}</td>
                        <td className={tdCls}>{time(item.lastSuccess)}</td>
                        <td className={tdCls}>
                          {item.nextAt > 0 ? time(item.nextAt) : '等待后台调度'}
                        </td>
                        <td className={tdCls}>{item.lastError ? reason(item.lastError) : '无'}</td>
                        <td className={tdCls}>{duration(item.elapsedMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className={subBlockCls}>
            <h3 className="font-heading text-[13.5px] font-semibold text-foreground">
              本次运行耗时
            </h3>
            <p className="hint text-xs text-muted-foreground">
              各阶段保留最近 128 个样本；次数从本次内核启动累计，重启后重新统计。
            </p>
            {snapshot.performance.length === 0 ? (
              <p className="text-xs text-muted-foreground">尚无阶段耗时样本。</p>
            ) : (
              <div className={tableWrapCls}>
                <table className={tableCls} aria-label="固定阶段耗时">
                  <thead>
                    <tr>
                      <th className={thCls}>阶段 / 通道</th>
                      <th className={thCls}>次数</th>
                      <th className={thCls}>失败 / 待补证 / 中止</th>
                      <th className={thCls}>最近 / P50 / P95</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.performance.map(item => (
                      <tr key={item.stage + ':' + item.channel}>
                        <td className={tdCls}>
                          {stages[item.stage] ?? '后台处理'} / {channel(item.channel)}
                        </td>
                        <td className={tdCls}>{item.count}</td>
                        <td className={tdCls}>
                          {item.failures} / {item.uncertain ?? 0} / {item.cancelled}
                        </td>
                        <td className={tdCls}>
                          {duration(item.lastMs)} / {duration(item.p50Ms)} / {duration(item.p95Ms)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className={subBlockCls}>
            <h3 className="font-heading text-[13.5px] font-semibold text-foreground">证据元数据</h3>
            <p className="hint text-xs leading-relaxed text-muted-foreground">
              仅统计证据目录顶层的元数据扫描，不是整个运行目录的磁盘占用；不包含数据库、浏览器资料或媒体预览子目录。
            </p>
            {evidence?.running && (
              <p className="text-xs text-primary">后台正在维护证据，仍被引用的记录继续保留。</p>
            )}
            {evidence?.error && (
              <p className="text-xs text-warning-foreground">证据维护暂不可用，资料已保留。</p>
            )}
            {!report ? (
              <p className="text-xs text-muted-foreground">尚无证据容量统计。</p>
            ) : (
              <div className="grid grid-cols-1 gap-1.5 text-xs text-foreground tabular-nums sm:grid-cols-2">
                <p className="rounded-lg bg-muted/35 px-3 py-2">
                  本次扫描 {report.total.files} 项 / {bytes(report.total.bytes)} · 识别元数据{' '}
                  {report.recognized.files} 份 / {bytes(report.recognized.bytes)}
                </p>
                <p className="rounded-lg bg-muted/35 px-3 py-2">
                  有引用保护 {report.protected.files} 份 / {bytes(report.protected.bytes)} · 可清理{' '}
                  {report.eligible.files} 份 / {bytes(report.eligible.bytes)}
                </p>
                <p className="rounded-lg bg-muted/35 px-3 py-2">
                  超过 {report.retentionDays} 天 {report.expired.files} 份 · 未识别保留{' '}
                  {report.unknown.files} 项
                </p>
                <p className="rounded-lg bg-muted/35 px-3 py-2">
                  本次清理 {report.deleted.files} 份 / {bytes(report.deleted.bytes)} · 仍待维护{' '}
                  {report.remainingEligible.files} 份
                </p>
                {!report.referencesComplete && (
                  <p className="rounded-lg border border-warning/30 bg-warning/6 px-3 py-2 text-warning-foreground sm:col-span-2">
                    引用尚未全部确认，相关证据保留。
                  </p>
                )}
                {report.cancelled && (
                  <p className="rounded-lg border border-warning/30 bg-warning/6 px-3 py-2 text-warning-foreground sm:col-span-2">
                    本次维护已中断，未处理记录保留。
                  </p>
                )}
              </div>
            )}
            <p className="text-xs text-muted-foreground tabular-nums">
              下次证据维护：{evidence && evidence.nextAt > 0 ? time(evidence.nextAt) : '等待后台空闲调度'}
            </p>
          </div>
        </>
      )}
    </section>
  );
}
