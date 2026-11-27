import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  request, setActiveWorkbenchAccount, WECHAT_KF_PLATFORM_ID, WECOM_AIBOT_PLATFORM_ID,
  type AccountSummary, type OfficialChannelPublicConfig,
} from './api';
import { errorMessages } from './error-messages';
import { OfficialChannelCreator, OfficialChannelManagerPanel } from './OfficialChannelEditor';

const invokeMock = vi.fn<(command: string, args: unknown) => Promise<unknown>>();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args: unknown) => invokeMock(command, args),
}));

interface HookBox {
  state: <T>(initial: T) => [T, (next: T) => void];
  ref: <T>(initial: T) => { current: T };
  effect: (setup: () => () => void) => void;
}
let activeHooks: HookBox | undefined;

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    useState: <T,>(initial: T) => activeHooks ? activeHooks.state(initial) : actual.useState(initial),
    useRef: <T,>(initial: T) => activeHooks ? activeHooks.ref(initial) : actual.useRef(initial),
    useCallback: <T extends (...args: never[]) => unknown>(callback: T, deps: readonly unknown[]) =>
      activeHooks ? callback : actual.useCallback(callback, deps),
    useLayoutEffect: (setup: () => () => void, deps: readonly unknown[]) => {
      if (activeHooks) activeHooks.effect(setup);
      else actual.useLayoutEffect(setup, deps);
    },
  };
});

function mount<P>(Component: (props: P) => ReactNode, props: P) {
  const states: unknown[] = [];
  const refs: { current: unknown }[] = [];
  let cleanup: (() => void) | undefined;

  function render() {
    let sIdx = 0;
    let rIdx = 0;
    let setup: (() => () => void) | undefined;
    activeHooks = {
      state<T>(initial: T) {
        const idx = sIdx++;
        if (idx === states.length) states.push(initial);
        return [states[idx] as T, (next: T) => { states[idx] = next; }];
      },
      ref<T>(initial: T) {
        const idx = rIdx++;
        return (refs[idx] ??= { current: initial }) as { current: T };
      },
      effect(effectSetup) { setup = effectSetup; },
    };
    let tree: ReactNode;
    try {
      tree = Component(props);
    } finally {
      activeHooks = undefined;
    }
    if (!cleanup) cleanup = setup?.();
    return tree;
  }

  render();
  return {
    tree: () => render(),
    markup: () => renderToStaticMarkup(render()),
    unmount: () => cleanup?.(),
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

beforeEach(() => {
  invokeMock.mockReset();
  setActiveWorkbenchAccount(null);
});
afterEach(() => setActiveWorkbenchAccount(null));

const wecomAccount: AccountSummary = {
  id: 'account_wecom_ui',
  accountRef: 'account_wecom_ui',
  platform: WECOM_AIBOT_PLATFORM_ID,
  connector: WECOM_AIBOT_PLATFORM_ID,
  ownId: 'bot-ui-1',
  displayLabel: '企微售前机器人',
  status: 'ACTIVE',
  profileRef: 'account_wecom_ui',
  capabilities: {
    channels: ['DIRECT_MESSAGE'],
    loginRecovery: false,
    manualSecurityRecovery: false,
    preview: false,
    readback: false,
    transport: 'official_api',
  },
  autoReplyEnabled: false,
  createdAt: '2026-11-27',
  updatedAt: '2026-11-27',
};

const wecomPublicConfig: OfficialChannelPublicConfig = {
  accountRef: 'account_wecom_ui',
  platform: WECOM_AIBOT_PLATFORM_ID,
  botId: 'bot-ui-1',
  wsUrl: null,
  allowGroupMessages: true,
  credentialStorage: 'DPAPI',
  secretConfigured: true,
  credentialError: null,
  connected: false,
  transportStatus: null,
  updatedAt: '2026-11-27T08:00:00Z',
};

test('OfficialChannelCreator registers WeCom AI Bot, reuses commandId on unconfirmed retry, clears secrets on platform switch', async () => {
  const onRegistered = vi.fn(async () => {});
  const onClose = vi.fn();
  invokeMock
    .mockRejectedValueOnce('IPC_RESPONSE_UNKNOWN_READ_STATUS')
    .mockResolvedValueOnce(wecomAccount)
    .mockResolvedValueOnce(wecomPublicConfig);

  const view = mount(OfficialChannelCreator, { disabled: false, onRegistered, onClose });
  try {
    (findInputByLabel(view.tree(), '机器人 ID').props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: 'bot-ui-1' },
    });
    (findInputByLabel(view.tree(), '机器人 Secret').props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: 'ui-secret-value' },
    });

    // First attempt times out -> preserves commandId for safe retry
    (findButton(view.tree(), '添加并保存配置').props.onClick as () => void)();
    await vi.waitFor(() => expect(view.markup()).toContain('注册结果尚未确认'));
    const firstCall = invokeMock.mock.calls[0]?.[1] as { commandId: string };

    // Retry reuses the exact same commandId & deterministic accountId
    (findButton(view.tree(), '添加并保存配置').props.onClick as () => void)();
    await vi.waitFor(() => expect(onRegistered).toHaveBeenCalledTimes(1));
    const retryCall = invokeMock.mock.calls[1]?.[1] as { commandId: string };
    expect(retryCall.commandId).toBe(firstCall.commandId);
    expect(findInputByLabel(view.tree(), '机器人 Secret').props.value).toBe('');

    // Switching platform clears draft secret
    (findInputByLabel(view.tree(), '机器人 Secret').props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: 'temp-secret' },
    });
    const kfSwitch = findElements(view.tree(), el => el.type === 'button' && textOf(el).includes('微信客服'))[0]!;
    (kfSwitch.props.onClick as () => void)();
    const wecomSwitch = findElements(view.tree(), el => el.type === 'button' && textOf(el).includes('企业微信智能机器人'))[0]!;
    (wecomSwitch.props.onClick as () => void)();
    expect(findInputByLabel(view.tree(), '机器人 Secret').props.value).toBe('');
  } finally {
    view.unmount();
  }
});

test('OfficialChannelManagerPanel locks bound BotID, clears secret on cancel, connects/observes/disconnects', async () => {
  const onUpdated = vi.fn(async () => {});
  const onOpenWorkbench = vi.fn();
  const connectedConfig: OfficialChannelPublicConfig = {
    ...wecomPublicConfig,
    connected: true,
    transportStatus: {
      transport: 'official_api',
      state: 'CONNECTED',
      protocol: 'wecom_ws',
      endpointDigest: 'a'.repeat(16),
      lastHeartbeatAt: Date.parse('2026-11-27T08:05:00Z'),
      lastSyncAt: null,
      errorCode: null,
    },
  };
  invokeMock
    .mockResolvedValueOnce(wecomPublicConfig)
    .mockResolvedValueOnce(connectedConfig)
    .mockResolvedValueOnce({ ok: true })
    .mockResolvedValueOnce(connectedConfig)
    .mockResolvedValueOnce(wecomPublicConfig);

  const view = mount(OfficialChannelManagerPanel, {
    account: wecomAccount,
    disabled: false,
    emergencyStopped: false,
    onUpdated,
    onOpenWorkbench,
  });
  try {
    await vi.waitFor(() => expect(view.markup()).toContain('本机加密保存（重启保留）'));
    (findButton(view.tree(), '修改配置与凭据').props.onClick as () => void)();
    expect(findInputByLabel(view.tree(), '机器人 ID').props.disabled).toBe(true);
    (findInputByLabel(view.tree(), '更新机器人 Secret').props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: 'unsaved-secret' },
    });
    (findButton(view.tree(), '取消').props.onClick as () => void)();
    (findButton(view.tree(), '修改配置与凭据').props.onClick as () => void)();
    expect(findInputByLabel(view.tree(), '更新机器人 Secret').props.value).toBe('');
    (findButton(view.tree(), '收起配置').props.onClick as () => void)();

    (findButton(view.tree(), '进入工作台查看会话').props.onClick as () => void)();
    expect(onOpenWorkbench).toHaveBeenCalledTimes(1);

    (findButton(view.tree(), '连接通道').props.onClick as () => void)();
    await vi.waitFor(() => expect(view.markup()).toContain('已连接'));

    (findButton(view.tree(), '立即拉取消息').props.onClick as () => void)();
    await vi.waitFor(() => expect(view.markup()).toContain('已完成一次消息拉取'));

    (findButton(view.tree(), '断开连接').props.onClick as () => void)();
    await vi.waitFor(() => expect(view.markup()).toContain('已断开渠道连接'));
  } finally {
    view.unmount();
  }
});

test('setActiveWorkbenchAccount routes everyday reads and writes via Protocol V2 ACCOUNT scope and resets cleanly', async () => {
  invokeMock.mockResolvedValue({ ok: true });
  setActiveWorkbenchAccount({
    accountRef: wecomAccount.accountRef,
    displayLabel: wecomAccount.displayLabel,
    platform: WECOM_AIBOT_PLATFORM_ID,
  });
  await request({ command: 'getInbox', channel: 'ALL', status: 'ALL', page: 0 });
  expect(invokeMock).toHaveBeenLastCalledWith('client_request_v2', {
    scope: { kind: 'ACCOUNT', accountRef: wecomAccount.accountRef },
    body: { command: 'getInbox', channel: 'ALL', status: 'ALL', page: 0 },
  });
  await request({ command: 'markInboxRead' });
  expect(invokeMock).toHaveBeenLastCalledWith('client_request_v2', expect.objectContaining({
    scope: { kind: 'ACCOUNT', accountRef: wecomAccount.accountRef },
    body: { command: 'markInboxRead' },
    commandId: expect.any(String),
  }));
  await request({ command: 'emergencyStop' });
  expect(invokeMock).toHaveBeenLastCalledWith('client_request', { body: { command: 'emergencyStop' } });

  const html = renderToStaticMarkup(createElement(OfficialChannelCreator, {
    disabled: false, onRegistered: async () => {}, onClose: () => {},
  }));
  expect(html).not.toContain('schema4');
  expect(errorMessages.ACCOUNT_IDENTITY_IMMUTABLE).toBeTruthy();
  expect(errorMessages.WECOM_WS_ENDPOINT_SSRF_BLOCKED).toBeTruthy();
  expect(WECHAT_KF_PLATFORM_ID).toBe('wechat-kf');
});
