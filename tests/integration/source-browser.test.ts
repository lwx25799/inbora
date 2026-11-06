import { expect,test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { privateTemp } from '../helpers.js';

test('source CLI tsx runtime can serialize browser inspection and native click guard',async()=>{
  const dir=privateTemp();const script=join(dir,'source-browser.mjs');
  const moduleUrl=(path:string)=>JSON.stringify(pathToFileURL(resolve(path)).href);
  await writeFile(script,`import {BrowserProfileOwner} from ${moduleUrl('src/browser/profile-owner.ts')};
import {DomAdapter} from ${moduleUrl('src/adapters/dom-adapter.ts')};
import {SendCoordinator} from ${moduleUrl('src/core/send-coordinator.ts')};
import {fixtureServer,mapping,rowData} from ${moduleUrl('tests/fixtures/site.ts')};
import {database} from ${moduleUrl('tests/helpers.ts')};
const server=await fixtureServer();const owner=await BrowserProfileOwner.launch(process.argv[2],true);const store=database();
try{await owner.open(server.origin);const dm=new DomAdapter(owner.dm,'DIRECT_MESSAGE',mapping(server.origin));
store.observe('DIRECT_MESSAGE','conversation-1',[],'own-1','fixture');
await owner.dm.evaluate(e=>window.addDm('conversation-1',e),rowData('dm'));
const batch=await dm.observeDm('conversation-1','peer-1');const id=store.observe('DIRECT_MESSAGE','conversation-1',batch.events,'own-1',batch.evidenceId)[0];
const draft=store.saveDraft(id,'source runtime fixture reply','mock');store.approve(draft.id,await dm.inspect(store.event(id).payload),draft.version,draft.text);
console.log(await new SendCoordinator(store,owner.actor).send(draft.id,dm,false));
}finally{store.close();await owner.close();await server.close();}`);
  const result=spawnSync(process.execPath,['--import','tsx',script,join(dir,'profile')],{encoding:'utf8',timeout:15000});
  expect(result.stderr).toBe('');expect(result.status).toBe(0);expect(result.stdout).toContain('CONFIRMED');
});

test('source runtime reads calibrated metadata after guarded conversation opening',()=>{
  const result=spawnSync(process.execPath,['--import','tsx',resolve('scripts/observed-smoke.mjs'),'source'],
    {encoding:'utf8',timeout:20000});
  expect(result.stderr).toBe('');expect(result.status).toBe(0);
  expect(result.stdout).toContain('"observedReaderSmoke":"PASS"');
  expect(result.stdout).toContain('"sends":0');
});

test('source runtime performs a native SVG fixture reply through durable intent and readback',()=>{
  const result=spawnSync(process.execPath,['--import','tsx',resolve('scripts/dm-reply-smoke.mjs'),'source'],
    {encoding:'utf8',timeout:20000});
  expect(result.stderr).toBe('');expect(result.status).toBe(0);
  expect(result.stdout).toContain('"nativeDmReplySmoke":"PASS"');
  expect(result.stdout).toContain('"realSends":0');
});
test('source runtime replies to an exact root comment with durable intent and bound readback',()=>{
  const result=spawnSync(process.execPath,['--import','tsx',resolve('scripts/comment-reply-smoke.mjs'),'source'],
    {encoding:'utf8',timeout:20000});
  expect(result.stderr).toBe('');expect(result.status).toBe(0);
  expect(result.stdout).toContain('"nativeCommentReplySmoke":"PASS"');expect(result.stdout).toContain('"realSends":0');
});

test('source runtime correlates both native submission responses through a fresh page model',()=>{
  const result=spawnSync(process.execPath,['--import','tsx',resolve('scripts/submission-smoke.mjs'),'source'],{encoding:'utf8',timeout:20000});
  expect(result.stderr).toBe('');expect(result.status).toBe(0);
  expect(result.stdout).toContain('"submissionSmoke":"PASS"');expect(result.stdout).toContain('"refreshedCrossClockProofs":2');
});
