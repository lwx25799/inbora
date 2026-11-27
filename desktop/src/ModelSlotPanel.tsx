import { useEffect, useRef, useState } from 'react';
import type * as React from 'react';
import {
  OPTIONAL_MODEL_SLOTS,
  type ModelCatalogEntry,
  type ModelSlotRoute,
  type OptionalModelSlot,
  type PublicModelConnection,
  type PublicModelSlots,
  type PublicModelState,
} from '../../src/contracts/model-providers.js';
import { modelPresetNames, modelProtocolNames, readModelCatalog, request } from './api';
import { Badge } from './components/ui/badge';
import { explainSafe } from './error-messages';
import { modelOption } from './ModelSelector';

export interface ModelSlotPanelProps {
  state?: PublicModelState;
  available?: boolean;
  disabled?: boolean;
  refreshing?: boolean;
}

interface OptionalSlotMeta {
  slot: OptionalModelSlot;
  title: string;
  badgeFallback: string;
  description: string;
}

type SlotDrafts = Record<OptionalModelSlot, { connectionId: string; modelId: string }>;

const OPTIONAL_SLOT_META: ReadonlyArray<OptionalSlotMeta> = [
  {
    slot: 'vision',
    title: '视觉看图模型',
    badgeFallback: '未配置时转人工',
    description:
      '仅用于解析开启看图开关后的客户截图或图片；未配置或未开启时，含图消息直接转人工处理，不臆测图片内容。',
  },
  {
    slot: 'utility',
    title: '后台辅助模型',
    badgeFallback: '自动回退主模型',
    description:
      '用于候选问答提炼、意图分类等后台轻任务；未配置时优先本地规则处理，必要时自动回退至主对话模型。',
  },
  {
    slot: 'embedding',
    title: '云端文本向量',
    badgeFallback: '优先本机或词检索',
    description:
      '用于知识检索辅助嵌入；未配置时优先使用本机向量引擎，未就绪则自动降级为增强关键词检索，不阻塞主流程。',
  },
];

const cardCls =
  'flex flex-col gap-4 rounded-2xl border border-border/85 bg-card p-5 text-card-foreground shadow-xs/5';
const slotCardCls =
  'flex flex-col justify-between gap-3 rounded-xl border border-border/75 bg-background/60 p-4';
const selectCls =
  'h-8.5 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-[13px] text-foreground shadow-xs/5 outline-none transition-shadow focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/32';
const btnPrimaryCls =
  'primary inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-primary bg-primary px-3 text-xs font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55';
const btnOutlineCls =
  'inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-input bg-popover px-3 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55 dark:bg-input/32 dark:hover:bg-input/64';

function slotDraftFromRoute(
  route: ModelSlotRoute | null | undefined,
): { connectionId: string; modelId: string } {
  return {
    connectionId: route?.connectionId ?? '',
    modelId: route?.modelId ?? '',
  };
}

function draftsFromSlots(slots: PublicModelSlots | null): SlotDrafts {
  return {
    vision: slotDraftFromRoute(slots?.vision),
    utility: slotDraftFromRoute(slots?.utility),
    embedding: slotDraftFromRoute(slots?.embedding),
  };
}

export function ModelSlotPanel({
  state,
  available = true,
  disabled = false,
  refreshing = false,
}: ModelSlotPanelProps): React.ReactElement | null {
  const [slots, setSlots] = useState<PublicModelSlots | null>(null);
  const [drafts, setDrafts] = useState<SlotDrafts>(() => draftsFromSlots(null));
  const [catalogCache, setCatalogCache] = useState<Record<string, ModelCatalogEntry[]>>({});
  const [loading, setLoading] = useState(false);
  const [savingSlot, setSavingSlot] = useState<OptionalModelSlot | null>(null);
  const [loadError, setLoadError] = useState('');
  const [slotErrors, setSlotErrors] = useState<Partial<Record<OptionalModelSlot, string>>>({});
  const [feedback, setFeedback] = useState('');
  const readSeq = useRef(0);
  const slotsRef = useRef<PublicModelSlots | null>(null);
  const initializedDraftsRef = useRef(false);

  const selectionRevision = state?.selection.selectionRevision;
  const connections = state?.connections ?? [];

  useEffect(() => {
    if (!available) {
      initializedDraftsRef.current = false;
      slotsRef.current = null;
      return;
    }
    let active = true;
    const seq = ++readSeq.current;
    setLoading(true);
    setLoadError('');
    void request<PublicModelSlots>({ command: 'modelProviders', action: 'getSlots' })
      .then(result => {
        if (!active || readSeq.current !== seq) return;
        const prevSlots = slotsRef.current;
        slotsRef.current = result;
        setSlots(result);
        if (!initializedDraftsRef.current || !prevSlots) {
          initializedDraftsRef.current = true;
          setDrafts(draftsFromSlots(result));
        } else {
          setDrafts(current => {
            const nextDrafts = { ...current };
            for (const slot of OPTIONAL_MODEL_SLOTS) {
              const prevSaved = slotDraftFromRoute(prevSlots[slot]);
              const cur = current[slot];
              if (cur.connectionId === prevSaved.connectionId && cur.modelId === prevSaved.modelId) {
                nextDrafts[slot] = slotDraftFromRoute(result[slot]);
              }
            }
            return nextDrafts;
          });
        }
      })
      .catch(cause => {
        if (!active || readSeq.current !== seq) return;
        setLoadError(explainSafe(cause, '无法读取四槽位模型路由状态。'));
      })
      .finally(() => {
        if (active && readSeq.current === seq) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [available, selectionRevision]);

  const selectedConnIdsKey = OPTIONAL_MODEL_SLOTS.map(slot => drafts[slot].connectionId)
    .filter(Boolean)
    .join(',');

  useEffect(() => {
    if (!available) return;
    let active = true;
    const pendingConnections = OPTIONAL_MODEL_SLOTS.map(slot =>
      connections.find(item => item.id === drafts[slot].connectionId),
    ).filter((conn): conn is PublicModelConnection => {
      if (!conn || !conn.modelsTruncated) return false;
      const cacheKey = `${conn.id}:${conn.version}`;
      return !catalogCache[cacheKey];
    });
    if (pendingConnections.length === 0) return;

    const unique = new Map<string, PublicModelConnection>();
    for (const conn of pendingConnections) unique.set(`${conn.id}:${conn.version}`, conn);

    for (const [cacheKey, conn] of unique) {
      void readModelCatalog(conn)
        .then(models => {
          if (!active) return;
          setCatalogCache(current => (current[cacheKey] ? current : { ...current, [cacheKey]: models }));
        })
        .catch(() => {
          // Fallback to inline models when full catalog fetch fails.
        });
    }
    return () => {
      active = false;
    };
  }, [available, selectedConnIdsKey, connections.length]);

  if (!available) return null;

  const primary = slots?.primary ?? state?.selection ?? null;
  const primaryConn =
    primary && primary.connectionId !== null
      ? connections.find(item => item.id === primary.connectionId)
      : undefined;
  const primaryApplied =
    primaryConn && primary && primaryConn.applied?.routeRevision === primary.routeRevision
      ? primaryConn.applied
      : null;

  async function saveSlot(meta: OptionalSlotMeta, conn: PublicModelConnection, modelId: string) {
    if (savingSlot || disabled || refreshing) return;
    setSavingSlot(meta.slot);
    setFeedback('');
    setSlotErrors(current => ({ ...current, [meta.slot]: undefined }));
    try {
      const next = await request<PublicModelSlots>({
        command: 'modelProviders',
        action: 'setSlot',
        commandId: globalThis.crypto.randomUUID(),
        slot: meta.slot,
        connectionId: conn.id,
        routeRevision: conn.draft.routeRevision,
        modelId,
        confirmed: true,
      });
      slotsRef.current = next;
      setSlots(next);
      setDrafts(current => ({
        ...current,
        [meta.slot]: slotDraftFromRoute(next[meta.slot]),
      }));
      setFeedback(`已保存「${meta.title}」绑定。`);
    } catch (cause) {
      setSlotErrors(current => ({
        ...current,
        [meta.slot]: explainSafe(cause, `保存「${meta.title}」失败，请稍后重试。`),
      }));
    } finally {
      setSavingSlot(null);
    }
  }

  async function clearSlot(meta: OptionalSlotMeta) {
    if (savingSlot || disabled || refreshing) return;
    setSavingSlot(meta.slot);
    setFeedback('');
    setSlotErrors(current => ({ ...current, [meta.slot]: undefined }));
    try {
      const next = await request<PublicModelSlots>({
        command: 'modelProviders',
        action: 'setSlot',
        commandId: globalThis.crypto.randomUUID(),
        slot: meta.slot,
        connectionId: null,
        routeRevision: null,
        modelId: null,
        confirmed: true,
      });
      slotsRef.current = next;
      setSlots(next);
      setDrafts(current => ({
        ...current,
        [meta.slot]: slotDraftFromRoute(next[meta.slot]),
      }));
      setFeedback(`已清除「${meta.title}」绑定，将按自动降级策略运行。`);
    } catch (cause) {
      setSlotErrors(current => ({
        ...current,
        [meta.slot]: explainSafe(cause, `清除「${meta.title}」失败，请稍后重试。`),
      }));
    } finally {
      setSavingSlot(null);
    }
  }

  function renderOptionalSlot(meta: OptionalSlotMeta, route: ModelSlotRoute | null) {
    const draft = drafts[meta.slot];
    const selectedConn = connections.find(item => item.id === draft.connectionId);
    const boundConn = route ? connections.find(item => item.id === route.connectionId) : undefined;
    const cachedModels = selectedConn
      ? (catalogCache[`${selectedConn.id}:${selectedConn.version}`] ?? selectedConn.models)
      : [];
    const modelChoices = [...cachedModels];
    if (
      selectedConn &&
      route &&
      route.connectionId === selectedConn.id &&
      !modelChoices.some(item => item.modelId === route.modelId)
    ) {
      modelChoices.unshift({ modelId: route.modelId, displayName: null, source: 'MANUAL' });
    }

    const activeModelId =
      selectedConn && modelChoices.some(item => item.modelId === draft.modelId)
        ? draft.modelId
        : selectedConn && modelChoices.length === 1
          ? modelChoices[0]!.modelId
          : '';

    const unchanged =
      !!route &&
      !!selectedConn &&
      route.connectionId === selectedConn.id &&
      route.routeRevision === selectedConn.draft.routeRevision &&
      route.modelId === activeModelId;
    const isBusy = savingSlot === meta.slot || disabled || refreshing;
    const slotError = slotErrors[meta.slot];

    return (
      <div key={meta.slot} className={slotCardCls} data-slot-id={meta.slot}>
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[13.5px] font-semibold text-foreground">{meta.title}</div>
            <Badge variant={route ? 'success' : 'secondary'} size="sm">
              {route ? '已单独指定' : meta.badgeFallback}
            </Badge>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">{meta.description}</p>
          {route && (
            <div className="rounded-lg border border-primary/20 bg-primary/[0.04] px-3 py-2 text-xs text-foreground">
              当前绑定：
              <span className="font-medium">
                {boundConn ? `${boundConn.name} · ${modelPresetNames[boundConn.draft.presetId]}` : '已保存连接'}
              </span>
              {' · '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{route.modelId}</code>
            </div>
          )}
        </div>

        <div className="space-y-2.5">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs font-medium text-foreground">
              选择连接
              <select
                aria-label={`${meta.title}连接`}
                className={selectCls}
                value={draft.connectionId}
                disabled={isBusy || connections.length === 0}
                onChange={event => {
                  const nextId = event.target.value;
                  setFeedback('');
                  setSlotErrors(current => ({ ...current, [meta.slot]: undefined }));
                  setDrafts(current => ({
                    ...current,
                    [meta.slot]: { connectionId: nextId, modelId: '' },
                  }));
                }}
              >
                <option value="">请选择连接</option>
                {connections.map(item => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {modelPresetNames[item.draft.presetId]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-foreground">
              选择模型
              <select
                aria-label={`${meta.title}模型`}
                className={selectCls}
                value={activeModelId}
                disabled={isBusy || !selectedConn}
                onChange={event => {
                  const nextModel = event.target.value;
                  setFeedback('');
                  setSlotErrors(current => ({ ...current, [meta.slot]: undefined }));
                  setDrafts(current => ({
                    ...current,
                    [meta.slot]: { ...current[meta.slot], modelId: nextModel },
                  }));
                }}
              >
                <option value="">请选择模型</option>
                {modelChoices.map(model => (
                  <option key={model.modelId} value={model.modelId}>
                    {modelOption(model)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {selectedConn && !selectedConn.draft.keyPresent && (
            <p className="text-[11.5px] text-warning-foreground">
              提示：所选连接尚未配置 Key，调用前请先在下方提供商管理中补全 Key。
            </p>
          )}
          {slotError && (
            <p
              className="rounded-lg border border-destructive/30 bg-destructive/6 px-2.5 py-1.5 text-xs font-medium text-destructive-foreground"
              role="alert"
            >
              {slotError}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-label={`保存${meta.title}`}
              className={btnPrimaryCls}
              disabled={isBusy || !selectedConn || !activeModelId || unchanged}
              onClick={() => {
                if (selectedConn && activeModelId) {
                  void saveSlot(meta, selectedConn, activeModelId);
                }
              }}
            >
              {savingSlot === meta.slot ? '保存中…' : '保存绑定'}
            </button>
            <button
              type="button"
              aria-label={`清除${meta.title}`}
              className={btnOutlineCls}
              disabled={isBusy || !route}
              onClick={() => void clearSlot(meta)}
            >
              清除（自动降级）
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <section className={cardCls} aria-labelledby="model-slots-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="model-slots-heading" className="font-heading text-[15px] font-semibold text-foreground">
              渐进四槽位模型路由
            </h2>
            <Badge variant="outline" size="sm">
              仅配主模型即可运行
            </Badge>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            只需配置主对话模型即可完成全部日常接待；视觉看图、后台辅助与云端向量均为可选槽位，留空时自动按规则降级。
          </p>
        </div>
        {loading && <span className="text-xs text-muted-foreground">正在同步槽位状态…</span>}
      </div>

      {loadError && (
        <p
          className="rounded-xl border border-destructive/30 bg-destructive/6 px-3.5 py-2 text-xs font-medium text-destructive-foreground"
          role="alert"
        >
          {loadError}
        </p>
      )}
      {feedback && (
        <p
          className="rounded-xl border border-success/30 bg-success/8 px-3.5 py-2 text-xs font-medium text-success-foreground"
          role="status"
        >
          {feedback}
        </p>
      )}

      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
        <div className={slotCardCls} data-slot-id="primary">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-[13.5px] font-semibold text-foreground">主对话模型</div>
              <Badge variant={primary?.connectionId ? 'success' : 'secondary'} size="sm">
                {primary?.connectionId ? '必填 · 已生效' : '必填 · 未选择'}
              </Badge>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              用于人工建议、自动回复、知识库学习与试聊；直接沿用上方当前全局生效模型，无需重复设置。
            </p>
          </div>
          <div className="rounded-lg border border-primary/20 bg-primary/[0.04] px-3 py-2.5 text-xs">
            {primary && primary.connectionId !== null ? (
              <div className="space-y-1">
                <div className="font-medium text-foreground">
                  {primaryConn
                    ? `${primaryConn.name} · ${modelPresetNames[primaryConn.draft.presetId]}`
                    : '已选主模型连接'}
                  {primaryApplied ? ` · ${modelProtocolNames[primaryApplied.protocol]}` : ''}
                </div>
                <div className="text-muted-foreground">
                  模型 ID：
                  {primary.modelDisplayName ? `${primary.modelDisplayName} · ` : ''}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
                    {primary.modelId}
                  </code>
                </div>
              </div>
            ) : (
              <span className="text-muted-foreground">尚未在上方应用全局主模型，应用后此处自动同步。</span>
            )}
          </div>
        </div>

        {OPTIONAL_SLOT_META.map(meta => renderOptionalSlot(meta, slots ? slots[meta.slot] : null))}
      </div>
    </section>
  );
}
