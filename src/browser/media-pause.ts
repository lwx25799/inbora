import type { Page } from 'playwright';

// Adapted from LockyBee/dsh-douyin-agent browser-launcher.mjs:37-63,
// MIT, commit 7989640e340f0fd79e2de9874880d5197546e755. See UPSTREAM.md
// and third_party/LockyBee-dsh-douyin-agent-MIT.txt for the retained notice.
// This function is serialized by Playwright: keep all browser dependencies local.
export function installMediaPauseDocument({ trustedOrigin }: { trustedOrigin: string }): void {
  if (window.top !== window || location.origin !== trustedOrigin) return;
  const key = Symbol.for('inbora.media-pause.v1');
  if (Reflect.has(document, key)) return;
  const nativePause = HTMLMediaElement.prototype.pause;
  let active = false;
  let disposed = false;
  // Object methods avoid module-scope esbuild name helpers in the tsx source chain.
  const guard = {
    pause(candidate: unknown): void {
      if (!active || !(candidate instanceof HTMLMediaElement) || candidate.paused) return;
      try { nativePause.call(candidate); } catch { /* Media failure must not affect collection. */ }
    },
    inspect(node: Node): void {
      if (!node.isConnected) return;
      if (node instanceof HTMLMediaElement) guard.pause(node);
      if (node instanceof Element || node instanceof Document) {
        for (const media of node.querySelectorAll('audio,video')) guard.pause(media);
      }
    },
    played(event: Event): void { guard.pause(event.target); },
    suspend(): void {
      if (!active) return;
      active = false;
      observer.disconnect();
      document.removeEventListener('play', guard.played, true);
      document.removeEventListener('playing', guard.played, true);
    },
    resume(): void {
      if (disposed || active) return;
      active = true;
      document.addEventListener('play', guard.played, true);
      document.addEventListener('playing', guard.played, true);
      observer.observe(document, { childList: true, subtree: true });
      guard.inspect(document);
    },
    release(): void {
      if (disposed) return;
      disposed = true;
      guard.suspend();
      window.removeEventListener('pagehide', guard.suspend);
      window.removeEventListener('pageshow', guard.resume);
      Reflect.deleteProperty(document, key);
    },
  };
  const observer = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) guard.inspect(node);
  });
  Object.defineProperty(document, key, { configurable: true, value: guard });
  window.addEventListener('pagehide', guard.suspend);
  window.addEventListener('pageshow', guard.resume);
  guard.resume();
}

// Explicit release is useful when a Page is retained after its business use ends.
// Closing/navigating a Page destroys this Document and its listener/observer graph.
export function releaseMediaPauseDocument(): void {
  const state = Reflect.get(document, Symbol.for('inbora.media-pause.v1')) as { release?: () => void } | undefined;
  state?.release?.();
}

const installed = new WeakMap<Page, Map<string, Promise<void>>>();

export async function installMediaPauseGuard(page: Page, trustedEntryUrl: string, headless: boolean): Promise<void> {
  if (!headless) return;
  const trustedOrigin = new URL(trustedEntryUrl).origin;
  let origins = installed.get(page);
  if (!origins) { origins = new Map(); installed.set(page, origins); }
  const current = origins.get(trustedOrigin);
  if (current) return current;
  const pending = page.addInitScript(installMediaPauseDocument, { trustedOrigin }).then(() => {});
  origins.set(trustedOrigin, pending);
  try { await pending; } catch (error) { origins.delete(trustedOrigin); throw error; }
}
