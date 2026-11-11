import { expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('source tsx starts the actual official SDK server, discovers sixteen tools, calls it, and closes on EOF', async () => {
  const run = promisify(execFile);
  const { stdout, stderr } = await run(process.execPath, ['scripts/mcp-smoke.mjs', '--source'], {
    timeout: 25_000, windowsHide: true,
  });
  expect(stderr).toBe('');
  expect(JSON.parse(stdout)).toMatchObject({ mode: 'tsx', handshake: 'PASS', tools: 16, offline: 'APP_NOT_RUNNING', exitedOnEof: true });
});
