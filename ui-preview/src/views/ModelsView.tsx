import type * as React from "react";
import {
  ActivityIcon,
  CheckCircle2Icon,
  CpuIcon,
  GitBranchIcon,
  KeyRoundIcon,
  LockIcon,
  PlusIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ZapIcon,
} from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { ProviderGlyph } from "@/components/DataWidgets";
import { ModelLatencyChart } from "@/components/RichVisuals";
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
import { TASK_ROUTING_ROWS, type ModelConnection } from "@/data/mockData";

interface ModelsProps {
  connections: ModelConnection[];
  selectedConnId: string;
  selectedModelId: string;
  onApplyModel: (connId: string, modelId: string) => void;
  onTestModel: (connId: string) => void;
  onOpenEditor: (connId: string | null) => void;
}

const CAPABILITY_TAGS: Record<string, string[]> = {
  conn_deepseek: ["128K", "低成本", "JSON 稳定"],
  conn_qwen: ["低延迟", "中文优化", "国内直连"],
  conn_openai: ["Responses API", "结构化输出"],
  conn_anthropic: ["长上下文", "细腻语气"],
};

export function ModelsView({
  connections,
  selectedConnId,
  selectedModelId,
  onApplyModel,
  onTestModel,
  onOpenEditor,
}: ModelsProps): React.ReactElement {
  const active = connections.find((c) => c.id === selectedConnId);
  const totalCalls = connections.reduce((s, c) => s + c.callsToday, 0) || 1;
  const tested = connections.filter((c) => c.lastTest?.ok);
  const avgMs = tested.length
    ? Math.round(tested.reduce((s, c) => s + (c.lastTest?.elapsedMs ?? 0), 0) / tested.length)
    : 0;
  const dpapiCount = connections.filter((c) => c.keyPresent && c.storage === "DPAPI").length;
  const memCount = connections.filter((c) => c.keyPresent && c.storage === "MEMORY").length;

  return (
    <div className="mx-auto max-w-[1240px] space-y-4 px-6 py-5">
      <AppHeader
        title="多模型配置"
        description="集中管理多提供商连接与安全凭据，一键切换全局生效模型；所有请求禁止自动重试以防重复扣费"
        actions={
          <Button size="sm" onClick={() => onOpenEditor(null)}>
            <PlusIcon />
            新增模型连接
          </Button>
        }
      />

      {/* Row 1: 3-Column Model Telemetry & Security Strip */}
      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
        <div className="rounded-2xl border border-primary/25 bg-primary/[0.045] p-4 shadow-xs/5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 font-medium text-primary">
              <CpuIcon className="size-3.5" />
              当前全局生效路由
            </span>
            <Badge variant="success" size="sm">生效中</Badge>
          </div>
          <div className="mt-2 font-mono text-lg font-semibold text-foreground">{selectedModelId}</div>
          <p className="mt-1 text-xs text-muted-foreground">
            {active?.name ?? "未设置"} · {active?.storage === "DPAPI" ? "本机加密保存" : "仅本次运行有效"}
          </p>
        </div>

        <div className="rounded-2xl border border-border/80 bg-card p-4 shadow-xs/5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <ActivityIcon className="size-3.5 text-primary" />
              今日调用与预估费用
            </span>
            <Badge variant="outline" size="sm">不自动重试</Badge>
          </div>
          <div className="mt-2 flex items-baseline gap-2.5">
            <span className="font-heading text-2xl font-semibold tabular-nums">{totalCalls} 次</span>
            <span className="text-xs text-muted-foreground tabular-nums">预估费用约 ¥0.29</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            平均响应 {avgMs} ms，包含建议草稿与知识库匹配
          </p>
        </div>

        <div className="rounded-2xl border border-border/80 bg-card p-4 shadow-xs/5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <KeyRoundIcon className="size-3.5 text-primary" />
              API 密钥保护
            </span>
            <Badge variant="secondary" size="sm">本机加密</Badge>
          </div>
          <div className="mt-2 flex items-baseline gap-2.5">
            <span className="font-heading text-2xl font-semibold tabular-nums">
              {dpapiCount + memCount} / {connections.length}
            </span>
            <span className="text-xs text-muted-foreground">
              {dpapiCount} 个长期加密 · {memCount} 个临时生效
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            密钥仅安全保存在你的电脑本地，绝不上传或明文展示
          </p>
        </div>
      </div>

      {/* Row 2: Latency Comparison Visual Chart + Per-Task Routing Matrix */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[0.95fr_1.25fr]">
        <CardFrame>
          <CardFrameHeader>
            <CardFrameTitle>提供商响应耗时对比</CardFrameTitle>
            <CardFrameDescription>基于最近一次单次连通测速（越短响应越快）</CardFrameDescription>
          </CardFrameHeader>
          <Card className="space-y-4 p-4">
            <ModelLatencyChart
              items={connections.map((c) => ({
                name: c.name,
                ms: c.lastTest?.elapsedMs ?? 0,
                calls: c.callsToday,
                active: c.id === selectedConnId,
              }))}
            />
            <div className="grid grid-cols-3 gap-2 rounded-xl bg-muted/40 p-2.5 text-center text-xs">
              <div>
                <div className="font-semibold text-foreground tabular-nums">492 ms</div>
                <div className="text-[10.5px] text-muted-foreground">最快通道</div>
              </div>
              <div>
                <div className="font-semibold text-primary tabular-nums">100%</div>
                <div className="text-[10.5px] text-muted-foreground">今日成功率</div>
              </div>
              <div>
                <div className="font-semibold text-foreground tabular-nums">0 次</div>
                <div className="text-[10.5px] text-muted-foreground">自动重试</div>
              </div>
            </div>
          </Card>
        </CardFrame>

        <CardFrame>
          <CardFrameHeader>
            <CardFrameTitle>分场景调用路由与边界</CardFrameTitle>
            <CardFrameDescription>明确每类任务绑定的模型路由与安全隔离策略</CardFrameDescription>
            <CardFrameAction>
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <GitBranchIcon className="size-3.5 text-primary" />
                4 项任务链路
              </span>
            </CardFrameAction>
          </CardFrameHeader>
          <Card className="divide-y divide-border/70">
            {TASK_ROUTING_ROWS.map((r) => (
              <div key={r.task} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-xs">
                <div className="min-w-0">
                  <div className="font-medium text-foreground">{r.task}</div>
                  <div className="text-[11px] text-muted-foreground">{r.desc}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant="outline" size="sm" className="font-mono">{r.model}</Badge>
                  <Badge variant="secondary" size="sm">{r.guard}</Badge>
                </div>
              </div>
            ))}
          </Card>
        </CardFrame>
      </div>

      {/* Row 3: Rich Provider Connection List */}
      <CardFrame>
        <CardFrameHeader>
          <CardFrameTitle>已配置模型连接（{connections.length}）</CardFrameTitle>
          <CardFrameDescription>
            点击任一模型标签即可切换全局生效路由；未配置密钥的连接保持锁定不可启用
          </CardFrameDescription>
          <CardFrameAction>
            <span className="text-xs text-muted-foreground">
              支持 OpenAI Chat / Responses / Anthropic / Gemini
            </span>
          </CardFrameAction>
        </CardFrameHeader>
        <Card className="divide-y divide-border/70">
          {connections.map((c) => {
            const isCurrent = c.id === selectedConnId;
            const sharePct = Math.round((c.callsToday / totalCalls) * 100);
            const latencyMs = c.lastTest?.elapsedMs ?? 0;
            const latencyPct = latencyMs ? Math.min(100, Math.round((latencyMs / 1200) * 100)) : 0;
            return (
              <div
                key={c.id}
                className={`grid grid-cols-1 items-center gap-4 px-5 py-4 transition-colors first:rounded-t-xl last:rounded-b-xl xl:grid-cols-[minmax(0,1fr)_180px_380px] ${
                  isCurrent ? "bg-primary/[0.035]" : "hover:bg-muted/35"
                }`}
              >
                <div className="flex min-w-0 items-start gap-3.5">
                  <ProviderGlyph id={c.id} />
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-semibold text-[14px] text-foreground">{c.name}</span>
                      {isCurrent && <Badge variant="success" size="sm">正在使用</Badge>}
                      <Badge variant="outline" size="sm">{c.protocol}</Badge>
                      {(CAPABILITY_TAGS[c.id] ?? []).map((tag) => (
                        <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {tag}
                        </span>
                      ))}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="truncate font-mono text-[11.5px]">{c.baseUrl}</span>
                      <span>·</span>
                      <span>{c.region}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 pt-0.5">
                      {c.keyPresent ? (
                        <Badge variant={c.storage === "DPAPI" ? "success" : "warning"} size="sm">
                          <LockIcon />
                          {c.storage === "DPAPI" ? "本机加密保存" : "仅本次运行有效"}
                        </Badge>
                      ) : (
                        <Badge variant="outline" size="sm">未配置密钥</Badge>
                      )}
                      {c.lastTest && (
                        <span className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground tabular-nums">
                          <CheckCircle2Icon className="size-3 text-success" />
                          连接正常 · {c.lastTest.elapsedMs} ms
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground tabular-nums">
                      <span>今日调用 {c.callsToday} 次</span>
                      <span>{sharePct}%</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary/80" style={{ width: `${sharePct}%` }} />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground tabular-nums">
                      <span>连通耗时</span>
                      <span className={latencyMs > 0 && latencyMs < 700 ? "font-medium text-primary" : ""}>
                        {latencyMs > 0 ? `${latencyMs} ms` : "未测速"}
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={`h-full rounded-full ${latencyMs > 750 ? "bg-chart-2" : "bg-primary/60"}`}
                        style={{ width: `${latencyPct}%` }}
                      />
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2.5">
                  <div className="flex flex-wrap gap-1.5">
                    {c.models.map((m) => {
                      const activeChip = isCurrent && selectedModelId === m;
                      return (
                        <Button
                          key={m}
                          size="xs"
                          variant={activeChip ? "default" : "outline"}
                          disabled={!c.keyPresent}
                          className="font-mono"
                          onClick={() => onApplyModel(c.id, m)}
                        >
                          {m}
                        </Button>
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="outline" size="xs" disabled={!c.keyPresent} onClick={() => onTestModel(c.id)}>
                      <ZapIcon />
                      测速
                    </Button>
                    <Button variant="ghost" size="xs" onClick={() => onOpenEditor(c.id)}>
                      编辑
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </Card>
      </CardFrame>

      {/* Bottom Safety Guardrail Matrix */}
      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
        <div className="flex items-start gap-3 rounded-xl border border-border/75 bg-muted/30 p-3.5">
          <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-primary" />
          <div className="space-y-0.5 text-xs">
            <div className="font-semibold text-foreground">不自动重试扣费</div>
            <p className="text-muted-foreground">
              请求超时或失败时不会在后台静默反复重试，直接交回人工确认，避免产生多余费用。
            </p>
          </div>
        </div>
        <div className="flex items-start gap-3 rounded-xl border border-border/75 bg-muted/30 p-3.5">
          <LockIcon className="mt-0.5 size-4 shrink-0 text-primary" />
          <div className="space-y-0.5 text-xs">
            <div className="font-semibold text-foreground">仅负责生成建议</div>
            <p className="text-muted-foreground">
              AI 仅基于你的知识库产出回复文案，不接触账号登录态，也无法擅自发送消息。
            </p>
          </div>
        </div>
        <div className="flex items-start gap-3 rounded-xl border border-border/75 bg-muted/30 p-3.5">
          <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-primary" />
          <div className="space-y-0.5 text-xs">
            <div className="font-semibold text-foreground">图片与隐私不外传</div>
            <p className="text-muted-foreground">
              客户发来的图片和视频仅留在本地待人工查看，不会交给模型猜测回复。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
