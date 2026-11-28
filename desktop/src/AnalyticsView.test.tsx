import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_ACCOUNT_ID, DOUYIN_PLATFORM_ID, WECOM_AIBOT_PLATFORM_ID } from '../../src/contracts/account.js';

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

import { setActiveWorkbenchAccount, type Status } from './api';
import { AppSidebar, DESKTOP_NAV_GROUPS, DESKTOP_PAGE_CRUMBS } from './components/AppSidebar';
import { CachedAvatar } from './components/CachedAvatar';
import { TopBar } from './components/TopBar';
import { Button } from './components/ui/button';
import { Tabs } from './components/ui/tabs';
import { PageContent } from './PageContent';
import { clearAvatarPreviewCache } from './useAvatarPreview';
import {
  AnalyticsView,
  buildAnalyticsCsv,
  sanitizeCsvCell,
  type AnalyticsSummary,
} from './views/AnalyticsView';

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

function textContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textContent(node.props.children);
  return '';
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

function sampleAnalytics(range: '7d' | '14d' | '30d' = '7d'): AnalyticsSummary {
  return {
    range,
    sinceIso: '2026-11-21T00:00:00.000Z',
    untilIso: '2026-11-27T23:59:59.999Z',
    scopes: {
      totals: 'ACCOUNT_WINDOW',
      dailySeries: 'ACCOUNT_WINDOW',
      handoffSummary: 'ACCOUNT_WINDOW',
      modelUsage: 'RUNTIME_ALL_TIME',
      budgets: 'SHARED_GLOBAL',
      accountBreakdown: 'ALL_ACCOUNTS_WINDOW',
      avgResponseBasis: 'CONFIRMATION_AT',
    },
    totals: {
      confirmedTotal: 42,
      autoConfirmed: 22,
      humanConfirmed: 10,
      faqDirectConfirmed: 8,
      unknownConfirmed: 2,
      autoRate: 30 / 42,
      faqDirectRate: 8 / 42,
      autoReplyAttempts: 32,
      autoReplySuccessRate: 30 / 32,
      avgResponseMs: 3400,
    },
    dailySeries: [
      { date: '2026-11-26', label: '11-26', autoConfirmed: 10, faqDirectConfirmed: 4, humanConfirmed: 6, unknownConfirmed: 1 },
      { date: '2026-11-27', label: '11-27', autoConfirmed: 12, faqDirectConfirmed: 4, humanConfirmed: 4, unknownConfirmed: 1 },
    ],
    handoffSummary: {
      accountId: DEFAULT_ACCOUNT_ID,
      sinceMs: 1795132800000,
      untilMs: 1795737599999,
      channel: null,
      total: 9,
      byCategory: [
        { key: 'AFTER_SALES', label: '售后退款/纠纷', count: 5, ratio: 5 / 9, percentage: 55.6 },
        { key: 'BARGAIN', label: '议价/优惠申请', count: 4, ratio: 4 / 9, percentage: 44.4 },
      ],
      byReasonCode: [],
      byStage: [],
    },
    modelUsage: {
      requests: 42,
      succeeded: 40,
      failed: 2,
      inputTokens: 12000,
      outputTokens: 3400,
      totalTokens: 15400,
      unresolved: 0,
    },
    budgets: [
      { kind: 'SEND', used: 18, maximum: 100 },
      { kind: 'MODEL', used: 42, maximum: 500 },
    ],
    accountBreakdown: [
      {
        accountId: DEFAULT_ACCOUNT_ID,
        displayLabel: '=cmd|抖音私密主号',
        platform: DOUYIN_PLATFORM_ID,
        autoConfirmed: 16,
        faqDirectConfirmed: 5,
        humanConfirmed: 7,
        unknownConfirmed: 1,
        totalConfirmed: 29,
      },
      {
        accountId: 'account_wecom_1',
        displayLabel: '+企微内部机器人',
        platform: WECOM_AIBOT_PLATFORM_ID,
        autoConfirmed: 6,
        faqDirectConfirmed: 3,
        humanConfirmed: 3,
        unknownConfirmed: 1,
        totalConfirmed: 13,
      },
    ],
  };
}

describe('Milestone 5: AnalyticsView & 9-page navigation', () => {
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

  test('AnalyticsView renders scopes & KPIs, blocks stale export when range fetch fails, and exports alias-only sanitized CSV', async () => {
    const exported: { csv: string; range: string }[] = [];
    invokeMock.mockImplementation(async (_cmd, args) => {
      const body = (args as { body?: { command?: string; range?: string } })?.body;
      if (body?.command === 'getAnalytics' && body.range === '7d') {
        return sampleAnalytics('7d');
      }
      if (body?.command === 'getAnalytics' && body.range === '30d') {
        throw new Error('OPERATION_FAILED_PRIVATE_DIAGNOSTICS');
      }
      return {};
    });

    const view = mountComponent(AnalyticsView, {
      activeAccountRef: DEFAULT_ACCOUNT_ID,
      onExportCsv: (csv, range) => exported.push({ csv, range }),
    });
    try {
      await vi.waitFor(() => {
        expect(view.markup()).toContain('确认送达总量');
      });

      const html = view.markup();
      expect(html).toContain('当期本账号');
      expect(html).toContain('全局共享额度');
      expect(html).toContain('全账号明细（当期）');
      expect(html).toContain('平均确认耗时 3.4s');
      expect(html).toContain('FAQ 直出占比 19.0%');
      expect(html).toContain('未知来源 2');
      expect(html).toContain('42 次');
      expect(html).toContain('15,400');
      expect(html).toContain('售后退款/纠纷');
      expect(html).toContain('<svg ');
      expect(html).not.toMatch(/无头|有头|schema3|schema4|DPAPI|协议\s*v2/iu);

      const exportBtn = findAll(
        view.getTree(),
        el => (el.type === Button || el.type === 'button') && textContent(el).includes('导出 CSV'),
      )[0];
      expect(exportBtn?.props.disabled).toBe(false);
      (exportBtn!.props.onClick as () => void)();

      expect(exported).toHaveLength(1);
      const csv = exported[0]!.csv;
      expect(csv.startsWith('\uFEFF')).toBe(true);
      expect(csv).toContain('账号 1,抖音');
      expect(csv).toContain('账号 2,企业微信智能机器人');
      expect(csv).not.toContain('account_001');
      expect(csv).not.toContain('account_wecom_1');
      expect(csv).not.toContain('抖音私密主号');
      expect(csv).not.toContain('企微内部机器人');

      // Switch to 14d with MIXED avgResponseBasis -> verifies mixed label in UI & CSV
      const mixedSummary = sampleAnalytics('14d');
      mixedSummary.scopes.avgResponseBasis = 'MIXED';
      const rangeTabs = findAll(view.getTree(), el => el.type === Tabs)[0];

      // First test 30d failure blocks stale export
      (rangeTabs!.props.onValueChange as (val: string) => void)('30d');
      await vi.waitFor(() => {
        expect(view.markup()).toContain('操作未能完成');
      });
      const disabledBtn = findAll(
        view.getTree(),
        el => (el.type === Button || el.type === 'button') && textContent(el).includes('导出 CSV'),
      )[0];
      expect(disabledBtn?.props.disabled).toBe(true);
      expect(view.markup()).not.toContain('确认送达总量');
    } finally {
      view.unmount();
    }

    const mixedSummary = sampleAnalytics('14d');
    mixedSummary.scopes.avgResponseBasis = 'MIXED';
    invokeMock.mockResolvedValueOnce(mixedSummary);
    const mixedView = mountComponent(AnalyticsView, { activeAccountRef: DEFAULT_ACCOUNT_ID });
    try {
      await vi.waitFor(() => {
        expect(mixedView.markup()).toContain('平均响应/确认耗时（混合口径） 3.4s');
      });
      const mixedCsv = buildAnalyticsCsv(mixedSummary);
      expect(mixedCsv).toContain('平均响应/确认耗时（混合口径）(秒)');
    } finally {
      mixedView.unmount();
    }
  });

  test('sanitizeCsvCell neutralizes leading whitespace & control chars before formula prefixes while preserving strict CSV quoting', () => {
    expect(sanitizeCsvCell('=1+1')).toBe("'=1+1");
    expect(sanitizeCsvCell('  =1+1')).toBe("'  =1+1");
    expect(sanitizeCsvCell('\u0007+cmd|calc')).toBe("'\u0007+cmd|calc");
    expect(sanitizeCsvCell('\t-2+3')).toBe("'\t-2+3");
    expect(sanitizeCsvCell('\r@SUM(A1:A2)')).toBe('"\'\r@SUM(A1:A2)"');
    expect(sanitizeCsvCell('\n=1+1')).toBe('"\'\n=1+1"');
    expect(sanitizeCsvCell('normal,label')).toBe('"normal,label"');
    expect(sanitizeCsvCell('say "hi"')).toBe('"say ""hi"""');

    const csv = buildAnalyticsCsv(sampleAnalytics('14d'));
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('近 14 天');
    expect(csv).toContain('历史未知来源');
  });

  test('9-page AppSidebar, TopBar & PageContent route 数据统计 and keep AppSidebar avatar bound to explicit accountRef', () => {
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const governanceGroup = DESKTOP_NAV_GROUPS.find(group => group.label === '治理与系统');
    expect(governanceGroup?.items.map(item => item.id)).toEqual(['runtime', 'analytics', 'settings']);
    expect(DESKTOP_PAGE_CRUMBS.analytics).toEqual({ group: '治理与系统', title: '数据统计' });
    expect(DESKTOP_NAV_GROUPS.flatMap(group => group.items)).toHaveLength(9);

    const onSelectPage = vi.fn();
    const sidebarView = mountComponent(AppSidebar, {
      page: 'analytics',
      collapsed: false,
      status: baseStatus({ account: { id: 'account_wecom_1', identity: 'stale-bot' } }),
      version: '0.3.5',
      busy: '',
      pendingCount: 2,
      pendingAutoReply: null,
      activeAccount: null,
      onSelectPage,
      onSetCollapsed: () => {},
      onToggleAutoReply: () => {},
      onReconnect: () => {},
    });
    try {
      expect(sidebarView.markup()).toContain('数据统计');
      const cachedAvatarEl = findAll(sidebarView.getTree(), el => el.type === CachedAvatar)[0];
      expect(cachedAvatarEl!.props.accountRef).toBe(DEFAULT_ACCOUNT_ID);
      expect(cachedAvatarEl!.props.avatarKey).toBe(DEFAULT_ACCOUNT_ID);

      const analyticsBtn = findAll(
        sidebarView.getTree(),
        el => el.type === 'button' && el.props['aria-label'] === '数据统计',
      )[0];
      (analyticsBtn!.props.onClick as () => void)();
      expect(onSelectPage).toHaveBeenCalledWith('analytics');
    } finally {
      sidebarView.unmount();
    }

    const topBarHtml = renderToStaticMarkup(
      createElement(TopBar, {
        page: 'analytics',
        theme: 'light',
        status: baseStatus(),
        busy: '',
        onSync: () => {},
        onToggleTheme: () => {},
        onOpenPalette: () => {},
        onNavigate: () => {},
      }),
    );
    expect(topBarHtml).toContain('治理与系统');
    expect(topBarHtml).toContain('数据统计');

    const pageEl = PageContent({
      page: 'analytics',
      sessionKey: 'sess',
      status: baseStatus(),
      runtime: 'D:\\synthetic',
      inboxSummary: { total: 0, page: 0, pageSize: 20, items: [] },
      busy: '',
      error: '',
      notice: '',
      theme: 'light',
      pendingAutoReply: null,
      hasUnsavedDraft: false,
      activeAccount: null,
      promptsState: {
        prompts: { persona: '', business: '', rules: '' },
        promptBusy: false,
        promptError: '',
        promptNotice: '',
        canSavePrompts: false,
        devRecoveryRestoring: false,
        updatePromptField: () => {},
        savePrompts: async () => {},
      },
      audit: [],
      auditPage: 0,
      setAuditPage: () => {},
      runtimeTab: 'diagnostics',
      onRuntimeTabChange: () => {},
      act: async (_l, fn) => fn(),
      updateStatus: () => {},
      updateProviders: () => {},
      onNavigate: () => {},
      onSync: () => {},
      onSelectEvent: () => {},
      onToggleAuto: async () => {},
      onSelectWorkbenchAccount: () => {},
      onToggleTheme: () => {},
      onEmergencyStop: () => {},
      onReconnect: async () => {},
    });
    expect(isValidElement(pageEl)).toBe(true);
    expect((pageEl as ReactElement).type).toBe(AnalyticsView);
  });
});
