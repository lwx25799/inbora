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
  const ownId=store.accountOwnId(auto.accountId);
  const hasGrantHistory=!!store.db.prepare("SELECT 1 FROM automation_grants WHERE kind IN ('MODEL','AUTO_REPLY') LIMIT 1").get()||
    !!store.db.prepare("SELECT 1 FROM audit_events WHERE event_type='PERSISTENT_GRANT_REVOKED' AND entity_id IN ('MODEL','AUTO_REPLY') LIMIT 1").get();
  if(ownId&&(remaining===null||remaining>0)&&!hasGrantHistory&&!auto.active('MODEL')&&!auto.active('AUTO_REPLY'))
    auto.grant('MODEL',{ownId,channels:['COMMENT_NOTIFICATION','DIRECT_MESSAGE'],model:settings.model,modelLimit:remaining,expiresAt:null});
}
