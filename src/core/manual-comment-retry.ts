import type {AccountSerialExecutor} from '../platform/platform-connector.js';
import {assertSecurityRevision,securityRevision} from '../storage/security-holds.js';
import {EventStore} from '../storage/store.js';
import {digest,requireSafe,proofTimeValid,type ReplyAdapter} from './contracts.js';

/** Explicit human-only exception; original unknown intent and normal-send freeze are never cleared. */
export class ManualCommentRetry{
  constructor(private readonly store:EventStore,private readonly actor:AccountSerialExecutor){}
  send(grantId:string,adapter:ReplyAdapter,real:boolean):Promise<'CONFIRMED'|'UNCERTAIN'>{
    return this.actor.run(async()=>{
      const grant=this.store.assertCommentRetryAvailable(grantId),draft=this.store.draft(grant.draftId),event=this.store.event(grant.eventId);
      requireSafe(draft.version===grant.version&&digest(draft.text)===grant.textDigest,'MANUAL_RETRY_BINDING_CHANGED');
      const channel=event.payload.channel,revision=securityRevision(this.store,channel);
      const checkSecurity=()=>assertSecurityRevision(this.store,channel,revision);
      let before:string[],id:string,final:Awaited<ReturnType<ReplyAdapter['verifyPrepared']>>;
      try{
        requireSafe(digest(await adapter.inspect(event.payload))===grant.snapshotDigest,'TARGET_CHANGED_REAPPROVE');
        await adapter.prepare(event.payload,draft.text);
        requireSafe(digest(await adapter.verifyPrepared(event.payload,draft.text))===grant.snapshotDigest,'TARGET_CHANGED_REAPPROVE');
        before=await adapter.baseline(event.payload);final=await adapter.verifyPrepared(event.payload,draft.text);
        requireSafe(digest(final)===grant.snapshotDigest,'TARGET_CHANGED_REAPPROVE');
        checkSecurity();
        id=this.store.recordCommentRetryIntent(grantId,final,real);
      }catch(error){
        try{await adapter.cancelPreparation?.(event.payload,draft.text);}catch{this.store.audit('PREPARATION_DISCARD_FAILED',draft.id);}
        this.store.revokeCommentRetry(grantId);throw error;
      }
      try{
        const checkSubmit=()=>{checkSecurity();this.store.assertCommentRetryAvailable(grantId,id);};
        const notBefore=this.store.commentRetryBoundary(id);checkSubmit();await adapter.clickOnce(notBefore,checkSubmit);
        const proof=await adapter.readback(event.payload,draft.text,before,notBefore);
        const valid=proof&&proof.id&&!before.includes(proof.id)&&!proof.pending&&proof.ownId===final.ownId&&
          proof.targetKey===final.targetKey&&proof.text===draft.text&&proofTimeValid(proof,notBefore);
        const result=valid?'CONFIRMED':'UNCERTAIN';this.store.commentRetryReceipt(id,result,valid?digest(proof):'NO_UNIQUE_BOUND_PROOF',valid?proof:undefined);return result;
      }catch{this.store.commentRetryReceipt(id,'UNCERTAIN','POST_RETRY_INTENT_FAILURE');return'UNCERTAIN';}
    });
  }
}
