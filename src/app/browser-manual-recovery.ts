import type {BrowserProfileOwner} from '../browser/profile-owner.js';
import {ManualRecovery} from '../browser/manual-recovery.js';
import {digest,requireSafe} from '../core/contracts.js';
import {loadObservationMapping} from '../config/runtime.js';
import type {EventStore} from '../storage/store.js';
import {readSecurityHold,securityRevision,resolveSecurityHold} from '../storage/security-holds.js';
import type {BrowserSafety} from './browser-safety.js';
import type {ManualRecoveryCommand} from './manual-recovery-contracts.js';

interface BrowserBinding {owner:BrowserProfileOwner|undefined;epoch:number;mode:'headed'|'headless';transitioning:boolean}

/** GUI-only authority and incident binding around the existing account actor's human lease. */
export class BrowserManualRecovery {
  private readonly controller:ManualRecovery;
  private requester:string|null=null;
  private mappingDigest:string|null=null;
  private starting=false;
  private permitted:()=>void=()=>{};
  onClosed:()=>void=()=>{};
  constructor(private readonly root:string,private readonly store:EventStore,private readonly safety:BrowserSafety,
    private readonly binding:()=>BrowserBinding){
    this.controller=new ManualRecovery(()=>{this.requester=null;this.mappingDigest=null;this.onClosed();});
  }
  get active(){return this.starting||this.controller.active;}
  status(){return this.controller.status();}
  shutdown(){return this.controller.shutdown();}
  async handle(command:ManualRecoveryCommand,token:string,permitted:()=>void):Promise<unknown>{
    permitted();
    if(command.action==='close'){
      requireSafe(this.requester===null||this.requester===token,'MANUAL_RECOVERY_OPERATOR_CHANGED');
      await this.controller.close(command.sessionId,permitted);return;
    }
    if(command.action==='start'){
      if(this.controller.active){
        requireSafe(this.controller.status()?.channel===command.channel,'MANUAL_RECOVERY_ALREADY_ACTIVE');
        const mapping=await loadObservationMapping(this.root).catch(()=>null);
        if(!mapping||digest(mapping)!==this.mappingDigest){await this.shutdown();requireSafe(false,'MANUAL_RECOVERY_MAPPING_CHANGED');}
        this.requester=token;this.permitted=permitted;
        return this.controller.resume(permitted);
      }
      requireSafe(!this.active,'MANUAL_RECOVERY_ALREADY_ACTIVE');
      this.starting=true;
      try{
      const current=this.binding(),hold=readSecurityHold(this.store,command.channel);
      requireSafe(current.owner&&current.mode==='headless'&&!current.transitioning,'MANUAL_RECOVERY_HEADLESS_REQUIRED');
      requireSafe(hold,'MANUAL_RECOVERY_INCIDENT_REQUIRED');
      const incident=await this.safety.incidents.read(hold.incidentId),mapping=await loadObservationMapping(this.root);
      permitted();
      const original=incident?.initial??incident?.afterFailure;
      requireSafe(incident?.sameDocument&&original&&incident.channel===command.channel&&incident.context.mode==='headless'&&
        incident.context.epoch===current.epoch&&incident.context.instanceId===this.safety.instanceId,
      'MANUAL_RECOVERY_ORIGINAL_PAGE_UNAVAILABLE');
      requireSafe(mapping&&incident.context.mappingDigest===digest(mapping)&&original.origin===mapping.origin,
        'MANUAL_RECOVERY_MAPPING_CHANGED');
      requireSafe(!hold.documentDigest||hold.documentDigest===digest([original.href,original.documentStartedAt]),
        'MANUAL_RECOVERY_ORIGINAL_PAGE_UNAVAILABLE');
      const revision=securityRevision(this.store,command.channel),ownId=mapping.self.uid;
      const check=()=>{
        this.permitted();const actual=this.binding();
        requireSafe(actual.owner===current.owner&&actual.epoch===current.epoch&&actual.mode==='headless'&&!actual.transitioning,
          'MANUAL_RECOVERY_ORIGINAL_PAGE_UNAVAILABLE');
        requireSafe(readSecurityHold(this.store,command.channel)?.revision===hold.revision&&
          securityRevision(this.store,command.channel)===revision,'MANUAL_RECOVERY_SECURITY_CHANGED');
        const own=this.store.db.prepare("SELECT own_id FROM accounts WHERE id='account_001'").get() as {own_id:string}|undefined;
        requireSafe(own?.own_id===ownId,'ACCOUNT_CHANGED');
      };
      this.permitted=permitted;check();this.requester=token;this.mappingDigest=digest(mapping);
      try{return await this.controller.start(current.owner,{channel:command.channel,epoch:current.epoch,
        incidentId:hold.incidentId,revision:hold.revision,document:{href:original.href,started:original.documentStartedAt},
        selectors:[mapping.securityBlockers],check});}
      catch(error){this.requester=null;this.mappingDigest=null;throw error;}
      }finally{this.starting=false;}
    }
    requireSafe(this.requester===token,'MANUAL_RECOVERY_OPERATOR_CHANGED');
    const mapping=await loadObservationMapping(this.root).catch(()=>null);permitted();
    if(!mapping||digest(mapping)!==this.mappingDigest){
      await this.shutdown();requireSafe(false,'MANUAL_RECOVERY_MAPPING_CHANGED');
    }
    if(command.action==='frame')return this.controller.frame(command.sessionId,permitted);
    if(command.action==='input')return this.controller.input(command.sessionId,command.frameId,command.sequence,command.input,permitted);
    const current=this.binding(),session=this.controller.status();
    requireSafe(current.owner&&session,'MANUAL_RECOVERY_SESSION_EXPIRED');
    await this.controller.finish(command.sessionId,permitted,async()=>{
      const hold=readSecurityHold(this.store,session.channel);requireSafe(hold,'MANUAL_RECOVERY_SECURITY_CHANGED');
      requireSafe(await this.safety.recover(current.owner!,session.channel,undefined,true,true,false),'SECURITY_RECOVERY_NOT_VERIFIED');
      return()=>requireSafe(resolveSecurityHold(this.store,session.channel,hold.revision),'MANUAL_RECOVERY_SECURITY_CHANGED');
    });
  }
}
