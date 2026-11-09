import { mkdir, readdir, readFile, writeFile,lstat } from 'node:fs/promises';
import {lstatSync,readFileSync,unlinkSync} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import { z } from 'zod';
import {digest,requireSafe} from '../core/contracts.js';

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
export interface EvidenceProtection {ids:ReadonlySet<string>;complete:boolean;unknownReferences:number}
export interface EvidenceCapacity {files:number;bytes:number}
export interface EvidenceRetentionReport {
  scope:'EVIDENCE_METADATA';retentionDays:number;referencesComplete:boolean;unknownReferences:number;cancelled:boolean;
  total:EvidenceCapacity;recognized:EvidenceCapacity;expired:EvidenceCapacity;protected:EvidenceCapacity;
  eligible:EvidenceCapacity;unknown:EvidenceCapacity;deleted:EvidenceCapacity;remainingEligible:EvidenceCapacity;
}
export interface EvidenceRetentionOptions {
  protection?:EvidenceProtection;refreshProtection?:()=>EvidenceProtection;signal?:AbortSignal;now?:number;
}
interface Candidate {id:string;file:string;bytes:number;fingerprint:string;modified:number;inode:number;device:number}
const counter=():EvidenceCapacity=>({files:0,bytes:0});
const count=(capacity:EvidenceCapacity,bytes:number):void=>{capacity.files++;capacity.bytes+=bytes;};
export const evidenceUuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const unproven:EvidenceProtection={ids:new Set(),complete:false,unknownReferences:1};

async function inspect(directory:string,days:number,options:EvidenceRetentionOptions){
  const retentionDays=z.number().int().min(1).max(365).parse(days),protection=options.protection??unproven;
  const cutoff=(options.now??Date.now())-retentionDays*86_400_000,candidates:Candidate[]=[];
  const report:EvidenceRetentionReport={scope:'EVIDENCE_METADATA',retentionDays,referencesComplete:protection.complete,
    unknownReferences:protection.unknownReferences,cancelled:false,total:counter(),recognized:counter(),expired:counter(),
    protected:counter(),eligible:counter(),unknown:counter(),deleted:counter(),remainingEligible:counter()};
  let names:string[];
  try{
    const directoryStat=await lstat(directory);requireSafe(directoryStat.isDirectory()&&!directoryStat.isSymbolicLink(),'EVIDENCE_DIRECTORY_UNSAFE');
    names=(await readdir(directory)).sort();
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {report,candidates};throw error;}
  for(const [index,name] of names.entries()){
    if(options.signal?.aborted){report.cancelled=true;break;}
    if(index>0&&index%100===0)await setImmediate();
    if(options.signal?.aborted){report.cancelled=true;break;}
    const file=join(directory,name);let bytes=0;
    try{
      const stat=await lstat(file);bytes=stat.isFile()&&!stat.isSymbolicLink()?stat.size:0;count(report.total,bytes);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>64_000||!evidenceUuid.test(name.slice(0,-5))||!name.endsWith('.json')){
        count(report.unknown,bytes);continue;
      }
      const raw=await readFile(file,'utf8'),parsed=evidenceSchema.safeParse(JSON.parse(raw));
      if(!parsed.success||parsed.data.id+'.json'!==name){count(report.unknown,bytes);continue;}
      count(report.recognized,bytes);
      if(protection.ids.has(parsed.data.id))count(report.protected,bytes);
      if(Date.parse(parsed.data.time)>=cutoff)continue;
      count(report.expired,bytes);
      if(protection.ids.has(parsed.data.id)||!protection.complete)continue;
      count(report.eligible,bytes);
      candidates.push({id:parsed.data.id,file,bytes,fingerprint:digest(raw),modified:stat.mtimeMs,inode:stat.ino,device:stat.dev});
    }catch{count(report.unknown,bytes);}
  }
  report.cancelled||=options.signal?.aborted===true;
  report.remainingEligible={...report.eligible};return {report,candidates};
}

/** Capacity covers top-level evidence metadata. Unknown entries and links are counted and retained. */
export async function inspectEvidence(directory:string,days:number,options:EvidenceRetentionOptions={}):Promise<EvidenceRetentionReport> {
  return (await inspect(directory,days,options)).report;
}

/** At most 100 verified unreferenced records per call; no deletion without a complete reference snapshot. */
export async function maintainEvidence(directory:string,days:number,options:EvidenceRetentionOptions={}):Promise<EvidenceRetentionReport> {
  const {report,candidates}=await inspect(directory,days,options);
  if(report.cancelled)return report;
  const protection=options.refreshProtection?.()??options.protection??unproven;
  report.referencesComplete=protection.complete;report.unknownReferences=protection.unknownReferences;
  if(!protection.complete){report.eligible=counter();report.remainingEligible=counter();return report;}
  // Refresh and these bounded synchronous checks share one JS turn: no local collection can add a reference between them.
  for(const candidate of candidates.slice(0,100)){
    if(options.signal?.aborted){report.cancelled=true;break;}
    if(protection.ids.has(candidate.id)){
      count(report.protected,candidate.bytes);report.eligible.files--;report.eligible.bytes-=candidate.bytes;continue;
    }
    try{
      const directoryStat=lstatSync(directory),stat=lstatSync(candidate.file);
      if(!directoryStat.isDirectory()||directoryStat.isSymbolicLink()||!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||
        stat.size!==candidate.bytes||stat.mtimeMs!==candidate.modified||stat.ino!==candidate.inode||stat.dev!==candidate.device||
        digest(readFileSync(candidate.file,'utf8'))!==candidate.fingerprint)continue;
      unlinkSync(candidate.file);count(report.deleted,candidate.bytes);
    }catch{/* A replaced, locked or already absent record is retained or left for a later bounded pass. */}
  }
  report.remainingEligible={files:report.eligible.files-report.deleted.files,bytes:report.eligible.bytes-report.deleted.bytes};
  return report;
}

/** Compatibility wrapper; callers must supply proven references to permit deletion. */
export async function pruneEvidence(directory:string,days:number,options:EvidenceRetentionOptions={}):Promise<number> {
  return (await maintainEvidence(directory,days,options)).deleted.files;
}
