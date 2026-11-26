import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { expect, test } from 'vitest';
import { MAX_WORKER_FRAME_BYTES, type WorkerRequestEnvelope } from '../../src/contracts/browser-worker.js';
import { encodeWorkerRequest, readWorkerRequests, readWorkerResponses } from '../../src/workers/worker-protocol.js';

function forbiddenImports(source: string, directory: string): string[] {
  const imports = source.matchAll(/\b(?:from\s*|(?:import|require)\s*\(\s*|import\s*)(['"])([^'"\r\n]+)\1/gu);
  return Array.from(imports, match => match[2]!.replaceAll('\\', '/')).filter(specifier => {
    if (/^(?:node:)?better-sqlite3(?:\/|$)/u.test(specifier)) return true;
    const path = relative(resolve('src'), resolve(specifier.startsWith('.') ? directory : '.', specifier));
    if (isAbsolute(path)) return false;
    const module = path.split(sep).join('/');
    return /^storage(?:\/|$)|^app\/credentials(?:[./]|$)/u.test(module);
  });
}

test('dependency scan detects static, type-only, dynamic, and re-export dependencies', () => {
  expect(forbiddenImports(`
    import db from 'better-sqlite3';
    import type { EventStore } from '../../storage/store.js';
    const credential = import('../../app/credentials.js');
    export { read } from 'src/storage/read.js';
    import '../worker-protocol.js';
  `, resolve('src/workers/nested'))).toEqual([
    'better-sqlite3', '../../storage/store.js', '../../app/credentials.js', 'src/storage/read.js',
  ]);
});

test('all Worker source files stay outside SQLite, storage, and credentials', () => {
  const files = readdirSync(resolve('src/workers'), { recursive: true, withFileTypes: true })
    .filter(file => file.isFile() && /\.[cm]?[jt]sx?$/u.test(file.name));
  expect(files.length).toBeGreaterThanOrEqual(3);
  const violations = files.flatMap(file => {
    const name = resolve(file.parentPath, file.name);
    return forbiddenImports(readFileSync(name, 'utf8'), file.parentPath).map(dependency => `${name} -> ${dependency}`);
  });
  expect(violations).toEqual([]);
});

const request: WorkerRequestEnvelope = { id: randomUUID(), sessionId: randomUUID(), ownerEpoch: 1,
  command: { action: 'readback', intentId: randomUUID(), baseline: [], notBefore: '2026-11-25', text: '' } };

async function collect<T>(frames: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const frame of frames) results.push(frame);
  return results;
}

test('Worker stdio decodes split UTF-8 and coalesced frames at the byte limit', async () => {
  if (request.command.action !== 'readback') throw new Error('Expected a readback fixture');
  const overhead = encodeWorkerRequest(request).length - 1;
  const remaining = MAX_WORKER_FRAME_BYTES - overhead;
  const text = '字'.repeat(Math.floor(remaining / 3)) + 'a'.repeat(remaining % 3);
  const envelope = { ...request, command: { ...request.command, text } };
  const frame = encodeWorkerRequest(envelope);
  expect(frame.length).toBe(MAX_WORKER_FRAME_BYTES + 1);
  const split = frame.indexOf(Buffer.from('字')) + 1;
  expect(await collect(readWorkerRequests(Readable.from([
    frame.subarray(0, split), Buffer.concat([frame.subarray(split), encodeWorkerRequest(request)]),
  ])))).toEqual([envelope, request]);
  expect(() => encodeWorkerRequest({ ...envelope, command: { ...envelope.command, text: text + 'a' } }))
    .toThrow('WORKER_FRAME_TOO_LARGE');
});

test('Worker stdio rejects oversized unterminated frames, partial frames, and invalid envelopes', async () => {
  await expect(collect(readWorkerRequests(Readable.from([
    Buffer.alloc(MAX_WORKER_FRAME_BYTES, 0x20), Buffer.from(' '),
  ])))).rejects.toThrow('WORKER_FRAME_TOO_LARGE');
  await expect(collect(readWorkerRequests(Readable.from([Buffer.from('{}')])))).rejects.toThrow('WORKER_FRAME_TRUNCATED');
  await expect(collect(readWorkerRequests(Readable.from([Buffer.from('{}\n')])))).rejects.toThrow('WORKER_REQUEST_INVALID');
  await expect(collect(readWorkerResponses(Readable.from([Buffer.from('{}\n')])))).rejects.toThrow('WORKER_RESPONSE_INVALID');
});
