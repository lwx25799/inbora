import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const caseIds = ['L01','L02','L03','N01','N02','N03','N04','N05','N06','N07','D01','D02','D03','D04','D05',
  'S01','S02','S03','S04','H01','H02','H03','M01','C01','C02','C03','C04','C05','C06'] as const;
export const evidenceSchema = z.object({
  version: z.literal(1), id: z.uuid(), time: z.iso.datetime(), caseId: z.enum(caseIds),
  browserVersion: z.string().regex(/^\d+\.\d+\.\d+\.\d+$/), mode: z.enum(['headed','headless']),
  taskId: z.uuid().nullable(), action: z.enum(['LOGIN','OBSERVE','APPROVE','SEND','RECOVERY','MODE_COMPARE','MANUAL_CHECK']),
  result: z.enum(['PASS','FAIL','UNVERIFIED','BLOCKED']),
  source: z.enum(['AUTOMATED_REAL','MANUAL_ATTESTATION','LOCAL_FIXTURE']),
  diagnostics: z.array(z.string().regex(/^[A-Z0-9_]+$/)).max(20),
  proofDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
});
export type EvidenceInput = Omit<z.infer<typeof evidenceSchema>, 'version' | 'id' | 'time'>;
export async function recordEvidence(directory: string, input: EvidenceInput): Promise<string> {
  const evidence = evidenceSchema.parse({ version: 1, id: randomUUID(), time: new Date().toISOString(), ...input });
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${evidence.id}.json`), JSON.stringify(evidence, null, 2), { flag: 'wx', mode: 0o600 });
  return evidence.id;
}
/** Retention only deletes recognized app-owned evidence records, never arbitrary files. */
export async function pruneEvidence(directory: string, days: number): Promise<number> {
  const cutoff = Date.now() - z.number().int().min(1).max(365).parse(days) * 86_400_000;
  await mkdir(directory, { recursive: true }); let count = 0;
  for (const name of await readdir(directory)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const path = join(directory, name);
    let evidence: z.infer<typeof evidenceSchema>;
    try { evidence = evidenceSchema.parse(JSON.parse(await readFile(path, 'utf8'))); } catch { continue; }
    if (new Date(evidence.time).getTime() < cutoff) { await unlink(path); count++; }
  }
  return count;
}
