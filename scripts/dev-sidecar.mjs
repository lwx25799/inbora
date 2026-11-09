import { spawn } from 'node:child_process';
import { watch as watchDirectory } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  reply(id, error) { this.write({ protocol: 1, requestId: id, ok: false, error }); }
  event(event) { this.write({ protocol: 1, event: { event } }); }

  async start() {
    this.lines = createInterface({ input: this.input, crlfDelay: Infinity });
    this.lines.on('line', line => this.receive(line));
    this.lines.on('close', () => { void this.close(); });
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
    let envelope;
    try {
      if (Buffer.byteLength(line) > 100_000) throw new Error();
      envelope = JSON.parse(line);
      if (envelope?.protocol !== 1 || typeof envelope.requestId !== 'string' ||
        !/^[a-f0-9-]{36}$/iu.test(envelope.requestId)) throw new Error();
      if (typeof envelope.secret !== 'string' || envelope.secret.length !== 64 ||
        !timingSafeEqual(Buffer.from(envelope.secret), Buffer.from(this.secret))) {
        this.reply(envelope.requestId, 'IPC_AUTHENTICATION_FAILED'); return;
      }
      if (!envelope.body || typeof envelope.body.command !== 'string') throw new Error();
    } catch { this.reply(envelope?.requestId ?? null, 'INVALID_COMMAND'); return; }
    if (this.closed) { this.reply(envelope.requestId, 'DEV_BACKEND_UNAVAILABLE_RESTART_REQUIRED'); return; }
    if (this.reloading || this.starting) { this.reply(envelope.requestId, 'DEV_BACKEND_RESTARTING_READ_STATUS'); return; }
    const owner = this.current;
    if (!owner || owner.child.exitCode !== null || owner.child.stdin.destroyed) {
      this.reply(envelope.requestId, 'DEV_BACKEND_UNAVAILABLE_RESTART_REQUIRED'); return;
    }
    if (this.pending.has(envelope.requestId) || this.pending.size >= 128) {
      this.reply(envelope.requestId, 'IPC_REQUEST_ALREADY_PENDING'); return;
    }
    // Retain only routing metadata, not request bodies, Keys, text or send parameters.
    this.pending.set(envelope.requestId, { generation: owner.generation, command: envelope.body.command });
    owner.child.stdin.write(line + '\n', error => {
      if (error && this.pending.delete(envelope.requestId)) this.reply(envelope.requestId, 'DEV_BACKEND_UNAVAILABLE_RESTART_REQUIRED');
    });
  }

  accept(owner, line) {
    if (this.current !== owner) return;
    let value;
    try { if (Buffer.byteLength(line) > 2_000_000) return; value = JSON.parse(line); } catch { return; }
    if (value?.protocol !== 1) return;
    if (value.ready === true) { owner.readySeen = true; owner.ready(); return; }
    const item = this.pending.get(value.requestId);
    if (item?.generation === owner.generation) {
      this.pending.delete(value.requestId);
      if (item.internal) { item.resolve(value); return; }
      if (this.reloading || this.closed) return;
      if (value.ok === true && item.command === 'connect' && value.result?.connected === true && typeof value.result.runtime === 'string')
        this.runtime = value.result.runtime;
      if (value.ok === true && item.command === 'disconnect' && value.result?.connected === false) this.runtime = undefined;
      this.write(value);
    } else if (value.event && !this.reloading && !this.closed) this.write(value);
  }

  failPending(error) {
    for (const [id, item] of this.pending) {
      if (item.internal) item.resolve({ ok: false, error });
      else this.reply(id, error);
    }
    this.pending.clear();
  }

  async boot(restoring) {
    this.starting = true;
    const child = spawn(process.execPath, ['--import', pathToFileURL(join(this.root, 'node_modules/tsx/dist/loader.mjs')).href, this.entry], {
      cwd: this.root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, INBORA_PIPE_NONCE: this.secret, NODE_OPTIONS: '', NODE_PATH: '', INBORA_MODEL_KEY: '', DEEPSEEK_API_KEY: '' },
    });
    let ready, failReady, closed;
    const owner = { child, generation: ++this.generation, readySeen: false };
    owner.booted = new Promise((yes, no) => { ready = yes; failReady = no; });
    owner.ready = ready;
    owner.closed = new Promise(yes => { closed = yes; });
    this.current = owner;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => this.accept(owner, line));
    child.stderr.on('data', () => {}); // Raw exceptions may contain private data; report fixed lifecycle codes only.
    child.stdin.on('error', () => {});
    child.once('error', () => failReady(new Error('DEV_BACKEND_START_FAILED')));
    child.once('close', (code, signal) => {
      lines.close(); closed({ code, signal }); failReady(new Error('DEV_BACKEND_START_FAILED'));
      if (this.current !== owner) return;
      this.current = undefined;
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
        const restored = new Promise(yes => this.pending.set(id, { generation: owner.generation, internal: true, resolve: yes }));
        child.stdin.write(JSON.stringify({ protocol: 1, requestId: id, secret: this.secret,
          body: { command: 'connect', runtime: this.runtime, initialize: false, consent: true } }) + '\n');
        const response = await restored;
        if (response.ok !== true || response.result?.connected !== true) throw new Error('DEV_BACKEND_RECONNECT_FAILED');
      }
      if (!this.closed) { this.write({ protocol: 1, ready: true }); if (restoring) this.event('backend_restarted'); }
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
    this.closePromise = (async () => { if (owner) await owner.closed; await this.reloadPromise?.catch(() => {}); this.lines?.close(); })();
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
