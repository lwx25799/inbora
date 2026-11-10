import {randomUUID} from 'node:crypto';
import {isStrong,requireSafe} from '../core/contracts.js';
import type {EventStore} from '../storage/store.js';
import type {AutomationStore} from '../storage/automation-store.js';
import type {DeepSeekProvider} from '../ai/deepseek.js';
import type {WorkbenchAuthority} from './authority.js';
import type {ClientCommand} from './contracts.js';
import {requireSuggestionEligibility,type SuggestionState,type SuggestionAuthorization} from './suggestion-eligibility.js';
import {runtimePerformance,type RuntimeOutcome} from '../observability/runtime-performance.js';

interface Context {store:EventStore;authority:WorkbenchAuthority;automation:AutomationStore|null;provider:Pick<DeepSeekProvider,'generate'>;
  state():SuggestionState;key():string;signal():AbortSignal;pending:Set<string>;emit(event:string):void;cancelMaintenance():void}

/** Explicit first-reply candidates share persistent MODEL allowance with their exact saved policy. */
export async function generateSuggestion(c:Context,token:string,command:Extract<ClientCommand,{command:'generateSuggestion'}>){
  c.authority.operator(token,'EDIT');const event=c.store.event(command.eventId),state=c.state();
  const authorization=requireSuggestionEligibility(c.store,c.authority,c.automation,event,{...state,modelBusy:c.pending.has(event.id)});
  requireSafe((c.authority.draftFor(event.id)?.version??0)===command.draftVersion,'DRAFT_VERSION_CONFLICT');
  const context=c.authority.contextVersion(event),id=randomUUID(),signal=c.signal();
  const sameAuthorization=(fresh:SuggestionAuthorization)=>requireSafe(authorization.grant?
    fresh.grant?.kind===authorization.grant.kind&&fresh.grant.version===authorization.grant.version:
    fresh.grant===null,'GRANT_REVOKED');
  const recheck=(checkAllowance=true)=>{
    c.authority.operator(token,'EDIT');requireSafe(!signal.aborted,'MODEL_PAUSED');
    const current=c.store.event(event.id);requireSafe(current.binding===event.binding,'TARGET_CHANGED');
    const fresh=requireSuggestionEligibility(c.store,c.authority,c.automation,current,{...c.state(),modelBusy:false},checkAllowance);sameAuthorization(fresh);return fresh;
  };
  const settings=authorization.policy?{...state.settings,rules:authorization.policy.instructions}:state.settings;
  const history=c.store.history(event.payload).filter(item=>isStrong(item)&&!c.store.db.prepare(`SELECT c.id FROM source_collisions c
    JOIN inbound_events e ON e.id=c.event_id WHERE e.account_id=? AND e.channel=? AND e.source_key=? LIMIT 1`)
    .get(item.accountId,item.channel,item.platformEventId));
  c.pending.add(event.id);c.emit('status_updated');c.cancelMaintenance();const end=runtimePerformance.start('MODEL',event.payload.channel);
  let outcome:RuntimeOutcome='FAILED';
  try{
    const result=await c.provider.generate(c.store,event.payload,history,settings,c.key(),true,signal,
      authorization.grant?()=>{recheck();c.automation!.reserve(authorization.grant!.version,'MODEL',id);}:undefined);
    recheck(false);
    c.store.db.prepare('INSERT INTO ai_suggestions VALUES(?,?,?,?,?,?,?,0)').run(id,event.id,command.draftVersion,context,result.text,result.model,Date.now());
    outcome='SUCCEEDED';
    c.emit('suggestion_updated');return{id,...result,stale:(c.authority.draftFor(event.id)?.version??0)!==command.draftVersion||c.authority.contextVersion(c.store.event(event.id))!==context};
  }finally{end(signal.aborted?'CANCELLED':outcome);c.pending.delete(event.id);c.emit('status_updated');}
}
