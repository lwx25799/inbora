import { requireSafe } from "../core/contracts.js";
import { SendCoordinator } from "../core/send-coordinator.js";
import type { EventStore } from "../storage/store.js";
import type { AutomationStore } from "../storage/automation-store.js";
import { runtimePerformance } from "../observability/runtime-performance.js";
import type { WorkbenchAuthority } from "./authority.js";
import type { PlatformConnector } from "../platform/platform-connector.js";
import type { VerificationScheduler } from "./verification-scheduler.js";
import type { SendParams } from "./contracts.js";
import { findUncertainFollowupForEvent, reconcileUncertainFollowup } from "./followup-verification.js";
import { prepareSendMediaAttachment } from "./ai-runtime-commands.js";
import { assertPolicyCommandOutboundSafe } from "./reply-pipeline-commands.js";

export interface DeliveryContext {
  store: EventStore;
  authority: WorkbenchAuthority;
  browser: PlatformConnector;
  getAutomation(): AutomationStore | null;
  getVerification(): VerificationScheduler | null;
  isClosing(): boolean;
  suspendForVisible(stopUnsubmitted: boolean): void;
  resetOnlineAbort(): AbortSignal;
  resumeAfterLogin(): void;
  bumpInboxRevision(): void;
  emit(event: string): void;
  errorCode(error: unknown): string;
}

export async function deliverCommand(
  ctx: DeliveryContext,
  token: string,
  id: string,
  p: SendParams,
  signal?:AbortSignal,
): Promise<void> {
  let dispose:()=>void|Promise<void> = () => {};
  const end = runtimePerformance.start("DELIVERY", ctx.store.event(p.eventId).payload.channel);
  try {
    const e = ctx.store.event(p.eventId);
    const media = prepareSendMediaAttachment(ctx.store, ctx.browser.root, p);
    const epoch = ctx.browser.ownerEpoch;
    const handle = await ctx.browser.adapter(e.payload, ctx.store, signal, {
      manualMedia: !!ctx.store.draft(p.draftId).approval?.snapshot.manualObservation,
    });
    dispose = handle.dispose;
    await ctx.browser.refreshIdentity(e.payload.channel);
    requireSafe(ctx.browser.ownerEpoch === epoch, "BROWSER_CLOSED");
    const guard = ctx.authority.dispatchGuard(token, id, () => ctx.browser.identity(e.payload.channel));
    const outcome = await new SendCoordinator(ctx.store, ctx.browser.actor, ctx.browser.accountId).send(
      p.draftId,
      handle.adapter,
      true,
      { ...guard, beforeSubmit: intentId => {
        requireSafe(!ctx.isClosing(), 'CLIENT_CLOSING');
        requireSafe(!signal?.aborted,'COLLECTION_CANCELLED');
        requireSafe(ctx.browser.ownerEpoch === epoch, "BROWSER_CLOSED");
        if(e.payload.channel==="COMMENT_NOTIFICATION")guard.beforeSubmit(intentId);
      }, check: () => {
        requireSafe(!ctx.isClosing(), 'CLIENT_CLOSING');
        requireSafe(ctx.browser.ownerEpoch === epoch, "BROWSER_CLOSED");
        assertPolicyCommandOutboundSafe(ctx.store, id, e, p.text, ctx.authority.now);
        guard.check();
      } },
      media,
    );
    const receipt = ctx.store.receiptForEvent(e.id) as { proof_ref: string } | undefined;
    ctx.authority.finish(id, outcome, outcome === "UNCERTAIN" ? (receipt?.proof_ref ?? null) : null);
    if (outcome === "UNCERTAIN") ctx.getVerification()?.enqueue(e.id);
    if (outcome === "CONFIRMED") {
      ctx.authority.completeTrial(p.eventId, ctx.authority.command(id).intent_id!, ctx.browser.identity(e.payload.channel));
    }
    end(outcome === "CONFIRMED" ? "SUCCEEDED" : "UNCERTAIN");
  } catch (error) {
    const intent = ctx.store.db
      .prepare("SELECT id,status FROM send_intents WHERE event_id=?")
      .get(p.eventId) as { id: string; status: string } | undefined;
    end(intent ? (intent.status === "CONFIRMED" ? "SUCCEEDED" : "UNCERTAIN") : "FAILED");
    if (intent && ctx.authority.command(id).intent_id === intent.id) {
      ctx.authority.finish(id, intent.status === "CONFIRMED" ? "CONFIRMED" : "UNCERTAIN", ctx.errorCode(error));
    } else {
      ctx.authority.finish(id, "FAILED_BEFORE_CLICK", ctx.errorCode(error));
      const d = ctx.store.draft(p.draftId);
      if (d.status === "APPROVED") ctx.store.invalidateApproval(d.id);
    }
  } finally {
    await dispose();
    ctx.emit("send_status_updated");
  }
}

export async function openTargetCommand(
  ctx: DeliveryContext,
  token: string,
  eventId: string,
  visible?: true,
): Promise<unknown> {
  ctx.authority.operator(token, "CONTROL");
  if (visible) {
    let suspended = false;
    const check = () => {
      ctx.authority.operator(token, "CONTROL");
      const auto = ctx.getAutomation();
      requireSafe(
        !ctx.isClosing() && auto?.state().collection?.inbox && !auto.state().emergencyStopped,
        "COLLECTION_CANCELLED",
      );
    };
    check();
    try {
      return await ctx.browser.openStoredMessage(
        ctx.store,
        eventId,
        async () => {
          ctx.suspendForVisible(false);
          suspended = true;
          const signal = ctx.resetOnlineAbort();
          await ctx.getVerification()?.drain();
          check();
          return signal;
        },
        check,
      );
    } catch (error) {
      if (suspended && !ctx.browser.loginRecovery && !ctx.getAutomation()?.state().emergencyStopped) {
        ctx.resumeAfterLogin();
      }
      throw error;
    } finally {
      ctx.emit("status_updated");
    }
  }
  const event = ctx.store.event(eventId);
  const handle = await ctx.browser.adapter(event.payload, ctx.store);
  try {
    await ctx.browser.actor.run(() => handle.adapter.inspect(event.payload));
    return { opened: true };
  } finally {
    await handle.dispose();
  }
}

export async function previewSendCommand(
  ctx: DeliveryContext,
  token: string,
  params: SendParams,
): Promise<unknown> {
  ctx.authority.operator(token, "SEND");
  prepareSendMediaAttachment(ctx.store, ctx.browser.root, params);
  const e = ctx.store.event(params.eventId);
  const handle = await ctx.browser.adapter(e.payload, ctx.store);
  try {
    const snapshot = await ctx.browser.actor.run(async () => {
      await ctx.browser.refreshIdentity(e.payload.channel);
      ctx.authority.assertCanSend(token, params, ctx.browser.identity(e.payload.channel));
      return handle.adapter.inspect(e.payload);
    });
    return {
      ...ctx.authority.preview(token, params, snapshot, ctx.browser.identity(e.payload.channel)),
      params,
      target: e.payload,
      account: snapshot.ownId,
    };
  } finally {
    await handle.dispose();
  }
}

export function sendResultCommand(
  store: EventStore,
  authority: WorkbenchAuthority,
  followups: { turn(id: string): unknown; result(token: string, id: string): unknown },
  token: string,
  id: string,
) {
  if (followups.turn(id)) return followups.result(token, id);
  const row = authority.command(id);
  authority.operator(token);
  return {
    commandId: id,
    status: row.status,
    intentId: row.intent_id,
    reason: row.reason,
    accepted:
      row.status !== "FAILED_BEFORE_CLICK" &&
      !!store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='manual_send_inputs'").get() &&
      !!store.db.prepare(`SELECT 1 FROM manual_send_inputs i JOIN manual_send_commands c ON c.command_id=i.command_id
        JOIN inbound_events e ON e.id=c.event_id WHERE i.command_id=? AND e.account_id=?`).get(id, store.accountId),
  };
}

export async function reconcileUncertainCommand(
  ctx: DeliveryContext,
  token: string,
  eventId: string,
): Promise<unknown> {
  ctx.authority.operator(token, "CONTROL");
  const hasVerificationResults = !!ctx.store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='verification_results'")
    .get();
  const uncertainOriginal = ctx.store.db
    .prepare(
      hasVerificationResults
        ? `SELECT i.id FROM send_intents i WHERE i.event_id=? AND i.status='UNCERTAIN'
           AND COALESCE((SELECT v.verified FROM verification_results v WHERE v.intent_id=i.id ORDER BY v.rowid DESC LIMIT 1), 0) <> 1`
        : "SELECT id FROM send_intents WHERE event_id=? AND status='UNCERTAIN'",
    )
    .get(eventId);
  if (!uncertainOriginal) {
    const uncertainFollowup = findUncertainFollowupForEvent(ctx.store, eventId);
    if (uncertainFollowup) {
      return reconcileUncertainFollowup(ctx.store, ctx.browser, uncertainFollowup, ctx.authority.now, () => {
        ctx.bumpInboxRevision();
        ctx.emit("send_status_updated");
      });
    }
  }
  return ctx.browser.verifyExisting(ctx.store, eventId);
}
