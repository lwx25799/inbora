import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import type { Status, Thread } from './api.js';
import { explain, reasons } from './api.js';
import { DirectMessageChat } from './DirectMessageChat';
import { EmergencyStopNotice } from './EmergencyStopNotice';
import { describeKnowledgeError } from './knowledge-client.js';
import { refreshTargets } from './read-refresh.js';
import { ReplyComposer } from './ReplyComposer';
import { ReplyDetail } from './ReplyDetail';
import { Settings } from './Settings';
import { SettingsDialog } from './SettingsDialog';
import {
  collectionSnapshot,
  policySnapshot,
  policySyncKey,
  sameAiSettings,
  sameCollectionForm,
  samePolicyForm,
} from './settings-form-sync.js';

function baseStatus(overrides: Partial<Status> = {}): Status {
  return {
    runtime: 'synthetic-stage0',
    account: { id: 'account_001', identity: 'own-1' },
    operator: { id: 'op-1', permissions: ['READ', 'EDIT', 'SEND', 'CONTROL'], expiresAt: Date.now() + 60_000 },
    mode: 'MANUAL',
    configuredMode: 'MANUAL',
    paused: false,
    browser: { state: 'OPEN_LAST_READ_VERIFIED', mode: 'headless', loginRecovery: false, version: 'synthetic' },
    lastSync: [],
    capabilities: [],
    budgets: [{ kind: 'MODEL', used: 0, maximum: 50 }],
    usage: { requests: 0, inputTokens: 0, outputTokens: 0, unresolved: 0 },
    settings: { model: 'deepseek-flash', persona: '人设', business: '业务', rules: '规则' },
    keyPresent: true,
    modelAuthorized: true,
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
    schema: 3,
    ...overrides,
  };
}

function baseThread(channel: 'DIRECT_MESSAGE' | 'COMMENT_NOTIFICATION', overrides: Partial<Thread> = {}): Thread {
  const dm = channel === 'DIRECT_MESSAGE';
  return {
    replyStatus: 'WAITING',
    controlledTrial: false,
    workUrl: null,
    event: {
      id: '930bfc79-03e3-4006-bd73-6c7e29596311',
      binding: 'synthetic-binding',
      status: 'AWAITING_DRAFT',
      payload: {
        accountId: 'account_001',
        channel,
        platformEventId: 'evt-1',
        actorId: 'peer-1',
        actorName: '合成用户',
        text: '测试消息',
        occurredAt: '2026-11-24T00:00:00Z',
        videoId: dm ? null : 'video-1',
        commentId: dm ? null : 'comment-1',
        conversationId: dm ? 'conv-1' : null,
        direction: 'INCOMING',
        kind: dm ? 'DM' : 'COMMENT',
        evidenceId: 'synthetic-only',
        discovery: dm ? 'DIRECT_MESSAGE' : 'NOTIFICATION',
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
    suggestions: [{ id: 'sug-1', text: '建议回复', model: 'deepseek-flash', draft_version: 0, context_version: '0'.repeat(64) }],
    ...overrides,
  };
}

function replyViewProps(thread: Thread, status: Status, readOnly = false) {
  return {
    detailElement: { current: null },
    dialogElement: { current: null },
    thread,
    status,
    setStatus: () => {},
    selected: thread.event.id,
    choose: () => {},
    busy: '',
    act: async (_label: string, action: () => Promise<void>) => action(),
    setNotice: () => {},
    openDialog: async () => {},
    closeDialog: async () => {},
    readOnly,
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
}

test('refreshTargets prevents refresh storms for knowledge_updated and sidecar_response_too_large', () => {
  expect(refreshTargets('knowledge_updated')).toEqual([]);
  expect(refreshTargets('sidecar_response_too_large')).toEqual([]);
  expect(refreshTargets('diagnostics_updated')).toEqual([]);
});

test('EmergencyStopNotice renders a headed-mode banner and return-to-headless action without stop or holds', () => {
  const headed = baseStatus({
    browser: { state: 'MANUAL_VISIBLE', mode: 'headed', loginRecovery: true, version: 'synthetic' },
  });
  const html = renderToStaticMarkup(
    createElement(EmergencyStopNotice, {
      status: headed,
      busy: '',
      act: async (_label, run) => run(),
      update: () => {},
    }),
  );
  expect(html).toContain('当前处于有头窗口，后台收取与自动回复已暂停');
  expect(html).toContain('>返回无头运行</button>');

  const reserved = baseStatus({
    automation: {
      ...baseStatus().automation!,
      emergencyStopped: true,
      emergencyStop: { reason: 'OWNER_PORT_RESERVED', source: 'CONNECTION', stoppedAt: 1794399998894, legacy: false },
    },
  });
  const reservedHtml = renderToStaticMarkup(
    createElement(EmergencyStopNotice, {
      status: reserved,
      busy: '',
      act: async (_label, run) => run(),
      update: () => {},
    }),
  );
  expect(reservedHtml).toContain('本机独占锁端口被系统保留或拒绝绑定');
});

test('Settings keeps collapsed fault recovery and diagnostics unmounted and updates verification copy', () => {
  const html = renderToStaticMarkup(
    createElement(Settings, {
      status: baseStatus(),
      runtime: 'synthetic-runtime',
      busy: '',
      error: '',
      notice: '',
      act: async (_label, run) => run(),
      update: () => {},
      stop: () => {},
      toggleAuto: async () => {},
      pendingAutoReply: null,
    }),
  );
  expect(html).not.toContain('网页未发送内容恢复');
  expect(html).not.toContain('正在读取本地诊断');
  expect(html).toContain('原无头页面');
  expect(html).not.toContain('登录和验证码在正常可见浏览器中由本人处理');
});

test('SettingsDialog renders local error, busy and notice feedback inside the dialog', () => {
  const errHtml = renderToStaticMarkup(
    createElement(SettingsDialog, {
      title: '模型详细配置',
      open: true,
      onClose: () => {},
      error: '保存失败提示',
      children: createElement('div'),
    }),
  );
  expect(errHtml).toContain('role="alert"');
  expect(errHtml).toContain('保存失败提示');
  const noticeHtml = renderToStaticMarkup(
    createElement(SettingsDialog, {
      title: '模型详细配置',
      open: true,
      onClose: () => {},
      notice: 'AI 配置已保存',
      children: createElement('div'),
    }),
  );
  expect(noticeHtml).toContain('role="status"');
  expect(noticeHtml).toContain('AI 配置已保存');
});

test('settings-form-sync compares clean vs dirty states and tracks backend policy/grant revisions', () => {
  const s1 = baseStatus();
  expect(sameAiSettings(s1.settings, { ...s1.settings })).toBe(true);
  expect(sameAiSettings(s1.settings, { ...s1.settings, rules: '修改后' })).toBe(false);
  const c1 = collectionSnapshot(s1);
  expect(sameCollectionForm(c1, { ...c1 })).toBe(true);
  expect(sameCollectionForm(c1, { ...c1, comments: false })).toBe(false);
  const p1 = policySnapshot(s1);
  expect(samePolicyForm(p1, { ...p1 })).toBe(true);
  expect(samePolicyForm(p1, { ...p1, instructions: '新规则' })).toBe(false);
  const s2 = baseStatus({
    automation: {
      ...s1.automation!,
      replyPolicy: {
        version: 2,
        kind: 'AUTO_REPLY',
        createdAt: 1,
        scope: {
          ownId: 'own-1',
          channels: ['DIRECT_MESSAGE'],
          model: 'deepseek-flash',
          modelLimit: 10,
          sendLimit: 5,
          expiresAt: null,
          workIds: [],
          futureOwnWorks: false,
          conversationIds: ['conv-1'],
          entireInbox: false,
          containsAny: [],
          excludesAny: ['广告'],
          instructions: '自动规则',
          startHour: 9,
          endHour: 22,
        },
      },
    },
  });
  expect(policySyncKey(s1)).not.toBe(policySyncKey(s2));
  expect(policySnapshot(s2).conversations).toBe('conv-1');
  expect(policySnapshot(s2).excludes).toBe('广告');
});

test('DirectMessageChat and ReplyDetail remove dead headed-only buttons and distinguish empty vs loading timeline', () => {
  const headed = baseStatus({ browser: { state: 'OPEN_LAST_READ_VERIFIED', mode: 'headed', loginRecovery: false, version: 'synthetic' } });
  const emptyLoaded = baseThread('DIRECT_MESSAGE', {
    timeline: { items: [], pageSize: 30, hasMore: false, before: null },
  });
  const emptyHtml = renderToStaticMarkup(createElement(DirectMessageChat, replyViewProps(emptyLoaded, headed)));
  expect(emptyHtml).not.toContain('在专属浏览器查看原对象');
  expect(emptyHtml).toContain('当前会话暂无可显示的消息记录。');
  expect(emptyHtml).not.toContain('正在读取会话消息');

  const unloading = baseThread('DIRECT_MESSAGE', { timeline: undefined });
  const loadingHtml = renderToStaticMarkup(createElement(DirectMessageChat, replyViewProps(unloading, headed)));
  expect(loadingHtml).toContain('正在读取会话消息…');

  const comment = baseThread('COMMENT_NOTIFICATION');
  const commentHtml = renderToStaticMarkup(createElement(ReplyDetail, replyViewProps(comment, headed)));
  expect(commentHtml).not.toContain('在专属浏览器查看原对象');
});

test('ReplyComposer uses 2000-char ruler and gates quoting on ownership, intent and readOnly without using send freeze', () => {
  const status = baseStatus();
  const owned = baseThread('DIRECT_MESSAGE', { frozen: true });
  const ownedHtml = renderToStaticMarkup(createElement(ReplyComposer, replyViewProps(owned, status)));
  expect(ownedHtml).toContain('/2000 字');
  expect(ownedHtml).not.toContain('/500 字');
  expect(ownedHtml).toMatch(/<button(?![^>]*disabled)[^>]*>引用到编辑器<\/button>/u);

  const unowned = baseThread('DIRECT_MESSAGE', {
    ownership: { operator_id: null, generation: 0, lease_expires_at: 0, isMine: false },
  });
  const unownedHtml = renderToStaticMarkup(createElement(ReplyComposer, replyViewProps(unowned, status)));
  expect(unownedHtml).toMatch(/<button[^>]*disabled=""[^>]*>引用到编辑器<\/button>/u);

  const expired = baseThread('DIRECT_MESSAGE', {
    ownership: { operator_id: 'op-1', generation: 1, lease_expires_at: Date.now() - 1000, isMine: true },
  });
  const expiredHtml = renderToStaticMarkup(createElement(ReplyComposer, replyViewProps(expired, status)));
  expect(expiredHtml).toMatch(/<button[^>]*disabled=""[^>]*>引用到编辑器<\/button>/u);

  const hasIntent = baseThread('DIRECT_MESSAGE', {
    intent: { id: 'intent-1', status: 'UNCERTAIN' },
  });
  const intentHtml = renderToStaticMarkup(createElement(ReplyComposer, replyViewProps(hasIntent, status)));
  expect(intentHtml).not.toContain('引用到编辑器');
});

test('unified error dictionary translates all critical IPC, policy, recovery and model error codes', () => {
  const requiredCodes = [
    'SIDECAR_CLOSED',
    'SIDECAR_RESPONSE_TOO_LARGE',
    'IPC_RESPONSE_UNKNOWN_READ_STATUS',
    'DEV_BACKEND_RESTARTING_READ_STATUS',
    'DEV_BACKEND_UNAVAILABLE_RESTART_REQUIRED',
    'INVALID_COMMAND',
    'EMERGENCY_STOPPED',
    'MANUAL_RECOVERY_IN_PROGRESS',
    'OPERATION_FAILED_PRIVATE_DIAGNOSTICS',
    'INVALID_POLICY_HOURS',
    'MODEL_BUDGET_EXHAUSTED',
    'DUPLICATE_HUMAN_REPLY_TEXT',
    'HUMAN_REPLY_DUPLICATE_UNRESOLVED',
    'MODEL_AUTH_FAILED',
    'MODEL_RATE_LIMITED',
    'MODEL_TIMEOUT',
    'MODEL_NETWORK_ERROR',
    'MODEL_SERVER_ERROR',
    'MODEL_HTTP_ERROR',
    'MODEL_CANCELLED',
    'MODEL_RESPONSE_TOO_LARGE',
    'MODEL_CHANGED',
    'MODEL_USAGE_INVALID',
    'MODEL_SENSITIVE_OUTPUT',
    'MODEL_DUPLICATE_OUTPUT',
    'INVALID_TEXT',
    'PERSONA_MODEL_FORMAT_INVALID',
    'KNOWLEDGE_CONTEXT_CHANGED',
    'INVALID_MODEL_KEY',
    'MODEL_PAUSED',
    'GRANT_REVOKED',
    'SECURITY_CHANNEL_HELD',
    'SECURITY_STATE_CHANGED',
    'ASSISTANT_AUTHENTICATION_FAILED',
    'ASSISTANT_INSTANCE_CHANGED',
    'OWNER_PORT_RESERVED',
  ];
  for (const code of requiredCodes) {
    expect(reasons[code], code).toBeTruthy();
    expect(explain(code)).toBe(reasons[code]);
    expect(explain(new Error(code))).toBe(reasons[code]);
    expect(describeKnowledgeError(code)).toBe(reasons[code]);
  }
});
