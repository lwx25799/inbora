import type {ObservationMapping} from '../config/site-mapping.js';
import type {InboundEvent} from '../core/contracts.js';
import type {DiscoveredPeer} from './observed-reader.js';

/** Viewing-only native identity. Body/media readiness is intentionally not a reply or delivery proof. */
export function visibleStoredMessage(input:{mapping:ObservationMapping;event:InboundEvent;peer:DiscoveredPeer}):boolean{
  const {mapping:m,event,peer}=input,s=m.selectors;
  const dom={
    securityCheck(value:unknown,selectors:string[],kind:'TITLE'|'COMPONENT'='COMPONENT'):void {
      if(value)return;
      const matches=[];
      for(const selector of selectors.slice(0,8))for(const node of Array.from(document.querySelectorAll(selector)).slice(0,12-matches.length)){
        const r=node.getBoundingClientRect();matches.push({selector:selector.slice(0,2000),tag:node.tagName.slice(0,24),id:node.id.slice(0,160),
          left:r.left,top:r.top,right:r.right,bottom:r.bottom,visible:dom.securityVisible(node)});
      }
      const frames=Array.from(document.querySelectorAll('iframe')).slice(0,8).map(node=>{const r=node.getBoundingClientRect();
        return{src:(node.getAttribute('src')??'').slice(0,2048),title:node.title.slice(0,160),left:r.left,top:r.top,right:r.right,bottom:r.bottom};});
      const signal={version:1,state:'SUSPECT',kind,href:location.href.slice(0,2048),origin:location.origin.slice(0,256),title:document.title.slice(0,160),
        documentStartedAt:performance.timeOrigin,observedAt:Date.now(),scope:'TARGET',target:{conversationId:event.conversationId??undefined},matches,frames};
      throw Error('OBSERVATION_SECURITY_SUSPECT INBORA_SECURITY_SIGNAL:'+JSON.stringify(signal));
    },
    securityVisible(element:Element):boolean {
      for(const node of [element,...element.querySelectorAll('*')]){
        if(!node.isConnected)continue;
        let shown=true;
        for(let current:Element|null=node;current;current=current.parentElement){
          const style=getComputedStyle(current);
          if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0){shown=false;break;}
        }
        if(!shown)continue;
        const candidates:{rect:DOMRect;parent:Element|null}[]=/^(?:IFRAME|IMG|CANVAS|VIDEO|AUDIO|INPUT|BUTTON|SELECT|TEXTAREA|SVG|OBJECT|EMBED)$/u.test(node.tagName)?Array.from(node.getClientRects(),rect=>({rect,parent:node.parentElement})):[];
        for(const child of node.childNodes){
          if(child.nodeType!==Node.TEXT_NODE||!child.nodeValue?.trim())continue;
          const range=document.createRange();range.selectNodeContents(child);
          for(const rect of range.getClientRects())candidates.push({rect,parent:node});
        }
        for(const {rect,parent} of candidates){
          let left=Math.max(0,rect.left),top=Math.max(0,rect.top),right=Math.min(innerWidth,rect.right),bottom=Math.min(innerHeight,rect.bottom);
          if(!(right>left&&bottom>top))continue;
          for(let current=parent;current;current=current.parentElement){
            const style=getComputedStyle(current);
            if(style.display==='contents')continue;
            const clipX=['hidden','clip','auto','scroll','overlay'].includes(style.overflowX);
            const clipY=['hidden','clip','auto','scroll','overlay'].includes(style.overflowY);
            if(!clipX&&!clipY)continue;
            const box=current.getBoundingClientRect();
            if(clipX){left=Math.max(left,box.left);right=Math.min(right,box.right);}
            if(clipY){top=Math.max(top,box.top);bottom=Math.min(bottom,box.bottom);}
            if(!(right>left&&bottom>top))break;
          }
          if(right>left&&bottom>top)return true;
        }
      }
      return false;
    },
    check(value:unknown):void{if(!value)throw Error('MESSAGE_VIEW_TARGET_CHANGED');},
    data(value:unknown,key:string):unknown{
      if(!value||typeof value!=='object')return undefined;
      const own=Object.getOwnPropertyDescriptor(value,key),inherited=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(value)??{},key);
      dom.check((!own||Object.hasOwn(own,'value'))&&(!inherited||Object.hasOwn(inherited,'value'))&&(!own||!inherited||own.value===inherited.value));
      return own?own.value:inherited?.value;
    },
    visible(node:Element):boolean{
      if(!node.isConnected||!node.getClientRects().length)return false;
      const rect=node.getBoundingClientRect();if(rect.right<=0||rect.left>=innerWidth||rect.bottom<=0||rect.top>=innerHeight)return false;
      for(let current:Element|null=node;current;current=current.parentElement){const style=getComputedStyle(current),clip=current.getBoundingClientRect();
        if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0)return false;
        if(current!==node&&(/auto|scroll|hidden|clip/u.test(style.overflowY)&&rect.bottom<=clip.top||
          /auto|scroll|hidden|clip/u.test(style.overflowY)&&rect.top>=clip.bottom))return false;
        if(current!==node&&(/auto|scroll|hidden|clip/u.test(style.overflowX)&&rect.right<=clip.left||
          /auto|scroll|hidden|clip/u.test(style.overflowX)&&rect.left>=clip.right))return false;
      }
      return true;
    },
    one(root:Element|Document,selector:string):Element{
      const rows=Array.from(root.querySelectorAll(selector)).filter(dom.visible);dom.check(rows.length===1);return rows[0]!;
    },
    react(node:Element,prefix:string):unknown{const keys=Object.getOwnPropertyNames(node).filter(key=>key.startsWith(prefix));dom.check(keys.length===1);return dom.data(node,keys[0]!);},
    props(node:Element):unknown{const children=dom.data(dom.react(node,'__reactProps$'),'children');return dom.data(Array.isArray(children)?dom.data(children,'0'):children,'props');},
  };
  dom.check(location.origin===m.origin);
  dom.securityCheck(!/验证码|安全验证|访问受限/u.test(document.title),[m.securityBlockers],'TITLE');
  dom.securityCheck(!Array.from(document.querySelectorAll(m.securityBlockers)).some(dom.securityVisible),[m.securityBlockers]);
  let fiber=dom.react(dom.one(document,s.selfAvatar),'__reactFiber$');for(let level=0;level<s.selfFiberDepth;level++)fiber=dom.data(fiber,'return');
  const own=dom.data(fiber,'memoizedProps');dom.check(dom.data(own,'uid')===m.self.uid&&dom.data(own,'secUid')===m.self.secUid);
  const chat=dom.one(document,s.chat),nativeChat=dom.data(dom.props(dom.one(chat,s.chatHeader)),'conversation');
  const first=dom.data(nativeChat,'conversationId'),second=dom.data(nativeChat,'id');
  dom.check((first===undefined||second===undefined||first===second)&&(first??second)===event.conversationId&&event.conversationId===peer.conversationId&&
    dom.data(nativeChat,'_toParticipantSecUserId')===peer.secUid&&dom.one(chat,s.chatTitle).textContent?.trim()===peer.title);
  dom.check(event.accountId==='account_001'&&event.channel==='DIRECT_MESSAGE'&&event.kind==='DM'&&event.videoId===null&&event.commentId===null&&
    event.rootCommentId===undefined&&event.replyToCommentId===undefined&&(event.occurredAtPrecisionMs??1)===1);
  const rows=Array.from(chat.querySelectorAll(s.messages)).filter(dom.visible);dom.check(rows.length<=100);
  const matches=rows.filter(row=>dom.data(dom.data(dom.props(row),'message'),'serverId')===event.platformEventId);dom.check(matches.length<=1);
  if(!matches.length)return false;const row=matches[0]!,native=dom.data(dom.props(row),'message');
  dom.check(dom.data(native,'conversationId')===event.conversationId&&dom.data(native,'sender')===event.actorId);
  const date=dom.data(native,'createdAt');let at=NaN;try{at=Date.prototype.getTime.call(date);}catch{/* No Date proof. */}
  dom.check(Number.isFinite(at)&&new Date(at).toISOString()===event.occurredAt);
  const box=row.closest(s.messageBox);dom.check(box&&chat.contains(box));let fromMe=false;
  for(let node:Element|null=row;node&&box!.contains(node);node=node.parentElement)if(node.classList.contains(s.fromMeClass))fromMe=true;
  dom.check(fromMe===(event.direction==='OUTGOING')&&fromMe===(event.actorId===m.self.uid)&&
    (fromMe||event.actorId===peer.uid));return true;
}
