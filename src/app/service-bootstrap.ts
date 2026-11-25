import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Blocked, requireSafe } from "../core/contracts.js";
import type { EventStore } from "../storage/store.js";
import { AutomationStore } from "../storage/automation-store.js";
import { migrateAutomation } from "../storage/automation-migration.js";
import { ensureQueryIndexes } from "../storage/query-indexes.js";
import { migrateFollowups } from "../storage/followup-migration.js";
import { migrateLocalAssistant } from "../storage/local-assistant-migration.js";
import type { ReplyKnowledgeService } from "../knowledge/service.js";
import { runtimePerformance } from "../observability/runtime-performance.js";
import type { WorkbenchAuthority } from "./authority.js";
import type { PlatformConnector } from "../platform/platform-connector.js";
import type { HumanFollowups } from "./human-followup.js";
import { BrowserDraftRecovery } from "./browser-draft-recovery.js";
import { classifyStoredShares } from "./message-disposition.js";
import { CollectionScheduler } from "./collection-scheduler.js";
import { VerificationScheduler } from "./verification-scheduler.js";
import { defaultSettings, settingsSchema, type AiSettings } from "./contracts.js";
import { migrateModelProviders } from "../storage/model-provider-migration.js";
import { ModelProviderStore } from "../storage/model-provider-store.js";
import { ModelRouteGuard } from "./model-route-guard.js";
import { ModelProviderController } from "./model-provider-controller.js";
import { ModelCredentialStore } from "./credentials.js";

export interface BootstrapInput {
  store: EventStore;
  authority: WorkbenchAuthority;
  browser: PlatformConnector;
  knowledge: ReplyKnowledgeService;
  followups: HumanFollowups;
  startedAt: number;
  isSyncBusy(): boolean;
  cancelMaintenance(): void;
  onInboxUpdated(): void;
  onSendStatusUpdated(): void;
}

export interface BootstrappedRuntime {
  automation: AutomationStore;
  collector: CollectionScheduler;
  verification: VerificationScheduler;
  hasStartupRecoveryCandidate: boolean;
}

/** Runs additive migrations, recovers unfinished jobs, and builds background schedulers. */
export async function bootstrapAutomationRuntime(input: BootstrapInput): Promise<BootstrappedRuntime> {
  const { store, authority, browser } = input;
  const backup = (name: string) => join(browser.root, "backups", `${name}-${randomUUID()}.sqlite`);
  await migrateAutomation(store, backup("automation"));
  await ensureQueryIndexes(store, backup("query-indexes"));
  await migrateFollowups(store, backup("human-followups"));
  await migrateLocalAssistant(store, backup("local-assistant"));
  await input.knowledge.initialize();
  input.followups.recover();
  const automation = new AutomationStore(store, authority.now, browser.accountId);
  automation.initialize(input.startedAt);
  classifyStoredShares(store, browser.root);
  const hasStartupRecoveryCandidate = new BrowserDraftRecovery(store, authority, browser).hasStartupCandidate();
  if (authority.mode() === "LIMITED_AUTO") authority.resumeIdleAutomation();
  if (!automation.state().emergencyStopped && authority.paused()) {
    store.db.prepare("UPDATE client_state SET paused=0 WHERE id=1").run();
    store.audit("SINGLE_ACCOUNT_ONLINE_RESTORED", authority.accountId);
  }
  store.db
    .prepare(
      `UPDATE automation_jobs SET state=COALESCE((SELECT status FROM send_intents WHERE event_id=automation_jobs.event_id),'REVIEW'),
       reason='RESTART_NO_REPLAY',updated_at=? WHERE state IN ('QUALIFYING','GENERATING','PREPARING','QUEUED','PREFLIGHT','SENDING')`,
    )
    .run(authority.now());
  const collector = new CollectionScheduler(
    automation,
    async (source, signal, trigger) => {
      requireSafe(trigger === "MANUAL" || !input.isSyncBusy(), "COLLECTION_CANCELLED");
      input.cancelMaintenance();
      const end = runtimePerformance.start("COLLECTION", source === "dm" ? "DIRECT_MESSAGE" : "COMMENT_NOTIFICATION");
      try {
        await browser.collect(automation, source, signal);
        end();
      } catch (error) {
        end(signal.aborted ? "CANCELLED" : "FAILED");
        throw error;
      }
    },
    input.onInboxUpdated,
  );
  const verification = new VerificationScheduler(
    automation,
    (eventId, signal) => browser.verifyExisting(store, eventId, { signal, background: true }),
    input.onSendStatusUpdated,
    (commandId, signal) => browser.verifyExistingFollowup(store, commandId, { signal, background: true }),
  );
  return { automation, collector, verification, hasStartupRecoveryCandidate };
}

export async function loadClientSettings(root: string): Promise<AiSettings | null> {
  try {
    const raw = JSON.parse(await readFile(join(root, "client-settings.json"), "utf8"));
    return settingsSchema.parse({ ...raw, model: defaultSettings.model });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function bootstrapModelProviders(automation: AutomationStore, root: string, transport: typeof fetch,
  updated: () => void): Promise<{ controller: ModelProviderController | null; reason: string | null }> {
  try {
    await migrateModelProviders(automation.store, root);
    const models = new ModelProviderStore(automation.store.db, automation.now);
    const controller = new ModelProviderController(new ModelRouteGuard(models, automation), new ModelCredentialStore(root),
      transport, updated);
    await controller.initialize();
    return { controller, reason: null };
  } catch (error) {
    const reason = error instanceof Blocked ? error.code : "MODEL_PROVIDER_SCHEMA_INVALID";
    automation.store.audit("MODEL_PROVIDERS_UNAVAILABLE", reason);
    return { controller: null, reason };
  }
}
