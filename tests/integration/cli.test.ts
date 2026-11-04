import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { privateTemp } from '../helpers.js';

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
  expect(run(['status','--runtime',root])).toContain('budgets');
});
