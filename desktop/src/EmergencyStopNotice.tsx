import { useEffect, useState } from 'react';
import { MonitorIcon, OctagonAlertIcon, ShieldAlertIcon } from 'lucide-react';
import { request, type Status } from './api';
import type { ManualRecoverySession, ManualRecoveryStart } from '../../src/contracts/manual-recovery.js';
import { SecurityRecoveryDialog } from './SecurityRecoveryDialog';
import { recoveryError } from './security-recovery-input';

const stopReasons: Record<string, string> = {
  MANUAL_EMERGENCY_STOP: '你已手动停止全部后台操作。',
  OBSERVATION_PAGE_BLOCKED: '页面安全检查未通过，当时的记录未区分具体阻断条件。',
  OBSERVATION_UNEXPECTED_ORIGIN: '浏览器页面来源与已授权网站不一致。',
  UNEXPECTED_ORIGIN: '浏览器页面来源与已授权网站不一致。',
  OBSERVATION_SECURITY_TITLE: '旧记录仅命中了页面标题，尚不能确认发生了安全验证。',
  OBSERVATION_SECURITY_COMPONENT: '旧记录命中了候选安全组件，缺少足以确认验证生效的现场证明。',
  OBSERVATION_SECURITY_SUSPECT: '页面安全状态待核验，尚未确认发生了安全验证。',
  SECURITY_VERIFICATION_CONFIRMED: '平台已明确要求本人完成安全验证。',
  CHALLENGE_REQUIRED: '平台要求本人完成安全验证。',
  LOGIN_REQUIRED: '平台要求重新登录。',
  PLATFORM_STOP: '平台要求停止操作。',
  OBSERVATION_ACCOUNT_CHANGED: '浏览器账号与绑定账号不一致。',
  ACCOUNT_CHANGED: '浏览器账号与绑定账号不一致。',
  OWN_WORKS_ACCOUNT_CHANGED: '作品页面账号与绑定账号不一致。',
  NATIVE_REPLY_ACCOUNT_CHANGED: '私信页面账号与绑定账号不一致。',
  COMMENT_REPLY_ACCOUNT_CHANGED: '评论页面账号与绑定账号不一致。',
  ACCOUNT_NOT_VERIFIED: '当前账号身份未通过核验。',
  OWNER_LOCKED_OR_PORT_UNAVAILABLE: '专属浏览器被占用或连接不可用。',
  OWNER_PORT_RESERVED: '本机独占锁端口被系统保留或拒绝绑定，请检查端口策略或稍后重试。',
  NATIVE_REPLY_PAGE_BLOCKED: '私信页面的登录或安全检查未通过。',
  COMMENT_REPLY_PAGE_BLOCKED: '评论页面的登录或安全检查未通过。',
};

const stopSources: Record<string, string> = {
  MANUAL: '手动急停',
  COLLECTION_COMMENTS: '评论后台收取',
  COLLECTION_DM: '私信后台收取',
  VERIFICATION: '已提交消息的后台核验',
  CONNECTION: '账号连接',
  AUTOMATIC_REPLY: '自动回复',
  UNKNOWN: '未记录来源',
};

const primaryButtonClass =
  'primary inline-flex h-7.5 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-primary bg-primary px-3 text-xs font-medium text-primary-foreground shadow-xs shadow-primary/20 transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-55';

const outlineButtonClass =
  'inline-flex h-7.5 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-input bg-card px-3 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-55 dark:bg-input/32 dark:hover:bg-input/55';

export function EmergencyStopNotice({
  status,
  busy,
  act,
  update,
  onRecoveryActiveChange,
}: {
  status: Status;
  busy: string;
  act: (label: string, run: () => Promise<void>) => Promise<void>;
  update: (status: Status) => void;
  onRecoveryActiveChange?: (active: boolean) => void;
}) {
  const [session, setSession] = useState<ManualRecoverySession | null>(null);
  const [startingRecovery, setStartingRecovery] = useState(false);
  const [openingError, setOpeningError] = useState('');
  const holds = status.securityHolds ?? [];
  const stopped = status.automation?.emergencyStopped;
  const recovery = status.browser.loginRecovery || status.browser.mode === 'headed';

  useEffect(() => {
    onRecoveryActiveChange?.(startingRecovery || Boolean(session));
  }, [startingRecovery, session, onRecoveryActiveChange]);

  useEffect(() => () => onRecoveryActiveChange?.(false), [onRecoveryActiveChange]);

  const resume = async () => {
    if (recovery) update(await request<Status>({ command: 'browser', open: true, mode: 'headless' }));
    update(await request<Status>({ command: 'resume', eventId: null }));
  };

  const openLogin = () =>
    act('打开登录处理', async () =>
      update(
        await request<Status>({
          command: 'browser',
          open: true,
          mode: 'headed',
          loginRecovery: true,
          manualVisible: true,
        }),
      ),
    );

  const openOriginal = (channel: ManualRecoverySession['channel']) => {
    setStartingRecovery(true);
    onRecoveryActiveChange?.(true);
    return act('正在接管原验证页面…', async () => {
      setOpeningError('');
      try {
        const result = await request<ManualRecoveryStart>({ command: 'securityRecovery', action: 'start', channel });
        if ('state' in result) update(await request<Status>({ command: 'getStatus' }));
        else setSession(result);
      } catch (error) {
        setOpeningError(recoveryError(error));
      } finally {
        setStartingRecovery(false);
      }
    });
  };

  const recoveryHelp =
    '在客户端内处理当前无头验证页面。若原现场已丢失，点击处理会重新检查原授权地址：已正常则恢复对应通道，仍有验证则显示新的实时画面；原现场证据仍单独保留。';

  const originalButtons = holds.map((hold, index) => (
    <button
      key={hold.revision}
      type="button"
      className={!stopped && index === 0 ? primaryButtonClass : outlineButtonClass}
      disabled={!!busy || !!session || !!recovery}
      onClick={() => void openOriginal(hold.channel)}
    >
      {holds.length > 1 ? `${hold.channel === 'DIRECT_MESSAGE' ? '私信' : '评论'}：` : ''}处理原验证页面
    </button>
  ));

  let notice = null;

  if (!stopped && !holds.length && recovery) {
    notice = (
      <section
        className="emergency-stop-notice headed-mode-notice shrink-0 border-b border-warning/30 bg-warning/10 px-6 py-2 text-foreground max-[1050px]:px-4"
        aria-label="有头浏览器运行提示"
        aria-live="polite"
      >
        <div className="headed-mode-bar flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <MonitorIcon aria-hidden="true" className="size-4 shrink-0 text-warning" />
            <strong className="text-xs font-semibold text-foreground">
              当前处于有头窗口，后台收取与自动回复已暂停
            </strong>
          </div>
          <button
            type="button"
            className={primaryButtonClass}
            disabled={!!busy}
            onClick={() =>
              void act('返回无头运行', async () =>
                update(await request<Status>({ command: 'browser', open: true, mode: 'headless' })),
              )
            }
          >
            返回无头运行
          </button>
        </div>
      </section>
    );
  }

  if (!stopped && holds.length) {
    notice = (
      <section
        className="emergency-stop-notice shrink-0 space-y-1.5 border-b border-warning/35 bg-warning/10 px-6 py-3 text-[13px] text-foreground max-[1050px]:px-4"
        aria-label="通道安全状态待核验"
        aria-live="polite"
      >
        <div className="emergency-stop-heading flex flex-wrap items-center gap-2">
          <ShieldAlertIcon aria-hidden="true" className="size-4 shrink-0 text-warning" />
          <strong className="font-heading text-sm font-semibold text-warning-foreground">页面安全状态待核验</strong>
        </div>
        <p className="text-xs leading-relaxed text-foreground">
          后台正在检查原页面；受影响通道的收取、模型和发送暂停，已有草稿可继续保存。
        </p>
        {holds.map(hold => (
          <p key={hold.revision} className="text-xs text-foreground tabular-nums">
            {hold.channel === 'DIRECT_MESSAGE' ? '私信' : '评论'}通道 ·{' '}
            {new Date(hold.heldAt).toLocaleString('zh-CN', { hour12: false })}
            <span className="emergency-stop-meta text-muted-foreground">
              {' '}
              · 现场编号：
              <code className="rounded bg-card/85 px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                {hold.incidentId}
              </code>
            </span>
          </p>
        ))}
        <p className="emergency-stop-help text-xs leading-relaxed text-muted-foreground">{recoveryHelp}</p>
        {openingError && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-1.5 text-xs text-destructive-foreground"
          >
            {openingError}
          </p>
        )}
        <div className="row flex flex-wrap items-center gap-2 pt-1">
          {recovery ? (
            <button
              type="button"
              className={primaryButtonClass}
              disabled={!!busy}
              onClick={() => void act('检查并恢复运行', resume)}
            >
              返回无头并检查恢复
            </button>
          ) : (
            <>
              {originalButtons}
              <button
                type="button"
                className={outlineButtonClass}
                disabled={!!busy || !!session}
                onClick={() => void act('检查并恢复运行', resume)}
              >
                检查并恢复运行
              </button>
            </>
          )}
        </div>
      </section>
    );
  }

  if (stopped) {
    const incident = status.automation!.emergencyStop;
    const legacy = !incident || incident.legacy;
    const reason = incident ? stopReasons[incident.reason] : undefined;
    notice = (
      <section
        className="emergency-stop-notice shrink-0 space-y-1.5 border-b border-destructive/35 bg-destructive/8 px-6 py-3 text-[13px] text-foreground dark:bg-destructive/14 max-[1050px]:px-4"
        aria-label="全局急停原因与处理"
        aria-live="polite"
      >
        <div className="emergency-stop-heading flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <div className="flex items-center gap-2">
            <OctagonAlertIcon aria-hidden="true" className="size-4 shrink-0 text-destructive" />
            <strong className="font-heading text-sm font-semibold text-destructive-foreground">
              全局急停，等待恢复
            </strong>
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">
            {incident?.stoppedAt
              ? new Date(incident.stoppedAt).toLocaleString('zh-CN', { hour12: false })
              : '旧版本未记录急停时间'}
          </span>
        </div>
        <p className="text-xs leading-relaxed text-foreground">
          {legacy ? '旧版本未独立记录本次急停原因。' : reason ?? '后台检查未通过，已停止全部调度。'}
        </p>
        {legacy && reason && <p className="text-xs text-foreground">最近收取错误（供排查）：{reason}</p>}
        <p className="emergency-stop-meta text-xs text-muted-foreground">
          {legacy ? '排查来源' : '触发来源'}：{stopSources[incident?.source ?? 'UNKNOWN'] ?? stopSources.UNKNOWN}
          。停止收取、模型和发送；已有草稿保留。
        </p>
        <p className="emergency-stop-help text-xs leading-relaxed text-muted-foreground">
          {recoveryHelp}重启不会自动解除急停。
        </p>
        {openingError && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-1.5 text-xs text-destructive-foreground"
          >
            {openingError}
          </p>
        )}
        <div className="row flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            className={primaryButtonClass}
            disabled={!!busy || !!session}
            onClick={() => void act('检查并恢复运行', resume)}
          >
            {recovery ? '返回无头并检查恢复' : '检查并恢复运行'}
          </button>
          {!recovery && originalButtons}
          {!recovery && incident?.reason === 'LOGIN_REQUIRED' && (
            <button
              type="button"
              className={outlineButtonClass}
              disabled={!!busy || !!session}
              onClick={() => void openLogin()}
            >
              处理登录
            </button>
          )}
        </div>
      </section>
    );
  }

  return (
    <>
      {notice}
      {session && <SecurityRecoveryDialog session={session} update={update} onClosed={() => setSession(null)} />}
    </>
  );
}
