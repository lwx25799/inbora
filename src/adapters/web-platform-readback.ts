import { z } from 'zod';
import type { Page } from 'playwright';
import type { WebPlatformReplyMapping } from '../config/web-platform-mapping.js';
import {
  proofTimeValid,
  requireSafe,
  targetKey,
  type InboundEvent,
  type SendProof,
} from '../core/contracts.js';
import { captureWebError } from './web-platform-reader.js';

const isoWithOffsetSchema = z.iso.datetime({ offset: true });

export function escapeCssAttrValue(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
}

export function buildAttrSelector(baseSelector: string, attr: string, value: string): string {
  return `${baseSelector}[${attr}="${escapeCssAttrValue(value)}"]`;
}

export function filterValidWebProofs(
  proofs: readonly SendProof[],
  event: InboundEvent,
  selfId: string,
  text: string,
  before: readonly string[],
  notBefore: string,
  hasBaseline: boolean,
): SendProof[] {
  const expectedKey = targetKey(event);
  return proofs.filter(proof =>
    !before.includes(proof.id)
    && proof.ownId === selfId
    && proof.targetKey === expectedKey
    && proof.text === text
    && !proof.pending
    && isoWithOffsetSchema.safeParse(proof.sentAt).success
    && proofTimeValid(proof, notBefore, hasBaseline),
  );
}

/**
 * Readback-only capture of scoped DM or comment outgoing proofs.
 * Independent from composer/send controls so receipts still resolve if the site closes the editor on send.
 */
export async function captureWebProofs(
  page: Page,
  mapping: WebPlatformReplyMapping,
  event: InboundEvent,
): Promise<{ context: unknown[]; proofs: SendProof[] }> {
  const dm = event.channel === 'DIRECT_MESSAGE' ? mapping.selectors.dm : undefined;
  const comment = event.channel === 'COMMENT_NOTIFICATION' ? mapping.selectors.comment : undefined;
  try {
    return await page.evaluate((arg) => {
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
        readConfirmed(row: Element, cfg: {
          fromMeClass?: string | undefined;
          proofPendingSelector?: string | undefined;
          proofFailedSelector?: string | undefined;
          proofConfirmedSelector?: string | undefined;
          proofConfirmedAttribute?: string | undefined;
          proofConfirmedValue?: string | undefined;
        }): { confirmed: boolean; pending: boolean } {
          const pending = Boolean(
            (cfg.proofPendingSelector && (row.matches(cfg.proofPendingSelector) || row.querySelector(cfg.proofPendingSelector)))
            || (cfg.proofFailedSelector && (row.matches(cfg.proofFailedSelector) || row.querySelector(cfg.proofFailedSelector))),
          );
          if (pending) return { confirmed: false, pending: true };
          if (cfg.proofConfirmedSelector) {
            const matched = row.matches(cfg.proofConfirmedSelector)
              || Boolean(row.querySelector(cfg.proofConfirmedSelector));
            return { confirmed: matched, pending: !matched };
          }
          const attr = cfg.proofConfirmedAttribute ?? 'data-delivery-status';
          const expected = cfg.proofConfirmedValue ?? 'confirmed';
          const confirmed = row.getAttribute(attr)?.trim() === expected;
          return { confirmed, pending: !confirmed };
        },
      };

      const context: unknown[] = [];
      const proofs: SendProof[] = [];
      let originals = 0;

      if (arg.event.channel === 'DIRECT_MESSAGE') {
        const cfg = arg.dm!;
        const scope = dom.one(document, cfg.pane);
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
          const textNode = row.querySelector(cfg.messageText) ?? row;
          const text = textNode.textContent ?? '';
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

        const proofIdAttr = cfg.proofIdAttribute ?? msgIdAttr;
        const proofOwnAttr = cfg.proofOwnIdAttribute ?? senderAttr;
        const proofTimeAttr = cfg.proofTimeAttribute ?? timeAttr;
        for (const row of Array.from(scope.querySelectorAll(cfg.outgoingRows)).filter(el => dom.visible(el))) {
          const id = row.getAttribute(proofIdAttr)?.trim() || '';
          const ownId = row.getAttribute(proofOwnAttr)?.trim() || '';
          const rowConvId = row.getAttribute(activeAttr)?.trim();
          if (rowConvId && rowConvId !== arg.event.conversationId) continue;
          if (cfg.fromMeClass && !row.classList.contains(cfg.fromMeClass)) continue;
          if (!id || ownId !== arg.selfId) continue;
          const textEl = cfg.proofText ? row.querySelector(cfg.proofText) : row.querySelector(cfg.messageText);
          if (!textEl) continue;
          const text = textEl.textContent ?? '';
          const timeEl = cfg.proofTime
            ? row.querySelector(cfg.proofTime)
            : cfg.messageTime
              ? row.querySelector(cfg.messageTime)
              : row;
          const sentAt = timeEl?.getAttribute(proofTimeAttr)?.trim()
            || timeEl?.getAttribute('datetime')?.trim()
            || '';
          if (!sentAt) continue;
          const status = dom.readConfirmed(row, cfg);
          proofs.push({
            id,
            ownId,
            targetKey: arg.targetKey,
            text,
            pending: status.pending || !status.confirmed,
            sentAt,
          });
        }
      } else {
        const cfg = arg.comment!;
        const list = dom.one(document, cfg.list);
        const idAttr = cfg.rowIdAttribute ?? 'data-comment-id';
        const authorAttr = cfg.authorIdAttribute ?? 'data-author-id';
        const videoAttr = cfg.videoIdAttribute ?? 'data-video-id';
        const timeAttr = cfg.timeAttribute ?? 'data-occurred-at';
        const parentAttr = cfg.parentIdAttribute ?? 'data-parent-id';
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
        const textNode = row.querySelector(cfg.text) ?? row;
        const text = textNode.textContent ?? '';
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

        const proofIdAttr = cfg.proofIdAttribute ?? idAttr;
        const proofOwnAttr = cfg.proofOwnIdAttribute ?? authorAttr;
        const proofTimeAttr = cfg.proofTimeAttribute ?? timeAttr;
        const directRepliesScope = cfg.directRepliesSelector
          ? Array.from(row.querySelectorAll(cfg.directRepliesSelector))
            .filter(el => dom.visible(el) && el.closest(cfg.rows) === row)
          : [];
        for (const out of Array.from(row.querySelectorAll(cfg.outgoingRows)).filter(el => dom.visible(el))) {
          if (out.closest(cfg.rows) !== row) continue;
          const outVideo = out.getAttribute(videoAttr)?.trim() || row.getAttribute(videoAttr)?.trim() || videoId;
          if (outVideo !== arg.event.videoId) continue;
          const outParent = out.getAttribute(parentAttr)?.trim() || '';
          if (outParent && outParent !== arg.event.commentId) continue;
          const inDirectReplies = directRepliesScope.some(container => container.contains(out));
          if (!outParent && !inDirectReplies) continue;
          const id = out.getAttribute(proofIdAttr)?.trim() || '';
          const ownId = out.getAttribute(proofOwnAttr)?.trim() || '';
          if (cfg.fromMeClass && !out.classList.contains(cfg.fromMeClass)) continue;
          if (!id || ownId !== arg.selfId) continue;
          const textEl = cfg.proofText ? out.querySelector(cfg.proofText) : out.querySelector(cfg.text);
          if (!textEl) continue;
          const replyText = textEl.textContent ?? '';
          const tEl = cfg.proofTime
            ? out.querySelector(cfg.proofTime)
            : cfg.time
              ? out.querySelector(cfg.time)
              : out;
          const sentAt = tEl?.getAttribute(proofTimeAttr)?.trim()
            || tEl?.getAttribute('datetime')?.trim()
            || '';
          if (!sentAt) continue;
          const status = dom.readConfirmed(out, cfg);
          proofs.push({
            id,
            ownId,
            targetKey: arg.targetKey,
            text: replyText,
            pending: status.pending || !status.confirmed,
            sentAt,
          });
        }
      }

      if (originals !== 1) throw new Error('NATIVE_REPLY_ORIGINAL_CHANGED');
      return { context, proofs };
    }, {
      event,
      selfId: mapping.selfId,
      targetKey: targetKey(event),
      dm,
      comment,
    });
  } catch (error) {
    return captureWebError(page, error);
  }
}

export function assertUniqueProof(proofs: readonly SendProof[]): SendProof | null {
  requireSafe(proofs.length <= 1, 'MULTIPLE_MATCHING_RECEIPTS');
  return proofs[0] ?? null;
}
