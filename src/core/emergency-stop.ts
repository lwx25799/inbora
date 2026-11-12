/** Fixed safety codes only: no page titles, selectors, private identifiers or exception text. */
export const platformStopCodes=[
  'OBSERVATION_PAGE_BLOCKED','OBSERVATION_UNEXPECTED_ORIGIN','OBSERVATION_SECURITY_TITLE','OBSERVATION_SECURITY_COMPONENT',
  'OBSERVATION_ACCOUNT_CHANGED','ACCOUNT_CHANGED','PLATFORM_STOP','CHALLENGE_REQUIRED','LOGIN_REQUIRED',
  'ACCOUNT_NOT_VERIFIED','UNEXPECTED_ORIGIN','OWNER_LOCKED_OR_PORT_UNAVAILABLE','OWN_WORKS_ACCOUNT_CHANGED',
  'NATIVE_REPLY_ACCOUNT_CHANGED','COMMENT_REPLY_ACCOUNT_CHANGED','NATIVE_REPLY_PAGE_BLOCKED','COMMENT_REPLY_PAGE_BLOCKED',
] as const;
export const emergencySources=['MANUAL','COLLECTION_COMMENTS','COLLECTION_DM','VERIFICATION','CONNECTION','AUTOMATIC_REPLY','UNKNOWN'] as const;
export type EmergencySource=typeof emergencySources[number];
export interface EmergencyStopInfo {
  reason:string;source:EmergencySource;stoppedAt:number|null;legacy:boolean;
}
const reasons=new Set<string>([...platformStopCodes,'MANUAL_EMERGENCY_STOP','EMERGENCY_REASON_UNKNOWN','LEGACY_EMERGENCY_STOP']);
export function safeEmergencyReason(reason:unknown):string {
  return typeof reason==='string'&&reasons.has(reason)?reason:'EMERGENCY_REASON_UNKNOWN';
}
