import { request, reasons, type Status } from './api';
import { SecurityRuntimeDetails } from './SecurityRuntimeDetails';

interface Props {
  status: Status;
  busy: string;
  act: (label: string, action: () => Promise<void>) => Promise<void>;
  update: (status: Status) => void;
}

const toggleWrapperCls =
  '[&>button]:inline-flex [&>button]:h-8 [&>button]:shrink-0 [&>button]:cursor-pointer [&>button]:items-center [&>button]:justify-center [&>button]:whitespace-nowrap [&>button]:rounded-lg [&>button]:border [&>button]:border-input [&>button]:bg-popover [&>button]:px-3 [&>button]:text-xs [&>button]:font-medium [&>button]:text-foreground [&>button]:shadow-xs/5 [&>button]:transition-colors [&>button]:hover:bg-accent/60 [&>button]:focus-visible:outline-none [&>button]:focus-visible:ring-2 [&>button]:focus-visible:ring-ring [&>button]:disabled:pointer-events-none [&>button]:disabled:opacity-55 dark:[&>button]:bg-input/32';

export function LocalAssistantSettings({ status, busy, act, update }: Props) {
  const state = status.localAssistant;
  const connection = status.localAssistantConnection;
  const enabled = state?.connectionEnabled !== false;
  return (
    <div
      className="settings-section flex flex-col gap-3.5 rounded-2xl border border-border/85 bg-card p-5 text-card-foreground shadow-xs/5"
      aria-labelledby="local-assistant-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="local-assistant-title" className="font-heading text-[15px] font-semibold tracking-tight text-foreground">
          本机助手连接（MCP）
        </h2>
        <span
          className={`inline-flex items-center rounded-sm px-2 py-0.5 text-[11px] font-medium ${
            enabled
              ? 'bg-success/10 text-success-foreground'
              : 'bg-secondary text-secondary-foreground'
          }`}
        >
          {connection?.tools ?? 16} 个受控工具
        </span>
      </div>

      <p
        role="status"
        className="rounded-xl border border-border/75 bg-muted/35 px-3.5 py-2 text-xs font-medium text-foreground"
      >
        助手连接：{enabled ? '已启用' : '已停用'} · 本机控制入口：
        {connection?.ready ? '已就绪' : '尚未就绪'}
      </p>

      <p className="text-[13px] leading-relaxed text-foreground">
        本机助手连接后即可查询收件箱、同步、编辑草稿和发送文字回复，无需另设助手权限或额度。
      </p>
      <p className="hint text-xs leading-relaxed text-muted-foreground">
        沿用当前账号、已保存收取范围、应用累计额度与模型许可；生成 AI 建议仍需可用的模型 Key。
      </p>
      <p className="hint text-xs leading-relaxed text-muted-foreground">
        仅支持正文完整且已核验的文字消息。人工编辑中的回复、人稿及现有发送记录保留。
      </p>
      {state?.reason && !(enabled && !state.grant && state.reason === 'ASSISTANT_PERMISSION_REQUIRED') && (
        <p className="hint rounded-xl border border-warning/35 bg-warning/8 px-3 py-2 text-xs text-warning-foreground">
          {reasons[state.reason] ?? '助手暂不可执行当前操作，请核对应用运行状态。'}
        </p>
      )}
      <p className="hint rounded-xl border border-border/70 bg-background px-3 py-2 text-xs text-muted-foreground tabular-nums">
        应用累计：
        {status.budgets
          .map(
            budget =>
              `${budget.kind === 'MODEL' ? '模型' : '发送'} ${budget.used}/${budget.maximum === null ? '无上限' : budget.maximum}`,
          )
          .join(' · ') || '尚未取得额度'}
      </p>

      <div className={toggleWrapperCls}>
        <button
          disabled={!!busy || !state}
          onClick={() =>
            void act(enabled ? '停用助手连接' : '启用助手连接', async () =>
              update(
                await request<Status>({
                  command: 'setLocalAssistantGrant',
                  enabled: !enabled,
                  confirmed: true,
                }),
              ),
            )
          }
        >
          {enabled ? '停用助手连接' : '启用助手连接'}
        </button>
      </div>

      <p className="hint text-xs leading-relaxed text-muted-foreground">
        停用立即阻止新的助手操作。已提交消息继续只读确认，不撤回、不重发；消息、草稿和已消费额度保留。
      </p>

      <details className="settings-disclosure rounded-xl border border-border/80 bg-muted/30 px-4 py-3 text-[13px]">
        <summary className="cursor-pointer font-medium text-[13px] text-foreground select-none">
          MCP 连接详情 · {connection?.tools ?? 16} 个工具
        </summary>
        <div className="mt-3 flex flex-col gap-2.5">
          <dl className="divide-y divide-border/70 rounded-lg border border-border/75 bg-card text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <dt className="text-muted-foreground">当前运行目录</dt>
              <dd>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground break-all">
                  {status.runtime}
                </code>
              </dd>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <dt className="text-muted-foreground">后端实例</dt>
              <dd>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                  {connection?.instanceId ?? '尚未建立'}
                </code>
              </dd>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <dt className="text-muted-foreground">连接方式</dt>
              <dd className="font-mono text-[11.5px] text-foreground">
                stdio · {connection?.tools ?? 16} 个工具
              </dd>
            </div>
          </dl>
          <p className="hint text-xs leading-relaxed text-muted-foreground">
            入口就绪仅表示客户端可供连接。Codex 中的安装与实际工具调用需单独核验。
          </p>
        </div>
      </details>

      <div className="[&>details]:rounded-xl [&>details]:border [&>details]:border-border/80 [&>details]:bg-muted/30 [&>details]:px-4 [&>details]:py-3 [&>details]:text-[13px] [&>details>summary]:cursor-pointer [&>details>summary]:font-medium [&>details>summary]:text-foreground">
        <SecurityRuntimeDetails status={status} />
      </div>
    </div>
  );
}
