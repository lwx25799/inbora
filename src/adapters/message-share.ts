import type {InboundEvent} from '../core/contracts.js';
import type {ObservationMapping} from '../config/site-mapping.js';
import type {DiscoveredPeer} from './observed-reader.js';
import type {MessageShare} from '../storage/message-shares.js';

export interface ShareInspection {
  share:MessageShare|null;detected:boolean;
  diagnostic:{anchors:number;cardMarkers:number;nativeItemIdPresent:boolean;nativeItemIdConflict:boolean;urlKinds:Record<string,number>;
    nativeKinds:{aweType:number|null;awemeType:number|null;isSlides:boolean|null};
    shareInfo:{type:string;fields:{key:string;type:string;urlKind:string}[]}[];parsedFields:{key:string;type:string;digitId:boolean}[]};
}
interface ShareInput {mapping:ObservationMapping;event:InboundEvent;peer:DiscoveredPeer}

/** Exact mapped native message only. No handler, getter, navigation, media request or text extraction. */
export function inspectMessageShare(input:ShareInput):ShareInspection {
  const {mapping:m,event,peer}=input,s=m.selectors;
  const dom={
    check(value:unknown):void{if(!value)throw Error('MESSAGE_SHARE_TARGET_CHANGED');},
    data(object:unknown,key:string):unknown{
      if(!object||typeof object!=='object')return undefined;
      const own=Object.getOwnPropertyDescriptor(object,key),inherited=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(object)??{},key);
      dom.check((!own||Object.hasOwn(own,'value'))&&(!inherited||Object.hasOwn(inherited,'value'))&&(!own||!inherited||own.value===inherited.value));
      return own?own.value:inherited?.value;
    },
    visible(node:Element):boolean{
      if(!node.isConnected||!node.getClientRects().length)return false;
      for(let current:Element|null=node;current;current=current.parentElement){const style=getComputedStyle(current);
        if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0)return false;}
      return true;
    },
    one(selector:string,root:Element|Document=document):Element{
      const nodes=root.querySelectorAll(selector);dom.check(nodes.length===1&&dom.visible(nodes[0]!));return nodes[0]!;
    },
    react(node:Element,prefix:string):unknown{
      const keys=Object.getOwnPropertyNames(node).filter(key=>key.startsWith(prefix));dom.check(keys.length===1);return dom.data(node,keys[0]!);
    },
    child(node:Element):unknown{
      const children=dom.data(dom.react(node,'__reactProps$'),'children');return dom.data(Array.isArray(children)?dom.data(children,'0'):children,'props');
    },
    work(raw:string):MessageShare|null{
      if(!raw||raw.length>2000)return null;
      try{const url=new URL(raw,location.href),match=/^\/(video|note)\/(\d{1,64})\/?$/u.exec(url.pathname);
        if(url.protocol!=='https:'||!['www.douyin.com','douyin.com'].includes(url.hostname)||url.username||url.password||url.port||!match)return null;
        return {kind:'DOUYIN_WORK',url:'https://www.douyin.com/'+match[1]+'/'+match[2],workId:match[2]!};
      }catch{return null;}
    },
  };
  dom.check(event.channel==='DIRECT_MESSAGE'&&!!event.platformEventId&&!!event.conversationId&&!!event.actorId&&!!event.occurredAt&&
    location.origin===m.origin&&!/验证码|安全验证/u.test(document.title)&&!Array.from(document.querySelectorAll(m.securityBlockers)).some(dom.visible));
  let fiber=dom.react(dom.one(s.selfAvatar),'__reactFiber$');for(let index=0;index<s.selfFiberDepth;index++)fiber=dom.data(fiber,'return');
  const own=dom.data(fiber,'memoizedProps');dom.check(dom.data(own,'uid')===m.self.uid&&dom.data(own,'secUid')===m.self.secUid);
  const chat=dom.one(s.chat),conversation=dom.data(dom.child(dom.one(s.chatHeader,chat)),'conversation');
  const first=dom.data(conversation,'conversationId'),second=dom.data(conversation,'id');
  dom.check((first===undefined||second===undefined||first===second)&&(first??second)===event.conversationId&&event.conversationId===peer.conversationId&&
    dom.data(conversation,'_toParticipantSecUserId')===peer.secUid&&dom.one(s.chatTitle,chat).textContent?.trim()===peer.title);
  const rows=Array.from(chat.querySelectorAll(s.messages)).filter(row=>dom.data(dom.data(dom.child(row),'message'),'serverId')===event.platformEventId);
  dom.check(rows.length===1&&dom.visible(rows[0]!));const row=rows[0]!,native=dom.data(dom.child(row),'message');
  dom.check(dom.data(native,'conversationId')===event.conversationId&&dom.data(native,'sender')===event.actorId);
  const date=dom.data(native,'createdAt');let at=NaN;try{at=Date.prototype.getTime.call(date);}catch{/* Not a native date. */}
  dom.check(Number.isFinite(at)&&new Date(at).toISOString()===event.occurredAt);
  let fromMe=false;const box=row.closest(s.messageBox);dom.check(box);
  for(let node:Element|null=row;node&&box!.contains(node);node=node.parentElement)if(node.classList.contains(s.fromMeClass))fromMe=true;
  dom.check(fromMe===(event.direction==='OUTGOING')&&fromMe===(event.actorId===m.self.uid));
  const anchors=Array.from(row.querySelectorAll('a[href]')).filter(node=>node.closest(s.messages)===row&&dom.visible(node));
  dom.check(anchors.length<=20);
  const candidates=new Map<string,MessageShare>(),urlKinds:Record<string,number>={};
  for(const anchor of anchors){const share=dom.work(anchor.getAttribute('href')??'');if(share)candidates.set(share.url,share);}
  // These upstream card markers are diagnostic candidates, not proof of a work ID or its route.
  const cardMarkers=Array.from(row.querySelectorAll('[class*="MessageItemShareAwemecontainer"],[data-e2e="shared-video-card"]'))
    .filter(node=>node.closest(s.messages)===row&&dom.visible(node)).length;
  const parsed=dom.data(native,'_parsedContent'),fields:ShareInspection['diagnostic']['parsedFields']=[];
  const itemId=parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?dom.data(parsed,'itemId'):undefined;
  const nativeItemId=typeof itemId==='string'&&/^\d{1,64}$/u.test(itemId)?itemId:null;
  const firstType=dom.data(parsed,'aweType'),secondType=dom.data(parsed,'awemeType'),slides=dom.data(parsed,'is_slides');
  const aweType=Number.isSafeInteger(firstType)&&Number(firstType)>=0&&Number(firstType)<=1000?Number(firstType):null;
  const awemeType=Number.isSafeInteger(secondType)&&Number(secondType)>=0&&Number(secondType)<=1000?Number(secondType):null;
  const nativeKinds={aweType,awemeType,isSlides:typeof slides==='boolean'?slides:null};
  const info=dom.data(parsed,'share_info'),shareInfo:ShareInspection['diagnostic']['shareInfo']=[];
  if(Array.isArray(info))for(let index=0;index<Math.min(3,info.length);index++){
    const value=dom.data(info,String(index)),fields:ShareInspection['diagnostic']['shareInfo'][number]['fields']=[];
    if(value&&typeof value==='object'&&!Array.isArray(value))for(const key of Object.getOwnPropertyNames(value).slice(0,16)){
      if(!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(key))continue;const descriptor=Object.getOwnPropertyDescriptor(value,key)!,field=descriptor.value;
      const work=Object.hasOwn(descriptor,'value')&&typeof field==='string'?dom.work(field):null;
      fields.push({key,type:Object.hasOwn(descriptor,'value')?Array.isArray(field)?'array':field===null?'null':typeof field:'accessor',
        urlKind:work?work.url.includes('/note/')?'DOUYIN_NOTE':'DOUYIN_VIDEO':typeof field==='string'&&/^(?:https?:|\/)/u.test(field)?'OTHER_URL':'NOT_URL'});
    }
    shareInfo.push({type:Array.isArray(value)?'array':value===null?'null':typeof value,fields});
  }
  if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)){
    const descriptors=Object.getOwnPropertyDescriptors(parsed),keys=Object.keys(descriptors);dom.check(keys.length<=64);
    for(const key of keys.slice(0,32)){
      if(!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(key))continue;const descriptor=descriptors[key]!,value=descriptor.value;
      const digitId=Object.hasOwn(descriptor,'value')&&typeof value==='string'&&/^\d{1,64}$/u.test(value);
      fields.push({key,type:Object.hasOwn(descriptor,'value')?Array.isArray(value)?'array':value===null?'null':typeof value:'accessor',digitId});
      if(Object.hasOwn(descriptor,'value')&&typeof value==='string'&&value.length<=2000){
        const work=dom.work(value),kind=work?'DOUYIN_WORK':/^(?:https?:|\/)/u.test(value)?'OTHER_URL':'NOT_URL';urlKinds[kind]=(urlKinds[kind]??0)+1;
      }
    }
  }
  let candidate=candidates.size===1?[...candidates.values()][0]!:null;
  // F2 f6be8c0 (Apache-2.0), douyin/dl.py:22-38 records 0/55 as video; this does not require is_slides to be present.
  // Keep the explicit slideshow route and invalid metadata distinct. aweType remains a separate IM field.
  const invalidSlides=slides!==undefined&&typeof slides!=='boolean';
  const route=slides===true?'note':!invalidSlides&&(awemeType===0||awemeType===55)?'video':null;
  if(candidates.size===0&&cardMarkers===1&&nativeItemId&&route)candidate={kind:'DOUYIN_WORK',url:'https://www.douyin.com/'+route+'/'+nativeItemId,workId:nativeItemId};
  const nativeItemIdConflict=!!nativeItemId&&!!candidate&&nativeItemId!==candidate.workId;
  return {share:nativeItemIdConflict?null:candidate,detected:cardMarkers>0||candidates.size>0,
    diagnostic:{anchors:anchors.length,cardMarkers,nativeItemIdPresent:!!nativeItemId,nativeItemIdConflict,nativeKinds,shareInfo,urlKinds,parsedFields:fields}};
}
