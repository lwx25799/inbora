import {hasVisibleSecurityComponent} from './security-components.js';
import { randomUUID } from 'node:crypto';
import type { Locator, Page } from 'playwright';
import { z } from 'zod';
import type { Field, SiteMapping, EventFields } from '../config/site-mapping.js';
import { DEFAULT_ACCOUNT_ID, type AccountId } from '../contracts/account.js';
import { digest, eventBinding, eventSchema, isStrong, requireSafe, targetKey,
  type Channel, type InboundEvent, type ReplyAdapter, type SendProof, type TargetSnapshot } from '../core/contracts.js';
import { captureAndGuard, releaseMappedPreparation, type NavigationInput } from './click-guard.js';

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
  private preparation:{token:string;binding:string;text:string}|null=null;
  constructor(readonly page: Page, readonly channel: Channel, readonly mapping: SiteMapping,
    private readonly receiptTimeoutMs = 5000, readonly accountId: AccountId = DEFAULT_ACCOUNT_ID) {}
  async guard(): Promise<void> {
    requireSafe(new URL(this.page.url()).origin === this.mapping.origin, 'UNEXPECTED_ORIGIN');
    for (const [code, selector] of [
      ['PLATFORM_STOP', this.mapping.guards.stopped], ['CHALLENGE_REQUIRED', this.mapping.guards.challenge],
      ['LOGIN_REQUIRED', this.mapping.guards.loginRequired],
    ] as const) requireSafe(!await this.page.evaluate(hasVisibleSecurityComponent,[selector]), code);
    await unique(this.page, this.mapping.guards.loggedIn);
    requireSafe(await field(this.page, this.mapping.guards.ownIdentity) === this.mapping.ownId, 'ACCOUNT_NOT_VERIFIED');
  }
  private async navigate(navigation:NavigationInput['navigation']):Promise<void>{
    await this.page.evaluate(captureAndGuard,{mapping:this.mapping,channel:this.channel,accountId:this.accountId,navigation});
  }
  private async parse(root: Locator, fields: EventFields, evidenceId: string): Promise<InboundEvent> {
    const raw: Record<string, string | null> = {};
    for (const [key, spec] of Object.entries(fields)) raw[key] = await field(root, spec);
    return eventSchema.parse({ ...raw, accountId: this.accountId, channel: this.channel, evidenceId,
      direction: this.mapping.directionValues[raw.direction ?? ''] ?? 'UNKNOWN',
      kind: this.mapping.kindValues[raw.kind ?? ''] ?? 'UNKNOWN' });
  }
  async openNotifications(): Promise<void> {
    await this.guard();
    if (!await visibleAny(this.page, this.mapping.notification.panel))
      await this.navigate({selector:this.mapping.notification.entry});
    await this.page.locator(this.mapping.notification.panel).waitFor({ state: 'visible' });
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
      await this.navigate({selector:this.mapping.dm.entry});
    await this.page.locator(this.mapping.dm.list).waitFor({ state: 'visible' });
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
    const activeRows = (await unique(this.page,this.mapping.dm.list)).locator(this.mapping.dm.activeRow);
    const activeRowMatches = await activeRows.count() === 1 && await activeRows.isVisible() &&
      await field(activeRows,this.mapping.dm.conversationId) === id && await field(activeRows,this.mapping.dm.peerId) === peerId;
    const panes = this.page.locator(this.mapping.dm.pane);
    const activePane = await panes.count() === 1 && await panes.isVisible() ? panes : null;
    if (activeRowMatches && activePane && await field(activePane, this.mapping.dm.activeId) === id &&
      await field(activePane, this.mapping.dm.activePeerId) === peerId) return;
    await this.navigate({scope:this.mapping.dm.list,rows:this.mapping.dm.rows,selector:this.mapping.dm.select,match:{id,peerId}});
    // A composer can appear before the new conversation has finished loading.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await this.guard();
      const pane = this.page.locator(this.mapping.dm.pane);
      requireSafe(await pane.count() <= 1, 'CONVERSATION_PANE_AMBIGUOUS');
      if (await pane.count() === 1 && await pane.isVisible() && await field(pane, this.mapping.dm.activeId) === id &&
        await field(pane, this.mapping.dm.activePeerId) === peerId && await activeRows.count() === 1 &&
        await field(activeRows,this.mapping.dm.conversationId) === id && await field(activeRows,this.mapping.dm.peerId) === peerId) return;
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
    const {panel,rows,jump}=this.mapping.notification;
    requireSafe(jump,'NOTIFICATION_TARGET_UNRESOLVED');
    await this.navigate({scope:panel,rows,selector:jump,match:{event:e,fields:this.mapping.notification.fields}});
    await this.page.locator(t.roots).filter({visible:true}).first().waitFor({ state: 'visible' });
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
    requireSafe(e.accountId === this.accountId, 'ACCOUNT_CHANGED');
    requireSafe(e.channel === this.channel && isStrong(e), 'WEAK_TARGET');
    await this.guard();
    if (this.channel === 'DIRECT_MESSAGE') await this.selectConversation(e.conversationId!, e.actorId!);
    else await this.locateComment(e);
    const t = this.mapping.targets[this.channel];
    if(t.openReply&&!await visibleAny(this.page,t.composer))await this.navigate({rows:t.roots,selector:t.openReply,match:{event:e,fields:t.fields}});
    return this.snapshot(e);
  }
  private async snapshot(e: InboundEvent, text: string | null = null, token: string | null = null): Promise<TargetSnapshot> {
    requireSafe(e.accountId===this.accountId,'ACCOUNT_CHANGED');
    const state = await this.page.evaluate(captureAndGuard, { mapping:this.mapping,channel:this.channel,accountId:this.accountId,event:e,text,token });
    requireSafe(state,'CLICK_DOM_GUARD_BLOCKED');
    return { accountId: e.accountId, ownId: this.mapping.ownId, targetKey: targetKey(e),
      eventBinding: eventBinding(e), contextDigest: digest(state.context), composerKey: targetKey(e), mappingDigest: digest(this.mapping) };
  }
  async prepare(e: InboundEvent, text: string): Promise<void> {
    requireSafe(e.accountId===this.accountId,'ACCOUNT_CHANGED');
    requireSafe(!this.preparation,'MAPPED_EDITOR_ALREADY_PREPARED');
    const token=randomUUID();
    this.preparation={token,binding:eventBinding(e),text};
    try{
      const state=await this.page.evaluate(captureAndGuard,{mapping:this.mapping,channel:this.channel,
        accountId:this.accountId,event:e,text:null,token:null,prepare:text,preparationToken:token});
      requireSafe(state&&!state.existingDraft,'NATIVE_REPLY_EXISTING_DRAFT');
    }catch(error){await this.dispose();throw error;}
  }
  async verifyPrepared(e:InboundEvent,text:string):Promise<TargetSnapshot>{
    const preparation=this.preparation;
    requireSafe(preparation?.binding===eventBinding(e)&&preparation.text===text,'SEND_NOT_PREPARED');
    return this.snapshot(e,text,preparation.token);
  }
  async cancelPreparation(e:InboundEvent,text:string):Promise<void>{
    if(this.preparation?.binding===eventBinding(e)&&this.preparation.text===text)await this.dispose();
  }
  async dispose():Promise<void>{
    const preparation=this.preparation;this.preparation=null;
    if(preparation)await this.page.evaluate(releaseMappedPreparation,{token:preparation.token,discard:true}).catch(()=>{});
  }
  private async proofs(e: InboundEvent): Promise<SendProof[]> {
    const t = this.mapping.targets[this.channel]; const result: SendProof[] = [];
    // Outgoing rows are scoped to the exact original comment or exact DM pane.
    const scope = this.channel === 'DIRECT_MESSAGE' ? await unique(this.page, this.mapping.dm.pane) : (await this.matchingRoot(e))!;
    for (const row of await scope.locator(t.outgoingRows).all()) if (await row.isVisible()) {
      const id = await field(row, t.proof.id); const ownId = await field(row, t.proof.ownId);
      const key = await field(row, t.proof.targetKey); const text = await field(row, t.proof.text);
      const pending = await field(row, t.proof.pending);
      const sentAt = await field(row,t.proof.sentAt);
      requireSafe(id && ownId && key && text && pending !== null && sentAt, 'PROOF_FIELDS_MISSING');
      requireSafe(z.iso.datetime({offset:true}).safeParse(sentAt).success,'PROOF_TIME_UNVERIFIABLE');
      result.push({ id, ownId, targetKey: key, text, pending: pending !== 'confirmed', sentAt });
    }
    requireSafe(new Set(result.map(p => p.id)).size === result.length, 'PROOF_ID_COLLISION');
    return result;
  }
  async baseline(e: InboundEvent): Promise<string[]> {
    await this.snapshot(e); return (await this.proofs(e)).map(p => p.id);
  }
  async clickOnce(_notBefore?:string,check?:()=>void):Promise<void>{
    const preparation=this.preparation;
    requireSafe(preparation,'SEND_NOT_PREPARED');
    this.preparation=null;
    try{
      check?.();
      const accepted=await this.page.evaluate(token=>{
        const host=window as unknown as {__inboraGate?:{token:string;submit:()=>boolean;remove:()=>void};__inboraPreparation?:{token:string;release:(discard:boolean)=>void}};
        const gate=host.__inboraGate;
        if(gate?.token!==token)throw new Error('CLICK_GUARD_NOT_ARMED');
        try{return gate.submit();}finally{
          gate.remove();if(host.__inboraGate===gate)delete host.__inboraGate;
          if(host.__inboraPreparation?.token===token){host.__inboraPreparation.release(false);delete host.__inboraPreparation;}
        }
      },preparation.token);
      requireSafe(accepted,'CLICK_GUARD_BLOCKED');
    }catch(error){
      await this.page.evaluate(releaseMappedPreparation,{token:preparation.token,discard:false}).catch(()=>{});
      throw error;
    }
  }
  async readback(e: InboundEvent, text: string, before: string[], notBefore: string): Promise<SendProof | null> {
    const deadline = Date.now() + this.receiptTimeoutMs;
    do {
      await this.snapshot(e);
      const proofs = (await this.proofs(e)).filter(p => !before.includes(p.id) && p.ownId === this.mapping.ownId &&
        p.targetKey === targetKey(e) && p.text === text && !p.pending && Date.parse(p.sentAt) > Date.parse(notBefore) && Date.parse(p.sentAt) <= Date.now());
      requireSafe(proofs.length <= 1, 'MULTIPLE_MATCHING_RECEIPTS');
      if (proofs[0]) return proofs[0];
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    return null;
  }
}
