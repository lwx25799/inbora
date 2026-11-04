import type { SiteMapping, Field, EventFields } from '../config/site-mapping.js';
import type { Channel, InboundEvent } from '../core/contracts.js';

export interface CaptureInput { mapping: SiteMapping; channel: Channel; event: InboundEvent; text: string | null; token: string | null }
export interface CaptureResult { context: unknown[]; ownId: string; targetKey: string }

/** Runs entirely inside the page. No async gap between the native click capture and validation. */
export function captureAndGuard(input: CaptureInput): CaptureResult {
  const { mapping: m, channel, event: expected, text, token } = input;
  type Gate = { token: string; enabled: boolean; used: boolean; blocked: boolean; remove: () => void; submit:()=>boolean };
  const host = window as unknown as { __inboraGate?: Gate };
  const key = channel === 'DIRECT_MESSAGE' ? `dm:${expected.conversationId}` : `comment:${expected.videoId}:${expected.commentId}`;
  const t = m.targets[channel];
  // Object methods keep this serialized function self-contained under both tsc and tsx/esbuild.
  const dom = {
    check(ok: unknown): void { if (!ok) throw new Error('CLICK_DOM_GUARD_BLOCKED'); },
    visible(el: Element): boolean {
      const style = getComputedStyle(el); return el.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    },
    one(root: Document | Element, selector: string): Element {
      const elements = root.querySelectorAll(selector); dom.check(elements.length === 1 && dom.visible(elements[0]!)); return elements[0]!;
    },
    read(root: Document | Element, spec: Field | null): string | null {
      if (!spec) return null;
      const element = spec.selector ? dom.one(root,spec.selector) : root;
      if (!(element instanceof Element)) throw new Error('CLICK_DOM_GUARD_BLOCKED');
      const raw = spec.attribute ? element.getAttribute(spec.attribute) : element.textContent;
      if (!raw) return null;
      if (spec.extract) {
        const regex = new RegExp(spec.extract.pattern,'u'); dom.check(regex.test(raw)); return raw.replace(regex,spec.extract.replacement).trim() || null;
      }
      return raw.trim() || null;
    },
    parse(root: Element, fields: EventFields): InboundEvent {
      const r: Record<string,string|null> = {};
      for (const [name,spec] of Object.entries(fields)) r[name] = dom.read(root,spec);
      return {...r,accountId:'account_001',channel,direction:m.directionValues[r.direction ?? ''] ?? 'UNKNOWN',
        kind:m.kindValues[r.kind ?? ''] ?? 'UNKNOWN'} as unknown as InboundEvent;
    },
    binding(e: InboundEvent): unknown[] {
      return [e.accountId,e.channel,e.platformEventId,e.actorId,e.text,e.occurredAt,e.videoId,e.commentId,e.conversationId,e.direction,e.kind];
    },
    capture(): CaptureResult {
      dom.check(location.origin === m.origin);
      for (const selector of [m.guards.loginRequired,m.guards.challenge,m.guards.stopped])
        dom.check(!Array.from(document.querySelectorAll(selector)).some(dom.visible));
      dom.one(document,m.guards.loggedIn); dom.check(dom.read(document,m.guards.ownIdentity) === m.ownId);
      const originals = Array.from(document.querySelectorAll(t.roots)).filter(root => dom.visible(root) &&
        JSON.stringify(dom.binding(dom.parse(root,t.fields))) === JSON.stringify(dom.binding(expected)));
      dom.check(originals.length === 1);
      const composer = dom.one(document,t.composer); dom.check(dom.read(composer,t.composerTarget) === key);
      if (text !== null) dom.check((composer instanceof HTMLInputElement || composer instanceof HTMLTextAreaElement ? composer.value : composer.textContent) === text);
      const context: unknown[] = []; let scope: Element = originals[0]!;
      if (channel === 'DIRECT_MESSAGE') {
        scope = dom.one(document,m.dm.pane);
        const activeRow = dom.one(dom.one(document,m.dm.list),m.dm.activeRow);
        dom.check(dom.read(activeRow,m.dm.conversationId) === expected.conversationId && dom.read(activeRow,m.dm.peerId) === expected.actorId);
        dom.check(dom.read(scope,m.dm.activeId) === expected.conversationId && dom.read(scope,m.dm.activePeerId) === expected.actorId);
        for (const row of scope.querySelectorAll(m.dm.messages)) if (dom.visible(row)) context.push(dom.binding(dom.parse(row,m.dm.fields)));
      } else context.push(dom.binding(expected));
      const ids = new Set<string>();
      for (const row of scope.querySelectorAll(t.outgoingRows)) if (dom.visible(row)) {
        const id = dom.read(row,t.proof.id); dom.check(id && !ids.has(id)); ids.add(id!);
        context.push([id,dom.read(row,t.proof.ownId),dom.read(row,t.proof.targetKey),dom.read(row,t.proof.text),dom.read(row,t.proof.pending),dom.read(row,t.proof.sentAt)]);
      }
      return {context,ownId:m.ownId,targetKey:key};
    },
  };
  const state = dom.capture();
  if (token) {
    host.__inboraGate?.remove();
    const button = dom.one(document,t.send); const baseline = JSON.stringify(state);
    const gate = {
      token,enabled:false,used:false,blocked:false,
      handle(event: Event): void {
        const path = event.composedPath(); const current = Array.from(document.querySelectorAll(t.send));
        if (!path.includes(button) && !current.some(el => path.includes(el))) return;
        try {
          dom.check(gate.enabled && !gate.blocked && !gate.used && current.length === 1 && current[0] === button);
          dom.check(JSON.stringify(dom.capture()) === baseline);
          if (event.type === 'click' && event.currentTarget === button) gate.used = true;
        } catch { gate.blocked = true; event.preventDefault(); event.stopImmediatePropagation(); }
      },
      submit(): boolean {
        dom.check(!gate.used && !gate.blocked && dom.one(document,t.send) === button);
        dom.check(JSON.stringify(dom.capture()) === baseline);
        // Re-arm after all earlier page tasks, then check and DOM-click in this same JS task.
        // No synthetic pointerover/pointerdown sequence can attach a later click handler in between.
        button.removeEventListener('click',gate.handle,true);button.addEventListener('click',gate.handle,true);
        gate.enabled=true;
        (button as HTMLElement).click();
        gate.enabled=false;return gate.used&&!gate.blocked;
      },
      remove(): void {
        window.removeEventListener('pointerdown',gate.handle,true); window.removeEventListener('click',gate.handle,true);
        button.removeEventListener('click',gate.handle,true);
      },
    };
    window.addEventListener('pointerdown',gate.handle,true); window.addEventListener('click',gate.handle,true);
    button.addEventListener('click',gate.handle,true);
    host.__inboraGate = gate;
  }
  return state;
}
