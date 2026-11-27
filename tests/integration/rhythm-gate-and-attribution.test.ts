import { afterEach, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserService } from '../../src/app/browser-service.js';
import { AccountActor } from '../../src/browser/account-actor.js';
import { ClientService } from '../../src/app/service.js';
import { DeepSeekProvider } from '../../src/ai/deepseek.js';
import { runAutomaticReply } from '../../src/app/automatic-reply.js';
import { migrateClient } from '../../src/storage/client-migration.js';
import { migrateAutomation } from '../../src/storage/automation-migration.js';
import { AutomationStore } from '../../src/storage/automation-store.js';
import { EventStore } from '../../src/storage/store.js';
import { WorkbenchAuthority } from '../../src/app/authority.js';
import { digest, targetKey, type InboundEvent } from '../../src/core/contracts.js';
import type { ReplyPolicy } from '../../src/app/automation-contracts.js';
import {
  FaqSuggestionService,
  HandoffAttributionStore,
  PersistentRhythmGate,
} from '../../src/app/reply-pipeline/index.js';
import { installFixtureKey } from '../model-provider-helpers.js';
import { candidate, pending, privateTemp, snapshot } from '../helpers.js';

const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) {
    await fn();
  }
});

class RhythmTestBrowser extends BrowserService {
  private readonly queue = new AccountActor();
  clicks = 0;
  override get actor() {
    return this.queue;
  }
  override identity() {
    return {
      identityDigest: digest('own-1'),
      mappingDigest: 'synthetic',
      browserVersion: '1.0.0.0',
      browserMode: 'headed' as const,
    };
  }
  override async refreshIdentity() {
    return this.identity();
  }
  override async close() {}
  override async adapter(e: InboundEvent) {
    let text = '';
    return {
      dispose: () => {},
      adapter: {
        inspect: async () => snapshot(e),
        prepare: async (_e: InboundEvent, t: string) => {
          text = t;
        },
        verifyPrepared: async () => snapshot(e),
        baseline: async () => [],
        clickOnce: async () => {
          this.clicks++;
        },
        readback: async () => ({
          id: randomUUID(),
          ownId: 'own-1',
          targetKey: targetKey(e),
          text,
          pending: false,
          sentAt: new Date().toISOString(),
        }),
      },
    };
  }
}

describe('SQLite 持久化三档节流阀（跨重启生效）', () => {
  test('最小随机间隔、滑动窗口突发上限、撞限自动冷却在关闭并重开 SQLite 后依然生效，且不修改 automation_schema 版本', async () => {
    const root = privateTemp('rhythm-persist-');
    const dbFile = join(root, 'poc.sqlite');
    let now = Date.parse('2026-11-12T08:00:00Z');
    let store = new EventStore(dbFile, true, () => new Date(now).toISOString());
    cleanups.push(() => {
      try {
        store.close();
      } catch {
        /* already closed */
      }
      rmSync(root, { recursive: true, force: true });
    });
    await migrateClient(store, join(root, 'client.sqlite'));
    await migrateAutomation(store, join(root, 'automation.sqlite'));
    store.bindAccount('own-1');

    const config = {
      profile: 'calm' as const,
      overrides: {
        minIntervalMs: 5_000,
        maxIntervalMs: 9_000,
        burstWindowMs: 60_000,
        burstMaxActions: 2,
        cooloffMs: 30_000,
      },
    };

    // 确定性 RNG = 0.5 -> 区间 [5000, 9000] 取 5000 + floor(0.5 * 4001) = 7000ms
    const gate1 = new PersistentRhythmGate(store.db, { now: () => now, rng: () => 0.5 });
    expect(gate1.evaluateOrTriggerCooloff('account_001', config).allowed).toBe(true);
    gate1.recordAction('account_001', config);

    // 1. 间隔未到（+3s < 7s）被拦截
    now += 3_000;
    const waitDecision = gate1.evaluateOrTriggerCooloff('account_001', config);
    expect(waitDecision.allowed).toBe(false);
    expect(waitDecision.reasonCode).toBe('RHYTHM_MIN_INTERVAL_WAIT');
    expect(waitDecision.retryAfterMs).toBe(4_000);

    // 2. 间隔到达（+7s）放行第 2 笔写动作，同时触发突发上限 2 -> 立即写入 30s 冷却
    now += 4_000;
    expect(gate1.evaluateOrTriggerCooloff('account_001', config).allowed).toBe(true);
    const snap = gate1.recordAction('account_001', config);
    expect(snap?.cooloffUntil).toBe(now + 30_000);
    expect(snap?.cooloffHits).toBe(1);

    // 3. 模拟进程重启：完全关闭并重新打开 SQLite 文件
    store.close();
    store = new EventStore(dbFile, false, () => new Date(now).toISOString());
    const gateAfterRestart = new PersistentRhythmGate(store.db, { now: () => now, rng: () => 0.5 });

    // 重启后仍在冷却期（+10s < 30s）-> 持续拦截
    now += 10_000;
    const cooloffDecision = gateAfterRestart.evaluateOrTriggerCooloff('account_001', config);
    expect(cooloffDecision.allowed).toBe(false);
    expect(cooloffDecision.reasonCode).toBe('RHYTHM_COOLOFF_ACTIVE');
    expect(cooloffDecision.retryAfterMs).toBe(20_000);
    expect(cooloffDecision.windowCount).toBe(2);

    // 超过突发窗口（+65s）后冷却与旧窗口均过期 -> 恢复放行
    now += 65_000;
    expect(gateAfterRestart.evaluateOrTriggerCooloff('account_001', config).allowed).toBe(true);

    // 严守不修改 automation_schema 版本号（仍为 3）
    expect(store.db.prepare('SELECT version FROM automation_schema').get()).toEqual({ version: 3 });
  });
});

describe('转人工归因统计与在线 8 阶段流水线零扣费拦截', () => {
  test('入站敏感词在预算预占前拦截（0 模型调用、0 扣费），出站死循环拦截，并落库统计归因分布', async () => {
    const root = privateTemp('pipeline-e2e-');
    const dbFile = join(root, 'poc.sqlite');
    const store = new EventStore(dbFile, true, () => '2026-11-12T00:00:00Z');
    let service: ClientService | undefined;
    cleanups.push(async () => {
      await service?.close();
      try {
        store.close();
      } catch {
        /* already closed */
      }
      rmSync(root, { recursive: true, force: true });
    });
    await migrateClient(store, join(root, 'client.sqlite'));
    store.bindAccount('own-1');

    let modelCalls = 0;
    const replies = [
      '您好，这款目前有现货，下单后 48 小时内发出。',
      // 第二次仅改动标点与语气符，模拟绕过底层全等比对的同句复读
      '您好！这款目前有现货，下单后 48 小时内发出~',
    ];
    const provider = new DeepSeekProvider(async () => {
      const content = replies[Math.min(modelCalls, replies.length - 1)]!;
      modelCalls++;
      return new Response(
        JSON.stringify({
          model: 'deepseek-flash',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
          usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
        }),
      );
    });

    const browser = new RhythmTestBrowser(root);
    service = new ClientService(store, browser, provider);
    await service.loadSettings();
    const token = service.authority.issueSession();
    await installFixtureKey(service, token, { key: 'synthetic-contract-key' });

    const policy: ReplyPolicy = {
      ownId: 'own-1',
      channels: ['DIRECT_MESSAGE'],
      model: 'deepseek-flash',
      modelLimit: 10,
      sendLimit: 10,
      expiresAt: null,
      workIds: [],
      futureOwnWorks: false,
      conversationIds: ['conversation-1'],
      entireInbox: true,
      containsAny: [],
      excludesAny: [],
      instructions: '简洁回复',
      startHour: 0,
      endHour: 24,
    };
    await service.dispatch(token, { command: 'setReplyPolicy', policy, confirmed: true });
    await service.dispatch(token, { command: 'setMode', mode: 'LIMITED_AUTO' });

    // 1. 入站导流敏感词 -> 前置零扣费转人工（独立会话，不污染后续正常会话历史）
    const sensitiveId = pending(
      store,
      candidate({
        conversationId: 'conversation-sensitive',
        platformEventId: 'dm-divert-1',
        text: '方便加我微信 abc9988 私下转账吗',
        occurredAt: '2026-11-12T01:00:00Z',
      }),
    );
    await service.runAutomaticReply();
    expect(modelCalls).toBe(0);
    expect(browser.clicks).toBe(0);
    expect(store.budget('MODEL').used).toBe(0);
    expect(store.budget('SEND').used).toBe(0);
    expect(store.db.prepare('SELECT state, reason FROM automation_jobs WHERE event_id=?').get(sensitiveId)).toEqual({
      state: 'REVIEW',
      reason: 'PLATFORM_REDLINE_WORD',
    });

    // 2. 第一条正常消息 -> 正常走 SendCoordinator 单次提交成功
    const normal1 = pending(
      store,
      candidate({
        conversationId: 'conversation-1',
        platformEventId: 'dm-ok-1',
        text: '请问这款有现货吗',
        occurredAt: '2026-11-12T01:01:00Z',
      }),
    );
    await service.runAutomaticReply();
    expect(modelCalls).toBe(1);
    expect(browser.clicks).toBe(1);
    expect(store.event(normal1).status).toBe('CONFIRMED');

    // 3. 同一客户冷却期内再次发来消息，模型试图回复完全相同的话术 -> 阶段 8 死循环保护拦截，禁止二次发送
    const normal2 = store.observe(
      'DIRECT_MESSAGE',
      'conversation-1',
      [
        candidate({
          platformEventId: 'dm-ok-2',
          text: '再问一下有现货吗',
          occurredAt: '2026-11-12T01:02:00Z',
        }),
      ],
      'own-1',
      'fixture',
      '2026-11-12T01:02:01Z',
    )[0]!;
    await service.runAutomaticReply();
    expect(modelCalls).toBe(2);
    expect(browser.clicks).toBe(1); // 绝不二次点击发送
    expect(store.db.prepare('SELECT state, reason FROM automation_jobs WHERE event_id=?').get(normal2)).toEqual({
      state: 'REVIEW',
      reason: 'LOOP_BREAKER_HANDOFF',
    });

    // 4. 查询归因分布统计
    const attrStore = new HandoffAttributionStore(store.db);
    // 补充两条不同原因以验证百分比分布汇总
    attrStore.record({
      accountId: 'account_001',
      channel: 'DIRECT_MESSAGE',
      eventId: 'evt-kmiss',
      stage: 'handoff_rules_and_knowledge',
      reasonCode: 'KNOWLEDGE_MISS_HANDOFF',
      createdAt: Date.now(),
    });
    attrStore.record({
      accountId: 'account_001',
      channel: 'DIRECT_MESSAGE',
      eventId: 'evt-media',
      stage: 'handoff_rules_and_knowledge',
      reasonCode: 'MEDIA_MESSAGE_HANDOFF',
      createdAt: Date.now(),
    });

    const summary = attrStore.querySummary({ accountId: 'account_001' });
    expect(summary.total).toBe(4);
    expect(summary.byCategory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'SENSITIVE_WORD', count: 1, percentage: 25 }),
        expect.objectContaining({ key: 'LOOP_BREAKER', count: 1, percentage: 25 }),
        expect.objectContaining({ key: 'KNOWLEDGE_MISS', count: 1, percentage: 25 }),
        expect.objectContaining({ key: 'MEDIA_MESSAGE', count: 1, percentage: 25 }),
      ]),
    );
  });

  test('通过显式配置在 runAutomaticReply 中启用碎片聚合：窗口未到 defer，到期合并仅单次提交', async () => {
    const root = privateTemp('pipeline-debounce-');
    const dbFile = join(root, 'poc.sqlite');
    let now = Date.parse('2026-11-12T09:00:13Z');
    const store = new EventStore(dbFile, true, () => '2026-11-12T08:00:00Z');
    let service: ClientService | undefined;
    cleanups.push(async () => {
      await service?.close();
      try {
        store.close();
      } catch {
        /* already closed */
      }
      rmSync(root, { recursive: true, force: true });
    });
    await migrateClient(store, join(root, 'client.sqlite'));
    store.bindAccount('own-1');
    let modelCalls = 0;
    const provider = new DeepSeekProvider(async () => {
      modelCalls++;
      return new Response(
        JSON.stringify({
          model: 'deepseek-flash',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '您好，卫衣M码目前现货充足。' } }],
          usage: { prompt_tokens: 4, completion_tokens: 8, total_tokens: 12 },
        }),
      );
    });
    const browser = new RhythmTestBrowser(root);
    service = new ClientService(store, browser, provider, () => now, Date.parse('2026-11-12T08:50:00Z'));
    await service.loadSettings();
    const token = service.authority.issueSession();
    await installFixtureKey(service, token, { key: 'synthetic-contract-key' });
    await service.dispatch(token, {
      command: 'setReplyPolicy',
      policy: {
        ownId: 'own-1',
        channels: ['DIRECT_MESSAGE'],
        model: 'deepseek-flash',
        modelLimit: 5,
        sendLimit: 5,
        expiresAt: null,
        workIds: [],
        futureOwnWorks: false,
        conversationIds: ['conversation-1'],
        entireInbox: true,
        containsAny: [],
        excludesAny: [],
        instructions: '简洁回复',
        startHour: 0,
        endHour: 24,
      },
      confirmed: true,
    });
    await service.dispatch(token, { command: 'setMode', mode: 'LIMITED_AUTO' });

    const id1 = pending(
      store,
      candidate({ platformEventId: 'deb-1', text: '请问在吗', occurredAt: '2026-11-12T09:00:10Z' }),
    );
    const id2 = store.observe(
      'DIRECT_MESSAGE',
      'conversation-1',
      [candidate({ platformEventId: 'deb-2', text: '黑色卫衣M码有货吗', occurredAt: '2026-11-12T09:00:12Z' })],
      'own-1',
      'fixture',
      '2026-11-12T09:00:12.500Z',
    )[0]!;

    const automation = new AutomationStore(store, () => now);
    const models = (service as unknown as { models: NonNullable<Parameters<typeof runAutomaticReply>[0]['models']> }).models;
    const humanReplies = (service as unknown as { humanReplies: Parameters<typeof runAutomaticReply>[0]['humanReplies'] }).humanReplies;
    const baseCtx: Parameters<typeof runAutomaticReply>[0] = {
      store,
      authority: service.authority,
      automation,
      browser: service.browser,
      models,
      provider,
      humanReplies,
      settings: { model: 'deepseek-flash', persona: '客服', business: '服装店', rules: '简洁回复' },
      modelPending: new Set<string>(),
      automaticSignal: new AbortController().signal,
      modelSignal: new AbortController().signal,
      isClosing: () => false,
      updated: () => {},
      stop: () => {},
      beforeWork: () => {},
      statusUpdated: () => {},
      errorCode: (e) => (e instanceof Error ? e.message : 'UNKNOWN'),
      pipelineConfig: { debounce: { enabled: true, windowMs: 3000 } },
    };

    // 当前 09:00:13，距最后一条 09:00:12 仅 1s < 3s -> 静默等待 defer，零调用、零写库
    await runAutomaticReply(baseCtx);
    expect(modelCalls).toBe(0);
    expect(browser.clicks).toBe(0);
    expect(store.db.prepare('SELECT count(*) AS n FROM automation_jobs').get()).toEqual({ n: 0 });

    // 推进到 09:00:16（距最后一条已 4s >= 3s）-> 合并两条碎片，仅对锚点 id2 单次提交！
    now = Date.parse('2026-11-12T09:00:16Z');
    await runAutomaticReply(baseCtx);
    expect(modelCalls).toBe(1);
    expect(browser.clicks).toBe(1);
    expect(store.event(id2).status).toBe('CONFIRMED');
    expect(store.db.prepare('SELECT state, reason FROM automation_jobs WHERE event_id=?').get(id1)).toEqual({
      state: 'MERGED',
      reason: 'DEBOUNCE_MERGED_INTO_ANCHOR',
    });
    expect(store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({ n: 1 });
  });
});

describe('离线人工对话自动提炼候选 FAQ 服务（faq-suggestions）', () => {
  test('仅从已确认人工回复聚类提炼并脱敏隐私，排除未确认/自动回复，支持采纳转草稿与丢弃去重', async () => {
    const root = privateTemp('faq-suggestions-');
    const dbFile = join(root, 'poc.sqlite');
    const store = new EventStore(dbFile, true, () => '2026-11-12T00:00:00Z');
    cleanups.push(() => {
      try {
        store.close();
      } catch {
        /* already closed */
      }
      rmSync(root, { recursive: true, force: true });
    });
    await migrateClient(store, join(root, 'client.sqlite'));
    await migrateAutomation(store, join(root, 'automation.sqlite'));
    store.bindAccount('own-1');
    const authority = new WorkbenchAuthority(store);
    const token = authority.issueSession();

    const createConfirmedReply = (
      platformEventId: string,
      conversationId: string,
      question: string,
      answer: string,
      origin: 'HUMAN_TYPED' | 'AUTO_POLICY',
      confirmStatus: 'CONFIRMED' | 'UNCERTAIN',
    ) => {
      const eventId = pending(
        store,
        candidate({
          platformEventId,
          conversationId,
          text: question,
          occurredAt: '2026-11-12T03:00:00Z',
        }),
      );
      const event = store.event(eventId);
      const draftId = randomUUID();
      store.db.prepare("INSERT INTO reply_drafts VALUES(?,?,?,?,1,'DRAFT',NULL,NULL)").run(draftId, eventId, answer, origin);
      store.db.prepare('INSERT INTO draft_revisions VALUES(?,1,?,?,?,?)').run(draftId, origin, answer, 'op-1', Date.now());
      store.db.prepare("UPDATE inbound_events SET status='AWAITING_APPROVAL' WHERE id=?").run(eventId);
      store.approve(draftId, snapshot(event.payload), 1, answer);
      const intentId = store.recordIntent(draftId, snapshot(event.payload), false, {
        check: () => {},
        committed: () => {},
      });
      store.receipt(intentId, confirmStatus, 'synthetic-proof');
      return eventId;
    };

    // 3 条相似的已确认人工回复（含手机号与订单号，验证脱敏）
    createConfirmedReply(
      'h-1',
      'conv-1',
      '您好请问发货时间是多久？我手机号 13812345678',
      '亲，下单后 48 小时内发货，顺丰包邮，查询请留单号 20261112000123。',
      'HUMAN_TYPED',
      'CONFIRMED',
    );
    createConfirmedReply(
      'h-2',
      'conv-2',
      '下单后发货时间一般几天到？邮箱 test@example.com',
      '亲，下单后 48 小时内发货，顺丰包邮，查询请留单号 20261112000124。',
      'HUMAN_TYPED',
      'CONFIRMED',
    );
    // 1 条未确认（UNCERTAIN）记录 -> 必须排除
    createConfirmedReply(
      'u-1',
      'conv-3',
      '你们门店营业时间几点开门',
      '早上9点开门',
      'HUMAN_TYPED',
      'UNCERTAIN',
    );
    // 2 条纯自动回复（AUTO_POLICY）记录 -> 必须排除
    createConfirmedReply(
      'a-1',
      'conv-4',
      '有发票可以开吗',
      '支持开电子发票',
      'AUTO_POLICY',
      'CONFIRMED',
    );
    createConfirmedReply(
      'a-2',
      'conv-5',
      '怎么开电子发票',
      '支持开电子发票',
      'AUTO_POLICY',
      'CONFIRMED',
    );
    // 2 条另一个主题的已确认人工回复 -> 测试丢弃后不复活
    createConfirmedReply(
      'h-wash-1',
      'conv-6',
      '这件羊毛衫可以机洗吗会缩水吗',
      '建议干洗或冷水手洗平铺晾干，避免机洗缩水。',
      'HUMAN_TYPED',
      'CONFIRMED',
    );
    createConfirmedReply(
      'h-wash-2',
      'conv-7',
      '羊毛衫洗涤方式能机洗吗',
      '建议干洗或冷水手洗平铺晾干，避免机洗缩水。',
      'HUMAN_TYPED',
      'CONFIRMED',
    );

    const faqService = new FaqSuggestionService(store);
    const suggestions = faqService.generateSuggestions({ minClusterSize: 2 });

    expect(suggestions).toHaveLength(2);
    const shipping = suggestions.find((item) => item.question.includes('发货时间'));
    expect(shipping).toBeDefined();
    expect(shipping!.sampleCount).toBe(2);
    // 隐私脱敏校验：绝不含原始手机号、邮箱、长订单号
    expect(shipping!.question).not.toContain('13812345678');
    expect(shipping!.question).not.toContain('test@example.com');
    expect(shipping!.suggestedAnswer).not.toContain('20261112000123');
    expect(shipping!.suggestedAnswer).toContain('[编号]');

    // 采纳 -> 转为符合 KnowledgeInput 的知识库草稿
    const adopted = faqService.adoptSuggestion(shipping!.id, { topic: '物流发货' });
    expect(adopted.suggestion.status).toBe('ADOPTED');
    expect(adopted.knowledgeDraft).toMatchObject({
      topic: '物流发货',
      channels: ['DIRECT_MESSAGE'],
    });
    expect(adopted.knowledgeDraft.title.length).toBeGreaterThan(0);
    expect(adopted.knowledgeDraft.text).toContain('48 小时内发货');

    // 丢弃另一条建议 -> 再次提炼不再重复复活
    const wash = suggestions.find((item) => item.question.includes('羊毛衫'));
    expect(wash).toBeDefined();
    const dismissed = faqService.dismissSuggestion(wash!.id);
    expect(dismissed.status).toBe('DISMISSED');

    const regenerated = faqService.generateSuggestions({ minClusterSize: 2 });
    expect(regenerated).toHaveLength(0);
    expect(faqService.listSuggestions('PENDING')).toHaveLength(0);
    expect(faqService.listSuggestions('ADOPTED')).toHaveLength(1);
    expect(faqService.listSuggestions('DISMISSED')).toHaveLength(1);
    authority.revoke(token);
  });
});
