import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import type { WebPlatformObservationMapping } from '../config/web-platform-mapping.js';
import type { AccountId } from '../contracts/account.js';
import {
  Blocked,
  eventSchema,
  requireSafe,
  type InboundEvent,
} from '../core/contracts.js';
import { reportSecurityFailure } from './security-signal.js';

export interface WebObservationBatch {
  scope: string;
  ownId: string;
  evidenceId: string;
  events: InboundEvent[];
}

export async function captureWebError(page: Page, error: unknown): Promise<never> {
  if (error instanceof Blocked) throw error;
  const msg = error instanceof Error ? error.message : String(error);
  const matched = msg.match(
    /(?:OBSERVATION|NATIVE_REPLY|COMMENT_REPLY|PLATFORM_MAPPING|WORKER|LOGIN|ACCOUNT)_[A-Z0-9_]+/u,
  )?.[0];
  if (matched) throw new Blocked(matched);
  return reportSecurityFailure(page, error);
}

/** Shared DOM guard used inside Playwright evaluate without module closures. */
export function evaluateWebGuard(arg: {
  origin: string;
  selfId: string;
  selfSelector: string;
  selfIdAttribute?: string;
  securityBlockers: string;
  loginRequired?: string;
}) {
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
  };
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
  const node = selfNodes[0]!;
  const actualSelf = arg.selfIdAttribute
    ? node.getAttribute(arg.selfIdAttribute)?.trim() ?? ''
    : node.textContent?.trim() ?? '';
  if (actualSelf !== arg.selfId) throw new Error('ACCOUNT_CHANGED');
  return { ownId: actualSelf };
}

export class WebPlatformReader {
  constructor(
    readonly page: Page,
    readonly mapping: WebPlatformObservationMapping,
    readonly accountId: AccountId,
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

  async observe(
    source: 'notifications' | 'works' | 'dm',
    index: number,
  ): Promise<WebObservationBatch | null> {
    await this.guard();
    if (source === 'dm') return this.observeDm(index);
    if (index > 0) return null;
    return this.observeComments(source);
  }

  private async observeDm(index: number): Promise<WebObservationBatch | null> {
    const dm = this.mapping.selectors.dm;
    requireSafe(dm, 'OBSERVATION_MAPPING_REQUIRED');
    if (dm.entry && !await this.page.locator(dm.pane).isVisible().catch(() => false)) {
      const listVisible = dm.list ? await this.page.locator(dm.list).isVisible().catch(() => false) : false;
      if (!listVisible) await this.page.locator(dm.entry).click();
    }
    let selectedConversationId: string | null = null;
    if (dm.list && dm.conversationRows) {
      await this.page.locator(dm.list).waitFor({ state: 'visible' });
      const rows = this.page.locator(dm.list).locator(dm.conversationRows);
      const count = await rows.count();
      if (index >= count) return null;
      const row = rows.nth(index);
      const convAttr = dm.conversationIdAttribute ?? 'data-conversation-id';
      selectedConversationId = (await row.getAttribute(convAttr))?.trim() ?? null;
      requireSafe(selectedConversationId, 'OBSERVATION_CONVERSATION_NOT_FOUND');
      const target = dm.selectAction ? row.locator(dm.selectAction) : row;
      await target.click();
      const activeAttr = dm.activeConversationIdAttribute ?? 'data-conversation-id';
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
        return convId === arg.selectedConversationId;
      }, {
        pane: dm.pane,
        activeConversationId: dm.activeConversationId ?? null,
        activeAttr,
        selectedConversationId,
      }, { timeout: 2_000 }).catch(() => {});
    } else if (index > 0) {
      return null;
    }

    await this.page.locator(dm.pane).waitFor({ state: 'visible' });
    const evidenceId = randomUUID();
    let raw: { conversationId: string; events: unknown[] };
    try {
      raw = await this.page.evaluate((arg) => {
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
        };
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
        const selfNodes = Array.from(document.querySelectorAll(arg.selfSelector)).filter(el => dom.visible(el));
        if (selfNodes.length !== 1) throw new Error('ACCOUNT_NOT_VERIFIED');
        const selfNode = selfNodes[0]!;
        const actualSelf = arg.selfIdAttribute
          ? selfNode.getAttribute(arg.selfIdAttribute)?.trim() ?? ''
          : selfNode.textContent?.trim() ?? '';
        if (actualSelf !== arg.selfId) throw new Error('ACCOUNT_CHANGED');

        const panes = Array.from(document.querySelectorAll(arg.pane)).filter(el => dom.visible(el));
        if (panes.length !== 1) throw new Error('OBSERVATION_DOM_NOT_READY');
        const pane = panes[0]!;
        const activeAttr = arg.activeConversationIdAttribute ?? 'data-conversation-id';
        let activeHolder: Element = pane;
        if (arg.activeConversationId) {
          const activeMatches = Array.from(pane.querySelectorAll(arg.activeConversationId)).filter(el => dom.visible(el));
          if (activeMatches.length !== 1) throw new Error('OBSERVATION_CONVERSATION_NOT_FOUND');
          activeHolder = activeMatches[0]!;
        }
        const convId = activeHolder.getAttribute(activeAttr)?.trim()
          || (arg.activeConversationId ? activeHolder.textContent?.trim() ?? '' : '');
        if (!convId) throw new Error('OBSERVATION_CONVERSATION_NOT_FOUND');
        if (arg.selectedConversationId && convId !== arg.selectedConversationId) {
          throw new Error('OBSERVATION_CONVERSATION_CHANGED');
        }
        const msgIdAttr = arg.messageIdAttribute ?? 'data-message-id';
        const senderAttr = arg.senderIdAttribute ?? 'data-sender-id';
        const timeAttr = arg.messageTimeAttribute ?? 'data-occurred-at';
        const events = Array.from(pane.querySelectorAll(arg.messages))
          .filter(row => dom.visible(row))
          .map(row => {
            const msgId = row.getAttribute(msgIdAttr)?.trim() || null;
            const senderId = row.getAttribute(senderAttr)?.trim() || null;
            const textEl = row.querySelector(arg.messageText);
            const text = textEl ? textEl.textContent ?? '' : row.textContent ?? '';
            const timeEl = arg.messageTime ? row.querySelector(arg.messageTime) : row;
            const occurredAt = timeEl?.getAttribute(timeAttr)?.trim()
              || timeEl?.getAttribute('datetime')?.trim()
              || timeEl?.textContent?.trim()
              || null;
            const fromMe = Boolean(
              (arg.fromMeClass && row.classList.contains(arg.fromMeClass))
              || senderId === arg.selfId,
            );
            return {
              accountId: arg.accountId,
              channel: 'DIRECT_MESSAGE',
              platformEventId: msgId,
              actorId: senderId,
              actorName: null,
              text,
              occurredAt,
              videoId: null,
              commentId: null,
              conversationId: convId,
              direction: fromMe ? 'OUTGOING' : 'INCOMING',
              kind: 'DM',
              evidenceId: arg.evidenceId,
              discovery: 'DIRECT_MESSAGE',
            };
          });
        return { conversationId: convId, events };
      }, {
        ...dm,
        origin: this.mapping.origin,
        selfId: this.mapping.selfId,
        selfSelector: this.mapping.selectors.selfId,
        ...(this.mapping.selectors.selfIdAttribute
          ? { selfIdAttribute: this.mapping.selectors.selfIdAttribute }
          : {}),
        securityBlockers: this.mapping.selectors.securityBlockers,
        accountId: this.accountId,
        evidenceId,
        selectedConversationId,
      });
    } catch (error) {
      return captureWebError(this.page, error);
    }
    return {
      scope: raw.conversationId,
      ownId: this.mapping.selfId,
      evidenceId,
      events: raw.events.map(item => eventSchema.parse(item)),
    };
  }

  private async observeComments(source: 'notifications' | 'works'): Promise<WebObservationBatch> {
    const comment = this.mapping.selectors.comment;
    requireSafe(comment, 'OBSERVATION_MAPPING_REQUIRED');
    if (comment.entry && !await this.page.locator(comment.list).isVisible().catch(() => false)) {
      await this.page.locator(comment.entry).click();
    }
    await this.page.locator(comment.list).waitFor({ state: 'visible' });
    const evidenceId = randomUUID();
    let raw: { scope: string; events: unknown[] };
    try {
      raw = await this.page.evaluate((arg) => {
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
        };
        const lists = Array.from(document.querySelectorAll(arg.list)).filter(el => dom.visible(el));
        if (lists.length !== 1) throw new Error('OBSERVATION_DOM_NOT_READY');
        const list = lists[0]!;
        const idAttr = arg.rowIdAttribute ?? 'data-comment-id';
        const parentAttr = arg.parentIdAttribute ?? 'data-parent-id';
        const videoAttr = arg.videoIdAttribute ?? 'data-video-id';
        const authorAttr = arg.authorIdAttribute ?? 'data-author-id';
        const timeAttr = arg.timeAttribute ?? 'data-occurred-at';
        let firstVideoId: string | null = null;
        const events = Array.from(list.querySelectorAll(arg.rows))
          .filter(row => dom.visible(row))
          .map(row => {
            const commentId = row.getAttribute(idAttr)?.trim() || null;
            const parentId = row.getAttribute(parentAttr)?.trim() || undefined;
            const videoId = row.getAttribute(videoAttr)?.trim() || list.getAttribute(videoAttr)?.trim() || null;
            if (!firstVideoId && videoId) firstVideoId = videoId;
            const authorNode = arg.authorId ? row.querySelector(arg.authorId) : row;
            const actorId = row.getAttribute(authorAttr)?.trim()
              || authorNode?.getAttribute(authorAttr)?.trim()
              || (arg.authorId ? authorNode?.textContent?.trim() ?? null : null);
            const actorName = arg.authorName
              ? row.querySelector(arg.authorName)?.textContent?.trim() ?? null
              : null;
            const text = (row.querySelector(arg.text) ?? row).textContent?.trim() ?? '';
            const timeNode = arg.time ? row.querySelector(arg.time) : row;
            const occurredAt = timeNode?.getAttribute(timeAttr)?.trim()
              || timeNode?.getAttribute('datetime')?.trim()
              || timeNode?.textContent?.trim()
              || null;
            const fromMe = Boolean(
              (arg.fromMeClass && row.classList.contains(arg.fromMeClass))
              || actorId === arg.selfId,
            );
            return {
              accountId: arg.accountId,
              channel: 'COMMENT_NOTIFICATION',
              platformEventId: commentId,
              actorId,
              actorName,
              text,
              occurredAt,
              videoId,
              commentId,
              ...(parentId && commentId ? { rootCommentId: parentId, replyToCommentId: commentId } : {}),
              conversationId: null,
              direction: fromMe ? 'OUTGOING' : 'INCOMING',
              kind: parentId ? 'REPLY' : 'COMMENT',
              evidenceId: arg.evidenceId,
              discovery: arg.source === 'notifications' ? 'NOTIFICATION' : 'ALLOWED_WORK',
            };
          });
        return { scope: firstVideoId ? `work:${firstVideoId}` : arg.source, events };
      }, {
        ...comment,
        selfId: this.mapping.selfId,
        accountId: this.accountId,
        evidenceId,
        source,
      });
    } catch (error) {
      return captureWebError(this.page, error);
    }
    return {
      scope: raw.scope,
      ownId: this.mapping.selfId,
      evidenceId,
      events: raw.events.map(item => eventSchema.parse(item)),
    };
  }
}
