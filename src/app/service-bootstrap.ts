import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { requireSafe } from "../core/contracts.js";
import type { EventStore } from "../storage/store.js";
import { AutomationStore } from "../storage/automation-store.js";
import { migrateAutomation } from "../storage/automation-migration.js";
import { ensureQueryIndexes } from "../storage/query-indexes.js";
import { migrateFollowups } from "../storage/followup-migration.js";
import { migrateLocalAssistant } from "../storage/local-assistant-migration.js";
import type { ReplyKnowledgeService } from "../knowledge/service.js";
import { runtimePerformance } from "../observability/runtime-performance.js";
import type { WorkbenchAuthority } from "./authority.js";
import type { BrowserService } from "./browser-service.js";
import type { HumanFollowups } from "./human-followup.js";
import { BrowserDraftRecovery } from "./browser-draft-recovery.js";
import { classifyStoredShares } from "./message-disposition.js";
import { CollectionScheduler } from "./collection-scheduler.js";
import { VerificationScheduler } from "./verification-scheduler.js";
import { settingsSchema, type AiSettings } from "./contracts.js";

export interface BootstrapInput {
  store: EventStore;
  authority: WorkbenchAuthority;
  browser: BrowserService;
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
  const automation = new AutomationStore(store, authority.now);
  automation.initialize(input.startedAt);
  classifyStoredShares(store, browser.root);
  const hasStartupRecoveryCandidate = new BrowserDraftRecovery(store, authority, browser).hasStartupCandidate();
  if (authority.mode() === "LIMITED_AUTO") authority.resumeIdleAutomation();
  if (!automation.state().emergencyStopped && authority.paused()) {
    store.db.prepare("UPDATE client_state SET paused=0 WHERE id=1").run();
    store.audit("SINGLE_ACCOUNT_ONLINE_RESTORED", "account_001");
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
    return settingsSchema.parse(JSON.parse(await readFile(join(root, "client-settings.json"), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
