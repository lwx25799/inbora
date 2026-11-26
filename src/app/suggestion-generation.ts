import {randomUUID} from 'node:crypto';
import {isStrong,requireSafe,type InboundEvent} from '../core/contracts.js';
import type {EventStore} from '../storage/store.js';
import type {AutomationStore} from '../storage/automation-store.js';
import type {DeepSeekProvider} from '../ai/deepseek.js';
import type {WorkbenchAuthority} from './authority.js';
import type {ClientCommand} from './contracts.js';
import {requireSuggestionEligibility,type SuggestionState,type SuggestionAuthorization} from './suggestion-eligibility.js';
import {runtimePerformance,type RuntimeOutcome} from '../observability/runtime-performance.js';
import {requireAssistantModelContext} from './local-assistant-model-context.js';
import {assertSecurityRevision,securityRevision} from '../storage/security-holds.js';
import type {ReplyKnowledgeContext} from '../knowledge/contracts.js';
import {assertReplyKnowledgeCurrent,bindReplyKnowledge,replySettingsFingerprint} from '../knowledge/generation-context.js';
import type {ModelProviderController} from './model-provider-controller.js';
import {modelCallFailureReason} from '../ai/business-model-call.js';

interface Context {store:EventStore;authority:WorkbenchAuthority;automation:AutomationStore|null;provider:Pick<DeepSeekProvider,'generate'>;
  state():SuggestionState;signal():AbortSignal;pending:Set<string>;emit(event:string):void;cancelMaintenance():void;
  models:ModelProviderController|null;knowledgeContext?(event:InboundEvent):ReplyKnowledgeContext|null}

/** Explicit first-reply candidates share persistent MODEL allowance with their exact saved policy. */
export async function generateSuggestion(c:Context,token:string,command:Extract<ClientCommand,{command:'generateSuggestion'}>){
  c.authority.operator(token,'EDIT');const event=c.store.event(command.eventId),state=c.state();
  const authorization=requireSuggestionEligibility(c.store,c.authority,c.automation,event,{...state,modelBusy:c.pending.has(event.id)});
  c.authority.checkAssistantModel(token,event);
  requireSafe((c.authority.draftFor(event.id)?.version??0)===command.draftVersion,'DRAFT_VERSION_CONFLICT');
  const context=c.authority.contextVersion(event),id=randomUUID(),signal=c.signal();
  const security=securityRevision(c.store,event.payload.channel);
  const assistant=c.authority.assistantVersion(token),generation=c.authority.ownership(event).generation;
  const selection=assistant===null?null:c.authority.selectionId(token,event.id);
  if(assistant!==null)c.authority.requireOwner(token,event,generation);
  const sameAuthorization=(fresh:SuggestionAuthorization)=>requireSafe(authorization.grant?
    fresh.grant?.kind===authorization.grant.kind&&fresh.grant.version===authorization.grant.version:
    fresh.grant===null,'GRANT_REVOKED');
  const recheck=(checkAllowance=true)=>{
    assertSecurityRevision(c.store,event.payload.channel,security);
    c.authority.operator(token,'EDIT');requireSafe(!signal.aborted,'MODEL_PAUSED');
    const current=c.store.event(event.id);requireSafe(current.binding===event.binding,'TARGET_CHANGED');
    requireSafe(c.authority.contextVersion(current)===context,'CONTEXT_VERSION_CONFLICT');
    c.authority.checkAssistantModel(token,current,checkAllowance);
    if(assistant!==null){
      c.authority.requireSelection(token,event.id,selection!);
      c.authority.requireOwner(token,current,generation);
      requireSafe((c.authority.draftFor(event.id)?.version??0)===command.draftVersion,'DRAFT_VERSION_CONFLICT');
    }
    const freshState=c.state(),fresh=requireSuggestionEligibility(c.store,c.authority,c.automation,current,{...freshState,modelBusy:false},checkAllowance);
    sameAuthorization(fresh);
    requireSafe(replySettingsFingerprint(freshState.settings,knowledge?.persona,fresh.policy?.instructions??freshState.settings.rules)===settingsFingerprint,'AI_SETTINGS_CHANGED');
    return fresh;
  };
  requireSafe(c.models&&authorization.grant,'REAL_MODEL_AUTHORIZATION_REQUIRED');
  const models=c.models,grant=authorization.grant;
  const binding={controller:models,kind:grant.kind,snapshot:models.guard.snapshot(grant,'REPLY_GENERATION')};
  const settings=authorization.policy?{...state.settings,rules:authorization.policy.instructions}:state.settings;
  const knowledge=c.knowledgeContext?.(event.payload)??null;
  const settingsFingerprint=replySettingsFingerprint(settings,knowledge?.persona);
  const history=c.store.history(event.payload).filter(item=>isStrong(item)&&!c.store.db.prepare(`SELECT c.id FROM source_collisions c
    JOIN inbound_events e ON e.id=c.event_id WHERE e.account_id=? AND e.channel=? AND e.source_key=? LIMIT 1`)
    .get(item.accountId,item.channel,item.platformEventId));
  c.pending.add(event.id);c.emit('status_updated');c.cancelMaintenance();const end=runtimePerformance.start('MODEL',event.payload.channel);
  let outcome:RuntimeOutcome='FAILED';
  let callId:string|undefined;
  try{
    const result=await c.provider.generate(c.store,event.payload,history,settings,'',true,signal,
      ()=>{recheck();assertReplyKnowledgeCurrent(c.store,knowledge);models.guard.automation.reserve(grant.version,'MODEL',id,event.payload.channel);
        c.authority.reserveAssistantModel(token,event,id);},
      (_input,actualHistory)=>requireAssistantModelContext(c.authority,token,event,actualHistory),knowledge,binding,()=>recheck(false));
    callId=result.callId;
    c.store.db.transaction(()=>{
      models.guard.assertCurrent(binding.snapshot,binding.kind);
      recheck(false);
      assertReplyKnowledgeCurrent(c.store,knowledge);
      c.store.db.prepare('INSERT INTO ai_suggestions VALUES(?,?,?,?,?,?,?,0)').run(id,event.id,command.draftVersion,context,result.text,result.model,Date.now());
      bindReplyKnowledge(c.store,'SUGGESTION',id,command.draftVersion,knowledge);
      models.models.bindGeneration({ownerKind:'SUGGESTION',ownerId:id,ownerVersion:1},result.callId);
    }).immediate();
    outcome='SUCCEEDED';
    c.emit('suggestion_updated');return{id,text:result.text,model:result.model,stale:(c.authority.draftFor(event.id)?.version??0)!==command.draftVersion||c.authority.contextVersion(c.store.event(event.id))!==context};
  }catch(error){
    if(callId&&outcome==='FAILED')models.models.discardUnpublishedCall(callId,modelCallFailureReason(error));
    throw error;
  }finally{end(signal.aborted?'CANCELLED':outcome);c.pending.delete(event.id);c.emit('status_updated');}
}
