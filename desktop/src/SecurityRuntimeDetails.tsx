import type { Status } from './api';

export function SecurityRuntimeDetails({ status }: { status: Status }) {
  const runtime = status.securityRuntime;
  const mismatch =
    runtime?.instanceId &&
    status.localAssistantConnection?.instanceId &&
    runtime.instanceId !== status.localAssistantConnection.instanceId;

  return (
    <details className="settings-disclosure rounded-xl border border-border/80 bg-card/70 px-4 py-3 text-xs text-foreground">
      <summary className="cursor-pointer select-none font-medium text-foreground transition-colors hover:text-primary">
        安全检查运行版本
      </summary>
      <dl className="mt-3 grid gap-2 border-t border-border/70 pt-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <dt className="text-muted-foreground">后端实例</dt>
          <dd className="m-0">
            <code className="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-[11px] text-foreground">
              {runtime?.instanceId ?? '尚未取得'}
            </code>
          </dd>
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <dt className="text-muted-foreground">检测规则版本</dt>
          <dd className="m-0">
            <code className="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-[11px] text-foreground">
              {runtime?.ruleVersion ?? '尚未取得'}
            </code>
          </dd>
        </div>
        <div className="space-y-1">
          <dt className="text-muted-foreground">已加载规则指纹</dt>
          <dd className="m-0">
            <code
              className="block rounded bg-muted/70 px-2 py-1 font-mono text-[11px] text-foreground"
              style={{ overflowWrap: 'anywhere' }}
            >
              {runtime?.fingerprint ?? '尚未取得'}
            </code>
          </dd>
        </div>
      </dl>
      {mismatch && (
        <p className="error mt-2.5 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive-foreground">
          规则记录与当前连接实例不一致，不能据此确认修复已生效。
        </p>
      )}
      <p className="hint mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
        以上信息来自当前连接后端已加载的规则。未取得指纹时，不能据此确认修复已生效。
      </p>
    </details>
  );
}
