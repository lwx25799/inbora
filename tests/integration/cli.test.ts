import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { privateTemp } from '../helpers.js';
import { OwnerLock } from '../../src/browser/owner-lock.js';
import { EventStore } from '../../src/storage/store.js';
import { approved, snapshot, candidate } from '../helpers.js';

const cli = resolve('src/cli.ts');
function run(args: string[]) { return execFileSync(process.execPath, ['--import','tsx',cli,...args], { encoding: 'utf8' }); }
test('CLI init/status/restart/help work without touching a real site, real entry requires explicit access', () => {
  const root = join(privateTemp(), 'runtime');
  expect(run(['--help'])).toContain('inbora');
  expect(JSON.parse(run(['init','--runtime',root]))).toEqual({ initialized: true });
  const status = JSON.parse(run(['status','--runtime',root]));
  expect(status.events).toEqual([]); expect(status.uncertain).toBe(0);
  const denied = spawnSync(process.execPath, ['--import','tsx',cli,'login','--runtime',root], { encoding: 'utf8', timeout: 10_000 });
  expect(denied.status).toBe(1); expect(denied.stdout).toContain('EXPLICIT_PRIVATE_ACCESS_REQUIRED');
  const retryDenied=spawnSync(process.execPath,['--import','tsx',cli,'retry-comment-once','fixture-draft','--runtime',root],{encoding:'utf8',timeout:10000});
  expect(retryDenied.status).toBe(1);expect(retryDenied.stdout).toContain('EXPLICIT_PRIVATE_ACCESS_REQUIRED');
  expect(run(['status','--runtime',root])).toContain('budgets');
});

test('review: pause is accepted while worker owns runtime and must not recover its active intent',async()=>{
  const root=join(privateTemp(),'runtime');run(['init','--runtime',root]);const s=new EventStore(join(root,'poc.sqlite'));
  const draft=approved(s);const eventId=s.draft(draft).eventId;const intent=s.recordIntent(draft,snapshot(candidate()),false);
  const owner=await OwnerLock.acquire(root);
  try{
    const result=spawnSync(process.execPath,['--import','tsx',cli,'pause',eventId,'--runtime',root],{encoding:'utf8',timeout:10000});
    expect(result.status).toBe(0);expect(s.db.prepare('SELECT status FROM send_intents WHERE id=?').get(intent)).toEqual({status:'INTENT_RECORDED'});
  }finally{await owner.close();s.close();}
});

test('review: status recovers actionable event/draft IDs without exposing message text',()=>{
  const root=join(privateTemp(),'runtime');run(['init','--runtime',root]);const s=new EventStore(join(root,'poc.sqlite'));
  const draft=approved(s);const eventId=s.draft(draft).eventId;s.close();
  const output=run(['status','--runtime',root]);
  expect(output).toContain(eventId);expect(output).toContain(draft);expect(output).not.toContain('approved fixture reply');
});
