import { join } from "node:path";
import { z } from "zod";
import type { BrowserProfileOwner } from "../browser/profile-owner.js";
import { ObservedReader, type DiscoveredPeer, type ObservationBatch } from "../adapters/observed-reader.js";
import { OwnWorksDiscovery, type PendingWork } from "../adapters/own-works-discovery.js";
import type { ObservationMapping } from "../config/site-mapping.js";
import { digest, requireSafe } from "../core/contracts.js";
import { recordEvidence } from "../observability/evidence.js";
import type { AutomationStore } from "../storage/automation-store.js";
import type { CollectionSource } from "./collection-scheduler.js";
import { collectionStops, DeferredObjectRead } from "./collection-scheduler.js";
import { Blocked } from "../core/contracts.js";

const worksCursorSchema = z.object({phase: z.enum(["discovery", "comments"]).default("discovery"),
  workIndex: z.number().int().nonnegative().default(0), first: z.boolean().default(true),
  pending: z.array(z.object({aweme_id:z.string(),create_time:z.number().nullable().optional(),author:z.object({uid:z.string(),sec_uid:z.string()})})).default([])});
const dmCursorSchema=z.object({deferred:z.array(z.object({id:z.string().min(1),until:z.number().int().nonnegative(),code:z.string()})).default([])});
const objectRetryMs=120_000;

/** Only this backend extends observed targets from the explicitly enabled own-account collection scope. */
export class InboxCollector {
  private discovery: OwnWorksDiscovery;
  constructor(readonly owner: BrowserProfileOwner, readonly mapping: ObservationMapping,
    readonly data: AutomationStore, readonly root: string, readonly mode: "headed" | "headless") {
    this.discovery = new OwnWorksDiscovery(owner.notification, mapping);
  }
  private check(source: CollectionSource, signal: AbortSignal):void {
    const state=this.data.state(),settings=state.collection;
    requireSafe(!signal.aborted&&!state.emergencyStopped&&settings&&(source==='works'?settings.comments:settings.inbox),'COLLECTION_CANCELLED');
    this.data.requireAccount(this.mapping.self.uid);
    requireSafe(settings.ownId===this.mapping.self.uid,'ACCOUNT_CHANGED');
  }
  async collect(source:CollectionSource,signal:AbortSignal):Promise<void> {
    this.check(source,signal);
    // One object/page turn, never a whole catalog or inbox inside the account lock.
    await this.owner.actor.run(async()=>{
      this.check(source,signal);
      if(source==='dm')await this.dm(signal);else await this.works(signal);
    },'background');
  }
  private async persist(source:CollectionSource,scope:string,batch:ObservationBatch,signal:AbortSignal):Promise<void> {
    this.check(source,signal);
    const evidence=await recordEvidence(join(this.root,'evidence'),{
      caseId:source==='dm'?'D01':'N01',browserVersion:this.owner.version(),mode:this.mode,taskId:null,action:'OBSERVE',
      result:'UNVERIFIED',source:this.mapping.environment==='fixture'?'LOCAL_FIXTURE':'AUTOMATED_REAL',
      diagnostics:['BACKGROUND_COLLECTION',source==='dm'?'ACCOUNT_INBOX':'OWN_WORK_COMMENTS'],proofDigest:digest(batch),
    });
    this.check(source,signal);
    this.data.store.db.transaction(()=>{
      for(const b of batch.bindings??[]) {
        const old=this.data.store.db.prepare('SELECT own_id,uid,sec_uid,conversation_id FROM collection_targets WHERE target_key=?').get(b.targetKey) as {
          own_id:string;uid:string;sec_uid:string;conversation_id:string|null;
        }|undefined;
        requireSafe(!old||old.own_id===this.mapping.self.uid&&old.uid===b.uid&&old.sec_uid===b.secUid&&old.conversation_id===b.conversationId,'OBSERVATION_TARGET_IDENTITY_CONFLICT');
        this.data.store.db.prepare(`INSERT INTO collection_targets VALUES(?,?,?,?,?,?,?) ON CONFLICT(target_key)
          DO UPDATE SET title=excluded.title,observed_at=excluded.observed_at`).run(b.targetKey,this.mapping.self.uid,b.uid,b.secUid,b.title,b.conversationId,this.data.now());
      }
      this.data.store.observe(source==='dm'?'DIRECT_MESSAGE':'COMMENT_NOTIFICATION',scope,batch.events.map(e=>({...e,evidenceId:evidence})),
        this.mapping.self.uid,evidence,new Date(this.data.now()).toISOString(),this.data.state().startedAt);
    }).immediate();
  }
  private async dmStage<T>(stage:'LIST'|'THREAD'|'ADVANCE',read:()=>Promise<T>):Promise<T> {
    try{return await read();}catch(error){
      if(error instanceof Blocked)throw error;
      throw new Blocked(`DM_${stage}_READ_FAILED`);
    }
  }
  private async dm(signal:AbortSignal):Promise<void> {
    const reader=new ObservedReader(this.owner.dm,this.mapping);
    const batch=await this.dmStage('LIST',()=>reader.conversations());
    this.check('dm',signal);
    for(const peer of batch.peers??[]) {
      const old=this.data.store.db.prepare('SELECT own_id,sec_uid FROM discovered_conversations WHERE id=?').get(peer.conversationId) as {own_id:string;sec_uid:string}|undefined;
      requireSafe(!old||old.own_id===this.mapping.self.uid&&old.sec_uid===peer.secUid,'OBSERVATION_CONVERSATION_CHANGED');
      this.data.store.db.prepare(`INSERT INTO discovered_conversations(id,own_id,uid,sec_uid,title,first_seen,last_seen) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,last_seen=excluded.last_seen`).run(peer.conversationId,this.mapping.self.uid,peer.uid,peer.secUid,peer.title,this.data.now(),this.data.now());
    }
    const visible=(batch.peers??[]).map(p=>p.conversationId);
    if(!visible.length)return;
    const saved=this.data.store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='dm'").get() as {cursor_json:string};
    const cursor=dmCursorSchema.parse(JSON.parse(saved.cursor_json));
    const candidates=this.data.store.db.prepare(`SELECT * FROM discovered_conversations WHERE own_id=? AND id IN (${visible.map(()=>'?').join(',')}) ORDER BY last_read,first_seen,id`).all(this.mapping.self.uid,...visible) as {
      id:string;uid:string|null;sec_uid:string;title:string;last_read:number;
    }[];
    // Retain failed attempts after cooldown: an old unreadable row must not regain priority over never-attempted peers.
    const attempts=new Map(cursor.deferred.map(item=>[item.id,item.until-objectRetryMs]));
    candidates.sort((a,b)=>Math.max(a.last_read,attempts.get(a.id)??0)-Math.max(b.last_read,attempts.get(b.id)??0));
    const deferred=new Set(cursor.deferred.filter(item=>item.until>this.data.now()).map(item=>item.id));
    const next=candidates.find(candidate=>!deferred.has(candidate.id));
    if(!next){await this.dmStage('ADVANCE',()=>reader.conversations('next'));return;}
    const peer:DiscoveredPeer={uid:next.uid,secUid:next.sec_uid,conversationId:next.id,title:next.title};
    let messages:ObservationBatch;
    try{messages=await this.dmStage('THREAD',()=>reader.dm(0,peer));}
    catch(error){
      const code=error instanceof Blocked?error.code:'DM_THREAD_READ_FAILED';
      if(!collectionStops.has(code)&&!signal.aborted){
        this.check('dm',signal);
        cursor.deferred=cursor.deferred.filter(item=>item.id!==next.id);
        cursor.deferred.push({id:next.id,until:this.data.now()+objectRetryMs,code});
        this.data.store.db.transaction(()=>{
          this.data.store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='dm'").run(JSON.stringify(cursor));
          this.data.store.audit('DM_READ_DEFERRED',digest(next.id),{threadReadFailed:true});
        }).immediate();
        throw new DeferredObjectRead(code);
      }
      throw error;
    }
    await this.persist('dm',next.id,messages,signal);
    const native=messages.bindings?.[0];
    if(native) {
      requireSafe(next.uid===null||next.uid===native.uid,'OBSERVATION_SENDER_UNVERIFIED');
      this.data.store.db.prepare('UPDATE discovered_conversations SET uid=? WHERE id=?').run(native.uid,next.id);
    }
    this.data.store.db.prepare('UPDATE discovered_conversations SET last_read=? WHERE id=?').run(this.data.now(),next.id);
    cursor.deferred=cursor.deferred.filter(item=>item.id!==next.id);
    this.data.store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='dm'").run(JSON.stringify(cursor));
    this.check('dm',signal);
    await this.dmStage('ADVANCE',()=>reader.conversations('next'));
  }
  private async works(signal:AbortSignal):Promise<void> {
    const row=this.data.store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='works'").get() as {cursor_json:string};
    const cursor=worksCursorSchema.parse(JSON.parse(row.cursor_json));
    if(cursor.phase==='discovery') {
      const reader=new ObservedReader(this.owner.notification,this.mapping);
      const result=await this.discovery.scan(reader,cursor.first,signal,cursor.pending as PendingWork[]);
      this.check('works',signal);
      for(const work of result.works)this.data.registerWork(work);
      cursor.pending=result.pending.slice(0,2000);cursor.first=result.complete;
      // A missing native link is retained for later review, never a barrier to already proven works.
      cursor.phase=result.complete?'comments':'discovery';cursor.workIndex=0;
    } else {
      const registered=this.data.store.db.prepare("SELECT id,url FROM discovered_works WHERE own_id=? AND state='INCLUDED' ORDER BY published_at,id").all(this.mapping.self.uid) as {id:string;url:string}[];
      const works=Array.from(new Map([...this.mapping.works,...registered].map(w=>[w.id,w])).values());
      const work=works[cursor.workIndex];
      let done=true;
      if(work) {
        const mapping={...this.mapping,works:[work]};
        const progress=this.data.store.db.prepare('SELECT scroll_top,last_height,end_observations,next_at FROM work_collection_progress WHERE work_id=?').get(work.id) as {
          scroll_top:number;last_height:number;end_observations:number;next_at:number;
        }|undefined;
        if(progress&&progress.next_at>this.data.now()){
          cursor.workIndex++;if(cursor.workIndex>=works.length){cursor.phase='discovery';cursor.workIndex=0;}
          this.data.store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='works'").run(JSON.stringify(cursor));return;
        }
        let batch:ObservationBatch;
        try{batch=await new ObservedReader(this.owner.notification,mapping).comments(0,true,progress?.scroll_top??0);}
        catch(error){
          const code=error instanceof Blocked?error.code:'WORK_READ_FAILED_PRIVATE_DIAGNOSTICS';
          if(!collectionStops.has(code)&&!signal.aborted){
            cursor.workIndex++;
            if(cursor.workIndex>=works.length){cursor.phase='discovery';cursor.workIndex=0;}
            this.data.store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='works'").run(JSON.stringify(cursor));
            this.data.store.audit('WORK_READ_DEFERRED',digest(work.id));
            this.data.store.db.prepare(`INSERT INTO work_collection_progress VALUES(?,0,0,0,?,?,?) ON CONFLICT(work_id)
              DO UPDATE SET last_error=excluded.last_error,next_at=excluded.next_at`).run(work.id,0,code,this.data.now()+objectRetryMs);
            throw new DeferredObjectRead(code);
          }
          throw error;
        }
        await this.persist('works',`work:${work.id}`,batch,signal);
        const scroll=batch.scroll!;
        const end=scroll.atEnd&&(progress?.last_height??scroll.height)===scroll.height?(progress?.end_observations??0)+1:0;
        done=end>=2;
        this.data.store.db.prepare(`INSERT INTO work_collection_progress VALUES(?,?,?,?,?,NULL,0) ON CONFLICT(work_id)
          DO UPDATE SET scroll_top=excluded.scroll_top,last_height=excluded.last_height,end_observations=excluded.end_observations,last_read=excluded.last_read,last_error=NULL,next_at=0`)
          .run(work.id,done?0:scroll.top,scroll.height,done?0:end,this.data.now());
      }
      if(done)cursor.workIndex++;
      if(cursor.workIndex>=works.length){cursor.phase='discovery';cursor.workIndex=0;}
    }
    this.data.store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='works'").run(JSON.stringify(cursor));
  }
  dispose():void {this.discovery.dispose();}
}
