import { useState } from 'react';
import { AutomationSettings } from './AutomationSettings';
import { request, closeDesktop, reasons, capabilityNames, type Status } from './api';
import { modes } from './presentation';

export function Settings({
  status,
  runtime,
  busy,
  act,
  update,
  stop,
}: {
  status: Status;
  runtime: string;
  busy: string;
  act: (s: string, f: () => Promise<void>) => Promise<void>;
  update: (s: Status) => void;
  stop:()=>void;
}) {
  const [settings, setSettings] = useState(status.settings),
    [key, setKey] = useState("");
  return (
    <section className="settings scroll">
      {status.automation&&<AutomationSettings status={status} busy={busy} act={act} update={update}/>}
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
        <p className="hint">日常收取与回复均使用无头浏览器，正常重启自动恢复。仅需登录或验证码时打开可见窗口，核对本人登录后自动恢复无头运行。</p>
        <div className="row">
          <button
            disabled={!!busy}
            onClick={() =>
              void act("处理登录或验证码", async () =>
                update(
                  await request<Status>({
                    command: "browser",
                    open: true,
                    mode: 'headed',
                    loginRecovery:true,
                  }),
                ),
              )
            }
          >
            登录或处理验证码
          </button>
          {status.browser.loginRecovery&&<button disabled={!!busy} onClick={()=>void act('恢复无头运行',async()=>update(
            await request<Status>({command:'browser',open:true,mode:'headless'})))}>返回无头运行</button>}
        </div>
        <details className="fault-controls"><summary>故障处理</summary>
          <p className="hint">仅在需要停止全部后台操作时使用。急停会停止收取、模型和发送；已提交消息不会撤回或重复发送。</p>
          <button className="danger" onClick={stop}>全局急停</button>
          {status.automation?.emergencyStopped&&<button
            onClick={() =>
              void act("更新账号暂停", async () =>
                update(
                  await request<Status>({
                    command: 'resume',
                    eventId: null,
                  }),
                ),
              )
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
          网络为本机直连。登录和验证码在正常可见浏览器中由本人处理，所有网页自启动即静音。
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
      <div className="settings-section">
        <h2>DeepSeek 辅助回复</h2>
        <p>
          手工建议与规则自动回复分别受已启用授权约束。Key 默认只留后端内存，普通配置保存保留现有 Key 与持续授权。
        </p>
        <label>
          模型
          <input
            value={settings.model}
            onChange={(e) =>
              setSettings({ ...settings, model: e.target.value })
            }
          />
        </label>
        <small>官方接口：https://api.deepseek.com/chat/completions</small>
        {(["persona", "business", "rules"] as const).map((field, i) => (
          <label key={field}>
            {["账号人设", "业务说明", "回复规则"][i]}
            <textarea
              value={settings[field]}
              onChange={(e) =>
                setSettings({ ...settings, [field]: e.target.value })
              }
            />
          </label>
        ))}
        <label>
          本次 API Key
          <input
            type="password"
            value={key}
            autoComplete="off"
            onChange={(e) => setKey(e.target.value)}
            placeholder={
              status.keyPresent
                ? "已持有 Key，留空保存可保留"
                : "不填写也可人工回复"
            }
          />
        </label>
        <button
          disabled={!!busy}
          onClick={() =>
            void act("保存 AI 配置", async () => {
              const submitted = key;
              setKey("");
              update(
                await request<Status>({
                  command: "configureAi",
                  settings,
                  key: submitted,
                }),
              );
            })
          }
        >
          保存配置并清空 Key 输入
        </button>
        <p>
          模型：{status.modelAuthorized ? "持续授权有效" : "未授权"} · Key：
          {status.keyPresent ? status.keyStored?'当前用户 DPAPI 安全保存':'仅后端内存持有' : "未配置"}
        </p>
        <label className="check"><input type="checkbox" checked={!!status.keyStored} disabled={!status.keyPresent||!!busy}
          onChange={e=>void act('更新安全保存',async()=>update(await request<Status>({command:'setKeyStorage',storage:e.target.checked?'DPAPI':'MEMORY'})))}/>
          在本机安全保存 Key（Windows 当前用户 DPAPI，默认关闭）</label>
        {status.keyStorageError&&<p className="error">{reasons[status.keyStorageError]??status.keyStorageError}</p>}
        <button disabled={!status.keyPresent&&!status.keyStored&&!status.keyStorageError} onClick={()=>void act('删除 Key',async()=>update(await request<Status>({command:'setKeyStorage',storage:'DELETE'})))}>删除已保存 Key 并清除内存</button>
        <div className="budget">
          {status.budgets.map((b) => (
            <p key={b.kind}>
              {b.kind === "MODEL" ? "累计模型预占" : "累计发送意图"}{" "}
              <strong>
                {b.used} / {b.maximum}
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
    </section>
  );
}
