import { useEffect, useRef, useState } from 'react';
import type * as React from 'react';
import {
  BUSINESS_TOOL_IDS,
  DEFAULT_ACCOUNT_AI_FEATURES,
  MEDIA_ASSET_MIME_TYPES,
  type AccountAiFeatures,
  type BusinessToolId,
  type MediaAssetMimeType,
  type MediaAssetSummary,
} from '../../src/contracts/ai-runtime.js';
import { modelBaseUrlSchema } from '../../src/contracts/model-providers.js';
import { getActiveWorkbenchAccount, request } from './api';
import { AutoReplySwitch } from './components/AutoReplySwitch';
import { Badge } from './components/ui/badge';
import { errorMessages, explainSafe } from './error-messages';

export interface AiRuntimeFeaturesPanelProps {
  accountId?: string | null;
  accountLabel?: string | null;
  disabled?: boolean;
}

const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
const CHUNKED_UPLOAD_THRESHOLD = 48_000;
const CHUNK_BASE64_CHARS = 32 * 1024;

const BUSINESS_TOOL_META: Record<
  BusinessToolId,
  { label: string; description: string; placeholder: string }
> = {
  query_order_status: {
    label: '查订单',
    description: '查询订单当前履约状态与基础明细（只读）',
    placeholder: 'https://api.example.com/readonly/orders',
  },
  query_logistics_trace: {
    label: '查物流',
    description: '查询快递承运与最新物流节点轨迹（只读）',
    placeholder: 'https://api.example.com/readonly/logistics',
  },
  query_inventory_stock: {
    label: '查库存',
    description: '查询商品规格当前可售库存余量（只读）',
    placeholder: 'https://api.example.com/readonly/inventory',
  },
};

const cardCls =
  'flex flex-col gap-5 rounded-2xl border border-border/85 bg-card p-5 text-card-foreground shadow-xs/5';
const sectionCls = 'flex flex-col gap-3 rounded-xl border border-border/75 bg-background/60 p-4';
const inputCls =
  'h-8.5 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-[13px] text-foreground shadow-xs/5 outline-none transition-shadow focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/32';
const btnPrimaryCls =
  'primary inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-primary bg-primary px-3.5 text-xs font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55';
const btnDangerCls =
  'danger inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-1 whitespace-nowrap rounded-lg border border-destructive/35 bg-destructive/8 px-2.5 text-xs font-medium text-destructive-foreground shadow-xs/5 transition-colors hover:bg-destructive/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55';

function toEndpointDrafts(features: AccountAiFeatures): Record<BusinessToolId, string> {
  return {
    query_order_status: features.toolEndpoints.query_order_status ?? '',
    query_logistics_trace: features.toolEndpoints.query_logistics_trace ?? '',
    query_inventory_stock: features.toolEndpoints.query_inventory_stock ?? '',
  };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return globalThis.btoa(binary);
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function AiRuntimeFeaturesPanel({
  accountId,
  accountLabel,
  disabled = false,
}: AiRuntimeFeaturesPanelProps): React.ReactElement {
  const [features, setFeatures] = useState<AccountAiFeatures>(() => ({
    ...DEFAULT_ACCOUNT_AI_FEATURES,
    enabledBusinessTools: [],
    toolEndpoints: {},
  }));
  const [endpointDrafts, setEndpointDrafts] = useState<Record<BusinessToolId, string>>(() =>
    toEndpointDrafts(DEFAULT_ACCOUNT_AI_FEATURES),
  );
  const [assets, setAssets] = useState<MediaAssetSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const loadSeq = useRef(0);
  const mountedRef = useRef(true);
  const uploadEpochRef = useRef(0);
  const accountIdRef = useRef(accountId ?? null);
  accountIdRef.current = accountId ?? null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      uploadEpochRef.current += 1;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const seq = ++loadSeq.current;
    uploadEpochRef.current += 1;
    setUploading(false);
    setLoading(true);
    setError('');
    setNotice('');
    void Promise.all([
      request<AccountAiFeatures>({ command: 'accountAiFeatures', action: 'get' }),
      request<{ assets: MediaAssetSummary[] }>({ command: 'mediaAssets', action: 'list' }),
    ])
      .then(([loadedFeatures, loadedAssets]) => {
        if (!active || loadSeq.current !== seq) return;
        setFeatures(loadedFeatures);
        setEndpointDrafts(toEndpointDrafts(loadedFeatures));
        setAssets(loadedAssets.assets);
      })
      .catch(cause => {
        if (!active || loadSeq.current !== seq) return;
        setError(explainSafe(cause, '读取当前账号多模态与业务工具配置失败。'));
      })
      .finally(() => {
        if (active && loadSeq.current === seq) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [accountId]);

  function toggleBusinessTool(toolId: BusinessToolId, checked: boolean) {
    setError('');
    setNotice('');
    setFeatures(current => {
      const nextSet = new Set(current.enabledBusinessTools);
      if (checked) nextSet.add(toolId);
      else nextSet.delete(toolId);
      return {
        ...current,
        enabledBusinessTools: BUSINESS_TOOL_IDS.filter(id => nextSet.has(id)),
      };
    });
  }

  async function handleSaveFeatures() {
    if (saving || disabled) return;
    setError('');
    setNotice('');

    const nextEndpoints: AccountAiFeatures['toolEndpoints'] = {};
    for (const toolId of BUSINESS_TOOL_IDS) {
      const trimmed = endpointDrafts[toolId].trim();
      if (!trimmed) continue;
      if (!modelBaseUrlSchema.safeParse(trimmed).success) {
        setError(
          `「${BUSINESS_TOOL_META[toolId].label}」查询地址无效：${errorMessages.INVALID_MODEL_BASE_URL}`,
        );
        return;
      }
      nextEndpoints[toolId] = trimmed;
    }

    const payload: AccountAiFeatures = {
      visionEnabled: features.visionEnabled,
      mediaReplyEnabled: features.mediaReplyEnabled,
      enabledBusinessTools: [...features.enabledBusinessTools],
      toolEndpoints: nextEndpoints,
      syncCustomerAvatars: features.syncCustomerAvatars,
    };

    setSaving(true);
    try {
      const saved = await request<AccountAiFeatures>({
        command: 'accountAiFeatures',
        action: 'save',
        features: payload,
      });
      setFeatures(saved);
      setEndpointDrafts(toEndpointDrafts(saved));
      setNotice('已保存当前账号的多模态与只读业务工具配置。');
    } catch (cause) {
      setError(explainSafe(cause, '保存账号模型增强配置失败。'));
    } finally {
      setSaving(false);
    }
  }

  async function handleAssetUpload(file: File | undefined) {
    if (!file || uploading || disabled) return;
    setError('');
    setNotice('');

    const mimeAllowed = (MEDIA_ASSET_MIME_TYPES as readonly string[]).includes(file.type);
    if (!mimeAllowed || file.size <= 0) {
      setError(errorMessages.MEDIA_ASSET_INVALID ?? '素材图片格式无效，仅支持 PNG、JPEG、WEBP。');
      return;
    }
    if (file.size > MAX_MEDIA_BYTES) {
      setError(errorMessages.MEDIA_ASSET_TOO_LARGE ?? '素材图片体积超过 5 MiB 上限。');
      return;
    }

    const capturedEpoch = uploadEpochRef.current;
    const capturedWorkbenchRef = getActiveWorkbenchAccount()?.accountRef ?? null;
    const capturedAccountProp = accountIdRef.current;
    const isUploadStale = () =>
      !mountedRef.current ||
      uploadEpochRef.current !== capturedEpoch ||
      (getActiveWorkbenchAccount()?.accountRef ?? null) !== capturedWorkbenchRef ||
      accountIdRef.current !== capturedAccountProp;

    setUploading(true);
    try {
      const buffer = await file.arrayBuffer();
      if (isUploadStale()) return;

      const base64 = bytesToBase64(new Uint8Array(buffer));
      const name = file.name.trim().slice(0, 120) || '素材图片';
      let asset: MediaAssetSummary;
      if (base64.length > CHUNKED_UPLOAD_THRESHOLD) {
        const sha256 = await sha256Hex(buffer);
        if (isUploadStale()) return;
        const started = await request<{ uploadId: string; chunkLimit?: number }>({
          command: 'mediaAssets',
          action: 'uploadStart',
          name,
          mimeType: file.type as MediaAssetMimeType,
          bytes: buffer.byteLength,
          sha256,
        });
        if (isUploadStale()) return;

        const maxChunk =
          started.chunkLimit && started.chunkLimit >= 4
            ? Math.min(CHUNK_BASE64_CHARS, Math.floor(started.chunkLimit / 4) * 4)
            : CHUNK_BASE64_CHARS;
        for (let offset = 0, index = 0; offset < base64.length; offset += maxChunk, index += 1) {
          if (isUploadStale()) return;
          await request<{ uploadId: string; index: number; receivedBytes: number }>({
            command: 'mediaAssets',
            action: 'uploadChunk',
            uploadId: started.uploadId,
            index,
            data: base64.slice(offset, offset + maxChunk),
          });
        }
        if (isUploadStale()) return;
        const finished = await request<{ asset: MediaAssetSummary }>({
          command: 'mediaAssets',
          action: 'uploadFinish',
          uploadId: started.uploadId,
        });
        if (isUploadStale()) return;
        asset = finished.asset;
      } else {
        const saved = await request<{ asset: MediaAssetSummary }>({
          command: 'mediaAssets',
          action: 'save',
          name,
          base64,
        });
        if (isUploadStale()) return;
        asset = saved.asset;
      }
      setAssets(current => [asset, ...current.filter(item => item.id !== asset.id)]);
      setNotice(`已上传素材图片「${asset.name}」。`);
    } catch (cause) {
      if (isUploadStale()) return;
      setError(explainSafe(cause, '上传素材图片失败。'));
    } finally {
      if (mountedRef.current && uploadEpochRef.current === capturedEpoch) {
        setUploading(false);
      }
      if (mountedRef.current && fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleAssetDelete(asset: MediaAssetSummary) {
    if (deletingId || disabled) return;
    setError('');
    setNotice('');
    setDeletingId(asset.id);
    try {
      const result = await request<{ deleted: boolean; assetId: string }>({
        command: 'mediaAssets',
        action: 'delete',
        assetId: asset.id,
      });
      if (result.deleted) {
        setAssets(current => current.filter(item => item.id !== asset.id));
        setNotice(`已删除素材图片「${asset.name}」。`);
      }
    } catch (cause) {
      setError(explainSafe(cause, '删除素材图片失败。'));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className={cardCls} aria-labelledby="ai-runtime-features-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2
              id="ai-runtime-features-heading"
              className="font-heading text-[15px] font-semibold text-foreground"
            >
              账号级多模态与只读业务工具
            </h2>
            {accountLabel && (
              <Badge variant="outline" size="sm">
                当前账号：{accountLabel}
              </Badge>
            )}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            按当前账号独立生效，默认全部保持关闭；开关与本地素材仅在对应账号授权范围内使用。
          </p>
        </div>
        <button
          type="button"
          className={btnPrimaryCls}
          disabled={disabled || loading || saving}
          onClick={() => void handleSaveFeatures()}
        >
          {saving ? '保存中…' : '保存账号能力配置'}
        </button>
      </div>

      {loading && <p className="text-xs text-muted-foreground">正在读取账号配置与素材列表…</p>}
      {error && (
        <p
          className="rounded-xl border border-destructive/30 bg-destructive/6 px-3.5 py-2 text-xs font-medium text-destructive-foreground"
          role="alert"
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          className="rounded-xl border border-success/30 bg-success/8 px-3.5 py-2 text-xs font-medium text-success-foreground"
          role="status"
        >
          {notice}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className={sectionCls}>
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13.5px] font-semibold text-foreground">多模态看图开关</span>
                <Badge variant={features.visionEnabled ? 'success' : 'secondary'} size="sm">
                  {features.visionEnabled ? '已开启' : '默认关闭'}
                </Badge>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                默认关闭；仅客户发来的截图或图片在开启后送入视觉模型，真实缓存头像与固定说明绝不送入模型
              </p>
            </div>
            <AutoReplySwitch
              checked={features.visionEnabled}
              disabled={disabled || loading || saving}
              ariaLabel="多模态看图开关"
              onChange={checked => {
                setError('');
                setNotice('');
                setFeatures(current => ({ ...current, visionEnabled: checked }));
              }}
            />
          </div>
        </div>

        <div className={sectionCls}>
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13.5px] font-semibold text-foreground">素材库图片回复开关</span>
                <Badge variant={features.mediaReplyEnabled ? 'success' : 'secondary'} size="sm">
                  {features.mediaReplyEnabled ? '已开启' : '默认关闭'}
                </Badge>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                开启后，已授权的问答或客服回复可附带下方本地素材库中的图片；仅支持 PNG、JPEG、WEBP（不超过 5 MiB）。
              </p>
            </div>
            <AutoReplySwitch
              checked={features.mediaReplyEnabled}
              disabled={disabled || loading || saving}
              ariaLabel="素材库图片回复开关"
              onChange={checked => {
                setError('');
                setNotice('');
                setFeatures(current => ({ ...current, mediaReplyEnabled: checked }));
              }}
            />
          </div>
        </div>
      </div>

      <div className={sectionCls}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5">
            <div className="text-[13.5px] font-semibold text-foreground">本地回复素材库</div>
            <p className="text-xs text-muted-foreground">
              上传 PNG / JPEG / WEBP 图片（单张 ≤ 5 MiB），仅存本机私有运行目录。
            </p>
          </div>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-input bg-popover px-3 py-1.5 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent/60">
            <span>{uploading ? '上传中…' : '上传素材图片'}</span>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-label="上传素材图片"
              className="sr-only"
              disabled={disabled || uploading}
              onChange={event => {
                void handleAssetUpload(event.target.files?.[0]);
              }}
            />
          </label>
        </div>

        {assets.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border/80 px-3 py-2.5 text-xs text-muted-foreground">
            暂无本地素材图片。
          </p>
        ) : (
          <ul className="divide-y divide-border/70 rounded-lg border border-border/75 bg-card">
            {assets.map(asset => (
              <li
                key={asset.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="truncate font-medium text-foreground">{asset.name}</div>
                  <div className="text-[11px] text-muted-foreground tabular-nums">
                    {asset.mimeType} · {formatBytes(asset.bytes)}
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={`删除素材 ${asset.name}`}
                  className={btnDangerCls}
                  disabled={disabled || deletingId === asset.id}
                  onClick={() => void handleAssetDelete(asset)}
                >
                  {deletingId === asset.id ? '删除中…' : '删除'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={sectionCls}>
        <div className="space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13.5px] font-semibold text-foreground">白名单只读业务工具</span>
            <Badge variant="outline" size="sm">
              仅只读 GET 查询
            </Badge>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            仅只读查询，严禁写操作与绕过统一发送通道；查询地址须为公网 HTTPS 端点。
          </p>
        </div>

        <div className="space-y-2.5">
          {BUSINESS_TOOL_IDS.map(toolId => {
            const meta = BUSINESS_TOOL_META[toolId];
            const enabled = features.enabledBusinessTools.includes(toolId);
            return (
              <div
                key={toolId}
                className="grid grid-cols-1 items-center gap-2.5 rounded-lg border border-border/75 bg-card p-3 md:grid-cols-[220px_1fr]"
              >
                <label className="flex cursor-pointer items-start gap-2.5 select-none">
                  <input
                    type="checkbox"
                    aria-label={`启用 ${meta.label}`}
                    checked={enabled}
                    disabled={disabled || loading || saving}
                    onChange={event => toggleBusinessTool(toolId, event.target.checked)}
                    className="mt-0.5 size-4 rounded border-input accent-primary"
                  />
                  <span className="space-y-0.5">
                    <span className="block text-xs font-semibold text-foreground">{meta.label}</span>
                    <span className="block text-[11px] text-muted-foreground">{meta.description}</span>
                  </span>
                </label>
                <input
                  type="url"
                  aria-label={`${meta.label}查询地址`}
                  className={inputCls}
                  placeholder={meta.placeholder}
                  value={endpointDrafts[toolId]}
                  disabled={disabled || loading || saving}
                  onChange={event => {
                    const value = event.target.value;
                    setError('');
                    setNotice('');
                    setEndpointDrafts(current => ({ ...current, [toolId]: value }));
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
