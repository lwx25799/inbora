import { AccountActor } from '../browser/account-actor.js';
import { EventStore } from '../storage/store.js';
import { Blocked, digest, requireSafe, proofTimeValid, type ReplyAdapter } from './contracts.js';

// Only fixed internal codes may enter a receipt; arbitrary browser errors can contain private text.
const postIntentCodes=new Set(['NATIVE_REPLY_CLICK_BLOCKED','NATIVE_REPLY_NOT_PREPARED','NATIVE_REPLY_ACK_REVOKED',
  'NATIVE_REPLY_EXISTING_DRAFT','NATIVE_REPLY_RECEIPT_AMBIGUOUS','NATIVE_REPLY_DOM_CHANGED','NATIVE_REPLY_ORIGINAL_CHANGED',
  'NATIVE_REPLY_CONVERSATION_CHANGED','NATIVE_REPLY_ACCOUNT_CHANGED','NATIVE_REPLY_PAGE_BLOCKED',
  'OBSERVATION_ROW_CHANGED','OBSERVATION_ROW_IDENTITY_CONFLICT','OBSERVATION_ROW_SELECTION_BLOCKED',
  'OBSERVATION_ACCOUNT_CHANGED','OBSERVATION_PAGE_BLOCKED','OBSERVATION_CONVERSATION_NOT_FOUND',
  'OBSERVATION_UNEXPECTED_ORIGIN','OBSERVATION_SECURITY_TITLE','OBSERVATION_SECURITY_COMPONENT',
  'OBSERVATION_CONVERSATION_NOT_UNIQUE','OBSERVATION_DOM_NOT_READY','OBSERVATION_METADATA_NOT_READY',
  'RENDERED_BINDING_UNAVAILABLE','COMMENT_REPLY_CLICK_BLOCKED','COMMENT_REPLY_ACK_REVOKED',
  'COMMENT_REPLY_CLOCK_UNVERIFIED','COMMENT_REPLY_EXISTING_DRAFT','COMMENT_REPLY_REFRESH_NOT_READY','COMMENT_REPLY_LIST_NOT_UNIQUE']);

export class SendCoordinator {
  constructor(private readonly store: Pick<EventStore,'draft'|'event'|'assertSendable'|'audit'|'recordIntent'|'intentBoundary'|'receipt'|'invalidateApproval'|'hasIntentForDraft'>, private readonly actor: AccountActor) {}
  send(draftId: string, adapter: ReplyAdapter, real: boolean,
    authority?: { check(): void; committed(intentId: string): void;manualMedia?():void }): Promise<'CONFIRMED' | 'UNCERTAIN'> {
    return this.actor.run(async () => {
      authority?.check();
      const draft = this.store.draft(draftId);
      const event = this.store.event(draft.eventId);
      this.store.assertSendable(event.id);
      requireSafe(draft.status === 'APPROVED' && draft.approval, 'APPROVAL_REQUIRED');
      const approved = draft.approval;
      const unchanged=(snapshot:typeof approved.snapshot,stage:'INSPECT'|'PREPARED'|'FINAL'):boolean=>{
        if(digest(snapshot)===digest(approved.snapshot))return true;
        for(const [field,code] of [['accountId','ACCOUNT'],['ownId','SELF'],['targetKey','TARGET'],['eventBinding','EVENT'],
          ['composerKey','COMPOSER'],['contextDigest','CONTEXT'],['mappingDigest','MAPPING'],['manualObservation','MEDIA']] as const)
          if(digest(snapshot[field]??null)!==digest(approved.snapshot[field]??null))this.store.audit(`SEND_RECHECK_${stage}_${code}_CHANGED`,draftId);
        return false;
      };
      let baseline: string[];
      let final: typeof approved.snapshot;
      let intentId:string;
      try {
        const before = await adapter.inspect(event.payload);
        requireSafe(unchanged(before,'INSPECT'), 'TARGET_CHANGED_REAPPROVE');
        await adapter.prepare(event.payload, draft.text);
        const prepared = await adapter.verifyPrepared(event.payload, draft.text);
        requireSafe(unchanged(prepared,'PREPARED'), 'TARGET_CHANGED_REAPPROVE');
        baseline = await adapter.baseline(event.payload);
        // Re-read after baseline and immediately before committing the irreversible intent.
        final = await adapter.verifyPrepared(event.payload, draft.text);
        requireSafe(unchanged(final,'FINAL'), 'TARGET_CHANGED_REAPPROVE');
        intentId=this.store.recordIntent(draftId,final,real,authority);
      } catch (error) {
        if(!this.store.hasIntentForDraft(draft.id)){
          try{await adapter.cancelPreparation?.(event.payload,draft.text);}catch{this.store.audit('PREPARATION_DISCARD_FAILED',draftId);}
          this.store.invalidateApproval(draftId);
        }
        throw error;
      }
      let phase='DISPATCH';
      try {
        const notBefore = this.store.intentBoundary(intentId);
        // Any error after intent commit is unknown, even if click() reports an error.
        await adapter.clickOnce(notBefore);
        phase='READBACK';
        const proof = await adapter.readback(event.payload, draft.text, baseline, notBefore);
        const valid = proof && proof.id && !baseline.includes(proof.id) && !proof.pending &&
          proof.ownId === final.ownId && proof.targetKey === final.targetKey && proof.text === draft.text &&
          (!proof.clockSkew||proof.clockSkew.baselineContextDigest===final.contextDigest)&&
          proofTimeValid(proof,notBefore);
        if (!valid) {
          this.store.receipt(intentId, 'UNCERTAIN', 'NO_UNIQUE_BOUND_PROOF');
          return 'UNCERTAIN';
        }
        this.store.receipt(intentId, 'CONFIRMED', digest(proof),proof);
        return 'CONFIRMED';
      } catch (error) {
        // A receipt write failure leaves the committed intent for restart recovery.
        const code=error instanceof Blocked&&postIntentCodes.has(error.code)?error.code:
          error instanceof Error&&error.name==='TimeoutError'?'BROWSER_TIMEOUT':'UNCLASSIFIED';
        this.store.receipt(intentId, 'UNCERTAIN', `POST_INTENT_FAILURE:${phase}:${code}`);
        return 'UNCERTAIN';
      }
    });
  }
}
