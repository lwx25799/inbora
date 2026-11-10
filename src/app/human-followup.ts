import {randomUUID} from 'node:crypto';
import {digest,requireSafe,validText,isStrong,targetKey,validManualMediaProof,type Draft,type TargetSnapshot,type SendProof} from '../core/contracts.js';
import {SendCoordinator} from '../core/send-coordinator.js';
import type {EventStore} from '../storage/store.js';
import type {WorkbenchAuthority} from './authority.js';
import type {BrowserService} from './browser-service.js';
import type {z} from 'zod';
import type {humanReplySchema} from './contracts.js';
import {humanReplyEligibility} from './manual-reply-eligibility.js';

type Input=z.infer<typeof humanReplySchema>;
interface Turn {command_id:string;event_id:string;target_key:string;operator_id:string;input_digest:string;params:string;text:string;version:number;
  status:string;approval:string|null;intent_id:string|null;attempt_started_at:string|null;reason:string|null;proof_ref:string|null;
  verified_at:string|null;native_id_digest:string|null;created_at:number}
interface NextDraft {event_id:string;id:string;text:string;version:number;operator_id:string;saved_at:number}

export class HumanFollowups {
  constructor(readonly store:EventStore,readonly authority:WorkbenchAuthority,readonly browser:BrowserService,
    readonly closing:()=>boolean,readonly emit:()=>void,readonly errorCode:(e:unknown)=>string){}
  present(){return !!this.store.db.prepare("SELECT name FROM sqlite_master WHERE name='human_reply_turns'").get();}
  originalConfirmed(eventId:string):boolean {
    const latest=this.store.db.prepare(`SELECT v.verified FROM verification_results v JOIN send_intents i ON i.id=v.intent_id
      WHERE i.event_id=? ORDER BY v.rowid DESC LIMIT 1`).get(eventId) as {verified:number}|undefined;
    const intent=this.store.db.prepare('SELECT status FROM send_intents WHERE event_id=?').get(eventId) as {status:string}|undefined;
    return !!intent&&(latest?latest.verified===1:intent.status==='CONFIRMED');
  }
  turn(id:string):Turn|undefined{return this.present()?this.store.db.prepare('SELECT * FROM human_reply_turns WHERE command_id=?').get(id) as Turn|undefined:undefined;}
  latest(eventId:string){return this.present()?this.store.db.prepare('SELECT * FROM human_reply_turns WHERE event_id=? ORDER BY rowid DESC LIMIT 1').get(eventId) as Turn|undefined:undefined;}
  currentDraft(eventId:string){return this.store.db.prepare('SELECT * FROM human_reply_drafts WHERE event_id=?').get(eventId) as NextDraft|undefined;}
  view(eventId:string){
    if(!this.present())return null;
    const row=this.currentDraft(eventId),turn=this.latest(eventId),confirmed=this.originalConfirmed(eventId),key=targetKey(this.store.event(eventId).payload);
    const blocked=!!this.store.db.prepare("SELECT command_id FROM human_reply_turns WHERE target_key=? AND status IN ('PREPARING','APPROVED','INTENT_RECORDED','UNCERTAIN') LIMIT 1").get(key);
    const frozen=this.store.sendFrozen(eventId),paused=(this.store.db.prepare('SELECT paused FROM pauses WHERE target_key=?').get(key) as {paused:number}|undefined)?.paused;
    return {eligible:confirmed&&!blocked&&!frozen&&!paused,reason:!confirmed?'FOLLOWUP_REQUIRES_CONFIRMED_REPLY':blocked?'FOLLOWUP_REPLY_UNRESOLVED':frozen?'TARGET_FROZEN':paused?'TARGET_PAUSED':null,
      draft:row?{id:row.id,eventId,text:row.text,version:row.version,model:'human',status:'DRAFT' as const,approval:null,origin:'HUMAN_TYPED'}:null,
      latestTurn:turn?{commandId:turn.command_id,status:turn.status,reason:turn.reason,intentId:turn.intent_id,verifiedAt:turn.verified_at,text:turn.text}:null};
  }
  private editable(token:string,eventId:string,generation:number){
    requireSafe(this.present(),'FOLLOWUP_NOT_READY');
    const event=this.store.event(eventId);this.authority.requireOwner(token,event,generation);
    requireSafe(this.authority.mode()!=='OBSERVE','OBSERVE_READ_ONLY');
    requireSafe(this.originalConfirmed(eventId),'FOLLOWUP_REQUIRES_CONFIRMED_REPLY');
    requireSafe(!this.store.db.prepare("SELECT command_id FROM human_reply_turns WHERE target_key=? AND status IN ('PREPARING','APPROVED','INTENT_RECORDED','UNCERTAIN') LIMIT 1").get(targetKey(event.payload)),
      'FOLLOWUP_REPLY_UNRESOLVED');
    return event;
  }
  save(token:string,eventId:string,generation:number,expectedVersion:number,text:string,suggestionId:string|null){
    requireSafe(suggestionId===null,'FOLLOWUP_HUMAN_TEXT_REQUIRED');text=text.replace(/\r\n?/gu,'\n');if(text)validText(text);
    this.store.db.transaction(()=>{
      this.editable(token,eventId,generation);const old=this.currentDraft(eventId);
      requireSafe((old?.version??0)===expectedVersion,'DRAFT_VERSION_CONFLICT');
      const op=this.authority.operator(token,'EDIT');
      this.store.db.prepare(`INSERT INTO human_reply_drafts VALUES(?,?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET
        text=excluded.text,version=excluded.version,operator_id=excluded.operator_id,saved_at=excluded.saved_at`)
        .run(eventId,old?.id??randomUUID(),text,expectedVersion+1,op.id,this.authority.now());
    }).immediate();return this.view(eventId)!.draft!;
  }
  queue(token:string,id:string,input:Input):boolean {
    const op=this.authority.operator(token,'SEND'),prior=this.turn(id);
    if(prior){requireSafe(prior.operator_id===op.id&&prior.input_digest===digest(input),'COMMAND_PARAMETERS_CONFLICT');return false;}
    requireSafe(!this.store.db.prepare('SELECT command_id FROM manual_send_commands WHERE command_id=?').get(id),'COMMAND_PARAMETERS_CONFLICT');
    return this.store.db.transaction(()=>{
      const event=this.editable(token,input.eventId,input.generation);this.authority.requireSelection(token,event.id,input.selectionId);
      requireSafe(input.suggestionId===null,'FOLLOWUP_HUMAN_TEXT_REQUIRED');validText(input.text);
      requireSafe(this.authority.contextVersion(event)===input.contextVersion,'CONTEXT_VERSION_CONFLICT');
      const old=this.currentDraft(event.id);requireSafe((old?.version??0)===input.expectedVersion,'DRAFT_VERSION_CONFLICT');
      const draft=old&&old.text===input.text?old:this.save(token,event.id,input.generation,input.expectedVersion,input.text,null);
      const params={...input,text:input.text.replace(/\r\n?/gu,'\n')};
      this.store.db.prepare(`INSERT INTO human_reply_turns VALUES(?,?,?,?,?,?,?,?,'PREPARING',NULL,NULL,NULL,NULL,NULL,NULL,NULL,?)`)
        .run(id,event.id,targetKey(event.payload),op.id,digest(input),JSON.stringify(params),params.text,draft.version,this.authority.now());
      this.guard(token,id);
      this.store.db.prepare('UPDATE human_reply_drafts SET text=?,version=version+1,saved_at=? WHERE event_id=?').run('',this.authority.now(),event.id);
      this.store.audit('HUMAN_FOLLOWUP_REQUESTED',id);return true;
    }).immediate();
  }
  guard(token:string,id:string,approved=false):void {
    requireSafe(!this.closing(),'CLIENT_CLOSING');requireSafe(!this.browser.loginRecovery,'LOGIN_RECOVERY_IN_PROGRESS');
    const turn=this.turn(id);requireSafe(turn,'COMMAND_NOT_FOUND');const input=JSON.parse(turn.params) as Input,event=this.store.event(turn.event_id);
    requireSafe(['PREPARING',...(approved?['APPROVED']:[])].includes(turn.status),'COMMAND_NOT_QUEUED');
    const op=this.authority.operator(token,'SEND');this.authority.operator(token,'APPROVE');
    requireSafe(op.id===turn.operator_id,'OPERATOR_PERMISSION_DENIED');this.authority.requireOwner(token,event,input.generation);
    this.authority.requireSelection(token,event.id,input.selectionId);
    requireSafe(!this.authority.paused(),'ACCOUNT_PAUSED');
    requireSafe(['MANUAL','AI_ASSISTED','LIMITED_AUTO'].includes(this.authority.mode()),'MODE_DRAFT_ONLY');
    requireSafe(this.originalConfirmed(event.id),'FOLLOWUP_REQUIRES_CONFIRMED_REPLY');
    requireSafe(!this.store.sendFrozen(event.id),'TARGET_FROZEN');
    requireSafe(!(this.store.db.prepare('SELECT paused FROM pauses WHERE target_key=?').get(turn.target_key) as {paused:number}|undefined)?.paused,'TARGET_PAUSED');
    requireSafe(!this.store.db.prepare("SELECT command_id FROM human_reply_turns WHERE target_key=? AND command_id<>? AND status IN ('PREPARING','APPROVED','INTENT_RECORDED','UNCERTAIN') LIMIT 1").get(turn.target_key,id),'COMMAND_ALREADY_QUEUED');
    requireSafe(this.authority.contextVersion(event)===input.contextVersion,'CONTEXT_VERSION_CONFLICT');
    requireSafe(humanReplyEligibility(this.store,event).eligible,'TARGET_NEEDS_REVIEW');
    if(approved)requireSafe(this.authority.capability(event.payload.channel,this.browser.identity(event.payload.channel)).state==='SEND_AVAILABLE','CHANNEL_NOT_SENDABLE');
  }
  result(token:string,id:string){
    const row=this.turn(id);requireSafe(row,'COMMAND_NOT_FOUND');this.authority.operator(token);
    return {commandId:id,status:row.status==='INTENT_RECORDED'?'SENDING':row.status==='APPROVED'?'QUEUED':row.status,intentId:row.intent_id,reason:row.reason};
  }
  recover(){
    if(!this.present())return;
    this.store.db.transaction(()=>{
      this.store.db.prepare("UPDATE human_reply_turns SET status='FAILED_BEFORE_CLICK',reason='RESTART_NO_REPLAY' WHERE status IN ('PREPARING','APPROVED')").run();
      this.store.db.prepare(`UPDATE human_reply_drafts SET text=(SELECT t.text FROM human_reply_turns t WHERE t.event_id=human_reply_drafts.event_id
        AND t.status='FAILED_BEFORE_CLICK' AND t.reason='RESTART_NO_REPLAY' AND human_reply_drafts.version=t.version+1 ORDER BY t.rowid DESC LIMIT 1),
        version=version+1 WHERE text='' AND EXISTS(SELECT 1 FROM human_reply_turns t WHERE t.event_id=human_reply_drafts.event_id
        AND t.status='FAILED_BEFORE_CLICK' AND t.reason='RESTART_NO_REPLAY' AND human_reply_drafts.version=t.version+1)`).run();
      const unresolved=this.store.db.prepare("SELECT command_id FROM human_reply_turns WHERE status='INTENT_RECORDED'").all() as {command_id:string}[];
      for(const row of unresolved)this.receipt(row.command_id,'UNCERTAIN','RESTART_WITH_UNFINISHED_INTENT');
    }).immediate();
  }
  async prepare(token:string,id:string){
    let dispose=()=>{};
    try{
      this.guard(token,id);const row=this.turn(id)!,event=this.store.event(row.event_id);
      const handle=await this.browser.adapter(event.payload,this.store,undefined,{manualMedia:!isStrong(event.payload)});dispose=handle.dispose;
      await this.browser.refreshIdentity(event.payload.channel);
      await this.browser.actor.run(async()=>{
        this.guard(token,id);const before=digest(this.browser.identity(event.payload.channel));
        const capabilities=digest(this.store.db.prepare('SELECT * FROM channel_capabilities WHERE channel=?').all(event.payload.channel));
        const snapshot=await handle.adapter.inspect(event.payload),identity=await this.browser.refreshIdentity(event.payload.channel);
        this.guard(token,id);requireSafe(identity&&digest(identity)===before,'CAPABILITY_CHANGED_DURING_CHECK');
        const own=(this.store.db.prepare('SELECT own_id FROM accounts WHERE id=?').get(event.payload.accountId) as {own_id:string}).own_id;
        requireSafe(snapshot.ownId===own&&identity.identityDigest===digest(own)&&snapshot.accountId===event.payload.accountId&&
          snapshot.eventBinding===event.binding&&snapshot.targetKey===row.target_key&&snapshot.composerKey===row.target_key,'TARGET_CHANGED');
        if(!isStrong(event.payload))requireSafe(validManualMediaProof(event.payload,snapshot),'HUMAN_MEDIA_APPROVAL_REQUIRED');
        requireSafe(capabilities===digest(this.store.db.prepare('SELECT * FROM channel_capabilities WHERE channel=?').all(event.payload.channel)),'CAPABILITY_CHANGED_DURING_CHECK');
        this.authority.attest(event.payload.channel,'SEND_AVAILABLE',identity,`readonly-contract:${digest(snapshot)}`);
        this.store.db.prepare("UPDATE human_reply_turns SET status='APPROVED',approval=? WHERE command_id=? AND status='PREPARING'")
          .run(JSON.stringify({version:row.version,textDigest:digest(row.text),snapshot}),id);
      });
      const ledger=this.ledger(id);
      await new SendCoordinator(ledger,this.browser.actor).send(id,handle.adapter,true,{check:()=>this.guard(token,id,true),committed:()=>{},manualMedia:()=>{
        requireSafe(humanReplyEligibility(this.store,event).eligible,'HUMAN_MEDIA_APPROVAL_REQUIRED');
      }});
    }catch(error){
      const row=this.turn(id);if(row&&!row.intent_id)this.store.db.transaction(()=>{
        this.store.db.prepare("UPDATE human_reply_turns SET status='FAILED_BEFORE_CLICK',reason=? WHERE command_id=?").run(this.errorCode(error),id);
        this.store.db.prepare("UPDATE human_reply_drafts SET text=?,version=version+1,saved_at=? WHERE event_id=? AND text='' AND version=?")
          .run(row.text,this.authority.now(),row.event_id,row.version+1);
      }).immediate();
    }finally{dispose();this.emit();}
  }
  private ledger(id:string){
    return {
      draft:(_draftId:string):Draft=>{
        const r=this.turn(id)!;return {id,eventId:r.event_id,text:r.text,version:r.version,model:'human',status:r.status==='APPROVED'?'APPROVED':'DRAFT',
          approval:r.approval?JSON.parse(r.approval):null};
      },
      event:(eventId:string)=>({...this.store.event(eventId),status:'APPROVED' as const}),
      assertSendable:(_eventId:string)=>requireSafe(this.turn(id)?.status==='APPROVED','EVENT_NOT_APPROVED'),
      hasIntentForDraft:(_draftId:string)=>!!this.turn(id)?.intent_id,
      audit:(...args:Parameters<EventStore['audit']>)=>this.store.audit(...args),
      invalidateApproval:(_draftId:string)=>{this.store.db.prepare("UPDATE human_reply_turns SET status='FAILED_BEFORE_CLICK',approval=NULL WHERE command_id=? AND intent_id IS NULL").run(id);},
      recordIntent:(_draftId:string,snapshot:TargetSnapshot,real:boolean,authority?:{check():void;committed(id:string):void;manualMedia?():void})=>this.store.db.transaction(()=>{
        requireSafe(authority,'CLIENT_AUTHORITY_REQUIRED');authority.check();const row=this.turn(id)!;
        const approval=row.approval?JSON.parse(row.approval) as Draft['approval']:null;
        requireSafe(row.status==='APPROVED'&&!row.intent_id&&approval&&approval.version===row.version&&approval.textDigest===digest(row.text)&&
          digest(approval.snapshot)===digest(snapshot),'APPROVAL_INVALID');
        if(!isStrong(this.store.event(row.event_id).payload)){requireSafe(authority.manualMedia&&validManualMediaProof(this.store.event(row.event_id).payload,snapshot),'HUMAN_MEDIA_APPROVAL_REQUIRED');authority.manualMedia();}
        if(real)this.store.consumeBudget('SEND');const intent=randomUUID();
        this.store.db.prepare("UPDATE human_reply_turns SET status='INTENT_RECORDED',intent_id=?,attempt_started_at=? WHERE command_id=?")
          .run(intent,new Date().toISOString(),id);this.store.audit('HUMAN_FOLLOWUP_CLICK_INTENT',id);authority.committed(intent);return intent;
      }).immediate(),
      intentBoundary:(_intentId:string)=>{const r=this.turn(id);requireSafe(r?.attempt_started_at,'INTENT_NOT_FOUND');return r.attempt_started_at;},
      receipt:(_intentId:string,result:'CONFIRMED'|'UNCERTAIN',ref:string,proof?:SendProof)=>this.receipt(id,result,ref,proof),
    };
  }
  private receipt(id:string,result:'CONFIRMED'|'UNCERTAIN',ref:string,proof?:SendProof){
    this.store.db.transaction(()=>{
      const row=this.turn(id);requireSafe(row?.intent_id&&['INTENT_RECORDED','UNCERTAIN'].includes(row.status),'INTENT_NOT_REVIEWABLE');
      this.store.db.prepare('UPDATE human_reply_turns SET status=?,proof_ref=?,verified_at=?,native_id_digest=?,reason=? WHERE command_id=?')
        .run(result,ref,new Date().toISOString(),proof?.id?digest(proof.id):null,result==='UNCERTAIN'?ref:null,id);
      if(proof?.submission||proof?.clockSkew)this.store.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?)')
        .run(randomUUID(),new Date().toISOString(),'HUMAN_FOLLOWUP_PROOF',id,JSON.stringify({
          submission:proof.submission,clockSkew:proof.clockSkew?{...proof.clockSkew,refreshedId:undefined}:undefined,
          nativeIdDigest:digest(proof.id),proofDigest:digest(proof)}));
      // Compatibility stop. Older code needs followup-aware resume logic before rollback can clear this target.
      if(result==='UNCERTAIN')this.store.db.prepare('INSERT INTO pauses VALUES(?,1) ON CONFLICT(target_key) DO UPDATE SET paused=1').run(row.target_key);
      this.store.audit('HUMAN_FOLLOWUP_'+result,id);
    }).immediate();
  }
}
