import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isWebBrowserPlatform } from '../contracts/account.js';
import {
  workerPlatformIdSchema,
  type WorkerCommand,
  type WorkerPlatformId,
  type WorkerSendBinding,
  type WorkerTarget,
} from '../contracts/browser-worker.js';
import type { Channel, SendProof, TargetSnapshot } from '../contracts/events.js';
import { Blocked, requireSafe } from '../core/contracts.js';
import {
  encodeWorkerPermitResult, encodeWorkerRequest, readWorkerOutput, workerTextDigest,
  type WorkerHello, type WorkerIdentity, type WorkerMode, type WorkerObservation, type WorkerReadback,
  type WorkerPermitCheck, type WorkerPermitError, type WorkerSendEvidence, type WorkerStatus,
} from './worker-protocol.js';

const requestTimeoutMs = 15_000;
const exitTimeoutMs = 5_000;
const unconfirmedTrees = new Set<string>();
const startupErrors = new Set([
  'OWNER_LOCKED_OR_PORT_UNAVAILABLE', 'OWNER_PORT_RESERVED', 'WORKER_PROFILE_DIR_INVALID',
  'WORKER_MODE_INVALID', 'WORKER_PLATFORM_INVALID', 'WORKER_EPOCH_INVALID', 'WORKER_SESSION_INVALID', 'WORKER_START_FAILED',
]);
const workerEnvironment = new Set([
  'PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE',
  'LOCALAPPDATA', 'APPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
]);

interface WorkerSession {
  child: ChildProcessWithoutNullStreams;
  sessionId: string;
  ownerEpoch: number;
  ready: boolean;
  closing: boolean;
  mayOwnBrowser: boolean;
  shutdownAcknowledged: boolean;
  cleanExit?: boolean;
  sendEpoch: number;
  activeSends: Map<string, WorkerSendBinding>;
  failure?: Error;
  exited: Promise<void>;
  termination?: Promise<void>;
  pending: Map<string, { resolve(result: unknown): void; reject(error: Error): void }>;
}

export interface WorkerDispatchLedger {
  hasDispatched(intentId: string): boolean;
  recordDispatched(binding: WorkerSendBinding): void;
}

export interface BrowserWorkerHostOptions {
  profileDir: string;
  accountRoot?: string;
  platformId?: WorkerPlatformId;
  allowFixture?: boolean;
  mode?: WorkerMode;
  entryScript?: string;
  ledger?: WorkerDispatchLedger;
  /** Synchronously recheck live Core authority. Returning false or throwing denies the request. */
  onPermitCheck?: (binding: Readonly<WorkerSendBinding>) => boolean | void;
}

export interface ExecuteWorkerSend {
  intentId: string;
  notBefore: string;
  text: string;
  targetDigest: string;
  nonce?: string;
  permitExpiresAt?: number;
}

export class BrowserWorkerHost {
  private readonly committedDispatchIntents = new Set<string>();
  private readonly profileDir: string;
  private readonly accountRoot: string | undefined;
  readonly platformId: WorkerPlatformId;
  private readonly allowFixture: boolean;
  private readonly mode: WorkerMode;
  private readonly entryScript: string;
  private readonly ledger: WorkerDispatchLedger | undefined;
  private readonly onPermitCheck: BrowserWorkerHostOptions['onPermitCheck'];
  private worker: WorkerSession | undefined;
  private epoch = 0;
  private lifecycle = Promise.resolve();

  constructor({ profileDir, accountRoot, platformId = 'douyin', allowFixture = false, mode = 'browser', entryScript, ledger, onPermitCheck }: BrowserWorkerHostOptions) {
    requireSafe(profileDir.length > 0, 'WORKER_PROFILE_DIR_INVALID');
    this.profileDir = resolve(profileDir);
    this.accountRoot = accountRoot ? resolve(accountRoot) : undefined;
    this.platformId = workerPlatformIdSchema.parse(platformId);
    this.allowFixture = allowFixture;
    this.mode = mode;
    this.ledger = ledger;
    this.onPermitCheck = onPermitCheck;
    this.entryScript = entryScript ? resolve(entryScript) : fileURLToPath(new URL(
      extname(import.meta.url) === '.ts' ? './browser-worker-entry.ts' : './browser-worker-entry.js', import.meta.url,
    ));
  }

  get pid() { return this.worker?.failure ? undefined : this.worker?.child.pid; }
  get sessionId() { return this.worker?.sessionId; }
  get ownerEpoch() { return this.epoch; }

  start(): Promise<WorkerHello> {
    return this.serialize(() => this.startWorker());
  }

  restart(): Promise<WorkerHello> {
    return this.serialize(async () => {
      await this.stopWorker();
      return this.startWorker();
    });
  }

  close(): Promise<void> {
    return this.serialize(() => this.stopWorker());
  }

  async killForTest(): Promise<void> {
    const worker = this.activeWorker();
    this.abort(worker, new Blocked('WORKER_DISCONNECTED'));
    await this.waitForExit(worker);
  }

  status(): Promise<WorkerStatus> { return this.call({ action: 'status' }); }
  async open(): Promise<WorkerStatus> {
    const worker = this.activeWorker();
    worker.mayOwnBrowser ||= this.mode === 'browser';
    return this.request(worker, { action: 'open' }) as Promise<WorkerStatus>;
  }
  async closeBrowser(): Promise<WorkerStatus> {
    const worker = this.activeWorker();
    void this.abortInFlight();
    const result = await this.request(worker, { action: 'close' }) as WorkerStatus;
    worker.mayOwnBrowser = false;
    return result;
  }
  observe(): Promise<{ events: unknown[] }>;
  observe(input: Required<Omit<Extract<WorkerCommand, { action: 'observe' }>, 'action'>>): Promise<WorkerObservation | null>;
  observe(input?: Omit<Extract<WorkerCommand, { action: 'observe' }>, 'action'>): Promise<unknown> {
    return this.call({ action: 'observe', ...input });
  }
  identity(channel: Channel, ownId?: string): Promise<WorkerIdentity | null> {
    return this.call({ action: 'identity', channel, ownId });
  }
  inspectTarget(): Promise<{ targetAvailable: boolean }>;
  inspectTarget(target: WorkerTarget): Promise<TargetSnapshot>;
  inspectTarget(target?: WorkerTarget): Promise<unknown> { return this.call({ action: 'inspectTarget', target }); }
  prepareSend(targetDigest: string, target?: WorkerTarget, text?: string): Promise<unknown> {
    return this.call({ action: 'prepareSend', targetDigest, target, text });
  }
  verifyPrepared(target: WorkerTarget, text: string): Promise<TargetSnapshot> {
    return this.call({ action: 'verifyPrepared', target, text });
  }
  baseline(target: WorkerTarget): Promise<string[]> { return this.call({ action: 'baseline', target }); }
  cancelPreparation(handleId?: string): Promise<unknown> { return this.call({ action: 'cancelPreparation', handleId }); }
  disposeTarget(handleId: string): Promise<void> { return this.call({ action: 'disposeTarget', handleId }); }

  async executeSend(input: ExecuteWorkerSend): Promise<WorkerSendEvidence> {
    const { intentId, notBefore, text, targetDigest, nonce = randomUUID(), permitExpiresAt } = input;
    requireSafe(!this.committedDispatchIntents.has(intentId) && !this.ledger?.hasDispatched(intentId), 'WORKER_CRASH_NO_REPLAY');
    const boundary = Date.parse(notBefore);
    const now = Date.now();
    // Wait out one Windows 15.6ms clock tick when notBefore is already <= caller clock so child Date.now() lag cannot reject a valid send.
    if (Number.isFinite(boundary) && boundary <= now && now - boundary < 20) {
      await new Promise(resolve => setTimeout(resolve, 20 - (now - boundary)));
    }
    const worker = this.activeWorker();
    requireSafe(!worker.activeSends.has(nonce), 'WORKER_NONCE_REPLAYED');
    const binding = { intentId, nonce, sessionId: worker.sessionId, ownerEpoch: worker.ownerEpoch,
      notBefore, textDigest: workerTextDigest(text), targetDigest, permitExpiresAt, sendEpoch: worker.sendEpoch };
    worker.activeSends.set(nonce, binding);
    try {
      const evidence = await this.request(worker, { action: 'executeSend', binding, text }, () => {
        this.ledger?.recordDispatched(binding);
        if (!this.ledger) this.committedDispatchIntents.add(intentId);
      }) as WorkerSendEvidence;
      requireSafe(worker.sendEpoch === binding.sendEpoch && !worker.closing && !worker.failure, 'EMERGENCY_STOPPED');
      return evidence;
    } finally { worker.activeSends.delete(nonce); }
  }

  async abortInFlight(): Promise<boolean> {
    const worker = this.worker;
    if (!worker?.ready || worker.failure ||
        !Array.from(worker.activeSends.values()).some(binding => binding.sendEpoch === worker.sendEpoch)) return false;
    worker.sendEpoch++;
    try {
      await this.request(worker, { action: 'abortSend' });
      return true;
    } catch {
      this.abort(worker, new Blocked('WORKER_DISCONNECTED'));
      return false;
    }
  }

  async readback({ intentId, baseline, notBefore, text, target }: Omit<Extract<WorkerCommand, { action: 'readback' }>, 'action'>): Promise<WorkerReadback> {
    const result = await this.call<WorkerReadback>({ action: 'readback', intentId, baseline, notBefore, text, target });
    if (result.verified) {
      const proofAt = Date.parse(result.proof?.sentAt ?? result.evidence.executedAt);
      const skewLimit = isWebBrowserPlatform(this.platformId) ? 50 : 20;
      if (Number.isFinite(proofAt) && proofAt > Date.now() && proofAt - Date.now() <= skewLimit) {
        await new Promise(resolve => setTimeout(resolve, proofAt - Date.now() + 1));
      }
    }
    return result;
  }

  verifyExisting({ target, text, notBefore }: Omit<Extract<WorkerCommand, { action: 'verifyExisting' }>, 'action'>): Promise<{ verified: boolean; proof: SendProof | null }> {
    return this.call({ action: 'verifyExisting', target, text, notBefore });
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(action);
    this.lifecycle = result.then(() => {}, () => {});
    return result;
  }

  private activeWorker(): WorkerSession {
    const worker = this.worker;
    requireSafe(worker?.ready && !worker.closing && !worker.failure, 'WORKER_NOT_RUNNING');
    return worker;
  }

  private async call<T>(command: WorkerCommand): Promise<T> {
    return this.request(this.activeWorker(), command) as Promise<T>;
  }

  private async startWorker(): Promise<WorkerHello> {
    if (this.worker?.ready && !this.worker.failure && !this.worker.closing) {
      return this.request(this.worker, { action: 'hello' }) as Promise<WorkerHello>;
    }
    await this.stopWorker();
    requireSafe(!unconfirmedTrees.has(this.profileDir), 'WORKER_PROCESS_TREE_NOT_EXITED');
    const sessionId = randomUUID();
    const ownerEpoch = ++this.epoch;
    const loader = /\.[cm]?ts$/u.test(extname(this.entryScript)) ? ['--import', import.meta.resolve('tsx')] : [];
    const child = spawn(process.execPath, [...loader, this.entryScript], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => workerEnvironment.has(key.toUpperCase()))),
        TSX_DISABLE_CACHE: '1',
        INBORA_WORKER_PROFILE_DIR: this.profileDir, INBORA_WORKER_MODE: this.mode,
        INBORA_WORKER_PLATFORM: this.platformId,
        ...(this.allowFixture && this.platformId !== 'douyin' ? { INBORA_WORKER_ALLOW_FIXTURE: '1' } : {}),
        ...(this.accountRoot ? { INBORA_WORKER_ACCOUNT_ROOT: this.accountRoot } : {}),
        INBORA_WORKER_SESSION_ID: sessionId, INBORA_WORKER_EPOCH: String(ownerEpoch),
      },
    });
    let diagnostics = '';
    let spawnError: Error | undefined;
    child.stderr.on('data', (chunk: Buffer) => {
      if (diagnostics.length < 1024) diagnostics += chunk.subarray(0, 1024 - diagnostics.length).toString('utf8');
    });
    child.on('error', error => { spawnError ??= error; });
    // Writes have a callback, and Node also emits 'error' on the pipe when it closes mid-write.
    child.stdin.on('error', () => {});
    const worker: WorkerSession = { child, sessionId, ownerEpoch, ready: false, closing: false, pending: new Map(),
      mayOwnBrowser: false, shutdownAcknowledged: false, sendEpoch: 0, activeSends: new Map(),
      exited: new Promise(resolveExit => child.once('close', () => {
        const code = diagnostics.trim();
        const failure = worker.failure ?? spawnError ?? new Blocked(
          !worker.ready && startupErrors.has(code) ? code : 'WORKER_DISCONNECTED',
        );
        this.failPending(worker, failure);
        resolveExit();
      })),
    };
    child.once('exit', exitCode => {
      worker.cleanExit = exitCode === 0 && worker.shutdownAcknowledged;
      if (worker.mayOwnBrowser && !worker.cleanExit && !worker.termination) unconfirmedTrees.add(this.profileDir);
    });
    this.worker = worker;
    void this.receive(worker);
    try {
      const hello = await this.request(worker, { action: 'hello' }) as WorkerHello;
      requireSafe(hello && hello.pid === child.pid && hello.sessionId === sessionId && hello.ownerEpoch === ownerEpoch &&
        hello.profileLocked === true && hello.mode === this.mode &&
        (this.platformId === 'douyin' ? hello.platformId === undefined || hello.platformId === 'douyin' : hello.platformId === this.platformId),
      'WORKER_HANDSHAKE_INVALID');
      worker.ready = true;
      return hello;
    } catch (error) {
      this.abort(worker, error instanceof Error ? error : new Blocked('WORKER_START_FAILED'));
      await this.waitForExit(worker);
      throw error;
    }
  }

  private async receive(worker: WorkerSession): Promise<void> {
    try {
      for await (const response of readWorkerOutput(worker.child.stdout)) {
        if (worker.failure) return;
        requireSafe(response.sessionId === worker.sessionId, 'WORKER_SESSION_MISMATCH');
        requireSafe(response.ownerEpoch === worker.ownerEpoch, 'WORKER_EPOCH_STALE');
        if ('kind' in response) {
          this.replyToPermitCheck(worker, response);
          continue;
        }
        const pending = worker.pending.get(response.id);
        requireSafe(pending, 'WORKER_RESPONSE_UNEXPECTED');
        if (response.ok) pending.resolve(response.result);
        else pending.reject(new Blocked(response.error));
      }
    } catch (error) {
      // A failed spawn is reported by the child 'error' event, with its original OS code.
      if (worker.child.pid !== undefined) {
        this.abort(worker, error instanceof Error ? error : new Blocked('WORKER_PROTOCOL_FAILED'));
      }
    }
  }

  private replyToPermitCheck(worker: WorkerSession, { id, sessionId, ownerEpoch, nonce }: WorkerPermitCheck): void {
    const binding = worker.activeSends.get(nonce);
    let error: WorkerPermitError | null = 'EMERGENCY_STOPPED';
    if (this.worker === worker && worker.ready && !worker.failure && !worker.closing &&
        binding && binding.sendEpoch === worker.sendEpoch) {
      if (binding.permitExpiresAt === undefined || Date.now() >= binding.permitExpiresAt) error = 'WORKER_SEND_PERMIT_EXPIRED';
      else {
        try {
          const allowed = this.onPermitCheck?.(binding);
          if ((allowed === undefined || allowed === true) && binding.sendEpoch === worker.sendEpoch) {
            error = Date.now() < binding.permitExpiresAt ? null : 'WORKER_SEND_PERMIT_EXPIRED';
          }
        } catch { /* A live Core guard can revoke access by throwing. */ }
      }
    }
    worker.child.stdin.write(encodeWorkerPermitResult({ id, sessionId, ownerEpoch, kind: 'permitResult', error }), failure => {
      if (failure) this.abort(worker, new Blocked('WORKER_DISCONNECTED'));
    });
  }

  private request(worker: WorkerSession, command: WorkerCommand, beforeWrite?: () => void): Promise<unknown> {
    const id = randomUUID();
    const { sessionId, ownerEpoch } = worker;
    const frame = encodeWorkerRequest({ id, sessionId, ownerEpoch, command });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.abort(worker, new Blocked('WORKER_REQUEST_TIMEOUT')), requestTimeoutMs);
      const finish = () => { clearTimeout(timer); worker.pending.delete(id); };
      worker.pending.set(id, {
        resolve: result => {
          if (command.action === 'shutdown') worker.shutdownAcknowledged = true;
          finish();
          resolve(result);
        },
        reject: error => { finish(); reject(error); },
      });
      // Commit synchronously before the first byte can reach the Worker.
      try { beforeWrite?.(); }
      catch (error) { finish(); reject(error); return; }
      try {
        worker.child.stdin.write(frame, error => {
          // During hello, wait for 'close' to report a startup diagnostic or spawn error.
          if (error && worker.ready) this.abort(worker, new Blocked('WORKER_DISCONNECTED'));
        });
      } catch {
        if (worker.ready) this.abort(worker, new Blocked('WORKER_DISCONNECTED'));
      }
    });
  }

  private failPending(worker: WorkerSession, error: Error): void {
    worker.failure ??= error;
    for (const pending of worker.pending.values()) pending.reject(worker.failure);
  }

  private abort(worker: WorkerSession, error: Error): void {
    this.failPending(worker, error);
    if (worker.termination) return;
    const { child } = worker;
    if (worker.mayOwnBrowser && !worker.cleanExit) unconfirmedTrees.add(this.profileDir);
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const systemRoot = process.env.SystemRoot;
    if (process.platform === 'win32' && systemRoot && isAbsolute(systemRoot)) {
      worker.termination = new Promise(resolveExit => {
        execFile(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, timeout: exitTimeoutMs }, error => {
            if (!error && worker.mayOwnBrowser) unconfirmedTrees.delete(this.profileDir);
            // A missing Worker PID does not prove that an already orphaned browser tree exited.
            if (error && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            resolveExit();
          });
      });
    } else child.kill('SIGKILL');
  }

  private async waitForExit(worker: WorkerSession): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all([worker.exited, worker.termination]), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Blocked('WORKER_EXIT_TIMEOUT')), exitTimeoutMs * 2);
      })]);
      requireSafe(!unconfirmedTrees.has(this.profileDir), 'WORKER_PROCESS_TREE_NOT_EXITED');
      if (this.worker === worker) this.worker = undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private async stopWorker(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    worker.closing = true;
    try {
      if (!worker.failure) await this.request(worker, { action: 'shutdown' });
      await this.waitForExit(worker);
    } catch {
      this.abort(worker, new Blocked('WORKER_DISCONNECTED'));
      await this.waitForExit(worker);
    }
  }
}
