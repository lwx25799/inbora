import { useCallback, useEffect, useState } from 'react';
import type * as React from 'react';
import {
  ActivityIcon,
  CpuIcon,
  KeyRoundIcon,
  LockIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
} from 'lucide-react';
import type { PublicModelState } from '../../../src/contracts/model-providers.js';
import { AiRuntimeFeaturesPanel } from '@/AiRuntimeFeaturesPanel';
import { ModelProviderSettings } from '@/ModelProviderSettings';
import { ModelSlotPanel } from '@/ModelSlotPanel';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/badge';
import { modelPresetNames, type Status } from '@/api';

export interface ModelsPageViewProps {
  status: Status;
  updateProviders: (next: Status, previous: Status) => void;
}

export function ModelsPageView({
  status,
  updateProviders,
}: ModelsPageViewProps): React.ReactElement {
  const [directoryState, setDirectoryState] = useState<PublicModelState | undefined>(
    status.modelProviders,
  );
  const [directoryError, setDirectoryError] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!status.modelProviders) {
      setDirectoryState(undefined);
      setDirectoryError(undefined);
    } else if (status.modelProviders.nextConnectionOffset == null) {
      setDirectoryState(status.modelProviders);
      setDirectoryError(undefined);
    }
  }, [status.modelProviders]);
  const handleDirectoryStateChange = useCallback((next: PublicModelState, error?: string) => {
    setDirectoryState(next);
    setDirectoryError(error);
  }, []);

  const providerState = directoryState ?? status.modelProviders;
  const connections = providerState?.connections ?? [];
  const totalConnections = providerState?.totalConnectionCount ?? connections.length;
  const hasMoreConnections =
    providerState?.nextConnectionOffset != null && totalConnections > connections.length;
  const loadingMoreConnections = hasMoreConnections && !directoryError;
  const selection = providerState?.selection;
  const activeConn =
    selection && selection.connectionId !== null
      ? connections.find(c => c.id === selection.connectionId)
      : undefined;
  const activeApplied =
    activeConn && selection && activeConn.applied?.routeRevision === selection.routeRevision
      ? activeConn.applied
      : null;

  const activeModelId =
    selection && selection.connectionId !== null
      ? selection.modelId
      : status.settings.model || '尚未应用模型';
  const activeModelLabel =
    selection && selection.connectionId !== null && selection.modelDisplayName
      ? `${selection.modelDisplayName}（${selection.modelId}）`
      : activeModelId;

  const modelBudget = status.budgets.find(b => b.kind === 'MODEL');
  const dpapiCount = connections.filter(c => c.draft.keyPresent && c.draft.keyStored).length;
  const memoryCount = connections.filter(c => c.draft.keyPresent && !c.draft.keyStored).length;
  const configuredCount = dpapiCount + memoryCount;

  return (
    <div className="mx-auto max-w-[1220px] space-y-5 px-6 py-5">
      <PageHeader
        title="多模型配置"
        description="集中管理多提供商连接与本机加密凭据，全应用统一使用当前全局生效模型，请求失败不自动重试"
      />

      {/* Row 1: 3 Real Telemetry & Credential Cards */}
      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
        <div className="rounded-2xl border border-primary/25 bg-primary/[0.04] p-4 shadow-xs/5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 font-medium text-primary">
              <CpuIcon className="size-3.5" />
              当前全局生效模型
            </span>
            <Badge variant={status.modelAuthorized ? 'success' : 'secondary'} size="sm">
              {status.modelAuthorized ? '调用已授权' : '未授权'}
            </Badge>
          </div>
          <div className="mt-2 truncate font-mono text-[15px] font-semibold text-foreground" title={activeModelLabel}>
            {activeModelId}
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {activeConn && activeApplied
              ? `${activeConn.name} · ${modelPresetNames[activeApplied.presetId]} · ${
                  activeApplied.keyStored ? '本机加密保存' : activeApplied.keyPresent ? '仅本次内存' : '未配置 Key'
                }`
              : '尚未在下方应用模型连接'}
          </p>
        </div>

        <div className="rounded-2xl border border-border/80 bg-card p-4 shadow-xs/5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <ActivityIcon className="size-3.5 text-primary" />
              累计模型调用与 Token
            </span>
            <Badge variant="outline" size="sm">
              不自动重试
            </Badge>
          </div>
          <div className="mt-2 flex flex-wrap items-baseline gap-2">
            <span className="font-heading text-2xl font-semibold text-foreground tabular-nums">
              {modelBudget ? modelBudget.used : status.usage.requests} 次
            </span>
            {modelBudget && (
              <span className="text-xs text-muted-foreground tabular-nums">
                / 额度 {modelBudget.maximum === null ? '无上限' : modelBudget.maximum}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground tabular-nums">
            输入 {status.usage.inputTokens.toLocaleString('zh-CN')} · 输出{' '}
            {status.usage.outputTokens.toLocaleString('zh-CN')}
            {status.usage.unresolved > 0 ? ` · 用量未知 ${status.usage.unresolved} 次` : ''}
          </p>
        </div>

        <div className="rounded-2xl border border-border/80 bg-card p-4 shadow-xs/5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <KeyRoundIcon className="size-3.5 text-primary" />
              已配置连接与凭据
            </span>
            <Badge variant="secondary" size="sm">
              本机保存
            </Badge>
          </div>
          <div className="mt-2 flex items-baseline gap-2.5">
            <span className="font-heading text-2xl font-semibold text-foreground tabular-nums">
              {hasMoreConnections ? `${configuredCount}+ / ${totalConnections}` : `${configuredCount} / ${totalConnections}`}
            </span>
            <span
              className={`text-xs tabular-nums ${
                hasMoreConnections && directoryError
                  ? 'font-medium text-destructive-foreground'
                  : 'text-muted-foreground'
              }`}
            >
              {hasMoreConnections && directoryError
                ? '其余连接读取失败，请见下方重试'
                : loadingMoreConnections
                  ? `已载入 ${connections.length}/${totalConnections}，正在读取其余连接…`
                  : `${dpapiCount} 个长期加密 · ${memoryCount} 个临时内存`}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            API Key 仅保存在本机受保护存储，界面绝不回显明文
          </p>
        </div>
      </div>

      {/* Row 2: Full Interactive Model Provider Settings */}
      <ModelProviderSettings
        status={status}
        update={updateProviders}
        onDirectoryStateChange={handleDirectoryStateChange}
      />

      {/* Row 3: Progressive 4-Slot Routing & Per-Account AI Runtime Features */}
      <ModelSlotPanel
        state={providerState}
        available={Boolean(
          status.modelProvidersSupported &&
            status.modelProvidersAvailable === true &&
            status.modelProviders,
        )}
        refreshing={loadingMoreConnections || hasMoreConnections}
      />
      <AiRuntimeFeaturesPanel
        key={status.account?.id ?? 'default'}
        accountId={status.account?.id ?? null}
        accountLabel={status.account?.identity ?? null}
      />

      {/* Row 4: Static Safety Guardrail Summary */}
      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
        <div className="flex items-start gap-3 rounded-xl border border-border/75 bg-muted/30 p-3.5">
          <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-primary" />
          <div className="space-y-0.5 text-xs">
            <div className="font-semibold text-foreground">超时与失败不自动重试</div>
            <p className="text-muted-foreground">
              请求异常时直接回退至人工处理，不静默重试扣费，未返回用量时不推算费用。
            </p>
          </div>
        </div>
        <div className="flex items-start gap-3 rounded-xl border border-border/75 bg-muted/30 p-3.5">
          <LockIcon className="mt-0.5 size-4 shrink-0 text-primary" />
          <div className="space-y-0.5 text-xs">
            <div className="font-semibold text-foreground">主对话优先与按需分流</div>
            <p className="text-muted-foreground">
              人工建议、自动回复与试聊默认使用主对话模型；看图、后台辅助与云端向量槽位可按需单独绑定或自动降级。
            </p>
          </div>
        </div>
        <div className="flex items-start gap-3 rounded-xl border border-border/75 bg-muted/30 p-3.5">
          <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-primary" />
          <div className="space-y-0.5 text-xs">
            <div className="font-semibold text-foreground">媒体与登录态隔离</div>
            <p className="text-muted-foreground">
              多模态看图按账号默认关闭，仅在显式开启后才允许将客户发来的截图或图片送入视觉模型；浏览器登录态、真实缓存头像与固定说明始终隔离。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
