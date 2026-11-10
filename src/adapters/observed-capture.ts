import type { ObservationMapping } from '../config/site-mapping.js';
import type {InboundEvent} from '../core/contracts.js';
import type {CommentThreadWindow} from './comment-thread-capture.js';

export interface DiscoveredPeer { uid: string | null; secUid: string; conversationId: string; title: string;activity?:string }
export interface CaptureInput { mapping: ObservationMapping; channel: 'identity' | 'dm' | 'comments' | 'row' | 'locate' | 'conversations' | 'navigate' | 'back' | 'commentScroll' | 'commentReveal' | 'diagnostic' | 'dmScroll'; index: number;
  evidenceId: string; rowIndex?: number; select?: boolean; scroll?: 'start' | 'next'; peer?: DiscoveredPeer; allCommentAuthors?: boolean; navigationUrl?: string; commentOffset?:number; commentStay?:boolean;
  commentRootId?:string;commentChildOffset?:number;conversationOffset?:number; diagnosticSource?:'dm'|'comments'; dmWindow?:boolean; dmTop?:number; collectionPartial?:boolean }
export type CaptureOptions = Pick<CaptureInput,'rowIndex'|'select'|'scroll'|'peer'|'allCommentAuthors'|'diagnosticSource'|'dmWindow'|'dmTop'|'conversationOffset'|'collectionPartial'|'navigationUrl'|'commentRootId'|'commentChildOffset'|'commentOffset'|'commentStay'>;
interface CommentScrollShape {depth:number;tag:string;overflowY:string;clientHeight:number;scrollHeight:number;scrollTop:number;visible:boolean;containsList:boolean}
export interface CommentRelationField {type:'ABSENT'|'ACCESSOR'|'CONFLICT'|'STRING'|'NUMBER'|'NULL'|'OTHER';nativeId:boolean;zero:boolean;root:boolean;child:boolean;self:boolean}
export interface CommentRelationShape {sampled:number;truncated:boolean;samples:{own:boolean;rootBound:boolean;replyToReplyId:CommentRelationField;replyToReplyID:CommentRelationField}[]}
export interface CollectionReadDiagnostic {
  source:'dm'|'comments';containers:number;visibleContainers:number;rows:number;visibleRows:number;roots:number;windowRoots:number;
  viewportHeight:number;containerTop:number;containerBottom:number;scrollTop:number;chatVisible:boolean;
  chatInViewport:boolean;backVisible:boolean;backInViewport:boolean;
  commentScroll?:{ancestors:CommentScrollShape[];document:CommentScrollShape|null;selectedDepth:number|null;documentFallback:boolean;truncated:boolean};
  commentPagination?:{scanned:number;truncated:boolean;samples:{kind:'MORE_COMMENTS'|'LOAD_MORE'|'VIEW_ALL'|'NO_MORE'|'EMPTY';tag:string;top:number;bottom:number;visible:boolean;inViewport:boolean}[]};
  back?:{count:number;centerHit?:'SELF'|'DESCENDANT'|'OUTSIDE'|'NONE'|'OFFSCREEN';centerIndex?:number|null;
    nodes?:{index:number;parentIndex:number|null;tag:'DIV'|'BUTTON'|'SPAN'|'A'|'SVG'|'PATH'|'OTHER';visible:boolean;inViewport:boolean;width:number;height:number;
      props:'NONE'|'DATA'|'REJECTED';handlers:{onClick:boolean;onMouseDown:boolean;onPointerDown:boolean;onMouseUp:boolean}}[]};
  commentChildren?:{rootRows:number;childRows:number;samples:{ownedAuthors:number;visibleProfiles:number;nativeUidPresent:boolean;nativeSecurePresent:boolean;
    profileMatchesNative:boolean;nativeProfileMatches:number;metadataReadable:boolean;hasRootNative:boolean;levelIs2:boolean;rootMatches:boolean;visibleBodies:number}[]};
  shareStage?:'CHAT_NOT_READY'|'HEADER_NOT_READY'|'CONVERSATION_UNVERIFIED'|'VERIFIED';
  windowRows?:number;contentMissingRows?:number;
  conversationSamples?:{titleCount:number;titleVisible:boolean;titleNonEmpty:boolean;nativeConversationPresent:boolean;securePeerPresent:boolean;metadataReadable:boolean}[];
  messageSamples?:{windowIndex:number;contentMissing:boolean;nativeIdPresent:boolean;conversationMatches:boolean;senderKnown:boolean;
    nativeKind:number|null;nativeStatus:number|null;timeValid:boolean;parsedPresent:boolean;parsedRejected:boolean;parsedTruncated:boolean;
    nativeShare?:{aweType:number|null;awemeType:number|null;slides:boolean|null;itemIdPresent:boolean;route:'VIDEO'|'NOTE'|'UNAVAILABLE'};
    textNodes:number;visibleTextNodes:number;nonEmptyTextNodes:number;visibleMediaNodes:number;visibleCardNodes:number;parsedFields:{key:string;type:'string'|'number'|'boolean'|'object'|'array'|'null'|'undefined'|'accessor'|'other';
      digitId:boolean;urlKind:'NONE'|'DOUYIN_VIDEO'|'DOUYIN_NOTE'|'HTTP_OTHER'|'DATA'|'BLOB'|'OTHER'}[]}[];
  samples:{visible:boolean;inWindow:boolean;hasBox:boolean;displayContents:boolean;top:number;bottom:number;width:number;height:number;bodies:number;visibleBodies:number}[];
}
export interface ObservationBatch { events: InboundEvent[]; evidenceId: string; unsupported: number; loaded: number; incomplete?:'CONTENT_NOT_READY';
  commentRelations?:CommentRelationShape;
  dmCoverage?:{id:string;occurredAt:string;precisionMs:number;captured:boolean}[];
  conversation?: { rowIndex: number | null; hasList: boolean };
  peers?: DiscoveredPeer[];
  scroll?:{top:number;height:number;viewport:number;atEnd:boolean};
  diagnostic?:CollectionReadDiagnostic;
  dmViewport?:{top:number;height:number;viewport:number;minimum:number;maximum:number};
  commentThreads?:{id:string;total:number|null;expandable:boolean;mounted:number}[];
  commentThread?:CommentThreadWindow&{beforeTotal:number};
  commentRestoreIncomplete?:true;commentRestoreStableEnd?:true;
  bindings?: {targetKey: string; uid: string; secUid: string; title: string; conversationId: string | null}[] }

/** Fixed paths in the currently rendered, authorized components; never calls website functions or getters. */
export function captureObserved(input: CaptureInput): ObservationBatch {
  const { mapping: m, channel, index, evidenceId } = input; const s = m.selectors;
  const dom = {
    check(value: unknown, code: string): void { if (!value) throw new Error(code); },
    // Adapted from LockyBee chat-browser.mjs dataField; MIT notice in third_party/.
    // Reject unsupported descriptors explicitly instead of returning an absent value.
    data(object: unknown, key: string): unknown {
      if (!object || typeof object !== 'object') return undefined;
      const own = Object.getOwnPropertyDescriptor(object,key);
      const inherited = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(object) ?? {},key);
      dom.check(!own || Object.hasOwn(own,'value'), 'RENDERED_ACCESSOR_UNSUPPORTED');
      dom.check(!inherited || Object.hasOwn(inherited,'value'), 'RENDERED_ACCESSOR_UNSUPPORTED');
      dom.check(!own || !inherited || own.value === inherited.value, 'RENDERED_FIELD_CONFLICT');
      return own ? own.value : inherited?.value;
    },
    relation(object:unknown,key:'replyToReplyId'|'replyToReplyID',root:string,id:string,children:Set<string>):CommentRelationField {
      const shape:CommentRelationField={type:'ABSENT',nativeId:false,zero:false,root:false,child:false,self:false};
      if(!object||typeof object!=='object')return shape;
      const own=Object.getOwnPropertyDescriptor(object,key),parent=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(object)??{},key);
      if(own&&!Object.hasOwn(own,'value')||parent&&!Object.hasOwn(parent,'value'))return{...shape,type:'ACCESSOR'};
      if(own&&parent&&own.value!==parent.value)return{...shape,type:'CONFLICT'};
      const value=own?own.value:parent?.value;
      shape.type=value===undefined?'ABSENT':value===null?'NULL':typeof value==='string'?'STRING':typeof value==='number'?'NUMBER':'OTHER';
      shape.nativeId=typeof value==='string'&&/^[1-9]\d{0,63}$/u.test(value);shape.zero=value==='0';shape.root=value===root;
      shape.self=value===id;shape.child=shape.nativeId&&!shape.self&&children.has(value as string);return shape;
    },
    // Bounded text and inline emoji reconstruction; exact native text is required by the caller.
    dmText(content:Element,row:Element):string|null {
      let visited=0,images=0,length=0;
      const traversal={
        append(value:string):string|null{length+=value.length;return length<=10_000?value:null;},
        walk(node:Node):string|null{
          if(++visited>180)return null;if(node.nodeType===Node.TEXT_NODE)return traversal.append(node.nodeValue??'');
          if(!(node instanceof Element)||node.closest(s.messages)!==row||!['SPAN','DIV','P','B','I','EM','STRONG','A','BR','IMG'].includes(node.tagName))return null;
          const style=getComputedStyle(node);
          if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0)return '';
          if(node.tagName==='BR')return traversal.append('\n');
          if(node.tagName==='IMG'){
            if(++images>8||node.childNodes.length||node.closest('a[href]'))return null;
            const alt=Element.prototype.getAttribute.call(node,'alt'),source=Element.prototype.getAttribute.call(node,'src');
            if(!alt||alt.length>32||/[\x00-\x1f\x7f]/u.test(alt)||
              !/(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3)/u.test(alt)&&!/^\[[^\[\]\r\n]{1,20}\]$/u.test(alt)||!source)return null;
            try{const url=new URL(source,location.origin);if(url.username||url.password||url.protocol!=='https:'&&!(m.environment==='fixture'&&url.origin===location.origin))return null;}catch{return null;}
            return traversal.append(alt);
          }
          let value='';for(const child of node.childNodes){const part=traversal.walk(child);if(part===null)return null;value+=part;}return value;
        },
      };
      return traversal.walk(content);
    },
    visible(element: Element): boolean {
      if(!element.isConnected||!element.getClientRects().length)return false;
      for(let n:Element|null=element;n;n=n.parentElement){const style=getComputedStyle(n);
        if(style.visibility==='hidden'||style.visibility==='collapse'||style.display==='none'||Number(style.opacity)===0)return false;}
      return true;
    },
    commentFrame(list:Element):{scroller:Element;maximum:number} {
      let scroller=list,found=false;
      for(let node:Element|null=list,depth=0;node&&depth<=16;node=node.parentElement,depth++)if(dom.visible(node)&&node.contains(list)&&
        ['auto','scroll'].includes(getComputedStyle(node).overflowY)&&node.clientHeight>0&&node.scrollHeight>node.clientHeight){scroller=node;found=true;break;}
      if(!found)scroller=document.scrollingElement??list;
      dom.check(scroller.clientHeight>0,'OBSERVATION_DOM_NOT_READY');
      const physical=Math.max(0,scroller.scrollHeight-scroller.clientHeight);
      const top=scroller===document.scrollingElement?0:scroller.getBoundingClientRect().top+scroller.clientTop;
      // The page scroller can continue well below the comment list into unrelated page content.
      const end=scroller===list?physical:Math.max(0,scroller.scrollTop+list.getBoundingClientRect().bottom-top-scroller.clientHeight);
      return {scroller,maximum:Math.min(physical,end)};
    },
    one(root: Document | Element, selector: string,stage='OBSERVATION'): Element {
      const found = root.querySelectorAll(selector);
      dom.check(found.length > 0,`${stage}_DOM_NOT_READY`);
      dom.check(found.length === 1,`${stage}_DOM_NOT_UNIQUE`);
      dom.check(dom.visible(found[0]!),`${stage}_DOM_NOT_READY`); return found[0]!;
    },
    ownedOne(root:Element,selector:string,requireVisible=true,stage='OBSERVATION'):Element{
      const found=Array.from(root.querySelectorAll(selector)).filter(n=>n.closest(s.commentRows)===root);
      dom.check(found.length>0,`${stage}_DOM_NOT_READY`);dom.check(found.length===1,`${stage}_DOM_NOT_UNIQUE`);
      dom.check(!requireVisible||dom.visible(found[0]!),`${stage}_DOM_NOT_READY`);return found[0]!;
    },
    react(element: Element, prefix: string): unknown {
      const keys = Object.getOwnPropertyNames(element).filter(key => key.startsWith(prefix));
      dom.check(keys.length === 1,'RENDERED_BINDING_UNAVAILABLE'); return dom.data(element,keys[0]!);
    },
    fiberProps(element: Element, depth: number): unknown {
      let fiber = dom.react(element,'__reactFiber$');
      for (let n = 0; n < depth; n++) fiber = dom.data(fiber,'return');
      return dom.data(fiber,'memoizedProps');
    },
    childProps(element: Element): unknown {
      const children = dom.data(dom.react(element,'__reactProps$'),'children');
      return dom.data(Array.isArray(children) ? dom.data(children,'0') : children,'props');
    },
    // Adapted from LockyBee readOwnedCommentText (MIT, fixed SHA in UPSTREAM).
    // Kept inside each serialized capture so tsx and built Node need no module closure.
    commentText(content:Element,row:Element,rowSelector:string,fixture:boolean):string|null {
      let visited=0,images=0,length=0;
      const tags=new Set(['SPAN','DIV','P','B','I','EM','STRONG','A','BR','IMG']);
      const traversal={
        append(value:string):string|null{length+=value.length;return length<=10_000?value:null;},
        walk(node:Node):string|null{
          if(++visited>180)return null;
          if(node.nodeType===Node.TEXT_NODE)return traversal.append(node.nodeValue??'');
          if(!(node instanceof Element)||node.closest(rowSelector)!==row||
            node.closest('[data-e2e="im-dialog"]')||!tags.has(node.tagName))return null;
          const style=getComputedStyle(node);
          if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0)return '';
          if(node.tagName==='BR')return traversal.append('\n');
          if(node.tagName==='IMG'){
            if(++images>8||node.childNodes.length||node.closest('a[href]'))return null;
            const alt=node.getAttribute('alt'),source=node.getAttribute('src');
            if(!alt||alt.length>32||/[\x00-\x1f\x7f]/.test(alt)||
              !/(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3)/u.test(alt)&&!/^\[[^\[\]\r\n]{1,20}\]$/.test(alt)||!source)return null;
            try{const url=new URL(source,location.origin);if(url.username||url.password||
              url.protocol!=='https:'&&!(fixture&&url.origin===location.origin))return null;}catch{return null;}
            return traversal.append(alt);
          }
          let value='';
          for(const child of node.childNodes){const part=traversal.walk(child);if(part===null)return null;value+=part;}
          return value;
        },
      };
      return traversal.walk(content);
    },
    id(value: unknown): string | null { return typeof value === 'string' && /^\d{1,64}$/.test(value) ? value : null; },
    conversationId(conversation: unknown): string {
      const first=dom.data(conversation,'conversationId'), second=dom.data(conversation,'id');
      dom.check(first !== undefined || second !== undefined,'OBSERVATION_METADATA_NOT_READY');
      for(const value of [first,second]) if(value !== undefined)
        dom.check(typeof value==='string' && value.length>0 && value.length<=512,'OBSERVATION_CONVERSATION_ID_CONFLICT');
      dom.check(first===undefined || second===undefined || first===second,'OBSERVATION_CONVERSATION_ID_CONFLICT');
      return (first ?? second) as string;
    },
    listConversation(conversation:unknown,peer?:DiscoveredPeer):string|null {
      const first=dom.data(conversation,'conversationId'),second=dom.data(conversation,'id');
      if(first===undefined&&second===undefined){
        dom.check(!peer||dom.data(conversation,'_toParticipantSecUserId')!==peer.secUid,'OBSERVATION_METADATA_NOT_READY');
        return null;
      }
      return dom.conversationId(conversation);
    },
    rowIdentity(row: Element, peer: DiscoveredPeer): void {
      dom.check(row.isConnected && dom.visible(row),'OBSERVATION_ROW_UNAVAILABLE');
      const conversation=dom.data(dom.fiberProps(row,s.conversationFiberDepth),'conversation');
      dom.check(dom.conversationId(conversation)===peer.conversationId &&
        dom.data(conversation,'_toParticipantSecUserId')===peer.secUid,'OBSERVATION_ROW_IDENTITY_CONFLICT');
      dom.check(dom.one(row,s.conversationTitle).textContent?.trim()===peer.title,'OBSERVATION_METADATA_NOT_READY');
    },
    emptyEditors():void {
      for(const editor of Array.from(document.querySelectorAll('[contenteditable="true"],textarea,input'))) {
        if(!dom.visible(editor)||editor instanceof HTMLInputElement&&!['text','search','email','url','tel','password'].includes(editor.type))continue;
        const text=editor instanceof HTMLInputElement||editor instanceof HTMLTextAreaElement?editor.value:editor.textContent??'';
        dom.check(!editor.querySelector('img,video,audio,iframe,object,input,[data-slate-void="true"],[data-attachment]'),'OBSERVATION_EXISTING_HUMAN_INPUT');
        const marker=editor.matches('[data-slate-editor="true"][data-zone-container="*"]')&&
          editor.children.length===1&&editor.firstElementChild?.matches('div.ace-line[data-node="true"]')&&
          editor.firstElementChild.children.length===1&&editor.firstElementChild.firstElementChild?.matches('span[data-enter="true"][data-string="true"][data-leaf="true"]')&&text==='\u200B';
        dom.check(text.length===0||marker,'OBSERVATION_EXISTING_HUMAN_INPUT');
        dom.check(Array.from(editor.querySelectorAll('*')).every(node=>['DIV','P','SPAN','BR','B','I','EM','STRONG','U','S'].includes(node.tagName)),
          'OBSERVATION_EXISTING_HUMAN_INPUT');
      }
    },
    time(value: unknown, seconds: boolean): string | null {
      let time = NaN;
      if (seconds && typeof value === 'number' && Number.isFinite(value)) time = value * 1000;
      else if (!seconds) { try { time = Date.prototype.getTime.call(value); } catch { /* no date evidence */ } }
      return Number.isFinite(time) && time >= Date.UTC(2000,0,1) && time <= Date.now() ? new Date(time).toISOString() : null;
    },
    dmFrame(chat:Element,clipRows:boolean,window:boolean):{rows:Element[];scroller:Element|undefined;viewport:ObservationBatch['dmViewport']} {
      const mounted=Array.from(chat.querySelectorAll(s.messages)),candidates=new Set<Element>();
      if(window)for(const row of mounted.slice(0,100)){
        let node=row.closest(s.messageBox)?.parentElement??row.parentElement;
        for(let depth=0;node&&chat.contains(node)&&depth<8;depth++,node=node.parentElement){
          if(/auto|scroll/.test(getComputedStyle(node).overflowY)&&node.clientHeight>0&&node.scrollHeight>node.clientHeight&&mounted.every(message=>node!.contains(message)))candidates.add(node);
          if(node===chat)break;
        }
      }
      dom.check(candidates.size<=1,'OBSERVATION_DM_SCROLL_NOT_UNIQUE');
      const scroller=Array.from(candidates)[0],clip=(scroller??chat).getBoundingClientRect();
      let viewport:ObservationBatch['dmViewport'];
      if(scroller){
        const range=Math.max(0,scroller.scrollHeight-scroller.clientHeight),reverse=scroller.scrollTop<0||getComputedStyle(scroller).flexDirection==='column-reverse';
        viewport={top:scroller.scrollTop,height:scroller.scrollHeight,viewport:scroller.clientHeight,minimum:reverse?-range:0,maximum:reverse?0:range};
      }
      const rows=mounted.filter(dom.visible).filter(row=>!clipRows||row.getBoundingClientRect().bottom>Math.max(0,window?clip.top:0)&&
        row.getBoundingClientRect().top<Math.min(innerHeight,window?clip.bottom:innerHeight));
      return {rows,scroller,viewport};
    },
    dmContent(row:Element):{texts:Element[];media:Element[];missing:boolean} {
      const texts=Array.from(row.querySelectorAll(s.messageText)).filter(node=>node.closest(s.messages)===row),
        media=Array.from(row.querySelectorAll('img,video,audio')).filter(node=>node.closest(s.messages)===row&&dom.visible(node));
      return {texts,media,missing:!media.length&&!(texts.length===1&&dom.visible(texts[0]!)&&(texts[0]!.textContent??'').length>0)};
    },
    dmPeerUid(rows:Element[],peer:DiscoveredPeer):string|null {
      const senders=new Set(rows.map(row=>dom.data(dom.data(dom.childProps(row),'message'),'sender')).filter(sender=>sender!==m.self.uid));
      dom.check(senders.size<=1,'OBSERVATION_SENDER_UNVERIFIED');
      const discovered=Array.from(senders)[0],uid=peer.uid??dom.id(discovered);
      if(peer.uid&&discovered!==undefined)dom.check(discovered===peer.uid,'OBSERVATION_SENDER_UNVERIFIED');
      return uid;
    },
  };
  dom.check(location.origin === m.origin && !/验证码|安全验证/.test(document.title), 'OBSERVATION_PAGE_BLOCKED');
  dom.check(!Array.from(document.querySelectorAll(m.securityBlockers)).some(dom.visible),'OBSERVATION_PAGE_BLOCKED');
  const avatar = dom.one(document,s.selfAvatar,'OBSERVATION_ACCOUNT_AVATAR'), own = dom.fiberProps(avatar,s.selfFiberDepth);
  dom.check(dom.data(own,'uid') === m.self.uid && dom.data(own,'secUid') === m.self.secUid,'OBSERVATION_ACCOUNT_CHANGED');
  const events: InboundEvent[] = [],commentThreads:NonNullable<ObservationBatch['commentThreads']>=[]; let unsupported = 0, loaded = 0,incomplete=false;
  const relationRows:{native:unknown;id:string;root:string;own:boolean}[]=[];
  const dmCoverage:NonNullable<ObservationBatch['dmCoverage']>=[];
  const bindings: NonNullable<ObservationBatch['bindings']> = [];
  let dmViewport:ObservationBatch['dmViewport'];
  if (channel === 'identity') return { events,evidenceId,unsupported,loaded };
  if(channel==='diagnostic') {
    const comments=input.diagnosticSource==='comments';
    if(comments){const work=m.works[index];dom.check(work&&location.href.split('?')[0]===work.url.split('?')[0],'OBSERVATION_WORK_CHANGED');}
    const containers=Array.from(document.querySelectorAll(comments?s.commentList:s.dmPanel)),visible=containers.filter(dom.visible);
    const container=visible.length===1?visible[0]:undefined,box=container?.getBoundingClientRect();
    const rows=container?Array.from(container.querySelectorAll(comments?s.commentRows:s.conversationRows)):[];
    const roots=rows.slice(0,250).filter(row=>!row.parentElement?.closest(comments?s.commentRows:s.conversationRows));
    const probe={
      inWindow(row:Element):boolean {const r=row.getBoundingClientRect();return r.bottom>Math.max(0,box?.top??0)&&r.top<Math.min(innerHeight,box?.bottom??innerHeight);},
      number(value:number):number{return Math.max(-10_000_000,Math.min(10_000_000,Math.round(value)));},
      sample(row:Element):CollectionReadDiagnostic['samples'][number]{
        const r=row.getBoundingClientRect(),bodies=comments?Array.from(row.querySelectorAll(s.commentText)).filter(n=>n.closest(s.commentRows)===row):[];
        return {visible:dom.visible(row),inWindow:probe.inWindow(row),hasBox:row.getClientRects().length>0,
          displayContents:getComputedStyle(row).display==='contents',top:probe.number(r.top),bottom:probe.number(r.bottom),width:probe.number(r.width),height:probe.number(r.height),
          bodies:bodies.length,visibleBodies:bodies.filter(dom.visible).length};
      },
      inViewport(node:Element):boolean{const r=node.getBoundingClientRect();return dom.visible(node)&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth;},
      back():NonNullable<CollectionReadDiagnostic['back']> {
        const matches=Array.from(document.querySelectorAll(s.chatBack)),back:NonNullable<CollectionReadDiagnostic['back']>={count:matches.length};
        if(matches.length!==1)return back;
        const wrapper=matches[0]!,nodes=[wrapper],walk=document.createTreeWalker(wrapper,NodeFilter.SHOW_ELEMENT);
        for(let next=walk.nextNode();next&&nodes.length<12;next=walk.nextNode())nodes.push(next as Element);
        back.nodes=nodes.map((node,index)=>{
          const r=node.getBoundingClientRect(),tag=node.tagName.toUpperCase();
          const shape:NonNullable<NonNullable<CollectionReadDiagnostic['back']>['nodes']>[number]={index,parentIndex:index===0?null:nodes.indexOf(node.parentElement!),
            tag:tag==='DIV'||tag==='BUTTON'||tag==='SPAN'||tag==='A'||tag==='SVG'||tag==='PATH'?tag:'OTHER',
            visible:dom.visible(node),inViewport:probe.inViewport(node),width:probe.number(r.width),height:probe.number(r.height),props:'NONE',
            handlers:{onClick:false,onMouseDown:false,onPointerDown:false,onMouseUp:false}};
          const keys=Object.getOwnPropertyNames(node).filter(key=>key.startsWith('__reactProps$'));
          if(!keys.length)return shape;
          shape.props='REJECTED';
          if(keys.length!==1)return shape;
          const descriptor=Object.getOwnPropertyDescriptor(node,keys[0]!);
          if(!descriptor||!Object.hasOwn(descriptor,'value')||!descriptor.value||typeof descriptor.value!=='object')return shape;
          const handlers=Object.keys(shape.handlers) as (keyof typeof shape.handlers)[];
          const fields=handlers.map(key=>Object.getOwnPropertyDescriptor(descriptor.value,key));
          if(fields.some(field=>field&&!Object.hasOwn(field,'value')))return shape;
          shape.props='DATA';
          for(const [position,key] of handlers.entries())shape.handlers[key]=typeof fields[position]?.value==='function';
          return shape;
        });
        const r=wrapper.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
        if(!dom.visible(wrapper)||x<0||x>=innerWidth||y<0||y>=innerHeight){back.centerHit='OFFSCREEN';back.centerIndex=null;return back;}
        const hit=document.elementFromPoint(x,y),position=hit?nodes.indexOf(hit):-1;
        back.centerHit=!hit?'NONE':hit===wrapper?'SELF':wrapper.contains(hit)?'DESCENDANT':'OUTSIDE';
        back.centerIndex=position<0?null:position;
        return back;
      },
      messages():Pick<CollectionReadDiagnostic,'shareStage'|'messageSamples'|'windowRows'|'contentMissingRows'> {
        const chats=Array.from(document.querySelectorAll(s.chat)).filter(dom.visible);
        if(chats.length!==1)return {shareStage:'CHAT_NOT_READY',messageSamples:[]};
        const chat=chats[0]!;let peer:DiscoveredPeer|undefined;
        try{
          const header=dom.one(chat,s.chatHeader),conversation=dom.data(dom.childProps(header),'conversation'),id=dom.conversationId(conversation),
            secure=dom.data(conversation,'_toParticipantSecUserId');
          peer=input.peer??m.peers.find(item=>item.conversationId===id&&item.secUid===secure);
          if(!peer||peer.conversationId!==id||peer.secUid!==secure||dom.one(chat,s.chatTitle).textContent?.trim()!==peer.title)
            return {shareStage:'CONVERSATION_UNVERIFIED',messageSamples:[]};
        }catch{return {shareStage:'HEADER_NOT_READY',messageSamples:[]};}
        const frame=dom.dmFrame(chat,true,true);dom.check(frame.rows.length<=100,'OBSERVATION_WINDOW_TOO_LARGE');
        const peerUid=dom.dmPeerUid(frame.rows.filter(row=>!row.parentElement?.closest(s.messages)),peer);
        const window=frame.rows.map((row,windowIndex)=>({row,windowIndex,content:dom.dmContent(row)}));
        const contentMissingRows=window.filter(item=>item.content.missing).length;
        const messageSamples=window.sort((a,b)=>Number(b.content.missing)-Number(a.content.missing)||a.windowIndex-b.windowIndex).slice(0,6).map(({row,windowIndex,content})=>{
          const sample:NonNullable<CollectionReadDiagnostic['messageSamples']>[number]={windowIndex,contentMissing:content.missing,
            nativeIdPresent:false,conversationMatches:false,senderKnown:false,nativeKind:null,nativeStatus:null,timeValid:false,
            parsedPresent:false,parsedRejected:false,parsedTruncated:false,textNodes:0,visibleTextNodes:0,nonEmptyTextNodes:0,visibleMediaNodes:0,visibleCardNodes:0,parsedFields:[]};
          try{
            const native=dom.data(dom.childProps(row),'message'),sender=dom.data(native,'sender');
            sample.nativeIdPresent=!!dom.id(dom.data(native,'serverId'));
            sample.conversationMatches=dom.data(native,'conversationId')===peer!.conversationId;
            sample.senderKnown=sender===m.self.uid||peerUid!==null&&sender===peerUid;
            if(!sample.nativeIdPresent||!sample.conversationMatches||!sample.senderKnown)return sample;
            const {texts,media}=content;
            sample.textNodes=texts.length;sample.visibleTextNodes=texts.filter(dom.visible).length;
            sample.nonEmptyTextNodes=texts.filter(node=>dom.visible(node)&&(node.textContent??'').length>0).length;
            sample.visibleMediaNodes=media.length;
            sample.visibleCardNodes=Array.from(row.querySelectorAll('[class*="MessageItemShareAwemecontainer"],[data-e2e="shared-video-card"]'))
              .filter(node=>node.closest(s.messages)===row&&dom.visible(node)).length;
            const kind=dom.data(native,'type'),status=dom.data(native,'serverStatus');
            sample.nativeKind=typeof kind==='number'&&Number.isSafeInteger(kind)&&kind>=0&&kind<=65535?kind:null;
            sample.nativeStatus=typeof status==='number'&&Number.isSafeInteger(status)&&status>=0&&status<=65535?status:null;
            sample.timeValid=dom.time(dom.data(native,'createdAt'),false)!==null;
            let parsed:unknown;
            try{parsed=dom.data(native,'_parsedContent');}catch{sample.parsedRejected=true;return sample;}
            if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return sample;
            sample.parsedPresent=true;const keys=Object.getOwnPropertyNames(parsed);sample.parsedTruncated=keys.length>32;
            if(sample.nativeKind===8||sample.nativeKind===77){
              const awe=dom.data(parsed,'aweType'),aweme=dom.data(parsed,'awemeType'),slides=dom.data(parsed,'is_slides'),item=dom.data(parsed,'itemId');
              const aweValid=typeof awe==='number'&&Number.isSafeInteger(awe)&&awe>=0&&awe<=1000,
                awemeValid=typeof aweme==='number'&&Number.isSafeInteger(aweme)&&aweme>=0&&aweme<=1000,
                itemIdPresent=typeof item==='string'&&/^[1-9]\d{0,63}$/u.test(item);
              sample.nativeShare={aweType:aweValid?awe:null,awemeType:awemeValid?aweme:null,slides:typeof slides==='boolean'?slides:null,itemIdPresent,
                route:itemIdPresent&&(aweme===undefined||awemeValid)?slides===true?'NOTE':(slides===undefined||slides===false)&&(aweme===0||aweme===55)?'VIDEO':'UNAVAILABLE':'UNAVAILABLE'};
            }
            for(const name of keys.slice(0,32)){
              const field=Object.getOwnPropertyDescriptor(parsed,name),data=field&&Object.hasOwn(field,'value'),value=data?field.value:undefined;
              const type=!data?'accessor':value===null?'null':Array.isArray(value)?'array':
                ['string','number','boolean','object','undefined'].includes(typeof value)?typeof value:'other';
              let urlKind:NonNullable<CollectionReadDiagnostic['messageSamples']>[number]['parsedFields'][number]['urlKind']='NONE';
              if(typeof value==='string'&&value.length<=262144){
                if(/^https:\/\/www\.douyin\.com\/video\/\d{1,64}(?:[?#]|$)/u.test(value))urlKind='DOUYIN_VIDEO';
                else if(/^https:\/\/www\.douyin\.com\/note\/\d{1,64}(?:[?#]|$)/u.test(value))urlKind='DOUYIN_NOTE';
                else if(/^https?:\/\//u.test(value))urlKind='HTTP_OTHER';else if(value.startsWith('data:'))urlKind='DATA';
                else if(value.startsWith('blob:'))urlKind='BLOB';else if(/^[a-z][a-z0-9+.-]*:/iu.test(value))urlKind='OTHER';
              }
              sample.parsedFields.push({key:/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(name)?name:'OTHER',type:type as typeof sample.parsedFields[number]['type'],
                digitId:typeof value==='string'&&/^\d{1,64}$/u.test(value)||typeof value==='number'&&Number.isSafeInteger(value)&&value>=0,urlKind});
            }
          }catch{/* Missing metadata yields only fixed false flags, never an exception body. */}
          return sample;
        });
        return {shareStage:'VERIFIED',windowRows:frame.rows.length,contentMissingRows,messageSamples};
      },
      conversations():NonNullable<CollectionReadDiagnostic['conversationSamples']> {
        if(!container)return [];
        return rows.filter(row=>dom.visible(row)&&row.closest(s.dmPanel)===container).slice(0,6).map(row=>{
          const titles=Array.from(row.querySelectorAll(s.conversationTitle)).filter(node=>node.closest(s.conversationRows)===row);
          const sample={titleCount:titles.length,titleVisible:titles.some(dom.visible),
            titleNonEmpty:titles.some(node=>dom.visible(node)&&(node.textContent??'').trim().length>0),
            nativeConversationPresent:false,securePeerPresent:false,metadataReadable:false};
          try{
            const native=dom.data(dom.fiberProps(row,s.conversationFiberDepth),'conversation'),first=dom.data(native,'conversationId'),second=dom.data(native,'id'),
              secure=dom.data(native,'_toParticipantSecUserId');
            const id=first??second;sample.nativeConversationPresent=typeof id==='string'&&id.length>0;
            sample.securePeerPresent=typeof secure==='string'&&secure.length>0;sample.metadataReadable=true;
          }catch{/* A descriptor failure is only a fixed boolean, never an exception body. */}
          return sample;
        });
      },
    };
    const diagnostic:CollectionReadDiagnostic={source:comments?'comments':'dm',containers:containers.length,visibleContainers:visible.length,
      rows:rows.length,visibleRows:rows.slice(0,250).filter(dom.visible).length,roots:roots.length,windowRoots:roots.filter(probe.inWindow).length,
      viewportHeight:innerHeight,containerTop:probe.number(box?.top??0),containerBottom:probe.number(box?.bottom??0),scrollTop:container?.scrollTop??0,
      chatVisible:!comments&&Array.from(document.querySelectorAll(s.chat)).some(dom.visible),
      chatInViewport:!comments&&Array.from(document.querySelectorAll(s.chat)).some(probe.inViewport),
      backVisible:!comments&&Array.from(document.querySelectorAll(s.chatBack)).some(dom.visible),
      backInViewport:!comments&&Array.from(document.querySelectorAll(s.chatBack)).some(probe.inViewport),samples:roots.slice(0,6).map(probe.sample)};
    if(comments){
      const scrollProbe={shape(node:Element,depth:number):CommentScrollShape {
        const overflow=getComputedStyle(node).overflowY;
        return {depth,tag:node.tagName,overflowY:['visible','hidden','clip','scroll','auto','overlay'].includes(overflow)?overflow:'OTHER',
          clientHeight:probe.number(node.clientHeight),scrollHeight:probe.number(node.scrollHeight),scrollTop:probe.number(node.scrollTop),
          visible:dom.visible(node),containsList:!!container&&node.contains(container)};
      }};
      const ancestors:CommentScrollShape[]=[];let node=container??null;
      for(let depth=0;node&&depth<=16;depth++,node=node.parentElement)ancestors.push(scrollProbe.shape(node,depth));
      const selected=ancestors.find(item=>item.visible&&item.containsList&&['auto','scroll'].includes(item.overflowY)&&item.clientHeight>0&&item.scrollHeight>item.clientHeight);
      diagnostic.commentScroll={ancestors,document:document.scrollingElement?scrollProbe.shape(document.scrollingElement,-1):null,
        selectedDepth:selected?.depth??null,documentFallback:!selected,truncated:!!node};
      const scope=container?Array.from({length:4}).reduce<Element>((parent)=>parent.parentElement??parent,container):null;
      const candidates=scope?Array.from(scope.querySelectorAll('span,button,div,a')).slice(-500):[];
      const kinds:Record<string,'MORE_COMMENTS'|'LOAD_MORE'|'VIEW_ALL'|'NO_MORE'|'EMPTY'>={'查看更多评论':'MORE_COMMENTS','查看更多':'MORE_COMMENTS','加载更多':'LOAD_MORE','查看全部':'VIEW_ALL','查看全部评论':'VIEW_ALL','没有更多':'NO_MORE','没有更多了':'NO_MORE','暂时没有更多评论':'NO_MORE','暂无评论':'EMPTY','暂无':'EMPTY'};
      diagnostic.commentPagination={scanned:candidates.length,truncated:candidates.length===500,samples:[]};
      for(const candidate of candidates){if(candidate.childElementCount||!dom.visible(candidate)||candidate.closest(s.commentRows))continue;
        const kind=kinds[(candidate.textContent??'').trim()];if(!kind)continue;const rect=candidate.getBoundingClientRect();
        diagnostic.commentPagination.samples.push({kind,tag:['SPAN','BUTTON','DIV','A'].includes(candidate.tagName)?candidate.tagName:'OTHER',
          top:probe.number(rect.top),bottom:probe.number(rect.bottom),visible:true,inViewport:probe.inViewport(candidate)});
        if(diagnostic.commentPagination.samples.length===12)break;}
      const children=rows.filter(row=>!!row.parentElement?.closest(s.commentRows)&&dom.visible(row));
      diagnostic.commentChildren={rootRows:roots.length,childRows:children.length,samples:children.slice(0,6).map(row=>{
        const authors=Array.from(row.querySelectorAll(s.commentAuthor)).filter(n=>n.closest(s.commentRows)===row&&dom.visible(n));
        const profiles=authors.map(n=>n.getAttribute('href')).filter(Boolean),sample={ownedAuthors:authors.length,visibleProfiles:profiles.length,
          nativeUidPresent:false,nativeSecurePresent:false,profileMatchesNative:false,nativeProfileMatches:0,metadataReadable:false,hasRootNative:false,levelIs2:false,rootMatches:false,
          visibleBodies:Array.from(row.querySelectorAll(s.commentText)).filter(n=>n.closest(s.commentRows)===row&&dom.visible(n)).length};
        try{const props=dom.fiberProps(row,s.commentFiberDepth),native=dom.data(props,'commentInfo'),user=dom.data(native,'user'),uid=dom.data(user,'uid'),secure=dom.data(user,'secUid');
          const parent=row.parentElement?.closest(s.commentRows),root=parent?dom.data(dom.fiberProps(parent,s.commentFiberDepth),'commentInfo'):null,id=dom.data(root,'cid');
          sample.nativeUidPresent=typeof uid==='string'&&/^[1-9]\d{0,63}$/.test(uid);sample.nativeSecurePresent=typeof secure==='string'&&/^[A-Za-z0-9_-]{1,300}$/.test(secure);
          sample.metadataReadable=true;sample.hasRootNative=typeof id==='string';sample.levelIs2=dom.data(props,'level')===2;sample.rootMatches=id!==undefined&&dom.data(native,'replyId')===id;
          if(typeof secure==='string')for(const href of profiles)try{const url=new URL(href!,location.origin);if(url.origin===m.origin&&url.pathname===`/user/${secure}`)
            sample.nativeProfileMatches=Math.min(2,sample.nativeProfileMatches+1);}catch{/* Malformed links cannot provide native author evidence. */}
          sample.profileMatchesNative=profiles.length===1&&sample.nativeProfileMatches===1;
        }catch{sample.metadataReadable=false;}return sample;
      })};}
    if(!comments){diagnostic.back=probe.back();diagnostic.conversationSamples=probe.conversations();Object.assign(diagnostic,probe.messages());}
    return {events,evidenceId,unsupported,loaded,diagnostic};
  }
  if(channel==='navigate') {
    const url=new URL(input.navigationUrl!);
    dom.check(url.origin===m.origin&&!url.username&&!url.password&&!url.hash&&
      (m.works.some(w=>w.url===url.href)||url.pathname===`/user/${m.self.secUid}`),'OBSERVATION_WORK_CHANGED');
    dom.emptyEditors();location.assign(url.href);
    return {events,evidenceId,unsupported,loaded};
  }
  if(channel==='back') {
    dom.emptyEditors();
    const chat=dom.one(document,s.chat),back=dom.one(document,s.chatBack);
    dom.check(chat.contains(back),'OBSERVATION_CONVERSATION_CHANGED');
    const r=back.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
    dom.check(x>=0&&x<innerWidth&&y>=0&&y<innerHeight,'OBSERVATION_BACK_NOT_INTERACTABLE');
    const hit=document.elementFromPoint(x,y);
    dom.check(hit&&back.contains(hit)&&dom.visible(hit),'OBSERVATION_BACK_NOT_INTERACTABLE');
    if(hit instanceof HTMLElement)hit.click();
    else {dom.check(hit instanceof SVGElement,'OBSERVATION_BACK_NOT_INTERACTABLE');
      hit!.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));}
    return {events,evidenceId,unsupported,loaded};
  }
  if(channel==='commentReveal') {
    const work=m.works[index];dom.check(work&&location.href.split('?')[0]===work.url.split('?')[0],'OBSERVATION_WORK_CHANGED');
    const lists=Array.from(document.querySelectorAll(s.commentList)).filter(dom.visible);
    dom.check(lists.length===1,'OBSERVATION_COMMENT_LIST_DOM_NOT_UNIQUE');
    dom.emptyEditors();const box=lists[0]!.getBoundingClientRect();
    if(!input.commentOffset||box.top>=innerHeight||box.bottom<=0)lists[0]!.scrollIntoView({block:'start',inline:'nearest',behavior:'instant'});
    else {
      const {scroller,maximum}=dom.commentFrame(lists[0]!);
      if(scroller.scrollTop>maximum)scroller.scrollTop=maximum;
    }
    return {events,evidenceId,unsupported,loaded};
  }
  if(channel==='commentScroll') {
    const work=m.works[index];dom.check(work&&location.href.split('?')[0]===work.url.split('?')[0],'OBSERVATION_WORK_CHANGED');
    dom.emptyEditors();
    const lists=Array.from(document.querySelectorAll(s.commentList)).filter(dom.visible);dom.check(lists.length===1,'OBSERVATION_DOM_NOT_UNIQUE');
    const {scroller:list,maximum}=dom.commentFrame(lists[0]!);
    const before=list.scrollTop;
    const target=input.commentOffset!==undefined?Math.min(maximum,input.commentOffset):Math.min(maximum,before+Math.max(1,Math.floor(list.clientHeight*0.8)));
    if(!input.commentStay&&target!==before)list.scrollTop=target;
    return {events,evidenceId,unsupported,loaded,scroll:{top:list.scrollTop,height:list.scrollHeight,viewport:list.clientHeight,atEnd:list.scrollTop>=maximum-1}};
  }
  if(channel==='conversations') {
    const panel=dom.one(document,s.dmPanel),list=s.conversationList?dom.one(panel,s.conversationList):null;
    if(input.conversationOffset!==undefined){dom.emptyEditors();dom.check(list&&Number.isFinite(input.conversationOffset),'OBSERVATION_CONVERSATION_NOT_FOUND');
      list!.scrollTop=Math.max(0,Math.min(list!.scrollHeight-list!.clientHeight,input.conversationOffset));}
    const rows=Array.from(panel.querySelectorAll(s.conversationRows)).filter(row=>dom.visible(row)&&(!list||list.contains(row)));
    dom.check(rows.length<=100,'OBSERVATION_WINDOW_TOO_LARGE');
    const peers:DiscoveredPeer[]=[];
    for(const row of rows) {
      const native=dom.data(dom.fiberProps(row,s.conversationFiberDepth),'conversation');
      const id=dom.listConversation(native),secure=dom.data(native,'_toParticipantSecUserId');
      if(id===null){unsupported++;continue;}
      // A direct conversation must expose a stable peer secure ID; groups/unsupported rows remain unselected.
      if(typeof secure!=='string'||!secure||secure.length>300||secure===m.self.secUid){unsupported++;continue;}
      const title=dom.one(row,s.conversationTitle).textContent?.trim();
      dom.check(title,'OBSERVATION_METADATA_NOT_READY');
      const known=m.peers.find(p=>p.conversationId===id&&p.secUid===secure);
      peers.push({uid:known?.uid??null,secUid:secure,conversationId:id,title:title!,activity:(row.textContent??'').replace(title!,'').slice(0,2000)});
    }
    dom.check(new Set(peers.map(p=>p.conversationId)).size===peers.length,'OBSERVATION_CONVERSATION_NOT_UNIQUE');
    if(list&&input.scroll)list.scrollTop=input.scroll==='start'||list.scrollTop+list.clientHeight>=list.scrollHeight-1?0:
      Math.min(list.scrollHeight-list.clientHeight,list.scrollTop+Math.max(1,Math.floor(list.clientHeight*0.8)));
    return {events,evidenceId,unsupported,loaded:rows.length,peers,...(list?{scroll:{top:list.scrollTop,height:list.scrollHeight,
      viewport:list.clientHeight,atEnd:list.scrollTop+list.clientHeight>=list.scrollHeight-1}}:{})};
  } else if(channel==='locate') {
    const peer=input.peer??m.peers[index];dom.check(peer,'OBSERVATION_PEER_REQUIRED');
    const panel=dom.one(document,s.dmPanel),list=s.conversationList?dom.one(panel,s.conversationList):null;
    const rows=document.querySelectorAll(s.conversationRows),matches:number[]=[];
    for(let n=0;n<rows.length;n++) {
      const row=rows[n]!;
      if(!panel.contains(row)||!dom.visible(row)||(list&&!list.contains(row)))continue;
      loaded++;dom.check(loaded<=100,'OBSERVATION_WINDOW_TOO_LARGE');
      const native=dom.data(dom.fiberProps(row,s.conversationFiberDepth),'conversation');
      const nativeId=dom.listConversation(native,peer);
      if(nativeId===null){unsupported++;continue;}
      if(nativeId===peer!.conversationId && dom.data(native,'_toParticipantSecUserId')===peer!.secUid)matches.push(n);
    }
    dom.check(loaded>0,'OBSERVATION_DOM_NOT_READY');
    dom.check(matches.length<=1,'OBSERVATION_CONVERSATION_NOT_UNIQUE');
    if(matches.length)dom.rowIdentity(rows[matches[0]!]!,peer!);
    else if(list && input.scroll) {
      // Only the calibrated list is moved; no contact bodies or private application state are traversed.
      list.scrollTop=input.scroll==='start'?0:Math.min(list.scrollHeight-list.clientHeight,
        list.scrollTop+Math.max(1,Math.floor(list.clientHeight*0.8)));
    }
    return {events,evidenceId,unsupported,loaded,conversation:{rowIndex:matches[0]??null,hasList:Boolean(list)}};
  } else if(channel==='row') {
    const peer=input.peer??m.peers[index], rows=document.querySelectorAll(s.conversationRows);
    dom.check(peer && Number.isInteger(input.rowIndex) && input.rowIndex!>=0 && input.rowIndex!<rows.length,'OBSERVATION_ROW_REQUIRED');
    const row=rows[input.rowIndex!]!;dom.rowIdentity(row,peer!);
    if(input.select) {
      const gate={accepted:false,blocked:false,
        handle(event: Event): void {
          if(event.currentTarget!==row)return;
          try { dom.rowIdentity(row,peer!);const current=dom.fiberProps(dom.one(document,s.selfAvatar),s.selfFiberDepth);
            dom.check(dom.data(current,'uid')===m.self.uid && dom.data(current,'secUid')===m.self.secUid,'OBSERVATION_ACCOUNT_CHANGED');
            gate.accepted=true;
          } catch {gate.blocked=true;event.preventDefault();event.stopImmediatePropagation();}
        },
      };
      const event=s.conversationSelectEvent;
      row.addEventListener(event,gate.handle,true);
      try {
        // One browser task binds the native UI selection event and final target capture.
        // No pointer/mouse sequence can open a different conversation before this check.
        dom.rowIdentity(row,peer!);
        row.dispatchEvent(new MouseEvent(event,{bubbles:true,cancelable:true,view:window,button:0,buttons:event==='mousedown'?1:0}));
        dom.check(gate.accepted&&!gate.blocked,'OBSERVATION_ROW_SELECTION_BLOCKED');
      } finally {row.removeEventListener(event,gate.handle,true);}
    }
    return {events,evidenceId,unsupported,loaded};
  } else if (channel === 'dm'||channel==='dmScroll') {
    const peer = input.peer??m.peers[index]; dom.check(peer,'OBSERVATION_PEER_REQUIRED');
    const chat = dom.one(document,s.chat), header = dom.one(chat,s.chatHeader);
    const conversation = dom.data(dom.childProps(header),'conversation');
    const id = dom.conversationId(conversation);
    dom.check(id === peer!.conversationId && dom.data(conversation,'_toParticipantSecUserId') === peer!.secUid &&
      dom.one(chat,s.chatTitle).textContent?.trim() === peer!.title,'OBSERVATION_CONVERSATION_CHANGED');
    const {rows,scroller,viewport}=dom.dmFrame(chat,!!input.peer,!!input.dmWindow||channel==='dmScroll');dmViewport=viewport;
    if(channel==='dmScroll') {
      dom.emptyEditors();
      dom.check(scroller&&dmViewport&&Number.isFinite(input.dmTop),'OBSERVATION_DM_SCROLL_UNAVAILABLE');
      scroller!.scrollTop=Math.max(dmViewport!.minimum,Math.min(dmViewport!.maximum,input.dmTop!));
      return {events,evidenceId,unsupported,loaded,dmViewport:dmViewport!};
    }
    loaded=rows.length;
    dom.check(rows.length>0,'OBSERVATION_DM_MESSAGES_DOM_NOT_READY');
    dom.check(rows.length <= 100,'OBSERVATION_WINDOW_TOO_LARGE');
    // Unknown direct peers are bound by the same native conversation and the unique non-self message sender.
    // Do not derive a UID from a nickname or invent one from a local fingerprint.
    const peerUid=dom.dmPeerUid(rows,peer!);
    if(peerUid)bindings.push({targetKey:`dm:${id}`,uid:peerUid,secUid:peer!.secUid,title:peer!.title,conversationId:id});
    for (const row of rows) {
      const message = dom.data(dom.childProps(row),'message');
      dom.check(dom.data(message,'conversationId') === id,'OBSERVATION_MESSAGE_CONVERSATION_CONFLICT');
      const sender = dom.data(message,'sender'), box = row.closest(s.messageBox);
      dom.check(box && (sender === m.self.uid || sender === peerUid),'OBSERVATION_SENDER_UNVERIFIED');
      let fromMe = false;
      for (let node: Element | null = row; node && box!.contains(node); node = node.parentElement)
        if (node.classList.contains(s.fromMeClass)) fromMe = true;
      dom.check(fromMe === (sender === m.self.uid),'OBSERVATION_DIRECTION_CONFLICT');
      const nativeId=dom.id(dom.data(message,'serverId')),nativeTime=dom.time(dom.data(message,'createdAt'),false);
      const coverage=input.collectionPartial&&input.peer&&nativeId&&/^[1-9]\d{0,63}$/u.test(nativeId)&&nativeTime?
        {id:nativeId,occurredAt:nativeTime,precisionMs:1,captured:false}:null;
      if(coverage)dmCoverage.push(coverage);
      const {texts,media,missing}=dom.dmContent(row);
      let text:string,contentType:InboundEvent['contentType'];
      let nativeShare=false;
      if(!media.length&&texts.length===0&&dom.data(message,'type')===8){
        const parsed=dom.data(message,'_parsedContent'),itemId=dom.data(parsed,'itemId'),kind=dom.data(parsed,'awemeType'),slides=dom.data(parsed,'is_slides');
        const serverId=dom.data(message,'serverId');
        const knownKind=kind===undefined||typeof kind==='number'&&Number.isSafeInteger(kind)&&kind>=0&&kind<=1000;
        const route=knownKind&&(slides===undefined||typeof slides==='boolean')&&(slides===true||kind===68||kind===0||kind===55);
        nativeShare=typeof itemId==='string'&&/^[1-9]\d{0,63}$/u.test(itemId)&&route&&
          typeof serverId==='string'&&/^[1-9]\d{0,63}$/u.test(serverId)&&!!dom.time(dom.data(message,'createdAt'),false);
      }
      const inlineText=media.length>0&&media.length<=8&&dom.data(message,'type')===7&&texts.length===1&&dom.visible(texts[0]!)&&
        media.every(node=>node.tagName==='IMG'&&texts[0]!.contains(node))?dom.dmText(texts[0]!,row):null;
      const exactInline=inlineText!==null&&inlineText.length>0&&inlineText===dom.data(dom.data(message,'_parsedContent'),'text');
      if(exactInline){text=inlineText;}
      else if(media.length) {
        const types=new Set(media.map(node=>node.tagName));
        contentType=texts.some(node=>dom.visible(node)&&(node.textContent??'').length>0)||types.size>1?'MIXED':
          types.has('VIDEO')?'VIDEO':types.has('AUDIO')?'AUDIO':'IMAGE';
        text=contentType==='IMAGE'?'[图片或表情消息，需人工查看]':contentType==='VIDEO'?'[视频消息，需人工查看]':
          contentType==='AUDIO'?'[音频消息，需人工查看]':'[含媒体的消息，需人工查看]';
        unsupported++;
      }else if(nativeShare){
        // Keep the existing thumbnail event binding; the work reference is private display metadata, never full text.
        contentType='IMAGE';text='[图片或表情消息，需人工查看]';unsupported++;
      }else {
        if(missing&&input.collectionPartial&&input.peer){
          dom.check(!!dom.id(dom.data(message,'serverId'))&&!!dom.time(dom.data(message,'createdAt'),false),'OBSERVATION_METADATA_NOT_READY');
          incomplete=true;unsupported++;continue;
        }
        dom.check(!missing,'OBSERVATION_DM_CONTENT_DOM_NOT_READY');
        text=texts[0]!.textContent??'';
        const parsed=dom.data(message,'_parsedContent');
        dom.check(text===dom.data(parsed,'text'),'OBSERVATION_MESSAGE_TEXT_CONFLICT');
      }
      events.push({ accountId:'account_001',channel:'DIRECT_MESSAGE',platformEventId:dom.id(dom.data(message,'serverId')),
        actorId:sender as string,actorName:fromMe ? null : peer!.title,text,occurredAt:dom.time(dom.data(message,'createdAt'),false),
        videoId:null,commentId:null,conversationId:peer!.conversationId,direction:fromMe?'OUTGOING':'INCOMING',kind:'DM',
        evidenceId,discovery:'DIRECT_MESSAGE',...(contentType?{contentType,observationIssue:'DM_CONTENT_UNVERIFIED' as const}:{}) });
      if(coverage)coverage.captured=true;
    }
  } else {
    const work = m.works[index]; dom.check(work && location.href.split('?')[0] === work.url.split('?')[0], 'OBSERVATION_WORK_CHANGED');
      const lists=Array.from(document.querySelectorAll(s.commentList)).filter(dom.visible);
      dom.check(lists.length>0,'OBSERVATION_COMMENT_LIST_DOM_NOT_READY');dom.check(lists.length===1,'OBSERVATION_COMMENT_LIST_DOM_NOT_UNIQUE');
      const list=lists[0]!,mounted=Array.from(list.querySelectorAll(s.commentRows));
      const thread=input.commentRootId?mounted.find(row=>!row.parentElement?.closest(s.commentRows)&&
        dom.data(dom.data(dom.fiberProps(row,s.commentFiberDepth),'commentInfo'),'cid')===input.commentRootId):undefined;
      dom.check(!input.commentRootId||thread,'OBSERVATION_COMMENT_THREAD_CHANGED');
      const rows=thread?[thread,...Array.from(thread.querySelectorAll(s.commentRows)).filter(n=>n.parentElement?.closest(s.commentRows)===thread&&dom.visible(n))
        .slice(input.commentChildOffset??0,(input.commentChildOffset??0)+100)]:mounted.filter(row=>!input.allCommentAuthors||
        row.getBoundingClientRect().bottom>Math.max(0,list.getBoundingClientRect().top)&&row.getBoundingClientRect().top<Math.min(innerHeight,list.getBoundingClientRect().bottom)); loaded = rows.length;
    dom.check(rows.length <= (thread?101:100),'OBSERVATION_WINDOW_TOO_LARGE');
    const visibleRoots=rows.filter(row=>dom.visible(row)&&!row.parentElement?.closest(s.commentRows));
    const empty=s.commentEmpty?Array.from(list.querySelectorAll(s.commentEmpty)).filter(dom.visible):[];
    dom.check(visibleRoots.length>0||empty.length===1,'OBSERVATION_COMMENT_ROOTS_DOM_NOT_READY');
    for (const row of rows) {
      if (!dom.visible(row)) continue;
      const parent=row.parentElement?.closest(s.commentRows)??null;
      if(parent?.parentElement?.closest(s.commentRows))continue;
      const authors = Array.from(row.querySelectorAll(s.commentAuthor)).filter(n=>n.closest(s.commentRows)===row&&dom.visible(n));
      if(parent&&authors.length===0){unsupported++;continue;}
      const profiles = authors.map(a => a.getAttribute('href')).filter(Boolean).map(href => new URL(href!,location.origin));
      const knownPeer=[...m.peers,...m.commentAuthors??[]].find(p => profiles.some(url => url.origin === m.origin && url.pathname === `/user/${p.secUid}`));
      if(!input.allCommentAuthors&&!knownPeer)continue;
      const props = dom.fiberProps(row,s.commentFiberDepth), comment = dom.data(props,'commentInfo');
      const rootProps=parent?dom.fiberProps(parent,s.commentFiberDepth):props,rootComment=dom.data(rootProps,'commentInfo');
      const author = dom.data(comment,'user'), aweme = dom.data(props,'awemeInfo'), self = dom.data(rootProps,'userInfo');
      dom.check(dom.data(aweme,'awemeId') === work!.id &&dom.data(dom.data(rootProps,'awemeInfo'),'awemeId')===work!.id&&
        dom.data(self,'uid') === m.self.uid,'OBSERVATION_COMMENT_WORK_CONFLICT');
      const nativeUid=dom.id(dom.data(author,'uid')),nativeSecure=dom.data(author,'secUid');
      const matchingAuthors=parent?authors.filter(node=>{const url=new URL(node.getAttribute('href')??'',location.origin);
        return typeof nativeSecure==='string'&&url.origin===m.origin&&url.pathname===`/user/${nativeSecure}`;}):authors;
      if(parent)dom.check(matchingAuthors.length===1,'OBSERVATION_COMMENT_AUTHOR_UNVERIFIED');
      const discoveredPeer=input.allCommentAuthors&&nativeUid&&typeof nativeSecure==='string'&&/^[A-Za-z0-9_-]{1,300}$/.test(nativeSecure)&&
        (parent?matchingAuthors.length===1:profiles.length===1&&profiles[0]!.origin===m.origin&&profiles[0]!.pathname===`/user/${nativeSecure}`)
        ? {uid:nativeUid,secUid:nativeSecure,title:matchingAuthors[0]!.textContent?.trim()??''}:null;
      if(input.allCommentAuthors)dom.check(discoveredPeer,'OBSERVATION_COMMENT_AUTHOR_UNVERIFIED');
      const peer = discoveredPeer??(parent?[...m.peers,...m.commentAuthors??[]].find(p=>p.uid===nativeUid&&p.secUid===nativeSecure):knownPeer);
      if (!peer) continue;
      dom.check(dom.data(author,'uid') === peer.uid && dom.data(author,'secUid') === peer.secUid,'OBSERVATION_COMMENT_AUTHOR_CONFLICT');
      const id = dom.id(dom.data(comment,'cid')), tooltip = dom.ownedOne(row,s.commentTooltip,false,'OBSERVATION_COMMENT_TOOLTIP');
      dom.check(id && tooltip.id === `tooltip_${id}`,'OBSERVATION_COMMENT_ID_CONFLICT');
      const body=dom.ownedOne(row,s.commentText,true,'OBSERVATION_COMMENT_TEXT'),rendered=dom.commentText(body,row,s.commentRows,m.environment==='fixture');
      const native=dom.data(comment,'text'),verified=rendered!==null&&rendered.length>0&&rendered===native;
      const text=typeof native==='string'&&native.length>0&&native.length<=10_000?native:rendered||'[非文本评论，待核对]';
      const rootId=parent?dom.id(dom.data(rootComment,'cid')):null;
      if(!parent&&input.allCommentAuthors){const total=dom.data(comment,'replyTotal'),expandable=Array.from(row.querySelectorAll('span,button,div')).some(n=>
        n.closest(s.commentRows)===row&&!n.childElementCount&&dom.visible(n)&&/^展开\d+条回复$/.test(n.textContent??''));
        commentThreads.push({id:id!,total:typeof total==='number'&&Number.isSafeInteger(total)&&total>=0?total:null,expandable,
          mounted:Array.from(row.querySelectorAll(s.commentRows)).filter(n=>n.parentElement?.closest(s.commentRows)===row&&dom.visible(n)).length});}
      const parentVerified=!parent||rootId!==null&&/^[1-9]\d{0,63}$/.test(rootId)&&id!==rootId&&/^[1-9]\d{0,63}$/.test(id!)&&
        dom.data(rootProps,'level')===1&&dom.data(rootComment,'replyId')==='0'&&dom.data(props,'level')===2&&
        dom.data(comment,'replyId')===rootId&&(dom.data(props,'levelOneCid')===undefined||dom.data(props,'levelOneCid')===rootId);
      if(parent&&parentVerified&&verified)relationRows.push({native:comment,id:id!,root:rootId!,own:nativeUid===m.self.uid});
      if(!verified||!parentVerified)unsupported++;
      bindings.push({targetKey:`comment:${work!.id}:${id}`,uid:peer.uid,secUid:peer.secUid,title:peer.title,conversationId:null});
      events.push({ accountId:'account_001',channel:'COMMENT_NOTIFICATION',platformEventId:id,actorId:peer.uid,
        actorName:peer.title,text,occurredAt:dom.time(dom.data(comment,'createTime'),true),occurredAtPrecisionMs:1000,videoId:work!.id,commentId:id,
        conversationId:null,direction:'INCOMING',kind:parent?'REPLY':'COMMENT',evidenceId,discovery:'ALLOWED_WORK',
        ...(parent&&parentVerified?{rootCommentId:rootId!,replyToCommentId:id!}:{}),
        ...(!parentVerified?{observationIssue:'COMMENT_PARENT_UNVERIFIED' as const}:verified?{}:{observationIssue:'COMMENT_TEXT_UNVERIFIED' as const}) });
    }
  }
  dom.check(new Set(events.map(e=>e.platformEventId).filter(Boolean)).size === events.filter(e=>e.platformEventId).length,
    'OBSERVATION_MESSAGE_ID_COLLISION');
  const commentRelations:CommentRelationShape|undefined=relationRows.length?{sampled:Math.min(3,relationRows.length),truncated:relationRows.length>3,
    samples:relationRows.slice(0,3).map(row=>{const children=new Set(relationRows.filter(item=>item.root===row.root).map(item=>item.id));
      return{own:row.own,rootBound:true,replyToReplyId:dom.relation(row.native,'replyToReplyId',row.root,row.id,children),
        replyToReplyID:dom.relation(row.native,'replyToReplyID',row.root,row.id,children)};})}:undefined;
  return { events,evidenceId,unsupported,loaded,bindings,...(dmViewport?{dmViewport}:{}),...(incomplete?{incomplete:'CONTENT_NOT_READY' as const}:{}),
    ...(commentRelations?{commentRelations}:{}),
    ...(commentThreads.length?{commentThreads}:{}),
    ...(dmCoverage.length===loaded&&loaded>0&&new Set(dmCoverage.map(row=>row.id)).size===loaded?{dmCoverage}:{}) };
}
