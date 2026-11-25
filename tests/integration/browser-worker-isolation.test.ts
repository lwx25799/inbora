import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import type { Page } from 'playwright';
import { expect, test, vi } from 'vitest';
import { ObservedCommentReply } from '../../src/adapters/observed-comment-reply.js';
import { ObservedDmReply } from '../../src/adapters/observed-dm-reply.js';
import { createRuntimeConnector, createWorkerDispatchLedger, runtimeWorkerMode } from '../../src/app/account-controller.js';
import { ClientService } from '../../src/app/service.js';
import { OwnerLock } from '../../src/browser/owner-lock.js';
import type { WorkerCommand, WorkerRequestEnvelope, WorkerSendBinding } from '../../src/contracts/browser-worker.js';
import { digest } from '../../src/core/contracts.js';
import { SendCoordinator } from '../../src/core/send-coordinator.js';
import { EventStore } from '../../src/storage/store.js';
import { migrateClient } from '../../src/storage/client-migration.js';
import { BrowserWorkerHost, type BrowserWorkerHostOptions, type WorkerDispatchLedger } from '../../src/workers/browser-worker-host.js';
import { encodeWorkerRequest, readWorkerResponses, workerTextDigest } from '../../src/workers/worker-protocol.js';
import { candidate, pending } from '../helpers.js';
import { commentReplyMapping, dmReplyMapping } from '../fixtures/observed-site.js';

async function profileFixture(): Promise<string> {
  const base = resolve('.local/tests');
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, 'wave31c-worker-'));
}

test('the live Worker and Core use the same exclusive Profile lock and shutdown releases it', async () => {
  const profile = await profileFixture();
  const host = new BrowserWorkerHost({ profileDir: profile, mode: 'synthetic' });
  const competitor = new BrowserWorkerHost({ profileDir: profile, mode: 'synthetic' });
  try {
    const hello = await host.start();
    expect(hello).toEqual({ pid: host.pid, sessionId: host.sessionId, ownerEpoch: host.ownerEpoch, profileLocked: true, mode: 'synthetic' });
    expect(hello.pid).not.toBe(process.pid);
    await expect(host.observe()).resolves.toEqual({ events: [] });
    await expect(host.inspectTarget()).resolves.toEqual({ targetAvailable: true });
    await expect(host.prepareSend('a'.repeat(64))).resolves.toEqual({ prepared: true });
    await expect(host.cancelPreparation()).resolves.toEqual({ prepared: false });
    await expect(host.closeBrowser()).resolves.toMatchObject({ state: 'CLOSED' });
    await expect(host.open()).resolves.toMatchObject({ state: 'OPEN' });
    await expect(competitor.start()).rejects.toMatchObject({ code: 'OWNER_LOCKED_OR_PORT_UNAVAILABLE' });
    await expect(OwnerLock.acquire(profile)).rejects.toMatchObject({ code: 'OWNER_LOCKED_OR_PORT_UNAVAILABLE' });
    await host.close();
    expect(host.pid).toBeUndefined();
    expect(() => process.kill(hello.pid, 0)).toThrow(/ESRCH/u);
    const lock = await OwnerLock.acquire(profile);
    try {
      await expect(host.start()).rejects.toMatchObject({ code: 'OWNER_LOCKED_OR_PORT_UNAVAILABLE' });
    } finally {
      await lock.close();
    }
  } finally {
    await Promise.all([host.close(), competitor.close()]);
    await rm(profile, { recursive: true, force: true });
  }
});

test('a crash after dispatch cannot replay the intent and recovery only reads evidence', async () => {
  const profile = await profileFixture();
  const ledgerPath = join(profile, 'dispatched.jsonl');
  const openLedger = (): WorkerDispatchLedger => ({
    hasDispatched: id => existsSync(ledgerPath) && readFileSync(ledgerPath, 'utf8').trim().split('\n')
      .some(line => (JSON.parse(line) as WorkerSendBinding).intentId === id),
    recordDispatched: binding => appendFileSync(ledgerPath, JSON.stringify(binding) + '\n', { flush: true }),
  });
  const host = new BrowserWorkerHost({ profileDir: profile, mode: 'synthetic', ledger: openLedger() });
  let replacement: BrowserWorkerHost | undefined;
  try {
    const first = await host.start();
    const input = { intentId: randomUUID(), notBefore: new Date().toISOString(), text: 'synthetic reply', targetDigest: 'a'.repeat(64) };
    await host.prepareSend(input.targetDigest);
    const evidence = await host.executeSend(input);
    expect(evidence).toEqual({ intentId: input.intentId, nonce: expect.stringMatching(/^[a-f0-9-]{36}$/u),
      executedAt: expect.any(String), evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect((await host.status()).executedCount).toBe(1);
    await expect(host.readback({ ...input, baseline: [] })).resolves.toEqual({ verified: true, evidence });
    await expect(host.readback({ ...input, baseline: [input.intentId] })).resolves.toEqual({ verified: false, evidence: null });
    await expect(host.executeSend({ ...input, intentId: randomUUID(), nonce: evidence.nonce })).rejects.toThrow('WORKER_NONCE_REPLAYED');
    expect((await host.status()).executedCount).toBe(1);

    const unknown = { intentId: randomUUID(), notBefore: input.notBefore, text: input.text, targetDigest: input.targetDigest };
    await host.prepareSend(unknown.targetDigest);
    const pending = expect(host.executeSend(unknown)).rejects.toThrow('WORKER_DISCONNECTED');
    expect(openLedger().hasDispatched(unknown.intentId)).toBe(true);
    await host.killForTest();
    await pending;
    expect(() => process.kill(first.pid, 0)).toThrow(/ESRCH/u);
    const next = await host.restart();
    expect(next.ownerEpoch).toBe(first.ownerEpoch + 1);
    expect(next.sessionId).not.toBe(first.sessionId);
    await expect(host.executeSend(unknown)).rejects.toThrow('WORKER_CRASH_NO_REPLAY');
    await host.close();
    replacement = new BrowserWorkerHost({ profileDir: profile, mode: 'synthetic', ledger: openLedger() });
    await replacement.start();
    await replacement.prepareSend(input.targetDigest);
    await expect(replacement.executeSend(input)).rejects.toThrow('WORKER_CRASH_NO_REPLAY');
    await expect(replacement.executeSend(unknown)).rejects.toThrow('WORKER_CRASH_NO_REPLAY');
    await expect(replacement.readback({ ...unknown, baseline: [] })).resolves.toEqual({ verified: false, evidence: null });
    expect((await replacement.status()).executedCount).toBe(0);
  } finally {
    await Promise.all([host.close(), replacement?.close()]);
    await rm(profile, { recursive: true, force: true });
  }
});

test('the Worker rejects stale envelopes and bindings, tampered text, and intent replay on the wire', async () => {
  const profile = await profileFixture();
  const sessionId = randomUUID();
  const ownerEpoch = 4;
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/workers/browser-worker-entry.ts'], {
      env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP,
        TSX_DISABLE_CACHE: '1', INBORA_WORKER_PROFILE_DIR: profile, INBORA_WORKER_MODE: 'synthetic',
        INBORA_WORKER_SESSION_ID: sessionId, INBORA_WORKER_EPOCH: String(ownerEpoch) }, windowsHide: true,
    });
    const exited = once(child, 'close');
    void exited.catch(() => {});
    child.stdin.on('error', () => {});
    child.stderr.resume();
    const responses = readWorkerResponses(child.stdout);
    const request = async (command: WorkerCommand, overrides: Partial<WorkerRequestEnvelope> = {}) => {
      const id = randomUUID();
      child.stdin.write(encodeWorkerRequest({ id, sessionId, ownerEpoch, command, ...overrides }));
      const response = await Promise.race([responses.next(), exited.then(() => {
        throw new Error('Worker exited before responding');
      })]);
      expect(response.value).toMatchObject({ id, sessionId, ownerEpoch });
      return response.value;
    };
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 20_000);
    try {
      expect(await request({ action: 'hello' })).toMatchObject({ ok: true });
      const text = 'bound text';
      const binding: WorkerSendBinding = { intentId: randomUUID(), nonce: randomUUID(), sessionId, ownerEpoch,
        notBefore: new Date().toISOString(), textDigest: workerTextDigest(text), targetDigest: 'd'.repeat(64) };
      const command = { action: 'executeSend', binding, text } as const;
      expect(await request(command, { ownerEpoch: ownerEpoch - 1 })).toMatchObject({ ok: false, error: 'WORKER_EPOCH_STALE' });
      expect(await request(command, { sessionId: randomUUID() })).toMatchObject({ ok: false, error: 'WORKER_SESSION_MISMATCH' });
      expect(await request({ ...command, binding: { ...binding, ownerEpoch: ownerEpoch - 1 } }))
        .toMatchObject({ ok: false, error: 'WORKER_EPOCH_STALE' });
      expect(await request({ ...command, binding: { ...binding, sessionId: randomUUID() } }))
        .toMatchObject({ ok: false, error: 'WORKER_SESSION_MISMATCH' });
      expect(await request({ ...command, text: 'tampered' })).toMatchObject({ ok: false, error: 'WORKER_TEXT_DIGEST_MISMATCH' });
      expect(await request(command)).toMatchObject({ ok: false, error: 'WORKER_NOT_PREPARED' });
      expect(await request({ action: 'prepareSend', targetDigest: 'a'.repeat(64) })).toMatchObject({ ok: true });
      expect(await request(command)).toMatchObject({ ok: false, error: 'WORKER_TARGET_DIGEST_MISMATCH' });
      expect(await request({ action: 'cancelPreparation' })).toMatchObject({ ok: true });
      expect(await request(command)).toMatchObject({ ok: false, error: 'WORKER_NOT_PREPARED' });
      expect(await request({ action: 'prepareSend', targetDigest: binding.targetDigest })).toMatchObject({ ok: true });
      expect(await request({ action: 'close' })).toMatchObject({ ok: true });
      expect(await request({ action: 'open' })).toMatchObject({ ok: true });
      expect(await request(command)).toMatchObject({ ok: false, error: 'WORKER_NOT_PREPARED' });
      expect(await request({ action: 'status' })).toMatchObject({ ok: true, result: { executedCount: 0 } });
      expect(await request({ action: 'prepareSend', targetDigest: binding.targetDigest })).toMatchObject({ ok: true });
      expect(await request({ ...command, binding: { ...binding, permitExpiresAt: Date.now() - 1 } }))
        .toMatchObject({ ok: false, error: 'WORKER_SEND_PERMIT_EXPIRED' });
      const sendId = randomUUID(), abortId = randomUUID();
      const leased = { ...command, binding: { ...binding, permitExpiresAt: Date.now() + 1_500 } };
      child.stdin.write(Buffer.concat([
        encodeWorkerRequest({ id: sendId, sessionId, ownerEpoch, command: leased }),
        encodeWorkerRequest({ id: abortId, sessionId, ownerEpoch, command: { action: 'abortSend' } }),
      ]));
      const replies = [(await responses.next()).value, (await responses.next()).value];
      expect(replies).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: sendId, ok: false, error: 'EMERGENCY_STOPPED' }),
        expect.objectContaining({ id: abortId, ok: true }),
      ]));
      expect(await request(leased)).toMatchObject({ ok: false, error: 'EMERGENCY_STOPPED' });
      expect(await request({ action: 'status' })).toMatchObject({ ok: true, result: { executedCount: 0 } });
      expect(await request({ ...command, binding: { ...binding, sendEpoch: 1 } }))
        .toMatchObject({ ok: true, result: { intentId: binding.intentId } });
      expect(await request({ ...command, binding: { ...binding, nonce: randomUUID() } }))
        .toMatchObject({ ok: false, error: 'WORKER_INTENT_REPLAYED' });
      expect(await request({ ...command, binding: { ...binding, nonce: randomUUID(), intentId: randomUUID() } }))
        .toMatchObject({ ok: false, error: 'WORKER_NOT_PREPARED' });
      expect(await request({ action: 'status' })).toMatchObject({ ok: true, result: { executedCount: 1 } });
      child.stdin.end();
      await expect(exited).resolves.toEqual([0, null]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      try { await exited; } finally { clearTimeout(watchdog); }
    }
    const lock = await OwnerLock.acquire(profile);
    await lock.close();
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

async function queuedClickFixture(onPermitCheck?: BrowserWorkerHostOptions['onPermitCheck'], { deferPost = false } = {}) {
  const root = await profileFixture();
  const held = Promise.withResolvers<void>();
  const queued = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const releasePost = Promise.withResolvers<void>();
  const clicked = Promise.withResolvers<number>();
  const attempted = Promise.withResolvers<void>();
  let writes = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    switch (url.pathname) {
      case '/hold': held.resolve(); await release.promise; break;
      case '/held': await held.promise; break;
      case '/queued': queued.resolve(); break;
      case '/clicked': clicked.resolve(Number(url.searchParams.get('count'))); break;
      case '/wait-to-send': await releasePost.promise; break;
      case '/attempted': attempted.resolve(); break;
      case '/send': if (req.method === 'POST') writes++; break;
    }
    res.end('OK');
  });
  server.listen(0, '127.0.0.1');
  const relativeUrl = (path: string) => pathToFileURL(resolve(path)).href;
  let host: BrowserWorkerHost | undefined;
  const close = async () => {
    release.resolve();
    releasePost.resolve();
    held.resolve();
    try { await host?.close(); }
    finally {
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      await rm(root, { recursive: true, force: true });
    }
  };
  try {
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const origin = `http://127.0.0.1:${address.port}`;
    const entry = join(root, 'fixture-worker.ts');
    const runtime = relativeUrl('src/config/runtime.ts');
    const fixtureRuntime = 'data:text/javascript,' + encodeURIComponent(
      `export * from ${JSON.stringify(runtime)}; export function loadDmReplyMapping() { return ${JSON.stringify(dmReplyMapping(origin))}; }`,
    );
    // The child still runs the real entry, adapter, IPC and routing. Only the local mapping and scheduling are fixtures.
    await writeFile(entry, `
      import { registerHooks } from 'node:module';
      import { chromium } from 'playwright';
      import { mountDmReply } from ${JSON.stringify(relativeUrl('tests/fixtures/observed-site.ts'))};
      const origin = ${JSON.stringify(origin)};
      registerHooks({ resolve(specifier, context, next) {
        if (specifier === '../config/runtime.js' && context.parentURL === ${JSON.stringify(relativeUrl('src/workers/browser-worker-entry.ts'))}) {
          return { url: ${JSON.stringify(fixtureRuntime)}, shortCircuit: true };
        }
        return next(specifier, context);
      } });
      const launch = chromium.launchPersistentContext.bind(chromium);
      chromium.launchPersistentContext = async (...args) => {
        const context = await launch(...args);
        const newPage = context.newPage.bind(context);
        context.newPage = async () => {
          const page = await newPage();
          await mountDmReply({ dm: page }, origin);
          await page.evaluate(deferPost => {
            document.querySelector('#native-send').addEventListener('click', () => {
              void (deferPost ? fetch('/wait-to-send') : Promise.resolve())
                .then(() => fetch('/send', { method: 'POST', body: 'fixture' }).catch(() => {}))
                .then(() => fetch('/attempted'));
            });
          }, ${deferPost});
          const evaluate = page.evaluate.bind(page);
          page.evaluate = async (fn, arg) => {
            if (!fn.toString().includes('gate.submit()')) return evaluate(fn, arg);
            const blocker = evaluate(() => {
              const xhr = new XMLHttpRequest();
              xhr.open('GET', '/hold', false);
              xhr.send();
            });
            void blocker.catch(() => {});
            await fetch(origin + '/held');
            const click = evaluate(fn, arg);
            void click.catch(() => {});
            await fetch(origin + '/queued');
            const report = async () => {
              const count = await evaluate(() => window.nativeClicks);
              await fetch(origin + '/clicked?count=' + count);
            };
            void click.then(report, report).catch(() => {});
            return click;
          };
          return page;
        };
        return context;
      };
      await import(${JSON.stringify(relativeUrl('src/workers/browser-worker-entry.ts'))});
    `);
    host = new BrowserWorkerHost({ profileDir: join(root, 'profile'), entryScript: entry, ...(onPermitCheck && { onPermitCheck }) });
    await host.start();
    await host.open();
    const target = { handleId: randomUUID(), ownId: '100', event: candidate({
      actorId: '200', conversationId: 'conv-a', platformEventId: '3',
      text: 'controlled-3', occurredAt: '2026-11-05T00:00:00.000Z',
    }) };
    const text = 'local HTTP fixture reply';
    const targetDigest = digest(await host.inspectTarget(target));
    await host.prepareSend(targetDigest, target, text);
    return {
      host, queued: queued.promise, release: release.resolve, clicked: clicked.promise, attempted: attempted.promise,
      releasePost: releasePost.resolve, writes: () => writes, close,
      send: (permitExpiresAt: number) => host!.executeSend({
        intentId: randomUUID(), notBefore: new Date().toISOString(), text, targetDigest, permitExpiresAt,
      }),
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function waitForFixture<T>(event: Promise<T>): Promise<T> {
  const timer = new AbortController();
  try {
    return await Promise.race([event, pause(8_000, undefined, { signal: timer.signal }).then(() => {
      throw new Error('Worker browser fixture did not reach the expected step');
    })]);
  } finally { timer.abort(); }
}

test('a queued browser click cannot send a POST after the Worker acknowledges emergency stop', async () => {
  const fixture = await queuedClickFixture();
  try {
    const sent = fixture.send(Date.now() + 8_000);
    void sent.catch(() => {});
    await Promise.race([fixture.queued, sent.then(() => { throw new Error('Send finished before it queued'); })]);
    const acknowledged = await fixture.host.abortInFlight();
    fixture.release();
    await waitForFixture(fixture.attempted);
    expect(fixture.writes()).toBe(0);
    expect(acknowledged).toBe(true);
    await expect(sent).rejects.toMatchObject({ code: 'EMERGENCY_STOPPED' });
    expect(await fixture.host.status()).toMatchObject({ executedCount: 0 });
  } finally { await fixture.close(); }
});

test('a delayed POST stays blocked after the stopped send has finished', async () => {
  const fixture = await queuedClickFixture(undefined, { deferPost: true });
  try {
    const sent = fixture.send(Date.now() + 8_000);
    void sent.catch(() => {});
    await waitForFixture(fixture.queued);
    fixture.release();
    expect(await waitForFixture(fixture.clicked)).toBe(1);
    expect(await fixture.host.abortInFlight()).toBe(true);
    await expect(sent).rejects.toMatchObject({ code: 'EMERGENCY_STOPPED' });
    await pause(2_000);
    fixture.releasePost();
    await waitForFixture(fixture.attempted);
    expect(fixture.writes()).toBe(0);
  } finally { await fixture.close(); }
}, 30_000);

test('a permit expiring in the browser evaluation queue prevents the DOM click', async () => {
  const fixture = await queuedClickFixture();
  try {
    const deadline = Date.now() + 1_500;
    const sent = fixture.send(deadline);
    void sent.catch(() => {});
    await Promise.race([fixture.queued, sent.then(() => { throw new Error('Send finished before it queued'); })]);
    expect(Date.now()).toBeLessThan(deadline);
    await pause(deadline - Date.now() + 20);
    fixture.release();
    expect(await waitForFixture(fixture.clicked)).toBe(0);
    await expect(sent).rejects.toMatchObject({ code: 'WORKER_SEND_PERMIT_EXPIRED' });
    expect(fixture.writes()).toBe(0);
  } finally { await fixture.close(); }
});

test.each(['dm', 'comment'])('the serialized %s gate removes itself when the permit expires', async channel => {
  const origin = 'http://127.0.0.1:8080';
  const token = 'fixture-gate';
  const gate = { token, submit: vi.fn(() => true), remove: vi.fn() };
  const deadline = Date.now() + 1000;
  const window = channel === 'dm' ? { __inboraDmReplyGate: gate } : { __inboraCommentGate: gate };
  const page = {
    on: () => {},
    once: () => {},
    evaluate: async (fn: (input: unknown) => unknown, arg: unknown) => {
      try { return runInNewContext(`(${fn.toString()})(arg)`, { window, arg, Date: { now: () => deadline } }); }
      catch (error) { throw new Error((error as Error).message); }
    },
  } as unknown as Page;
  const adapter = channel === 'dm'
    ? new ObservedDmReply(page, dmReplyMapping(origin))
    : new ObservedCommentReply(page, commentReplyMapping(origin));
  Object.assign(adapter, channel === 'dm' ? { gateToken: token } : { token });
  await expect(adapter.clickOnce(new Date(Date.now() - 2_000).toISOString(), undefined, deadline))
    .rejects.toMatchObject({ code: 'WORKER_SEND_PERMIT_EXPIRED' });
  expect(gate.submit).not.toHaveBeenCalled();
  expect(gate.remove).toHaveBeenCalledTimes(1);
});

test.each([true, false])('the Worker uses the live Core decision to allow a queued POST (%s)', async allow => {
  let livePermit = true;
  const onPermitCheck = vi.fn(() => livePermit);
  const fixture = await queuedClickFixture(onPermitCheck);
  try {
    const sent = fixture.send(Date.now() + 8_000);
    void sent.catch(() => {});
    await Promise.race([fixture.queued, sent.then(() => { throw new Error('Send finished before it queued'); })]);
    expect(onPermitCheck).not.toHaveBeenCalled();
    livePermit = allow;
    fixture.release();
    await waitForFixture(fixture.attempted);
    expect(onPermitCheck).toHaveBeenCalledWith(expect.objectContaining({ sessionId: fixture.host.sessionId, sendEpoch: 0 }));
    expect(fixture.writes()).toBe(allow ? 1 : 0);
    if (allow) await expect(sent).resolves.toMatchObject({ intentId: expect.any(String) });
    else await expect(sent).rejects.toMatchObject({ code: 'EMERGENCY_STOPPED' });
  } finally { await fixture.close(); }
});

test('single-account keeps the local connector and explicit or multi-browser mode selects isolation', async () => {
  const root = await profileFixture();
  const store = new EventStore(join(root, 'selection.sqlite'), true);
  try {
    vi.stubEnv('INBORA_BROWSER_WORKER', '');
    expect(createRuntimeConnector(root, store).constructor.name).toBe('DouyinPlatformConnector');
    vi.stubEnv('INBORA_BROWSER_WORKER', '1');
    expect(createRuntimeConnector(root, store).constructor.name).toBe('IsolatedDouyinConnector');
    vi.stubEnv('INBORA_BROWSER_WORKER', '');
    await migrateClient(store, join(root, 'pre-client.sqlite'));
    const service = new ClientService(store, createRuntimeConnector(root, store));
    try {
      await service.loadSettings();
      const storage = service.accounts.storage!;
      storage.registerAccount({ commandId: randomUUID(), platform: 'douyin', connector: 'douyin',
        accountId: 'account_secondary', ownId: 'fixture-secondary' });
      expect(runtimeWorkerMode(store)).toBe('browser');
      expect(createRuntimeConnector(root, store).constructor.name).toBe('IsolatedDouyinConnector');
    } finally { await service.close(); }
  } finally {
    vi.unstubAllEnvs();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the isolated Core sends an original and a human followup, then signals the Worker on emergency stop', async () => {
  const root = await profileFixture();
  const store = new EventStore(join(root, 'followup.sqlite'), true);
  const connector = createRuntimeConnector(root, store, 'synthetic');
  let activeService: ClientService | undefined;
  try {
    await migrateClient(store, join(root, 'pre-client.sqlite'));
    const eventId = pending(store);
    const service = activeService = new ClientService(store, connector);
    await service.loadSettings();
    await connector.open();
    const token = service.authority.issueSession();
    await service.dispatch(token, { command: 'setMode', mode: 'MANUAL' });
    const selectionId = randomUUID();
    const detail = await service.dispatch(token, { command: 'openHumanDialog', eventId, selectionId }) as {
      ownership: { generation: number }; contextVersion: string;
    };
    const input = { eventId, selectionId, generation: detail.ownership.generation, expectedVersion: 0,
      text: 'first isolated human reply', contextVersion: detail.contextVersion, suggestionId: null };
    const firstId = randomUUID();
    await service.dispatch(token, { command: 'sendHumanReply', commandId: firstId, input });
    await service.drain();
    expect(await service.dispatch(token, { command: 'getSendResult', commandId: firstId })).toMatchObject({ status: 'CONFIRMED' });

    const followupId = randomUUID();
    const next = (text: string, expectedVersion: number) => ({ ...input, text, expectedVersion,
      contextVersion: service.authority.contextVersion(store.event(eventId)) });
    await service.dispatch(token, { command: 'sendHumanFollowup', commandId: followupId,
      input: next('second isolated human reply', 0) });
    await service.drain();
    const receipt = await service.dispatch(token, { command: 'getSendResult', commandId: followupId });
    expect(receipt).toMatchObject({ status: 'CONFIRMED', intentId: expect.any(String) });
    const ledger = createWorkerDispatchLedger(store);
    expect(ledger.hasDispatched((receipt as { intentId: string }).intentId)).toBe(true);
    expect(store.budget('SEND').used).toBe(2);

    const abort = vi.spyOn(BrowserWorkerHost.prototype, 'abortInFlight');
    const execute = BrowserWorkerHost.prototype.executeSend;
    let stop: Promise<unknown> | undefined;
    const send = vi.spyOn(BrowserWorkerHost.prototype, 'executeSend').mockImplementationOnce(function (this: BrowserWorkerHost, request) {
      const outcome = execute.call(this, request);
      stop = service.dispatch(token, { command: 'emergencyStop' });
      void stop.catch(() => {});
      return outcome;
    });
    try {
      const commandId = randomUUID();
      await service.dispatch(token, { command: 'sendHumanFollowup', commandId,
        input: next('third isolated human reply', 2) });
      await service.drain();
      expect(send).toHaveBeenCalledTimes(1);
      expect(abort).toHaveBeenCalled();
      expect(stop).toBeDefined();
      await stop;
      const stopped = await service.dispatch(token, { command: 'getStatus' });
      expect(stopped).toMatchObject({ paused: true, automation: { emergencyStopped: true } });
    } finally {
      send.mockRestore();
      abort.mockRestore();
    }
  } finally {
    await activeService?.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the normal PlatformConnector and Core SendCoordinator submit through an isolated Worker', async () => {
  const root = await profileFixture();
  const db = join(root, 'fixture.sqlite');
  const store = new EventStore(db, true);
  const connector = createRuntimeConnector(root, store, 'synthetic');
  try {
    const eventId = pending(store);
    const event = store.event(eventId).payload;
    expect(createRuntimeConnector(root, store).constructor.name).toBe('DouyinPlatformConnector');
    await connector.open();
    await expect(OwnerLock.acquire(join(root, 'profile'))).rejects.toThrow('OWNER_LOCKED_OR_PORT_UNAVAILABLE');
    await expect(connector.observe(store, 'dm')).resolves.toEqual({ newEventIds: [] });
    const draft = store.saveDraft(eventId, 'Worker-bound reply', 'fixture');
    const { adapter, dispose } = await connector.adapter(event);
    try {
      store.approve(draft.id, await adapter.inspect(event), draft.version, draft.text);
      const coordinator = new SendCoordinator(store, connector.actor, connector.accountId);
      await expect(coordinator.send(draft.id, adapter, false)).resolves.toBe('CONFIRMED');
      const intentId = store.db.prepare('SELECT id FROM send_intents WHERE event_id=?').pluck().get(eventId) as string;
      expect(store.receiptForEvent(eventId)).toMatchObject({ result: 'CONFIRMED' });
      expect(createWorkerDispatchLedger(store).hasDispatched(intentId)).toBe(true);
      const reopened = new EventStore(db);
      try { expect(createWorkerDispatchLedger(reopened).hasDispatched(intentId)).toBe(true); }
      finally { reopened.close(); }
    } finally { await dispose(); }
  } finally {
    await connector.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
