import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { DEFAULT_ACCOUNT_ID } from '../../src/contracts/account.js';
import {
  accountRegistrationUnconfirmed, disconnectAccountV2, listAccountsV2, mockRegistrationAccountRef,
  MOCK_PLATFORM_ID, platformNames, registerMockAccountV2, runtimeSession,
  type AccountSummary, type MockRegistration, type Status,
} from './api';
import { explainSafe, extractErrorCode } from './error-messages';

const title = '账号与平台（单库多账号）';
const defaultDisplayLabel = '合成验证账号';
const accountStatusNames: Record<AccountSummary['status'], string> = {
  ACTIVE: '活跃', DISCONNECTED: '已解绑', PAUSED: '暂停', ERROR: '异常',
};

interface AccountMutation {
  request: () => Promise<AccountSummary>;
  success: string;
  failure: string;
  registration?: MockRegistration;
}

// Settings can unmount while a registration is in flight. Keep its identity on return to the same directory.
const pendingRegistrations = new Map<string, MockRegistration>();

export function AccountPlatformPanel({ status, busy }: { status: Status; busy: string }) {
  if (status.schema < 4) {
    return (
      <div className="settings-section">
        <h2>{title}</h2>
        <p className="hint">当前为单账号 schema3 模式</p>
      </div>
    );
  }
  return <ConnectedAccounts key={runtimeSession(status)} status={status} busy={busy} />;
}

function ConnectedAccounts({ status, busy }: { status: Status; busy: string }) {
  const { runtime } = status;
  const [accounts, setAccounts] = useState<AccountSummary[] | null>(null);
  const [displayLabel, setDisplayLabel] = useState('');
  const [registration, setRegistration] = useState(pendingRegistrations.get(runtime) ?? null);
  const [confirmAccount, setConfirmAccount] = useState<string | null>(null);
  const [pending, setPending] = useState<'list' | 'write' | null>('list');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lifetime = useRef<{ busy: boolean } | null>(null);
  const latestStatus = useRef(status);
  latestStatus.current = status;
  const disabled = !!busy || pending !== null;

  const run = useCallback(async (mutation?: AccountMutation) => {
    const current = lifetime.current;
    if (!current || current.busy) return;
    const attempt = mutation?.registration;
    const previous = pendingRegistrations.get(runtime);
    if (attempt && previous && attempt !== previous) return;
    if (attempt) {
      pendingRegistrations.set(runtime, attempt);
      setRegistration(attempt);
    }
    function confirmRegistration(confirmed: MockRegistration) {
      if (pendingRegistrations.get(runtime) === confirmed) pendingRegistrations.delete(runtime);
      if (lifetime.current === current) setRegistration(pendingRegistrations.get(runtime) ?? null);
    }
    current.busy = true;
    setPending(mutation ? 'write' : 'list');
    setError('');
    setNotice('');
    setConfirmAccount(null);
    let fallback = '暂时无法读取账号列表，请刷新后重试。';
    let awaitingRegistration = attempt;
    try {
      if (mutation) {
        fallback = mutation.failure;
        await mutation.request();
        awaitingRegistration = undefined;
        if (attempt) confirmRegistration(attempt);
        if (lifetime.current !== current) return;
        fallback = '账号已更新，暂时无法刷新账号列表。';
        setNotice(mutation.success);
        setAccounts(null);
        setPending('list');
      }
      const unresolved = pendingRegistrations.get(runtime);
      const next = await listAccountsV2(latestStatus.current);
      if (lifetime.current === current) {
        setAccounts(next);
        if (unresolved && next.some(account => account.accountRef === mockRegistrationAccountRef(unresolved.commandId)
          && account.platform === MOCK_PLATFORM_ID && account.displayLabel === unresolved.displayLabel)) {
          confirmRegistration(unresolved);
          setNotice('已确认合成验证账号注册成功。');
        }
      }
    } catch (cause) {
      const unconfirmed = awaitingRegistration && accountRegistrationUnconfirmed(cause);
      if (awaitingRegistration && !unconfirmed && (!previous || ['ACCOUNT_ID_CONFLICT', 'ACCOUNT_IDENTITY_CONFLICT']
        .includes(extractErrorCode(cause)))) confirmRegistration(awaitingRegistration);
      if (lifetime.current === current && !unconfirmed) setError(explainSafe(cause, fallback));
    } finally {
      if (lifetime.current === current) {
        current.busy = false;
        setPending(null);
      }
    }
  }, [runtime]);

  function register(input: MockRegistration) {
    void run({
      request: () => registerMockAccountV2(input),
      registration: input,
      success: '合成验证账号已注册。新账号默认关闭自动回复。',
      failure: '合成验证账号注册失败，请刷新账号列表后核对状态。',
    });
  }

  useLayoutEffect(() => {
    lifetime.current = { busy: false };
    void run();
    return () => { lifetime.current = null; };
  }, [run]);

  return (
    <div className="settings-section">
      <h2>{title}</h2>
      <div className="row">
        <button type="button" disabled={disabled} onClick={() => void run()}>刷新账号列表</button>
      </div>
      {pending && <p className="hint" role="status">{pending === 'list' ? '正在读取账号列表…' : '正在更新账号…'}</p>}
      {error && <p className="hint" role="status">{error}</p>}
      {notice && <p className="hint" role="status">{notice}</p>}
      {registration && pending !== 'write' && <p className="hint" role="status">
        “{registration.displayLabel}”的注册结果尚未确认。请刷新账号列表核对，或重试同一次注册。
      </p>}
      {accounts?.length === 0 && <p className="hint">暂无已注册账号。</p>}
      {accounts && accounts.length > 0 && (
        <dl>
          {accounts.map(account => (
            <div key={account.accountRef}>
              <dt>{account.displayLabel} · {Object.hasOwn(platformNames, account.platform) ? platformNames[account.platform] : account.platform}</dt>
              <dd>
                <code>{account.id}</code>
                <p className="hint">
                  {accountStatusNames[account.status]} · 自动回复：{account.autoReplyEnabled ? '开' : '关'}
                  {' · '}支持 {account.capabilities.channels.length} 个通道
                  {' · '}只读回读：{account.capabilities.readback ? '支持' : '不支持'}
                </p>
                {account.id !== DEFAULT_ACCOUNT_ID && account.status === 'ACTIVE' && (
                  confirmAccount === account.accountRef ? (
                    <div>
                      <p className="hint">确认解绑？历史消息与发送收据将完整保留。</p>
                      <div className="row">
                        <button type="button" className="danger" disabled={disabled} onClick={() => void run({
                          request: () => disconnectAccountV2(account.accountRef),
                          success: '账号已解绑。',
                          failure: '账号解绑失败，请刷新账号列表后核对状态。',
                        })}>确认解绑</button>
                        <button type="button" onClick={() => setConfirmAccount(null)}>取消</button>
                      </div>
                    </div>
                  ) : (
                    <div className="row">
                      <button type="button" disabled={disabled} onClick={() => setConfirmAccount(account.accountRef)}>解绑账号</button>
                    </div>
                  )
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <label>
        展示名（可选）
        <input type="text" value={displayLabel} placeholder={defaultDisplayLabel} maxLength={128}
          disabled={disabled || !!registration} onChange={event => setDisplayLabel(event.target.value)} />
      </label>
      <div className="row">
        <button type="button" disabled={disabled || !!registration} onClick={() => register({
          commandId: crypto.randomUUID(), displayLabel: displayLabel.trim() || defaultDisplayLabel,
        })}>注册合成验证账号 (Mock)</button>
        {registration && <button type="button" disabled={disabled}
          onClick={() => register(registration)}>重试同一次注册</button>}
      </div>
    </div>
  );
}
