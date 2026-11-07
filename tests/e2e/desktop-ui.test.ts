import { test, expect } from "vitest";
import { createServer } from "vite";
import { chromium } from "playwright";
import { join, resolve } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ClientService } from "../../src/app/service.js";
import { BrowserService } from "../../src/app/browser-service.js";
import { AccountActor } from "../../src/browser/account-actor.js";
import { migrateClient } from "../../src/storage/client-migration.js";
import {
  database,
  pending,
  privateTemp,
  candidate,
  snapshot,
} from "../helpers.js";
import {
  digest,
  targetKey,
  type InboundEvent,
  type ReplyAdapter,
} from "../../src/core/contracts.js";

test.each([
  { width: 900, height: 640 },
  { width: 1240, height: 800 },
])(
  "React inbox, editing and confirmation via mocked Tauri IPC at $width x $height",
  async (viewport) => {
    const root = privateTemp("desktop-ui-"),
      store = database();
    const comment = pending(
      store,
      candidate({
        channel: "COMMENT_NOTIFICATION",
        kind: "COMMENT",
        platformEventId: "ui-comment",
        commentId: "ui-parent",
        videoId: "ui-work",
        conversationId: null,
        actorName: "合成评论作者",
        text: "合成评论长文。".repeat(35),
      }),
    );
    const dm = pending(
      store,
      candidate({
        platformEventId: "ui-dm",
        actorName: "合成私信作者",
        text: "这是一条合成测试私信。",
      }),
    );
    const legacyDraft = store.saveDraft(comment, "此前保存的合成 Mock 草稿。", "mock-deterministic");
    await migrateClient(store, join(root, "backup.sqlite"));
    let clicks = 0,identityAvailable=true;
    class UiBrowser extends BrowserService {
      private uiActor = new AccountActor();
      override get actor() {
        return this.uiActor;
      }
      override identity() {
        return identityAvailable ? {
          identityDigest: digest("own-1"),
          mappingDigest: "ui-fixture",
          browserMode: "headed" as const,
          browserVersion: "ui-fixture",
        } : null;
      }
      override async refreshIdentity() {
        return this.identity();
      }
      override async close() {}
      override async adapter(e: InboundEvent) {
        let text = "";
        const adapter: ReplyAdapter = {
          inspect: async () => snapshot(e),
          prepare: async (_e, t) => {
            text = t;
          },
          verifyPrepared: async () => snapshot(e),
          baseline: async () => [],
          clickOnce: async () => {
            clicks++;
            await new Promise((r) => setTimeout(r, 5));
          },
          readback: async () => ({
            id: randomUUID(),
            ownId: "own-1",
            targetKey: targetKey(e),
            text,
            pending: false,
            sentAt: new Date().toISOString(),
          }),
        };
        return { adapter, dispose: () => {} };
      }
    }
    const service = new ClientService(store, new UiBrowser(root)),
      token = service.authority.issueSession();
    let connected = false;
    for (const channel of ["DIRECT_MESSAGE", "COMMENT_NOTIFICATION"] as const)
      service.authority.attest(
        channel,
        "SEND_AVAILABLE",
        service.browser.identity(channel)!,
        "synthetic-ui-evidence",
      );
    service.authority.setMode(token, "MANUAL");
    service.authority.pause(token, null, true);
    const server = await createServer({
      configFile: resolve("desktop/vite.config.ts"),
      server: { port: 0, strictPort: false },
      logLevel: "error",
    });
    await server.listen();
    const browser = await chromium.launch({
      channel: "msedge",
      headless: true,
    });
    const page = await browser.newPage({ viewport });
    const errors: string[] = [];
    let releaseSave: (() => void) | undefined;
    let saveEntered: (() => void) | undefined;
    let holdSave = false;
    let holdThread = false;
    let delayInitialRead = false;
    let initialReads = 0;
    let threadEntered: (() => void) | undefined;
    let releaseThread: (() => void) | undefined;
    let holdCommentReads = false;
    const releaseCommentReads: (() => void)[] = [];
    const controlTrace: { command: string; paused: boolean; generation?: number; isMine?: boolean }[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.exposeFunction(
        "fixtureInvoke",
        async (command: string, args: { body: unknown }) => {
          if (command === "desktop_info")
            return { runtime: root, version: "0.2.2-synthetic" };
          if (command !== "client_request")
            throw new Error("UNEXPECTED_NATIVE_COMMAND");
          const body = args.body as { command: string; eventId?: string };
          if (body.command === "connect") connected = true;
          if (!connected) throw new Error("CONNECT_RUNTIME_FIRST");
          if (body.command === "saveDraft" && holdSave) {
            saveEntered?.();
            await new Promise<void>((resolve) => {
              releaseSave = resolve;
            });
            holdSave = false;
          }
          const result = await service.dispatch(
            token,
            body.command === "connect" ? { command: "getStatus" } : body,
          );
          const ownership = (result as { ownership?: { generation: number; isMine: boolean } }).ownership;
          controlTrace.push({ command: body.command, paused: service.authority.paused(),
            ...(ownership ? { generation: ownership.generation, isMine: ownership.isMine } : {}) });
          const delayInitial = body.command === "getThread" && delayInitialRead && ++initialReads === 2;
          if (body.command === "getThread" && (holdThread || delayInitial)) {
            holdThread = false;
            if (delayInitial) delayInitialRead = false;
            threadEntered?.();
            await new Promise<void>((resolve) => { releaseThread = resolve; });
          }
          if (body.command === "getThread" && body.eventId === comment && holdCommentReads) {
            await new Promise<void>((resolve) => { releaseCommentReads.push(resolve); });
          }
          return result;
        },
      );
      await page.addInitScript(() => {
        (
          window as unknown as { __TAURI_INTERNALS__: unknown }
        ).__TAURI_INTERNALS__ = {
          invoke: async (command: string, args: unknown) => {
            const result = await (
              window as unknown as {
                fixtureInvoke: (c: string, a: unknown) => Promise<unknown>;
              }
            ).fixtureInvoke(command, args);
            if ((args as { body?: { command?: string } })?.body?.command === "getThread") {
              const fixtureWindow = window as unknown as { fixtureThreadReplies: number };
              fixtureWindow.fixtureThreadReplies = (fixtureWindow.fixtureThreadReplies ?? 0) + 1;
            }
            return result;
          },
        };
      });
      const address = server.httpServer!.address() as { port: number };
      await page.goto(`http://127.0.0.1:${address.port}`);
      await page.getByRole("checkbox").nth(1).check();
      await page.getByRole("button", { name: "连接收件箱" }).click();
      await page.getByRole("button", { name: /合成私信作者/ }).click();
      await expect
        .poll(() =>
          page.getByRole("heading", { name: "合成私信作者" }).isVisible(),
        )
        .toBe(true);
      await expect.poll(() => page.locator(".editor-title").innerText()).toContain("尚未保存");
      await page.getByRole("button", { name: "人工接管", exact: true }).click();
      const editor = page.getByRole("textbox", { name: "人工回复草稿" });
      await editor.fill("急停时必须保留的未保存人稿");
      await page.getByRole("button", { name: "全局急停", exact: true }).click();
      await page.getByText("急停已生效；已存意图仍需回读或冻结", { exact: true }).waitFor();
      expect(service.authority.paused()).toBe(true);
      expect(service.authority.ownership(store.event(dm)).operator_id).toBe(null);
      await expect.poll(() => page.getByRole("button", { name: "人工接管", exact: true }).count()).toBe(1);
      await expect.poll(() => editor.getAttribute("readonly")).not.toBe(null);
      expect(await editor.inputValue()).toBe("急停时必须保留的未保存人稿");
      await page.getByRole("button", { name: "人工接管", exact: true }).click();
      const oldThreadEntered = new Promise<void>((resolve) => { threadEntered = resolve; });
      holdThread = true;
      await page.getByRole("button", { name: "保存草稿", exact: true }).click();
      await oldThreadEntered;
      await editor.fill("旧详情在途期间继续输入的人稿");
      await page.getByRole("button", { name: "全局急停", exact: true }).click();
      await expect.poll(() => page.getByRole("button", { name: "人工接管", exact: true }).count()).toBe(1);
      releaseThread!();
      await page.getByText("草稿已保存，旧审批已失效", { exact: true }).waitFor();
      await expect.poll(() => page.getByRole("button", { name: "人工接管", exact: true }).count()).toBe(1);
      expect(await editor.getAttribute("readonly")).not.toBe(null);
      expect(await editor.inputValue()).toBe("旧详情在途期间继续输入的人稿");
      await page.getByRole("button", { name: "人工接管", exact: true }).click();
      await service.dispatch(token, { command: "resume", eventId: null });
      await page.getByRole("button", { name: "重新连接内核", exact: true }).click();
      await expect.poll(() => page.locator(".topbar .muted").innerText()).not.toContain("已暂停");
      holdSave = true;
      const entered = new Promise<void>((resolve) => {
        saveEntered = resolve;
      });
      await editor.fill("保存请求的旧文字");
      await page.getByRole("button", { name: "保存草稿", exact: true }).click();
      await entered;
      await editor.fill("保存期间继续输入的新文字");
      holdCommentReads = true;
      await page.getByRole("button", { name: /合成评论作者/ }).click();
      await expect.poll(() => releaseCommentReads.length).toBe(2);
      releaseSave!();
      await page
        .getByText("草稿已保存，旧审批已失效", { exact: true })
        .waitFor();
      holdCommentReads = false;
      releaseCommentReads.forEach(release => release());
      await expect.poll(() => page.getByRole("heading", { name: "合成评论作者" }).count()).toBe(1);
      await expect.poll(() => page.locator(".editor-title").innerText()).toContain("历史草稿");
      expect(await editor.inputValue()).toBe(legacyDraft.text);
      expect(service.authority.draftFor(comment)?.origin).toBe("LEGACY");
      await page.getByRole("button", { name: /合成私信作者/ }).click();
      await expect
        .poll(() => editor.inputValue())
        .toBe("保存期间继续输入的新文字");
      await editor.fill("人工编写的合成回复，不需要模型。");
      await page.getByRole('button',{name:'重新连接内核',exact:true}).click();
      await expect.poll(()=>editor.inputValue()).toBe('人工编写的合成回复，不需要模型。');
      await page.getByRole("button", { name: "保存草稿", exact: true }).click();
      await expect.poll(() => page.locator(".editor-title").innerText()).toContain("人工输入");
      await page
        .getByRole("button", { name: "核对并发送", exact: true })
        .click();
      await expect
        .poll(() =>
          page.getByRole("region", { name: "逐条发送确认" }).isVisible(),
        )
        .toBe(true);
      await page
        .getByRole("button", { name: "确认此目标与全文，发送一次" })
        .click();
      await service.drain();
      await expect.poll(() => store.event(dm).status).toBe("CONFIRMED");
      expect(clicks).toBe(1);
      await page.getByRole("button", { name: /合成评论作者/ }).click();
      await expect
        .poll(() => page.getByText("原父评论", { exact: true }).count())
        .toBeGreaterThan(0);
      await expect
        .poll(() => page.getByText("ui-parent", { exact: true }).isVisible())
        .toBe(true);
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth > innerWidth ||
          document.documentElement.scrollHeight > innerHeight,
      );
      expect(overflow).toBe(false);
      const output = resolve(".local/desktop-ui");
      await mkdir(output, { recursive: true });
      await page.screenshot({
        path: join(output, `inbox-${viewport.width}x${viewport.height}.png`),
      });
      await page
        .getByRole("button", { name: "AI 与设置", exact: true })
        .click();
      await expect
        .poll(() =>
          page.getByRole("heading", { name: "DeepSeek 辅助回复" }).isVisible(),
        )
        .toBe(true);
      identityAvailable=false;
      await page.getByRole('button',{name:'重新连接内核',exact:true}).click();
      await expect.poll(()=>page.getByRole('combobox',{name:'工作模式',exact:true}).inputValue()).toBe('MANUAL');
      await page.getByText('已选择纯人工回复；当前仅保存草稿。请打开专属浏览器，并查看下方通道状态。',{exact:true}).waitFor();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth||document.documentElement.scrollHeight>innerHeight)).toBe(false);
      await page.screenshot({path:join(output,`mode-${viewport.width}x${viewport.height}.png`)});
      await page.getByRole('combobox',{name:'工作模式',exact:true}).selectOption('OBSERVE');
      await expect.poll(()=>service.authority.mode()).toBe('OBSERVE');
      await page.getByRole('combobox',{name:'工作模式',exact:true}).selectOption('MANUAL');
      await expect.poll(()=>page.getByRole('combobox',{name:'工作模式',exact:true}).inputValue()).toBe('MANUAL');
      expect(await service.dispatch(token,{command:'getStatus'})).toMatchObject({mode:'DRAFT_ONLY',configuredMode:'MANUAL'});
      identityAvailable=true;
      await page.getByRole('button',{name:'重新连接内核',exact:true}).click();
      await page
        .getByRole("textbox", { name: "本次 API Key" })
        .fill("synthetic-ui-memory-key");
      await page
        .getByRole("button", { name: "保存配置并清空 Key 输入" })
        .click();
      await expect
        .poll(() =>
          page.getByRole("textbox", { name: "本次 API Key" }).inputValue(),
        )
        .toBe("");
      await page.getByRole("button", { name: "全局急停", exact: true }).click();
      await expect.poll(() => service.authority.paused()).toBe(true);
      expect(
        store.db.prepare("SELECT count(*) AS n FROM model_calls").get(),
      ).toEqual({ n: 0 });
      expect(errors).toEqual([]);
      expect(store.event(comment).status).toBe("AWAITING_APPROVAL");
      // A renderer refresh only reads the live authority. No command replay and no second click.
      await page.reload();
      await expect
        .poll(() =>
          page
            .getByRole("heading", { name: "收件箱", exact: true })
            .isVisible(),
        )
        .toBe(true);
      expect(clicks).toBe(1);
      const initialEntered = new Promise<void>((resolve) => { threadEntered = resolve; });
      delayInitialRead = true;
      await page.getByRole("button", { name: /合成评论作者/ }).click();
      await initialEntered;
      await page.getByRole("button", { name: "重新连接内核", exact: true }).click();
      await expect.poll(() => page.getByRole("button", { name: "人工接管", exact: true }).count()).toBe(1);
      await page.getByRole("button", { name: "人工接管", exact: true }).click();
      await editor.fill("初始详情迟到不得覆盖的人稿");
      const replies = await page.evaluate(() => (window as unknown as { fixtureThreadReplies: number }).fixtureThreadReplies);
      releaseThread!();
      await expect.poll(() => page.evaluate(() => (window as unknown as { fixtureThreadReplies: number }).fixtureThreadReplies)).toBe(replies + 1);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect.poll(() => editor.inputValue()).toBe("初始详情迟到不得覆盖的人稿");
      await expect.poll(() => page.getByRole("button", { name: "释放接管", exact: true }).count()).toBe(1);
      expect(await editor.getAttribute("readonly")).toBe(null);
      await writeFile(
        join(output, `checks-${viewport.width}.json`),
        JSON.stringify({
          viewport,
          overflow,
          clicks,
          modelRequests: 0,
          synthetic: true,
        }),
      );
    } finally {
      await mkdir(resolve(".local/desktop-ui"), { recursive: true });
      await writeFile(resolve(`.local/desktop-ui/control-trace-${viewport.width}.json`), JSON.stringify(controlTrace));
      await browser.close();
      await server.close();
      await service.close();
      store.close();
    }
  },
  60_000,
);
