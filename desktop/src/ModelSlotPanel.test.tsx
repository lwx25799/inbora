import { DEFAULT_ACCOUNT_ID } from '../../src/contracts/account.js';
import {
  DEFAULT_ACCOUNT_AI_FEATURES,
  type AccountAiFeatures,
  type MediaAssetSummary,
} from '../../src/contracts/ai-runtime.js';
import type { PublicModelConnection, PublicModelSlots, PublicModelState } from '../../src/contracts/model-providers.js';
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

import { setActiveWorkbenchAccount, type Status } from './api';
import { AiRuntimeFeaturesPanel } from './AiRuntimeFeaturesPanel';
import { explain } from './error-messages';
import { ModelSlotPanel } from './ModelSlotPanel';
import { ModelsPageView } from './views/ModelsPageView';

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

function findByAriaLabel(tree: ReactNode, ariaLabel: string) {
  const match = findAll(
    tree,
    el => el.props['aria-label'] === ariaLabel || el.props.ariaLabel === ariaLabel,
  )[0];
  expect(match, `Expected control with aria-label="${ariaLabel}"`).toBeTruthy();
  return match!;
}

function findButton(tree: ReactNode, labelPart: string) {
  const match = findAll(tree, el => el.type === 'button' && textContent(el).includes(labelPart))[0];
  expect(match, `Expected button containing "${labelPart}"`).toBeTruthy();
  return match!;
}

const conn1Id = '11111111-1111-4111-8111-111111111111';
const conn2Id = '22222222-2222-4222-8222-222222222222';
const assetId = '33333333-3333-4333-8333-333333333333';

const sampleConnections: PublicModelConnection[] = [
  {
    id: conn1Id,
    name: 'DeepSeek 主力',
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
  },
  {
    id: conn2Id,
    name: 'OpenAI 视觉',
    presetId: 'openai',
    version: 2,
    draftRevision: 3,
    models: [
      { modelId: 'gpt-4o', displayName: 'GPT-4o', source: 'DISCOVERED' },
      { modelId: 'gpt-4o-mini', displayName: 'GPT-4o mini', source: 'DISCOVERED' },
    ],
    modelsFetchedAt: 1794000000000,
    modelsTruncated: false,
    totalModelCount: 2,
    draft: {
      presetId: 'openai',
      protocol: 'OPENAI_RESPONSES',
      baseUrl: 'https://api.openai.com/v1',
      region: null,
      routeRevision: 3,
      keyPresent: true,
      keyStored: true,
      storage: 'DPAPI',
      unavailableReason: null,
      catalogResult: null,
      testResult: null,
    },
    applied: null,
  },
];

const baseProviderState: PublicModelState = {
  connections: sampleConnections,
  selection: {
    connectionId: conn1Id,
    routeRevision: 1,
    modelId: 'deepseek-chat',
    modelDisplayName: 'DeepSeek Chat',
    selectionRevision: 1,
  },
};

beforeEach(() => {
  requestMock.mockReset();
  setActiveWorkbenchAccount(null);
});

afterEach(() => {
  activeHooks = null;
  setActiveWorkbenchAccount(null);
});

test('ModelSlotPanel shows 4 slots and fallback rules when only primary is configured', async () => {
  const initialSlots: PublicModelSlots = {
    primary: baseProviderState.selection,
    vision: null,
    utility: null,
    embedding: null,
  };
  requestMock.mockResolvedValueOnce(initialSlots);

  const view = mountComponent(ModelSlotPanel, { state: baseProviderState, available: true });
  try {
    await vi.waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith({ command: 'modelProviders', action: 'getSlots' }),
    );
    const html = view.markup();
    expect(html).toContain('主对话模型');
    expect(html).toContain('视觉看图模型');
    expect(html).toContain('后台辅助模型');
    expect(html).toContain('云端文本向量');
    expect(html).toContain('deepseek-chat');
    expect(html).toContain('未配置时转人工');
    expect(html).toContain('自动回退主模型');
    expect(html).toContain('优先本机或词检索');
    expect(html).toContain('仅用于解析开启看图开关后的客户截图或图片');
    expect(html).toContain('必要时自动回退至主对话模型');
    expect(html).toContain('自动降级为增强关键词检索');
    expect(html).not.toMatch(/无头|有头|schema3|schema4|DPAPI|协议\s*v2/iu);
  } finally {
    view.unmount();
  }
});

test('ModelSlotPanel binds and clears vision slot via setSlot', async () => {
  const initialSlots: PublicModelSlots = {
    primary: baseProviderState.selection,
    vision: null,
    utility: null,
    embedding: null,
  };
  const boundSlots: PublicModelSlots = {
    ...initialSlots,
    vision: {
      slot: 'vision',
      connectionId: conn2Id,
      routeRevision: 3,
      modelId: 'gpt-4o',
      revision: 1,
      updatedAt: 1794000010000,
    },
  };
  requestMock.mockResolvedValueOnce(initialSlots);

  const view = mountComponent(ModelSlotPanel, { state: baseProviderState, available: true });
  try {
    await vi.waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith({ command: 'modelProviders', action: 'getSlots' }),
    );

    const visionConnSelect = findByAriaLabel(view.getTree(), '视觉看图模型连接');
    (visionConnSelect.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: conn2Id },
    });
    const visionModelSelect = findByAriaLabel(view.getTree(), '视觉看图模型模型');
    (visionModelSelect.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: 'gpt-4o' },
    });

    requestMock.mockResolvedValueOnce(boundSlots);
    const saveVisionBtn = findByAriaLabel(view.getTree(), '保存视觉看图模型');
    (saveVisionBtn.props.onClick as () => void)();

    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledTimes(2));
    expect(requestMock.mock.calls[1]![0]).toMatchObject({
      command: 'modelProviders',
      action: 'setSlot',
      slot: 'vision',
      connectionId: conn2Id,
      routeRevision: 3,
      modelId: 'gpt-4o',
      confirmed: true,
    });
    expect(typeof requestMock.mock.calls[1]![0].commandId).toBe('string');
    expect(view.markup()).toContain('已保存「视觉看图模型」绑定');
    expect(view.markup()).toContain('gpt-4o');

    requestMock.mockResolvedValueOnce(initialSlots);
    const clearVisionBtn = findByAriaLabel(view.getTree(), '清除视觉看图模型');
    (clearVisionBtn.props.onClick as () => void)();

    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledTimes(3));
    expect(requestMock.mock.calls[2]![0]).toMatchObject({
      command: 'modelProviders',
      action: 'setSlot',
      slot: 'vision',
      connectionId: null,
      routeRevision: null,
      modelId: null,
      confirmed: true,
    });
    expect(view.markup()).toContain('已清除「视觉看图模型」绑定，将按自动降级策略运行');
  } finally {
    view.unmount();
  }
});

test('AiRuntimeFeaturesPanel defaults vision OFF, saves features, manages mediaAssets, and toggles business tools', async () => {
  const initialFeatures: AccountAiFeatures = { ...DEFAULT_ACCOUNT_AI_FEATURES };
  const initialAsset: MediaAssetSummary = {
    id: assetId,
    name: '尺码表.png',
    mimeType: 'image/png',
    bytes: 2048,
    sha256: 'a'.repeat(64),
    createdAt: 1794000000000,
  };
  requestMock.mockResolvedValueOnce(initialFeatures).mockResolvedValueOnce({ assets: [initialAsset] });

  const view = mountComponent(AiRuntimeFeaturesPanel, {
    accountId: DEFAULT_ACCOUNT_ID,
    accountLabel: '主测试号',
  });
  try {
    await vi.waitFor(() => expect(view.markup()).toContain('尺码表.png'));
    expect(requestMock).toHaveBeenNthCalledWith(1, { command: 'accountAiFeatures', action: 'get' });
    expect(requestMock).toHaveBeenNthCalledWith(2, { command: 'mediaAssets', action: 'list' });

    const html = view.markup();
    expect(html).toContain('默认关闭；仅客户发来的截图或图片在开启后送入视觉模型，真实缓存头像与固定说明绝不送入模型');
    expect(html).toContain('仅只读查询，严禁写操作与绕过统一发送通道');

    const visionSwitch = findByAriaLabel(view.getTree(), '多模态看图开关');
    expect(visionSwitch.props.checked).toBe(false);
    (visionSwitch.props.onChange as (checked: boolean) => void)(true);

    const mediaSwitch = findByAriaLabel(view.getTree(), '素材库图片回复开关');
    expect(mediaSwitch.props.checked).toBe(false);
    (mediaSwitch.props.onChange as (checked: boolean) => void)(true);

    const orderCheckbox = findByAriaLabel(view.getTree(), '启用 查订单');
    (orderCheckbox.props.onChange as (e: { target: { checked: boolean } }) => void)({
      target: { checked: true },
    });
    const orderUrlInput = findByAriaLabel(view.getTree(), '查订单查询地址');
    (orderUrlInput.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: 'https://erp.example.com/readonly/order' },
    });

    const savedFeatures: AccountAiFeatures = {
      visionEnabled: true,
      mediaReplyEnabled: true,
      enabledBusinessTools: ['query_order_status'],
      toolEndpoints: { query_order_status: 'https://erp.example.com/readonly/order' },
      syncCustomerAvatars: false,
    };
    requestMock.mockResolvedValueOnce(savedFeatures);
    (findButton(view.getTree(), '保存账号能力配置').props.onClick as () => void)();

    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledTimes(3));
    expect(requestMock).toHaveBeenNthCalledWith(3, {
      command: 'accountAiFeatures',
      action: 'save',
      features: savedFeatures,
    });
    expect(view.markup()).toContain('已保存当前账号的多模态与只读业务工具配置');

    // Upload a valid PNG file -> base64 -> mediaAssets.save
    const uploadedAsset: MediaAssetSummary = {
      id: '44444444-4444-4444-8444-444444444444',
      name: '售后流程.png',
      mimeType: 'image/png',
      bytes: 4,
      sha256: 'b'.repeat(64),
      createdAt: 1794000020000,
    };
    requestMock.mockResolvedValueOnce({ asset: uploadedAsset });
    const fileInput = findByAriaLabel(view.getTree(), '上传素材图片');
    const mockFile = {
      name: '售后流程.png',
      type: 'image/png',
      size: 4,
      arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
    } as unknown as File;
    (fileInput.props.onChange as (e: { target: { files: File[] } }) => void)({
      target: { files: [mockFile] },
    });

    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledTimes(4));
    expect(requestMock).toHaveBeenNthCalledWith(4, {
      command: 'mediaAssets',
      action: 'save',
      name: '售后流程.png',
      base64: 'iVBORw==',
    });
    expect(view.markup()).toContain('售后流程.png');

    // Delete existing asset -> mediaAssets.delete
    requestMock.mockResolvedValueOnce({ deleted: true, assetId });
    (findByAriaLabel(view.getTree(), '删除素材 尺码表.png').props.onClick as () => void)();

    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledTimes(5));
    expect(requestMock).toHaveBeenNthCalledWith(5, {
      command: 'mediaAssets',
      action: 'delete',
      assetId,
    });
    expect(view.markup()).toContain('已删除素材图片「尺码表.png」');
    expect(view.markup()).not.toContain('删除素材 尺码表.png');

    // Reject oversized file (> 5 MiB) client-side without calling IPC
    const oversizedFile = {
      name: '超大图片.png',
      type: 'image/png',
      size: 5 * 1024 * 1024 + 1,
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    } as unknown as File;
    (fileInput.props.onChange as (e: { target: { files: File[] } }) => void)({
      target: { files: [oversizedFile] },
    });
    expect(requestMock).toHaveBeenCalledTimes(5);
    expect(view.markup()).toContain('超过 5 MiB 上限');
  } finally {
    view.unmount();
  }
});

test('ModelsPageView mounts slot routing and AI runtime panels with updated vision guardrail text and business error messages', () => {
  const status: Status = {
    runtime: 'synthetic-models',
    account: { id: DEFAULT_ACCOUNT_ID, identity: 'own-1' },
    operator: { id: 'op-1', permissions: ['READ', 'EDIT', 'SEND', 'CONTROL'], expiresAt: Date.now() + 60_000 },
    mode: 'MANUAL',
    configuredMode: 'MANUAL',
    paused: false,
    browser: { state: 'OPEN_LAST_READ_VERIFIED', mode: 'headless', loginRecovery: false, version: '130.0' },
    lastSync: [],
    capabilities: [{ channel: 'DIRECT_MESSAGE', state: 'SEND_AVAILABLE', reason: '', evidence: 'ok' }],
    budgets: [{ kind: 'MODEL', used: 1, maximum: null }],
    usage: { requests: 1, inputTokens: 100, outputTokens: 50, unresolved: 0 },
    settings: { model: 'deepseek-flash', persona: '', business: '', rules: '' },
    keyPresent: true,
    modelAuthorized: true,
    modelBusy: false,
    modelProvidersSupported: true,
    modelProvidersAvailable: true,
    modelProviders: baseProviderState,
    sync: { runId: null, running: false, cancelled: false, source: null, results: [] },
    go: 'UNVERIFIED',
    schema: 4,
  };

  const html = renderToStaticMarkup(
    createElement(ModelsPageView, { status, updateProviders: () => {} }),
  );
  expect(html).toContain('渐进四槽位模型路由');
  expect(html).toContain('账号级多模态与只读业务工具');

  const missingStateHtml = renderToStaticMarkup(
    createElement(ModelsPageView, {
      status: {
        ...status,
        modelProvidersSupported: undefined,
        modelProvidersAvailable: true,
        modelProviders: undefined,
      },
      updateProviders: () => {},
    }),
  );
  expect(missingStateHtml).not.toContain('渐进四槽位模型路由');
  expect(html).toContain('多模态看图按账号默认关闭，仅在显式开启后才允许将客户发来的截图或图片送入视觉模型');
  expect(html).not.toContain('也不会接收买家图片或头像');
  expect(html).not.toMatch(/无头|有头|schema3|schema4|DPAPI|协议\s*v2/iu);

  for (const code of [
    'VISION_INPUT_FORBIDDEN',
    'VISION_DISABLED_OR_UNCONFIGURED',
    'MEDIA_SEND_NOT_SUPPORTED',
    'MEDIA_ASSET_INVALID',
    'MEDIA_ASSET_NOT_FOUND',
    'MEDIA_ASSET_TOO_LARGE',
    'MEDIA_REPLY_DISABLED',
    'BUSINESS_TOOL_FORBIDDEN',
    'BUSINESS_TOOL_NOT_CONFIGURED',
    'BUSINESS_TOOL_FAILED',
    'MODEL_SLOT_INVALID',
  ]) {
    expect(explain(code), code).not.toBe(code);
  }
});

test('ModelSlotPanel preserves unsaved drafts in other optional slots when saving or clearing one slot', async () => {
  const initialSlots: PublicModelSlots = {
    primary: baseProviderState.selection,
    vision: null,
    utility: null,
    embedding: null,
  };
  const boundVisionSlots: PublicModelSlots = {
    ...initialSlots,
    vision: {
      slot: 'vision',
      connectionId: conn2Id,
      routeRevision: 3,
      modelId: 'gpt-4o',
      revision: 1,
      updatedAt: 1794000010000,
    },
  };
  requestMock.mockResolvedValueOnce(initialSlots);

  const view = mountComponent(ModelSlotPanel, { state: baseProviderState, available: true });
  try {
    await vi.waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith({ command: 'modelProviders', action: 'getSlots' }),
    );

    // Stage unsaved drafts in utility and embedding slots
    const utilityConnSelect = findByAriaLabel(view.getTree(), '后台辅助模型连接');
    (utilityConnSelect.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: conn2Id },
    });
    const utilityModelSelect = findByAriaLabel(view.getTree(), '后台辅助模型模型');
    (utilityModelSelect.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: 'gpt-4o-mini' },
    });
    const embeddingConnSelect = findByAriaLabel(view.getTree(), '云端文本向量连接');
    (embeddingConnSelect.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: conn1Id },
    });

    // Save vision slot
    const visionConnSelect = findByAriaLabel(view.getTree(), '视觉看图模型连接');
    (visionConnSelect.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: conn2Id },
    });
    const visionModelSelect = findByAriaLabel(view.getTree(), '视觉看图模型模型');
    (visionModelSelect.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: 'gpt-4o' },
    });

    requestMock.mockResolvedValueOnce(boundVisionSlots);
    (findByAriaLabel(view.getTree(), '保存视觉看图模型').props.onClick as () => void)();
    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledTimes(2));

    expect(findByAriaLabel(view.getTree(), '后台辅助模型连接').props.value).toBe(conn2Id);
    expect(findByAriaLabel(view.getTree(), '后台辅助模型模型').props.value).toBe('gpt-4o-mini');
    expect(findByAriaLabel(view.getTree(), '云端文本向量连接').props.value).toBe(conn1Id);

    // Clear vision slot -> only vision draft resets, utility & embedding drafts stay
    requestMock.mockResolvedValueOnce(initialSlots);
    (findByAriaLabel(view.getTree(), '清除视觉看图模型').props.onClick as () => void)();
    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledTimes(3));

    expect(findByAriaLabel(view.getTree(), '视觉看图模型连接').props.value).toBe('');
    expect(findByAriaLabel(view.getTree(), '后台辅助模型连接').props.value).toBe(conn2Id);
    expect(findByAriaLabel(view.getTree(), '后台辅助模型模型').props.value).toBe('gpt-4o-mini');
    expect(findByAriaLabel(view.getTree(), '云端文本向量连接').props.value).toBe(conn1Id);

    // Primary model switch (selectionRevision bumps) refreshes primary via getSlots WITHOUT wiping unsaved optional drafts
    const updatedPrimaryState: PublicModelState = {
      ...baseProviderState,
      selection: {
        connectionId: conn2Id,
        routeRevision: 3,
        modelId: 'gpt-4o',
        modelDisplayName: 'GPT-4o',
        selectionRevision: 2,
      },
    };
    requestMock.mockResolvedValueOnce({
      primary: updatedPrimaryState.selection,
      vision: null,
      utility: null,
      embedding: null,
    });
    view.updateProps({ state: updatedPrimaryState, available: true });
    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledTimes(4));
    expect(view.markup()).toContain('GPT-4o');
    expect(findByAriaLabel(view.getTree(), '后台辅助模型连接').props.value).toBe(conn2Id);
    expect(findByAriaLabel(view.getTree(), '后台辅助模型模型').props.value).toBe('gpt-4o-mini');
    expect(findByAriaLabel(view.getTree(), '云端文本向量连接').props.value).toBe(conn1Id);
  } finally {
    view.unmount();
  }
});

test('AiRuntimeFeaturesPanel uses chunked upload for large files and aborts upload on account switch or unmount', async () => {
  const largeBytes = new Uint8Array(40_000);
  largeBytes.fill(0x41);
  const expectedSha256 = Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', largeBytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  const expectedBase64 = Buffer.from(largeBytes).toString('base64');
  expect(expectedBase64.length).toBeGreaterThan(48_000);

  const chunkedAsset: MediaAssetSummary = {
    id: '55555555-5555-4555-8555-555555555555',
    name: '大图商品卡.png',
    mimeType: 'image/png',
    bytes: largeBytes.byteLength,
    sha256: expectedSha256,
    createdAt: 1794000030000,
  };
  const uploadId = '66666666-6666-4666-8666-666666666666';

  requestMock
    .mockResolvedValueOnce({ ...DEFAULT_ACCOUNT_AI_FEATURES })
    .mockResolvedValueOnce({ assets: [] })
    .mockResolvedValueOnce({ uploadId, chunkLimit: 65_536 })
    .mockResolvedValueOnce({ uploadId, index: 0, receivedBytes: 24_576 })
    .mockResolvedValueOnce({ uploadId, index: 1, receivedBytes: 40_000 })
    .mockResolvedValueOnce({ asset: chunkedAsset });

  const view = mountComponent(AiRuntimeFeaturesPanel, {
    accountId: DEFAULT_ACCOUNT_ID,
    accountLabel: '主测试号',
  });
  try {
    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledTimes(2));

    const fileInput = findByAriaLabel(view.getTree(), '上传素材图片');
    const largeFile = {
      name: '大图商品卡.png',
      type: 'image/png',
      size: largeBytes.byteLength,
      arrayBuffer: async () => largeBytes.buffer.slice(0),
    } as unknown as File;
    (fileInput.props.onChange as (e: { target: { files: File[] } }) => void)({
      target: { files: [largeFile] },
    });

    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledTimes(6));
    expect(requestMock.mock.calls[2]![0]).toEqual({
      command: 'mediaAssets',
      action: 'uploadStart',
      name: '大图商品卡.png',
      mimeType: 'image/png',
      bytes: largeBytes.byteLength,
      sha256: expectedSha256,
    });
    expect(requestMock.mock.calls[3]![0]).toEqual({
      command: 'mediaAssets',
      action: 'uploadChunk',
      uploadId,
      index: 0,
      data: expectedBase64.slice(0, 32 * 1024),
    });
    expect(requestMock.mock.calls[4]![0]).toEqual({
      command: 'mediaAssets',
      action: 'uploadChunk',
      uploadId,
      index: 1,
      data: expectedBase64.slice(32 * 1024),
    });
    expect(requestMock.mock.calls[5]![0]).toEqual({
      command: 'mediaAssets',
      action: 'uploadFinish',
      uploadId,
    });
    expect(view.markup()).toContain('大图商品卡.png');

    // Account switch while reading file -> abort and do NOT call mediaAssets
    let resolveBuffer!: (buf: ArrayBuffer) => void;
    const pendingFile = {
      name: '切号图片.png',
      type: 'image/png',
      size: 4,
      arrayBuffer: () => new Promise<ArrayBuffer>(resolve => {
        resolveBuffer = resolve;
      }),
    } as unknown as File;
    (findByAriaLabel(view.getTree(), '上传素材图片').props.onChange as (e: { target: { files: File[] } }) => void)({
      target: { files: [pendingFile] },
    });
    setActiveWorkbenchAccount({
      accountRef: 'account_other',
      displayLabel: '切换后账号',
      platform: 'wecom-aibot',
    });
    resolveBuffer(new Uint8Array([137, 80, 78, 71]).buffer);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(requestMock).toHaveBeenCalledTimes(6);

    // Unmount while reading file -> abort and do NOT call mediaAssets
    setActiveWorkbenchAccount(null);
    let resolveUnmountBuffer!: (buf: ArrayBuffer) => void;
    const unmountFile = {
      name: '卸载图片.png',
      type: 'image/png',
      size: 4,
      arrayBuffer: () => new Promise<ArrayBuffer>(resolve => {
        resolveUnmountBuffer = resolve;
      }),
    } as unknown as File;
    (findByAriaLabel(view.getTree(), '上传素材图片').props.onChange as (e: { target: { files: File[] } }) => void)({
      target: { files: [unmountFile] },
    });
    view.unmount();
    resolveUnmountBuffer(new Uint8Array([137, 80, 78, 71]).buffer);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(requestMock).toHaveBeenCalledTimes(6);
  } finally {
    view.unmount();
  }
});
