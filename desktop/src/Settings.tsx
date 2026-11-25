import { useEffect, useRef, useState } from 'react';
import { AutomationSettings } from './AutomationSettings';
import {LocalAssistantSettings} from './LocalAssistantSettings';
import { BrowserDraftRecovery } from './BrowserDraftRecovery';
import {DiagnosticsPanel} from './DiagnosticsPanel';
import {KnowledgeSettings} from './KnowledgeSettings';
import {ModelProviderSettings} from './ModelProviderSettings';
import { request, closeDesktop, reasons, capabilityNames, runtimeSession, saveBusinessPrompts, type BusinessPrompts, type Status } from './api';
import {explainSafe} from './error-messages';
import { modes } from './presentation';
import {SettingsDialog} from './SettingsDialog';
import {businessPrompts, samePrompts} from './settings-form-sync';
import './settings.css';

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
  stop:()=>void;
  toggleAuto:(enabled:boolean)=>Promise<void>;
  pendingAutoReply:boolean|null;
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
  const [promptsOpen,setPromptsOpen]=useState(false);
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
    } catch (error) {
      if (active.current) setPromptError(explainSafe(error, '业务提示词保存失败。'));
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
  return (
    <section className="settings scroll settings-compact">
      <div className="settings-section settings-daily"><h2>自动回复</h2>
        <label className="check"><input type="checkbox" role="switch" aria-label="设置中的自动回复" disabled={pendingAutoReply!==null||!!busy||!status.automation?.replyPolicy}
          checked={pendingAutoReply??(status.configuredMode==='LIMITED_AUTO'&&!!status.automation?.replyPolicy)} onChange={e=>{const enabled=e.target.checked;void act('更新自动回复',()=>toggleAuto(enabled));}}/>
          {pendingAutoReply!==null?pendingAutoReply?'正在开启自动回复…':'正在关闭自动回复…':`自动回复：${status.configuredMode==='LIMITED_AUTO'&&status.automation?.replyPolicy?'开':'关'}`}</label>
        <p className="hint">按已保存策略运行。关闭仅暂停自动回复，账号在线、收取和人稿保留。</p>
      </div>
      <div className="settings-columns">
        <div className="settings-column">
      {status.automation&&<AutomationSettings status={status} busy={busy} error={error} notice={notice} act={act} update={update}/>}
        </div>
        <div className="settings-column">
      <ModelProviderSettings status={status} update={updateProviders}/>
      <LocalAssistantSettings key={`${status.account?.identity??'none'}:${status.localAssistant?.grant?.version??'none'}`}
        status={status} busy={busy} act={act} update={update}/>
      <div className="settings-section">
        <h2>业务提示词</h2>
        <div className="row"><button onClick={()=>setPromptsOpen(true)}>编辑业务提示词</button></div>
        <SettingsDialog title="业务提示词" open={promptsOpen} onClose={()=>setPromptsOpen(false)}
          busy={promptBusy ? '正在保存业务提示词…' : ''} error={promptError} notice={promptNotice}>
        {(["persona", "business", "rules"] as const).map((field, i) => (
          <label key={field}>
            {["账号人设", "业务说明", "回复规则"][i]}
            <textarea
              value={settings[field]}
              maxLength={field === 'persona' ? 2000 : 4000}
              onChange={(e) =>
                setSettings((current) => ({ ...current, [field]: e.target.value }))
              }
            />
          </label>
        ))}
        {!canSavePrompts && <p className="hint" role="status">{reasons.BUSINESS_PROMPTS_BACKEND_UPGRADE_REQUIRED}</p>}
        <button disabled={promptBusy || !canSavePrompts} onClick={savePrompts}>保存业务提示词</button>
        </SettingsDialog>
      </div>
      <div className="settings-section">
        <h2>累计用量</h2>
        <div className="budget">
          {status.budgets.map((b) => (
            <p key={b.kind}>
              {b.kind === "MODEL" ? "累计模型预占" : "累计发送意图"}{" "}
              <strong>
                {b.used} / {b.maximum===null?'无上限':b.maximum}
              </strong>
            </p>
          ))}
          <p>
            已记录 Token{" "}
            <strong>
              {status.usage.inputTokens} 输入 / {status.usage.outputTokens} 输出
            </strong>
          </p>
        </div>
        <p className="hint">
          预算上限不代替授权。超时或失败不自动重试，未返回 usage 时不推算
          Token。
        </p>
      </div>
      <div className="settings-section">
        <h2>回复模式与运行</h2>
        <label>
          工作模式
          <select
            value={status.configuredMode}
            onChange={(e) =>
              void act("更新模式", async () =>
                update(
                  await request<Status>({
                    command: "setMode",
                    mode: e.target.value as Status["mode"],
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
        <p className="hint">
          切换模式不会开启未经核验的发送能力；新账号默认仅保存草稿。
        </p>
        {status.mode !== status.configuredMode && (
          <p className="hint" role="status">
            已选择{modes[status.configuredMode]}；正在自动连接账号，连接后即可继续。
          </p>
        )}
        <p className="hint">日常默认无头运行。可临时打开有头浏览器查看页面或处理登录；打开期间后台收取与自动回复暂缓，完成后点击“返回无头运行”继续。</p>
        <div className="row">
          <button
            disabled={!!busy||status.browser.state==='MANUAL_VISIBLE'}
            onClick={() =>
              void act("打开有头浏览器", async () =>
                update(
                  await request<Status>({
                    command: "browser",
                    open: true,
                    mode: 'headed',
                    loginRecovery:true,
                    manualVisible:true,
                  }),
                ),
              )
            }
          >
            打开有头浏览器
          </button>
          {(status.browser.loginRecovery||status.browser.mode==='headed')&&<button disabled={!!busy} onClick={()=>void act('恢复无头运行',async()=>update(
            await request<Status>({command:'browser',open:true,mode:'headless'})))}>返回无头运行</button>}
        </div>
        <details className="fault-controls" open={faultOpen} onToggle={e=>setFaultOpen(e.currentTarget.open)}>
          <summary onClick={e=>{e.preventDefault();setFaultOpen(open=>!open);}}>故障处理</summary>
          {faultOpen&&<BrowserDraftRecovery busy={busy} act={act}/>}
          <p className="hint">仅在需要停止全部后台操作时使用。急停会停止收取、模型和发送；已提交消息不会撤回或重复发送。</p>
          <button className="danger" onClick={stop}>全局急停</button>
          {status.automation?.emergencyStopped&&<button disabled={!!busy}
            onClick={() =>
              void act("检查并恢复运行", async () => {
                if(status.browser.loginRecovery||status.browser.mode==='headed')
                  update(await request<Status>({command:'browser',open:true,mode:'headless'}));
                update(await request<Status>({command:'resume',eventId:null}));
              })
            }
          >
            恢复运行
          </button>}
        </details>
        <p>
          数据目录：<code>{runtime}</code>
        </p>
        <button onClick={() => void closeDesktop().catch(() => {})}>
          退出工作台并保留数据
        </button>
        <p className="hint">
          网络为本机直连。日常采用无头运行，平台安全验证优先在客户端内直接操作原无头页面完成；仅遇重新登录等情况时可临时打开有头浏览器处理，所有网页自启动即静音。
        </p>
        <details><summary>连接详情</summary><dl>
          {status.capabilities.map((c) => (
            <div key={c.channel}>
              <dt>
                {c.channel === "DIRECT_MESSAGE" ? "私信能力" : "评论能力"}
              </dt>
              <dd>
                {capabilityNames[c.state] ?? c.state}
                {c.reason && <> · {reasons[c.reason] ?? c.reason}</>}
              </dd>
            </div>
          ))}
        </dl>
        <p className="hint">通道状态与 AI Key 分别生效；未配置 Key 仍可人工编辑和保存。</p>
        <button
          disabled={!!busy}
          onClick={() =>
            void act("同步通知", async () => {
              update(
                await request<Status>({
                  command: "observe",
                  source: "notifications",
                }),
              );
            })
          }
        >
          同步顶部通知（独立来源）
        </button>
        </details>
      </div>
        </div>
      </div>
      <KnowledgeSettings key={status.account?.id??'unbound'} accountId={status.account?.id??null} disabled={!!busy}/>
      <details className="settings-diagnostics" open={diagnosticsOpen} onToggle={e=>setDiagnosticsOpen(e.currentTarget.open)}>
        <summary onClick={e=>{e.preventDefault();setDiagnosticsOpen(open=>!open);}}>运行诊断与用量详情</summary>
        {diagnosticsOpen&&<DiagnosticsPanel/>}
      </details>
    </section>
  );
}
