import {randomUUID} from 'node:crypto';
import {requireSafe,type Channel} from '../core/contracts.js';
import type {EventStore} from './store.js';
import {isEmergencyStopped} from './emergency-stop.js';

export interface SecurityHold {
  revision:string;incidentId:string;channel:Channel;reason:string;mode:'headed'|'headless';heldAt:number;
  source:string;documentDigest?:string;
}
export type SecurityHoldInput=Omit<SecurityHold,'revision'|'channel'|'heldAt'|'source'>&{source?:string};
const held='SECURITY_CHANNEL_HELD',resolved='SECURITY_CHANNEL_RESOLVED';
export function securityHoldEntity(accountId:string,channel:Channel):string {
  return accountId+':'+channel;
}
function latest(store:Pick<EventStore,'accountId'|'db'>,channel:Channel){
  return store.db.prepare('SELECT id,event_type,time,detail_redacted FROM audit_events WHERE entity_id=? AND event_type IN (?,?) ORDER BY rowid DESC LIMIT 1')
    .get(securityHoldEntity(store.accountId,channel),held,resolved) as {id:string;event_type:string;time:string;detail_redacted:string}|undefined;
}
/** Independent of mode and capability attestations; only the bound recovery can append RESOLVED. */
export function readSecurityHold(store:Pick<EventStore,'accountId'|'db'>,channel:Channel):SecurityHold|null {
  const row=latest(store,channel);if(!row||row.event_type===resolved)return null;
  const fallback:SecurityHold={revision:row.id,incidentId:row.id,channel,reason:'SECURITY_STATE_UNREADABLE',mode:'headless',heldAt:Date.parse(row.time)||0,source:'UNKNOWN'};
  try{
    const value=JSON.parse(row.detail_redacted) as Partial<SecurityHold>;
    if(typeof value.incidentId!=='string'||!/^[-a-zA-Z0-9_]{1,128}$/u.test(value.incidentId)||
      typeof value.reason!=='string'||!value.reason.match(/^[A-Z_]{1,100}$/u)||
      !['headed','headless'].includes(value.mode??'')||typeof value.heldAt!=='number'||!Number.isSafeInteger(value.heldAt)||
      typeof value.source!=='string'||!value.source.match(/^[A-Z_]{1,100}$/u)||
      value.documentDigest!==undefined&&!/^[a-f0-9]{64}$/u.test(value.documentDigest))return fallback;
    return {...fallback,...value,revision:row.id,channel} as SecurityHold;
  }catch{return fallback;}
}
export function securityRevision(store:Pick<EventStore,'accountId'|'db'>,channel:Channel):string {
  const channelRevision=latest(store,channel)?.id??'CLEAR';
  const global=store.db.prepare("SELECT id FROM audit_events WHERE event_type IN ('EMERGENCY_STOPPED','EMERGENCY_RESUMED') ORDER BY rowid DESC LIMIT 1")
    .get() as {id:string}|undefined;
  return global?channelRevision+':'+global.id:channelRevision;
}
export function holdSecurityChannel(store:EventStore,channel:Channel,input:SecurityHoldInput,now=Date.now()):SecurityHold {
  requireSafe(/^[-a-zA-Z0-9_]{1,128}$/u.test(input.incidentId)&&/^[A-Z_]{1,100}$/u.test(input.reason)&&
    ['headed','headless'].includes(input.mode)&&Number.isSafeInteger(now)&&now>0&&
    /^[A-Z_]{1,100}$/u.test(input.source??'UNKNOWN')&&
    (input.documentDigest===undefined||/^[a-f0-9]{64}$/u.test(input.documentDigest)),'INVALID_SECURITY_HOLD');
  return store.db.transaction(()=>{
    const previous=readSecurityHold(store,channel);if(previous?.incidentId===input.incidentId)return previous;
    const value:SecurityHold={...input,source:input.source??'UNKNOWN',channel,revision:randomUUID(),heldAt:now};
    const {revision,...detail}=value;
    store.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?)').run(revision,new Date(now).toISOString(),held,securityHoldEntity(store.accountId,channel),JSON.stringify(detail));
    return value;
  }).immediate();
}
export function resolveSecurityHold(store:EventStore,channel:Channel,expectedRevision:string,now=Date.now(),check?:()=>void):boolean {
  return store.db.transaction(()=>{
    check?.();
    const value=readSecurityHold(store,channel);if(!value||value.revision!==expectedRevision)return false;
    store.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?)').run(randomUUID(),new Date(now).toISOString(),resolved,securityHoldEntity(store.accountId,channel),
      JSON.stringify({incidentId:value.incidentId,previousRevision:expectedRevision}));return true;
  }).immediate();
}
export function assertSecurityChannelClear(store:Pick<EventStore,'accountId'|'db'>,channel:Channel):void {
  requireSafe(!isEmergencyStopped(store),'EMERGENCY_STOPPED');
  requireSafe(!readSecurityHold(store,channel),'SECURITY_CHANNEL_HELD');
}
export function assertSecurityRevision(store:Pick<EventStore,'accountId'|'db'>,channel:Channel,expected:string):void {
  assertSecurityChannelClear(store,channel);requireSafe(securityRevision(store,channel)===expected,'SECURITY_STATE_CHANGED');
}
