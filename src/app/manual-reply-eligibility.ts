import {isManualMediaCandidate,isStrong,type StoredEvent} from '../core/contracts.js';
import type {EventStore} from '../storage/store.js';

/** A visible potential action, never an approval or a substitute for fresh browser proof. */
export function humanReplyEligibility(store:EventStore,event:StoredEvent,requireHumanDraft=true):{eligible:boolean;reason:string|null} {
  if(isStrong(event.payload)&&event.status!=='MANUAL_REVIEW')return {eligible:true,reason:null};
  if(!isManualMediaCandidate(event.payload)||event.status==='BASELINE'||event.status==='REJECTED')
    return {eligible:false,reason:event.payload.observationIssue==='DM_CONTENT_UNVERIFIED'?'TARGET_NEEDS_REVIEW':event.payload.observationIssue??'TARGET_NEEDS_REVIEW'};
  const collision=store.db.prepare('SELECT id FROM source_collisions WHERE event_id=? LIMIT 1').get(event.id);
  if(collision)return {eligible:false,reason:'TARGET_NEEDS_REVIEW'};
  const draft=store.db.prepare(`SELECT d.id,r.origin FROM reply_drafts d LEFT JOIN draft_revisions r ON r.draft_id=d.id AND r.version=d.version
    WHERE d.event_id=?`).get(event.id) as {id:string;origin:string|null}|undefined;
  if(requireHumanDraft&&draft&&draft.origin!=='HUMAN_TYPED')return {eligible:false,reason:'HUMAN_MEDIA_TEXT_REQUIRED'};
  return {eligible:true,reason:null};
}
