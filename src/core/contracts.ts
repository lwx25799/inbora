import { createHash } from 'node:crypto';
import { z } from 'zod';

export class Blocked extends Error {
  constructor(readonly code: string) { super(code); }
}
export function requireSafe(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Blocked(code);
}
export const channelSchema = z.enum(['COMMENT_NOTIFICATION', 'DIRECT_MESSAGE']);
export type Channel = z.infer<typeof channelSchema>;
export const eventSchema = z.object({
  accountId: z.literal('account_001'),
  channel: channelSchema,
  platformEventId: z.string().min(1).nullable(),
  actorId: z.string().min(1).nullable(),
  actorName: z.string().nullable(),
  text: z.string().min(1).max(10_000),
  occurredAt: z.string().min(1).nullable(),
  occurredAtPrecisionMs: z.number().int().min(1).max(86_400_000).optional(),
  videoId: z.string().min(1).nullable(),
  commentId: z.string().min(1).nullable(),
  conversationId: z.string().min(1).nullable(),
  direction: z.enum(['INCOMING', 'OUTGOING', 'SYSTEM', 'UNKNOWN']),
  kind: z.enum(['COMMENT', 'REPLY', 'DM', 'LIKE', 'FOLLOW', 'SYSTEM', 'UNKNOWN']),
  evidenceId: z.string().min(1),
  discovery: z.enum(['NOTIFICATION', 'ALLOWED_WORK', 'DIRECT_MESSAGE']).optional(),
  observationIssue: z.literal('COMMENT_TEXT_UNVERIFIED').optional(),
});
export type InboundEvent = z.infer<typeof eventSchema>;
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
  return digest(fields);
}
export function isStrong(e: InboundEvent): boolean {
  return Boolean(!e.observationIssue && e.platformEventId && e.actorId && (e.channel === 'DIRECT_MESSAGE'
    ? e.conversationId : e.videoId && e.commentId));
}
export function isEligible(e: InboundEvent, ownId: string): boolean {
  return e.direction === 'INCOMING' && e.actorId !== ownId &&
    (e.channel === 'DIRECT_MESSAGE' ? e.kind === 'DM' : ['COMMENT', 'REPLY'].includes(e.kind));
}
export type EventStatus = 'BASELINE' | 'AWAITING_DRAFT' | 'AWAITING_APPROVAL' | 'APPROVED' |
  'MANUAL_REVIEW' | 'INTENT_RECORDED' | 'CONFIRMED' | 'UNCERTAIN' | 'REJECTED';
export interface StoredEvent { id: string; payload: InboundEvent; binding: string; status: EventStatus }
export interface TargetSnapshot {
  accountId: string;
  ownId: string;
  targetKey: string;
  eventBinding: string;
  contextDigest: string;
  composerKey: string;
  mappingDigest: string;
}
export interface Draft {
  id: string; eventId: string; text: string; model: string; version: number;
  status: 'DRAFT' | 'APPROVED' | 'REJECTED';
  approval: { snapshot: TargetSnapshot; textDigest: string; version: number } | null;
}
export interface SendProof {
  id: string; ownId: string; targetKey: string; text: string; pending: boolean; sentAt: string;
  submission?:{boundary:string;requestAt:string;responseAt:string;requestDigest:string;responseDigest:string};
  clockSkew?:{boundary:string;baselineContextDigest:string;remainingContextDigest:string;refreshedId:string};
}
export const dmClockToleranceMs=2000;
export function proofTimeValid(proof:SendProof,boundary:string):boolean{
  const at=Date.parse(proof.sentAt),start=Date.parse(boundary),now=Date.now();
  if(!Number.isFinite(at)||at<Date.UTC(2000,0,1)||!Number.isFinite(start)||at>now)return false;
  if(!proof.submission){
    if(!proof.clockSkew)return at>start;
    const skew=proof.clockSkew;
    return proof.targetKey.startsWith('dm:')&&at>=start-dmClockToleranceMs&&skew.boundary===boundary&&
      skew.refreshedId===proof.id&&/^[a-f0-9]{64}$/.test(skew.baselineContextDigest)&&
      skew.baselineContextDigest===skew.remainingContextDigest;
  }
  const ack=proof.submission,request=Date.parse(ack.requestAt),response=Date.parse(ack.responseAt);
  return ack.boundary===boundary&&Number.isFinite(request)&&Number.isFinite(response)&&start<=request&&request<=response&&response<=now&&
    /^[a-f0-9]{64}$/.test(ack.requestDigest)&&/^[a-f0-9]{64}$/.test(ack.responseDigest);
}
export interface ReplyAdapter {
  inspect(event: InboundEvent): Promise<TargetSnapshot>;
  prepare(event: InboundEvent, text: string): Promise<void>;
  verifyPrepared(event: InboundEvent, text: string): Promise<TargetSnapshot>;
  baseline(event: InboundEvent): Promise<string[]>;
  clickOnce(notBefore?:string): Promise<void>;
  readback(event: InboundEvent, text: string, before: string[], notBefore: string): Promise<SendProof | null>;
}
export function validText(text: string): string {
  // The browser editor uses LF; canonicalize before persistence and human approval.
  text=text.replace(/\r\n?/gu,'\n');
  requireSafe(text.trim().length > 0 && [...text].length <= 500 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text), 'INVALID_TEXT');
  return text;
}
