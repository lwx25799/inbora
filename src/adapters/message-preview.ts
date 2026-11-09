import type { Page } from 'playwright';
import type { ObservationMapping } from '../config/site-mapping.js';
import { eventBinding,type InboundEvent } from '../core/contracts.js';
import { captureObserved,type ObservationBatch,type DiscoveredPeer } from './observed-reader.js';
import { MessagePreviewStore,maximumPreviewBytes,type CapturedMessageImage } from '../storage/message-previews.js';

interface ImageInspection {
  count:number;label:string|null;reason:string|null;sourceFingerprint:string;clip:{x:number;y:number;width:number;height:number}|null;
}
interface InspectionInput {mapping:ObservationMapping;event:InboundEvent;imageIndex:number;peer:DiscoveredPeer}
/** Native DOM reads only. URLs remain temporary comparison values and are never returned to the application UI. */
export async function inspectMessageImage(input:InspectionInput):Promise<ImageInspection> {
  const {mapping:m,event,imageIndex,peer}=input,s=m.selectors;
  const dom={
    check(condition:unknown):void{if(!condition)throw new Error('MESSAGE_PREVIEW_TARGET_CHANGED');},
    value(object:unknown,key:string):unknown{
      if(!object||typeof object!=='object')return undefined;const descriptor=Object.getOwnPropertyDescriptor(object,key);
      dom.check(!descriptor||Object.hasOwn(descriptor,'value'));return descriptor?.value;
    },
    visible(node:Element):boolean{
      if(!node.isConnected||!node.getClientRects().length)return false;
      for(let current:Element|null=node;current;current=current.parentElement){const style=getComputedStyle(current);
        if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0)return false;}
      return true;
    },
    one(selector:string,root:Document|Element=document):Element{
      const nodes=root.querySelectorAll(selector);dom.check(nodes.length===1&&dom.visible(nodes[0]!));return nodes[0]!;
    },
    react(node:Element,prefix:string):unknown{
      const names=Object.getOwnPropertyNames(node).filter(name=>name.startsWith(prefix));dom.check(names.length===1);return dom.value(node,names[0]!);
    },
    props(node:Element,depth:number):unknown{
      let fiber=dom.react(node,'__reactFiber$');for(let index=0;index<depth;index++)fiber=dom.value(fiber,'return');return dom.value(fiber,'memoizedProps');
    },
    child(node:Element):unknown{
      const children=dom.value(dom.react(node,'__reactProps$'),'children');return dom.value(Array.isArray(children)?dom.value(children,'0'):children,'props');
    },
    stack(node:Element):{node:Element;z:number}[]{
      const path:{node:Element;z:number}[]=[];
      for(let current:Element|null=node;current;current=current.parentElement){
        const style=getComputedStyle(current),parent=current.parentElement?getComputedStyle(current.parentElement):null;
        const explicit=/^-?\d+$/u.test(style.zIndex)&&(style.position!=='static'||!!parent&&/^(?:inline-)?(?:flex|grid)$/u.test(parent.display));
        const context=current===document.documentElement||explicit||style.position==='fixed'||style.position==='sticky'||Number(style.opacity)<1||
          style.transform!=='none'||style.filter!=='none'||style.backdropFilter!=='none'||style.perspective!=='none'||
          style.isolation==='isolate'||style.mixBlendMode!=='normal'||/paint|layout|strict|content/u.test(style.contain)||
          /transform|opacity|filter|perspective/u.test(style.willChange);
        if(context)path.unshift({node:current,z:explicit?Number(style.zIndex):0});
      }
      return path;
    },
    below(node:Element,image:Element):boolean{
      const foreign=dom.stack(node),target=dom.stack(image);let index=0;
      while(index<foreign.length&&index<target.length&&foreign[index]!.node===target[index]!.node)index++;
      return index<foreign.length&&index<target.length&&foreign[index]!.z<target[index]!.z;
    },
  };
  dom.check(location.origin===m.origin&&!/验证码|安全验证/u.test(document.title));
  dom.check(!Array.from(document.querySelectorAll(m.securityBlockers)).some(dom.visible));
  const own=dom.props(dom.one(s.selfAvatar),s.selfFiberDepth);
  dom.check(dom.value(own,'uid')===m.self.uid&&dom.value(own,'secUid')===m.self.secUid);
  const chat=dom.one(s.chat),header=dom.one(s.chatHeader,chat),conversation=dom.value(dom.child(header),'conversation');
  const nativeConversation=dom.value(conversation,'conversationId')??dom.value(conversation,'id');
  dom.check(nativeConversation===event.conversationId&&nativeConversation===peer.conversationId&&
    dom.value(conversation,'_toParticipantSecUserId')===peer.secUid&&dom.one(s.chatTitle,chat).textContent?.trim()===peer.title);
  const rows=Array.from(chat.querySelectorAll(s.messages)).filter(row=>{
    const native=dom.value(dom.child(row),'message');return dom.value(native,'serverId')===event.platformEventId;
  });
  dom.check(rows.length===1&&dom.visible(rows[0]!));const row=rows[0]!,native=dom.value(dom.child(row),'message');
  dom.check(dom.value(native,'conversationId')===event.conversationId&&dom.value(native,'sender')===event.actorId);
  const time=dom.value(native,'createdAt');let observed=NaN;try{observed=Date.prototype.getTime.call(time);}catch{/* Not a native date. */}
  dom.check(Number.isFinite(observed)&&new Date(observed).toISOString()===event.occurredAt);
  const images=Array.from(row.querySelectorAll('img')).filter(image=>image.closest(s.messages)===row&&dom.visible(image));
  const image=images[imageIndex];if(!image)return {count:images.length,label:null,reason:'MESSAGE_PREVIEW_NOT_AVAILABLE',sourceFingerprint:'',clip:null};
  const label=image.getAttribute('alt')?.replace(/[\u0000-\u001f\u007f]/gu,'').slice(0,120)||null;
  const decoration=image.closest('[role="menu"],[aria-hidden="true"],header');
  if(decoration&&row.contains(decoration))return {count:images.length,label,reason:'MESSAGE_PREVIEW_NOT_CONTENT',sourceFingerprint:'',clip:null};
  // Use the browser's resolved image source, including srcset; never invoke an own page-defined getter.
  const currentSource=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'currentSrc')?.get?.call(image) as string|undefined;
  const source=currentSource||image.getAttribute('src')||'';
  let safe=false;try{const url=new URL(source,location.href);safe=!!source&&!url.username&&!url.password&&
    source.length<=262_144&&(url.protocol==='https:'||m.environment==='fixture'&&url.origin===m.origin&&url.protocol==='http:'||
      /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\r\n]+$/u.test(source)||url.protocol==='blob:'&&url.origin===m.origin);}
  catch{/* Unsafe source never triggers a fetch. */}
  if(!safe)return {count:images.length,label,reason:'MESSAGE_PREVIEW_UNSAFE_SOURCE',sourceFingerprint:'',clip:null};
  if(!image.complete||image.naturalWidth<=0||image.naturalHeight<=0)return {count:images.length,label,reason:'MESSAGE_PREVIEW_NOT_LOADED',sourceFingerprint:'',clip:null};
  const bounds=image.getBoundingClientRect();
  if(bounds.width<=0||bounds.height<=0||bounds.width>512||bounds.height>512)return {count:images.length,label,reason:'MESSAGE_PREVIEW_TOO_LARGE',sourceFingerprint:'',clip:null};
  if(bounds.left<0||bounds.top<0||bounds.right>innerWidth||bounds.bottom>innerHeight)return {count:images.length,label,reason:'MESSAGE_PREVIEW_OUT_OF_VIEW',sourceFingerprint:'',clip:null};
  const points=[[0.5,0.5],[0.05,0.05],[0.95,0.05],[0.05,0.95],[0.95,0.95]];
  if(points.some(([x,y])=>document.elementFromPoint(bounds.left+bounds.width*x!,bounds.top+bounds.height*y!)!==image))
    return {count:images.length,label,reason:'MESSAGE_PREVIEW_OBSCURED',sourceFingerprint:'',clip:null};
  // Point hit tests miss narrow/pointer-events:none overlays; only a proven lower stacking context is ignored.
  const elements=document.querySelectorAll('*');
  if(elements.length>10_000||Array.from(elements).some(node=>node!==image&&!node.contains(image)&&dom.visible(node)&&
    Array.from(node.getClientRects()).some(rect=>rect.width>0&&rect.height>0&&rect.left<bounds.right&&rect.right>bounds.left&&rect.top<bounds.bottom&&rect.bottom>bounds.top)&&!dom.below(node,image)))
    return {count:images.length,label,reason:'MESSAGE_PREVIEW_OBSCURED',sourceFingerprint:'',clip:null};
  // Transformed image boxes can expose neighbouring text even when their centre is correctly bound.
  if(getComputedStyle(image).transform!=='none')return {count:images.length,label,reason:'MESSAGE_PREVIEW_TRANSFORMED',sourceFingerprint:'',clip:null};
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(source));
  const sourceFingerprint=Array.from(new Uint8Array(hash)).map(byte=>byte.toString(16).padStart(2,'0')).join('');
  return {count:images.length,label,reason:null,sourceFingerprint,clip:{x:bounds.left,y:bounds.top,width:bounds.width,height:bounds.height}};
}

/** Called only inside the existing account actor while its exact native batch is still mounted. */
export async function saveMessagePreviews(page:Page,mapping:ObservationMapping,batch:ObservationBatch,root:string,signal:AbortSignal):Promise<void> {
  const store=new MessagePreviewStore(root);
  for(const event of batch.events){
    if(signal.aborted)return;
    if(event.channel!=='DIRECT_MESSAGE'||event.observationIssue!=='DM_CONTENT_UNVERIFIED'||
      !['IMAGE','MIXED'].includes(event.contentType??'')||!event.platformEventId||!event.occurredAt)continue;
    const binding=batch.bindings?.find(item=>item.conversationId===event.conversationId&&
      (event.direction==='OUTGOING'?event.actorId===mapping.self.uid:item.uid===event.actorId));
    if(!binding)continue;const peer:DiscoveredPeer={uid:binding.uid,secUid:binding.secUid,conversationId:event.conversationId!,title:binding.title};
    const previous=store.list(event,mapping.self.uid);if(previous.length&&previous.every(item=>item.state==='READY'))continue;
    const images:CapturedMessageImage[]=[];
    for(let imageIndex=0;imageIndex<4&&!signal.aborted;imageIndex++){
      let before:ImageInspection;
      try{before=await page.evaluate(inspectMessageImage,{mapping,event,imageIndex,peer});}catch{break;}
      if(imageIndex>=before.count)break;
      if(before.reason||!before.clip){images.push({label:before.label,reason:before.reason??'MESSAGE_PREVIEW_CAPTURE_FAILED'});continue;}
      try{
        const bytes=await page.screenshot({type:'png',scale:'css',clip:before.clip,timeout:2000,animations:'allow',caret:'initial'});
        if(signal.aborted)return;
        const after=await page.evaluate(inspectMessageImage,{mapping,event,imageIndex,peer});
        if(after.reason||after.sourceFingerprint!==before.sourceFingerprint||after.label!==before.label||JSON.stringify(after.clip)!==JSON.stringify(before.clip)){
          images.push({label:before.label,reason:'MESSAGE_PREVIEW_TARGET_CHANGED'});continue;
        }
        const input:Parameters<typeof captureObserved>[0]={mapping,channel:'dm',index:0,evidenceId:'message-preview-only',dmWindow:true,peer};
        const final=await page.evaluate(captureObserved,input);
        if(!final.events.some(item=>eventBinding(item)===eventBinding(event))){images.push({label:before.label,reason:'MESSAGE_PREVIEW_TARGET_CHANGED'});continue;}
        images.push(bytes.length<=maximumPreviewBytes?{label:before.label,png:bytes,width:Math.round(before.clip.width),height:Math.round(before.clip.height)}:
          {label:before.label,reason:'MESSAGE_PREVIEW_TOO_LARGE'});
      }catch{images.push({label:before.label,reason:'MESSAGE_PREVIEW_CAPTURE_FAILED'});}
    }
    if(images.length&&!signal.aborted)try{store.save(event,mapping.self.uid,images);}catch{/* Cache failure cannot turn an observed inbound into a lost task. */}
  }
}
