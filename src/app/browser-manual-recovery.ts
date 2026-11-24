import type {BrowserProfileOwner} from '../browser/profile-owner.js';
import {ManualRecovery} from '../browser/manual-recovery.js';
import {Blocked,digest,requireSafe} from '../core/contracts.js';
import {isSecurityFailure} from '../adapters/security-signal.js';
import {securityCandidateCodes} from '../core/emergency-stop.js';
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
  private recreated=false;
  private permitted:()=>void=()=>{};
  onClosed:()=>void=()=>{};
  constructor(private readonly root:string,private readonly store:EventStore,private readonly safety:BrowserSafety,
    private readonly binding:()=>BrowserBinding){
    this.controller=new ManualRecovery(()=>{this.requester=null;this.mappingDigest=null;this.recreated=false;this.onClosed();});
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
        return {...await this.controller.resume(permitted),...(this.recreated?{recreated:true}:{})};
      }
      requireSafe(!this.active,'MANUAL_RECOVERY_ALREADY_ACTIVE');
      this.starting=true;
      try{
      const current=this.binding();let hold=readSecurityHold(this.store,command.channel);
      requireSafe(current.owner&&current.mode==='headless'&&!current.transitioning,'MANUAL_RECOVERY_HEADLESS_REQUIRED');
      requireSafe(hold,'MANUAL_RECOVERY_INCIDENT_REQUIRED');
      let incident=await this.safety.incidents.readRecovery(hold.incidentId);
      const mapping=await loadObservationMapping(this.root);
      permitted();
      let original=incident?.initial??incident?.afterFailure;
      if(!original&&incident?.fromFallback&&mapping&&incident.channel===command.channel&&incident.context.mode==='headless'){
        original={version:1,state:'SUSPECT',href:mapping.entryUrl,origin:mapping.origin,title:'',
          documentStartedAt:0,observedAt:incident.createdAt,kind:'COMPONENT',scope:'ACCOUNT_PAGE',matches:[],frames:[]};
      }
      requireSafe(original&&incident?.channel===command.channel&&incident.context.mode==='headless',
      'MANUAL_RECOVERY_ORIGINAL_PAGE_UNAVAILABLE');
      requireSafe(mapping&&incident.context.mappingDigest===digest(mapping)&&original.origin===mapping.origin,
        'MANUAL_RECOVERY_MAPPING_CHANGED');
      requireSafe(!hold.documentDigest||hold.documentDigest===digest([original.href,original.documentStartedAt])||
        incident.fromFallback&&incident.documentDigest===hold.documentDigest,
        'MANUAL_RECOVERY_ORIGINAL_PAGE_UNAVAILABLE');
      const previousHold=hold,stopRevision=securityRevision(this.store,command.channel).split(':')[1];
      const unchanged=()=>{
        permitted();const actual=this.binding();
        requireSafe(actual.owner===current.owner&&actual.epoch===current.epoch&&actual.mode==='headless'&&!actual.transitioning,
          'MANUAL_RECOVERY_ORIGINAL_PAGE_UNAVAILABLE');
        requireSafe(securityRevision(this.store,command.channel).split(':')[1]===stopRevision,'MANUAL_RECOVERY_SECURITY_CHANGED');
      };
      const document=await current.owner.actor.run(async()=>{unchanged();
        requireSafe(readSecurityHold(this.store,command.channel)?.revision===previousHold.revision,'MANUAL_RECOVERY_SECURITY_CHANGED');
        return (command.channel==='DIRECT_MESSAGE'?current.owner!.dm:current.owner!.notification)
          .evaluate(()=>({href:location.href,started:performance.timeOrigin}));});
      unchanged();
      let targetDoc:{href:string;started:number}={href:original.href,started:original.documentStartedAt};
      const recreated=!incident.sameDocument||incident.context.epoch!==current.epoch||incident.context.instanceId!==this.safety.instanceId||
        document.href!==original.href||document.started!==original.documentStartedAt;
      if(recreated){
        try{
          const clear=await this.safety.recover(current.owner,command.channel,AbortSignal.timeout(30_000),true,false,false,unchanged);unchanged();
          requireSafe(clear&&readSecurityHold(this.store,command.channel)?.revision===previousHold.revision,'MANUAL_RECOVERY_SECURITY_CHANGED');
          requireSafe(resolveSecurityHold(this.store,command.channel,previousHold.revision),'MANUAL_RECOVERY_SECURITY_CHANGED');
          this.store.audit('SECURITY_MANUAL_RECOVERY_RECHECK_CLEAR',previousHold.incidentId);
          return{state:'CLEARED'};
        }catch(error){
          unchanged();
          if(!isSecurityFailure(error)&&!(error instanceof Blocked&&securityCandidateCodes.has(error.code)))throw error;
          hold=readSecurityHold(this.store,command.channel);
          requireSafe(hold&&hold.revision!==previousHold.revision,'MANUAL_RECOVERY_ORIGINAL_PAGE_UNAVAILABLE');
          incident=await this.safety.incidents.readRecovery(hold.incidentId);original=incident?.initial??incident?.afterFailure;
          if(incident?.fromFallback){
            requireSafe(original&&incident.context.epoch===current.epoch&&incident.context.instanceId===this.safety.instanceId,
              'MANUAL_RECOVERY_ORIGINAL_PAGE_UNAVAILABLE');
            const live=await current.owner.actor.run(async()=>{unchanged();
              requireSafe(readSecurityHold(this.store,command.channel)?.revision===hold!.revision,'MANUAL_RECOVERY_SECURITY_CHANGED');
              return (command.channel==='DIRECT_MESSAGE'?current.owner!.dm:current.owner!.notification)
                .evaluate(()=>({href:location.href,started:performance.timeOrigin}));});
            unchanged();
            const liveBase=live.href.split(/[?#]/u,1)[0];
            requireSafe(liveBase===original.href&&live.started===original.documentStartedAt&&
              (!hold.documentDigest||digest([live.href,live.started])===hold.documentDigest),'MANUAL_RECOVERY_ORIGINAL_PAGE_UNAVAILABLE');
            targetDoc=live;
          }else{
            requireSafe(original&&incident?.sameDocument&&incident.context.epoch===current.epoch&&
              incident.context.instanceId===this.safety.instanceId,'MANUAL_RECOVERY_ORIGINAL_PAGE_UNAVAILABLE');
            targetDoc={href:original.href,started:original.documentStartedAt};
          }
        }
      }
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
      this.permitted=permitted;check();this.requester=token;this.mappingDigest=digest(mapping);this.recreated=recreated;
      try{const session=await this.controller.start(current.owner,{channel:command.channel,epoch:current.epoch,
        incidentId:hold.incidentId,revision:hold.revision,document:targetDoc,
        selectors:[mapping.securityBlockers],check});
        this.store.audit('SECURITY_MANUAL_RECOVERY_STARTED',hold.incidentId,{recreated});
        return {...session,...(recreated?{recreated:true}:{})};}
      catch(error){this.requester=null;this.mappingDigest=null;throw error;}
      }catch(error){
        const code=error instanceof Blocked&&/^[A-Z_]{1,100}$/u.test(error.code)?error.code:'OPERATION_FAILED_PRIVATE_DIAGNOSTICS';
        this.store.audit('SECURITY_MANUAL_RECOVERY_START_FAILED_'+code,command.channel);throw error;
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
