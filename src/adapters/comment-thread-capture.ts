import type {InboundEvent} from '../core/contracts.js';
import type {ObservationMapping} from '../config/site-mapping.js';

export interface CommentThreadWindow {initialTotal:number;total:number;mounted:number;offset:number;nextOffset:number;expandable:boolean;expanded:boolean}
export interface CommentThreadInput {mapping:ObservationMapping;event:InboundEvent;action:'open'|'position'|'inspect';offset:number}

/** Same calibrated root/leaf expand control as the reply adapter. No page handlers or private requests. */
export function captureCommentThread(input:CommentThreadInput):CommentThreadWindow {
  const {mapping:m,event:e}=input,s=m.selectors;
  const dom={
    check(value:unknown,code:string):void {if(!value)throw Error(code);},
    data(object:unknown,key:string):unknown {
      if(!object||typeof object!=='object')return undefined;
      const own=Object.getOwnPropertyDescriptor(object,key),inherited=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(object)??{},key);
      dom.check((!own||Object.hasOwn(own,'value'))&&(!inherited||Object.hasOwn(inherited,'value')),'RENDERED_ACCESSOR_UNSUPPORTED');
      dom.check(!own||!inherited||own.value===inherited.value,'RENDERED_FIELD_CONFLICT');return own?own.value:inherited?.value;
    },
    props(element:Element,depth:number):unknown {
      const keys=Object.getOwnPropertyNames(element).filter(key=>key.startsWith('__reactFiber$'));
      dom.check(keys.length===1,'RENDERED_BINDING_UNAVAILABLE');let fiber=dom.data(element,keys[0]!);
      for(let n=0;n<depth;n++)fiber=dom.data(fiber,'return');return dom.data(fiber,'memoizedProps');
    },
    visible(element:Element):boolean {
      if(!element.isConnected||!element.getClientRects().length)return false;
      for(let n:Element|null=element;n;n=n.parentElement){const style=getComputedStyle(n);
        if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0)return false;}
      return true;
    },
    owned(root:Element,selector:string,visible=true):Element[]{return Array.from(root.querySelectorAll(selector)).filter(n=>n.closest(s.commentRows)===root&&(!visible||dom.visible(n)));},
    text(body:Element,row:Element):string|null {
      let count=0,length=0,images=0;
      const walk={read(node:Node):string|null {
        if(++count>200)return null;
        if(node.nodeType===Node.TEXT_NODE){length+=(node.nodeValue??'').length;return length<=10_000?node.nodeValue??'':null;}
        if(!(node instanceof Element)||node.closest(s.commentRows)!==row||node.closest('[data-e2e="im-dialog"]')||
          !['DIV','P','SPAN','BR','B','I','EM','STRONG','U','S','A','IMG'].includes(node.tagName))return null;
        const style=getComputedStyle(node);if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0)return '';
        if(node.tagName==='BR'){length++;return length<=10_000?'\n':null;}
        if(node.tagName==='IMG'){
          const alt=node.getAttribute('alt'),src=node.getAttribute('src');
          if(++images>8||node.childNodes.length||node.closest('a[href]')||!alt||alt.length>32||/[\x00-\x1f\x7f]/.test(alt)||
            !/(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3)/u.test(alt)&&!/^\[[^\[\]\r\n]{1,20}\]$/.test(alt)||!src)return null;
          try{const url=new URL(src,location.origin);if(url.username||url.password||url.protocol!=='https:'&&
            !(m.environment==='fixture'&&url.origin===location.origin))return null;}catch{return null;}
          length+=alt.length;return length<=10_000?alt:null;
        }
        let value='';for(const child of node.childNodes){const part=walk.read(child);if(part===null)return null;value+=part;}return value;
      }};return walk.read(body);
    },
    empty():void {
      for(const editor of document.querySelectorAll('[contenteditable="true"],textarea,input')){
        if(!dom.visible(editor)||editor instanceof HTMLInputElement&&!['text','search','email','url','tel','password'].includes(editor.type))continue;
        const text=editor instanceof HTMLInputElement||editor instanceof HTMLTextAreaElement?editor.value:editor.textContent??'';
        dom.check(!editor.querySelector('img,video,audio,iframe,object,input,[data-slate-void="true"],[data-attachment]'),'OBSERVATION_EXISTING_HUMAN_INPUT');
        const marker=editor.matches('[data-slate-editor="true"][data-zone-container="*"]')&&editor.children.length===1&&
          editor.firstElementChild?.matches('div.ace-line[data-node="true"]')&&editor.firstElementChild.children.length===1&&
          editor.firstElementChild.firstElementChild?.matches('span[data-enter="true"][data-string="true"][data-leaf="true"]')&&text==='\u200B';
        dom.check(text.length===0||marker,'OBSERVATION_EXISTING_HUMAN_INPUT');
        dom.check(Array.from(editor.querySelectorAll('*')).every(n=>['DIV','P','SPAN','BR','B','I','EM','STRONG','U','S'].includes(n.tagName)),
          'OBSERVATION_EXISTING_HUMAN_INPUT');
      }
    },
    root():Element {
      dom.check(location.origin===m.origin&&m.works.some(w=>w.id===e.videoId&&w.url.split('?')[0]===location.href.split('?')[0]),'OBSERVATION_WORK_CHANGED');
      dom.check(!/验证码|安全验证|访问受限/.test(document.title)&&!Array.from(document.querySelectorAll(m.securityBlockers)).some(dom.visible),'OBSERVATION_PAGE_BLOCKED');
      const own=Array.from(document.querySelectorAll(s.selfAvatar));dom.check(own.length===1,'OBSERVATION_ACCOUNT_CHANGED');
      const identity=dom.props(own[0]!,s.selfFiberDepth);dom.check(dom.data(identity,'uid')===m.self.uid&&dom.data(identity,'secUid')===m.self.secUid,'OBSERVATION_ACCOUNT_CHANGED');
      const lists=Array.from(document.querySelectorAll(s.commentList)).filter(dom.visible);dom.check(lists.length===1,'OBSERVATION_DOM_NOT_UNIQUE');
      const tipsForRoot=Array.from(lists[0]!.querySelectorAll(s.commentTooltip)).filter(n=>n.id===`tooltip_${e.commentId}`);
      dom.check(tipsForRoot.length===1,'OBSERVATION_COMMENT_THREAD_CHANGED');const root=tipsForRoot[0]!.closest(s.commentRows);
      dom.check(root&&!root.parentElement?.closest(s.commentRows)&&dom.visible(root),'OBSERVATION_COMMENT_THREAD_CHANGED');
      const props=dom.props(root!,s.commentFiberDepth),native=dom.data(props,'commentInfo');
      const user=dom.data(native,'user'),authors=dom.owned(root!,s.commentAuthor),bodies=dom.owned(root!,s.commentText),tips=dom.owned(root!,s.commentTooltip,false);
      const href=authors.length===1?new URL(authors[0]!.getAttribute('href')??'',location.origin):null;
      const at=dom.data(native,'createTime'),millis=typeof at==='number'?at*1000:NaN;
      dom.check(Number.isFinite(millis)&&millis>=Date.UTC(2000,0,1)&&millis<=Date.now(),'OBSERVATION_COMMENT_THREAD_CHANGED');const time=new Date(millis).toISOString();
      dom.check(e.channel==='COMMENT_NOTIFICATION'&&e.kind==='COMMENT'&&dom.data(native,'cid')===e.commentId&&dom.data(props,'level')===1&&dom.data(native,'replyId')==='0'&&
        dom.data(dom.data(props,'awemeInfo'),'awemeId')===e.videoId&&dom.data(dom.data(props,'userInfo'),'uid')===m.self.uid&&
        dom.data(user,'uid')===e.actorId&&href?.origin===m.origin&&!href.username&&!href.password&&href.pathname===`/user/${String(dom.data(user,'secUid'))}`&&
        bodies.length===1&&dom.data(native,'text')===e.text&&dom.text(bodies[0]!,root!)===e.text&&time===e.occurredAt&&
        tips.length===1&&tips[0]!.id===`tooltip_${e.commentId}`,'OBSERVATION_COMMENT_THREAD_CHANGED');return root!;
    },
    buttons(root:Element):Element[]{return Array.from(root.querySelectorAll('span,button,div')).filter(n=>n.closest(s.commentRows)===root&&
      !n.childElementCount&&dom.visible(n)&&/^展开\d+条回复$/.test(n.textContent??''));},
  };
  const root=dom.root(),initialTotal=dom.data(dom.data(dom.props(root,s.commentFiberDepth),'commentInfo'),'replyTotal');let expanded=false;
  dom.check(typeof initialTotal==='number'&&Number.isSafeInteger(initialTotal)&&initialTotal>=0,'OBSERVATION_COMMENT_THREAD_METADATA_NOT_READY');
  const buttons=dom.buttons(root);dom.check(buttons.length<=1,'OBSERVATION_COMMENT_EXPAND_NOT_UNIQUE');
  if(input.action==='open'&&buttons[0]){
    dom.empty();const button=buttons[0];dom.check(button instanceof HTMLElement,'OBSERVATION_COMMENT_EXPAND_NOT_INTERACTABLE');
    button.scrollIntoView({block:'center'});
    const gate={handle(event:Event):void{try{dom.check(event.currentTarget===button&&dom.root()===root&&button.isConnected&&dom.buttons(root)[0]===button,
      'OBSERVATION_COMMENT_THREAD_CHANGED');dom.empty();}catch{event.preventDefault();event.stopImmediatePropagation();}}};
    button.addEventListener('click',gate.handle,true);try{(button as HTMLElement).click();expanded=true;}finally{button.removeEventListener('click',gate.handle,true);}
  }
  const current=dom.root(),native=dom.data(dom.props(current,s.commentFiberDepth),'commentInfo'),total=dom.data(native,'replyTotal');
  dom.check(typeof total==='number'&&Number.isSafeInteger(total)&&total>=0,'OBSERVATION_COMMENT_THREAD_METADATA_NOT_READY');
  const children=Array.from(current.querySelectorAll(s.commentRows)).filter(n=>n.parentElement?.closest(s.commentRows)===current&&dom.visible(n));
  const offset=input.offset<children.length?input.offset:0;
  if(input.action==='position'&&children[offset]){dom.empty();children[offset]!.scrollIntoView({block:'center'});dom.check(dom.root()===current,'OBSERVATION_COMMENT_THREAD_CHANGED');}
  const remaining=dom.buttons(current);dom.check(remaining.length<=1,'OBSERVATION_COMMENT_EXPAND_NOT_UNIQUE');
  return {initialTotal:initialTotal as number,total:total as number,mounted:children.length,offset,nextOffset:Math.min(children.length,offset+100),expandable:remaining.length===1,expanded};
}
