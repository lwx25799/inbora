import { DEFAULT_ACCOUNT_ID } from '../../src/contracts/account.js';
import {
  DEFAULT_REPLY_PIPELINE_PERSISTED_CONFIG,
  type ReplyPipelineStatusView,
} from '../../src/contracts/reply-pipeline.js';
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

import type { Status } from './api';
import { ReplyPipelineSettings, summarizeRhythmState } from './ReplyPipelineSettings';
import { AutomationView } from './views/AutomationView';

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

function findAll(
  node: ReactNode,
  predicate: (el: ReactElement<Record<string, unknown>>) => boolean,
  found: ReactElement<Record<string, unknown>>[] = [],
): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found);
    return found;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return found;
  if (predicate(node)) found.push(node);
  if ('children' in node.props) findAll(node.props.children as ReactNode, predicate, found);
  return found;
}

function findButton(tree: ReactNode, labelPart: string) {
  const match = findAll(tree, el => el.type === 'button' && textContent(el).includes(labelPart))[0];
  expect(match, `Expected button containing "${labelPart}"`).toBeTruthy();
  return match!;
}

function findByAriaLabel(tree: ReactNode, ariaLabel: string) {
  const match = findAll(
    tree,
    el => el.props['aria-label'] === ariaLabel || el.props.ariaLabel === ariaLabel,
  )[0];
  expect(match, `Expected control with aria-label="${ariaLabel}"`).toBeTruthy();
  return match!;
}

beforeEach(() => {
  requestMock.mockReset();
});

afterEach(() => {
  activeHooks = null;
});

function makeStatusView(overrides: Partial<ReplyPipelineStatusView> = {}): ReplyPipelineStatusView {
  return {
    configured: false,
    config: structuredClone(DEFAULT_REPLY_PIPELINE_PERSISTED_CONFIG),
    rhythmState: null,
    handoffSummary: {
      accountId: DEFAULT_ACCOUNT_ID,
      sinceMs: null,
      untilMs: null,
      channel: null,
      total: 0,
      byCategory: [],
      byReasonCode: [],
      byStage: [],
    },
    updatedAt: null,
    ...overrides,
  };
}

test('ReplyPipelineSettings loads initial config, edits all controls, and saves persisted config', async () => {
  const now = Date.now();
  const initialView = makeStatusView({
    configured: true,
    config: {
      ...structuredClone(DEFAULT_REPLY_PIPELINE_PERSISTED_CONFIG),
      rhythmProfile: 'natural',
      debounce: { enabled: true, windowMs: 3500 },
      sensitive: {
        customWords: ['微信号'],
        enablePlatformRedline: true,
        enablePromptInjectionGuard: true,
      },
      handoff: {
        mediaMessageHandoff: true,
        afterSalesHandoff: true,
        bargainHandoff: false,
        customTriggers: ['开发票'],
        knowledgeMissHandoff: false,
        knowledgeConflictHandoff: true,
        exactFaqDirectReply: false,
      },
    },
    rhythmState: {
      accountId: DEFAULT_ACCOUNT_ID,
      scope: 'ALL',
      profile: 'natural',
      lastActionAt: now - 10_000,
      nextAllowedAt: now - 1000,
      cooloffUntil: 0,
      windowTimestamps: [now - 60_000, now - 10_000],
      totalActions: 8,
      cooloffHits: 0,
      updatedAt: now - 10_000,
    },
    handoffSummary: {
      accountId: DEFAULT_ACCOUNT_ID,
      sinceMs: now - 7 * 86_400_000,
      untilMs: now,
      channel: null,
      total: 5,
      byCategory: [
        { key: 'AFTER_SALES', label: '售后/退款/投诉', count: 3, ratio: 0.6, percentage: 60 },
        { key: 'MEDIA_MESSAGE', label: '买家发图/媒体', count: 2, ratio: 0.4, percentage: 40 },
      ],
      byReasonCode: [],
      byStage: [],
    },
    updatedAt: now - 5000,
  });

  requestMock.mockResolvedValueOnce(initialView);
  const onSaved = vi.fn();
  const view = mountComponent(ReplyPipelineSettings, { accountId: DEFAULT_ACCOUNT_ID, onSaved });
  try {
    await vi.waitFor(() => expect(view.markup()).toContain('近 5 分钟动作：2 次'));
    expect(requestMock).toHaveBeenNthCalledWith(1, { command: 'replyPipeline', action: 'getConfig' });

    const loadedHtml = view.markup();
    expect(loadedHtml).toContain('近 5 分钟动作：2 次');
    expect(loadedHtml).toContain('累计已记录：8 次');
    expect(loadedHtml).toContain('近 7 天转人工归因摘要');
    expect(loadedHtml).toContain('售后/退款/投诉');
    expect(loadedHtml).toContain('3 次（60%）');
    expect(loadedHtml).toContain('微信号');
    expect(loadedHtml).toContain('开发票');
    expect(loadedHtml).toContain('精确命中高置信标准问答时免调模型直接回复，仍经过安全核查与唯一发送通道');
    expect(loadedHtml).not.toMatch(/无头|有头|schema3|schema4|DPAPI|协议\s*v2|FTS5|ONNX/iu);

    // Switch rhythm profile to calm, change debounce to 4500ms, toggle bargainHandoff & exactFaqDirectReply
    (findButton(view.getTree(), '保守').props.onClick as () => void)();
    (findByAriaLabel(view.getTree(), '静默聚合等待时长').props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: '4500' },
    });
    (findByAriaLabel(view.getTree(), '议价/砍价转人工').props.onChange as (checked: boolean) => void)(true);
    (findByAriaLabel(view.getTree(), '高置信 FAQ 精确直出').props.onChange as (checked: boolean) => void)(true);

    // Add a custom sensitive word and remove existing trigger word
    const sensitiveInput = findByAriaLabel(view.getTree(), '添加商家自定义敏感词');
    (sensitiveInput.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: '私下转账' },
    });
    const addButtons = findAll(view.getTree(), el => el.type === 'button' && textContent(el).trim() === '添加');
    (addButtons[0]!.props.onClick as () => void)();
    (findByAriaLabel(view.getTree(), '移除 开发票').props.onClick as () => void)();

    const savedResponse = makeStatusView({
      ...initialView,
      config: {
        ...initialView.config,
        rhythmProfile: 'calm',
        debounce: { enabled: true, windowMs: 4500 },
        sensitive: {
          ...initialView.config.sensitive,
          customWords: ['微信号', '私下转账'],
        },
        handoff: {
          ...initialView.config.handoff,
          bargainHandoff: true,
          customTriggers: [],
          exactFaqDirectReply: true,
        },
      },
      updatedAt: now,
    });
    requestMock.mockResolvedValueOnce(savedResponse);
    (findButton(view.getTree(), '保存保护与节流设置').props.onClick as () => void)();

    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledTimes(2));
    expect(requestMock).toHaveBeenNthCalledWith(2, {
      command: 'replyPipeline',
      action: 'saveConfig',
      config: {
        rhythmProfile: 'calm',
        debounce: { enabled: true, windowMs: 4500 },
        sensitive: {
          customWords: ['微信号', '私下转账'],
          enablePlatformRedline: true,
          enablePromptInjectionGuard: true,
        },
        handoff: {
          mediaMessageHandoff: true,
          afterSalesHandoff: true,
          bargainHandoff: true,
          customTriggers: [],
          knowledgeMissHandoff: false,
          knowledgeConflictHandoff: true,
          exactFaqDirectReply: true,
        },
        loopBreaker: { enabled: true },
      },
    });
    expect(onSaved).toHaveBeenCalledWith(savedResponse);
    expect(view.markup()).toContain('自动回复保护与节流设置已保存');
  } finally {
    view.unmount();
  }
});

test('ReplyPipelineSettings translates INVALID_PIPELINE_CONFIG and summarizes cooloff state', async () => {
  const now = 1_800_000_000_000;
  const summary = summarizeRhythmState(
    {
      accountId: DEFAULT_ACCOUNT_ID,
      scope: 'ALL',
      profile: 'calm',
      lastActionAt: now - 5_000,
      nextAllowedAt: now + 90_000,
      cooloffUntil: now + 90_000,
      windowTimestamps: [now - 100_000, now - 5_000, now - 400_000],
      totalActions: 12,
      cooloffHits: 1,
      updatedAt: now - 5_000,
    },
    'calm',
    now,
  );
  expect(summary.recentCount).toBe(2);
  expect(summary.totalActions).toBe(12);
  expect(summary.statusLabel).toContain('冷却等待中');

  requestMock.mockResolvedValueOnce(makeStatusView());
  const view = mountComponent(ReplyPipelineSettings, { accountId: DEFAULT_ACCOUNT_ID });
  try {
    await vi.waitFor(() => expect(view.markup()).not.toContain('正在读取当前保护与节流设置'));
    requestMock.mockRejectedValueOnce(new Error('INVALID_PIPELINE_CONFIG'));
    (findButton(view.getTree(), '保存保护与节流设置').props.onClick as () => void)();
    await vi.waitFor(() => expect(view.markup()).toContain('自动回复保护与节流设置不符合要求'));
  } finally {
    view.unmount();
  }
});

test('AutomationView mounts ReplyPipelineSettings below AutomationSettings', () => {
  const status: Status = {
    runtime: 'synthetic',
    account: { id: DEFAULT_ACCOUNT_ID, identity: 'own-1' },
    operator: { id: 'op-1', permissions: ['READ', 'EDIT', 'SEND', 'CONTROL'], expiresAt: Date.now() + 60_000 },
    mode: 'MANUAL',
    configuredMode: 'MANUAL',
    paused: false,
    browser: { state: 'OPEN_LAST_READ_VERIFIED', mode: 'headless', loginRecovery: false, version: '130' },
    lastSync: [],
    capabilities: [],
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
  };
  const html = renderToStaticMarkup(
    createElement(AutomationView, {
      status,
      busy: '',
      act: async (_label, fn) => fn(),
      update: () => {},
      promptsState: {
        prompts: { persona: '', business: '', rules: '' },
        promptBusy: false,
        promptError: '',
        promptNotice: '',
        canSavePrompts: true,
        devRecoveryRestoring: false,
        updatePromptField: () => {},
        savePrompts: async () => {},
      },
      toggleAuto: async () => {},
      pendingAutoReply: null,
    }),
  );
  expect(html).toContain('后台收取与持续授权');
  expect(html).toContain('自动回复保护、节奏控制与转人工');
});
