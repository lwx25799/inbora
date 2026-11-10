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
import type {InboxSync} from '../../src/app/contracts.js';
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
    const syncCalls:string[]=[];let releaseSyncRead:(()=>void)|undefined,holdSyncRead=true;
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
      override async observe(_store:typeof store,source:'works'|'dm'|'notifications'){
        syncCalls.push(source);if(holdSyncRead)await new Promise<void>(resolve=>{releaseSyncRead=resolve;});
        if(source==='works')pending(store,candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',conversationId:null,
          platformEventId:'ui-synced-comment',videoId:'ui-sync-work',commentId:'ui-sync-parent',actorName:'同步新增评论',text:'评论读取完成后可立即查看的合成任务',occurredAt:'2026-11-04T01:00:10Z'}));
        if(source==='dm')pending(store,candidate({platformEventId:'ui-synced-event',conversationId:'ui-synced-conversation',actorName:'同步新增任务',text:'同步后应自动出现的合成任务',occurredAt:'2026-11-04T01:00:10Z'}));
      }
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
    const service = new ClientService(store, new UiBrowser(root));
    await service.loadSettings();
    const token = service.authority.issueSession();
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
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    let releaseSave: (() => void) | undefined;
    let saveEntered: (() => void) | undefined;
    let holdSave = false;
    const controlTrace: { command: string; paused: boolean; eventId?:string|undefined; generation?: number; isMine?: boolean }[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    service.events.on('update',event=>{void page.evaluate(event=>{
      (window as unknown as {fixtureEmit?:(event:unknown)=>void}).fixtureEmit?.(event);
    },event).catch(()=>{});});
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
          controlTrace.push({ command: body.command, eventId:body.eventId, paused: service.authority.paused(),
            ...(ownership ? { generation: ownership.generation, isMine: ownership.isMine } : {}) });
          return result;
        },
      );
      await page.addInitScript(() => {
        const callbacks=new Map<number,(event:unknown)=>void>(),listeners=new Map<number,{event:string;handler:number}>();let next=0;
        const fixture=window as unknown as {fixtureEmit:(event:unknown)=>void;__TAURI_EVENT_PLUGIN_INTERNALS__:unknown};
        fixture.fixtureEmit=payload=>{for(const [id,listener]of listeners)if(listener.event==='inbora_status_updated')
          callbacks.get(listener.handler)?.({event:listener.event,id,payload});};
        fixture.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:(_event:string,id:number)=>{
          const listener=listeners.get(id);if(listener)callbacks.delete(listener.handler);listeners.delete(id);
        }};
        (
          window as unknown as { __TAURI_INTERNALS__: unknown }
        ).__TAURI_INTERNALS__ = {
          transformCallback:(callback:(event:unknown)=>void)=>{callbacks.set(++next,callback);return next;},
          invoke: async (command: string, args: unknown) => {
            const eventArgs=args as {event:string;handler:number};
            if(command==='plugin:event|listen'){const id=++next;listeners.set(id,eventArgs);return id;}
            if(command==='plugin:event|unlisten')return;
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
      await page.getByRole('heading',{name:'收件箱',exact:true}).waitFor();
      for(const name of ['全部','评论','私信'])expect(await page.getByRole('button',{name,exact:true}).count()).toBe(1);
      const dmRow=page.locator('.task[data-channel="DIRECT_MESSAGE"]').first(),commentRow=page.locator('.task[data-channel="COMMENT_NOTIFICATION"]').first();
      await dmRow.waitFor();await commentRow.waitFor();
      const dmTone=await dmRow.locator('.channel-label').evaluate(node=>getComputedStyle(node).color),
        commentTone=await commentRow.locator('.channel-label').evaluate(node=>getComputedStyle(node).color);
      expect(dmTone).not.toBe(commentTone);
      expect(await dmRow.evaluate(node=>getComputedStyle(node).backgroundColor)).not.toBe(await commentRow.evaluate(node=>getComputedStyle(node).backgroundColor));
      expect(await page.getByRole('combobox',{name:'任务状态'}).locator('option').allTextContents()).toEqual(['等待回复','已回复']);
      expect(await page.getByRole('button',{name:'同步私信',exact:true}).count()).toBe(0);
      expect(await page.getByRole('button',{name:'同步作品评论',exact:true}).count()).toBe(0);
      await page.getByRole('button',{name:'同步收件箱',exact:true}).click();
      await expect.poll(()=>syncCalls).toEqual(['works']);
      await expect.poll(()=>page.getByRole('button',{name:'正在同步评论…',exact:true}).isVisible(),{timeout:5000}).toBe(true);
      expect(await page.getByRole('button',{name:'正在同步评论…',exact:true}).isDisabled()).toBe(true);
      await page.getByRole('button',{name:'AI 与设置',exact:true}).click();
      await page.getByRole('heading',{name:'DeepSeek 辅助回复'}).waitFor();
      expect(await page.locator('details.fault-controls').evaluate(node=>(node as HTMLDetailsElement).open)).toBe(false);
      await page.getByText('故障处理',{exact:true}).click();
      expect(await page.getByRole('button',{name:'全局急停',exact:true}).isEnabled()).toBe(true);
      releaseSyncRead?.();await expect.poll(()=>syncCalls).toEqual(['works','dm']);
      await page.getByRole('button',{name:'收件箱',exact:true}).click();
      await page.getByRole('button',{name:/同步新增评论/}).waitFor();
      await page.reload();
      await expect.poll(()=>page.getByRole('button',{name:'正在同步私信…',exact:true}).isVisible(),{timeout:5000}).toBe(true);
      expect(await page.getByRole('button',{name:'正在同步私信…',exact:true}).isDisabled()).toBe(true);
      expect(syncCalls).toEqual(['works','dm']); // Reconnecting the renderer must not start another read.
      releaseSyncRead?.();
      await expect.poll(()=>page.getByRole('button',{name:'同步收件箱',exact:true}).isEnabled(),{timeout:5000}).toBe(true);
      await page.getByText('评论本轮同步完成；私信本轮同步完成',{exact:true}).waitFor();
      await page.getByRole('button',{name:/同步新增任务/}).waitFor();
      expect(syncCalls).toEqual(['works','dm']);expect(clicks).toBe(0);
      const syncState=(service as unknown as {sync:InboxSync}).sync,savedDmResult=syncState.results[1]!;
      syncState.results[1]={source:'dm',state:'DEFERRED',error:'OBSERVATION_DM_CONTENT_DOM_NOT_READY'};
      service.events.emit('update',{event:'inbox_sync_updated'});
      const syncProgress=page.getByTestId('inbox-sync-progress');
      await expect.poll(()=>syncProgress.innerText()).toContain('私信后台继续收取');
      expect(await syncProgress.getAttribute('role')).toBe('status');
      expect(await syncProgress.innerText()).not.toContain('私信同步失败');
      expect(await page.getByRole('button',{name:'同步收件箱',exact:true}).isEnabled()).toBe(true);
      syncState.results[1]=savedDmResult;service.events.emit('update',{event:'inbox_sync_updated'});
      await page.getByRole("button", { name: /合成私信作者/ }).click();
      const dialog=page.getByRole('dialog',{name:'人工回复对话框'}),editor=page.getByRole('textbox',{name:'人工回复草稿'});
      await editor.waitFor();
      expect(await page.locator('.chat-heading h2').evaluate(node=>getComputedStyle(node).color)).toBe(dmTone);
      expect(await dialog.getByRole('button',{name:'人工接管',exact:true}).count()).toBe(0);
      expect(await dialog.getByRole('button',{name:'保存草稿',exact:true}).count()).toBe(0);
      holdSave=true;
      const entered=new Promise<void>(resolve=>{saveEntered=resolve;});
      await editor.fill('自动保存旧文字');await entered;
      await editor.fill('保存期间继续输入的新文字');releaseSave!();
      await expect.poll(()=>service.authority.draftFor(dm)?.text).toBe('保存期间继续输入的新文字');
      expect(await dialog.getByRole('button',{name:'全局急停',exact:true}).count()).toBe(0);
      await service.dispatch(token,{command:'emergencyStop'});
      await expect.poll(()=>service.authority.paused()).toBe(true);
      await expect.poll(()=>service.authority.ownership(store.event(dm)).operator_id,{timeout:5000}).toBe(null);
      await expect.poll(()=>controlTrace.filter(item=>item.command==='getThread').at(-1)?.isMine,{timeout:5000}).toBe(false);
      expect(await editor.inputValue()).toBe('保存期间继续输入的新文字');
      await editor.fill('暂停期间保留的完整人稿');
      await expect.poll(()=>controlTrace.filter(item=>item.command==='openHumanDialog').at(-1)?.isMine).toBe(true);
      await expect.poll(()=>service.authority.draftFor(dm)?.text).toBe('暂停期间保留的完整人稿');
      await page.getByRole('button',{name:'AI 与设置',exact:true}).click();
      await page.getByText('故障处理',{exact:true}).click();
      await page.getByRole('button',{name:'恢复运行',exact:true}).click();
      await expect.poll(()=>service.authority.paused()).toBe(false);
      await page.getByRole('button',{name:'收件箱',exact:true}).click();
      await page.getByRole('button',{name:/合成评论作者/}).click();
      await page.getByRole('heading',{name:'合成评论作者',exact:true}).waitFor();
      expect(await page.locator('.detail-heading h2').evaluate(node=>getComputedStyle(node).color)).toBe(commentTone);
      expect(await page.locator('section.detail > details.identity').evaluate(node=>(node as HTMLDetailsElement).open)).toBe(false);
      await page.getByText('消息信息',{exact:true}).click();
      await page.getByRole('button',{name:'打开人工回复',exact:true}).click();
      await expect.poll(()=>dialog.locator('.editor-title').innerText()).toContain('历史草稿');
      expect(await editor.inputValue()).toBe(legacyDraft.text);
      await dialog.getByRole('button',{name:'关闭并保留草稿',exact:true}).click();
      await page.getByRole('button',{name:/合成私信作者/}).click();
      await expect.poll(()=>editor.inputValue()).toBe('暂停期间保留的完整人稿');
      await editor.fill('人工单击绑定最新全文，无需模型。');
      await page.getByRole('button',{name:'发送',exact:true}).click();
      await service.drain();await expect.poll(()=>store.event(dm).status).toBe('CONFIRMED');
      await expect.poll(()=>page.getByTestId('reply-send-result').textContent()).toContain('已回复');
      expect(clicks).toBe(1);
      const followup=pending(store,candidate({platformEventId:'ui-dm-after-confirmed',actorName:'合成私信作者',
        text:'已经回复后同会话新增入站',occurredAt:'2026-11-04T01:00:20Z'}));
      await page.getByRole('button',{name:'重新连接内核',exact:true}).click();
      await expect.poll(()=>controlTrace.filter(item=>item.command==='openHumanDialog').at(-1)?.isMine).toBe(true);
      await expect.poll(()=>page.getByRole('textbox',{name:'人工回复草稿'}).inputValue()).toBe('');
      await expect.poll(()=>controlTrace.filter(item=>item.command==='openHumanDialog').at(-1)?.eventId).toBe(followup);
      expect(service.authority.draftFor(followup)).toBeNull();expect(store.event(dm).status).toBe('CONFIRMED');expect(clicks).toBe(1);
      expect(await page.getByRole('region',{name:'逐条发送确认'}).count()).toBe(0);
      const output=resolve('.local/desktop-ui');await mkdir(output,{recursive:true});
      await page.screenshot({path:join(output,`dialog-${viewport.width}x${viewport.height}.png`)});
      await page.getByRole('button',{name:/合成评论作者/}).click();
      await page.getByRole('heading',{name:'合成评论作者',exact:true}).waitFor();
      const targetInfo=page.locator('section.detail > details.identity');
      expect(await targetInfo.evaluate(node=>({open:(node as HTMLDetailsElement).open,summary:node.querySelector('summary')?.textContent}))).toEqual({open:false,summary:'消息信息'});
      await page.getByText('消息信息',{exact:true}).click();
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
      await page.getByText('已选择纯人工回复；正在自动连接账号，连接后即可继续。',{exact:true}).waitFor();
      expect(await page.getByRole('button',{name:'暂停发送',exact:true}).count()).toBe(0);
      expect(await page.getByRole('button',{name:'关闭浏览器',exact:true}).count()).toBe(0);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth||document.documentElement.scrollHeight>innerHeight)).toBe(false);
      await page.screenshot({path:join(output,`mode-${viewport.width}x${viewport.height}.png`)});
      await page.getByRole('combobox',{name:'工作模式',exact:true}).selectOption('OBSERVE');
      await expect.poll(()=>service.authority.mode()).toBe('OBSERVE');
      await page.getByRole('combobox',{name:'工作模式',exact:true}).selectOption('MANUAL');
      await expect.poll(()=>page.getByRole('combobox',{name:'工作模式',exact:true}).inputValue()).toBe('MANUAL');
      expect(await service.dispatch(token,{command:'getStatus'})).toMatchObject({mode:'DRAFT_ONLY',configuredMode:'MANUAL'});
      identityAvailable=true;
      await page.getByRole('button',{name:'重新连接内核',exact:true}).click();
      await page.getByText('连接详情',{exact:true}).click();
      for(const state of ['READ_OK','SEND_REVIEW_ONLY','BLOCKED','SEND_AVAILABLE'] as const){
        service.authority.attest('COMMENT_NOTIFICATION',state,service.browser.identity('COMMENT_NOTIFICATION')!,'synthetic-capability-state');
        await page.getByRole('button',{name:'重新连接内核',exact:true}).click();
        const capability=page.locator('dl > div').filter({has:page.getByText('评论能力',{exact:true})});
        const labels={READ_OK:'已验证读取',SEND_REVIEW_ONLY:'发送待验证',BLOCKED:'通道已阻断',SEND_AVAILABLE:'发送已开通'};
        await expect.poll(()=>capability.textContent()).toContain(labels[state]);
        expect(await capability.textContent()).not.toContain('此通道当前禁止发送');
      }
      identityAvailable=false;
      await page.getByRole('button',{name:'重新连接内核',exact:true}).click();
      await expect.poll(()=>page.locator('dl > div').filter({has:page.getByText('评论能力',{exact:true})}).textContent()).toContain('请先打开专属浏览器并同步此通道');
      identityAvailable=true;
      await page.getByRole('button',{name:'重新连接内核',exact:true}).click();
      await service.dispatch(token,{command:'pause',eventId:null});
      await page.getByRole('spinbutton',{name:'本次持续授权的模型次数',exact:true}).fill('2');
      await page.getByRole('spinbutton',{name:'本次持续授权的发送次数',exact:true}).fill('2');
      await page.getByRole('textbox',{name:'允许回复的作品原生 ID（逗号或换行分隔）',exact:true}).fill('ui-sync-work');
      await page.getByRole('textbox',{name:'允许回复的私信原生会话 ID',exact:true}).fill('conversation-1');
      await page.getByRole('textbox',{name:'屏蔽词（命中后不自动回复）',exact:true}).fill('NEVER-FIXTURE-MATCH');
      await page.getByRole('textbox',{name:'自动回复规则',exact:true}).fill('Only answer the specified synthetic marker.');
      expect(await page.getByRole('checkbox',{name:/我确认当前本人账号、所选通道、模型/}).count()).toBe(0);
      await page.getByRole('button',{name:'按此范围启用规则自动回复',exact:true}).click();
      await expect.poll(()=>service.authority.mode()).toBe('LIMITED_AUTO');
      await expect.poll(()=>service.authority.paused()).toBe(false);
      await page.getByText(/自动回复（含模型调用）：策略版本/).waitFor();
      const authorized=await service.dispatch(token,{command:'getStatus'}) as {automation:{replyPolicy:{scope:{modelLimit:number;sendLimit:number;containsAny:string[]}}}};
      expect(authorized.automation.replyPolicy.scope).toMatchObject({modelLimit:2,sendLimit:2,containsAny:[],excludesAny:['NEVER-FIXTURE-MATCH']});
      await page.getByRole('switch',{name:'自动回复',exact:true}).click();
      await expect.poll(()=>service.authority.mode()).toBe('MANUAL');
      await expect.poll(()=>page.getByRole('switch',{name:'自动回复',exact:true}).isChecked()).toBe(false);
      await page.getByRole('switch',{name:'自动回复',exact:true}).click();
      await expect.poll(()=>service.authority.mode()).toBe('LIMITED_AUTO');
      expect(store.db.prepare('SELECT count(*) AS n FROM model_calls').get()).toEqual({n:0});
      await page.getByRole('button',{name:'撤销自动回复策略',exact:true}).click();
      await expect.poll(async()=>((await service.dispatch(token,{command:'getStatus'})) as {automation:{replyPolicy:unknown}}).automation.replyPolicy).toBe(null);
      await page.getByRole('combobox',{name:'工作模式',exact:true}).selectOption('MANUAL');
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
      await page.getByText('故障处理',{exact:true}).click();
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
      await page.getByRole('button',{name:/合成评论作者/}).click();
      await page.getByRole('button',{name:'打开人工回复',exact:true}).click();
      await editor.fill('重连后继续保留的人稿');
      await dialog.getByRole('button',{name:'关闭并保留草稿',exact:true}).click();
      await page.getByRole('button',{name:'重新连接内核',exact:true}).click();
      await page.getByRole('button',{name:'打开人工回复',exact:true}).click();
      await expect.poll(()=>editor.inputValue()).toBe('重连后继续保留的人稿');
      await dialog.getByRole('button',{name:'关闭并保留草稿',exact:true}).click();
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
      holdSyncRead=false;releaseSyncRead?.();
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
