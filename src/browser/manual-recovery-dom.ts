import type {ManualRecoveryRegion} from '../app/manual-recovery-contracts.js';

/** Serialized into the existing main document. It neither enters child frames nor changes the DOM. */
export function manualRecoveryElements(input:{selectors:string[]}):Element[]{
  const dom={visible(element:Element){
    if(!element.isConnected)return false;
    for(let node:Element|null=element;node;node=node.parentElement){
      const style=getComputedStyle(node);
      if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0)return false;
    }
    const rect=element.getBoundingClientRect();
    return rect.right>0&&rect.bottom>0&&rect.left<innerWidth&&rect.top<innerHeight&&rect.width>0&&rect.height>0;
  }};
  const roots=[...new Set(input.selectors.slice(0,8).flatMap(selector=>Array.from(document.querySelectorAll(selector)).slice(0,24)))].filter(dom.visible);
  const frames=[...new Set(roots.flatMap(root=>root.tagName==='IFRAME'?[root]:Array.from(root.querySelectorAll('iframe'))))].filter(dom.visible);
  // A security shell can cover the whole viewport. Its child challenge frame is the input boundary.
  if(frames.length)return frames.slice(0,24);
  return [...new Set(roots.flatMap(root=>{
    const rect=root.getBoundingClientRect();
    if(rect.width*rect.height<innerWidth*innerHeight*.75)return[root];
    return Array.from(root.querySelectorAll('button,input,textarea,canvas,img,svg,[role="button"]')).filter(dom.visible);
  }))].slice(0,24);
}

/** Validate the retained element itself; replacement nodes cannot inherit a previously displayed frame. */
export function inspectManualRecoveryElement(element:Element,input:{href:string;started:number;
  region?:ManualRecoveryRegion;point?:{x:number;y:number};focus?:boolean}):{
    documentMatches:boolean;region:ManualRecoveryRegion|null;permitted:boolean;
  }{
  const documentMatches=location.href===input.href&&performance.timeOrigin===input.started;
  if(!documentMatches||!element.isConnected)return{documentMatches,region:null,permitted:false};
  for(let node:Element|null=element;node;node=node.parentElement){
    const style=getComputedStyle(node);
    if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0)
      return{documentMatches,region:null,permitted:false};
  }
  const rect=element.getBoundingClientRect();
  let left=Math.max(0,rect.left),top=Math.max(0,rect.top),right=Math.min(innerWidth,rect.right),bottom=Math.min(innerHeight,rect.bottom);
  for(let parent=element.parentElement;parent;parent=parent.parentElement){
    const style=getComputedStyle(parent),box=parent.getBoundingClientRect();
    if(['hidden','clip','auto','scroll','overlay'].includes(style.overflowX)){left=Math.max(left,box.left);right=Math.min(right,box.right);}
    if(['hidden','clip','auto','scroll','overlay'].includes(style.overflowY)){top=Math.max(top,box.top);bottom=Math.min(bottom,box.bottom);}
  }
  if(!(right>left&&bottom>top))return{documentMatches,region:null,permitted:false};
  const region={x:left,y:top,width:right-left,height:bottom-top};
  if(input.region&&(['x','y','width','height'] as const).some(key=>Math.abs(region[key]-input.region![key])>.5))
    return{documentMatches,region,permitted:false};
  let permitted=true;
  if(input.point){
    const {x,y}=input.point,hit=document.elementFromPoint(x,y);
    permitted=x>=left&&x<right&&y>=top&&y<bottom&&!!hit&&(hit===element||element.contains(hit));
  }
  if(input.focus){
    const active=document.activeElement;
    permitted&&=!!active&&(active===element||element.contains(active));
  }
  return{documentMatches,region,permitted};
}
