import { useState } from 'react';
import type * as React from 'react';
import { FileTextIcon, SlidersHorizontalIcon, SparklesIcon } from 'lucide-react';
import { AutomationSettings } from '@/AutomationSettings';
import { ReplyPipelineSettings } from '@/ReplyPipelineSettings';
import { SettingsDialog } from '@/SettingsDialog';
import { AutoReplySwitch } from '@/components/AutoReplySwitch';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardFrame,
  CardFrameAction,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
} from '@/components/ui/card';
import { reasons, request, type Status } from '@/api';
import { modes } from '@/presentation';
import type { BusinessPromptsController } from '@/useBusinessPrompts';

export interface AutomationViewProps {
  status: Status;
  busy: string;
  error?: string;
  notice?: string;
  act: (label: string, fn: () => Promise<void>) => Promise<void>;
  update: (status: Status) => void;
  promptsState: BusinessPromptsController;
  toggleAuto: (enabled: boolean) => Promise<void>;
  pendingAutoReply: boolean | null;
}

const selectCls =
  'h-8.5 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-[13px] text-foreground shadow-xs/5 outline-none transition-shadow focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/32';
const textareaCls =
  'w-full min-w-0 rounded-lg border border-input bg-background px-3 py-2 text-[13px] leading-relaxed text-foreground shadow-xs/5 outline-none transition-shadow focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/32';
const btnPrimaryCls =
  'inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-primary bg-primary px-3 text-xs font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55';

export function AutomationView({
  status,
  busy,
  error = '',
  notice = '',
  act,
  update,
  promptsState,
  toggleAuto,
  pendingAutoReply,
}: AutomationViewProps): React.ReactElement {
  const [promptsOpen, setPromptsOpen] = useState(false);
  const {
    prompts,
    promptBusy,
    promptError,
    promptNotice,
    canSavePrompts,
    devRecoveryRestoring,
    updatePromptField,
    savePrompts,
  } = promptsState;

  const autoOn =
    status.configuredMode === 'LIMITED_AUTO' && Boolean(status.automation?.replyPolicy);
  const hasReplyPolicy = Boolean(status.automation?.replyPolicy);
  const emergencyStopped = Boolean(status.automation?.emergencyStopped || status.paused);
  const switchDisabled = pendingAutoReply !== null || !!busy || !hasReplyPolicy;
  const switchHint = !hasReplyPolicy
    ? '请先在下方保存并启用自动回复策略'
    : emergencyStopped
      ? '当前处于急停状态，恢复运行后可继续'
      : autoOn
        ? '点击暂停自动回复（保留策略配置）'
        : '点击按已保存策略开启自动回复';

  return (
    <div className="settings mx-auto max-w-[1200px] space-y-5 px-6 py-5">
      <PageHeader
        title="自动化规则"
        description="统一管理自动回复总开关、工作模式、后台收取范围、持续授权额度与业务提示词"
        actions={
          <label
            title={switchHint}
            className="check inline-flex cursor-pointer items-center gap-2.5 rounded-xl border border-border bg-card px-3.5 py-2 text-xs font-medium text-foreground shadow-xs/5 select-none has-[:disabled]:cursor-not-allowed"
          >
            <AutoReplySwitch
              checked={pendingAutoReply ?? autoOn}
              disabled={switchDisabled}
              ariaLabel="设置中的自动回复"
              title={switchHint}
              onChange={enabled => {
                void act('更新自动回复', () => toggleAuto(enabled));
              }}
            />
            <span>
              {pendingAutoReply !== null
                ? pendingAutoReply
                  ? '正在开启自动回复…'
                  : '正在关闭自动回复…'
                : `自动回复：${autoOn ? '开' : '关'}`}
            </span>
          </label>
        }
      />

      {/* Row 1: Unified Auto-Reply Status + Working Mode + Business Prompts */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <CardFrame>
          <CardFrameHeader>
            <CardFrameTitle>自动回复运行状态</CardFrameTitle>
            <CardFrameDescription>
              关闭仅暂停自动回复，账号在线、后台收取与人稿保留
            </CardFrameDescription>
            <CardFrameAction>
              <Badge variant={autoOn ? 'success' : 'secondary'} size="sm">
                <SparklesIcon />
                {autoOn ? '已开启' : '已暂停'}
              </Badge>
            </CardFrameAction>
          </CardFrameHeader>
          <Card className="space-y-2.5 p-4 text-xs">
            <div className="flex items-center justify-between text-muted-foreground">
              <span>规则策略</span>
              <span className="font-medium text-foreground tabular-nums">
                {status.automation?.replyPolicy
                  ? `版本 ${status.automation.replyPolicy.version}`
                  : '尚未启用策略'}
              </span>
            </div>
            <div className="flex items-center justify-between text-muted-foreground">
              <span>人工 AI 建议授权</span>
              <span className="font-medium text-foreground tabular-nums">
                {status.automation?.modelGrant
                  ? `版本 ${status.automation.modelGrant.version}`
                  : '未单独启用'}
              </span>
            </div>
            <p className="pt-1 leading-relaxed text-muted-foreground">
              在下方配置收取范围与规则并保存后，可随时使用右上角开关启停自动回复。
            </p>
          </Card>
        </CardFrame>

        <CardFrame>
          <CardFrameHeader>
            <CardFrameTitle>工作模式</CardFrameTitle>
            <CardFrameDescription>
              切换模式不会开启未经核验的发送能力；新账号默认仅保存草稿
            </CardFrameDescription>
            <CardFrameAction>
              <SlidersHorizontalIcon className="size-4 text-primary" />
            </CardFrameAction>
          </CardFrameHeader>
          <Card className="space-y-3 p-4">
            <label className="flex flex-col gap-1.5 text-xs font-medium text-foreground">
              工作模式
              <select
                className={selectCls}
                value={status.configuredMode}
                disabled={!!busy}
                onChange={e =>
                  void act('更新模式', async () =>
                    update(
                      await request<Status>({
                        command: 'setMode',
                        mode: e.target.value as Status['mode'],
                      }),
                    ),
                  )
                }
              >
                {Object.entries(modes).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {status.mode !== status.configuredMode && (
              <p
                className="rounded-lg border border-info/30 bg-info/6 px-3 py-2 text-xs text-info-foreground"
                role="status"
              >
                已选择{modes[status.configuredMode]}；正在自动连接账号，连接后即可继续。
              </p>
            )}
          </Card>
        </CardFrame>

        <CardFrame>
          <CardFrameHeader>
            <CardFrameTitle>业务提示词</CardFrameTitle>
            <CardFrameDescription>
              维护账号人设、业务说明与回复规则，不丢失未保存输入
            </CardFrameDescription>
            <CardFrameAction>
              <FileTextIcon className="size-4 text-primary" />
            </CardFrameAction>
          </CardFrameHeader>
          <Card className="flex flex-col justify-between gap-3 p-4">
            <div className="space-y-1 text-xs text-muted-foreground tabular-nums">
              <div>账号人设：{[...prompts.persona].length} 字</div>
              <div>业务说明：{[...prompts.business].length} 字</div>
              <div>回复规则：{[...prompts.rules].length} 字</div>
            </div>
            <div>
              <Button variant="outline" size="sm" onClick={() => setPromptsOpen(true)}>
                编辑业务提示词
              </Button>
            </div>
          </Card>
        </CardFrame>
      </div>

      <SettingsDialog
        title="业务提示词"
        open={promptsOpen}
        onClose={() => setPromptsOpen(false)}
        busy={promptBusy ? '正在保存业务提示词…' : ''}
        error={promptError}
        notice={promptNotice}
      >
        {(['persona', 'business', 'rules'] as const).map((field, i) => (
          <label key={field} className="flex flex-col gap-1.5 text-xs font-medium text-foreground">
            {['账号人设', '业务说明', '回复规则'][i]}
            <textarea
              rows={field === 'persona' ? 4 : 5}
              className={textareaCls}
              value={prompts[field]}
              maxLength={field === 'persona' ? 2000 : 4000}
              onChange={e => updatePromptField(field, e.target.value)}
            />
          </label>
        ))}
        {!canSavePrompts && (
          <p className="hint text-xs text-muted-foreground" role="status">
            {reasons.BUSINESS_PROMPTS_BACKEND_UPGRADE_REQUIRED}
          </p>
        )}
        <div className="flex justify-end pt-1">
          <button
            className={btnPrimaryCls}
            disabled={promptBusy || !canSavePrompts || devRecoveryRestoring}
            onClick={savePrompts}
          >
            保存业务提示词
          </button>
        </div>
      </SettingsDialog>

      {/* Row 2: Full Automation Settings Panel */}
      {status.automation ? (
        <>
          <AutomationSettings
            status={status}
            busy={busy}
            error={error}
            notice={notice}
            act={act}
            update={update}
          />
          <ReplyPipelineSettings
            accountId={status.account?.id ?? null}
            disabled={!!busy}
          />
        </>
      ) : (
        <Card className="p-6 text-center text-xs text-muted-foreground">
          当前内核尚未初始化自动化状态，请确认连接运行目录后重试。
        </Card>
      )}
    </div>
  );
}
