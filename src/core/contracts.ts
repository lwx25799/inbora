import { createHash } from 'node:crypto';
import { dmClockToleranceMs, type InboundEvent, type SendProof, type TargetSnapshot } from '../contracts/events.js';

export * from '../contracts/account.js';
export * from '../contracts/events.js';

export class Blocked extends Error {
  constructor(readonly code: string) { super(code); }
}
export function requireSafe(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Blocked(code);
}

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function targetKey(e: InboundEvent): string {
  return e.channel === 'DIRECT_MESSAGE'
    ? `dm:${e.conversationId ?? '?'}` : `comment:${e.videoId ?? '?'}:${e.commentId ?? '?'}`;
}
export function eventBinding(e: InboundEvent): string {
  const fields = [e.accountId, e.channel, e.platformEventId, e.actorId, e.text, e.occurredAt,
    e.videoId, e.commentId, e.conversationId, e.direction, e.kind];
  // Keep all pre-existing event bindings byte-for-byte compatible.
  if(e.observationIssue)fields.push(e.observationIssue);
  if(e.contentType)fields.push(e.contentType);
  if(e.rootCommentId!==undefined||e.replyToCommentId!==undefined)fields.push('NESTED_COMMENT',e.rootCommentId??null,e.replyToCommentId??null);
  return digest(fields);
}
export function isStrong(e: InboundEvent): boolean {
  return Boolean(!e.observationIssue && !e.contentType && e.platformEventId && e.actorId && (e.channel === 'DIRECT_MESSAGE'
    ? e.conversationId : e.videoId && e.commentId&&(e.kind!=='REPLY'||e.rootCommentId&&/^[1-9]\d{0,63}$/.test(e.rootCommentId)&&
      e.rootCommentId!==e.commentId&&e.replyToCommentId===e.commentId&&/^[1-9]\d{0,63}$/.test(e.commentId)&&
      e.occurredAt&&Number.isFinite(Date.parse(e.occurredAt)))));
}
export function isEligible(e: InboundEvent, ownId: string): boolean {
  return e.direction === 'INCOMING' && e.actorId !== ownId &&
    (e.channel === 'DIRECT_MESSAGE' ? e.kind === 'DM' : ['COMMENT', 'REPLY'].includes(e.kind));
}
export function isManualMediaCandidate(event:InboundEvent):boolean {
  return event.channel==='DIRECT_MESSAGE'&&event.direction==='INCOMING'&&event.kind==='DM'&&event.observationIssue==='DM_CONTENT_UNVERIFIED'&&
    !!event.contentType&&!!event.platformEventId&&!!event.actorId&&!!event.conversationId&&!!event.occurredAt&&Number.isFinite(Date.parse(event.occurredAt));
}
export function validManualMediaProof(event:InboundEvent,snapshot:TargetSnapshot):boolean {
  const proof=snapshot.manualObservation;
  return !!proof&&isManualMediaCandidate(event)&&proof.kind==='DM_MEDIA'&&proof.channel==='DIRECT_MESSAGE'&&proof.freshExact===true&&
    proof.eventBinding===eventBinding(event)&&snapshot.eventBinding===proof.eventBinding&&proof.contextDigest===snapshot.contextDigest&&
    proof.contentType===event.contentType&&Number.isSafeInteger(proof.nativeKind)&&proof.nativeKind>=0&&proof.nativeKind<=65535&&
    /^[a-f0-9]{64}$/u.test(proof.mediaDigest)&&/^[a-f0-9]{64}$/u.test(proof.contextDigest)&&
    snapshot.accountId===event.accountId&&snapshot.targetKey===targetKey(event)&&snapshot.composerKey===snapshot.targetKey&&event.actorId!==snapshot.ownId;
}
export function proofTimeValid(proof:SendProof,boundary:string,hasBaseline=true):boolean{
  const at=Date.parse(proof.sentAt),start=Date.parse(boundary),now=Date.now();
  if(!Number.isFinite(at)||at<Date.UTC(2000,0,1)||!Number.isFinite(start)||at>now+dmClockToleranceMs)return false;
  if(!proof.submission){
    if(!proof.clockSkew)return at>(hasBaseline?start:start+dmClockToleranceMs);
    const skew=proof.clockSkew;
    return proof.targetKey.startsWith('dm:')&&at>=start-dmClockToleranceMs&&skew.boundary===boundary&&
      skew.refreshedId===proof.id&&/^[a-f0-9]{64}$/.test(skew.baselineContextDigest)&&
      skew.baselineContextDigest===skew.remainingContextDigest;
  }
  const ack=proof.submission,request=Date.parse(ack.requestAt),response=Date.parse(ack.responseAt);
  return ack.boundary===boundary&&Number.isFinite(request)&&Number.isFinite(response)&&start<=request&&request<=response&&response<=now&&
    /^[a-f0-9]{64}$/.test(ack.requestDigest)&&/^[a-f0-9]{64}$/.test(ack.responseDigest);
}
export function validText(text: string): string {
  // The browser editor uses LF; canonicalize before persistence and human approval.
  text=text.replace(/\r\n?/gu,'\n');
  requireSafe(text.trim().length > 0 && [...text].length <= 500 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text), 'INVALID_TEXT');
  return text;
}
