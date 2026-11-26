import * as React from "react";
import { DownloadIcon, ShieldAlertIcon, ShieldCheckIcon } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardFrame,
  CardFrameAction,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import type { AuditRow } from "@/data/mockData";

interface RuntimeProps {
  auditRows: AuditRow[];
  securityHoldActive: boolean;
  onOpenVerify: () => void;
  onSimulateHold: () => void;
  onExportAudit: () => void;
}

const WORKERS = [
  { id: "核心业务进程", role: "状态机、唯一发送协调与数据库写者", scope: "全部 6 账号", state: "运行正常", rss: 126, priv: 94, queue: "无积压" },
  { id: "浏览器工作进程 #1", role: "无头静音 Edge（独占 Profile）", scope: "禾木手作旗舰号", state: "运行正常", rss: 312, priv: 238, queue: "串行空闲" },
  { id: "浏览器工作进程 #2", role: "无头静音 Edge（独占 Profile）", scope: "禾木设计精选号", state: "运行正常", rss: 278, priv: 206, queue: "串行空闲" },
  { id: "浏览器工作进程 #3", role: "多号轮转无头容器", scope: "禾木器物志（小红书）", state: "轮转待命", rss: 262, priv: 194, queue: "下次轮巡 00:38" },
  { id: "桌面协助进程 #1", role: "按需无状态 Python UIA", scope: "主理人私域号（个人微信）", state: "前台按需", rss: 138, priv: 102, queue: "等待桌面焦点" },
];

export function RuntimeView({
  auditRows,
  securityHoldActive,
  onOpenVerify,
  onSimulateHold,
  onExportAudit,
}: RuntimeProps): React.ReactElement {
  const [tab, setTab] = React.useState("queues");

  return (
    <div className="mx-auto max-w-[1160px] px-7 py-6">
      <AppHeader
        title="调度与审计"
        description="监控受控子进程内存水位、安全核验现场与不可篡改的本地脱敏审计记录"
        actions={
          <Button variant="outline" size="sm" onClick={onExportAudit}>
            <DownloadIcon />
            导出脱敏记录
          </Button>
        }
      />

      <Tabs value={tab} onValueChange={setTab} className="gap-5">
        <div className="border-b border-border">
          <TabsList variant="underline" className="pb-0">
            <TabsTab value="queues">运行与资源</TabsTab>
            <TabsTab value="security">
              安全与风控现场
              {securityHoldActive && <Badge variant="warning" size="sm" className="ml-1.5">1</Badge>}
            </TabsTab>
            <TabsTab value="audit">操作审计账本</TabsTab>
          </TabsList>
        </div>

        <TabsPanel value="queues" className="space-y-5">
          <CardFrame>
            <Card className="overflow-hidden">
              <div className="grid grid-cols-2 divide-y divide-border/70 lg:grid-cols-4 lg:divide-x lg:divide-y-0">
                <div className="px-5 py-4">
                  <div className="text-xs text-muted-foreground">受控进程总工作集</div>
                  <div className="mt-1 font-semibold text-2xl tabular-nums">1,116 MiB</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">不含系统普通浏览器</div>
                </div>
                <div className="px-5 py-4">
                  <div className="text-xs text-muted-foreground">近 1 小时 P95 峰值</div>
                  <div className="mt-1 font-semibold text-2xl tabular-nums">1,148 MiB</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">每 60 秒自动采样</div>
                </div>
                <div className="px-5 py-4">
                  <div className="text-xs text-muted-foreground">账号串行队列</div>
                  <div className="mt-1 font-semibold text-2xl tabular-nums">6 路</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">单号并发 1 · 人工优先</div>
                </div>
                <div className="px-5 py-4">
                  <div className="text-xs text-muted-foreground">退避冷却对象</div>
                  <div className="mt-1 font-semibold text-2xl tabular-nums">0 个</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">全部队列健康轮转</div>
                </div>
              </div>
            </Card>
          </CardFrame>

          <CardFrame>
            <CardFrameHeader>
              <CardFrameTitle>进程隔离拓扑</CardFrameTitle>
              <CardFrameDescription>
                所有浏览器与桌面协助子进程均严禁直连数据库，统一经核心进程鉴权通信
              </CardFrameDescription>
            </CardFrameHeader>
            <Card className="overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>进程</TableHead>
                    <TableHead>职责与边界</TableHead>
                    <TableHead>归属账号</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="text-right">工作集 / 私有</TableHead>
                    <TableHead>队列</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {WORKERS.map((w) => {
                    const held = securityHoldActive && w.id === "浏览器工作进程 #2";
                    return (
                      <TableRow key={w.id}>
                        <TableCell className="font-medium">{w.id}</TableCell>
                        <TableCell className="text-muted-foreground">{w.role}</TableCell>
                        <TableCell>{w.scope}</TableCell>
                        <TableCell>
                          <Badge variant={held ? "warning" : w.state === "运行正常" ? "success" : "secondary"} size="sm">
                            {held ? "评论待核验" : w.state}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {w.rss} / {w.priv} MiB
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {held ? "私信正常 · 评论暂停" : w.queue}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Card>
          </CardFrame>
        </TabsPanel>

        <TabsPanel value="security">
          <CardFrame>
            <CardFrameHeader>
              <CardFrameTitle>安全核验现场</CardFrameTitle>
              <CardFrameDescription>
                自动忽略页面空壳占位；仅在检出可见验证时暂停受影响通道，支持在应用内直接完成原页核验
              </CardFrameDescription>
              <CardFrameAction>
                {!securityHoldActive && (
                  <Button variant="outline" size="xs" onClick={onSimulateHold}>
                    模拟一次通道安全核验
                  </Button>
                )}
              </CardFrameAction>
            </CardFrameHeader>
            <Card className="p-6">
              {securityHoldActive ? (
                <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-warning/35 bg-warning/6 p-4">
                  <div className="flex items-start gap-3">
                    <ShieldAlertIcon className="mt-0.5 size-5 shrink-0 text-warning-foreground" />
                    <div>
                      <div className="font-semibold text-[14px]">
                        禾木设计精选号 · 评论通道出现可见安全验证
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        仅暂停该账号评论收取、模型与发送；同一账号私信通道不受影响。点击右侧按钮在原无头页面内完成人工核验。
                      </p>
                    </div>
                  </div>
                  <Button size="sm" onClick={onOpenVerify}>
                    处理原验证页面
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <div className="mb-3 flex size-10 items-center justify-center rounded-xl bg-success/10 text-success-foreground">
                    <ShieldCheckIcon className="size-5" />
                  </div>
                  <div className="font-medium text-foreground">当前没有待处理的安全验证现场</div>
                  <p className="mt-1 max-w-md text-xs text-muted-foreground">
                    所有网页通道运行平稳；你可以点击右上角或侧栏底部的场景切换器随时体验「原无头页内安全核验」完整流程。
                  </p>
                </div>
              )}
            </Card>
          </CardFrame>
        </TabsPanel>

        <TabsPanel value="audit">
          <CardFrame>
            <CardFrameHeader>
              <CardFrameTitle>本地脱敏审计账本（只读）</CardFrameTitle>
              <CardFrameDescription>
                发送确认、结果未知冻结、急停与配置变更原样留痕，严禁覆盖或删改
              </CardFrameDescription>
            </CardFrameHeader>
            <Card className="overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>时间</TableHead>
                    <TableHead>事件</TableHead>
                    <TableHead>账号 / 作用域</TableHead>
                    <TableHead>对象编号</TableHead>
                    <TableHead>脱敏摘要</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {auditRows.map((r, i) => (
                    <TableRow key={i}>
                      <TableCell className="tabular-nums text-muted-foreground">{r.time}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            r.type.includes("冻结") || r.type.includes("急停")
                              ? "error"
                              : r.type.includes("核验")
                                ? "warning"
                                : "secondary"
                          }
                          size="sm"
                        >
                          {r.type}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-medium">{r.scope}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{r.entity}</TableCell>
                      <TableCell className="text-muted-foreground">{r.detail}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          </CardFrame>
        </TabsPanel>
      </Tabs>
    </div>
  );
}
