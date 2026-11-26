import { useState, type Dispatch, type SetStateAction } from 'react';
import type * as React from 'react';
import { ShieldAlertIcon, ShieldCheckIcon } from 'lucide-react';
import { DiagnosticsPanel } from '@/DiagnosticsPanel';
import { SecurityRuntimeDetails } from '@/SecurityRuntimeDetails';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardFrame,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs';
import { capabilityNames, reasons, type Status } from '@/api';
import { browserState, time } from '@/presentation';
import type { AuditRow } from '@/useWorkbenchRefresh';

export interface RuntimeViewProps {
  status: Status;
  audit: AuditRow[];
  auditPage: number;
  setAuditPage: Dispatch<SetStateAction<number>>;
}

function auditBadgeVariant(eventType: string): 'error' | 'warning' | 'success' | 'secondary' {
  const upper = eventType.toUpperCase();
  if (upper.includes('STOP') || upper.includes('FREEZE') || upper.includes('FAIL') || upper.includes('ERROR')) {
    return 'error';
  }
  if (upper.includes('HOLD') || upper.includes('SECURITY') || upper.includes('UNCERTAIN') || upper.includes('PAUSE')) {
    return 'warning';
  }
  if (upper.includes('CONFIRM') || upper.includes('VERIF') || upper.includes('RESUME') || upper.includes('SENT')) {
    return 'success';
  }
  return 'secondary';
}

export function RuntimeView({
  status,
  audit,
  auditPage,
  setAuditPage,
}: RuntimeViewProps): React.ReactElement {
  const [tab, setTab] = useState<'diagnostics' | 'security' | 'audit'>('diagnostics');
  const holds = status.securityHolds ?? [];
  const unresolvedSends = status.automation?.unresolvedSends ?? [];

  return (
    <div className="mx-auto max-w-[1220px] space-y-5 px-6 py-5">
      <PageHeader
        title="调度与审计"
        description="运维观测与管理员排障视图：查看本地运行诊断、后台浏览器资源、通道安全核验与只读脱敏操作审计账本"
      />

      <Tabs
        value={tab}
        onValueChange={value => setTab(value as 'diagnostics' | 'security' | 'audit')}
        className="gap-5"
      >
        <div className="border-b border-border">
          <TabsList variant="underline" className="pb-0">
            <TabsTab value="diagnostics">运行与诊断</TabsTab>
            <TabsTab value="security">
              通道与安全
              {holds.length > 0 && (
                <Badge variant="warning" size="sm" className="ml-1.5">
                  {holds.length}
                </Badge>
              )}
            </TabsTab>
            <TabsTab value="audit">操作审计账本</TabsTab>
          </TabsList>
        </div>

        {/* Tab 1: Diagnostics + Browser Resources */}
        <TabsPanel value="diagnostics" className="space-y-4">
          <CardFrame>
            <Card className="overflow-hidden">
              <div className="grid grid-cols-1 divide-y divide-border/70 sm:grid-cols-2 lg:grid-cols-4 lg:divide-x lg:divide-y-0">
                <div className="px-5 py-4">
                  <div className="text-xs text-muted-foreground">浏览器连接</div>
                  <div className="mt-1 text-sm font-semibold text-foreground">
                    {browserState(status.browser.state, status.automation?.emergencyStopped)}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {status.browser.mode === 'headed' ? '有头 Edge' : '无头 Edge'}{' '}
                    {status.browser.version ?? ''}
                  </div>
                </div>
                <div className="px-5 py-4">
                  <div className="text-xs text-muted-foreground">后台收取状态</div>
                  <div className="mt-1 text-sm font-semibold text-foreground">
                    {status.automation?.collector.running
                      ? `读取中（${status.automation.collector.source === 'dm' ? '私信' : '评论'}）`
                      : status.automation?.collection
                        ? '已启用空闲待命'
                        : '尚未启用'}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                    待处理作品：{status.automation?.pendingWorks.count ?? 0} 个
                  </div>
                </div>
                <div className="px-5 py-4">
                  <div className="text-xs text-muted-foreground">待核验安全现场</div>
                  <div className="mt-1 font-heading text-xl font-semibold text-foreground tabular-nums">
                    {holds.length} 个
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {holds.length > 0 ? '受影响通道已隔离暂停' : '全部通道运行平稳'}
                  </div>
                </div>
                <div className="px-5 py-4">
                  <div className="text-xs text-muted-foreground">数据库架构</div>
                  <div className="mt-1 font-mono text-lg font-semibold text-foreground tabular-nums">
                    schema{status.schema}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    操作员权限：{status.operator.permissions.join(' / ') || '无'}
                  </div>
                </div>
              </div>
            </Card>
          </CardFrame>

          {tab === 'diagnostics' && <DiagnosticsPanel />}
        </TabsPanel>

        {/* Tab 2: Capabilities, Holds, SecurityRuntimeDetails */}
        <TabsPanel value="security" className="space-y-4">
          <CardFrame>
            <CardFrameHeader>
              <CardFrameTitle>安全核验现场与通道冻结</CardFrameTitle>
              <CardFrameDescription>
                仅在检测到可见安全验证时暂停受影响通道；未决发送记录保持只读冻结，绝不自动重发
              </CardFrameDescription>
            </CardFrameHeader>
            <Card className="space-y-4 p-5">
              {holds.length > 0 ? (
                <div className="space-y-2.5">
                  {holds.map(hold => (
                    <div
                      key={`${hold.channel}:${hold.incidentId}`}
                      className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-warning/35 bg-warning/8 p-4"
                    >
                      <div className="flex items-start gap-3">
                        <ShieldAlertIcon className="mt-0.5 size-5 shrink-0 text-warning-foreground" />
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold text-[13.5px] text-foreground">
                              {hold.channel === 'DIRECT_MESSAGE' ? '私信通道' : '评论通道'} · 安全待核验
                            </span>
                            <Badge variant="warning" size="sm">
                              {hold.mode === 'headed' ? '有头窗口' : '原无头页'}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            原因：{reasons[hold.reason] ?? hold.reason}
                          </p>
                          <p className="text-[11.5px] text-muted-foreground tabular-nums">
                            挂起时间：{time(hold.heldAt)} · 事件编号：
                            <code className="font-mono">{hold.incidentId}</code>
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-6 text-center">
                  <div className="mb-2.5 flex size-10 items-center justify-center rounded-xl bg-success/10 text-success-foreground">
                    <ShieldCheckIcon className="size-5" />
                  </div>
                  <div className="text-sm font-medium text-foreground">
                    当前没有待处理的安全验证现场
                  </div>
                  <p className="mt-1 max-w-md text-xs text-muted-foreground">
                    若平台触发可见安全验证，受影响通道将自动隔离，并可通过顶部横幅直接在原无头页完成人工核验。
                  </p>
                </div>
              )}

              {unresolvedSends.length > 0 && (
                <div className="space-y-2 border-t border-border/75 pt-3.5">
                  <div className="text-xs font-semibold text-warning-foreground">
                    发送结果待核对记录（只读冻结）
                  </div>
                  {unresolvedSends.map(item => (
                    <p
                      key={item.channel}
                      className="rounded-lg border border-warning/30 bg-warning/6 px-3.5 py-2 text-xs text-warning-foreground"
                    >
                      {item.count} 条{item.channel === 'DIRECT_MESSAGE' ? '私信' : '评论'}
                      发送结果仍不明确，原记录保留且禁止重发。
                    </p>
                  ))}
                </div>
              )}
            </Card>
          </CardFrame>

          <CardFrame>
            <CardFrameHeader>
              <CardFrameTitle>通道能力清单</CardFrameTitle>
              <CardFrameDescription>当前已验证的收发能力与通道限制说明</CardFrameDescription>
            </CardFrameHeader>
            <Card className="overflow-hidden">
              <dl className="divide-y divide-border/70 text-xs">
                {status.capabilities.length === 0 ? (
                  <div className="px-5 py-4 text-muted-foreground">尚无通道能力记录。</div>
                ) : (
                  status.capabilities.map(c => (
                    <div
                      key={c.channel}
                      className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5"
                    >
                      <dt className="font-medium text-foreground">
                        {c.channel === 'DIRECT_MESSAGE' ? '私信通道' : '评论通道'}
                      </dt>
                      <dd className="flex flex-wrap items-center gap-2 text-muted-foreground">
                        <Badge
                          variant={
                            c.state === 'SEND_AVAILABLE'
                              ? 'success'
                              : c.state === 'BLOCKED'
                                ? 'error'
                                : 'secondary'
                          }
                          size="sm"
                        >
                          {capabilityNames[c.state] ?? c.state}
                        </Badge>
                        {c.reason && <span>{reasons[c.reason] ?? c.reason}</span>}
                      </dd>
                    </div>
                  ))
                )}
              </dl>
            </Card>
          </CardFrame>

          <div className="[&>details]:rounded-2xl [&>details]:border [&>details]:border-border/85 [&>details]:bg-card [&>details]:px-5 [&>details]:py-4 [&>details]:text-[13px] [&>details]:shadow-xs/5 [&>details>summary]:cursor-pointer [&>details>summary]:font-semibold [&>details>summary]:text-foreground [&>details>dl]:mt-3 [&>details>dl]:space-y-2 [&>details>dl]:text-xs [&>details>p]:mt-2 [&>details>p]:text-xs [&>details>p]:text-muted-foreground">
            <SecurityRuntimeDetails status={status} />
          </div>
        </TabsPanel>

        {/* Tab 3: Read-only Redacted Audit Ledger */}
        <TabsPanel value="audit" className="space-y-4">
          <CardFrame>
            <CardFrameHeader>
              <CardFrameTitle>本地脱敏审计账本（只读）</CardFrameTitle>
              <CardFrameDescription>
                仅展示本地脱敏审计。未知收据和历史证据保留原记录，不可覆盖或删除
              </CardFrameDescription>
            </CardFrameHeader>
            <Card className="overflow-hidden">
              {audit.length === 0 ? (
                <div className="px-6 py-12 text-center text-xs text-muted-foreground">
                  当前页暂无审计记录。
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>时间</TableHead>
                      <TableHead>动作</TableHead>
                      <TableHead>对象编号</TableHead>
                      <TableHead>本地记录</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {audit.map((a, i) => (
                      <TableRow key={`${a.time}-${a.entity_id}-${i}`}>
                        <TableCell className="text-xs text-muted-foreground tabular-nums">
                          {time(a.time)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={auditBadgeVariant(a.event_type)} size="sm">
                            {a.event_type}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-foreground">
                          <code>{a.entity_id}</code>
                        </TableCell>
                        <TableCell className="max-w-[420px] whitespace-normal break-words text-xs text-muted-foreground">
                          {a.detail_redacted}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}

              <div className="pager flex items-center justify-between gap-3 border-t border-border/75 bg-muted/25 px-5 py-3 text-xs text-muted-foreground tabular-nums">
                <span>第 {auditPage + 1} 页（每页最多 50 条）</span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={auditPage === 0}
                    onClick={() => setAuditPage(n => Math.max(0, n - 1))}
                  >
                    上一页
                  </Button>
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={audit.length < 50}
                    onClick={() => setAuditPage(n => n + 1)}
                  >
                    下一页
                  </Button>
                </div>
              </div>
            </Card>
          </CardFrame>
        </TabsPanel>
      </Tabs>
    </div>
  );
}
