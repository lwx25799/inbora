import {Blocked,digest,isStrong,requireSafe,targetKey,type InboundEvent,type ReplyAdapter,type TargetSnapshot} from '../core/contracts.js';
import {lstat,mkdir,rename,unlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {EventStore} from '../storage/store.js';
import type {WorkbenchAuthority} from './authority.js';
import type {BrowserService} from './browser-service.js';
import {collectionStops} from './collection-scheduler.js';
import {sendParamsSchema,type BrowserDraftChoice,type ClientCommand} from './contracts.js';

interface SavedDraftAdapter extends ReplyAdapter {
  readSavedDraft(event:InboundEvent):Promise<{text:string;snapshot:TargetSnapshot}>;
  clearSavedDraft(event:InboundEvent,text:string):Promise<void>;
  locateSavedDraft?(event:InboundEvent,signal:AbortSignal):Promise<void>;
}
function supported(adapter:ReplyAdapter):adapter is SavedDraftAdapter {
  return typeof (adapter as Partial<SavedDraftAdapter>).readSavedDraft==='function'&&typeof (adapter as Partial<SavedDraftAdapter>).clearSavedDraft==='function';
}
const unavailable='BROWSER_DRAFT_NOT_RECOVERABLE';
class RecoveryRejection extends Blocked {
  constructor(readonly bucket:'dbRejected'|'readFailures',readonly reason:string,code=unavailable){super(code);}
}
function gate(ok:unknown,bucket:RecoveryRejection['bucket'],reason:string,code=unavailable):asserts ok {
  if(!ok)throw new RecoveryRejection(bucket,reason,code);
}
const frameCodes=new Set(['NATIVE_REPLY_ORIGINAL_CHANGED','NATIVE_REPLY_CONVERSATION_CHANGED','NATIVE_REPLY_ACCOUNT_CHANGED',
  'NATIVE_REPLY_DOM_CHANGED','NATIVE_REPLY_COMPOSER_CONFLICT','NATIVE_REPLY_EDITOR_CHANGED','NATIVE_REPLY_EDITOR_UNSUPPORTED',
  'NATIVE_REPLY_EDITOR_MEDIA','NATIVE_REPLY_EDITOR_TOO_COMPLEX','NATIVE_REPLY_EDITOR_MARKER_CHANGED','NATIVE_REPLY_METADATA_MISSING',
  'NATIVE_REPLY_ACCESSOR_UNSUPPORTED','NATIVE_REPLY_FIELD_CONFLICT','NATIVE_REPLY_MESSAGE_CONFLICT','NATIVE_REPLY_DIRECTION_CONFLICT',
  'NATIVE_REPLY_MESSAGE_TEXT_CONFLICT','NATIVE_REPLY_MESSAGE_TEXT_UNVERIFIED','NATIVE_REPLY_MESSAGE_STATE_MISSING',
  'NATIVE_REPLY_MESSAGE_ID_COLLISION','NATIVE_REPLY_WINDOW_UNVERIFIED','NATIVE_REPLY_LATEST_END_MISSING','NATIVE_REPLY_PAGE_BLOCKED',
  'NATIVE_REPLY_SAVED_DRAFT_SCOPE_REQUIRED','OBSERVATION_EXISTING_HUMAN_INPUT','BROWSER_DRAFT_INSPECTION_CANCELLED','INVALID_TEXT']);
const locatable=new Set(['NATIVE_REPLY_DOM_CHANGED','NATIVE_REPLY_CONVERSATION_CHANGED','NATIVE_REPLY_ORIGINAL_CHANGED',
  'NATIVE_REPLY_METADATA_MISSING','NATIVE_REPLY_WINDOW_UNVERIFIED','NATIVE_REPLY_LATEST_END_MISSING']);
interface RecoveryDiagnostic {
  version:1;at:string;phase:'BROWSER_UNAVAILABLE'|'CANDIDATES'|'FRAME'|'LOCATE'|'MATCHED'|'NO_MATCH'|'AMBIGUOUS'|'FAILED';
  candidateLimit:number;candidates:number;dbAccepted:number;frames:number;locations:number;matches:number;
  dbRejected:Record<string,number>;readFailures:Record<string,number>;
}

/** Explicit user recovery only. It never creates, retries, approves or submits a send command. */
export class BrowserDraftRecovery {
  constructor(readonly store:EventStore,readonly authority:WorkbenchAuthority,readonly browser:BrowserService){}
  hasStartupCandidate():boolean{
    return !!this.store.db.prepare(`SELECT d.id FROM reply_drafts d JOIN draft_revisions r ON r.draft_id=d.id AND r.version=d.version
      JOIN manual_send_commands c ON c.event_id=d.event_id JOIN policy_commands p ON p.command_id=c.command_id
      WHERE r.origin='AUTO_POLICY' AND d.status IN ('DRAFT','APPROVED') AND length(d.text)>0 AND c.status='FAILED_BEFORE_CLICK'
      AND c.intent_id IS NULL AND NOT EXISTS(SELECT 1 FROM send_intents i WHERE i.event_id=d.event_id) LIMIT 1`).get();
  }
  private candidate(eventId:string):BrowserDraftChoice{
    const event=this.store.event(eventId),payload=event.payload,draft=this.authority.draftFor(eventId);
    gate(payload.channel==='DIRECT_MESSAGE'&&isStrong(payload)&&!!payload.conversationId,'dbRejected','EVENT_NOT_STRONG_DM');
    gate(draft&&draft.text.trim()&&['DRAFT','APPROVED'].includes(draft.status),'dbRejected','DRAFT_STATE_OR_EMPTY');
    gate(['AWAITING_APPROVAL','APPROVED'].includes(event.status),'dbRejected','EVENT_STATE');
    const own=this.store.db.prepare('SELECT own_id FROM accounts WHERE id=?').get(payload.accountId) as {own_id:string}|undefined;
    gate(own&&payload.actorId!==own.own_id,'dbRejected','ACCOUNT');
    const revision=this.store.db.prepare('SELECT origin,text FROM draft_revisions WHERE draft_id=? AND version=?').get(draft.id,draft.version) as {origin:string;text:string}|undefined;
    gate(revision?.origin==='AUTO_POLICY'&&revision.text===draft.text,'dbRejected','DRAFT_ORIGIN_OR_VERSION');
    gate(!this.store.db.prepare('SELECT id FROM send_intents WHERE event_id=?').get(eventId),'dbRejected','EVENT_INTENT');
    gate(!this.store.sendFrozen(eventId),'dbRejected','TARGET_FROZEN');
    gate(!this.store.db.prepare('SELECT id FROM source_collisions WHERE event_id=?').get(eventId),'dbRejected','SOURCE_COLLISION');
    gate(!this.store.db.prepare(`SELECT c.command_id FROM manual_send_commands c JOIN inbound_events e ON e.id=c.event_id
      WHERE e.target_key=? AND c.status IN ('PREPARING','QUEUED','PREFLIGHT','SENDING')`).get(targetKey(payload)),'dbRejected','COMMAND_IN_FLIGHT');
    const commands=this.store.db.prepare(`SELECT c.params,c.params_digest FROM manual_send_commands c JOIN policy_commands p ON p.command_id=c.command_id
      WHERE c.event_id=? AND c.status='FAILED_BEFORE_CLICK' AND c.intent_id IS NULL ORDER BY c.created_at DESC LIMIT 10`).all(eventId) as {params:string;params_digest:string}[];
    gate(commands.some(command=>{let raw:unknown;try{raw=JSON.parse(command.params);}catch{return false;}
      const parsed=sendParamsSchema.safeParse(raw);return parsed.success&&digest(parsed.data)===command.params_digest&&parsed.data.eventId===eventId&&
        parsed.data.draftId===draft.id&&parsed.data.draftVersion===draft.version&&parsed.data.text===draft.text;}),'dbRejected','FAILED_POLICY_COMMAND');
    return {eventId,draftId:draft.id,draftVersion:draft.version,text:draft.text,contextVersion:this.authority.contextVersion(event),
      author:payload.actorName,conversationId:payload.conversationId,originalText:payload.text};
  }
  private same(choice:BrowserDraftChoice):void{
    requireSafe(digest(this.candidate(choice.eventId))===digest(choice),'BROWSER_DRAFT_CHANGED');
  }
  private async read(adapter:SavedDraftAdapter,choice:BrowserDraftChoice):Promise<void>{
    const event=this.store.event(choice.eventId),current=await adapter.readSavedDraft(event.payload),snapshot=current.snapshot;
    const own=this.store.db.prepare('SELECT own_id FROM accounts WHERE id=?').get(event.payload.accountId) as {own_id:string}|undefined;
    gate(current.text!=='','readFailures','EMPTY_EDITOR','BROWSER_DRAFT_NOT_MATCHED');
    gate(current.text===choice.text,'readFailures','TEXT_MISMATCH','BROWSER_DRAFT_NOT_MATCHED');
    gate(own&&snapshot.ownId===own.own_id&&snapshot.accountId===event.payload.accountId&&snapshot.eventBinding===event.binding&&
      snapshot.targetKey===targetKey(event.payload)&&snapshot.composerKey===snapshot.targetKey,'readFailures','IDENTITY_OR_TARGET_MISMATCH','BROWSER_DRAFT_NOT_MATCHED');
    this.same(choice);
  }
  async available(token:string,signal:AbortSignal=AbortSignal.timeout(30_000)):Promise<BrowserDraftChoice|null>{
    this.authority.operator(token,'READ');
    const report:RecoveryDiagnostic={version:1,at:new Date().toISOString(),phase:'BROWSER_UNAVAILABLE',candidateLimit:10,candidates:0,
      dbAccepted:0,frames:0,locations:0,matches:0,dbRejected:{},readFailures:{}};
    try{
    if(this.browser.loginRecovery||!this.browser.status().state.startsWith('OPEN'))return null;
    const epoch=this.browser.ownerEpoch;
    const candidates=this.store.db.prepare(`SELECT d.event_id FROM reply_drafts d JOIN draft_revisions r ON r.draft_id=d.id AND r.version=d.version
      WHERE r.origin='AUTO_POLICY' AND d.status IN ('DRAFT','APPROVED') AND length(d.text)>0
      AND NOT EXISTS(SELECT 1 FROM send_intents i WHERE i.event_id=d.event_id) ORDER BY r.saved_at DESC LIMIT 10`).all() as {event_id:string}[];
    report.phase='CANDIDATES';report.candidates=candidates.length;
    return await this.browser.actor.run(async()=>{
      requireSafe(this.browser.ownerEpoch===epoch&&!this.browser.loginRecovery&&this.browser.status().state.startsWith('OPEN'),'BROWSER_NOT_RUNNING');
      for(const row of candidates){let dispose=()=>{};
        try{requireSafe(!signal.aborted,'BROWSER_DRAFT_INSPECTION_CANCELLED');const choice=this.candidate(row.event_id);report.dbAccepted++;report.phase='FRAME';
          const handle=await this.browser.adapter(this.store.event(row.event_id).payload,this.store);dispose=handle.dispose;
          requireSafe(this.browser.ownerEpoch===epoch&&!this.browser.loginRecovery,'BROWSER_CLOSED');
          gate(supported(handle.adapter),'readFailures','ADAPTER_UNSUPPORTED');report.frames++;
          try{await this.read(handle.adapter,choice);}
          catch(error){
            if(!(error instanceof Blocked)||!locatable.has(error.code)||!handle.adapter.locateSavedDraft||report.locations>=2)throw error;
            requireSafe(!signal.aborted,'BROWSER_DRAFT_INSPECTION_CANCELLED');report.phase='LOCATE';report.locations++;
            await handle.adapter.locateSavedDraft(this.store.event(row.event_id).payload,signal);
            requireSafe(!signal.aborted&&this.browser.ownerEpoch===epoch&&!this.browser.loginRecovery,'BROWSER_DRAFT_INSPECTION_CANCELLED');
            report.phase='FRAME';report.frames++;await this.read(handle.adapter,choice);
          }
          requireSafe(!signal.aborted,'BROWSER_DRAFT_INSPECTION_CANCELLED');report.matches++;report.phase='MATCHED';return choice;
        }catch(error){
          const bucket=error instanceof RecoveryRejection?error.bucket:'readFailures',reason=error instanceof RecoveryRejection?error.reason:
            error instanceof Blocked&&frameCodes.has(error.code)?'READ_FRAME_'+error.code:'READ_FRAME_UNCLASSIFIED';
          report[bucket][reason]=(report[bucket][reason]??0)+1;
          if(!(error instanceof Blocked)||collectionStops.has(error.code)||['BROWSER_NOT_RUNNING','BROWSER_CLOSED','LOGIN_RECOVERY_IN_PROGRESS'].includes(error.code))throw error;
          if(signal.aborted||error instanceof RecoveryRejection&&['TEXT_MISMATCH','IDENTITY_OR_TARGET_MISMATCH'].includes(error.reason)||
            error.code==='OBSERVATION_EXISTING_HUMAN_INPUT'){report.phase='NO_MATCH';return null;}
          /* A nonmatching current page cannot authorize another target. */}
        finally{dispose();}
      }
      report.phase='NO_MATCH';return null;
    });
    }catch(error){report.phase='FAILED';throw error;}
    finally{await this.diagnostic(report);}
  }
  private async diagnostic(report:RecoveryDiagnostic):Promise<void>{
    const directory=join(this.browser.root,'evidence'),file=join(directory,'browser-draft-recovery-latest.json'),temporary=join(directory,randomUUID()+'.recovery-tmp');
    try{
      await mkdir(directory,{recursive:true});const dir=await lstat(directory);if(!dir.isDirectory()||dir.isSymbolicLink())return;
      try{const existing=await lstat(file);if(!existing.isFile()||existing.isSymbolicLink())return;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')return;}
      await writeFile(temporary,JSON.stringify(report),{flag:'wx',mode:0o600});await rename(temporary,file);
    }catch{/* A private diagnostic cannot change recovery eligibility or expose a raw filesystem error. */}
    finally{await unlink(temporary).catch(()=>{});}
  }
  async clear(token:string,input:Extract<ClientCommand,{command:'browser';action:'clearSavedDraftRecovery'}>):Promise<{cleared:true}>{
    this.authority.operator(token,'CONTROL');requireSafe(!this.browser.loginRecovery&&this.browser.status().state.startsWith('OPEN'),'BROWSER_NOT_RUNNING');
    const epoch=this.browser.ownerEpoch;
    return this.browser.actor.run(async()=>{
      requireSafe(this.browser.ownerEpoch===epoch&&!this.browser.loginRecovery&&this.browser.status().state.startsWith('OPEN'),'BROWSER_NOT_RUNNING');
      const choice=this.candidate(input.eventId);
      requireSafe(choice.draftId===input.draftId&&choice.draftVersion===input.draftVersion&&choice.text===input.expectedText&&choice.contextVersion===input.contextVersion,'BROWSER_DRAFT_CHANGED');
      const event=this.store.event(input.eventId),handle=await this.browser.adapter(event.payload,this.store);
      try{
        requireSafe(supported(handle.adapter),unavailable);await this.read(handle.adapter,choice);this.same(choice);
        requireSafe(this.browser.ownerEpoch===epoch&&!this.browser.loginRecovery,'BROWSER_CLOSED');
        await handle.adapter.clearSavedDraft(event.payload,choice.text);
        this.store.audit('USER_CLEARED_SAVED_BROWSER_DRAFT',choice.draftId,{version:choice.draftVersion});return {cleared:true};
      }finally{handle.dispose();}
    });
  }
}
