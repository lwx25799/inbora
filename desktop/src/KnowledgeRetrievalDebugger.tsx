import { useEffect, useRef, useState } from 'react';
import type { Channel } from '../../src/contracts/events.js';
import {
  channelName,
  describeKnowledgeError,
  knowledgeRequest,
  type OnnxEmbeddingStatus,
  type RetrievalDebugResult,
} from './knowledge-client';

interface KnowledgeRetrievalDebuggerProps {
  channel: Channel;
  sourceIds: string[];
  draftMessage: string;
  busy: boolean;
}

const hintCls = 'hint text-xs leading-relaxed text-muted-foreground';
const inputCls =
  'h-8.5 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-[13px] text-foreground shadow-xs/5 outline-none transition-shadow focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/32';
const selectCls =
  'h-8.5 min-w-0 rounded-lg border border-input bg-background px-2.5 text-xs text-foreground shadow-xs/5 outline-none transition-shadow focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/32';
const btnOutlineCls =
  'inline-flex h-8.5 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-input bg-popover px-3 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55 dark:bg-input/32 dark:hover:bg-input/64';

const thresholdPresets = [
  { value: '0.15', label: '宽松（0.15）' },
  { value: '0.25', label: '标准 · 推荐（0.25）' },
  { value: '0.45', label: '严格（0.45）' },
] as const;

export function describeEngineMode(mode: 'FTS5_ENHANCED' | 'HYBRID_ONNX' | undefined): string {
  return mode === 'HYBRID_ONNX' ? '关键词 + 本机语义混合检索' : '关键词增强检索';
}

export function describeEmbeddingBadge(status: OnnxEmbeddingStatus): {
  label: string;
  tone: 'success' | 'muted' | 'warning';
} {
  if (status.engineMode === 'HYBRID_ONNX') {
    return {
      label:
        status.state === 'REUSED_LOCAL'
          ? '本机语义索引已就绪（复用本机模型）'
          : '本机语义索引已就绪',
      tone: 'success',
    };
  }
  if (status.state === 'REUSED_LOCAL' || status.state === 'DOWNLOAD_READY') {
    return { label: '本机模型已校验 · 当前使用关键词增强检索', tone: 'muted' };
  }
  if (status.state === 'MISSING_NEEDS_DOWNLOAD') {
    return { label: '当前使用关键词增强检索（本机语义模型未安装）', tone: 'muted' };
  }
  return { label: '已自动切换为关键词增强检索', tone: 'warning' };
}

/** Pure state controller shared by the component and unit tests to guard async ordering and scope changes. */
export interface DebuggerViewState {
  scopeKey: string;
  debugSeq: number;
  statusEpoch: number;
  appliedStatusEpoch: number;
  debugResult: RetrievalDebugResult | null;
  embeddingStatus: OnnxEmbeddingStatus | null;
  error: string;
}

export function buildDebuggerScopeKey(channel: Channel, sourceIds: readonly string[]): string {
  return `${channel}|${[...sourceIds].sort().join(',')}`;
}

export function createInitialDebuggerState(scopeKey: string): DebuggerViewState {
  return {
    scopeKey,
    debugSeq: 0,
    statusEpoch: 0,
    appliedStatusEpoch: 0,
    debugResult: null,
    embeddingStatus: null,
    error: '',
  };
}

export function invalidateDebuggerScope(
  prev: DebuggerViewState,
  nextScopeKey: string,
): DebuggerViewState {
  if (prev.scopeKey === nextScopeKey) return prev;
  return {
    ...prev,
    scopeKey: nextScopeKey,
    debugSeq: prev.debugSeq + 1,
    debugResult: null,
    error: '',
  };
}

export function applyDebugResponse(
  current: DebuggerViewState,
  req: { seq: number; scopeKey: string; statusEpoch: number },
  response: RetrievalDebugResult,
): DebuggerViewState {
  if (req.seq !== current.debugSeq || req.scopeKey !== current.scopeKey) return current;
  const shouldUpdateStatus = req.statusEpoch >= current.appliedStatusEpoch;
  return {
    ...current,
    debugResult: response,
    embeddingStatus: shouldUpdateStatus ? response.onnxStatus : current.embeddingStatus,
    appliedStatusEpoch: shouldUpdateStatus ? req.statusEpoch : current.appliedStatusEpoch,
    error: '',
  };
}

export function applyEmbeddingStatusResponse(
  current: DebuggerViewState,
  reqEpoch: number,
  status: OnnxEmbeddingStatus,
): DebuggerViewState {
  if (reqEpoch < current.appliedStatusEpoch) return current;
  return {
    ...current,
    embeddingStatus: status,
    appliedStatusEpoch: reqEpoch,
    error: '',
  };
}

export function resolveLatestEmbeddingStatus(state: DebuggerViewState): OnnxEmbeddingStatus | null {
  return state.embeddingStatus ?? state.debugResult?.onnxStatus ?? null;
}

function describeExactMatchType(type: 'EXACT_TITLE' | 'EXACT_ALIAS' | 'HIGH_CONFIDENCE'): string {
  if (type === 'EXACT_TITLE') return '标题精确一致';
  if (type === 'EXACT_ALIAS') return '别名精确一致';
  return '高置信唯一命中';
}

function describeRejectReason(reason: string): string {
  if (reason === 'STOPWORD_ONLY_WEAK_MATCH') return '仅命中寒暄或口语词，已防误引用过滤';
  if (reason === 'SINGLE_CHAR_WITHOUT_EXACT_ALIAS') return '单字提问未命中显式单字别名';
  return '相关度低于当前门槛，已自动过滤';
}

function formatScorePercent(score: number): string {
  return `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`;
}

export function KnowledgeRetrievalDebugger({
  channel,
  sourceIds,
  draftMessage,
  busy,
}: KnowledgeRetrievalDebuggerProps) {
  const scopeKey = buildDebuggerScopeKey(channel, sourceIds);
  const [query, setQuery] = useState('');
  const [minScore, setMinScore] = useState('0.25');
  const [running, setRunning] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [view, setView] = useState<DebuggerViewState>(() => createInitialDebuggerState(scopeKey));

  const viewRef = useRef(view);
  viewRef.current = view;
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (viewRef.current.scopeKey === scopeKey) return;
    const next = invalidateDebuggerScope(viewRef.current, scopeKey);
    viewRef.current = next;
    setView(next);
    setRunning(false);
  }, [scopeKey]);

  const effectiveStatus = resolveLatestEmbeddingStatus(view);
  const badge = effectiveStatus ? describeEmbeddingBadge(effectiveStatus) : null;
  const disabled = busy || running;

  const inspectEmbedding = async () => {
    if (disabled || checkingStatus) return;
    const reqEpoch = viewRef.current.statusEpoch + 1;
    viewRef.current = { ...viewRef.current, statusEpoch: reqEpoch, error: '' };
    setView(viewRef.current);
    setCheckingStatus(true);
    try {
      const status = await knowledgeRequest<OnnxEmbeddingStatus>({ action: 'embeddingStatus' });
      if (!aliveRef.current) return;
      const next = applyEmbeddingStatusResponse(viewRef.current, reqEpoch, status);
      viewRef.current = next;
      setView(next);
    } catch (failure) {
      if (!aliveRef.current || reqEpoch < viewRef.current.appliedStatusEpoch) return;
      const next = { ...viewRef.current, error: describeKnowledgeError(failure) };
      viewRef.current = next;
      setView(next);
    } finally {
      if (aliveRef.current) setCheckingStatus(false);
    }
  };

  const runPreview = async (overrideQuery?: string) => {
    const targetQuery = (overrideQuery ?? query).trim();
    if (!targetQuery || disabled) return;
    const reqSeq = viewRef.current.debugSeq + 1;
    const reqEpoch = viewRef.current.statusEpoch + 1;
    const reqScope = scopeKey;
    const reqSourceIds = [...sourceIds];
    viewRef.current = { ...viewRef.current, debugSeq: reqSeq, statusEpoch: reqEpoch, error: '' };
    setView(viewRef.current);
    setRunning(true);
    try {
      const parsedMin = Number(minScore);
      const response = await knowledgeRequest<RetrievalDebugResult>({
        action: 'debugRetrieval',
        channel,
        query: targetQuery,
        ...(reqSourceIds.length ? { sourceIds: reqSourceIds } : {}),
        ...(Number.isFinite(parsedMin) ? { minScore: parsedMin } : {}),
      });
      if (!aliveRef.current) return;
      const next = applyDebugResponse(
        viewRef.current,
        { seq: reqSeq, scopeKey: reqScope, statusEpoch: reqEpoch },
        response,
      );
      viewRef.current = next;
      setView(next);
    } catch (failure) {
      if (
        !aliveRef.current ||
        reqSeq !== viewRef.current.debugSeq ||
        reqScope !== viewRef.current.scopeKey
      ) {
        return;
      }
      const next = { ...viewRef.current, error: describeKnowledgeError(failure) };
      viewRef.current = next;
      setView(next);
    } finally {
      if (aliveRef.current && reqSeq === viewRef.current.debugSeq) {
        setRunning(false);
      }
    }
  };

  const { debugResult, error } = view;

  return (
    <section
      className="knowledge-retrieval-debugger flex flex-col gap-3 rounded-xl border border-border/80 bg-background p-4"
      aria-label="知识召回调试台"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-0.5">
          <h3 className="font-heading text-[14px] font-semibold text-foreground">
            知识召回调试台
          </h3>
          <p className={hintCls}>
            输入模拟提问即可预览命中知识、匹配度与过滤原因，不消耗模型额度，也不会生成外发内容。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {badge && (
            <span
              className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11.5px] font-medium ${
                badge.tone === 'success'
                  ? 'border-success/30 bg-success/8 text-success-foreground'
                  : badge.tone === 'warning'
                    ? 'border-warning/35 bg-warning/8 text-warning-foreground'
                    : 'border-border/80 bg-muted/45 text-muted-foreground'
              }`}
            >
              {badge.label}
            </span>
          )}
          <button
            type="button"
            className={btnOutlineCls}
            disabled={disabled || checkingStatus}
            onClick={() => void inspectEmbedding()}
          >
            {checkingStatus ? '检查中…' : '检查索引状态'}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="text"
          className={inputCls}
          aria-label="召回调试提问"
          maxLength={4000}
          placeholder={`输入客户常见问法（当前通道：${channelName(channel)}）`}
          value={query}
          disabled={disabled}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              void runPreview();
            }
          }}
        />
        <select
          className={selectCls}
          aria-label="相关度门槛"
          value={minScore}
          disabled={disabled}
          onChange={event => setMinScore(event.target.value)}
        >
          {thresholdPresets.map(option => (
            <option key={option.value} value={option.value}>
              门槛：{option.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={btnOutlineCls}
          disabled={disabled || !query.trim()}
          onClick={() => void runPreview()}
        >
          {running ? '预检中…' : '预检命中知识'}
        </button>
      </div>

      {draftMessage.trim() && draftMessage.trim() !== query.trim() && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>可直接预检下方模拟来信：</span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              setQuery(draftMessage.trim());
              void runPreview(draftMessage.trim());
            }}
            className="cursor-pointer font-medium text-primary hover:underline disabled:pointer-events-none disabled:opacity-50"
          >
            带入并预检
          </button>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-2 text-xs font-medium text-destructive-foreground"
        >
          {error}
        </p>
      )}

      {debugResult && (
        <div className="flex flex-col gap-3 border-t border-border/75 pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground tabular-nums">
            <span>
              检索方式：{describeEngineMode(debugResult.engineMode)} · 命中 {debugResult.hits.length}{' '}
              条 · 已过滤 {debugResult.rejectedBelowThreshold.length} 条
            </span>
            <span>通道：{channelName(debugResult.channel)}</span>
          </div>

          {debugResult.exactFaqHit && (
            <div className="rounded-xl border border-primary/30 bg-primary/[0.045] px-3.5 py-2.5 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-primary">
                  高置信标准问答命中 · {describeExactMatchType(debugResult.exactFaqHit.matchType)}
                </span>
                <span className="font-medium text-foreground tabular-nums">
                  匹配度 {formatScorePercent(debugResult.exactFaqHit.score)}
                </span>
              </div>
              <p className="mt-1 font-medium text-foreground">
                {debugResult.exactFaqHit.title} · v{debugResult.exactFaqHit.version}
              </p>
              <p className="mt-1 leading-relaxed text-muted-foreground">
                {debugResult.exactFaqHit.text}
              </p>
            </div>
          )}

          {debugResult.conflicts.length > 0 && (
            <p className="rounded-lg border border-warning/35 bg-warning/8 px-3 py-2 text-xs text-warning-foreground">
              检测到同主题知识冲突（{debugResult.conflicts.join('、')}），冲突主题已暂停引用，请先停用过期条目。
            </p>
          )}

          {debugResult.hits.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border bg-muted/25 px-3.5 py-3 text-xs text-muted-foreground">
              当前没有达到相关度门槛的已启用知识。请确认知识条目已启用、适用通道一致，或展开下方已过滤条目查看原因。
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {debugResult.hits.map(hit => (
                <article
                  key={hit.chunkId}
                  className="flex flex-col gap-1.5 rounded-lg border border-border/75 bg-muted/20 px-3 py-2.5 text-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-semibold text-foreground">{hit.title}</span>
                      <span className="text-muted-foreground">v{hit.version}</span>
                      {hit.exactMatch && (
                        <span className="rounded bg-primary/12 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                          精确命中
                        </span>
                      )}
                    </div>
                    <span className="font-medium text-foreground tabular-nums">
                      匹配度 {formatScorePercent(hit.score)}
                    </span>
                  </div>
                  <p className="leading-relaxed text-muted-foreground">{hit.textPreview}</p>
                  {hit.matchedTerms.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1 pt-0.5">
                      <span className="text-[11px] text-muted-foreground">命中词：</span>
                      {hit.matchedTerms.slice(0, 8).map(term => (
                        <span
                          key={term}
                          className="rounded border border-border/80 bg-background px-1.5 py-0.5 text-[11px] text-foreground"
                        >
                          {term}
                        </span>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}

          {debugResult.rejectedBelowThreshold.length > 0 && (
            <details className="rounded-lg border border-border/75 bg-muted/25 px-3 py-2 text-xs">
              <summary className="cursor-pointer font-medium text-foreground select-none">
                未达门槛已自动过滤（{debugResult.rejectedBelowThreshold.length} 条）
              </summary>
              <div className="mt-2 flex flex-col gap-1.5 text-muted-foreground">
                {debugResult.rejectedBelowThreshold.map(item => (
                  <div
                    key={`${item.id}-${item.reason}`}
                    className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-1.5 first:border-t-0 first:pt-0"
                  >
                    <span className="font-medium text-foreground">{item.title}</span>
                    <span className="tabular-nums">
                      得分 {formatScorePercent(item.score)} · {describeRejectReason(item.reason)}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          )}

          <details className="rounded-lg border border-border/75 bg-muted/20 px-3 py-2 text-xs">
            <summary className="cursor-pointer font-medium text-muted-foreground select-none">
              查看检索排障详情
            </summary>
            <div className="mt-2 flex flex-col gap-1 text-[11.5px] text-muted-foreground tabular-nums">
              <p>
                有效词级切分：
                {debugResult.wordTerms.length ? debugResult.wordTerms.join('、') : '无'}
              </p>
              <p>
                已过滤常见口语词：
                {debugResult.filteredStopTerms.length
                  ? debugResult.filteredStopTerms.join('、')
                  : '无'}
              </p>
              <p>
                当前门槛值：{debugResult.minScore} · 检索模式代码：{debugResult.engineMode}
              </p>
              <p>
                语义索引状态：{(effectiveStatus ?? debugResult.onnxStatus).state}（
                {(effectiveStatus ?? debugResult.onnxStatus).reason}）
              </p>
            </div>
          </details>
        </div>
      )}
    </section>
  );
}
