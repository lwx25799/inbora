import { useEffect, useRef, useState } from 'react';
import type * as React from 'react';
import { ShieldCheckIcon } from 'lucide-react';
import {
  DEFAULT_REPLY_PIPELINE_PERSISTED_CONFIG,
  type ReplyPipelinePersistedConfig,
  type ReplyPipelineStatusView,
  type RhythmProfile,
  type RhythmStateSnapshot,
} from '../../src/contracts/reply-pipeline.js';
import { explain, request } from './api';
import { AutoReplySwitch } from './components/AutoReplySwitch';
import { Badge } from './components/ui/badge';
import {
  Card,
  CardFrame,
  CardFrameAction,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
} from './components/ui/card';

export interface ReplyPipelineSettingsProps {
  accountId?: string | null;
  disabled?: boolean;
  onSaved?: (status: ReplyPipelineStatusView) => void;
}

const RHYTHM_OPTIONS: ReadonlyArray<{
  value: RhythmProfile;
  label: string;
  detail: string;
}> = [
  { value: 'calm', label: '保守', detail: '慢速稳健 · 5 分钟最多 5 次' },
  { value: 'natural', label: '自然 · 推荐', detail: '日常推荐 · 5 分钟最多 12 次' },
  { value: 'active', label: '活跃', detail: '高峰响应 · 5 分钟最多 25 次' },
  { value: 'off', label: '关闭', detail: '不限制发送节奏' },
];

const DEBOUNCE_PRESETS = [2000, 3000, 4000, 5000] as const;

const inputCls =
  'h-8.5 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-[13px] text-foreground shadow-xs/5 outline-none transition-shadow focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/32';
const btnOutlineCls =
  'inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-input bg-popover px-3 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55 dark:bg-input/32 dark:hover:bg-input/64';
const btnPrimaryCls =
  'primary inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-primary bg-primary px-3.5 text-xs font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55';

function cloneConfig(config: ReplyPipelinePersistedConfig): ReplyPipelinePersistedConfig {
  return {
    rhythmProfile: config.rhythmProfile,
    debounce: { ...config.debounce },
    sensitive: {
      ...config.sensitive,
      customWords: [...config.sensitive.customWords],
    },
    handoff: {
      ...config.handoff,
      customTriggers: [...config.handoff.customTriggers],
    },
    loopBreaker: { ...config.loopBreaker },
  };
}

function formatClock(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString('zh-CN', { hour12: false });
}

export function summarizeRhythmState(
  rhythmState: RhythmStateSnapshot | null,
  profile: RhythmProfile,
  nowMs = Date.now(),
): { recentCount: number; totalActions: number; statusLabel: string } {
  if (!rhythmState) {
    return {
      recentCount: 0,
      totalActions: 0,
      statusLabel: profile === 'off' ? '节奏限制已关闭' : '暂无发送记录，启用后跨重启保留计数',
    };
  }
  const cutoff = nowMs - 5 * 60_000;
  const recentCount = rhythmState.windowTimestamps.filter(ts => ts > cutoff && ts <= nowMs + 60_000).length;
  let statusLabel = '节奏正常';
  if (profile === 'off') {
    statusLabel = '节奏限制已关闭';
  } else if (rhythmState.cooloffUntil > nowMs) {
    statusLabel = `冷却等待中（至 ${formatClock(rhythmState.cooloffUntil)}）`;
  } else if (rhythmState.nextAllowedAt > nowMs) {
    statusLabel = `间隔等待中（至 ${formatClock(rhythmState.nextAllowedAt)}）`;
  }
  return { recentCount, totalActions: rhythmState.totalActions, statusLabel };
}

function WordTagEditor({
  title,
  description,
  placeholder,
  ariaLabel,
  words,
  draftWord,
  localHint,
  disabled,
  onDraftChange,
  onAdd,
  onRemove,
}: {
  title: string;
  description: string;
  placeholder: string;
  ariaLabel: string;
  words: string[];
  draftWord: string;
  localHint: string;
  disabled: boolean;
  onDraftChange: (value: string) => void;
  onAdd: () => void;
  onRemove: (word: string) => void;
}) {
  return (
    <div className="space-y-2 rounded-xl border border-border/75 bg-muted/25 p-3.5">
      <div className="space-y-0.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-foreground">{title}</span>
          <span className="text-[11px] text-muted-foreground tabular-nums">{words.length}/200</span>
        </div>
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="text"
          className={inputCls}
          aria-label={ariaLabel}
          placeholder={placeholder}
          maxLength={60}
          value={draftWord}
          disabled={disabled}
          onChange={event => onDraftChange(event.target.value)}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              onAdd();
            }
          }}
        />
        <button
          type="button"
          className={btnOutlineCls}
          disabled={disabled || !draftWord.trim()}
          onClick={onAdd}
        >
          添加
        </button>
      </div>
      {localHint && (
        <p className="text-[11.5px] text-warning-foreground" role="status">
          {localHint}
        </p>
      )}
      {words.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {words.map(word => (
            <span
              key={word}
              className="inline-flex items-center gap-1 rounded-md border border-border/85 bg-background px-2 py-0.5 text-xs text-foreground"
            >
              <span>{word}</span>
              <button
                type="button"
                aria-label={`移除 ${word}`}
                disabled={disabled}
                onClick={() => onRemove(word)}
                className="cursor-pointer text-muted-foreground hover:text-destructive-foreground disabled:pointer-events-none disabled:opacity-50"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

interface SwitchRowProps {
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  ariaLabel: string;
  onChange: (checked: boolean) => void;
}

function renderSwitchRow({
  title,
  description,
  checked,
  disabled,
  ariaLabel,
  onChange,
}: SwitchRowProps) {
  return (
    <label
      key={ariaLabel}
      className="flex cursor-pointer items-start justify-between gap-3 rounded-xl border border-border/75 bg-background px-3.5 py-2.5 select-none has-[:disabled]:cursor-not-allowed"
    >
      <div className="space-y-0.5">
        <div className="text-[13px] font-medium text-foreground">{title}</div>
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <div className="pt-0.5">
        <AutoReplySwitch
          checked={checked}
          disabled={disabled}
          ariaLabel={ariaLabel}
          onChange={onChange}
        />
      </div>
    </label>
  );
}

export function ReplyPipelineSettings({
  accountId,
  disabled = false,
  onSaved,
}: ReplyPipelineSettingsProps): React.ReactElement {
  const [statusView, setStatusView] = useState<ReplyPipelineStatusView | null>(null);
  const [config, setConfig] = useState<ReplyPipelinePersistedConfig>(() =>
    cloneConfig(DEFAULT_REPLY_PIPELINE_PERSISTED_CONFIG),
  );
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [sensitiveDraft, setSensitiveDraft] = useState('');
  const [sensitiveHint, setSensitiveHint] = useState('');
  const [triggerDraft, setTriggerDraft] = useState('');
  const [triggerHint, setTriggerHint] = useState('');

  const validateWord = (
    raw: string,
    existing: string[],
    setHint: (msg: string) => void,
  ): string | null => {
    const clean = raw.trim();
    if (!clean) return null;
    if ([...clean].length > 60) {
      setHint('单个词语最多 60 个字，请精简后再添加。');
      return null;
    }
    if (existing.includes(clean)) {
      setHint('该词语已在列表中。');
      return null;
    }
    if (existing.length >= 200) {
      setHint('最多支持添加 200 个词语。');
      return null;
    }
    setHint('');
    return clean;
  };

  const aliveRef = useRef(true);
  const loadEpochRef = useRef(0);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      loadEpochRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (accountId === null) {
      setStatusView(null);
      setConfig(cloneConfig(DEFAULT_REPLY_PIPELINE_PERSISTED_CONFIG));
      setError('');
      setNotice('');
      return;
    }
    const epoch = ++loadEpochRef.current;
    setLoading(true);
    setError('');
    void request<ReplyPipelineStatusView>({ command: 'replyPipeline', action: 'getConfig' })
      .then(result => {
        if (!aliveRef.current || loadEpochRef.current !== epoch) return;
        setStatusView(result);
        setConfig(cloneConfig(result.config));
      })
      .catch(failure => {
        if (!aliveRef.current || loadEpochRef.current !== epoch) return;
        setError(explain(failure));
      })
      .finally(() => {
        if (aliveRef.current && loadEpochRef.current === epoch) {
          setLoading(false);
        }
      });
  }, [accountId]);

  const controlsDisabled = disabled || loading || saving || accountId === null;
  const rhythmInfo = summarizeRhythmState(statusView?.rhythmState ?? null, config.rhythmProfile);
  const handoffSummary = statusView?.handoffSummary ?? null;

  const saveConfig = async () => {
    if (controlsDisabled) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const saved = await request<ReplyPipelineStatusView>({
        command: 'replyPipeline',
        action: 'saveConfig',
        config,
      });
      if (!aliveRef.current) return;
      setStatusView(saved);
      setConfig(cloneConfig(saved.config));
      setNotice('自动回复保护与节流设置已保存，将立即生效并在重启后保留。');
      onSaved?.(saved);
    } catch (failure) {
      if (!aliveRef.current) return;
      setError(explain(failure));
    } finally {
      if (aliveRef.current) setSaving(false);
    }
  };

  return (
    <CardFrame aria-labelledby="reply-pipeline-settings-title">
      <CardFrameHeader>
        <CardFrameTitle id="reply-pipeline-settings-title">
          自动回复保护、节奏控制与转人工
        </CardFrameTitle>
        <CardFrameDescription>
          按业务场景设置发送频率上限、短消息合并等待、敏感词拦截与人工接管条件，所有写入仍经唯一安全发送通道。
        </CardFrameDescription>
        <CardFrameAction>
          <Badge variant={statusView?.configured ? 'success' : 'secondary'} size="sm">
            <ShieldCheckIcon />
            {statusView?.configured ? '已启用自定义保护' : '默认保护策略'}
          </Badge>
        </CardFrameAction>
      </CardFrameHeader>

      <Card className="space-y-5 p-5">
        {loading && (
          <p
            role="status"
            className="rounded-xl border border-border/75 bg-muted/40 px-3.5 py-2 text-xs text-muted-foreground"
          >
            正在读取当前保护与节流设置…
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="rounded-xl border border-destructive/30 bg-destructive/6 px-3.5 py-2 text-xs font-medium text-destructive-foreground"
          >
            {error}
          </p>
        )}
        {notice && (
          <p
            role="status"
            className="rounded-xl border border-success/30 bg-success/8 px-3.5 py-2 text-xs font-medium text-success-foreground"
          >
            {notice}
          </p>
        )}

        {/* 1. 写动作节流档位（持久化） */}
        <section className="space-y-3">
          <div className="space-y-0.5">
            <h3 className="font-heading text-[14px] font-semibold text-foreground">
              写动作节流档位（持久化）
            </h3>
            <p className="text-xs leading-relaxed text-muted-foreground">
              控制同一账号自动回复的发送间隔与 5 分钟突发上限，达到上限后自动进入冷却保护，重启后继续生效。
            </p>
          </div>
          <div
            role="radiogroup"
            aria-label="写动作节流档位"
            className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4"
          >
            {RHYTHM_OPTIONS.map(option => {
              const selected = config.rhythmProfile === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={controlsDisabled}
                  onClick={() =>
                    setConfig(prev => ({ ...prev, rhythmProfile: option.value }))
                  }
                  className={`flex cursor-pointer flex-col items-start gap-1 rounded-xl border px-3.5 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55 ${
                    selected
                      ? 'border-primary bg-primary/[0.06] text-foreground'
                      : 'border-border/80 bg-background text-foreground hover:bg-muted/40'
                  }`}
                >
                  <span className="text-[13px] font-semibold">{option.label}</span>
                  <span className="text-[11.5px] text-muted-foreground">{option.detail}</span>
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/75 bg-muted/30 px-3.5 py-2 text-xs text-muted-foreground tabular-nums">
            <span>
              当前节奏状态：<strong className="font-medium text-foreground">{rhythmInfo.statusLabel}</strong>
            </span>
            <span>
              近 5 分钟动作：{rhythmInfo.recentCount} 次 · 累计已记录：{rhythmInfo.totalActions} 次
            </span>
          </div>
        </section>

        {/* 2. 碎片消息静默聚合 */}
        <section className="space-y-3 border-t border-border/75 pt-4">
          <div className="space-y-0.5">
            <h3 className="font-heading text-[14px] font-semibold text-foreground">
              碎片消息静默聚合
            </h3>
            <p className="text-xs leading-relaxed text-muted-foreground">
              客户连续拆句发私信时，先静默等待数秒再合并上下文统一回复，避免逐条零散应答。
            </p>
          </div>
          {renderSwitchRow({
            title: '开启私信短消息静默等待合并',
            description: '等待客户短时间内补充完整问题后再触发回复，建议保持在 2 至 5 秒。',
            checked: config.debounce.enabled,
            disabled: controlsDisabled,
            ariaLabel: '开启私信短消息静默等待合并',
            onChange: enabled =>
              setConfig(prev => ({ ...prev, debounce: { ...prev.debounce, enabled } })),
          })}
          <div className="flex flex-col gap-2.5 rounded-xl border border-border/75 bg-muted/25 p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <label htmlFor="pipeline-debounce-slider" className="font-medium text-foreground">
                静默聚合等待时长
              </label>
              <span className="font-semibold text-foreground tabular-nums">
                {(config.debounce.windowMs / 1000).toFixed(1)} 秒（{config.debounce.windowMs} 毫秒）
              </span>
            </div>
            <input
              id="pipeline-debounce-slider"
              type="range"
              min={2000}
              max={5000}
              step={500}
              aria-label="静默聚合等待时长"
              disabled={controlsDisabled || !config.debounce.enabled}
              value={config.debounce.windowMs}
              onChange={event =>
                setConfig(prev => ({
                  ...prev,
                  debounce: { ...prev.debounce, windowMs: Number(event.target.value) },
                }))
              }
              className="w-full cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
            />
            <div className="flex flex-wrap items-center gap-1.5">
              {DEBOUNCE_PRESETS.map(ms => (
                <button
                  key={ms}
                  type="button"
                  disabled={controlsDisabled || !config.debounce.enabled}
                  onClick={() =>
                    setConfig(prev => ({
                      ...prev,
                      debounce: { ...prev.debounce, windowMs: ms },
                    }))
                  }
                  className={`cursor-pointer rounded-md border px-2 py-0.5 text-[11.5px] tabular-nums transition-colors disabled:pointer-events-none disabled:opacity-50 ${
                    config.debounce.windowMs === ms
                      ? 'border-primary bg-primary/10 font-medium text-primary'
                      : 'border-border/80 bg-background text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {ms / 1000} 秒
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* 3. 敏感词与防复读保护 */}
        <section className="space-y-3 border-t border-border/75 pt-4">
          <div className="space-y-0.5">
            <h3 className="font-heading text-[14px] font-semibold text-foreground">
              敏感词与防复读保护
            </h3>
            <p className="text-xs leading-relaxed text-muted-foreground">
              在调用模型前先行拦截违禁或高风险内容，节省模型额度并防止重复发同一句话。
            </p>
          </div>
          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-3">
            {renderSwitchRow({
              title: '平台红线拦截',
              description: '拦截导流微信号、二维码、私下交易及平台违禁词，命中后转人工处理。',
              checked: config.sensitive.enablePlatformRedline,
              disabled: controlsDisabled,
              ariaLabel: '平台红线拦截',
              onChange: enablePlatformRedline =>
                setConfig(prev => ({
                  ...prev,
                  sensitive: { ...prev.sensitive, enablePlatformRedline },
                })),
            })}
            {renderSwitchRow({
              title: '恶意指令诱导防护',
              description: '识别试图套取提示词或强行改写回复规则的来信并转人工。',
              checked: config.sensitive.enablePromptInjectionGuard,
              disabled: controlsDisabled,
              ariaLabel: '恶意指令诱导防护',
              onChange: enablePromptInjectionGuard =>
                setConfig(prev => ({
                  ...prev,
                  sensitive: { ...prev.sensitive, enablePromptInjectionGuard },
                })),
            })}
            {renderSwitchRow({
              title: '同句防复读保护',
              description: '对比近期已发送回复，避免短时间内对同一客户反复发送雷同内容。',
              checked: config.loopBreaker.enabled,
              disabled: controlsDisabled,
              ariaLabel: '同句防复读保护',
              onChange: enabled =>
                setConfig(prev => ({ ...prev, loopBreaker: { enabled } })),
            })}
          </div>
          {WordTagEditor({
            title: '商家自定义敏感词',
            description: '客户来信或生成草稿命中以下任意词时立即拦截并交由人工处理，不消耗后续发送。',
            placeholder: '输入敏感词后回车或点击添加（例如：竞品名称、绝对化用语）',
            ariaLabel: '添加商家自定义敏感词',
            words: config.sensitive.customWords,
            draftWord: sensitiveDraft,
            localHint: sensitiveHint,
            disabled: controlsDisabled,
            onDraftChange: value => {
              setSensitiveDraft(value);
              if (sensitiveHint) setSensitiveHint('');
            },
            onAdd: () => {
              const word = validateWord(sensitiveDraft, config.sensitive.customWords, setSensitiveHint);
              if (!word) return;
              setSensitiveDraft('');
              setConfig(prev => ({
                ...prev,
                sensitive: {
                  ...prev.sensitive,
                  customWords: [...prev.sensitive.customWords, word],
                },
              }));
            },
            onRemove: word =>
              setConfig(prev => ({
                ...prev,
                sensitive: {
                  ...prev.sensitive,
                  customWords: prev.sensitive.customWords.filter(item => item !== word),
                },
              })),
          })}
        </section>

        {/* 4. 精细转人工独立开关 & 精确直出 */}
        <section className="space-y-3 border-t border-border/75 pt-4">
          <div className="space-y-0.5">
            <h3 className="font-heading text-[14px] font-semibold text-foreground">
              精细转人工与标准问答直出
            </h3>
            <p className="text-xs leading-relaxed text-muted-foreground">
              按业务风险单独控制何时转人工接待；开启标准问答直出可对明确常见问题免调模型直接回复。
            </p>
          </div>
          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
            {renderSwitchRow({
              title: '含图/媒体消息转人工',
              description: '客户发来图片、视频或语音且未启用看图理解时，保留给人工处理。',
              checked: config.handoff.mediaMessageHandoff,
              disabled: controlsDisabled,
              ariaLabel: '含图/媒体消息转人工',
              onChange: mediaMessageHandoff =>
                setConfig(prev => ({
                  ...prev,
                  handoff: { ...prev.handoff, mediaMessageHandoff },
                })),
            })}
            {renderSwitchRow({
              title: '售后/退款/投诉转人工',
              description: '客户提及退换货、退款、质量问题或投诉维权时立即交由人工跟进。',
              checked: config.handoff.afterSalesHandoff,
              disabled: controlsDisabled,
              ariaLabel: '售后/退款/投诉转人工',
              onChange: afterSalesHandoff =>
                setConfig(prev => ({
                  ...prev,
                  handoff: { ...prev.handoff, afterSalesHandoff },
                })),
            })}
            {renderSwitchRow({
              title: '议价/砍价转人工',
              description: '客户询问最低价、打折或要求优惠时暂停自动回复并转人工。',
              checked: config.handoff.bargainHandoff,
              disabled: controlsDisabled,
              ariaLabel: '议价/砍价转人工',
              onChange: bargainHandoff =>
                setConfig(prev => ({
                  ...prev,
                  handoff: { ...prev.handoff, bargainHandoff },
                })),
            })}
            {renderSwitchRow({
              title: '知识未命中转人工',
              description: '知识库中没有找到相关条目时不靠模型猜测，直接转交人工回答。',
              checked: config.handoff.knowledgeMissHandoff,
              disabled: controlsDisabled,
              ariaLabel: '知识未命中转人工',
              onChange: knowledgeMissHandoff =>
                setConfig(prev => ({
                  ...prev,
                  handoff: { ...prev.handoff, knowledgeMissHandoff },
                })),
            })}
            {renderSwitchRow({
              title: '知识冲突转人工',
              description: '检测到同一主题存在多条冲突知识时暂停自动引用，等待人工确认。',
              checked: config.handoff.knowledgeConflictHandoff,
              disabled: controlsDisabled,
              ariaLabel: '知识冲突转人工',
              onChange: knowledgeConflictHandoff =>
                setConfig(prev => ({
                  ...prev,
                  handoff: { ...prev.handoff, knowledgeConflictHandoff },
                })),
            })}
            {renderSwitchRow({
              title: '高置信 FAQ 精确直出',
              description: '精确命中高置信标准问答时免调模型直接回复，仍经过安全核查与唯一发送通道。',
              checked: config.handoff.exactFaqDirectReply,
              disabled: controlsDisabled,
              ariaLabel: '高置信 FAQ 精确直出',
              onChange: exactFaqDirectReply =>
                setConfig(prev => ({
                  ...prev,
                  handoff: { ...prev.handoff, exactFaqDirectReply },
                })),
            })}
          </div>
          {WordTagEditor({
            title: '自定义转人工触发词',
            description: '客户来信包含以下任意词（如“开发票”、“找店长”）时跳过自动回复并转人工。',
            placeholder: '输入触发词后回车或点击添加',
            ariaLabel: '添加自定义转人工触发词',
            words: config.handoff.customTriggers,
            draftWord: triggerDraft,
            localHint: triggerHint,
            disabled: controlsDisabled,
            onDraftChange: value => {
              setTriggerDraft(value);
              if (triggerHint) setTriggerHint('');
            },
            onAdd: () => {
              const word = validateWord(triggerDraft, config.handoff.customTriggers, setTriggerHint);
              if (!word) return;
              setTriggerDraft('');
              setConfig(prev => ({
                ...prev,
                handoff: {
                  ...prev.handoff,
                  customTriggers: [...prev.handoff.customTriggers, word],
                },
              }));
            },
            onRemove: word =>
              setConfig(prev => ({
                ...prev,
                handoff: {
                  ...prev.handoff,
                  customTriggers: prev.handoff.customTriggers.filter(item => item !== word),
                },
              })),
          })}
        </section>

        {/* 5. 近 7 天转人工归因摘要 */}
        {handoffSummary && handoffSummary.total > 0 && (
          <section className="space-y-2.5 border-t border-border/75 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-heading text-[14px] font-semibold text-foreground">
                近 7 天转人工归因摘要
              </h3>
              <span className="text-xs font-medium text-muted-foreground tabular-nums">
                累计转人工 {handoffSummary.total} 次
              </span>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {handoffSummary.byCategory.map(bucket => (
                <div
                  key={bucket.key}
                  className="flex items-center justify-between gap-2 rounded-xl border border-border/75 bg-muted/25 px-3 py-2 text-xs"
                >
                  <span className="font-medium text-foreground">{bucket.label}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {bucket.count} 次（{bucket.percentage}%）
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/75 pt-4">
          <span className="text-xs text-muted-foreground">
            {statusView?.updatedAt
              ? `上次保存：${new Date(statusView.updatedAt).toLocaleString('zh-CN', { hour12: false })}`
              : '尚未保存过自定义保护与节流设置'}
          </span>
          <button
            type="button"
            className={btnPrimaryCls}
            disabled={controlsDisabled}
            onClick={() => void saveConfig()}
          >
            {saving ? '正在保存…' : '保存保护与节流设置'}
          </button>
        </div>
      </Card>
    </CardFrame>
  );
}
