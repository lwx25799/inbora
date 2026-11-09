import type { Page } from 'playwright';
import type { ObservationMapping } from '../config/site-mapping.js';
import { eventBinding,type InboundEvent } from '../core/contracts.js';
import { captureObserved,type ObservationBatch,type DiscoveredPeer } from './observed-reader.js';
import { MessagePreviewStore,maximumPreviewBytes,type CapturedMessageImage } from '../storage/message-previews.js';
import {MessagePreviewDiagnostics} from '../observability/message-preview-diagnostics.js';
import {inspectMessageShare} from './message-share.js';
import {MessageShareStore} from '../storage/message-shares.js';

interface ImageClipping {
  imageInMessageRect:boolean;imageInChatRect:boolean;hitSameMessage:boolean[];hitInChat:boolean[];overflowAncestorCount:number;truncated:boolean;
  ancestors:{index:number;x:boolean;y:boolean;containsX:boolean;containsY:boolean;pointsOutside:boolean[];hitIsAncestor:boolean[];
    sameMessage:boolean;insideChat:boolean;transformed:boolean}[];
}
interface ImageInspection {
  count:number;label:string|null;reason:string|null;sourceFingerprint:string;clip:{x:number;y:number;width:number;height:number}|null;
  canvas?:{dataUrl:string|null;width:number;height:number};canvasTainted?:boolean;
  obstruction?:{stage:'HIT'|'OVERLAP'|'LIMIT';imagePointerEvents:string;tag:string|null;ancestor:boolean;pointerEvents:string|null;position:string|null;zIndex:string|null;
    flow?:{sameStack:boolean;reason:'NOT_CANDIDATE'|'STACK'|'PAINT'|'FLOW'|'LIMIT'|'PROVEN';branchPositioned:boolean;branchGrouped:boolean;parentGrouped:boolean};
    hits?:('IMAGE'|'ANCESTOR'|'OTHER'|'NONE')[];borderRadius?:string;clipPath?:boolean;clipping?:ImageClipping;
    paint?:{backgroundTransparent:boolean;backgroundImage:boolean;borderWidths:boolean;borderStyles:boolean;shadow:boolean;outline:boolean;filter:boolean;backdrop:boolean;
      mask:boolean;directText:boolean;pseudo:boolean;childCount:number;insideImage:boolean;coversImage:boolean;beforeImage:boolean;
      scrollbar:boolean;replacementContent:boolean;borderImage:boolean;textShadow:boolean;textDecoration:boolean;appearance:boolean;reflection:boolean;topLayer:boolean;structuralDisplay:boolean}};
}
interface InspectionInput {mapping:ObservationMapping;event:InboundEvent;imageIndex:number;peer:DiscoveredPeer;mode?:'CANVAS'|'CANVAS_VERIFY'}
/** Native DOM reads only. URLs remain temporary comparison values and are never returned to the application UI. */
export async function inspectMessageImage(input:InspectionInput):Promise<ImageInspection> {
  const {mapping:m,event,imageIndex,peer}=input,s=m.selectors;
  let phase:'ENVIRONMENT'|'IDENTITY'|'CHAT'|'HEADER'|'ID'|'PEERSEC'|'TITLE'|'MESSAGE'|'TIME'='ENVIRONMENT';
  const dom={
    check(condition:unknown):void{if(!condition)throw new Error('MESSAGE_PREVIEW_INSPECT_'+phase+'_FAILED');},
    imageValue(image:HTMLImageElement,key:'currentSrc'|'complete'|'naturalWidth'|'naturalHeight'):unknown{
      return Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,key)?.get?.call(image);
    },
    value(object:unknown,key:string):unknown{
      if(!object||typeof object!=='object')return undefined;const descriptor=Object.getOwnPropertyDescriptor(object,key);
      const inherited=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(object)??{},key);
      dom.check((!descriptor||Object.hasOwn(descriptor,'value'))&&(!inherited||Object.hasOwn(inherited,'value'))&&
        (!descriptor||!inherited||descriptor.value===inherited.value));return descriptor?descriptor.value:inherited?.value;
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
      return (foreign[index]?.z??0)<(target[index]?.z??0);
    },
    ownedVisual(node:Element,image:Element,row:Element):boolean{
      // The calibrated message selector is the native body, separate from the outer author/direction box.
      if(image.closest(s.messages)!==row||!row.contains(node)||node.contains(image)||node.closest(s.messages)!==row)return false;
      const decoration=node.closest('header,nav,blockquote,q,[role="menu"],[role="dialog"],[aria-modal="true"],dialog,[popover],img,video,audio,iframe,object,embed,canvas,input,textarea,select,image,foreignObject');
      return !decoration||!row.contains(decoration);
    },
    flowEvidence(node:Element,image:Element):NonNullable<NonNullable<ImageInspection['obstruction']>['flow']>{
      const result={sameStack:false,reason:'NOT_CANDIDATE' as NonNullable<NonNullable<ImageInspection['obstruction']>['flow']>['reason'],branchPositioned:false,branchGrouped:false,parentGrouped:false};
      if(!(node instanceof HTMLDivElement||node instanceof HTMLSpanElement)||!(node.compareDocumentPosition(image)&Node.DOCUMENT_POSITION_FOLLOWING))return result;
      const foreign=dom.stack(node),target=dom.stack(image);
      result.sameStack=foreign.length===target.length&&!foreign.some((item,index)=>item.node!==target[index]!.node);
      const foregroundContext=foreign.length<target.length&&foreign.every((item,index)=>item.node===target[index]!.node)&&
        target.slice(foreign.length).every(item=>item.z>=0);
      if(!result.sameStack&&!foregroundContext){result.reason='STACK';return result;}
      const paint=dom.paint(node,image);
      if(paint.backgroundImage||paint.borderWidths||paint.borderStyles||paint.shadow||paint.outline||paint.filter||paint.backdrop||paint.mask||
        paint.directText||paint.pseudo||paint.scrollbar||paint.replacementContent||paint.borderImage||paint.textShadow||paint.textDecoration||
        paint.appearance||paint.reflection||paint.topLayer){result.reason='PAINT';return result;}
      let current:Element|null=node,index=0;
      for(;current&&!current.contains(image)&&index<64;current=current.parentElement,index++){
        const style=getComputedStyle(current),parent=current.parentElement?getComputedStyle(current.parentElement):null;
        result.branchPositioned=style.position!=='static';result.branchGrouped=style.cssFloat!=='none'||style.display!=='block';result.parentGrouped=!parent||parent.display!=='block';
        if(result.branchPositioned||result.branchGrouped||result.parentGrouped){result.reason='FLOW';return result;}
      }
      result.reason=current&&current.contains(image)?'PROVEN':'LIMIT';return result;
    },
    flowBackground(node:Element,image:Element):boolean{
      return dom.flowEvidence(node,image).reason==='PROVEN';
    },
    imageHit(hit:Element|null,image:Element,row:Element,x:number,y:number):boolean{
      if(hit===image)return true;
      if(hit&&dom.ownedVisual(hit,image,row))return true;
      if(!hit||!row.contains(hit)||!hit.contains(image))return false;
      // A clipped corner or pointer-free image can hit its own wrapper; generated overlays remain unproven.
      for(let node=image.parentElement;node&&row.contains(node);node=node.parentElement)
        for(const pseudo of ['::before','::after'])if(!['none','normal'].includes(getComputedStyle(node,pseudo).content))return false;
      const style=getComputedStyle(image);if(style.pointerEvents==='none')return true;
      const radii=[style.borderTopLeftRadius,style.borderTopRightRadius,style.borderBottomRightRadius,style.borderBottomLeftRadius];
      if(style.clipPath!=='none'||style.transform!=='none'||!radii.every(radius=>radius===radii[0])||!/^\d+(?:\.\d+)?px$/u.test(radii[0]!))return false;
      const bounds=image.getBoundingClientRect(),radius=Math.min(parseFloat(radii[0]!),bounds.width/2,bounds.height/2),
        px=x-bounds.left,py=y-bounds.top;
      if(radius<=0||px<0||py<0||px>bounds.width||py>bounds.height)return false;
      const cx=px<radius?radius:px>bounds.width-radius?bounds.width-radius:null,
        cy=py<radius?radius:py>bounds.height-radius?bounds.height-radius:null;
      return cx!==null&&cy!==null&&(px-cx)**2+(py-cy)**2>radius**2;
    },
    paint(node:Element,image:Element):NonNullable<NonNullable<ImageInspection['obstruction']>['paint']>{
      const style=getComputedStyle(node),r=node.getBoundingClientRect(),bounds=image.getBoundingClientRect();
      return {
        backgroundTransparent:style.backgroundColor==='transparent'||style.backgroundColor==='rgba(0, 0, 0, 0)',backgroundImage:style.backgroundImage!=='none',
        borderWidths:[style.borderTopWidth,style.borderRightWidth,style.borderBottomWidth,style.borderLeftWidth].some(value=>parseFloat(value)>0),
        borderStyles:[style.borderTopStyle,style.borderRightStyle,style.borderBottomStyle,style.borderLeftStyle].some(value=>value!=='none'&&value!=='hidden'),
        shadow:style.boxShadow!=='none',outline:parseFloat(style.outlineWidth)>0&&style.outlineStyle!=='none'&&style.outlineStyle!=='hidden',
        filter:style.filter!=='none',backdrop:style.backdropFilter!=='none',mask:style.maskImage!=='none'||
          !['','none'].includes(style.getPropertyValue('-webkit-mask-image')),
        directText:Array.from(node.childNodes).some(child=>child.nodeType===Node.TEXT_NODE&&(child.nodeValue??'').trim().length>0),
        pseudo:['::before','::after'].some(pseudo=>!['none','normal'].includes(getComputedStyle(node,pseudo).content)),childCount:Math.min(250,node.childElementCount),
        insideImage:r.left>=bounds.left&&r.right<=bounds.right&&r.top>=bounds.top&&r.bottom<=bounds.bottom,
        coversImage:r.left<=bounds.left&&r.right>=bounds.right&&r.top<=bounds.top&&r.bottom>=bounds.bottom,
        beforeImage:!!(node.compareDocumentPosition(image)&Node.DOCUMENT_POSITION_FOLLOWING),
        scrollbar:style.overflowX==='scroll'||style.overflowY==='scroll'||
          ['auto','overlay'].includes(style.overflowX)&&node.scrollWidth>node.clientWidth||
          ['auto','overlay'].includes(style.overflowY)&&node.scrollHeight>node.clientHeight||style.scrollbarGutter!=='auto',
        replacementContent:!['normal','none'].includes(style.content),borderImage:style.borderImageSource!=='none',
        textShadow:style.textShadow!=='none',textDecoration:style.textDecorationLine!=='none',appearance:style.appearance!=='none',
        reflection:!['','none'].includes(style.getPropertyValue('-webkit-box-reflect')),
        topLayer:!!node.closest('dialog,[popover]')||!!document.fullscreenElement?.contains(node),
        structuralDisplay:['block','inline','inline-block','flex','inline-flex','grid','inline-grid','contents','flow-root'].includes(style.display),
      };
    },
    structural(node:Element,image:Element):boolean{
      if(!(node instanceof HTMLDivElement||node instanceof HTMLSpanElement))return false;
      const paint=dom.paint(node,image);
      // Only the container's own empty paint is ignored; descendants remain in the global overlap scan.
      return paint.backgroundTransparent&&!paint.backgroundImage&&!paint.borderWidths&&!paint.borderStyles&&!paint.shadow&&!paint.outline&&
        !paint.filter&&!paint.backdrop&&!paint.mask&&!paint.directText&&!paint.pseudo&&!paint.scrollbar&&!paint.replacementContent&&
        !paint.borderImage&&!paint.textShadow&&!paint.textDecoration&&!paint.appearance&&!paint.reflection&&!paint.topLayer&&paint.structuralDisplay;
    },
    clipping(image:Element,row:Element,chat:Element,points:number[][],hits:(Element|null)[]):ImageClipping{
      const bounds=image.getBoundingClientRect(),rowRect=row.getBoundingClientRect(),chatRect=chat.getBoundingClientRect(),
        coordinates=points.map(([x,y])=>({x:bounds.left+bounds.width*x!,y:bounds.top+bounds.height*y!}));
      const ancestors:ImageClipping['ancestors']=[];let overflowAncestorCount=0,index=0,node=image.parentElement;
      for(;node&&index<64;node=node.parentElement,index++){
        const style=getComputedStyle(node),x=['hidden','clip','auto','scroll','overlay'].includes(style.overflowX),
          y=['hidden','clip','auto','scroll','overlay'].includes(style.overflowY);
        if(!x&&!y)continue;overflowAncestorCount++;if(ancestors.length===6)continue;
        const rect=node.getBoundingClientRect(),left=rect.left+node.clientLeft,top=rect.top+node.clientTop,
          right=left+node.clientWidth,bottom=top+node.clientHeight;
        ancestors.push({index,x,y,containsX:bounds.left>=left&&bounds.right<=right,containsY:bounds.top>=top&&bounds.bottom<=bottom,
          pointsOutside:coordinates.map(point=>x&&(point.x<left||point.x>=right)||y&&(point.y<top||point.y>=bottom)),
          hitIsAncestor:hits.map(hit=>hit===node),sameMessage:node.closest(s.messages)===row,insideChat:chat.contains(node),transformed:style.transform!=='none'});
      }
      return {imageInMessageRect:bounds.left>=rowRect.left&&bounds.right<=rowRect.right&&bounds.top>=rowRect.top&&bounds.bottom<=rowRect.bottom,
        imageInChatRect:bounds.left>=chatRect.left&&bounds.right<=chatRect.right&&bounds.top>=chatRect.top&&bounds.bottom<=chatRect.bottom,
        hitSameMessage:hits.map(hit=>hit?.closest(s.messages)===row),hitInChat:hits.map(hit=>!!hit&&chat.contains(hit)),
        overflowAncestorCount,truncated:overflowAncestorCount>ancestors.length||!!node,ancestors};
    },
    obstruction(stage:'HIT'|'OVERLAP'|'LIMIT',node:Element|null,image:Element):NonNullable<ImageInspection['obstruction']>{
      const style=node?getComputedStyle(node):null,paint=node?dom.paint(node,image):undefined;
      return {stage,imagePointerEvents:getComputedStyle(image).pointerEvents,tag:node?.tagName??null,ancestor:!!node?.contains(image),
        pointerEvents:style?.pointerEvents??null,position:style?.position??null,zIndex:style?.zIndex??null,...(paint?{paint}:{}),...(node?{flow:dom.flowEvidence(node,image)}:{})};
    },
  };
  dom.check(location.origin===m.origin&&!/验证码|安全验证/u.test(document.title));
  dom.check(!Array.from(document.querySelectorAll(m.securityBlockers)).some(dom.visible));
  phase='IDENTITY';
  const own=dom.props(dom.one(s.selfAvatar),s.selfFiberDepth);
  dom.check(dom.value(own,'uid')===m.self.uid&&dom.value(own,'secUid')===m.self.secUid);
  phase='CHAT';const chat=dom.one(s.chat);
  phase='HEADER';const header=dom.one(s.chatHeader,chat),conversation=dom.value(dom.child(header),'conversation');
  phase='ID';const first=dom.value(conversation,'conversationId'),second=dom.value(conversation,'id'),nativeConversation=first??second;
  dom.check((first===undefined||second===undefined||first===second)&&nativeConversation===event.conversationId&&nativeConversation===peer.conversationId);
  phase='PEERSEC';dom.check(dom.value(conversation,'_toParticipantSecUserId')===peer.secUid);
  phase='TITLE';dom.check(dom.one(s.chatTitle,chat).textContent?.trim()===peer.title);
  phase='MESSAGE';
  const rows=Array.from(chat.querySelectorAll(s.messages)).filter(row=>{
    const native=dom.value(dom.child(row),'message');return dom.value(native,'serverId')===event.platformEventId;
  });
  dom.check(rows.length===1&&dom.visible(rows[0]!));const row=rows[0]!,native=dom.value(dom.child(row),'message');
  dom.check(dom.value(native,'conversationId')===event.conversationId&&dom.value(native,'sender')===event.actorId);
  phase='TIME';
  const time=dom.value(native,'createdAt');let observed=NaN;try{observed=Date.prototype.getTime.call(time);}catch{/* Not a native date. */}
  dom.check(Number.isFinite(observed)&&new Date(observed).toISOString()===event.occurredAt);
  const images=Array.from(row.querySelectorAll('img')).filter(image=>image.closest(s.messages)===row&&dom.visible(image));
  const image=images[imageIndex];if(!image)return {count:images.length,label:null,reason:'MESSAGE_PREVIEW_NOT_AVAILABLE',sourceFingerprint:'',clip:null};
  const label=image.getAttribute('alt')?.replace(/[\u0000-\u001f\u007f]/gu,'').slice(0,120)||null;
  const decoration=image.closest('[role="menu"],[aria-hidden="true"],header,nav,blockquote,q,[role="dialog"],[aria-modal="true"],dialog,[popover]');
  if(decoration&&row.contains(decoration))return {count:images.length,label,reason:'MESSAGE_PREVIEW_NOT_CONTENT',sourceFingerprint:'',clip:null};
  // Use the browser's resolved image source, including srcset; never invoke an own page-defined getter.
  const currentSource=dom.imageValue(image,'currentSrc') as string|undefined;
  const source=currentSource||image.getAttribute('src')||'';
  let safe=false;try{const url=new URL(source,location.href);safe=!!source&&!url.username&&!url.password&&
    source.length<=262_144&&(url.protocol==='https:'||m.environment==='fixture'&&url.origin===m.origin&&url.protocol==='http:'||
      /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\r\n]+$/u.test(source)||url.protocol==='blob:'&&url.origin===m.origin);}
  catch{/* Unsafe source never triggers a fetch. */}
  if(!safe)return {count:images.length,label,reason:'MESSAGE_PREVIEW_UNSAFE_SOURCE',sourceFingerprint:'',clip:null};
  const naturalWidth=dom.imageValue(image,'naturalWidth'),naturalHeight=dom.imageValue(image,'naturalHeight');
  if(dom.imageValue(image,'complete')!==true||typeof naturalWidth!=='number'||typeof naturalHeight!=='number'||naturalWidth<=0||naturalHeight<=0)
    return {count:images.length,label,reason:'MESSAGE_PREVIEW_NOT_LOADED',sourceFingerprint:'',clip:null};
  let canvasTainted=false;
  if(input.mode){
    const ratio=Math.min(1,512/naturalWidth,512/naturalHeight),width=Math.max(1,Math.round(naturalWidth*ratio)),height=Math.max(1,Math.round(naturalHeight*ratio));
    try{
      let dataUrl:string|null=null;
      if(input.mode==='CANVAS'){
        // An unmounted canvas copies only the already loaded image; no DOM paint, URL request or CORS bypass.
        const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
        const context=HTMLCanvasElement.prototype.getContext.call(canvas,'2d');dom.check(context instanceof CanvasRenderingContext2D);
        const draw=CanvasRenderingContext2D.prototype.drawImage as (this:CanvasRenderingContext2D,image:CanvasImageSource,x:number,y:number,width:number,height:number)=>void;
        draw.call(context as CanvasRenderingContext2D,image,0,0,width,height);
        dataUrl=HTMLCanvasElement.prototype.toDataURL.call(canvas,'image/png');
        if(!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/u.test(dataUrl)||dataUrl.length>218_478)throw Error('MESSAGE_PREVIEW_CANVAS_TOO_LARGE');
      }
      const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([source,naturalWidth,naturalHeight])));
      const sourceFingerprint=Array.from(new Uint8Array(hash)).map(byte=>byte.toString(16).padStart(2,'0')).join('');
      return {count:images.length,label,reason:null,sourceFingerprint,clip:null,canvas:{dataUrl,width,height}};
    }catch(error){canvasTainted=error instanceof DOMException&&error.name==='SecurityError';}
  }
  const bounds=image.getBoundingClientRect();
  if(bounds.width<=0||bounds.height<=0||bounds.width>512||bounds.height>512)return {count:images.length,label,reason:'MESSAGE_PREVIEW_TOO_LARGE',sourceFingerprint:'',clip:null,canvasTainted};
  if(bounds.left<0||bounds.top<0||bounds.right>innerWidth||bounds.bottom>innerHeight)return {count:images.length,label,reason:'MESSAGE_PREVIEW_OUT_OF_VIEW',sourceFingerprint:'',clip:null,canvasTainted};
  const points=[[0.5,0.5],[0.05,0.05],[0.95,0.05],[0.05,0.95],[0.95,0.95]];
  const hits=points.map(([x,y])=>document.elementFromPoint(bounds.left+bounds.width*x!,bounds.top+bounds.height*y!));
  const hit=hits.find((node,index)=>!dom.imageHit(node,image,row,bounds.left+bounds.width*points[index]![0]!,bounds.top+bounds.height*points[index]![1]!));
  if(hit!==undefined)return {count:images.length,label,reason:'MESSAGE_PREVIEW_OBSCURED',sourceFingerprint:'',clip:null,canvasTainted,obstruction:{...dom.obstruction('HIT',hit,image),
    hits:hits.map(node=>node===image?'IMAGE':!node?'NONE':node.contains(image)?'ANCESTOR':'OTHER'),
    borderRadius:getComputedStyle(image).borderRadius.replace(/[^0-9.% /]/gu,'').slice(0,80),clipPath:getComputedStyle(image).clipPath!=='none',
    clipping:dom.clipping(image,row,chat,points,hits)}};
  // Point hit tests miss narrow overlays; renderer-owned UI and proven earlier paint stay inside the exact image clip.
  const elements=document.querySelectorAll('*');
  const overlap=Array.from(elements).find(node=>node!==image&&!node.contains(image)&&dom.visible(node)&&
    Array.from(node.getClientRects()).some(rect=>rect.width>0&&rect.height>0&&rect.left<bounds.right&&rect.right>bounds.left&&rect.top<bounds.bottom&&rect.bottom>bounds.top)&&
    !dom.below(node,image)&&!dom.structural(node,image)&&!dom.ownedVisual(node,image,row)&&!dom.flowBackground(node,image));
  if(elements.length>10_000||overlap)return {count:images.length,label,reason:'MESSAGE_PREVIEW_OBSCURED',sourceFingerprint:'',clip:null,canvasTainted,
    obstruction:dom.obstruction(elements.length>10_000?'LIMIT':'OVERLAP',overlap??null,image)};
  // Transformed image boxes can expose neighbouring text even when their centre is correctly bound.
  if(getComputedStyle(image).transform!=='none')return {count:images.length,label,reason:'MESSAGE_PREVIEW_TRANSFORMED',sourceFingerprint:'',clip:null,canvasTainted};
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(source));
  const sourceFingerprint=Array.from(new Uint8Array(hash)).map(byte=>byte.toString(16).padStart(2,'0')).join('');
  return {count:images.length,label,reason:null,sourceFingerprint,clip:{x:bounds.left,y:bounds.top,width:bounds.width,height:bounds.height},canvasTainted};
}

/** Called only inside the existing account actor while its exact native batch is still mounted. */
export async function saveMessagePreviews(page:Page,mapping:ObservationMapping,batch:ObservationBatch,root:string,signal:AbortSignal,exactPeer?:DiscoveredPeer):Promise<void> {
  const store=new MessagePreviewStore(root),diagnostics=new MessagePreviewDiagnostics();
  diagnostics.snapshot.batchDMcount=batch.events.filter(event=>event.channel==='DIRECT_MESSAGE').length;
  try{
  for(const event of batch.events){
    if(signal.aborted)return;
    if(event.channel!=='DIRECT_MESSAGE'||event.observationIssue!=='DM_CONTENT_UNVERIFIED'||
      !['IMAGE','MIXED'].includes(event.contentType??'')||!event.platformEventId||!event.occurredAt)continue;
    diagnostics.snapshot.eligibleCount++;
    const binding=batch.bindings?.find(item=>item.conversationId===event.conversationId&&
      (event.direction==='OUTGOING'?event.actorId===mapping.self.uid:item.uid===event.actorId));
    if(binding&&exactPeer&&(binding.conversationId!==exactPeer.conversationId||binding.secUid!==exactPeer.secUid||exactPeer.uid!==null&&binding.uid!==exactPeer.uid)){
      diagnostics.increment('skipped','BINDING_CONFLICT');continue;
    }
    const peer:DiscoveredPeer|undefined=binding?{uid:binding.uid,secUid:binding.secUid,conversationId:event.conversationId!,title:binding.title}:
      exactPeer?.conversationId===event.conversationId&&(event.direction==='OUTGOING'&&event.actorId===mapping.self.uid||exactPeer.uid===event.actorId)?exactPeer:undefined;
    if(!peer){diagnostics.increment('skipped','BINDING_MISSING');continue;}
    try{
      const inspected=await page.evaluate(inspectMessageShare,{mapping,event,peer});diagnostics.snapshot.shareInspected++;
      if(inspected.diagnostic&&diagnostics.snapshot.shareSamples.length<8)diagnostics.snapshot.shareSamples.push(inspected.diagnostic);
      if(inspected.detected){
        if(inspected.share){try{new MessageShareStore(root).save(event,mapping.self.uid,inspected.share);diagnostics.snapshot.shareLinked++;}catch{diagnostics.increment('caught','SHARE_WRITE');}}
        else diagnostics.snapshot.shareDetectedNoLink++;
        continue;
      }
    }catch{
      diagnostics.increment('caught','SHARE_INSPECT');
      try{store.save(event,mapping.self.uid,[{label:null,reason:'MESSAGE_PREVIEW_SHARE_INSPECT_FAILED'}]);}catch{diagnostics.increment('caught','CACHE_WRITE');}
      continue;
    }
    const previous=store.list(event,mapping.self.uid);if(previous.length&&previous.every(item=>item.state==='READY')){
      diagnostics.snapshot.reusedReady+=previous.length;continue;
    }
    const images:CapturedMessageImage[]=[];
    for(let imageIndex=0;imageIndex<4&&!signal.aborted;imageIndex++){
      let before:ImageInspection;
      diagnostics.snapshot.inspected++;
      const beforeInput:InspectionInput={mapping,event,imageIndex,peer,mode:'CANVAS'};
      try{before=await page.evaluate(inspectMessageImage,beforeInput);}catch(error){
        const reason=error instanceof Error?/MESSAGE_PREVIEW_INSPECT_(?:ENVIRONMENT|IDENTITY|CONVERSATION|CHAT|HEADER|ID|PEERSEC|TITLE|MESSAGE|TIME)_FAILED/u.exec(error.message)?.[0]:undefined;
        diagnostics.increment('caught','INSPECT_BEFORE');images.push({label:null,reason:reason??'MESSAGE_PREVIEW_INSPECT_FAILED'});break;
      }
      if(before.canvasTainted)diagnostics.increment('caught','MESSAGE_PREVIEW_CANVAS_TAINTED');
      if(before.obstruction&&diagnostics.snapshot.imageObstructions.length<8)diagnostics.snapshot.imageObstructions.push(before.obstruction);
      if(imageIndex>=before.count){if(imageIndex===0)images.push({label:null,reason:'MESSAGE_PREVIEW_NOT_AVAILABLE'});break;}
      if(before.reason||!before.clip&&!before.canvas?.dataUrl){images.push({label:before.label,reason:before.reason??'MESSAGE_PREVIEW_CAPTURE_FAILED'});continue;}
      let stage:'CAPTURE'|'INSPECT_AFTER'|'VERIFY_BINDING'='CAPTURE';
      try{
        const bytes=before.canvas?.dataUrl?Buffer.from(before.canvas.dataUrl.slice('data:image/png;base64,'.length),'base64'):
          await page.screenshot({type:'png',scale:'css',clip:before.clip!,timeout:2000,animations:'allow',caret:'initial'});
        if(signal.aborted)return;
        stage='INSPECT_AFTER';
        const after=await page.evaluate(inspectMessageImage,{mapping,event,imageIndex,peer,...(before.canvas?{mode:'CANVAS_VERIFY' as const}:{})});
        if(after.reason||after.sourceFingerprint!==before.sourceFingerprint||after.label!==before.label||
          (before.canvas?!after.canvas||after.canvas.width!==before.canvas.width||after.canvas.height!==before.canvas.height:JSON.stringify(after.clip)!==JSON.stringify(before.clip))){
          images.push({label:before.label,reason:'MESSAGE_PREVIEW_TARGET_CHANGED'});break;
        }
        stage='VERIFY_BINDING';
        const input:Parameters<typeof captureObserved>[0]={mapping,channel:'dm',index:0,evidenceId:'message-preview-only',dmWindow:true,peer};
        const final=await page.evaluate(captureObserved,input);
        if(!final.events.some(item=>eventBinding(item)===eventBinding(event))){images.push({label:before.label,reason:'MESSAGE_PREVIEW_TARGET_CHANGED'});break;}
        images.push(bytes.length<=maximumPreviewBytes?{label:before.label,png:bytes,width:before.canvas?.width??Math.round(before.clip!.width),height:before.canvas?.height??Math.round(before.clip!.height)}:
          {label:before.label,reason:'MESSAGE_PREVIEW_TOO_LARGE'});
      }catch{diagnostics.increment('caught',stage);images.push({label:before.label,reason:'MESSAGE_PREVIEW_CAPTURE_FAILED'});break;}
    }
    for(const image of images)if(!image.png)diagnostics.increment('unavailable',image.reason??'MESSAGE_PREVIEW_CAPTURE_FAILED');
    if(images.length&&!signal.aborted)try{
      store.save(event,mapping.self.uid,images);diagnostics.snapshot.ready+=store.list(event,mapping.self.uid).filter(item=>item.state==='READY').length;
    }catch{diagnostics.increment('caught','CACHE_WRITE');}
  }
  }finally{diagnostics.snapshot.cancelled=signal.aborted;await diagnostics.save(root);}
}
