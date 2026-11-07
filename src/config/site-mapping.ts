import { z } from 'zod';
import { requireSafe } from '../core/contracts.js';

const selector = z.string().min(1).max(2000);
export const observedSecurityBlockers='.uc-ui-verify-new_header-title,#captcha_container,[id^="captcha_container"],[data-e2e="captcha-container"]';
export const nativeCommentReplyPath='/aweme/v1/web/comment/list/reply/';
export const fieldSchema = z.object({
  selector: selector.optional(), attribute: z.string().min(1).optional(),
  extract: z.object({ pattern: z.string().min(1).max(500), replacement: z.string().min(1).max(500) }).optional(),
});
export type Field = z.infer<typeof fieldSchema>;
const eventFields = z.object({
  platformEventId: fieldSchema.nullable(), actorId: fieldSchema.nullable(), actorName: fieldSchema.nullable(),
  text: fieldSchema, occurredAt: fieldSchema.nullable(), videoId: fieldSchema.nullable(), commentId: fieldSchema.nullable(),
  conversationId: fieldSchema.nullable(), direction: fieldSchema, kind: fieldSchema,
});
const target = z.object({
  roots: selector, fields: eventFields,
  openReply: selector.nullable(), composer: selector, composerTarget: fieldSchema, send: selector,
  outgoingRows: selector,
  proof: z.object({ id: fieldSchema, ownId: fieldSchema, targetKey: fieldSchema, text: fieldSchema, pending: fieldSchema, sentAt: fieldSchema }),
});
export const mappingSchema = z.object({
  version: z.literal(1), environment: z.enum(['fixture', 'douyin']), origin: z.url(),
  observedAt: z.iso.datetime(), evidenceRef: z.string().min(1), ownId: z.string().min(1),
  guards: z.object({ loggedIn: selector, loginRequired: selector, challenge: selector, stopped: selector, ownIdentity: fieldSchema }),
  notification: z.object({ entry: selector, panel: selector, rows: selector, fields: eventFields, jump: selector.nullable() }),
  dm: z.object({ entry: selector, list: selector, rows: selector, activeRow: selector, conversationId: fieldSchema, peerId: fieldSchema,
    select: selector, pane: selector, activeId: fieldSchema, activePeerId: fieldSchema, messages: selector, fields: eventFields }),
  targets: z.object({ COMMENT_NOTIFICATION: target, DIRECT_MESSAGE: target }),
  directionValues: z.record(z.string(), z.enum(['INCOMING', 'OUTGOING', 'SYSTEM', 'UNKNOWN'])),
  kindValues: z.record(z.string(), z.enum(['COMMENT', 'REPLY', 'DM', 'LIKE', 'FOLLOW', 'SYSTEM', 'UNKNOWN'])),
});
export type SiteMapping = z.infer<typeof mappingSchema>;
export type EventFields = z.infer<typeof eventFields>;
export function validateMapping(value: unknown, real: boolean): SiteMapping {
  const mapping = mappingSchema.parse(value); const url = new URL(mapping.origin);
  requireSafe(url.origin === mapping.origin && !url.username && !url.password, 'INVALID_ORIGIN');
  if (real) requireSafe(mapping.environment === 'douyin' && mapping.origin === 'https://www.douyin.com', 'REAL_MAPPING_REQUIRED');
  else requireSafe(mapping.environment === 'fixture' && url.protocol === 'http:' &&
    ['127.0.0.1', 'localhost'].includes(url.hostname), 'LOCAL_FIXTURE_REQUIRED');
  return mapping;
}

// Read-only calibration can be installed before reply controls have been verified.
const nativeId = z.string().regex(/^\d{1,64}$/);
const secureId = z.string().regex(/^[A-Za-z0-9_-]{1,300}$/);
export const observationMappingSchema = z.object({
  version: z.literal(1), purpose: z.literal('observation'), environment: z.enum(['fixture', 'douyin']),
  origin: z.url(), entryUrl: z.url(), observedAt: z.iso.datetime(), evidenceRef: z.string().min(1),
  securityBlockers:selector.default(observedSecurityBlockers),
  self: z.object({ uid: nativeId, secUid: secureId }),
  peers: z.array(z.object({ uid: nativeId, secUid: secureId, conversationId: z.string().min(1).max(512), title: z.string().min(1) })).min(1).max(2),
  works: z.array(z.object({ id: nativeId, url: z.url() })).min(1).max(2),
  selectors: z.object({
    selfAvatar: selector, selfFiberDepth: z.number().int().min(0).max(8),
    dmEntry: selector, dmPanel: selector, conversationRows: selector, conversationTitle: selector,
    conversationList: selector.nullable().default(null),
    conversationFiberDepth: z.number().int().min(0).max(3),
    conversationSelectEvent: z.enum(['click','mousedown']),
    chat: selector, chatHeader: selector, chatTitle: selector, chatBack: selector,
    messages: selector, messageBox: selector, fromMeClass: z.string().min(1), messageText: selector,
    commentList: selector, commentEntry: selector, commentRows: selector, commentText: selector, commentAuthor: selector, commentTooltip: selector,
    commentEmpty: selector.nullable().default(null),
    commentFiberDepth: z.number().int().min(0).max(3),
  }),
});
export type ObservationMapping = z.infer<typeof observationMappingSchema>;
export function validateObservationMapping(value: unknown, real: boolean): ObservationMapping {
  const mapping = observationMappingSchema.parse(value); const origin = new URL(mapping.origin);
  requireSafe(origin.origin === mapping.origin && !origin.username && !origin.password, 'INVALID_ORIGIN');
  requireSafe(real ? mapping.environment === 'douyin' && mapping.origin === 'https://www.douyin.com' :
    mapping.environment === 'fixture' && origin.protocol === 'http:' && ['127.0.0.1','localhost'].includes(origin.hostname),
  real ? 'REAL_MAPPING_REQUIRED' : 'LOCAL_FIXTURE_REQUIRED');
  for (const url of [mapping.entryUrl, ...mapping.works.map(w => w.url)]) {
    const parsed = new URL(url);
    requireSafe(parsed.origin === mapping.origin && !parsed.username && !parsed.password && !parsed.hash, 'UNSAFE_OBSERVATION_URL');
  }
  requireSafe(mapping.works.every(w => new URL(w.url).pathname === `/video/${w.id}` || new URL(w.url).pathname === `/note/${w.id}`),
    'OBSERVATION_WORK_ID_CONFLICT');
  for (const key of ['uid','secUid','conversationId'] as const)
    requireSafe(new Set(mapping.peers.map(p => p[key])).size === mapping.peers.length, 'OBSERVATION_PEER_COLLISION');
  requireSafe(!mapping.peers.some(p => p.uid === mapping.self.uid || p.secUid === mapping.self.secUid), 'OBSERVATION_SELF_AS_PEER');
  requireSafe(new Set(mapping.works.map(w => w.id)).size === mapping.works.length, 'OBSERVATION_WORK_COLLISION');
  return mapping;
}

/** Installed separately: an observation mapping alone never enables reply controls. */
export const dmReplyMappingSchema = z.object({
  version: z.literal(1), purpose: z.literal('dm-reply'),
  observation: observationMappingSchema,
  observedAt: z.iso.datetime(), evidenceRef: z.string().min(1),
  blockers: selector,
  composer: selector, send: selector, pending: selector, failed: selector,
  composerScope: selector, composerFiberDepth: z.number().int().min(0).max(3),
  latestIndexAncestor: selector,
  submission: z.enum(['html-click','svg-click-event']),
  confirmedServerStatus: z.number().int(),
  textMessageType: z.number().int(),
  submissionReceipts:z.boolean().default(false),
});
export type DmReplyMapping = z.infer<typeof dmReplyMappingSchema>;
export function validateDmReplyMapping(value: unknown, real: boolean): DmReplyMapping {
  const mapping=dmReplyMappingSchema.parse(value);
  validateObservationMapping(mapping.observation,real);
  return mapping;
}

/** Direct replies to a verified level-one comment; never a new top-level comment. */
export const commentReplyMappingSchema=z.object({
  version:z.literal(1),purpose:z.literal('comment-reply'),observation:observationMappingSchema,
  observedAt:z.iso.datetime(),evidenceRef:z.string().min(1),blockers:selector,
  replyAction:selector,composerScope:selector,composerFiberDepth:z.number().int().min(0).max(3),
  composer:selector,send:selector,pending:selector,failed:selector,
  portalWorkIds:z.array(nativeId).max(2).default([]),
  submissionReceipts:z.boolean().default(false),
  rootLevel:z.literal(1),confirmedStatus:z.number().int(),
});
export type CommentReplyMapping=z.infer<typeof commentReplyMappingSchema>;
export function validateCommentReplyMapping(value:unknown,real:boolean):CommentReplyMapping{
  const mapping=commentReplyMappingSchema.parse(value);validateObservationMapping(mapping.observation,real);
  requireSafe(new Set(mapping.portalWorkIds).size===mapping.portalWorkIds.length&&mapping.portalWorkIds.every(id=>mapping.observation.works.some(w=>w.id===id)),
    'COMMENT_PORTAL_WORK_SCOPE_REQUIRED');return mapping;
}
