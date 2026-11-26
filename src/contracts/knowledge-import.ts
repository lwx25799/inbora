import { z } from 'zod';

export const importMappingSchema=z.object({speakerColumn:z.string().max(100),textColumn:z.string().max(100),
  conversationColumn:z.string().max(100).optional(),timeColumn:z.string().max(100).optional(),selfName:z.string().trim().min(1).max(100),
  channel:z.enum(['DIRECT_MESSAGE','COMMENT_NOTIFICATION'])}).strict();
