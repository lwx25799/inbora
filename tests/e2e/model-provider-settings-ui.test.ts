import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {chromium, type Browser, type Page} from 'playwright';
import {createServer, type ViteDevServer} from 'vite';
import {afterAll, beforeAll, expect, test} from 'vitest';
import {defaultSettings} from '../../src/contracts/client.js';
import {
  CONNECTION_PAGE_LIMIT, INLINE_MODEL_LIMIT, MODEL_ERROR_CODES, MODEL_PAGE_LIMIT,
  modelCatalogPageSchema, modelProvidersCommandSchema, publicModelStateSchema,
  type ModelCatalogEntry, type ModelProvidersCommand, type PublicModelConnection, type PublicModelState,
} from '../../src/contracts/model-providers.js';
import type {Status} from '../../desktop/src/api.js';
import {errorMessages} from '../../desktop/src/error-messages.js';

const firstId = '64ce7003-91f9-41e1-bc3e-60611c81b002';
const secondId = '4a80c146-69b4-4ff7-9c1a-c8363dd0edb6';
const firstModel = 'deepseek-flash';
const secondModel = 'vendor/model:free';
const manual = (modelId: string): ModelCatalogEntry => ({modelId, displayName: null, source: 'MANUAL'});
const now = 1795449600000;

function makeConnection(id: string, name: string, models: ModelCatalogEntry[]): PublicModelConnection {
  const draft: PublicModelConnection['draft'] = {
    routeRevision: 1, presetId: 'deepseek', protocol: 'OPENAI_CHAT', baseUrl: 'https://api.deepseek.com',
    region: null, storage: 'MEMORY', keyPresent: true, keyStored: false, unavailableReason: null,
    catalogResult: null, testResult: null,
  };
  return {id, name, presetId: draft.presetId, version: 1, draftRevision: 1, models, modelsFetchedAt: null,
    draft, applied: id === firstId ? structuredClone(draft) : null};
}

function makeStatus(): Status {
  return {
    runtime: 'synthetic-p16', account: null, operator: {id: 'test-operator', permissions: ['CONTROL'], expiresAt: now},
    mode: 'MANUAL', configuredMode: 'MANUAL', paused: false, browser: {state: 'CLOSED', mode: 'headless', version: null},
    lastSync: [], capabilities: [], budgets: [{kind: 'MODEL', used: 0, maximum: 10}],
    usage: {requests: 0, inputTokens: 0, outputTokens: 0, unresolved: 0},
    settings: {...defaultSettings}, keyPresent: true, modelAuthorized: true, modelBusy: false, go: 'UNVERIFIED', schema: 3,
    sync: {runId: null, running: false, cancelled: false, source: null, results: []},
    modelProvidersSupported: true, modelProvidersAvailable: true,
    modelProviders: {
      listRevision: 3,
      connections: [makeConnection(firstId, '原连接', [manual(firstModel)]), makeConnection(secondId, '同品牌备用', [manual(secondModel)])],
      selection: {connectionId: firstId, routeRevision: 1, modelId: firstModel, selectionRevision: 1},
    },
  };
}

function pendingCall(action: ModelProvidersCommand['action'], afterCommit = false, matches = (_: ModelProvidersCommand) => true) {
  let release!: (error?: string) => void;
  const waiting = new Promise<string | undefined>(resolve => { release = resolve; });
  return {action, afterCommit, matches, waiting, release, entered: false};
}

function updateDraft(connection: PublicModelConnection, changes: Partial<PublicModelConnection['draft']>) {
  ++connection.version;
  ++connection.draftRevision;
  connection.draft = {...connection.draft, catalogResult: null, testResult: null, ...changes, routeRevision: connection.draftRevision};
}

function publicState(state: PublicModelState, offset = 0, limit = CONNECTION_PAGE_LIMIT) {
  const next = Math.min(offset + limit, state.connections.length);
  const connections = [...state.connections].sort((a, b) =>
    Number(b.id === state.selection.connectionId) - Number(a.id === state.selection.connectionId));
  return publicModelStateSchema.parse({...state,
    totalConnectionCount: state.connections.length,
    nextConnectionOffset: next < state.connections.length ? next : null,
    connections: connections.slice(offset, next).map(connection => ({...connection,
      models: connection.models.slice(0, INLINE_MODEL_LIMIT),
      totalModelCount: connection.models.length, modelsTruncated: connection.models.length > INLINE_MODEL_LIMIT,
    })),
  });
}

function dispatchModel(state: PublicModelState, command: ModelProvidersCommand) {
  const advanceListRevision = () => { state.listRevision = (state.listRevision ?? 0) + 1; };
  if (command.action === 'getSlots' || command.action === 'setSlot') {
    return { primary: state.selection, vision: null, utility: null, embedding: null };
  }
  if (command.action === 'list' && !command.connectionId) {
    if (command.expectedListRevision !== undefined && command.expectedListRevision !== state.listRevision) {
      throw Error('MODEL_CONNECTION_CONFLICT');
    }
    return publicState(state, command.offset, Math.min(command.limit ?? CONNECTION_PAGE_LIMIT, CONNECTION_PAGE_LIMIT));
  }
  const connection = state.connections.find(item => item.id === command.connectionId);
  if (command.action === 'save' && command.connectionId === null) {
    const created = makeConnection(randomUUID(), command.name, []);
    created.draft.keyPresent = false;
    state.connections.push(created);
    advanceListRevision();
    return saveConnection(created, command);
  }
  if (!connection) throw Error('MODEL_CONNECTION_CONFLICT');
  if ('expectedVersion' in command && connection.version !== command.expectedVersion) throw Error('MODEL_CONNECTION_CONFLICT');
  if ('routeRevision' in command && connection.draft.routeRevision !== command.routeRevision) throw Error('MODEL_ROUTE_CHANGED');
  switch (command.action) {
    case 'list': {
      const offset = command.offset ?? 0;
      const models = connection.models.slice(offset, offset + (command.limit ?? MODEL_PAGE_LIMIT));
      const next = offset + models.length;
      return modelCatalogPageSchema.parse({connectionId: connection.id, version: connection.version, offset,
        nextOffset: next < connection.models.length ? next : null, totalModelCount: connection.models.length, models});
    }
    case 'save':
      if (command.expectedSelectionRevision !== undefined && command.expectedSelectionRevision !== state.selection.selectionRevision) {
        throw Error('MODEL_CONNECTION_CONFLICT');
      }
      if (command.manualModels && connection.models.length > INLINE_MODEL_LIMIT && !command.manualModelsComplete) {
        throw Error('MODEL_MANUAL_MODELS_TRUNCATED');
      }
      return saveConnection(connection, command);
    case 'setKey': {
      const storage = command.storage === 'DELETE' ? 'MEMORY' : command.storage;
      const applied = connection.applied;
      updateDraft(connection, {storage, keyPresent: command.storage !== 'DELETE', keyStored: storage === 'DPAPI'});
      connection.models = connection.models.filter(model => model.source === 'MANUAL');
      connection.modelsFetchedAt = null;
      if (command.storage === 'DELETE' && state.selection.connectionId === connection.id) {
        advanceListRevision();
        const appliedRevision = connection.draft.routeRevision;
        connection.applied = {...applied!, routeRevision: appliedRevision,
          keyPresent: false, keyStored: false, catalogResult: null, testResult: null, unavailableReason: null};
        if (applied && (applied.presetId !== connection.draft.presetId || applied.protocol !== connection.draft.protocol
          || applied.baseUrl !== connection.draft.baseUrl || applied.region !== connection.draft.region)) {
          connection.draft.routeRevision++;
          connection.draftRevision++;
        }
        state.selection = {...state.selection, routeRevision: appliedRevision,
          selectionRevision: state.selection.selectionRevision + 1};
      }
      return connection;
    }
    case 'discover': {
      const item: ModelCatalogEntry = {modelId: 'directory/model', displayName: null, source: 'DISCOVERED'};
      if (!connection.models.find(model => model.modelId === item.modelId)) connection.models.push(item);
      connection.modelsFetchedAt = now;
      ++connection.version;
      return connection.draft.catalogResult = {connectionId: connection.id, routeRevision: command.routeRevision,
        status: 'PARTIAL', fetchedAt: now, reason: null, totalCount: 1, truncated: true,
        selectedModelInCatalog: state.selection.connectionId === connection.id
          && state.selection.routeRevision === command.routeRevision ? state.selection.modelId === item.modelId : null};
    }
    case 'test':
      return connection.draft.testResult = {connectionId: connection.id, routeRevision: command.routeRevision,
        modelId: command.modelId, reportedModelId: command.modelId, commandId: command.commandId, status: 'SUCCEEDED',
        reason: null, elapsedMs: 10, usage: null};
    case 'apply':
      if (state.selection.selectionRevision !== command.expectedSelectionRevision) throw Error('MODEL_CONNECTION_CONFLICT');
      connection.applied = structuredClone(connection.draft);
      state.selection = {connectionId: connection.id, routeRevision: command.routeRevision, modelId: command.modelId,
        selectionRevision: state.selection.selectionRevision + 1};
      advanceListRevision();
      return state;
    case 'delete':
      if (state.selection.connectionId === connection.id) throw Error('MODEL_CONNECTION_CONFLICT');
      state.connections = state.connections.filter(item => item.id !== connection.id);
      advanceListRevision();
      return null;
  }
}

function saveConnection(connection: PublicModelConnection, command: Extract<ModelProvidersCommand, {action: 'save'}>) {
  const {baseUrl, protocol, presetId, region, name, manualModels} = command;
  const changed = baseUrl !== connection.draft.baseUrl || protocol !== connection.draft.protocol
    || presetId !== connection.draft.presetId || region !== connection.draft.region;
  if (changed) {
    updateDraft(connection, {baseUrl, protocol, presetId, region, keyPresent: false, keyStored: false});
    connection.models = connection.models.filter(item => item.source === 'MANUAL');
    connection.modelsFetchedAt = null;
  } else ++connection.version;
  connection.name = name;
  connection.presetId = presetId;
  if (manualModels) connection.models = [...manualModels.map(item => ({...manual(item.modelId), displayName: item.displayName ?? null})),
    ...connection.models.filter(item => item.source === 'DISCOVERED' && !manualModels.some(model => model.modelId === item.modelId))];
  return connection;
}

const usage = {requests: 1, knownUsageRequests: 1, unknownUsageRequests: 0, inputTokens: 10, outputTokens: 5,
  elapsedSamples: 1, averageElapsedMs: 5, p95ElapsedMs: 5};
const diagnostics = {
  version: 1, timeRangeSupported: false,
  modelBreakdownTruncated: true, modelBreakdownTotal: 5,
  model: {total: usage, groups: [
    {...usage, presetId: 'openrouter', model: secondModel, status: 'SUCCEEDED'},
    {...usage, presetId: 'custom', model: secondModel, status: 'SUCCEEDED'},
    {...usage, model: firstModel, status: 'SUCCEEDED'},
  ]},
  blockers: [], collection: {channels: [], works: {included: 0, historical: 0, review: 0}, conversations: {total: 0, neverRead: 0}},
  performance: [], evidence: {running: false, nextAt: 0, error: null, report: null},
};

let server: ViteDevServer;
let browser: Browser;
beforeAll(async () => {
  server = await createServer({configFile: resolve('desktop/vite.config.ts'), server: {port: 0, strictPort: false}, logLevel: 'error'});
  await server.listen();
  browser = await chromium.launch({channel: 'msedge', headless: true});
});
afterAll(async () => {
  try { await browser?.close(); } finally { await server?.close(); }
});

async function openSettings(status: Status, viewport = {width: 1240, height: 800}) {
  const page = await browser.newPage({viewport});
  page.setDefaultTimeout(3500);
  const calls: ModelProvidersCommand[] = [];
  const all: string[] = [];
  const prompts: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const holds: ReturnType<typeof pendingCall>[] = [];
  const initialModels = status.modelProviders && publicState(status.modelProviders);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { void dialog.accept(); });
  await page.exposeFunction('fixtureInvoke', async (name: string, args: {body: Record<string, unknown>}) => {
    if (name === 'desktop_info') return {runtime: status.runtime, version: 'p16-synthetic'};
    if (name !== 'client_request') throw Error('UNEXPECTED_NATIVE_COMMAND');
    const {body} = args;
    all.push(String(body.command));
    switch (body.command) {
      case 'getStatus':
        return status.modelProviders ? {...status, modelProviders: publicState(status.modelProviders)} : status;
      case 'selectTarget': return null;
      case 'getInbox': return {items: [], total: 0, page: 0, pageSize: 20};
      case 'getDiagnostics': return diagnostics;
      case 'configureAi':
        prompts.push(body);
        Object.assign(status.settings, body.settings);
        return {...status, modelProviders: initialModels};
      case 'accountAiFeatures':
        return {
          visionEnabled: false,
          mediaReplyEnabled: false,
          enabledBusinessTools: [],
          toolEndpoints: {},
          syncCustomerAvatars: false,
        };
      case 'mediaAssets':
        return { assets: [] };
      case 'businessTools':
        return {
          tools: [
            { id: 'query_order_status', enabled: false, endpointConfigured: false },
            { id: 'query_logistics_trace', enabled: false, endpointConfigured: false },
            { id: 'query_inventory_stock', enabled: false, endpointConfigured: false },
          ],
        };
      case 'modelProviders': {
        if (!status.modelProviders || status.modelProvidersAvailable !== true) throw Error('UNEXPECTED_MODEL_PROVIDERS_COMMAND');
        const command = modelProvidersCommandSchema.parse(body);
        if (command.action === 'getSlots') {
          return { primary: status.modelProviders.selection, vision: null, utility: null, embedding: null };
        }
        calls.push(command);
        const held = holds.find(item => !item.entered && item.action === command.action && item.matches(command));
        const wait = async (hold: NonNullable<typeof held>) => {
          hold.entered = true;
          const error = await hold.waiting;
          if (error) throw Error(error);
        };
        if (held && !held.afterCommit) await wait(held);
        const result = dispatchModel(status.modelProviders, command);
        if (command.action === 'test') status.budgets[0]!.used++;
        if (held?.afterCommit) await wait(held);
        return result;
      }
      default: throw Error('UNEXPECTED_FIXTURE_COMMAND');
    }
  });
  await page.addInitScript(() => {
    const fixture = window as unknown as {__TAURI_INTERNALS__: unknown; __TAURI_EVENT_PLUGIN_INTERNALS__: unknown;
      fixtureEmit: (payload: unknown) => void;
      fixtureInvoke: (command: string, args: unknown) => Promise<unknown>};
    let nextId = 0;
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<number, {event: string; handler: number}>();
    fixture.fixtureEmit = payload => {
      for (const [id, listener] of listeners) if (listener.event === 'inbora_status_updated') {
        callbacks.get(listener.handler)?.({event: listener.event, id, payload});
      }
    };
    fixture.__TAURI_INTERNALS__ = {
      transformCallback: (callback: (event: unknown) => void) => {
        callbacks.set(++nextId, callback);
        return nextId;
      },
      invoke: async (command: string, args: unknown) => {
        if (command === 'plugin:event|listen') {
          listeners.set(++nextId, args as {event: string; handler: number});
          return nextId;
        }
        if (command === 'plugin:event|unlisten') return;
        return fixture.fixtureInvoke(command, args);
      },
    };
    fixture.__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener: (_event: string, id: number) => {
      const listener = listeners.get(id);
      if (listener) callbacks.delete(listener.handler);
      listeners.delete(id);
    }};
  });
  try {
    await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port: number}).port}`);
    await page.getByRole('button', {name: '多模型配置', exact: true}).click();
    await page.getByRole('heading', {name: '当前模型', exact: true}).waitFor();
  } catch (error) {
    await page.close();
    throw error;
  }
  return {page, calls, all, prompts, errors,
    hold: (...args: Parameters<typeof pendingCall>) => {
      const item = pendingCall(...args); holds.push(item); return item;
    },
    emit: (event: string) => page.evaluate(name => (window as unknown as {fixtureEmit: (payload: unknown) => void})
      .fixtureEmit({event:name}), event),
    close: async () => { for (const hold of holds) hold.release(); await page.close(); },
  };
}

const button = (page: Page, name: string) => page.getByRole('button', {name, exact: true});
const text = (page: Page, value: string) => page.getByText(value, {exact: true});
const control = (page: Page, name: string) => page.getByLabel(name, {exact: true});
const select = (page: Page, name: string) => page.getByRole('combobox', {name, exact: true});

test('P16 saves a draft, manages Key and catalogs, tests once, applies and deletes in the existing settings page', async () => {
  const status = makeStatus();
  const fixture = await openSettings(status);
  const {page, calls} = fixture;
  try {
    const current = page.getByRole('region', {name: '当前模型'});
    await current.getByRole('definition').filter({hasText: '原连接 · DeepSeek'}).waitFor();
    expect(await button(page, '删除 原连接').isDisabled()).toBe(true);
    await text(page, '当前连接，切换后才可删除').waitFor();
    await button(page, '编辑 原连接').click();
    await control(page, 'Base URL').fill('https://api.deepseek.com/v2');
    await button(page, '保存连接').click();
    await current.getByText(errorMessages.MODEL_CONNECTION_NOT_APPLIED!, {exact: true}).waitFor();
    expect(status.modelProviders!.selection.routeRevision).toBe(1);
    expect(calls[0]).toMatchObject({action: 'save', expectedVersion: 1, connectionId: firstId});
    expect(calls.map(call => call.action)).toEqual(['save']);
    await button(page, '新建连接').click();
    await control(page, '连接名称').fill('路由备用');
    await select(page, '提供商预设').selectOption('qwen');
    await select(page, '区域').selectOption({label: '新加坡'});
    expect(await control(page, 'Base URL').inputValue()).toBe('https://dashscope-intl.aliyuncs.com/compatible-mode/v1');
    await select(page, '提供商预设').selectOption('siliconflow');
    await select(page, '区域').selectOption({label: '国际站'});
    expect(await control(page, 'Base URL').inputValue()).toBe('https://api.siliconflow.com/v1');
    await select(page, '提供商预设').selectOption('custom');
    expect(await select(page, '协议').locator('option:enabled').count()).toBe(4);
    expect(await select(page, '协议').inputValue()).toBe('');
    await select(page, '提供商预设').selectOption('openrouter');
    expect(await select(page, '区域').count()).toBe(0);
    await text(page, 'https://openrouter.ai/api/v1/chat/completions').waitFor();
    await control(page, '手动模型 ID').fill(secondModel);
    await button(page, '添加模型').click();
    await button(page, '保存连接').click();
    await page.getByRole('region', {name: '编辑连接 路由备用'}).waitFor();
    const added = status.modelProviders!.connections.find(item => item.name === '路由备用')!;
    expect(added.models.map(item => item.modelId)).toEqual([secondModel]);
    expect(calls[1]).toMatchObject({action: 'save', expectedVersion: 0, connectionId: null});

    const key = control(page, '本次 API Key');
    expect(await select(page, 'Key 存储方式').inputValue()).toBe('MEMORY');
    expect(await key.inputValue()).toBe('');
    await key.fill('synthetic-submitted');
    const deferred = fixture.hold('setKey');
    await button(page, '保存 Key').click();
    await expect.poll(() => deferred.entered).toBe(true);
    await key.fill('synthetic-follow-up');
    expect(await button(page, '正在更新 Key…').isDisabled()).toBe(true);
    expect(await button(page, '保存连接').isEnabled()).toBe(true);
    expect(await button(page, '自动化规则').isEnabled()).toBe(true);
    deferred.release();
    await text(page, 'Key 已保存。').waitFor();
    expect(await key.inputValue()).toBe('synthetic-follow-up');
    expect(calls[2]).toMatchObject({action: 'setKey', storage: 'MEMORY', key: 'synthetic-submitted', connectionId: added.id});
    await select(page, 'Key 存储方式').selectOption('DPAPI');
    await button(page, '保存 Key').click();
    await text(page, 'openrouter.ai · 本机加密保存').waitFor();
    await expect.poll(() => key.inputValue()).toBe('');
    await text(page, 'Key 已保存。').waitFor();
    await control(page, 'Base URL').fill('https://alternate.example.com/api/v1');
    expect(await text(page, 'Key 已保存。').count()).toBe(0);
    await control(page, 'Base URL').fill('https://openrouter.ai/api/v1');

    const versionBeforeDiscovery = added.version;
    await button(page, '获取模型').click();
    await page.getByText('列表未完整获取，已保留 1 个模型，可继续手动添加。', {exact: false}).waitFor();
    expect(added.version).toBe(versionBeforeDiscovery + 1);
    await select(page, '测试模型').selectOption(secondModel);
    const testCall = fixture.hold('test');
    await button(page, '测试连接（调用 1 次模型）').click();
    await expect.poll(() => testCall.entered).toBe(true);
    expect(await button(page, '正在测试连接…').isDisabled()).toBe(true);
    expect(await button(page, '获取模型').isEnabled()).toBe(true);
    expect(await button(page, '会话中心').isEnabled()).toBe(true);
    testCall.release();
    await page.getByText('连接测试通过。', {exact: false}).waitFor();
    const sentTest = calls.find(call => call.action === 'test');
    expect(sentTest).toMatchObject({connectionId: added.id, modelId: secondModel, confirmed: true, commandId: expect.stringMatching(/^[a-f0-9-]{36}$/u)});

    await select(page, '切换到连接').selectOption(added.id);
    expect(await select(page, '切换到模型').inputValue()).toBe('');
    await select(page, '切换到模型').selectOption(secondModel);
    expect(await current.innerText()).toContain('OpenRouter（openrouter.ai）');
    await current.getByRole('definition').filter({hasText: '原连接 · DeepSeek'}).waitFor();
    expect(status.modelProviders!.selection.connectionId).toBe(firstId);
    await button(page, '应用切换').click();
    await current.getByRole('definition').filter({hasText: '路由备用 · OpenRouter'}).waitFor();
    await current.getByRole('definition').filter({hasText: secondModel}).waitFor();
    expect(calls.find(call => call.action === 'apply')).toMatchObject({connectionId: added.id, modelId: secondModel,
      confirmed: true, expectedSelectionRevision: 1, commandId: expect.stringMatching(/^[a-f0-9-]{36}$/u)});
    expect(await button(page, '删除 路由备用').isDisabled()).toBe(true);
    await button(page, '删除 原连接').click();
    await button(page, '确认删除').click();
    await text(page, '已删除「原连接」。').waitFor();
    expect(status.modelProviders!.connections.some(item => item.id === firstId)).toBe(false);
    expect(status.budgets[0]!.used).toBe(1);
    await button(page, '清除 Key').click();
    await button(page, '确认清除 Key').click();
    await text(page, '这条连接的 Key 已吊销。').waitFor();
    await current.getByRole('definition').filter({hasText: '未配置'}).waitFor();
    expect(calls.at(-1)).toMatchObject({action: 'setKey', storage: 'DELETE'});
    expect(calls.at(-1)).not.toHaveProperty('key');
    expect(await key.inputValue()).toBe('');

    await button(page, '自动化规则').click();
    await button(page, '编辑业务提示词').click();
    const persona = page.getByRole('textbox', {name: '账号人设', exact: true});
    await persona.fill('合成业务人设');
    await page.keyboard.press('Escape');
    await button(page, '编辑业务提示词').click();
    expect(await persona.inputValue()).toBe('合成业务人设');
    await button(page, '保存业务提示词').click();
    await page.getByRole('dialog', {name: '业务提示词'}).getByText('业务提示词已保存', {exact: true}).waitFor();
    expect(fixture.prompts).toEqual([{command: 'configureAi', settings: {persona: '合成业务人设', business: '', rules: ''}}]);
    await page.keyboard.press('Escape');
    await button(page, '多模型配置').click();
    expect(await current.getByRole('definition').filter({hasText: '路由备用 · OpenRouter'}).isVisible()).toBe(true);
    expect(await current.getByRole('definition').filter({hasText: secondModel}).isVisible()).toBe(true);
    expect(await current.getByRole('definition').filter({hasText: '未配置'}).isVisible()).toBe(true);
    expect(fixture.errors).toEqual([]);
    expect(await page.locator('#main-content').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  } finally { await fixture.close(); }
});

test('P16 scopes results to the originating editor and does not replay after restart or reload', async () => {
  const status = makeStatus();
  const fixture = await openSettings(status, {width: 900, height: 640});
  const {page, calls, all} = fixture;
  try {
    for (const action of ['discover', 'test', 'save', 'setKey'] as const) {
      await button(page, '编辑 原连接').click();
      if (action === 'test') await select(page, '测试模型').selectOption(firstModel);
      if (action === 'setKey') await control(page, '本次 API Key').fill('synthetic-first-key');
      const delayed = fixture.hold(action);
      await button(page, {discover:'获取模型', test:'测试连接（调用 1 次模型）', save:'保存连接', setKey:'保存 Key'}[action]).click();
      await expect.poll(() => delayed.entered).toBe(true);
      await button(page, '编辑 同品牌备用').click();
      await control(page, '连接名称').fill(`备用连接编辑-${action}`);
      await control(page, '本次 API Key').fill('synthetic-second-draft');
      const reads = all.filter(name => name === 'getStatus').length;
      status.modelAuthorized = !status.modelAuthorized;
      delayed.release();
      await expect.poll(() => all.filter(name => name === 'getStatus').length).toBeGreaterThan(reads);
      await page.getByRole('definition').filter({hasText: status.modelAuthorized ? '当前有效' : '当前无效'}).waitFor();
      expect(await control(page, '连接名称').inputValue()).toBe(`备用连接编辑-${action}`);
      expect(await control(page, '本次 API Key').inputValue()).toBe('synthetic-second-draft');
      expect(await page.getByText(/列表未完整获取|连接测试通过|连接已保存|Key 已保存/u).count()).toBe(0);
    }
    await select(page, '切换到连接').selectOption(secondId);
    await select(page, '切换到模型').selectOption(secondModel);
    const switching = fixture.hold('apply');
    await button(page, '应用切换').click();
    await expect.poll(() => switching.entered).toBe(true);
    await button(page, '会话中心').click();
    await page.getByRole('heading', {name: '会话中心', exact: true}).waitFor();
    switching.release();
    await expect.poll(() => status.modelProviders?.selection.connectionId).toBe(secondId);
    await button(page, '多模型配置').click();
    await page.getByRole('definition').filter({hasText: '同品牌备用 · DeepSeek'}).waitFor();
    const before = calls.length;
    const readsBeforeRestart = all.filter(name => name === 'getStatus').length;
    const selectionsBeforeRestart = all.filter(name => name === 'selectTarget').length;
    status.modelAuthorized = !status.modelAuthorized;
    await fixture.emit('backend_restarted');
    await expect.poll(() => all.filter(name => name === 'getStatus').length).toBeGreaterThan(readsBeforeRestart);
    await expect.poll(() => all.filter(name => name === 'selectTarget').length).toBeGreaterThan(selectionsBeforeRestart);
    await page.getByRole('definition').filter({hasText: status.modelAuthorized ? '当前有效' : '当前无效'}).waitFor();
    expect(calls.slice(before).filter(command => command.action !== 'list')).toEqual([]);
    await page.reload();
    await button(page, '多模型配置').click();
    await button(page, '编辑 原连接').click();
    expect(await control(page, '本次 API Key').inputValue()).toBe('');
    expect(calls.slice(before).every(command => command.action === 'list')).toBe(true);
    expect(calls.slice(0, before).map(command => command.action)).toEqual(['discover', 'test', 'save', 'setKey', 'apply']);
    expect(fixture.errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await fixture.close(); }
});

test.each(['https://alternate.example.com/v1', 'https://api.deepseek.com/v2'])(
  'P16 scopes typed credentials to the saved destination and can revoke an applied Key from a keyless draft (%s)',
  async baseUrl => {
    const status = makeStatus();
    const active = status.modelProviders!.connections[0]!;
    if (baseUrl.endsWith('/v1')) {
      active.models.push(...Array.from({length:MODEL_PAGE_LIMIT}, (_, index) =>
        ({...manual(`large/manual-${index}`), displayName:'模'.repeat(150)})));
      expect(Buffer.byteLength(JSON.stringify(active.models))).toBeGreaterThan(90_000);
    }
    const fixture = await openSettings(status);
    const {page, calls} = fixture;
    try {
      await button(page, '编辑 原连接').click();
      const key = control(page, '本次 API Key');
      await key.fill('synthetic-for-original-destination');
      await control(page, 'Base URL').fill(baseUrl);
      expect(await key.isDisabled()).toBe(true);
      expect(await button(page, '保存 Key').isDisabled()).toBe(true);
      await button(page, '保存连接').click();
      await text(page, '连接已保存。').waitFor();
      expect(await key.inputValue()).toBe('');
      expect(await button(page, '保存 Key').isDisabled()).toBe(true);
      expect(status.modelProviders!.connections[0]!.draft.keyPresent).toBe(false);
      expect(status.modelProviders!.connections[0]!.applied!.keyPresent).toBe(true);
      expect(await button(page, '清除 Key').isEnabled()).toBe(true);
      const cleanupFailed = baseUrl.endsWith('/v2');
      if (cleanupFailed) status.keyStorageError = 'MODEL_CREDENTIAL_CLEANUP_FAILED';
      await button(page, '清除 Key').click();
      await button(page, '确认清除 Key').click();
      await text(page, '这条连接的 Key 已吊销。').waitFor();
      if (cleanupFailed) await text(page, errorMessages.MODEL_CREDENTIAL_CLEANUP_FAILED!).waitFor();
      expect(status.modelProviders!.connections[0]!.applied!.keyPresent).toBe(false);
      const writes = calls.filter(command => command.action !== 'list');
      expect(writes.map(command => command.action)).toEqual(['save', 'setKey']);
      expect(writes[0]).not.toHaveProperty('manualModels');
      expect(active.models).toHaveLength(baseUrl.endsWith('/v1') ? MODEL_PAGE_LIMIT + 1 : 1);
      expect(writes[1]).toMatchObject({action: 'setKey', connectionId: firstId, storage: 'DELETE'});
      expect(writes[1]).not.toHaveProperty('key');
      expect(fixture.errors).toEqual([]);
      if (cleanupFailed) {
        const state = status.modelProviders!;
        state.connections.splice(1, 0, ...Array.from({length:CONNECTION_PAGE_LIMIT - 1}, (_, index) =>
          makeConnection(randomUUID(), `分页连接 ${index}`, [])));
        state.listRevision! += CONNECTION_PAGE_LIMIT - 1;
        const beyondFirstPage = (command: ModelProvidersCommand) => command.action === 'list'
          && !command.connectionId && command.offset === CONNECTION_PAGE_LIMIT;
        await fixture.emit('status_updated');
        await expect.poll(() => calls.filter(beyondFirstPage).length).toBeGreaterThan(0);
        await button(page, '编辑 同品牌备用').click();
        const name = control(page, '连接名称');
        await name.fill('分页编辑草稿');
        await key.fill('synthetic-off-page-draft');

        const failedPage = fixture.hold('list', false, beyondFirstPage);
        await fixture.emit('status_updated');
        await expect.poll(() => failedPage.entered).toBe(true);
        failedPage.release('SYNTHETIC_LIST_FAILURE');
        await button(page, '重新读取连接').waitFor();
        expect(await name.inputValue()).toBe('分页编辑草稿');
        expect(await key.inputValue()).toBe('synthetic-off-page-draft');
        expect(await button(page, '保存连接').isDisabled()).toBe(true);
        expect(await button(page, '保存 Key').isDisabled()).toBe(true);

        const staleRevision = state.listRevision;
        state.connections[1] = makeConnection(randomUUID(), '替换的分页连接', []);
        state.listRevision! += 2;
        const beforeRetry = calls.length;
        await button(page, '重新读取连接').click();
        await expect.poll(() => button(page, '保存连接').isEnabled()).toBe(true);
        expect(calls.slice(beforeRetry).filter(beyondFirstPage)).toEqual([
          expect.objectContaining({expectedListRevision:staleRevision}),
          expect.objectContaining({expectedListRevision:state.listRevision}),
        ]);
        expect(await name.inputValue()).toBe('分页编辑草稿');
        expect(await key.inputValue()).toBe('synthetic-off-page-draft');

        const confirmation = fixture.hold('list', true, beyondFirstPage);
        await button(page, '清除 Key').click();
        await button(page, '确认清除 Key').click();
        await expect.poll(() => confirmation.entered).toBe(true);
        status.modelAuthorized = false;
        await fixture.emit('status_updated');
        await page.getByRole('definition').filter({hasText:'当前无效'}).waitFor();
        await button(page, '收起 同品牌备用').waitFor();
        const beforeConfirmationRetry = calls.length;
        confirmation.release();
        await text(page, '这条连接的 Key 已吊销。').waitFor();
        expect(calls.slice(beforeConfirmationRetry).some(beyondFirstPage)).toBe(true);
        expect(await text(page, errorMessages.MODEL_CREDENTIAL_CLEANUP_FAILED!).isVisible()).toBe(true);
        expect(await name.inputValue()).toBe('分页编辑草稿');
      }
    } finally { await fixture.close(); }
  },
);

test('P16 reads bounded catalog pages for both selectors and keeps off-page manual models when saving', async () => {
  const status = makeStatus();
  const connection = status.modelProviders!.connections[0]!;
  const tail = 'manual/off-page';
  connection.models = [manual(firstModel), ...Array.from({length:MODEL_PAGE_LIMIT - 1}, (_, index) =>
    manual(`manual/model-${index}`)), manual(tail), {modelId:'directory/model', displayName:null, source:'DISCOVERED'}];
  const fixture = await openSettings(status);
  const {page, calls} = fixture;
  try {
    await select(page, '切换到模型').selectOption(tail);
    expect(await select(page, '切换到模型').inputValue()).toBe(tail);
    const lastPage = fixture.hold('list', false, command => command.action === 'list'
      && command.connectionId === firstId && command.offset === MODEL_PAGE_LIMIT);
    await button(page, '编辑 原连接').click();
    await expect.poll(() => lastPage.entered).toBe(true);
    const editor = page.getByRole('region', {name:'编辑连接 原连接'});
    const save = button(page, '保存连接');
    await control(page, '连接名称').fill('保留完整手动目录');
    expect(await save.isDisabled()).toBe(true);
    await save.evaluate(element => (element as HTMLButtonElement).click());
    expect(calls.some(command => command.action === 'save')).toBe(false);
    const pages = calls.filter((command): command is Extract<ModelProvidersCommand, {action: 'list'}> =>
      command.action === 'list' && command.connectionId === firstId);
    for (const offset of [0, MODEL_PAGE_LIMIT]) {
      expect(pages.filter(command => command.offset === offset)).toEqual(
        Array.from({length: 2}, () => ({command: 'modelProviders', action: 'list', connectionId: firstId, offset, limit: MODEL_PAGE_LIMIT})),
      );
    }
    lastPage.release('SYNTHETIC_CATALOG_FAILURE');
    await editor.getByRole('button', {name:'重新读取模型'}).click();
    await select(page, '测试模型').selectOption(tail);
    expect(await select(page, '测试模型').inputValue()).toBe(tail);
    await save.click();
    await text(page, '连接已保存。').waitFor();
    const saves = () => calls.filter(command => command.action === 'save');
    expect(saves()[0]).toMatchObject({expectedVersion:1});
    expect(saves()[0]).not.toHaveProperty('manualModels');
    expect(connection.models.some(model => model.modelId === tail)).toBe(true);

    await control(page, '手动模型 ID').fill('manual/new');
    await button(page, '添加模型').click();
    const staleSave = fixture.hold('save');
    await save.click();
    await expect.poll(() => staleSave.entered).toBe(true);
    connection.version++;
    connection.models.splice(0, 0, manual('manual/concurrent'));
    staleSave.release();
    await button(page, '读取已保存配置').click();
    expect(saves()[1]).toMatchObject({expectedVersion:2, expectedSelectionRevision:1, manualModelsComplete:true,
      manualModels:expect.arrayContaining([{modelId:tail, displayName:null}, {modelId:'manual/new', displayName:null}])});
    await control(page, '手动模型 ID').fill('manual/new');
    await button(page, '添加模型').click();
    await save.click();
    await text(page, '连接已保存。').waitFor();
    expect(saves()[2]).toMatchObject({expectedVersion:3, expectedSelectionRevision:1, manualModelsComplete:true,
      manualModels:expect.arrayContaining([{modelId:tail, displayName:null}, {modelId:'manual/concurrent', displayName:null}])});
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.close(); }
});

test('P16 preserves later edits during saves and retains conflicts from another writer', async () => {
  const status = makeStatus();
  const fixture = await openSettings(status);
  const {page} = fixture;
  try {
    await button(page, '编辑 原连接').click();
    const name = control(page, '连接名称');
    await name.fill('第一次提交');
    const firstSave = fixture.hold('save', true);
    await button(page, '保存连接').click();
    await expect.poll(() => firstSave.entered).toBe(true);
    await name.fill('原连接');
    await button(page, '获取模型').click();
    await text(page, '列表未完整获取，已保留 1 个模型，可继续手动添加。 目录已达到保留上限。').waitFor();
    expect(await name.inputValue()).toBe('原连接');
    firstSave.release();
    await text(page, '连接已保存。').waitFor();
    expect(await name.inputValue()).toBe('原连接');

    await name.fill('第二次提交');
    const secondSave = fixture.hold('save', true);
    await button(page, '保存连接').click();
    await expect.poll(() => secondSave.entered).toBe(true);
    await name.fill('保存期间继续编辑');
    updateDraft(status.modelProviders!.connections[0]!, {baseUrl: 'https://concurrent.example.com/v1', keyPresent: false});
    secondSave.release();
    await button(page, '读取已保存配置').waitFor();
    expect(await button(page, '保存连接').isDisabled()).toBe(true);
    expect(await name.inputValue()).toBe('保存期间继续编辑');
    expect(await control(page, 'Base URL').inputValue()).toBe('https://api.deepseek.com');
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.close(); }
});

test('P16 displays specific status reasons and keeps diagnostic provider and model ID intact', async () => {
  for (const code of MODEL_ERROR_CODES) expect(errorMessages[code], code).toBeTruthy();
  const status = makeStatus();
  const [first, second] = status.modelProviders!.connections;
  const applied = first!.applied!;
  applied.keyPresent = false;
  applied.keyStored = true;
  applied.unavailableReason = 'DPAPI_RESTORE_FAILED';
  applied.catalogResult = {connectionId: firstId, routeRevision: 1, status: 'COMPLETE', fetchedAt: now, reason: null,
    totalCount: 0, truncated: false, selectedModelInCatalog: false};
  applied.testResult = {connectionId: firstId, routeRevision: 1, commandId: randomUUID(), modelId: firstModel,
    reportedModelId: null, status: 'FAILED', elapsedMs: 20, usage: null, reason: 'MODEL_AUTH_FAILED'};
  updateDraft(first!, {keyPresent: false, unavailableReason: 'MODEL_KEY_REQUIRED'});
  const selection = status.modelProviders!.selection;
  if (selection.connectionId !== null) selection.modelDisplayName = '应用中的显示名';
  first!.models[0]!.displayName = '草稿里的显示名';
  first!.draft.catalogResult = {connectionId:firstId, routeRevision:first!.draftRevision, status:'PARTIAL', fetchedAt:now,
    totalCount:1, truncated:false, selectedModelInCatalog:null, reason:'MODEL_TIMEOUT'};
  second!.draft.keyPresent = false;
  second!.models = [];
  status.budgets[0]!.used = 10;
  const fixture = await openSettings(status);
  const {page} = fixture;
  try {
    const current = page.getByRole('region', {name: '当前模型'});
    await current.getByRole('definition').filter({hasText: `应用中的显示名 · ${firstModel}`}).waitFor();
    await current.getByText('恢复失败', {exact: true}).waitFor();
    await current.getByText('目录未返回当前模型，已保留当前模型 ID。', {exact: true}).waitFor();
    await current.getByText(`连接测试失败。${errorMessages.MODEL_AUTH_FAILED}`, {exact: true}).waitFor();
    for (const code of ['DPAPI_RESTORE_FAILED', 'MODEL_CONNECTION_NOT_APPLIED', 'MODEL_BUDGET_EXHAUSTED'])
      await current.getByText(errorMessages[code]!, {exact: true}).waitFor();
    await select(page, '切换到连接').selectOption(secondId);
    await text(page, '模型目录为空，请在提供商管理中获取模型或手动添加。').waitFor();
    await text(page, '目标连接的 Key 未配置，请先保存可用的 Key。').waitFor();
    expect(await button(page, '应用切换').isDisabled()).toBe(true);
    await button(page, '编辑 原连接').click();
    const interruption = page.getByText('目录读取中断。', {exact:false});
    await interruption.waitFor();
    expect(await interruption.innerText()).toContain(errorMessages.MODEL_TIMEOUT);
    expect(await interruption.innerText()).not.toContain('目录已达到保留上限');
    await button(page, '调度与审计').click();
    const table = page.getByRole('table', {name: '模型与状态累计'});
    await text(page, '模型明细仅展示 3 组（共 5 组），上方累计包含全部记录。').waitFor();
    await table.getByRole('row').filter({hasText: 'OpenRouter'}).getByText(secondModel, {exact: true}).waitFor();
    await table.getByRole('row').filter({hasText: '自定义'}).getByText(secondModel, {exact: true}).waitFor();
    await table.getByRole('row').filter({hasText: '未知（历史记录）'}).getByText(firstModel, {exact: true}).waitFor();
    expect(fixture.calls).toEqual([]);
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.close(); }
});

test.each(['missing-state', 'disabled-flag', 'initialization-failed'] as const)(
  'P16 disables model management and explains unavailability (%s)', async mode => {
  const status = makeStatus();
  if (mode === 'missing-state') {
    delete status.modelProviders;
    delete status.modelProvidersSupported;
  } else {
    status.modelProvidersAvailable = false;
    if (mode === 'initialization-failed') status.modelProvidersSupported = true;
    else Object.assign(status, {modelProvidersSupported:false});
  }
  if (mode === 'initialization-failed') {
    delete status.modelProviders;
    status.modelProvidersError = 'MODEL_PROVIDER_SCHEMA_INVALID';
  }
  const fixture = await openSettings(status);
  const {page, all} = fixture;
  try {
    const legacy = text(page, '后端尚未更新多模型能力。');
    if (mode === 'initialization-failed') {
      await text(page, '多模型数据结构校验失败，请检查运行目录的迁移诊断。').waitFor();
      expect(await legacy.count()).toBe(0);
    } else await legacy.waitFor();
    expect(await button(page, '新建连接').isDisabled()).toBe(true);
    expect(await control(page, '本次 API Key').count()).toBe(0);
    await button(page, '自动化规则').click();
    expect(await button(page, '编辑业务提示词').isEnabled()).toBe(true);
    await button(page, '编辑业务提示词').click();
    const save = button(page, '保存业务提示词');
    if (mode === 'initialization-failed') {
      await control(page, '账号人设').fill('初始化失败时仍能保存');
      await save.click();
      await text(page, '业务提示词已保存').waitFor();
      expect(fixture.prompts).toEqual([{command: 'configureAi', settings: {persona: '初始化失败时仍能保存', business: '', rules: ''}}]);
    } else {
      await text(page, '请升级后端后再保存业务提示词。').waitFor();
      expect(await save.isDisabled()).toBe(true);
      expect(fixture.prompts).toEqual([]);
    }
    expect(all).not.toContain('modelProviders');
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.close(); }
});
