import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import type { DmReplyMapping } from '../config/site-mapping.js';
import { digest, eventBinding, isStrong, requireSafe, targetKey, validText,
  type InboundEvent, type ReplyAdapter, type SendProof, type TargetSnapshot } from '../core/contracts.js';
import { ObservedReader } from './observed-reader.js';
import {SubmissionResponse} from './submission-response.js';

interface ReplyCaptureInput {
  mapping: DmReplyMapping; event: InboundEvent;
  action: 'snapshot' | 'fill' | 'arm' | 'proofs' | 'refresh'; text: string | null; token: string | null;
  before: {context:unknown[];editorText:string}|null;
  editorShape:string|null;
}
interface ReplyFrame { context: unknown[]; proofs: SendProof[]; outgoingIds: string[]; editorText: string;editorShape:string }

/** Serialized without module helpers: fixed rendered paths, never calls website functions. */
export function captureDmReply(input: ReplyCaptureInput): ReplyFrame {
  const {mapping:m,event:expected,text,token}=input, o=m.observation, s=o.selectors;
  const peer=o.peers.find(p=>p.uid===expected.actorId&&p.conversationId===expected.conversationId);
  type Gate={token:string;submit:()=>boolean;remove:()=>void};
  const host=window as unknown as {__inboraDmReplyGate?:Gate};
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
    capture(): ReplyFrame & {editor: Element;button: Element} {
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
      const context:unknown[]=[],proofs:SendProof[]=[],outgoingIds:string[]=[],seen=new Set<string>();let originals=0;
      for(const row of rows) {
        const message=dom.data(dom.childProps(row),'message'),sender=dom.data(message,'sender'),id=dom.data(message,'serverId');
        dom.check(dom.data(message,'conversationId')===peer!.conversationId&&(sender===peer!.uid||sender===o.self.uid),'NATIVE_REPLY_MESSAGE_CONFLICT');
        const box=row.closest(s.messageBox);dom.check(box&&chat.contains(box),'NATIVE_REPLY_MESSAGE_CONFLICT');
        let outgoing=false;
        for(let node:Element|null=row;node&&box!.contains(node);node=node.parentElement)if(node.classList.contains(s.fromMeClass))outgoing=true;
        dom.check(outgoing===(sender===o.self.uid),'NATIVE_REPLY_DIRECTION_CONFLICT');
        const nativeId=typeof id==='string'&&/^[1-9]\d{0,63}$/.test(id)?id:null;
        if(nativeId){dom.check(!seen.has(nativeId),'NATIVE_REPLY_MESSAGE_ID_COLLISION');seen.add(nativeId);}
        const sentAt=dom.time(dom.data(message,'createdAt')),parsed=dom.data(message,'_parsedContent'),parsedText=dom.data(parsed,'text');
        const texts=row.querySelectorAll(s.messageText);
        const body=texts.length===1&&dom.visible(texts[0]!)&&!texts[0]!.querySelector('img,video,audio')?texts[0]!.textContent:null;
        if(body!==null)dom.check(body===parsedText,'NATIVE_REPLY_MESSAGE_TEXT_CONFLICT');
        const pending=dom.flagged(box!,m.pending),failed=dom.flagged(box!,m.failed);
        const status=dom.data(message,'serverStatus'),type=dom.data(message,'type');
        dom.check(typeof status==='number'&&Number.isFinite(status)&&typeof type==='number'&&Number.isFinite(type),'NATIVE_REPLY_MESSAGE_STATE_MISSING');
        if(input.action!=='proofs')dom.check(nativeId&&sentAt,'NATIVE_REPLY_WINDOW_UNVERIFIED');
        context.push([nativeId,sender,body,sentAt,type,status,pending,failed]);
        if(body!==null&&nativeId&&sentAt&&!outgoing&&type===m.textMessageType&&!pending&&!failed&&status===m.confirmedServerStatus) {
          const current={...expected,platformEventId:nativeId,actorId:sender as string,text:body,occurredAt:sentAt};
          if(JSON.stringify(dom.binding(current))===JSON.stringify(dom.binding(expected)))originals++;
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
      return{context,proofs,outgoingIds,editorText,editorShape:editor.innerHTML,editor,button};
    },
  };
  const state=dom.capture();
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
    return{context:after.context,proofs:after.proofs,outgoingIds:after.outgoingIds,editorText:after.editorText,editorShape:after.editorShape};
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
  return{context:state.context,proofs:state.proofs,outgoingIds:state.outgoingIds,editorText:state.editorText,editorShape:state.editorShape};
}

/** Uses only the independently installed, calibrated DM reply mapping. */
export class ObservedDmReply implements ReplyAdapter {
  private gateToken:string|null=null;
  private prepared:{binding:string;text:string;editorShape:string}|null=null;
  private pendingEvent:InboundEvent|null=null;
  private readonly submission:SubmissionResponse|null;
  constructor(readonly page:Page,readonly mapping:DmReplyMapping,private readonly receiptTimeoutMs=5000){
    this.submission=mapping.submissionReceipts?new SubmissionResponse(page,mapping.observation):null;
  }
  dispose():void{this.submission?.dispose();}
  private async frame(event:InboundEvent,action:ReplyCaptureInput['action']='snapshot',text:string|null=null,token:string|null=null,
    before:ReplyCaptureInput['before']=null,editorShape:string|null=null):Promise<ReplyFrame>{
    try{return await this.page.evaluate(captureDmReply,{mapping:this.mapping,event,action,text,token,before,editorShape});}
    catch(error){const code=error instanceof Error?error.message.match(/NATIVE_REPLY_[A-Z_]+/)?.[0]:null;
      if(code)requireSafe(false,code);throw error;}
  }
  private snapshot(event:InboundEvent,frame:ReplyFrame):TargetSnapshot {
    return{accountId:event.accountId,ownId:this.mapping.observation.self.uid,targetKey:targetKey(event),eventBinding:eventBinding(event),
      composerKey:targetKey(event),contextDigest:digest(frame.context),mappingDigest:digest(this.mapping)};
  }
  async inspect(event:InboundEvent):Promise<TargetSnapshot>{
    this.gateToken=null;
    const o=this.mapping.observation,index=o.peers.findIndex(p=>p.uid===event.actorId&&p.conversationId===event.conversationId);
    requireSafe(event.channel==='DIRECT_MESSAGE'&&isStrong(event)&&index>=0,'NATIVE_REPLY_SCOPE_REQUIRED');
    await new ObservedReader(this.page,o).dm(index);
    const frame=await this.frame(event);
    requireSafe(frame.editorText===''||this.prepared?.binding===eventBinding(event)&&this.prepared.text===frame.editorText,'NATIVE_REPLY_EXISTING_DRAFT');
    return this.snapshot(event,frame);
  }
  async prepare(event:InboundEvent,text:string):Promise<void>{
    validText(text);const frame=await this.frame(event);
    requireSafe(frame.editorText===''||this.prepared?.binding===eventBinding(event)&&this.prepared.text===frame.editorText,'NATIVE_REPLY_EXISTING_DRAFT');
    const after=await this.frame(event,'fill',text,null,{context:frame.context,editorText:frame.editorText});
    requireSafe(after.editorText===text,'NATIVE_REPLY_APPROVED_TEXT_CHANGED');
    requireSafe(digest(frame.context)===digest(after.context),'NATIVE_REPLY_CONTEXT_CHANGED');
    this.prepared={binding:eventBinding(event),text,editorShape:after.editorShape};
    this.pendingEvent=event;
  }
  async verifyPrepared(event:InboundEvent,text:string):Promise<TargetSnapshot>{
    requireSafe(this.prepared?.binding===eventBinding(event)&&this.prepared.text===text,'NATIVE_REPLY_NOT_PREPARED');
    const token=randomUUID(),frame=await this.frame(event,'arm',text,token,null,this.prepared.editorShape);
    this.gateToken=token;return this.snapshot(event,frame);
  }
  async baseline(event:InboundEvent):Promise<string[]>{return(await this.frame(event)).outgoingIds;}
  async clickOnce(notBefore?:string):Promise<void>{
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
    const initial=await this.poll(event,text,before,notBefore,ack?.id);
    if(!initial)return null;
    // A serverId can coexist with a temporary local createdAt. Require a fresh page model.
    requireSafe((await this.frame(event,'proofs')).editorText==='','NATIVE_REPLY_EXISTING_DRAFT');
    if(ack)requireSafe(this.submission!.expectRefresh(ack),'NATIVE_REPLY_ACK_REVOKED');
    await Promise.all([this.page.waitForNavigation({waitUntil:'domcontentloaded',timeout:15_000}),this.frame(event,'refresh')]);
    const index=this.mapping.observation.peers.findIndex(p=>p.uid===event.actorId&&p.conversationId===event.conversationId);
    requireSafe(index>=0,'NATIVE_REPLY_SCOPE_REQUIRED');
    await new ObservedReader(this.page,this.mapping.observation).dm(index);
    const refreshed=await this.poll(event,text,before,notBefore,ack?.id);
    if(ack&&this.submission!.current()!==ack)return null;
    const result=refreshed?.id===initial.id?{...refreshed,...(ack?{submission:ack.submission}:{})}:null;
    this.submission?.dispose();return result;
  }
  private async poll(event:InboundEvent,text:string,before:string[],notBefore:string,ackId?:string):Promise<SendProof|null>{
    const deadline=Date.now()+this.receiptTimeoutMs;let previous:string|null=null;
    do {
      const frame=await this.frame(event,'proofs');
      const matches=frame.proofs.filter(p=>!before.includes(p.id)&&p.text===text&&!p.pending&&
        (ackId?p.id===ackId:Date.parse(p.sentAt)>Date.parse(notBefore))&&Date.parse(p.sentAt)<=Date.now());
      requireSafe(matches.length<=1,'NATIVE_REPLY_RECEIPT_AMBIGUOUS');
      const proof=matches[0];
      if(proof&&digest(proof)===previous)return frame.editorText===''?proof:null;
      previous=proof?digest(proof):null;
      await new Promise(resolve=>setTimeout(resolve,75));
    }while(Date.now()<deadline);
    return null;
  }
}
