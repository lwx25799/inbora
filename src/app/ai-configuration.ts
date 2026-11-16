import {randomUUID} from 'node:crypto';
import {writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import type {AiSettings} from './contracts.js';
import type {EventStore} from '../storage/store.js';
import type {AutomationStore} from '../storage/automation-store.js';

export async function saveAiSettings(root:string,settings:AiSettings){
  const file=join(root,'client-settings.json'),temporary=`${file}.${randomUUID()}.tmp`;
  await writeFile(temporary,JSON.stringify(settings),{flag:'wx',mode:0o600});await rename(temporary,file);
}
export function grantConfiguredModel(store:EventStore,auto:AutomationStore,settings:AiSettings){
  const budget=store.budget('MODEL'),remaining=budget.maximum===null?null:budget.maximum-budget.used;
  const own=store.db.prepare("SELECT own_id FROM accounts WHERE id='account_001'").get() as {own_id:string}|undefined;
  if(own&&(remaining===null||remaining>0)&&!auto.active('MODEL')&&!auto.active('AUTO_REPLY'))
    auto.grant('MODEL',{ownId:own.own_id,channels:['COMMENT_NOTIFICATION','DIRECT_MESSAGE'],model:settings.model,modelLimit:remaining,expiresAt:null});
}
