import type { KnowledgeOverview, OnnxEmbeddingStatus } from '../../src/contracts/knowledge.js';
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
const desktopInfoMock = vi.fn();

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
  return {
    ...actual,
    request: (...args: unknown[]) => requestMock(...args),
    desktopInfo: (...args: unknown[]) => desktopInfoMock(...args),
  };
});

import { FaqSuggestionsPanel } from './FaqSuggestionsPanel';
import { KnowledgeRetrievalDebugger } from './KnowledgeRetrievalDebugger';
import { KnowledgeSettings } from './KnowledgeSettings';
import type { FaqSuggestion, KnowledgeAction, PerformKnowledge } from './knowledge-client';

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
  const match = findAll(tree, el => el.props['aria-label'] === ariaLabel)[0];
  expect(match, `Expected control with aria-label="${ariaLabel}"`).toBeTruthy();
  return match!;
}

beforeEach(() => {
  requestMock.mockReset();
  desktopInfoMock.mockReset();
  desktopInfoMock.mockResolvedValue({ runtime: 'synthetic', version: '0.3.5', features: { replyKnowledge: true } });
});

afterEach(() => {
  activeHooks = null;
});

const baseOverview: KnowledgeOverview = {
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

const pendingSuggestion: FaqSuggestion = {
  id: '2f5a1234-1234-4123-8123-1234567890ab',
  accountId: 'account_001',
  clusterDigest: 'digest-1',
  channels: ['DIRECT_MESSAGE', 'COMMENT_NOTIFICATION'],
  question: '发货后几天能到？',
  variants: ['快递多久到', '几天能收到货'],
  suggestedAnswer: '默认顺丰发货，省内次日达，省外 2 至 3 天送达。',
  sampleCount: 4,
  sourceEventIds: ['evt-1', 'evt-2'],
  status: 'PENDING',
  createdAt: 1794000000000,
  updatedAt: 1794000001000,
};

test('KnowledgeSettings renders 5th tab 候选 FAQ', () => {
  const html = renderToStaticMarkup(createElement(KnowledgeSettings, { accountId: 'account_001' }));
  expect(html).toContain('id="knowledge-tab-faq-suggestions"');
  expect(html).toContain('候选 FAQ');
});

test('FaqSuggestionsPanel loads list, supports generate, inline edit + adopt, and dismiss', async () => {
  requestMock.mockResolvedValueOnce({ suggestions: [pendingSuggestion] });
  const performMock = vi.fn(
    async (
      _label: string,
      action: KnowledgeAction | (() => Promise<unknown>),
      onSuccess?: (result: unknown) => void,
      _refresh?: boolean,
    ) => {
      const result = typeof action === 'function' ? await action() : await requestMock({ command: 'replyKnowledge', ...action });
      onSuccess?.(result);
    },
  );
  const perform: PerformKnowledge = performMock as unknown as PerformKnowledge;

  const view = mountComponent(FaqSuggestionsPanel, {
    overview: baseOverview,
    busy: false,
    perform,
  });
  try {
    await vi.waitFor(() => expect(view.markup()).toContain('发货后几天能到？'));
    expect(requestMock).toHaveBeenNthCalledWith(1, {
      command: 'replyKnowledge',
      action: 'listFaqSuggestions',
      status: 'PENDING',
    });

    const html = view.markup();
    expect(html).toContain('发货后几天能到？');
    expect(html).toContain('快递多久到');
    expect(html).toContain('来自 4 条已确认人工回复');
    expect(html).toContain('私信 / 评论');

    // Inline edit title, topic, aliases, text and adopt
    (findByAriaLabel(view.getTree(), `入库知识标题-${pendingSuggestion.id}`).props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: '配送与到货时效说明' },
    });
    (findByAriaLabel(view.getTree(), `所属主题-${pendingSuggestion.id}`).props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: '物流配送' },
    });
    (findByAriaLabel(view.getTree(), `相似问法关键词-${pendingSuggestion.id}`).props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: '快递多久到, 几天送达' },
    });
    (findByAriaLabel(view.getTree(), `标准回复正文-${pendingSuggestion.id}`).props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: '省内次日达，省外 2-3 天送达。' },
    });

    requestMock
      .mockResolvedValueOnce({ suggestion: { ...pendingSuggestion, status: 'ADOPTED' }, entry: { id: 'k-1' } })
      .mockResolvedValueOnce([]);
    (findButton(view.getTree(), '采纳并入库').props.onClick as () => void)();
    await vi.waitFor(() => expect(performMock).toHaveBeenCalledTimes(1));
    expect(performMock.mock.calls[0]![1]).toEqual({
      action: 'adoptFaqSuggestion',
      suggestionId: pendingSuggestion.id,
      title: '配送与到货时效说明',
      topic: '物流配送',
      text: '省内次日达，省外 2-3 天送达。',
      aliases: ['快递多久到', '几天送达'],
      channels: ['DIRECT_MESSAGE', 'COMMENT_NOTIFICATION'],
      activate: true,
    });
    expect(performMock.mock.calls[0]![3]).toBe(true);
    await vi.waitFor(() => {
      const m = view.markup();
      expect(m).toContain('已将「配送与到货时效说明」采纳并启用至知识库');
      expect(m).not.toContain('读取中…');
    });

    // Generate FAQ suggestions
    requestMock
      .mockResolvedValueOnce([pendingSuggestion])
      .mockResolvedValueOnce([pendingSuggestion]);
    (findButton(view.getTree(), '从已解决人工对话提炼').props.onClick as () => void)();
    await vi.waitFor(() => expect(performMock).toHaveBeenCalledTimes(2));
    expect(performMock.mock.calls[1]![1]).toEqual({ action: 'generateFaqSuggestions' });

    // Dismiss suggestion
    await vi.waitFor(() => {
      const m = view.markup();
      expect(m).toContain('丢弃不再提示');
      expect(m).not.toContain('读取中…');
    });
    requestMock
      .mockResolvedValueOnce({ ...pendingSuggestion, status: 'DISMISSED' })
      .mockResolvedValueOnce([]);
    (findButton(view.getTree(), '丢弃不再提示').props.onClick as () => void)();
    await vi.waitFor(() => expect(performMock).toHaveBeenCalledTimes(3));
    expect(performMock.mock.calls[2]![1]).toEqual({
      action: 'dismissFaqSuggestion',
      suggestionId: pendingSuggestion.id,
    });
    await vi.waitFor(() => expect(view.markup()).toContain('已忽略该候选问答'));
  } finally {
    view.unmount();
  }
});

test('KnowledgeRetrievalDebugger auto-fetches embeddingStatus once on mount and respects statusEpoch ordering', async () => {
  const hybridStatus: OnnxEmbeddingStatus = {
    state: 'REUSED_LOCAL',
    engineMode: 'HYBRID_ONNX',
    modelId: 'bge-small-zh-v1.5-q8',
    modelPath: null,
    expectedSha256: null,
    actualSha256: null,
    sizeBytes: 25_000_000,
    dims: 512,
    checkedPaths: [],
    reason: 'REUSED_LOCAL',
    checkedAt: 1794000000000,
  };

  let resolveMountStatus!: (status: OnnxEmbeddingStatus) => void;
  requestMock.mockImplementationOnce(
    () => new Promise<OnnxEmbeddingStatus>(resolve => { resolveMountStatus = resolve; }),
  );

  const view = mountComponent(KnowledgeRetrievalDebugger, {
    channel: 'DIRECT_MESSAGE',
    sourceIds: [],
    draftMessage: '快递多久发？',
    busy: false,
  });
  try {
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenNthCalledWith(1, {
      command: 'replyKnowledge',
      action: 'embeddingStatus',
    });

    // While mount status is still in-flight, user runs debugRetrieval (higher statusEpoch)
    const fallbackStatus: OnnxEmbeddingStatus = {
      state: 'FALLBACK_FTS5',
      engineMode: 'FTS5_ENHANCED',
      modelId: 'bge-small-zh-v1.5-q8',
      modelPath: null,
      expectedSha256: null,
      actualSha256: null,
      sizeBytes: null,
      dims: 512,
      checkedPaths: [],
      reason: 'ONNX_RUNTIME_UNAVAILABLE',
      checkedAt: 1794000005000,
    };
    requestMock.mockResolvedValueOnce({
      engineMode: 'FTS5_ENHANCED',
      query: '运费',
      channel: 'DIRECT_MESSAGE',
      queryTerms: ['运费'],
      wordTerms: ['运费'],
      filteredStopTerms: [],
      minScore: 0.25,
      hits: [],
      rejectedBelowThreshold: [],
      conflicts: [],
      exactFaqHit: null,
      onnxStatus: fallbackStatus,
    });
    (findByAriaLabel(view.getTree(), '召回调试提问').props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: '运费' },
    });
    (findButton(view.getTree(), '预检命中知识').props.onClick as () => void)();
    await vi.waitFor(() => expect(view.markup()).toContain('已自动切换为关键词增强检索'));

    // Now the older mount embeddingStatus resolves with HYBRID_ONNX -> must be ignored because its statusEpoch is older!
    resolveMountStatus(hybridStatus);
    await Promise.resolve();
    await Promise.resolve();
    const afterStaleHtml = view.markup();
    expect(afterStaleHtml).toContain('已自动切换为关键词增强检索');
    expect(afterStaleHtml).not.toContain('ONNX');
    expect(afterStaleHtml).not.toContain('C:\\');

    // Manual refresh updates to latest HYBRID_ONNX status cleanly
    requestMock.mockResolvedValueOnce(hybridStatus);
    (findButton(view.getTree(), '检查索引状态').props.onClick as () => void)();
    await vi.waitFor(() => expect(view.markup()).toContain('关键词 + 本机语义混合检索'));
    const freshHtml = view.markup();
    expect(freshHtml).toContain('本机语义索引状态');
    expect(freshHtml).toContain('已通过本机校验并直接复用现有模型');
    expect(freshHtml).not.toContain('ONNX');
    expect(freshHtml).not.toContain('FTS5');
  } finally {
    view.unmount();
  }
});
