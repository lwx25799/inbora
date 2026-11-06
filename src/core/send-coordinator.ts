import { AccountActor } from '../browser/account-actor.js';
import { EventStore } from '../storage/store.js';
import { digest, requireSafe, proofTimeValid, type ReplyAdapter } from './contracts.js';

export class SendCoordinator {
  constructor(private readonly store: EventStore, private readonly actor: AccountActor) {}
  send(draftId: string, adapter: ReplyAdapter, real: boolean,
    authority?: { check(): void; committed(intentId: string): void }): Promise<'CONFIRMED' | 'UNCERTAIN'> {
    return this.actor.run(async () => {
      authority?.check();
      const draft = this.store.draft(draftId);
      const event = this.store.event(draft.eventId);
      this.store.assertSendable(event.id);
      requireSafe(draft.status === 'APPROVED' && draft.approval, 'APPROVAL_REQUIRED');
      const approved = draft.approval;
      let baseline: string[];
      let final: typeof approved.snapshot;
      try {
        const before = await adapter.inspect(event.payload);
        requireSafe(digest(before) === digest(approved.snapshot), 'TARGET_CHANGED_REAPPROVE');
        await adapter.prepare(event.payload, draft.text);
        const prepared = await adapter.verifyPrepared(event.payload, draft.text);
        requireSafe(digest(prepared) === digest(approved.snapshot), 'TARGET_CHANGED_REAPPROVE');
        baseline = await adapter.baseline(event.payload);
        // Re-read after baseline and immediately before committing the irreversible intent.
        final = await adapter.verifyPrepared(event.payload, draft.text);
        requireSafe(digest(final) === digest(approved.snapshot), 'TARGET_CHANGED_REAPPROVE');
      } catch (error) { this.store.invalidateApproval(draftId); throw error; }
      const intentId = this.store.recordIntent(draftId, final, real, authority);
      try {
        const notBefore = this.store.intentBoundary(intentId);
        // Any error after intent commit is unknown, even if click() reports an error.
        await adapter.clickOnce(notBefore);
        const proof = await adapter.readback(event.payload, draft.text, baseline, notBefore);
        const valid = proof && proof.id && !baseline.includes(proof.id) && !proof.pending &&
          proof.ownId === final.ownId && proof.targetKey === final.targetKey && proof.text === draft.text &&
          proofTimeValid(proof,notBefore);
        if (!valid) {
          this.store.receipt(intentId, 'UNCERTAIN', 'NO_UNIQUE_BOUND_PROOF');
          return 'UNCERTAIN';
        }
        this.store.receipt(intentId, 'CONFIRMED', digest(proof),proof);
        return 'CONFIRMED';
      } catch {
        // A receipt write failure leaves the committed intent for restart recovery.
        this.store.receipt(intentId, 'UNCERTAIN', 'POST_INTENT_FAILURE');
        return 'UNCERTAIN';
      }
    });
  }
}
