import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { expect, test } from 'vitest';

const contracts = resolve('src/contracts');
const desktop = resolve('desktop/src');

function imports(source: string): string[] {
  // Covers static imports, re-exports, import() type expressions and runtime imports.
  return Array.from(source.matchAll(/\b(?:from\s*|(?:import|require)\s*\(\s*|import\s*)(['"])([^'"\r\n]+)\1/gu), match => match[2]!);
}

function isWithin(root: string, file: string): boolean {
  const path = relative(root, file);
  return !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep);
}

function violations(root: string, allowedRoots: string[], allowedPackages: RegExp): string[] {
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.[cm]?tsx?$/u.test(entry.name));
  expect(files.length).toBeGreaterThan(0);
  return files.flatMap(entry => {
    const file = resolve(entry.parentPath, entry.name);
    return imports(readFileSync(file, 'utf8')).filter(specifier =>
      specifier.startsWith('.') ? !allowedRoots.some(path => isWithin(path, resolve(entry.parentPath, specifier)))
        : !allowedPackages.test(specifier),
    ).map(specifier => `${relative(process.cwd(), file)} -> ${specifier}`);
  });
}

test('the dependency scan sees type-only, dynamic, and re-export dependencies', () => {
  expect(imports(`
    import type { Store } from '../storage/store.js';
    import 'playwright';
    export { read } from 'node:fs';
    type Crypto = typeof import('node:crypto');
    const db = require('better-sqlite3');
    const commands = import('../app/service.js');
  `)).toEqual(['../storage/store.js', 'playwright', 'node:fs', 'node:crypto', 'better-sqlite3', '../app/service.js']);
});

test('shared contracts depend only on other contracts and pure schema validation', () => {
  expect(violations(contracts, [contracts], /^zod$/u)).toEqual([]);
});

test('desktop source imports shared contracts without reaching backend modules', () => {
  expect(violations(desktop, [desktop, contracts], /^(?:react|react-dom(?:\/[\w-]+)?|@tauri-apps\/api\/[\w-]+|vitest)$/u))
    .toEqual([]);
});
