import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { installMediaPauseDocument, installMediaPauseGuard, releaseMediaPauseDocument } from '../../src/browser/media-pause.js';
import { mediaFixtureServer } from '../fixtures/media-site.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof mediaFixtureServer>>;
beforeAll(async () => {
  server = await mediaFixtureServer();
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
});
afterAll(async () => { await browser?.close(); await server?.close(); });

async function page(guard = true): Promise<Page> {
  const result = await browser.newPage();
  result.setDefaultTimeout(5000);
  if (guard) await installMediaPauseGuard(result, server.origin, true);
  await result.goto(server.origin);
  return result;
}

test('unguarded local media plays; initial autoplay and every later play are paused by the guard', async () => {
  const baseline = await page(false), guarded = await page();
  try {
    await baseline.waitForFunction(() => !(document.querySelector('audio') as HTMLAudioElement).paused);
    const before = await baseline.locator('#initial').evaluate(element => (element as HTMLAudioElement).currentTime);
    await baseline.waitForFunction(value => (document.querySelector('audio') as HTMLAudioElement).currentTime > value, before);
    await guarded.waitForFunction(() => (document.querySelector('audio') as HTMLAudioElement).paused);
    const outcomes = await guarded.locator('#initial').evaluate(async element => {
      const audio = element as HTMLAudioElement;
      const results: string[] = [];
      for (let index = 0; index < 5; index++) {
        try { await audio.play(); results.push('resolved'); } catch (error) { results.push((error as Error).name); }
      }
      return { results, paused: audio.paused };
    });
    expect(outcomes.paused).toBe(true);
    expect(outcomes.results).toHaveLength(5);
    expect(outcomes.results.every(result => result === 'AbortError' || result === 'resolved')).toBe(true);
    expect(await guarded.evaluate(() => Reflect.get(window, 'playFailures'))).toBe(0);
  } finally { await baseline.close(); await guarded.close(); }
});

test('added and replaced already-playing media pause without changing DOM, attributes, previews or human draft', async () => {
  const current = await page();
  try {
    const original = await current.locator('body').evaluate(body => body.innerHTML);
    await current.evaluate(async () => {
      const container = document.createElement('section'); container.id = 'dynamic';
      const audio = document.createElement('audio'); audio.id = 'later'; audio.loop = true; audio.src = '/silence.wav';
      container.append(audio); await audio.play(); document.body.append(container);
    });
    await current.waitForFunction(() => (document.querySelector('#later') as HTMLAudioElement).paused);
    await current.evaluate(async () => {
      const replacement = document.createElement('audio'); replacement.id = 'replacement'; replacement.src = '/silence.wav';
      await replacement.play(); document.querySelector('#dynamic')!.replaceChildren(replacement);
    });
    await current.waitForFunction(() => (document.querySelector('#replacement') as HTMLAudioElement).paused);
    await current.locator('#dynamic').evaluate(element => element.remove());
    expect(await current.locator('body').evaluate(body => body.innerHTML)).toBe(original);
    expect(await current.locator('#human-draft').inputValue()).toBe('unsaved human draft');
    expect(await current.locator('#preview').getAttribute('alt')).toBe('synthetic emoji preview');
  } finally { await current.close(); }
});

test('video stream playback stops while its source, attributes and native media functions remain unchanged', async () => {
  const baseline = await page(false), guarded = await page();
  try {
    const installVideo = async (current: Page) => current.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
      const stream = canvas.captureStream(10);
      const video = document.createElement('video'); video.id = 'stream'; video.muted = true; video.loop = true;
      video.preload = 'none'; video.srcObject = stream;
      const original = { source: video.srcObject, pause: video.pause, play: video.play, html: video.outerHTML };
      document.body.append(video); canvas.getContext('2d')!.fillRect(0, 0, 32, 32);
      try { await video.play(); } catch (error) { if ((error as Error).name !== 'AbortError') throw error; }
      return {
        paused: video.paused, sameSource: video.srcObject === original.source,
        samePause: video.pause === original.pause, samePlay: video.play === original.play,
        sameAttributes: video.outerHTML === original.html,
      };
    });
    expect(await installVideo(baseline)).toEqual({ paused: false, sameSource: true, samePause: true, samePlay: true, sameAttributes: true });
    expect(await installVideo(guarded)).toEqual({ paused: true, sameSource: true, samePause: true, samePlay: true, sameAttributes: true });
  } finally { await baseline.close(); await guarded.close(); }
});

test('removed media is collectable instead of retained in a guard node collection', async () => {
  const current = await page();
  try {
    await current.evaluate(() => {
      const media = document.createElement('audio'); document.body.append(media);
      Reflect.set(window, 'removedMedia', new WeakRef(media)); media.remove();
    });
    await current.requestGC();
    expect(await current.evaluate(() => Reflect.get(window, 'removedMedia').deref() === undefined)).toBe(true);
  } finally { await current.close(); }
});

test('paused empty and preload-none media never start resource selection when guards are installed repeatedly', async () => {
  const current = await page(false);
  try {
    const before = await current.locator('#empty,#unloaded').evaluateAll(elements => elements.map(element => {
      const audio = element as HTMLAudioElement;
      return { paused: audio.paused, networkState: audio.networkState, attributes: audio.outerHTML };
    }));
    const requests = server.mediaRequests();
    await current.evaluate(installMediaPauseDocument, { trustedOrigin: server.origin });
    await current.evaluate(installMediaPauseDocument, { trustedOrigin: server.origin });
    await current.evaluate(() => document.querySelector('#comments')!.append(document.createElement('span')));
    const after = await current.locator('#empty,#unloaded').evaluateAll(elements => elements.map(element => {
      const audio = element as HTMLAudioElement;
      return { paused: audio.paused, networkState: audio.networkState, attributes: audio.outerHTML };
    }));
    expect(after).toEqual(before); expect(server.mediaRequests()).toBe(requests);
    expect(after[0]?.networkState).toBe(0);
  } finally { await current.close(); }
});

test('pagehide suspends listeners and observer; pageshow restores once and explicit release restores normal playback', async () => {
  const current = await page();
  try {
    await current.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await current.locator('#initial').evaluate(element => (element as HTMLAudioElement).play());
    expect(await current.locator('#initial').evaluate(element => (element as HTMLAudioElement).paused)).toBe(false);
    await current.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    expect(await current.locator('#initial').evaluate(element => (element as HTMLAudioElement).paused)).toBe(true);
    await current.evaluate(releaseMediaPauseDocument);
    await current.evaluate(releaseMediaPauseDocument);
    await current.locator('#initial').evaluate(element => (element as HTMLAudioElement).play());
    await current.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    expect(await current.locator('#initial').evaluate(element => (element as HTMLAudioElement).paused)).toBe(false);
    expect(await current.evaluate(() => Reflect.has(document, Symbol.for('inbora.media-pause.v1')))).toBe(false);
    await current.evaluate(installMediaPauseDocument, { trustedOrigin: server.origin });
    expect(await current.locator('#initial').evaluate(element => (element as HTMLAudioElement).paused)).toBe(true);
  } finally { await current.close(); }
});

test('navigation reinstalls on trusted top-level documents and excludes every subframe and other origin', async () => {
  const current = await page(), foreign = await mediaFixtureServer();
  try {
    await current.reload();
    expect(await current.evaluate(() => Reflect.has(document, Symbol.for('inbora.media-pause.v1')))).toBe(true);
    await current.evaluate(origin => {
      const frame = document.createElement('iframe'); frame.src = origin; document.body.append(frame);
    }, server.origin);
    await current.waitForFunction(() => !!document.querySelector('iframe')?.contentDocument?.querySelector('#initial'));
    const subframe = current.frames().find(frame => frame.parentFrame());
    expect(await subframe?.evaluate(() => Reflect.has(document, Symbol.for('inbora.media-pause.v1')))).toBe(false);
    await subframe?.waitForFunction(() => !(document.querySelector('#initial') as HTMLAudioElement).paused);
    await current.goto(foreign.origin);
    expect(await current.evaluate(() => Reflect.has(document, Symbol.for('inbora.media-pause.v1')))).toBe(false);
    await current.waitForFunction(() => !(document.querySelector('#initial') as HTMLAudioElement).paused);
    await current.goBack();
    expect(await current.evaluate(() => Reflect.has(document, Symbol.for('inbora.media-pause.v1')))).toBe(true);
    expect(await current.locator('#initial').evaluate(element => (element as HTMLAudioElement).paused)).toBe(true);
  } finally { await current.close(); await foreign.close(); }
});

test('headed owner installs no init script and concurrent installs register one init script per Page', async () => {
  const current = await browser.newPage();
  const spy = vi.spyOn(current, 'addInitScript');
  try {
    await installMediaPauseGuard(current, server.origin, false); expect(spy).not.toHaveBeenCalled();
    await Promise.all([installMediaPauseGuard(current, server.origin, true), installMediaPauseGuard(current, server.origin, true)]);
    expect(spy).toHaveBeenCalledTimes(1);
    await current.goto(server.origin);
    expect(await current.evaluate(() => Reflect.has(document, Symbol.for('inbora.media-pause.v1')))).toBe(true);
  } finally { spy.mockRestore(); await current.close(); }
});
