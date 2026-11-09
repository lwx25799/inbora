import { randomUUID } from "node:crypto";
import { Blocked, requireSafe,targetKey } from "../core/contracts.js";
import type { AutomationStore } from "../storage/automation-store.js";
import { collectionStops } from "./collection-scheduler.js";

interface VerificationJob {intent_id:string;event_id:string;boundary:string;target_digest:string;attempts:number;next_at:number;deadline:number;state:string}
/** Append-only follow-up evidence for an existing intent. This worker has no sending capability. */
export class VerificationScheduler {
  private timer:ReturnType<typeof setInterval>|undefined;
  private running:Promise<void>|null=null;
  private abort:AbortController|undefined;
  private closed=false;
  private activeDeadline=0;
  constructor(readonly data:AutomationStore,
    private readonly verify:(eventId:string,signal:AbortSignal)=>Promise<{verified:boolean;evidenceId:string;nativeIdDigest?:string}>,
    private readonly updated:()=>void=()=>{},
  ) {}
  enqueue(eventId:string):void {
    const intent=this.data.store.db.prepare("SELECT id,attempt_started_at,target_digest FROM send_intents WHERE event_id=? AND status='UNCERTAIN'").get(eventId) as {
      id:string;attempt_started_at:string;target_digest:string;
    }|undefined;
    if(!intent)return;
    this.data.store.db.prepare("INSERT OR IGNORE INTO verification_jobs VALUES(?,?,?,?,0,?,?,'PENDING',NULL)")
      .run(intent.id,eventId,intent.attempt_started_at,intent.target_digest,this.data.now()+2000,this.data.now()+120_000);
  }
  start():void {
    if(this.timer||this.closed)return;
    this.data.store.db.prepare("UPDATE verification_jobs SET state=CASE WHEN attempts<2 THEN 'PENDING' ELSE 'REVIEW' END WHERE state='RUNNING'").run();
    this.data.store.db.prepare("UPDATE verification_jobs SET deadline=? WHERE state='PENDING' AND attempts<2 AND deadline<=?").run(this.data.now()+120_000,this.data.now());
    this.timer=setInterval(()=>void this.tick().catch(()=>{this.closed=true;clearInterval(this.timer);this.updated();}),1000);this.timer.unref();
  }
  async tick():Promise<void> {
    if(this.running){if(this.data.now()>=this.activeDeadline)this.abort?.abort();return;}
    if(this.closed||this.data.state().emergencyStopped)return;
    this.data.store.db.prepare("UPDATE verification_jobs SET state='NOT_NEEDED' WHERE state='PENDING' AND intent_id IN (SELECT id FROM send_intents WHERE status='CONFIRMED')").run();
    this.data.store.db.prepare("UPDATE verification_jobs SET state='REVIEW',last_error='VERIFICATION_DEADLINE' WHERE state='PENDING' AND (deadline<=? OR attempts>=2)").run(this.data.now());
    const job=this.data.store.db.prepare("SELECT j.* FROM verification_jobs j JOIN send_intents i ON i.id=j.intent_id WHERE j.state='PENDING' AND j.next_at<=? AND i.status='UNCERTAIN' ORDER BY j.next_at LIMIT 1").get(this.data.now()) as VerificationJob|undefined;
    if(!job)return;
    const abort=new AbortController();this.abort=abort;
    this.activeDeadline=Math.min(job.deadline,this.data.now()+30_000);
    const timeout=setTimeout(()=>abort.abort(),Math.max(1,this.activeDeadline-this.data.now()));timeout.unref();
    const task=Promise.resolve().then(async()=>{
      if(this.closed||abort.signal.aborted||this.data.state().emergencyStopped)return;
      const intent=this.data.store.db.prepare('SELECT event_id,attempt_started_at,target_digest FROM send_intents WHERE id=?').get(job.intent_id) as {
        event_id:string;attempt_started_at:string;target_digest:string;
      }|undefined;
      try {
        requireSafe(intent&&intent.event_id===job.event_id&&intent.attempt_started_at===job.boundary&&intent.target_digest===job.target_digest,'VERIFICATION_BINDING_CHANGED');
        this.data.store.db.prepare("UPDATE verification_jobs SET state='RUNNING',attempts=attempts+1 WHERE intent_id=? AND state='PENDING'").run(job.intent_id);
        const result=await this.verify(job.event_id,abort.signal);
        requireSafe(!abort.signal.aborted,'VERIFICATION_CANCELLED');
        this.data.store.db.transaction(()=>{
          const current=this.data.store.db.prepare('SELECT event_id,attempt_started_at,target_digest,target_key FROM send_intents WHERE id=?').get(job.intent_id) as {
            event_id:string;attempt_started_at:string;target_digest:string;target_key:string;
          }|undefined;
          const event=this.data.store.event(job.event_id);
          requireSafe(current&&current.event_id===job.event_id&&current.attempt_started_at===job.boundary&&current.target_digest===job.target_digest&&
            current.target_key===targetKey(event.payload),'VERIFICATION_BINDING_CHANGED');
          let verified=result.verified,conflict=false;
          if(verified&&result.nativeIdDigest!==undefined&&event.payload.channel==='DIRECT_MESSAGE'){
            requireSafe(/^[a-f0-9]{64}$/u.test(result.nativeIdDigest),'VERIFICATION_BINDING_CHANGED');
            const prior=this.data.store.db.prepare('SELECT native_id_digest FROM chat_delivery_links WHERE intent_id=?').get(job.intent_id) as {native_id_digest:string}|undefined;
            conflict=!!prior&&prior.native_id_digest!==result.nativeIdDigest;verified=!conflict;
            if(!conflict)this.data.store.db.prepare('INSERT INTO chat_delivery_links VALUES(?,?) ON CONFLICT(intent_id) DO NOTHING').run(job.intent_id,result.nativeIdDigest);
          }
          this.data.store.db.prepare('INSERT INTO verification_results VALUES(?,?,?,?,?)').run(randomUUID(),job.intent_id,Number(verified),result.evidenceId,this.data.now());
          this.data.store.db.prepare("UPDATE verification_jobs SET state=?,next_at=?,last_error=? WHERE intent_id=?")
            .run(verified?'VERIFIED':conflict||job.attempts+1>=2?'REVIEW':'PENDING',this.data.now()+10_000,
              verified?null:conflict?'VERIFICATION_NATIVE_ID_CONFLICT':'NO_COMPLETE_PROOF',job.intent_id);
          this.data.store.audit(verified?'FOLLOWUP_DELIVERY_VERIFIED':'FOLLOWUP_PROOF_INCOMPLETE',job.intent_id);
        }).immediate();
      }catch(cause){
        const error=cause instanceof Blocked?cause.code:'VERIFICATION_FAILED_PRIVATE_DIAGNOSTICS';
        this.data.store.db.prepare("UPDATE verification_jobs SET state=?,next_at=?,last_error=? WHERE intent_id=?")
          .run(job.attempts+1>=2||error==='VERIFICATION_BINDING_CHANGED'?'REVIEW':'PENDING',this.data.now()+10_000,error,job.intent_id);
        if(collectionStops.has(error))this.data.stop(true);
      }
    }).finally(()=>{clearTimeout(timeout);this.running=null;this.abort=undefined;this.updated();});
    this.running=task;await task;
  }
  cancel():void {this.abort?.abort();}
  async close():Promise<void> {this.closed=true;clearInterval(this.timer);this.cancel();await this.running;}
}
