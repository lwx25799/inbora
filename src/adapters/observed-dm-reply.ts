import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import type { DmReplyMapping } from '../config/site-mapping.js';
import { digest, dmClockToleranceMs, eventBinding, isStrong, isManualMediaCandidate, requireSafe, targetKey, validText,
  type InboundEvent, type ReplyAdapter, type SendProof, type TargetSnapshot } from '../core/contracts.js';
import { ObservedReader } from './observed-reader.js';
import {SubmissionResponse,type SubmissionAck} from './submission-response.js';

interface ReplyCaptureInput {
  mapping: DmReplyMapping; event: InboundEvent;
  action: 'snapshot' | 'fill' | 'arm' | 'proofs' | 'refresh' | 'cancel' | 'clearSaved'; text: string | null; token: string | null;
  before: {context:unknown[];editorText:string}|null;
  editorShape:string|null;
  manualMedia?:boolean;
}
interface MediaObservation {contentType:NonNullable<InboundEvent['contentType']>;nativeKind:number;witness:unknown[]}
interface ReplyFrame { context: unknown[]; proofs: SendProof[]; outgoingIds: string[]; editorText: string;editorShape:string;latestId:string|null;media?:MediaObservation }
export interface DmContextChange {
  stage:'PREPARE'|'FILL'|'PREPARED'|'BASELINE';beforeRows:number;afterRows:number;added:number;removed:number;reordered:boolean;changedRows:number;
  senderChanged:number;contentChanged:number;timeChanged:number;typeChanged:number;statusChanged:number;pendingChanged:number;failedChanged:number;
}

/** Serialized without module helpers: fixed rendered paths, never calls website functions. */
export function captureDmReply(input: ReplyCaptureInput): ReplyFrame {
  const {mapping:m,event:expected,text,token}=input, o=m.observation, s=o.selectors;
  const peer=o.peers.find(p=>p.uid===expected.actorId&&p.conversationId===expected.conversationId);
  const manualMedia=input.manualMedia===true&&expected.observationIssue==='DM_CONTENT_UNVERIFIED'&&!!expected.contentType;
  let sourceBudget=1_048_576;
  type Gate={token:string;submit:()=>boolean;remove:()=>void};
  type Preparation={token:string;editor:HTMLElement;chat:Element;binding:string;text:string;shape:string;foreignInput:boolean;clearing:boolean;remove:()=>void};
  const host=window as unknown as {__inboraDmReplyGate?:Gate;__inboraDmPreparation?:Preparation};
  const dom={
    check(ok: unknown,code='NATIVE_REPLY_GUARD_BLOCKED'): void {if(!ok)throw new Error(code);},
    // Same MIT dataField adaptation as observed-reader; see UPSTREAM and third_party notice.
    data(object: unknown,key: string): unknown {
      if(!object||typeof object!=='object')return undefined;
      const own=Object.getOwnPropertyDescriptor(object,key), inherited=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(object)??{},key);
      dom.check(!own||Object.hasOwn(own,'value'),'NATIVE_REPLY_ACCESSOR_UNSUPPORTED');
      dom.check(!inherited||Object.hasOwn(inherited,'value'),'NATIVE_REPLY_ACCESSOR_UNSUPPORTED');
      dom.check(!own||!inherited||own.value===inherited.value,'NATIVE_REPLY_FIELD_CONFLICT');
      return own?own.value:inherited?.value;
    },
    visible(element: Element): boolean {
      if(!element.isConnected||!element.getClientRects().length)return false;
      for(let node:Element|null=element;node;node=node.parentElement) {
        const style=getComputedStyle(node);
        if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0)return false;
      }
      return true;
    },
    one(root: Document|Element,selector: string): Element {
      const rows=root.querySelectorAll(selector);dom.check(rows.length===1&&dom.visible(rows[0]!),'NATIVE_REPLY_DOM_CHANGED');
      return rows[0]!;
    },
    flagged(root:Element,selector:string):boolean {
      return root.matches(selector)&&dom.visible(root)||Array.from(root.querySelectorAll(selector)).some(dom.visible);
    },
    react(element: Element,prefix: string): unknown {
      const keys=Object.getOwnPropertyNames(element).filter(k=>k.startsWith(prefix));
      dom.check(keys.length===1,'NATIVE_REPLY_METADATA_MISSING');return dom.data(element,keys[0]!);
    },
    fiber(element: Element,depth: number): unknown {
      let fiber=dom.react(element,'__reactFiber$');
      for(let n=0;n<depth;n++)fiber=dom.data(fiber,'return');
      return dom.data(fiber,'memoizedProps');
    },
    childProps(element: Element): unknown {
      const children=dom.data(dom.react(element,'__reactProps$'),'children');
      return dom.data(Array.isArray(children)?dom.data(children,'0'):children,'props');
    },
    time(value: unknown): string|null {
      let time=NaN;try{time=Date.prototype.getTime.call(value);}catch{/* no native date */}
      return Number.isFinite(time)&&time>=Date.UTC(2000,0,1)&&time<=Date.now()?new Date(time).toISOString():null;
    },
    binding(e: InboundEvent): unknown[] {
      return[e.accountId,e.channel,e.platformEventId,e.actorId,e.text,e.occurredAt,e.videoId,e.commentId,e.conversationId,e.direction,e.kind];
    },
    editableText(node: Node,budget: {remaining:number},root:Element): string {
      dom.check(--budget.remaining>=0,'NATIVE_REPLY_EDITOR_TOO_COMPLEX');
      if(node.nodeType===Node.TEXT_NODE)return node.nodeValue??'';
      dom.check(node instanceof HTMLElement,'NATIVE_REPLY_EDITOR_UNSUPPORTED');
      const element=node as HTMLElement;
      dom.check(element===root||!element.hasAttribute('contenteditable'),'NATIVE_REPLY_EDITOR_UNSUPPORTED');
      dom.check(['DIV','P','SPAN','BR','B','I','EM','STRONG','U','S'].includes(element.tagName),'NATIVE_REPLY_EDITOR_UNSUPPORTED');
      if(element.matches('span[data-enter="true"][data-string="true"][data-leaf="true"]')){
        const line=element.parentElement;
        dom.check(element.childNodes.length===1&&element.firstChild?.nodeType===Node.TEXT_NODE&&element.textContent==='\u200B'&&
          line?.matches('div.ace-line[data-node="true"]')&&line.lastChild===element&&line.parentElement===root&&
          root.matches('[data-slate-editor="true"][data-zone-container="*"]'),'NATIVE_REPLY_EDITOR_MARKER_CHANGED');
        return''; // calibrated editor-kit line terminator; ordinary zero-width text is retained
      }
      if(element.tagName==='BR')return'\n';
      const children=Array.from(element.childNodes);
      const paragraph=['DIV','P'].includes(element.tagName);
      dom.check(paragraph||!children.some(child=>child instanceof HTMLElement&&['DIV','P'].includes(child.tagName)),
        'NATIVE_REPLY_EDITOR_UNSUPPORTED');
      if(paragraph&&children.length===1&&children[0] instanceof HTMLBRElement)return''; // empty paragraph caret placeholder
      let value='',previousBlock=false,previousBreak=false,hasPrevious=false;
      for(const child of children){
        const block=child instanceof HTMLElement&&['DIV','P'].includes(child.tagName);
        const part=dom.editableText(child,budget,root);
        if(block){if(hasPrevious&&(previousBlock||!previousBreak))value+='\n';}
        else if(previousBlock)value+='\n';
        value+=part;previousBlock=block;previousBreak=!block&&part.endsWith('\n');hasPrevious=true;
      }
      return value;
    },
    editorText(editor: Element): string {
      dom.check(!editor.querySelector('img,video,audio,input,[data-slate-void="true"]'),'NATIVE_REPLY_EDITOR_MEDIA');
      const raw=editor instanceof HTMLInputElement||editor instanceof HTMLTextAreaElement?editor.value:editor.textContent??'';
      const value=editor instanceof HTMLInputElement||editor instanceof HTMLTextAreaElement?editor.value:dom.editableText(editor,{remaining:2000},editor);
      // An otherwise empty Slate editor contains a zero-width sentinel, not a user draft.
      return /^[\u200B\uFEFF]*$/.test(raw)?'':value;
    },
    nativeShare(parsed:unknown,nativeKind:unknown):unknown[]|null{
      if(nativeKind!==8)return null;
      const itemId=dom.data(parsed,'itemId'),kind=dom.data(parsed,'awemeType'),slides=dom.data(parsed,'is_slides');
      if(typeof itemId!=='string'||!/^[1-9]\d{0,63}$/u.test(itemId)||
        kind!==undefined&&(!Number.isSafeInteger(kind)||(kind as number)<0||(kind as number)>1000)||
        slides!==undefined&&typeof slides!=='boolean'||slides!==true&&kind!==0&&kind!==55&&kind!==68)return null;
      return ['SHARED_WORK',itemId,kind??null,slides??null];
    },
    media(row:Element,parsed:unknown,exactOriginal:boolean):{contentType:MediaObservation['contentType'];witness:unknown[]} {
      const nodes=dom.ownedMedia(row,'img,video,audio'),cards=dom.ownedMedia(row,'[class*="MessageItemShareAwemecontainer"],[data-e2e="shared-video-card"]');
      dom.check(nodes.length<=8&&cards.length<=1&&(nodes.length>0||cards.length===1),'NATIVE_REPLY_MEDIA_NOT_READY');
      const witness:unknown[]=[],types=new Set<string>();
      if(cards.length){
        const itemId=dom.data(parsed,'itemId'),kind=dom.data(parsed,'awemeType'),slides=dom.data(parsed,'is_slides');
        dom.check(typeof itemId==='string'&&/^[1-9]\d{0,63}$/u.test(itemId),'NATIVE_REPLY_MEDIA_UNVERIFIED');
        dom.check(kind===undefined||Number.isSafeInteger(kind),'NATIVE_REPLY_MEDIA_UNVERIFIED');
        dom.check(slides===undefined||typeof slides==='boolean','NATIVE_REPLY_MEDIA_UNVERIFIED');
        witness.push(['SHARED_WORK',itemId,kind??null,slides??null]);types.add('IMG');
      }
      for(const node of nodes){
        if(cards[0]?.contains(node))continue;
        dom.check(!node.closest('[role="menu"],[aria-hidden="true"],header'),'NATIVE_REPLY_MEDIA_UNVERIFIED');
        const prototype=node instanceof HTMLImageElement?HTMLImageElement.prototype:HTMLMediaElement.prototype;
        const current=Object.getOwnPropertyDescriptor(prototype,'currentSrc')?.get?.call(node) as string|undefined;
        const source=current||Element.prototype.getAttribute.call(node,'src')||'';
        sourceBudget-=source.length;dom.check(sourceBudget>=0,'NATIVE_REPLY_MEDIA_WINDOW_TOO_LARGE');
        let safe=false;try{const url=new URL(source,location.href);safe=source.length>0&&source.length<=262144&&!url.username&&!url.password&&
          (url.protocol==='https:'||o.environment==='fixture'&&url.protocol==='http:'&&url.origin===o.origin||
            url.protocol==='blob:'&&url.origin===o.origin||/^data:(?:image\/(?:png|jpeg|gif|webp)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+);base64,[A-Za-z0-9+/=\r\n]+$/u.test(source));}
        catch{/* Source verification never makes a request. */}
        dom.check(safe,'NATIVE_REPLY_MEDIA_UNVERIFIED');
        if(exactOriginal){
          if(node instanceof HTMLImageElement)dom.check(node.complete&&node.naturalWidth>0&&node.naturalHeight>0,'NATIVE_REPLY_MEDIA_NOT_READY');
          else dom.check(node instanceof HTMLMediaElement&&node.readyState>=1,'NATIVE_REPLY_MEDIA_NOT_READY');
        }
        witness.push([node.tagName,source]);types.add(node.tagName);
      }
      const texts=dom.ownedMedia(row,s.messageText).filter(node=>(node.textContent??'').length>0);
      if(texts.length){
        dom.check(texts.length===1,'NATIVE_REPLY_MESSAGE_TEXT_CONFLICT');let remaining=2000;
        const readable={
          walk(node:Node):string{
            dom.check(--remaining>=0,'NATIVE_REPLY_MEDIA_UNVERIFIED');if(node.nodeType===Node.TEXT_NODE)return node.nodeValue??'';
            dom.check(node instanceof HTMLElement,'NATIVE_REPLY_MEDIA_UNVERIFIED');const element=node as HTMLElement;
            if(!dom.visible(element))return'';
            dom.check(element.closest(s.messages)===row,'NATIVE_REPLY_MESSAGE_CONFLICT');
            if(element.tagName==='IMG'){const alt=Element.prototype.getAttribute.call(element,'alt');
              dom.check(alt&&alt.length<=128&&!/[\u0000-\u001f\u007f]/u.test(alt),'NATIVE_REPLY_MESSAGE_TEXT_CONFLICT');return alt!;}
            dom.check(['DIV','SPAN','P','BR','B','I','EM','STRONG'].includes(element.tagName),'NATIVE_REPLY_MEDIA_UNVERIFIED');
            return element.tagName==='BR'?'\n':Array.from(element.childNodes).map(child=>readable.walk(child)).join('');
          },
        };
        const body=readable.walk(texts[0]!);dom.check(body===dom.data(parsed,'text'),'NATIVE_REPLY_MESSAGE_TEXT_CONFLICT');witness.push(['TEXT',body]);
      }
      const contentType:MediaObservation['contentType']=texts.length||types.size>1?'MIXED':types.has('VIDEO')?'VIDEO':types.has('AUDIO')?'AUDIO':'IMAGE';
      return {contentType,witness};
    },
    ownedMedia(row:Element,selector:string):Element[]{
      return Array.from(row.querySelectorAll(selector)).filter(node=>node.closest(s.messages)===row&&dom.visible(node));
    },
    capture(): ReplyFrame & {editor: Element;button: Element} {
      sourceBudget=1_048_576;
      dom.check(peer&&expected.channel==='DIRECT_MESSAGE'&&expected.direction==='INCOMING'&&expected.kind==='DM','NATIVE_REPLY_SCOPE_REQUIRED');
      dom.check(location.origin===o.origin&&!/验证码|安全验证|访问受限/.test(document.title),'NATIVE_REPLY_PAGE_BLOCKED');
      dom.check(!Array.from(document.querySelectorAll(m.blockers)).some(dom.visible),'NATIVE_REPLY_PAGE_BLOCKED');
      dom.check(!Array.from(document.querySelectorAll(o.securityBlockers)).some(dom.visible),'NATIVE_REPLY_PAGE_BLOCKED');
      const own=dom.fiber(dom.one(document,s.selfAvatar),s.selfFiberDepth);
      dom.check(dom.data(own,'uid')===o.self.uid&&dom.data(own,'secUid')===o.self.secUid,'NATIVE_REPLY_ACCOUNT_CHANGED');
      const chat=dom.one(document,s.chat),header=dom.one(chat,s.chatHeader),conversation=dom.data(dom.childProps(header),'conversation');
      const first=dom.data(conversation,'conversationId'),second=dom.data(conversation,'id');
      dom.check((first===undefined||first===peer!.conversationId)&&(second===undefined||second===peer!.conversationId)&&
        (first!==undefined||second!==undefined)&&dom.data(conversation,'_toParticipantSecUserId')===peer!.secUid&&
        dom.one(chat,s.chatTitle).textContent?.trim()===peer!.title,'NATIVE_REPLY_CONVERSATION_CHANGED');
      const rows=Array.from(chat.querySelectorAll(s.messages)).filter(dom.visible);
      dom.check(rows.length>0&&rows.length<=100,'NATIVE_REPLY_WINDOW_UNVERIFIED');
      dom.check(rows.filter(row=>row.closest(m.latestIndexAncestor)?.getAttribute('data-index')==='0').length===1,'NATIVE_REPLY_LATEST_END_MISSING');
      const context:unknown[]=[],proofs:SendProof[]=[],outgoingIds:string[]=[],seen=new Set<string>();let originals=0,latestId:string|null=null,originalMedia:MediaObservation|undefined;
      for(const row of rows) {
        const message=dom.data(dom.childProps(row),'message'),sender=dom.data(message,'sender'),id=dom.data(message,'serverId');
        dom.check(dom.data(message,'conversationId')===peer!.conversationId&&(sender===peer!.uid||sender===o.self.uid),'NATIVE_REPLY_MESSAGE_CONFLICT');
        const box=row.closest(s.messageBox);dom.check(box&&chat.contains(box),'NATIVE_REPLY_MESSAGE_CONFLICT');
        let outgoing=false;
        for(let node:Element|null=row;node&&box!.contains(node);node=node.parentElement)if(node.classList.contains(s.fromMeClass))outgoing=true;
        dom.check(outgoing===(sender===o.self.uid),'NATIVE_REPLY_DIRECTION_CONFLICT');
        const nativeId=typeof id==='string'&&/^[1-9]\d{0,63}$/.test(id)?id:null;
        if(row.closest(m.latestIndexAncestor)?.getAttribute('data-index')==='0')latestId=nativeId;
        if(nativeId){dom.check(!seen.has(nativeId),'NATIVE_REPLY_MESSAGE_ID_COLLISION');seen.add(nativeId);}
        const sentAt=dom.time(dom.data(message,'createdAt')),parsed=dom.data(message,'_parsedContent'),parsedText=dom.data(parsed,'text');
        const texts=row.querySelectorAll(s.messageText);
        const body=texts.length===1&&dom.visible(texts[0]!)&&!texts[0]!.querySelector('img,video,audio')?texts[0]!.textContent:null;
        if(body!==null)dom.check(body===parsedText,'NATIVE_REPLY_MESSAGE_TEXT_CONFLICT');
        const pending=dom.flagged(box!,m.pending),failed=dom.flagged(box!,m.failed);
        const status=dom.data(message,'serverStatus'),type=dom.data(message,'type');
        dom.check(typeof status==='number'&&Number.isFinite(status)&&typeof type==='number'&&Number.isFinite(type),'NATIVE_REPLY_MESSAGE_STATE_MISSING');
        if(input.action!=='proofs')dom.check(nativeId&&sentAt,'NATIVE_REPLY_WINDOW_UNVERIFIED');
        const visibleMedia=manualMedia&&Array.from(row.querySelectorAll('img,video,audio,[class*="MessageItemShareAwemecontainer"],[data-e2e="shared-video-card"]'))
          .some(node=>node.closest(s.messages)===row&&dom.visible(node));
        const nativeShare=manualMedia&&texts.length===0?dom.nativeShare(parsed,type):null;
        const media=nativeShare?{contentType:'IMAGE' as const,witness:[nativeShare]}:
          visibleMedia?dom.media(row,parsed,nativeId===expected.platformEventId):null;
        if(!media&&type===m.textMessageType){
          dom.check(texts.length<=1,'NATIVE_REPLY_MESSAGE_TEXT_CONFLICT');
          dom.check(typeof parsedText==='string'&&parsedText.length<=10_000,'NATIVE_REPLY_MESSAGE_TEXT_UNVERIFIED');
        }
        // The bound native full text stays stable while an unrelated historical body mounts; visible text still must match it.
        const contextText=type===m.textMessageType?parsedText:body;
        context.push([nativeId,sender,media?['DM_MEDIA',media.contentType,media.witness]:contextText,sentAt,type,status,pending,failed]);
        if(body!==null&&nativeId&&sentAt&&!outgoing&&type===m.textMessageType&&!pending&&!failed&&status===m.confirmedServerStatus) {
          const current={...expected,platformEventId:nativeId,actorId:sender as string,text:body,occurredAt:sentAt};
          if(JSON.stringify(dom.binding(current))===JSON.stringify(dom.binding(expected)))originals++;
        }
        if(media&&nativeId===expected.platformEventId&&sender===expected.actorId&&sentAt===expected.occurredAt&&!outgoing&&!pending&&!failed&&status===m.confirmedServerStatus){
          dom.check(typeof type==='number'&&Number.isSafeInteger(type)&&type>=0&&type<=65535&&media.contentType===expected.contentType,'NATIVE_REPLY_MEDIA_CHANGED');
          originals++;originalMedia={...media,nativeKind:type as number};
        }
        if(outgoing&&nativeId) {
          outgoingIds.push(nativeId);
          if(body!==null&&sentAt&&type===m.textMessageType)proofs.push({id:nativeId,ownId:o.self.uid,targetKey:`dm:${peer!.conversationId}`,text:body,
            sentAt,pending:pending||failed||status!==m.confirmedServerStatus});
        }
      }
      dom.check(originals===1,'NATIVE_REPLY_ORIGINAL_CHANGED');
      const editor=dom.one(chat,m.composer),button=dom.one(chat,m.send);
      dom.check(editor.closest(s.chat)===chat&&button.closest(s.chat)===chat&&!button.contains(editor),'NATIVE_REPLY_COMPOSER_CONFLICT');
      const scope=dom.one(chat,m.composerScope),bound=dom.data(dom.fiber(scope,m.composerFiberDepth),'curConversation');
      const scopeFirst=dom.data(bound,'conversationId'),scopeSecond=dom.data(bound,'id');
      dom.check(scope.contains(editor)&&scope.contains(button)&&(scopeFirst!==undefined||scopeSecond!==undefined)&&
        (scopeFirst===undefined||scopeFirst===peer!.conversationId)&&(scopeSecond===undefined||scopeSecond===peer!.conversationId)&&
        dom.data(bound,'_toParticipantSecUserId')===peer!.secUid,'NATIVE_REPLY_COMPOSER_CONFLICT');
      dom.check(editor instanceof HTMLElement&&editor.isContentEditable,'NATIVE_REPLY_EDITOR_UNSUPPORTED');
      dom.check(m.submission==='html-click'?button instanceof HTMLElement:button instanceof SVGElement,'NATIVE_REPLY_CONTROL_CHANGED');
      const editorText=dom.editorText(editor);
      return{context,proofs,outgoingIds,editorText,editorShape:editor.innerHTML,editor,button,latestId,...(originalMedia?{media:originalMedia}:{})};
    },
  };
  const state=dom.capture();
  if(input.action==='clearSaved'){
    dom.check(text!==null&&text.length>0&&state.editorText===text,'NATIVE_REPLY_SAVED_DRAFT_MISMATCH');
    const editor=state.editor as HTMLElement,context=JSON.stringify(state.context),shape=state.editorShape,latestId=state.latestId,
      events=['beforeinput','input','paste','drop','compositionstart'];
    const guard={foreign:false,clearing:false,
      changed():void{if(!guard.clearing)guard.foreign=true;},
      current():void{const current=dom.capture();dom.check(!guard.foreign&&current.editor===editor&&current.editorShape===shape&&
        current.editorText===text&&current.latestId===latestId&&JSON.stringify(current.context)===context,'NATIVE_REPLY_SAVED_DRAFT_CHANGED');}};
    for(const event of events)editor.addEventListener(event,guard.changed,true);
    try{
      editor.focus({preventScroll:true});guard.current();
      const selection=getSelection(),range=document.createRange();dom.check(selection,'NATIVE_REPLY_SELECTION_UNAVAILABLE');
      range.selectNodeContents(editor);selection!.removeAllRanges();selection!.addRange(range);guard.current();
      host.__inboraDmReplyGate?.remove();guard.clearing=true;
      dom.check(document.execCommand('delete',false),'NATIVE_REPLY_INPUT_UNSUPPORTED');
      const after=dom.capture();dom.check(after.editor===editor&&after.editorText===''&&after.latestId===latestId&&
        JSON.stringify(after.context)===context,'NATIVE_REPLY_SAVED_DRAFT_NOT_CLEARED');
      if(host.__inboraDmPreparation?.editor===editor)host.__inboraDmPreparation.remove();
      return{context:after.context,proofs:after.proofs,outgoingIds:after.outgoingIds,editorText:after.editorText,editorShape:after.editorShape,latestId:after.latestId};
    }finally{for(const event of events)editor.removeEventListener(event,guard.changed,true);}
  }
  if(input.action==='cancel'){
    const owned=host.__inboraDmPreparation;
    dom.check(owned&&token===owned.token&&text===owned.text&&owned.binding===JSON.stringify(dom.binding(expected))&&
      !owned.foreignInput&&state.editor===owned.editor&&state.editor.closest(s.chat)===owned.chat&&
      state.editorText===owned.text&&state.editorShape===owned.shape,'NATIVE_REPLY_PREPARATION_NOT_OWNED');
    host.__inboraDmReplyGate?.remove();
    const editor=owned!.editor;editor.focus({preventScroll:true});
    const selection=getSelection(),range=document.createRange();dom.check(selection,'NATIVE_REPLY_SELECTION_UNAVAILABLE');
    range.selectNodeContents(editor);selection!.removeAllRanges();selection!.addRange(range);
    const current=dom.capture();
    dom.check(!owned!.foreignInput&&current.editor===editor&&current.editorText===owned!.text&&current.editorShape===owned!.shape,'NATIVE_REPLY_PREPARATION_NOT_OWNED');
    owned!.clearing=true;
    try{dom.check(document.execCommand('delete',false),'NATIVE_REPLY_INPUT_UNSUPPORTED');}
    finally{owned!.clearing=false;owned!.remove();}
    const after=dom.capture();dom.check(after.editor===editor&&after.editorText==='','NATIVE_REPLY_PREPARATION_NOT_CLEARED');
    return{context:after.context,proofs:after.proofs,outgoingIds:after.outgoingIds,editorText:after.editorText,editorShape:after.editorShape,latestId:after.latestId};
  }
  if(input.action==='fill') {
    dom.check(input.before&&text!==null,'NATIVE_REPLY_INPUT_REQUIRED');
    const editor=state.editor as HTMLElement,before=input.before!,context=JSON.stringify(before.context);
    const checkInput={
      current():void {
        const current=dom.capture();
        dom.check(current.editor===editor&&JSON.stringify(current.context)===context,'NATIVE_REPLY_CONTEXT_CHANGED');
        dom.check(current.editorText===before.editorText,'NATIVE_REPLY_EXISTING_DRAFT');
        dom.check(document.activeElement===editor,'NATIVE_REPLY_FOCUS_CHANGED');
      },
    };
    dom.check(state.editorText===before.editorText&&JSON.stringify(state.context)===context,'NATIVE_REPLY_CONTEXT_CHANGED');
    editor.focus({preventScroll:true});checkInput.current();
    const selection=getSelection(),range=document.createRange();dom.check(selection,'NATIVE_REPLY_SELECTION_UNAVAILABLE');
    range.selectNodeContents(editor);selection!.removeAllRanges();selection!.addRange(range);
    checkInput.current();
    dom.check(document.execCommand('insertText',false,text!),'NATIVE_REPLY_INPUT_UNSUPPORTED');
    const after=dom.capture();
    dom.check(after.editor===editor&&JSON.stringify(after.context)===context,'NATIVE_REPLY_CONTEXT_CHANGED');
    dom.check(after.editorText===text,'NATIVE_REPLY_APPROVED_TEXT_CHANGED');
    if(token){
      host.__inboraDmPreparation?.remove();
      const events=['beforeinput','input','paste','drop','compositionstart'];
      const owned={token,editor,chat:editor.closest(s.chat)!,binding:JSON.stringify(dom.binding(expected)),text:text!,shape:after.editorShape,foreignInput:false,clearing:false,
        changed():void{if(!owned.clearing)owned.foreignInput=true;},
        remove():void{for(const event of events)editor.removeEventListener(event,owned.changed,true);if(host.__inboraDmPreparation===owned)delete host.__inboraDmPreparation;}};
      for(const event of events)editor.addEventListener(event,owned.changed,true);host.__inboraDmPreparation=owned;
    }
    return{context:after.context,proofs:after.proofs,outgoingIds:after.outgoingIds,editorText:after.editorText,editorShape:after.editorShape,latestId:after.latestId,...(after.media?{media:after.media}:{})};
  }
  if(input.action==='refresh'){
    dom.check(state.editorText==='','NATIVE_REPLY_EXISTING_DRAFT');
    // Initiate native navigation in the same task as the final account/target/draft check.
    location.reload();
  }
  if(input.action==='arm') {
    dom.check(token&&text!==null&&state.editorText===text,'NATIVE_REPLY_APPROVED_TEXT_CHANGED');
    dom.check(input.editorShape===state.editorShape,'NATIVE_REPLY_EDITOR_CHANGED');
    host.__inboraDmReplyGate?.remove();
    const button=state.button,editor=state.editor,editorShape=state.editorShape,baseline=JSON.stringify(state.context);
    const gate={token:token!,enabled:false,attempted:false,used:false,blocked:false,
      validate():void {
        const current=dom.capture();
        dom.check(current.button===button&&current.editor===editor&&current.editorShape===editorShape&&
          JSON.stringify(current.context)===baseline&&current.editorText===text);
        dom.check(!button.closest('[disabled],[aria-disabled="true"],.disabled')&&getComputedStyle(button).pointerEvents!=='none');
      },
      handle(event:Event):void {
        if(!event.composedPath().includes(button))return;
        try {dom.check(gate.enabled&&!gate.used&&!gate.blocked);gate.validate();
          if(event.currentTarget===button)gate.used=true;
        } catch {gate.blocked=true;event.preventDefault();event.stopImmediatePropagation();}
      },
      submit():boolean {
        dom.check(!gate.attempted&&!gate.blocked);gate.attempted=true;gate.validate();
        host.__inboraDmPreparation?.remove();
        button.removeEventListener('click',gate.handle,true);button.addEventListener('click',gate.handle,true);
        gate.enabled=true;
        try {
          if(m.submission==='html-click')(button as HTMLElement).click();
          else button.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,composed:true,view:window}));
        } finally {gate.enabled=false;gate.remove();}
        return gate.used&&!gate.blocked;
      },
      remove():void {window.removeEventListener('click',gate.handle,true);button.removeEventListener('click',gate.handle,true);},
    };
    gate.validate();
    window.addEventListener('click',gate.handle,true);button.addEventListener('click',gate.handle,true);host.__inboraDmReplyGate=gate;
  }
  return{context:state.context,proofs:state.proofs,outgoingIds:state.outgoingIds,editorText:state.editorText,editorShape:state.editorShape,latestId:state.latestId,...(state.media?{media:state.media}:{})};
}

/** Uses only the independently installed, calibrated DM reply mapping. */
export class ObservedDmReply implements ReplyAdapter {
  private gateToken:string|null=null;
  private prepared:{binding:string;text:string;editorShape:string;contextDigest:string}|null=null;
  private pendingEvent:InboundEvent|null=null;
  private inspectedContext:unknown[]|null=null;
  private preparedContext:unknown[]|null=null;
  private preparationToken:string|null=null;
  private submissionStarted=false;
  private readonly submission:SubmissionResponse|null;
  constructor(readonly page:Page,readonly mapping:DmReplyMapping,private readonly receiptTimeoutMs=5000,
    private readonly options:{manualMedia?:boolean;onContextChanged?:(report:DmContextChange)=>void}={}){
    this.submission=mapping.submissionReceipts?new SubmissionResponse(page,mapping.observation):null;
  }
  dispose():void{
    this.submission?.dispose();this.inspectedContext=null;this.preparedContext=null;
    this.preparationToken=null;this.prepared=null;this.pendingEvent=null;this.gateToken=null;
  }
  private contextChanged(stage:DmContextChange['stage'],before:unknown[]|null,after:unknown[]):void {
    if(!before||!this.options.onContextChanged||digest(before)===digest(after))return;
    const original=new Map(before.map(row=>{const tuple=row as unknown[];return [tuple[0],tuple] as const;})),
      current=new Map(after.map(row=>{const tuple=row as unknown[];return [tuple[0],tuple] as const;}));
    const report:DmContextChange={stage,beforeRows:before.length,afterRows:after.length,
      added:[...current.keys()].filter(id=>!original.has(id)).length,removed:[...original.keys()].filter(id=>!current.has(id)).length,
      reordered:digest([...original.keys()].filter(id=>current.has(id)))!==digest([...current.keys()].filter(id=>original.has(id))),
      changedRows:0,senderChanged:0,contentChanged:0,timeChanged:0,typeChanged:0,statusChanged:0,pendingChanged:0,failedChanged:0};
    const fields=['senderChanged','contentChanged','timeChanged','typeChanged','statusChanged','pendingChanged','failedChanged'] as const;
    for(const [id,row] of current){
      const prior=original.get(id);if(!prior)continue;
      if(digest(prior)!==digest(row))report.changedRows++;
      for(const [index,field] of fields.entries())if(digest(prior[index+1]??null)!==digest(row[index+1]??null))report[field]++;
    }
    try{this.options.onContextChanged(report);}catch{/* Diagnostics never alter qualification or expose callback errors. */}
  }
  private async frame(event:InboundEvent,action:ReplyCaptureInput['action']='snapshot',text:string|null=null,token:string|null=null,
    before:ReplyCaptureInput['before']=null,editorShape:string|null=null):Promise<ReplyFrame>{
    try{return await this.page.evaluate(captureDmReply,{mapping:this.mapping,event,action,text,token,before,editorShape,manualMedia:this.options.manualMedia===true});}
    catch(error){const code=error instanceof Error?error.message.match(/NATIVE_REPLY_[A-Z_]+/)?.[0]:null;
      if(code)requireSafe(false,code);throw error;}
  }
  private snapshot(event:InboundEvent,frame:ReplyFrame):TargetSnapshot {
    const contextDigest=digest(frame.context);
    return{accountId:event.accountId,ownId:this.mapping.observation.self.uid,targetKey:targetKey(event),eventBinding:eventBinding(event),
      composerKey:targetKey(event),contextDigest,mappingDigest:digest(this.mapping),...(frame.media?{manualObservation:{kind:'DM_MEDIA' as const,
        channel:'DIRECT_MESSAGE' as const,eventBinding:eventBinding(event),contextDigest,contentType:frame.media.contentType,
        nativeKind:frame.media.nativeKind,mediaDigest:digest(frame.media.witness),freshExact:true as const}}:{})};
  }
  async inspect(event:InboundEvent):Promise<TargetSnapshot>{
    this.gateToken=null;
    const o=this.mapping.observation,index=o.peers.findIndex(p=>p.uid===event.actorId&&p.conversationId===event.conversationId);
    requireSafe(event.channel==='DIRECT_MESSAGE'&&(isStrong(event)||this.options.manualMedia===true&&isManualMediaCandidate(event))&&index>=0,'NATIVE_REPLY_SCOPE_REQUIRED');
    await new ObservedReader(this.page,o).dm(index,o.peers[index],true);
    const frame=await this.frame(event);
    requireSafe(frame.editorText===''||this.prepared?.binding===eventBinding(event)&&this.prepared.text===frame.editorText,'NATIVE_REPLY_EXISTING_DRAFT');
    this.inspectedContext=frame.context;
    return this.snapshot(event,frame);
  }
  async prepare(event:InboundEvent,text:string):Promise<void>{
    requireSafe(!this.preparationToken&&!this.submissionStarted,'NATIVE_REPLY_PREPARATION_ALREADY_OWNED');
    validText(text);const frame=await this.frame(event);
    this.contextChanged('PREPARE',this.inspectedContext,frame.context);
    requireSafe(frame.editorText===''||this.prepared?.binding===eventBinding(event)&&this.prepared.text===frame.editorText,'NATIVE_REPLY_EXISTING_DRAFT');
    const preparationToken=randomUUID();
    const after=await this.frame(event,'fill',text,preparationToken,{context:frame.context,editorText:frame.editorText});
    this.contextChanged('FILL',frame.context,after.context);
    requireSafe(after.editorText===text,'NATIVE_REPLY_APPROVED_TEXT_CHANGED');
    requireSafe(digest(frame.context)===digest(after.context),'NATIVE_REPLY_CONTEXT_CHANGED');
    this.prepared={binding:eventBinding(event),text,editorShape:after.editorShape,contextDigest:digest(frame.context)};
    this.preparedContext=frame.context;
    this.preparationToken=preparationToken;this.submissionStarted=false;
    this.pendingEvent=event;
  }
  async verifyPrepared(event:InboundEvent,text:string):Promise<TargetSnapshot>{
    requireSafe(this.prepared?.binding===eventBinding(event)&&this.prepared.text===text,'NATIVE_REPLY_NOT_PREPARED');
    const token=randomUUID(),frame=await this.frame(event,'arm',text,token,null,this.prepared.editorShape);
    this.contextChanged('PREPARED',this.preparedContext,frame.context);
    this.gateToken=token;return this.snapshot(event,frame);
  }
  async baseline(event:InboundEvent):Promise<string[]>{const frame=await this.frame(event);this.contextChanged('BASELINE',this.preparedContext,frame.context);return frame.outgoingIds;}
  async cancelPreparation(event:InboundEvent,text:string):Promise<void>{
    requireSafe(!this.submissionStarted&&this.preparationToken&&this.prepared?.binding===eventBinding(event)&&this.prepared.text===text,'NATIVE_REPLY_PREPARATION_NOT_OWNED');
    await this.frame(event,'cancel',text,this.preparationToken);
    this.preparationToken=null;this.prepared=null;this.preparedContext=null;this.gateToken=null;
  }
  async readSavedDraft(event:InboundEvent):Promise<{text:string;snapshot:TargetSnapshot}>{
    requireSafe(event.channel==='DIRECT_MESSAGE'&&event.direction==='INCOMING'&&isStrong(event),'NATIVE_REPLY_SAVED_DRAFT_SCOPE_REQUIRED');
    const frame=await this.frame(event);validText(frame.editorText);
    return{text:frame.editorText,snapshot:this.snapshot(event,frame)};
  }
  async clearSavedDraft(event:InboundEvent,text:string):Promise<void>{
    validText(text);requireSafe(event.channel==='DIRECT_MESSAGE'&&event.direction==='INCOMING'&&isStrong(event),'NATIVE_REPLY_SAVED_DRAFT_SCOPE_REQUIRED');
    await this.frame(event,'clearSaved',text);
    requireSafe((await this.frame(event)).editorText==='','NATIVE_REPLY_SAVED_DRAFT_NOT_CLEARED');
  }
  async clickOnce(notBefore?:string):Promise<void>{
    this.submissionStarted=true;
    const token=this.gateToken;this.gateToken=null;requireSafe(token,'NATIVE_REPLY_NOT_PREPARED');
    if(this.submission){requireSafe(notBefore&&this.pendingEvent&&this.prepared,'NATIVE_REPLY_INTENT_REQUIRED');
      this.submission.arm(this.pendingEvent,this.prepared.text,notBefore);}
    const accepted=await this.page.evaluate(token=>{
      const gate=(window as unknown as {__inboraDmReplyGate?:{token:string;submit:()=>boolean;remove:()=>void}}).__inboraDmReplyGate;
      if(!gate||gate.token!==token)throw new Error('NATIVE_REPLY_NOT_PREPARED');
      try{return gate.submit();}finally{gate.remove();}
    },token);
    requireSafe(accepted,'NATIVE_REPLY_CLICK_BLOCKED');
  }
  async readback(event:InboundEvent,text:string,before:string[],notBefore:string):Promise<SendProof|null>{
    let ack=null;
    if(this.submission){const deadline=Date.now()+this.receiptTimeoutMs;
      while(!(ack=this.submission.current())&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
      if(!ack)return null;
    }
    return this.refreshedProof(event,text,before,notBefore,ack??undefined,this.prepared?.contextDigest);
  }
  async verifyExisting(event:InboundEvent,text:string,notBefore:string,baselineContextDigest?:string):Promise<SendProof|null>{
    requireSafe(Number.isFinite(Date.parse(notBefore)),'NATIVE_REPLY_INTENT_REQUIRED');
    await this.inspect(event);
    // A new read-only adapter cannot reconstruct the prior attempt's ephemeral acknowledgement.
    // Small clock differences require the persisted pre-send context, never an invented acknowledgement.
    return this.refreshedProof(event,text,[],notBefore,undefined,baselineContextDigest);
  }
  private async refreshedProof(event:InboundEvent,text:string,before:string[],notBefore:string,ack?:SubmissionAck,baselineContextDigest?:string):Promise<SendProof|null>{
    const initial=await this.poll(event,text,before,notBefore,ack?.id,baselineContextDigest);
    if(!initial)return null;
    // A serverId can coexist with a temporary local createdAt. Require a fresh page model.
    requireSafe((await this.frame(event,'proofs')).editorText==='','NATIVE_REPLY_EXISTING_DRAFT');
    if(ack)requireSafe(this.submission!.expectRefresh(ack),'NATIVE_REPLY_ACK_REVOKED');
    await Promise.all([this.page.waitForNavigation({waitUntil:'domcontentloaded',timeout:15_000}),this.frame(event,'refresh')]);
    const index=this.mapping.observation.peers.findIndex(p=>p.uid===event.actorId&&p.conversationId===event.conversationId);
    requireSafe(index>=0,'NATIVE_REPLY_SCOPE_REQUIRED');
    await new ObservedReader(this.page,this.mapping.observation).dm(index);
    const refreshed=await this.poll(event,text,before,notBefore,ack?.id,baselineContextDigest);
    if(ack&&this.submission!.current()!==ack)return null;
    const result=refreshed?.id===initial.id?{...refreshed,...(ack?{submission:ack.submission}:{}),
      ...(refreshed.clockSkew?{clockSkew:{...refreshed.clockSkew,refreshedId:refreshed.id}}:{})}:null;
    this.submission?.dispose();return result;
  }
  private async poll(event:InboundEvent,text:string,before:string[],notBefore:string,ackId?:string,baselineContextDigest?:string):Promise<SendProof|null>{
    const deadline=Date.now()+this.receiptTimeoutMs;let previous:string|null=null;
    do {
      const frame=await this.frame(event,'proofs');
      const start=Date.parse(notBefore);
      const matches=frame.proofs.filter(p=>!before.includes(p.id)&&p.text===text&&!p.pending&&
        (ackId?p.id===ackId:Date.parse(p.sentAt)>start||Boolean(baselineContextDigest&&
          Date.parse(p.sentAt)>=start-dmClockToleranceMs&&frame.latestId===p.id&&
          digest(frame.context.filter(row=>(row as unknown[])[0]!==p.id))===baselineContextDigest))&&Date.parse(p.sentAt)<=Date.now());
      requireSafe(matches.length<=1,'NATIVE_REPLY_RECEIPT_AMBIGUOUS');
      const candidate=matches[0],proof=candidate&&!ackId&&Date.parse(candidate.sentAt)<=start?{...candidate,
        clockSkew:{boundary:notBefore,baselineContextDigest:baselineContextDigest!,
          remainingContextDigest:digest(frame.context.filter(row=>(row as unknown[])[0]!==candidate.id)),refreshedId:''}}:candidate;
      if(proof&&digest(proof)===previous)return frame.editorText===''?proof:null;
      previous=proof?digest(proof):null;
      await new Promise(resolve=>setTimeout(resolve,75));
    }while(Date.now()<deadline);
    return null;
  }
}
