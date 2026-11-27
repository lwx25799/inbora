import { afterEach, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DeepSeekProvider } from '../../src/ai/deepseek.js';
import { BrowserService } from '../../src/app/browser-service.js';
import { ClientService } from '../../src/app/service.js';
import { isReadOnlySidecarCommand } from '../../src/app/service-guards.js';
import { AccountActor } from '../../src/browser/account-actor.js';
import { isMutatingClientCommand } from '../../src/contracts/protocol-v2.js';
import {
  DEFAULT_REPLY_PIPELINE_PERSISTED_CONFIG,
  type ReplyPipelinePersistedConfig,
  type ReplyPipelineStatusView,
} from '../../src/contracts/reply-pipeline.js';
import { digest, targetKey, type InboundEvent } from '../../src/core/contracts.js';
import type { KnowledgeEntry } from '../../src/knowledge/contracts.js';
import { migrateReplyKnowledge } from '../../src/knowledge/migration.js';
import { ReplyKnowledgeStore } from '../../src/knowledge/store.js';
import { migrateClient } from '../../src/storage/client-migration.js';
import { EventStore } from '../../src/storage/store.js';
import type { FaqSuggestion, PipelineTrace } from '../../src/app/reply-pipeline/index.js';
import { installFixtureKey } from '../model-provider-helpers.js';
import { candidate, pending, privateTemp, snapshot } from '../helpers.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) {
    await fn();
  }
});

class PipelineCommandTestBrowser extends BrowserService {
  private readonly queue = new AccountActor();
  clicks = 0;
  lastSentText = '';
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
          this.lastSentText = text;
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

function tableExists(store: EventStore, name: string): boolean {
  return Boolean(
    store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name),
  );
}

describe('replyPipeline & FAQ suggestion commands integration', () => {
  test('getConfig is strictly read-only when absent; saveConfig persists across reopen and syncs rhythm + live auto-reply', async () => {
    const root = privateTemp('pipeline-cmd-persist-');
    const dbFile = join(root, 'poc.sqlite');
    let now = Date.parse('2026-11-15T08:00:00Z');
    let store = new EventStore(dbFile, true, () => new Date(now).toISOString());
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
    await migrateReplyKnowledge(store, join(root, 'knowledge.sqlite'));
    store.bindAccount('own-1');

    let modelCalls = 0;
    const provider = new DeepSeekProvider(async () => {
      modelCalls++;
      return new Response(
        JSON.stringify({
          model: 'deepseek-flash',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '模型回复' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });

    const browser = new PipelineCommandTestBrowser(root);
    service = new ClientService(store, browser, provider, () => now, now);
    await service.loadSettings();
    const token = service.authority.issueSession();

    expect(isMutatingClientCommand({ command: 'replyPipeline', action: 'getConfig' })).toBe(false);
    expect(isMutatingClientCommand({ command: 'replyPipeline', action: 'dryRun', eventId: randomUUID() })).toBe(false);
    expect(isMutatingClientCommand({
      command: 'replyPipeline',
      action: 'saveConfig',
      config: DEFAULT_REPLY_PIPELINE_PERSISTED_CONFIG,
    })).toBe(true);
    expect(isReadOnlySidecarCommand({ command: 'replyPipeline', action: 'getConfig' })).toBe(true);
    expect(isReadOnlySidecarCommand({ command: 'replyPipeline', action: 'dryRun', eventId: randomUUID() })).toBe(true);
    expect(isReadOnlySidecarCommand({ command: 'replyPipeline', action: 'saveConfig' })).toBe(false);

    // 1. getConfig before any save must NOT create lazy tables
    const initial = (await service.dispatch(token, {
      command: 'replyPipeline',
      action: 'getConfig',
    })) as ReplyPipelineStatusView;
    expect(initial.configured).toBe(false);
    expect(initial.config).toEqual(DEFAULT_REPLY_PIPELINE_PERSISTED_CONFIG);
    expect(initial.rhythmState).toBeNull();
    expect(initial.handoffSummary.total).toBe(0);
    expect(initial.updatedAt).toBeNull();
    expect(tableExists(store, 'reply_pipeline_settings')).toBe(false);
    expect(tableExists(store, 'rhythm_account_state')).toBe(false);
    expect(tableExists(store, 'handoff_attributions')).toBe(false);

    // 2. saveConfig persists and syncs PersistentRhythmGate without leaking raw sensitive words in audit
    const nextConfig: ReplyPipelinePersistedConfig = {
      rhythmProfile: 'calm',
      debounce: { enabled: true, windowMs: 3500 },
      sensitive: {
        customWords: ['secret-forbidden-word'],
        enablePlatformRedline: true,
        enablePromptInjectionGuard: true,
      },
      handoff: {
        mediaMessageHandoff: true,
        afterSalesHandoff: true,
        bargainHandoff: true,
        customTriggers: ['找人工经理'],
        knowledgeMissHandoff: false,
        knowledgeConflictHandoff: true,
        exactFaqDirectReply: true,
      },
      loopBreaker: { enabled: true },
    };

    const saved = (await service.dispatch(token, {
      command: 'replyPipeline',
      action: 'saveConfig',
      config: nextConfig,
    })) as ReplyPipelineStatusView;
    expect(saved.configured).toBe(true);
    expect(saved.config).toEqual(nextConfig);
    expect(saved.rhythmState?.profile).toBe('calm');
    expect(saved.updatedAt).toBe(now);

    const auditRow = store.db
      .prepare("SELECT detail_redacted FROM audit_events WHERE event_type='REPLY_PIPELINE_CONFIG_SAVED' ORDER BY rowid DESC LIMIT 1")
      .get() as { detail_redacted: string };
    expect(auditRow.detail_redacted).not.toContain('secret-forbidden-word');
    expect(auditRow.detail_redacted).not.toContain('找人工经理');

    // 3. Reopen DB + ClientService and verify persisted settings + live automatic reply behavior
    await service.close();
    store.close();

    now += 10_000;
    store = new EventStore(dbFile, false, () => new Date(now).toISOString());
    const browser2 = new PipelineCommandTestBrowser(root);
    service = new ClientService(store, browser2, provider, () => now, now);
    await service.loadSettings();
    const token2 = service.authority.issueSession();

    const reloaded = (await service.dispatch(token2, {
      command: 'replyPipeline',
      action: 'getConfig',
    })) as ReplyPipelineStatusView;
    expect(reloaded.configured).toBe(true);
    expect(reloaded.config).toEqual(nextConfig);
    expect(reloaded.rhythmState?.profile).toBe('calm');

    // Live automatic reply without host.pipelineConfig uses persisted exactFaqDirectReply + customWords
    await installFixtureKey(service, token2, { key: 'synthetic-contract-key' });
    const kStore = new ReplyKnowledgeStore(store);
    const faq = kStore.saveKnowledge('account_001', {
      title: '发货时效',
      topic: '物流',
      text: '下单后24小时内安排顺丰发出。',
      aliases: ['什么时候发货'],
    });
    kStore.setKnowledgeState('account_001', faq.id, 'ACTIVE');

    await service.dispatch(token2, {
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
        conversationIds: [],
        entireInbox: true,
        containsAny: [],
        excludesAny: [],
        instructions: '礼貌回复',
        startHour: 0,
        endHour: 24,
      },
      confirmed: true,
    });
    await service.dispatch(token2, { command: 'setMode', mode: 'LIMITED_AUTO' });

    const sensitiveEvId = pending(
      store,
      candidate({
        conversationId: 'conv-sens',
        platformEventId: 'sens-1',
        text: '请问你们有 secret-forbidden-word 吗',
        occurredAt: new Date(now - 5_000).toISOString(),
      }),
    );
    await service.runAutomaticReply();
    expect(modelCalls).toBe(0);
    expect(browser2.clicks).toBe(0);
    expect(store.db.prepare('SELECT reason FROM automation_jobs WHERE event_id=?').get(sensitiveEvId)).toEqual({
      reason: 'CUSTOM_SENSITIVE_WORD',
    });

    const faqEvId = pending(
      store,
      candidate({
        conversationId: 'conv-faq-live',
        platformEventId: 'faq-live-1',
        text: '发货时效',
        occurredAt: new Date(now - 5_000).toISOString(),
      }),
    );
    await service.runAutomaticReply();
    expect(modelCalls).toBe(0);
    expect(browser2.clicks).toBe(1);
    expect(browser2.lastSentText).toBe('下单后24小时内安排顺丰发出。');
    expect(store.event(faqEvId).status).toBe('CONFIRMED');
  });

  test('dryRun traces all stages read-only without writing jobs, drafts, or attribution', async () => {
    const root = privateTemp('pipeline-cmd-dryrun-');
    const now = Date.parse('2026-11-15T09:00:00Z');
    const store = new EventStore(join(root, 'poc.sqlite'), true, () => new Date(now).toISOString());
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
    await migrateReplyKnowledge(store, join(root, 'knowledge.sqlite'));
    store.bindAccount('own-1');

    const browser = new PipelineCommandTestBrowser(root);
    service = new ClientService(store, browser, new DeepSeekProvider(), () => now, now);
    await service.loadSettings();
    const token = service.authority.issueSession();

    await service.dispatch(token, {
      command: 'replyPipeline',
      action: 'saveConfig',
      config: {
        ...DEFAULT_REPLY_PIPELINE_PERSISTED_CONFIG,
        rhythmProfile: 'natural',
        sensitive: {
          customWords: ['禁用内部词'],
          enablePlatformRedline: true,
          enablePromptInjectionGuard: true,
        },
        handoff: {
          ...DEFAULT_REPLY_PIPELINE_PERSISTED_CONFIG.handoff,
          bargainHandoff: true,
          exactFaqDirectReply: true,
        },
      },
    });

    const normalEvId = pending(
      store,
      candidate({
        conversationId: 'conv-dry-ok',
        platformEventId: 'dry-ok-1',
        text: '请问尺码怎么选',
        occurredAt: new Date(now - 5_000).toISOString(),
      }),
    );
    const bargainEvId = pending(
      store,
      candidate({
        conversationId: 'conv-dry-bargain',
        platformEventId: 'dry-bargain-1',
        text: '能便宜点吗给我最低价',
        occurredAt: new Date(now - 5_000).toISOString(),
      }),
    );

    const tracePass = (await service.dispatch(token, {
      command: 'replyPipeline',
      action: 'dryRun',
      eventId: normalEvId,
      candidateReplyText: '您好，建议按平时尺码选购即可。',
    })) as PipelineTrace;
    expect(tracePass.dryRun).toBe(true);
    expect(tracePass.attributionRecorded).toBe(false);
    expect(tracePass.finalDecision).toBe('continue');
    expect(tracePass.stages.map((s) => s.stage)).toEqual([
      'eligibility_check',
      'scope_and_blacklist_check',
      'ownership_handoff_check',
      'rhythm_rate_limit_check',
      'content_safety_check',
      'debounce_preprocess',
      'handoff_rules_and_knowledge',
      'outbound_safety_and_loop_check',
    ]);

    const traceBargain = (await service.dispatch(token, {
      command: 'replyPipeline',
      action: 'dryRun',
      eventId: bargainEvId,
    })) as PipelineTrace;
    expect(traceBargain.dryRun).toBe(true);
    expect(traceBargain.finalDecision).toBe('handoff_human');
    expect(traceBargain.stoppedAt).toBe('handoff_rules_and_knowledge');
    expect(traceBargain.reasonCode).toBe('BARGAIN_KEYWORD_HANDOFF');
    expect(tableExists(store, 'handoff_attributions')).toBe(false);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM automation_jobs').get()).toEqual({ n: 0 });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM reply_drafts').get()).toEqual({ n: 0 });
  });

  test('FAQ suggestion commands list, generate, atomically adopt into ACTIVE k_knowledge, and dismiss', async () => {
    const root = privateTemp('pipeline-cmd-faq-');
    const now = Date.parse('2026-11-15T10:00:00Z');
    const store = new EventStore(join(root, 'poc.sqlite'), true, () => new Date(now).toISOString());
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
    await migrateReplyKnowledge(store, join(root, 'knowledge.sqlite'));
    store.bindAccount('own-1');

    const browser = new PipelineCommandTestBrowser(root);
    service = new ClientService(store, browser, new DeepSeekProvider(), () => now, now);
    await service.loadSettings();
    const token = service.authority.issueSession();

    expect(isMutatingClientCommand({ command: 'replyKnowledge', action: 'listFaqSuggestions' })).toBe(false);
    expect(isMutatingClientCommand({ command: 'replyKnowledge', action: 'generateFaqSuggestions' })).toBe(true);
    expect(isReadOnlySidecarCommand({ command: 'replyKnowledge', action: 'listFaqSuggestions' })).toBe(true);
    expect(isReadOnlySidecarCommand({ command: 'replyKnowledge', action: 'adoptFaqSuggestion' })).toBe(false);

    // Seed two confirmed human replies for shipping time and two for warranty
    const seedConfirmed = (conv: string, pid: string, q: string, a: string, tsOffset: number) => {
      const evId = pending(
        store,
        candidate({
          conversationId: conv,
          platformEventId: pid,
          text: q,
          occurredAt: new Date(now - tsOffset).toISOString(),
        }),
      );
      const ev = store.event(evId);
      const dId = randomUUID();
      store.db.prepare("INSERT INTO reply_drafts VALUES(?,?,?,?,1,'DRAFT',NULL,NULL)").run(dId, evId, a, 'HUMAN_TYPED');
      store.db.prepare("INSERT INTO draft_revisions VALUES(?,1,'HUMAN_TYPED',?,?,?)").run(dId, a, 'op-1', now);
      store.db.prepare("UPDATE inbound_events SET status='AWAITING_APPROVAL' WHERE id=?").run(evId);
      store.approve(dId, snapshot(ev.payload), 1, a);
      const iId = store.recordIntent(dId, snapshot(ev.payload), false, { check() {}, committed() {} });
      store.receipt(iId, 'CONFIRMED', `proof-${pid}`);
    };

    seedConfirmed('c1', 'p1', '请问多久能发货呀', '每天下午五点前下单当天发出。', 20_000);
    seedConfirmed('c2', 'p2', '大概多久可以发货呢', '每天下午五点前下单当天发出。', 15_000);
    seedConfirmed('c3', 'p3', '这个保修期是多长时间', '支持一年质保只换不修。', 10_000);
    seedConfirmed('c4', 'p4', '请问保修期有多久', '支持一年质保只换不修。', 5_000);

    const emptyList = (await service.dispatch(token, {
      command: 'replyKnowledge',
      action: 'listFaqSuggestions',
      status: 'PENDING',
    })) as FaqSuggestion[];
    expect(emptyList).toEqual([]);

    const generated = (await service.dispatch(token, {
      command: 'replyKnowledge',
      action: 'generateFaqSuggestions',
      minClusterSize: 2,
    })) as FaqSuggestion[];
    expect(generated.length).toBe(2);

    const pendingList = (await service.dispatch(token, {
      command: 'replyKnowledge',
      action: 'listFaqSuggestions',
      status: 'PENDING',
    })) as FaqSuggestion[];
    expect(pendingList.length).toBe(2);

    const first = pendingList[0]!;
    const second = pendingList[1]!;

    // Adopt first suggestion atomically into ACTIVE k_knowledge entry
    const adopted = (await service.dispatch(token, {
      command: 'replyKnowledge',
      action: 'adoptFaqSuggestion',
      suggestionId: first.id,
      title: '标准发货时效',
      topic: '物流配送',
      text: '每天下午5点前下单当天发出，默认顺丰。',
      aliases: ['多久发货', '什么时候发出'],
    })) as { suggestion: FaqSuggestion; entry: KnowledgeEntry };

    expect(adopted.suggestion.status).toBe('ADOPTED');
    expect(adopted.entry.title).toBe('标准发货时效');
    expect(adopted.entry.topic).toBe('物流配送');
    expect(adopted.entry.state).toBe('ACTIVE');
    expect(adopted.entry.aliases).toEqual(['多久发货', '什么时候发出']);

    const dbEntry = store.db
      .prepare('SELECT title, state FROM k_knowledge WHERE id=?')
      .get(adopted.entry.id) as { title: string; state: string };
    expect(dbEntry).toEqual({ title: '标准发货时效', state: 'ACTIVE' });

    // Dismiss second suggestion
    const dismissed = (await service.dispatch(token, {
      command: 'replyKnowledge',
      action: 'dismissFaqSuggestion',
      suggestionId: second.id,
    })) as FaqSuggestion;
    expect(dismissed.status).toBe('DISMISSED');

    const remainingPending = (await service.dispatch(token, {
      command: 'replyKnowledge',
      action: 'listFaqSuggestions',
      status: 'PENDING',
    })) as FaqSuggestion[];
    expect(remainingPending).toEqual([]);
  });
});
