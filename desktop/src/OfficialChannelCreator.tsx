import { useLayoutEffect, useRef, useState } from 'react';
import {
  accountRegistrationUnconfirmed,
  configureOfficialChannelV2,
  registerOfficialAccountV2,
  WECHAT_KF_PLATFORM_ID,
  WECOM_AIBOT_PLATFORM_ID,
  type ChannelCredentialStorage,
  type ConfigureOfficialChannelCommand,
  type OfficialApiPlatformId,
} from './api';
import { explainSafe } from './error-messages';

const labelCls = 'flex flex-col gap-1.5 text-xs font-medium text-foreground';
const hintCls = 'hint text-xs leading-relaxed text-muted-foreground';
const inputCls = 'h-8.5 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-[13px] text-foreground shadow-xs/5 outline-none transition-shadow placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/32';
const btnOutlineCls = 'inline-flex h-8 shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-lg border border-input bg-popover px-3 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55 dark:bg-input/32 dark:hover:bg-input/64';
const btnPrimaryCls = 'inline-flex h-8 shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-lg border border-primary bg-primary px-3 text-xs font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55';

export interface OfficialChannelCreatorProps {
  disabled: boolean;
  onRegistered: (notice: string, accountRef: string) => Promise<void>;
  onClose: () => void;
}

export function OfficialChannelCreator({
  disabled,
  onRegistered,
  onClose,
}: OfficialChannelCreatorProps) {
  const [platform, setPlatform] = useState<OfficialApiPlatformId>(WECOM_AIBOT_PLATFORM_ID);
  const [displayLabel, setDisplayLabel] = useState('');
  const [botId, setBotId] = useState('');
  const [wecomSecret, setWecomSecret] = useState('');
  const [wsUrl, setWsUrl] = useState('');
  const [allowGroupMessages, setAllowGroupMessages] = useState(true);
  const [corpId, setCorpId] = useState('');
  const [openKfId, setOpenKfId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [webhookToken, setWebhookToken] = useState('');
  const [encodingAESKey, setEncodingAESKey] = useState('');
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [storage, setStorage] = useState<ChannelCredentialStorage>('DPAPI');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  // Preserve commandId across unconfirmed registration retries so retries reuse the same deterministic accountRef.
  const pendingRegisterRef = useRef<{ key: string; commandId: string } | null>(null);
  const mounted = useRef(true);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  function clearSecrets() {
    setWecomSecret('');
    setAppSecret('');
    setWebhookToken('');
    setEncodingAESKey('');
  }

  function switchPlatform(next: OfficialApiPlatformId) {
    if (next === platform) return;
    setPlatform(next);
    clearSecrets();
    pendingRegisterRef.current = null;
    setError('');
  }

  function closePanel() {
    clearSecrets();
    pendingRegisterRef.current = null;
    onClose();
  }

  const isWecom = platform === WECOM_AIBOT_PLATFORM_ID;
  const canSubmit = !disabled && !submitting && (isWecom
    ? Boolean(botId.trim() && wecomSecret.trim())
    : Boolean(corpId.trim() && openKfId.trim() && appSecret.trim()));

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');
    const ownId = isWecom ? botId.trim() : openKfId.trim();
    const label = displayLabel.trim() || (isWecom ? `企微机器人 ${ownId}` : `微信客服 ${ownId}`);
    const registrationKey = JSON.stringify([platform, ownId, label]);
    const registerCommandId = pendingRegisterRef.current?.key === registrationKey
      ? pendingRegisterRef.current.commandId
      : crypto.randomUUID();
    pendingRegisterRef.current = { key: registrationKey, commandId: registerCommandId };

    let registeredRef: string | null = null;
    try {
      const account = await registerOfficialAccountV2({
        commandId: registerCommandId,
        platform,
        ownId,
        displayLabel: label,
      });
      registeredRef = account.accountRef;
      pendingRegisterRef.current = null;

      const configCommand: ConfigureOfficialChannelCommand = isWecom
        ? {
          command: 'accounts',
          action: 'configureOfficialChannel',
          commandId: crypto.randomUUID(),
          accountRef: account.accountRef,
          platform: WECOM_AIBOT_PLATFORM_ID,
          botId: ownId,
          wsUrl: wsUrl.trim() || null,
          allowGroupMessages,
          credentialMode: 'SET',
          storage,
          secret: wecomSecret.trim(),
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
          credentialMode: 'SET',
          storage,
          appSecret: appSecret.trim(),
          ...(webhookToken.trim() ? { token: webhookToken.trim() } : {}),
          ...(encodingAESKey.trim() ? { encodingAESKey: encodingAESKey.trim() } : {}),
        };
      await configureOfficialChannelV2(configCommand);
      if (mounted.current) {
        clearSecrets();
        setDisplayLabel('');
        setBotId('');
        setCorpId('');
        setOpenKfId('');
        setWsUrl('');
        setApiBaseUrl('');
        await onRegistered(
          `已接入${isWecom ? '企业微信智能机器人' : '微信客服'}「${label}」，新账号默认关闭自动回复。点击“管理接入”可发起连接。`,
          account.accountRef,
        );
      }
    } catch (cause) {
      if (registeredRef) {
        if (mounted.current) {
          clearSecrets();
          await onRegistered(
            `账号「${label}」已注册，但凭据保存未完成：${explainSafe(cause, '请打开“管理接入”补充保存。')}`,
            registeredRef,
          );
        }
      } else {
        if (!accountRegistrationUnconfirmed(cause)) pendingRegisterRef.current = null;
        if (mounted.current) {
          setError(
            accountRegistrationUnconfirmed(cause)
              ? '注册结果尚未确认。可直接再次点击“添加并保存配置”安全重试同一次注册。'
              : explainSafe(cause, '接入官方渠道失败，请核对参数后重试。'),
          );
        }
      }
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3.5 rounded-xl border border-primary/25 bg-primary/[0.03] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-[13.5px] font-semibold text-foreground">接入官方渠道</h3>
          <p className={hintCls}>直接通过官方协议接入，不启动额外浏览器窗口；密钥仅存本机受保护凭据或后端内存。</p>
        </div>
        <button type="button" className={btnOutlineCls} disabled={submitting} onClick={closePanel}>
          收起
        </button>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="选择官方渠道平台">
        <button
          type="button"
          className={`flex cursor-pointer flex-col items-start gap-0.5 rounded-xl border px-3.5 py-2.5 text-left transition-colors ${
            isWecom
              ? 'border-primary bg-primary/8 text-foreground'
              : 'border-border/80 bg-background text-muted-foreground hover:border-input hover:text-foreground'
          }`}
          disabled={submitting}
          onClick={() => switchPlatform(WECOM_AIBOT_PLATFORM_ID)}
        >
          <span className="text-xs font-semibold text-foreground">企业微信智能机器人</span>
          <span className="text-[11px] text-muted-foreground">官方 WSS 长连接，免公网域名与回调服务器</span>
        </button>
        <button
          type="button"
          className={`flex cursor-pointer flex-col items-start gap-0.5 rounded-xl border px-3.5 py-2.5 text-left transition-colors ${
            !isWecom
              ? 'border-primary bg-primary/8 text-foreground'
              : 'border-border/80 bg-background text-muted-foreground hover:border-input hover:text-foreground'
          }`}
          disabled={submitting}
          onClick={() => switchPlatform(WECHAT_KF_PLATFORM_ID)}
        >
          <span className="text-xs font-semibold text-foreground">微信客服</span>
          <span className="text-[11px] text-muted-foreground">官方 HTTPS 接口，支持游标同步与 48 小时回复窗口</span>
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className={labelCls}>
          展示名称（可选）
          <input
            type="text"
            className={inputCls}
            value={displayLabel}
            maxLength={128}
            placeholder={isWecom ? '如：售前企微机器人' : '如：官方售后客服'}
            disabled={submitting}
            onChange={event => setDisplayLabel(event.target.value)}
          />
        </label>
        <label className={labelCls}>
          密钥存储方式
          <select
            className={inputCls}
            value={storage}
            disabled={submitting}
            onChange={event => setStorage(event.target.value as ChannelCredentialStorage)}
          >
            <option value="DPAPI">本机加密保存（推荐，重启保留）</option>
            <option value="MEMORY">仅保存在内存（退出后清除）</option>
          </select>
        </label>
      </div>

      {isWecom ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={labelCls}>
              机器人 ID（BotID）
              <input
                type="text"
                className={`${inputCls} font-mono text-xs`}
                value={botId}
                maxLength={128}
                placeholder="企微后台智能机器人 BotID"
                disabled={submitting}
                onChange={event => { setBotId(event.target.value); pendingRegisterRef.current = null; }}
              />
            </label>
            <label className={labelCls}>
              机器人 Secret
              <input
                type="password"
                autoComplete="off"
                className={inputCls}
                value={wecomSecret}
                maxLength={4000}
                placeholder="输入机器人 Secret"
                disabled={submitting}
                onChange={event => setWecomSecret(event.target.value)}
              />
            </label>
          </div>
          <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-foreground">
            <input
              type="checkbox"
              checked={allowGroupMessages}
              disabled={submitting}
              onChange={event => setAllowGroupMessages(event.target.checked)}
            />
            允许接收群聊 @机器人 消息
          </label>
          <details className="rounded-lg border border-border/70 bg-background/70 px-3 py-2">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground select-none hover:text-foreground">
              高级端点设置（可选，默认直连企业微信官方地址）
            </summary>
            <div className="mt-2.5">
              <label className={labelCls}>
                自定义 WSS 端点
                <input
                  type="text"
                  className={`${inputCls} font-mono text-xs`}
                  value={wsUrl}
                  maxLength={2048}
                  placeholder="默认 wss://openws.work.weixin.qq.com"
                  disabled={submitting}
                  onChange={event => setWsUrl(event.target.value)}
                />
              </label>
            </div>
          </details>
        </>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={labelCls}>
              企业 ID（CorpID）
              <input
                type="text"
                className={`${inputCls} font-mono text-xs`}
                value={corpId}
                maxLength={128}
                placeholder="如 ww1234567890abcdef"
                disabled={submitting}
                onChange={event => setCorpId(event.target.value)}
              />
            </label>
            <label className={labelCls}>
              客服账号 ID（OpenKfID）
              <input
                type="text"
                className={`${inputCls} font-mono text-xs`}
                value={openKfId}
                maxLength={128}
                placeholder="如 wkxxxxxxxxxxxxxxxx"
                disabled={submitting}
                onChange={event => { setOpenKfId(event.target.value); pendingRegisterRef.current = null; }}
              />
            </label>
          </div>
          <label className={labelCls}>
            微信客服应用 Secret
            <input
              type="password"
              autoComplete="off"
              className={inputCls}
              value={appSecret}
              maxLength={4000}
              placeholder="输入微信客服应用 Secret"
              disabled={submitting}
              onChange={event => setAppSecret(event.target.value)}
            />
          </label>
          <details className="rounded-lg border border-border/70 bg-background/70 px-3 py-2">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground select-none hover:text-foreground">
              回调验签与高级端点（可选）
            </summary>
            <div className="mt-2.5 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className={labelCls}>
                回调 Token（可选）
                <input
                  type="password"
                  autoComplete="off"
                  className={inputCls}
                  value={webhookToken}
                  maxLength={4000}
                  placeholder="与 EncodingAESKey 成对填写"
                  disabled={submitting}
                  onChange={event => setWebhookToken(event.target.value)}
                />
              </label>
              <label className={labelCls}>
                回调 EncodingAESKey（可选）
                <input
                  type="password"
                  autoComplete="off"
                  className={inputCls}
                  value={encodingAESKey}
                  maxLength={4000}
                  placeholder="43 位 Base64 密钥"
                  disabled={submitting}
                  onChange={event => setEncodingAESKey(event.target.value)}
                />
              </label>
              <label className={`${labelCls} sm:col-span-2`}>
                自定义 API Base URL（可选）
                <input
                  type="text"
                  className={`${inputCls} font-mono text-xs`}
                  value={apiBaseUrl}
                  maxLength={2048}
                  placeholder="默认 https://qyapi.weixin.qq.com/cgi-bin"
                  disabled={submitting}
                  onChange={event => setApiBaseUrl(event.target.value)}
                />
              </label>
            </div>
          </details>
        </>
      )}

      {error && (
        <p className="hint rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-2 text-xs font-medium text-destructive-foreground" role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={btnPrimaryCls}
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {submitting ? '正在注册并保存…' : '添加并保存配置'}
        </button>
        <span className={hintCls}>保存后不会自动对外发送，需手动连接并配置回复策略。</span>
      </div>
    </div>
  );
}
