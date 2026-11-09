import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const roots = ['src', 'desktop/src', 'desktop/src-tauri/src', 'scripts', 'tests'];
const files = ['desktop/vite.config.ts', 'desktop/src-tauri/build.rs', 'vitest.config.ts'];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await collect(file);
    else if (/\.(?:ts|tsx|js|mjs|rs|css)$/u.test(file)) files.push(file);
  }
}
for (const root of roots) await collect(root);
const oversized = [];
let largest = { file: '', lines: 0 };
for (const file of files) {
  const source = await readFile(file, 'utf8');
  const lines = source.split('\n').length - Number(source.endsWith('\n'));
  if (lines > largest.lines) largest = { file, lines };
  if (lines > 800) oversized.push({ file, lines });
}
console.log(JSON.stringify({ sourceSize: oversized.length ? 'FAIL' : 'PASS', checked: files.length, maximum: 800, largest, oversized }));
if (oversized.length) process.exitCode = 1;
