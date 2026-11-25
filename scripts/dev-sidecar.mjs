import { spawn } from 'node:child_process';
import { watch as watchDirectory } from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_V2_BYTES = 1_048_576;
const MAX_BRIDGE_BYTES = 262_144;
const BRIDGE_SLOT_MS = 10_000;
const requestLimit = { 1: 100_000, 2: MAX_V2_BYTES };
const responseLimit = { 1: 2_000_000, 2: MAX_V2_BYTES };
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const protocolPrefix = /^\s*\{\s*"protocol"\s*:\s*([12])\s*[,}]/u;
const bridgePrefix = /^\s*\{\s*(?:"bridgeId"\s*:\s*"[^"]+"\s*,\s*)?"kind"\s*:\s*"native_bridge_(?:response|request)"/u;

function extractPrefixRequestId(line) {
  const prefix = line.slice(0, 512);
  const protocol = Number(protocolPrefix.exec(prefix)?.[1] ?? 1);
  const id = /^\s*\{\s*"protocol"\s*:\s*[12]\s*,\s*"requestId"\s*:\s*"([a-f0-9-]{36})"\s*[,}]/iu.exec(prefix)?.[1];
  return { protocol, requestId: id && uuid.test(id) ? id : null };
}

function boundedLines(stream, limits, onLine, onOversized, onEnd) {
  const max = Math.max(...Object.values(limits));
  const buffer = Buffer.allocUnsafe(max + 1);
  let size = 0;
  let limit = max;
  let discarding = false;
  const data = chunk => {
    for (let start = 0; start < chunk.length;) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline === -1 ? chunk.length : newline;
      if (!discarding) {
        if (size < 512) {
          const count = Math.min(end - start, 512 - size);
          chunk.copy(buffer, size, start, start + count);
          size += count;
          start += count;
          const prefix = buffer.toString('utf8', 0, size);
          limit = bridgePrefix.test(prefix) ? MAX_BRIDGE_BYTES : limits[protocolPrefix.exec(prefix)?.[1]] ?? max;
        }
        const count = Math.min(end - start, limit + 1 - size);
        chunk.copy(buffer, size, start, start + count);
        size += count;
        const payloadSize = size - Number(buffer[size - 1] === 0x0d);
        if (start + count < end || payloadSize > limit) {
          discarding = true;
          const prefix = buffer.toString('utf8', 0, Math.min(size, 512));
          if (!bridgePrefix.test(prefix)) onOversized(extractPrefixRequestId(prefix));
        } else if (newline !== -1) onLine(buffer.toString('utf8', 0, payloadSize));
      }
      if (newline === -1) break;
      start = newline + 1;
      size = 0;
      limit = max;
      discarding = false;
    }
  };
  stream.on('data', data);
  if (onEnd) stream.once('end', onEnd);
  return () => { stream.off('data', data); if (onEnd) stream.off('end', onEnd); stream.pause(); };
}

function pruneBridgeSlots(owner) {
  const now = Date.now();
  for (const [id, { expiresAt }] of owner?.bridges ?? []) {
    if (expiresAt <= now) owner.bridges.delete(id);
  }
}

/** Development-only pipe supervisor. Reloads source; never queues or replays business commands. */
export class DevelopmentSidecar {
  constructor({ root, secret, input = process.stdin, output = process.stdout,
    entry = join(root, 'src/app/sidecar.ts'), watch = true }) {
    if (!/^[a-f0-9]{64}$/.test(secret ?? '')) throw new Error('TRUSTED_DESKTOP_PARENT_REQUIRED');
    this.root = resolve(root);
    this.secret = secret;
    this.input = input;
    this.output = output;
    this.entry = resolve(entry);
    this.watch = watch;
    this.pending = new Map();
    this.generation = 0;
    this.current = undefined;
    this.runtime = undefined;
    this.closed = false;
    this.reloading = false;
    this.starting = false;
    this.previousUnsafeExit = false;
    this.sourceRevision = 0;
  }

  write(value) { this.output.write(JSON.stringify(value) + '\n'); }
  reply(id, error, protocol = 1) { this.write({ protocol, requestId: id, ok: false, error }); }
  event(event) { this.write({ protocol: 1, event: { event } }); }
  authenticated(value) {
    return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) &&
      timingSafeEqual(Buffer.from(value), Buffer.from(this.secret));
  }

  async start() {
    this.stopReading = boundedLines(this.input, requestLimit, line => this.receive(line),
      ({ protocol, requestId }) => this.reply(requestId, 'IPC_REQUEST_TOO_LARGE', protocol), () => { void this.close(); });
    if (this.watch) {
      this.watcher = watchDirectory(join(this.root, 'src'), { recursive: true }, (_event, filename) => {
        if (!filename || !/\.tsx?$/u.test(String(filename))) return;
        this.sourceRevision++;
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => { void this.restart().catch(() => this.event('backend_unavailable')); }, 250);
      });
      this.watcher.on('error', () => this.event('backend_watch_unavailable'));
    }
    await this.boot(false);
  }

  receive(line) {
    const bytes = Buffer.byteLength(line);
    const owner = this.current;
    pruneBridgeSlots(owner);
    const prefix = extractPrefixRequestId(line);
    let envelope;
    try {
      if (bytes > MAX_V2_BYTES) {
        if (!bridgePrefix.test(line.slice(0, 512))) {
          this.reply(prefix.requestId, 'IPC_REQUEST_TOO_LARGE', prefix.protocol);
        }
        return;
      }
      envelope = JSON.parse(line);
    } catch {
      this.reply(prefix.requestId, bytes > requestLimit[prefix.protocol] ? 'IPC_REQUEST_TOO_LARGE' : 'INVALID_COMMAND', prefix.protocol);
      return;
    }
    if (envelope?.kind === 'native_bridge_response') {
      if (bytes <= MAX_BRIDGE_BYTES && this.authenticated(envelope.secret) &&
        owner?.child.stdin.writable && owner.bridges.delete(envelope.bridgeId)) owner.child.stdin.write(line + '\n');
      return;
    }
    const { protocol, requestId } = envelope ?? {};
    const reject = error => this.reply(typeof requestId === 'string' && uuid.test(requestId) ? requestId : null,
      error, protocol === 2 ? 2 : 1);
    if (protocol !== 1 && protocol !== 2) return reject('INVALID_COMMAND');
    if (bytes > requestLimit[protocol]) return reject('IPC_REQUEST_TOO_LARGE');
    if (typeof requestId !== 'string' || !uuid.test(requestId)) return reject('INVALID_COMMAND');
    if (!this.authenticated(envelope.secret)) return reject('IPC_AUTHENTICATION_FAILED');
    if (typeof envelope.body?.command !== 'string') return reject('INVALID_COMMAND');
    if (this.closed) return reject('DEV_BACKEND_UNAVAILABLE_RESTART_REQUIRED');
    if (this.reloading || this.starting) return reject('DEV_BACKEND_RESTARTING_READ_STATUS');
    if (!owner || owner.child.exitCode !== null || !owner.child.stdin.writable) return reject('DEV_BACKEND_UNAVAILABLE_RESTART_REQUIRED');
    if (this.pending.has(requestId) || this.pending.size >= 128) return reject('IPC_REQUEST_ALREADY_PENDING');
    // Retain only routing metadata, not request bodies, Keys, text or send parameters.
    const item = { generation: owner.generation, protocol, command: envelope.body.command };
    this.pending.set(requestId, item);
    owner.child.stdin.write(line + '\n', error => {
      if (error && this.pending.get(requestId) === item) {
        this.pending.delete(requestId);
        reject('DEV_BACKEND_UNAVAILABLE_RESTART_REQUIRED');
      }
    });
  }

  accept(owner, line) {
    if (this.current !== owner) return;
    pruneBridgeSlots(owner);
    const bytes = Buffer.byteLength(line);
    if (bytes > responseLimit[1]) return this.rejectOversized(owner, extractPrefixRequestId(line));
    let value;
    try { value = JSON.parse(line); } catch { return; }
    if (value?.kind === 'native_bridge_request') {
      const id = value.bridgeId;
      if (bytes > MAX_BRIDGE_BYTES || !this.authenticated(value.secret) || typeof id !== 'string' ||
        !uuid.test(id) || !owner.child.stdin.writable || owner.bridges.has(id)) return;
      const busy = () => {
        if (this.current === owner && owner.child.stdin.writable) owner.child.stdin.write(JSON.stringify({
          kind: 'native_bridge_response', bridgeId: id, secret: this.secret, ok: false, error: 'NATIVE_BRIDGE_BUSY',
        }) + '\n');
      };
      if (owner.bridges.size >= 128) return busy();
      const slot = { expiresAt: Date.now() + BRIDGE_SLOT_MS };
      owner.bridges.set(id, slot);
      const failed = () => {
        if (owner.bridges.get(id) !== slot) return;
        owner.bridges.delete(id);
        busy();
      };
      try { this.output.write(line + '\n', error => { if (error) failed(); }); }
      catch { failed(); }
      return;
    }
    if (value?.protocol !== 1 && value?.protocol !== 2) return;
    if (bytes > responseLimit[value.protocol]) return this.rejectOversized(owner, value);
    if (value.protocol === 1 && value.ready === true) {
      if (!owner.readySeen) {
        owner.readySeen = true;
        // Advance the native cache generation before an internally restored connect can unprotect credentials.
        this.write({ protocol: 1, ready: true });
        owner.ready();
      }
      return;
    }
    const item = this.pending.get(value.requestId);
    if (item?.generation === owner.generation && item.protocol === value.protocol) {
      this.pending.delete(value.requestId);
      if (item.internal) { item.resolve(value); return; }
      if (this.reloading || this.closed) return;
      if (value.ok === true && item.command === 'connect' && value.result?.connected === true && typeof value.result.runtime === 'string')
        this.runtime = value.result.runtime;
      if (value.ok === true && item.command === 'disconnect' && value.result?.connected === false) this.runtime = undefined;
      this.output.write(line + '\n');
    } else if (value.event && !this.reloading && !this.closed) this.output.write(line + '\n');
  }

  rejectOversized(owner, { requestId, protocol }) {
    if (this.current !== owner) return;
    const item = this.pending.get(requestId);
    if (item?.generation === owner.generation && item.protocol === protocol) {
      this.pending.delete(requestId);
      if (item.internal) {
        item.resolve({ ok: false, error: 'SIDECAR_RESPONSE_TOO_LARGE' });
        return;
      }
      if (!this.reloading && !this.closed) this.reply(requestId, 'SIDECAR_RESPONSE_TOO_LARGE', protocol);
    }
    if (!this.reloading && !this.closed) this.event('sidecar_response_too_large');
  }

  failPending(error) {
    for (const [id, item] of this.pending) {
      if (item.internal) item.resolve({ ok: false, error });
      else this.reply(id, error, item.protocol);
    }
    this.pending.clear();
  }

  async boot(restoring) {
    this.starting = true;
    const strippedEnv = new Set([
      'NODE_OPTIONS',
      'NODE_PATH',
      'INBORA_MODEL_KEY',
      'DEEPSEEK_API_KEY',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GOOGLE_GENERATIVE_AI_API_KEY',
      'GEMINI_API_KEY',
    ]);
    const childEnv = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !strippedEnv.has(name.toUpperCase())),
    );
    childEnv.INBORA_PIPE_NONCE = this.secret;
    const child = spawn(process.execPath, ['--import', pathToFileURL(join(this.root, 'node_modules/tsx/dist/loader.mjs')).href, this.entry], {
      cwd: this.root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    });
    let ready, failReady, closed;
    const owner = { child, generation: ++this.generation, readySeen: false, bridges: new Map() };
    owner.booted = new Promise((yes, no) => { ready = yes; failReady = no; });
    owner.ready = ready;
    owner.closed = new Promise(yes => { closed = yes; });
    this.current = owner;
    const stopReading = boundedLines(child.stdout, responseLimit, line => this.accept(owner, line),
      fields => this.rejectOversized(owner, fields));
    child.stderr.on('data', () => {}); // Raw exceptions may contain private data; report fixed lifecycle codes only.
    child.stdin.on('error', () => {});
    child.once('error', () => failReady(new Error('DEV_BACKEND_START_FAILED')));
    child.once('close', (code, signal) => {
      stopReading(); closed({ code, signal }); failReady(new Error('DEV_BACKEND_START_FAILED'));
      if (this.current !== owner) return;
      this.current = undefined;
      if (owner.readySeen) this.write({ kind: 'dev_sidecar_cache_reset', secret: this.secret });
      // A syntax/import failure before ready cannot have accepted a runtime connection.
      this.previousUnsafeExit = code !== 0 && owner.readySeen && !!this.runtime;
      this.failPending('DEV_BACKEND_UNAVAILABLE_RESTART_REQUIRED');
      if (!this.reloading && !this.closed) this.event('backend_unavailable');
    });
    try {
      await owner.booted;
      if (this.closed) return;
      if (restoring && this.runtime) {
        const id = randomUUID();
        const restored = new Promise(yes => this.pending.set(id, { generation: owner.generation, protocol: 1, internal: true, resolve: yes }));
        child.stdin.write(JSON.stringify({ protocol: 1, requestId: id, secret: this.secret,
          body: { command: 'connect', runtime: this.runtime, initialize: false, consent: true } }) + '\n');
        const response = await restored;
        if (response.ok !== true || response.result?.connected !== true) throw new Error('DEV_BACKEND_RECONNECT_FAILED');
      }
      if (!this.closed && restoring) this.event('backend_restarted');
    } finally { this.starting = false; }
  }

  restart() {
    if (this.reloadPromise) return this.reloadPromise;
    if (this.closed) return Promise.resolve();
    this.reloading = true;
    const sourceRevision = this.sourceRevision;
    this.failPending('DEV_BACKEND_RESTARTING_READ_STATUS');
    this.reloadPromise = (async () => {
      const owner = this.current;
      if (owner) {
        owner.child.stdin.end();
        // No kill timeout: the old account holder must finish its intent/readback and close before replacement.
        const result = await owner.closed;
        if (result.code !== 0) throw new Error('DEV_BACKEND_START_FAILED');
      } else if (this.previousUnsafeExit) throw new Error('DEV_BACKEND_START_FAILED');
      if (!this.closed) await this.boot(true);
    })().finally(() => {
      this.reloading = false; this.reloadPromise = undefined;
      if (!this.closed && this.sourceRevision > sourceRevision) {
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => { void this.restart().catch(() => this.event('backend_unavailable')); }, 250);
      }
    });
    return this.reloadPromise;
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    clearTimeout(this.debounce);
    this.watcher?.close();
    this.failPending('DEV_BACKEND_UNAVAILABLE_RESTART_REQUIRED');
    const owner = this.current;
    owner?.child.stdin.end();
    this.closePromise = (async () => { if (owner) await owner.closed; await this.reloadPromise?.catch(() => {}); this.stopReading?.(); })();
    return this.closePromise;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const supervisor = new DevelopmentSidecar({ root: resolve(dirname(fileURLToPath(import.meta.url)), '..'), secret: process.env.INBORA_PIPE_NONCE });
  delete process.env.INBORA_PIPE_NONCE;
  process.on('SIGINT', () => { void supervisor.close(); });
  process.on('SIGTERM', () => { void supervisor.close(); });
  const parent = process.ppid;
  const heartbeat = setInterval(() => { try { process.kill(parent, 0); } catch { void supervisor.close(); } }, 2000);
  heartbeat.unref();
  await supervisor.start().catch(() => { supervisor.event('backend_unavailable'); });
}
