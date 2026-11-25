import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {
  MODEL_PRESET_IDS, MODEL_PROTOCOLS, isValidModelId, modelBaseUrlSchema, modelProvidersCommandSchema,
  type ModelPresetId, type ModelProtocol, type ModelKeyStorage, type ModelProvidersCommand,
  type PublicModelConnection,
} from '../../src/contracts/model-providers.js';
import {modelPresetNames, modelProtocolNames, readModelCatalog, reasons, type Status} from './api';
import {explainSafe} from './error-messages';
import {ModelActionFeedback, ModelCatalogFeedback, modelKeyStatus, modelOption, type ModelFeedback} from './ModelSelector';
import type {ChangeModelProviders} from './ModelProviderSettings';
import {useModelCatalog} from './useModelCatalog';

type Region = {id: string; name: string; url: string};
type Preset = {protocol: ModelProtocol | ''; url: string; regions?: Region[]; manualOnly?: boolean};
const presets: Record<ModelPresetId, Preset> = {
  deepseek: {protocol: 'OPENAI_CHAT', url: 'https://api.deepseek.com'},
  openai: {protocol: 'OPENAI_RESPONSES', url: 'https://api.openai.com/v1'},
  anthropic: {protocol: 'ANTHROPIC_MESSAGES', url: 'https://api.anthropic.com/v1'},
  gemini: {protocol: 'GEMINI_GENERATE_CONTENT', url: 'https://generativelanguage.googleapis.com/v1beta'},
  qwen: {protocol: 'OPENAI_CHAT', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', manualOnly: true, regions: [
    {id: 'beijing', name: '北京', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1'},
    {id: 'singapore', name: '新加坡', url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'},
    {id: 'us', name: '美国', url: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1'},
  ]},
  doubao: {protocol: 'OPENAI_CHAT', url: 'https://ark.cn-beijing.volces.com/api/v3', manualOnly: true},
  siliconflow: {protocol: 'OPENAI_CHAT', url: 'https://api.siliconflow.cn/v1', regions: [
    {id: 'china', name: '中国站', url: 'https://api.siliconflow.cn/v1'},
    {id: 'international', name: '国际站', url: 'https://api.siliconflow.com/v1'},
  ]},
  openrouter: {protocol: 'OPENAI_CHAT', url: 'https://openrouter.ai/api/v1'},
  custom: {protocol: '', url: ''},
};

type SaveCommand = Extract<ModelProvidersCommand, {action: 'save'}>;
type Form = Pick<SaveCommand, 'name' | 'presetId' | 'baseUrl' | 'region'> & {
  protocol: ModelProtocol | ''; manualModels: NonNullable<SaveCommand['manualModels']>;
};
type FormState = {form: Form; baseline: Form; version: number; complete: boolean};
type EditorCommand = Extract<ModelProvidersCommand, {action: 'save' | 'setKey' | 'discover' | 'test'}>;
type FeedbackScope = {revision?: number; modelId?: string; keyDestination?: string; requiresSavedRoute?: boolean; requiresKey?: boolean};
type Feedback = ModelFeedback & FeedbackScope;
const emptyKey = {value: '', destination: ''};

function snapshot(connection?: PublicModelConnection, models = connection?.models ?? [], complete = !connection?.modelsTruncated): FormState {
  const draft = connection?.draft;
  const form: Form = {
    name: connection?.name ?? '', presetId: draft?.presetId ?? 'deepseek', protocol: draft?.protocol ?? 'OPENAI_CHAT',
    baseUrl: draft?.baseUrl ?? presets.deepseek.url, region: draft?.region ?? null,
    manualModels: models.filter(model => model.source === 'MANUAL').map(({modelId, displayName}) => ({modelId, displayName})),
  };
  return {form, baseline: form, version: connection?.version ?? 0, complete};
}

function sameForm(a: Form, b: Form) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameRoute(a: Form, b: Form) {
  return a.presetId === b.presetId && a.protocol === b.protocol && a.baseUrl === b.baseUrl && a.region === b.region;
}

function hasCredential(revision: PublicModelConnection['applied']) {
  return revision && (revision.keyPresent || revision.keyStored || revision.unavailableReason === 'DPAPI_RESTORE_FAILED');
}

function keyDestination(revision?: PublicModelConnection['draft']) {
  return JSON.stringify([revision?.presetId, revision?.protocol, revision?.baseUrl, revision?.region]);
}

function endpointPreview(form: Form, modelId: string) {
  if (!form.protocol) return '请选择协议';
  const paths: Record<ModelProtocol, string> = {
    OPENAI_CHAT: 'chat/completions', OPENAI_RESPONSES: 'responses', ANTHROPIC_MESSAGES: 'messages',
    GEMINI_GENERATE_CONTENT: `models/${modelId ? encodeURIComponent(modelId) : '{模型 ID}'}:generateContent`,
  };
  return `${new URL(form.baseUrl).href.replace(/\/+$/u, '')}/${paths[form.protocol]}`;
}

export function ModelConnectionEditor({connection, change, onCreated, onClose, budgetExhausted, stopped, hidden, refreshing, selectionRevision}: {
  connection?: PublicModelConnection; change: ChangeModelProviders; onCreated: (id: string) => void;
  onClose: () => void; budgetExhausted: boolean; stopped: boolean; hidden: boolean;
  refreshing: boolean; selectionRevision: number;
}) {
  const [editor, setEditor] = useState(() => snapshot(connection));
  const {form, version} = editor;
  const [keyDraft, setKeyDraft] = useState(emptyKey);
  const [storage, setStorage] = useState<ModelKeyStorage>('MEMORY');
  const [manualId, setManualId] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualError, setManualError] = useState('');
  const [chosenModel, setChosenModel] = useState('');
  const [busy, setBusy] = useState<Partial<Record<EditorCommand['action'], boolean>>>({});
  const [feedback, setFeedback] = useState<Partial<Record<EditorCommand['action'], Feedback>>>({});
  const sequences = useRef(new Map<EditorCommand['action'], number>());
  const active = useRef(false);
  const revision = connection?.draft;
  const directory = useModelCatalog(connection);
  const stored = snapshot(connection, directory.models, directory.complete);
  const canEditModels = directory.complete && editor.complete;
  const savedRoute = Boolean(connection && sameRoute(form, stored.form));
  const destination = keyDestination(revision);
  const keyValue = savedRoute && keyDraft.destination === destination ? keyDraft.value : '';
  const canClearKey = hasCredential(connection?.draft ?? null) || hasCredential(connection?.applied ?? null);
  const regionOptions = presets[form.presetId].regions;
  const validBaseUrl = modelBaseUrlSchema.safeParse(form.baseUrl).success;
  const modelId = directory.models.some(model => model.modelId === chosenModel) ? chosenModel : '';
  const catalog = revision?.catalogResult;
  const catalogCount = catalog && ('totalCount' in catalog ? catalog.totalCount : catalog.models.length);
  const test = revision?.testResult;
  const versionConflict = !!connection && connection.version !== version;
  const canSave = !refreshing && canEditModels && !versionConflict;
  const draftChanged = connection && connection.applied?.routeRevision !== revision?.routeRevision;

  useLayoutEffect(() => {
    active.current = true;
    return () => { active.current = false; sequences.current.clear(); };
  }, []);
  useEffect(() => {
    setKeyDraft(current => current.destination === destination ? current : emptyKey);
  }, [destination]);
  useEffect(() => {
    if (busy.save || !directory.complete) return;
    const next = snapshot(connection, directory.models, true);
    setEditor(current => {
      if (sameForm(current.form, current.baseline) || sameForm(current.form, next.baseline)) return next;
      if (!current.complete && current.version === next.version) {
        return {...next, form: {...current.form, manualModels: next.form.manualModels}};
      }
      if (sameForm(current.baseline, next.baseline)) return {...current, version: next.version, complete: true};
      return current;
    });
  }, [connection, directory.complete, directory.models, busy.save]);

  function edit(fields: Partial<Form>) {
    setEditor(current => ({...current, form: {...current.form, ...fields}}));
  }

  function selectPreset(presetId: ModelPresetId) {
    const preset = presets[presetId];
    edit({presetId, protocol: preset.protocol, baseUrl: preset.url, region: preset.regions?.[0]?.id ?? null});
  }

  function addModel() {
    if (!canEditModels) return;
    if (!isValidModelId(manualId)) {
      setManualError('模型 ID 需要 1 至 256 个可打印英文字符，不含空格，允许 / 和 :。');
      return;
    }
    edit({manualModels: [...form.manualModels.filter(model => model.modelId !== manualId), {modelId: manualId, displayName: manualName.trim() || null}]});
    setManualId('');
    setManualName('');
    setManualError('');
  }

  async function run(command: EditorCommand, onSuccess?: (next: Status | undefined, isCurrent: () => boolean) => void | Promise<void>,
    onCommitted?: () => void, scope?: FeedbackScope) {
    const {action} = command;
    if (!active.current || busy[action]) return;
    const sequence = (sequences.current.get(action) ?? 0) + 1;
    sequences.current.set(action, sequence);
    // A keyed editor owns one connection for its lifetime. Only the latest request for each action can update it.
    const isCurrent = () => active.current && sequences.current.get(action) === sequence;
    setBusy(current => ({...current, [action]: true}));
    setFeedback(current => ({...current, [action]: undefined}));
    try {
      const next = await change(command, () => { if (isCurrent()) onCommitted?.(); });
      if (isCurrent()) await onSuccess?.(next, isCurrent);
    } catch (error) {
      if (isCurrent()) setFeedback(current => ({...current, [action]: {
        error: true, message: explainSafe(error, '操作未能确认，请查看已保存的连接状态。'),
        revision: 'routeRevision' in command ? command.routeRevision : undefined,
        modelId: 'modelId' in command ? command.modelId : undefined,
        ...scope,
      }}));
    } finally {
      if (isCurrent()) setBusy(current => ({...current, [action]: false}));
    }
  }

  function setMessage(action: EditorCommand['action'], message: string, error = false) {
    setFeedback(current => ({...current, [action]: {message, error}}));
  }

  function save() {
    if (!canSave) return;
    const {manualModels, ...metadata} = form;
    const manualChanged = JSON.stringify(manualModels) !== JSON.stringify(editor.baseline.manualModels);
    const parsed = modelProvidersCommandSchema.safeParse({command: 'modelProviders', action: 'save',
      connectionId: connection?.id ?? null, expectedVersion: version, ...metadata, name: form.name.trim(),
      ...(manualChanged ? {manualModels, manualModelsComplete:true, expectedSelectionRevision:selectionRevision} : {})});
    if (!parsed.success || parsed.data.action !== 'save') {
      setMessage('save', !validBaseUrl ? reasons.INVALID_MODEL_BASE_URL! : '请检查连接名称和手动模型列表。', true);
      return;
    }
    // The native request bridge accepts at most 90,000 JSON bytes.
    if (new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength > 90_000) {
      setMessage('save', '本次连接配置超过通信上限。请减少手动模型的数量或缩短显示名称。', true);
      return;
    }
    const submitted = {...form, name: parsed.data.name, baseUrl: new URL(form.baseUrl).href.replace(/\/+$/u, '')};
    void run(parsed.data, async (next, isCurrent) => {
      const updated = next?.modelProviders?.connections.find(item => connection ? item.id === connection.id : item.name === submitted.name);
      if (!updated) throw new Error('MODEL_PROVIDER_STATUS_UNCONFIRMED');
      const models = await readModelCatalog(updated);
      if (!isCurrent()) return;
      const saved = snapshot(updated, models, true);
      if (!sameForm(saved.form, submitted)) {
        // A different writer may have updated the connection after this save committed.
        setEditor(current => ({...current, baseline: submitted, version: version + 1}));
        throw new Error('MODEL_CONNECTION_CONFLICT');
      }
      setEditor(current => sameForm(current.form, form) ? saved : {...saved, form: current.form});
      if (!connection) onCreated(updated.id);
      setMessage('save', '连接已保存。');
    });
  }

  function writeKey(clear: boolean) {
    if (refreshing || !connection || !revision || (clear ? !canClearKey : !savedRoute || !keyValue.trim())) return;
    if (clear && !window.confirm('清除这条连接的全部 Key？依赖该连接的模型调用将停止。')) return;
    const submitted = keyDraft;
    const parsed = modelProvidersCommandSchema.safeParse({command: 'modelProviders', action: 'setKey',
      connectionId: connection.id, expectedVersion: connection.version,
      ...(clear ? {storage: 'DELETE'} : {storage, key: keyValue})});
    if (!parsed.success || parsed.data.action !== 'setKey') { setMessage('setKey', reasons.INVALID_MODEL_KEY!, true); return; }
    void run(parsed.data, next => {
      const updated = next?.modelProviders?.connections.find(item => item.id === connection.id);
      if (!updated) throw new Error('MODEL_PROVIDER_STATUS_UNCONFIRMED');
      if (clear) {
        if (hasCredential(updated.draft) || hasCredential(updated.applied)) throw new Error('MODEL_PROVIDER_STATUS_UNCONFIRMED');
        setFeedback(current => ({...current, setKey: {
          message: '这条连接的 Key 已吊销。',
          revision: updated.draft.routeRevision, keyDestination: keyDestination(updated.draft),
        }}));
      } else if (updated.draft.keyPresent && updated.draft.routeRevision === revision.routeRevision + 1
        && updated.draft.storage === storage && keyDestination(updated.draft) === destination) {
        setFeedback(current => ({...current, setKey: {message: 'Key 已保存。', revision: updated.draft.routeRevision,
          keyDestination: destination, requiresSavedRoute: true, requiresKey: true}}));
      }
    }, () => {
      if (!clear) setKeyDraft(current => current === submitted ? emptyKey : current);
    }, {revision: revision.routeRevision, keyDestination: destination, requiresSavedRoute: !clear});
  }

  function actionFeedback(action: EditorCommand['action']) {
    const item = feedback[action];
    return <ModelActionFeedback feedback={item && (item.revision === undefined || item.revision === revision?.routeRevision)
      && (item.keyDestination === undefined || item.keyDestination === destination)
      && (!item.requiresSavedRoute || savedRoute)
      && (!item.requiresKey || revision?.keyPresent)
      && (item.modelId === undefined || item.modelId === modelId) ? item : undefined}/>;
  }

  return <section className="model-editor" hidden={hidden} aria-label={connection ? `编辑连接 ${connection.name}` : '新建模型连接'}>
    <div className="model-heading">
      <h4>{connection ? `编辑 ${connection.name}` : '新建模型连接'}</h4>
      <button onClick={onClose}>收起编辑器</button>
    </div>
    <div className="model-fields">
      <label>连接名称<input value={form.name} maxLength={200} onChange={event => edit({name: event.target.value})}/></label>
      <label>提供商预设<select value={form.presetId} onChange={event => selectPreset(event.target.value as ModelPresetId)}>
        {MODEL_PRESET_IDS.map(id => <option key={id} value={id}>{modelPresetNames[id]}</option>)}
      </select></label>
      {regionOptions && <label>区域<select value={form.region ?? regionOptions.find(region => region.url === form.baseUrl)?.id ?? ''}
        onChange={event => {
          const region = regionOptions.find(item => item.id === event.target.value);
          if (region) edit({region: region.id, baseUrl: region.url});
        }}>
        {!regionOptions.some(region => region.id === form.region || (form.region === null && region.url === form.baseUrl)) &&
          <option value={form.region ?? ''} disabled>{form.region ?? '请选择区域'}</option>}
        {regionOptions.map(region => <option key={region.id} value={region.id}>{region.name}</option>)}
      </select></label>}
      {form.presetId === 'custom' && <label>协议<select value={form.protocol} onChange={event => edit({protocol: event.target.value as ModelProtocol})}>
        <option value="" disabled>请选择协议</option>
        {MODEL_PROTOCOLS.map(protocol => <option key={protocol} value={protocol}>{modelProtocolNames[protocol]}</option>)}
      </select></label>}
    </div>
    <label>Base URL<input value={form.baseUrl} maxLength={2048} aria-invalid={!!form.baseUrl && !validBaseUrl}
      onChange={event => edit({baseUrl: event.target.value})}/></label>
    {form.baseUrl && !validBaseUrl && <p className="error">{reasons.INVALID_MODEL_BASE_URL}</p>}
    <p className="hint model-endpoint">最终生成端点 <code>{validBaseUrl ? endpointPreview(form, modelId) : '等待有效的 Base URL'}</code></p>

    <div className="model-editor-section">
      <h4>模型列表</h4>
      {connection && <p className="hint">已保存 {connection.totalModelCount ?? directory.models.length} 个模型。</p>}
      <ModelCatalogFeedback directory={directory}/>
      {form.manualModels.length > 0 && <ul className="model-manual-list">
        {form.manualModels.map(model => <li key={model.modelId}>
          <span>{model.displayName && `${model.displayName} · `}<code>{model.modelId}</code></span>
          <button disabled={!canEditModels} aria-label={`移除模型 ${model.modelId}`} onClick={() => edit({manualModels:form.manualModels.filter(item => item.modelId !== model.modelId)})}>移除</button>
        </li>)}
      </ul>}
      <div className="model-fields">
        <label>手动模型 ID<input value={manualId} maxLength={256} onChange={event => setManualId(event.target.value)}/></label>
        <label>模型显示名称（可选）<input value={manualName} maxLength={200} onChange={event => setManualName(event.target.value)}/></label>
      </div>
      <button disabled={!manualId || !canEditModels} onClick={addModel}>添加模型</button>
      {manualError && <p className="error" role="alert">{manualError}</p>}
    </div>
    <div className="model-actions model-save">
      <button className="primary" disabled={busy.save || !canSave || !form.name.trim() || !form.protocol || !validBaseUrl} onClick={save}>
        {busy.save ? '正在保存连接…' : '保存连接'}
      </button>
      {versionConflict && <button disabled={refreshing || !directory.complete} onClick={() => setEditor(stored)}>读取已保存配置</button>}
    </div>
    {versionConflict && <p className="error" role="status">{reasons.MODEL_CONNECTION_CONFLICT}</p>}
    {actionFeedback('save')}
    {draftChanged && <p className="hint">{reasons.MODEL_CONNECTION_NOT_APPLIED}</p>}
    {connection && revision ? <>
      <div className="model-editor-section">
        <h4>API Key</h4>
        <p className="hint">{new URL(revision.baseUrl).host} · {modelKeyStatus(revision)}</p>
        {revision.unavailableReason && <p className="hint">{reasons[revision.unavailableReason]}</p>}
        <div className="model-fields">
          <label>本次 API Key<input type="password" autoComplete="off" maxLength={4000} value={keyValue} disabled={!savedRoute}
            onChange={event => setKeyDraft({value: event.target.value, destination})}/></label>
          <label>Key 存储方式<select value={storage} onChange={event => setStorage(event.target.value as ModelKeyStorage)}>
            <option value="MEMORY">仅保存在内存</option><option value="DPAPI">本机加密保存（DPAPI）</option>
          </select></label>
        </div>
        <div className="model-actions">
          <button disabled={refreshing || busy.setKey || !keyValue.trim()} onClick={() => writeKey(false)}>
            {busy.setKey ? '正在更新 Key…' : '保存 Key'}
          </button>
          <button disabled={refreshing || busy.setKey || !canClearKey} onClick={() => writeKey(true)}>清除 Key</button>
        </div>
        {actionFeedback('setKey')}
      </div>
      <div className="model-editor-section">
        <h4>获取目录与测试</h4>
        {!savedRoute && <p className="hint">地址、协议或区域已修改。保存连接后可更新 Key、获取模型或测试。</p>}
        {!revision.keyPresent && <p className="hint">请先保存 Key，再获取模型或测试。</p>}
        {presets[revision.presetId].manualOnly && <p className="hint">此预设使用手动模型 ID{revision.presetId === 'doubao' ? ' 或 Endpoint ID' : ''}。</p>}
        <button disabled={refreshing || busy.discover || !savedRoute || !revision.keyPresent || presets[revision.presetId].manualOnly}
          onClick={() => void run({command:'modelProviders', action:'discover', connectionId:connection.id, routeRevision:revision.routeRevision})}>
          {busy.discover ? '正在获取模型…' : '获取模型'}
        </button>
        {catalog && <p className={catalog.status === 'FAILED' ? 'error' : 'hint'} role="status">
          {catalog.status === 'PARTIAL' ? `列表未完整获取，已保留 ${catalogCount} 个模型，可继续手动添加。`
            : catalog.status === 'COMPLETE' ? `目录已获取，共 ${catalogCount} 个模型。` : '获取模型失败，可手动添加。'}
          {catalog.status === 'PARTIAL' && ('truncated' in catalog && catalog.truncated === true
            ? ' 目录已达到保留上限。' : ' 目录读取中断。')}
          {catalog.reason && ` ${reasons[catalog.reason]}`}
        </p>}
        {actionFeedback('discover')}
        <label>测试模型<select value={modelId} onChange={event => setChosenModel(event.target.value)}>
          <option value="" disabled>请选择已保存的模型</option>
          {directory.models.map(model => <option key={model.modelId} value={model.modelId}>{modelOption(model)}</option>)}
        </select></label>
        {budgetExhausted && <p className="hint">{reasons.MODEL_BUDGET_EXHAUSTED}</p>}
        {stopped && <p className="hint">全局急停期间暂不能测试。</p>}
        <button disabled={refreshing || busy.test || !savedRoute || !revision.keyPresent || !modelId || budgetExhausted || stopped}
          onClick={() => void run({command:'modelProviders', action:'test', connectionId:connection.id, routeRevision:revision.routeRevision,
            modelId, confirmed:true, commandId:globalThis.crypto.randomUUID()})}>
          {busy.test ? '正在测试连接…' : '测试连接（调用 1 次模型）'}
        </button>
        {test && <p className={test.status === 'FAILED' ? 'error' : 'hint'} role="status">
          {test.status === 'SUCCEEDED' ? '连接测试通过。' : test.status === 'FAILED' ? '连接测试失败。'
            : test.status === 'INTERRUPTED' ? '本次连接测试已中断。' : '后端正在测试连接。'}
          {' '}<code>{test.modelId}</code>{test.reportedModelId && test.reportedModelId !== test.modelId && <> · 服务返回 <code>{test.reportedModelId}</code></>}
          {test.elapsedMs !== null && ` · ${test.elapsedMs} ms`}{test.reason && ` · ${reasons[test.reason]}`}
        </p>}
        {actionFeedback('test')}
      </div>
    </> : <p className="hint">保存连接后可设置 Key、获取模型和测试。</p>}
  </section>;
}
