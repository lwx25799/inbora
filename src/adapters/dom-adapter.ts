import { randomUUID } from 'node:crypto';
import type { Locator, Page } from 'playwright';
import type { Field, SiteMapping, EventFields } from '../config/site-mapping.js';
import { digest, eventBinding, eventSchema, isStrong, requireSafe, targetKey,
  type Channel, type InboundEvent, type ReplyAdapter, type SendProof, type TargetSnapshot } from '../core/contracts.js';

type Root = Page | Locator;
export async function unique(root: Root, selector: string): Promise<Locator> {
  const found = root.locator(selector);
  requireSafe(await found.count() === 1 && await found.isVisible(), 'DOM_NOT_UNIQUE_OR_VISIBLE');
  return found;
}
export async function field(root: Root, spec: Field | null): Promise<string | null> {
  if (!spec) return null;
  const element = spec.selector ? await unique(root, spec.selector) : root;
  requireSafe('elementHandle' in element, 'FIELD_REQUIRES_ELEMENT');
  const result = spec.attribute ? await element.getAttribute(spec.attribute) : await element.textContent();
  if (!result) return null;
  if (spec.extract) {
    const pattern = new RegExp(spec.extract.pattern, 'u');
    requireSafe(pattern.test(result), 'OBSERVED_FIELD_FORMAT_CHANGED');
    return result.replace(pattern, spec.extract.replacement).trim() || null;
  }
  return result.trim() || null;
}
async function visibleAny(page: Page, selector: string): Promise<boolean> {
  for (const element of await page.locator(selector).all()) if (await element.isVisible()) return true;
  return false;
}
export class DomAdapter implements ReplyAdapter {
  private sendButton: Locator | null = null;
  constructor(readonly page: Page, readonly channel: Channel, readonly mapping: SiteMapping,
    private readonly receiptTimeoutMs = 5000) {}
  async guard(): Promise<void> {
    requireSafe(new URL(this.page.url()).origin === this.mapping.origin, 'UNEXPECTED_ORIGIN');
    for (const [code, selector] of [
      ['PLATFORM_STOP', this.mapping.guards.stopped], ['CHALLENGE_REQUIRED', this.mapping.guards.challenge],
      ['LOGIN_REQUIRED', this.mapping.guards.loginRequired],
    ] as const) requireSafe(!await visibleAny(this.page, selector), code);
    await unique(this.page, this.mapping.guards.loggedIn);
    requireSafe(await field(this.page, this.mapping.guards.ownIdentity) === this.mapping.ownId, 'ACCOUNT_NOT_VERIFIED');
  }
  private async parse(root: Locator, fields: EventFields, evidenceId: string): Promise<InboundEvent> {
    const raw: Record<string, string | null> = {};
    for (const [key, spec] of Object.entries(fields)) raw[key] = await field(root, spec);
    return eventSchema.parse({ ...raw, accountId: 'account_001', channel: this.channel, evidenceId,
      direction: this.mapping.directionValues[raw.direction ?? ''] ?? 'UNKNOWN',
      kind: this.mapping.kindValues[raw.kind ?? ''] ?? 'UNKNOWN' });
  }
  async openNotifications(): Promise<void> {
    await this.guard();
    if (!await visibleAny(this.page, this.mapping.notification.panel))
      await (await unique(this.page, this.mapping.notification.entry)).click();
    await unique(this.page, this.mapping.notification.panel); await this.guard();
  }
  async observeNotifications(): Promise<{ events: InboundEvent[]; evidenceId: string; loaded: number }> {
    requireSafe(this.channel === 'COMMENT_NOTIFICATION', 'WRONG_CHANNEL');
    await this.openNotifications();
    const evidenceId = randomUUID(); const events: InboundEvent[] = [];
    const panel = await unique(this.page, this.mapping.notification.panel);
    const rows = panel.locator(this.mapping.notification.rows);
    for (const row of await rows.all()) if (await row.isVisible()) events.push(await this.parse(row, this.mapping.notification.fields, evidenceId));
    await this.guard(); return { events, evidenceId, loaded: events.length };
  }
  async openDm(): Promise<void> {
    await this.guard();
    if (!await visibleAny(this.page, this.mapping.dm.list))
      await (await unique(this.page, this.mapping.dm.entry)).click();
    await unique(this.page, this.mapping.dm.list); await this.guard();
  }
  async conversations(): Promise<{ id: string; peerId: string }[]> {
    await this.openDm(); const found: { id: string; peerId: string }[] = [];
    const list = await unique(this.page, this.mapping.dm.list);
    for (const row of await list.locator(this.mapping.dm.rows).all()) {
      if (!await row.isVisible()) continue;
      const id = await field(row, this.mapping.dm.conversationId); const peerId = await field(row, this.mapping.dm.peerId);
      requireSafe(id && peerId && !found.some(x => x.id === id), 'CONVERSATION_ID_AMBIGUOUS'); found.push({ id, peerId });
    }
    return found;
  }
  private async selectConversation(id: string, peerId: string): Promise<void> {
    await this.openDm();
    const activePane = await unique(this.page, this.mapping.dm.pane);
    if (await field(activePane, this.mapping.dm.activeId) === id &&
      await field(activePane, this.mapping.dm.activePeerId) === peerId) return;
    const list = await unique(this.page, this.mapping.dm.list); const matches: Locator[] = [];
    for (const row of await list.locator(this.mapping.dm.rows).all()) {
      if (await row.isVisible() && await field(row, this.mapping.dm.conversationId) === id &&
        await field(row, this.mapping.dm.peerId) === peerId) matches.push(row);
    }
    requireSafe(matches.length === 1, 'CONVERSATION_NOT_UNIQUE');
    await (await unique(matches[0]!, this.mapping.dm.select)).click();
    // A composer can appear before the new conversation has finished loading.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await this.guard();
      const pane = await unique(this.page, this.mapping.dm.pane);
      if (await field(pane, this.mapping.dm.activeId) === id && await field(pane, this.mapping.dm.activePeerId) === peerId) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    requireSafe(false, 'CONVERSATION_SWITCH_UNVERIFIED');
  }
  async observeDm(id: string, peerId: string): Promise<{ events: InboundEvent[]; evidenceId: string }> {
    requireSafe(this.channel === 'DIRECT_MESSAGE', 'WRONG_CHANNEL');
    await this.selectConversation(id, peerId);
    const pane = await unique(this.page, this.mapping.dm.pane); const evidenceId = randomUUID(); const events: InboundEvent[] = [];
    for (const row of await pane.locator(this.mapping.dm.messages).all()) if (await row.isVisible()) {
      const event = await this.parse(row, this.mapping.dm.fields, evidenceId);
      requireSafe(event.conversationId === id && (event.direction !== 'INCOMING' || event.actorId === peerId), 'MESSAGE_IDENTITY_CONFLICT');
      events.push(event);
    }
    await this.guard(); return { events, evidenceId };
  }
  private async locateComment(e: InboundEvent): Promise<void> {
    const t = this.mapping.targets.COMMENT_NOTIFICATION;
    if (await this.matchingRoot(e, false)) return;
    await this.openNotifications();
    const panel = await unique(this.page, this.mapping.notification.panel); const matches: Locator[] = [];
    for (const row of await panel.locator(this.mapping.notification.rows).all()) {
      if (await row.isVisible() && eventBinding(await this.parse(row, this.mapping.notification.fields, e.evidenceId)) === eventBinding(e)) matches.push(row);
    }
    requireSafe(matches.length === 1 && this.mapping.notification.jump, 'NOTIFICATION_TARGET_UNRESOLVED');
    const jump = await unique(matches[0]!, this.mapping.notification.jump);
    const href = await jump.getAttribute('href');
    if (href) requireSafe(new URL(href, this.page.url()).origin === this.mapping.origin, 'UNSAFE_COMMENT_LINK');
    await jump.click();
    await this.page.locator(t.roots).first().waitFor({ state: 'visible' });
    await this.guard();
  }
  private async matchingRoot(e: InboundEvent, required = true): Promise<Locator | null> {
    const t = this.mapping.targets[this.channel]; const matches: Locator[] = [];
    for (const root of await this.page.locator(t.roots).all()) {
      if (!await root.isVisible()) continue;
      if (eventBinding(await this.parse(root, t.fields, e.evidenceId)) === eventBinding(e)) matches.push(root);
    }
    requireSafe(matches.length <= 1, 'TARGET_AMBIGUOUS');
    if (required) requireSafe(matches.length === 1, 'ORIGINAL_EVENT_CHANGED_OR_MISSING');
    return matches[0] ?? null;
  }
  async inspect(e: InboundEvent): Promise<TargetSnapshot> {
    this.sendButton = null;
    requireSafe(e.channel === this.channel && isStrong(e), 'WEAK_TARGET');
    await this.guard();
    if (this.channel === 'DIRECT_MESSAGE') await this.selectConversation(e.conversationId!, e.actorId!);
    else await this.locateComment(e);
    const root = (await this.matchingRoot(e))!; const t = this.mapping.targets[this.channel];
    if (t.openReply && !await visibleAny(this.page, t.composer)) await (await unique(root, t.openReply)).click();
    return this.snapshot(e);
  }
  private async snapshot(e: InboundEvent): Promise<TargetSnapshot> {
    await this.guard(); await this.matchingRoot(e);
    const t = this.mapping.targets[this.channel]; const composer = await unique(this.page, t.composer);
    requireSafe(await field(composer, t.composerTarget) === targetKey(e), 'COMPOSER_OWNERSHIP_UNVERIFIED');
    const context: string[] = [];
    if (this.channel === 'DIRECT_MESSAGE') {
      const pane = await unique(this.page, this.mapping.dm.pane);
      requireSafe(await field(pane, this.mapping.dm.activeId) === e.conversationId &&
        await field(pane, this.mapping.dm.activePeerId) === e.actorId, 'CONVERSATION_IDENTITY_CHANGED');
      for (const row of await pane.locator(this.mapping.dm.messages).all()) if (await row.isVisible()) {
        const message = await this.parse(row, this.mapping.dm.fields, e.evidenceId);
        if (message.direction === 'INCOMING') context.push(eventBinding(message));
      }
    } else context.push(eventBinding(e));
    return { accountId: e.accountId, ownId: this.mapping.ownId, targetKey: targetKey(e),
      eventBinding: eventBinding(e), contextDigest: digest(context), composerKey: targetKey(e), mappingDigest: digest(this.mapping) };
  }
  async prepare(e: InboundEvent, text: string): Promise<void> {
    await this.snapshot(e);
    await (await unique(this.page, this.mapping.targets[this.channel].composer)).fill(text);
  }
  async verifyPrepared(e: InboundEvent, text: string): Promise<TargetSnapshot> {
    const snapshot = await this.snapshot(e); const t = this.mapping.targets[this.channel];
    const composer = await unique(this.page, t.composer);
    const actual = await composer.evaluate(el => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el.textContent);
    requireSafe(actual === text, 'APPROVED_TEXT_CHANGED');
    this.sendButton = await unique(this.page, t.send);
    requireSafe(await this.sendButton.isEnabled(), 'SEND_BUTTON_DISABLED'); return snapshot;
  }
  private async proofs(e: InboundEvent): Promise<SendProof[]> {
    const t = this.mapping.targets[this.channel]; const result: SendProof[] = [];
    // Outgoing rows are scoped to the exact original comment or exact DM pane.
    const scope = this.channel === 'DIRECT_MESSAGE' ? await unique(this.page, this.mapping.dm.pane) : (await this.matchingRoot(e))!;
    for (const row of await scope.locator(t.outgoingRows).all()) if (await row.isVisible()) {
      const id = await field(row, t.proof.id); const ownId = await field(row, t.proof.ownId);
      const key = await field(row, t.proof.targetKey); const text = await field(row, t.proof.text);
      const pending = await field(row, t.proof.pending);
      requireSafe(id && ownId && key && text && pending !== null, 'PROOF_FIELDS_MISSING');
      result.push({ id, ownId, targetKey: key, text, pending: pending !== 'confirmed' });
    }
    requireSafe(new Set(result.map(p => p.id)).size === result.length, 'PROOF_ID_COLLISION');
    return result;
  }
  async baseline(e: InboundEvent): Promise<string[]> {
    await this.snapshot(e); return (await this.proofs(e)).map(p => p.id);
  }
  async clickOnce(): Promise<void> {
    requireSafe(this.sendButton, 'SEND_NOT_PREPARED');
    const button = this.sendButton; this.sendButton = null;
    await button.click({ timeout: 3000 });
  }
  async readback(e: InboundEvent, text: string, before: string[]): Promise<SendProof | null> {
    const deadline = Date.now() + this.receiptTimeoutMs;
    do {
      await this.snapshot(e);
      const proofs = (await this.proofs(e)).filter(p => !before.includes(p.id) && p.ownId === this.mapping.ownId &&
        p.targetKey === targetKey(e) && p.text === text && !p.pending);
      requireSafe(proofs.length <= 1, 'MULTIPLE_MATCHING_RECEIPTS');
      if (proofs[0]) return proofs[0];
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    return null;
  }
}
