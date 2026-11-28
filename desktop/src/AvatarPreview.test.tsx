import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_ACCOUNT_ID, WECOM_AIBOT_PLATFORM_ID } from '../../src/contracts/account.js';
import { DEFAULT_ACCOUNT_AI_FEATURES, type AccountAiFeatures } from '../../src/contracts/ai-runtime.js';

interface HookDispatcher {
  useState: <T>(initial: T | (() => T)) => [T, (next: T | ((prev: T) => T)) => void];
  useRef: <T>(initial: T) => { current: T };
  useEffect: (fn: () => (() => void) | void, deps?: readonly unknown[]) => void;
}
let activeHooks: HookDispatcher | null = null;
const invokeMock = vi.fn<(command: string, args: unknown) => Promise<unknown>>();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args: unknown) => invokeMock(command, args),
}));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    useState: <T,>(initial: T | (() => T)) =>
      activeHooks ? activeHooks.useState(initial) : actual.useState(initial),
    useRef: <T,>(initial: T) =>
      activeHooks ? activeHooks.useRef(initial) : actual.useRef(initial),
    useEffect: (fn: () => (() => void) | void, deps?: readonly unknown[]) =>
      activeHooks ? activeHooks.useEffect(fn, deps) : actual.useEffect(fn, deps),
    useLayoutEffect: (fn: () => (() => void) | void, deps?: readonly unknown[]) =>
      activeHooks ? activeHooks.useEffect(fn, deps) : actual.useLayoutEffect(fn, deps),
  };
});

import { reasons, setActiveWorkbenchAccount, type Inbox, type Status, type Thread } from './api';
import { AccountAvatarSyncCard } from './components/AccountAvatarSyncCard';
import { AutoReplySwitch } from './components/AutoReplySwitch';
import { CachedAvatar } from './components/CachedAvatar';
import { Button } from './components/ui/button';
import { DirectMessageChat } from './DirectMessageChat';
import { explain } from './error-messages';
import { InboxList } from './InboxList';
import { ReplyDetail } from './ReplyDetail';
import { clearAvatarPreviewCache, resetAvatarPreviewCache, sanitizeAvatarDataUrl } from './useAvatarPreview';
import { AccountsView } from './views/AccountsView';

function mountComponent<P>(Component: (props: P) => ReactNode, initialProps: P) {
  let currentProps = initialProps;
  const states: unknown[] = [];
  const refs: { current: unknown }[] = [];
  const effects: { deps?: readonly unknown[]; cleanup?: (() => void) | void }[] = [];
  let tree: ReactNode = null;
  let rendering = false;
  let needsRerender = false;
  const sameDeps = (a?: readonly unknown[], b?: readonly unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((item, index) => Object.is(item, b[index]));

  const render = () => {
    if (rendering) {
      needsRerender = true;
      return;
    }
    rendering = true;
    try {
      for (let pass = 0; pass < 10; pass++) {
        needsRerender = false;
        let stateIdx = 0;
        let refIdx = 0;
        let effectIdx = 0;
        const pendingEffects: { idx: number; fn: () => (() => void) | void; deps?: readonly unknown[] }[] = [];
        activeHooks = {
          useState: <T,>(initial: T | (() => T)) => {
            const idx = stateIdx++;
            if (idx >= states.length) {
              states.push(typeof initial === 'function' ? (initial as () => T)() : initial);
            }
            const setter = (next: T | ((prev: T) => T)) => {
              const prev = states[idx] as T;
              const value = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
              if (!Object.is(prev, value)) {
                states[idx] = value;
                render();
              }
            };
            return [states[idx] as T, setter];
          },
          useRef: <T,>(initial: T) => {
            const idx = refIdx++;
            if (idx >= refs.length) refs.push({ current: initial });
            return refs[idx] as { current: T };
          },
          useEffect: (fn, deps) => {
            const idx = effectIdx++;
            pendingEffects.push({ idx, fn, deps });
          },
        };
        try {
          tree = Component(currentProps);
        } finally {
          activeHooks = null;
        }
        for (const item of pendingEffects) {
          const previous = effects[item.idx];
          if (!previous || !item.deps || !sameDeps(previous.deps, item.deps)) {
            previous?.cleanup?.();
            const cleanup = item.fn();
            effects[item.idx] = { deps: item.deps, cleanup };
          }
        }
        if (!needsRerender) break;
      }
    } finally {
      rendering = false;
    }
  };

  render();
  return {
    getTree: () => tree,
    markup: () => renderToStaticMarkup(tree),
    updateProps: (nextProps: P) => {
      currentProps = nextProps;
      render();
    },
    unmount: () => {
      for (const item of effects) item?.cleanup?.();
    },
  };
}

function findAll(
  node: ReactNode,
  predicate: (el: ReactElement<Record<string, unknown>>) => boolean,
  out: ReactElement<Record<string, unknown>>[] = [],
): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, predicate, out);
    return out;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return out;
  if (predicate(node)) out.push(node);
  for (const value of Object.values(node.props)) {
    if (value !== null && (typeof value === 'object' || Array.isArray(value))) {
      findAll(value as ReactNode, predicate, out);
    }
  }
  return out;
}

function baseStatus(overrides: Partial<Status> = {}): Status {
  return {
    runtime: 'synthetic-m5',
    account: { id: DEFAULT_ACCOUNT_ID, identity: 'own-m5' },
    operator: { id: 'op-1', permissions: ['READ', 'EDIT', 'SEND', 'CONTROL'], expiresAt: Date.now() + 60_000 },
    mode: 'LIMITED_AUTO',
    configuredMode: 'LIMITED_AUTO',
    paused: false,
    browser: { state: 'OPEN_LAST_READ_VERIFIED', mode: 'headless', loginRecovery: false, version: '130.0' },
    lastSync: [{ channel: 'DIRECT_MESSAGE', at: '2026-11-27T10:00:00Z' }],
    capabilities: [{ channel: 'DIRECT_MESSAGE', state: 'SEND_AVAILABLE', reason: '', evidence: 'ok' }],
    budgets: [
      { kind: 'SEND', used: 18, maximum: 100 },
      { kind: 'MODEL', used: 42, maximum: 500 },
    ],
    usage: { requests: 42, inputTokens: 12000, outputTokens: 3400, unresolved: 0 },
    settings: { model: 'deepseek-chat', persona: '', business: '', rules: '' },
    keyPresent: true,
    modelAuthorized: true,
    modelBusy: false,
    automation: {
      startedAt: 1794054761443,
      emergencyStopped: false,
      collection: { ownId: 'own-m5', comments: true, inbox: true, commentIntervalMs: 30_000, dmIntervalMs: 15_000 },
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

const VALID_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('Milestone 5: Safe local avatar preview & per-account sync toggle', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    clearAvatarPreviewCache();
    setActiveWorkbenchAccount(null);
  });

  afterEach(() => {
    activeHooks = null;
    clearAvatarPreviewCache();
    setActiveWorkbenchAccount(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('useAvatarPreview binds explicit accountRef via requestV2, ignores stale responses, expires misses after TTL, and rejects non-ASCII/oversized URLs', async () => {
    expect(sanitizeAvatarDataUrl(VALID_PNG_DATA_URL)).toBe(VALID_PNG_DATA_URL);
    expect(sanitizeAvatarDataUrl('https://evil.example.com/avatar.png')).toBeNull();
    expect(sanitizeAvatarDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
    expect(sanitizeAvatarDataUrl('data:image/png;base64,AAAA\u200bAAAA')).toBeNull();
    expect(sanitizeAvatarDataUrl('data:image/png;base64,ſAAA')).toBeNull();
    expect(sanitizeAvatarDataUrl(`data:image/png;base64,${'A'.repeat(360_005)}`)).toBeNull();

    let nowMs = 1_795_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    let resolveSlowPrimary!: (val: unknown) => void;
    let missCalls = 0;

    invokeMock.mockImplementation(async (cmd, args) => {
      const payload = args as {
        scope?: { kind: string; accountRef?: string };
        body?: { command?: string; role?: string; key?: string };
      };
      if (payload.body?.command === 'getAvatarPreview' && payload.body.key === 'peer-slow') {
        return new Promise((resolve) => {
          resolveSlowPrimary = resolve;
        });
      }
      if (payload.body?.command === 'getAvatarPreview' && payload.body.key === 'peer-ttl') {
        missCalls += 1;
        if (missCalls === 1) {
          return { found: false, dataUrl: null, mimeType: null, bytes: 0, sha256: null };
        }
        return { found: true, dataUrl: VALID_PNG_DATA_URL, mimeType: 'image/png', bytes: 68, sha256: 'a'.repeat(64) };
      }
      if (cmd === 'client_request_v2' && payload.scope?.accountRef === 'account_wecom' && payload.body?.key === 'peer-wecom') {
        return { found: true, dataUrl: VALID_PNG_DATA_URL, mimeType: 'image/png', bytes: 68, sha256: 'b'.repeat(64) };
      }
      return { found: false, dataUrl: null, mimeType: null, bytes: 0, sha256: null };
    });

    const wecomAvatar = mountComponent(CachedAvatar, {
      role: 'CUSTOMER',
      avatarKey: 'peer-wecom',
      accountRef: 'account_wecom',
      fallbackText: '企',
    });
    try {
      await vi.waitFor(() => {
        expect(wecomAvatar.markup()).toContain(VALID_PNG_DATA_URL);
      });
      expect(invokeMock).toHaveBeenCalledWith('client_request_v2', {
        scope: { kind: 'ACCOUNT', accountRef: 'account_wecom' },
        body: { command: 'getAvatarPreview', role: 'CUSTOMER', key: 'peer-wecom' },
      });
    } finally {
      wecomAvatar.unmount();
    }

    const slowAvatar = mountComponent(CachedAvatar, {
      role: 'CUSTOMER',
      avatarKey: 'peer-slow',
      accountRef: DEFAULT_ACCOUNT_ID,
      fallbackText: '慢',
    });
    try {
      await vi.waitFor(() => expect(resolveSlowPrimary).toBeTypeOf('function'));
      clearAvatarPreviewCache();
      resolveSlowPrimary({ found: true, dataUrl: VALID_PNG_DATA_URL, mimeType: 'image/png', bytes: 68, sha256: 'c'.repeat(64) });
      await Promise.resolve();
      await Promise.resolve();
      expect(slowAvatar.markup()).not.toContain(VALID_PNG_DATA_URL);
      expect(slowAvatar.markup()).toContain('>慢<');
    } finally {
      slowAvatar.unmount();
    }

    // Mounted miss retries automatically after 30s TTL expiry without unmounting
    vi.useFakeTimers();
    const mountedTtl = mountComponent(CachedAvatar, {
      role: 'CUSTOMER',
      avatarKey: 'peer-ttl',
      accountRef: DEFAULT_ACCOUNT_ID,
      fallbackText: '新',
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(missCalls).toBe(1);
      expect(mountedTtl.markup()).toContain('>新<');

      // Before 30s: still cached as miss
      await vi.advanceTimersByTimeAsync(15_000);
      expect(missCalls).toBe(1);

      // Past 30s TTL: mounted timer triggers re-fetch and updates rendered image
      await vi.advanceTimersByTimeAsync(16_000);
      expect(missCalls).toBe(2);
      expect(mountedTtl.markup()).toContain(VALID_PNG_DATA_URL);
    } finally {
      mountedTtl.unmount();
      vi.useRealTimers();
    }

    // InboxList, ReplyDetail, and DirectMessageChat use identical fallback key when actorId is absent
    const dmInbox: Inbox = {
      total: 1,
      unreadTotal: 1,
      page: 0,
      pageSize: 20,
      items: [
        {
          id: 'ev-dm-1',
          status: 'AWAITING_DRAFT',
          replyStatus: 'WAITING',
          unread: true,
          channel: 'DIRECT_MESSAGE',
          author: '匿名买家',
          actorId: null,
          targetKey: 'dm:conv-99',
          preview: '请问发货了吗',
          time: '2026-11-27T10:00:00Z',
          source: 'DIRECT_MESSAGE',
        },
      ],
    };
    const inboxView = mountComponent(InboxList, {
      inbox: dmInbox,
      accountRef: 'account_wecom',
      selected: null,
      channel: 'ALL',
      setChannel: () => {},
      filter: 'ALL',
      setFilter: () => {},
      pageNumber: 0,
      setPageNumber: () => {},
      choose: () => {},
      markRead: () => {},
      markingRead: false,
    });
    const inboxAvatars = findAll(inboxView.getTree(), el => el.type === CachedAvatar);
    expect(inboxAvatars[0]!.props.avatarKey).toBe('dm:conv-99');
    expect(inboxAvatars[0]!.props.accountRef).toBe('account_wecom');
    inboxView.unmount();

    const dmThread: Thread = {
      replyStatus: 'WAITING',
      controlledTrial: false,
      workUrl: null,
      groupKey: 'hashed-dm-group-key',
      event: {
        id: '930bfc79-03e3-4006-bd73-6c7e29596312',
        binding: 'synthetic-binding',
        status: 'AWAITING_DRAFT',
        payload: {
          accountId: 'account_wecom',
          channel: 'DIRECT_MESSAGE',
          platformEventId: 'evt-dm-1',
          actorId: null,
          actorName: '匿名买家',
          text: '请问发货了吗',
          occurredAt: '2026-11-27T10:00:00Z',
          videoId: null,
          commentId: null,
          conversationId: 'conv-99',
          direction: 'INCOMING',
          kind: 'DM',
          evidenceId: 'ev',
          discovery: 'DIRECT_MESSAGE',
        },
      },
      draft: null,
      history: [],
      contextVersion: '0'.repeat(64),
      ownership: { operator_id: 'op-1', generation: 1, lease_expires_at: Date.now() + 60_000, isMine: true },
      capability: { state: 'SEND_AVAILABLE', reason: '', evidence: 'synthetic' },
      strong: true,
      paused: false,
      frozen: false,
      intent: null,
      receipt: null,
      suggestions: [],
    };
    const dmDetailView = mountComponent(ReplyDetail, {
      detailElement: { current: null },
      dialogElement: { current: null },
      thread: dmThread,
      status: baseStatus(),
      setStatus: () => {},
      selected: dmThread.event.id,
      choose: () => {},
      busy: '',
      act: async (_l, fn) => fn(),
      setNotice: () => {},
      openDialog: async () => {},
      closeDialog: async () => {},
      readOnly: false,
      localDraft: false,
      saving: false,
      dirty: false,
      error: '',
      notice: '',
      text: '',
      setText: () => {},
      setSuggestionId: () => {},
      refreshThread: async () => {},
      block: '',
      send: null,
      sendCurrentText: async () => {},
    });
    expect(dmDetailView.getTree()).toBeTruthy();
    const dmChatView = mountComponent(DirectMessageChat, {
      detailElement: { current: null },
      dialogElement: { current: null },
      thread: {
        ...dmThread,
        timeline: {
          items: [
            {
              id: 'tl-1',
              eventId: dmThread.event.id,
              direction: 'INCOMING',
              text: '请问发货了吗',
              occurredAt: '2026-11-27T10:00:00Z',
              historical: false,
              origin: 'OBSERVED',
              attachments: [],
            },
          ],
          pageSize: 30,
          hasMore: false,
          before: null,
        },
      },
      status: baseStatus(),
      setStatus: () => {},
      selected: dmThread.event.id,
      choose: () => {},
      busy: '',
      act: async (_l, fn) => fn(),
      setNotice: () => {},
      openDialog: async () => {},
      closeDialog: async () => {},
      readOnly: false,
      localDraft: false,
      saving: false,
      dirty: false,
      error: '',
      notice: '',
      text: '',
      setText: () => {},
      setSuggestionId: () => {},
      refreshThread: async () => {},
      block: '',
      send: null,
      sendCurrentText: async () => {},
    });
    const dmChatAvatars = findAll(dmChatView.getTree(), el => el.type === CachedAvatar);
    expect(dmChatAvatars).toHaveLength(2);
    for (const av of dmChatAvatars) {
      expect(av.props.avatarKey).toBe('dm:conv-99');
      expect(av.props.accountRef).toBe('account_wecom');
    }
    dmDetailView.unmount();
    dmChatView.unmount();

    const commentThread: Thread = {
      replyStatus: 'WAITING',
      controlledTrial: false,
      workUrl: null,
      groupKey: 'hashed-comment-group-key',
      event: {
        id: '930bfc79-03e3-4006-bd73-6c7e29596311',
        binding: 'synthetic-binding',
        status: 'AWAITING_DRAFT',
        payload: {
          accountId: 'account_wecom',
          channel: 'COMMENT_NOTIFICATION',
          platformEventId: 'evt-1',
          actorId: null,
          actorName: '林小鹿',
          text: '请问怎么买',
          occurredAt: '2026-11-27T10:00:00Z',
          videoId: 'video-1',
          commentId: 'comment-1',
          conversationId: null,
          direction: 'INCOMING',
          kind: 'COMMENT',
          evidenceId: 'ev',
          discovery: 'NOTIFICATION',
        },
      },
      draft: null,
      history: [],
      contextVersion: '0'.repeat(64),
      ownership: { operator_id: 'op-1', generation: 1, lease_expires_at: Date.now() + 60_000, isMine: true },
      capability: { state: 'SEND_AVAILABLE', reason: '', evidence: 'synthetic' },
      strong: true,
      paused: false,
      frozen: false,
      intent: null,
      receipt: null,
      suggestions: [],
    };
    const detailView = mountComponent(ReplyDetail, {
      detailElement: { current: null },
      dialogElement: { current: null },
      thread: commentThread,
      status: baseStatus(),
      setStatus: () => {},
      selected: commentThread.event.id,
      choose: () => {},
      busy: '',
      act: async (_l, fn) => fn(),
      setNotice: () => {},
      openDialog: async () => {},
      closeDialog: async () => {},
      readOnly: false,
      localDraft: false,
      saving: false,
      dirty: false,
      error: '',
      notice: '',
      text: '',
      setText: () => {},
      setSuggestionId: () => {},
      refreshThread: async () => {},
      block: '',
      send: null,
      sendCurrentText: async () => {},
    });
    const detailAvatars = findAll(detailView.getTree(), el => el.type === CachedAvatar);
    expect(detailAvatars[0]!.props.avatarKey).toBe('comment:video-1:comment-1');
    expect(detailAvatars[0]!.props.accountRef).toBe('account_wecom');
    detailView.unmount();
  });

  test('AccountsView & AccountAvatarSyncCard bind explicit accountRef, use atomic setSyncCustomerAvatars patch, and disable offline official channels', async () => {
    const existingFeatures: AccountAiFeatures = {
      ...DEFAULT_ACCOUNT_AI_FEATURES,
      visionEnabled: true,
      mediaReplyEnabled: true,
      enabledBusinessTools: ['query_order_status'],
      toolEndpoints: { query_order_status: 'https://api.example.com/orders' },
      syncCustomerAvatars: false,
    };

    const primaryAccountsView = mountComponent(AccountsView, {
      status: baseStatus({ account: { id: 'account_wecom', identity: 'bot-stale' } }),
      busy: '',
      act: async (_label, fn) => fn(),
      update: () => {},
      activeAccount: null,
    });
    const primarySyncCard = findAll(primaryAccountsView.getTree(), el => el.type === AccountAvatarSyncCard)[0];
    expect(primarySyncCard!.props.accountRef).toBe(DEFAULT_ACCOUNT_ID);
    expect(primarySyncCard!.props.offline).toBe(false);
    primaryAccountsView.unmount();

    const offlineOfficialView = mountComponent(AccountsView, {
      status: baseStatus({ account: { id: 'account_wecom', identity: 'bot-1' } }),
      busy: '',
      act: async (_label, fn) => fn(),
      update: () => {},
      activeAccount: {
        accountRef: 'account_wecom',
        displayLabel: '企微机器人',
        platform: WECOM_AIBOT_PLATFORM_ID,
      },
      officialAccountStatus: { connected: false, connectorState: 'DISCONNECTED' },
    });
    const offlineSyncCard = findAll(offlineOfficialView.getTree(), el => el.type === AccountAvatarSyncCard)[0];
    expect(offlineSyncCard!.props.accountRef).toBe('account_wecom');
    expect(offlineSyncCard!.props.offline).toBe(true);
    offlineOfficialView.unmount();

    invokeMock.mockImplementation(async (_cmd, args) => {
      const payload = args as {
        scope?: { kind: string; accountRef?: string };
        body?: { command?: string; action?: string; enabled?: boolean };
      };
      if (payload.body?.command === 'accountAiFeatures' && payload.body.action === 'get') {
        return existingFeatures;
      }
      if (payload.body?.command === 'accountAiFeatures' && payload.body.action === 'setSyncCustomerAvatars') {
        return { ...existingFeatures, syncCustomerAvatars: Boolean(payload.body.enabled) };
      }
      return {};
    });

    const syncCardView = mountComponent(AccountAvatarSyncCard, {
      accountRef: 'account_wecom',
      accountLabel: '企微机器人',
      disabled: false,
      offline: false,
    });
    try {
      await vi.waitFor(() => {
        const sw = findAll(syncCardView.getTree(), el => el.type === AutoReplySwitch)[0];
        expect(sw?.props.disabled).toBe(false);
      });

      const switchEl = findAll(syncCardView.getTree(), el => el.type === AutoReplySwitch)[0];
      (switchEl!.props.onChange as (checked: boolean) => void)(true);

      await vi.waitFor(() => {
        expect(
          invokeMock.mock.calls.some(
            ([cmd, args]) =>
              cmd === 'client_request_v2' &&
              (args as { body?: { action?: string } })?.body?.action === 'setSyncCustomerAvatars',
          ),
        ).toBe(true);
      });

      const patchCall = invokeMock.mock.calls.find(
        ([cmd, args]) =>
          cmd === 'client_request_v2' &&
          (args as { body?: { action?: string } })?.body?.action === 'setSyncCustomerAvatars',
      );
      expect(patchCall![1]).toMatchObject({
        scope: { kind: 'ACCOUNT', accountRef: 'account_wecom' },
        body: { command: 'accountAiFeatures', action: 'setSyncCustomerAvatars', enabled: true },
      });
      expect(syncCardView.markup()).toContain('已开启当前账号「同步采集客户头像」');

      // Turning off customer sync scopes reset ONLY to CUSTOMER for that account, keeping mounted ACCOUNT avatar intact
      invokeMock.mockImplementation(async (cmd, args) => {
        const payload = args as { scope?: { accountRef?: string }; body?: { command?: string; role?: string; action?: string; enabled?: boolean } };
        if (payload.body?.command === 'getAvatarPreview' && payload.body.role === 'ACCOUNT') {
          return { found: true, dataUrl: VALID_PNG_DATA_URL, mimeType: 'image/png', bytes: 68, sha256: 'd'.repeat(64) };
        }
        if (payload.body?.command === 'accountAiFeatures' && payload.body.action === 'setSyncCustomerAvatars') {
          return { ...existingFeatures, syncCustomerAvatars: Boolean(payload.body.enabled) };
        }
        if (cmd === 'client_request_v2' && payload.body?.command === 'accountAiFeatures' && payload.body.action === 'get') {
          throw new Error('OPERATION_FAILED_PRIVATE_DIAGNOSTICS');
        }
        return {};
      });
      const accountAvatarView = mountComponent(CachedAvatar, {
        role: 'ACCOUNT',
        avatarKey: 'own-wecom',
        accountRef: 'account_wecom',
        fallbackText: '企',
      });
      await vi.waitFor(() => expect(accountAvatarView.markup()).toContain(VALID_PNG_DATA_URL));
      const previewCallsBeforeOff = invokeMock.mock.calls.filter(
        ([, a]) => (a as { body?: { command?: string } })?.body?.command === 'getAvatarPreview',
      ).length;

      const switchOff = findAll(syncCardView.getTree(), el => el.type === AutoReplySwitch)[0];
      (switchOff!.props.onChange as (checked: boolean) => void)(false);
      await vi.waitFor(() => {
        expect(syncCardView.markup()).toContain('已关闭当前账号「同步采集客户头像」');
      });
      expect(accountAvatarView.markup()).toContain(VALID_PNG_DATA_URL);
      const previewCallsAfterOff = invokeMock.mock.calls.filter(
        ([, a]) => (a as { body?: { command?: string } })?.body?.command === 'getAvatarPreview',
      ).length;
      expect(previewCallsAfterOff).toBe(previewCallsBeforeOff);
      accountAvatarView.unmount();

      // Switching to another account whose load fails must clear previous checked state, keep switch disabled, and offer retry
      syncCardView.updateProps({
        accountRef: 'account_other',
        accountLabel: '另一账号',
        disabled: false,
        offline: false,
      });
      await vi.waitFor(() => {
        expect(syncCardView.markup()).toContain('操作未能完成');
      });
      const failedSwitch = findAll(syncCardView.getTree(), el => el.type === AutoReplySwitch)[0];
      expect(failedSwitch!.props.checked).toBe(false);
      expect(failedSwitch!.props.disabled).toBe(true);
      const retryBtn = findAll(syncCardView.getTree(), el => el.type === Button)[0];
      expect(retryBtn).toBeTruthy();

      // Calling resetAvatarPreviewCache explicitly also leaves unrelated account untouched
      resetAvatarPreviewCache({ role: 'CUSTOMER', accountRef: 'account_other' });
    } finally {
      syncCardView.unmount();
    }

    // Unmounting AccountAvatarSyncCard while disabling sync is in flight still invalidates CUSTOMER cache upon save completion
    let resolveDelayedDisable!: (val: unknown) => void;
    let customerPreviewCalls = 0;
    let customerSyncEnabled = true;
    invokeMock.mockImplementation(async (_cmd, args) => {
      const payload = args as { body?: { command?: string; role?: string; action?: string; enabled?: boolean } };
      if (payload.body?.command === 'getAvatarPreview' && payload.body.role === 'CUSTOMER') {
        customerPreviewCalls += 1;
        return customerSyncEnabled
          ? { found: true, dataUrl: VALID_PNG_DATA_URL, mimeType: 'image/png', bytes: 68, sha256: 'e'.repeat(64) }
          : { found: false, dataUrl: null, mimeType: null, bytes: 0, sha256: null };
      }
      if (payload.body?.command === 'accountAiFeatures' && payload.body.action === 'get') {
        return { ...existingFeatures, syncCustomerAvatars: true };
      }
      if (payload.body?.command === 'accountAiFeatures' && payload.body.action === 'setSyncCustomerAvatars') {
        customerSyncEnabled = Boolean(payload.body.enabled);
        return new Promise((resolve) => {
          resolveDelayedDisable = resolve;
        });
      }
      return {};
    });

    const cachedCustomer = mountComponent(CachedAvatar, {
      role: 'CUSTOMER',
      avatarKey: 'peer-unmount-race',
      accountRef: 'account_wecom',
      fallbackText: '客',
    });
    await vi.waitFor(() => expect(cachedCustomer.markup()).toContain(VALID_PNG_DATA_URL));
    expect(customerPreviewCalls).toBe(1);

    const raceCard = mountComponent(AccountAvatarSyncCard, {
      accountRef: 'account_wecom',
      accountLabel: '企微机器人',
      disabled: false,
      offline: false,
    });
    await vi.waitFor(() => {
      const sw = findAll(raceCard.getTree(), el => el.type === AutoReplySwitch)[0];
      expect(sw?.props.disabled).toBe(false);
    });
    const raceSwitch = findAll(raceCard.getTree(), el => el.type === AutoReplySwitch)[0];
    (raceSwitch!.props.onChange as (checked: boolean) => void)(false);
    await vi.waitFor(() => expect(resolveDelayedDisable).toBeTypeOf('function'));

    // Navigate away (unmount card) BEFORE the disable save resolves
    raceCard.unmount();

    resolveDelayedDisable({ ...existingFeatures, syncCustomerAvatars: false });
    await vi.waitFor(() => expect(customerPreviewCalls).toBe(2));
    expect(cachedCustomer.markup()).not.toContain(VALID_PNG_DATA_URL);
    expect(cachedCustomer.markup()).toContain('>客<');
    cachedCustomer.unmount();

    const offlineCard = mountComponent(AccountAvatarSyncCard, {
      accountRef: 'account_wecom',
      accountLabel: '企微机器人',
      disabled: false,
      offline: true,
    });
    try {
      const offlineSwitch = findAll(offlineCard.getTree(), el => el.type === AutoReplySwitch)[0];
      expect(offlineSwitch!.props.disabled).toBe(true);
      expect(offlineCard.markup()).toContain('官方通道当前未连接');
    } finally {
      offlineCard.unmount();
    }

    expect(reasons.AVATAR_SYNC_DISABLED).toBeTruthy();
    expect(reasons.AVATAR_INVALID_FORMAT).toBeTruthy();
    expect(reasons.AVATAR_TOO_LARGE).toBeTruthy();
    expect(explain('AVATAR_SYNC_DISABLED')).toBe(reasons.AVATAR_SYNC_DISABLED);
  });
});
