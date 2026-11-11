import {Blocked} from '../core/contracts.js';
import {loadObservationMapping} from '../config/runtime.js';
import type {LocalAssistantStore} from '../storage/local-assistant-store.js';

const configurationEpochs=new WeakMap<LocalAssistantStore,number>();

/** Trusted connection setup only. Tools cannot create, renew or restore this authorization. */
export async function configureAssistantConnection(assistant:LocalAssistantStore,root:string,
  mode:'IF_NEW'|'ENABLE'|'DISABLE',check:()=>void=()=>{}):Promise<boolean>{
  const epoch=(configurationEpochs.get(assistant)??0)+(mode==='IF_NEW'?0:1);
  if(mode!=='IF_NEW')configurationEpochs.set(assistant,epoch);
  if(mode==='DISABLE'){check();assistant.revoke();return true;}
  if(mode==='IF_NEW'&&assistant.hasGrantHistory())return false;
  try{
    // Check readiness before I/O. Account or collection setup can finish on a later status request.
    assistant.connectedScope();
    const mapping=await loadObservationMapping(root);
    check();
    if((configurationEpochs.get(assistant)??0)!==epoch)return false;
    // A disable or another first connection may have completed while reading the mapping.
    if(mode==='IF_NEW'&&assistant.hasGrantHistory())return false;
    const scope=assistant.connectedScope();
    assistant.grant(scope,mapping?.self.uid===scope.ownId?mapping.works.map(work=>work.id):[]);
    return true;
  }catch(error){
    if(mode==='IF_NEW'&&error instanceof Blocked&&
      ['ACCOUNT_NOT_VERIFIED','ASSISTANT_COLLECTION_REQUIRED'].includes(error.code))return false;
    throw error;
  }
}
