import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { EventStore } from "../dist/storage/store.js";
import { initRuntime } from "../dist/config/runtime.js";
import { OwnerLock } from "../dist/browser/owner-lock.js";

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
      WEBVIEW2_USER_DATA_FOLDER: join(root, `webview-${index}`),
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
  await page.getByRole("checkbox").nth(1).check();
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
const result = {
  source: "INSTALLED_NATIVE_TAURI_WEBVIEW2",
  executable,
  synthetic: true,
  root,
  viewports: [],
  modelRequests: 0,
  realSends: 0,
};
if (configuredPort) result.source = "NATIVE_TAURI_QA_CONFIG_API_DEBUG_ARGUMENT";
let run;
try {
  run = await launch(1);
  console.log("Installed native app and actual Tauri WebView attached");
  await connect(run.page);
  await run.page.getByRole("button", { name: /合成原生私信/ }).click();
  await run.page.getByRole("button", { name: "人工接管", exact: true }).click();
  await run.page
    .getByRole("textbox", { name: "人工回复草稿" })
    .fill("原生客户端人工持久化验证。");
  await run.page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await run.page
    .getByText("草稿已保存，旧审批已失效", { exact: true })
    .waitFor();
  assert(
    await run.page
      .getByRole("button", { name: "核对并发送", exact: true })
      .isDisabled(),
  );
  for (const viewport of [
    { width: 900, height: 640 },
    { width: 1240, height: 800 },
  ]) {
    await run.page.setViewportSize(viewport);
    assert.equal(
      await run.page.evaluate(
        () =>
          document.documentElement.scrollWidth > innerWidth ||
          document.documentElement.scrollHeight > innerHeight,
      ),
      false,
    );
    await run.page.screenshot({
      path: join(root, `native-${viewport.width}x${viewport.height}.png`),
    });
    result.viewports.push(viewport);
  }
  await run.page
    .getByRole("button", { name: "AI 与设置", exact: true })
    .click();
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
    .getByText("模型：未授权 · Key：仅后端内存持有", { exact: true })
    .waitFor();
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
  await connect(run.page);
  await run.page.getByRole("button", { name: /合成原生私信/ }).click();
  await run.page.waitForFunction(
    () =>
      document.querySelector('textarea[aria-label="人工回复草稿"]')?.value ===
      "原生客户端人工持久化验证。",
  );
  assert.equal(
    await run.page.getByRole("textbox", { name: "人工回复草稿" }).inputValue(),
    "原生客户端人工持久化验证。",
  );
  await run.page
    .getByRole("button", { name: "AI 与设置", exact: true })
    .click();
  await run.page
    .getByText("模型：未授权 · Key：未配置", { exact: true })
    .waitFor();
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
