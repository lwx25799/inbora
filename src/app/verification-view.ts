import {digest,type StoredEvent} from '../core/contracts.js';
import type {EventStore} from '../storage/store.js';

interface VerificationRow {
  state:string;attempts:number;last_error:string|null;verified:number|null;
  evidence_ref:string|null;checked_at:number|null;boundary:string;
}

/** Read-only activity and failure explanations; the original job and receipt stay unchanged. */
export function readVerificationView(store:EventStore,event:StoredEvent,activeEventId?:string|null) {
  const row=store.db.prepare(`SELECT j.state,j.attempts,j.last_error,j.boundary,r.verified,r.evidence_ref,r.checked_at
    FROM verification_jobs j LEFT JOIN verification_results r ON r.intent_id=j.intent_id
    WHERE j.event_id=? ORDER BY r.rowid DESC LIMIT 1`).get(event.id) as VerificationRow|undefined;
  if(!row)return null;
  const {boundary,...view}=row,e=event.payload;
  if(e.channel==='COMMENT_NOTIFICATION'&&row.state==='REVIEW'&&row.verified===0&&row.checked_at!==null&&row.last_error==='NO_COMPLETE_PROOF'){
    const diagnostic=store.db.prepare(`SELECT time,event_type,detail_redacted FROM audit_events
      WHERE entity_id=? AND time>=? AND event_type LIKE 'COMMENT_READBACK_VERIFY_EXISTING_%' ORDER BY rowid DESC LIMIT 1`)
      .get(digest(['comment',e.videoId,e.commentId]),boundary) as {time:string;event_type:string;detail_redacted:string}|undefined;
    const age=diagnostic?row.checked_at-Date.parse(diagnostic.time):NaN;
    if(diagnostic&&age>=0&&age<=2000)try{
      const counts=JSON.parse(diagnostic.detail_redacted) as Record<string,unknown>;
      if(diagnostic.event_type.includes('_FILTERED_')&&counts.poll_sameText===1&&counts.poll_afterBoundary===0&&counts.poll_notFuture===1)
        view.last_error='COMMENT_TIME_BEFORE_INTENT';
      else if(diagnostic.event_type.includes('_EMPTY_')&&counts.dom_bodyCandidates===1&&counts.dom_bodyRawMatches===1&&counts.dom_bodyMatches===0)
        view.last_error='COMMENT_VISIBLE_BODY_UNVERIFIED';
    }catch{/* An unavailable diagnostic retains the original bounded reason. */}
  }
  return {...view,...(activeEventId===event.id?{state:'RUNNING'}:{})};
}
