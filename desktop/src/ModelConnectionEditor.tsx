import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  MODEL_PRESET_IDS, MODEL_PROTOCOLS, isValidModelId, modelBaseUrlSchema, modelProvidersCommandSchema,
  type ModelPresetId, type ModelProtocol, type ModelKeyStorage, type ModelProvidersCommand,
  type PublicModelConnection,
} from '../../src/contracts/model-providers.js';
import { modelPresetNames, modelProtocolNames, readModelCatalog, reasons, type Status } from './api';
import { explainSafe } from './error-messages';
import {
  ModelActionFeedback, ModelCatalogFeedback, modelKeyStatus, modelOption, type ModelFeedback,
} from './ModelSelector';
import type { ChangeModelProviders } from './ModelProviderSettings';
import { useModelCatalog } from './useModelCatalog';

type Region = { id: string; name: string; url: string };
type Preset = { protocol: ModelProtocol | ''; url: string; regions?: Region[]; manualOnly?: boolean };
const presets: Record<ModelPresetId, Preset> = {
  deepseek: { protocol: 'OPENAI_CHAT', url: 'https://api.deepseek.com' },
  openai: { protocol: 'OPENAI_RESPONSES', url: 'https://api.openai.com/v1' },
  anthropic: { protocol: 'ANTHROPIC_MESSAGES', url: 'https://api.anthropic.com/v1' },
  gemini: { protocol: 'GEMINI_GENERATE_CONTENT', url: 'https://generativelanguage.googleapis.com/v1beta' },
  qwen: {
    protocol: 'OPENAI_CHAT',
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    manualOnly: true,
    regions: [
      { id: 'beijing', name: '北京', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
      { id: 'singapore', name: '新加坡', url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
      { id: 'us', name: '美国', url: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1' },
    ],
  },
  doubao: { protocol: 'OPENAI_CHAT', url: 'https://ark.cn-beijing.volces.com/api/v3', manualOnly: true },
  siliconflow: {
    protocol: 'OPENAI_CHAT',
    url: 'https://api.siliconflow.cn/v1',
    regions: [
      { id: 'china', name: '中国站', url: 'https://api.siliconflow.cn/v1' },
      { id: 'international', name: '国际站', url: 'https://api.siliconflow.com/v1' },
    ],
  },
  openrouter: { protocol: 'OPENAI_CHAT', url: 'https://openrouter.ai/api/v1' },
  custom: { protocol: '', url: '' },
};

const labelCls = 'flex flex-col gap-1.5 text-xs font-medium text-foreground';
const hintCls = 'hint text-xs leading-relaxed text-muted-foreground';
const errorCls = 'error rounded-xl border border-destructive/30 bg-destructive/6 px-3 py-2 text-xs font-medium text-destructive-foreground';
const inputCls = 'h-8.5 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-[13px] text-foreground shadow-xs/5 outline-none transition-shadow focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/32';
const btnOutlineCls = 'inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-input bg-popover px-3 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55 dark:bg-input/32 dark:hover:bg-input/64';
const btnDangerCls = 'danger inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-destructive/35 bg-destructive/8 px-3 text-xs font-medium text-destructive-foreground shadow-xs/5 transition-colors hover:bg-destructive/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55';
const btnPrimaryCls = 'primary inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-primary bg-primary px-3 text-xs font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55';
const subSectionCls = 'model-editor-section flex flex-col gap-3 rounded-xl border border-border/75 bg-card p-4';

function defaultPresetName(presetId: ModelPresetId, regionId: string | null): string {
  if (presetId === 'custom') return '';
  const base = modelPresetNames[presetId];
  const region = presets[presetId].regions?.find(item => item.id === regionId);
  return region ? `${base}（${region.name}）` : base;
}

type SaveCommand = Extract<ModelProvidersCommand, { action: 'save' }>;
type Form = Pick<SaveCommand, 'name' | 'presetId' | 'baseUrl' | 'region'> & {
  protocol: ModelProtocol | '';
  manualModels: NonNullable<SaveCommand['manualModels']>;
};
type FormState = { form: Form; baseline: Form; version: number; complete: boolean };
type EditorCommand = Extract<ModelProvidersCommand, { action: 'save' | 'setKey' | 'discover' | 'test' }>;
type FeedbackScope = {
  revision?: number;
  modelId?: string;
  keyDestination?: string;
  requiresSavedRoute?: boolean;
  requiresKey?: boolean;
};
type Feedback = ModelFeedback & FeedbackScope;
const emptyKey = { value: '', destination: '' };

function snapshot(connection?: PublicModelConnection, models = connection?.models ?? [], complete = !connection?.modelsTruncated): FormState {
  const draft = connection?.draft;
  const presetId = draft?.presetId ?? 'deepseek';
  const region = draft?.region ?? null;
  const form: Form = {
    name: connection?.name ?? defaultPresetName(presetId, region),
    presetId,
    protocol: draft?.protocol ?? 'OPENAI_CHAT',
    baseUrl: draft?.baseUrl ?? presets.deepseek.url,
    region,
    manualModels: models.filter(model => model.source === 'MANUAL').map(({ modelId, displayName }) => ({ modelId, displayName })),
  };
  return { form, baseline: form, version: connection?.version ?? 0, complete };
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
    OPENAI_CHAT: 'chat/completions',
    OPENAI_RESPONSES: 'responses',
    ANTHROPIC_MESSAGES: 'messages',
    GEMINI_GENERATE_CONTENT: `models/${modelId ? encodeURIComponent(modelId) : '{模型 ID}'}:generateContent`,
  };
  return `${new URL(form.baseUrl).href.replace(/\/+$/u, '')}/${paths[form.protocol]}`;
}

export function ModelConnectionEditor({
  connection, change, onCreated, onClose, budgetExhausted, stopped, hidden, refreshing, connectionWriting = false, selectionRevision,
}: {
  connection?: PublicModelConnection; change: ChangeModelProviders; onCreated: (id: string) => void;
  onClose: () => void; budgetExhausted: boolean; stopped: boolean; hidden: boolean;
  refreshing: boolean; connectionWriting?: boolean; selectionRevision: number;
}) {
  const [editor, setEditor] = useState(() => snapshot(connection));
  const { form, version } = editor;
  const [keyDraft, setKeyDraft] = useState(emptyKey);
  const [storage, setStorage] = useState<ModelKeyStorage>('MEMORY');
  const [manualId, setManualId] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualError, setManualError] = useState('');
  const [chosenModel, setChosenModel] = useState('');
  const [confirmClearKey, setConfirmClearKey] = useState<{ id: string; version: number } | null>(null);
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
  const modelId = directory.models.some(model => model.modelId === chosenModel)
    ? chosenModel
    : directory.models.length === 1
      ? directory.models[0]!.modelId
      : '';
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
    setKeyDraft(current => (current.destination === destination ? current : emptyKey));
  }, [destination]);
  useEffect(() => {
    if (busy.save || !directory.complete) return;
    const next = snapshot(connection, directory.models, true);
    setEditor(current => {
      if (sameForm(current.form, current.baseline) || sameForm(current.form, next.baseline)) return next;
      if (!current.complete && current.version === next.version) {
        return { ...next, form: { ...current.form, manualModels: next.form.manualModels } };
      }
      if (sameForm(current.baseline, next.baseline)) return { ...current, version: next.version, complete: true };
      return current;
    });
  }, [connection, directory.complete, directory.models, busy.save]);

  function edit(fields: Partial<Form>) {
    setEditor(current => ({ ...current, form: { ...current.form, ...fields } }));
  }

  function selectPreset(presetId: ModelPresetId) {
    const preset = presets[presetId];
    const nextRegion = preset.regions?.[0]?.id ?? null;
    const prevAuto = defaultPresetName(form.presetId, form.region);
    const shouldAutoName = !connection && (!form.name.trim() || form.name === prevAuto);
    edit({
      presetId,
      protocol: preset.protocol,
      baseUrl: preset.url,
      region: nextRegion,
      ...(shouldAutoName ? { name: defaultPresetName(presetId, nextRegion) } : {}),
    });
  }

  function addModel() {
    if (!canEditModels) return;
    if (!isValidModelId(manualId)) {
      setManualError('模型 ID 需要 1 至 256 个可打印英文字符，不含空格，允许 / 和 :。');
      return;
    }
    edit({
      manualModels: [
        ...form.manualModels.filter(model => model.modelId !== manualId),
        { modelId: manualId, displayName: manualName.trim() || null },
      ],
    });
    setManualId('');
    setManualName('');
    setManualError('');
  }

  async function run(
    command: EditorCommand,
    onSuccess?: (next: Status | undefined, isCurrent: () => boolean) => void | Promise<void>,
    onCommitted?: () => void,
    scope?: FeedbackScope,
  ) {
    const { action } = command;
    if (!active.current || busy[action]) return;
    const sequence = (sequences.current.get(action) ?? 0) + 1;
    sequences.current.set(action, sequence);
    // A keyed editor owns one connection for its lifetime. Only the latest request for each action can update it.
    const isCurrent = () => active.current && sequences.current.get(action) === sequence;
    setBusy(current => ({ ...current, [action]: true }));
    setFeedback(current => ({ ...current, [action]: undefined }));
    try {
      const next = await change(command, () => { if (isCurrent()) onCommitted?.(); });
      if (isCurrent()) await onSuccess?.(next, isCurrent);
    } catch (error) {
      if (isCurrent()) {
        setFeedback(current => ({
          ...current,
          [action]: {
            error: true,
            message: explainSafe(error, '操作未能确认，请查看已保存的连接状态。'),
            revision: 'routeRevision' in command ? command.routeRevision : undefined,
            modelId: 'modelId' in command ? command.modelId : undefined,
            ...scope,
          },
        }));
      }
    } finally {
      if (isCurrent()) setBusy(current => ({ ...current, [action]: false }));
    }
  }

  function setMessage(action: EditorCommand['action'], message: string, error = false) {
    setFeedback(current => ({ ...current, [action]: { message, error } }));
  }

  function save() {
    if (!canSave) return;
    const { manualModels, ...metadata } = form;
    const manualChanged = JSON.stringify(manualModels) !== JSON.stringify(editor.baseline.manualModels);
    const parsed = modelProvidersCommandSchema.safeParse({
      command: 'modelProviders', action: 'save', connectionId: connection?.id ?? null, expectedVersion: version,
      ...metadata, name: form.name.trim(),
      ...(manualChanged ? { manualModels, manualModelsComplete: true, expectedSelectionRevision: selectionRevision } : {}),
    });
    if (!parsed.success || parsed.data.action !== 'save') {
      setMessage('save', !validBaseUrl ? reasons.INVALID_MODEL_BASE_URL! : '请检查连接名称和手动模型列表。', true);
      return;
    }
    // The native request bridge accepts at most 90,000 JSON bytes.
    if (new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength > 90_000) {
      setMessage('save', '本次连接配置超过通信上限。请减少手动模型的数量或缩短显示名称。', true);
      return;
    }
    const submitted = { ...form, name: parsed.data.name, baseUrl: new URL(form.baseUrl).href.replace(/\/+$/u, '') };
    void run(parsed.data, async (next, isCurrent) => {
      const updated = next?.modelProviders?.connections.find(item => (connection ? item.id === connection.id : item.name === submitted.name));
      if (!updated) throw new Error('MODEL_PROVIDER_STATUS_UNCONFIRMED');
      const models = await readModelCatalog(updated);
      if (!isCurrent()) return;
      const saved = snapshot(updated, models, true);
      if (!sameForm(saved.form, submitted)) {
        // A different writer may have updated the connection after this save committed.
        setEditor(current => ({ ...current, baseline: submitted, version: version + 1 }));
        throw new Error('MODEL_CONNECTION_CONFLICT');
      }
      setEditor(current => (sameForm(current.form, form) ? saved : { ...saved, form: current.form }));
      if (!connection) onCreated(updated.id);
      setMessage('save', '连接已保存。');
    });
  }

  const anyBusy = connectionWriting || Object.values(busy).some(Boolean);
  useEffect(() => {
    setConfirmClearKey(current => {
      if (!current) return null;
      if (
        hidden ||
        anyBusy ||
        !connection ||
        !canClearKey ||
        current.id !== connection.id ||
        current.version !== connection.version
      ) {
        return null;
      }
      return current;
    });
  }, [hidden, anyBusy, connection?.id, connection?.version, canClearKey]);

  function writeKey(clear: boolean, expectedVersion?: number) {
    if (refreshing || !connection || !revision || (clear ? !canClearKey : !savedRoute || !keyValue.trim())) return;
    if (clear && expectedVersion !== undefined && connection.version !== expectedVersion) {
      setConfirmClearKey(null);
      return;
    }
    setConfirmClearKey(null);
    const submitted = keyDraft;
    const parsed = modelProvidersCommandSchema.safeParse({
      command: 'modelProviders',
      action: 'setKey',
      connectionId: connection.id,
      expectedVersion: expectedVersion ?? connection.version,
      ...(clear ? { storage: 'DELETE' } : { storage, key: keyValue }),
    });
    if (!parsed.success || parsed.data.action !== 'setKey') { setMessage('setKey', reasons.INVALID_MODEL_KEY!, true); return; }
    void run(
      parsed.data,
      next => {
        const updated = next?.modelProviders?.connections.find(item => item.id === connection.id);
        if (!updated) throw new Error('MODEL_PROVIDER_STATUS_UNCONFIRMED');
        if (clear) {
          if (hasCredential(updated.draft) || hasCredential(updated.applied)) throw new Error('MODEL_PROVIDER_STATUS_UNCONFIRMED');
          setFeedback(current => ({
            ...current,
            setKey: { message: '这条连接的 Key 已吊销。', revision: updated.draft.routeRevision, keyDestination: keyDestination(updated.draft) },
          }));
        } else if (
          updated.draft.keyPresent && updated.draft.routeRevision === revision.routeRevision + 1
          && updated.draft.storage === storage && keyDestination(updated.draft) === destination
        ) {
          setFeedback(current => ({
            ...current,
            setKey: { message: 'Key 已保存。', revision: updated.draft.routeRevision, keyDestination: destination, requiresSavedRoute: true, requiresKey: true },
          }));
        }
      },
      () => { if (!clear) setKeyDraft(current => (current === submitted ? emptyKey : current)); },
      { revision: revision.routeRevision, keyDestination: destination, requiresSavedRoute: !clear },
    );
  }

  function actionFeedback(action: EditorCommand['action']) {
    const item = feedback[action];
    return (
      <ModelActionFeedback
        feedback={
          item
          && (item.revision === undefined || item.revision === revision?.routeRevision)
          && (item.keyDestination === undefined || item.keyDestination === destination)
          && (!item.requiresSavedRoute || savedRoute)
          && (!item.requiresKey || revision?.keyPresent)
          && (item.modelId === undefined || item.modelId === modelId)
            ? item : undefined
        }
      />
    );
  }

  return (
    <section
      className={`model-editor gap-4 rounded-xl border border-border/85 bg-muted/35 p-4 ${hidden ? 'hidden' : 'flex flex-col'}`}
      hidden={hidden}
      aria-label={connection ? `编辑连接 ${connection.name}` : '新建模型连接'}
    >
      <div className="model-heading flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-heading text-[14px] font-semibold text-foreground">
          {connection ? `编辑 ${connection.name}` : '新建模型连接'}
        </h4>
        <button className={btnOutlineCls} onClick={onClose}>收起编辑器</button>
      </div>

      <div className="model-fields grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className={labelCls}>
          连接名称
          <input className={inputCls} value={form.name} maxLength={200} onChange={event => edit({ name: event.target.value })} />
        </label>
        <label className={labelCls}>
          提供商预设
          <select className={inputCls} value={form.presetId} onChange={event => selectPreset(event.target.value as ModelPresetId)}>
            {MODEL_PRESET_IDS.map(id => <option key={id} value={id}>{modelPresetNames[id]}</option>)}
          </select>
        </label>
        {regionOptions && (
          <label className={labelCls}>
            区域
            <select
              className={inputCls}
              value={form.region ?? regionOptions.find(region => region.url === form.baseUrl)?.id ?? ''}
              onChange={event => {
                const region = regionOptions.find(item => item.id === event.target.value);
                if (region) {
                  const prevAuto = defaultPresetName(form.presetId, form.region);
                  const shouldAutoName = !connection && (!form.name.trim() || form.name === prevAuto);
                  edit({
                    region: region.id,
                    baseUrl: region.url,
                    ...(shouldAutoName ? { name: defaultPresetName(form.presetId, region.id) } : {}),
                  });
                }
              }}
            >
              {!regionOptions.some(region => region.id === form.region || (form.region === null && region.url === form.baseUrl)) && (
                <option value={form.region ?? ''} disabled>{form.region ?? '请选择区域'}</option>
              )}
              {regionOptions.map(region => <option key={region.id} value={region.id}>{region.name}</option>)}
            </select>
          </label>
        )}
        {form.presetId === 'custom' && (
          <label className={labelCls}>
            协议
            <select className={inputCls} value={form.protocol} onChange={event => edit({ protocol: event.target.value as ModelProtocol })}>
              <option value="" disabled>请选择协议</option>
              {MODEL_PROTOCOLS.map(protocol => <option key={protocol} value={protocol}>{modelProtocolNames[protocol]}</option>)}
            </select>
          </label>
        )}
      </div>

      <label className={labelCls}>
        Base URL
        <input className={`${inputCls} font-mono text-xs`} value={form.baseUrl} maxLength={2048} aria-invalid={!!form.baseUrl && !validBaseUrl}
          onChange={event => edit({ baseUrl: event.target.value.trim() })} />
      </label>
      {form.baseUrl && !validBaseUrl && <p className={errorCls}>{reasons.INVALID_MODEL_BASE_URL}</p>}
      <p className={`model-endpoint ${hintCls}`}>
        最终生成端点{' '}
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground break-all">
          {validBaseUrl ? endpointPreview(form, modelId) : '等待有效的 Base URL'}
        </code>
      </p>

      <div className={subSectionCls}>
        <h4 className="text-[13px] font-semibold text-foreground">模型列表</h4>
        {connection && <p className={hintCls}>已保存 {connection.totalModelCount ?? directory.models.length} 个模型。</p>}
        <ModelCatalogFeedback directory={directory} />
        {form.manualModels.length > 0 && (
          <ul className="model-manual-list divide-y divide-border/70 overflow-hidden rounded-lg border border-border/75 bg-background">
            {form.manualModels.map(model => (
              <li key={model.modelId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
                <span className="min-w-0 break-all text-foreground">
                  {model.displayName && `${model.displayName} · `}
                  <code className="font-mono text-[11.5px]">{model.modelId}</code>
                </span>
                <button className={btnOutlineCls} disabled={!canEditModels} aria-label={`移除模型 ${model.modelId}`}
                  onClick={() => edit({ manualModels: form.manualModels.filter(item => item.modelId !== model.modelId) })}>
                  移除
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="model-fields grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className={labelCls}>
            手动模型 ID
            <input
              className={`${inputCls} font-mono text-xs`}
              value={manualId}
              maxLength={256}
              placeholder="如 deepseek-chat，按 Enter 添加"
              onChange={event => setManualId(event.target.value)}
              onKeyDown={event => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key === 'Enter' && manualId && canEditModels) {
                  event.preventDefault();
                  addModel();
                }
              }}
            />
          </label>
          <label className={labelCls}>
            模型显示名称（可选）
            <input
              className={inputCls}
              value={manualName}
              maxLength={200}
              placeholder="留空则直接显示模型 ID"
              onChange={event => setManualName(event.target.value)}
              onKeyDown={event => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key === 'Enter' && manualId && canEditModels) {
                  event.preventDefault();
                  addModel();
                }
              }}
            />
          </label>
        </div>
        <div>
          <button className={btnOutlineCls} disabled={!manualId || !canEditModels} onClick={addModel}>添加模型</button>
        </div>
        {manualError && <p className={errorCls} role="alert">{manualError}</p>}
      </div>

      <div className="model-actions model-save flex flex-wrap items-center gap-2">
        <button className={btnPrimaryCls} disabled={busy.save || !canSave || !form.name.trim() || !form.protocol || !validBaseUrl} onClick={save}>
          {busy.save ? '正在保存连接…' : '保存连接'}
        </button>
        {versionConflict && (
          <button className={btnOutlineCls} disabled={refreshing || !directory.complete} onClick={() => setEditor(stored)}>
            读取已保存配置
          </button>
        )}
      </div>
      {versionConflict && <p className={errorCls} role="status">{reasons.MODEL_CONNECTION_CONFLICT}</p>}
      {actionFeedback('save')}
      {draftChanged && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/25 bg-primary/[0.045] px-3 py-2 text-xs text-foreground">
          <span>{reasons.MODEL_CONNECTION_NOT_APPLIED}</span>
          <button
            type="button"
            className="shrink-0 cursor-pointer font-medium text-primary hover:underline"
            onClick={() => {
              const heading = document.getElementById('current-model-heading');
              heading?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              const target = document.getElementById('model-selector-connection');
              if (target instanceof HTMLElement && !(target as HTMLSelectElement).disabled) {
                target.focus({ preventScroll: true });
              }
            }}
          >
            前往上方应用切换
          </button>
        </div>
      )}

      {connection && revision ? (
        <>
          <div className={subSectionCls}>
            <h4 className="text-[13px] font-semibold text-foreground">API Key</h4>
            <p className={hintCls}>{new URL(revision.baseUrl).host} · {modelKeyStatus(revision)}</p>
            {revision.unavailableReason && <p className={hintCls}>{reasons[revision.unavailableReason]}</p>}
            <div className="model-fields grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className={labelCls}>
                本次 API Key
                <input type="password" autoComplete="off" className={inputCls} maxLength={4000} value={keyValue} disabled={!savedRoute}
                  onChange={event => setKeyDraft({ value: event.target.value, destination })} />
              </label>
              <label className={labelCls}>
                Key 存储方式
                <select className={inputCls} value={storage} onChange={event => setStorage(event.target.value as ModelKeyStorage)}>
                  <option value="MEMORY">仅保存在内存（退出后清除）</option>
                  <option value="DPAPI">本机加密保存（DPAPI，重启保留）</option>
                </select>
              </label>
            </div>
            <div className="model-actions flex flex-wrap items-center justify-between gap-2">
              <button className={btnPrimaryCls} disabled={refreshing || busy.setKey || !keyValue.trim()} onClick={() => writeKey(false)}>
                {busy.setKey ? '正在更新 Key…' : '保存 Key'}
              </button>
              <button
                type="button"
                className={btnDangerCls}
                disabled={refreshing || anyBusy || !canClearKey}
                onClick={() =>
                  setConfirmClearKey(current =>
                    current?.id === connection.id && current.version === connection.version
                      ? null
                      : { id: connection.id, version: connection.version },
                  )
                }
              >
                清除 Key
              </button>
            </div>
            {confirmClearKey?.id === connection.id &&
              confirmClearKey.version === connection.version &&
              !anyBusy &&
              canClearKey && (
              <div className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/6 p-3">
                <p className="text-xs text-destructive-foreground">
                  确认清除「{connection.name}」的全部 Key？依赖该连接的模型调用将停止。
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className={btnDangerCls}
                    disabled={refreshing || anyBusy}
                    onClick={() => writeKey(true, confirmClearKey.version)}
                  >
                    确认清除 Key
                  </button>
                  <button
                    type="button"
                    className={btnOutlineCls}
                    onClick={() => setConfirmClearKey(null)}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
            {actionFeedback('setKey')}
          </div>

          <div className={subSectionCls}>
            <h4 className="text-[13px] font-semibold text-foreground">获取目录与测试</h4>
            {!savedRoute && <p className={hintCls}>地址、协议或区域已修改。保存连接后可更新 Key、获取模型或测试。</p>}
            {!revision.keyPresent && <p className={hintCls}>请先保存 Key，再获取模型或测试。</p>}
            {presets[revision.presetId].manualOnly && (
              <p className={hintCls}>此预设使用手动模型 ID{revision.presetId === 'doubao' ? ' 或 Endpoint ID' : ''}。</p>
            )}
            <div>
              <button
                className={btnOutlineCls}
                disabled={refreshing || busy.discover || !savedRoute || !revision.keyPresent || presets[revision.presetId].manualOnly}
                onClick={() => void run({ command: 'modelProviders', action: 'discover', connectionId: connection.id, routeRevision: revision.routeRevision })}
              >
                {busy.discover ? '正在获取模型…' : '获取模型'}
              </button>
            </div>
            {catalog && (
              <p className={catalog.status === 'FAILED' ? errorCls : hintCls} role="status">
                {catalog.status === 'PARTIAL' ? `列表未完整获取，已保留 ${catalogCount} 个模型，可继续手动添加。`
                  : catalog.status === 'COMPLETE' ? `目录已获取，共 ${catalogCount} 个模型。` : '获取模型失败，可手动添加。'}
                {catalog.status === 'PARTIAL' && ('truncated' in catalog && catalog.truncated === true ? ' 目录已达到保留上限。' : ' 目录读取中断。')}
                {catalog.reason && ` ${reasons[catalog.reason]}`}
              </p>
            )}
            {actionFeedback('discover')}
            <label className={labelCls}>
              测试模型
              <select className={inputCls} value={modelId} onChange={event => setChosenModel(event.target.value)}>
                <option value="" disabled>请选择已保存的模型</option>
                {directory.models.map(model => <option key={model.modelId} value={model.modelId}>{modelOption(model)}</option>)}
              </select>
            </label>
            {budgetExhausted && <p className={hintCls}>{reasons.MODEL_BUDGET_EXHAUSTED}</p>}
            {stopped && <p className={hintCls}>全局急停期间暂不能测试。</p>}
            <div>
              <button
                className={btnOutlineCls}
                disabled={refreshing || busy.test || !savedRoute || !revision.keyPresent || !modelId || budgetExhausted || stopped}
                onClick={() => void run({
                  command: 'modelProviders', action: 'test', connectionId: connection.id, routeRevision: revision.routeRevision,
                  modelId, confirmed: true, commandId: globalThis.crypto.randomUUID(),
                })}
              >
                {busy.test ? '正在测试连接…' : '测试连接（调用 1 次模型）'}
              </button>
            </div>
            {test && (
              <p className={test.status === 'FAILED' ? errorCls : hintCls} role="status">
                {test.status === 'SUCCEEDED' ? '连接测试通过。' : test.status === 'FAILED' ? '连接测试失败。'
                  : test.status === 'INTERRUPTED' ? '本次连接测试已中断。' : '后端正在测试连接。'}{' '}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{test.modelId}</code>
                {test.reportedModelId && test.reportedModelId !== test.modelId && (
                  <> · 服务返回 <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{test.reportedModelId}</code></>
                )}
                {test.elapsedMs !== null && ` · ${test.elapsedMs} ms`}
                {test.reason && ` · ${reasons[test.reason]}`}
              </p>
            )}
            {actionFeedback('test')}
          </div>
        </>
      ) : (
        <p className={hintCls}>保存连接后可设置 Key、获取模型和测试。</p>
      )}
    </section>
  );
}
