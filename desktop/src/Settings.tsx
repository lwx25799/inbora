import { useEffect, useRef, useState } from 'react';
import { AutomationSettings } from './AutomationSettings';
import { AccountPlatformPanel } from './AccountPlatformPanel';
import { LocalAssistantSettings } from './LocalAssistantSettings';
import { BrowserDraftRecovery } from './BrowserDraftRecovery';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { KnowledgeSettings } from './KnowledgeSettings';
import { ModelProviderSettings } from './ModelProviderSettings';
import {
  request,
  closeDesktop,
  reasons,
  capabilityNames,
  runtimeSession,
  saveBusinessPrompts,
  type BusinessPrompts,
  type Status,
} from './api';
import { explainSafe } from './error-messages';
import { modes } from './presentation';
import { SettingsDialog } from './SettingsDialog';
import { businessPrompts, samePrompts } from './settings-form-sync';

const cardCls = 'settings-section flex flex-col gap-3.5 rounded-2xl border border-border/85 bg-card p-5 text-card-foreground shadow-xs/5';
const headingCls = 'font-heading text-[15px] font-semibold tracking-tight text-foreground';
const hintCls = 'hint text-xs leading-relaxed text-muted-foreground';
const btnOutlineCls = 'inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-input bg-popover px-3 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55 dark:bg-input/32 dark:hover:bg-input/64';
const btnPrimaryCls = 'inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-primary bg-primary px-3 text-xs font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55';
const btnDangerCls = 'danger inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-destructive bg-destructive px-3 text-xs font-medium text-white shadow-xs transition-colors hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55';
const selectCls = 'h-8.5 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-[13px] text-foreground shadow-xs/5 outline-none transition-shadow focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/32';
const textareaCls = 'w-full min-w-0 rounded-lg border border-input bg-background px-3 py-2 text-[13px] leading-relaxed text-foreground shadow-xs/5 outline-none transition-shadow focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/32';
const disclosureCls = 'rounded-xl border border-border/80 bg-muted/30 px-4 py-3 text-[13px]';

export function Settings({
  status,
  runtime,
  busy,
  error = '',
  notice = '',
  act,
  update,
  updateProviders,
  updatePrompts,
  stop,
  toggleAuto,
  pendingAutoReply,
}: {
  status: Status;
  runtime: string;
  busy: string;
  error?: string;
  notice?: string;
  act: (s: string, f: () => Promise<void>) => Promise<void>;
  update: (s: Status) => void;
  updateProviders: (next: Status, previous: Status) => void;
  updatePrompts: (session: string, prompts: BusinessPrompts) => void;
  stop: () => void;
  toggleAuto: (enabled: boolean) => Promise<void>;
  pendingAutoReply: boolean | null;
}) {
  const [settings, setSettings] = useState(() => businessPrompts(status.settings));
  const syncedSettings = useRef(settings);
  const latestSettings = useRef(settings);
  latestSettings.current = settings;
  const settingsKey = JSON.stringify(businessPrompts(status.settings));
  useEffect(() => {
    if (samePrompts(latestSettings.current, syncedSettings.current)) {
      const next = businessPrompts(status.settings);
      syncedSettings.current = next;
      latestSettings.current = next;
      setSettings(next);
    }
  }, [settingsKey]);
  const [promptsOpen, setPromptsOpen] = useState(false);
  const [promptBusy, setPromptBusy] = useState(false);
  const [promptError, setPromptError] = useState('');
  const [promptNotice, setPromptNotice] = useState('');
  const savingPrompts = useRef(false);
  const active = useRef(false);
  const session = runtimeSession(status);
  const canSavePrompts = status.modelProvidersSupported === true;
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  async function savePrompts() {
    if (savingPrompts.current || !canSavePrompts) return;
    savingPrompts.current = true;
    setPromptBusy(true);
    setPromptError('');
    setPromptNotice('');
    const submitted = latestSettings.current;
    try {
      const next = await saveBusinessPrompts(status, submitted);
      if (!active.current || runtimeSession(next) !== session) return;
      const saved = businessPrompts(next.settings);
      syncedSettings.current = saved;
      if (samePrompts(latestSettings.current, submitted)) {
        latestSettings.current = saved;
        setSettings(saved);
      }
      updatePrompts(session, saved);
      setPromptNotice('业务提示词已保存');
    } catch (cause) {
      if (active.current) setPromptError(explainSafe(cause, '业务提示词保存失败。'));
    } finally {
      savingPrompts.current = false;
      if (active.current) setPromptBusy(false);
    }
  }
  const [faultOpen, setFaultOpen] = useState(Boolean(status.automation?.emergencyStopped));
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  useEffect(() => {
    if (status.automation?.emergencyStopped) setFaultOpen(true);
  }, [status.automation?.emergencyStopped]);

  const autoOn = status.configuredMode === 'LIMITED_AUTO' && !!status.automation?.replyPolicy;

  return (
    <section className="settings scroll settings-compact mx-auto flex w-full max-w-[1220px] flex-col gap-5 overflow-y-auto px-6 py-5">
      <div className={`${cardCls} settings-daily border-primary/20 bg-primary/[0.03]`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className={headingCls}>自动回复</h2>
          <label className="check inline-flex cursor-pointer items-center gap-2.5 rounded-lg border border-border/80 bg-card px-3 py-1.5 text-[13px] font-medium text-foreground select-none">
            <input
              type="checkbox"
              role="switch"
              aria-label="设置中的自动回复"
              className="size-4 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-55"
              disabled={pendingAutoReply !== null || !!busy || !status.automation?.replyPolicy}
              checked={pendingAutoReply ?? autoOn}
              onChange={e => {
                const enabled = e.target.checked;
                void act('更新自动回复', () => toggleAuto(enabled));
              }}
            />
            {pendingAutoReply !== null
              ? pendingAutoReply
                ? '正在开启自动回复…'
                : '正在关闭自动回复…'
              : `自动回复：${autoOn ? '开' : '关'}`}
          </label>
        </div>
        <p className={hintCls}>按已保存策略运行。关闭仅暂停自动回复，账号在线、收取和人稿保留。</p>
      </div>

      <div className="settings-columns grid grid-cols-1 items-start gap-5 xl:grid-cols-2">
        <div className="settings-column flex min-w-0 flex-col gap-5">
          {status.automation && (
            <AutomationSettings
              status={status}
              busy={busy}
              error={error}
              notice={notice}
              act={act}
              update={update}
            />
          )}
        </div>

        <div className="settings-column flex min-w-0 flex-col gap-5">
          <ModelProviderSettings status={status} update={updateProviders} />
          <LocalAssistantSettings
            key={`${status.account?.identity ?? 'none'}:${status.localAssistant?.grant?.version ?? 'none'}`}
            status={status}
            busy={busy}
            act={act}
            update={update}
          />

          <div className={cardCls}>
            <h2 className={headingCls}>业务提示词</h2>
            <div className="row flex flex-wrap items-center gap-2">
              <button className={btnOutlineCls} onClick={() => setPromptsOpen(true)}>
                编辑业务提示词
              </button>
            </div>
            <SettingsDialog
              title="业务提示词"
              open={promptsOpen}
              onClose={() => setPromptsOpen(false)}
              busy={promptBusy ? '正在保存业务提示词…' : ''}
              error={promptError}
              notice={promptNotice}
            >
              {(['persona', 'business', 'rules'] as const).map((field, i) => (
                <label key={field} className="flex flex-col gap-1.5 text-xs font-medium text-foreground">
                  {['账号人设', '业务说明', '回复规则'][i]}
                  <textarea
                    rows={field === 'persona' ? 4 : 5}
                    className={textareaCls}
                    value={settings[field]}
                    maxLength={field === 'persona' ? 2000 : 4000}
                    onChange={e =>
                      setSettings(current => ({ ...current, [field]: e.target.value }))
                    }
                  />
                </label>
              ))}
              {!canSavePrompts && (
                <p className={hintCls} role="status">
                  {reasons.BUSINESS_PROMPTS_BACKEND_UPGRADE_REQUIRED}
                </p>
              )}
              <div className="flex items-center justify-end pt-1">
                <button
                  className={btnPrimaryCls}
                  disabled={promptBusy || !canSavePrompts}
                  onClick={savePrompts}
                >
                  保存业务提示词
                </button>
              </div>
            </SettingsDialog>
          </div>

          <div className={cardCls}>
            <h2 className={headingCls}>累计用量</h2>
            <div className="budget grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {status.budgets.map(b => (
                <p
                  key={b.kind}
                  className="flex items-center justify-between gap-2 rounded-xl border border-border/75 bg-muted/35 px-3.5 py-2.5 text-xs text-muted-foreground tabular-nums"
                >
                  <span>{b.kind === 'MODEL' ? '累计模型预占' : '累计发送意图'}</span>
                  <strong className="font-semibold text-foreground">
                    {b.used} / {b.maximum === null ? '无上限' : b.maximum}
                  </strong>
                </p>
              ))}
              <p className="flex items-center justify-between gap-2 rounded-xl border border-border/75 bg-muted/35 px-3.5 py-2.5 text-xs text-muted-foreground tabular-nums sm:col-span-2">
                <span>已记录 Token</span>
                <strong className="font-semibold text-foreground">
                  {status.usage.inputTokens} 输入 / {status.usage.outputTokens} 输出
                </strong>
              </p>
            </div>
            <p className={hintCls}>
              预算上限不代替授权。超时或失败不自动重试，未返回 usage 时不推算 Token。
            </p>
          </div>

          <div className={cardCls}>
            <h2 className={headingCls}>回复模式与运行</h2>
            <label className="flex flex-col gap-1.5 text-xs font-medium text-foreground">
              工作模式
              <select
                className={selectCls}
                value={status.configuredMode}
                onChange={e =>
                  void act('更新模式', async () =>
                    update(
                      await request<Status>({
                        command: 'setMode',
                        mode: e.target.value as Status['mode'],
                      }),
                    ),
                  )
                }
              >
                {Object.entries(modes).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <p className={hintCls}>
              切换模式不会开启未经核验的发送能力；新账号默认仅保存草稿。
            </p>
            {status.mode !== status.configuredMode && (
              <p
                className="hint rounded-xl border border-info/30 bg-info/6 px-3.5 py-2 text-xs text-info-foreground"
                role="status"
              >
                已选择{modes[status.configuredMode]}；正在自动连接账号，连接后即可继续。
              </p>
            )}
            <p className={hintCls}>
              日常默认后台静音运行。可临时打开登录窗口查看页面或处理登录；打开期间后台收取与自动回复暂缓，完成后点击“返回后台静音运行”继续。
            </p>
            <div className="row flex flex-wrap items-center gap-2">
              <button
                className={btnOutlineCls}
                disabled={!!busy || status.browser.state === 'MANUAL_VISIBLE'}
                onClick={() =>
                  void act('打开登录窗口', async () =>
                    update(
                      await request<Status>({
                        command: 'browser',
                        open: true,
                        mode: 'headed',
                        loginRecovery: true,
                        manualVisible: true,
                      }),
                    ),
                  )
                }
              >
                打开登录窗口
              </button>
              {(status.browser.loginRecovery || status.browser.mode === 'headed') && (
                <button
                  className={btnPrimaryCls}
                  disabled={!!busy}
                  onClick={() =>
                    void act('恢复后台静音运行', async () =>
                      update(
                        await request<Status>({ command: 'browser', open: true, mode: 'headless' }),
                      ),
                    )
                  }
                >
                  返回后台静音运行
                </button>
              )}
            </div>

            <details
              className={`fault-controls ${disclosureCls} border-destructive/25 bg-destructive/[0.03]`}
              open={faultOpen}
              onToggle={e => setFaultOpen(e.currentTarget.open)}
            >
              <summary
                className="cursor-pointer font-medium text-[13px] text-foreground select-none"
                onClick={e => {
                  e.preventDefault();
                  setFaultOpen(open => !open);
                }}
              >
                故障处理
              </summary>
              <div className="mt-3 flex flex-col gap-3">
                {faultOpen && <BrowserDraftRecovery busy={busy} act={act} />}
                <p className={hintCls}>
                  仅在需要停止全部后台操作时使用。急停会停止收取、模型和发送；已提交消息不会撤回或重复发送。
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <button className={btnDangerCls} onClick={stop}>
                    全局急停
                  </button>
                  {status.automation?.emergencyStopped && (
                    <button
                      className={btnPrimaryCls}
                      disabled={!!busy}
                      onClick={() =>
                        void act('检查并恢复运行', async () => {
                          if (status.browser.loginRecovery || status.browser.mode === 'headed')
                            update(
                              await request<Status>({
                                command: 'browser',
                                open: true,
                                mode: 'headless',
                              }),
                            );
                          update(await request<Status>({ command: 'resume', eventId: null }));
                        })
                      }
                    >
                      恢复运行
                    </button>
                  )}
                </div>
              </div>
            </details>

            <p className="text-xs text-muted-foreground">
              数据目录：
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11.5px] text-foreground break-all">
                {runtime}
              </code>
            </p>
            <div>
              <button className={btnOutlineCls} onClick={() => void closeDesktop().catch(() => {})}>
                退出工作台并保留数据
              </button>
            </div>
            <p className={hintCls}>
              网络为本机直连。日常采用后台静音运行，平台安全验证优先在客户端内直接操作原后台页面完成；仅遇重新登录等情况时可临时打开登录窗口处理，所有网页自启动即静音。
            </p>

            <details className={`settings-disclosure ${disclosureCls}`}>
              <summary className="cursor-pointer font-medium text-[13px] text-foreground select-none">
                连接详情
              </summary>
              <div className="mt-3 flex flex-col gap-3">
                <dl className="divide-y divide-border/70 rounded-lg border border-border/75 bg-card">
                  {status.capabilities.map(c => (
                    <div
                      key={c.channel}
                      className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs"
                    >
                      <dt className="font-medium text-muted-foreground">
                        {c.channel === 'DIRECT_MESSAGE' ? '私信能力' : '评论能力'}
                      </dt>
                      <dd className="text-foreground">
                        {capabilityNames[c.state] ?? c.state}
                        {c.reason && <> · {reasons[c.reason] ?? c.reason}</>}
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className={hintCls}>
                  通道状态与 AI Key 分别生效；未配置 Key 仍可人工编辑和保存。
                </p>
                <div>
                  <button
                    className={btnOutlineCls}
                    disabled={!!busy}
                    onClick={() =>
                      void act('同步通知', async () => {
                        update(
                          await request<Status>({
                            command: 'observe',
                            source: 'notifications',
                          }),
                        );
                      })
                    }
                  >
                    同步顶部通知（独立来源）
                  </button>
                </div>
              </div>
            </details>
          </div>

          <AccountPlatformPanel status={status} busy={busy} />
        </div>
      </div>

      <KnowledgeSettings
        key={status.account?.id ?? 'unbound'}
        accountId={status.account?.id ?? null}
        disabled={!!busy}
      />

      <details
        className={`settings-diagnostics ${disclosureCls}`}
        open={diagnosticsOpen}
        onToggle={e => setDiagnosticsOpen(e.currentTarget.open)}
      >
        <summary
          className="cursor-pointer font-medium text-[13px] text-foreground select-none"
          onClick={e => {
            e.preventDefault();
            setDiagnosticsOpen(open => !open);
          }}
        >
          运行诊断与用量详情
        </summary>
        {diagnosticsOpen && (
          <div className="mt-3">
            <DiagnosticsPanel />
          </div>
        )}
      </details>
    </section>
  );
}
