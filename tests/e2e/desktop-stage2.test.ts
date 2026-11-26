import {fileURLToPath} from 'node:url';
import {chromium, type Browser} from 'playwright';
import {createServer, type ViteDevServer} from 'vite';
import {afterAll, beforeAll, expect, test} from 'vitest';
import {defaultSettings} from '../../src/contracts/client.js';
import type {PublicModelConnection} from '../../src/contracts/model-providers.js';
import type {BusinessPrompts, Status} from '../../desktop/src/api.js';

const connectionId = '64ce7003-91f9-41e1-bc3e-60611c81b002';
const revision: PublicModelConnection['draft'] = {
  routeRevision:1, presetId:'deepseek', protocol:'OPENAI_CHAT', baseUrl:'https://api.deepseek.com',
  region:null, storage:'MEMORY', keyPresent:true, keyStored:false, unavailableReason:null, catalogResult:null, testResult:null,
};
const initial: Status = {
  runtime:'synthetic-stage2', account:null, operator:{id:'test-operator', permissions:[], expiresAt:0},
  mode:'MANUAL', configuredMode:'MANUAL', paused:false, browser:{state:'CLOSED', mode:'headless', version:null},
  lastSync:[], capabilities:[], budgets:[], usage:{requests:0, inputTokens:0, outputTokens:0, unresolved:0},
  settings:{...defaultSettings, persona:'旧人设'}, keyPresent:true, modelAuthorized:true, modelBusy:false,
  go:'UNVERIFIED', schema:3, sync:{runId:null, running:false, cancelled:false, source:null, results:[]},
  modelProvidersSupported:true, modelProvidersAvailable:true,
  modelProviders:{listRevision:2,
    connections:[{id:connectionId, name:'测试连接', presetId:'deepseek', version:1, draftRevision:1, modelsFetchedAt:null,
      models:['deepseek-flash','deepseek-pro'].map(modelId => ({modelId, displayName:null, source:'MANUAL'})),
      draft:revision, applied:revision}],
    selection:{connectionId, routeRevision:1, modelId:'deepseek-flash', selectionRevision:1}},
};

type Delivery = 'new-model' | 'new-session' | 'same-batch';
interface Fixture {release: () => void; awaitingStatus: () => boolean}

let server: ViteDevServer;
let browser: Browser;
beforeAll(async () => {
  server = await createServer({configFile:fileURLToPath(new URL('../../desktop/vite.config.ts', import.meta.url)),
    server:{port:0, strictPort:false}, logLevel:'error'});
  await server.listen();
  browser = await chromium.launch({channel:'msedge', headless:true});
}, 15_000);
afterAll(async () => {
  try { await browser?.close(); } finally { await server?.close(); }
});

test.each<Delivery>(['new-model', 'new-session', 'same-batch'])('App reconciles delayed business prompts with %s', async delivery => {
  const page = await browser.newPage();
  page.setDefaultTimeout(3500);
  try {
    await page.addInitScript(({initial, delivery}) => {
      let status = initial;
      let deferRead = false;
      let pauseReads = false;
      let finishRead: (() => void) | undefined;
      let finishPrompt: (() => void) | undefined;
      const target = window as unknown as {fixture: Fixture; __TAURI_INTERNALS__: unknown; __TAURI_EVENT_PLUGIN_INTERNALS__: unknown};
      target.fixture = {
        awaitingStatus: () => !!finishRead,
        release: () => {
          pauseReads = true;
          finishPrompt?.();
          finishRead?.();
        },
      };
      const advanceModel = () => {
        status = {...status, settings:{...status.settings, model:'deepseek-pro'}, modelProviders:{...status.modelProviders!,
          listRevision:3, selection:{connectionId:initial.modelProviders!.connections[0]!.id, routeRevision:1,
            modelId:'deepseek-pro', selectionRevision:2}}};
      };
      target.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: (name: string, args: {body:{command:string; settings:BusinessPrompts}}) => {
          if (name === 'desktop_info') return {runtime:status.runtime, version:'synthetic'};
          if (name === 'plugin:event|listen') return 1;
          if (name === 'plugin:event|unlisten') return;
          switch (args.body.command) {
            case 'getStatus': {
              if (pauseReads) return new Promise(() => {});
              if (!deferRead) return structuredClone(status);
              deferRead = false;
              const snapshot = structuredClone(status);
              return new Promise(resolve => { finishRead = () => resolve(snapshot); });
            }
            case 'getInbox': return {items:[], total:0, page:0, pageSize:20};
            case 'modelProviders':
              advanceModel();
              deferRead = delivery === 'same-batch';
              return null;
            case 'configureAi': {
              const snapshot = {...status, settings:{...status.settings, ...args.body.settings}};
              return new Promise(resolve => { finishPrompt = () => resolve(snapshot); });
            }
            case 'syncInbox':
              advanceModel();
              status = {...status, operator:{...status.operator, id:'replacement-operator'}, settings:{...status.settings, persona:'新会话人设'}};
              return structuredClone(status);
            default: throw new Error('UNEXPECTED_FIXTURE_COMMAND');
          }
        },
      };
      target.__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener: () => {}};
    }, {initial, delivery});
    await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}`);
    const button = (name: string) => page.getByRole('button', {name, exact:true});
    const persona = page.getByRole('textbox', {name:'账号人设', exact:true});
    const current = page.getByRole('region', {name:'当前模型'});
    const advancedModel = current.getByRole('definition').filter({hasText:'deepseek-pro'});
    await button('自动化规则').click();
    await button('编辑业务提示词').click();
    await persona.fill('已保存人设');
    await button('保存业务提示词').click();
    await page.getByText('正在保存业务提示词…', {exact:true}).waitFor();
    await page.keyboard.press('Escape');

    if (delivery === 'new-session') {
      await button('同步收件箱').click();
      await button('多模型配置').click();
    } else {
      await button('多模型配置').click();
      await page.getByRole('combobox', {name:'切换到模型', exact:true}).selectOption('deepseek-pro');
      await button('应用切换').click();
    }
    if (delivery === 'same-batch') {
      await expect.poll(() => page.evaluate(() => (window as unknown as {fixture:Fixture}).fixture.awaitingStatus())).toBe(true);
    } else await advancedModel.waitFor();

    await page.evaluate(() => (window as unknown as {fixture:Fixture}).fixture.release());
    await advancedModel.waitFor();
    if (delivery === 'same-batch') await page.getByText('已应用模型切换。', {exact:true}).waitFor();
    // A new AutomationView mount initializes from App state. The fixture holds fresh reads for this assertion.
    await button('会话中心').click();
    await button('自动化规则').click();
    await button('编辑业务提示词').click();
    expect(await persona.inputValue()).toBe(delivery === 'new-session' ? '新会话人设' : '已保存人设');
  } finally { await page.close(); }
}, 15_000);
