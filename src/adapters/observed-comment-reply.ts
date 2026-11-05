import {randomUUID} from 'node:crypto';
import type {Page} from 'playwright';
import type {CommentReplyMapping} from '../config/site-mapping.js';
import {digest,eventBinding,isStrong,requireSafe,targetKey,validText,
  type InboundEvent,type ReplyAdapter,type SendProof,type TargetSnapshot} from '../core/contracts.js';
import {ObservedReader} from './observed-reader.js';

interface Input{mapping:CommentReplyMapping;event:InboundEvent;action:'open'|'snapshot'|'fill'|'finish'|'arm'|'proofs';text:string|null;
  token:string|null;before:{context:unknown[];editorText:string}|null;shape:string|null}
interface Frame{context:unknown[];proofs:SendProof[];ids:string[];editorText:string;shape:string}

/** Fixed, bounded rendered paths. No calls to website handlers, getters or private endpoints. */
export function captureCommentReply(input:Input):Frame{
  const {mapping:m,event:e}=input,o=m.observation,s=o.selectors;
  type Gate={token:string;submit:()=>boolean;remove:()=>void};
  type InputGate={token:string;used:boolean;blocked:boolean;editor:HTMLElement;remove:()=>void};
  const host=window as unknown as {__inboraCommentGate?:Gate;__inboraCommentInputGate?:InputGate};
  const dom={
    check(ok:unknown,code='COMMENT_REPLY_GUARD_BLOCKED'):void{if(!ok)throw Error(code);},
    // Same reviewed MIT dataField adaptation as observed-reader; see UPSTREAM/third_party.
    data(object:unknown,key:string):unknown{
      if(!object||typeof object!=='object')return undefined;
      const own=Object.getOwnPropertyDescriptor(object,key),inherited=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(object)??{},key);
      dom.check(!own||Object.hasOwn(own,'value'),'COMMENT_REPLY_ACCESSOR');
      dom.check(!inherited||Object.hasOwn(inherited,'value'),'COMMENT_REPLY_ACCESSOR');
      dom.check(!own||!inherited||own.value===inherited.value,'COMMENT_REPLY_FIELD_CONFLICT');
      return own?own.value:inherited?.value;
    },
    visible(node:Element):boolean{
      if(!node.isConnected||!node.getClientRects().length)return false;
      for(let n:Element|null=node;n;n=n.parentElement){const v=getComputedStyle(n);
        if(v.display==='none'||v.visibility==='hidden'||v.visibility==='collapse'||Number(v.opacity)===0)return false;}
      return true;
    },
    one(root:Document|Element,selector:string,visible=true):Element{
      const found=root.querySelectorAll(selector);dom.check(found.length>0,'COMMENT_REPLY_DOM_NOT_READY');
      dom.check(found.length===1,'COMMENT_REPLY_DOM_CHANGED');dom.check(found[0]!.isConnected&&(!visible||dom.visible(found[0]!)), 'COMMENT_REPLY_DOM_NOT_READY');return found[0]!;
    },
    props(node:Element,depth:number):unknown{
      const keys=Object.getOwnPropertyNames(node).filter(k=>k.startsWith('__reactFiber$'));
      dom.check(keys.length===1,'COMMENT_REPLY_METADATA_MISSING');let fiber=dom.data(node,keys[0]!);
      for(let i=0;i<depth;i++)fiber=dom.data(fiber,'return');return dom.data(fiber,'memoizedProps');
    },
    time(value:unknown):string|null{
      const at=typeof value==='number'?value*1000:NaN;
      return Number.isFinite(at)&&at>=Date.UTC(2000,0,1)&&at<=Date.now()?new Date(at).toISOString():null;
    },
    owned(root:Element,selector:string):Element[]{
      return Array.from(root.querySelectorAll(selector)).filter(n=>n.closest(s.commentRows)===root);
    },
    root():{root:Element;context:unknown[];proofs:SendProof[];ids:string[]}{
      const work=o.works.find(w=>w.id===e.videoId),peer=o.peers.find(p=>p.uid===e.actorId);
      dom.check(work&&peer&&e.channel==='COMMENT_NOTIFICATION'&&e.kind==='COMMENT'&&e.direction==='INCOMING','COMMENT_REPLY_SCOPE_REQUIRED');
      dom.check(location.origin===o.origin&&location.href.split('?')[0]===work!.url.split('?')[0]&&
        !/验证码|安全验证|访问受限/.test(document.title)&&!Array.from(document.querySelectorAll(m.blockers)).some(dom.visible),'COMMENT_REPLY_PAGE_BLOCKED');
      const own=dom.props(dom.one(document,s.selfAvatar),s.selfFiberDepth);
      dom.check(dom.data(own,'uid')===o.self.uid&&dom.data(own,'secUid')===o.self.secUid,'COMMENT_REPLY_ACCOUNT_CHANGED');
      const list=dom.one(document,s.commentList),rows=Array.from(list.querySelectorAll(s.commentRows));
      dom.check(rows.length<=100,'COMMENT_REPLY_WINDOW_TOO_LARGE');
      const roots=rows.filter(n=>!n.parentElement?.closest(s.commentRows)&&dom.visible(n)&&
        dom.data(dom.data(dom.props(n,s.commentFiberDepth),'commentInfo'),'cid')===e.commentId);
      dom.check(roots.length===1,'COMMENT_REPLY_ROOT_NOT_UNIQUE');const root=roots[0]!,p=dom.props(root,s.commentFiberDepth),c=dom.data(p,'commentInfo');
      const author=dom.data(c,'user'),texts=dom.owned(root,s.commentText).filter(n=>n.textContent===e.text),
        tooltips=dom.owned(root,s.commentTooltip).filter(n=>n.id===`tooltip_${e.commentId}`),links=dom.owned(root,s.commentAuthor);
      const profile=links.length===1?new URL(links[0]!.getAttribute('href')??'',location.origin):null;
      dom.check(dom.data(p,'level')===m.rootLevel&&dom.data(c,'replyId')==='0'&&dom.data(c,'cid')===e.commentId&&
        dom.data(dom.data(p,'awemeInfo'),'awemeId')===e.videoId&&dom.data(dom.data(p,'userInfo'),'uid')===o.self.uid&&
        dom.data(author,'uid')===e.actorId&&dom.data(author,'secUid')===peer!.secUid&&
        profile?.origin===o.origin&&profile.pathname===`/user/${peer!.secUid}`&&
        texts.length===1&&dom.visible(texts[0]!)&&texts[0]!.textContent===e.text&&dom.data(c,'text')===e.text&&
        dom.time(dom.data(c,'createTime'))===e.occurredAt&&dom.data(c,'status')===m.confirmedStatus&&
        tooltips.length===1&&tooltips[0]!.id===`tooltip_${e.commentId}`,'COMMENT_REPLY_ORIGINAL_CHANGED');
      const replies=dom.data(c,'replyComment'),total=dom.data(c,'replyTotal');
      dom.check(Array.isArray(replies)&&replies.length<=100&&typeof total==='number'&&total>=replies.length,'COMMENT_REPLY_CONTEXT_UNVERIFIED');
      const context:unknown[]=[e.commentId,total],proofs:SendProof[]=[],ids:string[]=[],seen=new Set<string>();
      for(const r of replies as unknown[]){
        const id=dom.data(r,'cid'),text=dom.data(r,'text'),parent=dom.data(r,'replyId'),user=dom.data(r,'user'),uid=dom.data(user,'uid');
        const sec=dom.data(user,'secUid'),at=dom.time(dom.data(r,'createTime')),status=dom.data(r,'status');
        const strong=typeof id==='string'&&/^[1-9]\d{0,63}$/.test(id)&&typeof text==='string'&&typeof uid==='string'&&at&&parent===e.commentId;
        if(input.action!=='proofs')dom.check(strong,'COMMENT_REPLY_CONTEXT_UNVERIFIED');
        if(typeof id==='string'){dom.check(!seen.has(id),'COMMENT_REPLY_ID_COLLISION');seen.add(id);ids.push(id);}
        context.push([id,text,parent,uid,sec,at,status]);
        if(!strong||uid!==o.self.uid||sec!==o.self.secUid||status!==m.confirmedStatus)continue;
        const tooltip=Array.from(root.querySelectorAll(s.commentTooltip)).filter(n=>n.id===`tooltip_${id}`&&dom.visible(n));
        if(tooltip.length!==1)continue;
        const child=tooltip[0]!.closest(s.commentRows);
        if(!child||child===root||!dom.visible(child)||child.parentElement?.closest(s.commentRows)!==root)continue;
        const childProps=dom.props(child,s.commentFiberDepth),native=dom.data(childProps,'commentInfo'),nativeUser=dom.data(native,'user');
        if(dom.data(childProps,'level')!==2||dom.data(dom.data(childProps,'awemeInfo'),'awemeId')!==e.videoId||
          dom.data(native,'cid')!==id||dom.data(native,'replyId')!==e.commentId||dom.data(native,'text')!==text||
          dom.data(nativeUser,'uid')!==uid||dom.data(nativeUser,'secUid')!==sec||dom.time(dom.data(native,'createTime'))!==at||
          dom.data(native,'status')!==status)continue;
        const bodies=dom.owned(child,s.commentText).filter(dom.visible),authors=dom.owned(child,s.commentAuthor).filter(dom.visible);
        const authorUrl=authors.length===1?new URL(authors[0]!.getAttribute('href')??'',location.origin):null;
        const flagged=Array.from(child.querySelectorAll(`${m.pending},${m.failed}`)).some(dom.visible)||child.matches(`${m.pending},${m.failed}`);
        if(bodies.length===1&&bodies[0]!.textContent===text&&authorUrl?.origin===o.origin&&!authorUrl.username&&!authorUrl.password&&
          authorUrl.pathname===`/user/${o.self.secUid}`&&!flagged)
          proofs.push({id:id as string,ownId:o.self.uid,targetKey:`comment:${e.videoId}:${e.commentId}`,text:text as string,pending:false,sentAt:at as string});
      }
      return{root,context,proofs,ids};
    },
    editorText(editor:Element):string{
      dom.check(editor instanceof HTMLElement&&editor.isContentEditable&&!editor.querySelector('img,video,audio,input,[contenteditable]'),'COMMENT_REPLY_EDITOR_UNSUPPORTED');
      const contents=editor.querySelectorAll('[data-contents="true"]'),blocks=editor.querySelectorAll('[data-block="true"]');
      dom.check(contents.length===1&&blocks.length===1&&contents[0]!.parentElement===editor&&blocks[0]!.parentElement===contents[0]&&
        editor.children.length===1&&contents[0]!.children.length===1&&blocks[0]!.children.length===1,'COMMENT_REPLY_EDITOR_UNSUPPORTED');
      const line=blocks[0]!.firstElementChild;
      dom.check(line?.matches('div.public-DraftStyleDefault-block')&&Array.from(line.querySelectorAll('*')).every(n=>
        (n.tagName==='SPAN'||n.tagName==='BR')&&dom.visible(n)),'COMMENT_REPLY_EDITOR_UNSUPPORTED');
      const text=editor.textContent??'';
      dom.check(!/[\r\n]/.test(text)&&(text===''?editor.querySelectorAll('br').length===1:editor.querySelectorAll('br').length===0&&
        (editor as HTMLElement).innerText===text),'COMMENT_REPLY_EDITOR_UNSUPPORTED');return text;
    },
    capture():Frame&{root:Element;editor:HTMLElement;button:HTMLElement}{
      const state=dom.root(),scope=dom.one(state.root,m.composerScope),p=dom.props(scope,m.composerFiberDepth);
      dom.check(scope.closest(s.commentRows)===state.root&&dom.data(p,'cid')===e.commentId&&dom.data(p,'level')===m.rootLevel&&
        dom.data(p,'levelOneCid')===undefined&&dom.data(dom.data(p,'awemeInfo'),'awemeId')===e.videoId,'COMMENT_REPLY_COMPOSER_CHANGED');
      const editor=dom.one(scope,m.composer),button=dom.one(scope,m.send,false);
      dom.check(editor instanceof HTMLElement&&button instanceof HTMLElement&&editor.closest(m.composerScope)===scope&&
        button.closest(m.composerScope)===scope&&!button.contains(editor),'COMMENT_REPLY_COMPOSER_CHANGED');
      return{...state,editor:editor as HTMLElement,button:button as HTMLElement,editorText:dom.editorText(editor),shape:editor.innerHTML};
    },
    frame(state:Frame):Frame{return{context:state.context,proofs:state.proofs,ids:state.ids,editorText:state.editorText,shape:state.shape};},
  };
  if(input.action==='proofs'){const state=dom.root();return dom.frame({...state,editorText:'',shape:''});}
  if(input.action==='open'){
    const state=dom.root();
    if(!state.root.querySelector(m.composerScope)){
      const action=dom.one(state.root,m.replyAction);dom.check(action.textContent==='回复','COMMENT_REPLY_ACTION_CHANGED');
      const gate={handle(event:Event):void{if(event.currentTarget!==action)return;try{dom.check(dom.root().root===state.root&&action.isConnected);}
        catch{event.preventDefault();event.stopImmediatePropagation();}}};
      action.addEventListener('click',gate.handle,true);try{action instanceof HTMLElement&&action.click();}finally{action.removeEventListener('click',gate.handle,true);}
    }
    return dom.frame({...state,editorText:'',shape:''});
  }
  const state=dom.capture();
  if(input.action==='fill'){
    dom.check(input.text!==null&&input.before&&input.token,'COMMENT_REPLY_INPUT_REQUIRED');const editor=state.editor,prior=input.before!;
    const checkInput={validate():void{const now=dom.capture();dom.check(now.editor===editor&&JSON.stringify(now.context)===JSON.stringify(prior.context)&&
      now.editorText===prior.editorText,'COMMENT_REPLY_INPUT_CHANGED');dom.check(document.activeElement===editor,'COMMENT_REPLY_FOCUS_CHANGED');}};
    dom.check(state.editorText===prior.editorText&&JSON.stringify(state.context)===JSON.stringify(prior.context),'COMMENT_REPLY_INPUT_CHANGED');
    editor.focus({preventScroll:true});checkInput.validate();const selection=getSelection(),range=document.createRange();dom.check(selection,'COMMENT_REPLY_SELECTION_UNAVAILABLE');
    range.selectNodeContents(editor);selection!.removeAllRanges();selection!.addRange(range);checkInput.validate();
    host.__inboraCommentInputGate?.remove();
    const textEvent=new InputEvent('textInput',{data:input.text!,inputType:'insertText',bubbles:true,cancelable:true,composed:true});
    // Controlled-editor event only: never allow browser default insertion into a newly focused frame.
    textEvent.preventDefault();
    const gate={token:input.token!,used:false,blocked:false,editor,
      handle(event:Event):void{
        try{
          const selected=getSelection();
          dom.check(!gate.used&&!gate.blocked&&event===textEvent&&event instanceof InputEvent&&event.inputType==='insertText'&&
            event.data===input.text&&event.composedPath().includes(editor),'COMMENT_REPLY_INPUT_EVENT_CHANGED');
          checkInput.validate();dom.check(selected?.rangeCount===1&&editor.contains(selected.anchorNode)&&editor.contains(selected.focusNode)&&
            selected.toString()===prior.editorText,'COMMENT_REPLY_SELECTION_CHANGED');
          if(event.currentTarget===editor)gate.used=true;
        }catch{gate.blocked=true;event.preventDefault();event.stopImmediatePropagation();}
      },
      remove():void{window.removeEventListener('textInput',gate.handle,true);editor.removeEventListener('textInput',gate.handle,true);},
    };
    window.addEventListener('textInput',gate.handle,true);editor.addEventListener('textInput',gate.handle,true);host.__inboraCommentInputGate=gate;
    checkInput.validate();
    try{editor.dispatchEvent(textEvent);}finally{gate.remove();}
    dom.check(gate.used&&!gate.blocked,'COMMENT_REPLY_INPUT_NOT_WITNESSED');
    return dom.frame(state);
  }
  if(input.action==='finish'){
    const gate=host.__inboraCommentInputGate;
    dom.check(gate?.token===input.token&&gate.used&&!gate.blocked&&gate.editor===state.editor,'COMMENT_REPLY_INPUT_NOT_WITNESSED');
    dom.check(input.before&&JSON.stringify(state.context)===JSON.stringify(input.before.context),'COMMENT_REPLY_INPUT_CHANGED');
    if(input.before&&state.editorText===input.before.editorText&&state.editorText!==input.text)
      dom.check(false,'COMMENT_REPLY_INPUT_NOT_SETTLED');
    dom.check(state.editorText===input.text,'COMMENT_REPLY_INPUT_CHANGED');
    return dom.frame(state);
  }
  if(input.action==='arm'){
    dom.check(input.token&&input.text===state.editorText&&input.shape===state.shape,'COMMENT_REPLY_PREPARED_CHANGED');
    host.__inboraCommentGate?.remove();const editor=state.editor,button=state.button,root=state.root,shape=state.shape,context=JSON.stringify(state.context);
    const gate={token:input.token!,enabled:false,used:false,blocked:false,attempted:false,
      validate():void{const now=dom.capture();dom.check(dom.visible(button),'COMMENT_REPLY_SEND_NOT_READY');dom.check(now.root===root&&now.editor===editor&&now.button===button&&now.shape===shape&&
        now.editorText===input.text&&JSON.stringify(now.context)===context&&!button.closest('[disabled],[aria-disabled="true"],.disabled')&&
        getComputedStyle(button).pointerEvents!=='none');},
      handle(event:Event):void{if(!event.composedPath().includes(button))return;
        try{dom.check(gate.enabled&&!gate.used&&!gate.blocked);gate.validate();if(event.currentTarget===button)gate.used=true;}
        catch{gate.blocked=true;event.preventDefault();event.stopImmediatePropagation();}},
      submit():boolean{dom.check(!gate.attempted&&!gate.blocked);gate.attempted=true;gate.validate();
        button.removeEventListener('click',gate.handle,true);button.addEventListener('click',gate.handle,true);gate.enabled=true;
        try{button.click();}finally{gate.enabled=false;gate.remove();}return gate.used&&!gate.blocked;},
      remove():void{window.removeEventListener('click',gate.handle,true);button.removeEventListener('click',gate.handle,true);},
    };
    gate.validate();window.addEventListener('click',gate.handle,true);button.addEventListener('click',gate.handle,true);host.__inboraCommentGate=gate;
  }
  return dom.frame(state);
}

export class ObservedCommentReply implements ReplyAdapter{
  private prepared:{binding:string;text:string;shape:string}|null=null;
  private token:string|null=null;
  constructor(readonly page:Page,readonly mapping:CommentReplyMapping,private readonly timeoutMs=5000){}
  private async frame(event:InboundEvent,action:Input['action']='snapshot',text:string|null=null,token:string|null=null,
    before:Input['before']=null,shape:string|null=null):Promise<Frame>{
    try{return await this.page.evaluate(captureCommentReply,{mapping:this.mapping,event,action,text,token,before,shape});}
    catch(error){const code=error instanceof Error?error.message.match(/COMMENT_REPLY_[A-Z_]+/)?.[0]:null;if(code)requireSafe(false,code);throw error;}
  }
  private snapshot(event:InboundEvent,state:Frame):TargetSnapshot{return{accountId:event.accountId,ownId:this.mapping.observation.self.uid,
    targetKey:targetKey(event),eventBinding:eventBinding(event),composerKey:targetKey(event),contextDigest:digest(state.context),mappingDigest:digest(this.mapping)};}
  async inspect(event:InboundEvent):Promise<TargetSnapshot>{
    this.token=null;const index=this.mapping.observation.works.findIndex(w=>w.id===event.videoId);
    requireSafe(isStrong(event)&&index>=0,'COMMENT_REPLY_SCOPE_REQUIRED');
    if(this.page.url().split('?')[0]!==this.mapping.observation.works[index]!.url.split('?')[0])
      await new ObservedReader(this.page,this.mapping.observation).comments(index);
    await this.frame(event,'open');const deadline=Date.now()+5000;let frame:Frame;
    for(;;)try{frame=await this.frame(event);break;}catch(error){
      if(!(error instanceof Error)||!error.message.includes('COMMENT_REPLY_DOM_NOT_READY')||Date.now()>=deadline)throw error;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    requireSafe(frame.editorText===''||this.prepared?.binding===eventBinding(event)&&this.prepared.text===frame.editorText,'COMMENT_REPLY_EXISTING_DRAFT');
    return this.snapshot(event,frame);
  }
  async prepare(event:InboundEvent,text:string):Promise<void>{
    validText(text);requireSafe(!/[\r\n]/.test(text),'COMMENT_REPLY_SINGLE_LINE_ONLY');const before=await this.frame(event);
    requireSafe(before.editorText===''||this.prepared?.binding===eventBinding(event)&&this.prepared.text===before.editorText,'COMMENT_REPLY_EXISTING_DRAFT');
    const token=randomUUID(),prior={context:before.context,editorText:before.editorText};
    await this.frame(event,'fill',text,token,prior);
    try{
      const deadline=Date.now()+1000;let after:Frame;
      for(;;)try{after=await this.frame(event,'finish',text,token,prior);break;}catch(error){
        if(!(error instanceof Error)||!error.message.includes('COMMENT_REPLY_INPUT_NOT_SETTLED')||Date.now()>=deadline)throw error;
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      this.prepared={binding:eventBinding(event),text,shape:after.shape};
    }finally{
      await this.page.evaluate(token=>{const gate=(window as unknown as {__inboraCommentInputGate?:{token:string;remove:()=>void}}).__inboraCommentInputGate;
        if(gate?.token===token)gate.remove();},token).catch(()=>{});
    }
  }
  async verifyPrepared(event:InboundEvent,text:string):Promise<TargetSnapshot>{
    requireSafe(this.prepared?.binding===eventBinding(event)&&this.prepared.text===text,'COMMENT_REPLY_NOT_PREPARED');
    const token=randomUUID(),deadline=Date.now()+5000;let state:Frame;
    for(;;)try{state=await this.frame(event,'arm',text,token,null,this.prepared.shape);break;}catch(error){
      if(!(error instanceof Error)||!error.message.includes('COMMENT_REPLY_SEND_NOT_READY')||Date.now()>=deadline)throw error;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    this.token=token;return this.snapshot(event,state);
  }
  async baseline(event:InboundEvent):Promise<string[]>{return(await this.frame(event)).ids;}
  async clickOnce():Promise<void>{const token=this.token;this.token=null;requireSafe(token,'COMMENT_REPLY_NOT_PREPARED');
    const accepted=await this.page.evaluate(token=>{const gate=(window as unknown as {__inboraCommentGate?:Gate}).__inboraCommentGate;
      if(!gate||gate.token!==token)throw Error('COMMENT_REPLY_NOT_PREPARED');try{return gate.submit();}finally{gate.remove();}},token);
    requireSafe(accepted,'COMMENT_REPLY_CLICK_BLOCKED');
  }
  async readback(event:InboundEvent,text:string,before:string[],notBefore:string):Promise<SendProof|null>{
    const deadline=Date.now()+this.timeoutMs;let previous:string|null=null;
    do{const matches=(await this.frame(event,'proofs')).proofs.filter(p=>!before.includes(p.id)&&p.text===text&&
      Date.parse(p.sentAt)>Date.parse(notBefore)&&Date.parse(p.sentAt)<=Date.now());
      requireSafe(matches.length<=1,'COMMENT_REPLY_PROOF_AMBIGUOUS');const proof=matches[0];if(proof&&digest(proof)===previous)return proof;
      previous=proof?digest(proof):null;await new Promise(resolve=>setTimeout(resolve,75));
    }while(Date.now()<deadline);return null;
  }
}
type Gate={token:string;submit:()=>boolean;remove:()=>void};
