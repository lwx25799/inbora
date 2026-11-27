import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { BrowserContext, Page, Route } from 'playwright';
import { DomAdapter } from '../adapters/dom-adapter.js';
import { ObservedCommentReply } from '../adapters/observed-comment-reply.js';
import { ObservedDmReply } from '../adapters/observed-dm-reply.js';
import { ObservedReader } from '../adapters/observed-reader.js';
import { isSecurityFailure } from '../adapters/security-signal.js';
import { WebPlatformReplyAdapter } from '../adapters/web-platform-adapter.js';
import { WebPlatformReader } from '../adapters/web-platform-reader.js';
import { installMediaPauseGuard } from '../browser/media-pause.js';
import { OwnerLock } from '../browser/owner-lock.js';
import { loadCommentReplyMapping, loadDmReplyMapping, loadMapping, loadObservationMapping } from '../config/runtime.js';
import { loadWebPlatformObservationMapping, loadWebPlatformReplyMapping, requireCalibratedWebReplyMapping } from '../config/web-platform-mapping.js';
import { isWebBrowserPlatform } from '../contracts/account.js';
import { Blocked, DEFAULT_ACCOUNT_ID, digest, eventBinding, isEligible, requireSafe, targetKey } from '../core/contracts.js';
import { WorkerRequestEnvelopeSchema, workerPlatformIdSchema, type WorkerCommand, type WorkerPlatformId,
  type WorkerRequestEnvelope, type WorkerResponseEnvelope, type WorkerSendBinding, type WorkerTarget } from '../contracts/browser-worker.js';
import type { Channel, SendProof, TargetSnapshot } from '../contracts/events.js';
import {
  encodeWorkerPermitCheck, encodeWorkerResponse, readWorkerInput, workerTextDigest,
  type WorkerHello, type WorkerIdentity, type WorkerMode, type WorkerObservation, type WorkerReadback,
  type WorkerPermitError, type WorkerSendEvidence, type WorkerStatus,
} from './worker-protocol.js';

const consumedNonces = new Set<string>();
const dispatchedIntents = new Set<string>();
const permitCheckTimeoutMs = 1_000;
const readOnlyMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
type NativeAdapter = ObservedDmReply | ObservedCommentReply | WebPlatformReplyAdapter;
type TargetHandle = { target: WorkerTarget; adapter?: NativeAdapter; mappingDigest?: string };
type PreparedSend = { targetDigest: string; handle?: TargetHandle; text?: string };
type DispatchedSend = { evidence: WorkerSendEvidence; textDigest: string; notBefore: string; handle?: TargetHandle };
type SendWindow = {
  context: BrowserContext;
  page: Page;
  binding: WorkerSendBinding;
  settled: PromiseWithResolvers<void>;
  routes: Set<Promise<void>>;
  closed: boolean;
  failure?: WorkerPermitError;
};

function configuration(): {
  profileDir: string;
  accountRoot?: string;
  platformId: WorkerPlatformId;
  allowFixture: boolean;
  mode: WorkerMode;
  sessionId: string;
  ownerEpoch: number;
} {
  const profileDir = process.env.INBORA_WORKER_PROFILE_DIR;
  const accountRoot = process.env.INBORA_WORKER_ACCOUNT_ROOT;
  const mode = process.env.INBORA_WORKER_MODE ?? 'browser';
  const epoch = process.env.INBORA_WORKER_EPOCH;
  const allowFixture = process.env.INBORA_WORKER_ALLOW_FIXTURE === '1';
  requireSafe(profileDir && isAbsolute(profileDir), 'WORKER_PROFILE_DIR_INVALID');
  if (accountRoot !== undefined) requireSafe(accountRoot.length > 0 && isAbsolute(accountRoot), 'WORKER_PROFILE_DIR_INVALID');
  const parsedPlatform = workerPlatformIdSchema.safeParse(process.env.INBORA_WORKER_PLATFORM ?? 'douyin');
  requireSafe(parsedPlatform.success, 'WORKER_PLATFORM_INVALID');
  requireSafe(mode === 'synthetic' || mode === 'browser', 'WORKER_MODE_INVALID');
  requireSafe(epoch && /^\d+$/u.test(epoch), 'WORKER_EPOCH_INVALID');
  const session = WorkerRequestEnvelopeSchema.shape.sessionId.safeParse(process.env.INBORA_WORKER_SESSION_ID);
  requireSafe(session.success, 'WORKER_SESSION_INVALID');
  const ownerEpoch = Number(epoch);
  requireSafe(Number.isSafeInteger(ownerEpoch), 'WORKER_EPOCH_INVALID');
  return {
    profileDir,
    ...(accountRoot ? { accountRoot } : {}),
    platformId: parsedPlatform.data,
    allowFixture,
    mode,
    sessionId: session.data,
    ownerEpoch,
  };
}

class WorkerRuntime {
  private context: BrowserContext | undefined;
  private pages: Record<Channel, Page> | undefined;
  private observePages: Partial<Record<Channel, Page>> = {};
  private verifyPages: Partial<Record<Channel, Page>> = {};
  private readonly knownPages = new WeakSet<Page>();
  private syntheticOpen: boolean;
  private prepared: PreparedSend | undefined;
  private handle: TargetHandle | undefined;
  private lastDispatch: DispatchedSend | undefined;
  private readonly observations = new Map<string, DispatchedSend>();
  private executedCount = 0;
  private sendEpoch = 0;
  private sendWindow: SendWindow | undefined;
  private readonly revokedPages = new WeakSet<Page>();
  readonly hello: WorkerHello;

  constructor(private readonly profileDir: string, mode: WorkerMode, sessionId: string, ownerEpoch: number,
    private readonly checkCorePermit: (binding: WorkerSendBinding) => Promise<WorkerPermitError | null>,
    private readonly platformId: WorkerPlatformId = 'douyin',
    private readonly accountRoot?: string,
    private readonly allowFixture = false) {
    this.syntheticOpen = mode === 'synthetic';
    this.hello = {
      pid: process.pid,
      sessionId,
      ownerEpoch,
      profileLocked: true,
      mode,
      ...(platformId === 'douyin' ? {} : { platformId }),
    };
  }

  private status(): WorkerStatus {
    const state = this.syntheticOpen || this.context ? 'OPEN' : 'CLOSED';
    return { ...this.hello, state, executedCount: this.executedCount,
      ...(this.context ? { version: this.browserVersion(), pageCount: this.context.pages().length } : {}) };
  }

  private get root(): string { return this.accountRoot ?? dirname(this.profileDir); }
  private browserVersion(): string { return this.context?.browser()?.version() ?? 'unknown'; }

  private async open(): Promise<void> {
    if (this.hello.mode === 'synthetic') {
      this.syntheticOpen = true;
      return;
    }
    if (this.context) return;
    let context: BrowserContext | undefined;
    try {
      const { chromium } = await import('playwright');
      context = await chromium.launchPersistentContext(this.profileDir, {
        channel: 'msedge', headless: true, locale: 'zh-CN', args: ['--mute-audio'], timeout: 10_000, serviceWorkers: 'block',
      });
      const openedContext = context;
      await context.route('**/*', route => this.guardRequest(openedContext, route));
      context.setDefaultTimeout(5_000);
      context.setDefaultNavigationTimeout(15_000);
      const notifications = context.pages()[0] ?? await context.newPage();
      const dm = await context.newPage();
      this.knownPages.add(notifications);
      this.knownPages.add(dm);
      for (const extra of context.pages()) if (extra !== notifications && extra !== dm) await extra.close();
      context.on('page', page => {
        if (this.knownPages.has(page)) return;
        void page.opener().then(opener => {
          if (opener && !page.isClosed()) return page.close();
        }).catch(() => {});
      });
      this.context = context;
      this.pages = { COMMENT_NOTIFICATION: notifications, DIRECT_MESSAGE: dm };
      this.observePages = {};
      this.verifyPages = {};
      context.once('close', () => {
        if (this.context === context) {
          this.sendWindow?.settled.resolve();
          this.sendWindow = undefined;
          this.context = undefined;
          this.pages = undefined;
          this.observePages = {};
          this.verifyPages = {};
          this.prepared = undefined;
          this.handle = undefined;
          this.lastDispatch = undefined;
        }
      });
    } catch {
      await context?.close().catch(() => {});
      throw new Blocked('WORKER_BROWSER_OPEN_FAILED');
    }
  }

  async closeBrowser(): Promise<void> {
    this.syntheticOpen = false;
    try { await this.disposeTarget(this.handle?.target.handleId); }
    finally {
      this.prepared = undefined;
      this.lastDispatch = undefined;
      await this.context?.close();
    }
  }

  private requireOpen(): void { requireSafe(this.syntheticOpen || this.context, 'WORKER_BROWSER_CLOSED'); }

  private async pageFor(channel: Channel, entry: string, purpose: 'observe' | 'reply' | 'verify' = 'reply'): Promise<Page> {
    if (!isWebBrowserPlatform(this.platformId)) {
      const page = this.pages?.[channel];
      requireSafe(page && !page.isClosed(), 'WORKER_BROWSER_CLOSED');
      if (page.url() === 'about:blank') {
        await installMediaPauseGuard(page, entry, true);
        await page.goto(entry, { waitUntil: 'domcontentloaded' });
      }
      return page;
    }
    requireSafe(this.context, 'WORKER_BROWSER_CLOSED');
    const secondaryMap = purpose === 'observe' ? this.observePages : purpose === 'verify' ? this.verifyPages : null;
    let page = secondaryMap ? secondaryMap[channel] : this.pages?.[channel];
    if (secondaryMap && (!page || page.isClosed())) {
      page = await this.context.newPage();
      this.knownPages.add(page);
      secondaryMap[channel] = page;
    }
    requireSafe(page && !page.isClosed(), 'WORKER_BROWSER_CLOSED');
    const current = page.url();
    const targetUrl = new URL(entry);
    const sameTarget = purpose !== 'verify'
      && current !== 'about:blank'
      && new URL(current).origin === targetUrl.origin
      && current.split('#')[0] === entry.split('#')[0];
    if (!sameTarget) {
      if (current !== 'about:blank') {
        const empty = await page.evaluate(() => {
          for (const editor of Array.from(document.querySelectorAll('[contenteditable="true"],textarea,input'))) {
            if (editor instanceof HTMLInputElement && !['text', 'search', 'email', 'url', 'tel', 'password'].includes(editor.type)) continue;
            const text = editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement
              ? editor.value
              : (editor.textContent ?? '').replace(/[\u200B\uFEFF]/gu, '');
            if (text.length > 0) return false;
          }
          return true;
        });
        requireSafe(empty, 'OBSERVATION_EXISTING_HUMAN_INPUT');
      }
      await installMediaPauseGuard(page, entry, true);
      await page.goto(entry, { waitUntil: 'domcontentloaded' });
    }
    return page;
  }

  private async observe({ source, accountId = DEFAULT_ACCOUNT_ID, index = 0 }: Extract<WorkerCommand, { action: 'observe' }>)
  : Promise<WorkerObservation | { events: [] } | null> {
    this.requireOpen();
    if (this.syntheticOpen) return source ? null : { events: [] };
    requireSafe(!this.prepared, 'WORKER_PREPARATION_IN_PROGRESS');
    if (isWebBrowserPlatform(this.platformId)) {
      requireSafe(source, 'WORKER_OBSERVATION_SOURCE_REQUIRED');
      const mapping = await loadWebPlatformObservationMapping(this.root, this.platformId, { allowFixture: this.allowFixture });
      requireSafe(mapping, 'OBSERVATION_MAPPING_REQUIRED');
      const page = await this.pageFor(source === 'dm' ? 'DIRECT_MESSAGE' : 'COMMENT_NOTIFICATION', mapping.entryUrl, 'observe');
      return new WebPlatformReader(page, mapping, accountId).observe(source, index);
    }
    if (source === 'notifications') {
      if (index > 0) return null;
      const mapping = await loadMapping(this.root);
      const page = await this.pageFor('COMMENT_NOTIFICATION', mapping.origin);
      const adapter = new DomAdapter(page, 'COMMENT_NOTIFICATION', mapping, undefined, accountId);
      try { return { ...await adapter.observeNotifications(), scope: source, ownId: mapping.ownId }; }
      finally { adapter.dispose(); }
    }
    requireSafe(source, 'WORKER_OBSERVATION_SOURCE_REQUIRED');
    const mapping = await loadObservationMapping(this.root);
    requireSafe(mapping, 'OBSERVATION_MAPPING_REQUIRED');
    const item = source === 'dm' ? mapping.peers[index] : mapping.works[index];
    if (!item) return null;
    const page = await this.pageFor(source === 'dm' ? 'DIRECT_MESSAGE' : 'COMMENT_NOTIFICATION', mapping.entryUrl);
    const reader = new ObservedReader(page, mapping, undefined, undefined, accountId);
    const batch = source === 'dm' ? await reader.dm(index) : await reader.comments(index);
    const scope = 'conversationId' in item ? item.conversationId : `work:${item.id}`;
    return { scope, ownId: mapping.self.uid, evidenceId: batch.evidenceId, events: batch.events };
  }

  private async identity(channel: Channel, ownId?: string): Promise<WorkerIdentity | null> {
    this.requireOpen();
    if (this.syntheticOpen) {
      const seed = this.platformId === 'douyin' ? 'synthetic' : ['synthetic', this.platformId];
      return ownId ? { ownId, mappingDigest: digest(seed), browserVersion: 'mock' } : null;
    }
    if (isWebBrowserPlatform(this.platformId)) {
      const mapping = await loadWebPlatformReplyMapping(this.root, this.platformId, { allowFixture: this.allowFixture }).catch(() => null);
      if (!mapping) return null;
      requireSafe(!ownId || ownId === mapping.selfId, 'ACCOUNT_CHANGED');
      const channelConfig = channel === 'DIRECT_MESSAGE' ? mapping.selectors.dm : mapping.selectors.comment;
      if (!channelConfig) return null;
      const page = await this.pageFor(channel, mapping.entryUrl, 'reply');
      await new WebPlatformReplyAdapter(page, mapping, DEFAULT_ACCOUNT_ID).guard();
      return { ownId: mapping.selfId, mappingDigest: digest(mapping), browserVersion: this.browserVersion() };
    }
    const mapping = channel === 'DIRECT_MESSAGE' ? await loadDmReplyMapping(this.root) : await loadCommentReplyMapping(this.root);
    if (!mapping) return null;
    requireSafe(!ownId || ownId === mapping.observation.self.uid, 'ACCOUNT_CHANGED');
    const page = await this.pageFor(channel, mapping.observation.entryUrl);
    await new ObservedReader(page, mapping.observation).guard();
    return { ownId: mapping.observation.self.uid, mappingDigest: digest(mapping), browserVersion: this.browserVersion() };
  }

  private async inspect(target?: WorkerTarget): Promise<TargetSnapshot | { targetAvailable: true }> {
    this.requireOpen();
    requireSafe(!this.prepared, 'WORKER_PREPARATION_IN_PROGRESS');
    if (!target && this.syntheticOpen) return { targetAvailable: true };
    requireSafe(target, 'WORKER_TARGET_REQUIRED');
    const { event, ownId } = target;
    requireSafe(isEligible(event, ownId), 'WORKER_TARGET_INVALID');
    if (!this.handle) {
      const handle: TargetHandle = { target };
      if (!this.syntheticOpen) {
        if (isWebBrowserPlatform(this.platformId)) {
          const mapping = await requireCalibratedWebReplyMapping(this.root, this.platformId, { allowFixture: this.allowFixture });
          requireSafe(mapping.selfId === ownId, 'ACCOUNT_CHANGED');
          const channelConfig = event.channel === 'DIRECT_MESSAGE' ? mapping.selectors.dm : mapping.selectors.comment;
          requireSafe(channelConfig, 'PLATFORM_MAPPING_UNCALIBRATED');
          const page = await this.pageFor(event.channel, mapping.entryUrl, 'reply');
          handle.adapter = new WebPlatformReplyAdapter(page, mapping, event.accountId);
          handle.mappingDigest = digest(mapping);
        } else if (event.channel === 'DIRECT_MESSAGE') {
          const mapping = await loadDmReplyMapping(this.root);
          requireSafe(mapping?.observation.self.uid === ownId, 'NATIVE_REPLY_MAPPING_REQUIRED');
          const page = await this.pageFor(event.channel, mapping.observation.entryUrl);
          handle.adapter = new ObservedDmReply(page, mapping, undefined, { accountId: event.accountId });
        } else {
          const mapping = await loadCommentReplyMapping(this.root);
          requireSafe(mapping?.observation.self.uid === ownId, 'NATIVE_COMMENT_REPLY_MAPPING_REQUIRED');
          const page = await this.pageFor(event.channel, mapping.observation.entryUrl);
          handle.adapter = new ObservedCommentReply(page, mapping, undefined, { accountId: event.accountId });
        }
      }
      this.handle = handle;
    }
    return this.snapshot(this.requireTarget(target));
  }

  private requireTarget(target: WorkerTarget): TargetHandle {
    const handle = this.handle;
    requireSafe(handle && digest(handle.target) === digest(target), 'WORKER_TARGET_DIGEST_MISMATCH');
    return handle;
  }

  private async snapshot({ target: { event, ownId }, adapter }: TargetHandle): Promise<TargetSnapshot> {
    if (adapter) return adapter.inspect(event);
    const key = targetKey(event), binding = eventBinding(event);
    const seed = this.platformId === 'douyin' ? 'synthetic' : ['synthetic', this.platformId];
    return { accountId: event.accountId, ownId, targetKey: key, eventBinding: binding,
      contextDigest: digest([event.accountId, ownId, key, binding]), composerKey: key, mappingDigest: digest(seed) };
  }

  private async prepare(targetDigest?: string, target?: WorkerTarget, text?: string): Promise<{ prepared: true }> {
    this.requireOpen();
    requireSafe(targetDigest, 'WORKER_TARGET_DIGEST_REQUIRED');
    requireSafe(!this.prepared, 'WORKER_PREPARATION_IN_PROGRESS');
    if (!this.syntheticOpen && isWebBrowserPlatform(this.platformId)) {
      const latest = await requireCalibratedWebReplyMapping(this.root, this.platformId, { allowFixture: this.allowFixture });
      if (target && this.handle?.mappingDigest) {
        requireSafe(digest(latest) === this.handle.mappingDigest, 'TARGET_CHANGED_REAPPROVE');
      }
    }
    if (target) {
      const handle = this.requireTarget(target);
      requireSafe(text !== undefined, 'WORKER_TEXT_DIGEST_MISMATCH');
      requireSafe(digest(await this.snapshot(handle)) === targetDigest, 'WORKER_TARGET_DIGEST_MISMATCH');
      try { await handle.adapter?.prepare(target.event, text); }
      catch (error) {
        await handle.adapter?.cancelPreparation?.(target.event, text).catch(() => {});
        throw error;
      }
      this.prepared = { targetDigest, handle, text };
    } else {
      requireSafe(this.syntheticOpen, 'WORKER_TARGET_REQUIRED');
      this.prepared = { targetDigest };
    }
    return { prepared: true };
  }

  private async verifyPrepared(target: WorkerTarget, text: string): Promise<TargetSnapshot> {
    const handle = this.requireTarget(target);
    const record = this.prepared;
    requireSafe(record?.handle === handle && record.text === text, 'WORKER_NOT_PREPARED');
    const snapshot = handle.adapter ? await handle.adapter.verifyPrepared(target.event, text) : await this.snapshot(handle);
    requireSafe(digest(snapshot) === record.targetDigest, 'WORKER_TARGET_DIGEST_MISMATCH');
    return snapshot;
  }

  private async cancelPreparation(handleId?: string): Promise<{ prepared: false }> {
    const record = this.prepared;
    if (!handleId || record?.handle?.target.handleId === handleId) {
      this.prepared = undefined;
      if (record?.handle && record.text !== undefined) {
        await record.handle.adapter?.cancelPreparation?.(record.handle.target.event, record.text);
      }
    }
    return { prepared: false };
  }

  private async disposeTarget(handleId?: string): Promise<void> {
    const handle = this.handle;
    if (!handle || handle.target.handleId !== handleId) return;
    try {
      try { await this.cancelPreparation(handleId); }
      finally { await handle.adapter?.dispose(); }
    } finally {
      this.handle = undefined;
      if (this.lastDispatch?.handle === handle) this.lastDispatch = undefined;
    }
  }

  private checkSend(binding: WorkerSendBinding): void {
    requireSafe((binding.sendEpoch ?? 0) === this.sendEpoch, 'EMERGENCY_STOPPED');
    requireSafe(this.context || this.syntheticOpen, 'EMERGENCY_STOPPED');
    requireSafe(binding.permitExpiresAt === undefined ? this.syntheticOpen : Date.now() < binding.permitExpiresAt,
      'WORKER_SEND_PERMIT_EXPIRED');
  }

  private checkWindow(window: SendWindow): void {
    requireSafe(this.sendWindow === window && this.context === window.context && !window.closed,
      'EMERGENCY_STOPPED');
    this.checkSend(window.binding);
    if (window.failure) throw new Blocked(window.failure);
  }

  private async guardRequest(context: BrowserContext, route: Route): Promise<void> {
    const request = route.request();
    if (readOnlyMethods.has(request.method())) {
      await route.fallback();
      return;
    }
    const window = this.sendWindow;
    if (!window || window.context !== context || window.closed) {
      await route.abort('aborted');
      return;
    }
    let page: Page | undefined;
    try { page = request.frame().page(); }
    catch { /* Some requests have no associated frame. */ }
    if (!page || this.revokedPages.has(page) || page !== window.page) {
      await route.abort('aborted');
      return;
    }
    const pending = this.authorizeRequest(window, route);
    window.routes.add(pending);
    try { await pending; }
    finally { window.routes.delete(pending); }
  }

  private async authorizeRequest(window: SendWindow, route: Route): Promise<void> {
    try {
      this.checkWindow(window);
      const denial = await this.checkCorePermit(window.binding);
      // Apply any abort already queued on stdin before using the Core decision.
      await setImmediate();
      this.checkWindow(window);
      if (denial) throw new Blocked(denial);
      await route.continue();
    } catch (error) {
      window.failure ??= error instanceof Blocked && error.code === 'WORKER_SEND_PERMIT_EXPIRED'
        ? 'WORKER_SEND_PERMIT_EXPIRED' : 'EMERGENCY_STOPPED';
      await route.abort('aborted').catch(() => {});
    } finally {
      window.settled.resolve();
    }
  }

  private async clickWithPermit(adapter: NativeAdapter, context: BrowserContext, binding: WorkerSendBinding): Promise<void> {
    const deadline = binding.permitExpiresAt;
    requireSafe(deadline !== undefined, 'WORKER_SEND_PERMIT_EXPIRED');
    requireSafe(!this.revokedPages.has(adapter.page), 'EMERGENCY_STOPPED');
    const window: SendWindow = { context, page: adapter.page, binding, settled: Promise.withResolvers<void>(),
      routes: new Set(), closed: false };
    let mayHaveClicked = false;
    const savedPrepared = this.prepared;
    try {
      if (isWebBrowserPlatform(this.platformId)) {
        const preClickDenial = await this.checkCorePermit(binding);
        await setImmediate();
        this.checkSend(binding);
        if (preClickDenial) throw new Blocked(preClickDenial);
      }
      await adapter.clickOnce(binding.notBefore, () => {
        this.checkSend(binding);
        mayHaveClicked = true;
        this.sendWindow = window;
        this.prepared = undefined;
      }, deadline).catch(error => {
        if ((error as { preClick?: boolean }).preClick === true) {
          mayHaveClicked = false;
          if (this.sendWindow === window) this.sendWindow = undefined;
          if (!this.prepared && savedPrepared) this.prepared = savedPrepared;
          this.checkSend(binding);
          throw error;
        }
        this.checkSend(binding);
        if (this.sendWindow === window) this.checkWindow(window);
        throw error;
      });
      this.checkWindow(window);
      // Playwright can finish evaluate before reporting the first network request from the click.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Blocked('WORKER_SEND_PERMIT_EXPIRED')),
          Math.min(deadline - Date.now(), 2_147_483_647));
      });
      try {
        await Promise.race([window.settled.promise, expired]);
        this.checkWindow(window);
        await Promise.race([Promise.all(window.routes), expired]);
        this.checkWindow(window);
      } finally { clearTimeout(timer); }
    } catch (error) {
      if (mayHaveClicked) this.revokedPages.add(window.page);
      throw error;
    } finally {
      window.closed = true;
      if (this.sendWindow === window) this.sendWindow = undefined;
    }
  }

  private async execute({ binding, text }: Extract<WorkerCommand, { action: 'executeSend' }>): Promise<WorkerSendEvidence> {
    this.assertBinding(binding.sessionId, binding.ownerEpoch);
    requireSafe(!consumedNonces.has(binding.nonce), 'WORKER_NONCE_REPLAYED');
    requireSafe(!dispatchedIntents.has(binding.intentId), 'WORKER_INTENT_REPLAYED');
    requireSafe(workerTextDigest(text) === binding.textDigest, 'WORKER_TEXT_DIGEST_MISMATCH');
    const prepared = this.prepared;
    requireSafe(prepared, 'WORKER_NOT_PREPARED');
    requireSafe(prepared.targetDigest === binding.targetDigest, 'WORKER_TARGET_DIGEST_MISMATCH');
    this.checkSend(binding);
    const boundary = Date.parse(binding.notBefore);
    if (isWebBrowserPlatform(this.platformId) && Number.isFinite(boundary) && boundary > Date.now() && boundary - Date.now() <= 50) {
      await new Promise(resolve => setTimeout(resolve, boundary - Date.now() + 1));
    }
    requireSafe(Number.isFinite(boundary) && boundary <= Date.now(), 'WORKER_SEND_BOUNDARY_INVALID');
    if (prepared.handle) await this.verifyPrepared(prepared.handle.target, text);
    // Give pending pipe input a turn before reaching the adapter's final synchronous check.
    await setImmediate();
    this.checkSend(binding);
    if (!this.syntheticOpen && isWebBrowserPlatform(this.platformId)) {
      const latest = await requireCalibratedWebReplyMapping(this.root, this.platformId, { allowFixture: this.allowFixture });
      if (prepared.handle?.mappingDigest) {
        requireSafe(digest(latest) === prepared.handle.mappingDigest, 'TARGET_CHANGED_REAPPROVE');
      }
    }
    consumedNonces.add(binding.nonce);
    dispatchedIntents.add(binding.intentId);
    if (!this.syntheticOpen) {
      const adapter = prepared.handle?.adapter;
      requireSafe(adapter && this.context, 'WORKER_NOT_PREPARED');
      await this.clickWithPermit(adapter, this.context, binding);
    }
    this.prepared = undefined;
    this.executedCount++;
    const executedAt = new Date().toISOString();
    const evidence = { intentId: binding.intentId, nonce: binding.nonce, executedAt, evidenceDigest: digest([binding, executedAt]) };
    const dispatch: DispatchedSend = { evidence, textDigest: binding.textDigest, notBefore: binding.notBefore,
      ...(prepared.handle ? { handle: prepared.handle } : {}) };
    if (this.syntheticOpen) this.observations.set(binding.intentId, dispatch);
    else this.lastDispatch = dispatch;
    return evidence;
  }

  private async readback({ intentId, baseline, notBefore, text, target }: Extract<WorkerCommand, { action: 'readback' }>): Promise<WorkerReadback> {
    const record = this.hello.mode === 'synthetic' ? this.observations.get(intentId) : this.lastDispatch;
    if (record?.evidence.intentId === intentId && record.notBefore === notBefore &&
      record.textDigest === workerTextDigest(text) && !baseline.includes(intentId)) {
      if (this.hello.mode === 'synthetic') {
        const sentAt = record.evidence.executedAt;
        const proof: SendProof | null = record.handle ? { id: intentId, ownId: record.handle.target.ownId,
          targetKey: targetKey(record.handle.target.event), text, pending: false, sentAt,
          submission: { boundary: notBefore, requestAt: sentAt, responseAt: sentAt,
            requestDigest: record.evidence.evidenceDigest, responseDigest: digest([intentId, sentAt]) } } : null;
        return { verified: true, evidence: record.evidence, ...(proof ? { proof } : {}) };
      }
      const handle = target && this.requireTarget(target);
      if (handle && handle === record.handle && handle.adapter) {
        const proof = await handle.adapter.readback(handle.target.event, text, baseline, notBefore);
        if (proof) return { verified: true, evidence: record.evidence, proof };
      }
    }
    return { verified: false, evidence: null };
  }

  private async verifyExisting({ target, text, notBefore }: Extract<WorkerCommand, { action: 'verifyExisting' }>): Promise<{ verified: boolean; proof: SendProof | null }> {
    this.requireOpen();
    requireSafe(!this.prepared, 'WORKER_PREPARATION_IN_PROGRESS');
    if (this.syntheticOpen || !isWebBrowserPlatform(this.platformId)) {
      return { verified: false, proof: null };
    }
    const mapping = await requireCalibratedWebReplyMapping(this.root, this.platformId, { allowFixture: this.allowFixture });
    requireSafe(mapping.selfId === target.ownId, 'ACCOUNT_CHANGED');
    const channelConfig = target.event.channel === 'DIRECT_MESSAGE' ? mapping.selectors.dm : mapping.selectors.comment;
    requireSafe(channelConfig, 'PLATFORM_MAPPING_UNCALIBRATED');
    const page = await this.pageFor(target.event.channel, mapping.entryUrl, 'verify');
    const adapter = new WebPlatformReplyAdapter(page, mapping, target.event.accountId, 500);
    const proof = await adapter.verifyExisting(target.event, text, notBefore);
    return { verified: Boolean(proof), proof };
  }

  private assertBinding(sessionId: string, ownerEpoch: number): void {
    requireSafe(sessionId === this.hello.sessionId, 'WORKER_SESSION_MISMATCH');
    requireSafe(ownerEpoch === this.hello.ownerEpoch, 'WORKER_EPOCH_STALE');
  }

  abortSend(): void {
    this.sendEpoch++;
    this.sendWindow?.settled.resolve();
  }

  accept(request: WorkerRequestEnvelope): () => Promise<unknown> {
    const { sessionId, ownerEpoch, command } = request;
    this.assertBinding(sessionId, ownerEpoch);
    if (command.action === 'abortSend') {
      this.abortSend();
      return async () => null;
    }
    if (command.action === 'shutdown') this.abortSend();
    return () => this.dispatch(command);
  }

  private async dispatch(command: Exclude<WorkerCommand, { action: 'abortSend' }>): Promise<unknown> {
    switch (command.action) {
      case 'hello': return this.hello;
      case 'status': return this.status();
      case 'open': await this.open(); return this.status();
      case 'close': await this.closeBrowser(); return this.status();
      case 'observe': return this.observe(command);
      case 'identity': return this.identity(command.channel, command.ownId);
      case 'inspectTarget': return this.inspect(command.target);
      case 'prepareSend': return this.prepare(command.targetDigest, command.target, command.text);
      case 'verifyPrepared': return this.verifyPrepared(command.target, command.text);
      case 'baseline': return this.requireTarget(command.target).adapter?.baseline(command.target.event) ?? [];
      case 'cancelPreparation': return this.cancelPreparation(command.handleId);
      case 'disposeTarget': await this.disposeTarget(command.handleId); return null;
      case 'executeSend': return this.execute(command);
      case 'readback': return this.readback(command);
      case 'verifyExisting': return this.verifyExisting(command);
      case 'shutdown': return { shuttingDown: true };
    }
  }
}

function send(frame: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(frame, error => error ? reject(error) : resolve());
  });
}

async function main(): Promise<void> {
  const parentPid = process.ppid;
  const config = configuration();
  const lock = await OwnerLock.acquire(config.profileDir);
  let closing = false;
  const permitChecks = new Map<string, PromiseWithResolvers<WorkerPermitError | null>>();
  const runtime = new WorkerRuntime(config.profileDir, config.mode, config.sessionId, config.ownerEpoch, async binding => {
    if (closing) return 'EMERGENCY_STOPPED';
    const id = randomUUID();
    const result = Promise.withResolvers<WorkerPermitError | null>();
    permitChecks.set(id, result);
    const timer = setTimeout(() => result.resolve('EMERGENCY_STOPPED'), permitCheckTimeoutMs);
    try {
      void send(encodeWorkerPermitCheck({ kind: 'permitCheck', id, sessionId: config.sessionId,
        ownerEpoch: config.ownerEpoch, nonce: binding.nonce })).catch(() => result.resolve('EMERGENCY_STOPPED'));
      return await result.promise;
    } finally {
      clearTimeout(timer);
      permitChecks.delete(id);
    }
  }, config.platformId, config.accountRoot, config.allowFixture);
  let queued = 0;
  let operations = Promise.resolve();
  const shutdown = async (exitCode: number) => {
    if (closing) return;
    closing = true;
    runtime.abortSend();
    for (const pending of permitChecks.values()) pending.resolve('EMERGENCY_STOPPED');
    clearInterval(heartbeat);
    const watchdog = setTimeout(() => process.exit(1), 15_000);
    watchdog.unref();
    try {
      await operations.catch(() => {});
      await runtime.closeBrowser();
    } catch {
      exitCode = 1;
    } finally {
      await lock.close();
    }
    process.exit(exitCode);
  };
  const stop = () => { void shutdown(0).catch(fatal); };
  const heartbeat = setInterval(() => {
    try {
      if (parentPid <= 1 || process.ppid !== parentPid) stop();
      else process.kill(parentPid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') stop();
    }
  }, 2_000);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.stdin.once('end', stop);
  process.stdout.on('error', stop);

  const respond = async (request: WorkerRequestEnvelope, operation: () => Promise<unknown>) => {
    const response = { id: request.id, sessionId: config.sessionId, ownerEpoch: config.ownerEpoch };
    let body: WorkerResponseEnvelope;
    try {
      body = { ...response, ok: true, result: await operation() };
    } catch (error) {
      body = { ...response, ok: false, error: isSecurityFailure(error) ? 'OBSERVATION_SECURITY_SUSPECT' :
        error instanceof Blocked ? error.code : 'WORKER_OPERATION_FAILED' };
    }
    if (!closing) await send(encodeWorkerResponse(body));
  };
  try {
    // Revoke on ingress while browser operations and their replies stay serialized.
    for await (const request of readWorkerInput(process.stdin)) {
      if (closing) break;
      if ('kind' in request) {
        requireSafe(request.sessionId === config.sessionId, 'WORKER_SESSION_MISMATCH');
        requireSafe(request.ownerEpoch === config.ownerEpoch, 'WORKER_EPOCH_STALE');
        permitChecks.get(request.id)?.resolve(request.error);
        continue;
      }
      let operation: () => Promise<unknown>;
      try {
        operation = runtime.accept(request);
      } catch (error) {
        operation = async () => { throw error; };
      }
      if (request.command.action === 'abortSend') {
        await respond(request, operation);
        continue;
      }
      requireSafe(++queued <= 128, 'WORKER_QUEUE_FULL');
      operations = operations.then(async () => {
        if (!closing) await respond(request, operation);
        queued--;
      }).catch(() => { void shutdown(1).catch(fatal); });
      if (request.command.action === 'shutdown' && request.sessionId === config.sessionId &&
          request.ownerEpoch === config.ownerEpoch) {
        await operations;
        break;
      }
    }
    await shutdown(0);
  } catch (error) {
    if (!closing) process.stderr.write(`${error instanceof Blocked ? error.code : 'WORKER_PROTOCOL_FAILED'}\n`);
    await shutdown(1);
  }
}

function fatal(error: unknown): void {
  const code = error instanceof Blocked ? error.code : 'WORKER_START_FAILED';
  process.stderr.write(`${code}\n`, () => process.exit(1));
}

await main().catch(fatal);
