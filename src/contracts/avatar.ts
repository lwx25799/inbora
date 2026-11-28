import { z } from 'zod';

export const AVATAR_MAX_BYTES = 262_144;
export const AVATAR_MAX_DATA_URL_BYTES = 360_000;
export const AVATAR_CACHE_MAX_ENTRIES = 500;

export const avatarRoleSchema = z.enum(['ACCOUNT', 'CUSTOMER']);
export type AvatarRole = z.infer<typeof avatarRoleSchema>;

export const getAvatarPreviewCommandSchema = z.object({
  command: z.literal('getAvatarPreview'),
  role: avatarRoleSchema,
  key: z.string().min(1).max(256),
}).strict();
export type GetAvatarPreviewCommand = z.infer<typeof getAvatarPreviewCommandSchema>;

export interface AvatarPreviewResult {
  found: boolean;
  dataUrl: string | null;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | null;
  bytes: number;
  sha256: string | null;
}
