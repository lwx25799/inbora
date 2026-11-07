import { expect, test } from 'vitest';
import { fork } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { OwnerLock } from '../../src/browser/owner-lock.js';
import { privateTemp } from '../helpers.js';
import {existsSync} from 'node:fs';

test('opening an existing owner directory never creates a missing one',async()=>{
  const directory=join(privateTemp(),'absent');let lock:OwnerLock|undefined,error:unknown;
  try{lock=await OwnerLock.acquire(directory,false);}catch(failure){error=failure;}finally{await lock?.close();}
  expect({code:(error as NodeJS.ErrnoException)?.code,created:existsSync(directory)}).toEqual({code:'ENOENT',created:false});
  const initialized=await OwnerLock.acquire(directory,true);await initialized.close();expect(existsSync(directory)).toBe(true);
  const reopened=await OwnerLock.acquire(directory,false);await reopened.close();
});

test('second process is denied for same canonical owner directory; crash releases OS lock', async () => {
  const directory = privateTemp(); const childFile = join(directory, 'lock-child.mjs');
  const module = pathToFileURL(resolve('src/browser/owner-lock.ts')).href;
  await writeFile(childFile, `import {OwnerLock} from ${JSON.stringify(module)}; await OwnerLock.acquire(process.argv[2]); process.send('locked');`);
  const child = fork(childFile, [directory], { execArgv: ['--import','tsx'], stdio: ['ignore','ignore','ignore','ipc'] });
  try {
    await new Promise<void>((resolve, reject) => { child.once('message', () => resolve()); child.once('error', reject); child.once('exit', code => reject(new Error('child exited '+code))); });
    await expect(OwnerLock.acquire(directory)).rejects.toThrow('OWNER_LOCKED');
    const stopped = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill(); await stopped;
    const replacement = await OwnerLock.acquire(directory); await replacement.close();
  } finally { if (child.exitCode === null) child.kill(); }
});
