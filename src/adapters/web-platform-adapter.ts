import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import type { WebPlatformReplyMapping } from '../config/web-platform-mapping.js';
import type { AccountId } from '../contracts/account.js';
import {
  Blocked,
  digest,
  eventBinding,
  isEligible,
  isStrong,
  requireSafe,
  targetKey,
  type InboundEvent,
  type SendProof,
  type TargetSnapshot,
} from '../core/contracts.js';
import type { PlatformReplyAdapter } from '../platform/platform-connector.js';
import {
  assertUniqueProof,
  buildAttrSelector,
  captureWebProofs,
  filterValidWebProofs,
} from './web-platform-readback.js';
import { captureWebError, evaluateWebGuard } from './web-platform-reader.js';

export class WebPlatformReplyAdapter implements PlatformReplyAdapter {
  private prepared: {
    binding: string;
    text: string;
    contextDigest: string;
    contextJson: string;
    token: string;
  } | null = null;
  private pendingCleanupToken: string | null = null;
  private disposed = false;
  private lastEvent: InboundEvent | null = null;

  constructor(
    readonly page: Page,
    readonly mapping: WebPlatformReplyMapping,
    readonly accountId: AccountId,
    private readonly receiptTimeoutMs = 5_000,
  ) {}

  async guard(): Promise<{ ownId: string }> {
    try {
      return await this.page.evaluate(evaluateWebGuard, {
        origin: this.mapping.origin,
        selfId: this.mapping.selfId,
        selfSelector: this.mapping.selectors.selfId,
        ...(this.mapping.selectors.selfIdAttribute
          ? { selfIdAttribute: this.mapping.selectors.selfIdAttribute }
          : {}),
        securityBlockers: this.mapping.selectors.securityBlockers,
        ...(this.mapping.selectors.loginRequired
          ? { loginRequired: this.mapping.selectors.loginRequired }
          : {}),
      });
    } catch (error) {
      return captureWebError(this.page, error);
    }
  }

  private assertTargetChannel(event: InboundEvent): void {
    requireSafe(!this.disposed, 'BROWSER_CLOSED');
    requireSafe(event.accountId === this.accountId, 'ACCOUNT_CHANGED');
    requireSafe(isEligible(event, this.mapping.selfId) && isStrong(event), 'NATIVE_REPLY_SCOPE_REQUIRED');
    if (event.channel === 'DIRECT_MESSAGE') {
      requireSafe(this.mapping.selectors.dm, 'PLATFORM_MAPPING_UNCALIBRATED');
    } else {
      requireSafe(this.mapping.selectors.comment, 'PLATFORM_MAPPING_UNCALIBRATED');
    }
  }

  private async ensureTargetOpen(event: InboundEvent, readOnly = false): Promise<void> {
    if (event.channel === 'DIRECT_MESSAGE') {
      const dm = this.mapping.selectors.dm!;
      if (dm.entry && !await this.page.locator(dm.pane).isVisible().catch(() => false)) {
        const listVisible = dm.list ? await this.page.locator(dm.list).isVisible().catch(() => false) : false;
        if (!listVisible) await this.page.locator(dm.entry).click();
      }
      if (dm.list && dm.conversationRows) {
        const pane = this.page.locator(dm.pane);
        const activeAttr = dm.activeConversationIdAttribute ?? 'data-conversation-id';
        const activeHolder = dm.activeConversationId
          ? pane.locator(dm.activeConversationId)
          : pane;
        const activeId = await activeHolder.first().getAttribute(activeAttr).catch(() => null);
        if (activeId?.trim() !== event.conversationId) {
          if (!readOnly) {
            const hasDraft = await this.page.evaluate(arg => {
              const paneEl = document.querySelector(arg.pane);
              if (!paneEl) return false;
              const host = window as unknown as {
                __inboraWebPreparation?: { token?: string; editor?: Element; text?: string };
              };
              const prep = host.__inboraWebPreparation;
              for (const editor of Array.from(paneEl.querySelectorAll(arg.composer))) {
                const text = editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement
                  ? editor.value
                  : editor instanceof HTMLElement && editor.isContentEditable
                    ? (editor.textContent ?? '').replace(/[\u200B\uFEFF]/gu, '')
                    : '';
                if (!text) continue;
                if (prep && prep.editor === editor && prep.token === arg.preparedToken && text === prep.text) {
                  continue;
                }
                return true;
              }
              return false;
            }, {
              pane: dm.pane,
              composer: dm.composer,
              preparedToken: this.prepared?.token ?? null,
            }).catch(() => false);
            requireSafe(!hasDraft, 'NATIVE_REPLY_EXISTING_DRAFT');
          }
          const convAttr = dm.conversationIdAttribute ?? 'data-conversation-id';
          const row = this.page.locator(dm.list).locator(
            buildAttrSelector(dm.conversationRows, convAttr, event.conversationId!),
          );
          requireSafe(await row.count() === 1, 'NATIVE_REPLY_CONVERSATION_CHANGED');
          await (dm.selectAction ? row.locator(dm.selectAction) : row).click();
          const targetMsgSelector = buildAttrSelector(
            dm.messages,
            dm.messageIdAttribute ?? 'data-message-id',
            event.platformEventId!,
          );
          await this.page.waitForFunction(arg => {
            const panes = Array.from(document.querySelectorAll(arg.pane));
            if (panes.length !== 1) return false;
            const paneEl = panes[0]!;
            const holders = arg.activeConversationId
              ? Array.from(paneEl.querySelectorAll(arg.activeConversationId))
              : [paneEl];
            if (holders.length !== 1) return false;
            const convId = holders[0]!.getAttribute(arg.activeAttr)?.trim()
              || (arg.activeConversationId ? holders[0]!.textContent?.trim() ?? '' : '');
            if (convId !== arg.expectedConvId) return false;
            return Boolean(paneEl.querySelector(arg.targetMsgSelector));
          }, {
            pane: dm.pane,
            activeConversationId: dm.activeConversationId ?? null,
            activeAttr,
            expectedConvId: event.conversationId!,
            targetMsgSelector,
          }, { timeout: 2_000 }).catch(() => {});
        }
      }
      await this.page.locator(dm.pane).waitFor({ state: 'visible' });
      return;
    }

    const comment = this.mapping.selectors.comment!;
    if (comment.entry && !await this.page.locator(comment.list).isVisible().catch(() => false)) {
      await this.page.locator(comment.entry).click();
    }
    await this.page.locator(comment.list).waitFor({ state: 'visible' });
    if (!readOnly && comment.openReply) {
      const idAttr = comment.rowIdAttribute ?? 'data-comment-id';
      const row = this.page.locator(comment.list).locator(
        buildAttrSelector(comment.rows, idAttr, event.commentId!),
      );
      requireSafe(await row.count() === 1, 'COMMENT_REPLY_ORIGINAL_CHANGED');
      const composerInRow = row.locator(comment.composer);
      if (!await composerInRow.isVisible().catch(() => false)) {
        await row.locator(comment.openReply).click();
      }
    }
  }

  private async captureEditorAction(
    event: InboundEvent,
    options: {
      action: 'snapshot' | 'prepare' | 'verify' | 'armAndClick' | 'cancel';
      text?: string;
      token?: string;
      expectedContextJson?: string;
      permitExpiresAt?: number;
    },
  ): Promise<{ context: unknown[]; editorText: string }> {
    if (options.action !== 'cancel') {
      try {
        await this.guard();
      } catch (error) {
        if (options.action === 'armAndClick' || options.action === 'verify') {
          (error as { preClick?: boolean }).preClick = true;
        }
        throw error;
      }
    }
    const dm = event.channel === 'DIRECT_MESSAGE' ? this.mapping.selectors.dm : undefined;
    const comment = event.channel === 'COMMENT_NOTIFICATION' ? this.mapping.selectors.comment : undefined;
    try {
      return await this.page.evaluate((arg) => {
        const dom = {
          visible(el: Element): boolean {
            if (!el.isConnected || !el.getClientRects().length) return false;
            for (let node: Element | null = el; node; node = node.parentElement) {
              const style = getComputedStyle(node);
              if (
                style.display === 'none'
                || style.visibility === 'hidden'
                || style.visibility === 'collapse'
                || Number(style.opacity) === 0
              ) {
                return false;
              }
            }
            return true;
          },
          one(root: Document | Element, selector: string): Element {
            const matches = Array.from(root.querySelectorAll(selector)).filter(el => dom.visible(el));
            if (matches.length !== 1) throw new Error('NATIVE_REPLY_DOM_CHANGED');
            return matches[0]!;
          },
          readEditor(editor: Element): string {
            if (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement) {
              return editor.value;
            }
            if (editor instanceof HTMLElement && editor.isContentEditable) {
              return (editor.textContent ?? '').replace(/[\u200B\uFEFF]/gu, '');
            }
            throw new Error('NATIVE_REPLY_EDITOR_UNSUPPORTED');
          },
          writeEditor(editor: Element, value: string): void {
            if (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement) {
              const proto = editor instanceof HTMLInputElement
                ? HTMLInputElement.prototype
                : HTMLTextAreaElement.prototype;
              Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(editor, value);
            } else if (editor instanceof HTMLElement && editor.isContentEditable) {
              editor.textContent = value;
            } else {
              throw new Error('NATIVE_REPLY_EDITOR_UNSUPPORTED');
            }
            editor.dispatchEvent(new InputEvent('input', {
              bubbles: true,
              composed: true,
              inputType: value ? 'insertText' : 'deleteContent',
              data: value || null,
            }));
          },
          captureTarget() {
            if (location.origin !== arg.origin) throw new Error('OBSERVATION_UNEXPECTED_ORIGIN');
            if (/验证码|安全验证|访问受限/u.test(document.title)) {
              throw new Error('OBSERVATION_SECURITY_SUSPECT');
            }
            if (
              arg.securityBlockers
              && Array.from(document.querySelectorAll(arg.securityBlockers)).some(el => dom.visible(el))
            ) {
              throw new Error('OBSERVATION_SECURITY_SUSPECT');
            }
            if (
              arg.loginRequired
              && Array.from(document.querySelectorAll(arg.loginRequired)).some(el => dom.visible(el))
            ) {
              throw new Error('LOGIN_REQUIRED');
            }
            const selfNodes = Array.from(document.querySelectorAll(arg.selfSelector)).filter(el => dom.visible(el));
            if (selfNodes.length !== 1) throw new Error('ACCOUNT_NOT_VERIFIED');
            const selfNode = selfNodes[0]!;
            const actualSelf = arg.selfIdAttribute
              ? selfNode.getAttribute(arg.selfIdAttribute)?.trim() ?? ''
              : selfNode.textContent?.trim() ?? '';
            if (actualSelf !== arg.selfId) throw new Error('ACCOUNT_CHANGED');

            let scope: Element;
            const context: unknown[] = [];
            let originals = 0;

            if (arg.event.channel === 'DIRECT_MESSAGE') {
              const cfg = arg.dm!;
              scope = dom.one(document, cfg.pane);
              const activeAttr = cfg.activeConversationIdAttribute ?? 'data-conversation-id';
              let activeHolder: Element = scope;
              if (cfg.activeConversationId) {
                const activeMatches = Array.from(scope.querySelectorAll(cfg.activeConversationId)).filter(el => dom.visible(el));
                if (activeMatches.length !== 1) throw new Error('NATIVE_REPLY_CONVERSATION_CHANGED');
                activeHolder = activeMatches[0]!;
              }
              const convId = activeHolder.getAttribute(activeAttr)?.trim()
                || (cfg.activeConversationId ? activeHolder.textContent?.trim() ?? '' : '');
              if (!convId || convId !== arg.event.conversationId) {
                throw new Error('NATIVE_REPLY_CONVERSATION_CHANGED');
              }
              const msgIdAttr = cfg.messageIdAttribute ?? 'data-message-id';
              const senderAttr = cfg.senderIdAttribute ?? 'data-sender-id';
              const timeAttr = cfg.messageTimeAttribute ?? 'data-occurred-at';
              for (const row of Array.from(scope.querySelectorAll(cfg.messages)).filter(el => dom.visible(el))) {
                const id = row.getAttribute(msgIdAttr)?.trim() || null;
                const sender = row.getAttribute(senderAttr)?.trim() || null;
                const text = (row.querySelector(cfg.messageText) ?? row).textContent ?? '';
                const timeEl = cfg.messageTime ? row.querySelector(cfg.messageTime) : row;
                const sentAt = timeEl?.getAttribute(timeAttr)?.trim()
                  || timeEl?.getAttribute('datetime')?.trim()
                  || timeEl?.textContent?.trim()
                  || null;
                const fromMe = Boolean(
                  (cfg.fromMeClass && row.classList.contains(cfg.fromMeClass))
                  || sender === arg.selfId,
                );
                context.push([id, sender, text, sentAt, fromMe]);
                if (
                  !fromMe
                  && id === arg.event.platformEventId
                  && sender === arg.event.actorId
                  && text === arg.event.text
                  && sentAt === arg.event.occurredAt
                ) {
                  originals++;
                }
              }
            } else {
              const cfg = arg.comment!;
              const list = dom.one(document, cfg.list);
              const idAttr = cfg.rowIdAttribute ?? 'data-comment-id';
              const authorAttr = cfg.authorIdAttribute ?? 'data-author-id';
              const videoAttr = cfg.videoIdAttribute ?? 'data-video-id';
              const timeAttr = cfg.timeAttribute ?? 'data-occurred-at';
              const matches = Array.from(list.querySelectorAll(cfg.rows)).filter(row =>
                dom.visible(row) && row.getAttribute(idAttr)?.trim() === arg.event.commentId,
              );
              if (matches.length !== 1) throw new Error('COMMENT_REPLY_ORIGINAL_CHANGED');
              const row = matches[0]!;
              const authorNode = cfg.authorId ? row.querySelector(cfg.authorId) : row;
              const actorId = row.getAttribute(authorAttr)?.trim()
                || authorNode?.getAttribute(authorAttr)?.trim()
                || (cfg.authorId ? authorNode?.textContent?.trim() ?? '' : '');
              const videoId = row.getAttribute(videoAttr)?.trim() || list.getAttribute(videoAttr)?.trim() || '';
              const text = (row.querySelector(cfg.text) ?? row).textContent ?? '';
              const timeEl = cfg.time ? row.querySelector(cfg.time) : row;
              const occurredAt = timeEl?.getAttribute(timeAttr)?.trim()
                || timeEl?.getAttribute('datetime')?.trim()
                || timeEl?.textContent?.trim()
                || '';
              if (
                actorId === arg.event.actorId
                && videoId === arg.event.videoId
                && text === arg.event.text
                && occurredAt === arg.event.occurredAt
              ) {
                originals++;
              }
              context.push([arg.event.commentId, actorId, videoId, text, occurredAt]);
              // Strictly scope comment reply controls to the verified parent comment row (no whole-list fallback).
              scope = row;
            }

            if (originals !== 1) throw new Error('NATIVE_REPLY_ORIGINAL_CHANGED');
            const composerSel = arg.dm ? arg.dm.composer : arg.comment!.composer;
            const sendSel = arg.dm ? arg.dm.send : arg.comment!.send;
            const editor = dom.one(scope, composerSel);
            const button = dom.one(scope, sendSel);
            if (arg.comment && (editor.closest(arg.comment.rows) !== scope || button.closest(arg.comment.rows) !== scope)) {
              throw new Error('NATIVE_REPLY_COMPOSER_CONFLICT');
            }
            if (button.contains(editor)) throw new Error('NATIVE_REPLY_COMPOSER_CONFLICT');
            return { scope, editor, button, context, editorText: dom.readEditor(editor) };
          },
        };

        const host = window as unknown as {
          __inboraWebPreparation?: {
            token: string;
            editor: Element;
            text: string;
            foreign: boolean;
            writing: boolean;
            remove: () => void;
          };
        };

        if (arg.action === 'cancel') {
          if (location.origin !== arg.origin) throw new Error('OBSERVATION_UNEXPECTED_ORIGIN');
          const prep = host.__inboraWebPreparation;
          if (prep && (!arg.token || prep.token === arg.token)) {
            try {
              if (!prep.foreign && prep.editor.isConnected && dom.readEditor(prep.editor) === prep.text) {
                prep.writing = true;
                try {
                  dom.writeEditor(prep.editor, '');
                } finally {
                  prep.writing = false;
                }
              }
            } finally {
              prep.remove();
            }
          }
          return { context: [], editorText: '' };
        }

        const state = dom.captureTarget();

        if (arg.action === 'snapshot' && !arg.token) {
          if (state.editorText !== '') throw new Error('NATIVE_REPLY_EXISTING_DRAFT');
        }

        if (arg.action === 'prepare') {
          if (state.editorText !== '') throw new Error('NATIVE_REPLY_EXISTING_DRAFT');
          host.__inboraWebPreparation?.remove();
          const events = ['beforeinput', 'input', 'paste', 'drop', 'compositionstart'];
          const editor = state.editor;
          const prep = {
            token: arg.token!,
            editor,
            text: arg.text!,
            foreign: false,
            writing: true,
            onForeign() {
              if (!prep.writing) prep.foreign = true;
            },
            remove() {
              for (const name of events) editor.removeEventListener(name, prep.onForeign, true);
              if (host.__inboraWebPreparation === prep) delete host.__inboraWebPreparation;
            },
          };
          for (const name of events) editor.addEventListener(name, prep.onForeign, true);
          host.__inboraWebPreparation = prep;
          try {
            (editor as HTMLElement).focus({ preventScroll: true });
            dom.writeEditor(editor, arg.text!);
          } finally {
            prep.writing = false;
          }
          if (prep.foreign || dom.readEditor(editor) !== arg.text) {
            throw new Error('NATIVE_REPLY_APPROVED_TEXT_CHANGED');
          }
        }

        if (arg.action === 'verify' || arg.action === 'armAndClick') {
          const prep = host.__inboraWebPreparation;
          if (
            !prep
            || prep.token !== arg.token
            || prep.editor !== state.editor
            || prep.foreign
            || state.editorText !== arg.text
          ) {
            throw new Error('NATIVE_REPLY_NOT_PREPARED');
          }
          if (
            arg.expectedContextJson !== undefined
            && JSON.stringify(state.context) !== arg.expectedContextJson
          ) {
            throw new Error('NATIVE_REPLY_CONTEXT_CHANGED');
          }
          if (
            state.button.closest('[disabled],[aria-disabled="true"],.disabled')
            || getComputedStyle(state.button).pointerEvents === 'none'
          ) {
            throw new Error('NATIVE_REPLY_CONTROL_CHANGED');
          }
        }

        if (arg.action === 'armAndClick') {
          let button: Element;
          let editor: Element;
          let gate: {
            enabled: boolean;
            used: boolean;
            blocked: boolean;
            validate: () => void;
            handle: (evt: Event) => void;
          };
          try {
            if (arg.permitExpiresAt !== undefined && Date.now() >= arg.permitExpiresAt) {
              throw new Error('WORKER_SEND_PERMIT_EXPIRED');
            }
            button = state.button;
            editor = state.editor;
            gate = {
              enabled: false,
              used: false,
              blocked: false,
              validate() {
                const latest = dom.captureTarget();
                const prep = host.__inboraWebPreparation;
                if (
                  !prep
                  || prep.token !== arg.token
                  || prep.editor !== editor
                  || prep.foreign
                  || latest.editor !== editor
                  || latest.button !== button
                  || latest.editorText !== arg.text
                  || JSON.stringify(latest.context) !== arg.expectedContextJson
                  || button.closest('[disabled],[aria-disabled="true"],.disabled')
                  || getComputedStyle(button).pointerEvents === 'none'
                ) {
                  throw new Error('NATIVE_REPLY_CLICK_BLOCKED');
                }
              },
              handle(evt: Event) {
                if (!evt.composedPath().includes(button)) return;
                try {
                  if (!gate.enabled || gate.used || gate.blocked) throw new Error('NATIVE_REPLY_CLICK_BLOCKED');
                  gate.validate();
                  if (evt.currentTarget === button) gate.used = true;
                } catch {
                  gate.blocked = true;
                  evt.preventDefault();
                  evt.stopImmediatePropagation();
                }
              },
            };
            gate.validate();
          } catch (error) {
            return {
              context: [],
              editorText: '',
              preClickError: error instanceof Error ? error.message : String(error),
            };
          }
          button.addEventListener('click', gate.handle, true);
          gate.enabled = true;
          try {
            (button as HTMLElement).click();
          } finally {
            gate.enabled = false;
            button.removeEventListener('click', gate.handle, true);
            host.__inboraWebPreparation?.remove();
          }
          if (!gate.used || gate.blocked) throw new Error('NATIVE_REPLY_CLICK_BLOCKED');
        }

        return { context: state.context, editorText: dom.readEditor(state.editor) };
      }, {
        event,
        origin: this.mapping.origin,
        selfId: this.mapping.selfId,
        selfSelector: this.mapping.selectors.selfId,
        ...(this.mapping.selectors.selfIdAttribute
          ? { selfIdAttribute: this.mapping.selectors.selfIdAttribute }
          : {}),
        securityBlockers: this.mapping.selectors.securityBlockers,
        ...(this.mapping.selectors.loginRequired
          ? { loginRequired: this.mapping.selectors.loginRequired }
          : {}),
        dm,
        comment,
        ...options,
      }).then(result => {
        const preError = (result as { preClickError?: string }).preClickError;
        if (preError) {
          try {
            return captureWebError(this.page, new Error(preError));
          } catch (mapped) {
            (mapped as { preClick?: boolean }).preClick = true;
            throw mapped;
          }
        }
        return result;
      });
    } catch (error) {
      if ((error as { preClick?: boolean }).preClick === true) throw error;
      try {
        return captureWebError(this.page, error);
      } catch (mapped) {
        if (options.action === 'armAndClick' && mapped instanceof Blocked && (
          mapped.code === 'OBSERVATION_UNEXPECTED_ORIGIN'
          || mapped.code === 'OBSERVATION_SECURITY_SUSPECT'
          || mapped.code === 'LOGIN_REQUIRED'
          || mapped.code === 'ACCOUNT_NOT_VERIFIED'
          || mapped.code === 'ACCOUNT_CHANGED'
          || mapped.code === 'NATIVE_REPLY_ORIGINAL_CHANGED'
          || mapped.code === 'NATIVE_REPLY_CONVERSATION_CHANGED'
          || mapped.code === 'COMMENT_REPLY_ORIGINAL_CHANGED'
          || mapped.code === 'NATIVE_REPLY_DOM_CHANGED'
          || mapped.code === 'NATIVE_REPLY_COMPOSER_CONFLICT'
          || mapped.code === 'NATIVE_REPLY_NOT_PREPARED'
          || mapped.code === 'NATIVE_REPLY_CONTEXT_CHANGED'
          || mapped.code === 'NATIVE_REPLY_CONTROL_CHANGED'
          || mapped.code === 'WORKER_SEND_PERMIT_EXPIRED'
        )) {
          (mapped as { preClick?: boolean }).preClick = true;
        }
        throw mapped;
      }
    }
  }

  async inspect(event: InboundEvent): Promise<TargetSnapshot> {
    this.assertTargetChannel(event);
    this.lastEvent = event;
    await this.ensureTargetOpen(event);
    const frame = await this.captureEditorAction(event, { action: 'snapshot' });
    return {
      accountId: event.accountId,
      ownId: this.mapping.selfId,
      targetKey: targetKey(event),
      eventBinding: eventBinding(event),
      contextDigest: digest(frame.context),
      composerKey: targetKey(event),
      mappingDigest: digest(this.mapping),
    };
  }

  async prepare(event: InboundEvent, text: string): Promise<void> {
    this.assertTargetChannel(event);
    this.lastEvent = event;
    await this.ensureTargetOpen(event);
    const before = await this.captureEditorAction(event, { action: 'snapshot' });
    const beforeJson = JSON.stringify(before.context);
    const token = randomUUID();
    this.pendingCleanupToken = token;
    try {
      const after = await this.captureEditorAction(event, { action: 'prepare', text, token });
      requireSafe(beforeJson === JSON.stringify(after.context), 'NATIVE_REPLY_CONTEXT_CHANGED');
      this.prepared = {
        binding: eventBinding(event),
        text,
        contextDigest: digest(after.context),
        contextJson: beforeJson,
        token,
      };
      this.pendingCleanupToken = null;
    } catch (error) {
      await this.captureEditorAction(event, { action: 'cancel', token }).catch(() => {});
      this.pendingCleanupToken = null;
      throw error;
    }
  }

  async verifyPrepared(event: InboundEvent, text: string): Promise<TargetSnapshot> {
    this.assertTargetChannel(event);
    const prep = this.prepared;
    requireSafe(prep && prep.binding === eventBinding(event) && prep.text === text, 'NATIVE_REPLY_NOT_PREPARED');
    await this.captureEditorAction(event, {
      action: 'verify',
      text,
      token: prep.token,
      expectedContextJson: prep.contextJson,
    });
    return {
      accountId: event.accountId,
      ownId: this.mapping.selfId,
      targetKey: targetKey(event),
      eventBinding: eventBinding(event),
      contextDigest: prep.contextDigest,
      composerKey: targetKey(event),
      mappingDigest: digest(this.mapping),
    };
  }

  async baseline(event: InboundEvent): Promise<string[]> {
    this.assertTargetChannel(event);
    await this.guard();
    const frame = await captureWebProofs(this.page, this.mapping, event);
    return frame.proofs.map(proof => proof.id);
  }

  async clickOnce(_notBefore?: string, check?: () => void, permitExpiresAt?: number): Promise<void> {
    const prep = this.prepared;
    requireSafe(prep && check, 'NATIVE_REPLY_NOT_PREPARED');
    requireSafe(permitExpiresAt === undefined || Date.now() < permitExpiresAt, 'WORKER_SEND_PERMIT_EXPIRED');
    const currentEvent = this.lastEvent;
    requireSafe(currentEvent && eventBinding(currentEvent) === prep.binding, 'NATIVE_REPLY_NOT_PREPARED');
    try {
      await this.captureEditorAction(currentEvent, {
        action: 'verify',
        text: prep.text,
        token: prep.token,
        expectedContextJson: prep.contextJson,
      });
    } catch (error) {
      (error as { preClick?: boolean }).preClick = true;
      throw error;
    }
    check();
    this.pendingCleanupToken = prep.token;
    try {
      await this.captureEditorAction(currentEvent, {
        action: 'armAndClick',
        text: prep.text,
        token: prep.token,
        expectedContextJson: prep.contextJson,
        ...(permitExpiresAt !== undefined ? { permitExpiresAt } : {}),
      });
      this.prepared = null;
      this.pendingCleanupToken = null;
    } catch (error) {
      if ((error as { preClick?: boolean }).preClick !== true) {
        this.prepared = null;
      }
      throw error;
    }
  }

  async readback(event: InboundEvent, text: string, before: string[], notBefore: string): Promise<SendProof | null> {
    this.assertTargetChannel(event);
    const deadline = Date.now() + this.receiptTimeoutMs;
    while (true) {
      await this.guard();
      const frame = await captureWebProofs(this.page, this.mapping, event);
      const matches = filterValidWebProofs(
        frame.proofs,
        event,
        this.mapping.selfId,
        text,
        before,
        notBefore,
        true,
      );
      const unique = assertUniqueProof(matches);
      if (unique) return unique;
      if (Date.now() >= deadline) return null;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  async verifyExisting(
    event: InboundEvent,
    text: string,
    notBefore: string,
    contextDigest?: string,
  ): Promise<SendProof | null> {
    this.assertTargetChannel(event);
    await this.ensureTargetOpen(event, true);
    await this.guard();
    const frame = await captureWebProofs(this.page, this.mapping, event);
    if (contextDigest && digest(frame.context) !== contextDigest) {
      return null;
    }
    const matches = filterValidWebProofs(
      frame.proofs,
      event,
      this.mapping.selfId,
      text,
      [],
      notBefore,
      true,
    );
    return assertUniqueProof(matches);
  }

  async cancelPreparation(event: InboundEvent, _text: string): Promise<void> {
    const token = this.prepared?.token ?? this.pendingCleanupToken;
    this.prepared = null;
    this.pendingCleanupToken = null;
    if (!token || this.disposed) return;
    await this.captureEditorAction(event, { action: 'cancel', token }).catch(() => {});
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const token = this.prepared?.token ?? this.pendingCleanupToken;
    this.prepared = null;
    this.pendingCleanupToken = null;
    if (token && this.lastEvent) {
      await this.captureEditorAction(this.lastEvent, { action: 'cancel', token }).catch(() => {});
    }
  }
}
