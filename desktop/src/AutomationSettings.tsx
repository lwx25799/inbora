import { useEffect, useRef, useState } from 'react';
import { request, reasons, type Status } from './api';
import type { ReplyPolicy } from '../../src/contracts/automation.js';
import {
  collectionSnapshot,
  policySnapshot,
  policySyncKey,
  sameCollectionForm,
  samePolicyForm,
  type CollectionForm,
  type PolicyForm,
} from './settings-form-sync';
import { SettingsDialog } from './SettingsDialog';

const cardCls = 'settings-section settings-automation flex flex-col gap-4 rounded-2xl border border-border/85 bg-card p-5 text-card-foreground shadow-xs/5';
const headingCls = 'font-heading text-[15px] font-semibold tracking-tight text-foreground';
const subHeadingCls = 'settings-subtitle border-t border-border/75 pt-4 font-heading text-[14px] font-semibold text-foreground';
const hintCls = 'hint text-xs leading-relaxed text-muted-foreground';
const labelCls = 'flex flex-col gap-1.5 text-xs font-medium text-foreground';
const checkLabelCls = 'check inline-flex cursor-pointer items-start gap-2 text-[13px] text-foreground select-none';
const checkInputCls = 'mt-0.5 size-4 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-55';
const inputCls = 'h-8.5 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-[13px] text-foreground tabular-nums shadow-xs/5 outline-none transition-shadow focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/32';
const textareaCls = 'w-full min-w-0 rounded-lg border border-input bg-background px-3 py-2 text-[13px] leading-relaxed text-foreground shadow-xs/5 outline-none transition-shadow focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/32';
const btnOutlineCls = 'inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-input bg-popover px-3 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55 dark:bg-input/32 dark:hover:bg-input/64';
const btnPrimaryCls = 'primary inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-primary bg-primary px-3 text-xs font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55';
const disclosureCls = 'settings-disclosure rounded-xl border border-border/80 bg-muted/30 px-4 py-3 text-[13px]';

export function AutomationSettings({
  status,
  busy,
  error = '',
  notice = '',
  act,
  update,
}: {
  status: Status;
  busy: string;
  error?: string;
  notice?: string;
  act: (label: string, fn: () => Promise<void>) => Promise<void>;
  update: (s: Status) => void;
}) {
  const state = status.automation!;
  const [collection, setCollection] = useState<CollectionForm>(() => collectionSnapshot(status));
  const syncedCollection = useRef(collection),
    latestCollection = useRef(collection);
  latestCollection.current = collection;
  const collectionKey = JSON.stringify(state.collection ?? null);
  useEffect(() => {
    const next = collectionSnapshot(status);
    if (sameCollectionForm(latestCollection.current, syncedCollection.current)) {
      syncedCollection.current = next;
      latestCollection.current = next;
      setCollection(next);
    }
  }, [collectionKey]);

  const [policyForm, setPolicyForm] = useState<PolicyForm>(() => policySnapshot(status));
  const syncedPolicy = useRef(policyForm),
    latestPolicy = useRef(policyForm);
  latestPolicy.current = policyForm;
  const policyKey = policySyncKey(status);
  useEffect(() => {
    const next = policySnapshot(status);
    if (samePolicyForm(latestPolicy.current, syncedPolicy.current)) {
      syncedPolicy.current = next;
      latestPolicy.current = next;
      setPolicyForm(next);
    }
  }, [policyKey]);

  const applyCollectionResponse = (submitted: CollectionForm, next: Status) => {
    const snap = collectionSnapshot(next);
    syncedCollection.current = snap;
    if (sameCollectionForm(latestCollection.current, submitted)) {
      latestCollection.current = snap;
      setCollection(snap);
    }
    update(next);
  };
  const applyPolicyResponse = (submitted: PolicyForm, next: Status) => {
    const snap = policySnapshot(next);
    syncedPolicy.current = snap;
    if (samePolicyForm(latestPolicy.current, submitted)) {
      latestPolicy.current = snap;
      setPolicyForm(snap);
    }
    update(next);
  };

  const [ruleOpen, setRuleOpen] = useState(false);
  const { comments, inbox, commentSeconds, dmSeconds } = collection;
  const {
    commentReply,
    dmReply,
    replyToNestedComments,
    workIds,
    conversations,
    future,
    entireInbox,
    excludes,
    instructions,
    modelLimit,
    sendLimit,
    startHour,
    endHour,
    unlimitedModel,
    unlimitedSend,
  } = policyForm;
  const setCollectionField = <K extends keyof CollectionForm>(field: K, value: CollectionForm[K]) =>
    setCollection(current => ({ ...current, [field]: value }));
  const setPolicyField = <K extends keyof PolicyForm>(field: K, value: PolicyForm[K]) =>
    setPolicyForm(current => ({ ...current, [field]: value }));
  const ownId = status.account?.identity ?? '';
  const list = (s: string) => s.split(/[,，\n]/u).map(s => s.trim()).filter(Boolean);
  const channels: ReplyPolicy['channels'] = [
    ...(commentReply ? (['COMMENT_NOTIFICATION'] as const) : []),
    ...(dmReply ? (['DIRECT_MESSAGE'] as const) : []),
  ];
  const targetsValid =
    (!commentReply || future || list(workIds).length > 0) &&
    (!dmReply || entireInbox || list(conversations).length > 0);

  return (
    <div className={cardCls}>
      <div className="space-y-1">
        <h2 className={headingCls}>后台收取与持续授权</h2>
        <p className="text-xs text-muted-foreground">
          绑定本人账号：
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11.5px] text-foreground">
            {ownId || '等待账号核验'}
          </code>
        </p>
        <p className={hintCls}>
          收取起点：{new Date(state.startedAt).toLocaleString('zh-CN', { hour12: false })}
          。本号此后新作品自动纳入，停机新增恢复后补查；收取独立于 AI。
        </p>
      </div>

      <div className="flex flex-col gap-2.5 rounded-xl border border-border/75 bg-muted/30 p-3.5">
        <label className={checkLabelCls}>
          <input
            type="checkbox"
            className={checkInputCls}
            checked={comments}
            onChange={e => setCollectionField('comments', e.target.checked)}
          />
          收取本号新视频评论，并保留原已纳入作品
        </label>
        <label className={checkLabelCls}>
          <input
            type="checkbox"
            className={checkInputCls}
            checked={inbox}
            onChange={e => setCollectionField('inbox', e.target.checked)}
          />
          收取本账号私信收件箱的新消息及新会话
        </label>
      </div>

      <details className={disclosureCls}>
        <summary className="cursor-pointer font-medium text-[13px] text-foreground select-none">
          轮询参数 · 评论 {commentSeconds} 秒 / 私信 {dmSeconds} 秒
        </summary>
        <div className="policy-fields mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className={labelCls}>
            评论轮询秒数
            <input
              type="number"
              min="15"
              max="3600"
              className={inputCls}
              value={commentSeconds}
              onChange={e => setCollectionField('commentSeconds', Number(e.target.value))}
            />
          </label>
          <label className={labelCls}>
            私信轮询秒数
            <input
              type="number"
              min="15"
              max="3600"
              className={inputCls}
              value={dmSeconds}
              onChange={e => setCollectionField('dmSeconds', Number(e.target.value))}
            />
          </label>
        </div>
      </details>

      <div>
        <button
          className={btnOutlineCls}
          disabled={!ownId || !!busy}
          onClick={() =>
            void act('保存收取范围', async () => {
              const submitted = latestCollection.current;
              const next = await request<Status>({
                command: 'configureCollection',
                settings: {
                  ownId,
                  comments: submitted.comments,
                  inbox: submitted.inbox,
                  commentIntervalMs: submitted.commentSeconds * 1000,
                  dmIntervalMs: submitted.dmSeconds * 1000,
                },
              });
              applyCollectionResponse(submitted, next);
            })
          }
        >
          保存收取范围
        </button>
      </div>

      {state.emergencyStopped && (
        <p className="error rounded-xl border border-destructive/30 bg-destructive/6 px-3.5 py-2.5 text-xs font-medium text-destructive-foreground">
          当前全局急停，保存范围不会恢复调度。请使用页面上方的“检查并恢复运行”。
        </p>
      )}
      {state.collector.channels.length > 0 && (
        <div className="flex flex-col gap-1 rounded-xl border border-border/70 bg-muted/25 px-3.5 py-2.5">
          {state.collector.channels.map(c => (
            <p className={`${hintCls} tabular-nums`} key={c.source}>
              {c.source === 'dm' ? '私信' : '评论'}：
              {state.collector.running && state.collector.source === c.source
                ? '读取中'
                : c.last_success
                  ? '最近成功 ' + new Date(c.last_success).toLocaleTimeString('zh-CN')
                  : '尚无成功轮次'}
              {c.elapsed_ms !== null ? ' · ' + c.elapsed_ms + 'ms' : ''}
              {c.last_error ? ' · ' + c.last_error : ''}
            </p>
          ))}
        </div>
      )}

      <h3 className={subHeadingCls}>模型与自动回复范围</h3>
      <div className="settings-options flex flex-wrap gap-x-5 gap-y-2.5 rounded-xl border border-border/75 bg-muted/30 p-3.5">
        <label className={checkLabelCls}>
          <input
            type="checkbox"
            className={checkInputCls}
            checked={commentReply}
            onChange={e => setPolicyField('commentReply', e.target.checked)}
          />
          评论通道
        </label>
        <label className={checkLabelCls}>
          <input
            type="checkbox"
            className={checkInputCls}
            checked={dmReply}
            onChange={e => setPolicyField('dmReply', e.target.checked)}
          />
          私信通道
        </label>
        <label className={checkLabelCls}>
          <input
            type="checkbox"
            className={checkInputCls}
            checked={replyToNestedComments}
            onChange={e => setPolicyField('replyToNestedComments', e.target.checked)}
          />
          自动回复楼中楼评论
        </label>
      </div>
      <p className={hintCls}>
        关闭楼中楼自动回复仍保留收取和人工回复，不影响一级评论及私信；保存规则后生效。
      </p>

      <div className="policy-fields grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        <div className="flex flex-col gap-2 rounded-xl border border-border/80 bg-background p-3.5">
          <label className={labelCls}>
            本次持续授权的模型次数
            <input
              type="number"
              min="1"
              className={inputCls}
              disabled={unlimitedModel}
              value={modelLimit}
              onChange={e => setPolicyField('modelLimit', Number(e.target.value))}
            />
          </label>
          <label className={checkLabelCls}>
            <input
              type="checkbox"
              className={checkInputCls}
              checked={unlimitedModel}
              onChange={e => setPolicyField('unlimitedModel', e.target.checked)}
            />
            模型次数无上限
          </label>
        </div>
        <div className="flex flex-col gap-2 rounded-xl border border-border/80 bg-background p-3.5">
          <label className={labelCls}>
            本次持续授权的发送次数
            <input
              type="number"
              min="1"
              className={inputCls}
              disabled={unlimitedSend}
              value={sendLimit}
              onChange={e => setPolicyField('sendLimit', Number(e.target.value))}
            />
          </label>
          <label className={checkLabelCls}>
            <input
              type="checkbox"
              className={checkInputCls}
              checked={unlimitedSend}
              onChange={e => setPolicyField('unlimitedSend', e.target.checked)}
            />
            发送次数无上限
          </label>
        </div>
      </div>

      <p className={`${hintCls} tabular-nums`}>
        累计额度：
        {status.budgets
          .map(b => `${b.kind} ${b.used}/${b.maximum === null ? '无上限' : b.maximum}`)
          .join(' · ')}
        。保存后生效，已用次数不重置；改回有限额度时扣除已用次数，重启保留。
      </p>
      <p className={hintCls}>
        保存 API Key 后，请在当前模型区应用连接修订。没有有效授权时，请启用模型授权或保存自动回复策略。累计额度继续沿用。
      </p>

      <details className={disclosureCls}>
        <summary className="cursor-pointer font-medium text-[13px] text-foreground select-none">
          仅生成 AI 建议（可选）
        </summary>
        <div className="mt-3 flex flex-col gap-2.5">
          <p className={hintCls}>
            用于人工编辑时生成建议。下方规则自动回复已包含模型调用许可，无需先启用此项。
          </p>
          <div className="row flex flex-wrap items-center gap-2">
            <button
              className={btnOutlineCls}
              disabled={!ownId || !channels.length || !!busy}
              onClick={() =>
                void act('启用持续模型授权', async () => {
                  const submitted = latestPolicy.current;
                  const next = await request<Status>({
                    command: 'setModelGrant',
                    scope: {
                      ownId,
                      channels,
                      model: status.settings.model,
                      modelLimit: submitted.unlimitedModel ? null : submitted.modelLimit,
                      expiresAt: null,
                    },
                    confirmed: true,
                  });
                  applyPolicyResponse(submitted, next);
                })
              }
            >
              仅启用模型授权
            </button>
            <button
              className={btnOutlineCls}
              disabled={!state.modelGrant || !!busy}
              onClick={() =>
                void act('撤销模型授权', async () => {
                  const submitted = latestPolicy.current;
                  const next = await request<Status>({
                    command: 'setModelGrant',
                    scope: null,
                    confirmed: true,
                  });
                  applyPolicyResponse(submitted, next);
                })
              }
            >
              撤销模型授权
            </button>
          </div>
        </div>
      </details>

      <div className="policy-targets grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        <div className="flex flex-col gap-2 rounded-xl border border-border/80 bg-background p-3.5">
          <label className={labelCls}>
            允许回复的作品原生 ID（逗号或换行分隔）
            <textarea
              rows={3}
              className={textareaCls}
              value={workIds}
              onChange={e => setPolicyField('workIds', e.target.value)}
            />
          </label>
          <label className={checkLabelCls}>
            <input
              type="checkbox"
              className={checkInputCls}
              checked={future}
              onChange={e => setPolicyField('future', e.target.checked)}
            />
            回复策略覆盖本号运行起点后所有新视频
          </label>
        </div>
        <div className="flex flex-col gap-2 rounded-xl border border-border/80 bg-background p-3.5">
          <label className={labelCls}>
            允许回复的私信原生会话 ID
            <textarea
              rows={3}
              className={textareaCls}
              value={conversations}
              onChange={e => setPolicyField('conversations', e.target.value)}
            />
          </label>
          <label className={checkLabelCls}>
            <input
              type="checkbox"
              className={checkInputCls}
              checked={entireInbox}
              onChange={e => setPolicyField('entireInbox', e.target.checked)}
            />
            回复策略覆盖本账号已启用收件箱内的新会话
          </label>
        </div>
      </div>

      <p className={hintCls}>
        开启后回复范围内全部新评论和私信，AI根据每条原文及必要上下文生成回复，不需要触发词。
      </p>

      <label className={labelCls}>
        屏蔽词（命中后不自动回复）
        <input
          className={inputCls}
          value={excludes}
          onChange={e => setPolicyField('excludes', e.target.value)}
        />
      </label>

      <div className="settings-rule-summary flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/80 bg-muted/35 p-3.5">
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="text-[13px] font-semibold text-foreground">自动回复规则</h3>
          <p className={`${hintCls} truncate`}>
            {instructions.trim()
              ? `${[...instructions].length} 字 · ${instructions.replace(/\s+/gu, ' ').slice(0, 64)}`
              : '尚未填写规则'}
          </p>
        </div>
        <button className={btnOutlineCls} onClick={() => setRuleOpen(true)}>
          编辑自动回复规则
        </button>
      </div>

      <SettingsDialog
        title="编辑自动回复规则"
        open={ruleOpen}
        onClose={() => setRuleOpen(false)}
        busy={busy}
        error={error}
        notice={notice}
      >
        <p className={hintCls}>关闭保留输入。回到页面保存启用范围后，规则才生效。</p>
        <label className={`settings-rule ${labelCls}`}>
          自动回复规则
          <textarea
            rows={8}
            className={textareaCls}
            value={instructions}
            onChange={e => setPolicyField('instructions', e.target.value)}
          />
        </label>
        <div className="flex justify-end pt-1">
          <button className={btnPrimaryCls} onClick={() => setRuleOpen(false)}>
            完成编辑
          </button>
        </div>
      </SettingsDialog>

      <div className="policy-fields grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className={labelCls}>
          每日开始小时（北京时间）
          <input
            type="number"
            min="0"
            max="23"
            className={inputCls}
            value={startHour}
            onChange={e => setPolicyField('startHour', Number(e.target.value))}
          />
        </label>
        <label className={labelCls}>
          每日结束小时
          <input
            type="number"
            min="1"
            max="24"
            className={inputCls}
            value={endHour}
            onChange={e => setPolicyField('endHour', Number(e.target.value))}
          />
        </label>
      </div>

      <p className={hintCls}>
        一次启用即允许范围内模型调用与发送，并恢复普通发送暂停。人工接管、历史基线、我方消息、未知冻结和范围外任务均不自动外发；全局急停须先显式恢复。失败的模型调用不自动重试。
      </p>
      {!targetsValid && (
        <p className="hint rounded-xl border border-warning/35 bg-warning/8 px-3.5 py-2 text-xs text-warning-foreground">
          请为每个已选通道填写作品或会话 ID，或选择对应的新视频／收件箱覆盖范围；空范围不会自动回复。
        </p>
      )}

      <div className="row flex flex-wrap items-center gap-2 pt-1">
        <button
          className={btnPrimaryCls}
          disabled={!ownId || !channels.length || !targetsValid || !instructions.trim() || !!busy}
          onClick={() =>
            void act('启用规则自动回复', async () => {
              const submitted = latestPolicy.current;
              const policy: ReplyPolicy = {
                ownId,
                channels,
                replyToNestedComments: submitted.replyToNestedComments,
                model: status.settings.model,
                modelLimit: submitted.unlimitedModel ? null : submitted.modelLimit,
                sendLimit: submitted.unlimitedSend ? null : submitted.sendLimit,
                expiresAt: null,
                workIds: list(submitted.workIds),
                futureOwnWorks: submitted.future,
                conversationIds: list(submitted.conversations),
                entireInbox: submitted.entireInbox,
                containsAny: [],
                excludesAny: list(submitted.excludes),
                instructions: submitted.instructions,
                startHour: submitted.startHour,
                endHour: submitted.endHour,
              };
              const next = await request<Status>({
                command: 'enableReplyPolicy',
                policy,
                confirmed: true,
              });
              applyPolicyResponse(submitted, next);
            })
          }
        >
          按此范围启用规则自动回复
        </button>
        <button
          className={btnOutlineCls}
          disabled={!state.replyPolicy || !!busy}
          onClick={() =>
            void act('撤销自动回复策略', async () => {
              const submitted = latestPolicy.current;
              const next = await request<Status>({
                command: 'setReplyPolicy',
                policy: null,
                confirmed: true,
              });
              applyPolicyResponse(submitted, next);
            })
          }
        >
          撤销自动回复策略
        </button>
      </div>

      <p className="rounded-xl border border-border/75 bg-muted/30 px-3.5 py-2 text-xs font-medium text-foreground tabular-nums">
        自动回复（含模型调用）：{state.replyPolicy ? '策略版本 ' + state.replyPolicy.version : '关闭'}
        {' · '}人工 AI 建议：{state.modelGrant ? '授权版本 ' + state.modelGrant.version : '关闭'}
      </p>
      {state.autoStopReason && (
        <p className="hint rounded-xl border border-warning/35 bg-warning/8 px-3.5 py-2 text-xs text-warning-foreground">
          自动回复等待：{reasons[state.autoStopReason] ?? state.autoStopReason}
        </p>
      )}
      {state.unresolvedSends?.map(item => (
        <p
          className="hint rounded-xl border border-warning/35 bg-warning/8 px-3.5 py-2 text-xs text-warning-foreground"
          key={item.channel}
        >
          {item.count} 条{item.channel === 'DIRECT_MESSAGE' ? '私信' : '评论'}
          发送结果仍不明确，原记录保留且禁止重发。后续已核验的独立新消息继续处理；尚在发送或无法区分新旧时暂缓。
        </p>
      ))}
    </div>
  );
}
