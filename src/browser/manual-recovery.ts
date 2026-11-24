import {randomUUID} from 'node:crypto';
import type {ElementHandle,Frame,Page} from 'playwright';
import type {BrowserProfileOwner} from './profile-owner.js';
import {requireSafe,type Channel} from '../core/contracts.js';
import {manualRecoveryInputSchema,type ManualRecoveryFrame,type ManualRecoveryInput,
  type ManualRecoveryRegion,type ManualRecoverySession} from '../app/manual-recovery-contracts.js';
import {inspectManualRecoveryElement,manualRecoveryElements} from './manual-recovery-dom.js';

export interface ManualRecoveryOptions {
  channel:Channel;epoch:number;incidentId:string;revision:string;
  document:{href:string;started:number};selectors:string[];check:()=>void;
}
interface FrameBinding {
  id:string;expiresAt:number;
  nodes:{element:ElementHandle<Element>;region:ManualRecoveryRegion;child:Frame|null;childEpoch:number}[];
}
interface Lease {
  session:ManualRecoverySession;options:ManualRecoveryOptions;page:Page;
  release:()=>void;queue:Promise<void>;frames:FrameBinding[];sequence:number;
  pressed:boolean;invalid:boolean;startedAt:number;lastActivity:number;
  timer:ReturnType<typeof setInterval>|undefined;detach:()=>void;
  childEpochs:WeakMap<Frame,number>;
}
const idleTimeout=5*60_000,maximumDuration=15*60_000,frameLifetime=12_000;

/** An account-actor task owns the original page until this human session ends. */
export class ManualRecovery {
  private lease:Lease|undefined;
  private pending=false;
  private generation=0;
  constructor(private readonly onClosed:()=>void=()=>{},private readonly frameLifetimeMs=frameLifetime){}
  get active():boolean{return this.pending||!!this.lease;}
  status():{active:true;channel:Channel;incidentId:string}|null{
    return this.lease?{active:true,channel:this.lease.session.channel,incidentId:this.lease.session.incidentId}:null;
  }
  async start(owner:BrowserProfileOwner,options:ManualRecoveryOptions):Promise<ManualRecoverySession>{
    requireSafe(!this.active,'MANUAL_RECOVERY_ALREADY_ACTIVE');
    options.check();this.pending=true;const generation=++this.generation;
    let resolve!:(value:ManualRecoverySession)=>void,reject!:(error:unknown)=>void;
    const ready=new Promise<ManualRecoverySession>((done,failed)=>{resolve=done;reject=failed;});
    void owner.actor.run(async()=>{
      requireSafe(generation===this.generation,'MANUAL_RECOVERY_SESSION_EXPIRED');
      options.check();const page=options.channel==='DIRECT_MESSAGE'?owner.dm:owner.notification;
      await this.document(page,options.document);options.check();
      requireSafe(generation===this.generation,'MANUAL_RECOVERY_SESSION_EXPIRED');
      let release!:()=>void;const held=new Promise<void>(done=>{release=done;});
      const session={sessionId:randomUUID(),channel:options.channel,incidentId:options.incidentId};
      const lease:Lease={session,options,page,release,queue:Promise.resolve(),frames:[],sequence:0,
        pressed:false,invalid:false,startedAt:Date.now(),lastActivity:Date.now(),timer:undefined,detach:()=>{},childEpochs:new WeakMap()};
      const navigation=(frame:Frame)=>{
        if(frame===page.mainFrame())this.expire(lease);
        else{
          lease.childEpochs.set(frame,(lease.childEpochs.get(frame)??0)+1);
          if(lease.pressed)void this.enqueue(lease,()=>this.releasePointer(lease));
        }
      };
      const closed=()=>this.expire(lease);
      page.on('framenavigated',navigation);page.once('close',closed);
      lease.detach=()=>{page.off('framenavigated',navigation);page.off('close',closed);};
      lease.timer=setInterval(()=>{
        try{lease.options.check();}
        catch{this.expire(lease);return;}
        if(Date.now()-lease.lastActivity>=idleTimeout||Date.now()-lease.startedAt>=maximumDuration)this.expire(lease);
      },1000);lease.timer.unref();
      this.lease=lease;this.pending=false;resolve(session);
      await held;
    }).catch(error=>{if(generation===this.generation)this.pending=false;reject(error);});
    return ready;
  }
  private async document(page:Page,expected:ManualRecoveryOptions['document']):Promise<{width:number;height:number}>{
    requireSafe(!page.isClosed(),'MANUAL_RECOVERY_BROWSER_CLOSED');
    const actual=await page.evaluate(()=>({href:location.href,started:performance.timeOrigin,width:innerWidth,height:innerHeight}));
    requireSafe(actual.href===expected.href&&actual.started===expected.started,'MANUAL_RECOVERY_ORIGINAL_PAGE_UNAVAILABLE');
    return{width:actual.width,height:actual.height};
  }
  private current(id:string):Lease{
    const lease=this.lease;
    requireSafe(lease&&!lease.invalid&&lease.session.sessionId===id,'MANUAL_RECOVERY_SESSION_EXPIRED');
    return lease;
  }
  private session(lease:Lease,id:string):void{
    requireSafe(this.lease===lease&&!lease.invalid&&lease.session.sessionId===id,'MANUAL_RECOVERY_SESSION_EXPIRED');
  }
  private async check(lease:Lease,check:()=>void,id:string):Promise<void>{
    this.session(lease,id);
    lease.options.check();check();
    requireSafe(Date.now()-lease.lastActivity<idleTimeout&&Date.now()-lease.startedAt<maximumDuration,'MANUAL_RECOVERY_SESSION_EXPIRED');
    await this.document(lease.page,lease.options.document);
    this.session(lease,id);
    lease.options.check();check();
  }
  private enqueue<T>(lease:Lease,operation:()=>Promise<T>):Promise<T>{
    const result=lease.queue.then(operation);
    lease.queue=result.then(()=>{},()=>{});return result;
  }
  private async disposeFrame(frame:FrameBinding):Promise<void>{
    await Promise.all(frame.nodes.map(node=>node.element.dispose().catch(()=>{})));
  }
  private async releasePointer(lease:Lease):Promise<void>{
    if(!lease.pressed)return;lease.pressed=false;
    // Release away from all page controls, including when navigation or challenge removal occurred.
    await lease.page.mouse.move(-10,-10).catch(()=>{});
    await lease.page.mouse.up().catch(()=>{});
  }
  private async cleanup(lease:Lease):Promise<void>{
    lease.invalid=true;lease.detach();if(lease.timer)clearInterval(lease.timer);
    try{
      await this.releasePointer(lease);
      await Promise.all(lease.frames.splice(0).map(frame=>this.disposeFrame(frame)));
    }finally{
      const current=this.lease===lease;
      if(current)this.lease=undefined;
      lease.release();
      if(current){try{this.onClosed();}catch{/* Cleanup must always release the actor, including a failing status listener. */}}
    }
  }
  private expire(lease:Lease):void{
    if(lease.invalid)return;lease.invalid=true;
    void this.enqueue(lease,()=>this.cleanup(lease));
  }
  async resume(check:()=>void):Promise<ManualRecoverySession>{
    const lease=this.lease;requireSafe(lease&&!lease.invalid,'MANUAL_RECOVERY_SESSION_EXPIRED');
    const oldId=lease.session.sessionId;
    return this.enqueue(lease,async()=>{
      try{
        await this.check(lease,check,oldId);await this.releasePointer(lease);
        await Promise.all(lease.frames.splice(0).map(frame=>this.disposeFrame(frame)));
        await this.check(lease,check,oldId);
        lease.sequence=0;lease.lastActivity=Date.now();
        lease.session={...lease.session,sessionId:randomUUID()};
        return lease.session;
      }catch(error){
        if(lease.session.sessionId===oldId){
          try{await this.check(lease,check,oldId);}catch{await this.cleanup(lease);}
        }
        throw error;
      }
    });
  }
  async frame(sessionId:string,check:()=>void):Promise<ManualRecoveryFrame>{
    const lease=this.current(sessionId);
    return this.enqueue(lease,async()=>{
      try{
        await this.check(lease,check,sessionId);
        const size=await this.document(lease.page,lease.options.document);
        requireSafe(size.width>0&&size.height>0&&size.width<=16384&&size.height<=16384,'MANUAL_RECOVERY_IMAGE_TOO_LARGE');
        const array=await lease.page.evaluateHandle(manualRecoveryElements,{selectors:lease.options.selectors});
        const nodes:FrameBinding['nodes']=[];
        const pendingHandles=new Set<{dispose():Promise<void>}>();
        try{
          const properties=await array.getProperties();
          for(const value of properties.values())pendingHandles.add(value);
          for(const [key,value] of properties){
            const element=value.asElement() as ElementHandle<Element>|null;
            if(!/^\d+$/u.test(key)||!element){pendingHandles.delete(value);await value.dispose().catch(()=>{});continue;}
            const inspected=await element.evaluate(inspectManualRecoveryElement,lease.options.document);
            if(inspected.documentMatches&&inspected.region){
              const child=await element.contentFrame();
              pendingHandles.delete(value);
              nodes.push({element,region:inspected.region,child,childEpoch:child?lease.childEpochs.get(child)??0:0});
            }
            else{pendingHandles.delete(value);await element.dispose().catch(()=>{});}
          }
        }catch(error){
          await Promise.all([
            ...nodes.map(node=>node.element.dispose().catch(()=>{})),
            ...[...pendingHandles].map(handle=>handle.dispose().catch(()=>{})),
          ]);
          throw error;
        }
        finally{await array.dispose().catch(()=>{});}
        let buffer:Buffer;
        try{
          buffer=await lease.page.screenshot({type:'jpeg',quality:55,scale:'css',fullPage:false,timeout:2000,
            caret:'initial',animations:'allow'});
          await this.check(lease,check,sessionId);
          requireSafe(buffer.length<=500_000,'MANUAL_RECOVERY_IMAGE_TOO_LARGE');
        }catch(error){await Promise.all(nodes.map(node=>node.element.dispose().catch(()=>{})));throw error;}
        const now=Date.now(),binding={id:randomUUID(),expiresAt:now+this.frameLifetimeMs,nodes};
        const expired=lease.frames.filter(frame=>frame.expiresAt<=now);
        lease.frames=lease.frames.filter(frame=>frame.expiresAt>now);lease.frames.push(binding);
        while(lease.frames.length>8)expired.push(lease.frames.shift()!);
        await Promise.all(expired.map(frame=>this.disposeFrame(frame)));lease.lastActivity=now;
        return{sessionId,frameId:binding.id,image:'data:image/jpeg;base64,'+buffer.toString('base64'),
          ...size,regions:nodes.map(node=>node.region),expiresAt:binding.expiresAt,documentPreserved:true};
      }catch(error){
        if(lease.session.sessionId===sessionId){
          try{await this.check(lease,check,sessionId);}catch{await this.cleanup(lease);}
        }
        throw error;
      }
    });
  }
  async input(sessionId:string,frameId:string,sequence:number,input:ManualRecoveryInput,check:()=>void):Promise<{accepted:true}>{
    const lease=this.current(sessionId),parsed=manualRecoveryInputSchema.parse(input);
    return this.enqueue(lease,async()=>{
      try{
        await this.check(lease,check,sessionId);
        requireSafe(Number.isSafeInteger(sequence)&&sequence>lease.sequence,'MANUAL_RECOVERY_INPUT_REPLAY');
        lease.sequence=sequence;
        const frame=lease.frames.find(candidate=>candidate.id===frameId);
        requireSafe(frame&&frame.expiresAt>Date.now(),'MANUAL_RECOVERY_FRAME_EXPIRED');
        let allowed=false;
        for(const node of frame.nodes){
          if(node.child&&(node.child.isDetached()||(lease.childEpochs.get(node.child)??0)!==node.childEpoch))continue;
          const inspected=await node.element.evaluate(inspectManualRecoveryElement,{...lease.options.document,
            region:node.region,...(parsed.kind==='pointer'?{point:{x:parsed.x,y:parsed.y}}:{focus:true})}).catch(()=>null);
          if(inspected?.documentMatches&&inspected.permitted){allowed=true;break;}
        }
        requireSafe(allowed,parsed.kind==='pointer'?'MANUAL_RECOVERY_INPUT_OUTSIDE_CHALLENGE':'MANUAL_RECOVERY_FOCUS_REQUIRED');
        await this.check(lease,check,sessionId);
        if(parsed.kind==='pointer'){
          requireSafe(parsed.phase!=='down'||!lease.pressed,'MANUAL_RECOVERY_INPUT_REPLAY');
          requireSafe(parsed.phase!=='up'||lease.pressed,'MANUAL_RECOVERY_INPUT_REPLAY');
          await lease.page.mouse.move(parsed.x,parsed.y);
          this.session(lease,sessionId);lease.options.check();check();
          if(parsed.phase==='down'){lease.pressed=true;await lease.page.mouse.down();}
          if(parsed.phase==='up'){await lease.page.mouse.up();lease.pressed=false;}
        }else if(parsed.kind==='text')await lease.page.keyboard.insertText(parsed.text);
        else await lease.page.keyboard.press(parsed.key);
        await this.check(lease,check,sessionId);lease.lastActivity=Date.now();return{accepted:true};
      }catch(error){
        if(lease.session.sessionId===sessionId){
          await this.releasePointer(lease);
          try{await this.check(lease,check,sessionId);}catch{await this.cleanup(lease);}
        }
        throw error;
      }
    });
  }
  async finish(sessionId:string,check:()=>void,verify:()=>Promise<void|(()=>void)>):Promise<void>{
    const lease=this.current(sessionId);
    return this.enqueue(lease,async()=>{
      try{
        await this.check(lease,check,sessionId);await this.releasePointer(lease);const commit=await verify();
        if(commit){
          await this.check(lease,check,sessionId);
          this.session(lease,sessionId);lease.options.check();check();commit();
        }else{
          await this.document(lease.page,lease.options.document);this.session(lease,sessionId);check();
        }
      }
      finally{if(lease.session.sessionId===sessionId)await this.cleanup(lease);}
    });
  }
  async close(sessionId:string,check?:()=>void):Promise<void>{
    const lease=this.lease;
    if(!lease)return;
    return this.enqueue(lease,async()=>{
      this.session(lease,sessionId);
      try{check?.();}
      finally{lease.invalid=true;await this.cleanup(lease);}
    });
  }
  async shutdown():Promise<void>{
    this.generation++;this.pending=false;
    const lease=this.lease;
    if(lease){lease.invalid=true;await this.enqueue(lease,()=>this.cleanup(lease));}
  }
}
