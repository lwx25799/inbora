import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

export function sensitivePath(path) {
  return /(^|\/)(?:\.local|profiles?|evidence|logs|node_modules|dist)(\/|$)/i.test(path) ||
    /\.(?:sqlite(?:-wal|-shm)?|db|log|har)$/i.test(path) || /(^|\/)\.env(?:\.|$)/i.test(path) && !path.endsWith('.env.example');
}
export function hasSecret(text) {
  return /gh[pousr]_[a-zA-Z0-9]{24,}|github_pat_[a-zA-Z0-9_]{30,}|sk-[a-zA-Z0-9_-]{24,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(text);
}
if (process.argv.includes('--self-test')) {
  for (const p of ['.local/db/poc.sqlite','profile/Cookies','.env','data.db','trace.har']) assert.equal(sensitivePath(p),true);
  for (const p of ['src/browser/profile-owner.ts','docs/TEST-MATRIX.md','tests/fixtures/site.ts']) assert.equal(sensitivePath(p),false);
  assert.equal(hasSecret('ghp_'+'a'.repeat(36)),true); assert.equal(hasSecret('synthetic-contract-key'),false);
  console.log('privacy checker known-good/known-bad self-test passed');
} else {
  const git = (...args) => execFileSync('git',args,{encoding:'utf8',maxBuffer:30_000_000});
  const commits = git('rev-list','--all').trim().split(/\r?\n/u).filter(Boolean);
  const blobs = new Map();
  for (const ref of [...commits, ':INDEX:']) {
    const listing = ref === ':INDEX:' ? git('ls-files','--stage','-z') : git('ls-tree','-r','-z',ref);
    for (const record of listing.split('\0').filter(Boolean)) {
      const [metadata,path] = record.split('\t');
      if (sensitivePath(path)) throw new Error(`Forbidden tracked path: ${path}`);
      const hash = metadata.split(' ')[ref === ':INDEX:' ? 1 : 2];
      blobs.set(hash,path);
    }
  }
  for (const [hash,path] of blobs) {
    const text = git('cat-file','blob',hash);
    if (hasSecret(text)) throw new Error(`Credential signature in committed blob: ${path}`);
  }
  const samples = ['.local/probe','probe.sqlite','.env','node_modules/probe','dist/probe'];
  for (const sample of samples) git('check-ignore','--',sample);
  console.log(`privacy scan passed: ${commits.length} commits, ${blobs.size} unique staged/history blobs; no private runtime paths or credential signatures`);
}
