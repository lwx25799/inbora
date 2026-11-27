import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import { DEFAULT_ACCOUNT_ID } from '../../src/contracts/account.js';
import type { Inbox, Status, Thread } from './api';
import { errorMessages as reasons } from './error-messages';
import { InboxList } from './InboxList';
import { KnowledgeDocuments } from './KnowledgeDocuments';
import { KnowledgeSamples } from './KnowledgeSamples';
import { KnowledgeTrial } from './KnowledgeTrial';
import { ReplyComposer } from './ReplyComposer';
import { ReplyDetail } from './ReplyDetail';
import { CommandPalette } from './components/CommandPalette';
import { ConnectScreen } from './components/ConnectScreen';
import { budgetKindLabel, compactTime, formatBudgetLimit, formatSyncLabel } from './presentation';
import { AccountsView } from './views/AccountsView';
import { OverviewView } from './views/OverviewView';
import { RuntimeView } from './views/RuntimeView';

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
    expect(paletteHtml).toContain('同步收件箱');
    expect((paletteHtml.match(/<button /gu) ?? []).length).toBe(11);
  });
});
