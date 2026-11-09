import { join } from "node:path";
import { randomUUID } from 'node:crypto';
import { lstat,mkdir,rename,unlink,writeFile } from 'node:fs/promises';
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
import { saveMessagePreviews } from '../adapters/message-preview.js';
import {ChatMessageStore} from '../storage/chat-messages.js';
import {MessageShareStore} from '../storage/message-shares.js';
import {MessagePreviewStore} from '../storage/message-previews.js';
import {dmLatestSchema,dmWindowCoverage,latestDmWindow,overlapsCompletedDm} from './dm-incremental.js';
import {dmActivitySchema,readDmActivity} from './dm-activity.js';
import {previewRetryFields,preparePreviewRetry,finishPreviewNormalTurn} from './preview-retry.js';
import {commentThreadsSchema,collectCommentThread} from './comment-thread-collection.js';
import {qualifyLateArrivals} from './late-arrival-qualification.js';

const worksCursorSchema = z.object({phase: z.enum(["discovery", "comments"]).default("discovery"),
  workIndex: z.number().int().nonnegative().default(0), first: z.boolean().default(true),
  pending: z.array(z.object({aweme_id:z.string(),create_time:z.number().nullable().optional(),author:z.object({uid:z.string(),sec_uid:z.string()})})).default([]),
  commentThreads:commentThreadsSchema,threadBurst:z.number().int().nonnegative().default(0)});
const dmSweepSchema=z.object({peer:z.object({uid:z.string().nullable(),secUid:z.string(),conversationId:z.string(),title:z.string()}),
  phase:z.enum(['MIN','MAX','PROBE_MIN','PROBE_MAX']),top:z.number().finite(),height:z.number().nonnegative(),signature:z.string(),
  edge:z.number().int().nonnegative(),legHasNew:z.boolean(),minimumOld:z.boolean().default(false),
  anchor:z.object({top:z.number().finite(),height:z.number().nonnegative(),ids:z.array(z.string().min(1)).min(1).max(100)}).optional(),latest:dmLatestSchema.optional()});
const dmCursorSchema=z.object({deferred:z.array(z.object({id:z.string().min(1),until:z.number().int().nonnegative(),code:z.string()})).default([]),
  sweep:dmSweepSchema.optional(),parked:z.array(dmSweepSchema).default([]),recent:z.array(z.string().min(1)).default([]),
  burst:z.number().int().nonnegative().default(0),completed:z.array(z.object({id:z.string().min(1),latest:dmLatestSchema})).max(1000).default([]),activity:dmActivitySchema,
  activityNeedsNormal:z.boolean().default(false),...previewRetryFields});
type DmCursor=z.infer<typeof dmCursorSchema>;
type DmSweep=z.infer<typeof dmSweepSchema>;
const objectRetryMs=120_000;
type DiagnosticPhase='LIST'|'THREAD'|'ADVANCE'|'HINT';

/** Only this backend extends observed targets from the explicitly enabled own-account collection scope. */
export class InboxCollector {
  private discovery: OwnWorksDiscovery;
  private diagnosed=new Set<string>();
  private priority:string|undefined;
  private lastPriority:{id:string;at:number}|undefined;
  private priorityNeedsNormal=false;
  private disposed=false;
  constructor(readonly owner: BrowserProfileOwner, readonly mapping: ObservationMapping,
    readonly data: AutomationStore, readonly root: string, readonly mode: "headed" | "headless") {
    this.discovery = new OwnWorksDiscovery(owner.notification, mapping);
  }
  private check(source: CollectionSource, signal: AbortSignal):void {
    const state=this.data.state(),settings=state.collection;
    requireSafe(!this.disposed&&!signal.aborted&&!state.emergencyStopped&&settings&&(source==='works'?settings.comments:settings.inbox),'COLLECTION_CANCELLED');
    this.data.requireAccount(this.mapping.self.uid);
    requireSafe(settings.ownId===this.mapping.self.uid,'ACCOUNT_CHANGED');
  }
  async collect(source:CollectionSource,signal:AbortSignal):Promise<void> {
    this.check(source,signal);
    // One object/page turn, never a whole catalog or inbox inside the account lock.
    await this.owner.actor.run(async()=>{
      this.check(source,signal);
      if(source==='dm'){
        if(preparePreviewRetry(this.data,this.root,!this.priority&&!this.priorityNeedsNormal,id=>this.prioritize(this.mapping.self.uid,id)))this.priorityNeedsNormal=true;
        if(this.priority&&!this.priorityNeedsNormal)await this.previewPriority(signal);
        else{try{await this.dm(signal);}finally{
          if(!signal.aborted&&!this.disposed){this.priorityNeedsNormal=false;finishPreviewNormalTurn(this.data);}
        }}
      }else await this.works(signal);
    },'background');
  }
  prioritize(ownId:string,conversationId:string):boolean {
    const state=this.data.state();
    if(this.disposed||state.emergencyStopped||!state.collection?.inbox||state.collection.ownId!==ownId||ownId!==this.mapping.self.uid||
      this.lastPriority?.id===conversationId&&this.data.now()-this.lastPriority.at<objectRetryMs)return false;
    const own=this.data.store.db.prepare("SELECT own_id FROM accounts WHERE id='account_001'").get() as {own_id:string}|undefined;
    const peer=this.data.store.db.prepare('SELECT own_id,sec_uid FROM discovered_conversations WHERE id=?').get(conversationId) as {own_id:string;sec_uid:string}|undefined;
    const saved=this.data.store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='dm'").get() as {cursor_json:string};
    const cursor=dmCursorSchema.parse(JSON.parse(saved.cursor_json));
    if(own?.own_id!==ownId||peer?.own_id!==ownId||!peer.sec_uid||cursor.deferred.some(item=>item.id===conversationId&&item.until>this.data.now()))return false;
    this.priority=conversationId;return true;
  }
  private async previewPriority(signal:AbortSignal):Promise<void> {
    const id=this.priority!;this.priority=undefined;this.priorityNeedsNormal=true;this.lastPriority={id,at:this.data.now()};
    this.check('dm',signal);
    const saved=this.data.store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='dm'").get() as {cursor_json:string};
    const cursor=dmCursorSchema.parse(JSON.parse(saved.cursor_json));
    if(cursor.deferred.some(item=>item.id===id&&item.until>this.data.now()))return;
    const current=this.data.store.db.prepare('SELECT uid,sec_uid,title FROM discovered_conversations WHERE own_id=? AND id=?')
      .get(this.mapping.self.uid,id) as {uid:string|null;sec_uid:string;title:string}|undefined;
    requireSafe(current,'OBSERVATION_CONVERSATION_CHANGED');
    const reader=new ObservedReader(this.owner.dm,this.mapping,this.data.state().startedAt),peer={uid:current.uid,secUid:current.sec_uid,title:current.title,conversationId:id};
    let top:number|undefined,canRestore=false,restoring=false;
    try{
      top=(await reader.conversations()).scroll?.top;canRestore=true;this.check('dm',signal);
      const messages=await reader.dmWindow(peer,undefined,true);this.check('dm',signal);
      await this.persist('dm',id,messages,signal,peer);
      this.check('dm',signal);restoring=true;await reader.conversations(undefined,top);
    }catch(error){
      const code=error instanceof Blocked?error.code:'DM_THREAD_READ_FAILED';
      if(collectionStops.has(code)||code==='BROWSER_CLOSED'||signal.aborted||this.disposed)throw error;
      this.check('dm',signal);
      // Preserve the complete normal rotation/checkpoints; only the failed object's existing cooldown changes.
      cursor.deferred=cursor.deferred.filter(item=>item.id!==id);cursor.deferred.push({id,until:this.data.now()+objectRetryMs,code});
      this.data.store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='dm'").run(JSON.stringify(cursor));
      await this.diagnose(reader,'dm',code,signal,peer,'HINT');
      if(canRestore&&!restoring)try{await reader.conversations(undefined,top);}catch{/* No second return click if restoration itself failed. */}
      throw new DeferredObjectRead(code);
    }
  }
  private async persist(source:CollectionSource,scope:string,batch:ObservationBatch,signal:AbortSignal,exactPeer?:DiscoveredPeer):Promise<void> {
    this.check(source,signal);
    const display=()=>digest(batch.events.filter(event=>event.observationIssue==='DM_CONTENT_UNVERIFIED').map(event=>[
      event.platformEventId,new MessageShareStore(this.root).read(event,this.mapping.self.uid),new MessagePreviewStore(this.root).list(event,this.mapping.self.uid)]));
    const beforeDisplay=source==='dm'?display():null;
    if(source==='dm')await saveMessagePreviews(this.owner.dm,this.mapping,batch,this.root,signal,exactPeer);
    const displayChanged=source==='dm'&&beforeDisplay!==display();
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
      qualifyLateArrivals(this.data,{source,scope,ownId:this.mapping.self.uid,workIds:this.mapping.works.map(work=>work.id),events:batch.events,evidence,signal});
      if(source==='dm')new ChatMessageStore(this.data.store).observe(batch.events,this.mapping.self.uid,this.data.state().startedAt,this.data.now());
      if(displayChanged)this.data.store.audit('MESSAGE_DISPLAY_CHANGED',digest(['account_001','dm:'+scope]));
    }).immediate();
    requireSafe(!batch.incomplete||!!dmWindowCoverage(batch,this.data.state().startedAt),'OBSERVATION_DM_CONTENT_DOM_NOT_READY');
  }
  private async dmStage<T>(stage:'LIST'|'THREAD'|'ADVANCE',read:()=>Promise<T>):Promise<T> {
    try{return await read();}catch(error){
      if(error instanceof Blocked)throw error;
      throw new Blocked(`DM_${stage}_READ_FAILED`);
    }
  }
  private async diagnose(reader:ObservedReader,source:CollectionSource,code:string,signal:AbortSignal,peer?:DiscoveredPeer,phase:DiagnosticPhase='THREAD'):Promise<void> {
    const key=`${source}:${phase}:${code}${peer?.conversationId?':'+digest(peer.conversationId):''}`;
    if(this.diagnosed.has(key)||Array.from(this.diagnosed).filter(item=>item.startsWith(source+':')).length>=6||
      !['LIST','THREAD','ADVANCE','HINT'].includes(phase)||!/^[A-Z][A-Z0-9_]{1,100}$/.test(code))return;
    this.diagnosed.add(key);
    try{
      this.check(source,signal);
      const report=await reader.diagnostic(source==='works'?'comments':'dm',0,peer);this.check(source,signal);
      const directory=join(this.root,'evidence'),id=randomUUID();await mkdir(directory,{recursive:true});
      const destination=join(directory,`collection-read-${source}-latest.json`),temporary=join(directory,id+'.read-tmp'),dir=await lstat(directory);
      requireSafe(dir.isDirectory()&&!dir.isSymbolicLink(),'DIAGNOSTIC_PATH_UNAVAILABLE');
      try{const file=await lstat(destination);requireSafe(file.isFile()&&!file.isSymbolicLink(),'DIAGNOSTIC_PATH_UNAVAILABLE');}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      try{
        await writeFile(temporary,JSON.stringify({version:1,observedAt:new Date(this.data.now()).toISOString(),phase,code,report}),{flag:'wx',mode:0o600});
        this.check(source,signal);await rename(temporary,destination);
      }finally{await unlink(temporary).catch(()=>{});}
      this.data.store.audit('COLLECTION_READ_DIAGNOSTIC',digest(id),{dm:source==='dm'});
    }catch{/* Diagnostic failure must preserve the primary read failure and its watermarks. */}
  }
  private async advanceDm(reader:ObservedReader,signal:AbortSignal):Promise<void> {
    try{await this.dmStage('ADVANCE',()=>reader.conversations('next'));}catch(error){
      const code=error instanceof Blocked?error.code:'DM_ADVANCE_READ_FAILED';
      if(!collectionStops.has(code)&&code!=='BROWSER_CLOSED'&&!signal.aborted)await this.diagnose(reader,'dm',code,signal,undefined,'ADVANCE');
      throw error;
    }
  }
  private async dmPeer(reader:ObservedReader,cursor:DmCursor,signal:AbortSignal):Promise<DiscoveredPeer|undefined> {
    let batch:ObservationBatch;
    try{batch=await this.dmStage('LIST',()=>reader.conversations());}catch(error){
      const code=error instanceof Blocked?error.code:'DM_LIST_READ_FAILED';
      if(!collectionStops.has(code)&&code!=='BROWSER_CLOSED'&&!signal.aborted)await this.diagnose(reader,'dm',code,signal,undefined,'LIST');
      throw error;
    }
    this.check('dm',signal);
    for(const peer of batch.peers??[]) {
      const old=this.data.store.db.prepare('SELECT own_id,sec_uid FROM discovered_conversations WHERE id=?').get(peer.conversationId) as {own_id:string;sec_uid:string}|undefined;
      requireSafe(!old||old.own_id===this.mapping.self.uid&&old.sec_uid===peer.secUid,'OBSERVATION_CONVERSATION_CHANGED');
      this.data.store.db.prepare(`INSERT INTO discovered_conversations(id,own_id,uid,sec_uid,title,first_seen,last_seen) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,last_seen=excluded.last_seen`).run(peer.conversationId,this.mapping.self.uid,peer.uid,peer.secUid,peer.title,this.data.now(),this.data.now());
    }
    const visible=(batch.peers??[]).map(p=>p.conversationId);
    if(!visible.length)return;
    const candidates=this.data.store.db.prepare(`SELECT * FROM discovered_conversations WHERE own_id=? AND id IN (${visible.map(()=>'?').join(',')}) ORDER BY last_read,first_seen,id`).all(this.mapping.self.uid,...visible) as {
      id:string;uid:string|null;sec_uid:string;title:string;last_read:number;
    }[];
    // Retain failed attempts after cooldown: an old unreadable row must not regain priority over never-attempted peers.
    const attempts=new Map(cursor.deferred.map(item=>[item.id,item.until-objectRetryMs]));
    const known=new Set(cursor.recent);
    const discovered=candidates.filter(candidate=>!known.has(candidate.id)).sort((a,b)=>
      Math.max(a.last_read,attempts.get(a.id)??0)-Math.max(b.last_read,attempts.get(b.id)??0));
    // Newly discovered peers join the persistent rotation rather than overtaking every unfinished peer forever.
    cursor.recent.push(...discovered.map(candidate=>candidate.id));
    const order=new Map(cursor.recent.map((id,index)=>[id,index]));
    candidates.sort((a,b)=>order.get(a.id)!-order.get(b.id)!);
    const deferred=new Set(cursor.deferred.filter(item=>item.until>this.data.now()).map(item=>item.id));
    const next=candidates.find(candidate=>!deferred.has(candidate.id));
    if(!next){await this.advanceDm(reader,signal);return;}
    return {uid:next.uid,secUid:next.sec_uid,conversationId:next.id,title:next.title};
  }
  private dmSweep(peer:DiscoveredPeer,batch:ObservationBatch,prior:DmSweep|undefined,restarted:boolean):DmSweep|undefined {
    const viewport=batch.dmViewport;
    if(!viewport){requireSafe(!restarted,'OBSERVATION_DM_SCROLL_UNAVAILABLE');return;}
    const boundary=this.data.state().startedAt;
    const coverage=dmWindowCoverage(batch,boundary);
    const allOld=!!coverage&&coverage.every(row=>{
      const at=Date.parse(row.occurredAt);return at+row.precisionMs<=boundary;
    });
    const rows=coverage??batch.events.map(event=>({id:event.platformEventId,occurredAt:event.occurredAt}));
    const hasNew=rows.some(row=>{const at=Date.parse(row.occurredAt??'');return Number.isFinite(at)&&at>=boundary;});
    const signature=digest(rows.map(row=>[row.id,row.occurredAt]).sort());
    const ids=rows.map(row=>row.id).filter((id):id is string=>id!==null);
    const anchor=ids.length?{top:viewport.top,height:viewport.height,ids}:undefined;
    if(allOld&&prior?.latest&&prior.latest.maximumTime>=boundary)return;
    // An accurate native chat may reopen at a saved historical position, so an old first window proves neither end.
    if(!prior&&allOld)return {peer,phase:'PROBE_MIN',top:viewport.minimum,height:viewport.height,signature,
      edge:0,legHasNew:false,minimumOld:false,anchor};
    let phase=prior?.phase??'MIN',legHasNew=(prior?.legHasNew??false)||hasNew,minimumOld=prior?.minimumOld??false;
    const atEdge=Math.abs(viewport.top-(phase==='MIN'||phase==='PROBE_MIN'?viewport.minimum:viewport.maximum))<=1;
    let edge=atEdge?(prior?.height===viewport.height&&prior.signature===signature?prior.edge+1:1):0;
    // Scan both physical directions: CSS order alone must not decide which end contains older messages.
    if(phase==='PROBE_MIN'||phase==='PROBE_MAX') {
      if(hasNew){phase=phase==='PROBE_MIN'?'MAX':'MIN';edge=0;legHasNew=true;}
      else if(edge>=2) {
        if(phase==='PROBE_MIN'){phase='PROBE_MAX';minimumOld=allOld;}
        else {if(minimumOld&&allOld)return;phase='MIN';}
        edge=0;legHasNew=false;
      }
    } else if(edge>=2||allOld&&(prior?.legHasNew??false)) {
      if(phase==='MAX')return;
      phase='MAX';edge=0;legHasNew=hasNew;
    }
    const step=Math.max(1,Math.floor(viewport.viewport*0.8));
    const top=phase==='PROBE_MIN'?viewport.minimum:phase==='PROBE_MAX'?viewport.maximum:
      Math.max(viewport.minimum,Math.min(viewport.maximum,viewport.top+(phase==='MIN'?-step:step)));
    return {peer,phase,top,height:viewport.height,signature,edge,legHasNew,minimumOld,anchor};
  }
  private async resumeDm(reader:ObservedReader,peer:DiscoveredPeer,active:DmSweep,messages:ObservationBatch,signal:AbortSignal):Promise<ObservationBatch> {
    const anchor=active.anchor!;
    const ids=(batch:ObservationBatch)=>dmWindowCoverage(batch,this.data.state().startedAt)?.map(row=>row.id)??[];
    const matches=(batch:ObservationBatch)=>ids(batch).some(id=>anchor.ids.includes(id));
    // Preserve new arrivals before leaving a chat that reopened at its latest window.
    await this.persist('dm',peer.conversationId,messages,signal,peer);
    let aligned=messages;
    const initial=messages.dmViewport;requireSafe(initial,'OBSERVATION_DM_SCROLL_UNAVAILABLE');
    const delta=initial.height-anchor.height,direction=initial.minimum<0?-1:1;
    const candidates=[...new Set([anchor.top,anchor.top+direction*delta].map(top=>
      Math.max(initial.minimum,Math.min(initial.maximum,top))))];
    let best:ObservationBatch|undefined,bestScore=0;
    for(const top of candidates) {
      this.check('dm',signal);
      // Sticky or nonvirtual lists can expose the same IDs at many offsets: restore geometry before accepting the ID proof.
      if(!aligned.dmViewport||Math.abs(aligned.dmViewport.top-top)>1) {
        aligned=await reader.dmWindow(peer,top,true);
        await this.persist('dm',peer.conversationId,aligned,signal,peer);
      }
      const score=ids(aligned).filter(id=>anchor.ids.includes(id)).length;
      if(score>bestScore){best=aligned;bestScore=score;}
      if(score===anchor.ids.length)break;
    }
    requireSafe(best&&matches(best),'OBSERVATION_DM_ANCHOR_NOT_FOUND');
    aligned=best;
    const viewport=aligned.dmViewport;requireSafe(viewport,'OBSERVATION_DM_SCROLL_UNAVAILABLE');
    const step=Math.max(1,Math.floor(viewport.viewport*0.8));
    const top=active.phase==='PROBE_MIN'?viewport.minimum:active.phase==='PROBE_MAX'?viewport.maximum:
      Math.max(viewport.minimum,Math.min(viewport.maximum,viewport.top+(active.phase==='MIN'?-step:step)));
    this.check('dm',signal);
    return reader.dmWindow(peer,top,true);
  }
  private async dm(signal:AbortSignal):Promise<void> {
    const reader=new ObservedReader(this.owner.dm,this.mapping,this.data.state().startedAt);
    const saved=this.data.store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='dm'").get() as {cursor_json:string};
    const cursor=dmCursorSchema.parse(JSON.parse(saved.cursor_json));
    const park=(sweep:DmSweep)=>{cursor.parked=cursor.parked.filter(item=>item.peer.conversationId!==sweep.peer.conversationId);cursor.parked.push(sweep);};
    const save=()=>{this.data.store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='dm'").run(JSON.stringify(cursor));};
    if(cursor.activityNeedsNormal){cursor.activityNeedsNormal=false;save();}
    else{
      try{
        if(await readDmActivity(reader,this.data,cursor.activity,signal,(peer,batch)=>this.persist('dm',peer.conversationId,batch,signal,peer),save)){
          cursor.activityNeedsNormal=true;save();return;
        }
      }catch(error){cursor.activityNeedsNormal=true;save();throw error;}
    }
    let active=cursor.sweep&&cursor.burst<2&&!cursor.deferred.some(item=>item.id===cursor.sweep!.peer.conversationId&&item.until>this.data.now())?cursor.sweep:undefined;
    let peer:DiscoveredPeer|undefined;
    if(!active) {
      if(cursor.sweep)park(cursor.sweep);
      delete cursor.sweep;cursor.burst=0;
      peer=await this.dmPeer(reader,cursor,signal);
      if(!peer)return;
      active=cursor.parked.find(item=>item.peer.conversationId===peer!.conversationId);
      cursor.parked=cursor.parked.filter(item=>item.peer.conversationId!==peer!.conversationId);
    }
    if(active) {
      const current=this.data.store.db.prepare('SELECT uid,sec_uid,title FROM discovered_conversations WHERE own_id=? AND id=?')
        .get(this.mapping.self.uid,active.peer.conversationId) as {uid:string|null;sec_uid:string;title:string}|undefined;
      requireSafe(current&&current.sec_uid===active.peer.secUid&&(active.peer.uid===null||current.uid===active.peer.uid),'OBSERVATION_CONVERSATION_CHANGED');
      peer={...active.peer,uid:current.uid,title:current.title};
    }
    if(!peer)return;
    const visited=()=>{cursor.recent=cursor.recent.filter(id=>id!==peer!.conversationId);cursor.recent.push(peer!.conversationId);};
    let nextSweep:DmSweep|undefined;
    try{
      let messages=await this.dmStage('THREAD',()=>reader.dmWindow(peer,undefined,true));
      this.check('dm',signal);
      const completed=!active?cursor.completed.find(item=>item.id===peer.conversationId)?.latest:undefined;
      if(completed&&messages.dmViewport){
        const top=completed.side==='MIN'?messages.dmViewport.minimum:messages.dmViewport.maximum;
        if(Math.abs(messages.dmViewport.top-top)>1)messages=await this.dmStage('THREAD',()=>reader.dmWindow(peer,top,true));
      }
      const incremental=!!completed&&overlapsCompletedDm(messages,completed,this.data.state().startedAt);
      // A changed virtual height invalidates a raw offset. Rescan both ends from the current window instead.
      let prior=active&&messages.dmViewport?.height===active.height?active:undefined;
      if(active?.anchor) {
        messages=await this.dmStage('THREAD',()=>this.resumeDm(reader,peer,active!,messages,signal));
        prior=messages.dmViewport?.height===active.height?active:{...active,edge:0,signature:'',minimumOld:false};
      } else if(prior&&Math.abs(messages.dmViewport!.top-prior.top)>1) {
        const top=prior.top;
        messages=await this.dmStage('THREAD',()=>reader.dmWindow(peer,top,true));
        if(messages.dmViewport?.height!==prior.height)prior=undefined;
      }
      await this.persist('dm',peer.conversationId,messages,signal,peer);
      const native=messages.bindings?.[0];
      if(native) {
        requireSafe(peer.uid===null||peer.uid===native.uid,'OBSERVATION_SENDER_UNVERIFIED');
        this.data.store.db.prepare('UPDATE discovered_conversations SET uid=? WHERE id=?').run(native.uid,peer.conversationId);
        peer.uid=native.uid;
      }
      const latest=latestDmWindow(messages,active?.latest??completed,this.data.state().startedAt);
      nextSweep=incremental?undefined:this.dmSweep(peer,messages,prior,!!active);
      if(nextSweep)nextSweep.latest=latest;
      else if(latest){cursor.completed=cursor.completed.filter(item=>item.id!==peer.conversationId);cursor.completed.push({id:peer.conversationId,latest});cursor.completed=cursor.completed.slice(-1000);}
      if(nextSweep)await this.dmStage('THREAD',()=>reader.scrollDm(peer,nextSweep!.top));
      this.check('dm',signal);
    }
    catch(error){
      const code=error instanceof Blocked?error.code:'DM_THREAD_READ_FAILED';
      if(!collectionStops.has(code)&&code!=='BROWSER_CLOSED'&&!signal.aborted){
        this.check('dm',signal);
        cursor.deferred=cursor.deferred.filter(item=>item.id!==peer.conversationId);
        cursor.deferred.push({id:peer.conversationId,until:this.data.now()+objectRetryMs,code});
        if(code==='OBSERVATION_DM_ANCHOR_NOT_FOUND'&&active?.anchor){
          // The bounded candidates were freshly persisted, but no longer prove this peer's old position.
          if(cursor.sweep?.peer.conversationId===peer.conversationId)delete cursor.sweep;
          cursor.parked=cursor.parked.filter(item=>item.peer.conversationId!==peer.conversationId);
          cursor.completed=cursor.completed.filter(item=>item.id!==peer.conversationId);
        }else if(active)cursor.sweep=active;
        cursor.burst=2;visited();
        this.data.store.db.transaction(()=>{
          this.data.store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='dm'").run(JSON.stringify(cursor));
          this.data.store.audit('DM_READ_DEFERRED',digest(peer.conversationId),{threadReadFailed:true});
        }).immediate();
        await this.diagnose(reader,'dm',code,signal,peer,'THREAD');
        try{this.check('dm',signal);await this.advanceDm(reader,signal);}
        catch(advanceError){
          const advanceCode=advanceError instanceof Blocked?advanceError.code:'DM_ADVANCE_READ_FAILED';
          if(collectionStops.has(advanceCode)||advanceCode==='BROWSER_CLOSED'||signal.aborted)throw advanceError;
        }
        throw new DeferredObjectRead(code);
      }
      throw error;
    }
    cursor.deferred=cursor.deferred.filter(item=>item.id!==peer.conversationId);
    visited();
    // Height/phase resets cannot reset the persisted two-window quantum or erase another peer's checkpoint.
    const yieldPeer=!!nextSweep&&++cursor.burst>=2;
    if(nextSweep&&!yieldPeer)cursor.sweep=nextSweep;
    else {if(nextSweep)park(nextSweep);delete cursor.sweep;cursor.burst=0;}
    this.data.store.db.transaction(()=>{
      if(!nextSweep)this.data.store.db.prepare('UPDATE discovered_conversations SET last_read=? WHERE id=?').run(this.data.now(),peer.conversationId);
      this.data.store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='dm'").run(JSON.stringify(cursor));
    }).immediate();
    if(nextSweep&&!yieldPeer)return;
    this.check('dm',signal);
    await this.advanceDm(reader,signal);
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
      cursor.phase=result.complete?'comments':'discovery';cursor.workIndex=0;cursor.threadBurst=0;
    } else {
      const registered=this.data.store.db.prepare("SELECT id,url FROM discovered_works WHERE own_id=? AND state='INCLUDED' ORDER BY published_at,id").all(this.mapping.self.uid) as {id:string;url:string}[];
      const works=Array.from(new Map([...this.mapping.works,...registered].map(w=>[w.id,w])).values());
      const work=works[cursor.workIndex];
      let done=true;
      if(work) {
        const mapping={...this.mapping,works:[work]};
        const progress=this.data.store.db.prepare('SELECT scroll_top,last_height,end_observations,next_at,last_read FROM work_collection_progress WHERE work_id=?').get(work.id) as {
          scroll_top:number;last_height:number;end_observations:number;next_at:number;last_read:number;
        }|undefined;
        if(progress&&progress.next_at>this.data.now()){
          cursor.threadBurst=0;
          cursor.workIndex++;if(cursor.workIndex>=works.length){cursor.phase='discovery';cursor.workIndex=0;}
          this.data.store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='works'").run(JSON.stringify(cursor));return;
        }
        let batch:ObservationBatch|undefined,threadsPending=false,persisted=false;
        const reader=new ObservedReader(this.owner.notification,mapping,undefined,signal);
        try{
          batch=await reader.comments(0,true,progress?.scroll_top??0,{holdScroll:true,stay:cursor.commentThreads.some(item=>item.workId===work.id&&!item.done&&item.retryAt<=this.data.now())});
          const initial=batch;
          threadsPending=await collectCommentThread(reader,work.id,batch,cursor.commentThreads,this.data.now(),async part=>{
            const ids=new Set(part.events.map(event=>event.platformEventId));
            await this.persist('works',`work:${work.id}`,{...part,events:[...initial.events.filter(event=>!ids.has(event.platformEventId)),...part.events],
              bindings:[...initial.bindings??[],...part.bindings??[]]},signal);persisted=true;
          });
          if(!persisted){await this.persist('works',`work:${work.id}`,batch,signal);persisted=true;}
        }
        catch(error){
          const code=error instanceof Blocked?error.code:'WORK_READ_FAILED_PRIVATE_DIAGNOSTICS';
          if(!collectionStops.has(code)&&code!=='BROWSER_CLOSED'&&!signal.aborted){
            if(batch&&!persisted)await this.persist('works',`work:${work.id}`,batch,signal);
            const next=batch&&/^OBSERVATION_COMMENT_(THREAD|EXPAND)_/.test(code)?await reader.advanceComments(0):undefined;
            cursor.workIndex++;
            cursor.threadBurst=0;
            if(cursor.workIndex>=works.length){cursor.phase='discovery';cursor.workIndex=0;}
            this.data.store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='works'").run(JSON.stringify(cursor));
            this.data.store.audit('WORK_READ_DEFERRED',digest(work.id));
            this.data.store.db.prepare(`INSERT INTO work_collection_progress VALUES(?,0,0,0,?,?,?) ON CONFLICT(work_id)
              DO UPDATE SET last_error=excluded.last_error,next_at=excluded.next_at`).run(work.id,0,code,this.data.now()+objectRetryMs);
            if(next)this.data.store.db.prepare('UPDATE work_collection_progress SET scroll_top=?,last_height=?,end_observations=0 WHERE work_id=?').run(next.top,next.height,work.id);
            await this.diagnose(reader,'works',code,signal,undefined,'THREAD');
            throw new DeferredObjectRead(code);
          }
          throw error;
        }
        const incomplete=cursor.commentThreads.some(item=>item.workId===work.id&&!item.done);
        const yieldWork=threadsPending&&++cursor.threadBurst>=2;
        if(!threadsPending||yieldWork)cursor.threadBurst=0;
        if(yieldWork){cursor.workIndex++;if(cursor.workIndex>=works.length){cursor.phase='discovery';cursor.workIndex=0;}}
        // Checkpoint the unfinished root and rotation before an advance can fail, cancel or close the browser.
        this.data.store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='works'").run(JSON.stringify(cursor));
        const scroll=threadsPending&&!yieldWork?batch.scroll!:await reader.advanceComments(0);
        const end=!threadsPending&&scroll.atEnd&&(progress?.last_height??scroll.height)===scroll.height?(progress?.end_observations??0)+1:0;
        done=end>=2;
        this.data.store.db.prepare(`INSERT INTO work_collection_progress VALUES(?,?,?,?,?,?,0) ON CONFLICT(work_id)
          DO UPDATE SET scroll_top=excluded.scroll_top,last_height=excluded.last_height,end_observations=excluded.end_observations,last_read=excluded.last_read,last_error=excluded.last_error,next_at=0`)
          .run(work.id,done?0:scroll.top,scroll.height,done?0:end,incomplete?progress?.last_read??0:this.data.now(),incomplete?'OBSERVATION_COMMENT_THREAD_INCOMPLETE':null);
      }
      if(done)cursor.workIndex++;
      if(cursor.workIndex>=works.length){cursor.phase='discovery';cursor.workIndex=0;}
    }
    this.data.store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='works'").run(JSON.stringify(cursor));
  }
  dispose():void {this.disposed=true;this.priority=undefined;this.discovery.dispose();}
}
