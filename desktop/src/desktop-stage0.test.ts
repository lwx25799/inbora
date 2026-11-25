import { DEFAULT_ACCOUNT_ID } from '../../src/contracts/account.js';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

interface HookDispatcher {
  useState: <T>(initial: T | (() => T)) => [T, (next: T | ((prev: T) => T)) => void];
  useRef: <T>(initial: T) => { current: T };
  useEffect: (fn: () => (() => void) | void, deps?: readonly unknown[]) => void;
}
let activeHooks: HookDispatcher | null = null;
const requestMock = vi.fn();
const listenMock = vi.fn();
const invokeMock = vi.fn();

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

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return { ...actual, request: (...args: unknown[]) => requestMock(...args) };
});

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));
vi.mock('@tauri-apps/api/core', () => ({invoke: (...args: unknown[]) => invokeMock(...args)}));

import type { Status, Thread } from './api';
import { explain, reasons, runtimeSession, type BusinessPrompts } from './api';
import { AutomationSettings } from './AutomationSettings';
import { DiagnosticsPanel } from './DiagnosticsPanel';
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

beforeEach(() => {
  requestMock.mockReset();
  listenMock.mockReset();
  invokeMock.mockReset();
});

afterEach(() => {
  activeHooks = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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
    rerender: (nextProps: P) => {
      currentProps = nextProps;
      render();
    },
    unmount: () => {
      for (const effect of effects) effect?.cleanup?.();
    },
  };
}

function textContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textContent(node.props.children);
  return '';
}

function findAllElements(
  node: ReactNode,
  predicate: (el: ReactElement<Record<string, unknown>>) => boolean,
  found: ReactElement<Record<string, unknown>>[] = [],
): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) {
    for (const child of node) findAllElements(child, predicate, found);
    return found;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return found;
  if (predicate(node)) found.push(node);
  if ('children' in node.props) findAllElements(node.props.children as ReactNode, predicate, found);
  return found;
}

function findButton(tree: ReactNode, label: string) {
  const match = findAllElements(tree, el => el.type === 'button' && textContent(el).trim() === label)[0];
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

function findControlByLabel(tree: ReactNode, labelPart: string, tag: 'input' | 'textarea') {
  const label = findAllElements(tree, el => el.type === 'label' && textContent(el).includes(labelPart))[0];
  if (!label) throw new Error(`Label not found: ${labelPart}`);
  const control = findAllElements(label, el => el.type === tag)[0];
  if (!control) throw new Error(`Control ${tag} not found under label: ${labelPart}`);
  return control;
}

function baseStatus(overrides: Partial<Status> = {}): Status {
  return {
    runtime: 'synthetic-stage0',
    account: { id: DEFAULT_ACCOUNT_ID, identity: 'own-1' },
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
        accountId: DEFAULT_ACCOUNT_ID,
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
      updatePrompts: () => {},
      updateProviders: () => {},
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
      title: '业务提示词',
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
      title: '业务提示词',
      open: true,
      onClose: () => {},
      notice: '业务提示词已保存',
      children: createElement('div'),
    }),
  );
  expect(noticeHtml).toContain('role="status"');
  expect(noticeHtml).toContain('业务提示词已保存');
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

test('ReplyComposer uses 500-codepoint ruler aligned with validText and gates quoting on ownership, intent and readOnly without using send freeze', () => {
  const status = baseStatus();
  const owned = baseThread('DIRECT_MESSAGE', { frozen: true });
  const ownedHtml = renderToStaticMarkup(createElement(ReplyComposer, replyViewProps(owned, status)));
  expect(ownedHtml).toContain('0/500 字');
  expect(ownedHtml).not.toContain('/2000 字');
  expect(ownedHtml).toMatch(/<button(?![^>]*disabled)[^>]*>引用到编辑器<\/button>/u);

  const emojiHtml = renderToStaticMarkup(
    createElement(ReplyComposer, { ...replyViewProps(owned, status), text: '😀'.repeat(500) }),
  );
  expect(emojiHtml).toContain('500/500 字');
  expect(emojiHtml).not.toContain('1000/500 字');

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

test('AutomationSettings syncs baseline on model grant and policy revoke without getting stuck dirty or overwriting in-flight typing', async () => {
  const s1 = baseStatus();
  const s2 = baseStatus({
    automation: {
      ...s1.automation!,
      modelGrant: {
        version: 1,
        kind: 'MODEL',
        createdAt: 100,
        scope: {
          ownId: 'own-1',
          channels: ['COMMENT_NOTIFICATION', 'DIRECT_MESSAGE'],
          model: 'deepseek-flash',
          modelLimit: 15,
          expiresAt: null,
        },
      },
    },
  });
  const s3 = baseStatus({
    automation: {
      ...s2.automation!,
      modelGrant: {
        ...s2.automation!.modelGrant!,
        version: 2,
        scope: { ...s2.automation!.modelGrant!.scope, modelLimit: 25 },
      },
    },
  });
  let currentStatus = s1;
  const makeProps = (status: Status) => ({
    status,
    busy: '',
    act: async (_label: string, fn: () => Promise<void>) => fn(),
    update: (next: Status) => {
      currentStatus = next;
      view.rerender(makeProps(next));
    },
  });
  const view = mountComponent(AutomationSettings, makeProps(currentStatus));
  try {
    // 1. Edit modelLimit and click 仅启用模型授权 -> baseline syncs so later backend status updates propagate.
    const modelInput = findControlByLabel(view.getTree(), '本次持续授权的模型次数', 'input');
    (modelInput.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: '15' } });
    requestMock.mockResolvedValueOnce(s2);
    const grantBtn = findButton(view.getTree(), '仅启用模型授权');
    await (grantBtn.props.onClick as () => Promise<void>)();
    expect(findControlByLabel(view.getTree(), '本次持续授权的模型次数', 'input').props.value).toBe(15);

    view.rerender(makeProps(s3));
    expect(findControlByLabel(view.getTree(), '本次持续授权的模型次数', 'input').props.value).toBe(25);

    // 2. Edit instructions on an active policy, click 撤销自动回复策略 -> resets cleanly and tracks later status.
    const activePolicyStatus = baseStatus({
      automation: {
        ...s3.automation!,
        replyPolicy: {
          version: 1,
          kind: 'AUTO_REPLY',
          createdAt: 200,
          scope: {
            ownId: 'own-1',
            channels: ['DIRECT_MESSAGE'],
            model: 'deepseek-flash',
            modelLimit: 25,
            sendLimit: 10,
            expiresAt: null,
            workIds: [],
            futureOwnWorks: false,
            conversationIds: [],
            entireInbox: true,
            containsAny: [],
            excludesAny: [],
            instructions: '已保存规则',
            startHour: 8,
            endHour: 22,
          },
        },
      },
    });
    view.rerender(makeProps(activePolicyStatus));
    expect(findControlByLabel(view.getTree(), '自动回复规则', 'textarea').props.value).toBe('已保存规则');
    (findControlByLabel(view.getTree(), '自动回复规则', 'textarea').props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: '未保存临时改动' },
    });
    const afterRevoke = baseStatus({
      settings: { ...s1.settings, rules: '撤销后默认规则' },
      automation: { ...activePolicyStatus.automation!, replyPolicy: null },
    });
    requestMock.mockResolvedValueOnce(afterRevoke);
    await (findButton(view.getTree(), '撤销自动回复策略').props.onClick as () => Promise<void>)();
    expect(findControlByLabel(view.getTree(), '自动回复规则', 'textarea').props.value).toBe('撤销后默认规则');

    const laterBackend = baseStatus({
      settings: { ...s1.settings, rules: '远端最新默认规则' },
      automation: { ...afterRevoke.automation!, replyPolicy: null },
    });
    view.rerender(makeProps(laterBackend));
    expect(findControlByLabel(view.getTree(), '自动回复规则', 'textarea').props.value).toBe('远端最新默认规则');

    // 3. In-flight typing while enableReplyPolicy is pending must NOT be overwritten when response returns.
    (findControlByLabel(view.getTree(), '回复策略覆盖本号运行起点后所有新视频', 'input').props.onChange as (e: { target: { checked: boolean } }) => void)({
      target: { checked: true },
    });
    (findControlByLabel(view.getTree(), '回复策略覆盖本账号已启用收件箱内的新会话', 'input').props.onChange as (e: { target: { checked: boolean } }) => void)({
      target: { checked: true },
    });
    (findControlByLabel(view.getTree(), '自动回复规则', 'textarea').props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: '第一版规则' },
    });
    let resolvePolicy!: (value: Status) => void;
    requestMock.mockReturnValueOnce(new Promise<Status>(resolve => { resolvePolicy = resolve; }));
    const savePromise = (findButton(view.getTree(), '按此范围启用规则自动回复').props.onClick as () => Promise<void>)();
    // User keeps typing before the save request completes.
    (findControlByLabel(view.getTree(), '自动回复规则', 'textarea').props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: '第一版规则+在途键入' },
    });
    resolvePolicy(
      baseStatus({
        automation: {
          ...laterBackend.automation!,
          replyPolicy: {
            version: 2,
            kind: 'AUTO_REPLY',
            createdAt: 300,
            scope: {
              ownId: 'own-1',
              channels: ['COMMENT_NOTIFICATION', 'DIRECT_MESSAGE'],
              model: 'deepseek-flash',
              modelLimit: 25,
              sendLimit: 1,
              expiresAt: null,
              workIds: [],
              futureOwnWorks: true,
              conversationIds: [],
              entireInbox: true,
              containsAny: [],
              excludesAny: [],
              instructions: '第一版规则',
              startHour: 0,
              endHour: 24,
            },
          },
        },
      }),
    );
    await savePromise;
    expect(findControlByLabel(view.getTree(), '自动回复规则', 'textarea').props.value).toBe('第一版规则+在途键入');
  } finally {
    view.unmount();
  }
});

test('Settings saves only business prompts, follows idle updates and preserves in-flight typing', async () => {
  const selection = {connectionId: '64ce7003-91f9-41e1-bc3e-60611c81b002', routeRevision: 1, modelId: 'deepseek-flash', selectionRevision: 1};
  let status = baseStatus({modelProvidersSupported:true, modelProviders: {connections: [], selection}});
  const update = vi.fn();
  const makeProps = (snapshot: Status) => ({
    status: snapshot,
    runtime: 'synthetic-runtime',
    busy: '',
    error: '',
    notice: '',
    act: async (_label: string, fn: () => Promise<void>) => fn(),
    update,
    updatePrompts, updateProviders: update,
    stop: () => {},
    toggleAuto: async () => {},
    pendingAutoReply: null,
  });
  const updatePrompts = vi.fn<(session: string, prompts: BusinessPrompts) => void>();
  const view = mountComponent(Settings, makeProps(status));
  const rules = () => findControlByLabel(view.getTree(), '回复规则', 'textarea');
  const edit = (value: string) => (rules().props.onChange as (event: {target: {value: string}}) => void)({target: {value}});
  const save = () => (findButton(view.getTree(), '保存业务提示词').props.onClick as () => Promise<void>)();
  try {
    (findButton(view.getTree(), '编辑业务提示词').props.onClick as () => void)();
    expect(findAllElements(view.getTree(), el => el.type === SettingsDialog)[0]?.props.open).toBe(true);
    edit('规则A');
    const obsolete = {...status, settings: {...status.settings, rules: '规则A'}};
    status = {...status, settings: {...status.settings, model: 'new-model'}, keyPresent: false,
      modelProviders: {connections: [], selection: {...selection, modelId: 'new-model', selectionRevision: 2}}};
    view.rerender(makeProps(status));
    invokeMock.mockResolvedValueOnce(obsolete);
    await save();
    const prompts = {persona: '人设', business: '业务', rules: '规则A'};
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'client_request', {body: {command: 'configureAi', settings: prompts}});
    expect(updatePrompts).toHaveBeenNthCalledWith(1, runtimeSession(status), prompts);
    expect(update).not.toHaveBeenCalled();
    expect(rules().props.value).toBe('规则A');

    status = {...status, settings: {...status.settings, rules: '后端同步规则'}};
    view.rerender(makeProps(status));
    expect(rules().props.value).toBe('后端同步规则');

    edit('规则B');
    let resolveSave!: (value: Status) => void;
    invokeMock.mockReturnValueOnce(new Promise<Status>(resolve => { resolveSave = resolve; }));
    const saving = save();
    expect(findButton(view.getTree(), '保存业务提示词').props.disabled).toBe(true);
    expect(findButton(view.getTree(), '编辑业务提示词').props.disabled).toBeUndefined();
    edit('规则B+继续编辑');
    resolveSave({...obsolete, settings: {...obsolete.settings, rules: '规则B'}});
    await saving;
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'client_request', {body: {command: 'configureAi', settings: {...prompts, rules: '规则B'}}});
    expect(updatePrompts).toHaveBeenNthCalledWith(2, runtimeSession(status), {...prompts, rules: '规则B'});
    expect(rules().props.value).toBe('规则B+继续编辑');
    expect(findButton(view.getTree(), '保存业务提示词').props.disabled).toBe(false);
  } finally {
    view.unmount();
  }
});

test('DiagnosticsPanel ignores sidecar_response_too_large and knowledge_updated to prevent 150ms retry loops while refreshing on normal events', async () => {
  vi.useFakeTimers();
  const focusListeners = new Set<() => void>();
  vi.stubGlobal('window', {
    addEventListener: (name: string, fn: () => void) => { if (name === 'focus') focusListeners.add(fn); },
    removeEventListener: (name: string, fn: () => void) => { if (name === 'focus') focusListeners.delete(fn); },
  });
  let emitStatus: ((event: { payload?: { event?: unknown } }) => void) | null = null;
  const unlisten = vi.fn();
  listenMock.mockImplementation(async (_name: string, handler: (event: { payload?: { event?: unknown } }) => void) => {
    emitStatus = handler;
    return unlisten;
  });
  const snapshot = {
    version: 1,
    timeRangeSupported: false,
    model: {
      total: { requests: 1, knownUsageRequests: 1, unknownUsageRequests: 0, inputTokens: 10, outputTokens: 5, elapsedSamples: 1, averageElapsedMs: 20, p95ElapsedMs: 20 },
      groups: [],
    },
    blockers: [],
    collection: { channels: [], works: { included: 0, historical: 0, review: 0 }, conversations: { total: 0, neverRead: 0 } },
    performance: [],
    evidence: { running: false, nextAt: 0, error: null, report: null },
  };
  requestMock.mockResolvedValue(snapshot);

  const view = mountComponent(DiagnosticsPanel, {});
  try {
    // Allow listen() promise to resolve and initial delay=0 refresh to run.
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(emitStatus).not.toBeNull();

    // Ignored events must not schedule any refresh.
    emitStatus!({ payload: { event: 'sidecar_response_too_large' } });
    emitStatus!({ payload: { event: 'knowledge_updated' } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(requestMock).toHaveBeenCalledTimes(1);

    // Paired positive cases: diagnostics_updated and send_status_updated DO schedule refreshes.
    emitStatus!({ payload: { event: 'diagnostics_updated' } });
    await vi.advanceTimersByTimeAsync(150);
    expect(requestMock).toHaveBeenCalledTimes(2);

    emitStatus!({ payload: { event: 'send_status_updated' } });
    await vi.advanceTimersByTimeAsync(150);
    expect(requestMock).toHaveBeenCalledTimes(3);
  } finally {
    view.unmount();
  }
  expect(unlisten).toHaveBeenCalledTimes(1);
  expect(focusListeners.size).toBe(0);
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
  expect(reasons.INVALID_TEXT).toContain('500 字');
  expect(reasons.INVALID_TEXT).not.toContain('2000 字');
});
