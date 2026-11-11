import {digest,eventBinding,isStrong,requireSafe,targetKey,type StoredEvent} from '../core/contracts.js';
import {localAssistantScopeSchema,localAssistantStoredScopeSchema,type LocalAssistantGrant,
  type LocalAssistantPermission,type LocalAssistantScope,type LocalAssistantState} from '../app/local-assistant-contracts.js';
import {AutomationStore} from './automation-store.js';
import type {ReplyPolicy} from '../app/automation-contracts.js';
import type {EventStore} from './store.js';

export class LocalAssistantStore {
  constructor(readonly store:EventStore,readonly now:()=>number=Date.now){}
  private collection(){
    const state=new AutomationStore(this.store,this.now).state();
    requireSafe(state.collection,'ASSISTANT_COLLECTION_REQUIRED');
    return {ownId:state.collection.ownId,startedAt:state.startedAt,comments:state.collection.comments,inbox:state.collection.inbox};
  }
  hasGrantHistory():boolean{
    if(!this.available())return false;
    return !!this.store.db.prepare("SELECT version FROM automation_grants WHERE kind='LOCAL_ASSISTANT' LIMIT 1").get()||
      !!this.store.db.prepare("SELECT id FROM audit_events WHERE event_type='LOCAL_ASSISTANT_REVOKED' AND entity_id='LOCAL_ASSISTANT' LIMIT 1").get();
  }
  connectedScope():LocalAssistantScope{
    const current=this.collection();new AutomationStore(this.store,this.now).requireAccount(current.ownId);
    const channels:LocalAssistantScope['channels']=[];
    if(current.comments)channels.push('COMMENT_NOTIFICATION');
    if(current.inbox)channels.push('DIRECT_MESSAGE');
    requireSafe(channels.length>0,'ASSISTANT_COLLECTION_REQUIRED');
    return {ownId:current.ownId,channels,permissions:{read:true,editControl:true,send:true},
      expiresAt:null,modelLimit:null,sendLimit:null};
  }
  /** Called only by authenticated local connection/GUI entrypoints, never by an assistant tool. */
  grant(input:LocalAssistantScope,trustedMappedWorkIds:readonly string[]=[]):LocalAssistantGrant{
    const parsed=localAssistantScopeSchema.parse(input),current=this.collection();
    new AutomationStore(this.store,this.now).requireAccount(parsed.ownId);
    requireSafe(current.ownId===parsed.ownId&&parsed.channels.every(channel=>channel==='DIRECT_MESSAGE'?current.inbox:current.comments),
      'ASSISTANT_SCOPE_CHANGED');
    requireSafe(parsed.expiresAt===null||parsed.expiresAt>this.now(),'ASSISTANT_GRANT_EXPIRED');
    const collectedWorkIds=(this.store.db.prepare(`SELECT DISTINCT substr(e.scope,6) id FROM inbound_events e
      JOIN collection_targets t ON t.target_key=e.target_key WHERE e.channel='COMMENT_NOTIFICATION'
      AND e.scope LIKE 'work:%' AND t.own_id=? ORDER BY id`).all(parsed.ownId) as {id:string}[]).map(row=>row.id);
    const workIds=[...new Set([...trustedMappedWorkIds,...collectedWorkIds])].sort();
    const scope=localAssistantStoredScopeSchema.parse({...parsed,
      collection:{startedAt:current.startedAt,comments:current.comments,inbox:current.inbox,workIds}});
    return this.store.db.transaction(()=>{
      // Carry consumed reservations even across expiry/revocation; an ordinary regrant cannot erase spend.
      const previous=this.store.db.prepare("SELECT version FROM automation_grants WHERE kind='LOCAL_ASSISTANT' ORDER BY version DESC LIMIT 1")
        .get() as {version:number}|undefined;
      const used=this.usage(previous?.version);
      requireSafe((scope.modelLimit===null||scope.modelLimit>=used.MODEL)&&
        (scope.sendLimit===null||scope.sendLimit>=used.SEND),'ASSISTANT_LIMIT_BELOW_USED');
      this.revoke();
      const row=this.store.db.prepare('INSERT INTO automation_grants(kind,scope_json,scope_digest,created_at) VALUES(?,?,?,?)')
        .run('LOCAL_ASSISTANT',JSON.stringify(scope),digest(scope),this.now());
      const version=Number(row.lastInsertRowid);
      if(previous)this.store.db.prepare('INSERT INTO grant_reservations SELECT ?,kind,job_key,reserved_at FROM grant_reservations WHERE grant_version=?')
        .run(version,previous.version);
      this.store.audit('LOCAL_ASSISTANT_GRANTED',String(version));
      return {version,kind:'LOCAL_ASSISTANT' as const,scope,createdAt:this.now()};
    }).immediate();
  }
  revoke():void{
    this.store.db.transaction(()=>{
      this.store.db.prepare("UPDATE automation_grants SET revoked_at=? WHERE kind='LOCAL_ASSISTANT' AND revoked_at IS NULL").run(this.now());
      if(this.available()){
        this.store.db.prepare(`UPDATE manual_send_commands SET status='FAILED_BEFORE_CLICK',reason='ASSISTANT_GRANT_REVOKED'
          WHERE intent_id IS NULL AND status IN ('PREPARING','PREVIEW','QUEUED','PREFLIGHT')
          AND command_id IN(SELECT command_id FROM assistant_commands)`).run();
        this.store.db.prepare(`UPDATE thread_ownership SET operator_id=NULL,generation=generation+1,lease_expires_at=0
          WHERE operator_id IN(SELECT operator_id FROM assistant_sessions)`).run();
      }
      this.store.audit('LOCAL_ASSISTANT_REVOKED','LOCAL_ASSISTANT');
    }).immediate();
  }
  active():LocalAssistantGrant|null{
    if(!this.available())return null;
    const row=this.store.db.prepare("SELECT version,scope_json,scope_digest,created_at FROM automation_grants WHERE kind='LOCAL_ASSISTANT' AND revoked_at IS NULL ORDER BY version DESC LIMIT 1")
      .get() as {version:number;scope_json:string;scope_digest:string;created_at:number}|undefined;
    if(!row)return null;
    const scope=localAssistantStoredScopeSchema.parse(JSON.parse(row.scope_json));
    requireSafe(digest(scope)===row.scope_digest,'ASSISTANT_GRANT_CORRUPT');
    if(scope.expiresAt!==null&&scope.expiresAt<=this.now())return null;
    return {version:row.version,kind:'LOCAL_ASSISTANT',scope,createdAt:row.created_at};
  }
  usage(version?:number):{MODEL:number;SEND:number}{
    const result={MODEL:0,SEND:0};if(version===undefined)return result;
    const rows=this.store.db.prepare('SELECT kind,count(*) used FROM grant_reservations WHERE grant_version=? GROUP BY kind').all(version) as {kind:string;used:number}[];
    for(const row of rows)if(row.kind==='MODEL'||row.kind==='SEND')result[row.kind]=row.used;return result;
  }
  state():LocalAssistantState{
    const grant=this.active(),last=this.available()?this.store.db.prepare("SELECT version,revoked_at FROM automation_grants WHERE kind='LOCAL_ASSISTANT' ORDER BY version DESC LIMIT 1")
      .get() as {version:number;revoked_at:number|null}|undefined:undefined;
    const used=this.usage(grant?.version??last?.version);
    let reason:string|null=grant?null:'ASSISTANT_PERMISSION_REQUIRED';
    if(grant){try{this.requireScope(grant);}catch{reason='ASSISTANT_SCOPE_CHANGED';}}
    const remaining=(kind:'MODEL'|'SEND'):number|null=>{
      if(!grant)return 0;
      const limit=kind==='MODEL'?grant.scope.modelLimit:grant.scope.sendLimit;
      if(limit!==null)return Math.max(0,limit-used[kind]);
      const global=this.store.budget(kind);return global.maximum===null?null:Math.max(0,global.maximum-global.used);
    };
    return {grant,used,remaining:{MODEL:remaining('MODEL'),SEND:remaining('SEND')},reason,
      connectionEnabled:last?last.revoked_at===null:!this.hasGrantHistory()};
  }
  private requireScope(grant:LocalAssistantGrant):void{
    const current=this.collection();new AutomationStore(this.store,this.now).requireAccount(grant.scope.ownId);
    requireSafe(current.ownId===grant.scope.ownId&&current.startedAt===grant.scope.collection.startedAt&&
      current.comments===grant.scope.collection.comments&&current.inbox===grant.scope.collection.inbox,'ASSISTANT_SCOPE_CHANGED');
  }
  require(permission:LocalAssistantPermission,version?:number):LocalAssistantGrant{
    const grant=this.active();requireSafe(grant&&(version===undefined||grant.version===version),'ASSISTANT_PERMISSION_REQUIRED');
    this.requireScope(grant);requireSafe(grant.scope.permissions[permission],'ASSISTANT_PERMISSION_REQUIRED');return grant;
  }
  private includesWork(grant:LocalAssistantGrant,workId:string):boolean{
    return grant.scope.collection.workIds.includes(workId)||!!this.store.db.prepare(
      "SELECT id FROM discovered_works WHERE id=? AND own_id=? AND state='INCLUDED' AND published_at>?")
      .get(workId,grant.scope.ownId,grant.scope.collection.startedAt);
  }
  /** Enabling an existing policy must not let a narrower assistant start work outside its collection range. */
  requirePolicy(version:number,policy:ReplyPolicy):void{
    const grant=this.require('editControl',version);
    requireSafe(policy.ownId===grant.scope.ownId&&policy.channels.every(channel=>grant.scope.channels.includes(channel))&&
      (!policy.channels.includes('COMMENT_NOTIFICATION')||policy.workIds.every(id=>this.includesWork(grant,id))),
      'ASSISTANT_POLICY_OUTSIDE_SCOPE');
    for(const event of this.store.events()){
      const e=event.payload;
      if(!['AWAITING_DRAFT','AWAITING_APPROVAL','APPROVED'].includes(event.status)||!isStrong(e)||
        !policy.channels.includes(e.channel)||e.direction!=='INCOMING'||e.actorId===policy.ownId||
        this.store.sendFrozen(event.id)||this.store.db.prepare('SELECT id FROM send_intents WHERE event_id=?').get(event.id))continue;
      const draft=this.store.db.prepare(`SELECT r.origin FROM reply_drafts d JOIN draft_revisions r ON r.draft_id=d.id AND r.version=d.version
        WHERE d.event_id=?`).get(event.id) as {origin:string}|undefined;
      // An existing GUI or assistant draft is never an automatic policy candidate.
      if(draft&&draft.origin!=='AUTO_POLICY')continue;
      const matches=e.channel==='DIRECT_MESSAGE'?policy.entireInbox||policy.conversationIds.includes(e.conversationId!):
        (e.kind!=='REPLY'||policy.replyToNestedComments!==false)&&
          (policy.workIds.includes(e.videoId!)||policy.futureOwnWorks&&!!this.store.db.prepare(
            "SELECT id FROM discovered_works WHERE id=? AND own_id=? AND state='INCLUDED'").get(e.videoId,policy.ownId));
      if(matches)requireSafe(this.inScope(grant,event),'ASSISTANT_POLICY_OUTSIDE_SCOPE');
    }
  }
  inScope(grant:LocalAssistantGrant,event:StoredEvent):boolean{
    const e=event.payload,time=Date.parse(e.occurredAt??'');
    if(!(e.accountId==='account_001'&&grant.scope.channels.includes(e.channel)&&e.direction==='INCOMING'&&
      e.actorId!==grant.scope.ownId&&Number.isFinite(time)&&time>grant.scope.collection.startedAt&&time<=this.now()&&event.status!=='BASELINE'))return false;
    const row=this.store.db.prepare('SELECT scope,binding FROM inbound_events WHERE id=?').get(event.id) as {scope:string;binding:string}|undefined;
    if(!row||row.binding!==event.binding||eventBinding(e)!==event.binding)return false;
    const target=this.store.db.prepare('SELECT own_id,uid,sec_uid,conversation_id FROM collection_targets WHERE target_key=?').get(targetKey(e)) as
      {own_id:string;uid:string;sec_uid:string;conversation_id:string|null}|undefined;
    if(!target||target.own_id!==grant.scope.ownId||target.uid!==e.actorId||!target.sec_uid||target.conversation_id!==e.conversationId)return false;
    if(e.channel==='DIRECT_MESSAGE')return row.scope===e.conversationId&&!!this.store.db.prepare(
      'SELECT id FROM discovered_conversations WHERE id=? AND own_id=? AND sec_uid=?').get(e.conversationId,grant.scope.ownId,target.sec_uid);
    return row.scope==='work:'+e.videoId&&this.includesWork(grant,e.videoId!);
  }
  requireEvent(permission:LocalAssistantPermission,event:StoredEvent,version?:number):LocalAssistantGrant{
    const grant=this.require(permission,version);requireSafe(this.inScope(grant,event),'ASSISTANT_TARGET_OUTSIDE_SCOPE');return grant;
  }
  requireText(event:StoredEvent):void{
    requireSafe(isStrong(event.payload)&&!event.payload.observationIssue&&!event.payload.contentType,'ASSISTANT_TEXT_REQUIRED');
  }
  available():boolean{return !!this.store.db.prepare("SELECT name FROM sqlite_master WHERE name='assistant_sessions'").get();}
  bindSession(operatorId:string,version:number):void{
    const grant=this.active();requireSafe(grant?.version===version,'ASSISTANT_PERMISSION_REQUIRED');this.requireScope(grant);
    this.store.db.prepare('INSERT INTO assistant_sessions VALUES(?,?)').run(operatorId,version);
  }
  session(operatorId:string):number|null{
    if(!this.available())return null;
    return (this.store.db.prepare('SELECT grant_version FROM assistant_sessions WHERE operator_id=?').get(operatorId) as {grant_version:number}|undefined)?.grant_version??null;
  }
  bindCommand(operatorId:string,commandId:string):void{
    const version=this.session(operatorId);if(version===null)return;
    this.store.db.prepare('INSERT INTO assistant_commands VALUES(?,?)').run(commandId,version);
  }
  requireSend(operatorId:string,event:StoredEvent):void{
    const version=this.session(operatorId);if(version===null)return;
    this.requireEvent('send',event,version);this.requireText(event);
    requireSafe(!new AutomationStore(this.store,this.now).state().emergencyStopped,'EMERGENCY_STOPPED');
    requireSafe(this.allowance(version,'SEND'),'ASSISTANT_SEND_EXHAUSTED');
  }
  allowance(version:number,kind:'MODEL'|'SEND'):boolean{
    const grant=this.active();if(grant?.version!==version)return false;
    const limit=kind==='MODEL'?grant.scope.modelLimit:grant.scope.sendLimit,global=this.store.budget(kind);
    return (limit===null||this.usage(version)[kind]<limit)&&(global.maximum===null||global.used<global.maximum);
  }
  /** Invoked inside the same SQLite transaction as the global reservation, never on HTTP acceptance. */
  reserve(version:number,kind:'MODEL'|'SEND',jobKey:string,event:StoredEvent,globalAlreadyConsumed=false):void{
    this.store.db.transaction(()=>{
      this.requireEvent(kind==='SEND'?'send':'editControl',event,version);this.requireText(event);
      requireSafe(!new AutomationStore(this.store,this.now).state().emergencyStopped,'EMERGENCY_STOPPED');
      const grant=this.active()!,limit=kind==='MODEL'?grant.scope.modelLimit:grant.scope.sendLimit,global=this.store.budget(kind);
      requireSafe((limit===null||this.usage(version)[kind]<limit)&&(global.maximum===null||
        (globalAlreadyConsumed?global.used<=global.maximum:global.used<global.maximum)),`ASSISTANT_${kind}_EXHAUSTED`);
      requireSafe(!this.store.db.prepare('SELECT job_key FROM grant_reservations WHERE grant_version=? AND kind=? AND job_key=?').get(version,kind,jobKey),
        'ASSISTANT_OPERATION_ALREADY_RESERVED');
      this.store.db.prepare('INSERT INTO grant_reservations VALUES(?,?,?,?)').run(version,kind,jobKey,this.now());
    }).immediate();
  }
  commitCommand(commandId:string,event:StoredEvent):void{
    if(!this.available())return;
    const row=this.store.db.prepare('SELECT grant_version FROM assistant_commands WHERE command_id=?').get(commandId) as {grant_version:number}|undefined;
    if(row)this.reserve(row.grant_version,'SEND',commandId,event,true);
  }
}
