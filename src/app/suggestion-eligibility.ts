import {requireSafe,targetKey,type StoredEvent} from '../core/contracts.js';
import type {EventStore} from '../storage/store.js';
import type {AutomationStore} from '../storage/automation-store.js';
import type {WorkbenchAuthority} from './authority.js';
import type {AiSettings} from './contracts.js';
import type {Grant,ReplyPolicy} from './automation-contracts.js';

export interface SuggestionState {settings:AiSettings;keyPresent:boolean;modelAuthorized:boolean;modelBusy:boolean;recovering:boolean}
export interface SuggestionEligibility {eligible:boolean;reason:string|null}
export interface SuggestionAuthorization {grant:Grant|null;policy:ReplyPolicy|null}

export function requireSuggestionAuthorization(store:EventStore,automation:AutomationStore|null,event:StoredEvent,state:SuggestionState,checkAllowance=true):SuggestionAuthorization {
  let grant=automation?.active('MODEL')??null,policy:ReplyPolicy|null=null;
  if(!grant&&!state.modelAuthorized){grant=automation?.active('AUTO_REPLY')??null;policy=grant?.scope as ReplyPolicy|null;}
  requireSafe(state.modelAuthorized||grant,'REAL_MODEL_AUTHORIZATION_REQUIRED');
  if(grant){
    automation!.requireAccount(grant.scope.ownId);
    requireSafe(event.payload.accountId==='account_001'&&grant.scope.model===state.settings.model&&grant.scope.channels.includes(event.payload.channel),'MODEL_OUTSIDE_GRANT');
    if(policy)requireSafe(automation!.policyScopeMatches(grant as Grant<ReplyPolicy>,event),'MODEL_OUTSIDE_GRANT');
    if(checkAllowance)requireSafe(automation!.allowance(grant.version,'MODEL'),'MODEL_GRANT_EXHAUSTED');
  }else if(checkAllowance){const budget=store.budget('MODEL');requireSafe(budget.maximum===null||budget.used<budget.maximum,'MODEL_GRANT_EXHAUSTED');}
  return{grant,policy};
}

export function requireSuggestionEligibility(store:EventStore,authority:WorkbenchAuthority,automation:AutomationStore|null,event:StoredEvent,state:SuggestionState,checkAllowance=true):SuggestionAuthorization {
  requireSafe(!state.recovering,'LOGIN_RECOVERY_IN_PROGRESS');
  requireSafe(authority.mode()!=='OBSERVE'&&!authority.paused(),'MODEL_PAUSED');
  requireSafe(!automation?.state().emergencyStopped,'EMERGENCY_STOPPED');
  store.assertModelObservation(event.payload);
  requireSafe(!store.db.prepare('SELECT id FROM source_collisions WHERE event_id=? LIMIT 1').get(event.id),'TARGET_NEEDS_REVIEW');
  const paused=store.db.prepare('SELECT paused FROM pauses WHERE target_key=?').get(targetKey(event.payload)) as {paused:number}|undefined;
  requireSafe(!paused?.paused,'TARGET_PAUSED');
  const intent=store.db.prepare('SELECT id FROM send_intents WHERE event_id=?').get(event.id);
  const submitted=store.db.prepare("SELECT command_id FROM manual_send_commands WHERE event_id=? AND status<>'FAILED_BEFORE_CLICK' LIMIT 1").get(event.id);
  const hasTurns=store.db.prepare("SELECT name FROM sqlite_master WHERE name='human_reply_turns'").get()&&
    store.db.prepare('SELECT command_id FROM human_reply_turns WHERE event_id=? LIMIT 1').get(event.id);
  requireSafe(!intent&&!submitted&&!hasTurns,'SUGGESTION_ALREADY_SUBMITTED');
  requireSafe(['AWAITING_DRAFT','AWAITING_APPROVAL','APPROVED','MANUAL_REVIEW'].includes(event.status),'EVENT_NOT_DRAFTABLE');
  requireSafe(!state.modelBusy,'MODEL_ALREADY_PENDING');
  const authorization=requireSuggestionAuthorization(store,automation,event,state,checkAllowance);
  requireSafe(state.keyPresent,'MODEL_KEY_REQUIRED');return authorization;
}

export function suggestionEligibility(store:EventStore,authority:WorkbenchAuthority,automation:AutomationStore|null,event:StoredEvent,state:SuggestionState):SuggestionEligibility {
  try{requireSuggestionEligibility(store,authority,automation,event,state);return{eligible:true,reason:null};}
  catch(error){const code=error&&typeof error==='object'&&'code'in error?error.code:null;
    return{eligible:false,reason:typeof code==='string'&&/^[A-Z_]+$/u.test(code)?code:'SUGGESTION_NOT_AVAILABLE'};}
}

export function hasSuggestionAuthorization(automation:AutomationStore|null,state:Pick<SuggestionState,'settings'|'modelAuthorized'>):boolean {
  if(state.modelAuthorized)return true;
  const grant=automation?.active('MODEL')??automation?.active('AUTO_REPLY');return !!grant&&grant.scope.model===state.settings.model;
}
