import { readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Blocked, requireSafe } from '../core/contracts.js';
import { assistantDpapi } from './dpapi.js';

export const discoverySchema = z.object({
  version: z.literal(1),
  runtime: z.string().min(1).max(1000),
  instanceId: z.uuid(),
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  secret: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type AssistantDiscovery = z.infer<typeof discoverySchema>;
export const discoveryFilename = 'local-assistant.dpapi';

export async function canonicalAssistantRoot(root: string): Promise<string> {
  try { return await realpath(resolve(root)); }
  catch { throw new Blocked('APP_NOT_RUNNING'); }
}

export async function readAssistantDiscovery(root: string): Promise<AssistantDiscovery> {
  const canonical = await canonicalAssistantRoot(root);
  const file = join(canonical, discoveryFilename);
  let encrypted: Buffer;
  try {
    requireSafe((await stat(file)).size <= 16_000, 'ASSISTANT_CREDENTIAL_INVALID');
    encrypted = await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Blocked('APP_NOT_RUNNING');
    if (error instanceof Blocked) throw error;
    throw new Blocked('ASSISTANT_CREDENTIAL_UNAVAILABLE');
  }
  const plain = await assistantDpapi(encrypted, 'Unprotect');
  try {
    let parsed: unknown;
    try { parsed = JSON.parse(plain.toString('utf8')); }
    catch { throw new Blocked('ASSISTANT_CREDENTIAL_INVALID'); }
    const checked = discoverySchema.safeParse(parsed);
    requireSafe(checked.success, 'ASSISTANT_CREDENTIAL_INVALID');
    requireSafe(checked.data.runtime === canonical, 'ASSISTANT_RUNTIME_MISMATCH');
    return checked.data;
  } finally { plain.fill(0); encrypted.fill(0); }
}

/** Only the owning Sidecar writes discovery; the MCP client never creates a runtime. */
export async function publishAssistantDiscovery(value: AssistantDiscovery): Promise<() => Promise<void>> {
  const descriptor = discoverySchema.parse(value);
  requireSafe(await canonicalAssistantRoot(descriptor.runtime) === descriptor.runtime, 'ASSISTANT_RUNTIME_MISMATCH');
  const file = join(descriptor.runtime, discoveryFilename);
  const temporary = `${file}.${randomUUID()}.tmp`;
  const plain = Buffer.from(JSON.stringify(descriptor));
  let encrypted: Buffer;
  try { encrypted = await assistantDpapi(plain, 'Protect'); }
  finally { plain.fill(0); }
  try {
    await writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
  return async () => {
    try {
      const current = await readFile(file);
      // A late cleanup from an old instance must not erase a newer descriptor.
      if (current.length === encrypted.length && timingSafeEqual(current, encrypted)) await rm(file, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    } finally { encrypted.fill(0); }
  };
}
