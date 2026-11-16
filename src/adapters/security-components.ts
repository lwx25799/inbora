/** Serialized safety-component check. Keep the local capture predicates equivalent. */
export function hasVisibleSecurityComponent(selectors:string[]):boolean {
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
  return selectors.some(selector=>Array.from(document.querySelectorAll(selector)).some(dom.securityVisible));
}
