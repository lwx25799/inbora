import { z } from 'zod';
import { accountIdSchema, type AccountId } from './account.js';

export const channelSchema = z.enum(['COMMENT_NOTIFICATION', 'DIRECT_MESSAGE']);
export type Channel = z.infer<typeof channelSchema>;
export const eventSchema = z.object({
  accountId: accountIdSchema,
  channel: channelSchema,
  platformEventId: z.string().min(1).nullable(),
  actorId: z.string().min(1).nullable(),
  actorName: z.string().nullable(),
  text: z.string().min(1).max(10_000),
  occurredAt: z.string().min(1).nullable(),
  occurredAtPrecisionMs: z.number().int().min(1).max(86_400_000).optional(),
  videoId: z.string().min(1).nullable(),
  commentId: z.string().min(1).nullable(),
  rootCommentId: z.string().regex(/^[1-9]\d{0,63}$/).optional(),
  // The exact inbound child to reply to; not the original message's intermediate parent.
  replyToCommentId: z.string().regex(/^[1-9]\d{0,63}$/).optional(),
  conversationId: z.string().min(1).nullable(),
  direction: z.enum(['INCOMING', 'OUTGOING', 'SYSTEM', 'UNKNOWN']),
  kind: z.enum(['COMMENT', 'REPLY', 'DM', 'LIKE', 'FOLLOW', 'SYSTEM', 'UNKNOWN']),
  evidenceId: z.string().min(1),
  discovery: z.enum(['NOTIFICATION', 'ALLOWED_WORK', 'DIRECT_MESSAGE']).optional(),
  observationIssue: z.enum(['COMMENT_TEXT_UNVERIFIED', 'COMMENT_PARENT_UNVERIFIED', 'DM_CONTENT_UNVERIFIED']).optional(),
  contentType: z.enum(['IMAGE', 'VIDEO', 'AUDIO', 'MIXED']).optional(),
}).refine(event=>!event.contentType||event.channel==='DIRECT_MESSAGE'&&event.observationIssue==='DM_CONTENT_UNVERIFIED',
  {message:'DM_MEDIA_NEEDS_UNVERIFIED_CONTENT',path:['contentType']})
  .refine(event=>event.observationIssue!=='DM_CONTENT_UNVERIFIED'||event.channel==='DIRECT_MESSAGE',
    {message:'DM_CONTENT_REQUIRES_DIRECT_MESSAGE',path:['observationIssue']})
  .refine(event=>event.rootCommentId===undefined&&event.replyToCommentId===undefined||event.channel==='COMMENT_NOTIFICATION'&&
    event.kind==='REPLY'&&event.rootCommentId!==undefined&&event.rootCommentId!==event.commentId&&event.replyToCommentId===event.commentId,
    {message:'NESTED_COMMENT_TARGET_REQUIRED',path:['rootCommentId']})
  .refine(event=>event.observationIssue!=='COMMENT_PARENT_UNVERIFIED'||event.channel==='COMMENT_NOTIFICATION'&&event.kind==='REPLY',
    {message:'COMMENT_PARENT_REQUIRES_REPLY',path:['observationIssue']});
export type InboundEvent = z.infer<typeof eventSchema>;

export type EventStatus = 'BASELINE' | 'AWAITING_DRAFT' | 'AWAITING_APPROVAL' | 'APPROVED' |
  'MANUAL_REVIEW' | 'INTENT_RECORDED' | 'CONFIRMED' | 'UNCERTAIN' | 'REJECTED';
export interface StoredEvent { id: string; payload: InboundEvent; binding: string; status: EventStatus }
export interface TargetSnapshot {
  accountId: AccountId;
  ownId: string;
  targetKey: string;
  eventBinding: string;
  contextDigest: string;
  composerKey: string;
  mappingDigest: string;
  manualObservation?:ManualMediaProof;
}
export interface ManualMediaProof {
  kind:'DM_MEDIA';channel:'DIRECT_MESSAGE';eventBinding:string;contextDigest:string;
  contentType:'IMAGE'|'VIDEO'|'AUDIO'|'MIXED';nativeKind:number;mediaDigest:string;freshExact:true;
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

export interface ReplyAdapter {
  inspect(event: InboundEvent): Promise<TargetSnapshot>;
  prepare(event: InboundEvent, text: string): Promise<void>;
  cancelPreparation?(event: InboundEvent, text: string): Promise<void>;
  verifyPrepared(event: InboundEvent, text: string): Promise<TargetSnapshot>;
  baseline(event: InboundEvent): Promise<string[]>;
  clickOnce(notBefore?:string, check?:()=>void): Promise<void>;
  readback(event: InboundEvent, text: string, before: string[], notBefore: string): Promise<SendProof | null>;
}
