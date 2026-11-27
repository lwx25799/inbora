import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  configureOfficialChannelV2,
  connectOfficialChannelV2,
  disconnectOfficialChannelV2,
  getOfficialChannelConfigV2,
  observeOfficialAccountV2,
  WECHAT_KF_PLATFORM_ID,
  WECOM_AIBOT_PLATFORM_ID,
  type AccountSummary,
  type ChannelCredentialStorage,
  type ConfigureOfficialChannelCommand,
  type OfficialChannelPublicConfig,
} from './api';
import { explainSafe } from './error-messages';
import { compactTime } from './presentation';

export { OfficialChannelCreator, type OfficialChannelCreatorProps } from './OfficialChannelCreator';

const labelCls = 'flex flex-col gap-1.5 text-xs font-medium text-foreground';
const hintCls = 'hint text-xs leading-relaxed text-muted-foreground';
const inputCls = 'h-8.5 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-[13px] text-foreground shadow-xs/5 outline-none transition-shadow placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/32';
const btnOutlineCls = 'inline-flex h-8 shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-lg border border-input bg-popover px-3 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55 dark:bg-input/32 dark:hover:bg-input/64';
const btnPrimaryCls = 'inline-flex h-8 shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-lg border border-primary bg-primary px-3 text-xs font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55';
const btnDangerCls = 'danger inline-flex h-8 shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-lg border border-destructive/35 bg-destructive/8 px-3 text-xs font-medium text-destructive-foreground shadow-xs/5 transition-colors hover:bg-destructive/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55';

const transportStateNames: Record<string, string> = {
  CONNECTED: '已连接',
  CONNECTING: '连接中',
  DEGRADED: '连接降级',
  ERROR: '连接异常',
  DISCONNECTED: '未连接',
};

function credentialSummary(config: OfficialChannelPublicConfig): string {
  if (config.credentialError) return '本机加密凭据无法读取，请重新保存';
  if (!config.secretConfigured) return '尚未保存密钥凭据';
  if (config.credentialStorage === 'DPAPI') return '本机加密保存（重启保留）';
  if (config.credentialStorage === 'MEMORY') return '仅本次会话有效（退出清除）';
  return '尚未保存密钥凭据';
}

export interface OfficialChannelManagerPanelProps {
  account: AccountSummary;
  disabled: boolean;
  emergencyStopped: boolean;
  onUpdated: () => Promise<void>;
  onOpenWorkbench?: (() => void) | undefined;
}

export function OfficialChannelManagerPanel({
  account,
  disabled,
  emergencyStopped,
  onUpdated,
  onOpenWorkbench,
}: OfficialChannelManagerPanelProps) {
  const [config, setConfig] = useState<OfficialChannelPublicConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState<string>('');
  const [editing, setEditing] = useState(false);
  const [confirmClearSecret, setConfirmClearSecret] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [botId, setBotId] = useState(account.ownId ?? '');
  const [wsUrl, setWsUrl] = useState('');
  const [allowGroupMessages, setAllowGroupMessages] = useState(true);
  const [corpId, setCorpId] = useState('');
  const [openKfId, setOpenKfId] = useState(account.ownId ?? '');
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [storage, setStorage] = useState<ChannelCredentialStorage>('DPAPI');
  const [newSecret, setNewSecret] = useState('');
  const [newToken, setNewToken] = useState('');
  const [newAesKey, setNewAesKey] = useState('');
  const mounted = useRef(true);

  function clearSecretInputs() {
    setNewSecret('');
    setNewToken('');
    setNewAesKey('');
  }

  const hydrate = useCallback((next: OfficialChannelPublicConfig) => {
    setConfig(next);
    setStorage(next.credentialStorage === 'MEMORY' ? 'MEMORY' : 'DPAPI');
    if (next.platform === WECOM_AIBOT_PLATFORM_ID) {
      setBotId(next.botId);
      setWsUrl(next.wsUrl ?? '');
      setAllowGroupMessages(next.allowGroupMessages);
    } else {
      setCorpId(next.corpId);
      setOpenKfId(next.openKfId);
      setApiBaseUrl(next.apiBaseUrl ?? '');
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const next = await getOfficialChannelConfigV2(account.accountRef);
      if (mounted.current) hydrate(next);
    } catch (cause) {
      if (mounted.current) setError(explainSafe(cause, '暂时无法读取渠道配置。'));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [account.accountRef, hydrate]);

  useLayoutEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; };
  }, [refresh]);

  const runAction = async (label: string, work: () => Promise<void>) => {
    setActionBusy(label);
    setError('');
    setNotice('');
    setConfirmClearSecret(false);
    try {
      await work();
    } catch (cause) {
      if (mounted.current) setError(explainSafe(cause, `${label}失败，请核对配置后重试。`));
    } finally {
      if (mounted.current) setActionBusy('');
    }
  };

  const isWecom = account.platform === WECOM_AIBOT_PLATFORM_ID;
  const busyNow = disabled || loading || Boolean(actionBusy);
  const stateCode = config?.transportStatus?.state ?? (config?.connected ? 'CONNECTED' : 'DISCONNECTED');
  const identityLocked = Boolean(account.ownId);
  const corpLocked = Boolean(config && config.platform === WECHAT_KF_PLATFORM_ID && config.corpId);

  function toggleEditor(nextOpen: boolean) {
    if (!nextOpen) clearSecretInputs();
    setEditing(nextOpen);
    setConfirmClearSecret(false);
  }

  async function saveUpdate(credentialMode: 'KEEP' | 'SET' | 'DELETE') {
    await runAction(credentialMode === 'DELETE' ? '清空凭据' : '保存配置', async () => {
      const payload: ConfigureOfficialChannelCommand = isWecom
        ? {
          command: 'accounts',
          action: 'configureOfficialChannel',
          commandId: crypto.randomUUID(),
          accountRef: account.accountRef,
          platform: WECOM_AIBOT_PLATFORM_ID,
          botId: botId.trim(),
          wsUrl: wsUrl.trim() || null,
          allowGroupMessages,
          credentialMode,
          ...(credentialMode !== 'DELETE' ? { storage } : {}),
          ...(credentialMode === 'SET' ? { secret: newSecret.trim() } : {}),
        }
        : {
          command: 'accounts',
          action: 'configureOfficialChannel',
          commandId: crypto.randomUUID(),
          accountRef: account.accountRef,
          platform: WECHAT_KF_PLATFORM_ID,
          corpId: corpId.trim(),
          openKfId: openKfId.trim(),
          apiBaseUrl: apiBaseUrl.trim() || null,
          credentialMode,
          ...(credentialMode !== 'DELETE' ? { storage } : {}),
          ...(credentialMode === 'SET'
            ? {
              appSecret: newSecret.trim(),
              ...(newToken.trim() ? { token: newToken.trim() } : {}),
              ...(newAesKey.trim() ? { encodingAESKey: newAesKey.trim() } : {}),
            }
            : {}),
        };
      const updated = await configureOfficialChannelV2(payload);
      if (mounted.current) {
        hydrate(updated);
        clearSecretInputs();
        setEditing(false);
        setNotice(credentialMode === 'DELETE' ? '已清空本地保存的密钥凭据。' : '渠道配置已更新。');
        await onUpdated();
      }
    });
  }

  return (
    <div className="mt-1.5 flex flex-col gap-3 rounded-xl border border-border/80 bg-muted/25 p-3.5">
      {loading && !config ? (
        <p className={hintCls} role="status">正在读取渠道接入状态…</p>
      ) : config ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium ${
                config.connected
                  ? 'bg-success/12 text-success-foreground'
                  : stateCode === 'ERROR'
                    ? 'bg-destructive/12 text-destructive-foreground'
                    : 'bg-muted text-muted-foreground'
              }`}>
                {transportStateNames[stateCode] ?? stateCode}
              </span>
              <span className="text-muted-foreground">{credentialSummary(config)}</span>
            </div>
            <button type="button" className={btnOutlineCls} disabled={busyNow} onClick={() => void refresh()}>
              刷新状态
            </button>
          </div>

          <div className="grid grid-cols-1 gap-1 text-xs text-muted-foreground sm:grid-cols-2">
            {config.platform === WECOM_AIBOT_PLATFORM_ID ? (
              <>
                <span>BotID：<code className="font-mono text-[11px] text-foreground">{config.botId || '未填写'}</code></span>
                <span>群聊消息：{config.allowGroupMessages ? '允许接收' : '仅单聊'}</span>
              </>
            ) : (
              <>
                <span>CorpID：<code className="font-mono text-[11px] text-foreground">{config.corpId || '未填写'}</code></span>
                <span>OpenKfID：<code className="font-mono text-[11px] text-foreground">{config.openKfId || '未填写'}</code></span>
              </>
            )}
            {config.transportStatus?.lastHeartbeatAt && (
              <span>最近心跳：{compactTime(new Date(config.transportStatus.lastHeartbeatAt).toISOString())}</span>
            )}
            {config.transportStatus?.lastSyncAt && (
              <span>最近同步：{compactTime(new Date(config.transportStatus.lastSyncAt).toISOString())}</span>
            )}
          </div>

          {config.transportStatus?.errorCode && (
            <p className="hint rounded-lg border border-warning/35 bg-warning/8 px-2.5 py-1.5 text-xs text-warning-foreground">
              最近通道提示：{explainSafe(config.transportStatus.errorCode, '通道出现异常，请核对配置或稍后重试。')}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {!config.connected ? (
              <button
                type="button"
                className={btnPrimaryCls}
                disabled={busyNow || !config.secretConfigured || emergencyStopped}
                onClick={() => void runAction('连接通道', async () => {
                  const next = await connectOfficialChannelV2(account.accountRef);
                  if (mounted.current) {
                    hydrate(next);
                    if (next.connected) {
                      setNotice('官方渠道已建立连接。');
                    } else {
                      setError('通道尚未进入已连接状态，请核对凭据和网络后重试。');
                    }
                    await onUpdated();
                  }
                })}
              >
                {actionBusy === '连接通道' ? '正在连接…' : '连接通道'}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className={btnPrimaryCls}
                  disabled={busyNow || emergencyStopped}
                  onClick={() => void runAction('拉取消息', async () => {
                    await observeOfficialAccountV2(account.accountRef);
                    const next = await getOfficialChannelConfigV2(account.accountRef);
                    if (mounted.current) {
                      hydrate(next);
                      setNotice('已完成一次消息拉取。');
                    }
                  })}
                >
                  {actionBusy === '拉取消息' ? '正在拉取…' : '立即拉取消息'}
                </button>
                <button
                  type="button"
                  className={btnOutlineCls}
                  disabled={busyNow}
                  onClick={() => void runAction('断开连接', async () => {
                    const next = await disconnectOfficialChannelV2(account.accountRef);
                    if (mounted.current) {
                      hydrate(next);
                      setNotice('已断开渠道连接，本地配置与历史记录保留。');
                      await onUpdated();
                    }
                  })}
                >
                  {actionBusy === '断开连接' ? '正在断开…' : '断开连接'}
                </button>
              </>
            )}
            {onOpenWorkbench && (
              <button type="button" className={btnOutlineCls} disabled={busyNow} onClick={onOpenWorkbench}>
                进入工作台查看会话
              </button>
            )}
            <button
              type="button"
              className={btnOutlineCls}
              disabled={busyNow}
              onClick={() => toggleEditor(!editing)}
            >
              {editing ? '收起配置' : '修改配置与凭据'}
            </button>
            {config.secretConfigured && !confirmClearSecret && (
              <button
                type="button"
                className={btnOutlineCls}
                disabled={busyNow}
                onClick={() => setConfirmClearSecret(true)}
              >
                清空凭据
              </button>
            )}
          </div>

          {confirmClearSecret && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs">
              <span className="text-muted-foreground">确认清空本机保存的密钥？清空后会断开连接，需重新填入方可再次连接。</span>
              <div className="flex items-center gap-2">
                <button type="button" className={btnDangerCls} disabled={busyNow} onClick={() => void saveUpdate('DELETE')}>
                  确认清空
                </button>
                <button type="button" className={btnOutlineCls} onClick={() => setConfirmClearSecret(false)}>
                  取消
                </button>
              </div>
            </div>
          )}

          {editing && (
            <div className="flex flex-col gap-3 rounded-lg border border-border/80 bg-background p-3">
              {identityLocked && (
                <p className={hintCls}>已绑定的官方身份标识不可原地修改，避免历史会话串号；如需切换其他机器人或客服号，请新增独立接入。</p>
              )}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {isWecom ? (
                  <>
                    <label className={labelCls}>
                      机器人 ID（BotID）
                      <input type="text" className={`${inputCls} font-mono text-xs`} value={botId}
                        disabled={busyNow || identityLocked} onChange={event => setBotId(event.target.value)} />
                    </label>
                    <label className={labelCls}>
                      自定义 WSS 端点（可选）
                      <input type="text" className={`${inputCls} font-mono text-xs`} value={wsUrl} disabled={busyNow}
                        placeholder="留空使用默认官方地址" onChange={event => setWsUrl(event.target.value)} />
                    </label>
                  </>
                ) : (
                  <>
                    <label className={labelCls}>
                      企业 ID（CorpID）
                      <input type="text" className={`${inputCls} font-mono text-xs`} value={corpId}
                        disabled={busyNow || corpLocked} onChange={event => setCorpId(event.target.value)} />
                    </label>
                    <label className={labelCls}>
                      客服账号 ID（OpenKfID）
                      <input type="text" className={`${inputCls} font-mono text-xs`} value={openKfId}
                        disabled={busyNow || identityLocked} onChange={event => setOpenKfId(event.target.value)} />
                    </label>
                    <label className={`${labelCls} sm:col-span-2`}>
                      自定义 API Base URL（可选）
                      <input type="text" className={`${inputCls} font-mono text-xs`} value={apiBaseUrl} disabled={busyNow}
                        placeholder="留空使用默认官方地址" onChange={event => setApiBaseUrl(event.target.value)} />
                    </label>
                  </>
                )}
                <label className={labelCls}>
                  {isWecom ? '更新机器人 Secret（留空则保留现有）' : '更新应用 Secret（留空则保留现有）'}
                  <input
                    type="password"
                    autoComplete="off"
                    className={inputCls}
                    value={newSecret}
                    disabled={busyNow}
                    placeholder="仅在更换密钥时填写"
                    onChange={event => {
                      const next = event.target.value;
                      setNewSecret(next);
                      if (!next.trim()) {
                        setNewToken('');
                        setNewAesKey('');
                      }
                    }}
                  />
                </label>
                <label className={labelCls}>
                  密钥存储方式
                  <select className={inputCls} value={storage} disabled={busyNow}
                    onChange={event => setStorage(event.target.value as ChannelCredentialStorage)}>
                    <option value="DPAPI">本机加密保存（推荐，重启保留）</option>
                    <option value="MEMORY">仅保存在内存（退出后清除）</option>
                  </select>
                </label>
                {!isWecom && newSecret.trim() && (
                  <>
                    <label className={labelCls}>
                      回调 Token（可选）
                      <input type="password" autoComplete="off" className={inputCls} value={newToken} disabled={busyNow}
                        onChange={event => setNewToken(event.target.value)} />
                    </label>
                    <label className={labelCls}>
                      回调 EncodingAESKey（可选）
                      <input type="password" autoComplete="off" className={inputCls} value={newAesKey} disabled={busyNow}
                        onChange={event => setNewAesKey(event.target.value)} />
                    </label>
                  </>
                )}
              </div>
              {isWecom && (
                <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-foreground">
                  <input type="checkbox" checked={allowGroupMessages} disabled={busyNow}
                    onChange={event => setAllowGroupMessages(event.target.checked)} />
                  允许接收群聊 @机器人 消息
                </label>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={btnPrimaryCls}
                  disabled={busyNow || (isWecom ? !botId.trim() : !corpId.trim() || !openKfId.trim())}
                  onClick={() => void saveUpdate(newSecret.trim() ? 'SET' : 'KEEP')}
                >
                  保存更改
                </button>
                <button type="button" className={btnOutlineCls} onClick={() => toggleEditor(false)}>
                  取消
                </button>
              </div>
            </div>
          )}
        </>
      ) : null}

      {error && (
        <p className="hint rounded-lg border border-destructive/30 bg-destructive/6 px-2.5 py-1.5 text-xs font-medium text-destructive-foreground" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="hint rounded-lg border border-success/30 bg-success/8 px-2.5 py-1.5 text-xs font-medium text-success-foreground" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}
