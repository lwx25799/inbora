import { expect,test } from 'vitest';
import { writeFile,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recordEvidence,pruneEvidence } from '../../src/observability/evidence.js';
import { privateTemp } from '../helpers.js';

test('evidence enforces redacted metadata and retention touches only owned valid records',async()=>{
  const dir=privateTemp();const input={caseId:'H01' as const,browserVersion:'156.0.4314.58',mode:'headless' as const,
    taskId:null,action:'OBSERVE' as const,result:'UNVERIFIED' as const,source:'LOCAL_FIXTURE' as const,diagnostics:['SYNTHETIC'],proofDigest:null};
  await expect(recordEvidence(dir,{...input,diagnostics:['private message body']})).rejects.toThrow();
  const id=await recordEvidence(dir,input);const path=join(dir,`${id}.json`);const evidence=JSON.parse(await readFile(path,'utf8'));
  evidence.time='2020-01-01T00:00:00Z';await writeFile(path,JSON.stringify(evidence));await writeFile(join(dir,'keep.txt'),'user-owned');
  expect(await pruneEvidence(dir,14)).toBe(1);expect(await readFile(join(dir,'keep.txt'),'utf8')).toBe('user-owned');
});
