const domKeys=['visibleChildren','strongChildren','ownChildren','receiptCandidates','uniqueReceipt','serverRoot','serverChild','serverAuthor','serverText','serverTime',
  'serverConfirmed','domStatusConfirmed','tooltipBound','nativeConsistent','bodyMatches','bodyCandidates','bodyRawMatches','bodyRenderedMatches',
  'bodyRebuilt','bodyCommentNodes','bodyOtherTags','bodyTagKinds','bodySvgHidden','bodySvgEmpty','bodySvgIssue','authorMatches','notFlagged','proofs'] as const;
const pollKeys=['snapshots','rawProofs','newProofs','sameText','afterBoundary','notFuture','ackMatches','eligibleProofs','stableSnapshots'] as const;
const responseStages=['NONE','REQUEST','HTTP','SERVICE_WORKER','CONCURRENCY','SIZE','JSON','STALE','TARGET','SCHEMA','DUPLICATE','ROOT','ACCEPTED'] as const;
const failures=['NONE','NO_ACK','OLD_ACK','EMPTY','FILTERED','UNSTABLE','VERIFIED','GUARD_ERROR'] as const;
export type CommentProofCounts=Record<typeof domKeys[number],number>;
export interface CommentResponseStats {requests:number;responses:number;accepted:number;rows:number;stage:typeof responseStages[number]}
export interface CommentReadbackDiagnostic {
  stage:'ACK'|'POLL'|'VERIFY_EXISTING';reason:typeof failures[number];submissionEnabled:boolean;requestCount?:number;acknowledged?:boolean;
  submissionFailure?:string|null;responses:CommentResponseStats;dom?:CommentProofCounts;poll?:Record<typeof pollKeys[number],number>;
  guardCode?:string;
}
function count(value:unknown):number {return typeof value==='number'&&Number.isFinite(value)?Math.max(0,Math.min(10_000,Math.floor(value))):0;}
/** Explicit allowlist: never forwards a URL, native ID, body, exception or caller-supplied extra property. */
export function commentReadbackAudit(value:CommentReadbackDiagnostic){
  const knownSubmission=['INVALID_REQUEST','WORK_CHANGED','FORM_BINDING','MULTIPLE_SUBMISSIONS','INVALID_RESPONSE','HTTP_STATUS','BODY_LIMIT',
    'COMMENT_RESPONSE_BINDING','NAVIGATION'] as const;
  const knownGuards=['COMMENT_REPLY_CONTEXT_UNVERIFIED','COMMENT_REPLY_ORIGINAL_CHANGED','COMMENT_REPLY_ACCOUNT_CHANGED','COMMENT_REPLY_PAGE_BLOCKED',
    'COMMENT_REPLY_LIST_NOT_UNIQUE','COMMENT_REPLY_PROOF_AMBIGUOUS','COMMENT_REPLY_ID_COLLISION','COMMENT_REPLY_WINDOW_TOO_LARGE'] as const;
  const counts:Record<string,number|boolean>={submissionEnabled:value.submissionEnabled===true,requestCount:count(value.requestCount),acknowledged:value.acknowledged===true,
    getRequests:count(value.responses?.requests),getResponses:count(value.responses?.responses),getAccepted:count(value.responses?.accepted),getRows:count(value.responses?.rows)};
  for(const key of domKeys)counts['dom_'+key]=count(value.dom?.[key]);
  for(const key of pollKeys)counts['poll_'+key]=count(value.poll?.[key]);
  return {stage:['ACK','POLL','VERIFY_EXISTING'].includes(value.stage)?value.stage:'POLL',reason:failures.includes(value.reason)?value.reason:'GUARD_ERROR',
    responseStage:responseStages.includes(value.responses?.stage)?value.responses.stage:'NONE',
    submissionFailure:knownSubmission.find(code=>code===value.submissionFailure)??(value.submissionFailure?'OTHER':'NONE'),
    guardFailure:knownGuards.find(code=>code===value.guardCode)?.replace('COMMENT_REPLY_','')??(value.guardCode?'OTHER':'NONE'),counts};
}
