import {useState} from 'react';
import type {ModelCatalogEntry, PublicModelConnection, PublicModelState} from '../../src/contracts/model-providers.js';
import {modelPresetNames, modelProtocolNames, reasons} from './api';
import {explainSafe} from './error-messages';
import type {ChangeModelProviders} from './ModelProviderSettings';
import {useModelCatalog} from './useModelCatalog';

export type ModelFeedback = {message: string; error?: boolean};
type PublicRevision = PublicModelConnection['draft'];

export function ModelActionFeedback({feedback}: {feedback?: ModelFeedback}) {
  return feedback && <p className={feedback.error ? 'error' : 'model-feedback'} role={feedback.error ? 'alert' : 'status'}>
    {feedback.message}
  </p>;
}

export function modelKeyStatus(revision: PublicRevision) {
  if (revision.unavailableReason === 'DPAPI_RESTORE_FAILED') return '恢复失败';
  if (!revision.keyPresent) return '未配置';
  return revision.keyStored ? '本机 DPAPI 保存' : '内存保存';
}

export function modelOption(model: ModelCatalogEntry) {
  return model.displayName ? `${model.displayName}（${model.modelId}）` : model.modelId;
}

export function ModelSelector({state, budgetExhausted, modelAuthorized, change, refreshing}: {
  state: PublicModelState; budgetExhausted: boolean; modelAuthorized: boolean; change: ChangeModelProviders; refreshing: boolean;
}) {
  const {connections, selection} = state;
  const displayName = selection.connectionId !== null ? selection.modelDisplayName : null;
  const current = connections.find(item => item.id === selection.connectionId);
  const applied = current?.applied?.routeRevision === selection.routeRevision ? current?.applied : null;
  const [choice, setChoice] = useState<{connectionId: string; modelId: string} | null>(null);
  const [applying, setApplying] = useState(false);
  const [feedback, setFeedback] = useState<ModelFeedback>();
  const target = choice ? connections.find(item => item.id === choice.connectionId) : current;
  const directory = useModelCatalog(target);
  const requestedModel = choice?.modelId ?? selection.modelId;
  const retainedModel = target?.id === current?.id ? selection.modelId : null;
  const modelId = requestedModel && (directory.models.some(model => model.modelId === requestedModel) || requestedModel === retainedModel)
    ? requestedModel : '';
  const unchanged = target?.id === current?.id && target?.draft.routeRevision === selection.routeRevision && modelId === selection.modelId;
  const pending = current && current.draft.routeRevision !== selection.routeRevision;
  const catalog = applied?.catalogResult;
  const missingFromCatalog = selection.modelId && catalog && catalog.status !== 'FAILED'
    && ('selectedModelInCatalog' in catalog ? catalog.selectedModelInCatalog === false
      : !catalog.models.some(model => model.modelId === selection.modelId));
  const test = applied?.testResult;
  const testFailed = test?.modelId === selection.modelId && (test.status === 'FAILED' || test.status === 'INTERRUPTED');
  const currentIssues = new Set<string>();
  if (applied?.unavailableReason) currentIssues.add(reasons[applied.unavailableReason]!);
  if (applied && !applied.keyPresent && applied.unavailableReason !== 'DPAPI_RESTORE_FAILED') currentIssues.add(reasons.MODEL_KEY_REQUIRED!);
  if (pending) currentIssues.add(reasons.MODEL_CONNECTION_NOT_APPLIED!);
  if (budgetExhausted) currentIssues.add(reasons.MODEL_BUDGET_EXHAUSTED!);

  async function apply() {
    if (refreshing || !target || !modelId || applying || unchanged || !target.draft.keyPresent) return;
    setApplying(true);
    setFeedback(undefined);
    try {
      const result = await change({command: 'modelProviders', action: 'apply', connectionId: target.id,
        routeRevision: target.draft.routeRevision, modelId, expectedSelectionRevision: selection.selectionRevision,
        confirmed: true, commandId: globalThis.crypto.randomUUID()});
      const next = result?.modelProviders;
      if (next?.selection.connectionId !== target.id || next.selection.routeRevision !== target.draft.routeRevision
        || next.selection.modelId !== modelId) throw new Error('MODEL_PROVIDER_STATUS_UNCONFIRMED');
      setFeedback({message: '已应用模型切换。'});
    } catch (error) {
      setFeedback({error: true, message: explainSafe(error, '切换未能确认，请查看当前模型。')});
    } finally {
      setApplying(false);
    }
  }

  return <section aria-labelledby="current-model-heading">
    <h2 id="current-model-heading">当前模型</h2>
    {current && applied ? <dl className="model-facts">
      <div><dt>连接</dt><dd>{current.name} · {modelPresetNames[applied.presetId]}</dd></div>
      <div><dt>目标</dt><dd>{new URL(applied.baseUrl).host} · {modelProtocolNames[applied.protocol]}</dd></div>
      <div><dt>模型 ID</dt><dd>{displayName && `${displayName} · `}<code>{selection.modelId}</code></dd></div>
      <div><dt>Key</dt><dd>{modelKeyStatus(applied)}</dd></div>
      <div><dt>调用许可</dt><dd>{modelAuthorized ? '当前有效' : '当前无效'}</dd></div>
    </dl> : <p className="hint">尚未应用模型连接。</p>}
    {missingFromCatalog && <p className="hint">目录未返回当前模型，已保留当前模型 ID。</p>}
    {catalog?.status === 'FAILED' && <p className="hint">当前连接的目录获取失败。{catalog.reason && reasons[catalog.reason]}</p>}
    {testFailed && <p className="error">{test.status === 'INTERRUPTED' ? '本次连接测试已中断。' : '连接测试失败。'}{test.reason && reasons[test.reason]}</p>}
    {currentIssues.size > 0 && <ul className="model-issues">{[...currentIssues].map(issue => <li key={issue}>{issue}</li>)}</ul>}
    <div className="model-fields">
      <label>切换到连接
        <select value={target?.id ?? ''} disabled={!connections.length || applying} onChange={event => {
          setChoice({connectionId: event.target.value, modelId: ''});
          setFeedback(undefined);
        }}>
          <option value="" disabled>请选择连接</option>
          {connections.map(item => <option key={item.id} value={item.id}>{item.name} · {modelPresetNames[item.draft.presetId]}</option>)}
        </select>
      </label>
      <label>切换到模型
        <select value={modelId} disabled={!target || applying} onChange={event => {
          if (target) setChoice({connectionId: target.id, modelId: event.target.value});
          setFeedback(undefined);
        }}>
          <option value="" disabled>请选择模型</option>
          {directory.models.map(model => <option key={model.modelId} value={model.modelId}>{modelOption(model)}</option>)}
          {target && retainedModel && !directory.models.some(model => model.modelId === retainedModel) &&
            <option value={retainedModel}>{displayName ? `${displayName}（${retainedModel}）` : retainedModel}（当前）</option>}
        </select>
      </label>
    </div>
    {target && <>
      <ModelCatalogFeedback directory={directory}/>
      {directory.complete && !directory.models.length && !retainedModel && <p className="hint">模型目录为空，请在提供商管理中获取模型或手动添加。</p>}
      {!target.draft.keyPresent && <p className="hint">目标连接的 Key {modelKeyStatus(target.draft)}，请先保存可用的 Key。</p>}
      <p className="hint">应用后，人工 AI 建议、自动回复、知识库风格分析与试答将交给 {modelPresetNames[target.draft.presetId]}（{new URL(target.draft.baseUrl).host}）。原自动回复开关、规则、时段与累计额度保持不变。</p>
    </>}
    <button className="primary" disabled={refreshing || !target?.draft.keyPresent || !modelId || applying || unchanged} onClick={() => void apply()}>
      {applying ? '正在应用切换…' : '应用切换'}
    </button>
    <ModelActionFeedback feedback={feedback}/>
  </section>;
}

export function ModelCatalogFeedback({directory}: {directory: ReturnType<typeof useModelCatalog>}) {
  if (directory.complete) return null;
  return directory.error
    ? <p className="error" role="alert">{directory.error} <button onClick={directory.retry}>重新读取模型</button></p>
    : <p className="hint" role="status">正在读取完整模型目录…</p>;
}
