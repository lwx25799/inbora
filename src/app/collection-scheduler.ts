import { Blocked, requireSafe } from "../core/contracts.js";
import type { AutomationStore } from "../storage/automation-store.js";

export type CollectionSource = "works" | "dm";
/** An object-specific failure was persisted; the channel can serve a different object next turn. */
export class DeferredObjectRead extends Blocked {}
export const collectionStops = new Set([
  "OBSERVATION_PAGE_BLOCKED", "OBSERVATION_ACCOUNT_CHANGED", "ACCOUNT_CHANGED",
  "PLATFORM_STOP", "CHALLENGE_REQUIRED", "LOGIN_REQUIRED", "ACCOUNT_NOT_VERIFIED", "UNEXPECTED_ORIGIN",
  "OWNER_LOCKED_OR_PORT_UNAVAILABLE",
  "OWN_WORKS_ACCOUNT_CHANGED", "NATIVE_REPLY_ACCOUNT_CHANGED", "COMMENT_REPLY_ACCOUNT_CHANGED",
  "NATIVE_REPLY_PAGE_BLOCKED", "COMMENT_REPLY_PAGE_BLOCKED",
]);

/** One bounded browser turn at a time. No AI, sending, WebView visibility or operator-session dependency. */
export class CollectionScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | null = null;
  private abort: AbortController | undefined;
  private closed = false;
  private last: CollectionSource = "dm";
  private fatal: string | null = null;
  constructor(readonly persistence: AutomationStore,
    private readonly collect: (source: CollectionSource, signal: AbortSignal) => Promise<void>,
    private readonly updated: () => void = () => {},
  ) {}
  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => void this.pulse(), 1000);
    this.timer.unref();
    void this.pulse();
  }
  private async pulse():Promise<void> {
    try {await this.tick();}catch {
      this.fatal='COLLECTION_STATE_UNAVAILABLE';
      this.closed=true;clearInterval(this.timer);this.timer=undefined;
      this.updated();
    }
  }
  cancel(): void { this.abort?.abort(); }
  status() {
    return {running: !!this.running, source: this.running ? this.last : null, fatal:this.fatal,
      channels: this.persistence.store.db.prepare("SELECT * FROM collection_progress ORDER BY source").all()};
  }
  async tick(): Promise<void> {
    if (this.closed || this.running) return;
    const {collection, emergencyStopped} = this.persistence.state();
    if (!collection || emergencyStopped) return;
    const progress = this.persistence.store.db.prepare("SELECT source,next_at FROM collection_progress").all() as {source: CollectionSource; next_at: number}[];
    const due = progress.filter(p => (p.source === "works" ? collection.comments : collection.inbox) && p.next_at <= this.persistence.now());
    const next = due.find(p => p.source !== this.last) ?? due[0];
    if (!next) return;
    this.last = next.source;
    const abort = new AbortController(); this.abort = abort;
    const timeout = setTimeout(() => abort.abort(), 30_000); timeout.unref();
    const started = this.persistence.now();
    const interval = next.source === "works" ? collection.commentIntervalMs : collection.dmIntervalMs;
    const task = Promise.resolve().then(async () => {
      let error: string | null = null;
      let objectDeferred=false;
      try {
        const current = this.persistence.state();
        requireSafe(!this.closed && !abort.signal.aborted && !current.emergencyStopped && current.collection &&
          current.collection.ownId === collection.ownId && (next.source === "works" ? current.collection.comments : current.collection.inbox), "COLLECTION_CANCELLED");
        this.persistence.requireAccount(collection.ownId);
        await this.collect(next.source, abort.signal);
        requireSafe(!abort.signal.aborted, "COLLECTION_CANCELLED");
      } catch (cause) {
        error = cause instanceof Blocked ? cause.code : "COLLECTION_FAILED_PRIVATE_DIAGNOSTICS";
        objectDeferred=cause instanceof DeferredObjectRead;
      }
      const now = this.persistence.now();
      if (error) {
        const old = this.persistence.store.db.prepare("SELECT failures FROM collection_progress WHERE source=?").get(next.source) as {failures: number};
        const delay = objectDeferred?interval:Math.min(Math.max(interval, 600_000), interval * 2 ** Math.min(old.failures + 1, 10));
        this.persistence.store.db.prepare("UPDATE collection_progress SET next_at=?,last_error=?,failures=failures+1,elapsed_ms=? WHERE source=?")
          .run(now + delay, error, Math.max(0, now - started), next.source);
        if (collectionStops.has(error)) this.persistence.stop(true);
      } else {
        this.persistence.store.db.prepare("UPDATE collection_progress SET next_at=?,last_success=?,last_error=NULL,failures=0,elapsed_ms=? WHERE source=?")
          .run(now + interval, now, Math.max(0, now - started), next.source);
      }
    }).finally(() => {
      clearTimeout(timeout);
      this.running = null;
      this.abort = undefined;
      this.updated();
    });
    this.running = task;
    await task;
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer); this.timer = undefined;
    this.cancel();
    await this.running;
  }
}
