import {digest,requireSafe,targetKey,isManualMediaCandidate,validManualMediaProof} from '../core/contracts.js';
import {humanReplyEligibility} from './manual-reply-eligibility.js';
import type {EventStore} from '../storage/store.js';
import type {WorkbenchAuthority} from './authority.js';
import type {BrowserService} from './browser-service.js';
import {humanReplySchema,type SendParams} from './contracts.js';
import type {z} from 'zod';

/** One explicit human request, durable latest text, backend qualification, then the shared send coordinator. */
export class HumanReplyWorkflow {
  constructor(readonly store:EventStore,readonly authority:WorkbenchAuthority,readonly browser:BrowserService,
    readonly isClosing:()=>boolean,readonly deliver:(token:string,id:string,params:SendParams)=>Promise<void>,
    readonly emit:(event:string)=>void,readonly errorCode:(error:unknown)=>string){}
  queue(token:string,id:string,input:z.infer<typeof humanReplySchema>):boolean {
    this.authority.operator(token,'SEND');
    return this.store.db.transaction(()=>{
      const previous=this.store.db.prepare('SELECT input_digest FROM manual_send_inputs WHERE command_id=?').get(id) as {input_digest:string}|undefined;
      if(previous){requireSafe(previous.input_digest===digest(input),'COMMAND_PARAMETERS_CONFLICT');return false;}
      this.authority.requireSelection(token,input.eventId,input.selectionId);
      const event=this.store.event(input.eventId);
      if(isManualMediaCandidate(event.payload))requireSafe(humanReplyEligibility(this.store,event,false).eligible,'TARGET_NEEDS_REVIEW');
      this.authority.requireOwner(token,event,input.generation);
      requireSafe(this.authority.contextVersion(event)===input.contextVersion,'CONTEXT_VERSION_CONFLICT');
      const old=this.authority.draftFor(input.eventId);
      requireSafe((old?.version??0)===input.expectedVersion,'DRAFT_VERSION_CONFLICT');
      const draft=old&&old.text===input.text&&!input.suggestionId?old:this.authority.save(token,input.eventId,input.generation,input.expectedVersion,input.text,input.suggestionId);
      const params:SendParams={eventId:input.eventId,generation:input.generation,draftId:draft.id,draftVersion:draft.version,
        text:draft.text,contextVersion:input.contextVersion,selectionId:input.selectionId};
      this.store.db.prepare('INSERT INTO manual_send_commands VALUES(?,?,?,?,?,?,?,?,?)').run(id,event.id,this.authority.operator(token).id,
        digest(params),JSON.stringify(params),'PREPARING',null,null,this.authority.now());
      this.store.db.prepare('INSERT INTO manual_send_inputs VALUES(?,?)').run(id,digest(input));
      this.authority.assertCanSend(token,params,this.browser.identity(event.payload.channel),false,id,true);
      this.store.audit('HUMAN_SEND_REQUESTED',id);
      return true;
    }).immediate();
  }
  async prepare(token:string,id:string):Promise<void> {
    const row=this.authority.command(id),params=JSON.parse(row.params) as SendParams,event=this.store.event(params.eventId);
    let dispose=()=>{};
    try {
      const manualMedia=isManualMediaCandidate(event.payload)&&!!this.store.db.prepare('SELECT command_id FROM manual_send_inputs WHERE command_id=?').get(id)&&
        !this.store.db.prepare('SELECT command_id FROM policy_commands WHERE command_id=?').get(id);
      const handle=await this.browser.adapter(event.payload,this.store,undefined,{manualMedia});dispose=handle.dispose;
      await this.browser.refreshIdentity(event.payload.channel);
      await this.browser.actor.run(async()=>{
        requireSafe(!this.isClosing(),'CLIENT_CLOSING');
        requireSafe(this.authority.command(id).status==='PREPARING','COMMAND_NOT_QUEUED');
        this.authority.assertCanSend(token,params,this.browser.identity(event.payload.channel),false,id,true);
        const priorIdentity=digest(this.browser.identity(event.payload.channel));
        const before=digest(this.store.db.prepare('SELECT * FROM channel_capabilities WHERE channel=?').all(event.payload.channel));
        const snapshot=await handle.adapter.inspect(event.payload);
        requireSafe(!this.isClosing(),'CLIENT_CLOSING');
        requireSafe(this.authority.command(id).status==='PREPARING','COMMAND_NOT_QUEUED');
        this.authority.assertCanSend(token,params,this.browser.identity(event.payload.channel),false,id,true);
        const identity=await this.browser.refreshIdentity(event.payload.channel);
        requireSafe(digest(identity)===priorIdentity,'CAPABILITY_CHANGED_DURING_CHECK');
        const account=this.store.db.prepare("SELECT own_id FROM accounts WHERE id='account_001'").get() as {own_id:string};
        requireSafe(identity&&snapshot.ownId===account.own_id&&identity.identityDigest===digest(account.own_id)&&snapshot.accountId===event.payload.accountId&&
          snapshot.eventBinding===event.binding&&snapshot.targetKey===targetKey(event.payload)&&snapshot.composerKey===snapshot.targetKey,'TARGET_CHANGED');
        if(manualMedia)requireSafe(validManualMediaProof(event.payload,snapshot),'HUMAN_MEDIA_APPROVAL_REQUIRED');
        requireSafe(before===digest(this.store.db.prepare('SELECT * FROM channel_capabilities WHERE channel=?').all(event.payload.channel)),'CAPABILITY_CHANGED_DURING_CHECK');
        this.authority.attest(event.payload.channel,'SEND_AVAILABLE',identity,`readonly-contract:${digest(snapshot.manualObservation?[snapshot,identity]:snapshot)}`);
        this.store.audit('READ_ONLY_SEND_CONTRACT_VERIFIED',id);
        this.authority.approvePreparedCommand(token,id,snapshot,identity);
      });
      dispose();dispose=()=>{};
      await this.deliver(token,id,params);
    }catch(error){
      if(this.authority.command(id).intent_id===null)this.authority.finish(id,'FAILED_BEFORE_CLICK',this.errorCode(error));
      this.emit('send_status_updated');
    }finally{dispose();}
  }
}
