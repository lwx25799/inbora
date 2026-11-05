import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import { requireSafe } from '../core/contracts.js';
import { validateMapping, validateObservationMapping, validateDmReplyMapping,
  type SiteMapping, type ObservationMapping, type DmReplyMapping } from './site-mapping.js';

export const runtimeSchema = z.object({ version: z.literal(1), modelGrant: z.object({
  endpoint: z.url(), model: z.string().min(1), approvedAt: z.iso.datetime() }).nullable(),
  evidenceRetentionDays: z.number().int().min(1).max(365) });
export type RuntimeConfig = z.infer<typeof runtimeSchema>;
export function runtimeRoot(requested?: string): string {
  const root = resolve(requested ?? join(process.env.LOCALAPPDATA ?? '', 'inbora'));
  requireSafe(Boolean(requested || process.env.LOCALAPPDATA), 'LOCALAPPDATA_REQUIRED');
  const repo = resolve(import.meta.dirname, '../..'); const within = relative(repo, root);
  if (!within.startsWith('..') && !isAbsolute(within)) {
    const local = relative(join(repo, '.local'), root);
    requireSafe(!local.startsWith('..') && !isAbsolute(local), 'RUNTIME_MUST_BE_PRIVATE');
  }
  return root;
}
export async function initRuntime(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const canonical = await realpath(root);
  requireSafe(canonical.length > 3, 'INVALID_RUNTIME_DIRECTORY');
  await writeFile(join(root, 'runtime.json'), JSON.stringify({ version: 1, modelGrant: null, evidenceRetentionDays: 14 }), { flag: 'wx', mode: 0o600 });
}
export async function loadRuntime(root: string): Promise<RuntimeConfig> {
  return runtimeSchema.parse(JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8')));
}
export async function loadMapping(root: string): Promise<SiteMapping> {
  return validateMapping(JSON.parse(await readFile(join(root, 'site-mapping.json'), 'utf8')), true);
}
export async function loadObservationMapping(root: string): Promise<ObservationMapping | null> {
  let raw: string;
  try { raw = await readFile(join(root,'observation-mapping.json'),'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  return validateObservationMapping(JSON.parse(raw),true);
}
export async function loadDmReplyMapping(root:string):Promise<DmReplyMapping|null>{
  let raw:string;
  try{raw=await readFile(join(root,'dm-reply-mapping.json'),'utf8');}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  return validateDmReplyMapping(JSON.parse(raw),true);
}
