import { expect, test } from 'vitest';
import { fork } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { OwnerLock } from '../../src/browser/owner-lock.js';
import { privateTemp } from '../helpers.js';

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
