import { useState } from 'react';
import type {
  ModelCatalogEntry,
  PublicModelConnection,
  PublicModelState,
} from '../../src/contracts/model-providers.js';
import { modelPresetNames, modelProtocolNames, reasons } from './api';
import { explainSafe } from './error-messages';
import type { ChangeModelProviders } from './ModelProviderSettings';
import { useModelCatalog } from './useModelCatalog';

export type ModelFeedback = { message: string; error?: boolean };
type PublicRevision = PublicModelConnection['draft'];

const selectCls =
  'h-8.5 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-[13px] text-foreground shadow-xs/5 outline-none transition-shadow focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/32';
const btnPrimaryCls =
  'primary inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-primary bg-primary px-3 text-xs font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55';
const btnOutlineCls =
  'inline-flex h-7.5 shrink-0 cursor-pointer items-center justify-center gap-1 whitespace-nowrap rounded-lg border border-input bg-popover px-2.5 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55 dark:bg-input/32';

export function ModelActionFeedback({ feedback }: { feedback?: ModelFeedback }) {
  return (
    feedback && (
      <p
        className={
          feedback.error
            ? 'error rounded-xl border border-destructive/30 bg-destructive/6 px-3.5 py-2 text-xs font-medium text-destructive-foreground'
            : 'model-feedback rounded-xl border border-success/30 bg-success/8 px-3.5 py-2 text-xs font-medium text-success-foreground'
        }
        role={feedback.error ? 'alert' : 'status'}
      >
        {feedback.message}
      </p>
    )
  );
}

export function modelKeyStatus(revision: PublicRevision) {
  if (revision.unavailableReason === 'DPAPI_RESTORE_FAILED') return '恢复失败';
  if (!revision.keyPresent) return '未配置';
  return revision.keyStored ? '本机 DPAPI 保存' : '内存保存';
}

export function modelOption(model: ModelCatalogEntry) {
  return model.displayName ? `${model.displayName}（${model.modelId}）` : model.modelId;
}

export function ModelSelector({
  state,
  budgetExhausted,
  modelAuthorized,
  change,
  refreshing,
}: {
  state: PublicModelState;
  budgetExhausted: boolean;
  modelAuthorized: boolean;
  change: ChangeModelProviders;
  refreshing: boolean;
}) {
  const { connections, selection } = state;
  const displayName = selection.connectionId !== null ? selection.modelDisplayName : null;
  const current = connections.find(item => item.id === selection.connectionId);
  const applied = current?.applied?.routeRevision === selection.routeRevision ? current?.applied : null;
  const [choice, setChoice] = useState<{ connectionId: string; modelId: string } | null>(null);
  const [applying, setApplying] = useState(false);
  const [feedback, setFeedback] = useState<ModelFeedback>();
  const target = choice ? connections.find(item => item.id === choice.connectionId) : current;
  const directory = useModelCatalog(target);
  const requestedModel = choice?.modelId ?? selection.modelId;
  const retainedModel = target?.id === current?.id ? selection.modelId : null;
  const modelId =
    requestedModel &&
    (directory.models.some(model => model.modelId === requestedModel) ||
      requestedModel === retainedModel)
      ? requestedModel
      : '';
  const unchanged =
    target?.id === current?.id &&
    target?.draft.routeRevision === selection.routeRevision &&
    modelId === selection.modelId;
  const pending = current && current.draft.routeRevision !== selection.routeRevision;
  const catalog = applied?.catalogResult;
  const missingFromCatalog =
    selection.modelId &&
    catalog &&
    catalog.status !== 'FAILED' &&
    ('selectedModelInCatalog' in catalog
      ? catalog.selectedModelInCatalog === false
      : !catalog.models.some(model => model.modelId === selection.modelId));
  const test = applied?.testResult;
  const testFailed =
    test?.modelId === selection.modelId &&
    (test.status === 'FAILED' || test.status === 'INTERRUPTED');
  const currentIssues = new Set<string>();
  if (applied?.unavailableReason) currentIssues.add(reasons[applied.unavailableReason]!);
  if (applied && !applied.keyPresent && applied.unavailableReason !== 'DPAPI_RESTORE_FAILED')
    currentIssues.add(reasons.MODEL_KEY_REQUIRED!);
  if (pending) currentIssues.add(reasons.MODEL_CONNECTION_NOT_APPLIED!);
  if (budgetExhausted) currentIssues.add(reasons.MODEL_BUDGET_EXHAUSTED!);

  async function apply() {
    if (refreshing || !target || !modelId || applying || unchanged || !target.draft.keyPresent)
      return;
    setApplying(true);
    setFeedback(undefined);
    try {
      const result = await change({
        command: 'modelProviders',
        action: 'apply',
        connectionId: target.id,
        routeRevision: target.draft.routeRevision,
        modelId,
        expectedSelectionRevision: selection.selectionRevision,
        confirmed: true,
        commandId: globalThis.crypto.randomUUID(),
      });
      const next = result?.modelProviders;
      if (
        next?.selection.connectionId !== target.id ||
        next.selection.routeRevision !== target.draft.routeRevision ||
        next.selection.modelId !== modelId
      )
        throw new Error('MODEL_PROVIDER_STATUS_UNCONFIRMED');
      setFeedback({ message: '已应用模型切换。' });
    } catch (error) {
      setFeedback({
        error: true,
        message: explainSafe(error, '切换未能确认，请查看当前模型。'),
      });
    } finally {
      setApplying(false);
    }
  }

  return (
    <section aria-labelledby="current-model-heading" className="flex flex-col gap-3.5">
      <h2 id="current-model-heading" className="font-heading text-[15px] font-semibold text-foreground">
        当前模型
      </h2>

      {current && applied ? (
        <dl className="model-facts divide-y divide-border/70 overflow-hidden rounded-xl border border-primary/20 bg-primary/[0.03] text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
            <dt className="text-muted-foreground">连接</dt>
            <dd className="font-medium text-foreground">
              {current.name} · {modelPresetNames[applied.presetId]}
            </dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
            <dt className="text-muted-foreground">目标</dt>
            <dd className="font-mono text-[11.5px] text-foreground">
              {new URL(applied.baseUrl).host} · {modelProtocolNames[applied.protocol]}
            </dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
            <dt className="text-muted-foreground">模型 ID</dt>
            <dd className="text-foreground">
              {displayName && `${displayName} · `}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11.5px]">
                {selection.modelId}
              </code>
            </dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
            <dt className="text-muted-foreground">Key</dt>
            <dd className="font-medium text-foreground">{modelKeyStatus(applied)}</dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
            <dt className="text-muted-foreground">调用许可</dt>
            <dd className={modelAuthorized ? 'font-medium text-success-foreground' : 'font-medium text-warning-foreground'}>
              {modelAuthorized ? '当前有效' : '当前无效'}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="hint rounded-xl border border-border/75 bg-muted/35 px-3.5 py-2.5 text-xs text-muted-foreground">
          尚未应用模型连接。
        </p>
      )}

      {missingFromCatalog && (
        <p className="hint text-xs text-muted-foreground">目录未返回当前模型，已保留当前模型 ID。</p>
      )}
      {catalog?.status === 'FAILED' && (
        <p className="hint text-xs text-warning-foreground">
          当前连接的目录获取失败。{catalog.reason && reasons[catalog.reason]}
        </p>
      )}
      {testFailed && (
        <p className="error rounded-xl border border-destructive/30 bg-destructive/6 px-3.5 py-2 text-xs font-medium text-destructive-foreground">
          {test.status === 'INTERRUPTED' ? '本次连接测试已中断。' : '连接测试失败。'}
          {test.reason && reasons[test.reason]}
        </p>
      )}
      {currentIssues.size > 0 && (
        <ul className="model-issues flex flex-col gap-1 rounded-xl border border-warning/35 bg-warning/8 px-3.5 py-2.5 text-xs text-warning-foreground">
          {[...currentIssues].map(issue => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}

      <div className="model-fields grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-xs font-medium text-foreground">
          切换到连接
          <select
            id="model-selector-connection"
            className={selectCls}
            value={target?.id ?? ''}
            disabled={!connections.length || applying}
            onChange={event => {
              setChoice({ connectionId: event.target.value, modelId: '' });
              setFeedback(undefined);
            }}
          >
            <option value="" disabled>
              请选择连接
            </option>
            {connections.map(item => (
              <option key={item.id} value={item.id}>
                {item.name} · {modelPresetNames[item.draft.presetId]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-xs font-medium text-foreground">
          切换到模型
          <select
            className={selectCls}
            value={modelId}
            disabled={!target || applying}
            onChange={event => {
              if (target) setChoice({ connectionId: target.id, modelId: event.target.value });
              setFeedback(undefined);
            }}
          >
            <option value="" disabled>
              请选择模型
            </option>
            {directory.models.map(model => (
              <option key={model.modelId} value={model.modelId}>
                {modelOption(model)}
              </option>
            ))}
            {target &&
              retainedModel &&
              !directory.models.some(model => model.modelId === retainedModel) && (
                <option value={retainedModel}>
                  {displayName ? `${displayName}（${retainedModel}）` : retainedModel}（当前）
                </option>
              )}
          </select>
        </label>
      </div>

      {target && (
        <div className="flex flex-col gap-1.5">
          <ModelCatalogFeedback directory={directory} />
          {directory.complete && !directory.models.length && !retainedModel && (
            <p className="hint text-xs text-muted-foreground">
              模型目录为空，请在提供商管理中获取模型或手动添加。
            </p>
          )}
          {!target.draft.keyPresent && (
            <p className="hint text-xs text-warning-foreground">
              目标连接的 Key {modelKeyStatus(target.draft)}，请先保存可用的 Key。
            </p>
          )}
          <p className="hint text-xs leading-relaxed text-muted-foreground">
            应用后，人工 AI 建议、自动回复、知识库风格分析与试答将交给{' '}
            {modelPresetNames[target.draft.presetId]}（{new URL(target.draft.baseUrl).host}
            ）。原自动回复开关、规则、时段与累计额度保持不变。
          </p>
        </div>
      )}

      <div>
        <button
          className={btnPrimaryCls}
          disabled={refreshing || !target?.draft.keyPresent || !modelId || applying || unchanged}
          onClick={() => void apply()}
        >
          {applying ? '正在应用切换…' : '应用切换'}
        </button>
      </div>
      <ModelActionFeedback feedback={feedback} />
    </section>
  );
}

export function ModelCatalogFeedback({
  directory,
}: {
  directory: ReturnType<typeof useModelCatalog>;
}) {
  if (directory.complete) return null;
  return directory.error ? (
    <p
      className="error flex flex-wrap items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/6 px-3 py-2 text-xs font-medium text-destructive-foreground"
      role="alert"
    >
      <span>{directory.error}</span>
      <button className={btnOutlineCls} onClick={directory.retry}>
        重新读取模型
      </button>
    </p>
  ) : (
    <p className="hint text-xs text-muted-foreground" role="status">
      正在读取完整模型目录…
    </p>
  );
}
