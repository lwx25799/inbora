import {AccountActor} from '../browser/account-actor.js';
import {EventStore} from '../storage/store.js';
import {digest,requireSafe,type ReplyAdapter} from './contracts.js';

/** Explicit human-only exception; original unknown intent and normal-send freeze are never cleared. */
export class ManualCommentRetry{
  constructor(private readonly store:EventStore,private readonly actor:AccountActor){}
  send(grantId:string,adapter:ReplyAdapter,real:boolean):Promise<'CONFIRMED'|'UNCERTAIN'>{
    return this.actor.run(async()=>{
      const grant=this.store.assertCommentRetryAvailable(grantId),draft=this.store.draft(grant.draftId),event=this.store.event(grant.eventId);
      requireSafe(draft.version===grant.version&&digest(draft.text)===grant.textDigest,'MANUAL_RETRY_BINDING_CHANGED');
      let before:string[],final:Awaited<ReturnType<ReplyAdapter['verifyPrepared']>>;
      try{
        requireSafe(digest(await adapter.inspect(event.payload))===grant.snapshotDigest,'TARGET_CHANGED_REAPPROVE');
        await adapter.prepare(event.payload,draft.text);
        requireSafe(digest(await adapter.verifyPrepared(event.payload,draft.text))===grant.snapshotDigest,'TARGET_CHANGED_REAPPROVE');
        before=await adapter.baseline(event.payload);final=await adapter.verifyPrepared(event.payload,draft.text);
        requireSafe(digest(final)===grant.snapshotDigest,'TARGET_CHANGED_REAPPROVE');
      }catch(error){this.store.revokeCommentRetry(grantId);throw error;}
      const id=this.store.recordCommentRetryIntent(grantId,final,real);
      try{
        const notBefore=this.store.commentRetryBoundary(id);await adapter.clickOnce();
        const proof=await adapter.readback(event.payload,draft.text,before,notBefore);
        const valid=proof&&proof.id&&!before.includes(proof.id)&&!proof.pending&&proof.ownId===final.ownId&&
          proof.targetKey===final.targetKey&&proof.text===draft.text&&Number.isFinite(Date.parse(proof.sentAt))&&
          Date.parse(proof.sentAt)>Date.parse(notBefore)&&Date.parse(proof.sentAt)<=Date.now();
        const result=valid?'CONFIRMED':'UNCERTAIN';this.store.commentRetryReceipt(id,result,valid?digest(proof):'NO_UNIQUE_BOUND_PROOF');return result;
      }catch{this.store.commentRetryReceipt(id,'UNCERTAIN','POST_RETRY_INTENT_FAILURE');return'UNCERTAIN';}
    });
  }
}
