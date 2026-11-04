import { expect,test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventStore } from '../../src/storage/store.js';
import { privateTemp } from '../helpers.js';

test('hard process exit after committed intent recovers unknown without a receipt or click',async()=>{
  const dir=privateTemp();const file=join(dir,'poc.sqlite');const script=join(dir,'crash.mjs');
  await writeFile(script,`import {EventStore} from ${JSON.stringify(pathToFileURL(resolve('src/storage/store.ts')).href)};
import {approved,candidate,snapshot} from ${JSON.stringify(pathToFileURL(resolve('tests/helpers.ts')).href)};
const s=new EventStore(process.argv[2],true);const d=approved(s);s.recordIntent(d,snapshot(candidate()),true);process.exit(86);`);
  const child=spawnSync(process.execPath,['--import','tsx',script,file],{encoding:'utf8',timeout:10000});
  expect(child.status).toBe(86);const store=new EventStore(file);
  try{expect(store.recover()).toBe(1);expect(store.uncertain()).toHaveLength(1);
    expect(store.stats().budgets).toContainEqual({kind:'SEND',used:1,maximum:20});
    const event=store.events().find(e=>e.status==='UNCERTAIN');expect(event).toBeDefined();
    expect(()=>store.assertSendable(event!.id)).toThrow('EVENT_NOT_APPROVED');
  }finally{store.close();}
});
