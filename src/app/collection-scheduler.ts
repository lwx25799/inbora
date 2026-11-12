import { Blocked, requireSafe } from "../core/contracts.js";
import type { AutomationStore } from "../storage/automation-store.js";
import type {CollectionSettings} from './automation-contracts.js';
import {platformStopCodes} from '../core/emergency-stop.js';

export type CollectionSource = "works" | "dm";
export type CollectionTrigger = 'BACKGROUND'|'MANUAL';
interface TurnResult {error:string|null;deferredCode:string|null;cancelled:boolean}
/** An object-specific failure was persisted; the channel can serve a different object next turn. */
export class DeferredObjectRead extends Blocked {}
export const collectionStops = new Set<string>(platformStopCodes);

/** One bounded browser turn at a time. No AI, sending, WebView visibility or operator-session dependency. */
export class CollectionScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<TurnResult> | null = null;
  private abort: AbortController | undefined;
  private closed = false;
  private last: CollectionSource = "dm";
  private fatal: string | null = null;
  private suspended=false;
  private cancelGeneration=0;
  constructor(readonly persistence: AutomationStore,
    private readonly collect: (source: CollectionSource, signal: AbortSignal,trigger:CollectionTrigger) => Promise<void>,
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
  cancel(): void { this.cancelGeneration++;this.abort?.abort(); }
  suspend(value:boolean):void {this.suspended=value;if(value)this.cancel();}
  status() {
    return {running: !!this.running, source: this.running ? this.last : null, fatal:this.fatal,
      channels: this.persistence.store.db.prepare("SELECT * FROM collection_progress ORDER BY source").all()};
  }
  async tick(): Promise<void> {
    if (this.closed || this.running || this.suspended) return;
    const {collection, emergencyStopped} = this.persistence.state();
    if (!collection || emergencyStopped) return;
    const progress = this.persistence.store.db.prepare("SELECT source,next_at,last_error FROM collection_progress").all() as {source: CollectionSource; next_at: number;last_error:string|null}[];
    const now=this.persistence.now();
    for(const row of progress){
      const interval=row.source==='works'?collection.commentIntervalMs:collection.dmIntervalMs;
      if(row.last_error==='INBOX_SYNC_IN_PROGRESS'){
        // This old local scheduling refusal did not attempt a browser read and is not a channel failure.
        row.next_at=Math.min(row.next_at,now+interval);row.last_error=null;
        this.persistence.store.db.prepare("UPDATE collection_progress SET next_at=?,last_error=NULL,failures=0 WHERE source=? AND last_error='INBOX_SYNC_IN_PROGRESS'")
          .run(row.next_at,row.source);
      }
      if(row.last_error==='COLLECTION_CANCELLED'&&row.next_at>now+interval){
        row.next_at=now+interval;
        this.persistence.store.db.prepare("UPDATE collection_progress SET next_at=? WHERE source=? AND last_error='COLLECTION_CANCELLED'").run(row.next_at,row.source);
      }
    }
    const due = progress.filter(p => (p.source === "works" ? collection.comments : collection.inbox) && p.next_at <= this.persistence.now());
    const next = due.find(p => p.source !== this.last) ?? due[0];
    if (!next) return;
    await this.runTurn(next.source,'BACKGROUND',collection);
  }
  async runNow(source:CollectionSource,signal?:AbortSignal):Promise<{deferredCode:string|null}> {
    const generation=this.cancelGeneration;
    const permitted=()=>{
      const state=this.persistence.state(),collection=state.collection;
      requireSafe(!this.closed&&!this.suspended&&!signal?.aborted&&generation===this.cancelGeneration&&
        !state.emergencyStopped&&collection&&(source==='works'?collection.comments:collection.inbox),'COLLECTION_CANCELLED');
      return collection;
    };
    permitted();
    while(this.running){await this.running;permitted();}
    const result=await this.runTurn(source,'MANUAL',permitted(),signal);
    requireSafe(!result.cancelled,'COLLECTION_CANCELLED');
    if(result.error&&!result.deferredCode)throw new Blocked(result.error);
    return {deferredCode:result.deferredCode};
  }
  private runTurn(source:CollectionSource,trigger:CollectionTrigger,collection:CollectionSettings,externalSignal?:AbortSignal):Promise<TurnResult> {
    this.last = source;
    const abort = new AbortController(); this.abort = abort;
    const signal=externalSignal?AbortSignal.any([abort.signal,externalSignal]):abort.signal;
    const timeout = setTimeout(() => abort.abort(), 30_000); timeout.unref();
    const started = this.persistence.now();
    const interval = source === "works" ? collection.commentIntervalMs : collection.dmIntervalMs;
    const task = Promise.resolve().then(async () => {
      let error: string | null = null;
      let objectDeferred=false;
      let cancelled=false;
      try {
        const current = this.persistence.state();
        requireSafe(!this.closed && !signal.aborted && !current.emergencyStopped && current.collection &&
          current.collection.ownId === collection.ownId && (source === "works" ? current.collection.comments : current.collection.inbox), "COLLECTION_CANCELLED");
        this.persistence.requireAccount(collection.ownId);
        await this.collect(source,signal,trigger);
        requireSafe(!signal.aborted, "COLLECTION_CANCELLED");
      } catch (cause) {
        error = cause instanceof Blocked ? cause.code : "COLLECTION_FAILED_PRIVATE_DIAGNOSTICS";
        objectDeferred=cause instanceof DeferredObjectRead;
        cancelled=error==='COLLECTION_CANCELLED'||signal.aborted&&(!(cause instanceof Blocked)||error==='BROWSER_CLOSED'||error==='OBSERVATION_CANCELLED');
      }
      const now = this.persistence.now();
      if(cancelled){
        // A bounded interruption is neither a successful read nor a new source fault. Keep its prior error and checkpoint.
        this.persistence.store.db.prepare('UPDATE collection_progress SET next_at=?,elapsed_ms=? WHERE source=?')
          .run(now+interval,Math.max(0,now-started),source);
      }else if (error) {
        const old = this.persistence.store.db.prepare("SELECT failures FROM collection_progress WHERE source=?").get(source) as {failures: number};
        const delay = objectDeferred?interval:Math.min(Math.max(interval, 600_000), interval * 2 ** Math.min(old.failures + 1, 10));
        this.persistence.store.db.prepare("UPDATE collection_progress SET next_at=?,last_error=?,failures=failures+1,elapsed_ms=? WHERE source=?")
          .run(now + delay, error, Math.max(0, now - started),source);
        if (collectionStops.has(error)) this.persistence.stop(true,error,source==='works'?'COLLECTION_COMMENTS':'COLLECTION_DM');
      } else {
        this.persistence.store.db.prepare("UPDATE collection_progress SET next_at=?,last_success=?,last_error=NULL,failures=0,elapsed_ms=? WHERE source=?")
          .run(now + interval, now, Math.max(0, now - started),source);
      }
      return {error,deferredCode:objectDeferred?error:null,cancelled};
    }).finally(() => {
      clearTimeout(timeout);
      this.running = null;
      this.abort = undefined;
      this.updated();
    });
    this.running = task;
    return task;
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer); this.timer = undefined;
    this.cancel();
    await this.running;
  }
}
