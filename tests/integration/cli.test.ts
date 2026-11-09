import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { privateTemp } from '../helpers.js';
import { OwnerLock } from '../../src/browser/owner-lock.js';
import { EventStore } from '../../src/storage/store.js';
import {existsSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {observedMapping} from '../fixtures/observed-site.js';
import { approved, snapshot, candidate } from '../helpers.js';

const cli = resolve('src/cli.ts');
function run(args: string[]) { return execFileSync(process.execPath, ['--import','tsx',cli,...args], { encoding: 'utf8' }); }
test('CLI init/status/restart/help work without touching a real site, real entry requires explicit access', () => {
  const root = join(privateTemp(), 'runtime');
  expect(run(['--help'])).toContain('inbora '+(JSON.parse(readFileSync('package.json','utf8')) as {version:string}).version);
  expect(JSON.parse(run(['init','--runtime',root]))).toEqual({ initialized: true });
  const status = JSON.parse(run(['status','--runtime',root]));
  expect(status.events).toEqual([]); expect(status.uncertain).toBe(0);
  const denied = spawnSync(process.execPath, ['--import','tsx',cli,'login','--runtime',root], { encoding: 'utf8', timeout: 10_000 });
  expect(denied.status).toBe(1); expect(denied.stdout).toContain('EXPLICIT_PRIVATE_ACCESS_REQUIRED');
  for(const command of ['retry-comment-once','verify-comment']){
    const denied=spawnSync(process.execPath,['--import','tsx',cli,command,'fixture-draft','--runtime',root],{encoding:'utf8',timeout:10000});
    expect(denied.status).toBe(1);expect(denied.stdout).toContain('EXPLICIT_PRIVATE_ACCESS_REQUIRED');
  }
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

test('CLI ordinary calls launch headless and label evidence with the actual mode, while only login can launch headed',()=>{
  const root=join(privateTemp('cli-mode-'),'runtime');run(['init','--runtime',root]);
  writeFileSync(join(root,'observation-mapping.json'),JSON.stringify({...observedMapping('https://www.douyin.com'),environment:'douyin'}));
  const launchFile=join(root,'synthetic-launch.json'),preload=join(root,'mode-preload.mjs');
  writeFileSync(preload,`import {writeFileSync} from 'node:fs';
    import {BrowserProfileOwner} from ${JSON.stringify(pathToFileURL(resolve('src/browser/profile-owner.ts')).href)};
    import {ObservedReader} from ${JSON.stringify(pathToFileURL(resolve('src/adapters/observed-reader.ts')).href)};
    BrowserProfileOwner.launch=async(_profile,headless)=>{writeFileSync(${JSON.stringify(launchFile)},JSON.stringify({headless}));
      return {notification:{},dm:{},actor:{run:async action=>action()},open:async()=>{},close:async()=>{},version:()=> '123.0.0.0'};};
    ObservedReader.prototype.dm=async()=>({events:[],evidenceId:'synthetic-only',loaded:0,unsupported:0});`);
  const invoke=(args:string[])=>spawnSync(process.execPath,['--import','tsx','--import',pathToFileURL(preload).href,cli,...args,'--runtime',root,
    '--real-account','--private-access'],{encoding:'utf8',timeout:10000});
  const observed=invoke(['observe','dm']);expect(observed.status,observed.stdout+observed.stderr).toBe(0);expect(JSON.parse(readFileSync(launchFile,'utf8'))).toEqual({headless:true});
  const evidence=readdirSync(join(root,'evidence')).filter(name=>/^[a-f0-9-]{36}\.json$/u.test(name));expect(evidence).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(root,'evidence',evidence[0]!),'utf8')).mode).toBe('headless');
  const login=invoke(['login']);expect(login.status).toBe(1);expect(login.stdout).toContain('INTERACTIVE_TERMINAL_REQUIRED');
  expect(JSON.parse(readFileSync(launchFile,'utf8'))).toEqual({headless:false});
});

test.each([{args:['observe','dm','--headed','HEADED_ONLY_FOR_LOGIN']},{args:['login','--headless','LOGIN_REQUIRES_HEADED']},
  {args:['compare-modes','BROWSER_MODE_COMPARISON_DISABLED']}])('CLI mode restriction rejects before runtime or browser work: $args',({args})=>{
  const expected=args.at(-1)!,root=join(privateTemp('cli-mode-denied-'),'missing-runtime');
  const result=spawnSync(process.execPath,['--import','tsx',cli,...args.slice(0,-1),'--runtime',root,'--real-account','--private-access'],
    {encoding:'utf8',timeout:10000});
  expect(result.status).toBe(1);expect(result.stdout).toContain(expected);expect(existsSync(root)).toBe(false);
});
