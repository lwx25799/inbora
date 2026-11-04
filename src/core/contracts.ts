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
  occurredAt: z.string().min(1),
  videoId: z.string().min(1).nullable(),
  commentId: z.string().min(1).nullable(),
  conversationId: z.string().min(1).nullable(),
  direction: z.enum(['INCOMING', 'OUTGOING', 'SYSTEM', 'UNKNOWN']),
  kind: z.enum(['COMMENT', 'REPLY', 'DM', 'LIKE', 'FOLLOW', 'SYSTEM', 'UNKNOWN']),
  evidenceId: z.string().min(1),
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
  return digest([e.accountId, e.channel, e.platformEventId, e.actorId, e.text, e.occurredAt,
    e.videoId, e.commentId, e.conversationId, e.direction, e.kind]);
}
export function isStrong(e: InboundEvent): boolean {
  return Boolean(e.platformEventId && e.actorId && (e.channel === 'DIRECT_MESSAGE'
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
  id: string; ownId: string; targetKey: string; text: string; pending: boolean;
}
export interface ReplyAdapter {
  inspect(event: InboundEvent): Promise<TargetSnapshot>;
  prepare(event: InboundEvent, text: string): Promise<void>;
  verifyPrepared(event: InboundEvent, text: string): Promise<TargetSnapshot>;
  baseline(event: InboundEvent): Promise<string[]>;
  clickOnce(): Promise<void>;
  readback(event: InboundEvent, text: string, before: string[]): Promise<SendProof | null>;
}
export function validText(text: string): string {
  requireSafe(text.trim().length > 0 && [...text].length <= 500 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text), 'INVALID_TEXT');
  return text;
}
