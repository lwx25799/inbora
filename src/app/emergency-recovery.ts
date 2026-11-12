import {requireSafe} from '../core/contracts.js';
import type {EventStore} from '../storage/store.js';
import type {AutomationStore} from '../storage/automation-store.js';
import type {WorkbenchAuthority} from './authority.js';
import type {BrowserService} from './browser-service.js';

/** A failed, cancelled or stale read-only check must never clear a persistent stop. */
export async function recoverEmergency(input:{store:EventStore;data:AutomationStore;authority:WorkbenchAuthority;
  browser:BrowserService;token:string;signal:AbortSignal;closing:()=>boolean}):Promise<void>{
  const {store,data,authority,browser,token,signal}=input;
  authority.operator(token,'CONTROL');
  const revision=data.emergencyRevision();
  const own=(store.db.prepare("SELECT own_id FROM accounts WHERE id='account_001'").get() as {own_id:string}|undefined)?.own_id;
  requireSafe(own,'ACCOUNT_NOT_VERIFIED');
  const check=()=>{
    authority.operator(token,'CONTROL');
    requireSafe(data.state().emergencyStopped&&data.emergencyRevision()===revision,'EMERGENCY_RECOVERY_CHANGED');
    requireSafe(!input.closing()&&!signal.aborted,
      signal.reason instanceof Error&&signal.reason.name==='TimeoutError'?'EMERGENCY_RECOVERY_TIMEOUT':'EMERGENCY_RECOVERY_CANCELLED');
    requireSafe((store.db.prepare("SELECT own_id FROM accounts WHERE id='account_001'").get() as {own_id:string}|undefined)?.own_id===own,'ACCOUNT_CHANGED');
  };
  check();
  let committed=false;
  const complete=()=>store.db.transaction(()=>{
    check();requireSafe(!committed,'EMERGENCY_RECOVERY_CHANGED');
    requireSafe(data.resumeEmergency(revision),'EMERGENCY_RECOVERY_CHANGED');
    authority.pause(token,null,false);committed=true;
  }).immediate();
  // Returning on cancellation does not release the browser actor early. Its queued task checks again
  // before touching a page, and any already-running read finishes without changing the stop.
  await new Promise<void>((resolve,reject)=>{
    const cancel=()=>{if(committed)return;try{check();}catch(error){reject(error);}};
    signal.addEventListener('abort',cancel,{once:true});
    const done=()=>signal.removeEventListener('abort',cancel);
    Promise.resolve().then(()=>{check();return browser.verifyEmergencyRecovery(own,signal,check,complete);})
      .then(()=>{done();try{requireSafe(committed,'EMERGENCY_RECOVERY_NOT_VERIFIED');resolve();}catch(error){reject(error);}},error=>{done();reject(error);});
  });
}
