import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, writeFile,readFile,access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { EventStore } from "../dist/storage/store.js";
import { initRuntime } from "../dist/config/runtime.js";
import { OwnerLock } from "../dist/browser/owner-lock.js";
import { migrateClient } from '../dist/storage/client-migration.js';
import { migrateAutomation } from '../dist/storage/automation-migration.js';
import { AutomationStore } from '../dist/storage/automation-store.js';

const executable = resolve(
  process.argv[2] ?? ".local/native-installed/inbora.exe",
);
const configuredPort = process.argv[3] ? Number(process.argv[3]) : null;
const base = resolve(".local/native-smoke");
await mkdir(base, { recursive: true });
const root = await mkdtemp(join(base, "run-"));
await initRuntime(root);
const initial = new EventStore(join(root, "poc.sqlite"), true);
const event = {
  accountId: "account_001",
  channel: "DIRECT_MESSAGE",
  platformEventId: "native-synthetic-1",
  actorId: "native-fixture-peer",
  actorName: "合成原生私信",
  text: "仅用于本地原生窗口和持久化验证的合成事件。",
  occurredAt: "2026-11-06T00:00:01.000Z",
  videoId: null,
  commentId: null,
  conversationId: "native-fixture-conversation",
  direction: "INCOMING",
  kind: "DM",
  evidenceId: "synthetic-native-only",
  discovery: "DIRECT_MESSAGE",
};
initial.observe(
  "DIRECT_MESSAGE",
  event.conversationId,
  [],
  "native-fixture-own",
  "synthetic-native-only",
  "2026-11-06T00:00:00.000Z",
);
initial.observe(
  "DIRECT_MESSAGE",
  event.conversationId,
  [event],
  "native-fixture-own",
  "synthetic-native-only",
  "2026-11-06T00:00:02.000Z",
);
await migrateClient(initial,join(root,'schema3-backup.sqlite'));
await migrateAutomation(initial,join(root,'automation-backup.sqlite'));
const automation=new AutomationStore(initial);automation.initialize(Date.now());automation.stop(true);
const eventId=initial.events().find(item=>item.payload.platformEventId===event.platformEventId).id;
initial.close();

async function launch(index) {
  if (index > 1 && configuredPort) {
    for (let i = 0; i < 60; i++) {
      let live = false;
      try {
        live = (await fetch(`http://127.0.0.1:${configuredPort}/json/version`))
          .ok;
      } catch {}
      if (!live) break;
      if (i === 59) throw new Error("PREVIOUS_NATIVE_WEBVIEW_STILL_RUNNING");
      await delay(100);
    }
  }
  const server = createServer();
  server.listen(configuredPort ?? 0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  const child = spawn(executable, [], {
    windowsHide: true,
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
      WEBVIEW2_USER_DATA_FOLDER: join(root, 'webview'),
    },
    stdio: "ignore",
  });
  let connected = false;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error("NATIVE_APP_EXITED_EARLY");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        connected = true;
        break;
      }
    } catch {}
    await delay(200);
  }
  if (!connected) {
    child.kill();
    throw new Error("NATIVE_WEBVIEW_DEBUG_TARGET_UNAVAILABLE");
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let page;
  for (let i = 0; i < 50 && !page; i++) {
    page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().startsWith("http://tauri.localhost"));
    if (!page) await delay(100);
  }
  assert(
    page,
    "Native Tauri WebView must exist; no browser preview is accepted",
  );
  return { child, browser, page, port };
}
async function connect(page) {
  await page.getByRole("textbox", { name: "私有运行目录" }).fill(root);
  await page.getByRole("checkbox",{name:'我确认这是已授权账号的本地运行目录，允许读取并升级数据库',exact:true}).check();
  await page.getByRole("button", { name: "连接收件箱", exact: true }).click();
  try {
    await page
      .getByRole("heading", { name: "收件箱", exact: true })
      .waitFor({ timeout: 8000 });
  } catch (error) {
    console.log(
      "Native connect state: " + (await page.locator("body").innerText()),
    );
    throw error;
  }
}
const rpc=(page,body)=>page.evaluate(body=>window.__TAURI_INTERNALS__.invoke('client_request',{body}),body);
async function waitFor(check,message){
  const deadline=Date.now()+10_000;while(Date.now()<deadline){if(await check())return;await delay(100);}throw Error(message);
}
async function assertStopped(page){
  const status=await rpc(page,{command:'getStatus'});assert.equal(status.runtime,root);assert.equal(status.automation.emergencyStopped,true);
  assert.equal(status.browser.state,'CLOSED');assert.equal(status.automation.replyPolicy,null);assert.equal(status.automation.collection,null);
  assert.ok(status.budgets.every(item=>item.used===0));assert.equal(status.usage.requests,0);return status;
}
const draftText='原生客户端人工持久化验证。';
const result = {
  source: "PACKAGED_NATIVE_TAURI_WEBVIEW2",
  executable,
  synthetic: true,
  root,
  viewports: [],
  modelRequests: 0,
  realSends: 0,
};
if (configuredPort) result.debugPortConfigured = true;
let run;
try {
  run = await launch(1);
  console.log("Packaged native app and actual Tauri WebView attached");
  await connect(run.page);
  await assertStopped(run.page);
  await run.page.locator('.task').filter({hasText:'合成原生私信'}).click();
  const editor=run.page.getByRole('textbox',{name:'人工回复草稿'}),composer=run.page.locator('.reply-composer');
  await editor.waitFor();await waitFor(()=>editor.isEditable(),'INLINE_COMPOSER_NOT_EDITABLE');
  assert.equal(await run.page.getByRole('button',{name:'打开人工回复',exact:true}).count(),0);
  assert.equal(await run.page.getByRole('dialog',{name:'人工回复对话框'}).count(),0);
  assert.equal(await run.page.getByRole('log',{name:'私信消息流'}).count(),1);
  await editor.fill(draftText);
  await waitFor(async()=>{const thread=await rpc(run.page,{command:'getThread',eventId});return thread.ownership.isMine&&thread.draft?.text===draftText;},'INLINE_DRAFT_NOT_AUTOSAVED');
  await composer.getByText('修改已保存',{exact:true}).waitFor();result.automaticInlineComposer=true;
  assert.deepEqual(await run.page.getByRole('combobox',{name:'任务状态'}).locator('option').allTextContents(),['等待回复','已回复']);
  assert.equal(await run.page.getByRole('button',{name:'全局急停',exact:true}).count(),0);
  assert.equal(await run.page.getByRole('button',{name:'只读核验',exact:true}).count(),0);
  const nativeCommands=await run.page.evaluate(async()=>{
    const invoke=body=>window.__TAURI_INTERNALS__.invoke('client_request',{body});
    const errors={};
    const policy={ownId:'native-fixture-own',channels:['DIRECT_MESSAGE'],model:'deepseek-flash',modelLimit:1,sendLimit:1,expiresAt:null,
      workIds:[],futureOwnWorks:false,conversationIds:['native-fixture-conversation'],entireInbox:false,containsAny:['synthetic-marker'],excludesAny:[],instructions:'Synthetic contract only.',startHour:0,endHour:24};
    try{await invoke({command:'enableReplyPolicy',policy,confirmed:true});}catch(error){errors.enable=String(error);}
    const stopped=await invoke({command:'setAutomaticReply',enabled:false});
    return {errors,mode:stopped.configuredMode,emergencyStopped:stopped.automation.emergencyStopped};
  });
  assert.equal(nativeCommands.errors.enable,'EMERGENCY_STOPPED');
  assert.equal(nativeCommands.mode,'MANUAL');assert.equal(nativeCommands.emergencyStopped,true);
  result.nativePolicyCommands=true;result.twoReplyBuckets=true;
  assert(
    await run.page
      .getByRole("button", { name: "发送", exact: true })
      .isDisabled(),
  );
  for (const viewport of [
    { width: 900, height: 640 },
    { width: 1240, height: 800 },
  ]) {
    await run.page.setViewportSize(viewport);
    assert.equal(
      await run.page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
      ),
      false,
    );
    for(const control of [editor,composer.getByRole('button',{name:'发送',exact:true})]){
      const box=await control.boundingBox();assert.ok(box&&box.x>=0&&box.y>=0&&box.x+box.width<=viewport.width&&box.y+box.height<=viewport.height);
    }
    await run.page.screenshot({
      path: join(root, `native-${viewport.width}x${viewport.height}.png`),
    });
    result.viewports.push(viewport);
  }
  await run.page
    .getByRole("button", { name: "AI 与设置", exact: true })
    .click();
  const nested=run.page.getByRole('checkbox',{name:'自动回复楼中楼评论',exact:true});
  assert.equal(await nested.isChecked(),true);await nested.uncheck();assert.equal(await nested.isChecked(),false);
  await assertStopped(run.page);await nested.check();assert.equal(await nested.isChecked(),true);await assertStopped(run.page);
  result.nestedReplyChoice={defaultOn:true,offDisplayed:true,onDisplayed:true,policySaved:false};
  await run.page
    .getByRole("textbox", { name: "本次 API Key" })
    .fill("synthetic-native-memory-key");
  await run.page
    .getByRole("button", { name: "保存配置并清空 Key 输入" })
    .click();
  assert.equal(
    await run.page.getByRole("textbox", { name: "本次 API Key" }).inputValue(),
    "",
  );
  await run.page
    .getByText("模型：持续授权有效 · Key：仅后端内存持有", { exact: true })
    .waitFor();
  const keyed=await assertStopped(run.page);assert.equal(keyed.keyPresent,true);assert.equal(keyed.keyStored,false);
  assert.ok(keyed.automation.modelGrant);assert.equal(await run.page.getByRole('checkbox',{name:'在本机安全保存 Key（Windows 当前用户 DPAPI，默认关闭）',exact:true}).isChecked(),false);
  assert.equal((await readFile(join(root,'client-settings.json'),'utf8')).includes('synthetic-native-memory-key'),false);
  await assert.rejects(access(join(root,'model-key.dpapi')),{code:'ENOENT'});
  await run.page.reload();
  await run.page
    .getByRole("heading", { name: "收件箱", exact: true })
    .waitFor();
  // Explicit hard-exit case, no send has been approved or attempted.
  const exited = once(run.child, "exit");
  run.child.kill();
  await exited;
  await run.browser.close().catch(() => {});
  run = undefined;
  run = await launch(2);
  await run.page.getByRole('heading',{name:'收件箱',exact:true}).waitFor({timeout:10_000});
  result.autoReconnect=true;
  await assertStopped(run.page);
  await run.page.locator('.task').filter({hasText:'合成原生私信'}).click();
  await run.page.waitForFunction(
    () =>
      document.querySelector('textarea[aria-label="人工回复草稿"]')?.value ===
      "原生客户端人工持久化验证。",
  );
  assert.equal(
    await run.page.getByRole("textbox", { name: "人工回复草稿" }).inputValue(),
    draftText,
  );
  const resumed=await rpc(run.page,{command:'getThread',eventId});assert.equal(resumed.draft.text,draftText);assert.equal(resumed.draft.origin,'HUMAN_TYPED');
  await run.page
    .getByRole("button", { name: "AI 与设置", exact: true })
    .click();
  await run.page
    .getByText("模型：持续授权有效 · Key：未配置", { exact: true })
    .waitFor();
  const restarted=await assertStopped(run.page);assert.equal(restarted.keyPresent,false);assert.equal(restarted.keyStored,false);
  assert.equal(restarted.automation.modelGrant?.version,keyed.automation.modelGrant.version);
  assert.equal(await run.page.getByRole('checkbox',{name:'自动回复楼中楼评论',exact:true}).isChecked(),true);
  await run.page.getByText('故障处理',{exact:true}).click();
  await run.page.getByRole("button", { name: "全局急停", exact: true }).click();
  await run.page
    .getByText("急停已生效；已存意图仍需回读或冻结", { exact: true })
    .waitFor();
  result.restartPreservedDraft = true;
  result.keyMemoryOnly = true;
  result.emergencyStop = true;
  // The normal window-close command uses Tauri's own IPC and graceful supervisor shutdown.
  const exitPromise = once(run.child, "exit");
  const closeResult = await run.page
    .evaluate(async () => {
      try {
        await window.__TAURI_INTERNALS__.invoke("desktop_exit");
        return "closed";
      } catch {
        return "window-closed";
      }
    })
    .catch(() => "window-closed");
  result.normalClose = closeResult;
  await Promise.race([
    exitPromise,
    delay(10_000).then(() => {
      if (run.child.exitCode === null) throw new Error("NATIVE_EXIT_TIMEOUT");
    }),
  ]);
} catch (error) {
  if (run) {
    await run.page
      .screenshot({ path: join(root, "failure.png") })
      .catch(() => {});
    await writeFile(
      join(root, "failure.txt"),
      await run.page
        .locator("body")
        .innerText()
        .catch(() => ""),
    );
  }
  throw error;
} finally {
  if (run) {
    if (run.child.exitCode === null) run.child.kill();
    await run.browser.close().catch(() => {});
  }
}
let ownerLock;
for (let i = 0; i < 50 && !ownerLock; i++) {
  try {
    ownerLock = await OwnerLock.acquire(root);
  } catch {
    await delay(100);
  }
}
assert(ownerLock, "Native supervisor must release its runtime lock on exit");
let persisted;
for (let i = 0; i < 20 && !persisted; i++) {
  try {
    persisted = new EventStore(join(root, "poc.sqlite"));
  } catch (error) {
    if (i === 19) throw error;
    await delay(100);
  }
}
try {
  assert.equal(
    persisted.db.prepare("SELECT used FROM budgets WHERE kind=?").get("MODEL")
      .used,
    0,
  );
  assert.equal(
    persisted.db.prepare("SELECT used FROM budgets WHERE kind=?").get("SEND")
      .used,
    0,
  );
  assert.equal(
    persisted.db.prepare("SELECT count(*) AS n FROM model_calls").get().n,
    0,
  );
  assert.equal(persisted.db.prepare('SELECT count(*) AS n FROM send_intents').get().n,0);
  assert.equal(persisted.draft(persisted.db.prepare('SELECT id FROM reply_drafts WHERE event_id=?').get(eventId).id).text,draftText);
  assert.equal(
    persisted.db.prepare("SELECT paused FROM client_state WHERE id=1").get()
      .paused,
    1,
  );
} finally {
  persisted.close();
  await ownerLock.close();
}
await writeFile(
  join(root, "native-smoke.json"),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result));
