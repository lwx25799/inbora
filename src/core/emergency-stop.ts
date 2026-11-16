/** Fixed safety codes only: no page titles, selectors, private identifiers or exception text. */
export const platformStopCodes=[
  'OBSERVATION_SECURITY_SUSPECT','SECURITY_CHANNEL_HELD','SECURITY_VERIFICATION_CONFIRMED',
  'OBSERVATION_PAGE_BLOCKED','OBSERVATION_UNEXPECTED_ORIGIN','OBSERVATION_SECURITY_TITLE','OBSERVATION_SECURITY_COMPONENT',
  'OBSERVATION_ACCOUNT_CHANGED','ACCOUNT_CHANGED','PLATFORM_STOP','CHALLENGE_REQUIRED','LOGIN_REQUIRED',
  'ACCOUNT_NOT_VERIFIED','UNEXPECTED_ORIGIN','OWNER_LOCKED_OR_PORT_UNAVAILABLE','OWN_WORKS_ACCOUNT_CHANGED',
  'NATIVE_REPLY_ACCOUNT_CHANGED','COMMENT_REPLY_ACCOUNT_CHANGED','NATIVE_REPLY_PAGE_BLOCKED','COMMENT_REPLY_PAGE_BLOCKED',
] as const;
/** A diagnostic match is not proof of a challenge or an account-wide failure. */
export const securityCandidateCodes=new Set<string>([
  'OBSERVATION_SECURITY_SUSPECT','OBSERVATION_SECURITY_TITLE','OBSERVATION_SECURITY_COMPONENT',
]);
export const globalStopCodes=[
  'OBSERVATION_UNEXPECTED_ORIGIN','OBSERVATION_ACCOUNT_CHANGED','ACCOUNT_CHANGED','PLATFORM_STOP',
  'CHALLENGE_REQUIRED','SECURITY_VERIFICATION_CONFIRMED','UNEXPECTED_ORIGIN','OWN_WORKS_ACCOUNT_CHANGED',
  'NATIVE_REPLY_ACCOUNT_CHANGED','COMMENT_REPLY_ACCOUNT_CHANGED',
] as const;
const globalFailures=new Set<string>(globalStopCodes);
export function shouldStopGlobally(code:string):boolean {return globalFailures.has(code);}
export const emergencySources=['MANUAL','COLLECTION_COMMENTS','COLLECTION_DM','VERIFICATION','CONNECTION','AUTOMATIC_REPLY','UNKNOWN'] as const;
export type EmergencySource=typeof emergencySources[number];
export interface EmergencyStopInfo {
  reason:string;source:EmergencySource;stoppedAt:number|null;legacy:boolean;
}
const reasons=new Set<string>([...platformStopCodes,'MANUAL_EMERGENCY_STOP','EMERGENCY_REASON_UNKNOWN','LEGACY_EMERGENCY_STOP']);
export function safeEmergencyReason(reason:unknown):string {
  return typeof reason==='string'&&reasons.has(reason)?reason:'EMERGENCY_REASON_UNKNOWN';
}
