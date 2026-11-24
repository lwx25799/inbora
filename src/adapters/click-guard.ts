import type { SiteMapping, Field, EventFields } from '../config/site-mapping.js';
import type { Channel, InboundEvent } from '../core/contracts.js';

interface GuardInput { mapping:SiteMapping; channel:Channel; accountId:InboundEvent['accountId'] }
export interface CaptureInput extends GuardInput {
  event:InboundEvent; text:string|null; token:string|null; prepare?:string; preparationToken?:string;
}
export interface NavigationInput extends GuardInput {
  navigation: {selector:string; scope?:string; rows?:string; match?:{id:string;peerId:string}|{event:InboundEvent;fields:EventFields}};
}
type Preparation = {token:string; matches:(editor:Element,original:Element,event:InboundEvent,text:string)=>boolean; release:(discard:boolean)=>void};
type Gate = {token:string; remove:()=>void; submit:()=>boolean};
type GuardHost = {__inboraGate?:Gate; __inboraPreparation?:Preparation};

/** Detach only the matching operation. Cancel may also restore its untouched editor. */
export function releaseMappedPreparation({token,discard}:{token:string;discard:boolean}):void {
  const host=window as unknown as GuardHost;
  if(host.__inboraGate?.token===token){host.__inboraGate.remove();delete host.__inboraGate;}
  if(host.__inboraPreparation?.token===token){
    const preparation=host.__inboraPreparation;
    delete host.__inboraPreparation;
    preparation.release(discard);
  }
}
export interface CaptureResult { context: unknown[]; ownId: string; targetKey: string; existingDraft?: true }

/** Runs entirely inside the page. No async gap between the native click capture and validation. */
export function captureAndGuard(input: CaptureInput|NavigationInput): CaptureResult|null {
  const {mapping:m,channel,accountId}=input;
  const host=window as unknown as GuardHost;
  const t = m.targets[channel];
  // Object methods keep this serialized function self-contained under both tsc and tsx/esbuild.
  const dom = {
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
    check(ok:unknown,code='CLICK_DOM_GUARD_BLOCKED'):void {if(!ok)throw new Error(code);},
    visible(el: Element): boolean {
      const style = getComputedStyle(el); return el.getClientRects().length > 0 && style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none';
    },
    one(root: Document | Element, selector: string,code?:string): Element {
      const elements = root.querySelectorAll(selector); dom.check(elements.length === 1 && dom.visible(elements[0]!),code); return elements[0]!;
    },
    read(root: Document | Element, spec: Field | null): string | null {
      if (!spec) return null;
      const element = spec.selector ? dom.one(root,spec.selector) : root;
      if (!(element instanceof Element)) throw new Error('CLICK_DOM_GUARD_BLOCKED');
      const raw = spec.attribute ? element.getAttribute(spec.attribute) : element.textContent;
      if (!raw) return null;
      if (spec.extract) {
        const regex = new RegExp(spec.extract.pattern,'u'); dom.check(regex.test(raw)); return raw.replace(regex,spec.extract.replacement).trim() || null;
      }
      return raw.trim() || null;
    },
    parse(root: Element, fields: EventFields): InboundEvent {
      const r: Record<string,string|null> = {};
      for (const [name,spec] of Object.entries(fields)) r[name] = dom.read(root,spec);
      return {...r,accountId,channel,direction:m.directionValues[r.direction ?? ''] ?? 'UNKNOWN',
        kind:m.kindValues[r.kind ?? ''] ?? 'UNKNOWN'} as unknown as InboundEvent;
    },
    binding(e: InboundEvent): unknown[] {
      return [e.accountId,e.channel,e.platformEventId,e.actorId,e.text,e.occurredAt,e.videoId,e.commentId,e.conversationId,e.direction,e.kind];
    },
    formControl(editor:Element):editor is HTMLInputElement|HTMLTextAreaElement {
      return editor instanceof HTMLInputElement||editor instanceof HTMLTextAreaElement;
    },
    text(editor:Element):string|null {return dom.formControl(editor)?editor.value:editor.textContent;},
    shape(editor:Element):string {
      return dom.formControl(editor)?JSON.stringify([editor.tagName,editor.type,editor.readOnly,editor.matches(':disabled')])
        :JSON.stringify([editor instanceof HTMLElement&&editor.isContentEditable,editor.innerHTML]);
    },
    empty(editor:Element):boolean {
      return dom.text(editor)===''&&(dom.formControl(editor)||editor.children.length===0||
        editor.children.length===1&&editor.firstElementChild?.tagName==='BR');
    },
    write(editor:Element,value:string):void {
      if(dom.formControl(editor)){
        const prototype=editor instanceof HTMLInputElement?HTMLInputElement.prototype:HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(editor,value);
      }else editor.textContent=value;
    },
    input(editor:Element,value:string):void {
      editor.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:value?'insertText':'deleteContent',data:value||null}));
    },
    guardPage(navigation=false):void {
      dom.check(location.origin===m.origin,navigation?'UNEXPECTED_ORIGIN':undefined);
      for(const [code,selector] of [['PLATFORM_STOP',m.guards.stopped],['CHALLENGE_REQUIRED',m.guards.challenge],['LOGIN_REQUIRED',m.guards.loginRequired]] as const)
        dom.check(!Array.from(document.querySelectorAll(selector)).some(dom.securityVisible),navigation?code:undefined);
      dom.one(document,m.guards.loggedIn,navigation?'ACCOUNT_NOT_VERIFIED':undefined);
      dom.check(dom.read(document,m.guards.ownIdentity)===m.ownId,navigation?'ACCOUNT_NOT_VERIFIED':undefined);
    },
    navigate(input:NavigationInput):void {
      dom.guardPage(true);
      const {selector,scope,rows,match}=input.navigation;
      let container=scope?dom.one(document,scope,'DOM_NOT_UNIQUE_OR_VISIBLE'):document;
      if(rows&&match){
        const matches=Array.from(container.querySelectorAll(rows)).filter(row=>dom.visible(row)&&('event' in match
          ?match.event.accountId===accountId&&JSON.stringify(dom.binding(dom.parse(row,match.fields)))===JSON.stringify(dom.binding(match.event))
          :dom.read(row,m.dm.conversationId)===match.id&&dom.read(row,m.dm.peerId)===match.peerId));
        dom.check(matches.length===1,'event' in match?'NOTIFICATION_TARGET_UNRESOLVED':'CONVERSATION_NOT_UNIQUE');
        container=matches[0]!;
      }
      const button=dom.one(container,selector,'DOM_NOT_UNIQUE_OR_VISIBLE');
      if(!(button instanceof HTMLElement)||!button.isConnected||button.matches(':disabled'))
        throw new Error('DOM_NOT_UNIQUE_OR_VISIBLE');
      if(button instanceof HTMLAnchorElement&&button.href&&new URL(button.href).origin!==m.origin)
        throw new Error('UNSAFE_COMMENT_LINK');
      for(const target of Object.values(m.targets))
        for(const editor of document.querySelectorAll(target.composer))
          dom.check(dom.empty(editor),'BROWSER_HAS_HUMAN_INPUT');
      button.click();
    },
    capture(expected:InboundEvent,key:string){
      dom.check(expected.accountId===accountId);
      dom.guardPage();
      const originals = Array.from(document.querySelectorAll(t.roots)).filter(root => dom.visible(root) &&
        JSON.stringify(dom.binding(dom.parse(root,t.fields))) === JSON.stringify(dom.binding(expected)));
      dom.check(originals.length === 1);
      const composer = dom.one(document,t.composer); dom.check(dom.read(composer,t.composerTarget) === key);

      const context: unknown[] = []; let scope: Element = originals[0]!;
      if (channel === 'DIRECT_MESSAGE') {
        scope = dom.one(document,m.dm.pane);
        const activeRow = dom.one(dom.one(document,m.dm.list),m.dm.activeRow);
        dom.check(dom.read(activeRow,m.dm.conversationId) === expected.conversationId && dom.read(activeRow,m.dm.peerId) === expected.actorId);
        dom.check(dom.read(scope,m.dm.activeId) === expected.conversationId && dom.read(scope,m.dm.activePeerId) === expected.actorId);
        for (const row of scope.querySelectorAll(m.dm.messages)) if (dom.visible(row)) context.push(dom.binding(dom.parse(row,m.dm.fields)));
      } else context.push(dom.binding(expected));
      const ids = new Set<string>();
      for (const row of scope.querySelectorAll(t.outgoingRows)) if (dom.visible(row)) {
        const id = dom.read(row,t.proof.id); dom.check(id && !ids.has(id)); ids.add(id!);
        context.push([id,dom.read(row,t.proof.ownId),dom.read(row,t.proof.targetKey),dom.read(row,t.proof.text),dom.read(row,t.proof.pending),dom.read(row,t.proof.sentAt)]);
      }
      return {state:{context,ownId:m.ownId,targetKey:key},composer,original:originals[0]!};
    },
  };
  if('navigation' in input){dom.navigate(input);return null;}
  const {event:expected,text,token,prepare,preparationToken}=input;
  const key=channel==='DIRECT_MESSAGE'?`dm:${expected.conversationId}`:`comment:${expected.videoId}:${expected.commentId}`;
  const {state,composer,original}=dom.capture(expected,key);
  if(prepare!==undefined){
    dom.check(text===null&&token===null&&preparationToken&&!host.__inboraPreparation);
    if(!dom.empty(composer))return {...state,existingDraft:true};
    if(composer instanceof HTMLInputElement){
      dom.check(!/[\r\n]/u.test(prepare),'MAPPED_EDITOR_SINGLE_LINE_ONLY');
      dom.check(['text','search','tel','url','email','password'].includes(composer.type));
    }
    if(dom.formControl(composer))dom.check(!composer.readOnly&&!composer.matches(':disabled'));
    else dom.check(composer instanceof HTMLElement&&composer.isContentEditable);
    const nodes=dom.formControl(composer)?[]:Array.from(composer.childNodes);
    const owner=document,href=location.href,binding=JSON.stringify(dom.binding(expected));
    dom.write(composer,prepare);
    const shape=dom.shape(composer);
    let edited=false;
    const editorInput={mark():void{edited=true;}};
    const preparation:Preparation={
      token:preparationToken!,
      matches(editor,root,event,value){
        return !edited&&document===owner&&location.href===href&&editor===composer&&root===original&&
          JSON.stringify(dom.binding(event))===binding&&value===prepare&&dom.text(editor)===prepare&&dom.shape(editor)===shape;
      },
      release(discard){
        composer.removeEventListener('input',editorInput.mark);
        if(!discard)return;
        try{
          const current=dom.capture(expected,key);
          if(!preparation.matches(current.composer,current.original,expected,prepare))return;
          if(dom.formControl(composer))dom.write(composer,'');else composer.replaceChildren(...nodes);
          dom.input(composer,'');
        }catch{/* A changed document or unverified target may contain a human draft. */}
      },
    };
    host.__inboraPreparation=preparation;
    dom.input(composer,prepare);
    composer.addEventListener('input',editorInput.mark);
  }
  if (token) {
    const preparation=host.__inboraPreparation;
    if(!preparation||preparation.token!==token||text===null||!preparation.matches(composer,original,expected,text))
      throw new Error('CLICK_DOM_GUARD_BLOCKED');
    const button=dom.one(document,t.send),baseline=JSON.stringify(state);
    const verify={
      current():void{
        const current=dom.capture(expected,key);
        dom.check(host.__inboraPreparation===preparation&&preparation.matches(current.composer,current.original,expected,text));
        dom.check(JSON.stringify(current.state)===baseline);
        dom.check(button instanceof HTMLElement&&!button.matches(':disabled')&&!button.closest('[aria-disabled="true"]'),'SEND_BUTTON_DISABLED');
      },
    };
    verify.current();host.__inboraGate?.remove();
    const gate = {
      token,enabled:false,used:false,blocked:false,
      handle(event: Event): void {
        const path = event.composedPath(); const current = Array.from(document.querySelectorAll(t.send));
        if (!path.includes(button) && !current.some(el => path.includes(el))) return;
        try {
          dom.check(gate.enabled && !gate.blocked && !gate.used && current.length === 1 && current[0] === button);
          verify.current();
          if (event.type === 'click' && event.currentTarget === button) gate.used = true;
        } catch { gate.blocked = true; event.preventDefault(); event.stopImmediatePropagation(); }
      },
      submit(): boolean {
        dom.check(!gate.used && !gate.blocked && dom.one(document,t.send) === button);
        verify.current();
        // Re-arm after all earlier page tasks, then check and DOM-click in this same JS task.
        // No synthetic pointerover/pointerdown sequence can attach a later click handler in between.
        button.removeEventListener('click',gate.handle,true);button.addEventListener('click',gate.handle,true);
        gate.enabled=true;
        try{(button as HTMLElement).click();}finally{gate.enabled=false;}
        return gate.used&&!gate.blocked;
      },
      remove(): void {
        window.removeEventListener('pointerdown',gate.handle,true); window.removeEventListener('click',gate.handle,true);
        button.removeEventListener('click',gate.handle,true);
      },
    };
    window.addEventListener('pointerdown',gate.handle,true); window.addEventListener('click',gate.handle,true);
    button.addEventListener('click',gate.handle,true);
    host.__inboraGate = gate;
  }
  return state;
}
