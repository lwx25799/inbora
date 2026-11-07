import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CredentialStore } from '../../src/app/credentials.js';
import { privateTemp } from '../helpers.js';

test('Windows current-user DPAPI opt-in roundtrips only encrypted bytes and supports deletion',async()=>{
  const root=privateTemp('dpapi-synthetic-'),store=new CredentialStore(root),key='synthetic-credential-roundtrip';
  expect(await store.load()).toBeNull();
  await store.save(key);
  const encrypted=await readFile(join(root,'model-key.dpapi'));
  expect(encrypted.includes(Buffer.from(key))).toBe(false);
  expect(await new CredentialStore(root).load()).toBe(key);
  await store.delete();expect(await store.load()).toBeNull();
  const save=store.save(key),remove=new CredentialStore(root).delete();
  await Promise.all([save,remove]);expect(await store.load()).toBeNull();
});
