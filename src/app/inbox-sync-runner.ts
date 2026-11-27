import { randomUUID } from "node:crypto";
import { DEFAULT_ACCOUNT_ID, requireSafe } from "../core/contracts.js";
import { shouldStopGlobally } from "../core/emergency-stop.js";
import type { EventStore } from "../storage/store.js";
import type { AutomationStore } from "../storage/automation-store.js";
import type { WorkbenchAuthority } from "./authority.js";
import type { PlatformConnector } from "../platform/platform-connector.js";
import type { CollectionScheduler } from "./collection-scheduler.js";
import type { InboxSync } from "./contracts.js";

export interface InboxSyncHost {
  store: EventStore;
  authority: WorkbenchAuthority;
  browser: PlatformConnector;
  getAutomation(): AutomationStore | null;
  getCollector(): CollectionScheduler | null;
  isClosing(): boolean;
  emit(event: string): void;
  track(task: Promise<unknown>): void;
  errorCode(error: unknown): string;
}

/** Coordinates manual observe and bounded multi-channel inbox sync turns. */
export class InboxSyncRunner {
  private syncTask: Promise<void> | null = null;
  private syncAbort: AbortController | null = null;
  private observing = false;
  private sync: InboxSync = {
    runId: null,
    running: false,
    cancelled: false,
    source: null,
    results: [],
  };
  constructor(private readonly host: InboxSyncHost) {}
  get busy(): boolean {
    return !!this.syncTask || this.observing;
  }
  snapshot(): InboxSync {
    return this.sync;
  }
  stop(): void {
    if (!this.syncTask) return;
    this.syncAbort?.abort();
    this.sync.cancelled = true;
    for (const result of this.sync.results) {
      if (result.state === "PENDING" || result.state === "RUNNING") result.state = "CANCELLED";
    }
    this.host.emit("inbox_sync_updated");
  }
  private mustStop(code: string): boolean {
    return (
      shouldStopGlobally(code) ||
      ["BROWSER_CLOSED", "OPERATOR_EXPIRED", "OPERATOR_PERMISSION_DENIED"].includes(code)
    );
  }
  private observationFailed(source: "works" | "dm" | "notifications", error: unknown): never {
    const code = this.host.errorCode(error),
      mode = this.host.browser.status().mode;
    if (code !== "BROWSER_CLOSED") {
      const { store } = this.host;
      const { db, accountId } = store;
      const schema4 = store.schemaVersion() === 4;
      const global = shouldStopGlobally(code);
      const channel = source === "dm" ? "DIRECT_MESSAGE" : "COMMENT_NOTIFICATION";
      db.transaction(() => {
        if (schema4) {
          if (global) db.prepare("UPDATE account_channel_capabilities SET state='BLOCKED' WHERE account_id=?").run(accountId);
          else db.prepare("UPDATE account_channel_capabilities SET state='BLOCKED' WHERE account_id=? AND channel=? AND browser_mode=?")
            .run(accountId, channel, mode);
        }
        if (!schema4 || accountId === DEFAULT_ACCOUNT_ID) {
          if (global) db.prepare("UPDATE channel_capabilities SET state='BLOCKED'").run();
          else db.prepare("UPDATE channel_capabilities SET state='BLOCKED' WHERE channel=? AND browser_mode=?").run(channel, mode);
        }
      }).immediate();
    }
    this.host.emit("status_updated");
    throw error;
  }
  private async observeSource(source: "works" | "dm" | "notifications", signal?: AbortSignal): Promise<void> {
    try {
      await this.host.browser.observe(this.host.store, source, signal);
    } catch (error) {
      if (signal?.aborted && !this.mustStop(this.host.errorCode(error))) throw error;
      this.observationFailed(source, error);
    }
  }
  async observe(token: string, source: "works" | "dm" | "notifications", signal?: AbortSignal): Promise<void> {
    this.host.authority.operator(token, "CONTROL");
    requireSafe(!this.syncTask && !this.observing, "INBOX_SYNC_IN_PROGRESS");
    this.observing = true;
    try {
      await this.observeSource(source, signal);
    } finally {
      this.observing = false;
    }
    this.host.emit("inbox_updated");
  }
  private async syncSource(source: "works" | "dm", signal: AbortSignal): Promise<string | null> {
    requireSafe(!signal.aborted, "COLLECTION_CANCELLED");
    const collection = this.host.getAutomation()?.state().collection;
    const collector = this.host.getCollector();
    if (!collector || !(source === "works" ? collection?.comments : collection?.inbox)) {
      await this.observeSource(source, signal);
      return null;
    }
    try {
      return (await collector.runNow(source, signal)).deferredCode;
    } catch (error) {
      const code = this.host.errorCode(error);
      if (
        (signal.aborted || code === "COLLECTION_CANCELLED" || code === "OBSERVATION_CANCELLED") &&
        !this.mustStop(code)
      ) {
        throw error;
      }
      this.observationFailed(source, error);
    }
  }
  start(token: string): void {
    const assistantVersion = this.host.authority.assistantVersion(token);
    const scope =
      assistantVersion === null ? null : this.host.authority.assistant.require("editControl", assistantVersion);
    const sources: ("works" | "dm")[] = scope
      ? scope.scope.channels.map((channel) => (channel === "DIRECT_MESSAGE" ? "dm" : "works"))
      : ["works", "dm"];
    if (this.syncTask) return;
    requireSafe(!this.observing, "INBOX_SYNC_IN_PROGRESS");
    requireSafe(!this.host.getAutomation()?.state().emergencyStopped, "COLLECTION_CANCELLED");
    this.sync = {
      runId: randomUUID(),
      running: true,
      cancelled: false,
      source: sources[0]!,
      results: sources.map((source) => ({ source, state: "PENDING", error: null })),
    };
    const ownerEpoch = this.host.browser.ownerEpoch,
      abort = new AbortController();
    this.syncAbort = abort;
    const task = Promise.resolve()
      .then(async () => {
        for (const result of this.sync.results) {
          if (this.host.isClosing() || this.sync.cancelled) break;
          this.sync.source = result.source;
          result.state = "RUNNING";
          this.host.emit("inbox_sync_updated");
          try {
            this.host.authority.operator(token, "CONTROL");
            if (assistantVersion !== null) this.host.authority.assistant.require("editControl", assistantVersion);
            requireSafe(this.host.browser.ownerEpoch === ownerEpoch, "BROWSER_CLOSED");
            const deferred = await this.syncSource(result.source, abort.signal);
            if (!this.sync.cancelled) {
              result.state = deferred ? "DEFERRED" : "SUCCEEDED";
              result.error = deferred;
            }
          } catch (error) {
            if (this.sync.cancelled) break;
            const code = this.host.errorCode(error);
            result.state = code === "COLLECTION_CANCELLED" || code === "OBSERVATION_CANCELLED" ? "CANCELLED" : "FAILED";
            result.error = code;
            const safeCode = /^[A-Z][A-Z0-9_]{0,99}$/u.test(code) ? code : "PRIVATE_DIAGNOSTICS";
            this.host.store.audit(`INBOX_SYNC_${result.source.toUpperCase()}_${result.state}_${safeCode}`, this.sync.runId!);
            if (this.mustStop(code) || code.startsWith("ASSISTANT_")) {
              for (const next of this.sync.results) if (next.state === "PENDING") next.state = "SKIPPED";
              break;
            }
          }
          this.host.emit("inbox_updated");
        }
      })
      .finally(() => {
        this.sync.running = false;
        this.sync.source = null;
        this.syncTask = null;
        if (this.syncAbort === abort) this.syncAbort = null;
        this.host.emit("inbox_updated");
      });
    this.syncTask = task;
    this.host.track(task);
  }
}
