import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {ClientService} from '../app/service.js';
import type {WorkbenchQueries} from '../app/workbench-queries.js';
import type {LocalAssistantGrant} from '../app/local-assistant-contracts.js';
import {requireSafe,Blocked} from '../core/contracts.js';
import {LocalAssistantOperations} from '../storage/local-assistant-operations.js';
import {AssistantReads} from './assistant-reads.js';
import {assistantTools,operationSchema,type AssistantTool} from './tool-contracts.js';
import {assistantError} from './bridge-contracts.js';
import {draftView,statusView} from './projections.js';

type Inputs={[T in AssistantTool]:{tool:T;input:z.infer<(typeof assistantTools)[T]['inputSchema']>}}[AssistantTool];
type Operation=z.infer<typeof operationSchema>;
type Result=NonNullable<Operation['result']>;
interface Session {token:string;version:number;lastUsed:number}

/** Sole assistant-to-service adapter; no GUI operator token or arbitrary command is exposed. */
export class AssistantFacade {
  instanceId:string=randomUUID();
  private readonly operations:LocalAssistantOperations;
  private readonly reads:AssistantReads;
  private readonly sessions=new Map<string,Session>();
  private readonly pending=new Set<Promise<void>>();
  private readonly busy=new Map<string,number>();
  private publicToken:string;
  private closing=false;
  constructor(readonly service:ClientService){
    this.operations=new LocalAssistantOperations(service.store,service.authority.now);
    this.operations.recover();
    this.reads=new AssistantReads(service);
    this.publicToken=service.authority.issueSession(['READ']);
  }
  private readToken():string{
    try{this.service.authority.operator(this.publicToken);}catch{this.publicToken=this.service.authority.issueSession(['READ']);}
    return this.publicToken;
  }
  private session(id:string,version:number):string{
    const now=this.service.authority.now();
    for(const [key,item] of this.sessions)if(key!==id&&now-item.lastUsed>120_000&&!this.busy.has(item.token)){
      let active:unknown;
      try{
        const operator=this.service.authority.operator(item.token).id;
        active=this.service.store.db.prepare(`SELECT 1 FROM manual_send_commands WHERE operator_id=?
          AND status IN ('PREPARING','PREVIEW','QUEUED','PREFLIGHT','SENDING') LIMIT 1`).get(operator);
      }catch{/* An expired or revoked session cannot block unrelated new sessions. */}
      if(!active){this.service.authority.revoke(item.token);this.sessions.delete(key);}
    }
    const old=this.sessions.get(id);
    if(old&&old.version===version){try{this.service.authority.operator(old.token);old.lastUsed=now;return old.token;}catch{/* Session expiry requires fresh selection. */}}
    if(old)this.service.authority.revoke(old.token);
    requireSafe(this.sessions.has(id)||this.sessions.size<64,'ASSISTANT_SESSION_LIMIT');
    const token=this.service.authority.issueAssistantSession(version);this.sessions.set(id,{token,version,lastUsed:now});return token;
  }
  async dispatch(sessionId:string,name:string,args:unknown):Promise<unknown>{
    requireSafe(!this.closing,'APP_NOT_RUNNING');z.uuid().parse(sessionId);
    requireSafe(Object.hasOwn(assistantTools,name),'ASSISTANT_TOOL_NOT_ALLOWED');
    const tool=name as AssistantTool;
    const request={tool,input:assistantTools[tool].inputSchema.parse(args)} as Inputs;
    await this.service.assistantConnected();
    const result=await this.invoke(sessionId,request);
    const parsed=assistantTools[tool].outputSchema.safeParse(result);
    requireSafe(parsed.success,'ASSISTANT_RESPONSE_INVALID');return parsed.data;
  }
  private async invoke(sessionId:string,request:Inputs):Promise<unknown>{
    const authority=this.service.authority;
    if(request.tool==='inbora_get_status')return statusView(
      await this.service.dispatch(this.readToken(),{command:'getStatus'}) as ReturnType<WorkbenchQueries['status']>,
      authority.assistant.state(),this.instanceId);
    if(request.tool==='inbora_get_diagnostics'){
      const data=await this.service.dispatch(this.readToken(),{command:'getDiagnostics'}) as import('../app/diagnostics.js').DiagnosticsSnapshot;
      return {version:data.version,timeRangeSupported:data.timeRangeSupported,model:data.model,blockers:data.blockers,collection:data.collection};
    }
    if(request.tool==='inbora_get_operation')return this.operation(request.input.operationId);
    if(request.tool==='inbora_list_inbox'||request.tool==='inbora_get_thread'||request.tool==='inbora_inspect_preview'){
      const grant=authority.assistant.require('read'),token=this.session(sessionId,grant.version);
      if(request.tool==='inbora_list_inbox')return this.reads.inbox(token,request.input);
      if(request.tool==='inbora_get_thread')return this.reads.thread(token,request.input.eventId,request.input.timelineBefore);
      return this.reads.preview(token,request.input.eventId);
    }
    const grant=authority.assistant.require('editControl'),token=this.session(sessionId,grant.version);
    const eventId='eventId' in request.input?request.input.eventId:null;
    if(eventId){
      const event=this.service.store.event(eventId);
      authority.assistant.requireEvent('read',event,grant.version);authority.assistant.requireEvent('editControl',event,grant.version);
      if(!['inbora_refresh_preview','inbora_close_reply'].includes(request.tool))authority.assistant.requireText(event);
    }
    const id=request.input.operationId;
    if(!this.operations.begin(id,request.tool,request.input,grant.version,eventId))return this.operation(id);
    this.busy.set(token,(this.busy.get(token)??0)+1);
    // Acceptance is committed before starting asynchronous work. Repeated requests only query this record.
    const task=Promise.resolve().then(async()=>{
      requireSafe(!this.closing,'APP_NOT_RUNNING');authority.assistant.require('editControl',grant.version);
      const result=await this.execute(token,grant,request);
      this.operations.finish(id,result);
    }).catch(error=>this.operations.fail(id,assistantError(error))).finally(()=>{
      const left=(this.busy.get(token)??1)-1;if(left)this.busy.set(token,left);else this.busy.delete(token);
      this.pending.delete(task);this.service.events.emit('update',{event:'status_updated'});
    });
    this.pending.add(task);return this.operation(id);
  }
  private binding(token:string,input:{eventId:string;selectionId:string;generation:number;contextVersion:string;expectedVersion:number}):void{
    const a=this.service.authority,event=this.service.store.event(input.eventId),version=a.assistantVersion(token)!;
    a.assistant.requireEvent('read',event,version);a.assistant.requireEvent('editControl',event,version);a.assistant.requireText(event);
    a.requireSelection(token,input.eventId,input.selectionId);a.requireOwner(token,event,input.generation);
    requireSafe(a.contextVersion(event)===input.contextVersion,'CONTEXT_VERSION_CONFLICT');
    requireSafe((a.draftFor(input.eventId)?.version??0)===input.expectedVersion,'DRAFT_VERSION_CONFLICT');
    a.renew(token,input.eventId,input.generation);
  }
  private async execute(token:string,grant:LocalAssistantGrant,r:Inputs):Promise<Result>{
    const a=this.service.authority;
    switch(r.tool){
      case 'inbora_sync_inbox':{
        const s=await this.service.dispatch(token,{command:'syncInbox'}) as ReturnType<WorkbenchQueries['status']>;
        return {kind:'sync',runId:s.sync.runId};
      }
      case 'inbora_mark_all_read':{
        const value=await this.service.dispatch(token,{command:'markInboxRead'}) as {marked:number};return {kind:'read',marked:value.marked};
      }
      case 'inbora_set_automatic_reply':
        await this.service.dispatch(token,{command:'setAutomaticReply',enabled:r.input.enabled});
        return {kind:'automatic',enabled:r.input.enabled};
      case 'inbora_emergency_stop':
        await this.service.dispatch(token,{command:'emergencyStop'});return {kind:'stop',emergencyStopped:true};
      case 'inbora_refresh_preview':{
        a.assistant.requireEvent('read',this.service.store.event(r.input.eventId),grant.version);
        const result=await this.service.dispatch(token,{command:'getMessagePreview',eventId:r.input.eventId,refresh:true}) as {scheduled:boolean};
        return {kind:'preview',scheduled:result.scheduled};
      }
      case 'inbora_open_reply':{
        const event=this.service.store.event(r.input.eventId);
        a.assistant.requireEvent('read',event,grant.version);a.assistant.requireText(event);
        requireSafe(!this.service.store.db.prepare('SELECT id FROM send_intents WHERE event_id=?').get(event.id),'ASSISTANT_EXISTING_INTENT');
        const selectionId=randomUUID();
        await this.service.dispatch(token,{command:'openHumanDialog',eventId:event.id,selectionId});
        return this.reads.reply(token,event.id,selectionId);
      }
      case 'inbora_save_draft':{
        this.binding(token,r.input);
        await this.service.dispatch(token,{command:'saveDraft',eventId:r.input.eventId,generation:r.input.generation,
          expectedVersion:r.input.expectedVersion,text:r.input.text,suggestionId:null});
        return {kind:'saved',eventId:r.input.eventId,draft:draftView(a.draftFor(r.input.eventId))!};
      }
      case 'inbora_generate_suggestion':{
        this.binding(token,r.input);
        const result=await this.service.dispatch(token,{command:'generateSuggestion',eventId:r.input.eventId,draftVersion:r.input.expectedVersion}) as {id:string;text:string;stale:boolean};
        this.binding(token,r.input);
        return {kind:'suggestion',eventId:r.input.eventId,id:result.id,text:result.text,stale:result.stale};
      }
      case 'inbora_send_reply':{
        this.binding(token,r.input);a.assistant.requireEvent('send',this.service.store.event(r.input.eventId),grant.version);
        const {operationId,...input}=r.input;
        await this.service.dispatch(token,{command:'sendHumanReply',commandId:operationId,input:{...input,suggestionId:null}});
        return this.sendResult(operationId);
      }
      case 'inbora_close_reply':
        await this.service.dispatch(token,{command:'closeHumanDialog',eventId:r.input.eventId,generation:r.input.generation});
        return {kind:'closed',eventId:r.input.eventId};
      default:throw new Blocked('ASSISTANT_TOOL_NOT_ALLOWED');
    }
  }
  private sendResult(id:string):Extract<Result,{kind:'send'}>{
    const row=this.service.authority.command(id);
    const reason=row.reason===null?null:/^[A-Z][A-Z0-9_]{0,99}$/u.test(row.reason)?row.reason:
      row.reason.startsWith('POST_INTENT_FAILURE:')?'POST_INTENT_FAILURE':'PRIVATE_DIAGNOSTICS';
    return {kind:'send',commandId:id,status:row.status,intentId:row.intent_id,reason};
  }
  private operation(id:string):Operation{
    const row=this.operations.get(id);
    let result=row.result as Result|null,state=row.state,error=row.error;
    if(row.tool==='inbora_send_reply'&&this.service.store.db.prepare('SELECT command_id FROM assistant_commands WHERE command_id=?').get(id)){
      result=this.sendResult(id);
      state=result.status==='CONFIRMED'?'SUCCEEDED':result.status==='UNCERTAIN'?'UNKNOWN':result.status==='FAILED_BEFORE_CLICK'?'FAILED':'RUNNING';
      error=result.reason;
    }
    let canRead=false;
    try{
      if(row.eventId)this.service.authority.assistant.requireEvent('read',this.service.store.event(row.eventId),row.grantVersion);
      else this.service.authority.assistant.require('editControl',row.grantVersion);
      canRead=true;
    }catch{/* A known operation ID may report completion after revoke, but cannot expose old private text. */}
    return operationSchema.parse({operationId:id,tool:row.tool,state,eventId:canRead?row.eventId:null,
      result:canRead||result?.kind==='send'?result:null,error,createdAt:row.createdAt,updatedAt:row.updatedAt});
  }
  async drain():Promise<void>{await Promise.allSettled([...this.pending]);}
  async close():Promise<void>{
    this.closing=true;await this.drain();
    for(const session of this.sessions.values())this.service.authority.revoke(session.token);
    this.sessions.clear();this.service.authority.revoke(this.publicToken);
  }
}
