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
    await migrateClient(store, join(root, "backup.sqlite"));
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
    let clicks = 0;
    class UiBrowser extends BrowserService {
      private uiActor = new AccountActor();
      override get actor() {
        return this.uiActor;
      }
      override identity() {
        return {
          identityDigest: digest("own-1"),
          mappingDigest: "ui-fixture",
          browserMode: "headed" as const,
          browserVersion: "ui-fixture",
        };
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
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.exposeFunction(
        "fixtureInvoke",
        async (command: string, args: { body: unknown }) => {
          if (command === "desktop_info")
            return { runtime: root, version: "0.2.0-synthetic" };
          if (command !== "client_request")
            throw new Error("UNEXPECTED_NATIVE_COMMAND");
          const body = args.body as { command: string };
          if (body.command === "connect") connected = true;
          if (!connected) throw new Error("CONNECT_RUNTIME_FIRST");
          if (body.command === "saveDraft" && holdSave) {
            saveEntered?.();
            await new Promise<void>((resolve) => {
              releaseSave = resolve;
            });
            holdSave = false;
          }
          return service.dispatch(
            token,
            body.command === "connect" ? { command: "getStatus" } : body,
          );
        },
      );
      await page.addInitScript(() => {
        (
          window as unknown as { __TAURI_INTERNALS__: unknown }
        ).__TAURI_INTERNALS__ = {
          invoke: (command: string, args: unknown) =>
            (
              window as unknown as {
                fixtureInvoke: (c: string, a: unknown) => Promise<unknown>;
              }
            ).fixtureInvoke(command, args),
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
      await page.getByRole("button", { name: "人工接管", exact: true }).click();
      const editor = page.getByRole("textbox", { name: "人工回复草稿" });
      holdSave = true;
      const entered = new Promise<void>((resolve) => {
        saveEntered = resolve;
      });
      await editor.fill("保存请求的旧文字");
      await page.getByRole("button", { name: "保存草稿", exact: true }).click();
      await entered;
      await editor.fill("保存期间继续输入的新文字");
      await page.getByRole("button", { name: /合成评论作者/ }).click();
      releaseSave!();
      await page
        .getByText("草稿已保存，旧审批已失效", { exact: true })
        .waitFor();
      await page.getByRole("button", { name: /合成私信作者/ }).click();
      await expect
        .poll(() => editor.inputValue())
        .toBe("保存期间继续输入的新文字");
      await editor.fill("人工编写的合成回复，不需要模型。");
      await page.getByRole('button',{name:'重新连接内核',exact:true}).click();
      await expect.poll(()=>editor.inputValue()).toBe('人工编写的合成回复，不需要模型。');
      await page.getByRole("button", { name: "保存草稿", exact: true }).click();
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
      expect(store.event(comment).status).toBe("AWAITING_DRAFT");
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
      await browser.close();
      await server.close();
      await service.close();
      store.close();
    }
  },
  60_000,
);
