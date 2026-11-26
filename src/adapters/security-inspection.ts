import type {SecuritySignal} from './security-signal.js';

/** A bounded snapshot of this document only; never enters child-frame state or reads application getters. */
export function inspectSecuritySignal(input:{selectors:string[];expectedOrigin?:string}):SecuritySignal {
  const dom={
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
  };
  const matches:SecuritySignal['matches']=[];let hasVisible=false;
  for(const selector of input.selectors.slice(0,8)){
    hasVisible||=Array.from(document.querySelectorAll(selector)).some(dom.securityVisible);
    for(const node of Array.from(document.querySelectorAll(selector)).slice(0,12-matches.length)){
      const rect=node.getBoundingClientRect();matches.push({selector:selector.slice(0,2000),tag:node.tagName.slice(0,24),id:node.id.slice(0,160),
        left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,visible:dom.securityVisible(node)});
    }
  }
  const frames=Array.from(document.querySelectorAll('iframe')).slice(0,8).map(node=>{
    const rect=node.getBoundingClientRect();return{src:(node.getAttribute('src')??'').slice(0,2048),title:node.title.slice(0,160),
      left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom};
  });
  const title=document.title.slice(0,160),titleSignal=/验证码|安全验证|访问受限/u.test(title);
  return{version:1,state:titleSignal||hasVisible?'SUSPECT':'CLEAR',kind:titleSignal?'TITLE':'COMPONENT',
    href:location.href.slice(0,2048),origin:location.origin.slice(0,256),title,documentStartedAt:performance.timeOrigin,observedAt:Date.now(),scope:'ACCOUNT_PAGE',matches,frames};
}
