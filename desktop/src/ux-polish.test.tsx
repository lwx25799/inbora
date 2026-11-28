import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_ACCOUNT_ID, WECHAT_KF_PLATFORM_ID, WECOM_AIBOT_PLATFORM_ID } from '../../src/contracts/account.js';
import type { PublicModelConnection } from '../../src/contracts/model-providers.js';

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
  };
});

function mountView<P>(Component: (props: P) => ReactNode, initialProps: P) {
  let props = initialProps;
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
        let sIdx = 0;
        let rIdx = 0;
        let eIdx = 0;
        const pending: { idx: number; fn: () => (() => void) | void; deps?: readonly unknown[] }[] = [];
        activeHooks = {
          useState: <T,>(initial: T | (() => T)) => {
            const idx = sIdx++;
            if (idx >= states.length) states.push(typeof initial === 'function' ? (initial as () => T)() : initial);
            return [states[idx] as T, (next: T | ((prev: T) => T)) => {
              const prev = states[idx] as T;
              const value = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
              if (!Object.is(prev, value)) {
                states[idx] = value;
                render();
              }
            }];
          },
          useRef: <T,>(initial: T) => {
            const idx = rIdx++;
            if (idx >= refs.length) refs.push({ current: initial });
            return refs[idx] as { current: T };
          },
          useEffect: (fn, deps) => {
            pending.push({ idx: eIdx++, fn, deps });
          },
        };
        try {
          tree = Component(props);
        } finally {
          activeHooks = null;
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
    } finally {
      rendering = false;
    }
  };
  render();
  return {
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
import type { Inbox, Status, Thread } from './api';
import { errorMessages as reasons } from './error-messages';
import { InboxList } from './InboxList';
import { KnowledgeDocuments } from './KnowledgeDocuments';
import { KnowledgeSamples } from './KnowledgeSamples';
import { KnowledgeTrial } from './KnowledgeTrial';
import { FaqSuggestionsPanel } from './FaqSuggestionsPanel';
import { ModelConnectionEditor } from './ModelConnectionEditor';
import { ModelSelector } from './ModelSelector';
import { ReplyComposer } from './ReplyComposer';
import { ReplyDetail } from './ReplyDetail';
import { ReplyPipelineSettings } from './ReplyPipelineSettings';
import { SecurityRecoveryDialog } from './SecurityRecoveryDialog';
import { CommandPalette } from './components/CommandPalette';
import { ConnectScreen } from './components/ConnectScreen';
import { browserState, budgetKindLabel, compactTime, formatBudgetLimit, formatSyncLabel } from './presentation';
import { AccountsView } from './views/AccountsView';
import { OverviewView } from './views/OverviewView';
import { RuntimeView } from './views/RuntimeView';
import { SystemSettingsView } from './views/SystemSettingsView';

function baseStatus(overrides: Partial<Status> = {}): Status {
  return {
    runtime: 'synthetic-ux-polish',
    account: { id: DEFAULT_ACCOUNT_ID, identity: 'own-1' },
    operator: { id: 'op-1', permissions: ['READ', 'EDIT', 'SEND', 'CONTROL'], expiresAt: Date.now() + 60_000 },
    mode: 'MANUAL',
    configuredMode: 'MANUAL',
    paused: false,
    browser: { state: 'OPEN_LAST_READ_VERIFIED', mode: 'headless', loginRecovery: false, version: '130.0' },
    lastSync: [],
    capabilities: [{ channel: 'DIRECT_MESSAGE', state: 'SEND_AVAILABLE', reason: '', evidence: 'ok' }],
    budgets: [
      { kind: 'MODEL', used: 2, maximum: null },
      { kind: 'SEND', used: 1, maximum: 20 },
    ],
    usage: { requests: 2, inputTokens: 120, outputTokens: 60, unresolved: 0 },
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

function baseThread(overrides: Partial<Thread> = {}): Thread {
  return {
    replyStatus: 'WAITING',
    controlledTrial: false,
    workUrl: null,
    event: {
      id: '930bfc79-03e3-4006-bd73-6c7e29596311',
      binding: 'synthetic-binding',
      status: 'AWAITING_DRAFT',
      payload: {
        accountId: DEFAULT_ACCOUNT_ID,
        channel: 'COMMENT_NOTIFICATION',
        platformEventId: 'evt-1',
        actorId: 'peer-1',
        actorName: '测试访客',
        text: '请问有现货吗？',
        occurredAt: '2026-11-27T02:00:00Z',
        videoId: 'video-1',
        commentId: 'comment-1',
        conversationId: null,
        direction: 'INCOMING',
        kind: 'COMMENT',
        evidenceId: 'synthetic-only',
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
    ...overrides,
  };
}

describe('UX polish invariants across the 8 usability principles', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });
  afterEach(() => {
    activeHooks = null;
  });
  test('error messages point to current Stage 5 pages and never reference removed AI 与设置 page', () => {
    for (const [code, text] of Object.entries(reasons)) {
      expect(text, code).not.toContain('AI 与设置');
    }
    expect(reasons.EMERGENCY_STOPPED).toContain('系统设置 -> 故障处理');
    expect(reasons.MODEL_BUDGET_EXHAUSTED).toContain('自动化规则');
    expect(reasons.INVALID_MODEL_KEY).toContain('多模型配置');
  });

  test('presentation helpers unify sync labels, budget labels, and compact timestamps', () => {
    expect(budgetKindLabel('MODEL')).toBe('模型');
    expect(budgetKindLabel('SEND')).toBe('发送');
    expect(formatBudgetLimit(null)).toBe('无上限');
    expect(formatBudgetLimit(50)).toBe('50');
    expect(formatSyncLabel({ runId: null, running: false, cancelled: false, source: null, results: [] })).toBe('同步收件箱');
    expect(formatSyncLabel({ runId: 'r1', running: true, cancelled: false, source: 'dm', results: [] })).toBe('正在同步私信…');
    expect(compactTime(null)).toBe('尚无记录');
    expect(compactTime('2025-03-04T09:05:00')).toBe('2025-03-04 09:05');
  });

  test('ConnectScreen removes internal PoC milestone jargon and explains why submit is disabled', () => {
    const html = renderToStaticMarkup(
      createElement(ConnectScreen, {
        runtime: 'D:\\synthetic',
        initialize: false,
        consent: false,
        busy: '',
        error: '',
        version: '0.3.5',
        onRuntimeChange: () => {},
        onInitializeChange: () => {},
        onConsentChange: () => {},
        onConnect: () => {},
      }),
    );
    expect(html).not.toContain('PoC GO');
    expect(html).not.toContain('受控试用');
    expect(html).toContain('勾选上方确认后即可连接');
  });

  test('InboxList hides idle single-page pager and offers one-click escape from empty filtered views', () => {
    const emptyInbox: Inbox = { total: 0, unreadTotal: 0, page: 0, pageSize: 20, items: [] };
    const html = renderToStaticMarkup(
      createElement(InboxList, {
        inbox: emptyInbox,
        selected: null,
        channel: 'DIRECT_MESSAGE',
        setChannel: () => {},
        filter: 'UNREAD',
        setFilter: () => {},
        pageNumber: 0,
        setPageNumber: () => {},
        choose: () => {},
        markRead: () => {},
        markingRead: false,
      }),
    );
    expect(html).not.toContain('>上一页<');
    expect(html).not.toContain('>下一页<');
    expect(html).toContain('查看等待回复');
    expect(html).toContain('查看全部消息');
    expect(html).toContain('查看全部通道');
  });

  test('ReplyDetail hides empty 0-item history disclosure and ReplyComposer hides version 0 when no draft exists', () => {
    const status = baseStatus();
    const thread = baseThread();
    const props = {
      detailElement: { current: null },
      dialogElement: { current: null },
      thread,
      status,
      setStatus: () => {},
      selected: thread.event.id,
      choose: () => {},
      busy: '',
      act: async (_label: string, fn: () => Promise<void>) => fn(),
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
    };
    const detailHtml = renderToStaticMarkup(createElement(ReplyDetail, props));
    expect(detailHtml).not.toContain('有限上下文');
    expect(detailHtml).not.toContain('历史对话记录 · 0 条');
    const composerHtml = renderToStaticMarkup(createElement(ReplyComposer, props));
    expect(composerHtml).not.toContain('版本 0');
    expect(composerHtml).not.toContain('未配置 Key，人工回复仍可直接发送');
  });

  test('daily pages hide schema jargon, unify sync text, and keep empty knowledge disclosures hidden', () => {
    const status = baseStatus();
    const accountsHtml = renderToStaticMarkup(
      createElement(AccountsView, { status, busy: '', act: async () => {}, update: () => {} }),
    );
    expect(accountsHtml).not.toContain('schema4');

    const overviewHtml = renderToStaticMarkup(
      createElement(OverviewView, {
        status,
        inbox: { total: 0, unreadTotal: 0, page: 0, pageSize: 20, items: [] },
        busy: '',
        pendingAutoReply: null,
        onNavigate: () => {},
        onSync: () => {},
        onSelectEvent: () => {},
        onToggleAuto: () => {},
      }),
    );
    expect(overviewHtml).toContain('同步收件箱');
    expect(overviewHtml).not.toContain('立即同步');

    const emptyOverview = {
      available: true,
      sources: [],
      knowledge: [],
      samples: [],
      personas: [],
      activePersonaId: null,
      activePersona: null,
      totals: { sources: 0, knowledge: 0, samples: 0, accepted: 0, holdout: 0, personas: 0 },
      learningTasks: [],
      page: 0,
      pageSize: 50,
    };
    const samplesHtml = renderToStaticMarkup(
      createElement(KnowledgeSamples, { overview: emptyOverview, busy: false, perform: vi.fn() }),
    );
    expect(samplesHtml).not.toContain('管理聊天来源');

    const trialHtml = renderToStaticMarkup(
      createElement(KnowledgeTrial, { overview: emptyOverview, busy: false, perform: vi.fn() }),
    );
    expect(trialHtml).not.toContain('本次知识来源');

    const docsHtml = renderToStaticMarkup(
      createElement(KnowledgeDocuments, { overview: emptyOverview, busy: false, perform: vi.fn() }),
    );
    expect(docsHtml).not.toContain('>新建条目<');
  });

  test('RuntimeView translates audit event types and CommandPalette renders all navigation entries', () => {
    const runtimeHtml = renderToStaticMarkup(
      createElement(RuntimeView, {
        status: baseStatus(),
        audit: [
          { time: '2026-11-27T02:00:00Z', event_type: 'EMERGENCY_STOPPED', entity_id: 'sys-1', detail_redacted: 'manual' },
          { time: '2026-11-27T02:05:00Z', event_type: 'EMERGENCY_RESUMED', entity_id: 'sys-1', detail_redacted: 'manual' },
          { time: '2026-11-27T02:06:00Z', event_type: 'PERSISTENT_GRANT_ENABLED', entity_id: 'grant-1', detail_redacted: '{}' },
          { time: '2026-11-27T02:07:00Z', event_type: 'SECURITY_CHANNEL_HELD', entity_id: 'acc:dm', detail_redacted: '{}' },
          { time: '2026-11-27T02:08:00Z', event_type: 'CONFIRMED', entity_id: 'intent-1', detail_redacted: '{}' },
        ],
        auditPage: 0,
        setAuditPage: () => {},
        tab: 'audit',
      }),
    );
    expect(runtimeHtml).toContain('触发全局急停');
    expect(runtimeHtml).toContain('恢复后台运行');
    expect(runtimeHtml).toContain('启用持续授权');
    expect(runtimeHtml).toContain('通道触发安全待核验');
    expect(runtimeHtml).toContain('回复确认送达');
    expect(runtimeHtml).toContain('title="PERSISTENT_GRANT_ENABLED"');
    expect(runtimeHtml).toContain('title="SECURITY_CHANNEL_HELD"');

    const onNavigate = vi.fn();
    const paletteTree = createElement(CommandPalette, {
      open: true,
      theme: 'light',
      collapsed: false,
      syncDisabled: false,
      onClose: vi.fn(),
      onNavigate,
      onSync: vi.fn(),
      onToggleTheme: vi.fn(),
      onToggleCollapsed: vi.fn(),
    });
    const paletteHtml = renderToStaticMarkup(paletteTree);
    expect(paletteHtml).toContain('<dialog ');
    expect(paletteHtml).toContain('data-command-palette="true"');
    expect(paletteHtml).toContain('快速跳转与操作');
    expect(paletteHtml).toContain('多模型配置');
    expect(paletteHtml).toContain('数据统计');
    expect(paletteHtml).toContain('同步收件箱');
    expect((paletteHtml.match(/<button /gu) ?? []).length).toBe(12);
  });

  test('daily UI copy hides headless/headed, schema3/schema4, DPAPI, and protocol v2 jargon and generalizes origin errors', () => {
    const jargonPattern = /无头|有头|schema3|schema4|DPAPI|协议\s*v2/iu;
    const stripTags = (html: string) => html.replace(/<[^>]+>/gu, ' ');

    for (const [code, text] of Object.entries(reasons)) {
      expect(text, code).not.toMatch(jargonPattern);
    }
    expect(reasons.OBSERVATION_UNEXPECTED_ORIGIN).toBe(
      '当前页面来源与已授权平台网站不一致，请返回已授权平台页面后检查恢复。',
    );
    expect(reasons.OBSERVATION_UNEXPECTED_ORIGIN).not.toContain('抖音');

    for (const state of ['MANUAL_VISIBLE', 'LOGIN_RECOVERY', 'CLOSED', 'OPEN_LAST_READ_VERIFIED']) {
      expect(browserState(state), state).not.toMatch(jargonPattern);
    }

    const connection: PublicModelConnection = {
      id: 'conn-1',
      name: 'DeepSeek',
      presetId: 'deepseek',
      version: 1,
      draftRevision: 1,
      models: [{ modelId: 'deepseek-chat', displayName: 'DeepSeek Chat', source: 'MANUAL' }],
      modelsFetchedAt: null,
      modelsTruncated: false,
      totalModelCount: 1,
      draft: {
        presetId: 'deepseek',
        protocol: 'OPENAI_CHAT',
        baseUrl: 'https://api.deepseek.com',
        region: null,
        routeRevision: 1,
        keyPresent: true,
        keyStored: true,
        storage: 'DPAPI',
        unavailableReason: null,
        catalogResult: null,
        testResult: null,
      },
      applied: {
        presetId: 'deepseek',
        protocol: 'OPENAI_CHAT',
        baseUrl: 'https://api.deepseek.com',
        region: null,
        routeRevision: 1,
        keyPresent: true,
        keyStored: true,
        storage: 'DPAPI',
        unavailableReason: null,
        catalogResult: null,
        testResult: null,
      },
    };

    const viewsHtml = [
      renderToStaticMarkup(createElement(AccountsView, { status: baseStatus(), busy: '', act: async () => {}, update: () => {} })),
      renderToStaticMarkup(
        createElement(OverviewView, {
          status: baseStatus(),
          inbox: { total: 0, unreadTotal: 0, page: 0, pageSize: 20, items: [] },
          busy: '',
          pendingAutoReply: null,
          onNavigate: () => {},
          onSync: () => {},
          onSelectEvent: () => {},
          onToggleAuto: () => {},
        }),
      ),
      renderToStaticMarkup(
        createElement(RuntimeView, {
          status: baseStatus({
            securityHolds: [{
              channel: 'COMMENT_NOTIFICATION',
              reason: 'OBSERVATION_SECURITY_SUSPECT',
              incidentId: 'inc-1',
              revision: 'rev-1',
              heldAt: 1794399998894,
              mode: 'headless',
            }],
          }),
          audit: [],
          auditPage: 0,
          setAuditPage: () => {},
          tab: 'diagnostics',
        }),
      ),
      renderToStaticMarkup(
        createElement(RuntimeView, {
          status: baseStatus(),
          audit: [],
          auditPage: 0,
          setAuditPage: () => {},
          tab: 'security',
        }),
      ),
      renderToStaticMarkup(
        createElement(SystemSettingsView, {
          status: baseStatus({ schema: 3 }),
          runtime: 'D:\\synthetic',
          busy: '',
          theme: 'light',
          onToggleTheme: () => {},
          act: async () => {},
          update: () => {},
          stop: () => {},
          reconnect: async () => {},
        }),
      ),
      renderToStaticMarkup(
        createElement(SecurityRecoveryDialog, {
          session: {
            sessionId: 'sess-1',
            channel: 'DIRECT_MESSAGE',
            incidentId: 'inc-1',
            recreated: false,
          },
          update: () => {},
          onClosed: () => {},
        }),
      ),
      renderToStaticMarkup(
        createElement(ModelSelector, {
          state: {
            connections: [connection],
            selection: {
              connectionId: 'conn-1',
              routeRevision: 1,
              modelId: 'deepseek-chat',
              modelDisplayName: 'DeepSeek Chat',
              selectionRevision: 1,
            },
          },
          budgetExhausted: false,
          modelAuthorized: true,
          change: async () => undefined,
          refreshing: false,
        }),
      ),
      renderToStaticMarkup(
        createElement(ModelConnectionEditor, {
          connection,
          change: async () => undefined,
          onCreated: () => {},
          onClose: () => {},
          budgetExhausted: false,
          stopped: false,
          hidden: false,
          refreshing: false,
          selectionRevision: 1,
        }),
      ),
      renderToStaticMarkup(createElement(ReplyPipelineSettings, { accountId: null })),
      renderToStaticMarkup(
        createElement(FaqSuggestionsPanel, {
          overview: {
            available: true,
            sources: [],
            knowledge: [],
            samples: [],
            personas: [],
            activePersonaId: null,
            activePersona: null,
            totals: { sources: 0, knowledge: 0, samples: 0, accepted: 0, holdout: 0, personas: 0 },
            learningTasks: [],
            page: 0,
            pageSize: 50,
          },
          busy: false,
          perform: async () => {},
        }),
      ),
    ];

    expect(reasons.FAQ_SUGGESTION_NOT_FOUND).toBeTruthy();
    expect(reasons.FAQ_SUGGESTION_NOT_PENDING).toBeTruthy();
    expect(reasons.INVALID_PIPELINE_CONFIG).toBeTruthy();
    for (const html of viewsHtml) {
      expect(stripTags(html)).not.toMatch(jargonPattern);
      expect(html).not.toMatch(/title="[^"]*(schema3|schema4|DPAPI|无头|有头|协议\s*v2)/iu);
    }
  });

  test('AccountsView adapts cards between browser channel and official API channels', () => {
    const status = baseStatus();

    const browserHtml = renderToStaticMarkup(
      createElement(AccountsView, { status, busy: '', act: async () => {}, update: () => {} }),
    );
    expect(browserHtml).toContain('浏览器运行状态');
    expect(browserHtml).toContain('后台静音 Edge');
    expect(browserHtml).toContain('打开登录窗口');
    expect(browserHtml).toContain('同步顶部通知（独立来源）');
    expect(browserHtml).not.toContain('官方通道状态');

    const wecomHtml = renderToStaticMarkup(
      createElement(AccountsView, {
        status: baseStatus({ account: { id: 'account_wecom', identity: 'bot-1' } }),
        busy: '',
        act: async () => {},
        update: () => {},
        activeAccount: {
          accountRef: 'account_wecom',
          displayLabel: '企微售前机器人',
          platform: WECOM_AIBOT_PLATFORM_ID,
        },
      }),
    );
    expect(wecomHtml).toContain('官方通道状态');
    expect(wecomHtml).toContain('免浏览器后台运行');
    expect(wecomHtml).toContain('官方长连接');
    expect(wecomHtml).toContain('官方通道能力与连接摘要');
    expect(wecomHtml).not.toContain('浏览器运行窗口切换');
    expect(wecomHtml).not.toContain('同步顶部通知（独立来源）');
    expect(wecomHtml).not.toContain('打开登录窗口');

    const wechatKfHtml = renderToStaticMarkup(
      createElement(AccountsView, {
        status: baseStatus({ account: { id: 'account_kf', identity: 'wkf-1' } }),
        busy: '',
        act: async () => {},
        update: () => {},
        activeAccount: {
          accountRef: 'account_kf',
          displayLabel: '微信官方客服',
          platform: WECHAT_KF_PLATFORM_ID,
        },
      }),
    );
    expect(wechatKfHtml).toContain('官方通道状态');
    expect(wechatKfHtml).toContain('免浏览器后台运行');
    expect(wechatKfHtml).toContain('官方 API');
    expect(wechatKfHtml).not.toContain('浏览器运行窗口切换');
    expect(wechatKfHtml).not.toContain('同步顶部通知（独立来源）');
  });

  test('AccountsView queries getAccountStatus for official channels and never shows green badge when disconnected/degraded/error', async () => {
    const extractOfficialCard = (html: string) => {
      const start = html.indexOf('官方通道状态');
      const end = html.indexOf('最近同步状态');
      return html.slice(start, end);
    };

    const wecomActive = {
      accountRef: 'account_wecom',
      displayLabel: '企微售前机器人',
      platform: WECOM_AIBOT_PLATFORM_ID,
    };

    for (const scenario of [
      {
        label: 'disconnected',
        response: {
          connected: false,
          connectorState: 'DISCONNECTED',
          transportStatus: { transport: 'official_api', state: 'DISCONNECTED', protocol: 'wecom_ws', endpointDigest: null },
        },
        expectText: '未连接',
        expectSuccessBadge: false,
      },
      {
        label: 'degraded',
        response: {
          connected: false,
          connectorState: 'DEGRADED',
          transportStatus: { transport: 'official_api', state: 'DEGRADED', protocol: 'wecom_ws', endpointDigest: null },
        },
        expectText: '连接降级',
        expectSuccessBadge: false,
      },
      {
        label: 'error',
        response: {
          connected: false,
          connectorState: 'ERROR',
          transportStatus: { transport: 'official_api', state: 'ERROR', protocol: 'wecom_ws', endpointDigest: null },
        },
        expectText: '连接异常',
        expectSuccessBadge: false,
      },
      {
        label: 'unavailable',
        response: {
          connected: false,
          connectorState: 'UNAVAILABLE',
        },
        expectText: '未连接',
        expectSuccessBadge: false,
      },
      {
        label: 'connected',
        response: {
          connected: true,
          connectorState: 'CONNECTED',
          transportStatus: { transport: 'official_api', state: 'CONNECTED', protocol: 'wecom_ws', endpointDigest: null },
        },
        expectText: '已连接',
        expectSuccessBadge: true,
      },
    ]) {
      invokeMock.mockReset();
      invokeMock.mockImplementation(async (_cmd, args) => {
        const action = (args as { body?: { action?: string } })?.body?.action;
        if (action === 'getAccountStatus') return scenario.response;
        if (action === 'listAccounts') return { accounts: [] };
        return scenario.response;
      });
      const view = mountView(AccountsView, {
        status: baseStatus({ account: { id: 'account_wecom', identity: 'bot-1' } }),
        busy: '',
        act: async () => {},
        update: () => {},
        activeAccount: wecomActive,
      });
      try {
        await vi.waitFor(() => {
          expect(extractOfficialCard(view.markup())).toContain(scenario.expectText);
        });
        const cardHtml = extractOfficialCard(view.markup());
        if (scenario.expectSuccessBadge) {
          expect(cardHtml, scenario.label).toContain('bg-success');
        } else {
          expect(cardHtml, scenario.label).not.toContain('bg-success');
        }
      } finally {
        view.unmount();
      }
    }

    // Re-fetches getAccountStatus when status updates (e.g. after disconnect without inboxRevision change)
    let statusResp: Record<string, unknown> = {
      connected: true,
      connectorState: 'CONNECTED',
      transportStatus: { transport: 'official_api', state: 'CONNECTED', protocol: 'wecom_ws', endpointDigest: null },
    };
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (_cmd, args) => {
      const action = (args as { body?: { action?: string } })?.body?.action;
      if (action === 'getAccountStatus') return statusResp;
      if (action === 'listAccounts') return { accounts: [] };
      return statusResp;
    });
    const liveView = mountView(AccountsView, {
      status: baseStatus({ account: { id: 'account_wecom', identity: 'bot-1' } }),
      busy: '',
      act: async () => {},
      update: () => {},
      activeAccount: wecomActive,
    });
    try {
      await vi.waitFor(() => expect(extractOfficialCard(liveView.markup())).toContain('已连接'));
      expect(extractOfficialCard(liveView.markup())).toContain('bg-success');

      statusResp = {
        connected: false,
        connectorState: 'DISCONNECTED',
        transportStatus: { transport: 'official_api', state: 'DISCONNECTED', protocol: 'wecom_ws', endpointDigest: null },
      };
      liveView.updateProps({
        status: baseStatus({ account: { id: 'account_wecom', identity: 'bot-1' } }),
        busy: '',
        act: async () => {},
        update: () => {},
        activeAccount: wecomActive,
      });
      await vi.waitFor(() => expect(extractOfficialCard(liveView.markup())).toContain('未连接'));
      expect(extractOfficialCard(liveView.markup())).not.toContain('bg-success');
    } finally {
      liveView.unmount();
    }
  });
});
