import {randomUUID} from 'node:crypto';
import {platformStopCodes,emergencySources,safeEmergencyReason,type EmergencySource,type EmergencyStopInfo} from '../core/emergency-stop.js';
import type {EventStore} from './store.js';

function latest(store:EventStore){
  return store.db.prepare("SELECT id,event_type,detail_redacted FROM audit_events WHERE event_type IN ('EMERGENCY_STOPPED','EMERGENCY_RESUMED') ORDER BY rowid DESC LIMIT 1")
    .get() as {id:string;event_type:string;detail_redacted:string}|undefined;
}
export function emergencyRevision(store:EventStore):string {
  return latest(store)?.id??'LEGACY';
}
export function readEmergencyStop(store:EventStore):EmergencyStopInfo {
  const row=latest(store);
  if(row?.event_type==='EMERGENCY_STOPPED'){
    try{
      const value:unknown=JSON.parse(row.detail_redacted);
      if(value&&typeof value==='object'){
        const v=value as Record<string,unknown>;
        if(emergencySources.includes(v.source as EmergencySource)&&typeof v.legacy==='boolean'&&
          (v.legacy?v.stoppedAt===null:typeof v.stoppedAt==='number'&&Number.isSafeInteger(v.stoppedAt)&&v.stoppedAt>0))
          return {reason:safeEmergencyReason(v.reason),source:v.source as EmergencySource,stoppedAt:v.stoppedAt as number|null,legacy:v.legacy};
      }
    }catch{/* Old or damaged details cannot establish an original cause or timestamp. */}
  }
  // A previous channel error is only a diagnostic hint; it does not prove what caused a legacy stop.
  const candidates=(store.db.prepare('SELECT source,last_error FROM collection_progress WHERE last_error IS NOT NULL').all() as
    {source:string;last_error:string}[]).filter(r=>(platformStopCodes as readonly string[]).includes(r.last_error));
  const hint=candidates.length===1?candidates[0]:undefined;
  return {reason:hint?hint.last_error:'LEGACY_EMERGENCY_STOP',source:hint?.source==='works'?'COLLECTION_COMMENTS':
    hint?.source==='dm'?'COLLECTION_DM':'UNKNOWN',stoppedAt:null,legacy:true};
}
export function recordEmergencyStop(store:EventStore,stopped:boolean,now:number,reason:string,source:EmergencySource):void {
  store.db.transaction(()=>{
    const current=store.db.prepare('SELECT emergency_stopped FROM automation_state WHERE id=1').get() as {emergency_stopped:number};
    if(!stopped&&!current.emergency_stopped)return;
    const detail=stopped?(current.emergency_stopped?readEmergencyStop(store):{
      reason:safeEmergencyReason(reason),source:emergencySources.includes(source)?source:'UNKNOWN',stoppedAt:now,legacy:false}):{};
    store.db.prepare('UPDATE automation_state SET emergency_stopped=? WHERE id=1').run(Number(stopped));
    store.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?)').run(randomUUID(),new Date(now).toISOString(),
      stopped?'EMERGENCY_STOPPED':'EMERGENCY_RESUMED','account_001',JSON.stringify(detail));
  }).immediate();
}
export function resumeEmergency(store:EventStore,expectedRevision:string,now:number):boolean {
  return store.db.transaction(()=>{
    const row=store.db.prepare('SELECT emergency_stopped FROM automation_state WHERE id=1').get() as {emergency_stopped:number};
    if(!row.emergency_stopped||emergencyRevision(store)!==expectedRevision)return false;
    recordEmergencyStop(store,false,now,'EMERGENCY_REASON_UNKNOWN','UNKNOWN');return true;
  }).immediate();
}
