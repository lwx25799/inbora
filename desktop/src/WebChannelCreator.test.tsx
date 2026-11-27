import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DEFAULT_ACCOUNT_ID } from '../../src/contracts/account.js';
import { AccountPlatformPanel } from './AccountPlatformPanel';
import {
  BILIBILI_PLATFORM_ID,
  platformNames,
  setActiveWorkbenchAccount,
  XIAOHONGSHU_PLATFORM_ID,
  type AccountSummary,
  type Status,
} from './api';
import { errorMessages } from './error-messages';
import { AccountsView } from './views/AccountsView';
import { clearPendingWebRegistration, WebChannelCreator } from './WebChannelCreator';

const invokeMock = vi.fn<(command: string, args: unknown) => Promise<unknown>>();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args: unknown) => invokeMock(command, args),
}));

interface HookBox {
  useState: <T>(initial: T | (() => T)) => [T, (next: T | ((prev: T) => T)) => void];
  useRef: <T>(initial: T) => { current: T };
  useCallback: <T extends (...args: never[]) => unknown>(fn: T, deps: readonly unknown[]) => T;
  useEffect: (fn: () => (() => void) | void, deps?: readonly unknown[]) => void;
}
let activeHooks: HookBox | undefined;

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    useState: <T,>(initial: T | (() => T)) =>
      activeHooks ? activeHooks.useState(initial) : actual.useState(initial),
    useRef: <T,>(initial: T) =>
      activeHooks ? activeHooks.useRef(initial) : actual.useRef(initial),
    useCallback: <T extends (...args: never[]) => unknown>(callback: T, deps: readonly unknown[]) =>
      activeHooks ? activeHooks.useCallback(callback, deps) : actual.useCallback(callback, deps),
    useLayoutEffect: (setup: () => (() => void) | void, deps?: readonly unknown[]) => {
      if (activeHooks) activeHooks.useEffect(setup, deps);
      else actual.useLayoutEffect(setup, deps);
    },
    useEffect: (setup: () => (() => void) | void, deps?: readonly unknown[]) => {
      if (activeHooks) activeHooks.useEffect(setup, deps);
      else actual.useEffect(setup, deps);
    },
  };
});

function mount<P>(Component: (props: P) => ReactNode, initialProps: P) {
  let props = initialProps;
  const states: unknown[] = [];
  const refs: { current: unknown }[] = [];
  const callbacks: { deps: readonly unknown[]; fn: unknown }[] = [];
  const effects: { deps?: readonly unknown[]; cleanup?: (() => void) | void }[] = [];
  let tree: ReactNode = null;
  let rendering = false;
  let needsRerender = false;
  const sameDeps = (a?: readonly unknown[], b?: readonly unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((item, index) => Object.is(item, b[index]));

  const render = () => {
    if (rendering) {
      needsRerender = true;
      return tree;
    }
    rendering = true;
    try {
      for (let pass = 0; pass < 10; pass++) {
        needsRerender = false;
        let sIdx = 0;
        let rIdx = 0;
        let cIdx = 0;
        let eIdx = 0;
        const pending: { idx: number; fn: () => (() => void) | void; deps?: readonly unknown[] }[] = [];
        activeHooks = {
          useState: <T,>(initial: T | (() => T)) => {
            const idx = sIdx++;
            if (idx >= states.length) {
              states.push(typeof initial === 'function' ? (initial as () => T)() : initial);
            }
            return [
              states[idx] as T,
              (next: T | ((prev: T) => T)) => {
                const prev = states[idx] as T;
                const value = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
                if (!Object.is(prev, value)) {
                  states[idx] = value;
                  render();
                }
              },
            ];
          },
          useRef: <T,>(initial: T) => {
            const idx = rIdx++;
            if (idx >= refs.length) refs.push({ current: initial });
            return refs[idx] as { current: T };
          },
          useCallback: <T extends (...args: never[]) => unknown>(fn: T, deps: readonly unknown[]) => {
            const idx = cIdx++;
            const prev = callbacks[idx];
            if (!prev || !sameDeps(prev.deps, deps)) {
              callbacks[idx] = { deps, fn };
            }
            return callbacks[idx]!.fn as T;
          },
          useEffect: (fn, deps) => {
            pending.push({ idx: eIdx++, fn, deps });
          },
        };
        try {
          tree = Component(props);
        } finally {
          activeHooks = undefined;
        }
        for (const item of pending) {
          const prev = effects[item.idx];
          if (!prev || !item.deps || !sameDeps(prev.deps, item.deps)) {
            prev?.cleanup?.();
            effects[item.idx] = { deps: item.deps, cleanup: item.fn() };
          }
        }
        if (!needsRerender) break;
      }
      return tree;
    } finally {
      rendering = false;
    }
  };

  render();
  return {
    tree: () => tree,
    markup: () => renderToStaticMarkup(tree),
    updateProps: (nextProps: P) => {
      props = nextProps;
      render();
    },
    unmount: () => {
      for (const eff of effects) eff?.cleanup?.();
    },
  };
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

function findElements(
  node: ReactNode,
  predicate: (el: ReactElement<Record<string, unknown>>) => boolean,
  out: ReactElement<Record<string, unknown>>[] = [],
): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, predicate, out);
    return out;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return out;
  if (predicate(node)) out.push(node);
  if ('children' in node.props) findElements(node.props.children as ReactNode, predicate, out);
  return out;
}

function findButton(tree: ReactNode, label: string) {
  const matches = findElements(tree, el => el.type === 'button' && textOf(el).trim() === label);
  expect(matches, `Expected button "${label}"`).toHaveLength(1);
  return matches[0]!;
}

function findInputByLabel(tree: ReactNode, labelPart: string) {
  const label = findElements(tree, el => el.type === 'label' && textOf(el).includes(labelPart))[0];
  expect(label, `Expected label containing "${labelPart}"`).toBeTruthy();
  const input = findElements(label, el => el.type === 'input')[0];
  expect(input, `Expected input under "${labelPart}"`).toBeTruthy();
  return input!;
}

function baseStatus(overrides: Partial<Status> = {}): Status {
  return {
    runtime: 'synthetic-web-accounts',
    account: { id: DEFAULT_ACCOUNT_ID, identity: 'own-1' },
    operator: { id: 'op-1', permissions: ['READ', 'EDIT', 'SEND', 'CONTROL'], expiresAt: Date.now() + 60_000 },
    mode: 'MANUAL',
    configuredMode: 'MANUAL',
    paused: false,
    browser: { state: 'OPEN_LAST_READ_VERIFIED', mode: 'headless', loginRecovery: false, version: '130.0' },
    lastSync: [],
    capabilities: [
      { channel: 'DIRECT_MESSAGE', state: 'READ_OK', reason: '', evidence: 'ok' },
      { channel: 'COMMENT_NOTIFICATION', state: 'READ_OK', reason: '', evidence: 'ok' },
    ],
    budgets: [],
    usage: { requests: 0, inputTokens: 0, outputTokens: 0, unresolved: 0 },
    settings: { model: 'deepseek-flash', persona: '', business: '', rules: '' },
    keyPresent: false,
    modelAuthorized: false,
    modelBusy: false,
    automation: {
      startedAt: 1794054761443,
      emergencyStopped: false,
      collection: { ownId: 'own-1', comments: true, inbox: true, commentIntervalMs: 30_000, dmIntervalMs: 15_000 },
      modelGrant: null,
      replyPolicy: null,
      inboxRevision: 1,
      collector: { running: false, source: null, fatal: null, channels: [] },
      pendingWorks: { count: 0 },
    },
    sync: { runId: null, running: false, cancelled: false, source: null, results: [] },
    go: 'UNVERIFIED',
    schema: 4,
    ...overrides,
  };
}

const xhsAccount: AccountSummary = {
  id: 'account_xhs_1',
  accountRef: 'account_xhs_1',
  platform: XIAOHONGSHU_PLATFORM_ID,
  connector: XIAOHONGSHU_PLATFORM_ID,
  ownId: 'xhs-user-1',
  displayLabel: '小红书客服主号',
  status: 'ACTIVE',
  profileRef: 'profiles/account_xhs_1',
  capabilities: {
    channels: ['COMMENT_NOTIFICATION', 'DIRECT_MESSAGE'],
    loginRecovery: false,
    manualSecurityRecovery: true,
    preview: false,
    readback: true,
    transport: 'browser',
  },
  autoReplyEnabled: false,
  createdAt: '2026-11-27',
  updatedAt: '2026-11-27',
};

const biliAccount: AccountSummary = {
  ...xhsAccount,
  id: 'account_bili_1',
  accountRef: 'account_bili_1',
  platform: BILIBILI_PLATFORM_ID,
  connector: BILIBILI_PLATFORM_ID,
  ownId: 'bili-uid-88',
  displayLabel: 'B 站官方号',
  profileRef: 'profiles/account_bili_1',
};

beforeEach(() => {
  invokeMock.mockReset();
  setActiveWorkbenchAccount(null);
  clearPendingWebRegistration('rt-basic');
  clearPendingWebRegistration('rt-remount-committed');
  clearPendingWebRegistration('rt-remount-retry');
  clearPendingWebRegistration('rt-delayed-commit');
});
afterEach(() => {
  activeHooks = undefined;
  setActiveWorkbenchAccount(null);
});

test('WebChannelCreator registers Xiaohongshu and Bilibili accounts and reuses commandId on unconfirmed retry', async () => {
  const onRegistered = vi.fn(async () => {});
  const onClose = vi.fn();
  let registerAttempt = 0;
  invokeMock.mockImplementation(async (_cmd, args) => {
    const body = (args as { body?: { action?: string; platform?: string } })?.body;
    if (body?.action === 'listAccounts') return { accounts: [], schemaVersion: 4 };
    if (body?.action === 'registerAccount') {
      registerAttempt += 1;
      if (registerAttempt === 1) throw 'IPC_RESPONSE_UNKNOWN_READ_STATUS';
      return body.platform === BILIBILI_PLATFORM_ID ? biliAccount : xhsAccount;
    }
    return {};
  });

  const view = mount(WebChannelCreator, { runtime: 'rt-basic', disabled: false, onRegistered, onClose });
  try {
    (findInputByLabel(view.tree(), '展示名称').props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: '小红书客服主号' },
    });
    (findInputByLabel(view.tree(), '平台账号标识').props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: 'xhs-user-1' },
    });

    (findButton(view.tree(), '添加账号').props.onClick as () => void)();
    await vi.waitFor(() => expect(view.markup()).toContain('注册结果尚未确认'));

    const registerCalls = () => invokeMock.mock.calls.filter(
      call => (call[1] as { body?: { action?: string } })?.body?.action === 'registerAccount',
    );
    const firstArgs = registerCalls()[0]?.[1] as { commandId: string; body: Record<string, unknown> };
    expect(firstArgs.body).toMatchObject({
      command: 'accounts',
      action: 'registerAccount',
      platform: XIAOHONGSHU_PLATFORM_ID,
      connector: XIAOHONGSHU_PLATFORM_ID,
      displayLabel: '小红书客服主号',
      ownId: 'xhs-user-1',
      profileRef: `profiles/account_${firstArgs.commandId}`,
    });

    (findButton(view.tree(), '添加账号').props.onClick as () => void)();
    await vi.waitFor(() => expect(onRegistered).toHaveBeenCalledTimes(1));
    const retryArgs = registerCalls()[1]?.[1] as { commandId: string; body: Record<string, unknown> };
    expect(retryArgs.commandId).toBe(firstArgs.commandId);
    expect(retryArgs.body.accountId).toBe(firstArgs.body.accountId);

    const biliSwitch = findElements(view.tree(), el => el.type === 'button' && textOf(el).includes('B 站'))[0]!;
    (biliSwitch.props.onClick as () => void)();
    (findInputByLabel(view.tree(), '展示名称').props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: 'B 站官方号' },
    });
    (findButton(view.tree(), '添加账号').props.onClick as () => void)();
    await vi.waitFor(() => expect(onRegistered).toHaveBeenCalledTimes(2));

    const biliArgs = registerCalls()[2]?.[1] as { commandId: string; body: Record<string, unknown> };
    expect(biliArgs.body).toMatchObject({
      command: 'accounts',
      action: 'registerAccount',
      platform: BILIBILI_PLATFORM_ID,
      connector: BILIBILI_PLATFORM_ID,
      displayLabel: 'B 站官方号',
      profileRef: `profiles/account_${biliArgs.commandId}`,
    });
    expect('ownId' in biliArgs.body).toBe(false);
  } finally {
    view.unmount();
  }
});

test('WebChannelCreator retains unresolved registration across remounts and reconciles by deterministic accountRef', async () => {
  // Case A: registration committed on backend while IPC response was lost, then user closed and reopened form.
  let committedAccount: AccountSummary | null = null;
  const onRegisteredCommitted = vi.fn<(notice: string, accountRef: string) => Promise<void>>(async () => {});
  const onClose = vi.fn();
  invokeMock.mockImplementation(async (_cmd, args) => {
    const body = (args as { body?: { action?: string; accountId?: string; displayLabel?: string } })?.body;
    if (body?.action === 'listAccounts') {
      return { accounts: committedAccount ? [committedAccount] : [], schemaVersion: 4 };
    }
    if (body?.action === 'registerAccount') {
      committedAccount = {
        ...xhsAccount,
        id: body.accountId!,
        accountRef: body.accountId!,
        ownId: null,
        displayLabel: body.displayLabel!,
      };
      throw 'IPC_RESPONSE_UNKNOWN_READ_STATUS';
    }
    return {};
  });

  const firstMount = mount(WebChannelCreator, {
    runtime: 'rt-remount-committed',
    disabled: false,
    onRegistered: onRegisteredCommitted,
    onClose,
  });
  (findInputByLabel(firstMount.tree(), '展示名称').props.onChange as (e: { target: { value: string } }) => void)({
    target: { value: '小红书无ID号' },
  });
  (findButton(firstMount.tree(), '添加账号').props.onClick as () => void)();
  await vi.waitFor(() => expect(firstMount.markup()).toContain('注册结果尚未确认'));
  (findButton(firstMount.tree(), '收起').props.onClick as () => void)();
  expect(onClose).toHaveBeenCalledTimes(1);
  firstMount.unmount();

  // Reopen form -> automatically reconciles via listAccounts by deterministic accountRef without creating a duplicate.
  const reopened = mount(WebChannelCreator, {
    runtime: 'rt-remount-committed',
    disabled: false,
    onRegistered: onRegisteredCommitted,
    onClose,
  });
  try {
    await vi.waitFor(() => expect(onRegisteredCommitted).toHaveBeenCalledTimes(1));
    expect(onRegisteredCommitted.mock.calls[0]?.[1]).toBe(committedAccount!.accountRef);
    const regCalls = invokeMock.mock.calls.filter(
      c => (c[1] as { body?: { action?: string } })?.body?.action === 'registerAccount',
    );
    expect(regCalls).toHaveLength(1);
  } finally {
    reopened.unmount();
  }

  // Case B: backend did NOT commit before close/reopen -> restores draft & retries with the exact same commandId.
  invokeMock.mockReset();
  let attempt = 0;
  invokeMock.mockImplementation(async (_cmd, args) => {
    const body = (args as { body?: { action?: string; accountId?: string; displayLabel?: string } })?.body;
    if (body?.action === 'listAccounts') return { accounts: [], schemaVersion: 4 };
    if (body?.action === 'registerAccount') {
      attempt += 1;
      if (attempt === 1) throw 'IPC_RESPONSE_UNKNOWN_READ_STATUS';
      return { ...xhsAccount, id: body.accountId!, accountRef: body.accountId!, ownId: null, displayLabel: body.displayLabel! };
    }
    return {};
  });
  const onRegisteredRetry = vi.fn(async () => {});
  const mount1 = mount(WebChannelCreator, {
    runtime: 'rt-remount-retry',
    disabled: false,
    onRegistered: onRegisteredRetry,
    onClose: () => {},
  });
  (findInputByLabel(mount1.tree(), '展示名称').props.onChange as (e: { target: { value: string } }) => void)({
    target: { value: '小红书重连号' },
  });
  (findButton(mount1.tree(), '添加账号').props.onClick as () => void)();
  await vi.waitFor(() => expect(mount1.markup()).toContain('注册结果尚未确认'));
  mount1.unmount();

  const mount2 = mount(WebChannelCreator, {
    runtime: 'rt-remount-retry',
    disabled: false,
    onRegistered: onRegisteredRetry,
    onClose: () => {},
  });
  try {
    await vi.waitFor(() => expect(mount2.markup()).toContain('小红书重连号'));
    expect(mount2.markup()).toContain('注册结果尚未确认');
    (findButton(mount2.tree(), '添加账号').props.onClick as () => void)();
    await vi.waitFor(() => expect(onRegisteredRetry).toHaveBeenCalledTimes(1));
    const regCalls = invokeMock.mock.calls.filter(
      c => (c[1] as { body?: { action?: string } })?.body?.action === 'registerAccount',
    );
    expect(regCalls).toHaveLength(2);
    expect((regCalls[1]![1] as { commandId: string }).commandId).toBe(
      (regCalls[0]![1] as { commandId: string }).commandId,
    );
  } finally {
    mount2.unmount();
  }

  // Case C: empty listAccounts on remount followed by delayed backend commit stays locked onto original commandId.
  invokeMock.mockReset();
  let delayedCommitted: AccountSummary | null = null;
  const onRegisteredDelayed = vi.fn<(notice: string, accountRef: string) => Promise<void>>(async () => {});
  invokeMock.mockImplementation(async (_cmd, args) => {
    const body = (args as { body?: { action?: string; accountId?: string; displayLabel?: string } })?.body;
    if (body?.action === 'listAccounts') {
      return { accounts: delayedCommitted ? [delayedCommitted] : [], schemaVersion: 4 };
    }
    if (body?.action === 'registerAccount') {
      throw 'IPC_RESPONSE_UNKNOWN_READ_STATUS';
    }
    return {};
  });

  const delayed1 = mount(WebChannelCreator, {
    runtime: 'rt-delayed-commit',
    disabled: false,
    onRegistered: onRegisteredDelayed,
    onClose: () => {},
  });
  (findInputByLabel(delayed1.tree(), '展示名称').props.onChange as (e: { target: { value: string } }) => void)({
    target: { value: '小红书延迟号' },
  });
  (findButton(delayed1.tree(), '添加账号').props.onClick as () => void)();
  await vi.waitFor(() => expect(delayed1.markup()).toContain('注册结果尚未确认'));
  const originalArgs = invokeMock.mock.calls.find(
    c => (c[1] as { body?: { action?: string } })?.body?.action === 'registerAccount',
  )![1] as { commandId: string; body: { accountId: string; displayLabel: string } };
  delayed1.unmount();

  const delayed2 = mount(WebChannelCreator, {
    runtime: 'rt-delayed-commit',
    disabled: false,
    onRegistered: onRegisteredDelayed,
    onClose: () => {},
  });
  try {
    await vi.waitFor(() => expect(
      invokeMock.mock.calls.some(c => (c[1] as { body?: { action?: string } })?.body?.action === 'listAccounts'),
    ).toBe(true));
    // Empty list does NOT unlock inputs or replace commandId.
    expect(findInputByLabel(delayed2.tree(), '展示名称').props.disabled).toBe(true);
    expect(findButton(delayed2.tree(), '放弃重试并重置')).toBeTruthy();

    // Delayed original commit finishes on backend before retry click -> reconciles without duplicate registerAccount.
    delayedCommitted = {
      ...xhsAccount,
      id: originalArgs.body.accountId,
      accountRef: originalArgs.body.accountId,
      ownId: null,
      displayLabel: originalArgs.body.displayLabel,
    };
    (findButton(delayed2.tree(), '添加账号').props.onClick as () => void)();
    await vi.waitFor(() => expect(onRegisteredDelayed).toHaveBeenCalledTimes(1));
    expect(onRegisteredDelayed.mock.calls[0]?.[1]).toBe(originalArgs.body.accountId);
    expect(invokeMock.mock.calls.filter(
      c => (c[1] as { body?: { action?: string } })?.body?.action === 'registerAccount',
    )).toHaveLength(1);
  } finally {
    delayed2.unmount();
  }
});

test('AccountPlatformPanel distinguishes calibrated running vs closed/unverified/error/disconnected states and refreshes on browser updates', async () => {
  const onSelectWorkbenchAccount = vi.fn();
  const closedXhs: AccountSummary = {
    ...xhsAccount,
    id: 'account_xhs_closed',
    accountRef: 'account_xhs_closed',
    displayLabel: '小红书已关闭号',
  };
  const errXhs: AccountSummary = {
    ...xhsAccount,
    id: 'account_xhs_err',
    accountRef: 'account_xhs_err',
    displayLabel: '小红书状态异常号',
  };
  const disconnectedXhs: AccountSummary = {
    ...xhsAccount,
    id: 'account_xhs_disc',
    accountRef: 'account_xhs_disc',
    status: 'DISCONNECTED',
    displayLabel: '小红书已解绑号',
  };
  const closingXhs: AccountSummary = {
    ...xhsAccount,
    id: 'account_xhs_closing',
    accountRef: 'account_xhs_closing',
    status: 'DISCONNECTED',
    displayLabel: '小红书关闭中号',
  };
  let biliState = { connected: true, connectorState: 'OPEN_LAST_READ_VERIFIED', calibrated: true };
  let closingState = 'CLOSING';

  invokeMock.mockImplementation(async (_cmd, args) => {
    const body = (args as { body?: { action?: string; accountRef?: string } })?.body;
    if (body?.action === 'listAccounts') {
      return { accounts: [xhsAccount, biliAccount, closedXhs, errXhs, disconnectedXhs, closingXhs], schemaVersion: 4 };
    }
    if (body?.action === 'getAccountStatus') {
      if (body.accountRef === xhsAccount.accountRef) return { connected: false, connectorState: 'OPEN_UNVERIFIED', calibrated: false };
      if (body.accountRef === biliAccount.accountRef) return biliState;
      if (body.accountRef === closedXhs.accountRef) return { connected: false, connectorState: 'CLOSED', calibrated: true };
      if (body.accountRef === disconnectedXhs.accountRef) return { connected: false, connectorState: 'DISCONNECTED' };
      if (body.accountRef === closingXhs.accountRef) return { connected: false, connectorState: closingState };
      throw new Error('OPERATION_FAILED_PRIVATE_DIAGNOSTICS');
    }
    if (body?.action === 'disconnectAccount') {
      closingState = 'DISCONNECTED';
      return { ...closingXhs, status: 'DISCONNECTED' };
    }
    return {};
  });

  const panelElement = AccountPlatformPanel({
    status: baseStatus(),
    busy: '',
    onSelectWorkbenchAccount,
  });
  const PanelComponent = (isValidElement(panelElement) && typeof panelElement.type === 'function'
    ? panelElement.type
    : AccountPlatformPanel) as (props: Record<string, unknown>) => ReactNode;
  const panelProps = (isValidElement<Record<string, unknown>>(panelElement)
    ? panelElement.props
    : { status: baseStatus(), busy: '', onSelectWorkbenchAccount }) as Record<string, unknown>;
  const panel = mount(PanelComponent, panelProps);
  try {
    await vi.waitFor(() => expect(panel.markup()).toContain('正在关闭'));
    const html = panel.markup();
    expect(platformNames[XIAOHONGSHU_PLATFORM_ID]).toBe('小红书');
    expect(platformNames[BILIBILI_PLATFORM_ID]).toBe('B 站');
    expect(html).toContain('添加小红书 / B 站账号');
    expect(html).toContain('小红书客服主号 · 小红书');
    expect(html).toContain('B 站官方号 · B 站');
    expect(html).toContain('已打开 · 待身份核验');
    expect(html).toContain('未校准真实页 · 仅离线验证禁发');
    expect(html).toContain('后台静音运行');
    expect(html).toContain('已关闭');
    expect(html).toContain('状态读取失败');
    expect(html).toContain('重试关闭');

    const closedIdx = html.indexOf('小红书已关闭号');
    const errIdx = html.indexOf('小红书状态异常号');
    const discIdx = html.indexOf('小红书已解绑号');
    const closingIdx = html.indexOf('小红书关闭中号');
    expect(html.slice(closedIdx, errIdx)).not.toContain('后台静音运行');
    expect(html.slice(errIdx, discIdx)).not.toContain('未校准真实页');
    expect(html.slice(errIdx, discIdx)).not.toContain('后台静音运行');
    expect(html.slice(discIdx, closingIdx)).toContain('校准状态未知');
    expect(html.slice(discIdx, closingIdx)).not.toContain('未校准真实页');
    expect(html.slice(closingIdx)).toContain('正在关闭');
    expect(html.slice(closingIdx)).not.toContain('重新启用');

    // Retry disconnect completes shutdown and restores 重新启用.
    (findButton(panel.tree(), '重试关闭').props.onClick as () => void)();
    await vi.waitFor(() => expect(panel.markup()).not.toContain('重试关闭'));
    expect(panel.markup()).toContain('已完成关闭并清理该账号运行实例');

    // Browser lifecycle status change triggers web status refresh without manual panel refresh.
    biliState = { connected: false, connectorState: 'CLOSED', calibrated: true };
    panel.updateProps({
      ...panelProps,
      status: baseStatus({ browser: { state: 'CLOSED', mode: 'headless', loginRecovery: false, version: '130.0' } }),
    });
    await vi.waitFor(() => {
      const updated = panel.markup();
      const biliIdx = updated.indexOf('B 站官方号');
      const nextIdx = updated.indexOf('小红书已关闭号');
      expect(updated.slice(biliIdx, nextIdx)).toContain('已关闭');
      expect(updated.slice(biliIdx, nextIdx)).not.toContain('后台静音运行');
    });

    (findButton(panel.tree(), '添加小红书 / B 站账号').props.onClick as () => void)();
    expect(panel.markup()).toContain('选择网页渠道平台');
  } finally {
    panel.unmount();
  }
});

test('Parent list refresh reconciles locked unresolved registration in sync with open WebChannelCreator', async () => {
  clearPendingWebRegistration('rt-parent-sync');
  let committed: AccountSummary | null = null;
  invokeMock.mockImplementation(async (_cmd, args) => {
    const body = (args as { body?: { action?: string; accountId?: string; displayLabel?: string } })?.body;
    if (body?.action === 'listAccounts') return { accounts: committed ? [committed] : [], schemaVersion: 4 };
    if (body?.action === 'registerAccount') {
      committed = {
        ...xhsAccount,
        id: body.accountId!,
        accountRef: body.accountId!,
        ownId: null,
        displayLabel: body.displayLabel!,
      };
      throw 'IPC_RESPONSE_UNKNOWN_READ_STATUS';
    }
    return {};
  });

  const onReg = vi.fn<(notice: string, accountRef: string) => Promise<void>>(async () => {});
  const creator = mount(WebChannelCreator, { runtime: 'rt-parent-sync', disabled: false, onRegistered: onReg, onClose: () => {} });
  try {
    (findInputByLabel(creator.tree(), '展示名称').props.onChange as (e: { target: { value: string } }) => void)({ target: { value: '小红书联动号' } });
    (findButton(creator.tree(), '添加账号').props.onClick as () => void)();
    await vi.waitFor(() => expect(creator.markup()).toContain('注册结果尚未确认'));
    expect(findInputByLabel(creator.tree(), '展示名称').props.disabled).toBe(true);

    // Parent refresh reconciles and clears shared pending entry -> open form unlocks in sync, zero duplicate submit.
    clearPendingWebRegistration('rt-parent-sync');
    await vi.waitFor(() => expect(findInputByLabel(creator.tree(), '展示名称').props.disabled).toBe(false));
    expect(creator.markup()).not.toContain('注册结果尚未确认');
    expect(invokeMock.mock.calls.filter(c => (c[1] as { body?: { action?: string } })?.body?.action === 'registerAccount')).toHaveLength(1);
  } finally {
    creator.unmount();
  }
});

test('AccountsView handles closed/unverified/unavailable/emergency-stopped/error states without Douyin text or jargon', async () => {
  const xhsActive = {
    accountRef: xhsAccount.accountRef,
    displayLabel: xhsAccount.displayLabel,
    platform: XIAOHONGSHU_PLATFORM_ID,
  };
  const extractWebCard = (html: string) => {
    const start = html.indexOf('小红书通道状态');
    const end = html.indexOf('最近同步状态');
    return html.slice(start, end);
  };

  for (const scenario of [
    {
      label: 'closed-calibrated',
      response: { connected: false, connectorState: 'CLOSED', calibrated: true },
      emergencyStopped: false,
      expectCardText: '已关闭',
      forbidRunning: true,
      forbidSuccessBadge: true,
      forbidUncalibrated: true,
    },
    {
      label: 'open-unverified',
      response: { connected: false, connectorState: 'OPEN_UNVERIFIED', calibrated: true },
      emergencyStopped: false,
      expectCardText: '已打开 · 待身份核验',
      forbidRunning: true,
      forbidSuccessBadge: true,
      forbidUncalibrated: true,
    },
    {
      label: 'disconnected',
      response: { connected: false, connectorState: 'DISCONNECTED', calibrated: true },
      emergencyStopped: false,
      expectCardText: '未连接',
      forbidRunning: true,
      forbidSuccessBadge: true,
      forbidUncalibrated: true,
    },
    {
      label: 'unavailable',
      response: { connected: false, connectorState: 'UNAVAILABLE', calibrated: false },
      emergencyStopped: false,
      expectCardText: '暂不可用',
      forbidRunning: true,
      forbidSuccessBadge: true,
      forbidUncalibrated: false,
    },
    {
      label: 'emergency-stopped',
      response: { connected: true, connectorState: 'OPEN_LAST_READ_VERIFIED', calibrated: true },
      emergencyStopped: true,
      expectCardText: '已急停',
      forbidRunning: true,
      forbidSuccessBadge: true,
      forbidUncalibrated: true,
    },
    {
      label: 'status-error',
      reject: true,
      emergencyStopped: false,
      expectCardText: '状态读取失败',
      forbidRunning: true,
      forbidSuccessBadge: true,
      forbidUncalibrated: true,
    },
    {
      label: 'verified-connected-calibrated',
      response: { connected: true, connectorState: 'OPEN_LAST_READ_VERIFIED', calibrated: true },
      emergencyStopped: false,
      expectCardText: '后台静音运行',
      forbidRunning: false,
      forbidSuccessBadge: false,
      forbidUncalibrated: true,
    },
  ]) {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (_cmd, args) => {
      const body = (args as { body?: { action?: string } })?.body;
      if (body?.action === 'getAccountStatus') {
        if (scenario.reject) throw new Error('OPERATION_FAILED_PRIVATE_DIAGNOSTICS');
        return scenario.response;
      }
      if (body?.action === 'listAccounts') return { accounts: [xhsAccount], schemaVersion: 4 };
      return {};
    });

    const view = mount(AccountsView, {
      status: baseStatus({
        account: { id: xhsAccount.accountRef, identity: 'xhs-user-1' },
        automation: {
          ...baseStatus().automation!,
          emergencyStopped: scenario.emergencyStopped,
        },
      }),
      busy: '',
      act: async () => {},
      update: () => {},
      activeAccount: xhsActive,
    });
    try {
      await vi.waitFor(() => expect(extractWebCard(view.markup())).toContain(scenario.expectCardText));
      const fullHtml = view.markup();
      const cardHtml = extractWebCard(fullHtml);
      if (scenario.forbidRunning) expect(cardHtml, scenario.label).not.toContain('后台静音运行');
      if (scenario.forbidSuccessBadge) expect(cardHtml, scenario.label).not.toContain('bg-success');
      if (scenario.forbidUncalibrated) expect(fullHtml, scenario.label).not.toContain('未校准真实页');
      expect(fullHtml).not.toContain('同步顶部通知（独立来源）');
      expect(fullHtml).not.toContain('打开登录窗口');
      expect(fullHtml).not.toContain('后台静音 Edge');
    } finally {
      view.unmount();
    }
  }

  const jargonPattern = /无头|有头|schema3|schema4|DPAPI|协议\s*v2/iu;
  const stripTags = (html: string) => html.replace(/<[^>]+>/gu, ' ');
  expect(errorMessages.PLATFORM_MAPPING_UNCALIBRATED).toBe(
    '该平台真实页面尚未完成安全校准，当前禁止发送；仅支持本地离线验证。',
  );
  expect(errorMessages.PLATFORM_MAPPING_UNCALIBRATED).not.toMatch(jargonPattern);
  expect(errorMessages.WEB_CHANNEL_NOT_CALIBRATED).not.toMatch(jargonPattern);
  expect(stripTags(renderToStaticMarkup(createElement(WebChannelCreator, {
    runtime: 'rt-jargon',
    disabled: false,
    onRegistered: async () => {},
    onClose: () => {},
  })))).not.toMatch(jargonPattern);
  expect(stripTags(renderToStaticMarkup(createElement(AccountsView, {
    status: baseStatus(),
    busy: '',
    act: async () => {},
    update: () => {},
    activeAccount: xhsActive,
    webAccountStatus: { connected: false, connectorState: 'CLOSED', calibrated: true },
  })))).not.toMatch(jargonPattern);
});
