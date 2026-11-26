import { expect, test } from 'vitest';
import { fork } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { digest } from '../../src/core/contracts.js';
import { OwnerLock, ownerLockErrorCode, ownerLockPort, ownerLockPortBase, ownerLockPortSpan } from '../../src/browser/owner-lock.js';
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

test('close is idempotent, port hash preserves cross-version compatibility, and EACCES is distinct from EADDRINUSE', async () => {
  const directory = privateTemp('owner-lock-hardening-');
  const lock = await OwnerLock.acquire(directory);
  let canonical = await realpath(directory);
  if (process.platform === 'win32') canonical = canonical.toLowerCase();
  expect(ownerLockPortBase).toBe(20_000);
  expect(ownerLockPortSpan).toBe(40_000);
  expect(lock.port).toBe(ownerLockPort(canonical));
  expect(lock.port).toBe(20_000 + (Number.parseInt(digest(canonical).slice(0, 8), 16) % 40_000));
  expect(lock.port).toBeGreaterThanOrEqual(ownerLockPortBase);
  expect(lock.port).toBeLessThan(ownerLockPortBase + ownerLockPortSpan);
  for (let i = 0; i < 200; i++) {
    const syntheticPath = `/synthetic/owner-dir-${i}`;
    const port = ownerLockPort(syntheticPath);
    const legacy = 20_000 + (Number.parseInt(digest(syntheticPath).slice(0, 8), 16) % 40_000);
    expect(port).toBe(legacy);
    expect(port).toBeGreaterThanOrEqual(20_000);
    expect(port).toBeLessThanOrEqual(59_999);
  }
  expect(ownerLockErrorCode({ code: 'EADDRINUSE' })).toBe('OWNER_LOCKED_OR_PORT_UNAVAILABLE');
  expect(ownerLockErrorCode({ code: 'EACCES' })).toBe('OWNER_PORT_RESERVED');
  await Promise.all([lock.close(), lock.close()]);
  await lock.close();
  const reopened = await OwnerLock.acquire(directory, false);
  await reopened.close();
});
