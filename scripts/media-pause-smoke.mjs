import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mediaFixtureServer } from '../tests/fixtures/media-site.ts';

const source = process.argv[2] === 'source';
const { installMediaPauseGuard, releaseMediaPauseDocument } = await import(source
  ? '../src/browser/media-pause.ts' : '../dist/browser/media-pause.js');
const fixture = await mediaFixtureServer();
const browser = await chromium.launch({ channel: 'msedge', headless: true,
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
try {
  const baseline = await browser.newPage(), guarded = await browser.newPage();
  baseline.setDefaultTimeout(5000); guarded.setDefaultTimeout(5000);
  await installMediaPauseGuard(guarded, fixture.origin, true);
  await baseline.goto(fixture.origin); await guarded.goto(fixture.origin);
  await baseline.waitForFunction(() => !document.querySelector('#initial').paused);
  await guarded.waitForFunction(() => document.querySelector('#initial').paused);
  assert.equal(await guarded.locator('#human-draft').inputValue(), 'unsaved human draft');
  await guarded.reload();
  assert.equal(await guarded.locator('#initial').evaluate(media => media.paused), true);
  await guarded.evaluate(releaseMediaPauseDocument);
  await guarded.locator('#initial').evaluate(media => media.play());
  assert.equal(await guarded.locator('#initial').evaluate(media => media.paused), false);
  console.log(JSON.stringify({ mediaPauseSmoke: 'PASS', runtime: source ? 'tsx' : 'compiled',
    realPlaybackBaseline: true, paused: true, releaseRestoredPlayback: true, realSends: 0, modelCalls: 0 }));
} finally { await browser.close(); await fixture.close(); }
