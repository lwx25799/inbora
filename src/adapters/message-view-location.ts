import type {ObservationMapping} from '../config/site-mapping.js';
import type {InboundEvent} from '../core/contracts.js';
import type {DiscoveredPeer} from './observed-reader.js';

/** Viewing-only native identity. Body/media readiness is intentionally not a reply or delivery proof. */
export function visibleStoredMessage(input:{mapping:ObservationMapping;event:InboundEvent;peer:DiscoveredPeer}):boolean{
  const {mapping:m,event,peer}=input,s=m.selectors;
  const dom={
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
  dom.check(location.origin===m.origin&&!/验证码|安全验证/u.test(document.title)&&!Array.from(document.querySelectorAll(m.securityBlockers)).some(dom.visible));
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
