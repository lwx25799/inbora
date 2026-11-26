import type {ClientCommand} from './contracts.js';
import type {PlatformConnector} from '../platform/platform-connector.js';
import type {EventStore} from '../storage/store.js';
import type {WorkbenchAuthority} from './authority.js';
import {BrowserDraftRecovery} from './browser-draft-recovery.js';

/** Browser controls share lifecycle callbacks with temporary human recovery. */
export async function handleBrowserCommand(input:{command:Extract<ClientCommand,{command:'browser'}>;token:string;
  store:EventStore;authority:WorkbenchAuthority;browser:PlatformConnector;suspend:()=>void;resume:()=>void;cancel:()=>void;
  resetRetry:()=>void}):Promise<{value?:unknown;status:boolean}>{
  const {command:c,token,browser}=input;
  input.authority.operator(token,'CONTROL');
  if('action' in c){
    const recovery=new BrowserDraftRecovery(input.store,input.authority,browser);
    return{value:c.action==='inspectSavedDraftRecovery'?await recovery.available(token):await recovery.clear(token,c),status:false};
  }
  if(c.open&&c.loginRecovery){
    input.suspend();
    try{await browser.beginLoginRecovery(!c.manualVisible);input.resetRetry();}
    catch(error){if(!browser.loginRecovery)input.resume();throw error;}
  }else if(c.open&&browser.loginRecovery){
    if(await browser.finishLoginRecovery())input.resume();
  }else if(c.open)await browser.open('headless');
  else {input.cancel();await browser.close();}
  return{status:true};
}
