import { z } from 'zod';
import { requireSafe } from '../core/contracts.js';

const selector = z.string().min(1).max(2000);
export const fieldSchema = z.object({
  selector: selector.optional(), attribute: z.string().min(1).optional(),
  extract: z.object({ pattern: z.string().min(1).max(500), replacement: z.string().min(1).max(500) }).optional(),
});
export type Field = z.infer<typeof fieldSchema>;
const eventFields = z.object({
  platformEventId: fieldSchema.nullable(), actorId: fieldSchema.nullable(), actorName: fieldSchema.nullable(),
  text: fieldSchema, occurredAt: fieldSchema, videoId: fieldSchema.nullable(), commentId: fieldSchema.nullable(),
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
