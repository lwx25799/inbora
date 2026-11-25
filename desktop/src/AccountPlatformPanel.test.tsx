import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, test, vi } from 'vitest';
import { AccountPlatformPanel } from './AccountPlatformPanel';
import { DOUYIN_PLATFORM_ID, MOCK_PLATFORM_ID, listAccountsV2, request, type AccountSummary, type Status } from './api';

const invokeMock = vi.fn<(command: string, args: unknown) => Promise<unknown>>();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args: unknown) => invokeMock(command, args),
}));

interface PanelHooks {
  state: (initial: unknown) => [unknown, (next: unknown) => void];
  ref: (initial: unknown) => { current: unknown };
  effect: (setup: () => () => void) => void;
}
let activeHooks: PanelHooks | undefined;

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    useState: (initial: unknown) => activeHooks ? activeHooks.state(initial) : actual.useState(initial),
    useRef: (initial: unknown) => activeHooks ? activeHooks.ref(initial) : actual.useRef(initial),
    useCallback: (callback: () => void, deps: readonly unknown[]) =>
      activeHooks ? callback : actual.useCallback(callback, deps),
    useLayoutEffect: (setup: () => () => void, deps: readonly unknown[]) => {
      if (activeHooks) activeHooks.effect(setup);
      else actual.useLayoutEffect(setup, deps);
    },
  };
});

function status(schema = 4, runtime = 'synthetic-accounts'): Status {
  return {
    runtime, schema, account: null, operator: { id: 'operator-1', permissions: [], expiresAt: 0 },
    mode: 'OBSERVE', configuredMode: 'OBSERVE', paused: false,
    browser: { state: 'OPEN_LAST_READ_VERIFIED', mode: 'headless', loginRecovery: false, version: 'synthetic' },
    lastSync: [], capabilities: [], budgets: [], usage: { requests: 0, inputTokens: 0, outputTokens: 0, unresolved: 0 },
    settings: { model: 'deepseek-flash', persona: '', business: '', rules: '' },
    keyPresent: false, modelAuthorized: false, modelBusy: false, go: 'UNVERIFIED',
    sync: { runId: null, running: false, cancelled: false, source: null, results: [] },
  };
}

const mainAccount: AccountSummary = {
  id: 'account_001', accountRef: 'account_001', platform: DOUYIN_PLATFORM_ID, connector: 'douyin',
  displayLabel: '抖音主账号', status: 'ACTIVE', ownId: 'own-1', profileRef: 'profile-douyin',
  capabilities: { channels: ['COMMENT_NOTIFICATION', 'DIRECT_MESSAGE'], loginRecovery: true,
    manualSecurityRecovery: true, preview: true, readback: true },
  autoReplyEnabled: true, createdAt: '2026-11-25', updatedAt: '2026-11-25',
};
const mockAccount: AccountSummary = {
  ...mainAccount, id: 'account_002', accountRef: 'account_002', platform: MOCK_PLATFORM_ID, connector: MOCK_PLATFORM_ID,
  displayLabel: '合成验证账号', ownId: null, profileRef: 'profile-mock', autoReplyEnabled: false,
};
const listArgs = { scope: { kind: 'GLOBAL' }, body: { command: 'accounts', action: 'listAccounts' } };
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

beforeEach(() => invokeMock.mockReset());

function accountList(...accounts: AccountSummary[]) {
  return { accounts, schemaVersion: 4 };
}

function mountPanel(initialStatus = status()) {
  const panel = AccountPlatformPanel({ status: initialStatus, busy: '' });
  const states: unknown[] = [];
  const refs: { current: unknown }[] = [];
  let cleanup: (() => void) | undefined;

  function render() {
    if (typeof panel.type !== 'function') return panel;
    const Component = panel.type;
    let stateIndex = 0;
    let refIndex = 0;
    let setup: (() => () => void) | undefined;
    activeHooks = {
      state(initial) {
        const index = stateIndex++;
        if (index === states.length) states.push(initial);
        return [states[index], next => { states[index] = next; }];
      },
      ref(initial) {
        const index = refIndex++;
        return refs[index] ??= { current: initial };
      },
      effect(effectSetup) { setup = effectSetup; },
    };
    let tree: ReactNode;
    try {
      tree = Component(panel.props);
    } finally {
      activeHooks = undefined;
    }
    if (!cleanup) cleanup = setup?.();
    return tree;
  }

  render();
  return {
    key: panel.key,
    markup: () => renderToStaticMarkup(render()),
    buttons: (label: string) => findButtons(render(), label),
    click(label: string) {
      const buttons = findButtons(render(), label);
      expect(buttons).toHaveLength(1);
      expect(buttons[0].props.disabled).not.toBe(true);
      buttons[0].props.onClick();
    },
    unmount: () => cleanup?.(),
  };
}

function findButtons(node: ReactNode, label: string): ReactElement<{
  children: ReactNode; disabled?: boolean; onClick: () => void;
}>[] {
  if (Array.isArray(node)) return node.flatMap(child => findButtons(child, label));
  if (!isValidElement<{ children: ReactNode; disabled?: boolean; onClick: () => void }>(node)) return [];
  if (node.type === 'button' && node.props.children === label) return [node];
  return findButtons(node.props.children, label);
}

test('schema4 通过 GLOBAL v2 请求读取并展示抖音主账号与 Mock 账号', async () => {
  invokeMock.mockResolvedValueOnce(accountList(mainAccount, mockAccount));
  const panel = mountPanel();
  expect(panel.markup()).toContain('正在读取账号列表');
  await vi.waitFor(() => expect(panel.markup()).toContain('合成验证账号 · 合成验证平台 (Mock)'));
  expect(invokeMock).toHaveBeenCalledExactlyOnceWith('client_request_v2', listArgs);
  expect(panel.markup()).toContain('抖音主账号 · 抖音');
  expect(panel.markup()).toContain('<code>account_001</code>');
  expect(panel.markup()).toContain('<code>account_002</code>');
  expect(panel.markup()).toContain('活跃 · 自动回复：关 · 支持 2 个通道 · 只读回读：支持');
  expect(panel.buttons('解绑账号')).toHaveLength(1);
});

test('注册 Mock 账号使用默认展示名、GLOBAL 作用域和同一个 UUID，随后刷新', async () => {
  invokeMock.mockResolvedValueOnce(accountList(mainAccount)).mockResolvedValueOnce(mockAccount)
    .mockResolvedValueOnce(accountList(mainAccount, mockAccount));
  const panel = mountPanel();
  await vi.waitFor(() => expect(panel.markup()).toContain('抖音主账号'));
  panel.click('注册合成验证账号 (Mock)');

  const commandId = cryptoCommandId(1);
  expect(invokeMock).toHaveBeenNthCalledWith(2, 'client_request_v2', {
    scope: { kind: 'GLOBAL' }, commandId,
    body: { command: 'accounts', action: 'registerAccount', commandId, accountId: `account_${commandId}`,
      platform: 'mock-platform', connector: 'mock-platform', displayLabel: '合成验证账号' },
  });
  await vi.waitFor(() => expect(panel.markup()).toContain('合成验证账号 · 合成验证平台 (Mock)'));
  expect(panel.markup()).toContain('新账号默认关闭自动回复');
  expect(invokeMock).toHaveBeenNthCalledWith(3, 'client_request_v2', listArgs);
  expect(invokeMock).toHaveBeenCalledTimes(3);
});

test('第二个活跃账号注册后，主账号写入与全局写入自动走 v2，读取保留 v1', async () => {
  invokeMock.mockResolvedValueOnce(accountList(mainAccount)).mockResolvedValueOnce({})
    .mockResolvedValueOnce(mockAccount).mockResolvedValueOnce(accountList(mainAccount, mockAccount))
    .mockResolvedValue({});
  const panel = mountPanel(status(4, 'routing-registration'));
  await vi.waitFor(() => expect(panel.markup()).toContain('抖音主账号'));
  const mode = { command: 'setMode', mode: 'MANUAL' } as const;
  await request(mode);
  expect(invokeMock).toHaveBeenLastCalledWith('client_request', { body: mode });
  panel.click('注册合成验证账号 (Mock)');
  await vi.waitFor(() => expect(panel.markup()).toContain('合成验证账号 · 合成验证平台 (Mock)'));

  const sendId = crypto.randomUUID();
  const modelId = crypto.randomUUID();
  const calls = [
    [mode, { kind: 'ACCOUNT', accountRef: mainAccount.accountRef }, undefined],
    [{ command: 'markInboxRead' }, { kind: 'ACCOUNT', accountRef: mainAccount.accountRef }, undefined],
    [{ command: 'submitManualSend', commandId: sendId, confirmed: true, params: {
      eventId: crypto.randomUUID(), generation: 1, draftId: crypto.randomUUID(), draftVersion: 1,
      text: '合成回复', contextVersion: 'a'.repeat(64), selectionId: crypto.randomUUID(),
    } }, { kind: 'ACCOUNT', accountRef: mainAccount.accountRef }, sendId],
    [{ command: 'modelProviders', action: 'setKey', connectionId: modelId, expectedVersion: 1,
      storage: 'DELETE' }, { kind: 'GLOBAL' }, undefined],
  ] as const;
  for (const [body, scope, authoritativeId] of calls) {
    await request(body);
    const commandId = cryptoCommandId(invokeMock.mock.calls.length - 1);
    if (authoritativeId) expect(commandId).toBe(authoritativeId);
    expect(invokeMock).toHaveBeenLastCalledWith('client_request_v2', { body, scope, commandId });
  }
  await request({ command: 'modelProviders', action: 'list' });
  expect(invokeMock).toHaveBeenLastCalledWith('client_request', { body: { command: 'modelProviders', action: 'list' } });
});

test('已连接多账号库时，首次写入在打开账号面板前识别 v2，换库后恢复单账号 v1', async () => {
  const multi = status(4, 'startup-multi-account');
  invokeMock.mockResolvedValueOnce(multi).mockResolvedValueOnce(accountList(mainAccount, mockAccount))
    .mockResolvedValueOnce({}).mockResolvedValueOnce({ connected: false })
    .mockResolvedValueOnce(status(3, 'startup-single-account')).mockResolvedValueOnce({});
  await request({ command: 'getStatus' });
  const body = { command: 'setMode', mode: 'MANUAL' } as const;
  await request(body);
  expect(invokeMock).toHaveBeenNthCalledWith(1, 'client_request', { body: { command: 'getStatus' } });
  expect(invokeMock).toHaveBeenNthCalledWith(2, 'client_request_v2', listArgs);
  expect(invokeMock).toHaveBeenNthCalledWith(3, 'client_request_v2', {
    body, scope: { kind: 'ACCOUNT', accountRef: mainAccount.accountRef }, commandId: cryptoCommandId(2),
  });
  await request({ command: 'disconnect' });
  await request({ command: 'connect', runtime: 'startup-single-account', initialize: false, consent: true });
  await request(body);
  expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
    'client_request', 'client_request_v2', 'client_request_v2', 'client_request', 'client_request', 'client_request',
  ]);
  expect(invokeMock).toHaveBeenLastCalledWith('client_request', { body });
});

test('刚连接时立即下发急停，即使账号列表一直挂起', async () => {
  const body = { command: 'emergencyStop' } as const;
  invokeMock.mockResolvedValueOnce(status(4, 'stop-with-pending-accounts'))
    .mockResolvedValueOnce({ emergencyStopped: true })
    .mockReturnValueOnce(new Promise(() => {}))
    .mockResolvedValueOnce({ emergencyStopped: true });
  await request({ command: 'getStatus' });
  const first = request(body);
  expect(invokeMock).toHaveBeenNthCalledWith(2, 'client_request', { body });
  await expect(first).resolves.toEqual({ emergencyStopped: true });
  void listAccountsV2();
  const second = request(body);
  expect(invokeMock).toHaveBeenNthCalledWith(3, 'client_request_v2', listArgs);
  expect(invokeMock).toHaveBeenNthCalledWith(4, 'client_request', { body });
  await expect(second).resolves.toEqual({ emergencyStopped: true });
});

test('注册超时后刷新未找到对应账号时锁定新注册，重试沿用整帧和原命令 ID', async () => {
  invokeMock.mockResolvedValueOnce(accountList(mainAccount)).mockRejectedValueOnce('IPC_RESPONSE_UNKNOWN_READ_STATUS')
    .mockResolvedValueOnce(accountList(mainAccount, mockAccount)).mockResolvedValueOnce(mockAccount)
    .mockResolvedValueOnce(accountList(mainAccount, mockAccount));
  const panel = mountPanel(status(4, 'unknown-registration-retry'));
  await vi.waitFor(() => expect(panel.markup()).toContain('抖音主账号'));
  panel.click('注册合成验证账号 (Mock)');
  await vi.waitFor(() => expect(panel.markup()).toContain('注册结果尚未确认'));
  expect(panel.buttons('注册合成验证账号 (Mock)')[0]?.props.disabled).toBe(true);
  panel.click('刷新账号列表');
  await vi.waitFor(() => expect(panel.markup()).toContain('合成验证账号 · 合成验证平台 (Mock)'));
  expect(panel.buttons('注册合成验证账号 (Mock)')[0]?.props.disabled).toBe(true);
  panel.click('重试同一次注册');
  expect(invokeMock.mock.calls[3]).toEqual(invokeMock.mock.calls[1]);
  await vi.waitFor(() => expect(panel.buttons('注册合成验证账号 (Mock)')[0]?.props.disabled).toBe(false));
});

test('注册回包丢失后可通过刷新确认对应账号并解锁新注册', async () => {
  invokeMock.mockResolvedValueOnce(accountList(mainAccount)).mockRejectedValueOnce('IPC_RESPONSE_UNKNOWN_READ_STATUS');
  const panel = mountPanel(status(4, 'unknown-registration-refresh'));
  await vi.waitFor(() => expect(panel.markup()).toContain('抖音主账号'));
  panel.click('注册合成验证账号 (Mock)');
  const accountRef = `account_${cryptoCommandId(1)}`;
  invokeMock.mockResolvedValueOnce(accountList(mainAccount, { ...mockAccount, id: accountRef, accountRef }));
  await vi.waitFor(() => expect(panel.markup()).toContain('注册结果尚未确认'));
  panel.click('刷新账号列表');
  await vi.waitFor(() => expect(panel.markup()).toContain('已确认合成验证账号注册成功'));
  expect(panel.buttons('注册合成验证账号 (Mock)')[0]?.props.disabled).toBe(false);
  expect(panel.buttons('重试同一次注册')).toHaveLength(0);
  expect(invokeMock).toHaveBeenCalledTimes(3);
});

test('回到同一运行目录后仍能核对上次未确认的注册', async () => {
  const session = status(4, 'unknown-registration-remount');
  invokeMock.mockResolvedValueOnce(accountList(mainAccount)).mockRejectedValueOnce('DEV_BACKEND_RESTARTING_READ_STATUS')
    .mockResolvedValueOnce(accountList(mainAccount)).mockResolvedValueOnce(mockAccount)
    .mockResolvedValueOnce(accountList(mainAccount, mockAccount));
  const previous = mountPanel(session);
  await vi.waitFor(() => expect(previous.markup()).toContain('抖音主账号'));
  previous.click('注册合成验证账号 (Mock)');
  previous.unmount();
  const next = mountPanel(session);
  await vi.waitFor(() => expect(next.buttons('重试同一次注册')[0]?.props.disabled).toBe(false));
  expect(next.buttons('注册合成验证账号 (Mock)')[0]?.props.disabled).toBe(true);
  next.click('重试同一次注册');
  expect(invokeMock.mock.calls[3]).toEqual(invokeMock.mock.calls[1]);
  await vi.waitFor(() => expect(next.markup()).toContain('新账号默认关闭自动回复'));
});

test('显式确认后才按 ACCOUNT 作用域解绑 Mock 账号，并刷新为已解绑', async () => {
  const disconnected: AccountSummary = { ...mockAccount, status: 'DISCONNECTED' };
  invokeMock.mockResolvedValueOnce(accountList(mainAccount, mockAccount)).mockResolvedValueOnce(disconnected)
    .mockResolvedValueOnce(accountList(mainAccount, disconnected));
  const panel = mountPanel();
  await vi.waitFor(() => expect(panel.buttons('解绑账号')).toHaveLength(1));
  panel.click('解绑账号');
  expect(panel.markup()).toContain('确认解绑？历史消息与发送收据将完整保留。');
  expect(invokeMock).toHaveBeenCalledTimes(1);
  panel.click('取消');
  expect(panel.buttons('确认解绑')).toHaveLength(0);
  expect(invokeMock).toHaveBeenCalledTimes(1);
  panel.click('解绑账号');
  panel.click('确认解绑');

  const commandId = cryptoCommandId(1);
  expect(invokeMock).toHaveBeenNthCalledWith(2, 'client_request_v2', {
    scope: { kind: 'ACCOUNT', accountRef: mockAccount.accountRef }, commandId,
    body: { command: 'accounts', action: 'disconnectAccount', commandId, accountRef: mockAccount.accountRef, confirmed: true },
  });
  await vi.waitFor(() => expect(panel.markup()).toContain('已解绑 · 自动回复：关'));
  expect(panel.buttons('解绑账号')).toHaveLength(0);
  expect(invokeMock).toHaveBeenNthCalledWith(3, 'client_request_v2', listArgs);
});

test('schema3 显示只读说明且不发送账号请求', () => {
  const panel = mountPanel(status(3));
  expect(panel.markup()).toContain('当前为单账号 schema3 模式');
  expect(panel.buttons('注册合成验证账号 (Mock)')).toHaveLength(0);
  expect(invokeMock).not.toHaveBeenCalled();
});

test('列表读取失败时可手动刷新恢复', async () => {
  invokeMock.mockRejectedValueOnce('SCHEMA4_REQUIRED').mockResolvedValueOnce(accountList(mainAccount));
  const panel = mountPanel();
  await vi.waitFor(() => expect(panel.markup()).toContain('当前数据库尚未升级至多账号结构（schema4）。'));
  panel.click('刷新账号列表');
  await vi.waitFor(() => expect(panel.markup()).toContain('抖音主账号'));
  expect(panel.markup()).not.toContain('当前数据库尚未升级');
  expect(invokeMock).toHaveBeenNthCalledWith(2, 'client_request_v2', listArgs);
});

test('切换运行会话后，已卸载区块的注册回包不会触发刷新', async () => {
  let finishRegistration!: (account: AccountSummary) => void;
  const registration = new Promise<AccountSummary>(resolve => { finishRegistration = resolve; });
  invokeMock.mockResolvedValueOnce(accountList(mainAccount)).mockReturnValueOnce(registration)
    .mockResolvedValueOnce(accountList());
  const previous = mountPanel();
  await vi.waitFor(() => expect(previous.markup()).toContain('抖音主账号'));
  previous.click('注册合成验证账号 (Mock)');
  previous.unmount();
  const next = mountPanel(status(4, 'other-synthetic-runtime'));
  expect(next.key).not.toBe(previous.key);
  finishRegistration(mockAccount);
  await vi.waitFor(() => expect(next.markup()).toContain('暂无已注册账号'));
  expect(invokeMock).toHaveBeenCalledTimes(3);
  expect(next.markup()).not.toContain('新账号默认关闭自动回复');
});

function cryptoCommandId(callIndex: number) {
  const args = invokeMock.mock.calls[callIndex]?.[1] as { commandId?: string } | undefined;
  expect(args?.commandId).toMatch(uuidV4);
  return args?.commandId;
}
